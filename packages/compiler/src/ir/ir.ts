/**
 * yaffle IR: the contract between the compiler frontend and every backend.
 *
 * Properties every IR program has (the frontend guarantees them; backends may rely on them):
 *
 * - **Plain JSON.** No classes, Maps, bigints or undefined-vs-missing tricks. `yaffle ir` prints
 *   it and fixtures are JSON files. Big integers are decimal strings.
 * - **Monomorphized.** Generics are instantiated (`Span<Point>` → struct id `Span<Point>`,
 *   name `Span_Point`), type aliases are inlined, constants are folded.
 * - **No dynamic scoping.** Bound values (`$version`) and references to fields of lexically
 *   enclosing structs are lowered to *implicit parameters*, passed explicitly at every use site.
 *   `$endian` is the implicit `endian` parameter. So expressions only ever reference the current
 *   struct's fields, its parameters, `it`, lambda parameters and the built-ins `$offset`, `$end`
 *   and `$index`.
 * - **Reverses resolved.** Every value the writer must compute (derived lengths, offsets, sizes,
 *   constants, explicit `=` formulas) is an explicit `derive` expression. Backends never invert
 *   expressions themselves.
 * - **Checked.** Names resolve, types agree, every path that needs a bound value has one, and
 *   layout paths exist.
 *
 * Semantics are specified in docs/IR.md. When this file and IR.md disagree, fix one of them.
 */

export const IR_VERSION = 1 as const;

// ─────────────────────────────────────────────────────────────────────────────
// Program
// ─────────────────────────────────────────────────────────────────────────────

export interface IrProgram {
  version: typeof IR_VERSION;
  /** One entry per source file, in dependency order (imports before importers). */
  modules: IrModule[];
  structs: IrStruct[];
  enums: IrEnum[];
  externs: IrExtern[];
  /** Exported constants, for codegen to re-export. Uses are already folded into expressions. */
  consts: IrConst[];
  /** Exported structs: they get parse/serialize/view/toJson/fromJson entry points. */
  roots: IrRoot[];
}

export interface IrModule {
  /** Project-relative path with forward slashes, e.g. "formats/demo/archive.yfl". */
  path: string;
  /** Suggested output module name (path without extension, e.g. "formats/demo/archive"). */
  name: string;
}

export interface IrRoot {
  struct: StructId;
  /** Public name in generated code (the declared struct name). */
  name: string;
  module: string;
}

export interface IrConst {
  name: string;
  module: string;
  type: IrValueType;
  value: IrLiteral;
}

/** Stable identifier of a monomorphized struct, e.g. "Chunk", "Chunk.Record", "Span<Point>". */
export type StructId = string;
export type EnumId = string;
export type ExternId = string;

export interface IrSourceRef {
  module: string;
  /** 0-based line/character (UTF-16 code units). */
  start: { line: number; character: number };
  end: { line: number; character: number };
}

// ─────────────────────────────────────────────────────────────────────────────
// Structs
// ─────────────────────────────────────────────────────────────────────────────

export interface IrStruct {
  id: StructId;
  /** A valid identifier for generated code, unique in the program. "Chunk_Record", "Span_Point". */
  name: string;
  module: string;
  source: IrSourceRef;
  doc?: string;
  /**
   * Parameters in call order. Every struct-typed IrType passes `args` in this order.
   * Implicit parameters (origin != "explicit") are added by the frontend's lowering.
   */
  params: IrParam[];
  members: IrMember[];
  /** `@base`: pointers and `at` offsets inside count from this struct's first byte. */
  base: boolean;
  /** `@strict`: padding fill and reserved bits are checked on read (for this struct's own members). */
  strict: boolean;
  /**
   * Layers that apply to the struct as a whole wherever it is used (`struct H @padUntil(0x80) {`),
   * innermost first. Backends apply them exactly as if they were written on every use site,
   * inside any use-site layers.
   */
  layers: IrLayer[];
  /** `layout { … }`: ordering of this struct's own pointer/`at` targets on write. See IR.md §4. */
  layout?: IrLayoutItem[];
  /** True if reading or writing this struct can reach an async codec (transitively). */
  async: boolean;
  /** True if any primitive inside (transitively) inherits endianness, i.e. the `endian` param matters. */
  usesEndian: boolean;
}

export interface IrParam {
  name: string;
  type: IrValueType;
  /**
   * explicit: declared by the user (`struct Blob(u32 n)`).
   * bound:    lowered `$name` (from `u32 $version` somewhere above). `boundName` holds the name without `$`.
   * outer:    lowered reference to a field of a lexically enclosing struct.
   * endian:   the implicit endianness parameter (`$endian`). Type is { kind: "endian" }.
   */
  origin: "explicit" | "bound" | "outer" | "endian";
  boundName?: string;
  /** Root parameters with a default (or `endian`, default "le") are optional in parse options. */
  default?: IrExpr;
}

export type IrMember = IrField | IrBlock | IrSwitch | IrBits;

/**
 * A named field.
 *
 * Inline fields occupy bytes at the current position. A field with `placement` (`at expr`) or
 * `from` occupies no inline bytes. `placement` puts it at an offset from the base, and `from`
 * parses it from a virtual stream.
 */
export interface IrField {
  kind: "field";
  name: string;
  source: IrSourceRef;
  doc?: string;
  type: IrType;
  /** `T x at expr`. The offset is relative to the current base. */
  placement?: IrPlacement;
  /** `T x from stream`. */
  from?: IrFrom;
  /**
   * The raw value the writer stores, ignoring any input value. Present for constants
   * (`u16 magic = 42`), explicit formulas (`u32 size = sizeof(body)`) and compiler-derived
   * reverses (`count` from `entries[count]`). Evaluated in the *write context* (IR.md §3.2).
   */
  derive?: IrExpr;
  deriveKind?: "constant" | "formula" | "auto";
  /** Read-side validation. All must hold after reading (and are re-checked on write where noted). */
  checks: IrCheck[];
  /** Not in the input or output types (`@hidden`). Must be derivable on write. */
  hidden: boolean;
  /** Presence in the generated output (parse result) type. False only for hidden fields. */
  output: boolean;
  /**
   * Presence in the generated input (serialize argument) type.
   * absent:   derived, constant or hidden. The writer computes it, and any value given is ignored.
   * required: the caller must supply it.
   * optional: the caller may supply it, or the writer uses `derive` (e.g. split points of `from arr[*].piece` streams).
   */
  input: "required" | "optional" | "absent";
  /** For `in ("II", "MM")`: the literal values the output type narrows to. */
  literals?: IrLiteral[];
  /** Name this field is bound under (`u32 $version` → "version"). Informational: uses are already lowered to params. */
  bind?: string;
  /**
   * Set on a bytes field that is only read through `from`
   * slices (`T x from raw[a..b]`). On write it is derived (`input: "absent"`): a zero-filled
   * buffer of the field's own length (or, for `rest`/`[]` lengths, the largest slice end) with
   * every slice field's encoding written at its start. Overlapping slices must produce identical
   * bytes, otherwise it's a `DERIVE` error.
   */
  carrier?: "slices";
  /**
   * `virtual u40 size = (sizeHigh << 32) | sizeLow`.
   * A virtual field occupies **no bytes**. Its `type` is the declared type (for type mapping and
   * JSON only; nothing is read or written for it).
   * - Read: `read` is evaluated where the field is declared (earlier fields only). The value is
   *   visible to later expressions under the field's name.
   * - Write: the value comes from the input (`input` is "required", or "optional" with `derive` as
   *   the default). The fields it was computed from are derived from it: their `derive` references
   *   this field by name (e.g. `sizeHigh = size >> 32`), and they are `input: "absent"`. After
   *   writing, `read` must give back the input value, otherwise it's a `DERIVE` error.
   */
  virtual?: { read: IrExpr };
}

/**
 * An anonymous block: `{ … }` with layers, `if (…) { … } else { … }`, or both.
 * Members flatten into the enclosing struct's value. Fields of a conditional block without an
 * else branch are optional in the output and input types. Fields in both branches of an if/else
 * produce a union of the two shapes (IR.md §7).
 */
export interface IrBlock {
  kind: "block";
  source: IrSourceRef;
  condition?: IrExpr;
  members: IrMember[];
  else?: IrMember[];
  /** Innermost first. `@endian(x) { … }` → [{ kind: "endian", value: x }]. */
  layers: IrLayer[];
}

/** `switch (expr) { case …: members  default: members }`. Generates a discriminated union. */
export interface IrSwitch {
  kind: "switch";
  source: IrSourceRef;
  discriminant: IrExpr;
  /** Set when the discriminant is a plain field reference: the field TS narrows on. */
  discriminantField?: string;
  cases: { values: IrLiteral[]; members: IrMember[] }[];
  default?: IrMember[];
}

/** `bits u8 { … }`, or a run of C-style bitfields. */
export interface IrBits {
  kind: "bits";
  source: IrSourceRef;
  storage: IrPrimKind;
  endian: IrEndianSpec;
  bitOrder: "lsb" | "msb";
  fields: IrBitField[];
}

export interface IrBitField {
  /** null for reserved bits (unnamed). Reserved bits are written as 0 and checked in strict mode. */
  name: string | null;
  /** Bit position of the field's least significant bit within the storage unit (0 = LSB), already resolved from bitOrder. */
  shift: number;
  width: number;
  /** prim (unsigned or signed: sign-extended), bool (width 1) or enum. */
  type: IrType;
  derive?: IrExpr;
  deriveKind?: "constant" | "formula" | "auto";
  checks: IrCheck[];
  output: boolean;
  input: "required" | "optional" | "absent";
}

// ─────────────────────────────────────────────────────────────────────────────
// Types (how bytes become values)
// ─────────────────────────────────────────────────────────────────────────────

export type IrPrimKind =
  | "u8"
  | "u16"
  | "u24"
  | "u32"
  | "u40"
  | "u48"
  | "u56"
  | "u64"
  | "i8"
  | "i16"
  | "i24"
  | "i32"
  | "i40"
  | "i48"
  | "i56"
  | "i64"
  | "f16"
  | "f32"
  | "f64";

/** Fixed endianness, or the struct's `endian` parameter. */
export type IrEndianSpec = "le" | "be" | "inherit";

export type IrType =
  | IrPrimType
  | IrBoolType
  | IrStringType
  | IrBytesType
  | IrArrayType
  | IrStructType
  | IrEnumType
  | IrPointerType
  | IrExternType
  | IrUnionType
  | IrTransformType
  | IrLayeredType;

export interface IrPrimType {
  kind: "prim";
  prim: IrPrimKind;
  endian: IrEndianSpec;
}

/** One byte. Reads nonzero as true (strict: must be 0 or 1), writes 0/1. */
export interface IrBoolType {
  kind: "bool";
}

/**
 * Text. Code units of `unit` size; `length` counts code units (for `until`, the terminator is
 * one code unit with value 0). Read: decode the units, stopping at the first NUL unit (NUL and
 * everything after it is dropped from the value). Write: encode, then pad with NUL units up to
 * the length. A value longer than the length is a write error. With `until`, write the units,
 * then one NUL unit.
 */
export interface IrStringType {
  kind: "string";
  unit: 1 | 2 | 4;
  encoding: "utf8" | "ascii" | "latin1" | "utf16" | "utf32";
  /** Endianness of 2- and 4-byte units. */
  endian: IrEndianSpec;
  length: IrLength;
}

/** u8 arrays: the value is a byte array (Uint8Array, Vec<u8>, …). */
export interface IrBytesType {
  kind: "bytes";
  length: IrLength;
}

export interface IrArrayType {
  kind: "array";
  element: IrType;
  length: IrLength;
  /**
   * `T items[] at expr(\$index)`: each element sits at its own offset (from the base) instead of
   * consecutively. Combined with `length: rest`, elements are read while the next element's
   * offset is below the region end.
   */
  elementPlacement?: IrExpr;
}

export type IrLength =
  /** Exactly `expr` elements (or code units / bytes). */
  | { kind: "count"; expr: IrExpr }
  /** Elements until one equal to `terminator`. It is consumed, not part of the value, and written back. */
  | { kind: "until"; terminator: IrExpr }
  /**
   * `[before value]`: elements until the next one would equal `terminator`. The terminator is
   * *not* consumed (it belongs to what follows) and not written. Arrays only.
   */
  | { kind: "before"; terminator: IrExpr }
  /**
   * `[until it.next == 0]`: elements until one satisfies `predicate` (`it` = the element just
   * read); that element *is* included. On write, the last element must satisfy it and no earlier
   * one may. Arrays only.
   */
  | { kind: "untilPredicate"; predicate: IrExpr }
  /** Elements until the end of the enclosing region (`$end`). */
  | { kind: "rest" };

export interface IrStructType {
  kind: "struct";
  struct: StructId;
  /** One expression per IrStruct.params entry, in order (implicit params included). */
  args: IrExpr[];
}

export interface IrEnumType {
  kind: "enum";
  enum: EnumId;
  endian: IrEndianSpec;
}

/**
 * `T *name : u64`. On read: read the offset (storage), and if it equals `nullValue` the value is
 * null; otherwise the target is at base + offset (or field address + offset for `relative`).
 * Equal offsets within one parse yield the same target object (identity preserved).
 */
export interface IrPointerType {
  kind: "pointer";
  storage: IrPrimKind;
  storageEndian: IrEndianSpec;
  target: IrType;
  relative: boolean;
  /** Decimal string; present iff the pointer is nullable (`@nullable` → "0"). */
  nullValue?: string;
  /**
   * `@nullable(empty)` on a pointer to an array: an empty array is written as `nullValue` ("0"),
   * and a null pointer reads as an empty array (never as null).
   */
  emptyIsNull?: true;
  /**
   * `@origin(expr)`: target = base + origin + stored value (instead of base + value). Evaluated in
   * the struct holding the pointer, like a write formula: it may use `offsetof` of any field of
   * that struct (also later ones) and `offsetof(this)` (the struct's own start).
   */
  origin?: IrExpr;
  /**
   * owned: the writer places the target (layout engine).
   * ref:   `@ref`: the writer points at an equal value already placed in the same base.
   */
  ownership: "owned" | "ref";
}

export interface IrExternType {
  kind: "extern";
  extern: ExternId;
  args: IrExpr[];
}

/** `union U { A  B }`: try each variant in order; the first whose read succeeds (checks included) wins. */
export interface IrUnionType {
  kind: "union";
  variants: { name: string; type: IrType }[];
}

/**
 * `as` / `=` with `it`. Read: value = read(it = inner value). Write: inner value = write(it = value).
 * Without `write`, the transform is one-way: the input type is the inner type's input, and the
 * value is read-only in views.
 */
export interface IrTransformType {
  kind: "transform";
  inner: IrType;
  read: IrExpr;
  write?: IrExpr;
  /** Static type of the transformed value. */
  valueType: IrValueType;
  /** True if `write` was inferred by the compiler (shown as an LSP hint), false if explicit. */
  writeInferred?: boolean;
}

/**
 * Attributes wrapped around a type, innermost first:
 * `T x @size(a) @via(c) @size(b)` → layers [size(a), via(c), size(b)].
 */
export interface IrLayeredType {
  kind: "layered";
  inner: IrType;
  layers: IrLayer[];
}

export type IrLayer =
  /** Exactly N bytes. The inner content is read within this window; bytes after it are padding (fill 0, checked in strict mode). */
  | { kind: "size"; size: IrExpr }
  /** A byte transform. The inner bytes are the codec's decoded side, the outer bytes its encoded side. */
  | { kind: "via"; codec: ExternId; args: IrExpr[] }
  /**
   * Pad before until (position - origin + offset) % to == 0. The origin is the current base
   * (default) or, with `from: "file"`, the start of the current byte space: the root source, a
   * codec's decoded region, or a virtual stream. `offset` defaults to 0
   * (`@align(4, offset: 0x19)` aligns the position 0x19 bytes ahead).
   * `strict`: this padding's fill is checked on read even outside strict mode.
   */
  | {
      kind: "align";
      to: IrExpr;
      fill: IrFill;
      from?: "base" | "file";
      offset?: IrExpr;
      strict?: true;
    }
  | { kind: "padBefore"; count: IrExpr; fill: IrFill; strict?: true }
  | { kind: "padAfter"; count: IrExpr; fill: IrFill; strict?: true }
  /** Pad after the content until it occupies exactly `size` bytes. Content larger than size is an error. */
  | { kind: "padUntil"; size: IrExpr; fill: IrFill; strict?: true }
  /** Pad after the content until (end position - origin + offset) % to == 0 (origin as for `align`). */
  | {
      kind: "alignEnd";
      to: IrExpr;
      fill: IrFill;
      from?: "base" | "file";
      offset?: IrExpr;
      strict?: true;
    }
  /** Sets the `endian` argument for everything inside. */
  | { kind: "endian"; value: IrExpr }
  /** `@strict` on a field or block: padding fill and reserved bits inside are checked on read. */
  | { kind: "strict" };

export type IrFill =
  | { kind: "byte"; value: number }
  /** `i => expr`: `expr` uses the lambda parameter (the byte's index within the padding) and returns a byte. */
  | { kind: "fn"; param: string; expr: IrExpr };

export interface IrPlacement {
  /** Offset from the current base. */
  offset: IrExpr;
  /**
   * Write side: the placement constraint implied by a linear reverse (`at sector * 0x800` → the
   * target's offset must be ≡ 0 mod 0x800). The layout engine must pick a position satisfying it.
   */
  constraint?: { modulus: string; remainder: string };
  /**
   * True if the offset expression could not be reversed: the offset comes from input fields, and
   * the target must be written exactly there (overlaps are an error).
   */
  fixed: boolean;
  /**
   * `@nullable(empty)` on an `at` array: an empty array writes its offset as 0, and an offset of 0
   * reads as an empty array.
   */
  emptyIsNull?: true;
}

export interface IrFrom {
  stream: IrStreamExpr;
  /**
   * How the writer splits the encoded value into pieces when the stream joins several:
   * - "sizes": use the pieces' size fields from the input (each piece's `derive` is then optional).
   * - "fit":   largest piece whose encoded (outer) form fits the space before the next piece's placement.
   * Present only when the stream joins several pieces.
   */
  split?: { policy: "fit" | "sizes" };
}

export type IrStreamExpr =
  /** An earlier bytes field of this struct (its decoded/inner bytes). */
  | { kind: "field"; field: string }
  /** `arr[*].field`: the given bytes field of every element of an earlier array field, joined in order. */
  | { kind: "each"; array: string; field: string }
  /** `raw[a..b]`: a slice of another stream. `end` omitted means to the end. */
  | { kind: "slice"; stream: IrStreamExpr; start: IrExpr; end?: IrExpr };

export interface IrCheck {
  /** Boolean expression over `it` (the field's value after reading; for transforms, the transformed value) and earlier fields. */
  expr: IrExpr;
  /** Human-readable form for error messages, e.g. `magic == 42`, `order in ("II", "MM")`. */
  message: string;
  /** Only checked when strict (struct or layer). Constant/in/where checks are never strict-only. */
  strictOnly: boolean;
}

export interface IrLayoutItem {
  /** Path relative to the struct ("this" = the struct's own inline bytes). */
  path: IrLayoutPath;
  /** Layers applied to every structure this item places (in practice `align`). */
  layers: IrLayer[];
  /**
   * Per-element groups: `layout { volumes[*] { pieces[*]  portals[*].points } }`.
   * `path` names an array (elements inline or through pointers, without a trailing `[*]`). For each
   * element in order, `items` (paths relative to that element) are placed in order. Everything the
   * nested items name is claimed by this group, like any other item (IR.md §4.3).
   */
  group?: { items: IrLayoutItem[] };
}

export type IrLayoutPath = "this" | IrPathSegment[];
export type IrPathSegment = { kind: "field"; name: string } | { kind: "each" };

// ─────────────────────────────────────────────────────────────────────────────
// Enums and externs
// ─────────────────────────────────────────────────────────────────────────────

export interface IrEnum {
  id: EnumId;
  name: string;
  module: string;
  storage: IrPrimKind;
  members: { name: string; value: string }[];
  /** `@open`: unknown values pass through as numbers instead of failing. */
  open: boolean;
}

export type IrExtern = IrExternFn | IrExternCodec | IrExternTypeDecl;

/** `extern fn name(params) -> type`. The host implements `name(...args)`. */
export interface IrExternFn {
  kind: "fn";
  id: ExternId;
  name: string;
  module: string;
  params: { name: string; type: IrValueType }[];
  returns: IrValueType;
}

/**
 * `extern [async] codec name(params) [@ranged] [@streaming]`.
 * Host shape: { decode(input, ctx), encode(input, ctx) } where ctx = { args, outputSize?, position? }.
 * See IR.md §5.
 */
export interface IrExternCodec {
  kind: "codec";
  id: ExternId;
  name: string;
  module: string;
  params: { name: string; type: IrValueType }[];
  async: boolean;
  ranged: boolean;
  streaming: boolean;
}

/**
 * `extern type Name(params) : T [@size(n)]`.
 * Host shape: { size(bytes, ...args): number | undefined, read(bytes, ...args): T, write(value, ...args): bytes }.
 */
export interface IrExternTypeDecl {
  kind: "type";
  id: ExternId;
  name: string;
  module: string;
  params: { name: string; type: IrValueType }[];
  valueType: IrValueType;
  /** Fixed size in bytes, if declared with @size(n). */
  fixedSize?: number;
  /**
   * Implemented by every runtime, not the host (`uleb128`, `sleb128`). No yaffle.json extern
   * entry is needed; `module` is "".
   */
  builtin?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Values and expressions
// ─────────────────────────────────────────────────────────────────────────────

/** Static type of a value (what an expression evaluates to, or what a field holds). */
export type IrValueType =
  | { kind: "int"; bits: 8 | 16 | 24 | 32 | 40 | 48 | 56 | 64; signed: boolean }
  /** Intermediate result of integer arithmetic (exact; see IR.md §6). */
  | { kind: "bigint" }
  | { kind: "float"; bits: 16 | 32 | 64 }
  | { kind: "bool" }
  | { kind: "string" }
  | { kind: "bytes" }
  | { kind: "endian" }
  | { kind: "struct"; struct: StructId }
  | { kind: "enum"; enum: EnumId }
  | { kind: "array"; element: IrValueType }
  | { kind: "nullable"; inner: IrValueType }
  | { kind: "union"; variants: { name: string; type: IrValueType }[] }
  /** Opaque value of an extern type (its declared value type). */
  | { kind: "extern"; extern: ExternId; valueType: IrValueType };

export type IrLiteral =
  | { kind: "int"; value: string }
  | { kind: "float"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "string"; value: string }
  | { kind: "bytes"; hex: string }
  | { kind: "endian"; value: "le" | "be" }
  | { kind: "enum"; enum: EnumId; member: string };

export type IrBinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "<<"
  | ">>"
  | "&"
  | "|"
  | "^"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "&&"
  | "||";

export type IrBuiltinFn =
  /** sizeof(field): bytes the field occupies on disk (all layers). Write context only, or an earlier field on read. */
  | "sizeof"
  /** encodedSize(field, layer): byte length after applying layers [0, layer) (0 = plain encoding). Used for derived @size values. */
  | "encodedSize"
  /** offsetof(field): offset of the field's first byte from the current base. */
  | "offsetof"
  /** bytesof(field): the field's bytes on disk (after all layers). */
  | "bytesof"
  /** encode(field): the field's plain encoding (before any layer). */
  | "encode"
  | "crc32"
  | "adler32"
  /** min(a, b, …) or min(array) (the aggregate form; an empty array is a RANGE error). */
  | "min"
  /** max(a, b, …) or max(array). */
  | "max"
  | "abs"
  /** Float → integer, rounding half away from zero (used by inferred reverses of float transforms). */
  | "round"
  /** indexOf(array, value): first index, or a write error if absent (reverse of `names[it]`). */
  | "indexOf"
  /** len(array | string | bytes): element count / code units / bytes. */
  | "len"
  /** Byte length of a string in a given unit size and encoding: encodedLength(str, unit, encoding). */
  | "encodedLength"
  /** sum(array): the sum of an array of numbers (0 for an empty array). */
  | "sum"
  /**
   * lengths(array): the element count of each element of an array of arrays (pointer targets are
   * transparent), as an array. Reverse of element-wise lengths: `lens = lengths(lists)` for
   * `u16[lens[$index]] *lists[9] : u64`.
   */
  | "lengths"
  // Derived arrays: the second argument is a `lambda` expression.
  /** map(array, x => expr): the array of expr for each element. */
  | "map"
  /** filter(array, x => bool): the elements for which the predicate holds, in order. */
  | "filter"
  /** indicesWhere(array, x => bool): the indices (as integers) of the elements for which it holds. */
  | "indicesWhere"
  /**
   * sortedBy(array, x => key): a stable sort by key. Keys compare as numbers, as strings by code
   * points, or as bytes lexicographically.
   */
  | "sortedBy"
  /** unique(array): the array without later duplicates (first occurrence kept; value equality). */
  | "unique"
  /** concat(a, b, …): arrays joined in order. */
  | "concat"
  /**
   * isNull(x): true if `x` (of a `nullable` type, i.e. a `@nullable` pointer's value) is null.
   * The frontend lowers `x == null` to `isNull(x)` and `x != null` to `!isNull(x)`.
   */
  | "isNull";

export type IrExpr =
  | { kind: "literal"; value: IrLiteral; type: IrValueType }
  /** A field of the current struct (earlier field on read; any field in the write context). */
  | { kind: "field"; name: string; type: IrValueType }
  | { kind: "param"; name: string; type: IrValueType }
  /** The value being transformed or checked. */
  | { kind: "it"; type: IrValueType }
  /** Parameter of an inline lambda (fill functions). */
  | { kind: "lambdaParam"; name: string; type: IrValueType }
  /** $offset: current position from the base. $end: end of the enclosing region from the base. $index: index in the enclosing array. */
  | { kind: "builtinValue"; name: "offset" | "end" | "index"; type: IrValueType }
  | { kind: "member"; object: IrExpr; name: string; type: IrValueType }
  | { kind: "index"; object: IrExpr; index: IrExpr; type: IrValueType }
  /** `arr[*].field` in an expression: the array of that field over all elements. */
  | { kind: "map"; array: IrExpr; field: string; type: IrValueType }
  | { kind: "unary"; op: "-" | "!" | "~"; operand: IrExpr; type: IrValueType }
  | { kind: "binary"; op: IrBinaryOp; left: IrExpr; right: IrExpr; type: IrValueType }
  | { kind: "cond"; test: IrExpr; then: IrExpr; else: IrExpr; type: IrValueType }
  | {
      kind: "call";
      callee: { kind: "builtin"; name: IrBuiltinFn } | { kind: "extern"; extern: ExternId };
      args: IrExpr[];
      type: IrValueType;
    }
  /** Membership: `value in (a, b, lo..hi)`. Ranges are inclusive. */
  | {
      kind: "in";
      value: IrExpr;
      items: ({ kind: "value"; value: IrExpr } | { kind: "range"; low: IrExpr; high: IrExpr })[];
      type: { kind: "bool" };
    }
  /** `value in /pattern/`. Portable RE2-style subset; the pattern must match the whole string. */
  | { kind: "regex"; value: IrExpr; pattern: string; type: { kind: "bool" } }
  /** Integer/float conversion inserted by the checker (e.g. u8 → bigint arithmetic, int → float). */
  | { kind: "convert"; operand: IrExpr; type: IrValueType }
  /**
   * `this`: the current struct, only as the argument of `sizeof` (its encoded size; for a `@base`
   * struct its whole region including targets and `@alignEnd`; write context only), `offsetof`
   * (its start from the base), `bytesof` and `encode`.
   */
  | { kind: "this"; type: IrValueType }
  /**
   * `x => body`: only as an argument of map/filter/indicesWhere/sortedBy. The body
   * references the parameter as `{ kind: "lambdaParam", name: param }`; it may also use the
   * enclosing context (fields, params). `type` is the parameter's type.
   */
  | { kind: "lambda"; param: string; body: IrExpr; type: IrValueType };
