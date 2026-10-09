/**
 * Program model for the C++ backend: lookups plus the static analyses the emitters need
 * (placeables, static sizes, identity structs, by-value dependencies, field tables, type keys).
 */
import type {
  IrBitField,
  IrEnum,
  IrExtern,
  IrExternCodec,
  IrField,
  IrLayer,
  IrMember,
  IrProgram,
  IrStruct,
  IrType,
  IrValueType
} from "../../ir/index.ts";
import {
  forEachMember,
  innerSizeField,
  literalInt,
  primSize,
  someMember,
  strip
} from "./analysis.ts";
import { ident, memberName } from "./code.ts";

/** A named value in a struct (an IrField or a named bitfield), in declaration order. */
export interface FieldRef {
  name: string;
  field?: IrField;
  bit?: IrBitField;
  /** Inside an `if` without else, an if/else branch, or a switch case. */
  conditional: boolean;
}

export class Model {
  readonly program: IrProgram;
  readonly structs = new Map<string, IrStruct>();
  readonly enums = new Map<string, IrEnum>();
  readonly externs = new Map<string, IrExtern>();
  private readonly placeableMemo = new Map<string, boolean>();
  private readonly fieldsMemo = new Map<string, FieldRef[]>();
  private readonly sizeMemo = new Map<string, number | null>();
  private readonly structNames = new Map<string, string>();
  private readonly enumNames = new Map<string, string>();
  /** Type keys of `@ref` pointer targets: values of these types register as ref sites. */
  readonly refTargetKeys = new Set<string>();
  /** "structId.field" of arrays whose elements carry the pieces of a `from arr[*].piece` stream. */
  readonly streamArrays = new Set<string>();
  /** "structId.field" of piece size fields of `from arr[*].piece` streams (kept as optionals). */
  readonly splitSizeFields = new Set<string>();
  /** Structs that pointers or `at` fields can target: one object per address. */
  readonly identityStructs = new Set<string>();
  /** Structs held through `std::shared_ptr` everywhere: identity structs and by-value cycles. */
  readonly sharedStructs = new Set<string>();
  /** Struct definition order (by-value dependencies first). */
  readonly order: IrStruct[] = [];

  constructor(input: IrProgram) {
    const program = structuredClone(input);
    this.program = program;
    for (const s of program.structs) this.structs.set(s.id, s);
    for (const e of program.enums) this.enums.set(e.id, e);
    for (const x of program.externs) this.externs.set(x.id, x);
    this.assignNames();
    for (const s of program.structs) {
      this.walkTypes(s.members, t => {
        if (t.kind !== "pointer") return;
        if (t.ownership === "ref") this.refTargetKeys.add(this.typeKey(t.target));
        this.noteTarget(t.target);
      });
      forEachMember(s.members, m => {
        if (m.kind === "field" && m.placement) this.noteTarget(m.type);
      });
      this.noteStreams(s);
    }
    for (const id of this.identityStructs) this.sharedStructs.add(id);
    this.computeOrder();
  }

  private assignNames(): void {
    const used = new Set<string>();
    const unique = (base: string): string => {
      let n = base;
      for (let i = 2; used.has(n); i++) n = `${base}_${i}`;
      used.add(n);
      return n;
    };
    for (const e of this.program.enums) this.enumNames.set(e.id, unique(ident(e.name)));
    for (const s of this.program.structs) this.structNames.set(s.id, unique(ident(s.name)));
  }

  private noteTarget(t: IrType): void {
    const x = strip(t);
    if (x.kind === "struct") this.identityStructs.add(x.struct);
    else if (x.kind === "array") this.noteTarget(x.element);
  }

  /** Records the arrays and piece size fields of `from arr[*].piece` streams. */
  private noteStreams(s: IrStruct): void {
    for (const f of this.fields(s)) {
      let st = f.field?.from?.stream;
      while (st?.kind === "slice") st = st.stream;
      if (st?.kind !== "each") continue;
      const arr = this.field(s, st.array)?.field;
      const t = arr ? strip(arr.type) : undefined;
      const et = t?.kind === "array" ? strip(t.element) : undefined;
      if (et?.kind !== "struct") continue;
      this.streamArrays.add(`${s.id}.${st.array}`);
      const piece = this.field(this.struct(et.struct), st.field)?.field;
      const size = piece ? innerSizeField(piece.type) : undefined;
      if (size) this.splitSizeFields.add(`${et.struct}.${size}`);
    }
  }

  // ── by-value dependencies and definition order ───────────────────────────────

  /** Structs a value of type `t` contains by value (not through a vector or shared_ptr). */
  private hardDeps(t: IrType, out: Set<string>, inVector: boolean): void {
    switch (t.kind) {
      case "struct":
        if (!inVector) out.add(t.struct);
        return;
      case "array":
        this.hardDeps(t.element, out, true);
        return;
      case "pointer": {
        // Pointer targets are shared (struct/array/union) or values (scalars, strings).
        const x = strip(t.target);
        if (x.kind === "union") this.hardDeps(x, out, true);
        return;
      }
      case "union":
        for (const v of t.variants) this.hardDeps(v.type, out, inVector);
        return;
      case "transform":
      case "layered":
        this.hardDeps(t.inner, out, inVector);
        return;
      default:
        return;
    }
  }

  private structHardDeps(s: IrStruct): Set<string> {
    const out = new Set<string>();
    for (const f of this.fields(s)) this.hardDeps(f.field ? f.field.type : f.bit!.type, out, false);
    for (const p of s.params) this.valueHardDeps(p.type, out);
    return out;
  }

  private valueHardDeps(t: IrValueType, out: Set<string>): void {
    if (t.kind === "struct") out.add(t.struct);
    else if (t.kind === "nullable") this.valueHardDeps(t.inner, out);
    else if (t.kind === "union") for (const v of t.variants) this.valueHardDeps(v.type, out);
  }

  private computeOrder(): void {
    // Structs on a by-value cycle are boxed (shared) so the C++ types are finite.
    const deps = new Map<string, Set<string>>();
    for (const s of this.program.structs) deps.set(s.id, this.structHardDeps(s));
    const edges = (id: string): string[] =>
      [...(deps.get(id) ?? [])].filter(d => !this.sharedStructs.has(d) && this.structs.has(d));
    for (;;) {
      // Find a cycle among non-shared structs (DFS); box one struct of it and retry.
      const state = new Map<string, number>();
      let boxed: string | undefined;
      const visit = (id: string): void => {
        if (boxed) return;
        state.set(id, 1);
        for (const d of edges(id)) {
          if (boxed) return;
          const st = state.get(d) ?? 0;
          if (st === 1) {
            boxed = d;
            return;
          }
          if (st === 0) visit(d);
        }
        state.set(id, 2);
      };
      for (const s of this.program.structs) {
        if (!this.sharedStructs.has(s.id) && !state.has(s.id)) visit(s.id);
        if (boxed) break;
      }
      if (!boxed) break;
      this.sharedStructs.add(boxed);
    }
    const done = new Set<string>();
    const emit = (id: string): void => {
      if (done.has(id)) return;
      done.add(id);
      for (const d of edges(id)) emit(d);
      this.order.push(this.struct(id));
    };
    for (const s of this.program.structs) emit(s.id);
  }

  // ── lookups ─────────────────────────────────────────────────────────────────

  struct(id: string): IrStruct {
    const s = this.structs.get(id);
    if (!s) throw new Error(`unknown struct ${id}`);
    return s;
  }

  enum(id: string): IrEnum {
    const e = this.enums.get(id);
    if (!e) throw new Error(`unknown enum ${id}`);
    return e;
  }

  extern(id: string): IrExtern {
    const x = this.externs.get(id);
    if (!x) throw new Error(`unknown extern ${id}`);
    return x;
  }

  codec(id: string): IrExternCodec {
    const x = this.extern(id);
    if (x.kind !== "codec") throw new Error(`extern ${id} is not a codec`);
    return x;
  }

  /** C++ type name of a struct. */
  structName(id: string): string {
    const n = this.structNames.get(id);
    if (!n) throw new Error(`unknown struct ${id}`);
    return n;
  }

  enumName(id: string): string {
    const n = this.enumNames.get(id);
    if (!n) throw new Error(`unknown enum ${id}`);
    return n;
  }

  isShared(id: string): boolean {
    return this.sharedStructs.has(id);
  }

  /** Calls `f` for every type reachable from the members (not descending into other structs). */
  private walkTypes(members: readonly IrMember[], f: (t: IrType) => void): void {
    const visit = (t: IrType): void => {
      f(t);
      switch (t.kind) {
        case "array":
          visit(t.element);
          break;
        case "pointer":
          visit(t.target);
          break;
        case "union":
          for (const v of t.variants) visit(v.type);
          break;
        case "transform":
        case "layered":
          visit(t.inner);
          break;
      }
    };
    forEachMember(members, m => {
      if (m.kind === "field") visit(m.type);
      else if (m.kind === "bits") for (const b of m.fields) visit(b.type);
    });
  }

  /** Every named field of a struct, flattened in declaration order (first declaration wins). */
  fields(s: IrStruct): FieldRef[] {
    const hit = this.fieldsMemo.get(s.id);
    if (hit) return hit;
    const out: FieldRef[] = [];
    const walk = (ms: readonly IrMember[], cond: boolean): void => {
      for (const m of ms) {
        if (m.kind === "field") out.push({ name: m.name, field: m, conditional: cond });
        else if (m.kind === "bits") {
          for (const b of m.fields)
            if (b.name !== null) out.push({ name: b.name, bit: b, conditional: cond });
        } else if (m.kind === "block") {
          walk(m.members, cond || m.condition !== undefined);
          if (m.else) walk(m.else, true);
        } else {
          for (const c of m.cases) walk(c.members, true);
          if (m.default) walk(m.default, true);
        }
      }
    };
    walk(s.members, false);
    this.fieldsMemo.set(s.id, out);
    return out;
  }

  /** Distinct field names in declaration order (a name in several branches appears once). */
  uniqueFields(s: IrStruct): FieldRef[] {
    const seen = new Map<string, FieldRef>();
    for (const f of this.fields(s)) {
      const prev = seen.get(f.name);
      if (!prev) seen.set(f.name, { ...f });
      else prev.conditional = true;
    }
    return [...seen.values()];
  }

  field(s: IrStruct, name: string): FieldRef | undefined {
    return this.fields(s).find(f => f.name === name);
  }

  /** True if the field's C++ member is a `std::optional` (conditional or an optional input). */
  isOptionalMember(s: IrStruct, name: string): boolean {
    const f = this.uniqueFields(s).find(x => x.name === name);
    if (!f) return false;
    const input = f.field ? f.field.input : f.bit!.input;
    return f.conditional || input === "optional" || this.splitSizeFields.has(`${s.id}.${name}`);
  }

  member(name: string): string {
    return memberName(name);
  }

  // ── placeables ─────────────────────────────────────────────────────────────

  /** True if writing a value of this type can create placeables in the enclosing base region. */
  hasPlaceables(t: IrType): boolean {
    switch (t.kind) {
      case "pointer":
        return t.ownership === "owned";
      case "struct":
        return this.structHasPlaceables(t.struct);
      case "array":
        return t.elementPlacement !== undefined || this.hasPlaceables(t.element);
      case "union":
        return t.variants.some(v => this.hasPlaceables(v.type));
      case "transform":
        return this.hasPlaceables(t.inner);
      case "layered":
        return !t.layers.some(l => l.kind === "via") && this.hasPlaceables(t.inner);
      default:
        return false;
    }
  }

  /** True if the struct's members (not crossing its own base) create placeables. */
  private structHasPlaceables(id: string): boolean {
    const hit = this.placeableMemo.get(id);
    if (hit !== undefined) return hit;
    const s = this.struct(id);
    this.placeableMemo.set(id, false);
    let v = false;
    if (!s.base && !s.layers.some(l => l.kind === "via")) v = this.membersHavePlaceables(s.members);
    this.placeableMemo.set(id, v);
    return v;
  }

  membersHavePlaceables(ms: readonly IrMember[]): boolean {
    return someMember(
      ms,
      m =>
        m.kind === "field" && (m.placement !== undefined || (!m.from && this.hasPlaceables(m.type)))
    );
  }

  // ── static sizes ──────────────────────────────────────────────────────────

  staticSize(t: IrType): number | undefined {
    switch (t.kind) {
      case "prim":
        return primSize(t.prim);
      case "bool":
        return 1;
      case "enum":
        return primSize(this.enum(t.enum).storage);
      case "pointer":
        return primSize(t.storage);
      case "string": {
        const n = t.length.kind === "count" ? literalInt(t.length.expr) : undefined;
        return n === undefined ? undefined : n * t.unit;
      }
      case "bytes":
        return t.length.kind === "count" ? literalInt(t.length.expr) : undefined;
      case "array": {
        if (t.elementPlacement) return 0;
        const n = t.length.kind === "count" ? literalInt(t.length.expr) : undefined;
        const e = this.staticSize(t.element);
        return n === undefined || e === undefined ? undefined : n * e;
      }
      case "struct":
        return this.structStaticSize(t.struct);
      case "extern": {
        const x = this.extern(t.extern);
        return x.kind === "type" ? x.fixedSize : undefined;
      }
      case "transform":
        return this.staticSize(t.inner);
      case "layered": {
        const inner = this.staticSize(t.inner);
        return inner === undefined ? undefined : this.layersStatic(inner, t.layers);
      }
      case "union":
        return undefined;
    }
  }

  private structStaticSize(id: string): number | undefined {
    if (this.sizeMemo.has(id)) return this.sizeMemo.get(id) ?? undefined;
    this.sizeMemo.set(id, null);
    const s = this.struct(id);
    let size = s.base ? undefined : this.membersStaticSize(s.members);
    if (size !== undefined) size = this.layersStatic(size, s.layers);
    this.sizeMemo.set(id, size ?? null);
    return size;
  }

  private membersStaticSize(ms: readonly IrMember[]): number | undefined {
    let size = 0;
    for (const m of ms) {
      if (m.kind === "field") {
        if (m.placement || m.from || m.virtual) continue;
        const n = this.staticSize(m.type);
        if (n === undefined) return undefined;
        size += n;
      } else if (m.kind === "bits") size += primSize(m.storage);
      else if (m.kind === "block" && m.condition === undefined) {
        const inner = this.membersStaticSize(m.members);
        const n = inner === undefined ? undefined : this.layersStatic(inner, m.layers);
        if (n === undefined) return undefined;
        size += n;
      } else return undefined;
    }
    return size;
  }

  private layersStatic(inner: number, layers: readonly IrLayer[]): number | undefined {
    let size: number | undefined = inner;
    for (const l of layers) {
      if (size === undefined) return undefined;
      if (l.kind === "size") size = literalInt(l.size);
      else if (l.kind === "padUntil") {
        const n = literalInt(l.size);
        size = n === undefined ? undefined : Math.max(n, size);
      } else if (l.kind === "padBefore" || l.kind === "padAfter") {
        const n = literalInt(l.count);
        size = n === undefined ? undefined : size + n;
      } else if (l.kind !== "endian" && l.kind !== "strict") return undefined;
    }
    return size;
  }

  // ── type keys ─────────────────────────────────────────────────────────────

  /** Canonical key of a type (identity of pointer targets, `@ref` matching). Ignores expressions. */
  typeKey(t: IrType): string {
    switch (t.kind) {
      case "prim":
        return t.prim + (t.endian === "inherit" ? "" : t.endian);
      case "bool":
        return "bool";
      case "string":
        return `str:${t.encoding}:${t.unit}:${t.endian}:${t.length.kind}`;
      case "bytes":
        return `bytes:${t.length.kind}`;
      case "array":
        return `[${this.typeKey(t.element)}:${t.length.kind}]`;
      case "struct":
        return this.struct(t.struct).name;
      case "enum":
        return `enum:${t.enum}`;
      case "pointer":
        return `*${this.typeKey(t.target)}`;
      case "extern":
        return `extern:${t.extern}`;
      case "union":
        return `union(${t.variants.map(v => v.name).join("|")})`;
      case "transform":
        return `as(${this.typeKey(t.inner)})`;
      case "layered":
        return `layers(${this.typeKey(t.inner)}:${t.layers.map(l => l.kind).join(",")})`;
    }
  }

  isRefTarget(t: IrType): boolean {
    return this.refTargetKeys.size > 0 && this.refTargetKeys.has(this.typeKey(t));
  }

  /** True if values of the struct keep codec origins (a `via` layer in its members or its own). */
  usesMeta(s: IrStruct): boolean {
    const via = (ls: readonly IrLayer[]): boolean => ls.some(l => l.kind === "via");
    let found = via(s.layers);
    this.walkTypes(s.members, t => {
      if (t.kind === "layered" && via(t.layers)) found = true;
    });
    forEachMember(s.members, m => {
      if (m.kind === "block" && via(m.layers)) found = true;
    });
    return found;
  }
}
