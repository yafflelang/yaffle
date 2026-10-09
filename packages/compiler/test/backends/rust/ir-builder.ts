/**
 * A small builder for hand-written IR fixtures (the frontend is developed in parallel).
 * Every struct gets the implicit `endian` parameter first; `t.s(id)` passes it on.
 */
import type {
  IrBits,
  IrBlock,
  IrCheck,
  IrEnum,
  IrExpr,
  IrExtern,
  IrField,
  IrFill,
  IrLayer,
  IrLayoutItem,
  IrLength,
  IrLiteral,
  IrMember,
  IrParam,
  IrPrimKind,
  IrProgram,
  IrStruct,
  IrSwitch,
  IrType,
  IrValueType
} from "../../../src/ir/index.ts";

const SRC = {
  module: "test.yfl",
  start: { line: 0, character: 0 },
  end: { line: 0, character: 0 }
};

// ─── Value types ─────────────────────────────────────────────────────────────

export const vt = {
  int: (bits: 8 | 16 | 24 | 32 | 40 | 48 | 56 | 64, signed = false): IrValueType => ({
    kind: "int",
    bits,
    signed
  }),
  u8: { kind: "int", bits: 8, signed: false } as IrValueType,
  u16: { kind: "int", bits: 16, signed: false } as IrValueType,
  u32: { kind: "int", bits: 32, signed: false } as IrValueType,
  u64: { kind: "int", bits: 64, signed: false } as IrValueType,
  i32: { kind: "int", bits: 32, signed: true } as IrValueType,
  big: { kind: "bigint" } as IrValueType,
  f64: { kind: "float", bits: 64 } as IrValueType,
  f32: { kind: "float", bits: 32 } as IrValueType,
  bool: { kind: "bool" } as IrValueType,
  str: { kind: "string" } as IrValueType,
  bytes: { kind: "bytes" } as IrValueType,
  endian: { kind: "endian" } as IrValueType,
  struct: (id: string): IrValueType => ({ kind: "struct", struct: id }),
  enum: (id: string): IrValueType => ({ kind: "enum", enum: id }),
  array: (element: IrValueType): IrValueType => ({ kind: "array", element })
};

// ─── Expressions ─────────────────────────────────────────────────────────────

const lit = (value: IrLiteral, type: IrValueType): IrExpr => ({ kind: "literal", value, type });
const bin = (
  op: Extract<IrExpr, { kind: "binary" }>["op"],
  left: IrExpr,
  right: IrExpr,
  type: IrValueType = vt.big
): IrExpr => ({
  kind: "binary",
  op,
  left,
  right,
  type
});
const call = (name: string, args: IrExpr[], type: IrValueType = vt.big): IrExpr =>
  ({ kind: "call", callee: { kind: "builtin", name }, args, type }) as IrExpr;

export const e = {
  int: (v: number | bigint | string): IrExpr => lit({ kind: "int", value: String(v) }, vt.big),
  float: (v: number): IrExpr => lit({ kind: "float", value: v }, vt.f64),
  bool: (v: boolean): IrExpr => lit({ kind: "bool", value: v }, vt.bool),
  str: (v: string): IrExpr => lit({ kind: "string", value: v }, vt.str),
  bytes: (hex: string): IrExpr => lit({ kind: "bytes", hex }, vt.bytes),
  le: lit({ kind: "endian", value: "le" }, vt.endian),
  be: lit({ kind: "endian", value: "be" }, vt.endian),
  enumLit: (id: string, member: string): IrExpr =>
    lit({ kind: "enum", enum: id, member }, vt.enum(id)),
  f: (name: string, type: IrValueType = vt.u32): IrExpr => ({ kind: "field", name, type }),
  p: (name: string, type: IrValueType = vt.u32): IrExpr => ({ kind: "param", name, type }),
  endian: { kind: "param", name: "endian", type: vt.endian } as IrExpr,
  it: (type: IrValueType = vt.u32): IrExpr => ({ kind: "it", type }),
  lam: (name: string): IrExpr => ({ kind: "lambdaParam", name, type: vt.big }),
  offset: { kind: "builtinValue", name: "offset", type: vt.big } as IrExpr,
  end: { kind: "builtinValue", name: "end", type: vt.big } as IrExpr,
  index: { kind: "builtinValue", name: "index", type: vt.big } as IrExpr,
  member: (object: IrExpr, name: string, type: IrValueType = vt.u32): IrExpr => ({
    kind: "member",
    object,
    name,
    type
  }),
  idx: (object: IrExpr, index: IrExpr, type: IrValueType = vt.u32): IrExpr => ({
    kind: "index",
    object,
    index,
    type
  }),
  map: (array: IrExpr, field: string, type: IrValueType): IrExpr => ({
    kind: "map",
    array,
    field,
    type
  }),
  add: (a: IrExpr, b: IrExpr) => bin("+", a, b),
  sub: (a: IrExpr, b: IrExpr) => bin("-", a, b),
  mul: (a: IrExpr, b: IrExpr) => bin("*", a, b),
  div: (a: IrExpr, b: IrExpr) => bin("/", a, b),
  mod: (a: IrExpr, b: IrExpr) => bin("%", a, b),
  shl: (a: IrExpr, b: IrExpr) => bin("<<", a, b),
  shr: (a: IrExpr, b: IrExpr) => bin(">>", a, b),
  and: (a: IrExpr, b: IrExpr) => bin("&", a, b),
  or: (a: IrExpr, b: IrExpr) => bin("|", a, b),
  xor: (a: IrExpr, b: IrExpr) => bin("^", a, b),
  fadd: (a: IrExpr, b: IrExpr) => bin("+", a, b, vt.f64),
  fmul: (a: IrExpr, b: IrExpr) => bin("*", a, b, vt.f64),
  fdiv: (a: IrExpr, b: IrExpr) => bin("/", a, b, vt.f64),
  eq: (a: IrExpr, b: IrExpr) => bin("==", a, b, vt.bool),
  ne: (a: IrExpr, b: IrExpr) => bin("!=", a, b, vt.bool),
  lt: (a: IrExpr, b: IrExpr) => bin("<", a, b, vt.bool),
  le_: (a: IrExpr, b: IrExpr) => bin("<=", a, b, vt.bool),
  gt: (a: IrExpr, b: IrExpr) => bin(">", a, b, vt.bool),
  ge: (a: IrExpr, b: IrExpr) => bin(">=", a, b, vt.bool),
  land: (a: IrExpr, b: IrExpr) => bin("&&", a, b, vt.bool),
  lor: (a: IrExpr, b: IrExpr) => bin("||", a, b, vt.bool),
  not: (a: IrExpr): IrExpr => ({ kind: "unary", op: "!", operand: a, type: vt.bool }),
  neg: (a: IrExpr): IrExpr => ({ kind: "unary", op: "-", operand: a, type: vt.big }),
  bnot: (a: IrExpr): IrExpr => ({ kind: "unary", op: "~", operand: a, type: vt.big }),
  cond: (test: IrExpr, then: IrExpr, els: IrExpr, type: IrValueType = vt.big): IrExpr => ({
    kind: "cond",
    test,
    then,
    else: els,
    type
  }),
  in: (value: IrExpr, items: (IrExpr | [IrExpr, IrExpr])[]): IrExpr => ({
    kind: "in",
    value,
    items: items.map(i =>
      Array.isArray(i)
        ? { kind: "range" as const, low: i[0], high: i[1] }
        : { kind: "value" as const, value: i }
    ),
    type: { kind: "bool" }
  }),
  regex: (value: IrExpr, pattern: string): IrExpr => ({
    kind: "regex",
    value,
    pattern,
    type: { kind: "bool" }
  }),
  conv: (operand: IrExpr, type: IrValueType): IrExpr => ({ kind: "convert", operand, type }),
  call,
  len: (a: IrExpr) => call("len", [a]),
  sizeof: (field: string, type: IrValueType = vt.bytes) => call("sizeof", [e.f(field, type)]),
  offsetof: (field: string, type: IrValueType = vt.bytes) => call("offsetof", [e.f(field, type)]),
  encodedSize: (field: string, layer: number, type: IrValueType = vt.bytes) =>
    call("encodedSize", [e.f(field, type), e.int(layer)]),
  crc32: (a: IrExpr) => call("crc32", [a]),
  bytesof: (field: string, type: IrValueType = vt.bytes) =>
    call("bytesof", [e.f(field, type)], vt.bytes),
  encodedLength: (a: IrExpr, unit: number, enc: string) =>
    call("encodedLength", [a, e.int(unit), e.str(enc)]),
  ext: (id: string, args: IrExpr[], type: IrValueType): IrExpr => ({
    kind: "call",
    callee: { kind: "extern", extern: id },
    args,
    type
  })
};

// ─── Types ───────────────────────────────────────────────────────────────────

export const len = {
  count: (expr: IrExpr): IrLength => ({ kind: "count", expr }),
  n: (n: number): IrLength => ({ kind: "count", expr: e.int(n) }),
  until: (terminator: IrExpr): IrLength => ({ kind: "until", terminator }),
  rest: { kind: "rest" } as IrLength
};

export const t = {
  prim: (prim: IrPrimKind, endian: "le" | "be" | "inherit" = "inherit"): IrType => ({
    kind: "prim",
    prim,
    endian
  }),
  u8: { kind: "prim", prim: "u8", endian: "inherit" } as IrType,
  u16: { kind: "prim", prim: "u16", endian: "inherit" } as IrType,
  u32: { kind: "prim", prim: "u32", endian: "inherit" } as IrType,
  u64: { kind: "prim", prim: "u64", endian: "inherit" } as IrType,
  i32: { kind: "prim", prim: "i32", endian: "inherit" } as IrType,
  f32: { kind: "prim", prim: "f32", endian: "inherit" } as IrType,
  bool: { kind: "bool" } as IrType,
  str: (
    length: IrLength = len.until(e.int(0)),
    encoding: "utf8" | "ascii" | "latin1" | "utf16" | "utf32" = "utf8",
    endian: "le" | "be" | "inherit" = "inherit"
  ): IrType => ({
    kind: "string",
    unit: encoding === "utf16" ? 2 : encoding === "utf32" ? 4 : 1,
    encoding,
    endian,
    length
  }),
  bytes: (length: IrLength): IrType => ({ kind: "bytes", length }),
  array: (element: IrType, length: IrLength, elementPlacement?: IrExpr): IrType => ({
    kind: "array",
    element,
    length,
    ...(elementPlacement ? { elementPlacement } : {})
  }),
  /** A struct use passing `endian` plus extra arguments. */
  s: (id: string, ...args: IrExpr[]): IrType => ({
    kind: "struct",
    struct: id,
    args: [e.endian, ...args]
  }),
  enum: (id: string, endian: "le" | "be" | "inherit" = "inherit"): IrType => ({
    kind: "enum",
    enum: id,
    endian
  }),
  ptr: (
    target: IrType,
    opts: {
      storage?: IrPrimKind;
      nullable?: string;
      relative?: boolean;
      ref?: boolean;
      endian?: "le" | "be" | "inherit";
    } = {}
  ): IrType => ({
    kind: "pointer",
    storage: opts.storage ?? "u32",
    storageEndian: opts.endian ?? "inherit",
    target,
    relative: opts.relative ?? false,
    ...(opts.nullable !== undefined ? { nullValue: opts.nullable } : {}),
    ownership: opts.ref ? "ref" : "owned"
  }),
  ext: (id: string, args: IrExpr[] = []): IrType => ({ kind: "extern", extern: id, args }),
  union: (variants: [string, IrType][]): IrType => ({
    kind: "union",
    variants: variants.map(([name, type]) => ({ name, type }))
  }),
  transform: (inner: IrType, read: IrExpr, valueType: IrValueType, write?: IrExpr): IrType => ({
    kind: "transform",
    inner,
    read,
    valueType,
    ...(write ? { write } : {})
  }),
  layered: (inner: IrType, ...layers: IrLayer[]): IrType => ({ kind: "layered", inner, layers })
};

const zero: IrFill = { kind: "byte", value: 0 };
export const L = {
  size: (size: IrExpr): IrLayer => ({ kind: "size", size }),
  via: (codec: string, ...args: IrExpr[]): IrLayer => ({ kind: "via", codec, args }),
  align: (to: number | IrExpr, fill: IrFill = zero): IrLayer => ({
    kind: "align",
    to: typeof to === "number" ? e.int(to) : to,
    fill
  }),
  padBefore: (n: number, fill: IrFill = zero): IrLayer => ({
    kind: "padBefore",
    count: e.int(n),
    fill
  }),
  padAfter: (n: number, fill: IrFill = zero): IrLayer => ({
    kind: "padAfter",
    count: e.int(n),
    fill
  }),
  padUntil: (n: number | IrExpr, fill: IrFill = zero): IrLayer => ({
    kind: "padUntil",
    size: typeof n === "number" ? e.int(n) : n,
    fill
  }),
  alignEnd: (to: number, fill: IrFill = zero): IrLayer => ({
    kind: "alignEnd",
    to: e.int(to),
    fill
  }),
  endian: (value: IrExpr): IrLayer => ({ kind: "endian", value }),
  strict: { kind: "strict" } as IrLayer,
  fill: (value: number): IrFill => ({ kind: "byte", value }),
  fillFn: (param: string, expr: IrExpr): IrFill => ({ kind: "fn", param, expr })
};

// ─── Members ─────────────────────────────────────────────────────────────────

export interface FieldOpts {
  derive?: IrExpr;
  deriveKind?: "constant" | "formula" | "auto";
  checks?: IrCheck[];
  hidden?: boolean;
  input?: "required" | "optional" | "absent";
  placement?: {
    offset: IrExpr;
    fixed?: boolean;
    constraint?: { modulus: string; remainder: string };
  };
  from?: IrField["from"];
  literals?: IrLiteral[];
}

export function f(name: string, type: IrType, o: FieldOpts = {}): IrField {
  const derived = o.derive !== undefined;
  return {
    kind: "field",
    name,
    source: SRC,
    type,
    ...(o.placement
      ? {
          placement: {
            offset: o.placement.offset,
            fixed: o.placement.fixed ?? false,
            ...(o.placement.constraint ? { constraint: o.placement.constraint } : {})
          }
        }
      : {}),
    ...(o.from ? { from: o.from } : {}),
    ...(o.derive ? { derive: o.derive, deriveKind: o.deriveKind ?? "formula" } : {}),
    checks: o.checks ?? [],
    hidden: o.hidden ?? false,
    output: !(o.hidden ?? false),
    input: o.input ?? (derived || o.hidden ? "absent" : "required"),
    ...(o.literals ? { literals: o.literals } : {})
  };
}

/** A constant field: derived, checked on read. */
export function konst(
  name: string,
  type: IrType,
  value: IrExpr,
  itType: IrValueType = vt.u32
): IrField {
  return f(name, type, {
    derive: value,
    deriveKind: "constant",
    checks: [check(e.eq(e.it(itType), value), `${name} == const`)]
  });
}

export function check(expr: IrExpr, message = "check", strictOnly = false): IrCheck {
  return { expr, message, strictOnly };
}

export function block(
  members: IrMember[],
  o: { condition?: IrExpr; else?: IrMember[]; layers?: IrLayer[] } = {}
): IrBlock {
  return {
    kind: "block",
    source: SRC,
    members,
    layers: o.layers ?? [],
    ...(o.condition ? { condition: o.condition } : {}),
    ...(o.else ? { else: o.else } : {})
  };
}

export function sw(
  discriminant: IrExpr,
  cases: [IrLiteral[], IrMember[]][],
  def?: IrMember[],
  discriminantField?: string
): IrSwitch {
  return {
    kind: "switch",
    source: SRC,
    discriminant,
    ...(discriminantField ? { discriminantField } : {}),
    cases: cases.map(([values, members]) => ({ values, members })),
    ...(def ? { default: def } : {})
  };
}

export const litv = {
  int: (v: number | string): IrLiteral => ({ kind: "int", value: String(v) }),
  str: (v: string): IrLiteral => ({ kind: "string", value: v }),
  enumm: (id: string, member: string): IrLiteral => ({ kind: "enum", enum: id, member })
};

export function bits(
  storage: IrPrimKind,
  fields: {
    name: string | null;
    shift: number;
    width: number;
    type?: IrType;
    derive?: IrExpr;
    checks?: IrCheck[];
  }[],
  endian: "le" | "be" | "inherit" = "inherit"
): IrBits {
  return {
    kind: "bits",
    source: SRC,
    storage,
    endian,
    bitOrder: "lsb",
    fields: fields.map(x => ({
      name: x.name,
      shift: x.shift,
      width: x.width,
      type: x.type ?? { kind: "prim", prim: "u8", endian: "inherit" },
      ...(x.derive ? { derive: x.derive, deriveKind: "formula" as const } : {}),
      checks: x.checks ?? [],
      output: x.name !== null,
      input: x.derive ? ("absent" as const) : ("required" as const)
    }))
  };
}

// ─── Structs and programs ────────────────────────────────────────────────────

export interface StructOpts {
  params?: IrParam[];
  base?: boolean;
  strict?: boolean;
  layers?: IrLayer[];
  layout?: IrLayoutItem[];
  async?: boolean;
  /** Omit the implicit endian parameter. */
  noEndian?: boolean;
}

export function S(id: string, members: IrMember[], o: StructOpts = {}): IrStruct {
  const endian: IrParam = { name: "endian", type: vt.endian, origin: "endian", default: e.le };
  return {
    id,
    name: id.replace(/[^A-Za-z0-9_]/g, "_"),
    module: "test.yfl",
    source: SRC,
    params: [...(o.noEndian ? [] : [endian]), ...(o.params ?? [])],
    members,
    base: o.base ?? false,
    strict: o.strict ?? false,
    layers: o.layers ?? [],
    ...(o.layout ? { layout: o.layout } : {}),
    async: o.async ?? false,
    usesEndian: true
  };
}

export function param(
  name: string,
  type: IrValueType,
  origin: IrParam["origin"] = "explicit",
  boundName?: string
): IrParam {
  return { name, type, origin, ...(boundName ? { boundName } : {}) };
}

export function layoutItem(path: "this" | (string | "*")[], align?: number): IrLayoutItem {
  return {
    path:
      path === "this"
        ? "this"
        : path.map(p =>
            p === "*" ? { kind: "each" as const } : { kind: "field" as const, name: p }
          ),
    layers: align ? [L.align(align)] : []
  };
}

export function enumDecl(
  id: string,
  storage: IrPrimKind,
  members: [string, number | string][],
  open = false
): IrEnum {
  return {
    id,
    name: id,
    module: "test.yfl",
    storage,
    members: members.map(([name, value]) => ({ name, value: String(value) })),
    open
  };
}

export function codec(
  id: string,
  o: { streaming?: boolean; ranged?: boolean; params?: { name: string; type: IrValueType }[] } = {}
): IrExtern {
  return {
    kind: "codec",
    id,
    name: id,
    module: "test.yfl",
    params: o.params ?? [],
    async: false,
    ranged: o.ranged ?? false,
    streaming: o.streaming ?? false
  };
}

export function externFn(
  id: string,
  params: { name: string; type: IrValueType }[],
  returns: IrValueType
): IrExtern {
  return { kind: "fn", id, name: id, module: "test.yfl", params, returns };
}

export function externType(
  id: string,
  valueType: IrValueType,
  params: { name: string; type: IrValueType }[] = [],
  fixedSize?: number
): IrExtern {
  return {
    kind: "type",
    id,
    name: id,
    module: "test.yfl",
    params,
    valueType,
    ...(fixedSize !== undefined ? { fixedSize } : {})
  };
}

export function program(
  structs: IrStruct[],
  roots: string[],
  o: { enums?: IrEnum[]; externs?: IrExtern[] } = {}
): IrProgram {
  return {
    version: 1,
    modules: [{ path: "test.yfl", name: "test" }],
    structs,
    enums: o.enums ?? [],
    externs: o.externs ?? [],
    consts: [],
    roots: roots.map(r => ({ struct: r, name: r, module: "test.yfl" }))
  };
}

/** The derive for a count field: `len(field)`. */
export function lenOf(field: string, type: IrValueType = vt.array(vt.u32)): IrExpr {
  return e.len(e.f(field, type));
}
