/**
 * Program model for the C# backend: lookups, C# names, and the static analyses the emitters need
 * (placeables, static sizes, async-ness, field tables, type keys).
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
  IrType
} from "../../ir/index.ts";
import { extentFields, literalInt, primSize, stripLayers, stripType } from "./analysis.ts";
import { ident, pascal, typeName } from "./code.ts";

/** A named value in a struct (an IrField or a named bitfield), in declaration order. */
export interface FieldRef {
  name: string;
  field?: IrField;
  bit?: IrBitField;
  /** Inside an `if` without else, an if/else branch, or a switch case. */
  conditional: boolean;
}

/** Member names every generated struct class reserves (root API and object members). */
const RESERVED_MEMBERS = new Set([
  "Parse",
  "ParseAsync",
  "SafeParse",
  "SafeParseAsync",
  "Serialize",
  "SerializeAsync",
  "ToJson",
  "FromJson",
  "View",
  "ViewAsync",
  "Info",
  "GetType",
  "ToString",
  "Equals",
  "GetHashCode",
  "MemberwiseClone",
  "Finalize",
  "Clone",
  "StructuralEquals",
  "Options"
]);

/** `base`, `base2`, `base3`, … : the first name not in `used` (which it joins). */
function unique(used: Set<string>, base: string, sep = ""): string {
  let n = base;
  for (let i = 2; used.has(n); i++) n = `${base}${sep}${i}`;
  used.add(n);
  return n;
}

export class Model {
  readonly program: IrProgram;
  private readonly structs = new Map<string, IrStruct>();
  private readonly enums = new Map<string, IrEnum>();
  private readonly externs = new Map<string, IrExtern>();
  private readonly placeableMemo = new Map<string, boolean>();
  private readonly fieldsMemo = new Map<string, FieldRef[]>();
  private readonly sizeMemo = new Map<string, number | null>();
  private readonly asyncMemo = new Map<string, boolean>();
  private readonly extentsMemo = new Map<string, Set<string>>();
  /** Type keys of `@ref` pointer targets: values of these types register as ref sites. */
  private readonly refTargetKeys = new Set<string>();
  /** Structs that pointers or `at` fields can target: their inline values join the identity map. */
  readonly identityStructs = new Set<string>();
  private readonly classNames = new Map<string, string>();
  private readonly enumNames = new Map<string, string>();
  /** Per enum: member name → C# member name. */
  private readonly enumMembers = new Map<string, Map<string, string>>();
  /** Per struct: field name → C# member name. */
  private readonly memberNames = new Map<string, Map<string, string>>();
  /** Per struct: one-way transform field name → C# member holding its raw value. */
  private readonly rawNames = new Map<string, Map<string, string>>();
  /** Per root struct: the C# name of its options class. */
  readonly optionsNames = new Map<string, string>();

  constructor(program: IrProgram) {
    this.program = program;
    for (const s of program.structs) this.structs.set(s.id, s);
    for (const e of program.enums) this.enums.set(e.id, e);
    for (const x of program.externs) this.externs.set(x.id, x);
    const noteTarget = (t: IrType): void => {
      const x = stripType(t);
      if (x.kind === "struct") this.identityStructs.add(x.struct);
      else if (x.kind === "array") noteTarget(x.element);
    };
    for (const s of program.structs) {
      this.walkTypes(s.members, t => {
        if (t.kind !== "pointer") return;
        if (t.ownership === "ref") this.refTargetKeys.add(this.typeKey(t.target));
        noteTarget(t.target);
      });
      for (const f of this.fields(s)) if (f.field?.placement) noteTarget(f.field.type);
    }
    this.assignNames();
  }

  // ── names ─────────────────────────────────────────────────────────────────

  private assignNames(): void {
    const taken = new Set<string>();
    for (const s of this.program.structs)
      this.classNames.set(s.id, unique(taken, typeName(s.name)));
    for (const e of this.program.enums) this.enumNames.set(e.id, unique(taken, typeName(e.name)));
    for (const r of this.program.roots) {
      if (!this.optionsNames.has(r.struct))
        this.optionsNames.set(r.struct, unique(taken, `${this.className(r.struct)}Options`));
    }
    for (const s of this.program.structs) {
      const used = new Set<string>([this.className(s.id), ...RESERVED_MEMBERS]);
      const members = new Map<string, string>();
      for (const f of this.fields(s)) {
        if (members.has(f.name)) continue;
        const hidden = !(f.field ?? f.bit!).output;
        let base = hidden ? `Hidden_${ident(f.name).replace(/^@/, "")}` : pascal(f.name);
        if (!hidden && base.startsWith("Hidden_")) base = `F${base}`;
        members.set(f.name, unique(used, base, "_"));
      }
      this.memberNames.set(s.id, members);
      const raws = new Map<string, string>();
      for (const f of this.fields(s)) {
        if (!f.field?.output || !isOneWay(f.field.type) || raws.has(f.name)) continue;
        raws.set(f.name, unique(used, `${members.get(f.name)!}Raw`, "_"));
      }
      this.rawNames.set(s.id, raws);
    }
    for (const e of this.program.enums) {
      const used = new Set<string>();
      const names = new Map<string, string>();
      for (const m of e.members) {
        let base = ident(m.name).replace(/^@/, "");
        if (base === "value__") base = "value__1";
        const n = unique(used, base, "_");
        names.set(m.name, ident(n).startsWith("@") ? `@${n}` : n);
      }
      this.enumMembers.set(e.id, names);
    }
  }

  private static lookup<T>(map: Map<string, T>, key: string, what: string): T {
    const v = map.get(key);
    if (v === undefined) throw new Error(`unknown ${what} ${key}`);
    return v;
  }

  /** C# member holding the raw (pre-transform) value of a one-way transform field. */
  rawMember(s: IrStruct, field: string): string {
    const n = this.rawNames.get(s.id)?.get(field);
    if (!n) throw new Error(`field ${field} of ${s.id} is not a one-way transform`);
    return n;
  }

  /** C# class name of a struct. */
  className(id: string): string {
    return Model.lookup(this.classNames, id, "struct");
  }

  /** C# name of an enum. */
  enumName(id: string): string {
    return Model.lookup(this.enumNames, id, "enum");
  }

  /** C# member name of a struct's field (a public property, or an internal field for hidden ones). */
  member(s: IrStruct | string, field: string): string {
    const id = typeof s === "string" ? s : s.id;
    const n = this.memberNames.get(id)?.get(field);
    if (!n) throw new Error(`unknown field ${field} of ${id}`);
    return n;
  }

  /** C# enum member name. */
  enumMember(id: string, name: string): string {
    const n = this.enumMembers.get(id)?.get(name);
    if (!n) throw new Error(`unknown enum member ${name} of ${id}`);
    return n;
  }

  // ── lookups ───────────────────────────────────────────────────────────────

  struct(id: string): IrStruct {
    return Model.lookup(this.structs, id, "struct");
  }

  enum(id: string): IrEnum {
    return Model.lookup(this.enums, id, "enum");
  }

  extern(id: string): IrExtern {
    return Model.lookup(this.externs, id, "extern");
  }

  codec(id: string): IrExternCodec {
    const x = this.extern(id);
    if (x.kind !== "codec") throw new Error(`extern ${id} is not a codec`);
    return x;
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
    for (const f of this.allMembers(members)) {
      if (f.kind === "field") visit(f.type);
      else if (f.kind === "bits") for (const b of f.fields) visit(b.type);
    }
  }

  /** The members and every member nested in their blocks and switches. */
  private *allMembers(ms: readonly IrMember[]): Generator<IrMember> {
    for (const m of ms) {
      yield m;
      if (m.kind === "block") {
        yield* this.allMembers(m.members);
        if (m.else) yield* this.allMembers(m.else);
      } else if (m.kind === "switch") {
        for (const c of m.cases) yield* this.allMembers(c.members);
        if (m.default) yield* this.allMembers(m.default);
      }
    }
  }

  /** Every named field of a struct, flattened in declaration order. */
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

  /** The struct's fields, each name once (its first occurrence): the order of view metadata. */
  uniqueFields(s: IrStruct): FieldRef[] {
    const seen = new Set<string>();
    return this.fields(s).filter(f => !seen.has(f.name) && seen.add(f.name));
  }

  field(s: IrStruct, name: string): FieldRef | undefined {
    return this.fields(s).find(f => f.name === name);
  }

  /** True if a field appears more than once (several branches): its C# type is `object?`. */
  isMultiField(s: IrStruct, name: string): boolean {
    return this.fields(s).filter(f => f.name === name).length > 1;
  }

  /** The array field `name` of `s` whose elements are structs (`from arr[*].piece` streams). */
  structArray(
    s: IrStruct,
    name: string
  ): { array: Extract<IrType, { kind: "array" }>; element: IrStruct } {
    const f = this.field(s, name)?.field;
    if (!f) throw new Error(`unknown stream array ${name}`);
    const t = stripLayers(f.type);
    if (t.kind !== "array") throw new Error(`${name} is not an array`);
    const et = stripLayers(t.element);
    if (et.kind !== "struct") throw new Error(`${name} elements are not structs`);
    return { array: t, element: this.struct(et.struct) };
  }

  /** Read-side extents of a struct (see `extentFields`). */
  readExtents(s: IrStruct): Set<string> {
    let hit = this.extentsMemo.get(s.id);
    if (!hit) this.extentsMemo.set(s.id, (hit = extentFields(s)));
    return hit;
  }

  // ── placeables ────────────────────────────────────────────────────────────

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
  structHasPlaceables(id: string): boolean {
    const hit = this.placeableMemo.get(id);
    if (hit !== undefined) return hit;
    const s = this.struct(id);
    this.placeableMemo.set(id, false);
    const v =
      !s.base && !s.layers.some(l => l.kind === "via") && this.membersHavePlaceables(s.members);
    this.placeableMemo.set(id, v);
    return v;
  }

  /** Same as structHasPlaceables but ignoring the struct's own `base` flag (its region contents). */
  membersHavePlaceables(ms: readonly IrMember[]): boolean {
    for (const m of this.allMembers(ms)) {
      if (m.kind !== "field") continue;
      if (m.placement || (!m.from && this.hasPlaceables(m.type))) return true;
    }
    return false;
  }

  // ── async ─────────────────────────────────────────────────────────────────

  /** True if reading/writing a value of this type (with its layers) awaits an async codec. */
  isAsyncType(t: IrType): boolean {
    switch (t.kind) {
      case "struct":
        return this.bodyAsync(t.struct) || this.layersAsync(this.struct(t.struct).layers);
      case "array":
        return this.isAsyncType(t.element);
      case "pointer":
        return this.isAsyncType(t.target);
      case "union":
        return t.variants.some(v => this.isAsyncType(v.type));
      case "transform":
        return this.isAsyncType(t.inner);
      case "layered":
        return this.layersAsync(t.layers) || this.isAsyncType(t.inner);
      default:
        return false;
    }
  }

  private layersAsync(layers: readonly IrLayer[]): boolean {
    return layers.some(l => l.kind === "via" && this.codec(l.codec).async);
  }

  /** True if the struct's own members (not its struct-level layers) reach an async codec. */
  bodyAsync(id: string): boolean {
    const hit = this.asyncMemo.get(id);
    if (hit !== undefined) return hit;
    this.asyncMemo.set(id, false);
    const v = this.membersAsync(this.struct(id).members);
    this.asyncMemo.set(id, v);
    return v;
  }

  membersAsync(ms: readonly IrMember[]): boolean {
    for (const m of this.allMembers(ms)) {
      if (m.kind === "field" && this.isAsyncType(m.type)) return true;
      if (m.kind === "block" && this.layersAsync(m.layers)) return true;
    }
    return false;
  }

  /** True if a root's API is async-only (its struct or its layers reach an async codec). */
  rootIsAsync(id: string): boolean {
    return this.isAsyncType({ kind: "struct", struct: id, args: [] });
  }

  // ── static sizes ──────────────────────────────────────────────────────────

  /** Inline size in bytes if it is the same for every value, else undefined. */
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
      let n: number | undefined;
      if (m.kind === "field") {
        if (m.placement || m.from || m.virtual) continue;
        n = this.staticSize(m.type);
      } else if (m.kind === "bits") n = primSize(m.storage);
      else if (m.kind === "block" && m.condition === undefined) {
        const inner = this.membersStaticSize(m.members);
        n = inner === undefined ? undefined : this.layersStatic(inner, m.layers);
      }
      if (n === undefined) return undefined;
      size += n;
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
}

/** A transform without an inverse (possibly under layers): canonical JSON shows its raw value. */
function isOneWay(t: IrType): boolean {
  const x = stripLayers(t);
  return x.kind === "transform" && !x.write;
}
