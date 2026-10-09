/**
 * `suggestLayout`: infer `layout { … }` rules (IR.md §4) that reproduce the
 * order and alignment of pointer and `at` targets in a sample file.
 *
 * 1. **Observe.** Decode the sample as a view and build the placement tree of every base region:
 *    *frames* (struct instances, inline or a target's top struct) hold *slots* in declaration
 *    order (placeable targets, inline structs, inline arrays of structs), and every placed target
 *    (*object*) has its byte extent in the file.
 * 2. **Explain.** Walk each region's objects in file order and explain them greedily with layout
 *    items of the enclosing struct, shortest path first (`records` before `records[*]` before
 *    `records[*].model`): an item is accepted when the objects it would place come next as
 *    contiguous blocks (one per match) and each block is explained recursively by the matched
 *    unit's own order (inner struct layouts are inferred along the way, and must agree across
 *    instances).
 * 3. **Minimize.** Drop struct layouts that the default order reproduces, and trailing items the
 *    leftovers rule covers, checking with a simulation of the layout engine.
 * 4. **Align.** From the gaps between consecutive objects, pick per item the alignment that
 *    satisfies most of what it places (inherited by nested items unless they need their own).
 * 5. **Edit.** Insert, replace or remove `layout` blocks.
 */
import type * as A from "../frontend/ast.ts";
import type { StructSym } from "../frontend/symbols.ts";
import type { IrLayoutItem, IrMember, IrStruct, IrType } from "../ir/index.ts";
import * as runtime from "@yaffle/runtime";
import type { TextEdit, WorkspaceEdit } from "./api.ts";
import { access, bareType, sampleOptions, structFields, type SampleProgram } from "./sample.ts";

// ── the placement tree ─────────────────────────────────────────────────────────

interface Obj {
  id: number;
  /** Start and end of the target's own bytes (a nested base: its whole region). */
  start: number;
  end: number;
  kind: "struct" | "array" | "leaf" | "base";
  frame?: Frame;
  /** Arrays of inline structs. */
  elements?: Frame[];
  /** Arrays of owned pointers. */
  elemTargets?: Obj[];
  /** Default pre-order rank (tie-break for objects at the same position). */
  rank: number;
  /** The block's own alignment: `@align` inside its content (the writer aligns the block to it). */
  blockAlign: number;
  label: string;
}

interface Frame {
  struct: IrStruct;
  slots: Slot[];
  /** The target whose top frame this is (undefined for inline frames and the root). */
  obj?: Obj;
}

type Slot =
  | { kind: "target"; field: string; obj: Obj }
  | { kind: "targets"; field: string; objs: Obj[] }
  | { kind: "frame"; field: string; frame: Frame }
  | { kind: "frames"; field: string; frames: Frame[] };

/** A path segment: a field name, or "*" for every element. */
type Seg = string;

interface Item {
  path: Seg[] | "this";
  align?: number;
  /** A per-element group: `path` names the array, items are per element. */
  group?: Item[];
}

/** A base region: its frame, where it starts and where its inline bytes end. */
interface Region {
  frame: Frame;
  start: number;
  inlineEnd: number;
  /** Objects placed in the region, in file order. */
  objects: Obj[];
  /** Empty targets at positions a layout can't produce (an offset formula writes 0 for them). */
  ignored: Set<Obj>;
}

class TreeBuilder {
  private nextId = 0;
  private rank = 0;
  private readonly sp: SampleProgram;
  private readonly byKey = new Map<string, Obj>();
  readonly regions: Region[] = [];
  /** Struct names that contain placeables (directly or in inline parts). */
  private readonly hasPlaceables = new Map<string, boolean>();

  constructor(sp: SampleProgram) {
    this.sp = sp;
  }

  private placeables(s: IrStruct, seen = new Set<string>()): boolean {
    const hit = this.hasPlaceables.get(s.name);
    if (hit !== undefined) return hit;
    if (seen.has(s.name)) return false;
    seen.add(s.name);
    let yes = false;
    for (const f of structFields(s.members)) {
      if (!("type" in f)) continue;
      if ("placement" in f && f.placement && !f.placement.fixed) yes = true;
      const t = bareType(f.type);
      if (t.kind === "pointer" && t.ownership === "owned") yes = true;
      const inner = this.inlineStruct(t);
      if (inner && !inner.base && this.placeables(inner, seen)) yes = true;
      if (t.kind === "array") {
        const e = bareType(t.element);
        if (e.kind === "pointer" && e.ownership === "owned") yes = true;
        const es = this.inlineStruct(e);
        if (es && !es.base && this.placeables(es, seen)) yes = true;
      }
      if (yes) break;
    }
    this.hasPlaceables.set(s.name, yes);
    return yes;
  }

  private readonly structAligns = new Map<string, number>();

  /** lcm of the constant `@align` layers a value of this type writes inline. */
  typeAlign(t: IrType): number {
    let a = 1;
    let cur: IrType = t;
    for (;;) {
      if (cur.kind === "layered") {
        for (const l of cur.layers)
          if (l.kind === "align" && l.to.kind === "literal" && l.to.value.kind === "int")
            a = lcm(a, Number(l.to.value.value));
        cur = cur.inner;
      } else if (cur.kind === "transform") cur = cur.inner;
      else break;
    }
    if (cur.kind === "array") return lcm(a, this.typeAlign(cur.element));
    const s = this.inlineStruct(cur);
    return s ? lcm(a, this.structAlign(s)) : a;
  }

  private structAlign(s: IrStruct): number {
    const hit = this.structAligns.get(s.id);
    if (hit !== undefined) return hit;
    this.structAligns.set(s.id, 1);
    let a = 1;
    for (const l of s.layers)
      if (l.kind === "align" && l.to.kind === "literal" && l.to.value.kind === "int")
        a = lcm(a, Number(l.to.value.value));
    const members = (ms: IrMember[]) => {
      for (const m of ms) {
        if (m.kind === "field") {
          if (!m.placement && !m.from && bareType(m.type).kind !== "pointer")
            a = lcm(a, this.typeAlign(m.type));
        } else if (m.kind === "block") {
          for (const l of m.layers)
            if (l.kind === "align" && l.to.kind === "literal" && l.to.value.kind === "int")
              a = lcm(a, Number(l.to.value.value));
          members(m.members);
          if (m.else) members(m.else);
        } else if (m.kind === "switch") {
          for (const c of m.cases) members(c.members);
          if (m.default) members(m.default);
        }
      }
    };
    members(s.members);
    this.structAligns.set(s.id, a);
    return a;
  }

  private inlineStruct(t: IrType): IrStruct | undefined {
    const b = bareType(t);
    if (b.kind !== "struct") return undefined;
    return this.sp.program.structs.find(s => s.id === b.struct);
  }

  /** The root region and everything below it. */
  async build(view: object): Promise<void> {
    const root = runtime.nodeOf(view);
    if (!(root instanceof runtime.StructNode)) throw new Error("the sample has no root struct");
    const s = this.sp.structs.get(root.info.name)!;
    const region: Region = {
      frame: { struct: s, slots: [] },
      start: 0,
      inlineEnd: 0,
      objects: [],
      ignored: new Set()
    };
    this.regions.push(region);
    region.frame = await this.frame(root, s);
    region.inlineEnd = await access(() =>
      root.inlineEnd >= 0 ? root.inlineEnd : root.pos + root.size
    );
  }

  private async frame(node: runtime.StructNode, s: IrStruct): Promise<Frame> {
    const frame: Frame = { struct: s, slots: [] };
    if (!this.placeables(s)) return frame;
    const keys = await access(() => node.keys());
    for (const f of structFields(s.members)) {
      if (!("type" in f) || !keys.includes(f.name)) continue;
      const t = bareType(f.type);
      const placed = "placement" in f && f.placement && !f.placement.fixed;
      const owned = t.kind === "pointer" && t.ownership === "owned";
      if (placed || owned) {
        const raw = node.peek(f.name);
        const v = await access(() => node.get(f.name));
        if (v === null || v === undefined) continue;
        const info = runtime.isLazy(raw) ? raw.target : undefined;
        const targetType = owned ? (t as { target: IrType }).target : f.type;
        const obj = await this.object(v, targetType, info, node, `${s.name}.${f.name}`);
        if (obj) frame.slots.push({ kind: "target", field: f.name, obj });
        continue;
      }
      if (t.kind === "struct") {
        const inner = this.inlineStruct(t);
        if (!inner || inner.base || !this.placeables(inner)) continue;
        const child = runtime.nodeOf(await access(() => node.get(f.name)));
        if (child instanceof runtime.StructNode)
          frame.slots.push({ kind: "frame", field: f.name, frame: await this.frame(child, inner) });
        continue;
      }
      if (t.kind === "array") {
        const e = bareType(t.element);
        const arr = runtime.nodeOf(await access(() => node.get(f.name)));
        if (!(arr instanceof runtime.ArrayNode)) continue;
        if (e.kind === "pointer" && e.ownership === "owned") {
          const objs: Obj[] = [];
          for (let i = 0; i < arr.length; i++) {
            const v = await access(() => arr.get(i));
            if (v === null || v === undefined) continue;
            const o = await this.object(v, e.target, undefined, node, `${s.name}.${f.name}[${i}]`);
            if (o) objs.push(o);
          }
          if (objs.length) frame.slots.push({ kind: "targets", field: f.name, objs });
          continue;
        }
        const es = this.inlineStruct(e);
        if (!es || es.base || !this.placeables(es)) continue;
        const frames: Frame[] = [];
        for (let i = 0; i < arr.length; i++) {
          const el = runtime.nodeOf(await access(() => arr.get(i)));
          if (el instanceof runtime.StructNode) frames.push(await this.frame(el, es));
        }
        frame.slots.push({ kind: "frames", field: f.name, frames });
      }
    }
    return frame;
  }

  /** The object for a target value (shared targets are one object). */
  private async object(
    v: unknown,
    type: IrType,
    info: runtime.TargetInfo | undefined,
    owner: runtime.StructNode,
    label: string
  ): Promise<Obj | undefined> {
    const node = runtime.nodeOf(v);
    const origin =
      typeof v === "object" && v !== null ? owner.root.origins.get(v as object) : undefined;
    let start: number;
    let end: number;
    if (node instanceof runtime.StructNode) {
      start = node.pos;
      end = node.pos + (await access(() => node.size));
    } else if (origin) {
      start = origin.pos;
      end = origin.pos + origin.size;
    } else if (info && info.size !== undefined) {
      start = info.addr;
      end = info.addr + info.size;
    } else return undefined;
    const key = `${node instanceof runtime.StructNode ? node.space.id : (origin?.space.id ?? info?.space.id)}:${start}:${node instanceof runtime.StructNode ? node.info.key : label.split(".").pop()}`;
    const hit = this.byKey.get(key);
    if (hit) return hit;
    const obj: Obj = {
      id: this.nextId++,
      start,
      end,
      kind: "leaf",
      rank: this.rank++,
      label,
      blockAlign: this.typeAlign(type)
    };
    this.byKey.set(key, obj);
    const b = bareType(type);
    if (node instanceof runtime.StructNode) {
      const s = this.sp.structs.get(node.info.name)!;
      if (node.info.base) {
        obj.kind = "base";
        // its own region
        const region: Region = {
          frame: { struct: s, slots: [] },
          start,
          inlineEnd: start,
          objects: [],
          ignored: new Set()
        };
        this.regions.push(region);
        region.frame = await this.frame(node, s);
        delete region.frame.obj;
        region.inlineEnd = node.inlineEnd >= 0 ? node.inlineEnd : end;
      } else {
        obj.kind = "struct";
        obj.frame = await this.frame(node, s);
        obj.frame.obj = obj;
      }
    } else if (node instanceof runtime.ArrayNode && b.kind === "array") {
      obj.kind = "array";
      const e = bareType(b.element);
      if (e.kind === "pointer" && e.ownership === "owned") {
        obj.elemTargets = [];
        for (let i = 0; i < node.length; i++) {
          const x = await access(() => node.get(i));
          if (x === null || x === undefined) continue;
          const o = await this.object(x, e.target, undefined, owner, `${label}[${i}]`);
          if (o) obj.elemTargets.push(o);
        }
      } else {
        const es = this.inlineStruct(e);
        if (es && !es.base && this.placeables(es)) {
          obj.elements = [];
          for (let i = 0; i < node.length; i++) {
            const el = runtime.nodeOf(await access(() => node.get(i)));
            if (el instanceof runtime.StructNode) obj.elements.push(await this.frame(el, es));
          }
        }
      }
    }
    return obj;
  }
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

function lcm(a: number, b: number): number {
  return (a / gcd(a, b)) * b;
}

/** Objects of a frame's units (not crossing nested bases), each once. */
function collect(frame: Frame, out: Set<Obj>): void {
  for (const slot of frame.slots) {
    if (slot.kind === "target") collectObj(slot.obj, out);
    else if (slot.kind === "targets") for (const o of slot.objs) collectObj(o, out);
    else if (slot.kind === "frame") collect(slot.frame, out);
    else for (const f of slot.frames) collect(f, out);
  }
}

function collectObj(o: Obj, out: Set<Obj>): void {
  if (out.has(o)) return;
  out.add(o);
  if (o.frame) collect(o.frame, out);
  for (const f of o.elements ?? []) collect(f, out);
  for (const t of o.elemTargets ?? []) collectObj(t, out);
}

// ── simulating the layout engine (IR.md §4) ────────────────────────────────────

type Layouts = Map<string, Item[]>;

interface ItemRef {
  struct: string;
  index: number;
}

type Match = { obj: Obj } | { frame: Frame };

function resolve(frame: Frame, path: Seg[]): Match[] {
  let cur: (Match | { frames: Frame[] } | { objs: Obj[] })[] = [{ frame }];
  for (const seg of path) {
    const next: typeof cur = [];
    for (const c of cur) {
      if ("frame" in c) {
        const slot = c.frame.slots.find(s => s.field === seg);
        if (!slot) continue;
        if (slot.kind === "target") next.push({ obj: slot.obj });
        else if (slot.kind === "targets") next.push({ objs: slot.objs });
        else if (slot.kind === "frame") next.push({ frame: slot.frame });
        else next.push({ frames: slot.frames });
      } else if ("frames" in c) {
        if (seg === "*") for (const f of c.frames) next.push({ frame: f });
      } else if ("objs" in c) {
        if (seg === "*") for (const o of c.objs) next.push({ obj: o });
      } else {
        const o = c.obj;
        if (seg === "*") {
          for (const f of o.elements ?? []) next.push({ frame: f });
          for (const t of o.elemTargets ?? []) next.push({ obj: t });
        } else if (o.frame) {
          const slot = o.frame.slots.find(s => s.field === seg);
          if (!slot) continue;
          if (slot.kind === "target") next.push({ obj: slot.obj });
          else if (slot.kind === "targets") next.push({ objs: slot.objs });
          else if (slot.kind === "frame") next.push({ frame: slot.frame });
          else next.push({ frames: slot.frames });
        }
      }
    }
    cur = next;
  }
  const out: Match[] = [];
  for (const c of cur) {
    if ("frames" in c) for (const f of c.frames) out.push({ frame: f });
    else if ("objs" in c) for (const o of c.objs) out.push({ obj: o });
    else out.push(c);
  }
  return out;
}

/**
 * The writer's layout engine (packages/runtime/src/layout.ts), over the observed tree: placeables
 * named by a struct's items are claimed first (placed by that item only); without a `this`
 * item the struct's own bytes come first; leftovers follow in declaration order.
 */
class Simulation {
  readonly placed = new Set<Obj>();
  readonly order: Obj[] = [];
  readonly stacks = new Map<Obj, ItemRef[]>();
  private readonly stack: ItemRef[] = [];
  private readonly claimed = new Set<Obj>();
  private readonly visiting = new Set<Obj>();
  private readonly layouts: Layouts;

  constructor(layouts: Layouts) {
    this.layouts = layouts;
  }

  private place(o: Obj): void {
    if (this.placed.has(o)) return;
    this.placed.add(o);
    this.order.push(o);
    this.stacks.set(o, [...this.stack]);
  }

  unit(o: Obj): void {
    if (this.visiting.has(o)) return this.place(o);
    this.visiting.add(o);
    if (o.frame) this.frame(o.frame, o);
    else {
      this.place(o);
      for (const f of o.elements ?? []) this.frame(f, undefined);
      for (const t of o.elemTargets ?? []) this.remainingObj(t);
    }
    this.visiting.delete(o);
  }

  private remainingObj(o: Obj): void {
    if (!this.claimed.has(o)) this.unit(o);
  }

  /** Everything an item names, claimed before anything is placed (groups: per element). */
  private claim(f: Frame, items: Item[], mine: Obj[]): void {
    const take = (o: Obj) => {
      if (!this.claimed.has(o) && !this.placed.has(o)) {
        this.claimed.add(o);
        mine.push(o);
      }
    };
    for (const item of items) {
      if (item.path === "this") continue;
      if (item.group) {
        for (const el of resolve(f, [...item.path, "*"])) {
          const obj = "obj" in el ? el.obj : undefined;
          if (obj && item.group.some(i => i.path === "this")) take(obj);
          const inner = obj ? obj.frame : "frame" in el ? el.frame : undefined;
          if (inner) this.claim(inner, item.group, mine);
        }
        continue;
      }
      for (const m of resolve(f, item.path)) if ("obj" in m) take(m.obj);
    }
  }

  /** Places what one item names (a group: for each element, its own bytes first unless `this` is named). */
  private placeItem(f: Frame, self: Obj | undefined, item: Item, mine: Obj[]): void {
    const unitOf = (o: Obj) => {
      if (mine.includes(o)) {
        this.claimed.delete(o);
        this.unit(o);
      } else if (!this.claimed.has(o)) this.unit(o);
    };
    if (item.path === "this") {
      if (self) {
        this.claimed.delete(self);
        this.place(self);
      }
      return;
    }
    if (item.group) {
      for (const el of resolve(f, [...item.path, "*"])) {
        const obj = "obj" in el ? el.obj : undefined;
        const inner = obj ? obj.frame : "frame" in el ? el.frame : undefined;
        if (obj && !item.group.some(i => i.path === "this")) this.place(obj);
        if (!inner) continue;
        for (const gi of item.group) this.placeItem(inner, obj, gi, mine);
      }
      return;
    }
    for (const m of resolve(f, item.path)) {
      if ("obj" in m) unitOf(m.obj);
      else this.frame(m.frame, undefined);
    }
  }

  frame(f: Frame, self: Obj | undefined): void {
    const items = this.layouts.get(f.struct.id);
    if (items?.length) {
      const mine: Obj[] = [];
      this.claim(f, items, mine);
      if (self && !items.some(i => i.path === "this")) this.place(self);
      items.forEach((item, index) => {
        this.stack.push({ struct: f.struct.id, index });
        this.placeItem(f, self, item, mine);
        this.stack.pop();
      });
      for (const o of mine) this.claimed.delete(o);
    }
    if (self) this.place(self);
    for (const slot of f.slots) {
      if (slot.kind === "target") this.remainingObj(slot.obj);
      else if (slot.kind === "targets") for (const o of slot.objs) this.remainingObj(o);
      else if (slot.kind === "frame") this.frame(slot.frame, undefined);
      else for (const x of slot.frames) this.frame(x, undefined);
    }
  }
}

function simulate(region: Region, layouts: Layouts): Simulation {
  const sim = new Simulation(layouts);
  sim.frame(region.frame, undefined);
  return sim;
}

/** Objects of a region that carry position information (non-empty), in simulated order. */
function sameOrder(a: Obj[], b: Obj[]): boolean {
  const fa = a.filter(o => o.end > o.start);
  const fb = b.filter(o => o.end > o.start);
  return fa.length === fb.length && fa.every((o, i) => o === fb[i]);
}

// ── inference ──────────────────────────────────────────────────────────────────

class Inference {
  layouts: Layouts = new Map();
  placed = new Set<Obj>();
  private readonly pathCache = new Map<Frame, Map<Obj, Seg[]>>();

  private snapshot(): { layouts: Layouts; placed: Set<Obj> } {
    return {
      layouts: new Map([...this.layouts].map(([k, v]) => [k, [...v]])),
      placed: new Set(this.placed)
    };
  }

  private restore(s: { layouts: Layouts; placed: Set<Obj> }): void {
    this.layouts = s.layouts;
    this.placed = s.placed;
  }

  /** Generalized paths from a frame to every object below it. */
  private paths(frame: Frame): Map<Obj, Seg[]> {
    let m = this.pathCache.get(frame);
    if (m) return m;
    m = new Map();
    const out = m;
    const visitFrame = (f: Frame, prefix: Seg[]) => {
      for (const slot of f.slots) {
        const p = [...prefix, slot.field];
        if (slot.kind === "target") visitObj(slot.obj, p);
        else if (slot.kind === "targets") for (const o of slot.objs) visitObj(o, [...p, "*"]);
        else if (slot.kind === "frame") visitFrame(slot.frame, p);
        else for (const x of slot.frames) visitFrame(x, [...p, "*"]);
      }
    };
    const visitObj = (o: Obj, p: Seg[]) => {
      if (out.has(o)) return;
      out.set(o, p);
      if (o.frame) visitFrame(o.frame, p);
      for (const x of o.elements ?? []) visitFrame(x, [...p, "*"]);
      for (const t of o.elemTargets ?? []) visitObj(t, [...p, "*"]);
    };
    visitFrame(frame, []);
    this.pathCache.set(frame, out);
    return out;
  }

  /** Remaining (unplaced) objects of a match. */
  private remaining(m: Match): Set<Obj> {
    const all = new Set<Obj>();
    if ("obj" in m) collectObj(m.obj, all);
    else collect(m.frame, all);
    return new Set([...all].filter(o => !this.placed.has(o)));
  }

  private merge(struct: string, items: Item[]): boolean {
    const old = this.layouts.get(struct);
    if (!old) {
      this.layouts.set(struct, items);
      return true;
    }
    const key = (i: Item) => (i.path === "this" ? "this" : i.path.join("."));
    const sub = (a: Item[], b: Item[]) => {
      let j = 0;
      for (const x of b) if (j < a.length && key(a[j]!) === key(x)) j++;
      return j === a.length;
    };
    if (sub(items, old)) return true;
    if (sub(old, items)) {
      this.layouts.set(struct, items);
      return true;
    }
    return false;
  }

  /** Explains `seq` (exactly the remaining objects of the frame, in file order). */
  explainFrame(frame: Frame, top: boolean, seq: Obj[]): boolean {
    const items: Item[] = [];
    let i = 0;
    while (i < seq.length) {
      const o = seq[i]!;
      if (top && o === frame.obj) {
        items.push({ path: "this" });
        this.placed.add(o);
        i++;
        continue;
      }
      const full = this.paths(frame).get(o);
      if (!full) {
        return false;
      }
      let done = false;
      for (let len = 1; len <= full.length && !done; len++) {
        const path = full.slice(0, len);
        const snap = this.snapshot();
        const matches = resolve(frame, path);
        const blocks = matches.map(m => ({ m, set: this.remaining(m) })).filter(b => b.set.size);
        let k = i;
        let ok = blocks.length > 0;
        for (const b of blocks) {
          const slice = seq.slice(k, k + b.set.size);
          if (slice.length !== b.set.size || slice.some(x => !b.set.has(x))) {
            ok = false;
            break;
          }
          k += b.set.size;
        }
        if (ok) {
          k = i;
          for (const b of blocks) {
            const slice = seq.slice(k, k + b.set.size);
            k += b.set.size;
            ok =
              "obj" in b.m
                ? this.explainUnit(b.m.obj, slice)
                : this.explainFrame(b.m.frame, false, slice);
            if (!ok) break;
          }
        }
        if (!ok) {
          this.restore(snap);
          continue;
        }
        items.push({ path });
        i = k;
        done = true;
      }
      if (!done) {
        return false;
      }
    }
    return this.merge(frame.struct.id, items);
  }

  private explainUnit(o: Obj, slice: Obj[]): boolean {
    if (o.kind === "struct") return this.explainFrame(o.frame!, true, slice);
    let k = 0;
    if (!this.placed.has(o)) {
      if (slice[0] !== o) return false;
      this.placed.add(o);
      k = 1;
    }
    const parts: Match[] = [
      ...(o.elements ?? []).map(f => ({ frame: f })),
      ...(o.elemTargets ?? []).map(t => ({ obj: t }))
    ];
    for (const m of parts) {
      const set = this.remaining(m);
      if (!set.size) continue;
      const part = slice.slice(k, k + set.size);
      if (part.length !== set.size || part.some(x => !set.has(x))) return false;
      k += set.size;
      if (!("obj" in m ? this.explainUnit(m.obj, part) : this.explainFrame(m.frame, false, part)))
        return false;
    }
    return k === slice.length;
  }
}

// ── alignment ──────────────────────────────────────────────────────────────────

const POWERS = Array.from({ length: 17 }, (_, i) => 2 ** i);

/** Alignments that put an object exactly where it is, given where the previous one ended. */
function feasible(start: number, prevEnd: number, blockAlign: number): Set<number> {
  const out = new Set<number>();
  if (start < prevEnd) return out;
  for (const n of POWERS) {
    const a = lcm(n, blockAlign);
    if (Math.ceil(prevEnd / a) * a === start) out.add(n);
  }
  return out;
}

function chooseAlignments(regions: Region[], layouts: Layouts): { exact: boolean } {
  // feasible alignments per object, and which items placed it
  const fe = new Map<Obj, Set<number>>();
  const stacks = new Map<Obj, ItemRef[]>();
  for (const r of regions) {
    const sim = simulate(r, layouts);
    let pos = r.inlineEnd;
    for (const o of sim.order) {
      if (r.ignored.has(o)) continue;
      fe.set(o, feasible(o.start - r.start, pos - r.start, o.blockAlign));
      stacks.set(o, sim.stacks.get(o) ?? []);
      pos = Math.max(pos, o.end);
    }
  }
  const refKey = (x: ItemRef) => `${x.struct}#${x.index}`;
  // objects in the subtree of each item, and items nested in each item
  const subtree = new Map<string, Obj[]>();
  const children = new Map<string, Set<string>>();
  const roots = new Set<string>();
  const refs = new Map<string, ItemRef>();
  for (const [o, st] of stacks) {
    st.forEach((x, d) => {
      const k = refKey(x);
      refs.set(k, x);
      let list = subtree.get(k);
      if (!list) subtree.set(k, (list = []));
      list.push(o);
      if (d === 0) roots.add(k);
      else {
        const p = refKey(st[d - 1]!);
        let c = children.get(p);
        if (!c) children.set(p, (c = new Set()));
        c.add(k);
      }
    });
  }
  // objects each item places itself (its innermost item), and item depths
  const direct = new Map<string, Obj[]>();
  const depth = new Map<string, number>();
  for (const [o, st] of stacks) {
    st.forEach((x, d) => depth.set(refKey(x), Math.min(depth.get(refKey(x)) ?? d, d)));
    const last = st[st.length - 1];
    if (!last) continue;
    let list = direct.get(refKey(last));
    if (!list) direct.set(refKey(last), (list = []));
    list.push(o);
  }
  // Fewest explicit alignments (outer ones preferred) such that every object sits where it
  // does: a small dynamic program over the item tree.
  interface Choice {
    cost: number;
    align: number;
  }
  const memo = new Map<string, Choice>();
  const cost = (k: string, inherited: number): Choice => {
    const key = `${k}|${inherited}`;
    const hit = memo.get(key);
    if (hit) return hit;
    memo.set(key, { cost: Infinity, align: inherited });
    const own = direct.get(k) ?? [];
    const many = (subtree.get(k)?.length ?? 0) >= 3;
    let best: Choice | undefined;
    for (const n of [inherited, ...(many ? [...POWERS].reverse() : POWERS)]) {
      if (n === inherited && best) continue;
      const unsat = own.filter(o => !fe.get(o)!.has(n)).length;
      let c = unsat * 1e6 + (n !== inherited ? 1000 + (depth.get(k) ?? 0) : 0);
      for (const ch of children.get(k) ?? []) c += cost(ch, n).cost;
      if (!best || c < best.cost) best = { cost: c, align: n };
    }
    memo.set(key, best!);
    return best!;
  };
  const chosen = new Map<string, number>();
  const assign = (k: string, inherited: number) => {
    const c = cost(k, inherited);
    if (c.align !== inherited) chosen.set(k, c.align);
    for (const ch of children.get(k) ?? []) assign(ch, c.align);
  };
  for (const k of roots) assign(k, 1);
  for (const [k, n] of chosen) {
    const ref = refs.get(k)!;
    const item = layouts.get(ref.struct)?.[ref.index];
    if (item) item.align = n;
  }
  // is every object explained?
  let exact = true;
  for (const [o, st] of stacks) {
    let a = 1;
    for (const x of st) {
      const n = chosen.get(refKey(x));
      if (n !== undefined) a = n;
    }
    if (!fe.get(o)!.has(a)) exact = false;
  }
  return { exact };
}

/** True if the layouts (with their alignments) put every object exactly where it is. */
function positionsMatch(regions: Region[], layouts: Layouts): boolean {
  for (const r of regions) {
    const sim = simulate(r, layouts);
    if (!sameOrder(sim.order, r.objects)) {
      return false;
    }
    let pos = r.inlineEnd;
    for (const o of sim.order) {
      if (r.ignored.has(o)) continue;
      let a = 1;
      for (const x of sim.stacks.get(o) ?? []) {
        const n = layouts.get(x.struct)?.[x.index]?.align;
        if (n !== undefined) a = n;
      }
      const rel = pos - r.start;
      const al = lcm(a, o.blockAlign);
      const want = r.start + Math.ceil(rel / al) * al;
      if (o.start !== want) {
        return false;
      }
      pos = Math.max(pos, o.end);
    }
  }
  return true;
}

/** The schema's own layouts, in the inference's terms. */
function schemaLayouts(sp: SampleProgram): Layouts {
  const out: Layouts = new Map();
  for (const s of sp.program.structs) {
    if (!s.layout?.length) continue;
    const convert = (item: IrLayoutItem): Item => {
      const it: Item = {
        path:
          item.path === "this"
            ? "this"
            : item.path.map(seg => (seg.kind === "each" ? "*" : seg.name))
      };
      for (const l of item.layers) {
        if (l.kind === "align" && l.to.kind === "literal" && l.to.value.kind === "int")
          it.align = Number(l.to.value.value);
      }
      if (item.group) it.group = item.group.items.map(convert);
      return it;
    };
    out.set(s.id, s.layout.map(convert));
  }
  return out;
}

// ── edits ──────────────────────────────────────────────────────────────────────

function itemText(i: Item): string {
  const path =
    i.path === "this"
      ? "this"
      : i.path.reduce((s, seg) => (seg === "*" ? `${s}[*]` : s ? `${s}.${seg}` : seg), "");
  if (!i.group) return path;
  // a per-element group: `volumes[*] @align(16) { pieces[*]  portals[*].points }`
  const inner = i.group
    .map(g => itemText(g) + (g.align ? ` @align(${alignText(g.align)})` : ""))
    .join("  ");
  return `${path}[*]${i.align ? ` @align(${alignText(i.align)})` : ""} { ${inner} }`;
}

function alignText(n: number): string {
  return n >= 16 ? `0x${n.toString(16)}` : String(n);
}

function layoutText(items: Item[], indent: string, unit: string): string {
  const paths = items.map(itemText);
  // a group's own alignment is part of its text
  const alignOf = (it: Item) => (it.align && !it.group ? it.align : undefined);
  const one = `layout { ${items.map((it, k) => paths[k] + (alignOf(it) ? ` @align(${alignText(alignOf(it)!)})` : "")).join(", ")} }`;
  if (items.length <= 6 && one.length + indent.length <= 80 && !items.some(i => i.align || i.group))
    return one;
  const width = Math.max(...paths.map((p, k) => (items[k]!.group ? 0 : p.length)));
  const lines = items.map(
    (it, k) =>
      `${indent}${unit}${alignOf(it) ? `${paths[k]!.padEnd(width)} @align(${alignText(alignOf(it)!)})` : paths[k]}`
  );
  return `layout {\n${lines.join("\n")}\n${indent}}`;
}

function memberIndent(text: string, decl: A.StructDecl): { indent: string; unit: string } {
  const first = decl.members[0];
  const lineIndent = (offset: number) => {
    const ls = text.lastIndexOf("\n", offset - 1) + 1;
    return /^[ \t]*/.exec(text.slice(ls))![0];
  };
  const outer = lineIndent(decl.span.start);
  const indent = first ? lineIndent(first.span.start) : outer + "  ";
  const unit =
    indent.startsWith(outer) && indent.length > outer.length ? indent.slice(outer.length) : "  ";
  return { indent, unit };
}

function editsFor(
  layouts: Layouts,
  involved: Set<string>,
  sp: SampleProgram
): WorkspaceEdit | undefined {
  const changes: Record<string, TextEdit[]> = {};
  const done = new Set<StructSym>();
  for (const s of sp.program.structs) {
    if (!involved.has(s.id)) continue;
    const sym = sp.syms.get(s.name);
    if (!sym || done.has(sym)) continue;
    done.add(sym);
    const items = layouts.get(s.id) ?? [];
    const file = sym.module.file;
    const text = file.text;
    const existing = sym.decl.members.find(m => m.kind === "LayoutMember") as
      A.LayoutMember | undefined;
    const { indent, unit } = memberIndent(text, sym.decl);
    const edits = (changes[sym.module.path] ??= []);
    if (!items.length) {
      if (!existing) continue;
      // remove the whole line(s)
      const ls = text.lastIndexOf("\n", existing.span.start - 1) + 1;
      const le = text.indexOf("\n", existing.span.end);
      edits.push({
        range: file.rangeOf({ start: ls, end: le < 0 ? existing.span.end : le + 1 }),
        newText: ""
      });
      continue;
    }
    const block = layoutText(items, indent, unit);
    if (existing) {
      edits.push({ range: file.rangeOf(existing.span), newText: block });
    } else {
      const close = sym.decl.bodySpan.end - 1;
      const ls = text.lastIndexOf("\n", close - 1) + 1;
      const onOwnLine = /^[ \t]*$/.test(text.slice(ls, close));
      edits.push(
        onOwnLine
          ? { range: file.rangeOf({ start: ls, end: ls }), newText: `${indent}${block}\n` }
          : {
              range: file.rangeOf({ start: close, end: close }),
              newText: ` ${block} `
            }
      );
    }
  }
  for (const [k, v] of Object.entries(changes)) if (!v.length) delete changes[k];
  return Object.keys(changes).length ? { changes } : undefined;
}

// ── entry point ────────────────────────────────────────────────────────────────

interface LayoutAnalysis {
  layouts: Layouts;
  /** Struct ids whose frames were observed. */
  involved: Set<string>;
  /** The simulated order reproduces the sample's order. */
  orderReproduced: boolean;
  /** Every gap is explained by the chosen alignments. */
  alignmentReproduced: boolean;
  /** The schema's own layouts already reproduce the sample. */
  schemaReproduces: boolean;
}

async function analyzeLayout(
  sp: SampleProgram,
  bytes: Uint8Array,
  args?: Record<string, unknown>
): Promise<LayoutAnalysis> {
  const view = sp.api.view(bytes, sampleOptions(sp, args));
  const tree = new TreeBuilder(sp);
  await tree.build(view);
  const involved = new Set<string>();
  const markFrames = (f: Frame) => {
    involved.add(f.struct.id);
    for (const s of f.slots) {
      if (s.kind === "frame") markFrames(s.frame);
      else if (s.kind === "frames") s.frames.forEach(markFrames);
    }
  };
  for (const r of tree.regions) {
    const objs = new Set<Obj>();
    collect(r.frame, objs);
    for (const o of objs) if (o.end === o.start && o.start < r.inlineEnd) r.ignored.add(o);
    r.objects = [...objs]
      .filter(o => !r.ignored.has(o))
      .sort(
        (a, b) =>
          a.start - b.start ||
          (a.end > a.start ? 1 : 0) - (b.end > b.start ? 1 : 0) ||
          a.rank - b.rank
      );
    markFrames(r.frame);
    for (const o of objs) {
      if (o.frame) markFrames(o.frame);
      for (const f of o.elements ?? []) markFrames(f);
    }
  }
  const schemaReproduces = positionsMatch(tree.regions, schemaLayouts(sp));
  const inf = new Inference();
  for (const r of tree.regions) for (const o of r.ignored) inf.placed.add(o);
  let explained = true;
  for (const r of tree.regions) {
    if (!inf.explainFrame(r.frame, false, r.objects)) explained = false;
  }
  if (!explained) {
    // nothing to suggest when the schema's own layout (groups included) already reproduces it
    if (schemaReproduces)
      return {
        layouts: schemaLayouts(sp),
        involved,
        orderReproduced: true,
        alignmentReproduced: true,
        schemaReproduces
      };
    throw new Error(
      "The sample's target order can't be expressed with layout rules (instances of a struct are ordered differently; per-element groups `arr[*] { … }` aren't inferred yet)."
    );
  }
  const layouts = inf.layouts;
  const orderReproduced = tree.regions.every(r => sameOrder(simulate(r, layouts).order, r.objects));
  chooseAlignments(tree.regions, layouts);
  const exact = positionsMatch(tree.regions, layouts);
  // minimize: default order where it does the same, then trailing items the leftovers cover
  const still = () =>
    exact
      ? positionsMatch(tree.regions, layouts)
      : tree.regions.every(r => sameOrder(simulate(r, layouts).order, r.objects));
  for (const id of [...layouts.keys()]) {
    const items = layouts.get(id)!;
    layouts.delete(id);
    if (still()) continue;
    layouts.set(id, items);
    while (items.length) {
      const last = items.pop()!;
      if (!still()) {
        items.push(last);
        break;
      }
    }
    if (!items.length) layouts.delete(id);
  }
  return { layouts, involved, orderReproduced, alignmentReproduced: exact, schemaReproduces };
}

export async function suggestLayoutEdit(
  sp: SampleProgram,
  bytes: Uint8Array,
  args?: Record<string, unknown>
): Promise<WorkspaceEdit | undefined> {
  const result = await analyzeLayout(sp, bytes, args);
  if (result.schemaReproduces) return undefined;
  return editsFor(result.layouts, result.involved, sp);
}
