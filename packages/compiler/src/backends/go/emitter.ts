/** What the reader and writer emitters share: expression contexts, arguments, fills, slots. */
import type { IrExpr, IrFill, IrParam, IrStruct, IrType, IrValueType } from "../../ir/index.ts";
import { Code, funcLit, goStr, local } from "./code.ts";
import { formatInt, type CExpr, type ExprCompiler, type ExprCtx } from "./expr.ts";
import { usesIndex } from "./irutil.ts";
import { BackendError, type Model } from "./model.ts";
import type { ModuleCtx } from "./module.ts";

/** Where generated code is when it reads or writes a member. */
export interface EmitCtx {
  s: IrStruct;
  /** Go code of the endianness and of "is it little endian". */
  endian: string;
  le: string;
  /** Go code of `$index`. */
  index: string;
  /** Codec reuse slot of the value. */
  slot: string;
  /** Array index variables inside this struct (codec reuse keys of non-struct values). */
  idx: string[];
  it?: CExpr | undefined;
  /** Go names of the lambda parameters in scope (fills). */
  lambdas?: Map<string, string> | undefined;
}

/** A context at the start of a struct's members. */
export function structCtx(s: IrStruct, index: string, slot: string): EmitCtx {
  return { s, endian: "endian", le: "le", index, slot, idx: [] };
}

/** The parameter list of a struct's reader or writer. */
export function paramList(model: Model, s: IrStruct): string {
  return s.params
    .map(p =>
      p.origin === "endian"
        ? "endian yaffle.Endian"
        : `${local(p.name)} ${model.goValueType(p.type)}`
    )
    .join(", ");
}

export abstract class Emitter<C extends EmitCtx> {
  readonly model: Model;
  readonly x: ExprCompiler;
  readonly mod: ModuleCtx;
  protected code!: Code;

  constructor(model: Model, x: ExprCompiler, mod: ModuleCtx) {
    this.model = model;
    this.x = x;
    this.mod = mod;
  }

  abstract exprCtx(ctx: C): ExprCtx;

  /** The parts of exprCtx that read and write contexts share. */
  protected commonExprCtx(
    ctx: C
  ): Pick<ExprCtx, "param" | "it" | "lambda" | "externFn" | "hoist" | "use" | "fieldType"> {
    const s = ctx.s;
    return {
      param: (name, type) => {
        const p = s.params.find(q => q.name === name);
        if (p?.origin === "endian")
          return { code: ctx.endian, gt: "yaffle.Endian", kind: "endian", safe: true };
        return this.x.typed(local(name), type);
      },
      it: type => {
        if (!ctx.it) throw new BackendError("`it` used outside a check or transform");
        return ctx.it.gt ? ctx.it : this.x.typed(ctx.it.code, type);
      },
      lambda: name => ctx.lambdas?.get(name) ?? local(name),
      externFn: id => this.mod.extern(id),
      hoist: (code, hint) => this.mod.hoist(code, hint),
      use: pkg => this.mod.use(pkg),
      fieldType: name => this.model.field(s, name)?.field?.type
    };
  }

  expr(e: IrExpr, ctx: C): CExpr {
    return this.x.compile(e, this.exprCtx(ctx));
  }

  num(e: IrExpr, ctx: C): string {
    return this.x.asOffset(this.expr(e, ctx));
  }

  len(e: IrExpr, ctx: C): string {
    return this.x.asLen(this.expr(e, ctx));
  }

  /** Go code of "little endian" for a primitive's byte order. */
  leOf(e: "le" | "be" | "inherit", ctx: C): string {
    if (e === "inherit") return ctx.le;
    return e === "le" ? "true" : "false";
  }

  /** Arguments of a struct, extern type or codec, converted to their parameters' types. */
  args(exprs: readonly IrExpr[], params: readonly { type: IrValueType }[], ctx: C): string[] {
    return exprs.map((a, i) => {
      const ce = this.expr(a, ctx);
      const p = params[i];
      return p ? this.x.to(ce, p.type, this.exprCtx(ctx), "argument") : ce.code;
    });
  }

  /** The arguments of a struct's reader or writer. */
  structArgs(s: IrStruct, exprs: readonly IrExpr[], ctx: C): string[] {
    return this.args(exprs, s.params as readonly IrParam[], ctx);
  }

  /** A terminator byte. */
  byteOf(c: CExpr): string {
    if (c.gt === "untyped") return `byte(${c.code})`;
    if (c.gt === "uint8") return c.code;
    return `byte(${this.x.asI64(c, true)})`;
  }

  /** A padding fill: a byte, or a function of the byte's index. */
  fill(f: IrFill, ctx: C): string {
    if (f.kind === "byte")
      return f.value === 0 ? "yaffle.Fill{}" : `yaffle.Fill{Byte: ${formatInt(BigInt(f.value))}}`;
    const p = local(f.param);
    const lambdas = new Map(ctx.lambdas ?? []);
    lambdas.set(f.param, p);
    const body = this.expr(f.expr, { ...ctx, lambdas });
    return `yaffle.Fill{Fn: ${funcLit(`func(${p} int) int64`, this.x.asI64(body, true))}}`;
  }

  /** The codec reuse slot of a value: the slot name, plus the array indices it is under. */
  slotCode(slot: string, ctx: C): string {
    if (!ctx.idx.length) return goStr(slot);
    return `yaffle.Slot(${goStr(slot)}, ${ctx.idx.join(", ")})`;
  }

  /** True if elements of type t read `$index` (directly or in nested structs). */
  elementUsesIndex(t: IrType, layout: boolean): boolean {
    switch (t.kind) {
      case "struct":
        return usesIndex(this.model.struct(t.struct), layout);
      case "layered":
      case "transform":
        return this.elementUsesIndex(t.inner, layout);
      case "pointer":
        return this.elementUsesIndex(t.target, layout);
      case "union":
        return t.variants.some(v => this.elementUsesIndex(v.type, layout));
      default:
        return false;
    }
  }

  /** The statements f emits, captured into a separate builder. */
  protected capture<T>(f: () => T): { inner: Code; value: T } {
    const saved = this.code;
    const inner = saved.child();
    this.code = inner;
    try {
      return { inner, value: f() };
    } finally {
      this.code = saved;
    }
  }
}
