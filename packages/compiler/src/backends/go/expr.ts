/**
 * IR expressions → Go expressions, implementing the integer semantics of docs/IR.md §6.
 *
 * Integer subexpressions carry a value range (interval analysis). Arithmetic is done in int64 when
 * every operand and the result provably fit, in uint64 when they are non-negative and fit, and
 * with *big.Int (through yaffle.Big… helpers) otherwise. Every binary expression is emitted in
 * parentheses, which keeps the output stable under gofmt.
 */
import type { IrExpr, IrLiteral, IrType, IrValueType } from "../../ir/index.ts";
import { goStr, local, stripParens } from "./code.ts";
import { stripType } from "./irutil.ts";
import { BackendError, intGo, type Model } from "./model.ts";

export type Range = [bigint, bigint];
export type Kind = "int" | "float" | "bool" | "str" | "bytes" | "enum" | "endian" | "other";

export interface CExpr {
  code: string;
  /** Go type of `code`: a Go type name, "untyped" (integer literal) or "big" (*big.Int). */
  gt: string;
  kind: Kind;
  range?: Range | undefined;
  lit?: bigint | undefined;
  /** Evaluation can't fail and has no side effects. */
  safe?: boolean | undefined;
}

export const LEN_MAX = 1n << 36n;
const I64: Range = [-(1n << 63n), (1n << 63n) - 1n];
const U64: Range = [0n, (1n << 64n) - 1n];
const SAFE53: Range = [-((1n << 53n) - 1n), (1n << 53n) - 1n];
const FULL: Range = [-(1n << 64n), 1n << 64n];

export function intRange(bits: number, signed: boolean): Range {
  const b = BigInt(bits);
  return signed ? [-(1n << (b - 1n)), (1n << (b - 1n)) - 1n] : [0n, (1n << b) - 1n];
}

function within(r: Range | undefined, lo: bigint, hi: bigint): boolean {
  return r !== undefined && r[0] >= lo && r[1] <= hi;
}
const inI64 = (r: Range | undefined): boolean => within(r, I64[0], I64[1]);
const inU64 = (r: Range | undefined): boolean => within(r, U64[0], U64[1]);
function minB(...xs: bigint[]): bigint {
  return xs.reduce((a, b) => (b < a ? b : a));
}
function maxB(...xs: bigint[]): bigint {
  return xs.reduce((a, b) => (b > a ? b : a));
}
function absB(x: bigint): bigint {
  return x < 0n ? -x : x;
}

function intE(code: string, gt: string, range: Range, safe?: boolean): CExpr {
  return { code, gt, kind: "int", range, safe };
}

function boolE(code: string, safe?: boolean): CExpr {
  return { code, gt: "bool", kind: "bool", safe };
}

function floatE(code: string, safe?: boolean): CExpr {
  return { code, gt: "float64", kind: "float", safe };
}

/** A length or position: a Go `int` from 0 to LEN_MAX. */
function lenE(code: string, safe?: boolean): CExpr {
  return intE(code, "int", [0n, LEN_MAX], safe);
}

const GO_INTS: Record<string, Range> = {
  int8: intRange(8, true),
  int16: intRange(16, true),
  int32: intRange(32, true),
  int64: I64,
  int: I64,
  uint8: intRange(8, false),
  uint16: intRange(16, false),
  uint32: intRange(32, false),
  uint64: U64
};

function isGoInt(gt: string): boolean {
  return gt in GO_INTS;
}

/** Context in which an expression is compiled (read side or write side). */
export interface ExprCtx {
  mode: "read" | "write";
  field(name: string, type: IrValueType): CExpr;
  param(name: string, type: IrValueType): CExpr;
  it(type: IrValueType): CExpr;
  /** Code of a lambda parameter (an `int`). */
  lambda(name: string): string;
  /** `$offset`, `$end`, `$index` (Go `int` code). */
  builtin(name: "offset" | "end" | "index"): string;
  sizeof(field: string): string;
  offsetof(field: string): string;
  encodedSize(field: string, layer: number): string;
  bytesof(field: string): string;
  encode(field: string): string;
  /** Go identifier of an extern implementation. */
  externFn(id: string): string;
  /** Hoists a package-level variable and returns its name. */
  hoist(code: string, hint: string): string;
  /** Records an import the code needs. */
  use(pkg: string): void;
  /** IR type of a field (for len() of strings). */
  fieldType(name: string): IrType | undefined;
}

export class ExprCompiler {
  readonly model: Model;
  /** Parameters of the lambdas being compiled, innermost last. */
  private readonly lambdas: Map<string, CExpr>[] = [];
  private lambdaCount = 0;
  constructor(model: Model) {
    this.model = model;
  }

  /** Compiles f with the lambda's parameter bound to a Go parameter of IR type t. */
  private withLambda<T>(lam: IrExpr, elem: IrValueType, f: (param: string, body: IrExpr) => T): T {
    if (lam.kind !== "lambda") throw new BackendError("expected a lambda argument");
    // A distinct name: the body may also use struct parameters or temporaries.
    const name = `${local(lam.param)}_${++this.lambdaCount}`;
    this.lambdas.push(new Map([[lam.param, this.typed(name, elem)]]));
    try {
      return f(name, lam.body);
    } finally {
      this.lambdas.pop();
    }
  }

  rangeOf(t: IrValueType): Range | undefined {
    if (t.kind === "int") return intRange(t.bits, t.signed);
    if (t.kind === "bigint") return I64;
    if (t.kind === "extern") return this.rangeOf(t.valueType);
    if (t.kind === "enum") {
      const st = this.model.enum(t.enum).storage;
      return intRange(Number(st.slice(1)), st[0] === "i");
    }
    return undefined;
  }

  kindOf(t: IrValueType): Kind {
    switch (t.kind) {
      case "int":
      case "bigint":
        return "int";
      case "float":
        return "float";
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
      case "extern":
        return this.kindOf(t.valueType);
      default:
        return "other";
    }
  }

  /** Wraps a typed Go value (field, param, it) of IR value type t. */
  typed(code: string, t: IrValueType, safe = true): CExpr {
    const c: CExpr = { code, gt: this.model.goValueType(t), kind: this.kindOf(t), safe };
    const r = t.kind === "enum" ? undefined : this.rangeOf(t);
    if (r) c.range = r;
    return c;
  }

  // ── conversions ───────────────────────────────────────────────────────────

  /** As an int64 expression (the range must fit). Untyped literals stay bare unless `typed`. */
  asI64(c: CExpr, typed = false): string {
    if (c.gt === "int64") return c.code;
    if (c.gt === "untyped") return typed ? `int64(${c.code})` : c.code;
    if (c.gt === "big") return `${c.code}.Int64()`;
    return `int64(${c.code})`;
  }

  asU64(c: CExpr, typed = false): string {
    if (c.gt === "uint64") return c.code;
    if (c.gt === "untyped") return typed ? `uint64(${c.code})` : c.code;
    if (c.gt === "big") return `${c.code}.Uint64()`;
    return `uint64(${c.code})`;
  }

  asBig(c: CExpr, ctx: ExprCtx): string {
    if (c.gt === "big") return c.code;
    if (c.gt === "untyped") {
      if (inI64(c.range)) return `yaffle.BigI(${c.code})`;
      return ctx.hoist(`yaffle.BigLit(${goStr(String(c.lit))})`, "big");
    }
    if (c.gt === "uint64" || c.gt === "uint32" || c.gt === "uint16" || c.gt === "uint8")
      return `yaffle.BigU(${this.asU64(c)})`;
    return `yaffle.BigI(${this.asI64(c)})`;
  }

  asFloat(c: CExpr): string {
    if (c.gt === "float64") return c.code;
    if (c.gt === "big") return `yaffle.BigFloat(${c.code})`;
    return `float64(${c.code})`;
  }

  /** A non-negative Go `int` (lengths, counts). */
  asLen(c: CExpr, what = "length"): string {
    return this.asInt(c, 0n, "yaffle.Len", what);
  }

  /** A Go `int` (offsets, positions). */
  asOffset(c: CExpr, what = "offset"): string {
    return this.asInt(c, SAFE53[0], "yaffle.Off", what);
  }

  /**
   * A Go `int` from lo to 2^53 - 1: a plain conversion when the range proves it, otherwise a
   * checking helper (`check`, `checkU`, `checkBig` by the operand's representation).
   */
  private asInt(c: CExpr, lo: bigint, check: string, what: string): string {
    if (c.kind !== "int") throw new BackendError(`${what} of kind ${c.kind}`);
    if (within(c.range, lo, SAFE53[1])) {
      if (c.gt === "int" || c.gt === "untyped") return c.code;
      if (c.gt === "big") return `int(${c.code}.Int64())`;
      return `int(${c.code})`;
    }
    const w = goStr(what);
    if (c.gt === "uint64") return `${check}U(${c.code}, ${w})`;
    if (c.gt !== "big" && (inI64(c.range) || isGoInt(c.gt) || c.gt === "untyped"))
      return `${check}(${this.asI64(c, true)}, ${w})`;
    return `${check}Big(${c.code}, ${w})`;
  }

  /**
   * Converts to the Go representation of a destination value type, with a RANGE check when the
   * value's range doesn't provably fit.
   */
  to(c: CExpr, t: IrValueType, ctx: ExprCtx, what = "value"): string {
    const want = this.model.goValueType(t);
    if ((t.kind === "array" || t.kind === "bytes") && c.gt.startsWith("[]") && c.gt !== want)
      return this.convArray(c, t, ctx, what);
    if (t.kind === "int" || t.kind === "bigint") {
      if (c.kind === "float") return this.intFromFloat(c, t, ctx);
      if (c.kind === "enum") return `${want}(${c.code})`;
      if (c.kind !== "int") return c.code;
      const r = t.kind === "int" ? intRange(t.bits, t.signed) : I64;
      return this.intTo(c, want, r, ctx, what);
    }
    if (t.kind === "float") {
      if (c.gt === want) return c.code;
      if (want === "float64") return this.asFloat(c);
      return `float32(${this.asFloat(c)})`;
    }
    if (t.kind === "enum") {
      if (c.kind === "enum") return c.code;
      if (c.kind === "int") {
        const st = this.model.enum(t.enum).storage;
        const inner = this.intTo(
          c,
          intGo(Number(st.slice(1)), st[0] === "i"),
          intRange(Number(st.slice(1)), st[0] === "i"),
          ctx,
          what
        );
        return `${want}(${inner})`;
      }
      return c.code;
    }
    if (t.kind === "extern") return this.to(c, t.valueType, ctx, what);
    return c.code;
  }

  /** An array converted element-wise to another integer element type (range-checked). */
  private convArray(c: CExpr, t: IrValueType, ctx: ExprCtx, what: string): string {
    const want = this.model.goValueType(t);
    const from = c.gt.slice(2) === "byte" ? "uint8" : c.gt.slice(2);
    const to = want.slice(2) === "byte" ? "uint8" : want.slice(2);
    if (from === to) return c.code;
    const elem: IrValueType =
      t.kind === "bytes"
        ? { kind: "int", bits: 8, signed: false }
        : (t as { element: IrValueType }).element;
    if (!isGoInt(from) || !(elem.kind === "int" || elem.kind === "bigint"))
      throw new BackendError(`cannot convert ${c.gt} to ${want}`);
    const e: CExpr = { code: "e", gt: from, kind: "int", range: GO_INTS[from]!, safe: true };
    const conv = this.to(e, elem, ctx, what);
    return `yaffle.Map(${c.code}, func(e ${from}) ${to} { return ${conv} })`;
  }

  /** An integer CExpr converted to Go int type `want` with range [lo, hi]. */
  intTo(c: CExpr, want: string, r: Range, ctx: ExprCtx, what = "value"): string {
    if (within(c.range, r[0], r[1])) {
      if (c.gt === want) return c.code;
      if (c.gt === "big")
        return r[0] < 0n || inI64(r) ? `${want}(${c.code}.Int64())` : `${want}(${c.code}.Uint64())`;
      return `${want}(${c.code})`;
    }
    const w = goStr(what);
    const lo = r[0];
    const hi = r[1];
    if (c.gt === "big") {
      return hi > I64[1]
        ? `${want}(yaffle.BigToU64(${c.code}, ${hi}, ${w}))`
        : `${want}(yaffle.BigToI64(${c.code}, ${lit64(lo)}, ${lit64(hi)}, ${w}))`;
    }
    if (c.gt === "uint64" || (c.range && c.range[1] > I64[1])) {
      const u = c.gt === "uint64" ? c.code : this.asU64(c, true);
      if (!inU64(c.range) && c.gt !== "uint64")
        return this.intTo({ ...c, code: this.asBig(c, ctx), gt: "big" }, want, r, ctx, what);
      return hi > I64[1]
        ? `${want}(yaffle.CheckU64(${u}, ${hi}, ${w}))`
        : `${want}(yaffle.U64ToI64(${u}, ${lit64(hi)}, ${w}))`;
    }
    const i = this.asI64(c, true);
    if (hi > I64[1]) return `${want}(yaffle.I64ToU64(${i}, ${hi}, ${w}))`;
    const call = `yaffle.CheckI64(${i}, ${lit64(lo)}, ${lit64(hi)}, ${w})`;
    return want === "int64" ? call : `${want}(${call})`;
  }

  private intFromFloat(c: CExpr, t: IrValueType, ctx: ExprCtx): string {
    const want = this.model.goValueType(t);
    const r = t.kind === "int" ? intRange(t.bits, t.signed) : I64;
    return this.intTo(intE(`yaffle.Trunc(${this.asFloat(c)})`, "int64", I64), want, r, ctx);
  }

  // ── compile ───────────────────────────────────────────────────────────────

  compile(e: IrExpr, ctx: ExprCtx): CExpr {
    switch (e.kind) {
      case "literal":
        return this.literal(e.value, ctx);
      case "field":
        return ctx.field(e.name, e.type);
      case "param":
        return ctx.param(e.name, e.type);
      case "it":
        return ctx.it(e.type);
      case "lambdaParam": {
        for (let i = this.lambdas.length - 1; i >= 0; i--) {
          const hit = this.lambdas[i]!.get(e.name);
          if (hit) return hit;
        }
        return lenE(ctx.lambda(e.name), true);
      }
      case "builtinValue":
        return intE(ctx.builtin(e.name), "int", [e.name === "index" ? -1n : 0n, LEN_MAX], true);
      case "member":
        return this.member(e.object, e.name, e.type, ctx);
      case "index": {
        const o = this.compile(e.object, ctx);
        const i = this.compile(e.index, ctx);
        return this.typed(`yaffle.At(${o.code}, ${this.asI64(i, true)})`, e.type, false);
      }
      case "map": {
        const o = this.compile(e.array, ctx);
        const ev = e.array.type.kind === "array" ? e.array.type.element : undefined;
        if (!ev || ev.kind !== "struct") throw new BackendError("map over a non-struct array");
        const s = this.model.struct(ev.struct);
        const g = this.model.goField(s, e.field);
        const elemGt = this.model.goValueType(e.type.kind === "array" ? e.type.element : e.type);
        const get = g.ptr ? `yaffle.Get(x.${g.go}, ${goStr(e.field)})` : `x.${g.go}`;
        return {
          code: `yaffle.Map(${o.code}, func(x *${this.model.structName(ev.struct)}) ${elemGt} { return ${get} })`,
          gt: `[]${elemGt}`,
          kind: "other"
        };
      }
      case "unary":
        return this.unary(e.op, this.compile(e.operand, ctx), e.type, ctx);
      case "binary":
        return this.binary(e.op, e.left, e.right, e.type, ctx);
      case "cond":
        return this.cond(e, ctx);
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
        if (!parts.length) return boolE("false", true);
        return boolE(parts.length === 1 ? parts[0]! : `(${parts.join(" || ")})`, v.safe);
      }
      case "regex": {
        const v = this.compile(e.value, ctx);
        ctx.use("regexp");
        const re = ctx.hoist(`regexp.MustCompile(${goStr(`^(?:${e.pattern})$`)})`, "re");
        return boolE(`${re}.MatchString(${v.code})`, v.safe);
      }
      case "lambda":
        throw new BackendError(
          "a lambda is only valid as an argument of map/filter/indicesWhere/sortedBy"
        );
      case "this":
        throw new BackendError(
          "`this` is only valid as the argument of sizeof/offsetof/bytesof/encode"
        );
      case "convert":
        return this.convert(e.operand, e.type, ctx);
    }
  }

  private member(object: IrExpr, name: string, type: IrValueType, ctx: ExprCtx): CExpr {
    const o = this.compile(object, ctx);
    let ot = object.type;
    while (ot.kind === "nullable") ot = ot.inner;
    if (ot.kind !== "struct") throw new BackendError(`member ${name} of a non-struct value`);
    const s = this.model.struct(ot.struct);
    const g = this.model.goField(s, name);
    const access = `${o.code}.${g.go}`;
    const code = g.ptr ? `yaffle.Get(${access}, ${goStr(name)})` : access;
    return this.typed(code, type, false);
  }

  literal(v: IrLiteral, ctx: ExprCtx): CExpr {
    switch (v.kind) {
      case "int": {
        const b = BigInt(v.value);
        // Beyond 64 bits: a hoisted *big.Int; otherwise an untyped Go constant.
        const big = b < I64[0] || b > U64[1];
        const code = big ? ctx.hoist(`yaffle.BigLit(${goStr(v.value)})`, "big") : formatInt(b);
        return { ...intE(code, big ? "big" : "untyped", [b, b], true), lit: b };
      }
      case "float":
        return floatE(formatFloat(v.value, ctx), true);
      case "bool":
        return boolE(String(v.value), true);
      case "string":
        return { code: goStr(v.value), gt: "string", kind: "str", safe: true };
      case "bytes":
        return {
          code: ctx.hoist(bytesLiteral(v.hex), "bytes"),
          gt: "[]byte",
          kind: "bytes",
          safe: true
        };
      case "endian":
        return {
          code: v.value === "be" ? "yaffle.BE" : "yaffle.LE",
          gt: "yaffle.Endian",
          kind: "endian",
          safe: true
        };
      case "enum":
        return {
          code: this.model.enumMember(v.enum, v.member),
          gt: this.model.enumName(v.enum),
          kind: "enum",
          safe: true
        };
    }
  }

  private convert(operand: IrExpr, t: IrValueType, ctx: ExprCtx): CExpr {
    const o = this.compile(operand, ctx);
    if (o.kind === "enum" && (t.kind === "int" || t.kind === "bigint")) {
      const st = this.model.enum(operand.type.kind === "enum" ? operand.type.enum : "").storage;
      const bits = Number(st.slice(1));
      const gt = intGo(bits, st[0] === "i");
      return intE(`${gt}(${o.code})`, gt, intRange(bits, st[0] === "i"), o.safe);
    }
    if (t.kind === "float") {
      if (o.kind === "float" && o.gt !== "float32") return o;
      return floatE(this.asFloat(o), o.safe);
    }
    if (t.kind === "int" || t.kind === "bigint") {
      if (o.kind !== "float") return o;
      const range = this.rangeOf(t) ?? I64;
      return intE(`yaffle.Trunc(${this.asFloat(o)})`, "int64", inI64(range) ? range : I64);
    }
    if (t.kind === "enum" && o.kind === "int") {
      return {
        code: this.to(o, t, ctx),
        gt: this.model.enumName(t.enum),
        kind: "enum",
        safe: o.safe
      };
    }
    return o;
  }

  private unary(op: "-" | "!" | "~", o: CExpr, t: IrValueType, ctx: ExprCtx): CExpr {
    if (op === "!") return boolE(`!${wrap(o.code)}`, o.safe);
    if (o.kind === "float" || t.kind === "float")
      return floatE(`(-${wrap(this.asFloat(o))})`, o.safe);
    const r = o.range ?? FULL;
    if (op === "-") {
      const range: Range = [-r[1], -r[0]];
      if (o.lit !== undefined && inI64(range))
        return { ...intE(formatInt(-o.lit), "untyped", range, true), lit: -o.lit };
      if (inI64(r) && inI64(range))
        return intE(`(-${wrap(this.asI64(o, true))})`, "int64", range, o.safe);
      return intE(`yaffle.BigNeg(${this.asBig(o, ctx)})`, "big", range, o.safe);
    }
    const range: Range = [-r[1] - 1n, -r[0] - 1n];
    if (inI64(r)) return intE(`(^${wrap(this.asI64(o, true))})`, "int64", range, o.safe);
    return intE(`yaffle.BigNot(${this.asBig(o, ctx)})`, "big", range, o.safe);
  }

  private binary(op: string, le: IrExpr, re: IrExpr, t: IrValueType, ctx: ExprCtx): CExpr {
    const a = this.compile(le, ctx);
    const b = this.compile(re, ctx);
    const safe = (a.safe ?? false) && (b.safe ?? false);
    if (op === "&&" || op === "||") return boolE(`(${a.code} ${op} ${b.code})`, safe);
    if (op === "==" || op === "!=") return boolE(this.equality(op, a, b, ctx), safe);
    if (op === "<" || op === "<=" || op === ">" || op === ">=")
      return boolE(this.relational(op, a, b, ctx), safe);
    const r = this.arith(op, a, b, t, ctx);
    if (
      safe &&
      (op === "+" || op === "-" || op === "*" || op === "&" || op === "|" || op === "^") &&
      r.gt !== "big"
    )
      r.safe = true;
    return r;
  }

  equality(op: "==" | "!=", a: CExpr, b: CExpr, ctx: ExprCtx): string {
    if (a.kind === "int" && b.kind === "int") return this.intCompare(op, a, b, ctx);
    if ((a.kind === "int" || a.kind === "float") && (b.kind === "int" || b.kind === "float"))
      return `(${this.asFloat(a)} ${op} ${this.asFloat(b)})`;
    if (a.kind === "bytes" && b.kind === "bytes") {
      ctx.use("bytes");
      return `${op === "!=" ? "!" : ""}bytes.Equal(${a.code}, ${b.code})`;
    }
    // Composite values compare by value (docs/IR.md §6).
    if (a.kind === "bytes" || b.kind === "bytes" || a.kind === "other" || b.kind === "other")
      return `${op === "!=" ? "!" : ""}yaffle.Equal(${a.code}, ${b.code})`;
    if (a.kind === "enum" && b.kind === "int")
      return `(${a.code} ${op} ${this.to(b, { kind: "int", bits: 64, signed: true }, ctx)})`;
    return `(${a.code} ${op} ${b.code})`;
  }

  relational(op: string, a: CExpr, b: CExpr, ctx: ExprCtx): string {
    if (a.kind === "int" && b.kind === "int") return this.intCompare(op, a, b, ctx);
    if ((a.kind === "int" || a.kind === "float") && (b.kind === "int" || b.kind === "float"))
      return `(${this.asFloat(a)} ${op} ${this.asFloat(b)})`;
    return `(${a.code} ${op} ${b.code})`;
  }

  private intCompare(op: string, a: CExpr, b: CExpr, ctx: ExprCtx): string {
    if (a.gt === b.gt && isGoInt(a.gt)) return `(${a.code} ${op} ${b.code})`;
    if (
      a.gt === "untyped" &&
      isGoInt(b.gt) &&
      within(a.range, GO_INTS[b.gt]![0], GO_INTS[b.gt]![1])
    )
      return `(${a.code} ${op} ${b.code})`;
    if (
      b.gt === "untyped" &&
      isGoInt(a.gt) &&
      within(b.range, GO_INTS[a.gt]![0], GO_INTS[a.gt]![1])
    )
      return `(${a.code} ${op} ${b.code})`;
    if (inI64(a.range) && inI64(b.range) && a.gt !== "big" && b.gt !== "big")
      return `(${this.asI64(a, b.gt === "untyped")} ${op} ${this.asI64(b)})`;
    if (inU64(a.range) && inU64(b.range) && a.gt !== "big" && b.gt !== "big")
      return `(${this.asU64(a, b.gt === "untyped")} ${op} ${this.asU64(b)})`;
    return `(yaffle.BigCmp(${this.asBig(a, ctx)}, ${this.asBig(b, ctx)}) ${op} 0)`;
  }

  /** Common representation of integer operands and a result. */
  private rep(
    ranges: (Range | undefined)[],
    result: Range,
    ops: CExpr[]
  ): "int64" | "uint64" | "big" {
    if (ops.some(o => o.gt === "big")) return "big";
    if (ranges.every(r => inI64(r)) && inI64(result)) return "int64";
    if (ranges.every(r => inU64(r)) && inU64(result)) return "uint64";
    return "big";
  }

  private operand(c: CExpr, rep: "int64" | "uint64", typed: boolean): string {
    return rep === "int64" ? this.asI64(c, typed) : this.asU64(c, typed);
  }

  private arith(op: string, a: CExpr, b: CExpr, t: IrValueType, ctx: ExprCtx): CExpr {
    if (t.kind === "float" || a.kind === "float" || b.kind === "float") {
      if (op === "%") return floatE(`yaffle.FMod(${this.asFloat(a)}, ${this.asFloat(b)})`);
      return floatE(`(${this.asFloat(a)} ${op} ${this.asFloat(b)})`);
    }
    const ra = a.range ?? FULL;
    const rb = b.range ?? FULL;
    const bothUntyped = a.gt === "untyped" && b.gt === "untyped";
    const big = (fn: string, range: Range): CExpr =>
      intE(`yaffle.${fn}(${this.asBig(a, ctx)}, ${this.asBig(b, ctx)})`, "big", range);
    const infix = (rep: "int64" | "uint64", range: Range, typedA = bothUntyped): CExpr =>
      intE(`(${this.operand(a, rep, typedA)} ${op} ${this.operand(b, rep, false)})`, rep, range);
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
        const rep = this.rep([ra, rb], range, [a, b]);
        if (rep === "big")
          return big(op === "+" ? "BigAdd" : op === "-" ? "BigSub" : "BigMul", range);
        return infix(rep, range);
      }
      case "/":
      case "%": {
        const ma = maxB(absB(ra[0]), absB(ra[1]));
        let range: Range;
        if (op === "/") range = [ra[0] < 0n || rb[0] < 0n ? -ma : 0n, ma];
        else {
          const mb = maxB(absB(rb[0]), absB(rb[1]));
          const m = minB(ma, mb > 0n ? mb - 1n : 0n);
          range = [ra[0] < 0n ? -m : 0n, m];
        }
        const rep = this.rep([ra, rb], range, [a, b]);
        if (rep === "big") return big(op === "/" ? "BigDiv" : "BigMod", range);
        // A non-zero literal divisor needs no zero check.
        if (b.lit !== undefined && b.lit !== 0n) return infix(rep, range, true);
        const fn = `yaffle.${op === "/" ? "Div" : "Mod"}${rep === "int64" ? "" : "U"}`;
        return intE(
          `${fn}(${this.operand(a, rep, false)}, ${this.operand(b, rep, false)})`,
          rep,
          range
        );
      }
      case "<<":
      case ">>": {
        let range: Range;
        if (op === "<<") {
          const clamp = (x: bigint): bigint => (x > 63n ? 63n : x < 0n ? 0n : x);
          const f1 = 1n << (b.lit ?? clamp(rb[1]));
          const f0 = 1n << (b.lit ?? clamp(rb[0]));
          const ps = [ra[0] * f1, ra[0] * f0, ra[1] * f1, ra[1] * f0];
          range = [minB(...ps), maxB(...ps)];
        } else range = [ra[0] < 0n ? ra[0] : 0n, ra[1] > 0n ? ra[1] : 0n];
        const rep = this.rep([ra], range, [a]);
        if (rep === "big") {
          const fn = op === "<<" ? "yaffle.BigShl" : "yaffle.BigShr";
          return intE(`${fn}(${this.asBig(a, ctx)}, ${this.asI64(b, true)})`, "big", range);
        }
        const litShift = b.lit !== undefined && b.lit >= 0n && b.lit <= 63n;
        const count = litShift ? String(b.lit) : `yaffle.ShiftCount(${this.asI64(b, true)})`;
        return intE(`(${this.operand(a, rep, true)} ${op} ${count})`, rep, range);
      }
      case "&":
      case "|":
      case "^": {
        let range: Range = I64;
        if (op === "&" && (ra[0] >= 0n || rb[0] >= 0n)) {
          range = [
            0n,
            ra[0] >= 0n && rb[0] >= 0n ? minB(ra[1], rb[1]) : ra[0] >= 0n ? ra[1] : rb[1]
          ];
        } else if (ra[0] >= 0n && rb[0] >= 0n) {
          const hi = maxB(ra[1], rb[1]);
          let p = 1n;
          while (p <= hi) p <<= 1n;
          range = [0n, p - 1n];
        } else if (!inI64(ra) || !inI64(rb)) {
          range = [I64[0], U64[1]];
        }
        let rep: "int64" | "uint64" | "big";
        if (a.gt === "big" || b.gt === "big") rep = "big";
        else if (inI64(ra) && inI64(rb)) rep = "int64";
        else if (inU64(ra) && inU64(rb)) rep = "uint64";
        else rep = "big";
        if (rep === "big")
          return big(op === "&" ? "BigAnd" : op === "|" ? "BigOr" : "BigXor", range);
        return infix(rep, range);
      }
    }
    throw new BackendError(`unknown operator ${op}`);
  }

  private cond(e: Extract<IrExpr, { kind: "cond" }>, ctx: ExprCtx): CExpr {
    const t = this.compile(e.test, ctx);
    const a = this.compile(e.then, ctx);
    const b = this.compile(e.else, ctx);
    let ac: string;
    let bc: string;
    let gt: string;
    let kind: Kind = a.kind;
    let range: Range | undefined;
    if (a.kind === "int" && b.kind === "int") {
      range = [
        minB((a.range ?? FULL)[0], (b.range ?? FULL)[0]),
        maxB((a.range ?? FULL)[1], (b.range ?? FULL)[1])
      ];
      const rep = this.rep([a.range, b.range], range, [a, b]);
      if (rep === "big") {
        ac = this.asBig(a, ctx);
        bc = this.asBig(b, ctx);
        gt = "big";
      } else {
        ac = this.operand(a, rep, true);
        bc = this.operand(b, rep, true);
        gt = rep;
      }
    } else if (
      (a.kind === "float" || a.kind === "int") &&
      (b.kind === "float" || b.kind === "int")
    ) {
      ac = this.asFloat(a);
      bc = this.asFloat(b);
      gt = "float64";
      kind = "float";
    } else {
      ac = a.code;
      bc = b.code;
      gt = a.gt === "untyped" ? b.gt : a.gt;
    }
    const goT = gt === "big" ? "*big.Int" : gt;
    const safe = t.safe && a.safe && b.safe;
    let code: string;
    if (safe) code = `yaffle.If(${stripParens(t.code)}, ${ac}, ${bc})`;
    else {
      if (gt === "big") ctx.use("math/big");
      code = `yaffle.Cond(${stripParens(t.code)}, func() ${goT} { return ${ac} }, func() ${goT} { return ${bc} })`;
    }
    const out: CExpr = { code, gt, kind, safe };
    if (range) out.range = range;
    return out;
  }

  /** map/filter/indicesWhere/sortedBy(array, x => …). */
  private derivedArray(name: string, e: Extract<IrExpr, { kind: "call" }>, ctx: ExprCtx): CExpr {
    const arr = this.compile(e.args[0]!, ctx);
    const at = e.args[0]!.type;
    const lam = e.args[1]!;
    const elemVt: IrValueType =
      lam.kind === "lambda"
        ? lam.type
        : at.kind === "array"
          ? at.element
          : { kind: "int", bits: 8, signed: false };
    if (!arr.gt.startsWith("[]")) throw new BackendError(`${name}() of a non-array value`);
    const elemGo = arr.gt.slice(2);
    return this.withLambda(lam, elemVt, (p, body) => {
      const b = this.compile(body, ctx);
      switch (name) {
        case "map": {
          const out = e.type.kind === "array" ? e.type.element : body.type;
          const R = this.model.goValueType(out);
          return {
            code: `yaffle.Map(${arr.code}, func(${p} ${elemGo}) ${R} { return ${this.to(b, out, ctx, "element")} })`,
            gt: `[]${R}`,
            kind: "other"
          };
        }
        case "filter":
          return {
            code: `yaffle.Filter(${arr.code}, func(${p} ${elemGo}) bool { return ${stripParens(b.code)} })`,
            gt: arr.gt,
            kind: arr.kind
          };
        case "indicesWhere":
          return {
            code: `yaffle.IndicesWhere(${arr.code}, func(${p} ${elemGo}) bool { return ${stripParens(b.code)} })`,
            gt: "[]int64",
            kind: "other"
          };
        default: {
          // sortedBy: numbers, strings (code points) or bytes (lexicographic).
          let fn = "yaffle.SortedBy";
          let K: string;
          let key: string;
          if (b.kind === "int" || b.kind === "enum") {
            const ki: CExpr =
              b.kind === "enum"
                ? { ...b, code: `int64(${b.code})`, gt: "int64", kind: "int", range: I64 }
                : b;
            if (ki.gt === "big" || !(inI64(ki.range) || inU64(ki.range))) {
              fn = "yaffle.SortedByBig";
              K = "*big.Int";
              key = this.asBig(ki, ctx);
              ctx.use("math/big");
            } else if (inI64(ki.range)) {
              K = "int64";
              key = this.asI64(ki, true);
            } else {
              K = "uint64";
              key = this.asU64(ki, true);
            }
          } else if (b.kind === "float") {
            K = "float64";
            key = this.asFloat(b);
          } else if (b.kind === "str") {
            K = "string";
            key = b.code;
          } else if (b.kind === "bytes") {
            fn = "yaffle.SortedByBytes";
            K = "[]byte";
            key = b.code;
          } else throw new BackendError("sortedBy() keys must be numbers, strings or bytes");
          return {
            code: `${fn}(${arr.code}, func(${p} ${elemGo}) ${K} { return ${stripParens(key)} })`,
            gt: arr.gt,
            kind: arr.kind
          };
        }
      }
    });
  }

  private call(e: Extract<IrExpr, { kind: "call" }>, ctx: ExprCtx): CExpr {
    if (e.callee.kind === "extern") {
      const x = this.model.extern(e.callee.extern);
      const params = x.kind === "fn" ? x.params : [];
      const args = e.args.map((a, i) => {
        const c = this.compile(a, ctx);
        const p = params[i];
        return p ? this.to(c, p.type, ctx, "argument") : c.code;
      });
      const ret = x.kind === "fn" ? x.returns : e.type;
      const rt = this.model.goValueType(ret);
      return this.typed(
        `yaffle.CallFn(${goStr(x.name)}, func() ${rt} { return ${ctx.externFn(e.callee.extern)}(${args.join(", ")}) })`,
        ret,
        false
      );
    }
    const name = e.callee.name;
    const fieldArg = (): string => {
      const a = e.args[0] as { kind: string; name?: string } | undefined;
      if (a && a.kind === "this") return "this";
      if (!a || a.kind !== "field" || a.name === undefined)
        throw new BackendError(`${name}() needs a field argument`);
      return a.name;
    };
    // over one array, or one byte string (`u8` arrays)
    const oneArray =
      e.args.length === 1 && (e.args[0]!.type.kind === "array" || e.args[0]!.type.kind === "bytes");
    switch (name as string) {
      case "sizeof":
        return lenE(ctx.sizeof(fieldArg()));
      case "offsetof":
        return lenE(ctx.offsetof(fieldArg()));
      case "encodedSize": {
        const k = e.args[1];
        const layer =
          k && k.kind === "literal" && k.value.kind === "int" ? Number(k.value.value) : 0;
        return lenE(ctx.encodedSize(fieldArg(), layer));
      }
      case "bytesof":
        return { code: ctx.bytesof(fieldArg()), gt: "[]byte", kind: "bytes" };
      case "encode":
        return { code: ctx.encode(fieldArg()), gt: "[]byte", kind: "bytes" };
      case "crc32":
      case "adler32": {
        const a = this.compile(e.args[0]!, ctx);
        const fn = name === "crc32" ? "yaffle.Crc32" : "yaffle.Adler32";
        const arg = a.kind === "str" ? `yaffle.Utf8(${a.code})` : a.code;
        return intE(`${fn}(${arg})`, "uint32", [0n, (1n << 32n) - 1n]);
      }
      case "sum": {
        const a = this.compile(e.args[0]!, ctx);
        const et = e.args[0]!.type.kind === "array" ? e.args[0]!.type.element : undefined;
        if (et?.kind === "float") return floatE(`yaffle.SumF(${a.code})`);
        const unsigned = et?.kind === "int" && !et.signed;
        if (unsigned && et.bits > 32)
          return intE(`yaffle.SumU(${a.code})`, "big", [0n, 1n << 100n]);
        return intE(`yaffle.Sum(${a.code})`, "int64", unsigned ? [0n, I64[1]] : I64);
      }
      case "map":
      case "filter":
      case "indicesWhere":
      case "sortedBy":
        return this.derivedArray(name, e, ctx);
      case "isNull": {
        // A nullable value is a Go pointer or a nil-able slice.
        const a = this.compile(e.args[0]!, ctx);
        return boolE(`(${a.code} == nil)`, a.safe);
      }
      case "unique": {
        const a = this.compile(e.args[0]!, ctx);
        return { code: `yaffle.Unique(${a.code})`, gt: a.gt, kind: a.kind };
      }
      case "concat": {
        const want = this.model.goValueType(e.type);
        const parts = e.args.map(x => {
          const c = this.compile(x, ctx);
          return c.gt === want ? c.code : this.to(c, e.type, ctx, "element");
        });
        return {
          code: `yaffle.Concat(${parts.join(", ")})`,
          gt: want,
          kind: this.kindOf(e.type)
        };
      }
      case "lengths": {
        const a = this.compile(e.args[0]!, ctx);
        return { code: `yaffle.Lengths(${a.code})`, gt: "[]int64", kind: "other" };
      }
      case "min":
      case "max": {
        if (oneArray) {
          const a = this.compile(e.args[0]!, ctx);
          const fn = name === "min" ? "yaffle.MinOf" : "yaffle.MaxOf";
          return this.typed(`${fn}(${a.code})`, e.type, false);
        }
        const xs = e.args.map(a => this.compile(a, ctx));
        const safe = xs.every(x => x.safe);
        if (xs.some(x => x.kind === "float"))
          return floatE(`${name}(${xs.map(x => this.asFloat(x)).join(", ")})`, safe);
        const ranges = xs.map(x => x.range ?? FULL);
        const range: Range =
          name === "min"
            ? [minB(...ranges.map(r => r[0])), minB(...ranges.map(r => r[1]))]
            : [maxB(...ranges.map(r => r[0])), maxB(...ranges.map(r => r[1]))];
        const rep = this.rep(ranges, range, xs);
        if (rep === "big") {
          let code = this.asBig(xs[0]!, ctx);
          const fn = name === "min" ? "yaffle.BigMin" : "yaffle.BigMax";
          for (const x of xs.slice(1)) code = `${fn}(${code}, ${this.asBig(x, ctx)})`;
          return intE(code, "big", range);
        }
        const allUntyped = xs.every(x => x.gt === "untyped");
        const args = xs.map((x, i) => this.operand(x, rep, allUntyped && i === 0));
        return intE(`${name}(${args.join(", ")})`, rep, range, safe);
      }
      case "abs": {
        const x = this.compile(e.args[0]!, ctx);
        if (x.kind === "float") return floatE(`yaffle.AbsF(${this.asFloat(x)})`);
        const r = x.range ?? FULL;
        const m = maxB(absB(r[0]), absB(r[1]));
        if (inI64(r) && m <= I64[1])
          return intE(`yaffle.Abs64(${this.asI64(x, true)})`, "int64", [0n, m]);
        return intE(`yaffle.BigAbs(${this.asBig(x, ctx)})`, "big", [0n, m]);
      }
      case "round": {
        const x = this.compile(e.args[0]!, ctx);
        const tr = this.rangeOf(e.type) ?? I64;
        if (inI64(tr)) return intE(`yaffle.Round(${this.asFloat(x)})`, "int64", tr);
        return intE(`yaffle.RoundBig(${this.asFloat(x)})`, "big", tr);
      }
      case "indexOf": {
        const arr = this.compile(e.args[0]!, ctx);
        const v = this.compile(e.args[1]!, ctx);
        const elem = arr.gt.startsWith("[]") ? arr.gt.slice(2) : undefined;
        let vc = v.code;
        const et = e.args[0]!.type.kind === "array" ? e.args[0]!.type.element : undefined;
        if (elem && v.gt !== elem && et) vc = this.to(v, et, ctx);
        return intE(`yaffle.IndexOf(${arr.code}, ${vc})`, "int64", [0n, LEN_MAX]);
      }
      case "len": {
        const a0 = e.args[0]!;
        const a = this.compile(a0, ctx);
        if (a.kind === "str") {
          let enc = "utf8";
          if (a0.kind === "field") {
            const ft = stripType(ctx.fieldType(a0.name));
            if (ft && ft.kind === "string") enc = ft.encoding;
          }
          return intE(`yaffle.CodeUnits(${a.code}, ${encConst(enc)})`, "int64", [0n, LEN_MAX]);
        }
        return lenE(`len(${a.code})`, a.safe);
      }
      case "encodedLength": {
        const s = this.compile(e.args[0]!, ctx);
        const encArg = e.args[2];
        const enc =
          encArg && encArg.kind === "literal" && encArg.value.kind === "string"
            ? encArg.value.value
            : "utf8";
        return intE(`yaffle.EncodedLen(${s.code}, ${encConst(enc)})`, "int64", [0n, LEN_MAX]);
      }
    }
    throw new BackendError(`unsupported builtin ${String(name)}`);
  }
}

export function encConst(enc: string): string {
  switch (enc) {
    case "utf8":
      return "yaffle.UTF8";
    case "ascii":
      return "yaffle.ASCII";
    case "latin1":
      return "yaffle.Latin1";
    case "utf16":
      return "yaffle.UTF16";
    case "utf32":
      return "yaffle.UTF32";
  }
  throw new BackendError(`unknown encoding ${enc}`);
}

function wrap(code: string): string {
  return /^[A-Za-z0-9_.]+$/.test(code) || (/^\(.*\)$/.test(code) && stripParens(code) !== code)
    ? code
    : `(${code})`;
}

function lit64(b: bigint): string {
  return b === I64[0] ? b.toString() : formatInt(b);
}

export function formatInt(b: bigint): string {
  const a = absB(b);
  if (a >= 0x10000n && (a & 0xffn) === 0n) return (b < 0n ? "-0x" : "0x") + a.toString(16);
  if (a >= 256n && (a & (a - 1n)) === 0n) return (b < 0n ? "-0x" : "0x") + a.toString(16);
  return b.toString();
}

export function formatFloat(x: number, ctx?: ExprCtx): string {
  if (Number.isNaN(x) || !Number.isFinite(x) || Object.is(x, -0)) {
    ctx?.use("math");
    if (Number.isNaN(x)) return "math.NaN()";
    if (Object.is(x, -0)) return "math.Copysign(0, -1)";
    return x > 0 ? "math.Inf(1)" : "math.Inf(-1)";
  }
  const s = String(x);
  return /[.e]/.test(s) ? s : `${s}.0`;
}

export function bytesLiteral(hex: string): string {
  const bytes: string[] = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(`0x${hex.slice(i, i + 2)}`);
  return `[]byte{${bytes.join(", ")}}`;
}
