/**
 * IR expressions → Python expressions, implementing the integer semantics of docs/IR.md §6.
 *
 * Python integers are exact, so there is no number/bigint split. Integer subexpressions still
 * carry a value range: it lets the compiler use plain `//`, `%`, `<<` and `>>` where they agree
 * with the IR's truncating semantics, and skip length checks on values known to be non-negative.
 */
import type {
  ExternId,
  IrBuiltinFn,
  IrExpr,
  IrLiteral,
  IrType,
  IrValueType
} from "../../ir/index.ts";
import { paren, pyBool, pyBytes, pyFloat, pyInt, pyStr, stripParens } from "./code.ts";
import { stripType, type Model, type Range } from "./model.ts";

type Kind = "int" | "float" | "bool" | "str" | "bytes" | "other";

export interface CExpr {
  code: string;
  kind: Kind;
  /** Integer range (integer expressions). */
  range?: Range;
  /** Set for integer literals. */
  lit?: bigint;
  /** Set for float literals. */
  flit?: number;
}

const LEN_MAX = 1n << 48n;

/** A length, size or offset: a non-negative int. */
const lengthOf = (code: string): CExpr => ({ code, kind: "int", range: [0n, LEN_MAX] });
const FULL: Range = [-(1n << 64n), 1n << 64n];

function intRange(bits: number, signed: boolean): Range {
  const b = BigInt(bits);
  return signed ? [-(1n << (b - 1n)), (1n << (b - 1n)) - 1n] : [0n, (1n << b) - 1n];
}

/** The range of an integer storage kind ("u8", "i16", …). */
function storageRange(storage: string): Range {
  return intRange(Number(storage.slice(1)), storage[0] === "i");
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

/** What an expression's names mean where it is compiled (reader, writer, root API, …). */
export interface ExprCtx {
  field(name: string, type: IrValueType): CExpr;
  param(name: string, type: IrValueType): CExpr;
  it(type: IrValueType): CExpr;
  lambda(name: string): string;
  /** `$offset`, `$end`, `$index`. */
  builtin(name: "offset" | "end" | "index"): string;
  sizeof(field: string): string;
  offsetof(field: string): string;
  encodedSize(field: string, layer: number): string;
  bytesof(field: string): string;
  encode(field: string): string;
  /** Local name of an extern implementation. */
  externFn(id: string): string;
  /** Hoists a module-level constant and returns its name. */
  hoist(code: string, hint: string): string;
  /** IR type of a field of the current struct (for len() of strings). */
  fieldType(name: string): IrType | undefined;
  /** Python reference to an enum class / its value maps. */
  enumRef(id: string, what: "class" | "members" | "values"): string;
  /** Attribute name of a field of a struct. */
  attr(structId: string, name: string): string;
  /** Python reference to an enum member (`Kind.Gpu`). */
  enumMember(id: string, member: string): string;
  /** Requests a module import (e.g. "re"). */
  need(module: string): void;
  /** Python reference to a struct's `_to_json_X` (composite equality compares canonical JSON). */
  toJson?(structId: string): string;
}

/**
 * A context outside any struct (parameter defaults, piece lengths, value ranges): every name and
 * position compiles to `placeholder()`. Callers override what they support.
 */
export function detachedCtx(placeholder: () => string = () => "None"): ExprCtx {
  const value = (): CExpr => ({ code: placeholder(), kind: "other" });
  return {
    field: value,
    param: value,
    it: value,
    lambda: placeholder,
    builtin: placeholder,
    sizeof: placeholder,
    offsetof: placeholder,
    encodedSize: placeholder,
    bytesof: placeholder,
    encode: placeholder,
    externFn: placeholder,
    hoist: placeholder,
    fieldType: () => undefined,
    enumRef: placeholder,
    enumMember: placeholder,
    attr: (_s, name) => name,
    need: () => {}
  };
}

export class ExprCompiler {
  readonly model: Model;
  /** Lambda parameters in scope: IR name → Python names (innermost last). */
  private readonly lambdaScope = new Map<string, string[]>();
  private lambdaCount = 0;
  constructor(model: Model) {
    this.model = model;
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
      case "extern":
        return this.kindOf(t.valueType);
      default:
        return "other";
    }
  }

  rangeOf(t: IrValueType): Range | undefined {
    if (t.kind === "int") return intRange(t.bits, t.signed);
    if (t.kind === "bigint") return FULL;
    if (t.kind === "extern") return this.rangeOf(t.valueType);
    if (t.kind === "enum") return storageRange(this.model.enum(t.enum).storage);
    return undefined;
  }

  /** Wraps a typed value (field, param, it) as a CExpr. */
  typed(code: string, t: IrValueType): CExpr {
    const c: CExpr = { code, kind: this.kindOf(t) };
    const r = this.rangeOf(t);
    if (r && c.kind === "int") c.range = r;
    return c;
  }

  /** A non-negative integer (lengths, counts). */
  asLen(c: CExpr, what = "length"): string {
    if (c.kind === "int" && c.range && c.range[0] >= 0n) return c.code;
    return `_rt.length(${stripParens(c.code)}, ${pyStr(what)})`;
  }

  /** An integer (offsets). */
  asOffset(c: CExpr): string {
    if (c.kind === "int") return c.code;
    return `_rt.offset(${stripParens(c.code)})`;
  }

  /** Converts to the representation of a destination value type. */
  to(c: CExpr, t: IrValueType): string {
    if (t.kind === "float" && c.kind === "int") {
      if (c.lit !== undefined) return pyFloat(Number(c.lit));
      return `float(${stripParens(c.code)})`;
    }
    // A derived array (map, indicesWhere, …) written to a u8 array.
    if (t.kind === "bytes" && c.kind === "other") return `_rt.as_bytes(${stripParens(c.code)})`;
    return c.code;
  }

  /** `x => body` as a Python lambda (a fresh parameter name per lambda). */
  lambda(e: Extract<IrExpr, { kind: "lambda" }>, ctx: ExprCtx): string {
    const name = `_lam_${e.param.replace(/\W/g, "_")}_${++this.lambdaCount}`;
    const stack = this.lambdaScope.get(e.param) ?? [];
    stack.push(name);
    this.lambdaScope.set(e.param, stack);
    try {
      const body = this.compile(e.body, ctx);
      return `(lambda ${name}: ${stripParens(body.code)})`;
    } finally {
      stack.pop();
    }
  }

  /**
   * A canonicalizer for values of type `t` whose Python equality differs from canonical-JSON
   * equality (structs, floats, arrays of them), or undefined.
   */
  canonOf(t: IrValueType, ctx: ExprCtx): string | undefined {
    switch (t.kind) {
      case "struct":
        return ctx.toJson
          ? `(lambda _cx: ${ctx.toJson(t.struct)}(_cx, _rt.ToJsonCtx(), ""))`
          : undefined;
      case "float":
        return "_rt.float_to_json";
      case "array":
        return this.canonOf(t.element, ctx);
      case "nullable":
        return this.canonOf(t.inner, ctx);
      case "union":
        return t.variants.some(v => this.canonOf(v.type, ctx))
          ? `(lambda _cx: (_cx.type, _rt.canonical(_cx.value, {${t.variants
              .map(v => `${pyStr(v.name)}: ${this.canonOf(v.type, ctx) ?? "None"}`)
              .join(", ")}}.get(_cx.type))))`
          : undefined;
      default:
        return undefined;
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
      case "lambdaParam": {
        const scoped = this.lambdaScope.get(e.name);
        if (scoped && scoped.length) return this.typed(scoped[scoped.length - 1]!, e.type);
        return lengthOf(ctx.lambda(e.name));
      }
      case "builtinValue":
        return {
          code: ctx.builtin(e.name),
          kind: "int",
          range: [e.name === "index" ? -1n : 0n, LEN_MAX]
        };
      case "member": {
        const o = this.compile(e.object, ctx);
        const ot = e.object.type;
        const attr =
          ot.kind === "struct" ? ctx.attr(ot.struct, e.name) : e.name.replace(/\W/g, "_");
        return this.typed(`${paren(o.code)}.${attr}`, e.type);
      }
      case "index": {
        const o = this.compile(e.object, ctx);
        const i = this.compile(e.index, ctx);
        return this.typed(`_rt.at(${o.code}, ${stripParens(i.code)})`, e.type);
      }
      case "map": {
        const o = this.compile(e.array, ctx);
        const at = e.array.type;
        const el = at.kind === "array" ? stripNullable(at.element) : undefined;
        const attr =
          el && el.kind === "struct" ? ctx.attr(el.struct, e.field) : e.field.replace(/\W/g, "_");
        return { code: `[_e.${attr} for _e in ${o.code}]`, kind: "other" };
      }
      case "unary":
        return this.unary(e.op, this.compile(e.operand, ctx), e.type);
      case "binary":
        return this.binary(e.op, e.left, e.right, e.type, ctx);
      case "cond": {
        const t = this.compile(e.test, ctx);
        const a = this.compile(e.then, ctx);
        const b = this.compile(e.else, ctx);
        const r: CExpr = {
          code: `(${a.code} if ${t.code} else ${b.code})`,
          kind: a.kind === "float" || b.kind === "float" ? "float" : a.kind
        };
        if (a.range && b.range)
          r.range = [minB(a.range[0], b.range[0]), maxB(a.range[1], b.range[1])];
        return r;
      }
      case "call":
        return e.callee.kind === "extern"
          ? this.externCall(e, e.callee.extern, ctx)
          : this.builtinCall(e, e.callee.name, ctx);
      case "in": {
        const v = this.compile(e.value, ctx);
        const parts = e.items.map(it => {
          if (it.kind === "value") return `${v.code} == ${this.compile(it.value, ctx).code}`;
          const lo = this.compile(it.low, ctx);
          const hi = this.compile(it.high, ctx);
          return `${lo.code} <= ${v.code} <= ${hi.code}`;
        });
        return { code: parts.length ? `(${parts.join(" or ")})` : "False", kind: "bool" };
      }
      case "regex": {
        const v = this.compile(e.value, ctx);
        ctx.need("re");
        const re = ctx.hoist(`_re.compile(${pyStr(jsRegexToPython(e.pattern))}, _re.ASCII)`, "re");
        return { code: `(${re}.fullmatch(${v.code}) is not None)`, kind: "bool" };
      }
      case "lambda":
        return { code: this.lambda(e, ctx), kind: "other" };
      case "this":
        throw new Error("`this` is only valid as the argument of sizeof/offsetof/bytesof/encode");
      case "convert": {
        const o = this.compile(e.operand, ctx);
        const from = e.operand.type;
        if (from.kind === "enum" && (e.type.kind === "int" || e.type.kind === "bigint")) {
          const en = this.model.enum(from.enum);
          return {
            code: `_rt.enum_value(${ctx.enumRef(from.enum, "values")}, ${ctx.enumRef(from.enum, "members")}, ${pyBool(en.open)}, ${o.code})`,
            kind: "int",
            range: storageRange(en.storage)
          };
        }
        if (e.type.kind === "float") {
          if (o.kind === "float") return o;
          if (o.lit !== undefined)
            return { code: pyFloat(Number(o.lit)), kind: "float", flit: Number(o.lit) };
          return { code: `float(${stripParens(o.code)})`, kind: "float" };
        }
        if (e.type.kind === "int" || e.type.kind === "bigint") {
          if (o.kind === "float") {
            const r: CExpr = { code: `_rt.trunc(${stripParens(o.code)})`, kind: "int" };
            const rr = this.rangeOf(e.type);
            if (rr) r.range = rr;
            return r;
          }
          if (o.kind === "int") return o;
          return this.typed(o.code, e.type);
        }
        if (e.type.kind === "enum" && o.kind === "int") {
          return {
            code: `_rt.enum_of(${ctx.enumRef(e.type.enum, "class")}, ${o.code})`,
            kind: "other"
          };
        }
        return o;
      }
    }
  }

  literal(v: IrLiteral, t: IrValueType, ctx: ExprCtx): CExpr {
    switch (v.kind) {
      case "int": {
        const b = BigInt(v.value);
        if (t.kind === "float") return { code: pyFloat(Number(b)), kind: "float", flit: Number(b) };
        return { code: pyInt(b), kind: "int", range: [b, b], lit: b };
      }
      case "float":
        return { code: pyFloat(v.value), kind: "float", flit: v.value };
      case "bool":
        return { code: v.value ? "True" : "False", kind: "bool" };
      case "string":
        return { code: pyStr(v.value), kind: "str" };
      case "bytes":
        return { code: ctx.hoist(pyBytes(v.hex), "b"), kind: "bytes" };
      case "endian":
        return { code: pyStr(v.value), kind: "other" };
      case "enum": {
        const en = this.model.enum(v.enum);
        const m = en.members.find(x => x.name === v.member);
        const r: CExpr = { code: ctx.enumMember(v.enum, v.member), kind: "other" };
        if (m) {
          const b = BigInt(m.value);
          r.range = [b, b];
        }
        return r;
      }
    }
  }

  private unary(op: "-" | "!" | "~", o: CExpr, t: IrValueType): CExpr {
    if (op === "!") return { code: `(not ${o.code})`, kind: "bool" };
    if (o.kind === "float" || t.kind === "float") {
      if (o.flit !== undefined) return { code: pyFloat(-o.flit), kind: "float", flit: -o.flit };
      return { code: `(-${o.code})`, kind: "float" };
    }
    const r = o.range ?? FULL;
    if (op === "-") {
      if (o.lit !== undefined)
        return { code: pyInt(-o.lit), kind: "int", range: [-o.lit, -o.lit], lit: -o.lit };
      return { code: `(-${o.code})`, kind: "int", range: [-r[1], -r[0]] };
    }
    return { code: `(~${o.code})`, kind: "int", range: [-r[1] - 1n, -r[0] - 1n] };
  }

  private binary(op: string, le: IrExpr, re: IrExpr, t: IrValueType, ctx: ExprCtx): CExpr {
    const a = this.compile(le, ctx);
    const b = this.compile(re, ctx);
    if (op === "&&" || op === "||") {
      return { code: `(${a.code} ${op === "&&" ? "and" : "or"} ${b.code})`, kind: "bool" };
    }
    if ((op === "==" || op === "!=") && (isComposite(le.type) || isComposite(re.type))) {
      // Composite values compare by value: arrays element-wise, structs by canonical JSON.
      const canon = this.canonOf(isComposite(le.type) ? le.type : re.type, ctx);
      const eq = `_rt.equal(${stripParens(a.code)}, ${stripParens(b.code)}${canon ? `, ${canon}` : ""})`;
      return { code: op === "==" ? eq : `(not ${eq})`, kind: "bool" };
    }
    if (op === "==" || op === "!=" || op === "<" || op === "<=" || op === ">" || op === ">=") {
      return { code: `(${a.code} ${op} ${b.code})`, kind: "bool" };
    }
    return this.arith(op, a, b, t);
  }

  private arith(op: string, a: CExpr, b: CExpr, t: IrValueType): CExpr {
    if (t.kind === "float" || a.kind === "float" || b.kind === "float") {
      switch (op) {
        case "+":
        case "-":
        case "*":
          return { code: `(${a.code} ${op} ${b.code})`, kind: "float" };
        case "/": {
          const lit = b.flit ?? (b.lit !== undefined ? Number(b.lit) : undefined);
          if (lit !== undefined && lit !== 0 && Number.isFinite(lit))
            return { code: `(${a.code} / ${b.code})`, kind: "float" };
          return { code: `_rt.fdiv(${a.code}, ${b.code})`, kind: "float" };
        }
        case "%":
          return { code: `_rt.fmod(${a.code}, ${b.code})`, kind: "float" };
      }
    }
    const ra = a.range ?? FULL;
    const rb = b.range ?? FULL;
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
        return { code: `(${a.code} ${op} ${b.code})`, kind: "int", range };
      }
      case "/": {
        const m = maxB(absB(ra[0]), absB(ra[1]));
        const range: Range = [-m, m];
        if (ra[0] >= 0n && b.lit !== undefined && b.lit > 0n)
          return { code: `(${a.code} // ${b.code})`, kind: "int", range: [0n, ra[1] / b.lit] };
        if (ra[0] >= 0n && rb[0] > 0n)
          return { code: `(${a.code} // ${b.code})`, kind: "int", range: [0n, ra[1]] };
        return { code: `_rt.div(${a.code}, ${b.code})`, kind: "int", range };
      }
      case "%": {
        const mb = maxB(absB(rb[0]), absB(rb[1]));
        const ma = maxB(absB(ra[0]), absB(ra[1]));
        const m = minB(ma, mb > 0n ? mb - 1n : 0n);
        const range: Range = [ra[0] < 0n ? -m : 0n, m];
        if (ra[0] >= 0n && rb[0] > 0n)
          return { code: `(${a.code} % ${b.code})`, kind: "int", range };
        return { code: `_rt.mod(${a.code}, ${b.code})`, kind: "int", range };
      }
      case "<<": {
        const maxShift = b.lit !== undefined ? b.lit : rb[1] > 63n ? 63n : rb[1];
        const minShift = b.lit !== undefined ? b.lit : rb[0] < 0n ? 0n : rb[0];
        const f1 = 1n << (maxShift < 0n ? 0n : maxShift);
        const f0 = 1n << (minShift < 0n ? 0n : minShift);
        const ps = [ra[0] * f1, ra[0] * f0, ra[1] * f1, ra[1] * f0];
        const range: Range = [minB(...ps), maxB(...ps)];
        if (b.lit !== undefined && b.lit >= 0n && b.lit <= 63n)
          return { code: `(${a.code} << ${b.code})`, kind: "int", range };
        return { code: `_rt.shl(${a.code}, ${b.code})`, kind: "int", range };
      }
      case ">>": {
        const range: Range = [ra[0] < 0n ? ra[0] : 0n, ra[1] > 0n ? ra[1] : 0n];
        if (b.lit !== undefined && b.lit >= 0n && b.lit <= 63n)
          return { code: `(${a.code} >> ${b.code})`, kind: "int", range };
        return { code: `_rt.shr(${a.code}, ${b.code})`, kind: "int", range };
      }
      case "&":
      case "|":
      case "^": {
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
        return { code: `(${a.code} ${op} ${b.code})`, kind: "int", range };
      }
    }
    throw new Error(`unknown operator ${op}`);
  }

  private externCall(e: Extract<IrExpr, { kind: "call" }>, extern: ExternId, ctx: ExprCtx): CExpr {
    const x = this.model.extern(extern);
    const params = x.kind === "fn" ? x.params : [];
    const args = e.args.map((a, i) => {
      const c = this.compile(a, ctx);
      const p = params[i];
      return p ? this.to(c, p.type) : c.code;
    });
    const ret = x.kind === "fn" ? x.returns : e.type;
    const call = `_rt.call_host(${ctx.externFn(extern)}, ${pyStr(x.name)}${args.map(a => ", " + a).join("")})`;
    const k = this.kindOf(ret);
    if (k === "int") return this.typed(`_rt.host_int(${call}, ${pyStr(x.name)})`, ret);
    if (k === "float") return this.typed(`_rt.host_float(${call}, ${pyStr(x.name)})`, ret);
    return this.typed(call, ret);
  }

  private builtinCall(
    e: Extract<IrExpr, { kind: "call" }>,
    name: IrBuiltinFn,
    ctx: ExprCtx
  ): CExpr {
    const fieldArg = (): string => {
      const a = e.args[0];
      if (a && a.kind === "this") return "this";
      if (!a || a.kind !== "field") throw new Error(`${name}() needs a field argument`);
      return a.name;
    };
    const aggregate = (fn: string): CExpr => {
      const a = this.compile(e.args[0]!, ctx);
      const c: CExpr = {
        code: `_rt.${fn}(${a.code})`,
        kind: fn === "lengths" ? "other" : this.kindOf(e.type)
      };
      const range = this.rangeOf(e.type);
      if (range && fn !== "lengths" && c.kind === "int") c.range = range;
      return c;
    };
    const oneArray = e.args.length === 1 && e.args[0]!.type.kind === "array";
    switch (name) {
      case "sum":
        return aggregate("sum_of");
      case "lengths":
        return aggregate("lengths");
      case "sizeof":
        return lengthOf(ctx.sizeof(fieldArg()));
      case "offsetof":
        return lengthOf(ctx.offsetof(fieldArg()));
      case "encodedSize": {
        const k = e.args[1];
        const layer =
          k && k.kind === "literal" && k.value.kind === "int" ? Number(k.value.value) : 0;
        return lengthOf(ctx.encodedSize(fieldArg(), layer));
      }
      case "bytesof":
        return { code: ctx.bytesof(fieldArg()), kind: "bytes" };
      case "encode":
        return { code: ctx.encode(fieldArg()), kind: "bytes" };
      case "crc32":
      case "adler32": {
        const a = this.compile(e.args[0]!, ctx);
        return { code: `_rt.${name}(${a.code})`, kind: "int", range: [0n, (1n << 32n) - 1n] };
      }
      case "min":
      case "max": {
        if (oneArray) return aggregate(`${name}_of`);
        const xs = e.args.map(a => this.compile(a, ctx));
        if (xs.some(x => x.kind === "float"))
          return { code: `${name}(${xs.map(x => x.code).join(", ")})`, kind: "float" };
        const ranges = xs.map(x => x.range ?? FULL);
        const range: Range =
          name === "min"
            ? [minB(...ranges.map(r => r[0])), minB(...ranges.map(r => r[1]))]
            : [maxB(...ranges.map(r => r[0])), maxB(...ranges.map(r => r[1]))];
        return {
          code: `${name}(${xs.map(x => stripParens(x.code)).join(", ")})`,
          kind: "int",
          range
        };
      }
      case "abs": {
        const x = this.compile(e.args[0]!, ctx);
        if (x.kind === "float") return { code: `abs(${stripParens(x.code)})`, kind: "float" };
        const r = x.range ?? FULL;
        return {
          code: `abs(${stripParens(x.code)})`,
          kind: "int",
          range: [0n, maxB(absB(r[0]), absB(r[1]))]
        };
      }
      case "round": {
        const x = this.compile(e.args[0]!, ctx);
        return {
          code: `_rt.round_half_away(${stripParens(x.code)})`,
          kind: "int",
          range: this.rangeOf(e.type) ?? FULL
        };
      }
      case "indexOf": {
        const arr = this.compile(e.args[0]!, ctx);
        const v = this.compile(e.args[1]!, ctx);
        return lengthOf(`_rt.index_of(${arr.code}, ${v.code})`);
      }
      case "len": {
        const a0 = e.args[0]!;
        const a = this.compile(a0, ctx);
        if (a.kind === "str") {
          let enc = "utf8";
          if (a0.kind === "field") {
            const ft = ctx.fieldType(a0.name);
            const st = ft && stripType(ft);
            if (st?.kind === "string") enc = st.encoding;
          }
          return lengthOf(`_rt.code_units(${a.code}, ${pyStr(enc)})`);
        }
        return lengthOf(`len(${stripParens(a.code)})`);
      }
      case "map":
      case "filter":
      case "indicesWhere":
      case "sortedBy": {
        const arr = this.compile(e.args[0]!, ctx);
        const fn = this.compile(e.args[1]!, ctx);
        const rt = {
          map: "map_of",
          filter: "filter_of",
          indicesWhere: "indices_where",
          sortedBy: "sorted_by"
        }[name];
        return {
          code: `_rt.${rt}(${stripParens(arr.code)}, ${fn.code})`,
          kind: "other" // a list at run time even for u8 arrays (to() converts)
        };
      }
      case "unique": {
        const arr = this.compile(e.args[0]!, ctx);
        const canon = this.canonOf(e.args[0]!.type, ctx);
        return {
          code: `_rt.unique_of(${stripParens(arr.code)}${canon ? `, ${canon}` : ""})`,
          kind: "other" // a list at run time even for u8 arrays (to() converts)
        };
      }
      case "concat": {
        const xs = e.args.map(a => stripParens(this.compile(a, ctx).code));
        return { code: `_rt.concat_of(${xs.join(", ")})`, kind: "other" };
      }
      case "isNull": {
        const x = this.compile(e.args[0]!, ctx);
        return { code: `(${x.code} is None)`, kind: "bool" };
      }
      case "encodedLength": {
        const s = this.compile(e.args[0]!, ctx);
        const encArg = e.args[2];
        const enc =
          encArg && encArg.kind === "literal" && encArg.value.kind === "string"
            ? encArg.value.value
            : "utf8";
        return lengthOf(`_rt.encoded_bytes(${s.code}, ${pyStr(enc)})`);
      }
    }
    throw new Error(`unsupported builtin ${String(name)}`);
  }
}

/** Values compared by value rather than by Python identity or dataclass equality. */
function isComposite(t: IrValueType): boolean {
  return (
    t.kind === "array" ||
    t.kind === "struct" ||
    t.kind === "bytes" ||
    t.kind === "union" ||
    (t.kind === "nullable" && isComposite(t.inner))
  );
}

function stripNullable(t: IrValueType): IrValueType {
  return t.kind === "nullable" ? t.inner : t;
}

/** Translates the portable regex subset from JS syntax to Python `re` syntax. */
function jsRegexToPython(p: string): string {
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === "\\" && i + 1 < p.length) {
      const n = p[i + 1]!;
      if (n === "u" && p[i + 2] === "{") {
        const close = p.indexOf("}", i + 3);
        if (close > 0) {
          const hex = p.slice(i + 3, close);
          out += `\\U${hex.padStart(8, "0")}`;
          i = close;
          continue;
        }
      }
      out += ch + n;
      i++;
      continue;
    }
    if (ch === "(" && p.startsWith("(?<", i) && p[i + 3] !== "=" && p[i + 3] !== "!") {
      out += "(?P<";
      i += 2;
      continue;
    }
    out += ch;
  }
  return out;
}
