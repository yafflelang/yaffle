/**
 * Program model for the Java backend: lookups, the static analyses the emitters need
 * (placeables, static sizes, field tables, type keys) and Java naming (classes, fields, unions,
 * references to JDK and runtime classes).
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
  eachStream,
  forEachMember,
  literalInt,
  primSize,
  storageType,
  unlayer
} from "./analysis.ts";
import { ident } from "./code.ts";

/** A named value in a struct (an IrField or a named bitfield), in declaration order. */
export interface FieldRef {
  name: string;
  field?: IrField;
  bit?: IrBitField;
  /** Inside an `if` without else, an if/else branch, or a switch case. */
  conditional: boolean;
}

/** The IR type of a field or bitfield. */
export const refType = (f: FieldRef): IrType => (f.field ? f.field.type : f.bit!.type);
export const refInput = (f: FieldRef): IrField["input"] => (f.field ? f.field.input : f.bit!.input);
export const refOutput = (f: FieldRef): boolean => (f.field ? f.field.output : f.bit!.output);

/** Per-struct Java field naming. */
export interface FieldInfo {
  /** JSON / IR name. */
  name: string;
  /** Java field name. */
  java: string;
  /** Java type of the field. */
  type: string;
  /** For one-way transforms: the field holding the raw value (written, in JSON). */
  raw?: { java: string; type: string };
  /** Not public (hidden fields). */
  hidden: boolean;
  /** The Java type is a reference type (may be null). */
  nullable: boolean;
  /** The Java type is a boxed primitive (Integer, Long, …). */
  boxed: boolean;
  /**
   * A conditional field whose value may be null (a nullable pointer): the flag field telling a
   * taken branch with a null value from an untaken branch (canonical JSON shows `null` vs. no key).
   */
  present?: string;
}

/** A union type's Java interface and variant records. */
export interface UnionInfo {
  name: string;
  variants: { name: string; java: string }[];
  /** The variants' types: IR types for `union` types, value types for transform results. */
  types: ({ ir: true; type: IrType } | { ir: false; type: IrValueType })[];
}

/** Simple names the generated code uses unqualified when no user type shadows them. */
const JDK_TYPES: Record<string, string> = {
  List: "java.util.List",
  ArrayList: "java.util.ArrayList",
  Map: "java.util.Map",
  LinkedHashMap: "java.util.LinkedHashMap",
  Arrays: "java.util.Arrays",
  Objects: "java.util.Objects",
  BigInteger: "java.math.BigInteger",
  CompletableFuture: "java.util.concurrent.CompletableFuture",
  Pattern: "java.util.regex.Pattern"
};

export const RUNTIME_PACKAGE = "dev.yaffle.runtime";

const RUNTIME_TYPES = new Set(
  (
    "Api AsyncCodec AsyncSource AsyncView Bytes Canon Checksums Codec CodecCtx Codecs Commit " +
    "Decoded Encoding Endian ErrorCode Extent ExternType Fill Frame FromJsonCtx Hex Ints Json " +
    "LArray LEntry LStruct Layout LayoutItem Leb128 Lists ListView Patch Placeable Prim Reader Rt " +
    "SafeResult Source Streams StructInfo StructView ToJsonCtx ViewNode ViewRead ViewRoot ViewScan " +
    "Writer YEnum YValue YaffleException"
  ).split(" ")
);

/** Calls `f` for every type reachable from the members (not descending into other structs). */
function walkTypes(members: readonly IrMember[], f: (t: IrType) => void): void {
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

export class Model {
  readonly program: IrProgram;
  readonly pkg: string;
  private readonly structs = new Map<string, IrStruct>();
  private readonly enums = new Map<string, IrEnum>();
  private readonly externs = new Map<string, IrExtern>();
  private readonly placeableMemo = new Map<string, boolean>();
  private readonly fieldsMemo = new Map<string, FieldRef[]>();
  private readonly sizeMemo = new Map<string, number | null>();
  private readonly fieldInfoMemo = new Map<string, Map<string, FieldInfo>>();
  /** Type keys of `@ref` pointer targets: values of these types register as ref sites. */
  private readonly refTargetKeys = new Set<string>();
  /** "structId.field" of bytes fields that `from arr[*].field` streams join. */
  readonly streamPieces = new Set<string>();
  /** Structs that pointers or `at` fields can target: their inline values join the identity map. */
  readonly identityStructs = new Set<string>();
  private readonly classNames = new Map<string, string>();
  private readonly enumNames = new Map<string, string>();
  /** Union key → interface name and variant records. */
  readonly unions = new Map<string, UnionInfo>();
  /** Every simple type name user code defines (structs, enums, unions). */
  private readonly userTypes = new Set<string>();
  /** Name of the nested options class of roots. */
  readonly optionsName: string;

  constructor(input: IrProgram, pkg: string) {
    const program = structuredClone(input);
    this.program = program;
    this.pkg = pkg;
    for (const s of program.structs) this.structs.set(s.id, s);
    for (const e of program.enums) this.enums.set(e.id, e);
    for (const x of program.externs) this.externs.set(x.id, x);
    const noteTarget = (t: IrType): void => {
      const x = storageType(t);
      if (x.kind === "struct") this.identityStructs.add(x.struct);
      else if (x.kind === "array") noteTarget(x.element);
    };
    for (const s of program.structs) {
      walkTypes(s.members, t => {
        if (t.kind === "pointer") {
          if (t.ownership === "ref") this.refTargetKeys.add(this.typeKey(t.target));
          noteTarget(t.target);
        }
      });
      forEachMember(s.members, m => {
        if (m.kind === "field" && m.placement) noteTarget(m.type);
      });
      for (const f of this.fields(s)) {
        const st = eachStream(f.field?.from?.stream);
        if (!st) continue;
        const arr = this.field(s, st.array)?.field;
        const t = arr && unlayer(arr.type);
        const et = t?.kind === "array" ? unlayer(t.element) : undefined;
        if (et?.kind === "struct") this.streamPieces.add(`${et.struct}.${st.field}`);
      }
    }
    this.assignNames();
    this.optionsName = this.userTypes.has("Options") ? "Options_" : "Options";
  }

  // ── naming ──────────────────────────────────────────────────────────────────

  private typeIdent(name: string): string {
    const s = ident(name);
    return /^_[0-9]/.test(s) ? "T" + s : s;
  }

  private assignNames(): void {
    const taken = new Set<string>();
    const claim = (base: string): string => {
      let n = base;
      let k = 2;
      while (taken.has(n.toLowerCase())) n = `${base}${k++}`;
      taken.add(n.toLowerCase());
      this.userTypes.add(n);
      return n;
    };
    for (const s of this.program.structs) this.classNames.set(s.id, claim(this.typeIdent(s.name)));
    for (const e of this.program.enums) this.enumNames.set(e.id, claim(this.typeIdent(e.name)));
    // One sealed interface per distinct variant list.
    const register = (key: string, variants: { name: string }[], types: UnionInfo["types"]) => {
      if (this.unions.has(key)) return;
      const name = claim(variants.map(v => this.typeIdent(v.name)).join("Or"));
      this.unions.set(key, { name, variants: this.variantNames(variants), types });
    };
    for (const s of this.program.structs) {
      walkTypes(s.members, t => {
        if (t.kind !== "union") return;
        register(
          this.unionKeyT(t),
          t.variants,
          t.variants.map(v => ({ ir: true, type: v.type }))
        );
      });
    }
    const visitV = (t: IrValueType): void => {
      if (t.kind === "union") {
        register(
          this.unionKeyV(t),
          t.variants,
          t.variants.map(v => ({ ir: false, type: v.type }))
        );
        t.variants.forEach(v => visitV(v.type));
      } else if (t.kind === "array") visitV(t.element);
      else if (t.kind === "nullable") visitV(t.inner);
    };
    for (const s of this.program.structs) {
      for (const p of s.params) visitV(p.type);
      walkTypes(s.members, t => {
        if (t.kind === "transform") visitV(t.valueType);
      });
    }
  }

  private variantNames(vs: readonly { name: string }[]): { name: string; java: string }[] {
    const used = new Set<string>();
    return vs.map(v => {
      let j = this.typeIdent(v.name);
      while (used.has(j)) j += "_";
      used.add(j);
      return { name: v.name, java: j };
    });
  }

  /** Key of a union type: variant names and their Java types. */
  private unionKeyT(t: Extract<IrType, { kind: "union" }>): string {
    return t.variants.map(v => `${v.name}:${this.valueKeyJ(this.valueTypeOf(v.type))}`).join("|");
  }

  private unionKeyV(t: Extract<IrValueType, { kind: "union" }>): string {
    return t.variants.map(v => `${v.name}:${this.valueKeyJ(v.type)}`).join("|");
  }

  /** A key identifying the Java type of a value type. */
  private valueKeyJ(t: IrValueType): string {
    switch (t.kind) {
      case "int":
        return javaIntKind(t.bits, t.signed);
      case "float":
        return t.bits === 32 ? "float" : "double";
      case "struct":
        return `S:${t.struct}`;
      case "enum":
        return `E:${t.enum}`;
      case "array":
        return `[${this.valueKeyJ(t.element)}]`;
      case "nullable":
        return `?${this.valueKeyJ(t.inner)}`;
      case "union":
        return `U(${this.unionKeyV(t)})`;
      case "extern":
        return this.valueKeyJ(t.valueType);
      default:
        return t.kind;
    }
  }

  /** The Java class name of a struct. */
  className(id: string): string {
    const n = this.classNames.get(id);
    if (!n) throw new Error(`unknown struct ${id}`);
    return n;
  }

  enumName(id: string): string {
    const n = this.enumNames.get(id);
    if (!n) throw new Error(`unknown enum ${id}`);
    return n;
  }

  unionOfT(t: Extract<IrType, { kind: "union" }>): UnionInfo {
    return this.union(this.unionKeyT(t));
  }

  unionOfV(t: Extract<IrValueType, { kind: "union" }>): UnionInfo {
    return this.union(this.unionKeyV(t));
  }

  private union(key: string): UnionInfo {
    const u = this.unions.get(key);
    if (!u) throw new Error("unknown union type");
    return u;
  }

  /** A JDK type's name in generated code (simple unless a user type shadows it). */
  jdk(name: string): string {
    const fq = JDK_TYPES[name];
    if (!fq) throw new Error(`unknown JDK type ${name}`);
    return this.userTypes.has(name) ? fq : name;
  }

  isJdk(name: string): boolean {
    return name in JDK_TYPES;
  }

  /** A java.lang type's name in generated code. */
  lang(name: string): string {
    return this.userTypes.has(name) ? `java.lang.${name}` : name;
  }

  /** A runtime class's name in generated code. */
  rt(name: string): string {
    return this.userTypes.has(name) ? `${RUNTIME_PACKAGE}.${name}` : name;
  }

  /** Imports for a generated file body: every runtime/JDK simple name it mentions (unshadowed). */
  importsFor(body: string, used: Set<string>): string[] {
    const names = new Set(used);
    for (const n of [...RUNTIME_TYPES, ...Object.keys(JDK_TYPES)]) {
      if (new RegExp(`(?<![\\w.$])${n}\\b`).test(body)) names.add(n);
    }
    const out: string[] = [];
    for (const n of [...names].sort()) {
      if (this.userTypes.has(n)) continue;
      if (RUNTIME_TYPES.has(n)) out.push(`import ${RUNTIME_PACKAGE}.${n};`);
      else if (JDK_TYPES[n]) out.push(`import ${JDK_TYPES[n]};`);
    }
    return out;
  }

  /** Fully qualified name of a user type. */
  fq(simple: string): string {
    return this.pkg ? `${this.pkg}.${simple}` : simple;
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

  /** Every named field of a struct, flattened in declaration order. */
  fields(s: IrStruct): FieldRef[] {
    const hit = this.fieldsMemo.get(s.id);
    if (hit) return hit;
    const out: FieldRef[] = [];
    forEachMember(s.members, (m, conditional) => {
      if (m.kind === "field") out.push({ name: m.name, field: m, conditional });
      else if (m.kind === "bits") {
        for (const b of m.fields)
          if (b.name !== null) out.push({ name: b.name, bit: b, conditional });
      }
    });
    this.fieldsMemo.set(s.id, out);
    return out;
  }

  field(s: IrStruct, name: string): FieldRef | undefined {
    return this.fields(s).find(f => f.name === name);
  }

  /** The output fields of a struct, one per name (its first output declaration). */
  outputFields(s: IrStruct): FieldRef[] {
    const seen = new Set<string>();
    return this.fields(s).filter(f => refOutput(f) && !seen.has(f.name) && seen.add(f.name));
  }

  /** True if some declaration of the field is conditional. */
  isConditional(s: IrStruct, name: string): boolean {
    return this.fields(s).some(f => f.name === name && f.conditional);
  }

  // ── Java fields ─────────────────────────────────────────────────────────────

  /** Java field info of every named field of a struct (one entry per name). */
  fieldInfos(s: IrStruct): Map<string, FieldInfo> {
    const hit = this.fieldInfoMemo.get(s.id);
    if (hit) return hit;
    const used = new Set<string>();
    const unique = (base: string): string => {
      let n = base;
      while (used.has(n)) n += "_";
      used.add(n);
      return n;
    };
    const byName = new Map<string, FieldRef[]>();
    for (const f of this.fields(s)) byName.set(f.name, [...(byName.get(f.name) ?? []), f]);
    // Every name first, so raw-field names never shadow real fields.
    const javaNames = new Map<string, string>();
    for (const [name, list] of byName) {
      const hidden = !refOutput(list[0]!);
      javaNames.set(name, unique(hidden ? `$${name.replace(/[^A-Za-z0-9_]/g, "_")}` : ident(name)));
    }
    const out = new Map<string, FieldInfo>();
    for (const [name, list] of byName) {
      const java = javaNames.get(name)!;
      const hidden = !refOutput(list[0]!);
      const boxedWanted =
        list.length > 1 || list.some(f => f.conditional || refInput(f) === "optional");
      const types = new Set(list.map(f => this.javaType(refType(f), boxedWanted)));
      const type = types.size === 1 ? [...types][0]! : this.lang("Object");
      const info: FieldInfo = {
        name,
        java,
        type,
        hidden,
        boxed: isBoxed(type),
        nullable: !isPrimitive(type)
      };
      const nullableValue = list.some(
        f => f.field && this.valueTypeOf(f.field.type).kind === "nullable"
      );
      if (!hidden && nullableValue && list.some(f => f.conditional)) {
        info.present = unique(`$has_${java.replace(/^\$/, "")}`);
      }
      const t = list[0]!.field && unlayer(list[0]!.field.type);
      if (t?.kind === "transform" && !t.write) {
        info.raw = { java: unique(`${java}Raw`), type: this.javaType(t.inner, boxedWanted) };
      }
      out.set(name, info);
    }
    this.fieldInfoMemo.set(s.id, out);
    return out;
  }

  fieldInfo(s: IrStruct, name: string): FieldInfo {
    const f = this.fieldInfos(s).get(name);
    if (!f) throw new Error(`unknown field ${name} in ${s.name}`);
    return f;
  }

  // ── Java types ──────────────────────────────────────────────────────────────

  /** Java type of a value read with IR type `t`. */
  javaType(t: IrType, boxed = false, qualified = false): string {
    return this.javaValueType(this.valueTypeOf(t), boxed, qualified);
  }

  /** Java type of a value type. */
  javaValueType(t: IrValueType, boxed = false, qualified = false): string {
    const q = (n: string): string => (qualified ? this.fq(n) : n);
    switch (t.kind) {
      case "int": {
        const k = javaIntKind(t.bits, t.signed);
        return boxed ? this.lang(k === "int" ? "Integer" : "Long") : k;
      }
      case "bigint":
        return this.jdk("BigInteger");
      case "float":
        if (t.bits === 32) return boxed ? this.lang("Float") : "float";
        return boxed ? this.lang("Double") : "double";
      case "bool":
        return boxed ? this.lang("Boolean") : "boolean";
      case "string":
        return this.lang("String");
      case "bytes":
        return "byte[]";
      case "endian":
        return this.rt("Endian");
      case "struct":
        return q(this.className(t.struct));
      case "enum":
        return q(this.enumName(t.enum));
      case "array":
        return `${this.jdk("List")}<${this.javaValueType(t.element, true, qualified)}>`;
      case "nullable":
        return this.javaValueType(t.inner, true, qualified);
      case "union":
        return q(this.unionOfV(t).name);
      case "extern":
        return this.javaValueType(t.valueType, boxed, qualified);
    }
  }

  /** The boxed Java type of a primitive Java type (other types are returned as they are). */
  boxedOf(java: string): string {
    const box = BOXES[java];
    return box ? this.lang(box) : java;
  }

  /** The value type a read of `t` produces. */
  valueTypeOf(t: IrType): IrValueType {
    switch (t.kind) {
      case "prim":
        if (t.prim[0] === "f") {
          return { kind: "float", bits: Number(t.prim.slice(1)) as 16 | 32 | 64 };
        }
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
        return { kind: "array", element: this.valueTypeOf(t.element) };
      case "struct":
        return { kind: "struct", struct: t.struct };
      case "enum":
        return { kind: "enum", enum: t.enum };
      case "pointer": {
        const inner = this.valueTypeOf(t.target);
        return t.nullValue !== undefined && !t.emptyIsNull ? { kind: "nullable", inner } : inner;
      }
      case "extern": {
        const x = this.extern(t.extern);
        return x.kind === "type" ? x.valueType : { kind: "bytes" };
      }
      case "union":
        return {
          kind: "union",
          variants: t.variants.map(v => ({ name: v.name, type: this.valueTypeOf(v.type) }))
        };
      case "transform":
        return t.valueType;
      case "layered":
        return this.valueTypeOf(t.inner);
    }
  }

  // ── placeables ──────────────────────────────────────────────────────────────

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
    const v = !s.base && !s.layers.some(l => l.kind === "via") && this.membersHavePlaceables(s);
    this.placeableMemo.set(id, v);
    return v;
  }

  /** True if a struct's members create placeables in its region (its own `base` flag ignored). */
  membersHavePlaceables(s: IrStruct): boolean {
    let found = false;
    forEachMember(s.members, m => {
      if (m.kind !== "field" || found) return;
      found = !!m.placement || (!m.from && !m.virtual && this.hasPlaceables(m.type));
    });
    return found;
  }

  // ── static sizes ────────────────────────────────────────────────────────────

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
        return inner === undefined ? undefined : layersStatic(inner, t.layers);
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
    if (size !== undefined) size = layersStatic(size, s.layers);
    this.sizeMemo.set(id, size ?? null);
    return size;
  }

  /** Static inline size of a member list (unconditional members only). */
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
        n = inner === undefined ? undefined : layersStatic(inner, m.layers);
      }
      if (n === undefined) return undefined;
      size += n;
    }
    return size;
  }

  // ── type keys ───────────────────────────────────────────────────────────────

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

/** Applies size-changing layers with literal arguments; undefined if not static. */
function layersStatic(inner: number, layers: readonly IrLayer[]): number | undefined {
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

/** Java primitive kind for an integer type. */
export function javaIntKind(bits: number, signed: boolean): "int" | "long" {
  return bits <= (signed ? 32 : 24) ? "int" : "long";
}

const BOXES: Record<string, string> = {
  int: "Integer",
  long: "Long",
  double: "Double",
  float: "Float",
  boolean: "Boolean"
};

const BOXED = new Set(Object.values(BOXES));

export function isBoxed(type: string): boolean {
  return BOXED.has(type.replace(/^java\.lang\./, ""));
}

export function isPrimitive(type: string): boolean {
  return type in BOXES;
}
