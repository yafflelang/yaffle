/**
 * The layout engine (docs/IR.md §4): assigns every placeable of a base region a position.
 *
 * - Default order: the base's own bytes first, then each placeable's unit in pre-order
 *   (a unit = the target's own bytes, then its own targets).
 * - `layout { … }` items of a struct order that struct's own targets: a path naming a placeable
 *   places its unit (minus anything already placed); a path naming inline data or `[*]` elements
 *   places the remaining units reachable from there; `this` places the struct's own bytes.
 *   Items in an outer struct run first, so they pull groups out of inner layouts.
 * - Item layers (`align`, `padBefore`, `padAfter`, `alignEnd`) apply to every block an item
 *   places unless a nested item specifies its own. Placement constraints (`at sector * 0x800`)
 *   and alignment required by a block's content add to that. Layer arguments that read fields
 *   are evaluated per struct instance by the generated writer (`LStruct.layout`).
 * - Fixed placements go exactly where they say; overlaps are OVERLAP errors and sequential
 *   placement flows around them.
 * - Sticky mode (view commits): placeables keep their original positions where possible
 *   (see `StickyPolicy`).
 */
import { fail } from "./errors.ts";
import { num, type Int } from "./int.ts";
import {
  LArray,
  LStruct,
  Placeable,
  fileStart,
  lcm,
  modulo,
  type LEntry,
  type Region
} from "./writer.ts";

export type LayoutLayer =
  /** With `offset`/`file`, the block start satisfies `(start - origin + offset) % to == 0`. */
  | { kind: "align"; to: number; offset?: number; file?: boolean }
  | { kind: "padBefore"; count: number }
  | { kind: "padAfter"; count: number }
  | { kind: "alignEnd"; to: number };

export interface LayoutItem {
  /** "this", or field names with "*" for `[*]`. */
  path: "this" | readonly string[];
  layers: readonly LayoutLayer[];
  /**
   * Per-element group: `path` names an array; for each element in order, these
   * items (paths relative to the element, "this" = the element itself when it is a target) are
   * placed in order. Everything they name is claimed by the group.
   */
  group?: readonly LayoutItem[];
}

/**
 * How a view commit treats size changes:
 * - "default": targets that grow move to the end; everything else stays unless pushed forward
 *   by growth before it (then it shifts by the minimum that keeps alignment).
 * - "append": like default, but targets pushed by inline growth move to the end too.
 * - "splice": nothing moves to the end; every size change shifts what follows (both directions).
 * - "error": any size change is an error.
 */
export interface StickyPolicy {
  grow: "default" | "append" | "splice" | "error";
  /** Size of the base's own bytes in the original (undefined: no original). */
  origRootSize: number | undefined;
  /** Original size of the whole region. */
  origSize?: number;
}

/** A layout item's alignment computed from fields: a safe integer of at least 1, else RANGE. */
export function layoutAlign(v: Int): number {
  const n = num(v, "alignment");
  if (n < 1) fail("RANGE", `alignment ${n} is less than 1`);
  return n;
}

/** The layout items of a region's root struct: its own (per instance), else the region's. */
function rootItems(region: Region): readonly LayoutItem[] | undefined {
  return region.lroot?.layout ?? region.layout;
}

function checkAlign(to: number): void {
  if (!(Number.isSafeInteger(to) && to >= 1)) fail("RANGE", `alignment ${to} is less than 1`);
}

function alignUp(x: number, a: number): number {
  return a <= 1 ? x : Math.ceil(x / a) * a;
}

interface Range {
  start: number;
  end: number;
  name: string;
}

/** A block start's alignment, plus residues `start % to == rem` (alignment offsets and origins). */
interface Requirement {
  align: number;
  residues: readonly { to: number; rem: number }[];
}

class Engine {
  cursor: number;
  readonly reserved: Range[] = [];
  readonly region: Region;
  constructor(region: Region) {
    this.region = region;
    this.cursor = region.root.size;
    if (region.root.size) this.reserved.push({ start: 0, end: region.root.size, name: "base" });
  }

  placeFixed(p: Placeable): void {
    const start = p.fixed!;
    if (!Number.isSafeInteger(start) || start < 0)
      fail("RANGE", `invalid fixed offset ${start} for ${p.name}`);
    const end = start + p.block.size;
    if (end > start) {
      for (const r of this.reserved) {
        if (start < r.end && r.start < end) {
          fail(
            "OVERLAP",
            `${p.name} at [0x${start.toString(16)}, 0x${end.toString(16)}) overlaps ${r.name} at [0x${r.start.toString(16)}, 0x${r.end.toString(16)})`
          );
        }
      }
      this.reserved.push({ start, end, name: p.name });
    }
    p.block.pos = start;
  }

  /** Smallest position ≥ cursor satisfying alignment and constraint and not overlapping fixed ranges. */
  findPos(p: Placeable, align: number, from: number): number {
    const size = p.block.size;
    let pos = this.satisfy(p, align, from);
    for (let guard = 0; guard < 100000; guard++) {
      const hit =
        size > 0 ? this.reserved.find(r => pos < r.end && r.start < pos + size) : undefined;
      if (!hit) return pos;
      pos = this.satisfy(p, align, hit.end);
    }
    return fail("OVERLAP", `no room for ${p.name}`);
  }

  satisfy(p: Placeable, align: number, from: number): number {
    let pos = alignUp(from, align);
    for (let guard = 0; !meetsConstraint(p, pos);) {
      pos += align;
      const { modulus: m, remainder } = p.constraint!;
      if (++guard > m) {
        fail(
          "DERIVE",
          `placement constraint ≡ ${modulo(remainder, m)} (mod ${m}) cannot be met with alignment ${align}`
        );
      }
    }
    return pos;
  }

  /** Placeables claimed by a layout item of an enclosing container (placed only by that item). */
  readonly claimed = new Set<Placeable>();
  /** Placeables whose unit is being placed (cycles in the target graph). */
  private readonly visiting = new Set<Placeable>();

  /** What a block's start must satisfy: its own alignment plus its item layers'. */
  requirement(p: Placeable, layers: readonly LayoutLayer[]): Requirement {
    let align = p.block.align;
    // `@align(n, offset: k)` / `from: file` items: a residue instead of a plain alignment.
    const residues: { to: number; rem: number }[] = [];
    for (const l of layers) {
      if (l.kind !== "align") continue;
      checkAlign(l.to);
      if (l.offset || l.file) {
        const origin = l.file ? fileStart(this.region.root, l.to) : 0;
        residues.push({ to: l.to, rem: modulo(-(origin + (l.offset ?? 0)), l.to) });
      } else align = lcm(align, l.to);
    }
    return { align, residues };
  }

  /** Like `findPos`, also meeting the requirement's residues. */
  findPosFor(p: Placeable, req: Requirement, from: number): number {
    let pos = this.findPos(p, req.align, from);
    for (let guard = 0; !meetsResidues(req, pos); guard++) {
      if (guard > 1 << 20) fail("DERIVE", `no position satisfies the alignment of ${p.name}`);
      pos = this.findPos(p, req.align, pos + 1);
    }
    return pos;
  }

  placeBlock(p: Placeable, layers: readonly LayoutLayer[]): void {
    if (p.placed) {
      // Reaching a fixed placement moves the running position past it.
      if (p.fixed !== undefined) this.cursor = Math.max(this.cursor, p.block.pos + p.block.size);
      return;
    }
    const req = this.requirement(p, layers);
    let cursor = this.cursor;
    for (const l of layers) if (l.kind === "padBefore") cursor += l.count;
    const pos = this.findPosFor(p, req, cursor);
    p.block.pos = pos;
    cursor = pos + p.block.size;
    for (const l of layers) {
      if (l.kind === "padAfter") cursor += l.count;
      else if (l.kind === "alignEnd") {
        checkAlign(l.to);
        cursor = alignUp(cursor, l.to);
      }
    }
    this.cursor = Math.max(this.cursor, cursor);
  }

  placeUnit(p: Placeable, layers: readonly LayoutLayer[]): void {
    if (this.visiting.has(p)) {
      this.placeBlock(p, layers);
      return;
    }
    this.visiting.add(p);
    try {
      const c = p.content;
      if (c instanceof LStruct) this.processStruct(c, c.layout, p, layers);
      else {
        this.placeBlock(p, layers);
        if (c) this.placeRemaining(c, layers);
      }
    } finally {
      this.visiting.delete(p);
    }
  }

  placeRemaining(e: LEntry, layers: readonly LayoutLayer[]): void {
    if (e instanceof Placeable) {
      // A placeable claimed by a container's item is placed by that item only.
      if (!this.claimed.has(e)) this.placeUnit(e, layers);
    } else if (e instanceof LArray) {
      for (const it of e.items) if (it) this.placeRemaining(it, layers);
    } else this.processStruct(e, e.layout, undefined, layers);
  }

  processStruct(
    s: LStruct,
    items: readonly LayoutItem[] | undefined,
    self: Placeable | undefined,
    inherited: readonly LayoutLayer[]
  ): void {
    if (items && items.length) {
      // Claim every placeable an item names, so no other unit places it first.
      const mine = new Set<Placeable>();
      this.claimItems(s, items, mine);
      const thisItem = items.find(i => i.path === "this");
      if (self && !thisItem) this.placeBlock(self, inherited);
      this.placeItems(s, items, self, inherited, mine);
      for (const p of mine) this.claimed.delete(p);
      if (self) this.placeBlock(self, inherited);
    } else if (self) this.placeBlock(self, inherited);
    for (const e of s.fields.values()) this.placeRemaining(e, inherited);
  }

  /** Claims every placeable the items name (group items: for every element of their array). */
  private claimItems(s: LEntry, items: readonly LayoutItem[], mine: Set<Placeable>): void {
    for (const item of items) {
      if (item.path === "this") continue;
      const reached = resolvePath(s, item.path);
      if (item.group) {
        for (const el of elementsOf(reached)) this.claimItems(el, item.group, mine);
        continue;
      }
      for (const e of reached) {
        if (e instanceof Placeable && !this.claimed.has(e) && !e.placed) {
          this.claimed.add(e);
          mine.add(e);
        }
      }
    }
  }

  /** Places the items in order (`self` is what `this` names). */
  private placeItems(
    s: LEntry,
    items: readonly LayoutItem[],
    self: Placeable | undefined,
    inherited: readonly LayoutLayer[],
    mine: Set<Placeable>
  ): void {
    for (const item of items) {
      const layers = item.layers.length ? item.layers : inherited;
      if (item.path === "this") {
        if (self) this.placeBlock(self, layers);
        continue;
      }
      const reached = resolvePath(s, item.path);
      if (item.group) {
        // For each element, its items in order (claims stay until the container is done).
        // An element that is itself a target comes first, like `this` in a unit, unless named.
        const namesThis = item.group.some(g => g.path === "this");
        for (const el of elementsOf(reached)) {
          const self = el instanceof Placeable ? el : undefined;
          if (self && !namesThis) this.placeBlock(self, layers);
          this.placeItems(el, item.group, self, layers, mine);
        }
        continue;
      }
      for (const e of reached) {
        if (e instanceof Placeable) {
          if (mine.has(e)) {
            this.claimed.delete(e);
            this.placeUnit(e, layers);
          } else if (!this.claimed.has(e)) this.placeUnit(e, layers);
        } else this.placeRemaining(e, layers);
      }
    }
  }
}

/** The elements of the arrays a group's path reaches (through pointer targets). */
function elementsOf(reached: readonly LEntry[]): LEntry[] {
  const out: LEntry[] = [];
  for (let e of reached) {
    if (e instanceof Placeable) {
      if (!e.content) continue;
      e = e.content;
    }
    if (e instanceof LArray) for (const it of e.items) if (it) out.push(it);
  }
  return out;
}

/** Entries a layout path reaches from `s` (descending through placeables' contents). */
function resolvePath(s: LEntry, path: readonly string[]): LEntry[] {
  let cur: LEntry[] = [s];
  for (const seg of path) {
    const next: LEntry[] = [];
    for (let e of cur) {
      if (e instanceof Placeable) {
        if (!e.content) continue;
        e = e.content;
      }
      if (seg === "*") {
        if (e instanceof LArray) for (const it of e.items) if (it) next.push(it);
      } else if (e instanceof LStruct) {
        const f = e.fields.get(seg);
        if (f) next.push(f);
      }
    }
    cur = next;
  }
  return cur;
}

/** Runs the engine in default order: the region's own items first, then every unplaced unit. */
function placeAll(engine: Engine, region: Region): void {
  if (region.lroot) engine.processStruct(region.lroot, rootItems(region), undefined, []);
  for (const p of region.placeables) if (!p.placed) engine.placeUnit(p, []);
}

/** Assigns positions to every block of the region. */
export function layoutRegion(region: Region): void {
  if (region.sticky && region.sticky.origRootSize !== undefined) {
    stickyLayout(region, region.sticky);
    return;
  }
  for (const p of region.placeables) p.block.pos = -1;
  const engine = new Engine(region);
  for (const p of region.placeables) if (p.fixed !== undefined) engine.placeFixed(p);
  placeAll(engine, region);
}

/**
 * A dry run of the default layout: the order it places every placeable in, and what each
 * non-fixed placeable's start must satisfy there. Positions are restored afterwards.
 */
function defaultRun(region: Region): { order: Placeable[]; reqs: Map<Placeable, Requirement> } {
  const order: Placeable[] = [];
  const reqs = new Map<Placeable, Requirement>();
  const seen = new Set<Placeable>();
  const saved = region.placeables.map(p => p.block.pos);
  for (const p of region.placeables) p.block.pos = p.fixed ?? -1;
  const engine = new Engine(region);
  const place = engine.placeBlock.bind(engine);
  engine.placeBlock = (p, layers) => {
    if (!seen.has(p)) {
      seen.add(p);
      order.push(p);
      if (!p.placed) reqs.set(p, engine.requirement(p, layers));
    }
    place(p, layers);
  };
  placeAll(engine, region);
  region.placeables.forEach((p, i) => (p.block.pos = saved[i]!));
  return { order, reqs };
}

/** Whether `pos` meets the placeable's `at` constraint (position ≡ remainder mod modulus). */
function meetsConstraint(p: Placeable, pos: number): boolean {
  const c = p.constraint;
  return !c || c.modulus <= 1 || modulo(pos, c.modulus) === modulo(c.remainder, c.modulus);
}

function meetsResidues(req: Requirement, pos: number): boolean {
  return req.residues.every(r => modulo(pos, r.to) === r.rem);
}

/** True if `pos` satisfies the placeable's alignment, residues and placement constraint. */
function fits(p: Placeable, req: Requirement, pos: number): boolean {
  return (
    (req.align <= 1 || pos % req.align === 0) && meetsResidues(req, pos) && meetsConstraint(p, pos)
  );
}

function stickyLayout(region: Region, policy: StickyPolicy): void {
  const { order, reqs } = defaultRun(region);
  const reqOf = (p: Placeable): Requirement =>
    reqs.get(p) ?? { align: p.block.align, residues: [] };
  for (const p of region.placeables) p.block.pos = -1;
  const engine = new Engine(region);
  for (const p of region.placeables) if (p.fixed !== undefined) engine.placeFixed(p);

  const origRoot = policy.origRootSize!;
  if (policy.grow === "error" && region.root.size !== origRoot) {
    fail("DERIVE", `the base grew from ${origRoot} to ${region.root.size} bytes (grow: "error")`);
  }
  const old = region.placeables
    .filter(p => p.orig !== undefined && p.fixed === undefined)
    .sort((a, b) => a.orig! - b.orig!);
  const toEnd: Placeable[] = [];
  let origCursor = origRoot;
  let origEnd = policy.origSize ?? origRoot;
  for (const p of old) origEnd = Math.max(origEnd, p.orig! + (p.origSize ?? 0));

  for (const p of old) {
    const size = p.block.size;
    const origSize = p.origSize ?? size;
    const grows = size > origSize;
    if (policy.grow === "error" && size !== origSize) {
      fail("DERIVE", `${p.name} changed size from ${origSize} to ${size} (grow: "error")`);
    }
    const req = reqOf(p);
    // An empty target can sit anywhere: it keeps its original offset, except
    // under "splice", which shifts everything after a size change.
    if (size === 0 && origSize === 0 && policy.grow !== "splice" && fits(p, req, p.orig!)) {
      p.block.pos = p.orig!;
      continue;
    }
    if (grows && (policy.grow === "default" || policy.grow === "append")) {
      toEnd.push(p);
      origCursor = Math.max(origCursor, p.orig! + origSize);
      continue;
    }
    // The part of the original gap that alignment does not explain is kept.
    const extra = Math.max(0, p.orig! - alignUp(origCursor, req.align));
    let pos: number;
    const keep = fits(p, req, p.orig!);
    if (policy.grow === "splice") {
      pos =
        engine.cursor === origCursor && keep
          ? p.orig!
          : engine.findPosFor(p, req, engine.cursor + extra);
    } else if (engine.cursor <= p.orig! && keep) {
      pos = p.orig!;
      if (engine.reserved.some(r => pos < r.end && r.start < pos + size))
        pos = engine.findPosFor(p, req, pos);
    } else if (policy.grow === "append" || !keep) {
      // Pushed by growth before it (append), or no longer aligned where it was: move to the end.
      toEnd.push(p);
      origCursor = Math.max(origCursor, p.orig! + origSize);
      continue;
    } else {
      pos = engine.findPosFor(p, req, engine.cursor + extra);
    }
    p.block.pos = pos;
    engine.cursor = Math.max(engine.cursor, pos + size);
    origCursor = Math.max(origCursor, p.orig! + origSize);
  }
  // Moved and new placeables go at the end, in default layout order.
  engine.cursor = Math.max(engine.cursor, policy.grow === "splice" ? engine.cursor : origEnd);
  const rest = new Set<Placeable>([...toEnd, ...region.placeables.filter(p => !p.placed)]);
  for (const p of order) {
    if (!rest.has(p) || p.placed) continue;
    p.block.pos = engine.findPosFor(p, reqOf(p), engine.cursor);
    engine.cursor = p.block.pos + p.block.size;
  }
  for (const p of region.placeables) {
    if (!p.placed) {
      p.block.pos = engine.findPos(p, p.block.align, engine.cursor);
      engine.cursor = p.block.pos + p.block.size;
    }
  }
}
