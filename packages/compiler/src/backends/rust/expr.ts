/**
 * IR expressions → Rust expressions.
 *
 * Integers are computed exactly in `i128` (fallible operations use `?`), floats in `f64`.
 * Heavier values are borrowed: `&str`, `&[u8]`, `&Struct`, `&Vec<T>`.
 */
import type { IrExpr, IrLiteral, IrValueType } from "../../ir/index.ts";
import {
  BackendError,
  argName,
  fieldPlace,
  literalInt,
  type Model,
  type Shape,
  type StructModel
} from "./model.ts";
import { strLit } from "./names.ts";

export type ETy =
  | { k: "int" }
  | { k: "float" }
  | { k: "bool" }
  | { k: "endian" }
  | { k: "str" }
  | { k: "bytes" }
  | { k: "enum"; id: string }
  /** A reference `&T` to a stored value of this shape (struct, array, union, …). */
  | { k: "ref"; shape: Shape }
  /** `Option<&T>` (nullable values); the shape is the inner value's. */
  | { k: "opt"; shape: Shape };

export interface CExpr {
  code: string;
  t: ETy;
}

export type FieldRef = { kind: "place"; place: string; shape: Shape } | { kind: "expr"; e: CExpr };

export interface ExprCtx {
  m: Model;
  sm: StructModel;
  mode: "read" | "eager" | "late" | "json";
  field(name: string): FieldRef;
  param(name: string): FieldRef;
  it?: { place: string; shape: Shape } | { e: CExpr };
  lambda?: Record<string, string>;
  /** Parameters of `x => body` lambdas: the element being visited. */
  lambdaVals?: Record<string, CExpr>;
  /** Write modes: the slot variable for a field at a layer level ("all" = on disk). */
  slot?(field: string, level: number | "all"): string;
  /** Write mode: the field whose struct arguments are being computed (it starts here). */
  selfField?: string;
  /** Read mode: offset/size locals of an earlier field. */
  measure?(field: string): { o: string; s: string };
  offset(): string;
  end(): string;
  index(): string;
}

const I128: Shape = { k: "int", rust: "i128", bits: 128, signed: true };
const U8: Shape = { k: "int", rust: "u8", bits: 8, signed: false };

let tmpCounter = 0;
export function tmp(prefix: string): string {
  return `__${prefix}${tmpCounter++}`;
}

/** Loads a stored value (a place expression of a shape) as an expression value. */
export function load(place: string, shape: Shape): CExpr {
  switch (shape.k) {
    case "int":
      return { code: `(${place} as i128)`, t: { k: "int" } };
    case "float":
      return { code: `(${place} as f64)`, t: { k: "float" } };
    case "bool":
      return { code: `${place}`, t: { k: "bool" } };
    case "endian":
      return { code: `${place}`, t: { k: "endian" } };
    case "string":
      return { code: `${place}.as_str()`, t: { k: "str" } };
    case "bytes":
      return { code: `${place}.as_slice()`, t: { k: "bytes" } };
    case "enum":
      return { code: `${place}`, t: { k: "enum", id: shape.id } };
    case "box":
    case "rc":
      return load(`(*${place})`, shape.inner);
    case "option":
      if (shape.inner.k === "rc")
        return { code: `${place}.as_deref()`, t: { k: "opt", shape: shape.inner.inner } };
      return { code: `${place}.as_ref()`, t: { k: "opt", shape: shape.inner } };
    case "oneway":
      return load(`${place}.value`, shape.value);
    case "extern":
      return load(place, shape.value);
    default:
      return { code: `(&${place})`, t: { k: "ref", shape } };
  }
}

/** Loads through a reference expression `&T` (e.g. a param of reference type, `it`). */
export function loadRef(refExpr: string, shape: Shape): CExpr {
  return load(`(*${refExpr})`, shape);
}

function intLit(v: string): string {
  return v.startsWith("-") ? `(${v}_i128)` : `${v}_i128`;
}

function floatLit(f: number): string {
  if (Number.isNaN(f)) return "f64::NAN";
  if (f === Infinity) return "f64::INFINITY";
  if (f === -Infinity) return "f64::NEG_INFINITY";
  let s = String(f);
  if (!/[.eE]/.test(s)) s += ".0";
  return f < 0 || Object.is(f, -0) ? `(${Object.is(f, -0) ? "-0.0" : s}_f64)` : `${s}_f64`;
}

export function literal(ctx: ExprCtx, l: IrLiteral): CExpr {
  switch (l.kind) {
    case "int":
      return { code: intLit(l.value), t: { k: "int" } };
    case "float":
      return { code: floatLit(l.value), t: { k: "float" } };
    case "bool":
      return { code: String(l.value), t: { k: "bool" } };
    case "string":
      return { code: strLit(l.value), t: { k: "str" } };
    case "bytes": {
      const bytes = l.hex.replace(/\s+/g, "").match(/../g) ?? [];
      return { code: `(&[${bytes.map(b => `0x${b}u8`).join(", ")}][..])`, t: { k: "bytes" } };
    }
    case "endian":
      return { code: l.value === "be" ? "yr::Endian::Be" : "yr::Endian::Le", t: { k: "endian" } };
    case "enum": {
      const e = ctx.m.enum(l.enum);
      const v = e.variants.find(x => x.irName === l.member);
      if (!v) throw new BackendError(`enum ${e.name} has no member ${l.member}`);
      return { code: `${e.name}::${v.name}`, t: { k: "enum", id: l.enum } };
    }
  }
}

function want(c: CExpr, k: ETy["k"], what: string): string {
  if (c.t.k !== k) throw new BackendError(`expected ${k} for ${what}, got ${c.t.k}`);
  return c.code;
}

export function asInt(c: CExpr): string {
  if (c.t.k === "int") return c.code;
  if (c.t.k === "enum") return `(${c.code}.to_raw() as i128)`;
  if (c.t.k === "bool") return `(${c.code} as i128)`;
  throw new BackendError(`expected an integer, got ${c.t.k}`);
}
export function asFloat(c: CExpr): string {
  if (c.t.k === "float") return c.code;
  if (c.t.k === "int") return `(${c.code} as f64)`;
  throw new BackendError(`expected a float, got ${c.t.k}`);
}
export function asBool(c: CExpr): string {
  return want(c, "bool", "a condition");
}

function fieldExpr(ctx: ExprCtx, name: string): CExpr {
  const f = ctx.field(name);
  return f.kind === "place" ? load(f.place, f.shape) : f.e;
}

/** A field of another struct value (`hdr.version`). */
function memberAccess(ctx: ExprCtx, obj: CExpr, name: string): CExpr {
  if (obj.t.k !== "ref" || obj.t.shape.k !== "struct")
    throw new BackendError(`member access .${name} on a non-struct value`);
  const sm = ctx.m.struct(obj.t.shape.id);
  const f = sm.fields.get(name);
  if (!f) throw new BackendError(`${sm.name} has no field ${name}`);
  if (!f.output)
    throw new BackendError(`${sm.name}.${name} is hidden and cannot be accessed from outside`);
  return load(fieldPlace(f, `(*${obj.code})`), f.shape);
}

function cmpOperands(a: CExpr, b: CExpr): [string, string] {
  if ((a.t.k === "int" || a.t.k === "float") && (b.t.k === "int" || b.t.k === "float")) {
    if (a.t.k === "float" || b.t.k === "float") return [asFloat(a), asFloat(b)];
    return [a.code, b.code];
  }
  if (a.t.k === "enum" && b.t.k === "int") return [asInt(a), b.code];
  if (a.t.k === "int" && b.t.k === "enum") return [a.code, asInt(b)];
  if (a.t.k === "opt" || b.t.k === "opt") {
    return [
      a.t.k === "opt" ? a.code : `Some(${a.code})`,
      b.t.k === "opt" ? b.code : `Some(${b.code})`
    ];
  }
  return [a.code, b.code];
}

const INT_OPS: Record<string, string> = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "div",
  "%": "rem",
  "<<": "shl",
  ">>": "shr"
};

export function compile(ctx: ExprCtx, e: IrExpr): CExpr {
  switch (e.kind) {
    case "literal":
      return literal(ctx, e.value);
    case "field":
      return fieldExpr(ctx, e.name);
    case "param": {
      const p = ctx.param(e.name);
      return p.kind === "place" ? load(p.place, p.shape) : p.e;
    }
    case "it": {
      if (!ctx.it) throw new BackendError("`it` used outside a check or transform");
      return "e" in ctx.it ? ctx.it.e : load(ctx.it.place, ctx.it.shape);
    }
    case "lambdaParam": {
      const lv = ctx.lambdaVals?.[e.name];
      if (lv) return lv;
      const v = ctx.lambda?.[e.name];
      if (!v) throw new BackendError(`unknown lambda parameter ${e.name}`);
      return { code: v, t: { k: "int" } };
    }
    case "lambda":
      throw new BackendError(
        "a lambda is only allowed as an argument of map, filter, indicesWhere or sortedBy"
      );
    case "builtinValue":
      if (e.name === "offset") return { code: ctx.offset(), t: { k: "int" } };
      if (e.name === "end") return { code: ctx.end(), t: { k: "int" } };
      return { code: ctx.index(), t: { k: "int" } };
    case "member":
      return memberAccess(ctx, compile(ctx, e.object), e.name);
    case "index": {
      const obj = compile(ctx, e.object);
      const idx = asInt(compile(ctx, e.index));
      if (obj.t.k === "ref" && obj.t.shape.k === "array")
        return load(`(*yr::index(${obj.code}, ${idx})?)`, obj.t.shape.elem);
      if (obj.t.k === "bytes") return load(`(*yr::index(${obj.code}, ${idx})?)`, U8);
      throw new BackendError("indexing a value that is not an array");
    }
    case "map": {
      const obj = compile(ctx, e.array);
      if (obj.t.k !== "ref" || obj.t.shape.k !== "array" || obj.t.shape.elem.k !== "struct")
        throw new BackendError("arr[*].field on a value that is not an array of structs");
      const sm = ctx.m.struct(obj.t.shape.elem.id);
      const f = sm.fields.get(e.field);
      if (!f) throw new BackendError(`${sm.name} has no field ${e.field}`);
      if (f.switches.length > 0 || f.optionalTop || f.input === "optional")
        throw new BackendError(`arr[*].${e.field}: conditional fields are not supported in maps`);
      return {
        code: `(&${obj.code}.iter().map(|__e| __e.${f.ident}.clone()).collect::<Vec<_>>())`,
        t: { k: "ref", shape: { k: "array", elem: f.shape } }
      };
    }
    case "unary": {
      const a = compile(ctx, e.operand);
      if (e.op === "!") return { code: `(!${asBool(a)})`, t: { k: "bool" } };
      if (e.op === "~") return { code: `(!${asInt(a)})`, t: { k: "int" } };
      if (a.t.k === "float") return { code: `(-${a.code})`, t: { k: "float" } };
      return { code: `yr::int::neg(${asInt(a)})?`, t: { k: "int" } };
    }
    case "binary":
      return binary(ctx, e);
    case "cond": {
      const t = asBool(compile(ctx, e.test));
      let a = compile(ctx, e.then);
      let b = compile(ctx, e.else);
      if (a.t.k === "float" || b.t.k === "float") {
        a = { code: asFloat(a), t: { k: "float" } };
        b = { code: asFloat(b), t: { k: "float" } };
      }
      return { code: `(if ${t} { ${a.code} } else { ${b.code} })`, t: a.t };
    }
    case "call":
      return call(ctx, e);
    case "in": {
      const v = tmp("v");
      const val = compile(ctx, e.value);
      const parts = e.items.map(it => {
        if (it.kind === "value") {
          const [x, y] = cmpOperands({ code: v, t: val.t }, compile(ctx, it.value));
          return `(${x} == ${y})`;
        }
        const [lo, x1] = cmpOperands(compile(ctx, it.low), { code: v, t: val.t });
        const [x2, hi] = cmpOperands({ code: v, t: val.t }, compile(ctx, it.high));
        return `(${lo} <= ${x1} && ${x2} <= ${hi})`;
      });
      return {
        code: `({ let ${v} = ${val.code}; ${parts.length ? parts.join(" || ") : "false"} })`,
        t: { k: "bool" }
      };
    }
    case "regex": {
      const id = ctx.m.regex(e.pattern);
      const v = compile(ctx, e.value);
      return {
        code: `yr::regex_match(&RE_${id}, ${strLit(e.pattern)}, ${want(v, "str", "a regex")})`,
        t: { k: "bool" }
      };
    }
    case "convert":
      return convert(compile(ctx, e.operand), e.type);
  }
  throw new BackendError(`unsupported expression kind ${(e as { kind: string }).kind}`);
}

function convert(a: CExpr, to: IrValueType): CExpr {
  switch (to.kind) {
    case "float":
      if (a.t.k === "int") {
        const c = `(${a.code} as f64)`;
        return { code: to.bits === 64 ? c : `(${c} as f32 as f64)`, t: { k: "float" } };
      }
      if (a.t.k === "float")
        return { code: to.bits === 64 ? a.code : `(${a.code} as f32 as f64)`, t: { k: "float" } };
      break;
    case "bigint":
      if (a.t.k === "float") return { code: `yr::int::from_f64(${a.code})?`, t: { k: "int" } };
      return { code: asInt(a), t: { k: "int" } };
    case "int":
      if (a.t.k === "float")
        return {
          code: `yr::int::fit(yr::int::from_f64(${a.code})?, ${to.bits}, ${to.signed})?`,
          t: { k: "int" }
        };
      return { code: `yr::int::fit(${asInt(a)}, ${to.bits}, ${to.signed})?`, t: { k: "int" } };
    default:
      break;
  }
  return a;
}

function binary(ctx: ExprCtx, e: Extract<IrExpr, { kind: "binary" }>): CExpr {
  const a = compile(ctx, e.left);
  const b = compile(ctx, e.right);
  const op = e.op;
  if (op === "&&" || op === "||")
    return { code: `(${asBool(a)} ${op} ${asBool(b)})`, t: { k: "bool" } };
  if (op === "==" || op === "!=") {
    // Composite values compare by value, element-wise (IR.md §6).
    const eq = compositeEq(a, b);
    if (eq !== undefined) return { code: op === "==" ? eq : `(!${eq})`, t: { k: "bool" } };
  }
  if (op === "==" || op === "!=" || op === "<" || op === "<=" || op === ">" || op === ">=") {
    const [x, y] = cmpOperands(a, b);
    return { code: `(${x} ${op} ${y})`, t: { k: "bool" } };
  }
  const isFloat = a.t.k === "float" || b.t.k === "float" || e.type.kind === "float";
  if (isFloat) {
    if (op === "&" || op === "|" || op === "^" || op === "<<" || op === ">>")
      throw new BackendError(`operator ${op} on floats`);
    return { code: `(${asFloat(a)} ${op} ${asFloat(b)})`, t: { k: "float" } };
  }
  if (op === "&" || op === "|" || op === "^") {
    if (a.t.k === "bool" && b.t.k === "bool")
      return { code: `(${a.code} ${op} ${b.code})`, t: { k: "bool" } };
    return { code: `(${asInt(a)} ${op} ${asInt(b)})`, t: { k: "int" } };
  }
  return { code: `yr::int::${INT_OPS[op]}(${asInt(a)}, ${asInt(b)})?`, t: { k: "int" } };
}

/** The field named by a builtin's first argument (sizeof(x), offsetof(x), …). */
function fieldArg(e: IrExpr | undefined, what: string): string {
  const n = argName(e);
  if (n === undefined) throw new BackendError(`${what} needs a field argument`);
  return n;
}

const int = (code: string): CExpr => ({ code, t: { k: "int" } });

function call(ctx: ExprCtx, e: Extract<IrExpr, { kind: "call" }>): CExpr {
  if (e.callee.kind === "extern") return externCall(ctx, e.callee.extern, e.args);
  const n = e.callee.name;
  switch (n) {
    case "sizeof":
    case "offsetof":
    case "bytesof":
    case "encode":
    case "encodedSize":
      return measureCall(ctx, n, e.args);
    case "crc32":
    case "adler32": {
      const arg = e.args[0];
      let bytes: CExpr;
      if (arg && arg.kind === "field" && arg.type.kind !== "bytes") {
        bytes = call(ctx, {
          kind: "call",
          callee: { kind: "builtin", name: "bytesof" },
          args: [arg],
          type: { kind: "bytes" }
        });
      } else {
        if (!arg) throw new BackendError(`${n} needs an argument`);
        bytes = compile(ctx, arg);
      }
      return int(`(yr::${n}(${want(bytes, "bytes", n)}) as i128)`);
    }
    case "min":
    case "max": {
      const args = e.args.map(a => compile(ctx, a));
      const first = args[0];
      if (args.length === 1 && first && first.t.k === "ref" && first.t.shape.k === "array") {
        // The aggregate form: min/max over an array (empty is a RANGE error).
        const el = first.t.shape.elem;
        const item = load("(*__e)", el);
        if (item.t.k === "float")
          return {
            code: `yr::agg_f64(${first.code}.iter().map(|__e| ${item.code}), ${n === "max"})?`,
            t: { k: "float" }
          };
        return int(`yr::agg_int(${first.code}.iter().map(|__e| ${asInt(item)}), ${n === "max"})?`);
      }
      const isF = args.some(a => a.t.k === "float");
      return args
        .slice(1)
        .reduce<CExpr>(
          (acc, x) =>
            isF
              ? { code: `${asFloat(acc)}.${n}(${asFloat(x)})`, t: { k: "float" } }
              : int(`std::cmp::${n}(${asInt(acc)}, ${asInt(x)})`),
          args[0]!
        );
    }
    case "abs": {
      const a = compile(ctx, e.args[0]!);
      return a.t.k === "float"
        ? { code: `${a.code}.abs()`, t: { k: "float" } }
        : int(`yr::int::abs(${asInt(a)})?`);
    }
    case "round": {
      const a = compile(ctx, e.args[0]!);
      const r = `${asFloat(a)}.round()`;
      return e.type.kind === "float"
        ? { code: r, t: { k: "float" } }
        : int(`yr::int::from_f64(${r})?`);
    }
    case "indexOf": {
      const arr = compile(ctx, e.args[0]!);
      const val = compile(ctx, e.args[1]!);
      if (arr.t.k !== "ref" || arr.t.shape.k !== "array")
        throw new BackendError("indexOf needs an array");
      const el = arr.t.shape.elem;
      const x = tmp("x");
      let pred: string;
      if (el.k === "int") pred = `(*__e as i128) == ${x}`;
      else if (el.k === "float") pred = `(*__e as f64) == ${x}`;
      else if (el.k === "string") pred = `__e.as_str() == ${x}`;
      else if (el.k === "bytes") pred = `__e.as_slice() == ${x}`;
      else if (el.k === "struct" || el.k === "union") pred = `__e == ${x}`;
      else pred = `*__e == ${x}`;
      return int(
        `({ let ${x} = ${val.code}; ${arr.code}.iter().position(|__e| ${pred}).map(|__i| __i as i128).ok_or_else(|| yr::YaffleError::input("value not found for indexOf"))? })`
      );
    }
    case "len": {
      const a = compile(ctx, e.args[0]!);
      if (a.t.k === "str") return int(`(yr::strings::js_length(${a.code}) as i128)`);
      if (a.t.k === "bytes" || (a.t.k === "ref" && a.t.shape.k === "array"))
        return int(`(${a.code}.len() as i128)`);
      throw new BackendError(`len of ${a.t.k}`);
    }
    case "encodedLength": {
      const a = compile(ctx, e.args[0]!);
      const encArg = e.args[2];
      const enc =
        encArg && encArg.kind === "literal" && encArg.value.kind === "string"
          ? encArg.value.value
          : "utf8";
      // Bytes (IR.md; the frontend divides by the unit for code-unit lengths).
      const unit = enc === "utf16" ? 2 : enc === "utf32" ? 4 : 1;
      return int(
        `((yr::strings::unit_count(${want(a, "str", "encodedLength")}, ${encodingRust(enc)}) * ${unit}) as i128)`
      );
    }
    default:
      return extraBuiltin(ctx, e);
  }
}

/** `sizeof`, `offsetof`, `bytesof`, `encode` and `encodedSize`, per expression context. */
function measureCall(ctx: ExprCtx, n: string, args: IrExpr[]): CExpr {
  const f = fieldArg(args[0], n);
  const level: number | "all" =
    n === "encode" ? 0 : n === "encodedSize" ? Number(literalInt(args[1]) ?? 0) : "all";
  if (f === "$this") {
    // The current struct: a `@base` struct starts at 0 and its size is its whole region.
    if (n === "offsetof" && ctx.sm.ir.base) return int("0_i128");
    if (ctx.mode === "read" || ctx.mode === "json") {
      if (n === "offsetof") return int("__this_o");
      throw new BackendError(`${n}(this) is only available in computed fields`);
    }
    if (n === "sizeof" && ctx.sm.ir.base && ctx.mode === "late") return int("__r.region_len()");
  }
  if (ctx.mode === "read" || ctx.mode === "json") {
    if (!ctx.measure) throw new BackendError(`${n} is not available here`);
    const ms = ctx.measure(f);
    if (n === "sizeof" || n === "encodedSize") return int(ms.s);
    if (n === "offsetof") return int(ms.o);
    return { code: `r.slice_rel(${ms.o}, ${ms.s})?`, t: { k: "bytes" } };
  }
  if (!ctx.slot) throw new BackendError(`${n} is not available here`);
  const slot = ctx.slot(f, level);
  if (ctx.mode === "late") {
    if (n === "sizeof" || n === "encodedSize") return int(`__r.size(${slot})?`);
    if (n === "offsetof") return int(`__r.offset(${slot})?`);
    return { code: `__r.bytes(${slot})?`, t: { k: "bytes" } };
  }
  if (n === "sizeof" || n === "encodedSize") return int(`w.size_now(${slot})?`);
  if (n === "offsetof" && level === "all" && f === ctx.selfField) return int("w.offset_now()?");
  if (n === "offsetof") return int(`w.offset_of_now(${slot})?`);
  return { code: `w.bytes_now(${slot})?.as_slice()`, t: { k: "bytes" } };
}

export function encodingRust(enc: string): string {
  const m: Record<string, string> = {
    utf8: "Utf8",
    ascii: "Ascii",
    latin1: "Latin1",
    utf16: "Utf16",
    utf32: "Utf32"
  };
  return `yr::Encoding::${m[enc] ?? "Utf8"}`;
}

/** An owned copy of an expression value, and its shape (elements of derived arrays). */
function owned(c: CExpr): { code: string; shape: Shape } {
  switch (c.t.k) {
    case "int":
      return { code: c.code, shape: I128 };
    case "float":
      return { code: c.code, shape: { k: "float", rust: "f64", bits: 64 } };
    case "bool":
      return { code: c.code, shape: { k: "bool" } };
    case "endian":
      return { code: c.code, shape: { k: "endian" } };
    case "str":
      return { code: `${c.code}.to_string()`, shape: { k: "string" } };
    case "bytes":
      return { code: `${c.code}.to_vec()`, shape: { k: "bytes" } };
    case "enum":
      return { code: c.code, shape: { k: "enum", id: c.t.id } };
    case "ref":
      return { code: `${c.code}.clone()`, shape: c.t.shape };
    case "opt":
      return { code: `${c.code}.cloned()`, shape: { k: "option", inner: c.t.shape } };
  }
}

/** Iteration over an array value: the iterator and each element as an expression. */
function elements(
  a: CExpr,
  what: string
): { src: string; elem: (v: string) => CExpr; shape: Shape } {
  if (a.t.k === "bytes") return { src: a.code, elem: v => load(`(*${v})`, U8), shape: U8 };
  if (a.t.k === "ref" && a.t.shape.k === "array") {
    const el = a.t.shape.elem;
    return { src: a.code, elem: v => load(`(*${v})`, el), shape: el };
  }
  throw new BackendError(`${what} needs an array`);
}

/** The result of a derived-array builtin: a vector value of `elem` (bytes for u8 sources). */
function vecResult(block: string, elem: Shape, bytes: boolean): CExpr {
  if (bytes) return { code: `(&${block}[..])`, t: { k: "bytes" } };
  return { code: `(&${block})`, t: { k: "ref", shape: { k: "array", elem } } };
}

/** `map`, `filter`, `indicesWhere`, `sortedBy`, `unique`, `concat`. */
function derivedArray(ctx: ExprCtx, n: string, e: Extract<IrExpr, { kind: "call" }>): CExpr {
  const lambda = (k: number) => {
    const l = e.args[k];
    if (!l || l.kind !== "lambda") throw new BackendError(`${n} needs a lambda argument`);
    return l;
  };
  const withParam = (param: string, v: CExpr): ExprCtx => ({
    ...ctx,
    lambdaVals: { ...(ctx.lambdaVals ?? {}), [param]: v }
  });
  if (n === "concat") {
    const parts = e.args.map(x => elements(compile(ctx, x), "concat"));
    const same = parts.every(p => JSON.stringify(p.shape) === JSON.stringify(parts[0]?.shape));
    const allBytes = e.args.every((_, i) => parts[i]!.shape === U8) && same;
    const elem = same && parts[0] ? parts[0].shape : I128;
    const ext = parts.map(p =>
      same
        ? `__o.extend(${p.src}.iter().cloned());`
        : `__o.extend(${p.src}.iter().map(|__x| *__x as i128));`
    );
    return vecResult(
      `{ let mut __o: Vec<${ctx.m.rustType(elem)}> = Vec::new(); ${ext.join(" ")} __o }`,
      elem,
      allBytes && compile(ctx, e.args[0]!).t.k === "bytes"
    );
  }
  const arr = compile(ctx, e.args[0]!);
  const it = elements(arr, n);
  const bytes = arr.t.k === "bytes";
  const x = tmp("lx");
  const src = tmp("src");
  switch (n) {
    case "map": {
      const l = lambda(1);
      const body = owned(compile(withParam(l.param, it.elem(x)), l.body));
      return vecResult(
        `{ let ${src} = ${it.src}; let mut __o: Vec<${ctx.m.rustType(body.shape)}> = Vec::with_capacity(${src}.len()); for ${x} in ${src}.iter() { __o.push(${body.code}); } __o }`,
        body.shape,
        false
      );
    }
    case "filter": {
      const l = lambda(1);
      const pred = asBool(compile(withParam(l.param, it.elem(x)), l.body));
      return vecResult(
        `{ let ${src} = ${it.src}; let mut __o: Vec<${ctx.m.rustType(it.shape)}> = Vec::new(); for ${x} in ${src}.iter() { if ${pred} { __o.push((*${x}).clone()); } } __o }`,
        it.shape,
        bytes
      );
    }
    case "indicesWhere": {
      const l = lambda(1);
      const pred = asBool(compile(withParam(l.param, it.elem(x)), l.body));
      return vecResult(
        `{ let ${src} = ${it.src}; let mut __o: Vec<i128> = Vec::new(); for (__i, ${x}) in ${src}.iter().enumerate() { if ${pred} { __o.push(__i as i128); } } __o }`,
        I128,
        false
      );
    }
    case "sortedBy": {
      const l = lambda(1);
      const key = owned(compile(withParam(l.param, it.elem(x)), l.body));
      return vecResult(
        `{ let ${src} = ${it.src}; let mut __k: Vec<(${ctx.m.rustType(key.shape)}, usize)> = Vec::with_capacity(${src}.len()); for (__i, ${x}) in ${src}.iter().enumerate() { __k.push((${key.code}, __i)); } __k.sort_by(|__a, __b| __a.0.partial_cmp(&__b.0).unwrap_or(std::cmp::Ordering::Equal)); __k.into_iter().map(|(_, __i)| ${src}[__i].clone()).collect::<Vec<${ctx.m.rustType(it.shape)}>>() }`,
        it.shape,
        bytes
      );
    }
    case "unique":
      return vecResult(
        `{ let ${src} = ${it.src}; let mut __o: Vec<${ctx.m.rustType(it.shape)}> = Vec::new(); for ${x} in ${src}.iter() { if !__o.contains(${x}) { __o.push((*${x}).clone()); } } __o }`,
        it.shape,
        bytes
      );
  }
  throw new BackendError(`unsupported builtin ${n}`);
}

/** Element-wise equality of composite values (arrays, bytes); undefined for other values. */
function compositeEq(a: CExpr, b: CExpr): string | undefined {
  const seq = (c: CExpr): Shape | undefined =>
    c.t.k === "bytes"
      ? U8
      : c.t.k === "ref" && c.t.shape.k === "array"
        ? c.t.shape.elem
        : undefined;
  const ea = seq(a);
  const eb = seq(b);
  if (!ea || !eb) return undefined;
  if (JSON.stringify(ea) === JSON.stringify(eb)) return `(${a.code} == ${b.code})`;
  const num = (s: Shape) => s.k === "int" || s.k === "enum";
  if (num(ea) && num(eb)) {
    const conv = (s: Shape, v: string) =>
      s.k === "enum" ? `((*${v}).to_raw() as i128)` : `(*${v} as i128)`;
    return `({ let __ea = ${a.code}; let __eb = ${b.code}; __ea.len() == __eb.len() && __ea.iter().zip(__eb.iter()).all(|(__x, __y)| ${conv(ea, "__x")} == ${conv(eb, "__y")}) })`;
  }
  return `(${a.code} == ${b.code})`;
}

/** Derived arrays, `isNull`, `sum` and `lengths`. */
function extraBuiltin(ctx: ExprCtx, e: Extract<IrExpr, { kind: "call" }>): CExpr {
  const n = (e.callee as { name: string }).name;
  if (["map", "filter", "indicesWhere", "sortedBy", "unique", "concat"].includes(n))
    return derivedArray(ctx, n, e);
  if (n === "isNull") {
    // `x == null`: only nullable values can be null.
    const x = compile(ctx, e.args[0]!);
    return { code: x.t.k === "opt" ? `${x.code}.is_none()` : "false", t: { k: "bool" } };
  }
  const a = e.args[0] ? compile(ctx, e.args[0]) : undefined;
  if (!a || a.t.k !== "ref" || a.t.shape.k !== "array")
    throw new BackendError(`${n} needs an array`);
  const el = a.t.shape.elem;
  if (n === "sum") {
    const item = load("(*__e)", el);
    if (item.t.k === "float")
      return { code: `${a.code}.iter().map(|__e| ${item.code}).sum::<f64>()`, t: { k: "float" } };
    return { code: `yr::sum_int(${a.code}.iter().map(|__e| ${asInt(item)}))?`, t: { k: "int" } };
  }
  if (n === "lengths") {
    // Element counts of an array of arrays (pointer targets are transparent; null is empty).
    const lenOf = (s: Shape, x: string): string => {
      if (s.k === "rc") return lenOf(s.inner, `(*${x})`);
      if (s.k === "option") return `${x}.as_ref().map_or(0, |__o| ${lenOf(s.inner, "(*__o)")})`;
      return `${x}.len()`;
    };
    return {
      code: `(&${a.code}.iter().map(|__e| ${lenOf(el, "(*__e)")} as i128).collect::<Vec<i128>>())`,
      t: {
        k: "ref",
        shape: { k: "array", elem: I128 }
      }
    };
  }
  throw new BackendError(`unsupported builtin ${n}`);
}

/** Converts an expression to a typed Rust argument for an extern function parameter. */
export function toParamValue(ctx: ExprCtx, c: CExpr, shape: Shape): string {
  switch (shape.k) {
    case "int":
      return intConv(asInt(c), shape);
    case "float":
      return `(${asFloat(c)} as ${shape.rust})`;
    case "bool":
      return asBool(c);
    case "string":
      return want(c, "str", "a string argument");
    case "bytes":
      return want(c, "bytes", "a bytes argument");
    case "endian":
      return want(c, "endian", "an endian argument");
    case "enum":
      if (c.t.k === "enum") return c.code;
      return `${ctx.m.enum(shape.id).name}::from_raw(${intConv(asInt(c), ctx.m.enum(shape.id).storage)}).ok_or_else(|| yr::YaffleError::range("not an enum value"))?`;
    case "option":
      if (c.t.k === "opt") return c.code;
      return `Some(${toParamValue(ctx, c, shape.inner)})`;
    default:
      if (c.t.k === "ref") return c.code;
      if (c.t.k === "opt") return c.code;
      throw new BackendError(`cannot pass ${c.t.k} as ${shape.k}`);
  }
}

/** `i128` → a stored integer type, with a range check. */
export function intConv(code: string, shape: Shape): string {
  if (shape.k !== "int") throw new BackendError("intConv on a non-integer");
  if (shape.rust === "i128") return code;
  const std = shape.bits === 8 || shape.bits === 16 || shape.bits === 32 || shape.bits === 64;
  if (std) return `yr::int::to::<${shape.rust}>(${code})?`;
  return shape.signed
    ? `(yr::int::to_sbits(${code}, ${shape.bits})? as ${shape.rust})`
    : `(yr::int::to_ubits(${code}, ${shape.bits})? as ${shape.rust})`;
}

function externCall(ctx: ExprCtx, id: string, args: IrExpr[]): CExpr {
  const ex = ctx.m.extern(id);
  if (ex.kind !== "fn") throw new BackendError(`${ex.name} is not an extern function`);
  const path = ctx.m.externPath(id);
  const argCode = args.map((a, i) => {
    const p = ex.params[i];
    const shape = p ? ctx.m.shapeOfValue(p.type, ex.name) : I128;
    return toParamValue(ctx, compile(ctx, a), shape);
  });
  const callCode = `${path}(${argCode.join(", ")})`;
  const r = ctx.m.shapeOfValue(ex.returns, ex.name);
  switch (r.k) {
    case "int":
      return { code: `(${callCode} as i128)`, t: { k: "int" } };
    case "float":
      return { code: `(${callCode} as f64)`, t: { k: "float" } };
    case "bool":
      return { code: callCode, t: { k: "bool" } };
    case "string":
      return { code: `(${callCode}).as_str()`, t: { k: "str" } };
    case "bytes":
      return { code: `(${callCode}).as_slice()`, t: { k: "bytes" } };
    case "endian":
      return { code: callCode, t: { k: "endian" } };
    case "enum":
      return { code: callCode, t: { k: "enum", id: r.id } };
    default:
      return { code: `(&${callCode})`, t: { k: "ref", shape: r } };
  }
}

/**
 * Converts an expression value to an owned stored value of a shape (for derived values, transform
 * results, arguments by value).
 */
export function toStored(ctx: ExprCtx, c: CExpr, shape: Shape): string {
  switch (shape.k) {
    case "int":
      return intConv(asInt(c), shape);
    case "float":
      return `(${asFloat(c)} as ${shape.rust})`;
    case "bool":
      return asBool(c);
    case "endian":
      return want(c, "endian", "an endian value");
    case "string":
      return `${want(c, "str", "a string value")}.to_string()`;
    case "bytes":
      if (c.t.k === "ref" && c.t.shape.k === "array") {
        // A derived array of integers (`indicesWhere`, `map`) into a byte array.
        const item = load("(*__x)", c.t.shape.elem);
        return `${c.code}.iter().map(|__x| -> yr::Result<u8> { Ok(yr::int::to::<u8>(${asInt(item)})?) }).collect::<yr::Result<Vec<u8>>>()?`;
      }
      return `${want(c, "bytes", "a bytes value")}.to_vec()`;
    case "enum": {
      if (c.t.k === "enum") return c.code;
      const en = ctx.m.enum(shape.id);
      return `${en.name}::from_raw(${intConv(asInt(c), en.storage)}).ok_or_else(|| yr::YaffleError::input("not an enum value"))?`;
    }
    case "rc":
      return `Rc::new(${toStored(ctx, c, shape.inner)})`;
    case "box":
      return `Box::new(${toStored(ctx, c, shape.inner)})`;
    case "option":
      if (c.t.k === "opt") return `${c.code}.cloned()`;
      return `Some(${toStored(ctx, c, shape.inner)})`;
    case "oneway":
      return `yr::OneWay { value: ${toStored(ctx, c, shape.value)}, raw: Default::default() }`;
    case "extern":
      return toStored(ctx, c, shape.value);
    case "array":
      if (c.t.k === "bytes") {
        const item = load("(*__x)", U8);
        return `${c.code}.iter().map(|__x| -> yr::Result<${ctx.m.rustType(shape.elem)}> { Ok(${toStored(ctx, item, shape.elem)}) }).collect::<yr::Result<Vec<_>>>()?`;
      }
      if (
        c.t.k === "ref" &&
        c.t.shape.k === "array" &&
        JSON.stringify(c.t.shape.elem) !== JSON.stringify(shape.elem)
      ) {
        // Element conversion (e.g. `lengths(…)` giving i128 counts for a u16 array).
        const item = load("(*__x)", c.t.shape.elem);
        return `${c.code}.iter().map(|__x| -> yr::Result<${ctx.m.rustType(shape.elem)}> { Ok(${toStored(ctx, item, shape.elem)}) }).collect::<yr::Result<Vec<_>>>()?`;
      }
      if (c.t.k === "ref") return `${c.code}.clone()`;
      throw new BackendError(`cannot store ${c.t.k} as an array`);
    default:
      if (c.t.k === "ref") return `${c.code}.clone()`;
      throw new BackendError(`cannot store ${c.t.k} as ${shape.k}`);
  }
}

/** Equality of an expression value and a loaded stored value (transform round trips). */
export function eqExpr(a: CExpr, b: CExpr): string {
  if (a.t.k === "float" || b.t.k === "float")
    return `yr::float_close(${asFloat(a)}, ${asFloat(b)}, true)`;
  const [x, y] = cmpOperands(a, b);
  return `(${x} == ${y})`;
}
