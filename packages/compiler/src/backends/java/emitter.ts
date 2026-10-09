/** What the reader and writer emitters share: contexts, expressions, arguments, control flow. */
import type {
  IrExpr,
  IrFill,
  IrMember,
  IrStruct,
  IrSwitch,
  IrType,
  IrValueType
} from "../../ir/index.ts";
import { Code, ident, stripParens } from "./code.ts";
import type { ClassCtx } from "./ctx.ts";
import type { CExpr, ExprCompiler, ExprCtx } from "./expr.ts";
import type { Model } from "./model.ts";

/** The part of a read or write context both emitters use. */
export interface EmitCtx {
  s: IrStruct;
  /** Code of the current `$endian` (an Endian). */
  endian: string;
  /** Code of the current little-endian flag (a boolean). */
  le: string;
  /** Code of `$index` (long). */
  index: string;
  /** Array nesting depth (frame index slots). */
  depth: number;
  /** Code and type of `it` (checks, transforms, terminator predicates). */
  it?: { code: string; type: IrValueType } | undefined;
  /** Fill lambda parameters → code. */
  lambdas?: Map<string, string> | undefined;
  /** Codec-reuse slot of the value being emitted. */
  slot: string;
}

export abstract class Emitter<C extends EmitCtx> {
  readonly model: Model;
  readonly x: ExprCompiler;
  readonly cls: ClassCtx;
  protected code!: Code;

  constructor(model: Model, x: ExprCompiler, cls: ClassCtx) {
    this.model = model;
    this.x = x;
    this.cls = cls;
  }

  protected use(n: string): string {
    return this.cls.use(n);
  }

  abstract exprCtx(ctx: C): ExprCtx;

  /** True if a struct needs `$index` set when it is an array element. */
  protected abstract structUsesIndex(s: IrStruct): boolean;

  /** The parts of an expression context that don't depend on the direction. */
  protected commonExprCtx(
    ctx: C
  ): Pick<ExprCtx, "param" | "it" | "lambda" | "externCall" | "hoist" | "fieldType" | "use"> {
    const s = ctx.s;
    return {
      param: (name, type) => {
        const p = s.params.find(q => q.name === name);
        if (p?.origin === "endian" || name === "endian")
          return { code: ctx.endian, repr: "endian" };
        return this.x.typed(ident(name), type);
      },
      it: type => {
        if (!ctx.it) throw new Error("`it` used outside a check or transform");
        return this.x.typed(ctx.it.code, ctx.it.type ?? type);
      },
      lambda: name => ctx.lambdas?.get(name) ?? ident(name),
      externCall: (id, args) => this.cls.externCall(id, args),
      hoist: (code, type, hint) => this.cls.hoist(code, type, hint),
      fieldType: name => this.model.field(s, name)?.field?.type,
      use: n => this.use(n)
    };
  }

  expr(e: IrExpr, ctx: C): CExpr {
    return this.x.compile(e, this.exprCtx(ctx));
  }

  /** A long (offsets, positions; may be negative before checks). */
  num(e: IrExpr, ctx: C): string {
    return this.x.asLong(this.expr(e, ctx), this.exprCtx(ctx));
  }

  /** A non-negative int (lengths). */
  len(e: IrExpr, ctx: C): string {
    return this.x.asLen(this.expr(e, ctx), this.exprCtx(ctx));
  }

  /** Arguments converted to their parameters' types (struct, extern and codec arguments). */
  argCodes(params: readonly { type: IrValueType }[], args: readonly IrExpr[], ctx: C): string[] {
    const ectx = this.exprCtx(ctx);
    return args.map((a, i) => {
      const ce = this.x.compile(a, ectx);
      const p = params[i];
      return p ? this.x.to(ce, p.type, ectx) : ce.code;
    });
  }

  leOf(e: "le" | "be" | "inherit", ctx: C): string {
    return e === "inherit" ? ctx.le : e === "le" ? "true" : "false";
  }

  fill(f: IrFill, ctx: C): string {
    const F = this.use("Fill");
    if (f.kind === "byte") return f.value === 0 ? `${F}.ZERO` : `${F}.of(${f.value})`;
    const p = this.code.fresh("$fi");
    const lambdas = new Map(ctx.lambdas ?? []);
    lambdas.set(f.param, p);
    const body = this.expr(f.expr, { ...ctx, lambdas });
    return `${p} -> ${this.x.asLong(body, this.exprCtx(ctx))}`;
  }

  /** Java type of a compiled expression's representation. */
  reprType(c: CExpr): string {
    switch (c.repr) {
      case "int":
        return "int";
      case "long":
      case "u64":
        return "long";
      case "big":
        return this.use("BigInteger");
      case "f32":
        return "float";
      case "f64":
        return "double";
      case "bool":
        return "boolean";
      case "str":
        return this.model.lang("String");
      case "bytes":
        return "byte[]";
      case "endian":
        return this.use("Endian");
      default:
        return "var";
    }
  }

  /**
   * A lambda body: what `f` emits, then its result. Without statements (and without `block`) the
   * result alone.
   */
  protected closure(f: () => string, block = false): string {
    const saved = this.code;
    const inner = saved.child();
    this.code = inner;
    const v = f();
    this.code = saved;
    if (inner.empty && !block) return v;
    const body = new Code();
    body.line("{");
    body.indent(() => {
      body.append(inner);
      body.line(`return ${v};`);
    });
    body.line("}");
    return body.toString();
  }

  /** The struct's own layers as its users apply them (a base pads its region itself). */
  protected outerLayers(s: IrStruct): IrStruct["layers"] {
    return s.base ? s.layers.filter(l => l.kind !== "alignEnd") : s.layers;
  }

  /** True if elements of type `t` need `$index` set while they are read or written. */
  protected elementUsesIndex(t: IrType): boolean {
    switch (t.kind) {
      case "struct":
        return this.structUsesIndex(this.model.struct(t.struct));
      case "layered":
      case "transform":
        return this.elementUsesIndex(t.inner);
      case "pointer":
        return this.elementUsesIndex(t.target);
      case "union":
        return t.variants.some(v => this.elementUsesIndex(v.type));
      default:
        return false;
    }
  }

  /** `if (cond) { then } else { els }`. */
  protected emitIf(cond: IrExpr, ctx: C, then: () => void, els?: () => void): void {
    const parts: [string, () => void][] = [
      [`if (${stripParens(this.expr(cond, ctx).code)})`, then]
    ];
    if (els) parts.push(["else", els]);
    this.code.chain(parts);
  }

  /** A switch as an if/else chain; `noMatch` gives the statement for an unmatched value. */
  protected emitSwitch(
    m: IrSwitch,
    ctx: C,
    branch: (members: readonly IrMember[]) => void,
    noMatch: (d: string) => string
  ): void {
    const c = this.code;
    const d = c.fresh("$d");
    const disc = this.expr(m.discriminant, ctx);
    c.line(`final ${this.reprType(disc)} ${d} = ${disc.code};`);
    const dExpr: CExpr = { ...disc, code: d };
    const ectx = this.exprCtx(ctx);
    const parts: [string, () => void][] = m.cases.map((cs, i) => {
      const conds = cs.values.map(v =>
        this.x.equality("==", dExpr, this.x.literal(v, m.discriminant.type, ectx), ectx)
      );
      return [`${i ? "else if" : "if"} (${conds.join(" || ")})`, () => branch(cs.members)];
    });
    const def = m.default;
    const last = def ? () => branch(def) : () => c.line(noMatch(d));
    if (parts.length) c.chain([...parts, ["else", last]]);
    else if (def) c.block("", last);
    else last();
  }
}
