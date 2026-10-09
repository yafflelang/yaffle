/**
 * The relocation-style writer (docs/IR.md §3.2):
 *
 * 1. Generated writers encode bottom-up into **blocks**: inline bytes plus **fixups** (a position,
 *    a width and a closure computing the value once sizes and positions are final).
 * 2. Pointer and `at` targets become **placeables**, each with its own block. Generated code also
 *    records the structure (`LStruct` / `LArray`) the layout engine matches `layout` paths against.
 * 3. When a base **region** (the root, a `@base` struct, a codec's decoded side) is complete, the
 *    layout engine assigns every block a position, the blocks are assembled, and the fixups run.
 */
import {
  YaffleError,
  cleanPath,
  fail,
  rethrowWithPath,
  wrapHostError,
  type PathSegment
} from "./errors.ts";
import { PRIMS, checkPrim, writePrim, type PrimKind } from "./prim.ts";
import { encodeString, type StringEncoding, type StringUnit } from "./strings.ts";
import { fillByte, type Fill } from "./reader.ts";
import { toHex } from "./json.ts";
import { layoutRegion, type LayoutItem, type StickyPolicy } from "./layout.ts";

// ── structure for layout ───────────────────────────────────────────────────────

/** The placeables reachable from one struct instance, by field (declaration order). */
export class LStruct {
  readonly kind = "struct";
  /**
   * The struct's `layout { … }` items. When their arguments read fields, the generated writer
   * evaluates them per instance and sets this at the end of the struct.
   */
  layout: readonly LayoutItem[] | undefined;
  readonly fields = new Map<string, LEntry>();
  constructor(layout?: readonly LayoutItem[]) {
    this.layout = layout;
  }
  set(name: string, e: LEntry | undefined | void): void {
    if (e) this.fields.set(name, e);
  }
  /** Starts an array entry for field `name`. */
  arr(name: string): LArray {
    const a = new LArray();
    this.fields.set(name, a);
    return a;
  }
}

export class LArray {
  readonly kind = "array";
  readonly items: (LEntry | undefined)[] = [];
  push(e: LEntry | undefined | void): void {
    this.items.push(e || undefined);
  }
}

export interface PlaceOptions {
  /** `at` constraint from a linear reverse: position ≡ remainder (mod modulus). */
  constraint?: { modulus: number; remainder: number };
  /** Fixed placement: exactly this base-relative offset. */
  fixed?: number;
}

/** A pointer or `at` target: its block plus the structure of its content. */
export class Placeable {
  readonly kind = "placeable";
  readonly block: Block;
  content: LEntry | undefined;
  constraint: { modulus: number; remainder: number } | undefined;
  fixed: number | undefined;
  /** Commit mode: original position and size (from a view). */
  orig: number | undefined;
  origSize: number | undefined;
  /** Field name, for error messages. */
  name: string;
  constructor(block: Block, name: string, opts: PlaceOptions = {}) {
    this.block = block;
    this.name = name;
    this.constraint = opts.constraint;
    this.fixed = opts.fixed;
    // A fixed placement's position is known before its content is written: inner alignment is
    // computed from it instead of constraining the block's start.
    if (opts.fixed !== undefined) block.fixedAt = opts.fixed;
  }
  get placed(): boolean {
    return this.block.pos >= 0;
  }
}

export type LEntry = LStruct | LArray | Placeable;

// ── blocks ──────────────────────────────────────────────────────────────────────

/** Provenance of a part copied unchanged from a source (views and codec reuse). */
export interface Provenance {
  /** Identifies the original byte space (a view's store). */
  space: object;
  offset: number;
}

interface Part {
  at: number;
  data: Uint8Array;
  prov?: Provenance;
}

export class Block {
  readonly parts: Part[] = [];
  private cur = new Uint8Array(64);
  private dv = new DataView(this.cur.buffer);
  private curLen = 0;
  private curAt = 0;
  size = 0;
  /** Required start alignment (from `align` layers inside, computed relative to the block start). */
  align = 1;
  /** The base-relative start when known before layout (fixed placements). */
  fixedAt: number | undefined;
  /** Base-relative position, assigned by layout (-1 until then). The region root is at 0. */
  pos = -1;
  readonly region: Region;
  constructor(region: Region) {
    this.region = region;
  }

  private ensure(n: number): void {
    if (this.curLen + n <= this.cur.length) return;
    let cap = this.cur.length * 2;
    while (cap < this.curLen + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.cur.subarray(0, this.curLen));
    this.cur = next;
    this.dv = new DataView(next.buffer);
  }

  private seal(): void {
    if (this.curLen) {
      this.parts.push({ at: this.curAt, data: this.cur.subarray(0, this.curLen) });
      this.cur = new Uint8Array(64);
      this.dv = new DataView(this.cur.buffer);
      this.curLen = 0;
    }
    this.curAt = this.size;
  }

  u8(v: number): void {
    this.ensure(1);
    this.cur[this.curLen++] = v;
    this.size++;
  }

  /** Writes a primitive whose value is already validated. */
  prim(kind: PrimKind, v: number | bigint, le: boolean): void {
    const n = PRIMS[kind].size;
    this.ensure(n);
    writePrim(this.cur, this.dv, this.curLen, kind, v, le);
    this.curLen += n;
    this.size += n;
  }

  /** Appends bytes. Large arrays are referenced, not copied. */
  bytes(b: Uint8Array, prov?: Provenance): void {
    if (b.length >= 512 || prov) {
      this.seal();
      if (b.length) {
        const part: Part = { at: this.size, data: b };
        if (prov) part.prov = prov;
        this.parts.push(part);
      }
      this.size += b.length;
      this.curAt = this.size;
      return;
    }
    this.ensure(b.length);
    this.cur.set(b, this.curLen);
    this.curLen += b.length;
    this.size += b.length;
  }

  fill(n: number, fill: Fill): void {
    if (typeof fill === "number" && fill === 0 && n >= 512) {
      this.bytes(new Uint8Array(n));
      return;
    }
    this.ensure(n);
    for (let i = 0; i < n; i++) this.cur[this.curLen + i] = fillByte(fill, i);
    this.curLen += n;
    this.size += n;
  }

  /** All parts in order (the current buffer included). */
  allParts(): Part[] {
    if (!this.curLen) return this.parts;
    return [...this.parts, { at: this.curAt, data: this.cur.subarray(0, this.curLen) }];
  }

  /** Copies the block's bytes into `out` at `at`. */
  copyTo(out: Uint8Array, at: number): void {
    for (const p of this.parts) out.set(p.data, at + p.at);
    if (this.curLen) out.set(this.cur.subarray(0, this.curLen), at + this.curAt);
  }

  /** The block's bytes (fixups not applied). */
  toBytes(): Uint8Array {
    if (this.parts.length === 0) return this.cur.subarray(0, this.curLen);
    if (this.parts.length === 1 && !this.curLen && this.parts[0]!.at === 0)
      return this.parts[0]!.data;
    const out = new Uint8Array(this.size);
    this.copyTo(out, 0);
    return out;
  }
}

// ── fixups ──────────────────────────────────────────────────────────────────────

/**
 * Phases: 0 = sizes, positions, pointers; 1 = `@ref` pointers (need the assembled bytes);
 * 2 = content-dependent values (checksums, bytesof), innermost first.
 */
export interface Fixup {
  block: Block;
  at: number;
  phase: 0 | 1 | 2;
  depth: number;
  /** Path of the field that registered it (for errors). */
  path: PathSegment[];
  /** Computes and writes the value into the assembled region bytes at `abs`. */
  run(out: Uint8Array, abs: number): void;
}

/** A position inside a block (absolute = block.pos + at once laid out). */
export interface Mark {
  block: Block;
  at: number;
}

/** Start/end of a field's encoding, for sizeof/offsetof/bytesof. */
export class Extent {
  block: Block;
  start: number;
  end = -1;
  /** Byte length after each layer stage (`encodedSize(field, k)`). */
  readonly stages: number[] = [];
  /** Set for placed fields: the placeable that holds the field. */
  placeable: Placeable | undefined;
  /** An empty placed array whose offset is written as 0 (`@nullable(empty)`). */
  emptyIsNull = false;
  /** The plain encoding (before any codec), if a `via` layer recorded it. */
  plain: Uint8Array | undefined;
  constructor(block: Block, start: number) {
    this.block = block;
    this.start = start;
  }
  get size(): number {
    if (this.placeable) return this.placeable.block.size;
    // While the field is still being written (its own size layer asks), the bytes so far.
    if (this.end < 0) return this.block.size - this.start;
    return this.end - this.start;
  }
  /** Base-relative position (valid after layout). */
  get pos(): number {
    if (this.placeable)
      return this.emptyIsNull && this.placeable.block.size === 0 ? 0 : this.placeable.block.pos;
    if (this.block.pos < 0) fail("DERIVE", "position used before layout");
    return this.block.pos + this.start;
  }
  /** Encoded size after `k` layer stages (0 = plain encoding). */
  stage(k: number): number {
    const v = this.stages[k];
    if (v === undefined) {
      if (k >= this.stages.length && this.end >= 0) return this.size;
      fail("DERIVE", `encoded size at layer ${k} is not available yet`);
    }
    return v;
  }
  /** The field's bytes in the finished region (content-dependent fixups only). */
  bytes(): Uint8Array {
    const b = this.placeable ? this.placeable.block : this.block;
    const out = b.region.output;
    if (!out) return fail("DERIVE", "bytes of a field used before its region was assembled");
    const pos = this.pos;
    return out.subarray(pos, pos + this.size);
  }
  /** The field's plain encoding (before layers). */
  plainBytes(): Uint8Array {
    if (this.plain) return this.plain;
    const all = this.bytes();
    return this.stages.length ? all.subarray(0, this.stages[0]) : all;
  }
}

/** `this` of a base struct: its whole region, whose size is known once the region is finished. */
class RegionExtent extends Extent {
  override get size(): number {
    const region = this.block.region;
    return region.output ? region.output.length : region.root.size;
  }
}

// ── regions ─────────────────────────────────────────────────────────────────────

interface RefSite {
  key: string;
  block: Block;
  start: number;
  end: number;
  /** The value object written there (identity matches for `@ref` pointers to objects). */
  value: object | undefined;
}

interface RefUse {
  key: string;
  path: PathSegment[];
  /** Object targets: matched by identity first. */
  value: object | undefined;
  /** Lazily computed encoding (objects), or the encoding itself (primitives). */
  encode: (() => Uint8Array) | undefined;
  encoding: Uint8Array | undefined;
  origin: (() => number) | undefined;
  /** Where the pointer is written. */
  mark: Mark;
  /** Start of the pointer's own base (undefined: this region's start). */
  base: Mark | undefined;
  kind: PrimKind;
  le: boolean;
  relative: boolean;
  nullValue: bigint | undefined;
}

/** A base region: the base's own block at offset 0, plus everything placed in it. */
export class Region {
  readonly root: Block;
  readonly blocks: Block[] = [];
  readonly placeables: Placeable[] = [];
  readonly fixups: Fixup[] = [];
  readonly identity = new Map<object, Map<string, Placeable>>();
  readonly refSites: RefSite[] = [];
  readonly refUses: RefUse[] = [];
  lroot: LStruct | undefined;
  layout: readonly LayoutItem[] | undefined;
  /** The region's total size is padded to a multiple of this (a base's `@alignEnd`). */
  alignEnd = 1;
  /**
   * A base's `@alignEnd` with an origin or offset: the total size is padded until
   * `(start + size + offset) % to == 0`, where start is 0 (`base`) or the region's start in its
   * byte space (`file`).
   */
  readonly alignEnds: { to: number; file: boolean; offset: number }[] = [];
  /**
   * Where this region's bytes go in the enclosing region, when it is a nested `@base` written
   * inline (`Writer.base`): `at` bytes into `block`. Undefined for a region that starts its own
   * byte space (the root, a codec's decoded side, a virtual stream, a temporary encoding).
   */
  anchor: { block: Block; at: number } | undefined;
  /**
   * A nested `@base` struct's region: `@ref` pointers without a target here are left in
   * `unresolved` for the enclosing base to resolve.
   */
  escalate = false;
  readonly unresolved: RefUse[] = [];
  /** Commit mode (views): keep unchanged placeables where they were. */
  sticky: StickyPolicy | undefined;
  /** After finish: the assembled bytes and part provenance (for patches). */
  output: Uint8Array | undefined;
  readonly provenance: { at: number; len: number; prov: Provenance }[] = [];
  constructor() {
    this.root = new Block(this);
    this.root.pos = 0;
    this.blocks.push(this.root);
  }

  newBlock(): Block {
    const b = new Block(this);
    this.blocks.push(b);
    return b;
  }

  /** Lays out, assembles and runs the fixups. Returns the region's bytes. */
  finish(): Uint8Array {
    layoutRegion(this);
    let size = 0;
    for (const b of this.blocks) {
      if (b.pos < 0) continue;
      size = Math.max(size, b.pos + b.size);
    }
    if (this.alignEnd > 1) size = Math.ceil(size / this.alignEnd) * this.alignEnd;
    for (let changed = this.alignEnds.length > 0, guard = 0; changed && guard < 64; guard++) {
      changed = false;
      for (const a of this.alignEnds) {
        const start = a.file ? fileStart(this.root, a.to) : 0;
        const pad = modulo(-(start + size + a.offset), a.to);
        if (pad) {
          size += pad;
          changed = true;
        }
      }
      if (this.alignEnd > 1 && size % this.alignEnd) {
        size = Math.ceil(size / this.alignEnd) * this.alignEnd;
        changed = true;
      }
    }
    const out = new Uint8Array(size);
    for (const b of this.blocks) {
      if (b.pos < 0) continue;
      for (const p of b.allParts()) {
        out.set(p.data, b.pos + p.at);
        if (p.prov) this.provenance.push({ at: b.pos + p.at, len: p.data.length, prov: p.prov });
      }
    }
    this.output = out;
    const run = (f: Fixup): void => {
      try {
        f.run(out, f.block.pos + f.at);
      } catch (e) {
        rethrowWithPath(e, f.path);
      }
    };
    for (const f of this.fixups) if (f.phase === 0) run(f);
    this.resolveRefs(out);
    for (const f of this.fixups.filter(x => x.phase === 2).sort((a, b) => b.depth - a.depth))
      run(f);
    return out;
  }

  private resolveRefs(out: Uint8Array): void {
    if (!this.refUses.length) return;
    let byEncoding: Map<string, number> | undefined;
    const byIdentity = new Map<object, Map<string, number>>();
    for (const s of this.refSites) {
      if (s.block.pos < 0 || !s.value) continue;
      const abs = s.block.pos + s.start;
      let m = byIdentity.get(s.value);
      if (!m) byIdentity.set(s.value, (m = new Map()));
      const prev = m.get(s.key);
      if (prev === undefined || abs < prev) m.set(s.key, abs);
    }
    const encodingIndex = (): Map<string, number> => {
      if (byEncoding) return byEncoding;
      byEncoding = new Map();
      for (const s of this.refSites) {
        if (s.block.pos < 0) continue;
        const abs = s.block.pos + s.start;
        const key = `${s.key}|${toHex(out.subarray(abs, s.block.pos + s.end))}`;
        const prev = byEncoding.get(key);
        if (prev === undefined || abs < prev) byEncoding.set(key, abs);
      }
      return byEncoding;
    };
    for (const u of this.refUses) {
      try {
        let target = u.value ? byIdentity.get(u.value)?.get(u.key) : undefined;
        if (target === undefined) {
          const enc = u.encoding ?? u.encode!();
          target = encodingIndex().get(`${u.key}|${toHex(enc)}`);
        }
        if (target === undefined) {
          if (this.escalate) {
            this.unresolved.push(u);
            continue;
          }
          throw new YaffleError("REF", "no equal value is placed in this base for a @ref pointer");
        }
        const abs = u.mark.block.pos + u.mark.at;
        const base = u.base ? u.base.block.pos + u.base.at : 0;
        const value = (u.relative ? target - abs : target - base) - (u.origin ? u.origin() : 0);
        writeOffset(out, abs, u.kind, u.le, value, u.nullValue);
      } catch (e) {
        rethrowWithPath(e, u.path);
      }
    }
  }
}

function writeOffset(
  out: Uint8Array,
  abs: number,
  kind: PrimKind,
  le: boolean,
  value: number,
  nullValue: bigint | undefined
): void {
  if (nullValue !== undefined && BigInt(value) === nullValue) {
    fail("DERIVE", `pointer offset ${value} equals the null value`);
  }
  const p = PRIMS[kind];
  if (!p.signed && value < 0) fail("RANGE", `negative offset ${value} for ${kind}`);
  writePrimAt(out, abs, kind, checkPrim(p.big ? BigInt(value) : value, kind, "pointer"), le);
}

/** Writes a validated primitive into assembled region bytes. */
function writePrimAt(
  out: Uint8Array,
  abs: number,
  kind: PrimKind,
  v: number | bigint,
  le: boolean
): void {
  writePrim(out, new DataView(out.buffer, out.byteOffset, out.byteLength), abs, kind, v, le);
}

// ── the writer used by generated code ───────────────────────────────────────────

type WriteEntry = LStruct | LEntry | undefined | void;

export class Writer {
  /** Current block (inline bytes go here). */
  b: Block;
  /** Current base region. */
  region: Region;
  /** Struct nesting depth (orders content-dependent fixups). */
  depth = 0;
  index = -1;
  private readonly frames: (() => PathSegment[])[] = [];
  private readonly rootRegion: Region;

  constructor(region = new Region()) {
    this.region = region;
    this.b = region.root;
    this.rootRegion = region;
  }

  /** Enters a struct writer; `get` returns its current field/index (for fixup error paths). */
  enter(get: () => PathSegment[]): void {
    this.frames.push(get);
    this.depth++;
  }

  leave(): void {
    this.frames.pop();
    this.depth--;
  }

  /** The current path from the root (snapshot). */
  path(): PathSegment[] {
    return this.frames.flatMap(g => cleanPath(g()));
  }

  // ── commit mode (views) ──────────────────────────────────────────────────

  /** Original absolute position/size of a value (pointer targets, `at` values) in the view's source. */
  origin: ((value: unknown) => { pos: number; size: number } | undefined) | undefined;
  /** Original target of a field of a view struct (when the field got a new value). */
  slotOrigin:
    ((owner: unknown, field: string) => { pos: number; size: number } | undefined) | undefined;
  /** Original position of a nested base struct (its region keeps targets where they were). */
  regionOrigin:
    ((value: unknown) => { base: number; inline: number; size: number } | undefined) | undefined;
  /** Byte arrays from this buffer are recorded as copied from the original (for patches). */
  provenance: { buffer: ArrayBufferLike; start: number; length: number; space: object } | undefined;
  /** Absolute original position of the current region's base. */
  private originBase = 0;

  private provOf(v: Uint8Array): Provenance | undefined {
    const p = this.provenance;
    if (!p || v.buffer !== p.buffer || this.region !== this.rootRegion) return undefined;
    const offset = v.byteOffset - p.start;
    if (offset < 0 || offset + v.length > p.length) return undefined;
    return { space: p.space, offset };
  }

  private noteOrigin(p: Placeable, value: unknown, owner?: unknown): void {
    if (!this.origin || this.region.sticky?.origRootSize === undefined) return;
    const o =
      this.origin(value) ?? (owner !== undefined ? this.slotOrigin?.(owner, p.name) : undefined);
    if (o && o.pos >= this.originBase) {
      p.orig = o.pos - this.originBase;
      p.origSize = o.size;
    }
  }

  /** Offset of the next byte within the current block. */
  get offset(): number {
    return this.b.size;
  }

  /** `$offset` on write: the base-relative position (exact in a region's own block). */
  get position(): number {
    return (this.b.pos >= 0 ? this.b.pos : 0) + this.b.size;
  }

  mark(): Mark {
    return { block: this.b, at: this.b.size };
  }

  extent(): Extent {
    return new Extent(this.b, this.b.size);
  }

  close(e: Extent): void {
    e.end = this.b.size;
  }

  // ── primitives (validated) ───────────────────────────────────────────────

  prim(kind: PrimKind, v: unknown, le: boolean, what?: string): void {
    this.b.prim(kind, checkPrim(v, kind, what), le);
  }
  u8(v: unknown): void {
    this.b.prim("u8", checkPrim(v, "u8"), true);
  }
  bool(v: unknown): void {
    if (typeof v !== "boolean") fail("INPUT", `expected a boolean, got ${typeof v}`);
    this.b.u8(v ? 1 : 0);
  }
  bytes(v: unknown, prov?: Provenance): void {
    if (!(v instanceof Uint8Array)) fail("INPUT", "expected a Uint8Array");
    this.b.bytes(v, prov ?? this.provOf(v));
  }
  /** Raw bytes known to be valid. */
  raw(v: Uint8Array): void {
    this.b.bytes(v, this.provOf(v));
  }

  /** `u8 x[n]`: exactly `n` bytes (other lengths would read back differently: DERIVE). */
  bytesN(v: unknown, n: number): void {
    if (!(v instanceof Uint8Array)) fail("INPUT", "expected a Uint8Array");
    if (v.length !== n) fail("DERIVE", `${v.length} bytes given, the length expression says ${n}`);
    this.b.bytes(v, this.provOf(v));
  }

  /** Bytes followed by a terminator byte (which must not occur inside). */
  bytesUntil(v: unknown, term: number): void {
    if (!(v instanceof Uint8Array)) fail("INPUT", "expected a Uint8Array");
    if (v.includes(term & 0xff))
      fail("INPUT", `the bytes contain the terminator 0x${(term & 0xff).toString(16)}`);
    this.b.bytes(v);
    this.b.u8(term & 0xff);
  }

  /** Writes an extern type through its host `write`. */
  extern(
    host: { write(value: unknown, ...args: unknown[]): unknown },
    value: unknown,
    args: unknown[],
    fixedSize: number
  ): void {
    let out: unknown;
    try {
      out = host.write(value, ...args);
    } catch (e) {
      wrapHostError(e, "CODEC", "extern type write() failed");
    }
    if (!(out instanceof Uint8Array)) fail("INPUT", "extern type write() must return a Uint8Array");
    if (fixedSize >= 0 && out.length !== fixedSize) {
      fail("DERIVE", `extern type wrote ${out.length} bytes, its fixed size is ${fixedSize}`);
    }
    this.b.bytes(out);
  }

  /** `this` of a base struct: its whole region (size known once the region is finished). */
  regionExtent(): Extent {
    return new RegionExtent(this.region.root, 0);
  }

  /** An extent for a placed field, created before its content is written (stages go into it). */
  pendingExtent(): Extent {
    return new Extent(this.b, this.b.size);
  }

  /** Binds a pending extent to the placeable that holds the field. */
  bindExtent(e: Extent, p: Placeable, emptyIsNull = false): void {
    e.placeable = p;
    e.block = p.block;
    e.start = 0;
    e.end = p.block.size;
    e.emptyIsNull = emptyIsNull;
  }

  /** Text: `count` pads with NUL units up to `n` (longer is INPUT), `until` appends one NUL unit. */
  str(
    v: unknown,
    unit: StringUnit,
    enc: StringEncoding,
    le: boolean,
    mode: "count" | "until" | "rest",
    n = 0
  ): void {
    const bytes = encodeString(v, enc, le);
    if (mode === "count") {
      if (bytes.length > n * unit) {
        fail("INPUT", `string of ${bytes.length / unit} units exceeds the length ${n}`);
      }
      this.b.bytes(bytes);
      this.b.fill(n * unit - bytes.length, 0);
    } else {
      this.b.bytes(bytes);
      if (mode === "until") this.b.fill(unit, 0);
    }
  }

  // ── padding ──────────────────────────────────────────────────────────────

  pad(n: number, fill: Fill): void {
    if (!Number.isSafeInteger(n) || n < 0) fail("RANGE", `invalid padding length ${n}`);
    this.b.fill(n, fill);
  }

  /** Pads until the base-relative position is a multiple of `to`. */
  align(to: number, fill: Fill): void {
    this.alignAt(to, fill, false, 0);
  }

  /**
   * `align(to, from: …, offset: …)`: pads until `(position + offset) % to == 0`, where the
   * position counts from the nearest base (`file` false) or from the start of the current byte
   * space (`file` true: the root, a codec's decoded side or a virtual stream; nested `@base`
   * regions count from where they are written). Block starts that are not known yet are required
   * to be multiples of `to`, and the padding is computed from the known part.
   */
  alignAt(to: number, fill: Fill, file: boolean, offset: number): void {
    checkAlignment(to, offset);
    const start = file ? fileStart(this.b, to) : blockStart(this.b, to);
    this.b.fill(modulo(-(start + this.b.size + offset), to), fill);
  }

  /** A base's `@alignEnd(to, from: …, offset: …)`: pads the whole region. */
  regionAlignEnd(to: number, file: boolean, offset: number): void {
    if (!file && offset === 0) {
      this.region.alignEnd = lcm(this.region.alignEnd, to);
      return;
    }
    checkAlignment(to, offset);
    this.region.alignEnds.push({ to, file, offset });
  }

  padUntil(start: number, size: number, fill: Fill): void {
    const used = this.b.size - start;
    if (used > size) fail("INPUT", `content of ${used} bytes exceeds padUntil(${size})`);
    this.b.fill(size - used, fill);
  }

  /** Closes a `size(n)` window opened at `start`: content longer than n is DERIVE, shorter is padded. */
  sizeWindow(start: number, n: number): void {
    if (!Number.isSafeInteger(n) || n < 0) fail("RANGE", `invalid size ${n}`);
    const used = this.b.size - start;
    if (used > n) fail("DERIVE", `content of ${used} bytes does not fit size ${n}`);
    this.b.fill(n - used, 0);
  }

  // ── fixups ───────────────────────────────────────────────────────────────

  /** Reserves `n` zero bytes in the current block, filled in by `run` after layout. */
  private fixup(n: number, phase: 0 | 2, run: (out: Uint8Array, abs: number) => void): void {
    const block = this.b;
    const at = block.size;
    block.fill(n, 0);
    this.region.fixups.push({ block, at, phase, depth: this.depth, path: this.path(), run });
  }

  /** Reserves a primitive whose value is computed after layout. */
  deferPrim(
    kind: PrimKind,
    le: boolean,
    compute: () => unknown,
    phase: 0 | 2 = 0,
    what?: string
  ): void {
    this.fixup(PRIMS[kind].size, phase, (out, abs) =>
      writePrimAt(out, abs, kind, checkPrim(compute(), kind, what), le)
    );
  }

  /** Reserves `n` bytes whose content is computed after layout. */
  deferBytes(n: number, compute: () => Uint8Array, phase: 0 | 2 = 0): void {
    this.fixup(n, phase, (out, abs) => {
      const v = compute();
      if (v.length !== n) fail("DERIVE", `derived bytes have length ${v.length}, expected ${n}`);
      out.set(v, abs);
    });
  }

  /** A check evaluated after layout (e.g. read-side placement offsets must match). */
  deferCheck(run: () => void, phase: 0 | 2 = 0): void {
    this.region.fixups.push({
      block: this.b,
      at: 0,
      phase,
      depth: this.depth,
      path: this.path(),
      run: () => run()
    });
  }

  // ── targets ──────────────────────────────────────────────────────────────

  /**
   * Places a pointer target: identical objects (by reference) with the same type key share one
   * placeable. `write` encodes the target into the placeable's block and returns its structure.
   */
  target(
    value: unknown,
    key: string,
    name: string,
    write: () => WriteEntry,
    opts?: PlaceOptions,
    owner?: unknown
  ): Placeable {
    const shared = this.sharedTarget(value, key);
    if (shared.hit) return shared.hit;
    const p = this.newPlaceable(name, opts, value, owner);
    shared.register?.(p);
    return this.fillPlaceable(p, write);
  }

  async targetAsync(
    value: unknown,
    key: string,
    name: string,
    write: () => Promise<WriteEntry>,
    opts?: PlaceOptions,
    owner?: unknown
  ): Promise<Placeable> {
    const shared = this.sharedTarget(value, key);
    if (shared.hit) return shared.hit;
    const p = this.newPlaceable(name, opts, value, owner);
    shared.register?.(p);
    return this.fillPlaceableAsync(p, write);
  }

  /** Places an `at` field's value (no identity sharing). `owner` is the struct holding the field. */
  place(
    name: string,
    value: unknown,
    write: () => WriteEntry,
    opts?: PlaceOptions,
    owner?: unknown
  ): Placeable {
    return this.fillPlaceable(this.newPlaceable(name, opts, value, owner), write);
  }

  async placeAsync(
    name: string,
    value: unknown,
    write: () => Promise<WriteEntry>,
    opts?: PlaceOptions,
    owner?: unknown
  ): Promise<Placeable> {
    return this.fillPlaceableAsync(this.newPlaceable(name, opts, value, owner), write);
  }

  /**
   * The placeable an object value already has under `key` in this region, or a `register`
   * function recording a new one (before its content is written, so cycles find it).
   */
  private sharedTarget(
    value: unknown,
    key: string
  ): { hit?: Placeable | undefined; register?: (p: Placeable) => void } {
    if (typeof value !== "object" || value === null) return {};
    const identity = this.region.identity;
    const byKey = identity.get(value);
    const hit = byKey?.get(key);
    if (hit) return { hit };
    return {
      register: p => {
        if (byKey) byKey.set(key, p);
        else identity.set(value, new Map([[key, p]]));
      }
    };
  }

  private newPlaceable(
    name: string,
    opts: PlaceOptions | undefined,
    value: unknown,
    owner: unknown
  ): Placeable {
    const p = new Placeable(this.region.newBlock(), name, opts);
    this.noteOrigin(p, value, owner);
    this.region.placeables.push(p);
    return p;
  }

  private fillPlaceable(p: Placeable, write: () => WriteEntry): Placeable {
    const leave = this.enterBlock(p.block);
    try {
      p.content = write() || undefined;
    } finally {
      leave();
    }
    return p;
  }

  private async fillPlaceableAsync(
    p: Placeable,
    write: () => Promise<WriteEntry>
  ): Promise<Placeable> {
    const leave = this.enterBlock(p.block);
    try {
      p.content = (await write()) || undefined;
    } finally {
      leave();
    }
    return p;
  }

  /** Writes into `block` (index reset) until the returned function restores the current block. */
  private enterBlock(block: Block): () => void {
    const saveB = this.b;
    const saveIndex = this.index;
    this.b = block;
    this.index = -1;
    return () => {
      this.b = saveB;
      this.index = saveIndex;
    };
  }

  /** Writes an owned pointer: the offset of `p` (null → `nullValue`). */
  pointer(
    kind: PrimKind,
    le: boolean,
    p: Placeable | null,
    relative: boolean,
    nullValue: bigint | undefined,
    origin?: () => number
  ): void {
    if (p === null) {
      if (nullValue === undefined) fail("INPUT", "null for a pointer that is not nullable");
      const v = PRIMS[kind].big ? nullValue : Number(nullValue);
      this.fixup(PRIMS[kind].size, 0, (out, abs) =>
        writePrimAt(out, abs, kind, checkPrim(v, kind), le)
      );
      return;
    }
    this.fixup(PRIMS[kind].size, 0, (out, abs) => {
      if (p.block.pos < 0) fail("DERIVE", `target ${p.name} was not placed`);
      const value = (relative ? p.block.pos - abs : p.block.pos) - (origin ? origin() : 0);
      writeOffset(out, abs, kind, le, value, nullValue);
    });
  }

  /**
   * Writes a `@ref` pointer: resolved after layout to the first placed value in this base whose
   * encoding (type `key`) equals `encoding`.
   */
  refPointer(
    kind: PrimKind,
    le: boolean,
    key: string,
    value: unknown,
    encode: () => Uint8Array,
    relative: boolean,
    nullValue: bigint | undefined,
    origin?: () => number
  ): void {
    if (value === null) {
      this.pointer(kind, le, null, relative, nullValue);
      return;
    }
    const mark = this.mark();
    this.b.fill(PRIMS[kind].size, 0);
    // Objects resolve by identity first (the same object placed elsewhere); the encoding is
    // computed only when that fails. Primitives (strings) match by encoding.
    const isObj = typeof value === "object";
    this.region.refUses.push({
      key,
      path: this.path(),
      value: isObj ? value : undefined,
      encode: isObj ? encode : undefined,
      encoding: isObj ? undefined : encode(),
      origin,
      mark,
      base: undefined,
      kind,
      le,
      relative,
      nullValue
    });
  }

  /** Registers an encoded value as a possible `@ref` target. */
  refSite(key: string, start: number, value?: unknown): void {
    this.region.refSites.push({
      key,
      block: this.b,
      start,
      end: this.b.size,
      value: typeof value === "object" && value !== null ? value : undefined
    });
  }

  // ── regions ──────────────────────────────────────────────────────────────

  /**
   * Encodes a nested base region (a codec's decoded side, a stream, a temporary encoding) and
   * returns its finished bytes. Nothing inside escapes to the enclosing region.
   */
  subRegion(
    layout: readonly LayoutItem[] | undefined,
    write: (w: Writer) => WriteEntry
  ): Uint8Array {
    const leave = this.enterRegion(layout, undefined);
    const region = this.region;
    try {
      return finishRegion(region, write(this));
    } finally {
      leave();
    }
  }

  async subRegionAsync(
    layout: readonly LayoutItem[] | undefined,
    write: (w: Writer) => Promise<WriteEntry>
  ): Promise<Uint8Array> {
    const leave = this.enterRegion(layout, undefined);
    const region = this.region;
    try {
      return finishRegion(region, await write(this));
    } finally {
      leave();
    }
  }

  /** Encodes a value standalone (its plain encoding as a fresh region). */
  encodeAlone(write: (w: Writer) => WriteEntry): Uint8Array {
    return this.subRegion(undefined, write);
  }

  /**
   * Writes a `@base` struct inline: its region (own block, targets, `@alignEnd`) is laid out and
   * finished on its own, then appended here. `@ref` pointers it can't resolve search this base and
   * the ones enclosing it. `value` is the struct being written (views keep its targets in place).
   */
  base(
    layout: readonly LayoutItem[] | undefined,
    write: (w: Writer) => WriteEntry,
    value?: unknown
  ): void {
    const leave = this.enterRegion(layout, value, true);
    const region = this.region;
    let out: Uint8Array;
    try {
      out = finishRegion(region, write(this));
    } finally {
      leave();
    }
    this.appendRegion(region, out);
  }

  async baseAsync(
    layout: readonly LayoutItem[] | undefined,
    write: (w: Writer) => Promise<WriteEntry>,
    value?: unknown
  ): Promise<void> {
    const leave = this.enterRegion(layout, value, true);
    const region = this.region;
    let out: Uint8Array;
    try {
      out = finishRegion(region, await write(this));
    } finally {
      leave();
    }
    this.appendRegion(region, out);
  }

  /**
   * Starts a nested region; the returned function restores the enclosing one. A nested base
   * (`anchored`) escalates its unresolved `@ref`s, and in a commit keeps its targets where they
   * were when `value` is an unchanged view of the struct.
   */
  private enterRegion(
    layout: readonly LayoutItem[] | undefined,
    value: unknown,
    anchored = false
  ): () => void {
    const region = new Region();
    region.layout = layout;
    region.escalate = anchored;
    const saved = { region: this.region, b: this.b, index: this.index, base: this.originBase };
    const sticky = this.region.sticky;
    if (sticky) {
      const o = value !== undefined ? this.regionOrigin?.(value) : undefined;
      region.sticky = o
        ? { grow: sticky.grow, origRootSize: o.inline, origSize: o.size }
        : { grow: sticky.grow, origRootSize: undefined };
      if (o) this.originBase = o.base;
    }
    // A nested base written inline lands where the enclosing block is now (`from: file` origins).
    if (anchored) region.anchor = { block: this.b, at: this.b.size };
    this.region = region;
    this.b = region.root;
    return () => {
      this.region = saved.region;
      this.b = saved.b;
      this.index = saved.index;
      this.originBase = saved.base;
    };
  }

  /**
   * Appends a finished nested base region's bytes here and hands its unresolved `@ref` pointers
   * to this region. Their offsets stay relative to the nested base.
   */
  private appendRegion(nested: Region, out: Uint8Array): void {
    const block = this.b;
    const at = block.size;
    this.raw(out);
    for (const u of nested.unresolved) {
      const inner = u.base ? u.base.block.pos + u.base.at : 0;
      this.region.refUses.push({
        ...u,
        mark: { block, at: at + u.mark.block.pos + u.mark.at },
        base: { block, at: at + inner }
      });
    }
  }
}

/** Sets a finished region's layout structure and finishes it. */
export function finishRegion(region: Region, l: WriteEntry): Uint8Array {
  if (l instanceof LStruct) region.lroot = l;
  else if (l) {
    const s = new LStruct();
    s.set("$", l);
    region.lroot = s;
  }
  return region.finish();
}

function checkAlignment(to: number, offset: number): void {
  if (!Number.isSafeInteger(to) || to <= 0) fail("RANGE", `invalid alignment ${to}`);
  if (!Number.isSafeInteger(offset)) fail("RANGE", `invalid alignment offset ${offset}`);
}

/** Euclidean remainder: `a mod m` in `[0, m)`. */
export function modulo(a: number, m: number): number {
  return ((a % m) + m) % m;
}

/**
 * The known part of block `b`'s start within its region. A block whose position a later layout
 * decides gets `to` added to its alignment requirement (so its start contributes a multiple of
 * `to`) and counts as 0.
 */
function blockStart(b: Block, to: number): number {
  if (b === b.region.root) return 0;
  if (b.fixedAt !== undefined) return b.fixedAt;
  b.align = lcm(b.align, to);
  return 0;
}

/** Like `blockStart`, but counted from the start of the byte space (`from: file`). */
export function fileStart(b: Block, to: number): number {
  const anchor = b.region.anchor;
  return blockStart(b, to) + (anchor ? fileStart(anchor.block, to) + anchor.at : 0);
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

export function lcm(a: number, b: number): number {
  return (a / gcd(a, b)) * b;
}
