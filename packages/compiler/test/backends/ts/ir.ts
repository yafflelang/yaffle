/**
 * A small builder for hand-written IR fixtures, which pin down backend behaviour independently of
 * the frontend: `S("Entry", [f("a", u32), derived("n", u32, len(fr("items")))])`.
 */
import type {
  IrBits,
  IrBitField,
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
  IrStreamExpr,
  IrSwitch,
  IrType,
  IrValueType
} from "yaffle/ir";

const SRC = {
  module: "main.yfl",
  start: { line: 0, character: 0 },
  end: { line: 0, character: 0 }
};

// ── value types ──────────────────────────────────────────────────────────────

export const vt = {
  int(bits: 8 | 16 | 24 | 32 | 40 | 48 | 56 | 64 = 32, signed = false): IrValueType {
    return { kind: "int", bits, signed };
  },
  big: { kind: "bigint" } as IrValueType,
  float(bits: 16 | 32 | 64 = 64): IrValueType {
    return { kind: "float", bits };
  },
  bool: { kind: "bool" } as IrValueType,
  string: { kind: "string" } as IrValueType,
  bytes: { kind: "bytes" } as IrValueType,
  endian: { kind: "endian" } as IrValueType,
  struct(id: string): IrValueType {
    return { kind: "struct", struct: id };
  },
  enum(id: string): IrValueType {
    return { kind: "enum", enum: id };
  },
  array(element: IrValueType): IrValueType {
    return { kind: "array", element };
  }
};

/** Value type of a primitive kind. */
function primVt(p: IrPrimKind): IrValueType {
  if (p[0] === "f") return vt.float(Number(p.slice(1)) as 16 | 32 | 64);
  return vt.int(Number(p.slice(1)) as 8, p[0] === "i");
}

/** Value type produced by reading an IR type (approximate, enough for fixtures). */
function typeVt(t: IrType): IrValueType {
  switch (t.kind) {
    case "prim":
      return primVt(t.prim);
    case "bool":
      return vt.bool;
    case "string":
      return vt.string;
    case "bytes":
      return vt.bytes;
    case "array":
      return vt.array(typeVt(t.element));
    case "struct":
      return vt.struct(t.struct);
    case "enum":
      return vt.enum(t.enum);
    case "pointer":
      return t.nullValue !== undefined
        ? { kind: "nullable", inner: typeVt(t.target) }
        : typeVt(t.target);
    case "transform":
      return t.valueType;
    case "layered":
      return typeVt(t.inner);
    case "union":
      return {
        kind: "union",
        variants: t.variants.map(v => ({ name: v.name, type: typeVt(v.type) }))
      };
    case "extern":
      return vt.big;
  }
}

// ── types ────────────────────────────────────────────────────────────────────

function prim(p: IrPrimKind, endian: "le" | "be" | "inherit" = "inherit"): IrType {
  return { kind: "prim", prim: p, endian };
}

export const u8 = prim("u8");
export const u16 = prim("u16");
export const u24 = prim("u24");
export const u32 = prim("u32");
export const u40 = prim("u40");
export const u48 = prim("u48");
export const u56 = prim("u56");
export const u64 = prim("u64");
export const i8 = prim("i8");
export const i16 = prim("i16");
export const i24 = prim("i24");
export const i32 = prim("i32");
export const i40 = prim("i40");
export const i48 = prim("i48");
export const i56 = prim("i56");
export const i64 = prim("i64");
export const f16 = prim("f16");
export const f32 = prim("f32");
export const f64 = prim("f64");
export const bool: IrType = { kind: "bool" };

export function count(expr: IrExpr | number): IrLength {
  return { kind: "count", expr: typeof expr === "number" ? int(expr) : expr };
}
export function until(terminator: IrExpr | number): IrLength {
  return {
    kind: "until",
    terminator: typeof terminator === "number" ? int(terminator) : terminator
  };
}
export const rest: IrLength = { kind: "rest" };

/** The stream of an earlier bytes field. */
export function fieldStream(field: string): IrStreamExpr {
  return { kind: "field", field };
}
/** `stream[start..end]` (`end` omitted: to the end). */
export function sliceOf(stream: IrStreamExpr, start: number, end?: number): IrStreamExpr {
  return end === undefined
    ? { kind: "slice", stream, start: int(start) }
    : { kind: "slice", stream, start: int(start), end: int(end) };
}

export function str(
  length: IrLength,
  encoding: "utf8" | "ascii" | "latin1" | "utf16" | "utf32" = "utf8",
  endian: "le" | "be" | "inherit" = "inherit"
): IrType {
  const unit = encoding === "utf16" ? 2 : encoding === "utf32" ? 4 : 1;
  return { kind: "string", unit, encoding, endian, length };
}

/** `str` = char[until 0]. */
export const cstr = str({
  kind: "until",
  terminator: {
    kind: "literal",
    value: { kind: "int", value: "0" },
    type: { kind: "int", bits: 8, signed: false }
  }
});

export function bytes(length: IrLength): IrType {
  return { kind: "bytes", length };
}

export function array(element: IrType, length: IrLength, elementPlacement?: IrExpr): IrType {
  return elementPlacement
    ? { kind: "array", element, length, elementPlacement }
    : { kind: "array", element, length };
}

/** A struct type; the endian param is passed through first, then `args`. */
export function ref(id: string, ...args: IrExpr[]): IrType {
  return { kind: "struct", struct: id, args: [param("endian", vt.endian), ...args] };
}

export function enumT(id: string, endian: "le" | "be" | "inherit" = "inherit"): IrType {
  return { kind: "enum", enum: id, endian };
}

export function ptr(
  target: IrType,
  storage: IrPrimKind = "u64",
  opts: {
    relative?: boolean;
    nullable?: string | boolean;
    ref?: boolean;
    endian?: "le" | "be" | "inherit";
  } = {}
): IrType {
  const t: IrType = {
    kind: "pointer",
    storage,
    storageEndian: opts.endian ?? "inherit",
    target,
    relative: opts.relative ?? false,
    ownership: opts.ref ? "ref" : "owned"
  };
  if (opts.nullable !== undefined && opts.nullable !== false) {
    (t as { nullValue?: string }).nullValue = opts.nullable === true ? "0" : opts.nullable;
  }
  return t;
}

export function layered(inner: IrType, ...layers: IrLayer[]): IrType {
  return { kind: "layered", inner, layers };
}

export function transform(
  inner: IrType,
  read: IrExpr,
  valueType: IrValueType,
  write?: IrExpr
): IrType {
  return write
    ? { kind: "transform", inner, read, write, valueType }
    : { kind: "transform", inner, read, valueType };
}

export function union(...variants: [string, IrType][]): IrType {
  return { kind: "union", variants: variants.map(([name, type]) => ({ name, type })) };
}

export function externT(id: string, ...args: IrExpr[]): IrType {
  return { kind: "extern", extern: id, args };
}

// ── layers ───────────────────────────────────────────────────────────────────

const fill0: IrFill = { kind: "byte", value: 0 };
export function fillByte(v: number): IrFill {
  return { kind: "byte", value: v };
}
export function fillFn(param: string, expr: IrExpr): IrFill {
  return { kind: "fn", param, expr };
}
function num(x: IrExpr | number): IrExpr {
  return typeof x === "number" ? int(x) : x;
}

/** `strict`: the fill is checked on read even outside strict mode. */
interface PadOpts {
  strict?: true;
}

interface AlignOpts extends PadOpts {
  from?: "base" | "file";
  offset?: IrExpr | number;
}

function alignOpts({
  offset,
  ...rest
}: AlignOpts): Omit<AlignOpts, "offset"> & { offset?: IrExpr } {
  return offset === undefined ? rest : { ...rest, offset: num(offset) };
}

export const L = {
  size: (n: IrExpr | number): IrLayer => ({ kind: "size", size: num(n) }),
  via: (codec: string, ...args: IrExpr[]): IrLayer => ({ kind: "via", codec, args }),
  align: (to: IrExpr | number, fill: IrFill = fill0, opts: AlignOpts = {}): IrLayer => ({
    kind: "align",
    to: num(to),
    fill,
    ...alignOpts(opts)
  }),
  padBefore: (n: IrExpr | number, fill: IrFill = fill0, opts: PadOpts = {}): IrLayer => ({
    kind: "padBefore",
    count: num(n),
    fill,
    ...opts
  }),
  padAfter: (n: IrExpr | number, fill: IrFill = fill0, opts: PadOpts = {}): IrLayer => ({
    kind: "padAfter",
    count: num(n),
    fill,
    ...opts
  }),
  padUntil: (n: IrExpr | number, fill: IrFill = fill0, opts: PadOpts = {}): IrLayer => ({
    kind: "padUntil",
    size: num(n),
    fill,
    ...opts
  }),
  alignEnd: (to: IrExpr | number, fill: IrFill = fill0, opts: AlignOpts = {}): IrLayer => ({
    kind: "alignEnd",
    to: num(to),
    fill,
    ...alignOpts(opts)
  }),
  endian: (value: IrExpr): IrLayer => ({ kind: "endian", value }),
  strict: (): IrLayer => ({ kind: "strict" })
};

// ── expressions ──────────────────────────────────────────────────────────────

export function int(v: number | bigint | string, type: IrValueType = vt.big): IrExpr {
  return { kind: "literal", value: { kind: "int", value: String(v) }, type };
}
export function float(v: number): IrExpr {
  return { kind: "literal", value: { kind: "float", value: v }, type: vt.float() };
}
export function strLit(v: string): IrExpr {
  return { kind: "literal", value: { kind: "string", value: v }, type: vt.string };
}
function bytesLit(hex: string): IrExpr {
  return { kind: "literal", value: { kind: "bytes", hex }, type: vt.bytes };
}
export function endianLit(v: "le" | "be"): IrExpr {
  return { kind: "literal", value: { kind: "endian", value: v }, type: vt.endian };
}
/** Field reference; the value type defaults to u32. */
export function fr(name: string, type: IrValueType = vt.int(32)): IrExpr {
  return { kind: "field", name, type };
}
export function param(name: string, type: IrValueType = vt.int(32)): IrExpr {
  return { kind: "param", name, type };
}
export function it(type: IrValueType = vt.int(32)): IrExpr {
  return { kind: "it", type };
}
/** `param => body`; `type` is the parameter's type. */
export function lambda(param: string, body: IrExpr, type: IrValueType = vt.int(8)): IrExpr {
  return { kind: "lambda", param, body, type };
}
/** A reference to a lambda's (or fill function's) parameter. */
export function lambdaParam(name: string, type: IrValueType = vt.int(32)): IrExpr {
  return { kind: "lambdaParam", name, type };
}
export const $offset: IrExpr = { kind: "builtinValue", name: "offset", type: vt.big };
export const $end: IrExpr = { kind: "builtinValue", name: "end", type: vt.big };
export const $index: IrExpr = { kind: "builtinValue", name: "index", type: vt.big };

type Op = Extract<IrExpr, { kind: "binary" }>["op"];
export function bin(op: Op, left: IrExpr, right: IrExpr | number, type?: IrValueType): IrExpr {
  const r = num(right);
  const cmp = ["==", "!=", "<", "<=", ">", ">=", "&&", "||"].includes(op);
  return { kind: "binary", op, left, right: r, type: type ?? (cmp ? vt.bool : vt.big) };
}
export const add = (a: IrExpr, b: IrExpr | number): IrExpr => bin("+", a, b);
export const sub = (a: IrExpr, b: IrExpr | number): IrExpr => bin("-", a, b);
export const mul = (a: IrExpr, b: IrExpr | number): IrExpr => bin("*", a, b);
export const div = (a: IrExpr, b: IrExpr | number): IrExpr => bin("/", a, b);
export const eq = (a: IrExpr, b: IrExpr | number): IrExpr => bin("==", a, b);
export const ge = (a: IrExpr, b: IrExpr | number): IrExpr => bin(">=", a, b);

export function cond(test: IrExpr, then: IrExpr, els: IrExpr, type: IrValueType = vt.big): IrExpr {
  return { kind: "cond", test, then, else: els, type };
}
export function call(
  name: Extract<Extract<IrExpr, { kind: "call" }>["callee"], { kind: "builtin" }>["name"],
  args: IrExpr[],
  type: IrValueType = vt.big
): IrExpr {
  return { kind: "call", callee: { kind: "builtin", name }, args, type };
}
export function callExtern(id: string, args: IrExpr[], type: IrValueType = vt.int(32)): IrExpr {
  return { kind: "call", callee: { kind: "extern", extern: id }, args, type };
}
export const len = (x: IrExpr): IrExpr => call("len", [x]);
export const sizeof = (f: string): IrExpr => call("sizeof", [fr(f, vt.bytes)]);
export const offsetof = (f: string): IrExpr => call("offsetof", [fr(f, vt.bytes)]);
export const encodedSize = (f: string, layer: number): IrExpr =>
  call("encodedSize", [fr(f, vt.bytes), int(layer)]);
export function member(object: IrExpr, name: string, type: IrValueType = vt.int(32)): IrExpr {
  return { kind: "member", object, name, type };
}
export function index(
  object: IrExpr,
  idx: IrExpr | number,
  type: IrValueType = vt.int(32)
): IrExpr {
  return { kind: "index", object, index: num(idx), type };
}
export function inSet(value: IrExpr, ...items: (IrExpr | number | [number, number])[]): IrExpr {
  return {
    kind: "in",
    value,
    items: items.map(i =>
      Array.isArray(i)
        ? { kind: "range", low: int(i[0]), high: int(i[1]) }
        : { kind: "value", value: num(i) }
    ),
    type: { kind: "bool" }
  };
}
export function regex(value: IrExpr, pattern: string): IrExpr {
  return { kind: "regex", value, pattern, type: { kind: "bool" } };
}
export function convert(operand: IrExpr, type: IrValueType): IrExpr {
  return { kind: "convert", operand, type };
}

// ── members ──────────────────────────────────────────────────────────────────

interface FieldOpts {
  derive?: IrExpr;
  deriveKind?: "constant" | "formula" | "auto";
  checks?: IrCheck[];
  hidden?: boolean;
  input?: "required" | "optional" | "absent";
  literals?: IrLiteral[];
  placement?: IrField["placement"];
  from?: IrField["from"];
}

export function f(name: string, type: IrType, opts: FieldOpts = {}): IrField {
  const field: IrField = {
    kind: "field",
    name,
    source: SRC,
    type,
    checks: opts.checks ?? [],
    hidden: opts.hidden ?? false,
    output: !(opts.hidden ?? false),
    input: opts.input ?? (opts.derive || opts.hidden ? "absent" : "required")
  };
  if (opts.derive) {
    field.derive = opts.derive;
    field.deriveKind = opts.deriveKind ?? "auto";
  }
  if (opts.literals) field.literals = opts.literals;
  if (opts.placement) field.placement = opts.placement;
  if (opts.from) field.from = opts.from;
  return field;
}

/** A derived field (left out of the input). */
export function derived(name: string, type: IrType, derive: IrExpr, opts: FieldOpts = {}): IrField {
  return f(name, type, { ...opts, derive, deriveKind: opts.deriveKind ?? "auto" });
}

/** A virtual field: `read` gives its value; on write it is an input that the parts derive from. */
export function virtual(name: string, type: IrType, read: IrExpr, opts: FieldOpts = {}): IrField {
  return { ...f(name, type, { input: "required", ...opts }), virtual: { read } };
}

/** A constant: written automatically, checked on read. */
export function constant(
  name: string,
  type: IrType,
  value: number | bigint | string | Uint8Array,
  opts: FieldOpts = {}
): IrField {
  const vtype = typeVt(type);
  const lit: IrExpr =
    typeof value === "string"
      ? strLit(value)
      : value instanceof Uint8Array
        ? bytesLit(Array.from(value, b => b.toString(16).padStart(2, "0")).join(""))
        : int(value, vtype);
  return f(name, type, {
    ...opts,
    derive: lit,
    deriveKind: "constant",
    checks: [
      {
        expr: eq(it(vtype), lit),
        message: `${name} == ${value instanceof Uint8Array ? "bytes" : String(value)}`,
        strictOnly: false
      },
      ...(opts.checks ?? [])
    ]
  });
}

export function check(expr: IrExpr, message = "check", strictOnly = false): IrCheck {
  return { expr, message, strictOnly };
}

export function placed(
  offset: IrExpr,
  opts: { fixed?: boolean; modulus?: number; remainder?: number } = {}
): IrField["placement"] {
  const p: NonNullable<IrField["placement"]> = { offset, fixed: opts.fixed ?? false };
  if (opts.modulus)
    p.constraint = { modulus: String(opts.modulus), remainder: String(opts.remainder ?? 0) };
  return p;
}

export function block(
  members: IrMember[],
  opts: { condition?: IrExpr; else?: IrMember[]; layers?: IrLayer[] } = {}
): IrBlock {
  const b: IrBlock = { kind: "block", source: SRC, members, layers: opts.layers ?? [] };
  if (opts.condition) b.condition = opts.condition;
  if (opts.else) b.else = opts.else;
  return b;
}

export function sw(
  discriminant: IrExpr,
  cases: [IrLiteral[], IrMember[]][],
  opts: { default?: IrMember[]; field?: string } = {}
): IrSwitch {
  const s: IrSwitch = {
    kind: "switch",
    source: SRC,
    discriminant,
    cases: cases.map(([values, members]) => ({ values, members }))
  };
  if (opts.default) s.default = opts.default;
  const df = opts.field ?? (discriminant.kind === "field" ? discriminant.name : undefined);
  if (df) s.discriminantField = df;
  return s;
}

export function litInt(v: number | bigint | string): IrLiteral {
  return { kind: "int", value: String(v) };
}
export function litStr(v: string): IrLiteral {
  return { kind: "string", value: v };
}

export function bits(
  storage: IrPrimKind,
  fields: (Partial<IrBitField> & { name: string | null; width: number })[],
  opts: { endian?: "le" | "be" | "inherit"; bitOrder?: "lsb" | "msb" } = {}
): IrBits {
  let shift = 0;
  const total = Number(storage.slice(1));
  const out: IrBitField[] = fields.map(x => {
    const s = opts.bitOrder === "msb" ? total - shift - x.width : shift;
    shift += x.width;
    const bf: IrBitField = {
      name: x.name,
      shift: x.shift ?? s,
      width: x.width,
      type: x.type ?? prim(storage),
      checks: x.checks ?? [],
      output: x.output ?? x.name !== null,
      input: x.input ?? (x.derive ? "absent" : "required")
    };
    if (x.derive) {
      bf.derive = x.derive;
      bf.deriveKind = x.deriveKind ?? "formula";
    }
    return bf;
  });
  return {
    kind: "bits",
    source: SRC,
    storage,
    endian: opts.endian ?? "inherit",
    bitOrder: opts.bitOrder ?? "lsb",
    fields: out
  };
}

// ── structs and programs ─────────────────────────────────────────────────────

interface StructOpts {
  params?: IrParam[];
  base?: boolean;
  strict?: boolean;
  layers?: IrLayer[];
  layout?: IrLayoutItem[];
  async?: boolean;
  module?: string;
  noEndian?: boolean;
  doc?: string;
}

export function S(id: string, members: IrMember[], opts: StructOpts = {}): IrStruct {
  const params: IrParam[] = opts.noEndian
    ? []
    : [{ name: "endian", type: vt.endian, origin: "endian" }];
  params.push(...(opts.params ?? []));
  const s: IrStruct = {
    id,
    name: id.replace(/[^A-Za-z0-9_]/g, "_"),
    module: opts.module ?? "main.yfl",
    source: SRC,
    params,
    members,
    base: opts.base ?? false,
    strict: opts.strict ?? false,
    layers: opts.layers ?? [],
    async: opts.async ?? false,
    usesEndian: !opts.noEndian
  };
  if (opts.layout) s.layout = opts.layout;
  if (opts.doc) s.doc = opts.doc;
  return s;
}

export function p(
  name: string,
  type: IrValueType = vt.int(32),
  origin: IrParam["origin"] = "explicit",
  def?: IrExpr
): IrParam {
  const x: IrParam = { name, type, origin };
  if (origin === "bound") x.boundName = name;
  if (def) x.default = def;
  return x;
}

export function layoutItem(path: "this" | string, ...layers: IrLayer[]): IrLayoutItem {
  if (path === "this") return { path: "this", layers };
  return {
    path: path.split(".").flatMap(seg => {
      const m = /^(\w+)((?:\[\*\])*)$/.exec(seg);
      if (!m) throw new Error(`bad layout path ${path}`);
      const out: ({ kind: "field"; name: string } | { kind: "each" })[] = [
        { kind: "field", name: m[1]! }
      ];
      for (let i = 0; i < m[2]!.length / 3; i++) out.push({ kind: "each" });
      return out;
    }),
    layers
  };
}

/** A layout group: per element of `path`, `items` are placed in order. */
export function layoutGroup(
  path: string,
  items: IrLayoutItem[],
  ...layers: IrLayer[]
): IrLayoutItem {
  return { ...layoutItem(path, ...layers), group: { items } };
}

export function enumDecl(
  id: string,
  storage: IrPrimKind,
  members: Record<string, number | bigint>,
  open = false,
  module = "main.yfl"
): IrEnum {
  return {
    id,
    name: id,
    module,
    storage,
    members: Object.entries(members).map(([name, v]) => ({ name, value: String(v) })),
    open
  };
}

export function codecDecl(
  name: string,
  opts: {
    async?: boolean;
    ranged?: boolean;
    streaming?: boolean;
    params?: { name: string; type: IrValueType }[];
  } = {}
): IrExtern {
  return {
    kind: "codec",
    id: name,
    name,
    module: "main.yfl",
    params: opts.params ?? [],
    async: opts.async ?? false,
    ranged: opts.ranged ?? false,
    streaming: opts.streaming ?? false
  };
}

export function externFnDecl(
  name: string,
  params: { name: string; type: IrValueType }[],
  returns: IrValueType
): IrExtern {
  return { kind: "fn", id: name, name, module: "main.yfl", params, returns };
}

export function externTypeDecl(
  name: string,
  valueType: IrValueType,
  params: { name: string; type: IrValueType }[] = [],
  fixedSize?: number
): IrExtern {
  const x: IrExtern = { kind: "type", id: name, name, module: "main.yfl", params, valueType };
  if (fixedSize !== undefined) (x as { fixedSize?: number }).fixedSize = fixedSize;
  return x;
}

export function program(opts: {
  structs: IrStruct[];
  roots: string[] | { struct: string; name?: string }[];
  enums?: IrEnum[];
  externs?: IrExtern[];
  modules?: string[];
}): IrProgram {
  const modules = opts.modules ?? [...new Set(["main.yfl", ...opts.structs.map(s => s.module)])];
  return {
    version: 1,
    modules: modules.map(path => ({ path, name: path.replace(/\.yfl$/, "") })),
    structs: opts.structs,
    enums: opts.enums ?? [],
    externs: opts.externs ?? [],
    consts: [],
    roots: opts.roots.map(r => {
      const id = typeof r === "string" ? r : r.struct;
      const s = opts.structs.find(x => x.id === id);
      if (!s) throw new Error(`root ${id} not found`);
      return {
        struct: id,
        name: typeof r === "string" ? s.name : (r.name ?? s.name),
        module: s.module
      };
    })
  };
}
