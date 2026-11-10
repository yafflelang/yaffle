/**
 * IR expressions → C# expressions, implementing the integer semantics of docs/IR.md §6.
 *
 * Integer subexpressions carry a value range (interval analysis). Arithmetic is computed in the
 * narrowest of `long`, `Int128` and `BigInteger` that holds the operands and the result, so it is
 * always exact. Values land in typed locations through range-checked conversions (`Rt.Ck`).
 */
import type { IrExpr, IrLiteral, IrType, IrValueType } from "../../ir/index.ts";
import { primValueType, stripType } from "./analysis.ts";
import { str } from "./code.ts";
import type { Model } from "./model.ts";
import type { Types } from "./types.ts";

export type Kind = "int" | "float" | "bool" | "str" | "bytes" | "endian" | "other";
export type Range = [bigint, bigint];

export interface CExpr {
  code: string;
  kind: Kind;
  /** C# static type of `code`. */
  cs: string;
  /** Integer range (int expressions). */
  range?: Range;
  /** Set for integer literals. */
  lit?: bigint;
}

/** Upper bound of lengths, offsets and sizes (`$offset`, `sizeof`, `len`, …). */
const LEN_MAX = 1n << 36n;
const LONG: Range = [-(1n << 63n), (1n << 63n) - 1n];
const I128: Range = [-(1n << 127n), (1n << 127n) - 1n];
const FULL: Range = [-(1n << 64n), 1n << 64n];

export function intRange(bits: number, signed: boolean): Range {
  const b = BigInt(bits);
  return signed ? [-(1n << (b - 1n)), (1n << (b - 1n)) - 1n] : [0n, (1n << b) - 1n];
}

const CS_RANGES: Record<string, Range> = {
  byte: intRange(8, false),
  sbyte: intRange(8, true),
  ushort: intRange(16, false),
  short: intRange(16, true),
  uint: intRange(32, false),
  int: intRange(32, true),
  ulong: intRange(64, false),
  long: LONG,
  Int128: I128
};

/** The element type of bytes treated as an array (derived arrays over u8[] fields). */
const U8: IrValueType = { kind: "int", bits: 8, signed: false };

/** Integer computation types, narrowest first. */
type Comp = "long" | "Int128" | "BigInteger";

function within(r: Range | undefined, w: Range): boolean {
  return r !== undefined && r[0] >= w[0] && r[1] <= w[1];
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

/** The narrowest computation type holding every range. */
function compType(...ranges: (Range | undefined)[]): Comp {
  if (ranges.every(r => within(r, LONG))) return "long";
  if (ranges.every(r => within(r, I128))) return "Int128";
  return "BigInteger";
}

/** Context in which an expression is compiled (read side or write side). */
export interface ExprCtx {
  field(name: string, type: IrValueType): CExpr;
  param(name: string, type: IrValueType): CExpr;
  it(type: IrValueType): CExpr;
  lambda(name: string): string;
  /** `$offset`, `$end`, `$index` (long). */
  builtin(name: "offset" | "end" | "index"): string;
  sizeof(field: string): string;
  offsetof(field: string): string;
  encodedSize(field: string, layer: number): string;
  bytesof(field: string): string;
  encode(field: string): string;
  /** C# expression naming an extern fn's implementation (a method group). */
  externFn(id: string): string;
  /** Hoists a static readonly field and returns its name. */
  hoist(code: string, type: string, hint: string): string;
  fieldType(name: string): IrType | undefined;
  fresh(prefix: string): string;
}

export class ExprCompiler {
  readonly model: Model;
  readonly types: Types;
  constructor(model: Model, types: Types) {
    this.model = model;
    this.types = types;
  }

  rangeOf(t: IrValueType): Range | undefined {
    if (t.kind === "int") return intRange(t.bits, t.signed);
    if (t.kind === "bigint") return FULL;
    if (t.kind === "extern") return this.rangeOf(t.valueType);
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
      case "endian":
        return "endian";
      case "extern":
        return this.kindOf(t.valueType);
      default:
        return "other";
    }
  }

  /** Wraps a typed value (field, param, it) as a CExpr. */
  typed(code: string, t: IrValueType): CExpr {
    const c: CExpr = { code, kind: this.kindOf(t), cs: this.types.valueType(t) };
    const r = this.rangeOf(t);
    if (r) c.range = r;
    return c;
  }

  // ── conversions ───────────────────────────────────────────────────────────

  intLit(v: bigint, cs: string, hoist?: ExprCtx["hoist"]): string {
    if (cs === "long") return v === LONG[0] ? "long.MinValue" : `${v}L`;
    if (cs === "int") return v < 0n ? `(${v})` : `${v}`;
    if (cs === "ulong") return `${v}UL`;
    if (cs === "uint") return `${v}U`;
    if (cs === "short" || cs === "sbyte" || cs === "ushort" || cs === "byte") {
      return `((${cs})${v < 0n ? `(${v})` : v})`;
    }
    if (cs === "Int128" || cs === "BigInteger") {
      if (within([v, v], LONG)) return v === LONG[0] ? `((${cs})long.MinValue)` : `((${cs})${v}L)`;
      if (v >= 0n && v < 1n << 64n) return `((${cs})${v}UL)`;
      const parse =
        cs === "Int128"
          ? `Rt.Num.ParseI128(${str(String(v))})`
          : `Rt.Num.ParseBig(${str(String(v))})`;
      return hoist ? hoist(parse, cs, "big") : parse;
    }
    return `${v}`;
  }

  /** Code of an integer CExpr in the integer type `cs` (the caller guarantees the range fits). */
  conv(c: CExpr, cs: string, ctx?: ExprCtx): string {
    if (c.cs === cs) return c.code;
    if (c.lit !== undefined) return this.intLit(c.lit, cs, ctx?.hoist);
    return `((${cs})${paren(c.code)})`;
  }

  asDouble(c: CExpr): string {
    if (c.cs === "double") return c.code;
    if (c.lit !== undefined) return formatDouble(Number(c.lit));
    return `((double)${paren(c.code)})`;
  }

  /** A long (offsets, positions): checked when the range may exceed long. */
  asLong(c: CExpr): string {
    if (c.kind === "float") return `Rt.Num.Trunc(${this.asDouble(c)})`;
    if (c.cs === "long") return c.code;
    if (within(c.range, LONG)) return this.conv(c, "long");
    return `Rt.Ck.Off(${c.code})`;
  }

  /** A non-negative long (lengths, counts): RANGE when negative. */
  asLen(c: CExpr, what = "length"): string {
    if (within(c.range, [0n, LONG[1]])) return this.conv(c, "long");
    if (c.cs === "long" || c.cs === "ulong" || c.cs === "Int128" || c.cs === "BigInteger")
      return `Rt.Ck.Len(${c.code}, ${str(what)})`;
    return `Rt.Ck.Len(${this.conv(c, "long")}, ${str(what)})`;
  }

  /** An integer CExpr as code of type long, Int128 or BigInteger (for Rt.Ck overloads). */
  wide(c: CExpr): string {
    if (c.cs === "long" || c.cs === "Int128" || c.cs === "BigInteger") return c.code;
    if (within(c.range, LONG)) return this.conv(c, "long");
    return this.conv(c, "Int128");
  }

  /** Converts to the C# type of a destination value type (range-checked where needed). */
  to(c: CExpr, t: IrValueType, what = "value"): string {
    switch (t.kind) {
      case "int": {
        const cs = this.types.intType(t.bits, t.signed);
        const dest = intRange(t.bits, t.signed);
        if (c.kind === "float") {
          return `Rt.Ck.${ckName(t.bits, t.signed)}(Rt.Num.Trunc(${this.asDouble(c)}), ${str(what)})`;
        }
        if (c.kind !== "int") return c.code;
        if (c.cs === cs && within(c.range, dest)) return c.code;
        if (within(c.range, dest)) return this.conv(c, cs);
        return `Rt.Ck.${ckName(t.bits, t.signed)}(${this.wide(c)}, ${str(what)})`;
      }
      case "bigint":
        if (c.kind !== "int") return c.code;
        if (within(c.range, I128)) return this.conv(c, "Int128");
        return `((Int128)${paren(c.code)})`;
      case "float": {
        if (c.kind !== "int" && c.kind !== "float") return c.code;
        const d = this.asDouble(c);
        if (t.bits === 64) return d;
        if (t.bits === 32) return c.cs === "float" ? c.code : `((float)${paren(d)})`;
        return c.cs === "Half" ? c.code : `Rt.HalfBits.ToHalf(${d})`;
      }
      case "enum": {
        const en = this.model.enum(t.enum);
        const name = this.model.enumName(t.enum);
        if (c.kind === "int") return `((${name})${this.to(c, primValueType(en.storage), what)})`;
        return c.code;
      }
      case "extern":
        return this.to(c, t.valueType, what);
      case "bytes":
        // A derived array of integers written to a bytes field.
        if (c.kind !== "bytes" && c.cs !== "byte[]" && c.cs.startsWith("List<"))
          return `Rt.Arrays.ToBytes(${c.code})`;
        return c.code;
      case "array": {
        const el = this.types.valueType(t.element);
        const want = `List<${el}>`;
        if (c.cs === want || !(c.cs.startsWith("List<") || c.cs === "byte[]")) return c.code;
        const intEl = t.element.kind === "int" || t.element.kind === "bigint";
        return intEl ? `Rt.Arrays.CastInts<${el}>(${c.code})` : `Rt.Arrays.Cast<${el}>(${c.code})`;
      }
      default:
        return c.code;
    }
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
        // Fill functions (`i => …`) take the padding byte index; derived-array lambdas an element.
        if (e.type.kind === "bigint")
          return { code: ctx.lambda(e.name), kind: "int", cs: "long", range: [0n, LEN_MAX] };
        return this.typed(ctx.lambda(e.name), e.type);
      case "builtinValue":
        return {
          code: ctx.builtin(e.name),
          kind: "int",
          cs: "long",
          range: [e.name === "index" ? -1n : 0n, LEN_MAX]
        };
      case "member": {
        const o = this.compile(e.object, ctx);
        const ot = e.object.type;
        if (ot.kind !== "struct") throw new Error(`member access on a ${ot.kind}`);
        return this.memberAccess(o.code, ot.struct, e.name, e.type);
      }
      case "index": {
        const o = this.compile(e.object, ctx);
        const i = this.compile(e.index, ctx);
        return this.typed(`Rt.Values.At(${o.code}, ${this.asLen(i, "index")})`, e.type);
      }
      case "map": {
        const o = this.compile(e.array, ctx);
        const at = e.array.type;
        const el = at.kind === "array" ? at.element : undefined;
        if (!el || el.kind !== "struct") throw new Error("map over a non-struct array");
        const p = ctx.fresh("e");
        const m = this.memberAccess(
          p,
          el.struct,
          e.field,
          e.type.kind === "array" ? e.type.element : e.type
        );
        return {
          code: `Rt.Values.Map(${o.code}, (${this.model.className(el.struct)} ${p}) => ${m.code})`,
          kind: "other",
          cs: `List<${m.cs}>`
        };
      }
      case "unary":
        return this.unary(e.op, this.compile(e.operand, ctx), e.type);
      case "binary":
        return this.binary(e.op, e.left, e.right, e.type, ctx);
      case "cond": {
        const t = this.compile(e.test, ctx);
        const a = this.compile(e.then, ctx);
        const b = this.compile(e.else, ctx);
        if (a.kind === "int" && b.kind === "int") {
          const range: Range = [minB(a.range![0], b.range![0]), maxB(a.range![1], b.range![1])];
          const cs =
            a.cs === b.cs && a.lit === undefined && b.lit === undefined ? a.cs : compType(range);
          return {
            code: `(${t.code} ? ${this.conv(a, cs, ctx)} : ${this.conv(b, cs, ctx)})`,
            kind: "int",
            cs,
            range
          };
        }
        if ((a.kind === "float" || a.kind === "int") && (b.kind === "float" || b.kind === "int")) {
          return {
            code: `(${t.code} ? ${this.asDouble(a)} : ${this.asDouble(b)})`,
            kind: "float",
            cs: "double"
          };
        }
        return { code: `(${t.code} ? ${a.code} : ${b.code})`, kind: a.kind, cs: a.cs };
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
        return {
          code: parts.length ? `(${parts.join(" || ")})` : "false",
          kind: "bool",
          cs: "bool"
        };
      }
      case "regex": {
        const v = this.compile(e.value, ctx);
        const re = ctx.hoist(
          `new System.Text.RegularExpressions.Regex(${str(`^(?:${e.pattern})$`)}, System.Text.RegularExpressions.RegexOptions.ECMAScript)`,
          "System.Text.RegularExpressions.Regex",
          "re"
        );
        return { code: `${re}.IsMatch(${v.code})`, kind: "bool", cs: "bool" };
      }
      case "lambda": {
        // Lambdas are arguments of map/filter/indicesWhere/sortedBy: a typed C# lambda.
        const l = this.lambda(e, ctx);
        return { code: `((${l.cs} ${l.param}) => ${l.body.code})`, kind: "other", cs: "Delegate" };
      }
      case "this":
        throw new Error("`this` is only valid as the argument of sizeof/offsetof/bytesof/encode");
      case "convert":
        return this.convert(e, ctx);
    }
  }

  /** A lambda's parameter, its C# type and the compiled body (the body sees the enclosing context). */
  lambda(e: IrExpr, ctx: ExprCtx): { param: string; cs: string; body: CExpr } {
    if (e.kind !== "lambda") throw new Error(`expected a lambda, got ${e.kind}`);
    const param = ctx.fresh(`l_${e.param.replace(/[^A-Za-z0-9_]/g, "_")}`);
    const name = e.param;
    const inner: ExprCtx = { ...ctx, lambda: n => (n === name ? param : ctx.lambda(n)) };
    return { param, cs: this.types.valueType(e.type), body: this.compile(e.body, inner) };
  }

  /** `obj.field` for a struct value: the property, unwrapped when nullable. */
  memberAccess(obj: string, structId: string, field: string, t: IrValueType): CExpr {
    const s = this.model.struct(structId);
    const f = this.model.field(s, field);
    if (!f) throw new Error(`unknown field ${field} of ${s.name}`);
    const info = this.types.field(s, f);
    let code = `${obj}.${info.member}`;
    if (info.nullable) code = info.valueType ? `${code}.GetValueOrDefault()` : `${code}!`;
    const c = this.typed(code, t);
    if (info.base !== c.cs && info.base !== "object") c.cs = info.base;
    return c;
  }

  private convert(e: Extract<IrExpr, { kind: "convert" }>, ctx: ExprCtx): CExpr {
    const o = this.compile(e.operand, ctx);
    const from = e.operand.type;
    if (from.kind === "enum" && (e.type.kind === "int" || e.type.kind === "bigint")) {
      const en = this.model.enum(from.enum);
      const cs = this.types.primType(en.storage);
      return {
        code: `((${cs})${paren(o.code)})`,
        kind: "int",
        cs,
        range: intRange(Number(en.storage.slice(1)), en.storage[0] === "i")
      };
    }
    if (e.type.kind === "float") {
      if (o.kind === "int" || o.kind === "float") {
        return { code: this.asDouble(o), kind: "float", cs: "double" };
      }
      return o;
    }
    if (e.type.kind === "int" || e.type.kind === "bigint") {
      if (o.kind === "float") {
        const rr = this.rangeOf(e.type) ?? LONG;
        return {
          code: `Rt.Num.Trunc(${this.asDouble(o)})`,
          kind: "int",
          cs: "long",
          range: within(rr, LONG) ? rr : LONG
        };
      }
      if (o.kind === "bool") {
        return { code: `(${o.code} ? 1L : 0L)`, kind: "int", cs: "long", range: [0n, 1n] };
      }
      return o;
    }
    if (e.type.kind === "enum" && o.kind === "int") {
      return { code: this.to(o, e.type), kind: "other", cs: this.model.enumName(e.type.enum) };
    }
    return o;
  }

  literal(v: IrLiteral, t: IrValueType, ctx: ExprCtx): CExpr {
    switch (v.kind) {
      case "int": {
        const b = BigInt(v.value);
        if (t.kind === "float")
          return { code: formatDouble(Number(b)), kind: "float", cs: "double" };
        const cs = within([b, b], LONG) ? "long" : within([b, b], I128) ? "Int128" : "BigInteger";
        return { code: this.intLit(b, cs, ctx.hoist), kind: "int", cs, range: [b, b], lit: b };
      }
      case "float":
        return { code: formatDouble(v.value), kind: "float", cs: "double" };
      case "bool":
        return { code: String(v.value), kind: "bool", cs: "bool" };
      case "string":
        return { code: str(v.value), kind: "str", cs: "string" };
      case "bytes":
        return {
          code: ctx.hoist(`Rt.Hex.Decode(${str(v.hex)})`, "byte[]", "bytes"),
          kind: "bytes",
          cs: "byte[]"
        };
      case "endian":
        return {
          code: v.value === "le" ? "Rt.Endian.Le" : "Rt.Endian.Be",
          kind: "endian",
          cs: "Rt.Endian"
        };
      case "enum":
        return {
          code: `${this.model.enumName(v.enum)}.${this.model.enumMember(v.enum, v.member)}`,
          kind: "other",
          cs: this.model.enumName(v.enum)
        };
    }
  }

  private unary(op: "-" | "!" | "~", o: CExpr, t: IrValueType): CExpr {
    if (op === "!") return { code: `(!${paren(o.code)})`, kind: "bool", cs: "bool" };
    if (o.kind === "float" || t.kind === "float") {
      return { code: `(-${paren(this.asDouble(o))})`, kind: "float", cs: "double" };
    }
    const r = o.range ?? FULL;
    if (op === "-") {
      const range: Range = [-r[1], -r[0]];
      if (o.lit !== undefined) {
        const cs = compType(range);
        return { code: this.intLit(-o.lit, cs), kind: "int", cs, range, lit: -o.lit };
      }
      const cs = compType(r, range);
      return { code: `(-${this.conv(o, cs)})`, kind: "int", cs, range };
    }
    const range: Range = [-r[1] - 1n, -r[0] - 1n];
    const cs = compType(r, range);
    return { code: `(~${this.conv(o, cs)})`, kind: "int", cs, range };
  }

  private binary(op: string, le: IrExpr, re: IrExpr, t: IrValueType, ctx: ExprCtx): CExpr {
    const a = this.compile(le, ctx);
    const b = this.compile(re, ctx);
    if (op === "&&" || op === "||")
      return { code: `(${a.code} ${op} ${b.code})`, kind: "bool", cs: "bool" };
    if (op === "==" || op === "!=")
      return { code: this.equality(op, a, b), kind: "bool", cs: "bool" };
    if (op === "<" || op === "<=" || op === ">" || op === ">=") {
      return { code: this.relational(op, a, b), kind: "bool", cs: "bool" };
    }
    return this.arith(op, a, b, t, ctx);
  }

  private numeric(c: CExpr): boolean {
    return c.kind === "int" || c.kind === "float";
  }

  equality(op: "==" | "!=", a: CExpr, b: CExpr): string {
    if (this.numeric(a) && this.numeric(b)) return this.relational(op, a, b);
    if (a.kind === "bytes" && b.kind === "bytes") {
      return `${op === "!=" ? "!" : ""}Rt.Values.BytesEq(${a.code}, ${b.code})`;
    }
    if (
      (a.kind === "str" && b.kind === "str") ||
      (a.kind === "bool" && b.kind === "bool") ||
      (a.kind === "endian" && b.kind === "endian") ||
      (a.kind === "other" && b.kind === "other" && a.cs === b.cs && this.types.isValueType(a.cs))
    ) {
      return `(${a.code} ${op} ${b.code})`;
    }
    return `${op === "!=" ? "!" : ""}Rt.Values.Eq(${a.code}, ${b.code})`;
  }

  relational(op: string, a: CExpr, b: CExpr): string {
    if (a.kind === "float" || b.kind === "float")
      return `(${this.asDouble(a)} ${op} ${this.asDouble(b)})`;
    if (a.kind !== "int" || b.kind !== "int") return `(${a.code} ${op} ${b.code})`;
    if (a.cs === b.cs && a.lit === undefined && b.lit === undefined)
      return `(${a.code} ${op} ${b.code})`;
    // A literal that fits the other side's type compares directly.
    const dr = CS_RANGES[b.cs];
    if (a.lit !== undefined && b.lit === undefined && dr && within(a.range, dr)) {
      return `(${this.intLit(a.lit, b.cs)} ${op} ${b.code})`;
    }
    const ar = CS_RANGES[a.cs];
    if (b.lit !== undefined && a.lit === undefined && ar && within(b.range, ar)) {
      return `(${a.code} ${op} ${this.intLit(b.lit, a.cs)})`;
    }
    const cs = compType(a.range ?? FULL, b.range ?? FULL);
    return `(${this.conv(a, cs)} ${op} ${this.conv(b, cs)})`;
  }

  private arith(op: string, a: CExpr, b: CExpr, t: IrValueType, ctx: ExprCtx): CExpr {
    if (t.kind === "float" || a.kind === "float" || b.kind === "float") {
      const x = this.asDouble(a);
      const y = this.asDouble(b);
      if (op === "+" || op === "-" || op === "*" || op === "/" || op === "%") {
        return { code: `(${x} ${op} ${y})`, kind: "float", cs: "double" };
      }
      a = { code: `Rt.Num.Trunc(${x})`, kind: "int", cs: "long", range: LONG };
      b = { code: `Rt.Num.Trunc(${y})`, kind: "int", cs: "long", range: LONG };
    }
    const ra = a.range ?? FULL;
    const rb = b.range ?? FULL;
    const res = (range: Range, code: (cs: Comp) => string): CExpr => {
      const cs = compType(ra, rb, range);
      return { code: code(cs), kind: "int", cs, range };
    };
    const A = (cs: Comp): string => this.conv(a, cs, ctx);
    const B = (cs: Comp): string => this.conv(b, cs, ctx);
    switch (op) {
      case "+":
        return res([ra[0] + rb[0], ra[1] + rb[1]], cs => `(${A(cs)} + ${B(cs)})`);
      case "-":
        return res([ra[0] - rb[1], ra[1] - rb[0]], cs => `(${A(cs)} - ${B(cs)})`);
      case "*": {
        const ps = [ra[0] * rb[0], ra[0] * rb[1], ra[1] * rb[0], ra[1] * rb[1]];
        return res([minB(...ps), maxB(...ps)], cs => `(${A(cs)} * ${B(cs)})`);
      }
      case "/": {
        const m = maxB(absB(ra[0]), absB(ra[1]));
        const range: Range =
          rb[0] > 0n || (b.lit !== undefined && b.lit > 0n)
            ? [ra[0] < 0n ? -m : 0n, ra[1] < 0n ? 0n : m]
            : [-m, m];
        if (b.lit !== undefined && b.lit > 0n) return res(range, cs => `(${A(cs)} / ${B(cs)})`);
        return res(range, cs => `Rt.Num.Div(${A(cs)}, ${B(cs)})`);
      }
      case "%": {
        const mb = maxB(absB(rb[0]), absB(rb[1]));
        const ma = maxB(absB(ra[0]), absB(ra[1]));
        const m = minB(ma, mb > 0n ? mb - 1n : 0n);
        const range: Range = [ra[0] < 0n ? -m : 0n, ra[1] < 0n ? 0n : m];
        if (b.lit !== undefined && b.lit > 0n) return res(range, cs => `(${A(cs)} % ${B(cs)})`);
        return res(range, cs => `Rt.Num.Mod(${A(cs)}, ${B(cs)})`);
      }
      case "<<": {
        const maxShift = b.lit !== undefined ? b.lit : rb[1] > 63n ? 63n : rb[1] < 0n ? 0n : rb[1];
        const minShift = b.lit !== undefined ? b.lit : rb[0] < 0n ? 0n : rb[0] > 63n ? 63n : rb[0];
        const f1 = 1n << maxShift;
        const f0 = 1n << minShift;
        const ps = [ra[0] * f1, ra[0] * f0, ra[1] * f1, ra[1] * f0];
        const range: Range = [minB(...ps), maxB(...ps)];
        const cs = compType(ra, range);
        if (b.lit !== undefined && b.lit >= 0n && b.lit <= 63n) {
          return { code: `(${this.conv(a, cs, ctx)} << ${b.lit})`, kind: "int", cs, range };
        }
        return {
          code: `Rt.Num.Shl(${this.conv(a, cs, ctx)}, ${this.asLong(b)})`,
          kind: "int",
          cs,
          range
        };
      }
      case ">>": {
        const range: Range =
          b.lit !== undefined && b.lit >= 0n && b.lit <= 63n
            ? [ra[0] >> b.lit, ra[1] >> b.lit]
            : [ra[0] < 0n ? ra[0] : 0n, ra[1] > 0n ? ra[1] : 0n];
        const cs = compType(ra, range);
        if (b.lit !== undefined && b.lit >= 0n && b.lit <= 63n) {
          return { code: `(${this.conv(a, cs, ctx)} >> ${b.lit})`, kind: "int", cs, range };
        }
        return {
          code: `Rt.Num.Shr(${this.conv(a, cs, ctx)}, ${this.asLong(b)})`,
          kind: "int",
          cs,
          range
        };
      }
      case "&":
      case "|":
      case "^": {
        let range: Range;
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
        } else {
          range = [minB(ra[0], rb[0], LONG[0]), maxB(ra[1], rb[1], LONG[1])];
        }
        return res(range, cs => `(${A(cs)} ${op} ${B(cs)})`);
      }
    }
    throw new Error(`unknown operator ${op}`);
  }

  private call(e: Extract<IrExpr, { kind: "call" }>, ctx: ExprCtx): CExpr {
    if (e.callee.kind === "extern") {
      const x = this.model.extern(e.callee.extern);
      const params = x.kind === "fn" ? x.params : [];
      const args = e.args.map((a, i) => {
        const c = this.compile(a, ctx);
        const p = params[i];
        return p ? this.to(c, p.type, "argument") : c.code;
      });
      const ret = x.kind === "fn" ? x.returns : e.type;
      const cs = this.types.valueType(ret);
      return this.typed(
        `Rt.Check.Host<${cs}>(() => ${ctx.externFn(e.callee.extern)}(${args.join(", ")}), ${str(x.name)})`,
        ret
      );
    }
    const name = e.callee.name;
    const fieldArg = (): string => {
      const a = e.args[0];
      if (a?.kind === "this") return "this";
      if (a?.kind !== "field") throw new Error(`${name}() needs a field argument`);
      return a.name;
    };
    const arg = (i = 0): CExpr => this.compile(e.args[i]!, ctx);
    switch (name as string) {
      case "sum": {
        const a = arg();
        if (e.type.kind === "float")
          return { code: `Rt.Values.SumF(${a.code})`, kind: "float", cs: "double" };
        return { code: `Rt.Values.Sum(${a.code})`, kind: "int", cs: "Int128", range: FULL };
      }
      case "lengths":
        return { code: `Rt.Values.Lengths(${arg().code})`, kind: "other", cs: "List<long>" };
      case "sizeof":
        return length(ctx.sizeof(fieldArg()));
      case "offsetof":
        return length(ctx.offsetof(fieldArg()));
      case "encodedSize": {
        const k = e.args[1];
        const layer = k?.kind === "literal" && k.value.kind === "int" ? Number(k.value.value) : 0;
        return length(ctx.encodedSize(fieldArg(), layer));
      }
      case "bytesof":
        return { code: ctx.bytesof(fieldArg()), kind: "bytes", cs: "byte[]" };
      case "encode":
        return { code: ctx.encode(fieldArg()), kind: "bytes", cs: "byte[]" };
      case "crc32":
      case "adler32": {
        const fn = name === "crc32" ? "Crc32" : "Adler32";
        return {
          code: `Rt.Checksum.${fn}(${arg().code})`,
          kind: "int",
          cs: "uint",
          range: [0n, (1n << 32n) - 1n]
        };
      }
      case "min":
      case "max":
        return this.minMax(name === "min", e, ctx);
      case "abs": {
        const x = arg();
        if (x.kind === "float")
          return { code: `Math.Abs(${this.asDouble(x)})`, kind: "float", cs: "double" };
        const r = x.range ?? FULL;
        const range: Range = [0n, maxB(absB(r[0]), absB(r[1]))];
        const cs = compType(r, range);
        return { code: `Rt.Num.Abs(${this.conv(x, cs, ctx)})`, kind: "int", cs, range };
      }
      case "round": {
        const tr = this.rangeOf(e.type) ?? LONG;
        return {
          code: `Rt.Num.Round(${this.asDouble(arg())})`,
          kind: "int",
          cs: "long",
          range: within(tr, LONG) ? tr : LONG
        };
      }
      case "indexOf": {
        const arr = arg();
        return length(`Rt.Values.IndexOf(${arr.code}, (object?)${paren(arg(1).code)})`);
      }
      case "len": {
        const a0 = e.args[0]!;
        const a = arg();
        if (a.kind === "str") {
          const t = a0.kind === "field" ? ctx.fieldType(a0.name) : undefined;
          const ft = t && stripType(t);
          const enc = ft?.kind === "string" ? encName(ft.encoding) : "Utf8";
          return length(`Rt.Strings.CodeUnits(${a.code}, Rt.TextEncoding.${enc})`);
        }
        return length(`((long)${paren(a.code)}.${a.kind === "bytes" ? "Length" : "Count"})`);
      }
      case "map":
      case "filter":
      case "indicesWhere":
      case "sortedBy":
        return this.lambdaArray(name, e, ctx);
      case "unique": {
        const arr = arg();
        const el = this.elementCs(e.type);
        return list(`Rt.Arrays.Unique<${el.cs}>(${arr.code})`, el.cs);
      }
      case "concat": {
        const el = this.elementCs(e.type);
        const xs = e.args.map(a => {
          const c = this.compile(a, ctx);
          return el.type ? this.to(c, { kind: "array", element: el.type }) : c.code;
        });
        return list(`Rt.Arrays.Concat<${el.cs}>(${xs.join(", ")})`, el.cs);
      }
      case "isNull": {
        // `x == null` on a nullable pointer's value: the member itself, not unwrapped.
        const code = arg().code.replace(/(\.GetValueOrDefault\(\)|!)$/, "");
        return { code: `(${code} is null)`, kind: "bool", cs: "bool" };
      }
      case "encodedLength": {
        const s = arg();
        const encArg = e.args[2];
        const enc =
          encArg?.kind === "literal" && encArg.value.kind === "string"
            ? encArg.value.value
            : "utf8";
        return length(`Rt.Strings.EncodedBytes(${s.code}, Rt.TextEncoding.${encName(enc)})`);
      }
    }
    throw new Error(`unsupported builtin ${String(name)}`);
  }

  /** `min`/`max` of an array, or of several numbers (exact in the narrowest type holding them). */
  private minMax(min: boolean, e: Extract<IrExpr, { kind: "call" }>, ctx: ExprCtx): CExpr {
    const fn = min ? "Min" : "Max";
    // over one array, or one byte string (`u8` arrays)
    const one = e.args.length === 1 ? e.args[0]!.type.kind : undefined;
    if (one === "array" || one === "bytes")
      return this.typed(`Rt.Values.${fn}Of(${this.compile(e.args[0]!, ctx).code})`, e.type);
    const xs = e.args.map(a => this.compile(a, ctx));
    if (xs.some(x => x.kind === "float")) {
      let code = this.asDouble(xs[0]!);
      for (const x of xs.slice(1)) code = `Math.${fn}(${code}, ${this.asDouble(x)})`;
      return { code, kind: "float", cs: "double" };
    }
    const ranges = xs.map(x => x.range ?? FULL);
    const pick = min ? minB : maxB;
    const range: Range = [pick(...ranges.map(r => r[0])), pick(...ranges.map(r => r[1]))];
    const cs = compType(...ranges, range);
    const host = cs === "long" ? "Math" : cs;
    let code = this.conv(xs[0]!, cs, ctx);
    for (const x of xs.slice(1)) code = `${host}.${fn}(${code}, ${this.conv(x, cs, ctx)})`;
    return { code, kind: "int", cs, range };
  }

  /** `map`, `filter`, `indicesWhere` and `sortedBy`: an array and a lambda. */
  private lambdaArray(name: string, e: Extract<IrExpr, { kind: "call" }>, ctx: ExprCtx): CExpr {
    const arr = this.compile(e.args[0]!, ctx).code;
    const l = this.lambda(e.args[1]!, ctx);
    const lam = (body: string): string => `(${l.cs} ${l.param}) => ${body}`;
    switch (name) {
      case "map": {
        const el = e.type.kind === "array" ? e.type.element : undefined;
        const outCs = el ? this.types.valueType(el) : l.body.cs;
        const body = el ? this.to(l.body, el) : l.body.code;
        return list(`Rt.Arrays.Map<${l.cs}, ${outCs}>(${arr}, ${lam(body)})`, outCs);
      }
      case "filter":
        return list(`Rt.Arrays.Filter<${l.cs}>(${arr}, ${lam(l.body.code)})`, l.cs);
      case "indicesWhere":
        return list(`Rt.Arrays.IndicesWhere<${l.cs}>(${arr}, ${lam(l.body.code)})`, "Int128");
      default:
        return list(`Rt.Arrays.SortedBy<${l.cs}, ${l.body.cs}>(${arr}, ${lam(l.body.code)})`, l.cs);
    }
  }

  /** The element type of an array (or bytes, as u8) result, and its C# type. */
  private elementCs(t: IrValueType): { type: IrValueType | undefined; cs: string } {
    const type = t.kind === "array" ? t.element : t.kind === "bytes" ? U8 : undefined;
    return { type, cs: type ? this.types.valueType(type) : "object" };
  }
}

/** A length, size or offset (a non-negative long). */
function length(code: string): CExpr {
  return { code, kind: "int", cs: "long", range: [0n, LEN_MAX] };
}

/** A derived array: `List<elementCs>`. */
function list(code: string, elementCs: string): CExpr {
  return { code, kind: "other", cs: `List<${elementCs}>` };
}

/** Name of the Rt.Ck conversion for an integer type (the primitive of the next whole byte count). */
export function ckName(bits: number, signed: boolean): string {
  return `${signed ? "I" : "U"}${Math.min(64, Math.ceil(bits / 8) * 8)}`;
}

export function encName(enc: string): string {
  switch (enc) {
    case "utf8":
      return "Utf8";
    case "ascii":
      return "Ascii";
    case "latin1":
      return "Latin1";
    case "utf16":
      return "Utf16";
    case "utf32":
      return "Utf32";
  }
  return "Utf8";
}

/** Parenthesizes code unless it is a simple name, member access, number or already parenthesized. */
export function paren(code: string): string {
  if (/^[A-Za-z_@][A-Za-z0-9_.@]*$/.test(code)) return code;
  if (/^-?\d+(\.\d+)?[A-Za-z]*$/.test(code)) return code.startsWith("-") ? `(${code})` : code;
  if (isParenthesized(code)) return code;
  return `(${code})`;
}

/** Code without one pair of enclosing parentheses (an `if` condition). */
export function stripParens(code: string): string {
  return isParenthesized(code) ? code.slice(1, -1) : code;
}

/** True if `s` is one parenthesized group: it opens with `(` that is closed by its last character. */
function isParenthesized(s: string): boolean {
  if (!s.startsWith("(") || !s.endsWith(")")) return false;
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0 && i < s.length - 1) return false;
    }
  }
  return depth === 0;
}

export function formatDouble(x: number): string {
  if (Number.isNaN(x)) return "double.NaN";
  if (x === Infinity) return "double.PositiveInfinity";
  if (x === -Infinity) return "double.NegativeInfinity";
  if (Object.is(x, -0)) return "(-0.0)";
  let s = String(x);
  if (!/[.eE]/.test(s)) s += ".0";
  s = s.replace("e+", "E+").replace("e-", "E-");
  return x < 0 ? `(${s})` : s;
}
