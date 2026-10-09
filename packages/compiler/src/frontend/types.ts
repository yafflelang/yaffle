/**
 * Type helpers shared by the checker, lowering and the language service: the primitive table,
 * IR value-type utilities, static sizes and display strings.
 */
import type {
  IrBitField,
  IrField,
  IrEndianSpec,
  IrLiteral,
  IrPrimKind,
  IrType,
  IrValueType
} from "../ir/index.ts";

export interface PrimInfo {
  prim: IrPrimKind;
  bytes: number;
  bits: 8 | 16 | 24 | 32 | 40 | 48 | 56 | 64;
  signed: boolean;
  float: boolean;
}

export const PRIMS: Record<IrPrimKind, PrimInfo> = Object.fromEntries(
  (
    [
      ["u8", 1, false, false],
      ["u16", 2, false, false],
      ["u24", 3, false, false],
      ["u32", 4, false, false],
      ["u40", 5, false, false],
      ["u48", 6, false, false],
      ["u56", 7, false, false],
      ["u64", 8, false, false],
      ["i8", 1, true, false],
      ["i16", 2, true, false],
      ["i24", 3, true, false],
      ["i32", 4, true, false],
      ["i40", 5, true, false],
      ["i48", 6, true, false],
      ["i56", 7, true, false],
      ["i64", 8, true, false],
      ["f16", 2, true, true],
      ["f32", 4, true, true],
      ["f64", 8, true, true]
    ] as const
  ).map(([prim, bytes, signed, float]) => [
    prim,
    { prim, bytes, bits: (bytes * 8) as PrimInfo["bits"], signed, float }
  ])
) as Record<IrPrimKind, PrimInfo>;

/** Built-in scalar and string type names (besides the primitives with optional le/be suffix). */
type BuiltinTypeName =
  | { kind: "prim"; prim: IrPrimKind; endian: IrEndianSpec }
  | { kind: "bool" }
  | { kind: "char"; unit: 1 | 2 | 4 }
  | { kind: "str"; unit: 1 | 2 | 4 }
  | { kind: "leb"; signed: boolean };

export function lookupBuiltinType(name: string): BuiltinTypeName | undefined {
  if (name === "bool") return { kind: "bool" };
  if (name === "char") return { kind: "char", unit: 1 };
  if (name === "char16") return { kind: "char", unit: 2 };
  if (name === "char32") return { kind: "char", unit: 4 };
  if (name === "str") return { kind: "str", unit: 1 };
  if (name === "str16") return { kind: "str", unit: 2 };
  if (name === "str32") return { kind: "str", unit: 4 };
  if (name === "uleb128") return { kind: "leb", signed: false };
  if (name === "sleb128") return { kind: "leb", signed: true };
  const m = /^([ui](?:8|16|24|32|40|48|56|64)|f(?:16|32|64))(le|be)?$/.exec(name);
  if (m)
    return {
      kind: "prim",
      prim: m[1] as IrPrimKind,
      endian: (m[2] as "le" | "be" | undefined) ?? "inherit"
    };
  return undefined;
}

/** An integer primitive type name (`u32`, `i16be`, …), not a float. */
export function intPrim(name: string): { prim: IrPrimKind; endian: IrEndianSpec } | undefined {
  const b = lookupBuiltinType(name);
  return b && b.kind === "prim" && !PRIMS[b.prim].float
    ? { prim: b.prim, endian: b.endian }
    : undefined;
}

export const BUILTIN_TYPE_NAMES: string[] = [
  ...Object.keys(PRIMS).flatMap(p =>
    PRIMS[p as IrPrimKind].bytes > 1 ? [p, p + "le", p + "be"] : [p]
  ),
  "bool",
  "char",
  "char16",
  "char32",
  "str",
  "str16",
  "str32",
  "uleb128",
  "sleb128"
];

// ── value types ──────────────────────────────────────────────────────────────

export const BIGINT: IrValueType = { kind: "bigint" };
export const F64: IrValueType = { kind: "float", bits: 64 };
export const BOOL: IrValueType = { kind: "bool" };
export const STRING: IrValueType = { kind: "string" };
export const BYTES: IrValueType = { kind: "bytes" };
export const ENDIAN: IrValueType = { kind: "endian" };
export const U8: IrValueType = { kind: "int", bits: 8, signed: false };
export const U32: IrValueType = { kind: "int", bits: 32, signed: false };

/** Marker type for expressions that failed to type (suppresses follow-on errors). Never reaches IR output. */
export const ERROR_TYPE: IrValueType = { kind: "struct", struct: "<error>" };

/** Opaque type of a generic type parameter during checking. Never reaches IR output. */
export function typeParamType(name: string): IrValueType {
  return { kind: "struct", struct: `<T:${name}>` };
}

export function isErrorType(t: IrValueType): boolean {
  return t.kind === "struct" && t.struct === "<error>";
}

export function isTypeParamType(t: IrValueType): boolean {
  return t.kind === "struct" && t.struct.startsWith("<T:");
}

export function isIntType(t: IrValueType): boolean {
  return t.kind === "int" || t.kind === "bigint";
}

export function isNumericType(t: IrValueType): boolean {
  return t.kind === "int" || t.kind === "bigint" || t.kind === "float";
}

export function intType(p: IrPrimKind): IrValueType {
  const info = PRIMS[p];
  if (info.float) return { kind: "float", bits: info.bits as 16 | 32 | 64 };
  return { kind: "int", bits: info.bits, signed: info.signed };
}

export function sameValueType(a: IrValueType, b: IrValueType): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Range of an int value type as [min, max]. */
export function intRange(t: IrValueType): [bigint, bigint] | undefined {
  if (t.kind !== "int") return undefined;
  const bits = BigInt(t.bits);
  if (t.signed) return [-(1n << (bits - 1n)), (1n << (bits - 1n)) - 1n];
  return [0n, (1n << bits) - 1n];
}

export function fitsInt(v: bigint, t: IrValueType): boolean {
  const r = intRange(t);
  if (!r) return t.kind === "bigint";
  return v >= r[0] && v <= r[1];
}

/** The value type of an IR type (what the field holds in generated code). */
export function valueTypeOf(
  t: IrType,
  structValue?: (id: string) => IrValueType,
  externValue?: (id: string) => IrValueType
): IrValueType {
  switch (t.kind) {
    case "prim":
      return intType(t.prim);
    case "bool":
      return BOOL;
    case "string":
      return STRING;
    case "bytes":
      return BYTES;
    case "array":
      return { kind: "array", element: valueTypeOf(t.element, structValue, externValue) };
    case "struct":
      if (t.struct.startsWith("<T:")) return { kind: "struct", struct: t.struct };
      return structValue ? structValue(t.struct) : { kind: "struct", struct: t.struct };
    case "enum":
      return { kind: "enum", enum: t.enum };
    case "pointer": {
      const inner = valueTypeOf(t.target, structValue, externValue);
      return t.nullValue !== undefined ? { kind: "nullable", inner } : inner;
    }
    case "extern":
      // An extern type's value is its declared value type (the host returns a plain value).
      return externValue ? externValue(t.extern) : BIGINT;
    case "union":
      return {
        kind: "union",
        variants: t.variants.map(v => ({
          name: v.name,
          type: valueTypeOf(v.type, structValue, externValue)
        }))
      };
    case "transform":
      return t.valueType;
    case "layered":
      return valueTypeOf(t.inner, structValue, externValue);
  }
}

/** Strips layers and transforms. */
export function coreType(t: IrType): IrType {
  while (t.kind === "layered" || t.kind === "transform") t = t.inner;
  return t;
}

export function displayValueType(t: IrValueType, names?: (id: string) => string): string {
  switch (t.kind) {
    case "int":
      return `${t.signed ? "i" : "u"}${t.bits}`;
    case "bigint":
      return "int";
    case "float":
      return `f${t.bits}`;
    case "bool":
    case "string":
    case "bytes":
    case "endian":
      return t.kind;
    case "struct":
      if (t.struct === "<error>") return "?";
      if (t.struct.startsWith("<T:")) return t.struct.slice(3, -1);
      return names ? names(t.struct) : t.struct;
    case "enum":
      return names ? names(t.enum) : t.enum;
    case "array":
      return `${displayValueType(t.element, names)}[]`;
    case "nullable":
      return `${displayValueType(t.inner, names)}?`;
    case "union":
      return t.variants.map(v => v.name).join(" | ");
    case "extern":
      return names ? names(t.extern) : t.extern;
  }
}

export function literalToString(l: IrLiteral): string {
  switch (l.kind) {
    case "int":
      return hexIfLarge(BigInt(l.value));
    case "float":
      return Number.isInteger(l.value) ? l.value.toFixed(1) : String(l.value);
    case "bool":
      return String(l.value);
    case "string":
      return JSON.stringify(l.value);
    case "bytes":
      return `x"${l.hex}"`;
    case "endian":
      return l.value;
    case "enum":
      return `${l.enum}.${l.member}`;
  }
}

export function hexIfLarge(v: bigint): string {
  if (v >= 256n) return "0x" + v.toString(16);
  if (v <= -256n) return "-0x" + (-v).toString(16);
  return v.toString();
}

export function isIrField(x: IrField | IrBitField): x is IrField {
  return (x as IrField).kind === "field";
}

export function hex(n: number | bigint): string {
  return "0x" + n.toString(16);
}
