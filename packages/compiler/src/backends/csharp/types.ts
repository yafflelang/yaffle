/**
 * C# types of IR values: one class per struct (used both as the parse result and as the
 * serialize input), enums with the storage's underlying type, `List<T>` for arrays, `byte[]` for
 * bytes, nullable types for conditional fields, nullable pointers and optional inputs.
 */
import type { IrField, IrStruct, IrType, IrValueType } from "../../ir/index.ts";
import { stripLayers } from "./analysis.ts";
import type { FieldRef, Model } from "./model.ts";

/** C# value types (non-nullable without `?`). */
const VALUE_TYPES = new Set([
  "byte",
  "sbyte",
  "ushort",
  "short",
  "uint",
  "int",
  "ulong",
  "long",
  "Int128",
  "BigInteger",
  "Half",
  "float",
  "double",
  "bool",
  "Rt.Endian"
]);

export interface FieldInfo {
  /** C# member name. */
  member: string;
  /** C# type of the member (with `?` when nullable). */
  type: string;
  /** C# type of the value without nullability. */
  base: string;
  nullable: boolean;
  /** The base type is a C# value type (nullable → `Nullable<T>`). */
  valueType: boolean;
}

export class Types {
  readonly model: Model;
  /** C# names of the enums (value types). */
  private readonly enumNames: Set<string>;

  constructor(model: Model) {
    this.model = model;
    this.enumNames = new Set(model.program.enums.map(e => model.enumName(e.id)));
  }

  intType(bits: number, signed: boolean): string {
    if (bits <= 8) return signed ? "sbyte" : "byte";
    if (bits <= 16) return signed ? "short" : "ushort";
    if (bits <= 32) return signed ? "int" : "uint";
    return signed ? "long" : "ulong";
  }

  primType(p: string): string {
    if (p === "f16") return "Half";
    if (p === "f32") return "float";
    if (p === "f64") return "double";
    return this.intType(Number(p.slice(1)), p[0] === "i");
  }

  isValueType(cs: string): boolean {
    return VALUE_TYPES.has(cs) || this.enumNames.has(cs);
  }

  /** C# type of a value type (non-nullable unless the IR type is nullable). */
  valueType(t: IrValueType): string {
    switch (t.kind) {
      case "int":
        return this.intType(t.bits, t.signed);
      case "bigint":
        return "Int128";
      case "float":
        return t.bits === 16 ? "Half" : t.bits === 32 ? "float" : "double";
      case "bool":
        return "bool";
      case "string":
        return "string";
      case "bytes":
        return "byte[]";
      case "endian":
        return "Rt.Endian";
      case "struct":
        return this.model.className(t.struct);
      case "enum":
        return this.model.enumName(t.enum);
      case "array":
        return `List<${this.valueType(t.element)}>`;
      case "nullable":
        return `${this.valueType(t.inner)}?`;
      case "union":
        return "Rt.UnionValue";
      case "extern":
        return this.valueType(t.valueType);
    }
  }

  /** C# type of a value read with IR type `t` (pointers: nullable target type when nullable). */
  type(t: IrType): string {
    switch (t.kind) {
      case "prim":
        return this.primType(t.prim);
      case "bool":
        return "bool";
      case "string":
        return "string";
      case "bytes":
        return "byte[]";
      case "array":
        return `List<${this.type(t.element)}>`;
      case "struct":
        return this.model.className(t.struct);
      case "enum":
        return this.model.enumName(t.enum);
      case "pointer": {
        const target = this.type(t.target);
        return t.nullValue !== undefined && !t.emptyIsNull ? `${target}?` : target;
      }
      case "extern": {
        const x = this.model.extern(t.extern);
        return x.kind === "type" ? this.valueType(x.valueType) : "object";
      }
      case "union":
        return "Rt.UnionValue";
      case "transform":
        return this.valueType(t.valueType);
      case "layered":
        return this.type(t.inner);
    }
  }

  /** The type without a trailing `?`. */
  nonNull(cs: string): string {
    return cs.endsWith("?") ? cs.slice(0, -1) : cs;
  }

  /** C# declaration info of a struct field (or bitfield). */
  field(s: IrStruct, f: FieldRef): FieldInfo {
    const member = this.model.member(s, f.name);
    if (this.model.isMultiField(s, f.name))
      return { member, type: "object?", base: "object", nullable: true, valueType: false };
    const decl = f.field ?? f.bit!;
    const cs = this.type(decl.type);
    const base = this.nonNull(cs);
    const nullable =
      cs !== base ||
      f.conditional ||
      decl.input === "optional" ||
      (f.field !== undefined && !f.field.output);
    return {
      member,
      type: nullable ? `${base}?` : base,
      base,
      nullable,
      valueType: this.isValueType(base)
    };
  }

  /** The one-way transform under a field's layers, if any (canonical JSON shows its raw value). */
  oneWay(f: IrField): Extract<IrType, { kind: "transform" }> | undefined {
    const t = stripLayers(f.type);
    return t.kind === "transform" && !t.write ? t : undefined;
  }
}
