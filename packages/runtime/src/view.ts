/**
 * Lazy views: a struct view reads only the bytes it touches.
 *
 * - Generated `scan_X` functions read a struct's scalars and record each field's byte range.
 *   Composite children stay lazy: inline structs and arrays become child views, pointer and `at`
 *   targets, bytes and codec regions become `Lazy` values forced on first access.
 * - Setting a scalar to a value of the same encoded size patches the bytes in place (a `Space`
 *   keeps the patches; the original bytes are never modified before `$commit`).
 * - Anything else (array push/splice, a value changing size, replacing a struct or a target)
 *   "materializes" the node: its values become a plain record that `$commit` re-encodes with the
 *   generated writer (see commit.ts).
 */
import { cleanPath, fail, rethrowAt, rethrowWithPath, type PathSegment } from "./errors.ts";
import { Reader } from "./reader.ts";
import {
  ArrayStore,
  NeedAsync,
  SliceStore,
  UNKNOWN_END,
  storeCovers,
  storeSource,
  type ByteStore,
  type SyncSource
} from "./source.ts";
import { decode, rememberCodec, type Codec, type CodecCtx } from "./codec.ts";
import { PieceStore, RangedStore } from "./lazy.ts";
import { fieldValue, getRaw, hiddenValue } from "./json.ts";
import type { LStruct, Writer } from "./writer.ts";
import type { LayoutItem } from "./layout.ts";
import { plan } from "./commit.ts";

// ── lazy values ────────────────────────────────────────────────────────────────

const LAZY = Symbol.for("yaffle.lazy");

/** Where a pointer or `at` target is (for tools: sample annotations, layout analysis). */
export interface TargetInfo {
  /** Address of the target in `space`. */
  addr: number;
  space: Space;
  /** Bytes the target's read consumed, once it has been read. */
  size: number | undefined;
}

/**
 * Depth of transient evaluations (`Lazy.peek`): while positive, lazy helpers compute values
 * without registering decoded spaces or codec origins, so a virtual stream can decode a piece
 * without keeping it alive (its own LRU cache bounds the memory).
 */
let transient = 0;

export class Lazy<T = unknown> {
  readonly [LAZY] = true;
  private readonly f: () => T;
  private value: T | undefined;
  private done = false;
  private version = -1;
  private readonly space: Space | undefined;
  /** Set for pointer and `at` targets: where the target is, readable without forcing it. */
  target: TargetInfo | undefined;
  /** Byte values: the value's length when known without computing it (stream piece sizes). */
  length: number | undefined;
  /** Byte values: a store over the value's bytes, without materializing them. */
  toStore: (() => ByteStore) | undefined;
  constructor(f: () => T, space?: Space) {
    this.f = f;
    this.space = space;
  }
  /** True once the value has been read (and the space hasn't changed since). */
  get forced(): boolean {
    return this.done && this.version === (this.space ? this.space.version : 0);
  }
  get(): T {
    const v = this.space ? this.space.version : 0;
    if (!this.done || this.version !== v) {
      this.value = this.f();
      this.done = true;
      this.version = v;
    }
    return this.value as T;
  }
  /** The value, computed without caching it (or the cached value if it was read already). */
  peek(): T {
    if (this.forced) return this.value as T;
    transient++;
    try {
      return this.f();
    } finally {
      transient--;
    }
  }
}

/** Marks the known length of a lazily read byte value (generated code, stream pieces). */
export function knownLength<T>(v: T, n: number): T {
  if (isLazy(v) && Number.isSafeInteger(n) && n >= 0) v.length = n;
  return v;
}

export function isLazy(v: unknown): v is Lazy {
  return typeof v === "object" && v !== null && (v as { [LAZY]?: boolean })[LAZY] === true;
}

/** Forces a lazy value (other values pass through). */
export function force<T>(v: T): T {
  return isLazy(v) ? (v.get() as T) : v;
}

// ── byte spaces ────────────────────────────────────────────────────────────────

interface InPlace {
  at: number;
  data: Uint8Array;
  node: StructNode | undefined;
}

/** A store with in-place patches applied on read. Exposes `whole` only while unpatched. */
class PatchedStore implements ByteStore {
  readonly space: Space;
  constructor(space: Space) {
    this.space = space;
  }
  get size(): number {
    return this.space.base.size;
  }
  get whole(): Uint8Array | undefined {
    return this.space.patches.length ? undefined : this.space.base.whole;
  }
  get lazySize(): boolean {
    return this.space.base.lazySize === true;
  }
  get chunk(): number {
    return this.space.base.chunk ?? 0x4000;
  }
  covers(end: number): boolean {
    return storeCovers(this.space.base, end);
  }
  get(offset: number, length: number): Uint8Array {
    return this.patched(offset, this.space.base.get(offset, length));
  }
  getSome(offset: number, min: number, max: number): Uint8Array {
    const base = this.space.base;
    if (base.getSome) return this.patched(offset, base.getSome(offset, min, max));
    return this.get(offset, Math.max(min, Math.min(max, base.size - offset)));
  }
  /** `raw` (the base bytes at `offset`) with the in-place patches applied. */
  private patched(offset: number, raw: Uint8Array): Uint8Array {
    const ps = this.space.patches;
    const length = raw.length;
    if (!ps.some(p => p.at < offset + length && offset < p.at + p.data.length)) return raw;
    const out = new Uint8Array(raw);
    for (const p of ps) {
      const from = Math.max(p.at, offset);
      const to = Math.min(p.at + p.data.length, offset + length);
      if (from < to) out.set(p.data.subarray(from - p.at, to - p.at), from - offset);
    }
    return out;
  }
}

/** Where a decoded space came from (for re-encoding and codec reuse). */
export interface DecodedOrigin {
  parent: Space;
  start: number;
  end: number;
  codec: Codec;
  name: string;
  ctx: CodecCtx;
  ranged: boolean;
}

let spaceIds = 0;

/** A byte space: the view's source, or a codec's decoded output. In-place patches live here. */
export class Space {
  readonly id = ++spaceIds;
  readonly root: ViewRoot;
  base: ByteStore;
  readonly patches: InPlace[] = [];
  readonly decoded: DecodedOrigin | undefined;
  /** Bumped by every patch: cached scans and lazy values re-read. */
  version = 0;
  readonly store: PatchedStore;
  constructor(root: ViewRoot, base: ByteStore, decoded?: DecodedOrigin) {
    this.root = root;
    this.base = base;
    this.decoded = decoded;
    this.store = new PatchedStore(this);
  }

  patch(at: number, data: Uint8Array, node: StructNode | undefined): void {
    if (at < 0 || !storeCovers(this.base, at + data.length))
      fail("RANGE", "patch outside the data");
    this.patches.push({ at, data: data.slice(), node });
    this.version++;
    this.root.version++;
  }

  reader(pos: number, base: number, end: number, strict: boolean): Reader {
    const r = new Reader(this.store, { strict });
    r.pos = pos;
    r.base = base;
    r.end = end;
    r.maxEnd = pos;
    if (this.decoded) r.copy = true;
    return r;
  }
}

// ── generated metadata ─────────────────────────────────────────────────────────

export type Ranges = { [field: string]: [number, number] };
export type Scanned = [object, Ranges];

export interface FieldInfo {
  input: "required" | "optional" | "absent";
  /** Same-size values can be patched in place (an encoder exists and no derive depends on it). */
  patch: boolean;
  /** Later read-side expressions depend on it: setting it changes the structure. */
  structural: boolean;
}

/** Per-struct view metadata emitted by the TS backend (`$view_X`). */
export interface StructInfo {
  name: string;
  key: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generated signatures vary
  scan: (r: Reader, ...args: any[]) => Scanned;
  staticSize: number | undefined;
  base: boolean;
  fields: { readonly [name: string]: FieldInfo };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generated signatures vary
  encode: { readonly [name: string]: (value: any, values: any, ...args: any[]) => Uint8Array };
  /** In-place edits inside inline children cannot change this struct's derived values. */
  childSafe: boolean;
  /**
   * `@base` structs (sync formats): the eager reader, to measure the whole region (inline bytes
   * and every target) when inline data follows the struct.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generated signatures vary
  measure?: ((r: Reader, ...args: any[]) => unknown) | undefined;
}

// ── scan context ───────────────────────────────────────────────────────────────

interface ScanCtx {
  root: ViewRoot;
  space: Space;
  node: StructNode | undefined;
  /** Path prefix of views created in this context. */
  path: PathSegment[];
}

const scanStack: ScanCtx[] = [];

function current(): ScanCtx {
  const c = scanStack[scanStack.length - 1];
  if (!c) return fail("INPUT", "view helper used outside a scan");
  return c;
}

function withScan<T>(ctx: ScanCtx, f: () => T): T {
  scanStack.push(ctx);
  try {
    return f();
  } finally {
    scanStack.pop();
  }
}

// ── nodes ──────────────────────────────────────────────────────────────────────

export interface NodeCtx {
  base: number;
  end: number;
  index: number;
  strict: boolean;
  parent: StructNode | undefined;
  path: PathSegment[];
}

export class StructNode {
  readonly root: ViewRoot;
  readonly space: Space;
  readonly info: StructInfo;
  readonly pos: number;
  readonly args: unknown[];
  readonly ctx: NodeCtx;
  private values: Record<string, unknown> | undefined;
  private ranges: Ranges | undefined;
  private version = -1;
  /** End of the inline bytes (before a base struct's targets). */
  inlineEnd = -1;
  /** End of everything the struct consumes. */
  extentEnd = -1;
  materialized: Record<string, unknown> | undefined;
  readonly view: object;

  constructor(
    root: ViewRoot,
    space: Space,
    info: StructInfo,
    pos: number,
    args: unknown[],
    ctx: NodeCtx
  ) {
    this.root = root;
    this.space = space;
    this.info = info;
    this.pos = pos;
    this.args = args;
    this.ctx = ctx;
    this.view = structProxy(() => this);
  }

  get path(): PathSegment[] {
    return this.ctx.path;
  }

  ensureScanned(): void {
    if (this.values && this.version === this.space.version) return;
    const r = this.space.reader(this.pos, this.ctx.base, this.ctx.end, this.ctx.strict);
    r.index = this.ctx.index;
    let res: Scanned;
    try {
      res = withScan({ root: this.root, space: this.space, node: this, path: this.path }, () =>
        this.info.scan(r, ...this.args)
      );
    } catch (e) {
      rethrowWithPath(e, this.path);
    }
    this.values = res[0] as Record<string, unknown>;
    this.ranges = res[1];
    this.inlineEnd = r.inlineEnd >= 0 ? r.inlineEnd : r.pos;
    this.extentEnd = r.pos;
    this.version = this.space.version;
  }

  /** Size of the struct's bytes (inline extent; a base struct includes its targets). */
  get size(): number {
    if (this.info.staticSize !== undefined && !this.info.base) return this.info.staticSize;
    this.ensureScanned();
    return (this.info.base ? this.regionEnd() : this.extentEnd) - this.pos;
  }

  private measured = -1;
  private measuredVersion = -1;

  /**
   * End of a `@base` struct's whole region: its targets are lazy in the scan, so the region is
   * measured by reading it eagerly, the way `parse` does (once per space version).
   */
  regionEnd(): number {
    this.ensureScanned();
    const measure = this.info.measure;
    if (!this.info.base || !measure) return this.extentEnd;
    if (this.measuredVersion !== this.space.version) {
      const r = this.space.reader(this.pos, this.ctx.base, this.ctx.end, this.ctx.strict);
      r.index = this.ctx.index;
      try {
        measure(r, ...this.args);
      } catch (e) {
        rethrowWithPath(e, this.path);
      }
      this.measured = Math.max(r.pos, this.extentEnd);
      this.measuredVersion = this.space.version;
    }
    return this.measured;
  }

  has(name: string): boolean {
    if (this.materialized)
      return name in this.materialized && this.materialized[name] !== undefined;
    this.ensureScanned();
    return name in this.values! && this.values![name] !== undefined;
  }

  keys(): string[] {
    if (this.materialized)
      return Object.keys(this.materialized).filter(k => this.materialized![k] !== undefined);
    this.ensureScanned();
    return Object.keys(this.values!).filter(k => this.values![k] !== undefined);
  }

  get(name: string): unknown {
    const src = this.materialized ?? (this.ensureScanned(), this.values!);
    return this.forceField(name, src[name]);
  }

  /** A field's stored value, read if it is lazy (errors carry the field's path). */
  private forceField(name: string, v: unknown): unknown {
    if (!isLazy(v)) return v;
    try {
      return v.get();
    } catch (e) {
      return rethrowWithPath(e, [...this.path, name]);
    }
  }

  /** Where the field's original target was (before any edit), for sticky layout. */
  originalTarget(name: string): { pos: number; size: number } | undefined {
    this.ensureScanned();
    const v = this.values![name];
    if (v === undefined || v === null) return undefined;
    // A pointer or `at` target knows where it was, whatever its value (scalars too).
    if (isLazy(v) && v.target && v.target.space === this.space) {
      if (v.target.size === undefined) v.get();
      if (v.target.size !== undefined) return { pos: v.target.addr, size: v.target.size };
    }
    const f = force(v);
    if (typeof f !== "object" || f === null) return undefined;
    const o = this.root.origins.get(f);
    if (o && o.space === this.space) return { pos: o.pos, size: o.size };
    const n = nodeOf(f);
    if (n instanceof StructNode && n.space === this.space) return { pos: n.pos, size: n.size };
    return undefined;
  }

  range(name: string): [number, number] | undefined {
    this.ensureScanned();
    return this.ranges![name];
  }

  /** The stored value of a field without forcing it (a `Lazy` for targets, bytes and regions). */
  peek(name: string): unknown {
    if (this.materialized) return this.materialized[name];
    this.ensureScanned();
    return this.values![name];
  }

  /** Like `peek`, but also finds `@hidden` fields (stream pieces), unforced. */
  rawField(name: string): unknown {
    if (this.materialized && name in this.materialized) return this.materialized[name];
    this.ensureScanned();
    const h = hiddenValue(this.values!, name);
    return h !== undefined ? h : this.values![name];
  }

  /** A field's value, `@hidden` fields included (`fieldValue` in json.ts asks views this). */
  fieldValue(name: string): unknown {
    return this.forceField(name, this.rawField(name));
  }

  /** The raw value of a one-way transform field (canonical JSON shows it), if unchanged. */
  rawValue(name: string): unknown {
    this.ensureScanned();
    if (this.materialized && this.materialized[name] !== this.values![name]) return undefined;
    return getRaw(this.values!, name);
  }

  /**
   * A random-access source over a bytes field (or a field read from a stream) without
   * materializing it: decoded pieces and ranged codec blocks stay lazy. For nesting views:
   * `Inner.view(outer.$source("file"))`.
   */
  source(name: string): SyncSource {
    try {
      return storeSource(storeOfValue(this.rawField(name), name));
    } catch (e) {
      return rethrowAt(e, ...this.path, name);
    }
  }

  set(name: string, value: unknown): void {
    const fi = this.info.fields[name];
    try {
      if (!fi) fail("INPUT", `${this.info.name} has no field ${name}`);
      if (fi.input === "absent") fail("INPUT", `${name} is derived and cannot be set`);
      const enc = this.info.encode[name];
      if (enc && !this.materialized) {
        // Encoding validates the value (range, type, checks) right away, even for structural edits.
        this.ensureScanned();
        const range = this.ranges![name];
        const values = { ...this.forced(), [name]: value };
        const bytes = enc(value, values, ...this.args);
        if (fi.patch && !fi.structural && range && bytes.length === range[1] - range[0]) {
          this.space.patch(range[0], bytes, this);
          return;
        }
      }
      this.materialize()[name] = value;
      this.root.markStructural();
    } catch (e) {
      rethrowAt(e, ...this.path, name);
    }
  }

  delete(name: string): void {
    const m = this.materialize();
    delete m[name];
    this.root.markStructural();
  }

  /** Values with lazies forced (for encoders). */
  private forced(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this.values!)) out[k] = isLazy(v) ? undefined : v;
    return out;
  }

  materialize(): Record<string, unknown> {
    if (!this.materialized) {
      this.ensureScanned();
      this.materialized = { ...this.values };
    }
    return this.materialized;
  }
}

/** Array of a field: lazy (fixed-size elements) or a list of values/views. */
export class ArrayNode {
  readonly root: ViewRoot;
  readonly space: Space;
  readonly owner: StructNode | undefined;
  readonly path: PathSegment[];
  /** Path of the context that created the array (element views extend it). */
  private readonly ownerPath: PathSegment[];
  private readonly lazy:
    | {
        start: number;
        count: number;
        /** Element size (fixed-size elements), or 0 with `pos`. */
        size: number;
        /** Element positions of `at`-placed elements (`T x[] at f($index)`). */
        pos?: ((i: number) => number) | undefined;
        elem: (r: Reader, i: number) => unknown;
        encode: ((v: unknown) => Uint8Array) | undefined;
        base: number;
        end: number;
        strict: boolean;
      }
    | undefined;
  private readonly cache = new Map<number, unknown>();
  private cacheVersion = 0;
  items: unknown[] | undefined;
  readonly view: unknown[];

  constructor(
    root: ViewRoot,
    space: Space,
    owner: StructNode | undefined,
    path: PathSegment[],
    ownerPath: PathSegment[],
    lazy: ArrayNode["lazy"],
    items: unknown[] | undefined
  ) {
    this.root = root;
    this.space = space;
    this.owner = owner;
    this.path = path;
    this.ownerPath = ownerPath;
    this.lazy = lazy;
    this.items = items;
    this.view = arrayProxy(this);
  }

  get length(): number {
    return this.items ? this.items.length : this.lazy!.count;
  }

  /** Position of element `i` of a lazily read array. */
  private elementPos(i: number): number {
    const l = this.lazy!;
    return l.pos ? l.pos(i) : l.start + i * l.size;
  }

  get(i: number): unknown {
    if (this.items) return force(this.items[i]);
    const l = this.lazy!;
    if (i < 0 || i >= l.count || !Number.isInteger(i)) return undefined;
    if (this.cacheVersion !== this.space.version) {
      this.cache.clear();
      this.cacheVersion = this.space.version;
    }
    if (this.cache.has(i)) return this.cache.get(i);
    const r = this.space.reader(this.elementPos(i), l.base, l.end, l.strict);
    r.index = i;
    let v: unknown;
    try {
      v = withScan(
        { root: this.root, space: this.space, node: this.owner, path: this.ownerPath },
        () => force(l.elem(r, i))
      );
    } catch (e) {
      rethrowWithPath(e, [...this.path, i]);
    }
    // Struct elements become nodes whose identity is cached by the root; scalars are cached here.
    this.cache.set(i, v);
    return v;
  }

  set(i: number, v: unknown): void {
    if (!this.items && this.lazy?.encode && !this.lazy.pos && i >= 0 && i < this.lazy.count) {
      const old = this.get(i);
      if (typeof old !== "object" || old === null) {
        const bytes = this.lazy.encode(v);
        if (bytes.length === this.lazy.size) {
          this.space.patch(this.lazy.start + i * this.lazy.size, bytes, this.owner);
          return;
        }
      }
    }
    this.materialize()[i] = v;
    this.root.markStructural();
  }

  materialize(): unknown[] {
    if (!this.items) {
      const n = this.lazy!.count;
      const out: unknown[] = new Array(n);
      for (let i = 0; i < n; i++) out[i] = this.get(i);
      this.items = out;
    }
    if (this.owner && !this.owner.materialized) this.owner.materialize();
    return this.items;
  }

  snapshot(): unknown[] {
    const out: unknown[] = [];
    for (let i = 0; i < this.length; i++) out.push(this.get(i));
    return out;
  }
}

// ── proxies ────────────────────────────────────────────────────────────────────

const NODE = Symbol.for("yaffle.node");

/** The node behind a struct or array view (undefined for other values). */
export function nodeOf(v: unknown): StructNode | ArrayNode | undefined {
  if ((typeof v === "object" || typeof v === "function") && v !== null) {
    return (v as { [NODE]?: StructNode | ArrayNode })[NODE];
  }
  return undefined;
}

function structProxy(getNode: () => StructNode): object {
  return new Proxy(
    {},
    {
      get(_t, key) {
        const node = getNode();
        if (key === NODE) return node;
        if (typeof key === "symbol") return undefined;
        if (key === "then") return undefined;
        if (key[0] === "$") return viewMethod(node, key);
        return node.get(key);
      },
      set(_t, key, value) {
        if (typeof key === "symbol") return false;
        getNode().set(key, value);
        return true;
      },
      deleteProperty(_t, key) {
        if (typeof key === "symbol") return false;
        getNode().delete(key);
        return true;
      },
      has(_t, key) {
        return typeof key === "string" && getNode().has(key);
      },
      ownKeys() {
        return getNode().keys();
      },
      getOwnPropertyDescriptor(_t, key) {
        const node = getNode();
        if (typeof key !== "string" || !node.has(key)) return undefined;
        return { value: node.get(key), enumerable: true, configurable: true, writable: true };
      }
    }
  );
}

function viewMethod(node: StructNode, key: string): unknown {
  const root = node.root;
  switch (key) {
    case "$offset":
      return node.pos;
    case "$size":
      return node.size;
    case "$raw":
      return () => node.space.store.get(node.pos, node.size);
    case "$set":
      return (values: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(values)) node.set(k, v);
      };
    case "$patches":
      return (opts?: CommitOptions) => root.patches(opts);
    case "$commit":
      return (opts?: CommitOptions) => root.commit(opts);
    case "$plain":
      return () => plain(node.view);
    case "$node":
      return node;
    case "$source":
      return (name: string) => node.source(name);
    default:
      return node.get(key);
  }
}

const MUTATORS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin"
]);

function arrayProxy(node: ArrayNode): unknown[] {
  const target: unknown[] = [];
  return new Proxy(target, {
    get(_t, key) {
      if (key === NODE) return node;
      if (key === "length") return node.length;
      if (typeof key === "string") {
        const i = indexKey(key);
        if (i !== undefined) return node.get(i);
        if (MUTATORS.has(key)) {
          return (...args: unknown[]) => {
            const items = node.materialize();
            node.root.markStructural();
            return (items as unknown as Record<string, (...a: unknown[]) => unknown>)[key]!(
              ...args
            );
          };
        }
        if (key === "$plain") return () => plain(node.view);
        if (key === "$node") return node;
        if (key === "then") return undefined;
      }
      if (key === Symbol.iterator) return () => node.snapshot()[Symbol.iterator]();
      const snap = node.snapshot();
      const v = Reflect.get(snap, key);
      return typeof v === "function" ? v.bind(snap) : v;
    },
    set(_t, key, value) {
      if (key === "length") {
        node.materialize().length = Number(value);
        node.root.markStructural();
        return true;
      }
      if (typeof key === "string") {
        const i = indexKey(key);
        if (i !== undefined) {
          node.set(i, value);
          return true;
        }
      }
      return false;
    },
    has(_t, key) {
      if (key === "length") return true;
      if (typeof key === "string") {
        const i = indexKey(key);
        if (i !== undefined) return i < node.length;
      }
      return false;
    },
    ownKeys() {
      return [...Array.from({ length: node.length }, (_, i) => String(i)), "length"];
    },
    getOwnPropertyDescriptor(_t, key) {
      if (key === "length")
        return { value: node.length, writable: true, enumerable: false, configurable: false };
      if (typeof key === "string") {
        const i = indexKey(key);
        if (i !== undefined && i < node.length) {
          return { value: node.get(i), writable: true, enumerable: true, configurable: true };
        }
      }
      return undefined;
    }
  });
}

function indexKey(key: string): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(key)) return undefined;
  return Number(key);
}

/** A deep plain snapshot of a view (views → objects/arrays, lazies forced). */
export function plain(v: unknown, seen = new Map<unknown, unknown>()): unknown {
  const n = nodeOf(v);
  if (!n) {
    if (Array.isArray(v)) return v.map(x => plain(force(x), seen));
    if (v instanceof Uint8Array || typeof v !== "object" || v === null) return v;
    if (seen.has(v)) return seen.get(v);
    const out: Record<string, unknown> = {};
    seen.set(v, out);
    for (const [k, x] of Object.entries(v)) out[k] = plain(force(x), seen);
    return out;
  }
  if (seen.has(v)) return seen.get(v);
  if (n instanceof ArrayNode) {
    const out: unknown[] = [];
    seen.set(v, out);
    for (let i = 0; i < n.length; i++) out.push(plain(n.get(i), seen));
    return out;
  }
  const out: Record<string, unknown> = {};
  seen.set(v, out);
  for (const k of n.keys()) out[k] = plain(n.get(k), seen);
  return out;
}

// ── helpers called by generated scan functions ─────────────────────────────────

function nodeKey(space: Space, pos: number, info: StructInfo, args: unknown[]): string {
  return `${space.id}:${pos}:${info.key}(${args.map(a => (typeof a === "object" ? "o" : String(a))).join(",")})`;
}

/** An inline struct: a child view (scanned now only if its size is not static). */
export function child<T = object>(
  r: Reader,
  info: StructInfo,
  args: unknown[],
  seg: () => PathSegment[]
): T {
  const c = current();
  const path = pathIn(c, seg());
  const node = c.root.node(c.space, r.pos, info, args, {
    base: r.base,
    end: r.rawEnd,
    index: r.index,
    strict: r.strict,
    parent: c.node,
    path
  });
  if (info.staticSize !== undefined && !info.base) {
    if (r.rawEnd !== UNKNOWN_END && !r.covers(r.pos + info.staticSize)) {
      // Scan it now, so the error names the field that runs out of bytes (as `parse` does).
      node.ensureScanned();
      r.fail("EOF", `need ${info.staticSize} bytes for ${info.name}`);
    }
    r.pos += info.staticSize;
  } else {
    node.ensureScanned();
    // A base struct's region includes its targets (measured eagerly, as parse reads it).
    r.pos = info.base ? node.regionEnd() : node.extentEnd;
    if (r.pos > r.maxEnd) r.maxEnd = r.pos;
  }
  return node.view as T;
}

/** The path of a view created in scan context `c` for the segments `seg`. */
function pathIn(c: ScanCtx, seg: readonly PathSegment[]): PathSegment[] {
  return [...c.path, ...cleanPath(seg)];
}

/** An array view created in scan context `c`. */
function arrayView<T>(
  c: ScanCtx,
  path: PathSegment[],
  lazy: ConstructorParameters<typeof ArrayNode>[5],
  items: T[] | undefined
): T[] {
  return new ArrayNode(c.root, c.space, c.node, path, c.path, lazy, items).view as T[];
}

/**
 * Reads the element of a lazily read array that runs out of bytes (or any element), so a scan
 * fails with the same error and path as `parse` would.
 */
function readElementNow(
  c: ScanCtx,
  path: PathSegment[],
  r: Reader,
  at: number,
  i: number,
  elem: (r: Reader, i: number) => unknown
): void {
  const r2 = c.space.reader(at, r.base, r.rawEnd, r.strict);
  r2.index = i;
  try {
    withScan({ root: c.root, space: c.space, node: c.node, path: c.path }, () => {
      const v = force(elem(r2, i));
      const n = nodeOf(v);
      if (n instanceof StructNode) n.ensureScanned();
    });
  } catch (e) {
    rethrowWithPath(e, [...path, i]);
  }
}

/** A fixed-size-element array: elements are read on access. */
export function lazyArray<T = unknown>(
  r: Reader,
  count: number,
  size: number,
  elem: (r: Reader, i: number) => T,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generated element encoders
  encode: ((v: any) => Uint8Array) | undefined,
  seg: () => PathSegment[]
): T[] {
  const c = current();
  const start = r.pos;
  const total = count * size;
  const path = pathIn(c, seg());
  // Over a stream whose size is not known yet, the elements check their bounds when read
  // (resolving the size here would decode every piece up to the array's end).
  if (r.rawEnd !== UNKNOWN_END && !r.covers(start + total)) {
    const k = Math.max(0, Math.min(count - 1, Math.floor((r.end - start) / size)));
    readElementNow(c, path, r, start + k * size, k, elem);
    r.fail("EOF", `need ${total} bytes for ${count} elements`);
  }
  r.pos += total;
  const lazy = { start, count, size, elem, encode, base: r.base, end: r.rawEnd, strict: r.strict };
  return arrayView<T>(c, path, lazy, undefined);
}

/**
 * An array whose elements each sit at their own offset (`T x[n] at f($index)`, or `T x[] at
 * f($index)` up to the region end): the count comes from the offsets alone, and elements are
 * read on access. `offset(i)` is the offset from the base.
 */
export function placedArray<T = unknown>(
  r: Reader,
  count: number | undefined,
  offset: (i: number) => number,
  elem: (r: Reader, i: number) => T,
  seg: () => PathSegment[]
): T[] {
  const c = current();
  const base = r.base;
  const path = pathIn(c, seg());
  const at = (i: number): number => {
    try {
      return base + offset(i);
    } catch (e) {
      return rethrowAt(e, i);
    }
  };
  let n = count;
  if (n === undefined) {
    const end = r.end;
    n = 0;
    while (at(n) < end) n++;
  }
  const lazy = {
    start: n ? at(0) : base,
    count: n,
    size: 0,
    pos: at,
    elem,
    encode: undefined,
    base,
    end: r.rawEnd,
    strict: r.strict
  };
  return arrayView<T>(c, path, lazy, undefined);
}

/** An array whose elements were read already (variable-size elements). */
export function arrayOf<T>(items: T[], seg: () => PathSegment[]): T[] {
  const c = current();
  return arrayView(c, pathIn(c, seg()), undefined, items);
}

/** Bytes read on access. */
export function lazyBytes(r: Reader, n: number): Uint8Array {
  const c = current();
  const start = r.pos;
  if (!Number.isSafeInteger(n) || n < 0) r.fail("RANGE", `invalid length ${n}`);
  if (r.rawEnd !== UNKNOWN_END && !r.covers(start + n))
    r.fail("EOF", `need ${n} bytes at 0x${start.toString(16)}`);
  r.pos += n;
  const { base, strict } = r;
  const end = r.rawEnd;
  const space = c.space;
  const lazy = new Lazy(() => space.reader(start, base, end, strict).bytes(n), space);
  lazy.length = n;
  lazy.toStore = () => new SliceStore(space.store, start, n);
  return lazy as unknown as Uint8Array;
}

/**
 * Bytes to the end of the region, read on access. Over a stream whose size is not known yet,
 * the size stays unknown until the bytes are read (a store over them stays lazy).
 */
export function lazyRest(r: Reader): Uint8Array {
  if (r.rawEnd !== UNKNOWN_END) return lazyBytes(r, r.rawEnd - r.pos);
  const c = current();
  const start = r.pos;
  const { base, strict } = r;
  const space = c.space;
  const lazy = new Lazy(() => {
    const r2 = space.reader(start, base, UNKNOWN_END, strict);
    return r2.bytes(r2.end - start);
  }, space);
  lazy.toStore = () => new SliceStore(space.store, start);
  // Nothing follows a rest read in its region: anything read later is past the end.
  r.pos = UNKNOWN_END;
  return lazy as unknown as Uint8Array;
}

/** A pointer or `at` target, read on access (identity per address and type key). */
export function lazyTarget<T>(
  r: Reader,
  addr: number,
  key: string,
  read: (r: Reader) => T,
  seg: PathSegment[] = []
): T {
  const c = current();
  const { base, strict } = r;
  const end = r.rawEnd;
  const path = pathIn(c, seg);
  const lazy: Lazy<unknown> = new Lazy(() => {
    const k = `${c.space.id}:${addr}:${key}:${c.space.version}`;
    const hit = c.root.targets.get(k);
    if (hit !== undefined) {
      lazy.target!.size = c.root.targetSizes.get(k);
      return hit;
    }
    if (!Number.isSafeInteger(addr) || addr < 0 || !storeCovers(c.space.base, addr)) {
      fail("EOF", `target address 0x${addr.toString(16)} is outside the data`, addr);
    }
    const r2 = c.space.reader(addr, base, end, strict);
    const v = withScan({ root: c.root, space: c.space, node: undefined, path }, () =>
      force(read(r2))
    );
    if (typeof v === "object" && v !== null) {
      c.root.origins.set(v, { pos: addr, size: r2.pos - addr, space: c.space });
    }
    c.root.targets.set(k, v);
    c.root.targetSizes.set(k, r2.pos - addr);
    lazy.target!.size = r2.pos - addr;
    return v;
  }, c.space);
  lazy.target = { addr, space: c.space, size: undefined };
  return lazy as unknown as T;
}

/**
 * A store over the bytes of a value: zero-copy for lazily read bytes; for values read from a
 * codec region or a stream, the decoded or joined bytes; for a struct view, its bytes.
 */
function storeOfValue(v: unknown, what = "the field"): ByteStore {
  if (v instanceof Uint8Array) return new ArrayStore(v);
  if (isLazy(v)) {
    if (v.toStore) return v.toStore();
    v = v.get();
    if (v instanceof Uint8Array) return new ArrayStore(v);
  }
  const n = nodeOf(v);
  if (n instanceof StructNode) return new SliceStore(n.space.store, n.pos, n.size);
  return fail("INPUT", `${what} is not a byte value`);
}

/** The bytes a lazily read value covers: its own store if it is bytes, else the whole space. */
function storeIn(space: Space, inner: unknown): ByteStore {
  return inner instanceof Uint8Array || (isLazy(inner) && inner.toStore)
    ? storeOfValue(inner)
    : space.store;
}

/** True if any patch of `space` after the first `since` overlaps `[start, end)`. */
function patchedSince(space: Space, since: number, start: number, end: number): boolean {
  const ps = space.patches;
  for (let i = since; i < ps.length; i++) {
    const p = ps[i]!;
    if (p.at < end && start < p.at + p.data.length) return true;
  }
  return false;
}

/**
 * A codec region: decoded on access (async codecs throw `NeedAsync`, handled by async views).
 * Streaming codecs are decoded right away (their encoded length is only known after decoding).
 * Ranged codecs decode only the blocks a read touches (`RangedStore`).
 */
export function lazyRegion<T>(
  r: Reader,
  codec: Codec,
  name: string,
  ctx: CodecCtx,
  opts: { streaming: boolean; ranged: boolean; async: boolean; slot: string },
  read: (r: Reader) => T
): T {
  const c = current();
  const start = r.pos;
  const strict = r.strict;
  let decoded: Uint8Array | undefined;
  let end = r.end;
  const input = (): Uint8Array => c.space.store.get(start, end - start);
  if (opts.streaming) {
    const d = decode(codec, name, c.space.store.get(start, end - start), ctx, true, start);
    decoded = d.output;
    end = start + d.consumed;
  }
  r.pos = end;
  const key = `${c.space.id}:${start}:${opts.slot}`;
  const ranged = opts.ranged && !opts.async && !decoded;
  const makeSpace = (): Space => {
    let store: ByteStore;
    if (ranged) {
      store = new RangedStore(
        c.space.store,
        start,
        end - start,
        (bytes, position) =>
          decode(codec, name, bytes, { ...ctx, position }, false, start + position).output
      );
    } else {
      let out = decoded;
      if (!out) {
        const cached = c.root.asyncDecoded.get(key);
        if (cached) out = cached;
        else if (opts.async) {
          throw new NeedAsync(key, async () => {
            const res = await (codec.decode(input(), ctx) as Promise<unknown>);
            if (!(res instanceof Uint8Array))
              fail("CODEC", `codec ${name} decode returned ${typeof res}`);
            c.root.asyncDecoded.set(key, res);
          });
        } else out = decode(codec, name, input(), ctx, false, start).output;
      }
      store = new ArrayStore(new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
    }
    return new Space(c.root, store, {
      parent: c.space,
      start,
      end,
      codec,
      name,
      ctx,
      ranged: opts.ranged
    });
  };
  // The decoded space stays the same object until a patch changes the encoded bytes, so edits
  // inside it survive edits elsewhere in the parent.
  const getSpace = (): Space => {
    const known = c.root.regions.get(key);
    if (known) {
      const since = c.root.regionPatches.get(key) ?? 0;
      if (!patchedSince(c.space, since, start, end)) return known;
      if (known.patches.length) {
        fail("INPUT", `conflicting edits: a ${name} region was patched inside and outside`);
      }
    }
    const sp = makeSpace();
    if (!transient) {
      c.root.regions.set(key, sp);
      c.root.regionPatches.set(key, c.space.patches.length);
    }
    return sp;
  };
  return lazyIn(c, c.path, strict, getSpace, read, (v, space) => {
    // Ranged regions re-encode to the same bytes; remembering would decode them whole.
    if (!transient && !ranged) {
      rememberCodec(v, opts.slot, input().slice(), space.base.get(0, space.base.size).slice());
    }
  });
}

/**
 * A value read from the start of another byte space (a decoded region or a stream), on access.
 * `after` sees each value read.
 */
function lazyIn<T>(
  c: ScanCtx,
  path: PathSegment[],
  strict: boolean,
  getSpace: () => Space,
  read: (r: Reader) => T,
  after?: (v: unknown, space: Space) => void
): T {
  const readIn = <R>(space: Space, f: (r2: Reader) => R): R => {
    const end = space.base.lazySize ? UNKNOWN_END : space.base.size;
    const r2 = space.reader(0, 0, end, strict);
    return withScan({ root: c.root, space, node: undefined, path }, () => f(r2));
  };
  const lazy = new Lazy(() => {
    const space = getSpace();
    const v = readIn(space, r2 => force(read(r2)));
    after?.(v, space);
    return v;
  }, c.space);
  lazy.toStore = () => {
    const space = getSpace();
    return storeIn(space, readIn(space, read));
  };
  return lazy as unknown as T;
}

/**
 * A field read from a virtual stream (`T x from …`), on access. The stream is a byte store
 * (`viewPieces`, `streamOf`, `streamSlice`), so only the bytes the read touches are decoded. The
 * stream's space stays the same object while it has edits.
 */
export function lazyStream<T>(
  r: Reader,
  slot: string,
  stream: () => ByteStore,
  strict: boolean,
  read: (r: Reader) => T,
  seg: PathSegment[] = []
): T {
  const c = current();
  const key = `${c.space.id}:${r.pos}:${slot}`;
  const getSpace = (): Space => {
    const known = c.root.streams.get(key);
    if (known && (known.space.patches.length || known.parentPatches === c.space.patches.length))
      return known.space;
    const space = new Space(c.root, stream());
    if (!transient) c.root.streams.set(key, { space, parentPatches: c.space.patches.length });
    return space;
  };
  return lazyIn(c, pathIn(c, seg), strict, getSpace, read);
}

/** The stream of a field (`T x from raw`): a store over the field's bytes. */
export function streamOf(v: unknown): ByteStore {
  return storeOfValue(v, "the stream field");
}

/** `s[start..end]` of a stream (end omitted: to the stream's end). */
export function streamSlice(s: ByteStore, start: number, end?: number): ByteStore {
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    (end !== undefined && end < start) ||
    !storeCovers(s, end ?? start)
  ) {
    fail("EOF", `stream slice [${start}, ${end ?? "end"}) is outside the stream`);
  }
  return new SliceStore(s, start, end === undefined ? undefined : end - start);
}

/**
 * The stream `arr[*].field` of a view: the elements' byte fields joined, decoded piece by piece
 * on demand (`PieceStore`). Piece lengths come from `knownLength` (the size fields the schema
 * reads), so mapping an offset to its piece reads headers only.
 */
export function viewPieces(arr: unknown, field: string): PieceStore {
  const list = nodeOf(arr);
  const node = list instanceof ArrayNode ? list : undefined;
  const items = node ? undefined : Array.isArray(arr) ? (arr as unknown[]) : undefined;
  if (!node && !items) fail("INPUT", `the stream's array is not an array`);
  const element = (i: number): unknown => (node ? node.get(i) : items![i]);
  const raw = (i: number): unknown => {
    const e = element(i);
    const n = nodeOf(e);
    if (n instanceof StructNode) return n.rawField(field);
    if (typeof e !== "object" || e === null) return undefined;
    return fieldValue(e, field);
  };
  return new PieceStore({
    count: node ? node.length : items!.length,
    length(i: number): number | undefined {
      const v = raw(i);
      return v instanceof Uint8Array ? v.length : isLazy(v) ? v.length : undefined;
    },
    bytes(i: number): Uint8Array {
      try {
        const v = raw(i);
        const b = isLazy(v) ? v.peek() : v;
        if (!(b instanceof Uint8Array)) fail("INPUT", `stream piece ${i} has no bytes in ${field}`);
        return b;
      } catch (e) {
        // A piece that fails to decode is reported where `parse` reports it: at the piece.
        return rethrowWithPath(e, node ? [...node.path, i, field] : [i, field]);
      }
    }
  });
}

// ── the view root ──────────────────────────────────────────────────────────────

export type GrowPolicy = "append" | "splice" | "error";

export interface CommitOptions {
  /** How size changes are handled: "append" (default for pointer targets), "splice", "error". */
  grow?: GrowPolicy;
  /**
   * Re-encode the whole value through the writer even without structural edits (by default,
   * only in-place patches are applied then). Checks that a view rebuilds its own bytes.
   */
  rewrite?: boolean;
}

export interface Patch {
  /** Offset in the original bytes. */
  at: number;
  /** Bytes removed there. */
  remove: number;
  /** Bytes inserted there. */
  insert: Uint8Array;
}

export interface ViewSpec {
  info: StructInfo;
  args: unknown[];
  strict: boolean;
  layout: readonly LayoutItem[] | undefined;
  write: (w: Writer, value: unknown) => LStruct | void;
  /** Async formats (async codecs): the async root writer, used by async views' commits. */
  writeAsync?: ((w: Writer, value: unknown) => Promise<LStruct | void>) | undefined;
}

export class ViewRoot {
  space: Space;
  readonly spec: ViewSpec;
  readonly nodes = new Map<string, StructNode>();
  readonly targets = new Map<string, unknown>();
  /** Bytes each target read consumed (same keys as `targets`). */
  readonly targetSizes = new Map<string, number>();
  readonly regions = new Map<string, Space>();
  /** Number of parent patches when each region space was created (later ones may stale it). */
  readonly regionPatches = new Map<string, number>();
  /** Spaces of virtual streams read so far. */
  readonly streams = new Map<string, { space: Space; parentPatches: number }>();
  readonly asyncDecoded = new Map<string, Uint8Array>();
  origins = new WeakMap<object, { pos: number; size: number; space: Space }>();
  structural = false;
  version = 0;
  rootNode: StructNode;
  /** Sources with `write` get the committed bytes written back. */
  readonly sink: ((bytes: Uint8Array, patches: Patch[]) => void) | undefined;

  constructor(
    store: ByteStore,
    spec: ViewSpec,
    sink?: (bytes: Uint8Array, patches: Patch[]) => void
  ) {
    this.spec = spec;
    this.space = new Space(this, store);
    this.sink = sink;
    this.rootNode = this.makeRoot();
  }

  private makeRoot(): StructNode {
    return new StructNode(this, this.space, this.spec.info, 0, this.spec.args, {
      base: 0,
      end: this.space.base.lazySize ? UNKNOWN_END : this.space.base.size,
      index: -1,
      strict: this.spec.strict,
      parent: undefined,
      path: []
    });
  }

  /** The root view: always resolves to the current root node (also after `$commit`). */
  readonly view: object = structProxy(() => this.rootNode);

  node(space: Space, pos: number, info: StructInfo, args: unknown[], ctx: NodeCtx): StructNode {
    const k = nodeKey(space, pos, info, args);
    let n = this.nodes.get(k);
    if (!n) {
      n = new StructNode(this, space, info, pos, args, ctx);
      this.nodes.set(k, n);
    }
    return n;
  }

  markStructural(): void {
    this.structural = true;
    this.version++;
  }

  /** The edits as patches against the original bytes (no side effects). */
  patches(opts: CommitOptions = {}): Patch[] {
    return plan(this, opts).patches;
  }

  /** Applies all edits; returns the new bytes and rebinds the view to them. */
  commit(opts: CommitOptions = {}): Uint8Array {
    const p = plan(this, opts);
    const bytes = p.bytes();
    if (this.sink) this.sink(bytes, p.patches);
    this.rebind(new ArrayStore(bytes));
    return bytes;
  }

  rebind(store: ByteStore): void {
    this.space = new Space(this, store);
    this.nodes.clear();
    this.targets.clear();
    this.targetSizes.clear();
    this.regions.clear();
    this.regionPatches.clear();
    this.streams.clear();
    this.asyncDecoded.clear();
    this.origins = new WeakMap();
    this.structural = false;
    this.version++;
    this.rootNode = this.makeRoot();
  }
}
