/** What the reader and writer emitters share: their context, expression plumbing and helpers. */
import type { IrExpr, IrFill, IrStruct, IrValueType } from "../../ir/index.ts";
import { Code, ident } from "./code.ts";
import type { CExpr, ExprCompiler, ExprCtx } from "./expr.ts";
import type { Model } from "./model.ts";
import type { ModuleCtx } from "./module.ts";
import type { Types } from "./types.ts";

/** Where an emitter is in a struct. */
export interface EmitCtx {
  s: IrStruct;
  /** The `$endian` variable, and the bool variable telling whether it is little endian. */
  endian: string;
  le: string;
  /** Awaiting is allowed here (an async method or lambda). */
  async: boolean;
  /** Code of `$index`. */
  index: string;
  /** Array nesting depth (path index variables `__i0`, `__i1`, …). */
  depth: number;
  /** The value `it` names (checks, transforms, terminators). */
  it?: { code: string; type: IrValueType } | undefined;
  /** Variables of enclosing lambdas and fill functions, by IR name. */
  lambdas?: Map<string, string> | undefined;
  /** Identifies the value for codec reuse. */
  slot: string;
}

export abstract class Emitter<C extends EmitCtx> {
  readonly model: Model;
  readonly x: ExprCompiler;
  readonly types: Types;
  readonly mod: ModuleCtx;
  /** Where statements go. */
  protected code!: Code;

  constructor(model: Model, x: ExprCompiler, types: Types, mod: ModuleCtx) {
    this.model = model;
    this.x = x;
    this.types = types;
    this.mod = mod;
  }

  abstract exprCtx(ctx: C): ExprCtx;

  /** The parts of an expression context that read and write share. */
  protected commonExprCtx(
    ctx: C
  ): Pick<ExprCtx, "param" | "it" | "lambda" | "externFn" | "hoist" | "fieldType" | "fresh"> {
    const s = ctx.s;
    return {
      param: (name, type) => {
        const p = s.params.find(q => q.name === name);
        if (p?.origin === "endian" || name === "endian")
          return { code: ctx.endian, kind: "endian", cs: "Rt.Endian" };
        return this.x.typed(ident(name), type);
      },
      it: type => {
        if (!ctx.it) throw new Error("`it` used outside a check or transform");
        return this.x.typed(ctx.it.code, ctx.it.type ?? type);
      },
      lambda: name => ctx.lambdas?.get(name) ?? ident(name),
      externFn: id => this.mod.externFn(id),
      hoist: (code, type, hint) => this.mod.hoist(code, type, hint),
      fieldType: name => this.model.field(s, name)?.field?.type,
      fresh: p => this.code.fresh(p)
    };
  }

  expr(e: IrExpr, ctx: C): CExpr {
    return this.x.compile(e, this.exprCtx(ctx));
  }

  /** An offset or position (long). */
  num(e: IrExpr, ctx: C): string {
    return this.x.asLong(this.expr(e, ctx));
  }

  /** A length or count (non-negative long). */
  len(e: IrExpr, ctx: C): string {
    return this.x.asLen(this.expr(e, ctx));
  }

  /** Arguments converted to their parameters' types (struct, codec and extern arguments). */
  args(exprs: readonly IrExpr[], params: readonly { type: IrValueType }[], ctx: C): string[] {
    return exprs.map((a, i) => {
      const ce = this.expr(a, ctx);
      const p = params[i];
      return p ? this.x.to(ce, p.type, "argument") : ce.code;
    });
  }

  /** The C# bool telling whether a value of the given byte order is little endian. */
  leOf(e: "le" | "be" | "inherit", ctx: C): string {
    return e === "inherit" ? ctx.le : e === "le" ? "true" : "false";
  }

  /** A padding fill: a constant byte, or a function of the byte's index. */
  fill(f: IrFill, ctx: C): string {
    if (f.kind === "byte") return `Rt.Fill.Of(${f.value})`;
    const p = this.code.fresh("fi");
    const lambdas = new Map(ctx.lambdas ?? []);
    lambdas.set(f.param, p);
    const body = this.expr(f.expr, { ...ctx, lambdas });
    return `new Rt.Fill((long ${p}) => ${this.x.asLong(body)})`;
  }

  /** Statements emitted by `f` into a fresh builder (sharing the temp counter); returns both. */
  protected capture<T>(f: () => T): { body: Code; value: T } {
    const saved = this.code;
    const body = saved.child();
    this.code = body;
    try {
      return { body, value: f() };
    } finally {
      this.code = saved;
    }
  }
}
