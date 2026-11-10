/**
 * IR expressions → TypeScript expressions, implementing the integer semantics of docs/IR.md §6.
 *
 * Integer subexpressions carry a value range. When every operand is a `number` and the result
 * provably stays within ±2^53 the code computes in `number`; otherwise it computes in `bigint`.
 */
import type { IrExpr, IrLiteral, IrType, IrValueType } from "../../ir/index.ts";
import { group, str } from "./code.ts";
import { stripType, type Model } from "./model.ts";

export type Repr = "num" | "big" | "bool" | "str" | "bytes" | "other";
export type Range = [bigint, bigint];

export interface CExpr {
  code: string;
  repr: Repr;
  /** Integer range (num/big integer expressions). Floats have no range. */
  range?: Range;
  /** True for float-valued numbers. */
  float?: boolean;
  /** Set for integer literals. */
  lit?: bigint;
}

const SAFE = (1n << 53n) - 1n;
const LEN_MAX = 1n << 36n;

function intRange(bits: number, signed: boolean): Range {
  const b = BigInt(bits);
  return signed ? [-(1n << (b - 1n)), (1n << (b - 1n)) - 1n] : [0n, (1n << b) - 1n];
}

const FULL: Range = [-(1n << 64n), 1n << 64n];

function fits(r: Range | undefined): boolean {
  return r !== undefined && r[0] >= -SAFE && r[1] <= SAFE;
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

/** Context in which an expression is compiled (read side or write side). */
export interface ExprCtx {
  mode: "read" | "write";
  /** Code for a field reference. */
  field(name: string, type: IrValueType): CExpr;
  param(name: string, type: IrValueType): CExpr;
  it(type: IrValueType): CExpr;
  lambda(name: string): string;
  /** `$offset`, `$end`, `$index` (numbers). */
  builtin(name: "offset" | "end" | "index"): string;
  /** sizeof/offsetof/encodedSize/bytesof/encode of a field (field name). */
  sizeof(field: string): string;
  offsetof(field: string): string;
  encodedSize(field: string, layer: number): string;
  bytesof(field: string): string;
  encode(field: string): string;
  /** Local name of an imported extern implementation. */
  externFn(id: string): string;
  /** Hoists a module-level constant and returns its name. */
  hoist(code: string, hint: string): string;
  /** IR type of a field (for len() of strings). */
  fieldType(name: string): IrType | undefined;
}

/** A context for expressions that read no fields (literals, parameter defaults). */
export function constCtx(mod: {
  extern(id: string): string;
  hoist(code: string, hint: string): string;
}): ExprCtx {
  const none = (): CExpr => ({ code: "undefined", repr: "other" });
  return {
    mode: "read",
    field: none,
    param: none,
    it: none,
    lambda: n => n,
    builtin: () => "0",
    sizeof: () => "0",
    offsetof: () => "0",
    encodedSize: () => "0",
    bytesof: () => "undefined",
    encode: () => "undefined",
    externFn: id => mod.extern(id),
    hoist: (code, hint) => mod.hoist(code, hint),
    fieldType: () => undefined
  };
}

export class ExprCompiler {
  readonly model: Model;
  constructor(model: Model) {
    this.model = model;
  }

  reprOf(t: IrValueType): Repr {
    switch (t.kind) {
      case "int":
        return t.bits > 48 ? "big" : "num";
      case "bigint":
        return "big";
      case "float":
        return "num";
      case "bool":
        return "bool";
      case "string":
        return "str";
      case "bytes":
        return "bytes";
      case "enum":
        return "other";
      case "extern":
        return this.reprOf(t.valueType);
      default:
        return "other";
    }
  }

  rangeOf(t: IrValueType): Range | undefined {
    if (t.kind === "int") return intRange(t.bits, t.signed);
    if (t.kind === "bigint") return FULL;
    if (t.kind === "extern") return this.rangeOf(t.valueType);
    return undefined;
  }

  /** Call arguments, each converted to its parameter's type when it has one. */
  args(args: readonly IrExpr[], params: readonly { type: IrValueType }[], ctx: ExprCtx): string[] {
    return args.map((a, i) => {
      const c = this.compile(a, ctx);
      const p = params[i];
      return p ? this.to(c, p.type) : c.code;
    });
  }

  /** Wraps a typed value (field, param, it) as a CExpr. */
  typed(code: string, t: IrValueType): CExpr {
    const repr = this.reprOf(t);
    const c: CExpr = { code, repr };
    const r = this.rangeOf(t);
    if (r) c.range = r;
    if (t.kind === "float") c.float = true;
    return c;
  }

  // ── conversions ───────────────────────────────────────────────────────────

  asNum(c: CExpr): string {
    if (c.repr === "big") {
      if (c.lit !== undefined && absB(c.lit) <= SAFE) return String(c.lit);
      return c.float ? `Number(${c.code})` : `$rt.num(${c.code})`;
    }
    return c.code;
  }

  asBig(c: CExpr): string {
    if (c.repr === "big") return c.code;
    if (c.lit !== undefined) return `${c.lit}n`;
    return `BigInt(${c.code})`;
  }

  /** A non-negative safe integer number (lengths, counts). */
  asLen(c: CExpr, what = "length"): string {
    if (c.repr === "num" && within(c.range, 0n, SAFE)) return c.code;
    return `$rt.len(${c.code}, ${str(what)})`;
  }

  /** A safe integer number (offsets). */
  asOffset(c: CExpr): string {
    if (c.repr === "num" && fits(c.range)) return c.code;
    return `$rt.num(${c.code}, "offset")`;
  }

  /**
   * Like `to`, plus a RANGE check when the expression's static range may exceed an integer
   * destination type (e.g. a virtual field's computed value).
   */
  toChecked(c: CExpr, t: IrValueType, what: string): string {
    const code = this.to(c, t);
    const r = this.rangeOf(t);
    if (t.kind !== "int" || !r || within(c.range, r[0], r[1])) return code;
    return `$rt.inRange(${code}, ${r[0]}n, ${r[1]}n, ${str(what)})`;
  }

  /** Converts to the representation of a destination value type. */
  to(c: CExpr, t: IrValueType): string {
    const want = this.reprOf(t);
    if (want === "big" && c.repr === "num" && !c.float) return this.asBig(c);
    if (want === "num" && c.repr === "big") return this.asNum(c);
    if (t.kind === "float" && c.repr === "big") return `Number(${c.code})`;
    // A derived array written to a bytes field.
    if (want === "bytes" && c.repr === "other") return `$rt.toBytes(${c.code})`;
    return c.code;
  }

  // ── compile ───────────────────────────────────────────────────────────────

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
      case "lambdaParam":
        // Fill functions (`i => …`) take the padding byte index; other lambdas take an element.
        if (e.type.kind === "bigint")
          return { code: ctx.lambda(e.name), repr: "num", range: [0n, LEN_MAX] };
        return this.typed(ctx.lambda(e.name), e.type);
      case "builtinValue":
        return {
          code: ctx.builtin(e.name),
          repr: "num",
          range: [e.name === "index" ? -1n : 0n, LEN_MAX]
        };
      case "member": {
        const o = this.compile(e.object, ctx);
        return this.typed(`${o.code}${propAccess(e.name)}`, e.type);
      }
      case "index": {
        const o = this.compile(e.object, ctx);
        const i = this.compile(e.index, ctx);
        return this.typed(`$rt.at(${o.code}, ${this.asLen(i, "index")})`, e.type);
      }
      case "map": {
        const o = this.compile(e.array, ctx);
        return { code: `${o.code}.map(($e) => $e${propAccess(e.field)})`, repr: "other" };
      }
      case "unary":
        return this.unary(e.op, this.compile(e.operand, ctx), e.type);
      case "binary":
        return this.binary(e.op, e.left, e.right, e.type, ctx);
      case "cond": {
        const t = this.compile(e.test, ctx);
        const a = this.compile(e.then, ctx);
        const b = this.compile(e.else, ctx);
        if (a.repr === "big" || b.repr === "big") {
          const r: CExpr = {
            code: `(${t.code} ? ${this.asBig(a)} : ${this.asBig(b)})`,
            repr: "big"
          };
          if (a.range && b.range)
            r.range = [minB(a.range[0], b.range[0]), maxB(a.range[1], b.range[1])];
          return r;
        }
        const r: CExpr = { code: `(${t.code} ? ${a.code} : ${b.code})`, repr: a.repr };
        if (a.range && b.range)
          r.range = [minB(a.range[0], b.range[0]), maxB(a.range[1], b.range[1])];
        if (a.float || b.float) r.float = true;
        return r;
      }
      case "call":
        return this.call(e, ctx);
      case "in": {
        const v = this.compile(e.value, ctx);
        const parts = e.items.map(it => {
          if (it.kind === "value") return this.equality("==", v, this.compile(it.value, ctx));
          const lo = this.compile(it.low, ctx);
          const hi = this.compile(it.high, ctx);
          return `(${this.relational(">=", v, lo)} && ${this.relational("<=", v, hi)})`;
        });
        return { code: parts.length ? `(${parts.join(" || ")})` : "false", repr: "bool" };
      }
      case "regex": {
        const v = this.compile(e.value, ctx);
        const re = ctx.hoist(`new RegExp(${str(`^(?:${e.pattern})$`)}, "u")`, "re");
        return { code: `${re}.test(${v.code})`, repr: "bool" };
      }
      case "lambda": {
        // Lambdas only appear as arguments of map/filter/indicesWhere/sortedBy; compiled
        // standalone they are an arrow function returning the body.
        const l = this.lambda(e, ctx);
        return { code: `((${l.param}) => ${l.body.code})`, repr: "other" };
      }
      case "this":
        throw new Error("`this` is only valid as the argument of sizeof/offsetof/bytesof/encode");
      case "convert": {
        const o = this.compile(e.operand, ctx);
        if (e.operand.type.kind === "enum" && (e.type.kind === "int" || e.type.kind === "bigint")) {
          return this.enumToInt(e.operand.type.enum, o);
        }
        if (e.type.kind === "float") {
          return {
            code: o.repr === "big" ? `Number(${o.code})` : o.code,
            repr: "num",
            float: true
          };
        }
        if (e.type.kind === "int" || e.type.kind === "bigint") {
          if (o.float) {
            const r: CExpr = { code: `Math.trunc(${o.code})`, repr: "num" };
            const rr = this.rangeOf(e.type);
            if (rr) r.range = rr;
            return e.type.kind === "int" && e.type.bits > 48
              ? { code: `BigInt(${r.code})`, repr: "big", range: rr ?? FULL }
              : r;
          }
          if (e.type.kind === "int") {
            const want = this.reprOf(e.type);
            if (want === "big" && o.repr === "num")
              return { ...o, code: this.asBig(o), repr: "big" };
          }
          return o;
        }
        if (e.type.kind === "enum" && o.repr !== "other") {
          return {
            code: `${this.enumNames(e.type.enum)}.get(${o.code}) ?? ${o.code}`,
            repr: "other"
          };
        }
        return o;
      }
    }
  }

  private lambdaCount = 0;

  /** A lambda's parameter variable and compiled body (the body sees the enclosing context). */
  lambda(e: IrExpr, ctx: ExprCtx): { param: string; body: CExpr } {
    if (e.kind !== "lambda") throw new Error(`expected a lambda, got ${e.kind}`);
    const param = `$l${this.lambdaCount++}_${e.param.replace(/[^A-Za-z0-9_]/g, "_")}`;
    const name = e.param;
    const inner: ExprCtx = { ...ctx, lambda: n => (n === name ? param : ctx.lambda(n)) };
    return { param, body: this.compile(e.body, inner) };
  }

  enumNames(id: string): string {
    return `$enum_${this.model.enumName(id)}_names`;
  }

  enumValues(id: string): string {
    return `$enum_${this.model.enumName(id)}_values`;
  }

  enumToInt(id: string, o: CExpr): CExpr {
    const en = this.model.enum(id);
    const big = Number(en.storage.slice(1)) > 48;
    return {
      code: `$rt.enumValue(${this.enumValues(id)}, ${o.code})`,
      repr: big ? "big" : "num",
      range: intRange(Number(en.storage.slice(1)), en.storage[0] === "i")
    };
  }

  literal(v: IrLiteral, t: IrValueType, ctx: ExprCtx): CExpr {
    switch (v.kind) {
      case "int": {
        const b = BigInt(v.value);
        const big = (t.kind === "int" && t.bits > 48) || absB(b) > SAFE;
        return {
          code: big ? `${b}n` : formatInt(b),
          repr: big ? "big" : "num",
          range: [b, b],
          lit: b
        };
      }
      case "float":
        return { code: formatFloat(v.value), repr: "num", float: true };
      case "bool":
        return { code: String(v.value), repr: "bool" };
      case "string":
        return { code: str(v.value), repr: "str" };
      case "bytes":
        return { code: ctx.hoist(`$rt.fromHex(${str(v.hex)})`, "bytes"), repr: "bytes" };
      case "endian":
        return { code: str(v.value), repr: "other" };
      case "enum":
        return { code: str(v.member), repr: "other" };
    }
  }

  private unary(op: "-" | "!" | "~", o: CExpr, t: IrValueType): CExpr {
    if (op === "!") return { code: `!${group(o.code)}`, repr: "bool" };
    if (o.float || t.kind === "float")
      return { code: `(-${group(o.code)})`, repr: "num", float: true };
    const r = o.range ?? FULL;
    if (op === "-") {
      const range: Range = [-r[1], -r[0]];
      if (o.repr === "num" && fits(range))
        return { code: `(-${group(o.code)})`, repr: "num", range };
      return { code: `(-${group(this.asBig(o))})`, repr: "big", range };
    }
    const range: Range = [-r[1] - 1n, -r[0] - 1n];
    if (o.repr === "num" && fits(range))
      return { code: `(-${group(o.code)} - 1)`, repr: "num", range };
    return { code: `(~${group(this.asBig(o))})`, repr: "big", range };
  }

  private binary(op: string, le: IrExpr, re: IrExpr, t: IrValueType, ctx: ExprCtx): CExpr {
    if (op === "&&" || op === "||") {
      const a = this.compile(le, ctx);
      const b = this.compile(re, ctx);
      return { code: `(${a.code} ${op} ${b.code})`, repr: "bool" };
    }
    const a = this.compile(le, ctx);
    const b = this.compile(re, ctx);
    if (op === "==" || op === "!=") return { code: this.equality(op, a, b), repr: "bool" };
    if (op === "<" || op === "<=" || op === ">" || op === ">=") {
      return { code: this.relational(op, a, b), repr: "bool" };
    }
    return this.arith(op, a, b, t);
  }

  equality(op: "==" | "!=", a: CExpr, b: CExpr): string {
    const neg = op === "!=";
    if ((a.repr === "num" || a.repr === "big") && (b.repr === "num" || b.repr === "big")) {
      if (a.float || b.float) {
        return `(${this.asFloat(a)} ${neg ? "!==" : "==="} ${this.asFloat(b)})`;
      }
      if (a.repr === "big" || b.repr === "big") {
        return `(${this.asBig(a)} ${neg ? "!==" : "==="} ${this.asBig(b)})`;
      }
      return `(${a.code} ${neg ? "!==" : "==="} ${b.code})`;
    }
    const structural =
      a.repr === "bytes" ||
      b.repr === "bytes" ||
      (a.repr === "other" &&
        b.repr === "other" &&
        !isSimpleLiteral(a.code) &&
        !isSimpleLiteral(b.code));
    if (structural) return `${neg ? "!" : ""}$rt.equals(${a.code}, ${b.code})`;
    return `(${a.code} ${neg ? "!==" : "==="} ${b.code})`;
  }

  private asFloat(c: CExpr): string {
    return c.repr === "big" ? `Number(${c.code})` : c.code;
  }

  relational(op: string, a: CExpr, b: CExpr): string {
    if ((a.repr === "num" || a.repr === "big") && (b.repr === "num" || b.repr === "big")) {
      if (a.float || b.float) return `(${this.asFloat(a)} ${op} ${this.asFloat(b)})`;
      if (a.repr === "big" || b.repr === "big") return `(${this.asBig(a)} ${op} ${this.asBig(b)})`;
    }
    return `(${a.code} ${op} ${b.code})`;
  }

  private arith(op: string, a: CExpr, b: CExpr, t: IrValueType): CExpr {
    if (t.kind === "float" || a.float || b.float) {
      const x = this.asFloat(a);
      const y = this.asFloat(b);
      if (op === "<<" || op === ">>" || op === "&" || op === "|" || op === "^") {
        // Not meaningful for floats; fall through as integer ops on truncated values.
      } else {
        return { code: `(${x} ${op} ${y})`, repr: "num", float: true };
      }
    }
    const ra = a.range ?? FULL;
    const rb = b.range ?? FULL;
    const bothNum = a.repr === "num" && b.repr === "num";
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
        if (bothNum && fits(range))
          return { code: `(${a.code} ${op} ${b.code})`, repr: "num", range };
        return { code: `(${this.asBig(a)} ${op} ${this.asBig(b)})`, repr: "big", range };
      }
      case "/": {
        const m = maxB(absB(ra[0]), absB(ra[1]));
        const range: Range = [-m, m];
        if (bothNum && fits(range)) {
          if (b.lit !== undefined && b.lit > 0n) {
            return { code: `Math.trunc(${a.code} / ${b.code})`, repr: "num", range };
          }
          return { code: `$rt.div(${a.code}, ${b.code})`, repr: "num", range };
        }
        return { code: `$rt.divBig(${this.asBig(a)}, ${this.asBig(b)})`, repr: "big", range };
      }
      case "%": {
        const mb = maxB(absB(rb[0]), absB(rb[1]));
        const ma = maxB(absB(ra[0]), absB(ra[1]));
        const m = minB(ma, mb > 0n ? mb - 1n : 0n);
        const range: Range = [ra[0] < 0n ? -m : 0n, m];
        if (bothNum && fits(ra) && fits(rb)) {
          if (b.lit !== undefined && b.lit > 0n && ra[0] >= 0n) {
            return { code: `(${a.code} % ${b.code})`, repr: "num", range };
          }
          return { code: `$rt.mod(${a.code}, ${b.code})`, repr: "num", range };
        }
        return { code: `$rt.modBig(${this.asBig(a)}, ${this.asBig(b)})`, repr: "big", range };
      }
      case "<<": {
        const maxShift = b.lit !== undefined ? b.lit : rb[1] > 63n ? 63n : rb[1];
        const minShift = b.lit !== undefined ? b.lit : rb[0] < 0n ? 0n : rb[0];
        const f1 = 1n << maxShift;
        const f0 = 1n << minShift;
        const ps = [ra[0] * f1, ra[0] * f0, ra[1] * f1, ra[1] * f0];
        const range: Range = [minB(...ps), maxB(...ps)];
        if (a.repr === "num" && fits(range) && b.lit !== undefined && b.lit >= 0n && b.lit <= 63n) {
          return { code: `(${a.code} * ${formatInt(1n << b.lit)})`, repr: "num", range };
        }
        if (a.repr === "num" && fits(range)) {
          return { code: `$rt.shl(${a.code}, ${this.asNum(b)})`, repr: "num", range };
        }
        return { code: `$rt.shlBig(${this.asBig(a)}, ${this.asNum(b)})`, repr: "big", range };
      }
      case ">>": {
        const range: Range = [ra[0] < 0n ? ra[0] : 0n, ra[1] > 0n ? ra[1] : 0n];
        if (a.repr === "num" && fits(ra)) {
          if (
            b.lit !== undefined &&
            b.lit >= 0n &&
            b.lit <= 31n &&
            within(ra, 0n, (1n << 32n) - 1n)
          ) {
            return { code: `(${a.code} >>> ${b.lit})`, repr: "num", range };
          }
          if (b.lit !== undefined && b.lit >= 0n && b.lit <= 63n) {
            return {
              code: `Math.floor(${a.code} / ${formatInt(1n << b.lit)})`,
              repr: "num",
              range
            };
          }
          return { code: `$rt.shr(${a.code}, ${this.asNum(b)})`, repr: "num", range };
        }
        return { code: `$rt.shrBig(${this.asBig(a)}, ${this.asNum(b)})`, repr: "big", range };
      }
      case "&":
      case "|":
      case "^": {
        const U32: Range = [0n, (1n << 32n) - 1n];
        const I32: Range = [-(1n << 31n), (1n << 31n) - 1n];
        if (bothNum && within(ra, U32[0], U32[1]) && within(rb, U32[0], U32[1])) {
          const range: Range = op === "&" ? [0n, minB(ra[1], rb[1])] : U32;
          if (within(ra, 0n, I32[1]) && within(rb, 0n, I32[1])) {
            return {
              code: `(${a.code} ${op} ${b.code})`,
              repr: "num",
              range: op === "&" ? range : [0n, I32[1]]
            };
          }
          return { code: `((${a.code} ${op} ${b.code}) >>> 0)`, repr: "num", range };
        }
        if (bothNum && within(ra, I32[0], I32[1]) && within(rb, I32[0], I32[1])) {
          return { code: `(${a.code} ${op} ${b.code})`, repr: "num", range: I32 };
        }
        let range: Range = intRange(64, true);
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
        }
        return { code: `(${this.asBig(a)} ${op} ${this.asBig(b)})`, repr: "big", range };
      }
    }
    throw new Error(`unknown operator ${op}`);
  }

  private call(e: Extract<IrExpr, { kind: "call" }>, ctx: ExprCtx): CExpr {
    if (e.callee.kind === "extern") {
      const x = this.model.extern(e.callee.extern);
      const args = this.args(e.args, x.kind === "fn" ? x.params : [], ctx);
      const ret = x.kind === "fn" ? x.returns : e.type;
      return this.typed(
        `$rt.callHost(${ctx.externFn(e.callee.extern)}, ${str(x.name)}${args.map(a => ", " + a).join("")})`,
        ret
      );
    }
    const name = e.callee.name;
    const fieldArg = (): string => {
      const a = e.args[0] as { kind: string; name?: string } | undefined;
      // `this` (the current struct) is the extent named "this".
      if (a && a.kind === "this") return "this";
      if (!a || a.kind !== "field" || a.name === undefined)
        throw new Error(`${name}() needs a field argument`);
      return a.name;
    };
    // Aggregates over one array argument: min(arr), max(arr), sum(arr), lengths(arr).
    const aggregate = (fn: string): CExpr => {
      const a = this.compile(e.args[0]!, ctx);
      const r = this.reprOf(e.type);
      const code = `$rt.${fn}(${a.code})`;
      const c: CExpr = { code, repr: fn === "lengths" ? "other" : r };
      const range = this.rangeOf(e.type);
      if (range && fn !== "lengths") c.range = range;
      if (e.type.kind === "float") c.float = true;
      return c;
    };
    // over one array, or one byte string (`u8` arrays)
    const oneArray =
      e.args.length === 1 && (e.args[0]!.type.kind === "array" || e.args[0]!.type.kind === "bytes");
    switch (name as string) {
      case "sum":
        return aggregate(this.reprOf(e.type) === "big" ? "sumBig" : "sum");
      case "lengths":
        return aggregate("lengths");
      case "sizeof":
        return { code: ctx.sizeof(fieldArg()), repr: "num", range: [0n, LEN_MAX] };
      case "offsetof":
        return { code: ctx.offsetof(fieldArg()), repr: "num", range: [0n, LEN_MAX] };
      case "encodedSize": {
        const k = e.args[1];
        const layer =
          k && k.kind === "literal" && k.value.kind === "int" ? Number(k.value.value) : 0;
        return { code: ctx.encodedSize(fieldArg(), layer), repr: "num", range: [0n, LEN_MAX] };
      }
      case "bytesof":
        return { code: ctx.bytesof(fieldArg()), repr: "bytes" };
      case "encode":
        return { code: ctx.encode(fieldArg()), repr: "bytes" };
      case "crc32":
      case "adler32": {
        const a = this.compile(e.args[0]!, ctx);
        const code =
          a.repr === "str" ? `$rt.${name}($rt.utf8(${a.code}))` : `$rt.${name}(${a.code})`;
        return { code, repr: "num", range: [0n, (1n << 32n) - 1n] };
      }
      case "min":
      case "max": {
        if (oneArray) return aggregate(`${name}Of`);
        const xs = e.args.map(a => this.compile(a, ctx));
        const float = xs.some(x => x.float);
        if (float)
          return {
            code: `Math.${name}(${xs.map(x => this.asFloat(x)).join(", ")})`,
            repr: "num",
            float: true
          };
        const big = xs.some(x => x.repr === "big");
        const ranges = xs.map(x => x.range ?? FULL);
        const range: Range =
          name === "min"
            ? [minB(...ranges.map(r => r[0])), minB(...ranges.map(r => r[1]))]
            : [maxB(...ranges.map(r => r[0])), maxB(...ranges.map(r => r[1]))];
        if (!big)
          return { code: `Math.${name}(${xs.map(x => x.code).join(", ")})`, repr: "num", range };
        let code = this.asBig(xs[0]!);
        for (const x of xs.slice(1)) code = `$rt.${name}(${code}, ${this.asBig(x)})`;
        return { code, repr: "big", range };
      }
      case "abs": {
        const x = this.compile(e.args[0]!, ctx);
        if (x.float) return { code: `Math.abs(${x.code})`, repr: "num", float: true };
        const r = x.range ?? FULL;
        const m = maxB(absB(r[0]), absB(r[1]));
        if (x.repr === "num") return { code: `Math.abs(${x.code})`, repr: "num", range: [0n, m] };
        return { code: `$rt.absBig(${x.code})`, repr: "big", range: [0n, m] };
      }
      case "round": {
        const x = this.compile(e.args[0]!, ctx);
        const tr = this.rangeOf(e.type) ?? FULL;
        const code = `$rt.round(${this.asFloat(x)})`;
        if (this.reprOf(e.type) === "big")
          return { code: `BigInt(${code})`, repr: "big", range: tr };
        return { code, repr: "num", range: tr };
      }
      case "indexOf": {
        const arr = this.compile(e.args[0]!, ctx);
        const v = this.compile(e.args[1]!, ctx);
        return { code: `$rt.indexOf(${arr.code}, ${v.code})`, repr: "num", range: [0n, LEN_MAX] };
      }
      case "len": {
        const a0 = e.args[0]!;
        const a = this.compile(a0, ctx);
        if (a.repr === "str") {
          const ft = a0.kind === "field" ? ctx.fieldType(a0.name) : undefined;
          const st = ft && stripType(ft);
          const enc = st?.kind === "string" ? st.encoding : "utf8";
          return {
            code: `$rt.codeUnits(${a.code}, ${str(enc)})`,
            repr: "num",
            range: [0n, LEN_MAX]
          };
        }
        return { code: `${wrapCall(a.code)}.length`, repr: "num", range: [0n, LEN_MAX] };
      }
      case "map":
      case "filter":
      case "indicesWhere":
      case "sortedBy": {
        const arr = this.compile(e.args[0]!, ctx);
        const l = this.lambda(e.args[1]!, ctx);
        let body = l.body.code;
        if (name === "map") {
          const el = e.type.kind === "array" ? e.type.element : undefined;
          if (el) body = this.to(l.body, el);
        }
        const fns: Record<string, string> = {
          map: "mapArr",
          filter: "filterArr",
          indicesWhere: "indicesWhere",
          sortedBy: "sortedBy"
        };
        const fn = fns[name]!;
        const el = e.type.kind === "array" ? e.type.element : undefined;
        const big = name === "indicesWhere" && el !== undefined && this.reprOf(el) === "big";
        return {
          code: `$rt.${fn}(${arr.code}, (${l.param}) => ${body}${big ? ", true" : ""})`,
          repr: "other"
        };
      }
      case "unique": {
        const arr = this.compile(e.args[0]!, ctx);
        return { code: `$rt.unique(${arr.code})`, repr: "other" };
      }
      case "concat": {
        const xs = e.args.map(a => this.compile(a, ctx).code);
        return { code: `$rt.concat(${xs.join(", ")})`, repr: "other" };
      }
      case "isNull": {
        // `x == null` for a nullable pointer value (lazy targets in views are forced first).
        const x = this.compile(e.args[0]!, ctx);
        return { code: `($rt.force(${x.code}) === null)`, repr: "bool" };
      }
      case "encodedLength": {
        const s = this.compile(e.args[0]!, ctx);
        const encArg = e.args[2];
        const enc =
          encArg && encArg.kind === "literal" && encArg.value.kind === "string"
            ? encArg.value.value
            : "utf8";
        return {
          code: `$rt.encodedBytes(${s.code}, ${str(enc)})`,
          repr: "num",
          range: [0n, LEN_MAX]
        };
      }
    }
    throw new Error(`unsupported builtin ${String(name)}`);
  }
}

function propAccess(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`;
}

function wrapCall(code: string): string {
  return /^[A-Za-z0-9_$.[\]"]+$/.test(code) || /^[A-Za-z0-9_$.]+\(.*\)$/.test(code)
    ? code
    : `(${code})`;
}

function isSimpleLiteral(code: string): boolean {
  return /^"/.test(code) || /^-?\d/.test(code);
}

export function formatInt(b: bigint): string {
  const a = absB(b);
  if (a >= 0x10000n && (a & 0xffn) === 0n) return (b < 0n ? "-0x" : "0x") + a.toString(16);
  if (a >= 256n && (a & (a - 1n)) === 0n) return (b < 0n ? "-0x" : "0x") + a.toString(16);
  return b.toString();
}

export function formatFloat(x: number): string {
  if (Number.isNaN(x)) return "NaN";
  if (x === Infinity) return "Infinity";
  if (x === -Infinity) return "-Infinity";
  if (Object.is(x, -0)) return "-0";
  return String(x);
}
