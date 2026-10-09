/**
 * C++ types for IR types and value types, and enum declarations.
 *
 * Mapping (docs/targets/cpp.md): u8…u64 → std::uint8_t…std::uint64_t (u24 → uint32_t, u40/u48/u56 →
 * uint64_t, signed alike), f16/f32 → float, f64 → double, bool → bool, strings → std::string
 * (UTF-8), bytes → yaffle::Bytes, arrays → std::vector, enums → enum class, unions → std::variant,
 * structs by value (or std::shared_ptr for pointer targets and by-value cycles), pointers →
 * std::shared_ptr for struct/array/union targets and the value (std::optional when nullable)
 * otherwise. Conditional fields and optional inputs are std::optional.
 */
import type { IrPrimKind, IrStruct, IrType, IrValueType } from "../../ir/index.ts";
import { stripLayers } from "./analysis.ts";
import { Code, intLit } from "./code.ts";
import type { Model } from "./model.ts";

export function primCppType(p: IrPrimKind): string {
  if (p === "f16" || p === "f32") return "float";
  if (p === "f64") return "double";
  return intCppType(Number(p.slice(1)), p[0] === "i");
}

export function intCppType(bits: number, signed: boolean): string {
  const w = bits <= 8 ? 8 : bits <= 16 ? 16 : bits <= 32 ? 32 : 64;
  return `std::${signed ? "int" : "uint"}${w}_t`;
}

export class TypeMapper {
  readonly model: Model;
  /** Union C++ types by structural key → alias name. */
  readonly unions = new Map<string, { name: string; variants: string[] }>();
  private unionCount = 0;

  constructor(model: Model) {
    this.model = model;
  }

  structRef(id: string): string {
    const n = this.model.structName(id);
    return this.model.isShared(id) ? `std::shared_ptr<${n}>` : n;
  }

  /** C++ type of a value read with IR type `t`. */
  type(t: IrType): string {
    switch (t.kind) {
      case "prim":
        return primCppType(t.prim);
      case "bool":
        return "bool";
      case "string":
        return "std::string";
      case "bytes":
        return "yaffle::Bytes";
      case "array":
        return `std::vector<${this.type(t.element)}>`;
      case "struct":
        return this.structRef(t.struct);
      case "enum":
        return this.model.enumName(t.enum);
      case "pointer":
        return this.pointerType(t);
      case "extern": {
        const x = this.model.extern(t.extern);
        return x.kind === "type" ? this.valueType(x.valueType) : "yaffle::Bytes";
      }
      case "union":
        return this.unionAlias(t.variants.map(v => this.type(v.type)));
      case "transform":
        return this.valueType(t.valueType);
      case "layered":
        return this.type(t.inner);
    }
  }

  /** Pointer targets: shared for struct/array/union targets (identity), values otherwise. */
  pointerType(t: Extract<IrType, { kind: "pointer" }>): string {
    const x = stripLayers(t.target);
    if (x.kind === "struct") return `std::shared_ptr<${this.model.structName(x.struct)}>`;
    if (x.kind === "array" || x.kind === "union") return `std::shared_ptr<${this.type(x)}>`;
    const v = this.type(t.target);
    return t.nullValue !== undefined && !t.emptyIsNull ? `std::optional<${v}>` : v;
  }

  /** True if pointers to this target type hold a shared object (null = nullptr). */
  sharedTarget(target: IrType): boolean {
    const x = stripLayers(target);
    return x.kind === "struct" || x.kind === "array" || x.kind === "union";
  }

  /** The alias of the `std::variant` of these variant types (declared once per program). */
  private unionAlias(variants: string[]): string {
    const key = variants.join("|");
    const hit = this.unions.get(key);
    if (hit) return hit.name;
    const name = `Union${++this.unionCount}`;
    this.unions.set(key, { name, variants });
    return name;
  }

  /** C++ type of a value type. */
  valueType(t: IrValueType): string {
    switch (t.kind) {
      case "int":
        return intCppType(t.bits, t.signed);
      case "bigint":
        return "yaffle::i128";
      case "float":
        return t.bits === 64 ? "double" : "float";
      case "bool":
        return "bool";
      case "string":
        return "std::string";
      case "bytes":
        return "yaffle::Bytes";
      case "endian":
        return "yaffle::Endian";
      case "struct":
        return this.structRef(t.struct);
      case "enum":
        return this.model.enumName(t.enum);
      case "array":
        return `std::vector<${this.valueType(t.element)}>`;
      case "nullable": {
        const inner = this.valueType(t.inner);
        return inner.startsWith("std::shared_ptr<") ? inner : `std::optional<${inner}>`;
      }
      case "union":
        return this.unionAlias(t.variants.map(v => this.valueType(v.type)));
      case "extern":
        return this.valueType(t.valueType);
    }
  }

  /** C++ type of a struct parameter (scalars by value, the rest by const reference). */
  paramType(t: IrValueType): string {
    const c = this.valueType(t);
    if (
      t.kind === "int" ||
      t.kind === "bigint" ||
      t.kind === "float" ||
      t.kind === "bool" ||
      t.kind === "endian" ||
      t.kind === "enum"
    )
      return c;
    return `const ${c}&`;
  }

  /** The member type of a field (optional when conditional or an optional input). */
  memberType(s: IrStruct, name: string, t: IrType): string {
    const c = this.type(t);
    return this.model.isOptionalMember(s, name) ? `std::optional<${c}>` : c;
  }

  /** Default member initializer for scalars. */
  defaultInit(t: IrType): string {
    const x = stripLayers(t);
    switch (x.kind) {
      case "prim":
        return " = 0";
      case "bool":
        return " = false";
      case "enum":
        return "{}";
      case "transform":
        return valueInit(x.valueType);
      case "extern": {
        const e = this.model.extern(x.extern);
        return e.kind === "type" ? valueInit(e.valueType) : "";
      }
      case "pointer":
        if (this.sharedTarget(x.target) || (x.nullValue !== undefined && !x.emptyIsNull)) return "";
        return this.defaultInit(x.target);
      default:
        return "";
    }
  }

  emitEnum(code: Code, id: string): void {
    const e = this.model.enum(id);
    const name = this.model.enumName(id);
    code.block(
      `enum class ${name} : ${primCppType(e.storage)}`,
      () => {
        for (const m of e.members) code.line(`${enumMember(m.name)} = ${intLit(BigInt(m.value))},`);
      },
      ";"
    );
  }
}

function valueInit(v: IrValueType): string {
  if (v.kind === "int" || v.kind === "bigint" || v.kind === "float") return " = 0";
  if (v.kind === "bool") return " = false";
  if (v.kind === "enum") return "{}";
  return "";
}

/** C++ enumerator name. */
export function enumMember(name: string): string {
  let s = name.replace(/[^A-Za-z0-9_]/g, "_");
  if (/^[0-9]/.test(s)) s = "_" + s;
  return ENUM_RESERVED.has(s) ? `${s}_` : s;
}

const ENUM_RESERVED = new Set(
  (
    "alignas alignof and and_eq asm auto bitand bitor bool break case catch char class compl " +
    "concept const constexpr continue decltype default delete do double else enum explicit export " +
    "extern false float for friend goto if inline int long mutable namespace new noexcept not " +
    "nullptr operator or private protected public register return short signed sizeof static " +
    "struct switch template this throw true try typedef typename union unsigned using virtual void " +
    "volatile while xor EOF NULL TRUE FALSE DOMAIN errno"
  ).split(" ")
);
