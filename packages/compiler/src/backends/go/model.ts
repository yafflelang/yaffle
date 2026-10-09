/**
 * Program model for the Go backend: lookups, Go names and types, and the static analyses the
 * emitters need (placeables, static sizes, field tables, type keys).
 */
import type {
  IrBitField,
  IrEnum,
  IrExpr,
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
import { NameSet, exported, unexported } from "./code.ts";
import { leafMembers, literalInt, stripLayers } from "./irutil.ts";

export class BackendError extends Error {}

/** A named value in a struct (an IrField or a named bitfield), in declaration order. */
export interface FieldRef {
  name: string;
  field?: IrField;
  bit?: IrBitField;
  /** Inside an `if` without else, an if/else branch, or a switch case. */
  conditional: boolean;
}

/** How a field is stored in the generated Go struct. */
export interface GoField {
  name: string;
  /** Go field name (exported for output fields, unexported for hidden ones). */
  go: string;
  /** Go type as declared (pointer-wrapped when optional). */
  type: string;
  /** Go type of the value itself. */
  valueType: string;
  /** Pointer-wrapped (conditional or optional input) scalar: read through `*`. */
  ptr: boolean;
  /** Absent means nil (conditional fields of nilable types, pointer-wrapped ones). */
  nilAbsent: boolean;
  /** One-way transform: the raw value's field and Go type. */
  raw?: { go: string; type: string; valueType: string };
  conditional: boolean;
  hidden: boolean;
  ref: FieldRef;
}

/** A union Go type: its name and one field per variant. */
export interface UnionInfo {
  go: string;
  variants: { name: string; go: string; type: string }[];
}

type UnionType = Extract<IrType, { kind: "union" }>;

export class Model {
  readonly program: IrProgram;
  readonly structs = new Map<string, IrStruct>();
  readonly enums = new Map<string, IrEnum>();
  readonly externs = new Map<string, IrExtern>();
  private readonly placeableMemo = new Map<string, boolean>();
  private readonly fieldsMemo = new Map<string, FieldRef[]>();
  private readonly sizeMemo = new Map<string, number | null>();
  /** Type keys of `@ref` pointer targets: values of these types register as ref sites. */
  readonly refTargetKeys = new Set<string>();
  /** "structId.field" of bytes fields that `from arr[*].field` streams join. */
  readonly streamPieces = new Set<string>();
  /** "structId.field" of fields a `from` stream reads (their content comes from the stream on write). */
  readonly streamSources = new Set<string>();
  /** Structs that pointers or `at` fields can target: their inline values join the identity map. */
  readonly identityStructs = new Set<string>();

  // Go names (one namespace for the whole package: every module is a file of it)
  readonly names = new NameSet();
  private readonly structGo = new Map<string, string>();
  private readonly viewGo = new Map<string, string>();
  private readonly enumGo = new Map<string, string>();
  private readonly enumMemberGo = new Map<string, string>();
  readonly unions = new Map<string, UnionInfo>();
  /** Unions whose fromJSON helper the JSON emitter used (emitted once, in the support file). */
  readonly unionFromJSON = new Map<string, UnionType>();
  private readonly goFields = new Map<string, GoField[]>();
  /** Counter for hoisted package-level variables. */
  readonly hoistCounter = { n: 0 };

  constructor(input: IrProgram) {
    const program = structuredClone(input);
    this.program = program;
    for (const s of program.structs) this.structs.set(s.id, s);
    for (const e of program.enums) this.enums.set(e.id, e);
    for (const x of program.externs) this.externs.set(x.id, x);
    const noteTarget = (t: IrType): void => {
      let x = t;
      while (x.kind === "layered" || x.kind === "transform") x = x.inner;
      if (x.kind === "struct") this.identityStructs.add(x.struct);
      else if (x.kind === "array") noteTarget(x.element);
    };
    for (const s of program.structs) {
      this.walkTypes(s.members, t => {
        if (t.kind === "pointer") {
          if (t.ownership === "ref") this.refTargetKeys.add(this.typeKey(t.target));
          noteTarget(t.target);
        }
      });
      for (const m of leafMembers(s.members))
        if (m.kind === "field" && m.placement) noteTarget(m.type);
      for (const f of this.fields(s)) {
        let st = f.field?.from?.stream;
        while (st && st.kind === "slice") st = st.stream;
        if (st?.kind === "field") this.streamSources.add(`${s.id}.${st.field}`);
        if (st?.kind === "each") {
          this.streamSources.add(`${s.id}.${st.array}`);
          const es = this.elementStruct(s, st.array);
          if (es) this.streamPieces.add(`${es.id}.${st.field}`);
        }
      }
    }
    this.assignNames();
  }

  // ── naming ────────────────────────────────────────────────────────────────

  private assignNames(): void {
    for (const s of this.program.structs)
      this.structGo.set(s.id, this.names.take(exported(s.name)));
    for (const s of this.program.structs) this.viewName(s.id);
    for (const e of this.program.enums) this.enumGo.set(e.id, this.names.take(exported(e.name)));
    for (const e of this.program.enums) {
      const en = this.enumGo.get(e.id)!;
      for (const m of e.members)
        this.enumMemberGo.set(`${e.id}.${m.name}`, this.names.take(en + exported(m.name)));
    }
    // Unions are named after their variants; collect them up front so names are stable.
    for (const s of this.program.structs) {
      this.walkTypes(s.members, t => {
        if (t.kind === "union") this.unionOf(t);
      });
    }
  }

  structName(id: string): string {
    const n = this.structGo.get(id);
    if (!n) throw new BackendError(`unknown struct ${id}`);
    return n;
  }

  /** Go name of a struct's view type. */
  viewName(id: string): string {
    let n = this.viewGo.get(id);
    if (!n) {
      n = this.names.take(`${this.structName(id)}View`);
      this.viewGo.set(id, n);
    }
    return n;
  }

  enumName(id: string): string {
    const n = this.enumGo.get(id);
    if (!n) throw new BackendError(`unknown enum ${id}`);
    return n;
  }

  enumMember(id: string, member: string): string {
    const n = this.enumMemberGo.get(`${id}.${member}`);
    if (!n) throw new BackendError(`unknown enum member ${id}.${member}`);
    return n;
  }

  /** The union Go type with these variants (created on first use). */
  union(variants: { name: string; type: string }[]): UnionInfo {
    const key = variants.map(v => `${v.name}:${v.type}`).join("|");
    let u = this.unions.get(key);
    if (!u) {
      const fields = new NameSet(["Type"]);
      u = {
        go: this.names.take(variants.map(v => exported(v.name)).join("Or") || "Union"),
        variants: variants.map(v => ({ ...v, go: fields.take(exported(v.name)) }))
      };
      this.unions.set(key, u);
    }
    return u;
  }

  /** The union Go type of a union IR type. */
  unionOf(t: UnionType): UnionInfo {
    return this.union(t.variants.map(v => ({ name: v.name, type: this.goType(v.type) })));
  }

  /** Go fields of a struct, in declaration order (duplicates across branches merged). */
  goFieldsOf(s: IrStruct): GoField[] {
    const hit = this.goFields.get(s.id);
    if (hit) return hit;
    const names = new NameSet(["yfl"]);
    const out: GoField[] = [];
    const byName = new Map<string, GoField>();
    for (const f of this.fields(s)) {
      const t = f.field ? f.field.type : f.bit!.type;
      const hidden = f.field ? !f.field.output : !f.bit!.output;
      const optionalInput = (f.field?.input ?? f.bit?.input) === "optional";
      const valueType = this.goType(t);
      const prev = byName.get(f.name);
      if (prev) {
        if (prev.valueType !== valueType) {
          throw new BackendError(
            `not implemented: field ${f.name} of ${s.name} has different types in different branches`
          );
        }
        prev.conditional = true;
        continue;
      }
      const nilable = isNilable(valueType);
      const wrap = (f.conditional || optionalInput) && !nilable;
      const go = names.take(hidden ? unexported(f.name) : exported(f.name));
      const g: GoField = {
        name: f.name,
        go,
        type: wrap ? `*${valueType}` : valueType,
        valueType,
        ptr: wrap,
        nilAbsent: wrap || (f.conditional && nilable),
        conditional: f.conditional,
        hidden,
        ref: f
      };
      const tt = stripLayers(t);
      if (tt.kind === "transform" && !tt.write && !hidden) {
        const rv = this.goType(tt.inner);
        g.raw = { go: names.take(go + "Raw"), valueType: rv, type: wrap ? `*${rv}` : rv };
      }
      byName.set(f.name, g);
      out.push(g);
    }
    this.goFields.set(s.id, out);
    return out;
  }

  goField(s: IrStruct, name: string): GoField {
    const g = this.goFieldsOf(s).find(x => x.name === name);
    if (!g) throw new BackendError(`unknown field ${name} of ${s.name}`);
    return g;
  }

  // ── Go types ──────────────────────────────────────────────────────────────

  /** Go type of a value read with IR type t. */
  goType(t: IrType): string {
    switch (t.kind) {
      case "prim":
        return primGo(t.prim);
      case "bool":
        return "bool";
      case "string":
        return "string";
      case "bytes":
        return "[]byte";
      case "array":
        return `[]${this.goType(t.element)}`;
      case "struct":
        return `*${this.structName(t.struct)}`;
      case "enum":
        return this.enumName(t.enum);
      case "pointer": {
        const target = this.goType(t.target);
        if (t.nullValue !== undefined && !t.emptyIsNull && !isNilable(target)) return `*${target}`;
        return target;
      }
      case "extern": {
        const x = this.extern(t.extern);
        return x.kind === "type" ? this.goValueType(x.valueType) : "[]byte";
      }
      case "union":
        return `*${this.unionOf(t).go}`;
      case "transform":
        return this.goValueType(t.valueType);
      case "layered":
        return this.goType(t.inner);
    }
  }

  /** Go type of a value type. */
  goValueType(t: IrValueType): string {
    switch (t.kind) {
      case "int":
        return intGo(t.bits, t.signed);
      case "bigint":
        return "int64";
      case "float":
        return t.bits === 64 ? "float64" : "float32";
      case "bool":
        return "bool";
      case "string":
        return "string";
      case "bytes":
        return "[]byte";
      case "endian":
        return "yaffle.Endian";
      case "struct":
        return `*${this.structName(t.struct)}`;
      case "enum":
        return this.enumName(t.enum);
      case "array":
        return `[]${this.goValueType(t.element)}`;
      case "nullable": {
        const inner = this.goValueType(t.inner);
        return isNilable(inner) ? inner : `*${inner}`;
      }
      case "union":
        return `*${this.union(t.variants.map(v => ({ name: v.name, type: this.goValueType(v.type) }))).go}`;
      case "extern":
        return this.goValueType(t.valueType);
    }
  }

  /**
   * A transform whose value type is the exact intermediate `bigint` gets a concrete integer type
   * from the range of its read expression (`range` computes it).
   */
  normalizeTransforms(range: (e: IrExpr, it: IrValueType) => [bigint, bigint] | undefined): void {
    for (const s of this.program.structs) {
      this.walkTypes(s.members, t => {
        if (t.kind !== "transform" || t.valueType.kind !== "bigint") return;
        let r: [bigint, bigint] | undefined;
        try {
          r = range(t.read, valueTypeOf(this, t.inner));
        } catch {
          r = undefined;
        }
        if (r && r[0] >= -(1n << 47n) && r[1] < 1n << 47n)
          t.valueType = { kind: "int", bits: 48, signed: true };
        else if (r && r[0] >= 0n && r[1] < 1n << 48n)
          t.valueType = { kind: "int", bits: 48, signed: false };
        else t.valueType = { kind: "int", bits: 64, signed: r ? r[0] < 0n : true };
      });
    }
    this.goFields.clear();
  }

  // ── lookups ───────────────────────────────────────────────────────────────

  struct(id: string): IrStruct {
    const s = this.structs.get(id);
    if (!s) throw new BackendError(`unknown struct ${id}`);
    return s;
  }

  enum(id: string): IrEnum {
    const e = this.enums.get(id);
    if (!e) throw new BackendError(`unknown enum ${id}`);
    return e;
  }

  extern(id: string): IrExtern {
    const x = this.externs.get(id);
    if (!x) throw new BackendError(`unknown extern ${id}`);
    return x;
  }

  codec(id: string): IrExternCodec {
    const x = this.extern(id);
    if (x.kind !== "codec") throw new BackendError(`extern ${id} is not a codec`);
    return x;
  }

  /** Calls f for every type reachable from the members (not descending into other structs). */
  walkTypes(members: readonly IrMember[], f: (t: IrType) => void): void {
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
    for (const m of leafMembers(members)) {
      if (m.kind === "field") visit(m.type);
      else for (const b of m.fields) visit(b.type);
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

  field(s: IrStruct, name: string): FieldRef | undefined {
    return this.fields(s).find(f => f.name === name);
  }

  /** The element struct of an array-of-structs field (`arr` of `arr[*].field`). */
  elementStruct(s: IrStruct, array: string): IrStruct | undefined {
    const t = this.field(s, array)?.field?.type;
    const at = t && stripLayers(t);
    const et = at?.kind === "array" ? stripLayers(at.element) : undefined;
    return et?.kind === "struct" ? this.struct(et.struct) : undefined;
  }

  // ── placeables ────────────────────────────────────────────────────────────

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

  membersHavePlaceables(ms: readonly IrMember[]): boolean {
    return leafMembers(ms).some(
      m => m.kind === "field" && (!!m.placement || (!m.from && this.hasPlaceables(m.type)))
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

  structStaticSize(id: string): number | undefined {
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

  /** Canonical key of a type (identity of targets, `@ref` matching). Ignores expressions. */
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

export function isNilable(goType: string): boolean {
  return goType.startsWith("*") || goType.startsWith("[]");
}

export function primSize(p: string): number {
  return Number(p.slice(1)) / 8;
}

export function primGo(p: string): string {
  if (p[0] === "f") return p === "f64" ? "float64" : "float32";
  return intGo(Number(p.slice(1)), p[0] === "i");
}

export function intGo(bits: number, signed: boolean): string {
  const w = bits <= 8 ? 8 : bits <= 16 ? 16 : bits <= 32 ? 32 : 64;
  return `${signed ? "int" : "uint"}${w}`;
}

/** yaffle.Prim constant of a primitive kind. */
export function primConst(p: string): string {
  return `yaffle.${p.toUpperCase()}`;
}

/** The value type a read of t produces (for `it` and comparisons). */
export function valueTypeOf(model: Model, t: IrType): IrValueType {
  switch (t.kind) {
    case "prim":
      if (t.prim[0] === "f")
        return { kind: "float", bits: Number(t.prim.slice(1)) as 16 | 32 | 64 };
      return {
        kind: "int",
        bits: Number(t.prim.slice(1)) as 8 | 16 | 24 | 32 | 40 | 48 | 56 | 64,
        signed: t.prim[0] === "i"
      };
    case "bool":
      return { kind: "bool" };
    case "string":
      return { kind: "string" };
    case "bytes":
      return { kind: "bytes" };
    case "array":
      return { kind: "array", element: valueTypeOf(model, t.element) };
    case "struct":
      return { kind: "struct", struct: t.struct };
    case "enum":
      return { kind: "enum", enum: t.enum };
    case "pointer": {
      const inner = valueTypeOf(model, t.target);
      return t.nullValue !== undefined && !t.emptyIsNull ? { kind: "nullable", inner } : inner;
    }
    case "extern": {
      const x = model.extern(t.extern);
      return x.kind === "type" ? x.valueType : { kind: "bytes" };
    }
    case "union":
      return {
        kind: "union",
        variants: t.variants.map(v => ({ name: v.name, type: valueTypeOf(model, v.type) }))
      };
    case "transform":
      return t.valueType;
    case "layered":
      return valueTypeOf(model, t.inner);
  }
}
