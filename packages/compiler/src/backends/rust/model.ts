/**
 * Analysis of an IR program for the Rust backend: Rust shapes of every value, the Rust layout
 * of every struct (fields, optional fields, switch enums), and the write-side analyses (late
 * derived values, measured fields, placeable-bearing types, codec caches, virtual streams).
 */
import type {
  IrBits,
  IrBitField,
  IrEnum,
  IrExpr,
  IrExtern,
  IrField,
  IrLayer,
  IrLayoutItem,
  IrLiteral,
  IrMember,
  IrParam,
  IrPrimKind,
  IrProgram,
  IrStruct,
  IrSwitch,
  IrType,
  IrValueType
} from "../../ir/index.ts";
import { NameSet, camel, ident, sanitize, snake, strLit } from "./names.ts";

// ─── Shapes ──────────────────────────────────────────────────────────────────

export type RustInt = "u8" | "u16" | "u32" | "u64" | "i8" | "i16" | "i32" | "i64" | "i128";

export type Shape =
  | { k: "int"; rust: RustInt; bits: number; signed: boolean }
  | { k: "float"; rust: "f32" | "f64"; bits: 16 | 32 | 64 }
  | { k: "bool" }
  | { k: "string" }
  | { k: "bytes" }
  | { k: "endian" }
  | { k: "struct"; id: string }
  | { k: "enum"; id: string }
  | { k: "array"; elem: Shape }
  | { k: "rc"; inner: Shape }
  /** An inline struct value of a recursive type (`Box<T>`, so the type has a finite size). */
  | { k: "box"; inner: Shape }
  | { k: "option"; inner: Shape }
  | { k: "union"; name: string }
  | { k: "oneway"; value: Shape; raw: Shape }
  | { k: "extern"; value: Shape };

export function intShape(bits: number, signed: boolean): Shape {
  const w = bits <= 8 ? 8 : bits <= 16 ? 16 : bits <= 32 ? 32 : 64;
  return { k: "int", rust: `${signed ? "i" : "u"}${w}` as RustInt, bits, signed };
}

/** Values readers and writers take by reference (`&T`), apart from strings, bytes and arrays. */
export function byReference(s: Shape): boolean {
  return (
    s.k === "struct" || s.k === "union" || s.k === "oneway" || s.k === "extern" || s.k === "rc"
  );
}

export function primInfo(p: IrPrimKind): {
  bytes: number;
  signed: boolean;
  float: boolean;
  bits: number;
} {
  const float = p.startsWith("f");
  const bits = Number(p.slice(1));
  return { bytes: bits / 8, signed: p.startsWith("i"), float, bits };
}

export function primShape(p: IrPrimKind): Shape {
  const i = primInfo(p);
  if (i.float)
    return { k: "float", rust: i.bits === 64 ? "f64" : "f32", bits: i.bits as 16 | 32 | 64 };
  return intShape(i.bits, i.signed);
}

// ─── Program model ───────────────────────────────────────────────────────────

export interface ParamModel {
  ir: IrParam;
  /** Rust variable name inside readers/writers. */
  v: string;
  /** Name in root params structs and JSON args (explicit name, bound name, or "endian"). */
  pub: string;
  shape: Shape;
}

export interface FieldInfo {
  name: string;
  /** Rust struct (or switch variant) field identifier. */
  ident: string;
  /** Accessor method name on switch enums (unique in the struct). */
  acc: string;
  /** Reader/writer local variable name. */
  local: string;
  /** The switch case the field is declared in ("" outside switches). */
  caseKey: string;
  shape: Shape;
  /** Declared inside a conditional block or a switch case (the reader local is an Option). */
  conditional: boolean;
  /** Path of switches (outermost first) the field is inside, for write access. */
  switches: SwitchModel[];
  /** Inside an optional (conditional) context in the Rust struct at the top level. */
  optionalTop: boolean;
  ir?: IrField;
  bit?: IrBitField;
  output: boolean;
  input: "required" | "optional" | "absent";
  derive?: IrExpr;
  type?: IrType;
}

export type RMember =
  | { k: "field"; info: FieldInfo; optional: boolean }
  | { k: "switch"; sw: SwitchModel; optional: boolean };

export interface SwitchModel {
  ir: IrSwitch;
  /** Struct field identifier holding the enum. */
  ident: string;
  /** Rust enum name. */
  enumName: string;
  variants: VariantModel[];
  /** Every variant is exactly one field with the same name: tuple variants. */
  tuple: boolean;
  /** Fields reachable inside the variants (for accessor methods). */
  fieldNames: string[];
  /** Switches nested inside the variants (for accessor methods). */
  nested: SwitchModel[];
  /** The switch whose variant contains this one. */
  outer?: SwitchModel;
  /** Optional (inside a conditional block) where it is declared. */
  optional: boolean;
}

export interface VariantModel {
  name: string;
  members: RMember[];
  /** Index into ir.cases, or -1 for default. */
  caseIndex: number;
}

export interface StructModel {
  ir: IrStruct;
  name: string;
  params: ParamModel[];
  /** First declaration of every field name. */
  fields: Map<string, FieldInfo>;
  /** Every declaration (switch cases may redeclare a name with another type). */
  byDecl: Map<IrField | IrBitField, FieldInfo>;
  members: RMember[];
  switches: SwitchModel[];
  /** Holds a codec reuse cache (`__cache`). */
  hasCache: boolean;
}

export interface UnionModel {
  name: string;
  key: string;
  variants: { name: string; irName: string; type: IrType; shape: Shape }[];
}

export interface EnumModel {
  ir: IrEnum;
  name: string;
  storage: Shape;
  variants: { name: string; irName: string; value: string }[];
  unknown?: string;
}

export class BackendError extends Error {}

export class Model {
  structs = new Map<string, StructModel>();
  enums = new Map<string, EnumModel>();
  externs = new Map<string, IrExtern>();
  unions = new Map<string, UnionModel>();
  private unionNames = new NameSet();
  regexes: string[] = [];
  /** Root struct id → name of its params struct. */
  paramsNames = new Map<string, string>();
  /** Structs that contain themselves inline (their inline uses are boxed). */
  recursive = new Set<string>();
  /** Stream source fields: "<structId>.<field>" → id. */
  streamIds = new Map<string, number>();
  /** Arrays whose elements carry an `each` stream (`structId.field`): absent input means none. */
  streamArrays = new Set<string>();
  /** Type keys of `@ref` pointer targets. */
  refKeys = new Set<string>();
  /** Structs that pointers target: their values carry an identity (`__id`). */
  identStructs = new Set<string>();
  private lateMemo = new Map<string, boolean>();
  private bearingMemo = new Map<string, boolean>();
  private sharedMemo = new Map<string, boolean>();

  program: IrProgram;
  externPaths: Record<string, string>;
  constructor(program: IrProgram, externPaths: Record<string, string>) {
    this.program = program;
    this.externPaths = externPaths;
    // Names the generated code uses unqualified (prelude types, traits and variants) can't be type names.
    const typeNames = new NameSet([
      "Rc",
      "Vec",
      "Option",
      "String",
      "Box",
      "Self",
      "Result",
      "yr",
      "Default",
      "Clone",
      "Copy",
      "Debug",
      "PartialEq",
      "Eq",
      "PartialOrd",
      "Ord",
      "Hash",
      "Some",
      "None",
      "Ok",
      "Err",
      "Send",
      "Sync",
      "Sized",
      "Drop",
      "Fn",
      "FnMut",
      "FnOnce",
      "From",
      "Into",
      "TryFrom",
      "TryInto",
      "AsRef",
      "AsMut",
      "Iterator",
      "IntoIterator",
      "ToString",
      "ToOwned",
      "Extend",
      "Unpin"
    ]);
    for (const e of program.externs) this.externs.set(e.id, e);
    for (const en of program.enums) {
      const name = typeNames.take(ident(en.name));
      const vn = new NameSet();
      const variants = en.members.map(m => ({
        name: vn.take(camel(m.name)),
        irName: m.name,
        value: m.value
      }));
      const em: EnumModel = { ir: en, name, storage: primShape(en.storage), variants };
      if (en.open) em.unknown = vn.take("Unknown");
      this.enums.set(en.id, em);
    }
    for (const s of program.structs) {
      const name = typeNames.take(ident(s.name));
      this.structs.set(s.id, {
        ir: s,
        name,
        params: [],
        fields: new Map(),
        byDecl: new Map(),
        members: [],
        switches: [],
        hasCache: false
      });
    }
    this.findRecursive(program);
    // Stream ids first: hidden stream carriers are stored (not output) so the stream can be joined.
    for (const s of program.structs) {
      for (const f of allFields(s.members)) {
        if (f.from) this.registerStream(s, f.from.stream);
      }
    }
    for (const s of program.structs) this.buildStruct(this.structs.get(s.id)!, typeNames);
    for (const r of program.roots) {
      const sm = this.structs.get(r.struct);
      if (sm && !this.paramsNames.has(r.struct))
        this.paramsNames.set(r.struct, typeNames.take(`${sm.name}Params`));
    }
    // Ref target keys and stream ids.
    for (const s of program.structs) {
      this.walkTypes(s, t => {
        if (t.kind === "pointer" && t.ownership === "ref") this.refKeys.add(typeKey(t.target));
        if (t.kind === "pointer") {
          const inner = effectiveLayers(this, t.target).inner;
          if (inner.kind === "struct") this.identStructs.add(inner.struct);
        }
      });
    }
  }

  /** Structs reachable from themselves through inline values (not arrays or pointers). */
  private findRecursive(program: IrProgram): void {
    const edges = new Map<string, Set<string>>();
    const inlineStructs = (t: IrType, out: Set<string>): void => {
      if (t.kind === "struct") out.add(t.struct);
      else if (t.kind === "layered") inlineStructs(t.inner, out);
      else if (t.kind === "transform" && !t.write) inlineStructs(t.inner, out);
      else if (t.kind === "union") t.variants.forEach(v => inlineStructs(v.type, out));
    };
    for (const s of program.structs) {
      const out = new Set<string>();
      for (const f of allFields(s.members)) inlineStructs(f.type, out);
      edges.set(s.id, out);
    }
    for (const s of program.structs) {
      const seen = new Set<string>();
      const stack = [...(edges.get(s.id) ?? [])];
      while (stack.length > 0) {
        const x = stack.pop()!;
        if (x === s.id) {
          this.recursive.add(s.id);
          break;
        }
        if (seen.has(x)) continue;
        seen.add(x);
        stack.push(...(edges.get(x) ?? []));
      }
    }
  }

  private registerStream(s: IrStruct, st: NonNullable<IrField["from"]>["stream"]): void {
    if (st.kind === "field") this.streamId(s.id, st.field);
    else if (st.kind === "each") {
      const arr = findField(s.members, st.array);
      const elem = arr ? elementStruct(arr.type) : undefined;
      if (elem) this.streamId(elem, st.field);
      this.streamArrays.add(`${s.id}.${st.array}`);
    } else this.registerStream(s, st.stream);
  }

  streamId(structId: string, field: string): number {
    const k = `${structId}.${field}`;
    let id = this.streamIds.get(k);
    if (id === undefined) {
      id = this.streamIds.size + 1;
      this.streamIds.set(k, id);
    }
    return id;
  }

  struct(id: string): StructModel {
    const s = this.structs.get(id);
    if (!s) throw new BackendError(`unknown struct ${id}`);
    return s;
  }
  enum(id: string): EnumModel {
    const e = this.enums.get(id);
    if (!e) throw new BackendError(`unknown enum ${id}`);
    return e;
  }
  extern(id: string): IrExtern {
    const e = this.externs.get(id);
    if (!e) throw new BackendError(`unknown extern ${id}`);
    return e;
  }
  externPath(id: string): string {
    const e = this.extern(id);
    if (e.kind === "type" && e.builtin) {
      if (e.id === "uleb128" || e.name === "uleb128") return "yr::codec::ULEB128";
      if (e.id === "sleb128" || e.name === "sleb128") return "yr::codec::SLEB128";
    }
    const p = this.externPaths[e.name] ?? this.externPaths[id];
    if (!p) throw new BackendError(`extern ${e.name} has no Rust implementation (options.externs)`);
    return p;
  }

  regex(pattern: string): number {
    let i = this.regexes.indexOf(pattern);
    if (i < 0) {
      i = this.regexes.length;
      this.regexes.push(pattern);
    }
    return i;
  }

  // ─── Shapes ────────────────────────────────────────────────────────────────

  shapeOfType(t: IrType, ctxName: string, inline = true): Shape {
    switch (t.kind) {
      case "prim":
        return primShape(t.prim);
      case "bool":
        return { k: "bool" };
      case "string":
        return { k: "string" };
      case "bytes":
        return { k: "bytes" };
      case "array":
        return { k: "array", elem: this.shapeOfType(t.element, ctxName, false) };
      case "struct":
        return inline && this.recursive.has(t.struct)
          ? { k: "box", inner: { k: "struct", id: t.struct } }
          : { k: "struct", id: t.struct };
      case "enum":
        return { k: "enum", id: t.enum };
      case "pointer": {
        const rc: Shape = { k: "rc", inner: this.shapeOfType(t.target, ctxName, false) };
        // `@nullable(empty)`: null reads as an empty array, so the value is never null.
        return t.nullValue !== undefined && !t.emptyIsNull ? { k: "option", inner: rc } : rc;
      }
      case "extern": {
        const e = this.extern(t.extern);
        if (e.kind !== "type") throw new BackendError(`${e.name} is not an extern type`);
        return { k: "extern", value: this.shapeOfValue(e.valueType, ctxName) };
      }
      case "union":
        return { k: "union", name: this.unionFor(t, ctxName).name };
      case "transform":
        if (t.write) return this.shapeOfValue(t.valueType, ctxName);
        return {
          k: "oneway",
          value: this.shapeOfValue(t.valueType, ctxName),
          raw: this.shapeOfType(t.inner, ctxName)
        };
      case "layered":
        return this.shapeOfType(t.inner, ctxName, inline);
    }
  }

  shapeOfValue(v: IrValueType, ctxName: string): Shape {
    switch (v.kind) {
      case "int":
        return intShape(v.bits, v.signed);
      case "bigint":
        return { k: "int", rust: "i128", bits: 128, signed: true };
      case "float":
        return { k: "float", rust: v.bits === 64 ? "f64" : "f32", bits: v.bits };
      case "bool":
        return { k: "bool" };
      case "string":
        return { k: "string" };
      case "bytes":
        return { k: "bytes" };
      case "endian":
        return { k: "endian" };
      case "struct":
        return { k: "struct", id: v.struct };
      case "enum":
        return { k: "enum", id: v.enum };
      case "array":
        return { k: "array", elem: this.shapeOfValue(v.element, ctxName) };
      case "nullable":
        return { k: "option", inner: this.shapeOfValue(v.inner, ctxName) };
      case "union": {
        const t: IrType = {
          kind: "union",
          variants: v.variants.map(x => ({ name: x.name, type: valueToType(x.type) }))
        };
        return {
          k: "union",
          name: this.unionFor(t as Extract<IrType, { kind: "union" }>, ctxName).name
        };
      }
      case "extern":
        return { k: "extern", value: this.shapeOfValue(v.valueType, ctxName) };
    }
  }

  unionFor(t: Extract<IrType, { kind: "union" }>, ctxName: string): UnionModel {
    const key = JSON.stringify(t.variants.map(v => [v.name, typeKey(v.type)]));
    let u = this.unions.get(key);
    if (!u) {
      const name = this.unionNames.take(camel(ctxName) + "Union");
      const vn = new NameSet();
      u = { name, key, variants: [] };
      this.unions.set(key, u);
      u.variants = t.variants.map(v => ({
        name: vn.take(camel(v.name)),
        irName: v.name,
        type: v.type,
        shape: this.shapeOfType(v.type, ctxName + "_" + v.name)
      }));
    }
    return u;
  }

  rustType(s: Shape): string {
    switch (s.k) {
      case "int":
      case "float":
        return s.rust;
      case "bool":
        return "bool";
      case "string":
        return "String";
      case "bytes":
        return "Vec<u8>";
      case "endian":
        return "yr::Endian";
      case "struct":
        return this.struct(s.id).name;
      case "enum":
        return this.enum(s.id).name;
      case "array":
        return `Vec<${this.rustType(s.elem)}>`;
      case "box":
        return `Box<${this.rustType(s.inner)}>`;
      case "rc":
        return `Rc<${this.rustType(s.inner)}>`;
      case "option":
        return `Option<${this.rustType(s.inner)}>`;
      case "union":
        return s.name;
      case "oneway":
        return `yr::OneWay<${this.rustType(s.value)}, ${this.rustType(s.raw)}>`;
      case "extern":
        return this.rustType(s.value);
    }
  }

  /** Rust type of a parameter (references for non-Copy values). */
  paramType(s: Shape, lt: string): string {
    if (s.k === "string") return `&${lt}str`;
    if (s.k === "bytes") return `&${lt}[u8]`;
    if (s.k === "array") return `&${lt}[${this.rustType(s.elem)}]`;
    if (s.k === "option") return `Option<${this.paramType(s.inner, lt)}>`;
    return byReference(s) ? `&${lt}${this.rustType(s)}` : this.rustType(s);
  }

  // ─── Struct layout ─────────────────────────────────────────────────────────

  private buildStruct(sm: StructModel, typeNames: NameSet): void {
    const s = sm.ir;
    const pn = new NameSet();
    sm.params = s.params.map(p => ({
      ir: p,
      v: "p_" + sanitize(p.name),
      pub: pn.take(p.origin === "bound" ? (p.boundName ?? p.name) : p.name),
      shape: this.shapeOfValue(p.type, s.name + "_" + p.name)
    }));
    const idents = new NameSet(["__cache"]);
    const accs = new NameSet([
      "default",
      "clone",
      "eq",
      "ne",
      "fmt",
      "hash",
      "to_json",
      "from_json",
      "to_json_with",
      "from_json_with"
    ]);
    const locals = new NameSet();
    const declare = (
      name: string,
      shape: Shape,
      conditional: boolean,
      switches: SwitchModel[],
      optionalTop: boolean,
      caseKey: string,
      decl: IrField | IrBitField,
      extra: Partial<FieldInfo>
    ): FieldInfo => {
      const same = JSON.stringify(shape);
      const prev = [...sm.byDecl.values()].find(
        f => f.name === name && JSON.stringify(f.shape) === same
      );
      const first = sm.fields.get(name);
      if (prev) {
        prev.conditional = true;
        sm.byDecl.set(decl, prev);
        return prev;
      }
      if (first && !(first.caseKey !== "" && caseKey !== "" && first.caseKey !== caseKey)) {
        throw new BackendError(
          `${s.name}.${name}: declared with different types in different branches (only switch cases may do that in the Rust backend)`
        );
      }
      const info: FieldInfo = {
        name,
        ident: switches.length > 0 ? snake(name) : idents.take(snake(name)),
        acc: switches.length > 0 ? accs.take(snake(name)) : "",
        local: locals.take("f_" + sanitize(name)),
        caseKey,
        shape,
        conditional,
        switches,
        optionalTop,
        output: true,
        input: "required",
        ...extra
      };
      if (!first) sm.fields.set(name, info);
      sm.byDecl.set(decl, info);
      return info;
    };
    let switchCount = 0;
    const group = (
      members: IrMember[],
      optional: boolean,
      conditional: boolean,
      switches: SwitchModel[],
      caseKey: string
    ): RMember[] => {
      const out: RMember[] = [];
      const push = (m: RMember) => {
        if (m.k === "field" && out.some(o => o.k === "field" && o.info === m.info)) return;
        out.push(m);
      };
      const field = (decl: IrField | IrBitField, name: string, keep: boolean) => {
        const info = declare(
          name,
          this.shapeOfType(decl.type, s.name + "_" + name),
          conditional,
          switches,
          optional && switches.length === 0,
          caseKey,
          decl,
          {
            ...("kind" in decl ? { ir: decl } : { bit: decl }),
            output: decl.output,
            input: decl.input,
            ...(decl.derive ? { derive: decl.derive } : {}),
            type: decl.type
          }
        );
        if (keep) push({ k: "field", info, optional: optional || decl.input === "optional" });
      };
      for (const m of members) {
        if (m.kind === "field") {
          field(m, m.name, m.output || this.streamIds.has(`${s.id}.${m.name}`));
        } else if (m.kind === "bits") {
          for (const b of m.fields) if (b.name !== null) field(b, b.name, b.output);
        } else if (m.kind === "block") {
          if (m.condition) {
            for (const x of group(m.members, true, true, switches, caseKey)) push(x);
            for (const x of group(m.else ?? [], true, true, switches, caseKey)) push(x);
          } else {
            for (const x of group(m.members, optional, conditional, switches, caseKey)) push(x);
          }
        } else {
          const idx = switchCount++;
          const swm: SwitchModel = {
            ir: m,
            ident: "",
            enumName: "",
            variants: [],
            tuple: false,
            fieldNames: [],
            nested: [],
            optional
          };
          const outer = switches[switches.length - 1];
          if (outer) {
            swm.outer = outer;
            outer.nested.push(swm);
          }
          const inner = [...switches, swm];
          const vn = new NameSet(["Default"]);
          const cases = m.cases.map((c, ci) => ({
            name: vn.take(variantName(c.values, this)),
            members: group(c.members, false, true, inner, `${idx}:${ci}`),
            caseIndex: ci
          }));
          if (m.default)
            cases.push({
              name: "Default",
              members: group(m.default, false, true, inner, `${idx}:d`),
              caseIndex: -1
            });
          swm.variants = cases;
          const single = cases.every(
            c => c.members.length === 1 && c.members[0]!.k === "field" && !c.members[0]!.optional
          );
          const names = new Set(
            cases.map(c => (c.members[0]?.k === "field" ? c.members[0].info.name : ""))
          );
          swm.tuple = single && names.size === 1 && cases.length > 0;
          const base = swm.tuple
            ? [...names][0]!
            : m.discriminantField
              ? `${m.discriminantField}_case`
              : `switch${idx}`;
          swm.ident = switches.length > 0 ? accs.take(snake(base)) : idents.take(snake(base));
          swm.enumName = typeNames.take(`${sm.name}_${camel(base)}`);
          swm.fieldNames = collectFieldNames(cases);
          sm.switches.push(swm);
          out.push({ k: "switch", sw: swm, optional });
        }
      }
      return out;
    };
    sm.members = group(s.members, false, false, [], "");
    sm.hasCache = this.structNeedsCache(s);
  }

  /** A struct holds a codec reuse cache when it has codec layers, or values that do. */
  private structNeedsCache(s: IrStruct): boolean {
    const via = (layers: IrLayer[]) => layers.some(l => l.kind === "via");
    if (via(s.layers)) return true;
    if (allMembers(s.members).some(m => m.kind === "block" && via(m.layers))) return true;
    let found = false;
    this.walkTypes(s, t => {
      if (t.kind === "layered" && via(t.layers)) found = true;
      if (t.kind === "struct" && via(this.struct(t.struct).ir.layers)) found = true;
    });
    return found;
  }

  /** Visits every type of a struct's fields and bitfields, nested types included. */
  walkTypes(s: IrStruct, f: (t: IrType) => void): void {
    const visit = (t: IrType): void => {
      f(t);
      switch (t.kind) {
        case "layered":
        case "transform":
          visit(t.inner);
          break;
        case "array":
          visit(t.element);
          break;
        case "pointer":
          visit(t.target);
          break;
        case "union":
          for (const v of t.variants) visit(v.type);
          break;
        default:
          break;
      }
    };
    for (const fld of allFields(s.members)) visit(fld.type);
    for (const b of allBits(s.members)) for (const x of b.fields) visit(x.type);
  }

  // ─── Write-side analyses ───────────────────────────────────────────────────

  /** A derived field whose value depends on positions, sizes or final bytes. */
  isLateField(sm: StructModel, name: string): boolean {
    const key = `${sm.ir.id}.${name}`;
    const memo = this.lateMemo.get(key);
    if (memo !== undefined) return memo;
    this.lateMemo.set(key, false);
    const f = sm.fields.get(name);
    const late = !!f?.derive && f.input !== "required" && this.isLateExpr(sm, f.derive);
    this.lateMemo.set(key, late);
    return late;
  }

  isLateExpr(sm: StructModel, e: IrExpr): boolean {
    let late = false;
    walkExpr(e, x => {
      if (late) return;
      if (x.kind === "builtinValue" && (x.name === "offset" || x.name === "end")) late = true;
      else if (x.kind === "call" && x.callee.kind === "builtin") {
        const n = x.callee.name;
        if (
          n === "sizeof" ||
          n === "encodedSize" ||
          n === "offsetof" ||
          n === "bytesof" ||
          n === "encode"
        )
          late = true;
        if ((n === "crc32" || n === "adler32") && x.args[0] && x.args[0].type.kind !== "bytes")
          late = true;
      } else if (x.kind === "field" && this.isLateField(sm, x.name)) late = true;
    });
    return late;
  }

  /** Does a value of this type contain placeables of the enclosing base? */
  bearing(t: IrType): boolean {
    switch (t.kind) {
      case "pointer":
        return t.ownership === "owned";
      case "array":
        return t.elementPlacement !== undefined || this.bearing(t.element);
      case "layered":
        return !t.layers.some(l => l.kind === "via") && this.bearing(t.inner);
      case "transform":
        return this.bearing(t.inner);
      case "union":
        return t.variants.some(v => this.bearing(v.type));
      case "struct":
        return this.structBearing(t.struct);
      default:
        return false;
    }
  }

  structBearing(id: string): boolean {
    const memo = this.bearingMemo.get(id);
    if (memo !== undefined) return memo;
    this.bearingMemo.set(id, false);
    const s = this.struct(id).ir;
    let r = false;
    if (!s.base && !s.layers.some(l => l.kind === "via")) {
      for (const f of allFields(s.members)) {
        if (
          f.placement ||
          (f.type.kind === "array" && f.type.elementPlacement) ||
          this.bearing(f.type)
        )
          r = true;
      }
    }
    this.bearingMemo.set(id, r);
    return r;
  }

  private contentMemo: { structs: Set<string>; members: Set<string> } | undefined;

  /**
   * Whether a derived value reads field `field` of struct `sid`: through a checksum or the bytes
   * of a value containing the struct, or by member access. Views don't patch such fields in
   * place (the derived value would go stale).
   */
  contentRead(sid: string, field: string): boolean {
    if (!this.contentMemo) {
      const structs = new Set<string>();
      const members = new Set<string>();
      const reach = (t: IrType): void => {
        switch (t.kind) {
          case "struct":
            if (structs.has(t.struct)) return;
            structs.add(t.struct);
            for (const f of allFields(this.struct(t.struct).ir.members)) reach(f.type);
            return;
          case "layered":
          case "transform":
            return reach(t.inner);
          case "array":
            return reach(t.element);
          case "pointer":
            return reach(t.target);
          case "union":
            return t.variants.forEach(v => reach(v.type));
          default:
            return;
        }
      };
      for (const s of this.program.structs) {
        const derives: IrExpr[] = [];
        for (const f of allFields(s.members)) if (f.derive) derives.push(f.derive);
        for (const b of allBits(s.members))
          for (const x of b.fields) if (x.derive) derives.push(x.derive);
        for (const d of derives) {
          walkExpr(d, x => {
            if (x.kind === "call" && x.callee.kind === "builtin") {
              const n = x.callee.name;
              if (["crc32", "adler32", "bytesof", "encode"].includes(n)) {
                const a = x.args[0];
                if (a?.kind === "field") {
                  const f = findField(s.members, a.name);
                  if (f) reach(f.type);
                } else if (a?.kind === "this") reach({ kind: "struct", struct: s.id, args: [] });
              }
            } else if (x.kind === "member" && x.object.type.kind === "struct")
              members.add(`${x.object.type.struct}.${x.name}`);
            else if (x.kind === "map") {
              const at = x.array.type;
              if (at.kind === "array" && at.element.kind === "struct")
                members.add(`${at.element.struct}.${x.field}`);
            }
          });
        }
      }
      this.contentMemo = { structs, members };
    }
    return this.contentMemo.structs.has(sid) || this.contentMemo.members.has(`${sid}.${field}`);
  }

  /**
   * Does a scanned (shallow) value of this type hold placeholders: pointer targets, `at` and
   * `from` fields, and with `codecs`, regions of non-streaming codecs (scans don't decode them)?
   */
  private placeholders(t: IrType, codecs: boolean, seen: Set<string>): boolean {
    const lazyVia = (layers: IrLayer[]) =>
      codecs &&
      layers.some(l => {
        const c = l.kind === "via" ? this.externs.get(l.codec) : undefined;
        return c?.kind === "codec" && !c.streaming;
      });
    switch (t.kind) {
      case "pointer":
        return true;
      case "array":
        return t.elementPlacement !== undefined || this.placeholders(t.element, codecs, seen);
      case "layered":
        return lazyVia(t.layers) || this.placeholders(t.inner, codecs, seen);
      case "transform":
        return this.placeholders(t.inner, codecs, seen);
      case "union":
        return t.variants.some(v => this.placeholders(v.type, codecs, seen));
      case "struct": {
        if (seen.has(t.struct)) return false;
        seen.add(t.struct);
        const s = this.struct(t.struct).ir;
        // Struct-level codecs are use-site layers; block codecs are decoded by scans, and their
        // fields scanned in the decoded region.
        return (
          lazyVia(s.layers) ||
          allFields(s.members).some(
            f =>
              f.placement !== undefined ||
              f.from !== undefined ||
              this.placeholders(f.type, codecs, seen)
          )
        );
      }
      default:
        return false;
    }
  }

  /** Does a scanned value of this type hold pointer targets, `at` or `from` fields? */
  hasUnread(t: IrType): boolean {
    return this.placeholders(t, false, new Set());
  }

  /** A field a scan leaves a placeholder for (views read it on demand). */
  lazyField(f: IrField): boolean {
    return (
      f.placement !== undefined ||
      f.from !== undefined ||
      this.placeholders(f.type, true, new Set())
    );
  }

  /** Can a value of this shape contain shared (pointer) targets that need JSON paths? */
  sharedShape(s: Shape): boolean {
    switch (s.k) {
      case "rc":
        return true;
      case "box":
        return this.sharedShape(s.inner);
      case "array":
      case "option":
        return this.sharedShape(s.k === "array" ? s.elem : s.inner);
      case "struct": {
        if (this.identStructs.has(s.id)) return true;
        const memo = this.sharedMemo.get(s.id);
        if (memo !== undefined) return memo;
        this.sharedMemo.set(s.id, false);
        const sm = this.struct(s.id);
        const r = [...sm.fields.values()].some(f => this.sharedShape(f.shape));
        this.sharedMemo.set(s.id, r);
        return r;
      }
      case "union": {
        const u = [...this.unions.values()].find(x => x.name === s.name);
        return !!u && u.variants.some(v => this.sharedShape(v.shape));
      }
      case "oneway":
        return this.sharedShape(s.value);
      default:
        return false;
    }
  }
}

// ─── IR helpers ──────────────────────────────────────────────────────────────

/** Every member, nested blocks, else branches and switch cases included (pre-order). */
export function allMembers(members: IrMember[]): IrMember[] {
  const out: IrMember[] = [];
  const visit = (ms: IrMember[]) => {
    for (const m of ms) {
      out.push(m);
      if (m.kind === "block") {
        visit(m.members);
        visit(m.else ?? []);
      } else if (m.kind === "switch") {
        for (const c of m.cases) visit(c.members);
        visit(m.default ?? []);
      }
    }
  };
  visit(members);
  return out;
}

export function allFields(members: IrMember[]): IrField[] {
  return allMembers(members).filter((m): m is IrField => m.kind === "field");
}

export function allBits(members: IrMember[]): IrBits[] {
  return allMembers(members).filter((m): m is IrBits => m.kind === "bits");
}

export function findField(members: IrMember[], name: string): IrField | undefined {
  return allFields(members).find(f => f.name === name);
}

/** The expressions of layers: sizes, codec arguments, alignments, padding, fills. */
export function layerExprs(layers: IrLayer[], out: IrExpr[] = []): IrExpr[] {
  for (const l of layers) {
    if (l.kind === "size") out.push(l.size);
    else if (l.kind === "via") out.push(...l.args);
    else if (l.kind === "align" || l.kind === "alignEnd") {
      out.push(l.to);
      if (l.offset) out.push(l.offset);
    } else if (l.kind === "padBefore" || l.kind === "padAfter") out.push(l.count);
    else if (l.kind === "padUntil") out.push(l.size);
    else if (l.kind === "endian") out.push(l.value);
    if ("fill" in l && l.fill.kind === "fn") out.push(l.fill.expr);
  }
  return out;
}

/** The expressions of a struct's layout items (alignments), group items included. */
export function layoutExprs(items: IrLayoutItem[], out: IrExpr[] = []): IrExpr[] {
  for (const it of items) {
    layerExprs(it.layers, out);
    if (it.group) layoutExprs(it.group.items, out);
  }
  return out;
}

/**
 * The expressions inside a type: lengths, terminators, arguments, layer parameters, … The write
 * expressions of transforms only with `write` (readers don't evaluate them).
 */
export function typeExprs(t: IrType, write = true, out: IrExpr[] = []): IrExpr[] {
  const visit = (x: IrType) => typeExprs(x, write, out);
  switch (t.kind) {
    case "string":
    case "bytes":
      if (t.length.kind === "count") out.push(t.length.expr);
      break;
    case "array":
      if (t.length.kind === "count") out.push(t.length.expr);
      if (t.length.kind === "until" || t.length.kind === "before") out.push(t.length.terminator);
      if (t.length.kind === "untilPredicate") out.push(t.length.predicate);
      if (t.elementPlacement) out.push(t.elementPlacement);
      visit(t.element);
      break;
    case "struct":
    case "extern":
      out.push(...t.args);
      break;
    case "pointer":
      if (t.origin) out.push(t.origin);
      visit(t.target);
      break;
    case "transform":
      out.push(t.read);
      if (write && t.write) out.push(t.write);
      visit(t.inner);
      break;
    case "layered":
      layerExprs(t.layers, out);
      visit(t.inner);
      break;
    case "union":
      t.variants.forEach(v => visit(v.type));
      break;
    default:
      break;
  }
  return out;
}

/**
 * Every expression of a struct's members: types, checks, placements, conditions, and with
 * `write`, the formulas of derived fields and transform writes (readers don't evaluate them).
 */
export function memberExprs(members: IrMember[], write: boolean): IrExpr[] {
  const out: IrExpr[] = [];
  for (const m of allMembers(members)) {
    if (m.kind === "field") {
      typeExprs(m.type, write, out);
      out.push(...m.checks.map(c => c.expr));
      if (m.placement) out.push(m.placement.offset);
      if (m.derive && write) out.push(m.derive);
      if (m.virtual) out.push(m.virtual.read);
    } else if (m.kind === "block") {
      if (m.condition) out.push(m.condition);
      layerExprs(m.layers, out);
    } else if (m.kind === "switch") out.push(m.discriminant);
    else
      for (const f of m.fields) {
        out.push(...f.checks.map(c => c.expr));
        if (f.derive && write) out.push(f.derive);
      }
  }
  return out;
}

/**
 * Visits an expression and its subexpressions (pre-order). Returning `false` from `f` skips the
 * subexpressions of that node.
 */
export function walkExpr(e: IrExpr, f: (e: IrExpr) => boolean | void): void {
  if (f(e) === false) return;
  const walk = (x: IrExpr) => walkExpr(x, f);
  switch (e.kind) {
    case "member":
      walk(e.object);
      break;
    case "index":
      walk(e.object);
      walk(e.index);
      break;
    case "map":
      walk(e.array);
      break;
    case "unary":
    case "convert":
      walk(e.operand);
      break;
    case "binary":
      walk(e.left);
      walk(e.right);
      break;
    case "cond":
      walk(e.test);
      walk(e.then);
      walk(e.else);
      break;
    case "call":
      e.args.forEach(walk);
      break;
    case "in":
      walk(e.value);
      for (const it of e.items) {
        if (it.kind === "value") walk(it.value);
        else {
          walk(it.low);
          walk(it.high);
        }
      }
      break;
    case "regex":
      walk(e.value);
      break;
    case "lambda":
      walk(e.body);
      break;
    default:
      break;
  }
}

/** The measuring builtins: they read a field's position, size or bytes. */
const MEASURES = ["sizeof", "offsetof", "bytesof", "encode", "encodedSize"];

/**
 * Fields whose position, size or bytes expressions read (`sizeof(x)`, `crc32(x)` of a non-bytes
 * field, …), with the layer level each one measures (`encodedSize(x, k)` and `encode(x)`: a
 * level; the others: "all", the field on disk).
 */
export function measuredFields(exprs: IrExpr[]): Map<string, Set<number | "all">> {
  const out = new Map<string, Set<number | "all">>();
  for (const e of exprs)
    walkExpr(e, x => {
      if (x.kind !== "call" || x.callee.kind !== "builtin") return;
      const n = x.callee.name;
      const a = x.args[0];
      const name = argName(a);
      if (!a || name === undefined) return;
      let level: number | "all" | undefined;
      if (n === "encode") level = 0;
      else if (n === "encodedSize") level = Number(literalInt(x.args[1]) ?? 0);
      else if (MEASURES.includes(n)) level = "all";
      else if ((n === "crc32" || n === "adler32") && a.type.kind !== "bytes") level = "all";
      if (level === undefined) return;
      let s = out.get(name);
      if (!s) out.set(name, (s = new Set()));
      s.add(level);
    });
  return out;
}

/** The value of an integer literal expression. */
export function literalInt(e: IrExpr | undefined): string | undefined {
  if (e && e.kind === "literal" && e.value.kind === "int") return e.value.value;
  return undefined;
}

/** The struct id of an array's elements (through layers and transforms). */
export function elementStruct(t: IrType): string | undefined {
  let x: IrType = t;
  while (x.kind === "layered" || x.kind === "transform") x = x.inner;
  if (x.kind !== "array") return undefined;
  let e: IrType = x.element;
  while (e.kind === "layered" || e.kind === "transform") e = e.inner;
  return e.kind === "struct" ? e.struct : undefined;
}

/** A stable key of a type's encoding shape, used to match `@ref` targets with candidates. */
export function typeKey(t: IrType): string {
  const strip = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(strip);
    if (x && typeof x === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
        if (k === "args" || k === "source") continue;
        o[k] = strip(v);
      }
      return o;
    }
    return x;
  };
  return JSON.stringify(strip(t));
}

function valueToType(v: IrValueType): IrType {
  switch (v.kind) {
    case "struct":
      return { kind: "struct", struct: v.struct, args: [] };
    case "enum":
      return { kind: "enum", enum: v.enum, endian: "inherit" };
    case "bool":
      return { kind: "bool" };
    case "string":
      return {
        kind: "string",
        unit: 1,
        encoding: "utf8",
        endian: "inherit",
        length: { kind: "rest" }
      };
    case "bytes":
      return { kind: "bytes", length: { kind: "rest" } };
    case "int":
      return {
        kind: "prim",
        prim: `${v.signed ? "i" : "u"}${v.bits}` as IrPrimKind,
        endian: "inherit"
      };
    case "float":
      return { kind: "prim", prim: `f${v.bits}` as IrPrimKind, endian: "inherit" };
    case "array":
      return { kind: "array", element: valueToType(v.element), length: { kind: "rest" } };
    default:
      return { kind: "bytes", length: { kind: "rest" } };
  }
}

function literalName(l: IrLiteral, m: Model): string {
  switch (l.kind) {
    case "int":
      return l.value.startsWith("-") ? `Neg${l.value.slice(1)}` : `V${l.value}`;
    case "float":
      return `F${String(l.value).replace(/[^0-9a-zA-Z]/g, "_")}`;
    case "bool":
      return l.value ? "True" : "False";
    case "string":
      return l.value === "" ? "Empty" : camel(l.value);
    case "bytes":
      return `X${l.hex}`;
    case "endian":
      return camel(l.value);
    case "enum": {
      const e = m.enums.get(l.enum);
      return e?.variants.find(v => v.irName === l.member)?.name ?? camel(l.member);
    }
  }
}

function variantName(values: IrLiteral[], m: Model): string {
  if (values.length === 0) return "Empty";
  return values.map(v => literalName(v, m)).join("Or");
}

function collectFieldNames(variants: VariantModel[]): string[] {
  const out = new Set<string>();
  const visit = (ms: RMember[]) => {
    for (const m of ms) {
      if (m.k === "field") out.add(m.info.name);
      else for (const v of m.sw.variants) visit(v.members);
    }
  };
  for (const v of variants) visit(v.members);
  return [...out];
}

/**
 * The name a measuring builtin (`sizeof`, `offsetof`, …) refers to: a field's name, or `$this`
 * for the current struct (`sizeof(this)`, IR `{ kind: "this" }`).
 */
export function argName(a: IrExpr | undefined): string | undefined {
  if (!a) return undefined;
  if (a.kind === "field") return a.name;
  if ((a as { kind: string }).kind === "this") return "$this";
  return undefined;
}

/** The Rust variable of a struct's `endian` parameter, or little endian. */
export function endianVar(sm: StructModel): string {
  return sm.params.find(p => p.ir.origin === "endian")?.v ?? "yr::Endian::Le";
}

/** A root struct used with its own parameters as arguments. */
export function rootType(sm: StructModel): IrType {
  const args = sm.params.map(p => ({ kind: "param", name: p.ir.name, type: p.ir.type }) as IrExpr);
  return { kind: "struct", struct: sm.ir.id, args };
}

/** `Option<&Enum>` access to a switch's enum value from a struct value `obj`. */
export function switchAccess(sw: SwitchModel, obj: string): string {
  if (!sw.outer) return sw.optional ? `${obj}.${sw.ident}.as_ref()` : `Some(&${obj}.${sw.ident})`;
  return `${switchAccess(sw.outer, obj)}.and_then(|__s| __s.${sw.ident}())`;
}

/** Access to a field of a struct value `obj`: a place (`opt: false`) or an `Option<&T>`. */
export function fieldAccess(f: FieldInfo, obj: string): { opt: boolean; code: string } {
  if (f.switches.length > 0) {
    return {
      opt: true,
      code: `${switchAccess(f.switches[0]!, obj)}.and_then(|__s| __s.${f.acc}())`
    };
  }
  if (f.optionalTop || f.input === "optional")
    return { opt: true, code: `${obj}.${f.ident}.as_ref()` };
  return { opt: false, code: `${obj}.${f.ident}` };
}

/** A field's reader local as a place: an `Option` when `optional` (absent is an `INPUT` error). */
export function localPlace(f: FieldInfo, optional: boolean): string {
  return optional ? `(*yr::present(${f.local}.as_ref(), ${strLit(f.name)})?)` : f.local;
}

/** A field of a struct value `obj` as a place; an absent optional field is an `INPUT` error. */
export function fieldPlace(f: FieldInfo, obj: string): string {
  const acc = fieldAccess(f, obj);
  return acc.opt ? `(*yr::present(${acc.code}, ${strLit(f.name)})?)` : acc.code;
}

/**
 * Number of struct-level layers merged in front of a use's layers. Layer indices in the IR
 * (`encodedSize(x, k)`) count the use-site layers only, so effective level = k + this.
 */
export function structLayerCount(m: Model, t: IrType): number {
  let inner = t;
  while (inner.kind === "layered") inner = inner.inner;
  if (inner.kind !== "struct") return 0;
  const s = m.struct(inner.struct).ir;
  return s.base ? s.layers.filter(l => l.kind !== "alignEnd").length : s.layers.length;
}

/**
 * Splits off the outermost `align` / `padBefore` layers: padding before a field's content is not
 * part of the field for `offsetof` / `sizeof` (the offset points at the aligned content).
 * `leading` is outermost first.
 */
export function splitLeading(layers: IrLayer[]): { leading: IrLayer[]; rest: IrLayer[] } {
  let n = layers.length;
  const leading: IrLayer[] = [];
  while (n > 0 && (layers[n - 1]!.kind === "align" || layers[n - 1]!.kind === "padBefore")) {
    leading.push(layers[n - 1]!);
    n--;
  }
  return { leading, rest: layers.slice(0, n) };
}

/** Layers of a use of a type with the struct's own layers merged in (innermost first). */
export function effectiveLayers(m: Model, t: IrType): { inner: IrType; layers: IrLayer[] } {
  let inner = t;
  let layers: IrLayer[] = [];
  if (t.kind === "layered") {
    inner = t.inner;
    layers = t.layers;
  }
  if (inner.kind === "struct") {
    const s = m.struct(inner.struct).ir;
    // A `@base` struct's `@alignEnd` pads its whole region, inside the struct.
    const own = s.base ? s.layers.filter(l => l.kind !== "alignEnd") : s.layers;
    if (own.length > 0) layers = [...own, ...layers];
  }
  if (inner.kind === "layered") {
    const nested = effectiveLayers(m, inner);
    return { inner: nested.inner, layers: [...nested.layers, ...layers] };
  }
  return { inner, layers };
}
