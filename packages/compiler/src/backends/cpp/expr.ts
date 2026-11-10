/**
 * IR expressions → C++ expressions, implementing the integer semantics of docs/IR.md §6.
 *
 * Integer subexpressions carry a value range (interval analysis). When every operand and the
 * result provably fit `std::int64_t`, the code computes in int64; otherwise in `yaffle::i128`
 * (with checked helpers where even 128 bits could overflow). Operands are always cast explicitly,
 * so C++'s usual arithmetic conversions (signed/unsigned mixing) never apply.
 */
import type { IrExpr, IrLiteral, IrType, IrValueType } from "../../ir/index.ts";
import { floatLit, intLit, str } from "./code.ts";
import type { Model } from "./model.ts";
import { enumMember, intCppType, type TypeMapper } from "./types.ts";

export type Repr = "int" | "float" | "bool" | "str" | "bytes" | "enum" | "endian" | "other";
export type Range = [bigint, bigint];

/** How the C++ code of an integer expression is typed. */
export type IntType = "lit" | "i64" | "i128" | "native";

export interface CExpr {
  code: string;
  repr: Repr;
  /** Integer range (int expressions). */
  range?: Range;
  /** C++ typing of int expressions. */
  it?: IntType;
  /** Set for integer literals. */
  lit?: bigint;
  /** Value type when known (fields, params, it). */
  vt?: IrValueType;
}

const I64: Range = [-(1n << 63n), (1n << 63n) - 1n];
const I128: Range = [-(1n << 127n), (1n << 127n) - 1n];
const LEN_MAX = 1n << 40n;

function intRange(bits: number, signed: boolean): Range {
  const b = BigInt(bits);
  return signed ? [-(1n << (b - 1n)), (1n << (b - 1n)) - 1n] : [0n, (1n << b) - 1n];
}

function within(r: Range | undefined, lo: bigint, hi: bigint): boolean {
  return r !== undefined && r[0] >= lo && r[1] <= hi;
}
function fitsI64(r: Range | undefined): boolean {
  return within(r, I64[0], I64[1]);
}
function fitsI128(r: Range | undefined): boolean {
  return within(r, I128[0], I128[1]);
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
function clampI128(r: Range): Range {
  return [r[0] < I128[0] ? I128[0] : r[0], r[1] > I128[1] ? I128[1] : r[1]];
}

/** Context in which an expression is compiled (read side or write side). */
export interface ExprCtx {
  field(name: string, type: IrValueType): CExpr;
  param(name: string, type: IrValueType): CExpr;
  it(type: IrValueType): CExpr;
  lambda(name: string): string;
  /** `$offset`, `$end`, `$index` (int64). */
  builtin(name: "offset" | "end" | "index"): string;
  sizeof(field: string): string;
  offsetof(field: string): string;
  encodedSize(field: string, layer: number): string;
  bytesof(field: string): string;
  encode(field: string): string;
  /** Qualified name of an extern's host implementation. */
  externFn(id: string): string;
  /** IR type of a field of the current struct. */
  fieldType(name: string): IrType | undefined;
}

export class ExprCompiler {
  readonly model: Model;
  readonly types: TypeMapper;
  constructor(model: Model, types: TypeMapper) {
    this.model = model;
    this.types = types;
  }

  reprOf(t: IrValueType): Repr {
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
        return this.reprOf(t.valueType);
      default:
        return "other";
    }
  }

  rangeOf(t: IrValueType): Range | undefined {
    if (t.kind === "int") return intRange(t.bits, t.signed);
    if (t.kind === "bigint") return I128;
    if (t.kind === "extern") return this.rangeOf(t.valueType);
    return undefined;
  }

  /** Wraps a typed value (field, param, it) as a CExpr. */
  typed(code: string, t: IrValueType): CExpr {
    const c: CExpr = { code, repr: this.reprOf(t), vt: t };
    const r = this.rangeOf(t);
    if (r) {
      c.range = r;
      c.it = t.kind === "bigint" ? "i128" : "native";
    }
    return c;
  }

  // ── conversions ───────────────────────────────────────────────────────────

  asI64(c: CExpr): string {
    if (c.lit !== undefined && fitsI64([c.lit, c.lit])) return intLit(c.lit);
    if (c.it === "i64") return c.code;
    if (c.repr === "float") return `static_cast<std::int64_t>(yaffle::trunc_to_int(${c.code}))`;
    if (c.repr === "enum") return `static_cast<std::int64_t>(${c.code})`;
    if (c.repr === "bool") return `static_cast<std::int64_t>(${c.code})`;
    if (!fitsI64(c.range)) return `yaffle::to<std::int64_t>(${this.asI128(c)})`;
    return `static_cast<std::int64_t>(${c.code})`;
  }

  asI128(c: CExpr): string {
    if (c.lit !== undefined)
      return fitsI64([c.lit, c.lit]) ? `yaffle::i128(${intLit(c.lit)})` : intLit(c.lit);
    if (c.it === "i128") return c.code;
    if (c.repr === "float") return `yaffle::trunc_to_int(${c.code})`;
    return `static_cast<yaffle::i128>(${c.code})`;
  }

  asF64(c: CExpr): string {
    if (c.repr === "float") {
      const vt = c.vt;
      if (vt && vt.kind === "float" && vt.bits !== 64) return `static_cast<double>(${c.code})`;
      return c.code;
    }
    if (c.lit !== undefined) return floatLit(Number(c.lit));
    return `static_cast<double>(${c.code})`;
  }

  /** A non-negative length or count (int64). */
  asLen(c: CExpr, what = "length"): string {
    if (c.repr === "int" && within(c.range, 0n, I64[1])) {
      if (c.lit !== undefined) return intLit(c.lit);
      return c.it === "i64" ? c.code : `static_cast<std::int64_t>(${c.code})`;
    }
    return `yaffle::len(${this.asI128(c)}, ${str(what)})`;
  }

  /** An offset or position (int64). */
  asOffset(c: CExpr): string {
    if (c.repr === "int" && fitsI64(c.range)) return this.asI64(c);
    return `yaffle::offset(${this.asI128(c)})`;
  }

  /** A value converted to the C++ type of a destination value type (range checked). */
  to(c: CExpr, t: IrValueType, what = "value"): string {
    if (t.kind === "int") {
      const ct = intCppType(t.bits, t.signed);
      const r = intRange(t.bits, t.signed);
      if (c.repr === "float") return this.checkInt(`yaffle::trunc_to_int(${c.code})`, t, what);
      if (c.repr === "enum") return `static_cast<${ct}>(${c.code})`;
      if (c.repr !== "int") return c.code;
      if (
        c.vt &&
        c.vt.kind === "int" &&
        c.vt.bits === t.bits &&
        c.vt.signed === t.signed &&
        c.it === "native"
      )
        return c.code;
      if (within(c.range, r[0], r[1])) {
        if (c.lit !== undefined) return `static_cast<${ct}>(${intLit(c.lit)})`;
        return `static_cast<${ct}>(${c.code})`;
      }
      return this.checkInt(this.asI128(c), t, what);
    }
    if (t.kind === "bigint") return c.repr === "int" ? this.asI128(c) : c.code;
    if (t.kind === "float") {
      const d = this.asF64(c);
      return t.bits === 64 ? d : `static_cast<float>(${d})`;
    }
    if (t.kind === "enum" && c.repr === "int")
      return `static_cast<${this.model.enumName(t.enum)}>(${this.asI128(c)})`;
    if (t.kind === "extern") return this.to(c, t.valueType, what);
    // A derived array written to a bytes field or an array of integers.
    if (t.kind === "bytes" && c.repr === "other") return `yaffle::array_to_bytes(${c.code})`;
    if (t.kind === "array" && t.element.kind === "int" && c.repr === "other")
      return `yaffle::array_to_ints<${intCppType(t.element.bits, t.element.signed)}>(${c.code})`;
    return c.code;
  }

  private checkInt(code: string, t: Extract<IrValueType, { kind: "int" }>, what: string): string {
    const ct = intCppType(t.bits, t.signed);
    if (t.bits === 8 || t.bits === 16 || t.bits === 32 || t.bits === 64)
      return `yaffle::to<${ct}>(${code}, ${str(what)})`;
    return `yaffle::to_bits<${ct}>(${code}, ${t.bits}, ${str(what)})`;
  }

  // ── compile ───────────────────────────────────────────────────────────────

  compile(e: IrExpr, ctx: ExprCtx): CExpr {
    switch (e.kind) {
      case "literal":
        return this.literal(e.value, e.type);
      case "field":
        return ctx.field(e.name, e.type);
      case "param":
        return ctx.param(e.name, e.type);
      case "it":
        return ctx.it(e.type);
      case "lambdaParam":
        // Fill functions (`i => …`) take the padding byte index; other lambdas take an element.
        if (e.type.kind === "bigint") return i64(ctx.lambda(e.name), [0n, LEN_MAX]);
        return this.typed(ctx.lambda(e.name), e.type);
      case "builtinValue":
        return i64(ctx.builtin(e.name), [e.name === "index" ? -1n : -LEN_MAX, LEN_MAX]);
      case "member": {
        const o = this.compile(e.object, ctx);
        const ot = e.object.type;
        let code = `yaffle::obj(${o.code}).${this.model.member(e.name)}`;
        if (ot.kind === "struct" || (ot.kind === "nullable" && ot.inner.kind === "struct")) {
          const sid = ot.kind === "struct" ? ot.struct : (ot.inner as { struct: string }).struct;
          const s = this.model.struct(sid);
          if (this.model.isOptionalMember(s, e.name)) code = `yaffle::obj(${code})`;
        }
        return this.typed(code, e.type);
      }
      case "index": {
        const o = this.compile(e.object, ctx);
        const i = this.compile(e.index, ctx);
        return this.typed(`yaffle::at(${o.code}, ${this.asI128(i)})`, e.type);
      }
      case "map": {
        const o = this.compile(e.array, ctx);
        const at = e.array.type;
        let opt = false;
        const et = at.kind === "array" ? at.element : undefined;
        if (et && et.kind === "struct")
          opt = this.model.isOptionalMember(this.model.struct(et.struct), e.field);
        const acc = `yaffle::obj(e_).${this.model.member(e.field)}`;
        return {
          code: `yaffle::map_values(${o.code}, [&](const auto& e_) { return ${opt ? `yaffle::obj(${acc})` : acc}; })`,
          repr: "other",
          vt: e.type
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
        if (a.repr === "int" && b.repr === "int") {
          const range: Range = [minB(a.range![0], b.range![0]), maxB(a.range![1], b.range![1])];
          if (fitsI64(range) && fitsI64(a.range) && fitsI64(b.range))
            return i64(`(${t.code} ? ${this.asI64(a)} : ${this.asI64(b)})`, range);
          return i128(`(${t.code} ? ${this.asI128(a)} : ${this.asI128(b)})`, range);
        }
        if (a.repr === "float" || b.repr === "float")
          return { code: `(${t.code} ? ${this.asF64(a)} : ${this.asF64(b)})`, repr: "float" };
        if (a.repr === "str" || b.repr === "str")
          return {
            code: `(${t.code} ? std::string(${a.code}) : std::string(${b.code}))`,
            repr: "str"
          };
        return { code: `(${t.code} ? ${a.code} : ${b.code})`, repr: a.repr, vt: e.type };
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
        return { code: `yaffle::regex_match(${v.code}, ${str(e.pattern)})`, repr: "bool" };
      }
      case "this":
        throw new Error("`this` is only valid as the argument of sizeof/offsetof/bytesof/encode");
      case "lambda": {
        // Lambdas are arguments of map/filter/indicesWhere/sortedBy; standalone they are a C++
        // lambda returning the body.
        const l = this.lambda(e, ctx);
        return { code: `[&](const auto& ${l.param}) { return ${l.body.code}; }`, repr: "other" };
      }
      case "convert": {
        const o = this.compile(e.operand, ctx);
        const from = e.operand.type;
        if (from.kind === "enum" && (e.type.kind === "int" || e.type.kind === "bigint")) {
          const en = this.model.enum(from.enum);
          const bits = Number(en.storage.slice(1));
          return i64(
            `static_cast<std::int64_t>(${o.code})`,
            bits >= 64 && en.storage[0] === "u" ? I64 : intRange(bits, en.storage[0] === "i")
          );
        }
        if (e.type.kind === "float") {
          return { code: this.asF64(o), repr: "float", vt: { kind: "float", bits: 64 } };
        }
        if (e.type.kind === "int" || e.type.kind === "bigint") {
          if (o.repr === "float") {
            const rr = this.rangeOf(e.type) ?? I128;
            return i128(`yaffle::trunc_to_int(${o.code})`, rr);
          }
          if (o.repr === "bool") return i64(`static_cast<std::int64_t>(${o.code})`, [0n, 1n]);
          return o;
        }
        if (e.type.kind === "enum" && o.repr === "int") {
          return {
            code: `static_cast<${this.model.enumName(e.type.enum)}>(${this.asI128(o)})`,
            repr: "enum",
            vt: e.type
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
    const param = `lp${this.lambdaCount++}_${e.param.replace(/[^A-Za-z0-9_]/g, "_")}`;
    const name = e.param;
    const inner: ExprCtx = { ...ctx, lambda: n => (n === name ? param : ctx.lambda(n)) };
    return { param, body: this.compile(e.body, inner) };
  }

  literal(v: IrLiteral, t: IrValueType): CExpr {
    switch (v.kind) {
      case "int": {
        const b = BigInt(v.value);
        if (t.kind === "float") return { code: floatLit(Number(b)), repr: "float" };
        return { code: intLit(b), repr: "int", range: [b, b], lit: b, it: "lit" };
      }
      case "float":
        return { code: floatLit(v.value), repr: "float" };
      case "bool":
        return { code: String(v.value), repr: "bool" };
      case "string":
        return { code: str(v.value), repr: "str" };
      case "bytes":
        return { code: `yaffle::from_hex(${str(v.hex)})`, repr: "bytes" };
      case "endian":
        return { code: `yaffle::Endian::${v.value}`, repr: "endian" };
      case "enum":
        return {
          code: `${this.model.enumName(v.enum)}::${enumMember(v.member)}`,
          repr: "enum",
          vt: { kind: "enum", enum: v.enum }
        };
    }
  }

  private unary(op: "-" | "!" | "~", o: CExpr, t: IrValueType): CExpr {
    if (op === "!") return { code: `!${wrap(o.code)}`, repr: "bool" };
    if (o.repr === "float" || t.kind === "float")
      return { code: `(-${wrap(this.asF64(o))})`, repr: "float" };
    const r = o.range ?? I128;
    const range: Range = op === "-" ? [-r[1], -r[0]] : [-r[1] - 1n, -r[0] - 1n];
    if (fitsI64(range) && fitsI64(r)) {
      const x = this.asI64(o);
      return i64(op === "-" ? `(-${wrap(x)})` : `(~${wrap(x)})`, range);
    }
    const x = this.asI128(o);
    if (op === "-" && !fitsI128(range)) return i128(`yaffle::neg(${x})`, clampI128(range));
    return i128(op === "-" ? `(-${wrap(x)})` : `(~${wrap(x)})`, clampI128(range));
  }

  private binary(op: string, le: IrExpr, re: IrExpr, t: IrValueType, ctx: ExprCtx): CExpr {
    const a = this.compile(le, ctx);
    const b = this.compile(re, ctx);
    if (op === "&&" || op === "||") return { code: `(${a.code} ${op} ${b.code})`, repr: "bool" };
    if (op === "==" || op === "!=") return { code: this.equality(op, a, b), repr: "bool" };
    if (op === "<" || op === "<=" || op === ">" || op === ">=")
      return { code: this.relational(op, a, b), repr: "bool" };
    return this.arith(op, a, b, t);
  }

  equality(op: "==" | "!=", a: CExpr, b: CExpr): string {
    const num = (c: CExpr): boolean => c.repr === "int" || c.repr === "float";
    if (num(a) && num(b)) {
      if (a.repr === "float" || b.repr === "float")
        return `(${this.asF64(a)} ${op} ${this.asF64(b)})`;
      const [x, y] = this.decided(a, b, op);
      if (fitsI64(a.range) && fitsI64(b.range))
        return `(${x(this.asI64(a))} ${op} ${y(this.asI64(b))})`;
      return `(${x(this.asI128(a))} ${op} ${y(this.asI128(b))})`;
    }
    if (a.repr === "enum" && b.repr === "int") return `(${this.asI128(a)} ${op} ${this.asI128(b)})`;
    if (a.repr === "int" && b.repr === "enum") return `(${this.asI128(a)} ${op} ${this.asI128(b)})`;
    if (a.repr === "str" && b.repr === "str" && a.code.startsWith('"') && b.code.startsWith('"'))
      return `(std::string_view(${a.code}) ${op} std::string_view(${b.code}))`;
    if (a.repr === "bytes" && b.repr === "bytes")
      return `(yaffle::Bytes(${a.code}) ${op} yaffle::Bytes(${b.code}))`;
    // Composite values: arrays element-wise (bytes equal arrays of the same numbers),
    // structs by canonical JSON.
    if (a.repr === "other" || b.repr === "other")
      return `(${op === "!=" ? "!" : ""}yaffle::equals(${a.code}, ${b.code}))`;
    return `(${a.code} ${op} ${b.code})`;
  }

  /**
   * Wrappers for the operands of an integer comparison. When the static ranges already decide
   * it (`u8 >= 0`, `mid in (0..99)`), GCC's -Wtype-limits would flag the comparison: the
   * non-literal operand then goes through `yaffle::opaque`, an identity GCC can't see through.
   * The comparison itself stays (operands may throw, e.g. a checked index).
   */
  private decided(a: CExpr, b: CExpr, op: string): [(c: string) => string, (c: string) => string] {
    const id = (c: string): string => c;
    const ra = a.range;
    const rb = b.range;
    if (!ra || !rb) return [id, id];
    let known: boolean;
    switch (op) {
      case "<":
        known = ra[1] < rb[0] || ra[0] >= rb[1];
        break;
      case "<=":
        known = ra[1] <= rb[0] || ra[0] > rb[1];
        break;
      case ">":
        known = ra[0] > rb[1] || ra[1] <= rb[0];
        break;
      case ">=":
        known = ra[0] >= rb[1] || ra[1] < rb[0];
        break;
      default:
        known = ra[1] < rb[0] || rb[1] < ra[0] || (ra[0] === ra[1] && rb[0] === rb[1]);
    }
    if (!known) return [id, id];
    const o = (c: string): string => `yaffle::opaque(${c})`;
    if (a.lit !== undefined && b.lit !== undefined) return [o, id];
    return [a.lit !== undefined ? id : o, b.lit !== undefined ? id : o];
  }

  relational(op: string, a: CExpr, b: CExpr): string {
    if (a.repr === "float" || b.repr === "float")
      return `(${this.asF64(a)} ${op} ${this.asF64(b)})`;
    if (a.repr === "int" || b.repr === "int" || a.repr === "enum" || b.repr === "enum") {
      const [x, y] = this.decided(a, b, op);
      if (a.repr !== "enum" && b.repr !== "enum" && fitsI64(a.range) && fitsI64(b.range))
        return `(${x(this.asI64(a))} ${op} ${y(this.asI64(b))})`;
      return `(${x(this.asI128(a))} ${op} ${y(this.asI128(b))})`;
    }
    return `(${a.code} ${op} ${b.code})`;
  }

  private arith(op: string, a: CExpr, b: CExpr, t: IrValueType): CExpr {
    if (t.kind === "float" || a.repr === "float" || b.repr === "float") {
      if (op === "%")
        return { code: `std::fmod(${this.asF64(a)}, ${this.asF64(b)})`, repr: "float" };
      if (op !== "<<" && op !== ">>" && op !== "&" && op !== "|" && op !== "^")
        return { code: `(${this.asF64(a)} ${op} ${this.asF64(b)})`, repr: "float" };
    }
    const ra = a.range ?? I128;
    const rb = b.range ?? I128;
    const both64 = fitsI64(ra) && fitsI64(rb);
    const result = (code64: string, code128: string, checked: string, range: Range): CExpr => {
      if (both64 && fitsI64(range)) return i64(code64, range);
      if (fitsI128(range)) return i128(code128, range);
      return i128(checked, clampI128(range));
    };
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
        const fn = op === "+" ? "add" : op === "-" ? "sub" : "mul";
        return result(
          `(${this.asI64(a)} ${op} ${this.asI64(b)})`,
          `(${this.asI128(a)} ${op} ${this.asI128(b)})`,
          `yaffle::${fn}(${this.asI128(a)}, ${this.asI128(b)})`,
          range
        );
      }
      case "/": {
        const m = maxB(absB(ra[0]), absB(ra[1]));
        const range: Range = [-m, m];
        const safeDivisor = b.lit !== undefined && b.lit > 0n;
        if (safeDivisor && both64 && fitsI64(range))
          return i64(`(${this.asI64(a)} / ${this.asI64(b)})`, range);
        if (safeDivisor && fitsI128(range))
          return i128(`(${this.asI128(a)} / ${this.asI128(b)})`, range);
        return i128(`yaffle::div(${this.asI128(a)}, ${this.asI128(b)})`, clampI128(range));
      }
      case "%": {
        const mb = maxB(absB(rb[0]), absB(rb[1]));
        const ma = maxB(absB(ra[0]), absB(ra[1]));
        const m = minB(ma, mb > 0n ? mb - 1n : 0n);
        const range: Range = [ra[0] < 0n ? -m : 0n, m];
        if (b.lit !== undefined && b.lit > 0n && both64)
          return i64(`(${this.asI64(a)} % ${this.asI64(b)})`, range);
        return i128(`yaffle::mod(${this.asI128(a)}, ${this.asI128(b)})`, range);
      }
      case "<<": {
        const maxShift = b.lit !== undefined ? b.lit : rb[1] > 63n ? 63n : rb[1] < 0n ? 0n : rb[1];
        const minShift = b.lit !== undefined ? b.lit : rb[0] < 0n ? 0n : rb[0] > 63n ? 63n : rb[0];
        const f1 = 1n << (maxShift < 0n ? 0n : maxShift);
        const f0 = 1n << (minShift < 0n ? 0n : minShift);
        const ps = [ra[0] * f1, ra[0] * f0, ra[1] * f1, ra[1] * f0];
        const range: Range = [minB(...ps), maxB(...ps)];
        if (b.lit !== undefined && b.lit >= 0n && b.lit <= 63n) {
          if (fitsI64(ra) && fitsI64(range))
            return i64(`(${this.asI64(a)} * ${intLit(1n << b.lit)})`, range);
          if (fitsI128(range)) return i128(`(${this.asI128(a)} * ${intLit(1n << b.lit)})`, range);
        }
        return i128(`yaffle::shl(${this.asI128(a)}, ${this.asI128(b)})`, clampI128(range));
      }
      case ">>": {
        const range: Range = [ra[0] < 0n ? ra[0] : 0n, ra[1] > 0n ? ra[1] : 0n];
        if (b.lit !== undefined && b.lit >= 0n && b.lit <= 63n) {
          if (fitsI64(ra)) return i64(`(${this.asI64(a)} >> ${b.lit})`, range);
          return i128(`(${this.asI128(a)} >> ${b.lit})`, range);
        }
        return i128(`yaffle::shr(${this.asI128(a)}, ${this.asI128(b)})`, range);
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
          const lo = minB(ra[0], rb[0]);
          const hi = maxB(ra[1], rb[1], -lo);
          let p = 1n;
          while (p <= hi) p <<= 1n;
          range = [-p, p - 1n];
        }
        if (both64) return i64(`(${this.asI64(a)} ${op} ${this.asI64(b)})`, range);
        return i128(`(${this.asI128(a)} ${op} ${this.asI128(b)})`, clampI128(range));
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
        return p ? this.to(c, p.type, p.name) : c.code;
      });
      const ret = x.kind === "fn" ? x.returns : e.type;
      const fn = ctx.externFn(e.callee.extern);
      return this.typed(
        `static_cast<${this.types.valueType(ret)}>(yaffle::call_host(${str(x.name)}, [&](auto&&... a_) { return ${fn}(a_...); }${args.map(a => ", " + a).join("")}))`,
        ret
      );
    }
    const name = e.callee.name;
    const fieldArg = (): string => {
      const a = e.args[0];
      if (a && a.kind === "this") return "this";
      if (!a || a.kind !== "field") throw new Error(`${name}() needs a field argument`);
      return a.name;
    };
    // over one array, or one byte string (`u8` arrays)
    const oneArray =
      e.args.length === 1 && (e.args[0]!.type.kind === "array" || e.args[0]!.type.kind === "bytes");
    const len: Range = [0n, LEN_MAX];
    switch (name) {
      case "sum": {
        const a = this.compile(e.args[0]!, ctx);
        if (e.type.kind === "float") return { code: `yaffle::sum_float(${a.code})`, repr: "float" };
        return i128(`yaffle::sum_int(${a.code})`, I128);
      }
      case "lengths": {
        const a = this.compile(e.args[0]!, ctx);
        return { code: `yaffle::lengths(${a.code})`, repr: "other", vt: e.type };
      }
      case "sizeof":
        return i64(ctx.sizeof(fieldArg()), len);
      case "offsetof":
        return i64(ctx.offsetof(fieldArg()), [-LEN_MAX, LEN_MAX]);
      case "encodedSize": {
        const k = e.args[1];
        const layer =
          k && k.kind === "literal" && k.value.kind === "int" ? Number(k.value.value) : 0;
        return i64(ctx.encodedSize(fieldArg(), layer), len);
      }
      case "bytesof":
        return { code: ctx.bytesof(fieldArg()), repr: "bytes" };
      case "encode":
        return { code: ctx.encode(fieldArg()), repr: "bytes" };
      case "crc32":
      case "adler32": {
        const a = this.compile(e.args[0]!, ctx);
        return i64(`static_cast<std::int64_t>(yaffle::${name}(${a.code}))`, [0n, (1n << 32n) - 1n]);
      }
      case "min":
      case "max": {
        if (oneArray) {
          const a = this.compile(e.args[0]!, ctx);
          const vt = e.type;
          return this.typed(`yaffle::${name}_of(${a.code})`, vt);
        }
        const xs = e.args.map(a => this.compile(a, ctx));
        if (xs.some(x => x.repr === "float")) {
          let code = this.asF64(xs[0]!);
          for (const x of xs.slice(1)) code = `std::f${name}(${code}, ${this.asF64(x)})`;
          return { code, repr: "float" };
        }
        const ranges = xs.map(x => x.range ?? I128);
        const range: Range =
          name === "min"
            ? [minB(...ranges.map(r => r[0])), minB(...ranges.map(r => r[1]))]
            : [maxB(...ranges.map(r => r[0])), maxB(...ranges.map(r => r[1]))];
        if (ranges.every(r => fitsI64(r)))
          return i64(
            `std::${name}<std::int64_t>({${xs.map(x => this.asI64(x)).join(", ")}})`,
            range
          );
        return i128(
          `std::${name}<yaffle::i128>({${xs.map(x => this.asI128(x)).join(", ")}})`,
          range
        );
      }
      case "abs": {
        const x = this.compile(e.args[0]!, ctx);
        if (x.repr === "float") return { code: `std::fabs(${this.asF64(x)})`, repr: "float" };
        const r = x.range ?? I128;
        const m = maxB(absB(r[0]), absB(r[1]));
        return i128(`yaffle::abs_int(${this.asI128(x)})`, clampI128([0n, m]));
      }
      case "round": {
        const x = this.compile(e.args[0]!, ctx);
        const tr = this.rangeOf(e.type) ?? I128;
        return i128(`yaffle::round_half_away(${this.asF64(x)})`, tr);
      }
      case "indexOf": {
        const arr = this.compile(e.args[0]!, ctx);
        const v = this.compile(e.args[1]!, ctx);
        return i64(`yaffle::index_of(${arr.code}, ${v.code})`, len);
      }
      case "len": {
        const a = this.compile(e.args[0]!, ctx);
        if (a.repr === "str") {
          let enc = "utf8";
          const a0 = e.args[0]!;
          if (a0.kind === "field") {
            const ft = ctx.fieldType(a0.name);
            let x = ft;
            while (x && (x.kind === "layered" || x.kind === "transform")) x = x.inner;
            if (x && x.kind === "string") enc = x.encoding;
          }
          return i64(`yaffle::code_units(${a.code}, yaffle::Encoding::${enc})`, len);
        }
        return i64(`yaffle::size_of(${a.code})`, len);
      }
      // Derived arrays.
      case "map": {
        const arr = this.compile(e.args[0]!, ctx);
        const l = this.lambda(e.args[1]!, ctx);
        const el = e.type.kind === "array" ? e.type.element : undefined;
        const R = el ? this.types.valueType(el) : `std::decay_t<decltype(${l.body.code})>`;
        const body = el ? this.to(l.body, el) : l.body.code;
        return {
          code: `yaffle::map_arr<${R}>(${arr.code}, [&](const auto& ${l.param}) -> ${R} { return ${body}; })`,
          repr: "other",
          vt: e.type
        };
      }
      case "filter":
      case "indicesWhere":
      case "sortedBy": {
        const arr = this.compile(e.args[0]!, ctx);
        const l = this.lambda(e.args[1]!, ctx);
        const fn = { filter: "filter_arr", indicesWhere: "indices_where", sortedBy: "sorted_by" }[
          name
        ];
        return {
          code: `yaffle::${fn}(${arr.code}, [&]([[maybe_unused]] const auto& ${l.param}) { return ${l.body.code}; })`,
          repr: "other",
          vt: e.type
        };
      }
      case "unique": {
        const arr = this.compile(e.args[0]!, ctx);
        return { code: `yaffle::unique_arr(${arr.code})`, repr: "other", vt: e.type };
      }
      case "concat": {
        const xs = e.args.map(a => this.compile(a, ctx).code);
        return { code: `yaffle::concat_arr(${xs.join(", ")})`, repr: "other", vt: e.type };
      }
      case "isNull": {
        const x = this.compile(e.args[0]!, ctx);
        return { code: `yaffle::is_null(${x.code})`, repr: "bool" };
      }
      case "encodedLength": {
        const s = this.compile(e.args[0]!, ctx);
        const encArg = e.args[2];
        const enc =
          encArg && encArg.kind === "literal" && encArg.value.kind === "string"
            ? encArg.value.value
            : "utf8";
        return i64(`yaffle::encoded_bytes(${s.code}, yaffle::Encoding::${enc})`, len);
      }
    }
    throw new Error(`unsupported builtin ${String(name)}`);
  }
}

function wrap(code: string): string {
  return /^[A-Za-z0-9_.]+$/.test(code) || /^\(.*\)$/.test(code) ? code : `(${code})`;
}

function i64(code: string, range: Range): CExpr {
  return { code, repr: "int", range, it: "i64" };
}

function i128(code: string, range: Range): CExpr {
  return { code, repr: "int", range, it: "i128" };
}
