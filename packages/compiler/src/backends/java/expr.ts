/**
 * IR expressions → Java expressions, implementing the integer semantics of docs/IR.md §6.
 *
 * Integer subexpressions carry a value range (interval analysis). When every operand is an `int`
 * or `long` and the result provably stays within the signed 64-bit range, the code computes in
 * `long`; otherwise it computes with `BigInteger`. `u64` values travel as their unsigned bit
 * pattern in a `long` (repr "u64").
 */
import type { IrExpr, IrLiteral, IrType, IrValueType } from "../../ir/index.ts";
import { storageType } from "./analysis.ts";
import { doubleLit, enumConst, intLit, longLit, str, wrap } from "./code.ts";
import { javaIntKind, type Model } from "./model.ts";

export type Repr =
  | "int"
  | "long"
  | "u64"
  | "big"
  | "f32"
  | "f64"
  | "bool"
  | "str"
  | "bytes"
  | "enum"
  | "endian"
  | "list"
  | "obj";
export type Range = [bigint, bigint];

export interface CExpr {
  code: string;
  repr: Repr;
  /** Integer range (int/long/u64/big). */
  range?: Range;
  /** Set for integer literals. */
  lit?: bigint;
  /**
   * Lists computed by builtins: the Java element type they hold, so assigning them to a field
   * converts the elements when it differs.
   */
  listElem?: string;
}

const LMIN = -(1n << 63n);
const LMAX = (1n << 63n) - 1n;
const IMIN = -(1n << 31n);
const IMAX = (1n << 31n) - 1n;
const LEN_MAX = (1n << 31n) - 1n;
const FULL: Range = [-(1n << 64n), 1n << 64n];

export function intRange(bits: number, signed: boolean): Range {
  const b = BigInt(bits);
  return signed ? [-(1n << (b - 1n)), (1n << (b - 1n)) - 1n] : [0n, (1n << b) - 1n];
}

function fitsLong(r: Range | undefined): boolean {
  return r !== undefined && r[0] >= LMIN && r[1] <= LMAX;
}

function fitsInt(r: Range | undefined): boolean {
  return r !== undefined && r[0] >= IMIN && r[1] <= IMAX;
}

function within(r: Range | undefined, lo: bigint, hi: bigint): boolean {
  return r !== undefined && r[0] >= lo && r[1] <= hi;
}

function minB(...xs: bigint[]): bigint {
  return xs.reduce((a, b) => (b < a ? b : a));
}
function maxB(...xs: bigint[]): bigint {
  return xs.reduce((a, b) => (b > a ? b : a));
}
function absB(x: bigint): bigint {
  return x < 0n ? -x : x;
}

function isSmall(c: CExpr): boolean {
  return c.repr === "int" || c.repr === "long";
}

function isInt(c: CExpr): boolean {
  return c.repr === "int" || c.repr === "long" || c.repr === "u64" || c.repr === "big";
}

function isFloat(c: CExpr): boolean {
  return c.repr === "f32" || c.repr === "f64";
}

/** A u64, or a small value known to be non-negative: usable as an unsigned 64-bit pattern. */
function isUnsigned(c: CExpr): boolean {
  return c.repr === "u64" || (isSmall(c) && within(c.range, 0n, LMAX));
}

/** The range of `a & b`, `a | b` or `a ^ b` (`fallback` when the operands may be negative). */
function bitwiseRange(op: string, ra: Range, rb: Range, fallback: Range): Range {
  if (op === "&" && (ra[0] >= 0n || rb[0] >= 0n)) {
    return [0n, ra[0] >= 0n && rb[0] >= 0n ? minB(ra[1], rb[1]) : ra[0] >= 0n ? ra[1] : rb[1]];
  }
  if (ra[0] >= 0n && rb[0] >= 0n) {
    let p = 1n;
    while (p <= maxB(ra[1], rb[1])) p <<= 1n;
    return [0n, p - 1n];
  }
  return fallback;
}

/** `Rt` host call helpers by the Java type the call returns (`call` boxes). */
const CALLS: Record<string, string> = {
  int: "callInt",
  long: "callLong",
  double: "callDouble",
  float: "callFloat",
  boolean: "callBool"
};

/** Context in which an expression is compiled (read side or write side). */
export interface ExprCtx {
  field(name: string, type: IrValueType): CExpr;
  param(name: string, type: IrValueType): CExpr;
  it(type: IrValueType): CExpr;
  lambda(name: string): string;
  /** `$offset`, `$end`, `$index` (long code). */
  builtin(name: "offset" | "end" | "index"): string;
  sizeof(field: string): string;
  offsetof(field: string): string;
  encodedSize(field: string, layer: number): string;
  bytesof(field: string): string;
  encode(field: string): string;
  /** Code calling an extern fn's host method with the given argument codes. */
  externCall(id: string, args: string[]): string;
  /** Hoists a class-level constant and returns its name. */
  hoist(code: string, type: string, hint: string): string;
  /** IR type of a field. */
  fieldType(name: string): IrType | undefined;
  /** Notes a runtime/JDK class used by the code. */
  use(name: string): string;
}

export class ExprCompiler {
  readonly model: Model;
  private lambdas = 0;
  /** Parameters of the lambdas being compiled: name → Java parameter and its type. */
  private readonly lambdaScope = new Map<string, { code: string; type: IrValueType }>();

  constructor(model: Model) {
    this.model = model;
  }

  reprOf(t: IrValueType): Repr {
    switch (t.kind) {
      case "int":
        if (t.bits === 64 && !t.signed) return "u64";
        return javaIntKind(t.bits, t.signed);
      case "bigint":
        return "big";
      case "float":
        return t.bits === 32 ? "f32" : "f64";
      case "bool":
        return "bool";
      case "string":
        return "str";
      case "bytes":
        return "bytes";
      case "enum":
        return "enum";
      case "endian":
        return "endian";
      case "array":
        return "list";
      case "extern":
        return this.reprOf(t.valueType);
      case "nullable":
        return this.reprOf(t.inner);
      default:
        return "obj";
    }
  }

  rangeOf(t: IrValueType): Range | undefined {
    if (t.kind === "int") return intRange(t.bits, t.signed);
    if (t.kind === "bigint") return FULL;
    if (t.kind === "extern") return this.rangeOf(t.valueType);
    if (t.kind === "nullable") return this.rangeOf(t.inner);
    return undefined;
  }

  /** Wraps a typed value (field, param, it) as a CExpr. */
  typed(code: string, t: IrValueType): CExpr {
    const c: CExpr = { code, repr: this.reprOf(t) };
    const r = this.rangeOf(t);
    if (r) c.range = r;
    return c;
  }

  // ── conversions ─────────────────────────────────────────────────────────────

  /** Code of type long holding the value (int and long reprs; others are converted with checks). */
  asLong(c: CExpr, ctx: ExprCtx): string {
    switch (c.repr) {
      case "int":
        return c.lit !== undefined ? longLit(c.lit) : `(long) ${wrap(c.code)}`;
      case "long":
        return c.code;
      case "u64":
        return within(c.range, 0n, LMAX) ? c.code : `${ctx.use("Ints")}.u64ToLong(${c.code})`;
      case "big":
        if (c.lit !== undefined && c.lit >= LMIN && c.lit <= LMAX) return longLit(c.lit);
        return `${ctx.use("Ints")}.toLong(${c.code})`;
      case "f32":
      case "f64":
        return `${ctx.use("Ints")}.trunc(${c.code})`;
      default:
        return c.code;
    }
  }

  /** Code of type BigInteger. */
  asBig(c: CExpr, ctx: ExprCtx): string {
    switch (c.repr) {
      case "big":
        return c.code;
      case "int":
      case "long":
        if (c.lit !== undefined) return this.bigLit(c.lit, ctx);
        return `${ctx.use("BigInteger")}.valueOf(${c.code})`;
      case "u64":
        return `${ctx.use("Ints")}.u64(${c.code})`;
      case "f32":
      case "f64":
        return `${ctx.use("Ints")}.truncBig(${c.code})`;
      default:
        return c.code;
    }
  }

  bigLit(v: bigint, ctx: ExprCtx): string {
    const B = ctx.use("BigInteger");
    if (v === 0n) return `${B}.ZERO`;
    if (v === 1n) return `${B}.ONE`;
    if (v === 2n) return `${B}.TWO`;
    if (v === 10n) return `${B}.TEN`;
    const init =
      v >= LMIN && v <= LMAX ? `${B}.valueOf(${longLit(v)})` : `new ${B}(${str(v.toString())})`;
    return ctx.hoist(init, B, "BIG");
  }

  /** Code of type double. */
  asDouble(c: CExpr, ctx: ExprCtx): string {
    switch (c.repr) {
      case "f64":
        return c.code;
      case "f32":
      case "int":
      case "long":
        if (c.lit !== undefined) return doubleLit(Number(c.lit));
        return `(double) ${wrap(c.code)}`;
      case "u64":
        return `${ctx.use("Ints")}.u64ToDouble(${c.code})`;
      case "big":
        return `${wrap(c.code)}.doubleValue()`;
      default:
        return c.code;
    }
  }

  /** A non-negative int (lengths, counts). */
  asLen(c: CExpr, ctx: ExprCtx): string {
    if (c.repr === "int" && within(c.range, 0n, LEN_MAX)) return c.code;
    if (c.repr === "long" && within(c.range, 0n, LEN_MAX)) return `(int) ${wrap(c.code)}`;
    if (c.repr === "u64") return `${ctx.use("Ints")}.lenU64(${c.code})`;
    return `${ctx.use("Ints")}.len(${c.code})`;
  }

  /**
   * Converts to the Java representation of a destination value type. Integer narrowing checks
   * that the value fits the Java type (RANGE).
   */
  to(c: CExpr, t: IrValueType, ctx: ExprCtx): string {
    const want = this.reprOf(t);
    switch (want) {
      case "int": {
        if (isFloat(c)) return `${ctx.use("Ints")}.toInt(${ctx.use("Ints")}.trunc(${c.code}))`;
        if (c.repr === "int") return c.code;
        if (c.lit !== undefined && c.lit >= IMIN && c.lit <= IMAX) return intLit(c.lit);
        if (c.repr === "long" && fitsInt(c.range)) return `(int) ${wrap(c.code)}`;
        if (c.repr === "big") return `${ctx.use("Ints")}.toInt(${c.code})`;
        if (c.repr === "u64")
          return `${ctx.use("Ints")}.toInt(${ctx.use("Ints")}.u64ToLong(${c.code}))`;
        return `${ctx.use("Ints")}.toInt(${c.code})`;
      }
      case "long":
        if (c.repr === "int") return c.lit !== undefined ? longLit(c.lit) : c.code;
        return this.asLong(c, ctx);
      case "u64":
        if (c.repr === "u64") return c.code;
        if (isSmall(c) && within(c.range, 0n, LMAX)) return this.asLong(c, ctx);
        if (c.repr === "big") {
          if (c.lit !== undefined && c.lit >= 0n && c.lit < 1n << 64n) {
            return longLit(BigInt.asIntN(64, c.lit));
          }
          return `${ctx.use("Ints")}.toU64(${c.code})`;
        }
        if (isFloat(c)) return `${ctx.use("Ints")}.toU64(${ctx.use("Ints")}.truncBig(${c.code}))`;
        return `${ctx.use("Ints")}.toU64(${this.asLong(c, ctx)})`;
      case "big":
        return this.asBig(c, ctx);
      case "f32":
        if (c.repr === "f32") return c.code;
        if (c.repr === "f64" && /^-?[0-9.]+(e-?[0-9]+)?$/.test(c.code)) return `${c.code}f`;
        return `(float) ${wrap(this.asDouble(c, ctx))}`;
      case "f64":
        return this.asDouble(c, ctx);
      case "list":
        if (t.kind === "array" && c.repr === "bytes") return `${ctx.use("Lists")}.of(${c.code})`;
        return t.kind === "array" && c.repr === "list" ? this.toList(c, t, ctx) : c.code;
      case "bytes":
        // A computed list written to a u8 array.
        return c.repr === "list" ? `${ctx.use("Lists")}.bytes(${c.code})` : c.code;
      default:
        return c.code;
    }
  }

  // ── compile ─────────────────────────────────────────────────────────────────

  compile(e: IrExpr, ctx: ExprCtx): CExpr {
    switch (e.kind) {
      case "literal":
        return this.literal(e.value, e.type, ctx);
      case "field":
        return ctx.field(e.name, e.type);
      case "param":
        return ctx.param(e.name, e.type);
      case "it":
        return ctx.it(e.type);
      case "lambdaParam": {
        const scoped = this.lambdaScope.get(e.name);
        // Elements arrive boxed (list elements): unbox them like a boxed field.
        if (scoped) return this.unbox(scoped.code, scoped.type);
        return { code: ctx.lambda(e.name), repr: "int", range: [0n, LEN_MAX] };
      }
      case "builtinValue":
        return {
          code: ctx.builtin(e.name),
          repr: "long",
          range: [e.name === "index" ? -1n : -LEN_MAX, LEN_MAX]
        };
      case "member": {
        const o = this.compile(e.object, ctx);
        return this.member(o, e.object.type, e.name, e.type);
      }
      case "index": {
        const o = this.compile(e.object, ctx);
        const i = this.compile(e.index, ctx);
        const idx = this.asLong(i, ctx);
        if (o.repr === "bytes") {
          return { code: `${ctx.use("Rt")}.at(${o.code}, ${idx})`, repr: "int", range: [0n, 255n] };
        }
        return this.unbox(`${ctx.use("Rt")}.at(${o.code}, ${idx})`, e.type);
      }
      case "map": {
        const o = this.compile(e.array, ctx);
        const et = e.array.type.kind === "array" ? e.array.type.element : undefined;
        const v = `$m${++this.lambdas}`;
        let fieldCode = `${v}.${e.field}`;
        if (et && et.kind === "struct") {
          const s = this.model.struct(et.struct);
          fieldCode = `${v}.${this.model.fieldInfo(s, e.field).java}`;
        }
        return {
          code: `${wrap(o.code)}.stream().map(${v} -> ${fieldCode}).toList()`,
          repr: "list"
        };
      }
      case "unary":
        return this.unary(e.op, this.compile(e.operand, ctx), e.type, ctx);
      case "binary":
        return this.binary(e.op, e.left, e.right, e.type, ctx);
      case "cond":
        return this.cond(
          this.compile(e.test, ctx),
          this.compile(e.then, ctx),
          this.compile(e.else, ctx),
          ctx
        );
      case "call":
        return this.call(e, ctx);
      case "in": {
        const v = this.compile(e.value, ctx);
        const parts = e.items.map(it => {
          if (it.kind === "value") return this.equality("==", v, this.compile(it.value, ctx), ctx);
          const lo = this.compile(it.low, ctx);
          const hi = this.compile(it.high, ctx);
          return `(${this.relational(">=", v, lo, ctx)} && ${this.relational("<=", v, hi, ctx)})`;
        });
        return { code: parts.length ? `(${parts.join(" || ")})` : "false", repr: "bool" };
      }
      case "regex": {
        const v = this.compile(e.value, ctx);
        const P = ctx.use("Pattern");
        const re = ctx.hoist(`${P}.compile(${str(`^(?:${e.pattern})$`)})`, P, "RE");
        return { code: `${re}.matcher(${v.code}).matches()`, repr: "bool" };
      }
      case "lambda":
        throw new Error(
          "a lambda is only valid as an argument of map/filter/indicesWhere/sortedBy"
        );
      case "this":
        throw new Error("`this` is only valid as the argument of sizeof/offsetof/bytesof/encode");
      case "convert":
        return this.convert(e.operand, e.type, ctx);
    }
  }

  /** `obj.name` on a struct value. */
  private member(o: CExpr, ot: IrValueType, name: string, t: IrValueType): CExpr {
    let st = ot;
    while (st.kind === "nullable") st = st.inner;
    if (st.kind !== "struct") return this.typed(`${wrap(o.code)}.${name}`, t);
    const fi = this.model.fieldInfo(this.model.struct(st.struct), name);
    return this.fieldValue(`${wrap(o.code)}.${fi.java}`, fi.boxed, fi.type, t);
  }

  /**
   * A Java field's value used as a value of type `t`: boxed fields are unboxed, and a field with
   * different types in different branches (Java type `Object`) is cast to this one.
   */
  fieldValue(code: string, boxed: boolean, javaType: string, t: IrValueType): CExpr {
    if (boxed) return this.unbox(code, t);
    if (javaType === this.model.lang("Object")) return this.unbox(code, t, true);
    return this.typed(code, t);
  }

  /**
   * A boxed value (or an Object, with `fromObject`) used as a value of type `t`: primitives are
   * unboxed, reference types cast from Object.
   */
  unbox(code: string, t: IrValueType, fromObject = false): CExpr {
    const j = this.model.javaValueType(t, false);
    const boxedT = this.model.javaValueType(t, true);
    if (j === boxedT) return this.typed(fromObject ? `((${j}) ${code})` : code, t);
    // An Object field (different types in different branches) may hold any boxed number.
    const numeric = j === "int" || j === "long" || j === "double" || j === "float";
    const src = fromObject
      ? `((${numeric ? this.model.lang("Number") : boxedT}) ${code})`
      : wrap(code);
    return this.typed(`${src}.${j}Value()`, t);
  }

  convert(operand: IrExpr, t: IrValueType, ctx: ExprCtx): CExpr {
    const o = this.compile(operand, ctx);
    if (operand.type.kind === "enum" && (t.kind === "int" || t.kind === "bigint")) {
      const en = this.model.enum(operand.type.enum);
      const bits = Number(en.storage.slice(1));
      const signed = en.storage[0] === "i";
      return {
        code: `${wrap(o.code)}.value()`,
        repr: bits === 64 && !signed ? "u64" : "long",
        range: intRange(bits, signed)
      };
    }
    if (t.kind === "float") {
      const d = this.asDouble(o, ctx);
      if (t.bits === 32) return { code: `(float) ${wrap(d)}`, repr: "f32" };
      return { code: d, repr: "f64" };
    }
    if (t.kind === "int" || t.kind === "bigint") {
      const tr = this.rangeOf(t) ?? FULL;
      if (isFloat(o)) {
        if (fitsLong(tr))
          return { code: `${ctx.use("Ints")}.trunc(${o.code})`, repr: "long", range: tr };
        return { code: `${ctx.use("Ints")}.truncBig(${o.code})`, repr: "big", range: tr };
      }
      return o;
    }
    if (t.kind === "enum" && isInt(o)) {
      const en = this.model.enum(t.enum);
      const name = this.model.enumName(t.enum);
      return {
        code: en.open
          ? `${name}.of(${this.asLong(o, ctx)})`
          : `${name}.fromValue(${this.asLong(o, ctx)})`,
        repr: "enum"
      };
    }
    return o;
  }

  literal(v: IrLiteral, t: IrValueType, ctx: ExprCtx): CExpr {
    switch (v.kind) {
      case "int": {
        const b = BigInt(v.value);
        if (
          b >= IMIN &&
          b <= IMAX &&
          !(t.kind === "int" && javaIntKind(t.bits, t.signed) === "long")
        ) {
          return { code: intLit(b), repr: "int", range: [b, b], lit: b };
        }
        if (b >= LMIN && b <= LMAX)
          return { code: longLit(b), repr: "long", range: [b, b], lit: b };
        return { code: this.bigLit(b, ctx), repr: "big", range: [b, b], lit: b };
      }
      case "float":
        return { code: doubleLit(v.value), repr: "f64" };
      case "bool":
        return { code: String(v.value), repr: "bool" };
      case "string":
        return { code: str(v.value), repr: "str" };
      case "bytes": {
        const H = ctx.use("Hex");
        return { code: ctx.hoist(`${H}.decode(${str(v.hex)})`, "byte[]", "BYTES"), repr: "bytes" };
      }
      case "endian":
        return { code: `${ctx.use("Endian")}.${v.value === "le" ? "LE" : "BE"}`, repr: "endian" };
      case "enum": {
        const en = this.model.enum(v.enum);
        return {
          code: `${this.model.enumName(v.enum)}.${enumConst(en.open, v.member)}`,
          repr: "enum"
        };
      }
    }
  }

  private unary(op: "-" | "!" | "~", o: CExpr, t: IrValueType, ctx: ExprCtx): CExpr {
    if (op === "!") return { code: `!${wrap(o.code)}`, repr: "bool" };
    if (isFloat(o) || t.kind === "float") {
      return { code: `(-${wrap(this.asDouble(o, ctx))})`, repr: "f64" };
    }
    const r = o.range ?? FULL;
    if (op === "-") {
      const range: Range = [-r[1], -r[0]];
      if (isSmall(o) && fitsLong(range)) {
        return { code: `(-${wrap(this.asLong(o, ctx))})`, repr: "long", range };
      }
      return { code: `${wrap(this.asBig(o, ctx))}.negate()`, repr: "big", range };
    }
    const range: Range = [-r[1] - 1n, -r[0] - 1n];
    if (isSmall(o) && fitsLong(range)) {
      return { code: `(~${wrap(this.asLong(o, ctx))})`, repr: "long", range };
    }
    return { code: `${wrap(this.asBig(o, ctx))}.not()`, repr: "big", range };
  }

  private binary(op: string, le: IrExpr, re: IrExpr, t: IrValueType, ctx: ExprCtx): CExpr {
    const a = this.compile(le, ctx);
    const b = this.compile(re, ctx);
    if (op === "&&" || op === "||") return { code: `(${a.code} ${op} ${b.code})`, repr: "bool" };
    if (op === "==" || op === "!=") return { code: this.equality(op, a, b, ctx), repr: "bool" };
    if (op === "<" || op === "<=" || op === ">" || op === ">=") {
      return { code: this.relational(op, a, b, ctx), repr: "bool" };
    }
    return this.arith(op, a, b, t, ctx);
  }

  cond(t: CExpr, a: CExpr, b: CExpr, ctx: ExprCtx): CExpr {
    const range =
      a.range && b.range
        ? ([minB(a.range[0], b.range[0]), maxB(a.range[1], b.range[1])] as Range)
        : undefined;
    const mk = (code: string, repr: Repr): CExpr => {
      const c: CExpr = { code: `(${t.code} ? ${code})`, repr };
      if (range) c.range = range;
      return c;
    };
    if (isInt(a) && isInt(b)) {
      if (a.repr === "big" || b.repr === "big" || (a.repr === "u64") !== (b.repr === "u64")) {
        if (a.repr === "u64" && b.repr === "u64") return mk(`${a.code} : ${b.code}`, "u64");
        const bothFit = range && fitsLong(range) && a.repr !== "u64" && b.repr !== "u64";
        if (bothFit) return mk(`${this.asLong(a, ctx)} : ${this.asLong(b, ctx)}`, "long");
        if (
          (a.repr === "u64" && isSmall(b) && within(b.range, 0n, LMAX)) ||
          (b.repr === "u64" && isSmall(a) && within(a.range, 0n, LMAX))
        ) {
          return mk(`${this.asLongRaw(a, ctx)} : ${this.asLongRaw(b, ctx)}`, "u64");
        }
        return mk(`${this.asBig(a, ctx)} : ${this.asBig(b, ctx)}`, "big");
      }
      if (a.repr === "u64") return mk(`${a.code} : ${b.code}`, "u64");
      if (a.repr === "int" && b.repr === "int") return mk(`${a.code} : ${b.code}`, "int");
      return mk(`${this.asLong(a, ctx)} : ${this.asLong(b, ctx)}`, "long");
    }
    if (isFloat(a) || isFloat(b)) {
      if (a.repr === "f32" && b.repr === "f32") return mk(`${a.code} : ${b.code}`, "f32");
      return mk(`${this.asDouble(a, ctx)} : ${this.asDouble(b, ctx)}`, "f64");
    }
    return mk(`${a.code} : ${b.code}`, a.repr);
  }

  equality(op: "==" | "!=", a: CExpr, b: CExpr, ctx: ExprCtx): string {
    const neg = op === "!=";
    if (isInt(a) && isInt(b)) {
      if (isSmall(a) && isSmall(b)) return `(${a.code} ${op} ${b.code})`;
      if (a.repr === "u64" && b.repr === "u64") return `(${a.code} ${op} ${b.code})`;
      const u = a.repr === "u64" ? a : b.repr === "u64" ? b : undefined;
      const other = u === a ? b : a;
      if (u && isSmall(other)) {
        if (other.lit !== undefined) {
          if (other.lit < 0n) return neg ? "true" : "false";
          return `(${u.code} ${op} ${longLit(other.lit)})`;
        }
        if (within(other.range, 0n, LMAX)) return `(${u.code} ${op} ${this.asLong(other, ctx)})`;
      }
      if (u && other.repr === "big" && other.lit !== undefined) {
        if (other.lit < 0n || other.lit >= 1n << 64n) return neg ? "true" : "false";
        return `(${u.code} ${op} ${longLit(BigInt.asIntN(64, other.lit))})`;
      }
      return `${neg ? "!" : ""}${wrap(this.asBig(a, ctx))}.equals(${this.asBig(b, ctx)})`;
    }
    if ((isFloat(a) || isFloat(b)) && (isInt(a) || isFloat(a)) && (isInt(b) || isFloat(b))) {
      return `(${this.asDouble(a, ctx)} ${op} ${this.asDouble(b, ctx)})`;
    }
    if (a.repr === "bool" || a.repr === "endian") return `(${a.code} ${op} ${b.code})`;
    if (a.repr === "str" || b.repr === "str") {
      const [x, y] = b.code.startsWith('"') ? [b, a] : [a, b];
      return `${neg ? "!" : ""}${wrap(x.code)}.equals(${y.code})`;
    }
    if ((a.repr === "bytes" && b.repr === "list") || (a.repr === "list" && b.repr === "bytes")) {
      return `${neg ? "!" : ""}${ctx.use("Rt")}.equals(${a.code}, ${b.code})`;
    }
    if (a.repr === "bytes" || b.repr === "bytes") {
      return `${neg ? "!" : ""}${ctx.use("Arrays")}.equals(${a.code}, ${b.code})`;
    }
    if (a.repr === "enum" || b.repr === "enum") {
      return `${neg ? "!" : ""}${ctx.use("Objects")}.equals(${a.code}, ${b.code})`;
    }
    return `${neg ? "!" : ""}${ctx.use("Rt")}.equals(${a.code}, ${b.code})`;
  }

  relational(op: string, a: CExpr, b: CExpr, ctx: ExprCtx): string {
    if (isFloat(a) || isFloat(b))
      return `(${this.asDouble(a, ctx)} ${op} ${this.asDouble(b, ctx)})`;
    if (isSmall(a) && isSmall(b)) return `(${a.code} ${op} ${b.code})`;
    if ((a.repr === "u64" || b.repr === "u64") && isUnsigned(a) && isUnsigned(b)) {
      return `(${this.model.lang("Long")}.compareUnsigned(${this.asLongRaw(a, ctx)}, ${this.asLongRaw(b, ctx)}) ${op} 0)`;
    }
    return `(${wrap(this.asBig(a, ctx))}.compareTo(${this.asBig(b, ctx)}) ${op} 0)`;
  }

  /** A u64 or non-negative small value as raw bits. */
  private asLongRaw(c: CExpr, ctx: ExprCtx): string {
    if (c.repr === "u64") return c.code;
    return this.asLong(c, ctx);
  }

  private arith(op: string, a: CExpr, b: CExpr, t: IrValueType, ctx: ExprCtx): CExpr {
    if (t.kind === "float" || isFloat(a) || isFloat(b)) {
      if (!(op === "<<" || op === ">>" || op === "&" || op === "|" || op === "^")) {
        const x = this.asDouble(a, ctx);
        const y = this.asDouble(b, ctx);
        return { code: `(${x} ${op} ${y})`, repr: "f64" };
      }
    }
    const ra = a.range ?? FULL;
    const rb = b.range ?? FULL;
    const bothSmall = isSmall(a) && isSmall(b);
    const L = (c: CExpr): string => this.asLong(c, ctx);
    const B = (c: CExpr): string => this.asBig(c, ctx);
    switch (op) {
      case "+":
      case "-":
      case "*": {
        let range: Range;
        if (op === "+") range = [ra[0] + rb[0], ra[1] + rb[1]];
        else if (op === "-") range = [ra[0] - rb[1], ra[1] - rb[0]];
        else {
          const ps = [ra[0] * rb[0], ra[0] * rb[1], ra[1] * rb[0], ra[1] * rb[1]];
          range = [minB(...ps), maxB(...ps)];
        }
        if (bothSmall && fitsLong(range)) {
          // Two ints: widen the left operand so the operation happens in long.
          const left = a.repr === "int" && b.repr === "int" ? L(a) : a.code;
          return { code: `(${left} ${op} ${b.code})`, repr: "long", range };
        }
        const m = op === "+" ? "add" : op === "-" ? "subtract" : "multiply";
        return { code: `${wrap(B(a))}.${m}(${B(b)})`, repr: "big", range };
      }
      case "/": {
        const m = maxB(absB(ra[0]), absB(ra[1]));
        const range: Range = [-m, m];
        if (bothSmall && fitsLong(range)) {
          if (b.lit !== undefined && b.lit !== 0n) {
            return { code: `(${L(a)} / ${b.code})`, repr: "long", range };
          }
          return { code: `${ctx.use("Ints")}.div(${L(a)}, ${L(b)})`, repr: "long", range };
        }
        return { code: `${ctx.use("Ints")}.div(${B(a)}, ${B(b)})`, repr: "big", range };
      }
      case "%": {
        const mb = maxB(absB(rb[0]), absB(rb[1]));
        const ma = maxB(absB(ra[0]), absB(ra[1]));
        const m = minB(ma, mb > 0n ? mb - 1n : 0n);
        const range: Range = [ra[0] < 0n ? -m : 0n, m];
        if (bothSmall && fitsLong(ra) && fitsLong(rb)) {
          if (b.lit !== undefined && b.lit !== 0n) {
            return { code: `(${L(a)} % ${b.code})`, repr: "long", range };
          }
          return { code: `${ctx.use("Ints")}.mod(${L(a)}, ${L(b)})`, repr: "long", range };
        }
        return { code: `${ctx.use("Ints")}.mod(${B(a)}, ${B(b)})`, repr: "big", range };
      }
      case "<<": {
        const maxShift = b.lit !== undefined ? b.lit : rb[1] > 63n ? 63n : rb[1];
        const minShift = b.lit !== undefined ? b.lit : rb[0] < 0n ? 0n : rb[0];
        const f1 = 1n << (maxShift < 0n ? 0n : maxShift);
        const f0 = 1n << (minShift < 0n ? 0n : minShift);
        const ps = [ra[0] * f1, ra[0] * f0, ra[1] * f1, ra[1] * f0];
        const range: Range = [minB(...ps), maxB(...ps)];
        if (isSmall(a) && fitsLong(range) && b.lit !== undefined && b.lit >= 0n && b.lit <= 63n) {
          return { code: `(${L(a)} << ${b.lit})`, repr: "long", range };
        }
        if (isSmall(a) && fitsLong(range) && isSmall(b)) {
          return { code: `${ctx.use("Ints")}.shl(${L(a)}, ${L(b)})`, repr: "long", range };
        }
        const n = isSmall(b) ? L(b) : B(b);
        return { code: `${ctx.use("Ints")}.shl(${B(a)}, ${n})`, repr: "big", range };
      }
      case ">>": {
        const range: Range = [ra[0] < 0n ? ra[0] : 0n, ra[1] > 0n ? ra[1] : 0n];
        if (isSmall(a)) {
          if (b.lit !== undefined && b.lit >= 0n && b.lit <= 63n) {
            return { code: `(${L(a)} >> ${b.lit})`, repr: "long", range };
          }
          if (isSmall(b))
            return { code: `${ctx.use("Ints")}.shr(${L(a)}, ${L(b)})`, repr: "long", range };
        }
        if (a.repr === "u64" && b.lit !== undefined && b.lit >= 1n && b.lit <= 63n) {
          return { code: `(${a.code} >>> ${b.lit})`, repr: "long", range: [0n, ra[1] >> b.lit] };
        }
        const n = isSmall(b) ? L(b) : B(b);
        return { code: `${ctx.use("Ints")}.shr(${B(a)}, ${n})`, repr: "big", range };
      }
      case "&":
      case "|":
      case "^": {
        if (bothSmall) {
          const range = bitwiseRange(op, ra, rb, intRange(64, true));
          const left = a.repr === "int" && b.repr === "int" ? L(a) : a.code;
          return { code: `(${left} ${op} ${b.code})`, repr: "long", range };
        }
        if (a.repr === "u64" && b.repr === "u64") {
          return {
            code: `(${a.code} ${op} ${b.code})`,
            repr: "u64",
            range: [0n, (1n << 64n) - 1n]
          };
        }
        if (isUnsigned(a) && isUnsigned(b) && (a.repr === "u64" || b.repr === "u64")) {
          if (op === "&") {
            const small = a.repr === "u64" ? b : a;
            return {
              code: `(${this.asLongRaw(a, ctx)} & ${this.asLongRaw(b, ctx)})`,
              repr: "long",
              range: [0n, small.range![1]]
            };
          }
          return {
            code: `(${this.asLongRaw(a, ctx)} ${op} ${this.asLongRaw(b, ctx)})`,
            repr: "u64",
            range: [0n, (1n << 64n) - 1n]
          };
        }
        const range = bitwiseRange(op, ra, rb, FULL);
        const m = op === "&" ? "and" : op === "|" ? "or" : "xor";
        return { code: `${wrap(B(a))}.${m}(${B(b)})`, repr: "big", range };
      }
    }
    throw new Error(`unknown operator ${op}`);
  }

  /** An extern fn call: host failures become CODEC errors. */
  private externCall(e: Extract<IrExpr, { kind: "call" }>, id: string, ctx: ExprCtx): CExpr {
    const x = this.model.extern(id);
    const params = x.kind === "fn" ? x.params : [];
    const args = e.args.map((a, i) => {
      const c = this.compile(a, ctx);
      const p = params[i];
      return p ? this.to(c, p.type, ctx) : c.code;
    });
    const ret = x.kind === "fn" ? x.returns : e.type;
    const fn = CALLS[this.model.javaValueType(ret, false)] ?? "call";
    return this.typed(
      `${ctx.use("Rt")}.${fn}(() -> ${ctx.externCall(id, args)}, ${str(x.name)})`,
      ret
    );
  }

  /** `min`/`max` of several values (or, with one array argument, of its elements). */
  private minMax(e: Extract<IrExpr, { kind: "call" }>, name: "min" | "max", ctx: ExprCtx): CExpr {
    const Ints = ctx.use("Ints");
    // over one array, or one byte string (`u8` arrays)
    const one = e.args.length === 1 ? e.args[0]!.type.kind : undefined;
    if (one === "array" || one === "bytes") {
      const a = this.compile(e.args[0]!, ctx);
      if (e.type.kind === "float")
        return { code: `${Ints}.${name}OfDouble(${a.code})`, repr: "f64" };
      return {
        code: `${Ints}.${name}Of(${a.code})`,
        repr: "big",
        range: this.rangeOf(e.type) ?? FULL
      };
    }
    const xs = e.args.map(a => this.compile(a, ctx));
    const fold = (conv: (x: CExpr) => string, fn: string): string =>
      xs.slice(1).reduce((code, x) => `${fn}(${code}, ${conv(x)})`, conv(xs[0]!));
    const math = `${this.model.lang("Math")}.${name}`;
    if (xs.some(isFloat)) return { code: fold(x => this.asDouble(x, ctx), math), repr: "f64" };
    const ranges = xs.map(x => x.range ?? FULL);
    const pick = name === "min" ? minB : maxB;
    const range: Range = [pick(...ranges.map(r => r[0])), pick(...ranges.map(r => r[1]))];
    if (xs.every(isSmall))
      return { code: fold(x => this.asLong(x, ctx), math), repr: "long", range };
    return { code: fold(x => this.asBig(x, ctx), `${Ints}.${name}`), repr: "big", range };
  }

  private call(e: Extract<IrExpr, { kind: "call" }>, ctx: ExprCtx): CExpr {
    if (e.callee.kind === "extern") return this.externCall(e, e.callee.extern, ctx);
    const name = e.callee.name;
    const fieldArg = (): string => {
      const a = e.args[0];
      if (a && a.kind === "this") return "this";
      if (!a || a.kind !== "field") throw new Error(`${name}() needs a field argument`);
      return a.name;
    };
    const Ints = (): string => ctx.use("Ints");
    switch (name) {
      case "sum": {
        const a = this.compile(e.args[0]!, ctx);
        if (e.type.kind === "float") return { code: `${Ints()}.sumDouble(${a.code})`, repr: "f64" };
        return {
          code: `${Ints()}.sum(${a.code})`,
          repr: "big",
          range: this.rangeOf(e.type) ?? FULL
        };
      }
      case "lengths": {
        const a = this.compile(e.args[0]!, ctx);
        return { code: `${Ints()}.lengths(${a.code})`, repr: "list", listElem: "Long" };
      }
      case "sizeof":
        return { code: ctx.sizeof(fieldArg()), repr: "int", range: [0n, LEN_MAX] };
      case "offsetof":
        return { code: ctx.offsetof(fieldArg()), repr: "long", range: [-LEN_MAX, LEN_MAX] };
      case "encodedSize": {
        const k = e.args[1];
        const layer =
          k && k.kind === "literal" && k.value.kind === "int" ? Number(k.value.value) : 0;
        return { code: ctx.encodedSize(fieldArg(), layer), repr: "int", range: [0n, LEN_MAX] };
      }
      case "bytesof":
        return { code: ctx.bytesof(fieldArg()), repr: "bytes" };
      case "encode":
        return { code: ctx.encode(fieldArg()), repr: "bytes" };
      case "crc32":
      case "adler32": {
        const a = this.compile(e.args[0]!, ctx);
        return {
          code: `${ctx.use("Checksums")}.${name}(${a.code})`,
          repr: "long",
          range: [0n, (1n << 32n) - 1n]
        };
      }
      case "min":
      case "max":
        return this.minMax(e, name, ctx);
      case "abs": {
        const x = this.compile(e.args[0]!, ctx);
        if (isFloat(x))
          return { code: `${this.model.lang("Math")}.abs(${this.asDouble(x, ctx)})`, repr: "f64" };
        const r = x.range ?? FULL;
        const m = maxB(absB(r[0]), absB(r[1]));
        if (isSmall(x) && m <= LMAX)
          return {
            code: `${this.model.lang("Math")}.abs(${this.asLong(x, ctx)})`,
            repr: "long",
            range: [0n, m]
          };
        return { code: `${wrap(this.asBig(x, ctx))}.abs()`, repr: "big", range: [0n, m] };
      }
      case "round": {
        const x = this.compile(e.args[0]!, ctx);
        const tr = this.rangeOf(e.type) ?? FULL;
        if (fitsLong(tr))
          return { code: `${Ints()}.round(${this.asDouble(x, ctx)})`, repr: "long", range: tr };
        return { code: `${Ints()}.roundBig(${this.asDouble(x, ctx)})`, repr: "big", range: tr };
      }
      case "indexOf": {
        const arr = this.compile(e.args[0]!, ctx);
        const v = this.compile(e.args[1]!, ctx);
        return {
          code: `${ctx.use("Rt")}.indexOf(${arr.code}, ${v.code})`,
          repr: "long",
          range: [0n, LEN_MAX]
        };
      }
      case "len": {
        const a = this.compile(e.args[0]!, ctx);
        if (a.repr === "str") {
          const a0 = e.args[0]!;
          const ft = a0.kind === "field" ? ctx.fieldType(a0.name) : undefined;
          const st = ft && storageType(ft);
          const enc = st?.kind === "string" ? st.encoding : "utf8";
          return {
            code: `${ctx.use("Encoding")}.${enc.toUpperCase()}.codeUnits(${a.code})`,
            repr: "long",
            range: [0n, LEN_MAX]
          };
        }
        if (a.repr === "bytes")
          return { code: `${wrap(a.code)}.length`, repr: "int", range: [0n, LEN_MAX] };
        return { code: `${wrap(a.code)}.size()`, repr: "int", range: [0n, LEN_MAX] };
      }
      case "encodedLength": {
        const s = this.compile(e.args[0]!, ctx);
        const encArg = e.args[2];
        const enc =
          encArg && encArg.kind === "literal" && encArg.value.kind === "string"
            ? encArg.value.value
            : "utf8";
        return {
          code: `${ctx.use("Encoding")}.${enc.toUpperCase()}.encodedBytes(${s.code})`,
          repr: "long",
          range: [0n, LEN_MAX * 4n]
        };
      }
      case "isNull": {
        // Nullable values are references.
        const a = this.compile(e.args[0]!, ctx);
        return { code: `(${a.code} == null)`, repr: "bool" };
      }
      case "map":
      case "filter":
      case "indicesWhere":
      case "sortedBy":
      case "unique":
      case "concat":
        return this.derivedBytes(e, this.derivedArray(e, name, ctx), ctx);
    }
    throw new Error(`unsupported builtin ${String(name)}`);
  }

  /** Compiles a lambda's body with its parameter in scope; `render` turns it into Java. */
  private lambda(l: IrExpr | undefined, ctx: ExprCtx, render: (body: CExpr) => string): string {
    if (!l || l.kind !== "lambda") throw new Error("expected a lambda argument");
    const p = `$l${++this.lambdas}`;
    const saved = this.lambdaScope.get(l.param);
    this.lambdaScope.set(l.param, { code: p, type: l.type });
    try {
      return `${p} -> ${render(this.compile(l.body, ctx))}`;
    } finally {
      if (saved) this.lambdaScope.set(l.param, saved);
      else this.lambdaScope.delete(l.param);
    }
  }

  /** A value boxed as a sort key: numbers (u64 as BigInteger), strings, bytes, booleans. */
  private sortKey(c: CExpr, ctx: ExprCtx): string {
    if (c.repr === "u64") return `${ctx.use("Ints")}.u64(${c.code})`;
    return c.code;
  }

  /**
   * A derived array whose IR type is `bytes` (`filter`/`sortedBy`/`unique` of bytes, `concat` of
   * bytes; IR.md §6) is a `byte[]` in Java: the computed list is converted (range checked).
   */
  private derivedBytes(e: Extract<IrExpr, { kind: "call" }>, c: CExpr, ctx: ExprCtx): CExpr {
    if (e.type.kind !== "bytes" || c.repr !== "list") return c;
    return { code: `${ctx.use("Lists")}.bytes(${c.code})`, repr: "bytes" };
  }

  /** Derived arrays: `map`, `filter`, `indicesWhere`, `sortedBy`, `unique`, `concat`. */
  private derivedArray(e: Extract<IrExpr, { kind: "call" }>, name: string, ctx: ExprCtx): CExpr {
    const L = ctx.use("Lists");
    const elemOf = (t: IrValueType): IrValueType | undefined =>
      t.kind === "array" ? t.element : t.kind === "nullable" ? elemOf(t.inner) : undefined;
    const outElem = elemOf(e.type);
    const boxedOut = outElem ? this.model.javaValueType(outElem, true) : "Object";
    // u8 arrays are byte[]: the builtins see them as lists of their (unsigned) values.
    const asList = (c: CExpr): CExpr =>
      c.repr === "bytes" ? { code: `${L}.of(${c.code})`, repr: "list", listElem: "Integer" } : c;
    const arr = (): CExpr => asList(this.compile(e.args[0]!, ctx));
    switch (name) {
      case "map": {
        const a = arr();
        const f = this.lambda(e.args[1], ctx, b => (outElem ? this.to(b, outElem, ctx) : b.code));
        return {
          code: `${wrap(a.code)}.stream().map(${f}).toList()`,
          repr: "list",
          listElem: boxedOut
        };
      }
      case "filter": {
        const a = arr();
        const f = this.lambda(e.args[1], ctx, b => b.code);
        return { code: `${wrap(a.code)}.stream().filter(${f}).toList()`, repr: "list" };
      }
      case "indicesWhere": {
        const a = arr();
        const f = this.lambda(e.args[1], ctx, b => b.code);
        return { code: `${L}.indicesWhere(${a.code}, ${f})`, repr: "list", listElem: "Long" };
      }
      case "sortedBy": {
        const a = arr();
        const f = this.lambda(e.args[1], ctx, b => this.sortKey(b, ctx));
        return { code: `${L}.sortedBy(${a.code}, ${f})`, repr: "list" };
      }
      case "unique":
        return { code: `${L}.unique(${arr().code})`, repr: "list" };
      case "concat": {
        const parts = e.args.map(a => asList(this.compile(a, ctx)).code);
        if (e.type.kind !== "array") {
          return { code: `${L}.concat(${parts.join(", ")})`, repr: "list", listElem: "Object" };
        }
        const jt = this.model.javaValueType(e.type);
        return {
          code: `${ctx.use("Rt")}.<${jt}>cast(${L}.concat(${parts.join(", ")}))`,
          repr: "list"
        };
      }
    }
    throw new Error(`unsupported builtin ${name}`);
  }

  /**
   * A list value as a list of the Java element type of `t` (lists computed by builtins may hold
   * other element types; integer elements are range checked).
   */
  private toList(c: CExpr, t: Extract<IrValueType, { kind: "array" }>, ctx: ExprCtx): string {
    const want = this.model.javaValueType(t.element, true);
    if (c.listElem === undefined || c.listElem === want) return c.code;
    const el = t.element;
    if (el.kind === "int") {
      const P = `${ctx.use("Prim")}.${el.signed ? "I" : "U"}${el.bits}`;
      const fn = javaIntKind(el.bits, el.signed) === "int" ? "ints" : "longs";
      return `${ctx.use("Lists")}.${fn}(${c.code}, ${P})`;
    }
    return `${ctx.use("Rt")}.<${this.model.javaValueType(t)}>cast(${c.code})`;
  }
}
