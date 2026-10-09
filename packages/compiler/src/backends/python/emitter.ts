/**
 * What the reader and writer emitters share: the code builder they emit into, nested functions,
 * the side-independent parts of expression contexts, and layer argument helpers.
 */
import type { IrExpr, IrFill, IrLayer, IrStruct, IrValueType } from "../../ir/index.ts";
import { Code, closureParams, pyBool, pyIdent, stripParens } from "./code.ts";
import type { CExpr, ExprCompiler, ExprCtx } from "./expr.ts";
import type { Model } from "./model.ts";
import type { ModuleCtx } from "./module.ts";
import type { Names } from "./names.ts";
import type { TypeEmitter } from "./types.ts";

/** Context of the value being read or written. */
export interface EmitCtx {
  s: IrStruct;
  /** Code of the endianness (`"le"` / `"be"`) and of the matching little-endian flag. */
  endian: string;
  le: string;
  async: boolean;
  /** Code of `$index`. */
  index: string;
  /** Array nesting depth (path slots `_p[1]`, `_p[2]`, …). */
  depth: number;
  /** Code and type of `it` (checks, transforms, predicates). */
  it?: { code: string; type: IrValueType } | undefined;
  /** Fill function parameters: IR name → Python name. */
  lambdas?: Map<string, string> | undefined;
  /** Codec-reuse slot of the value (reader and writer must agree). */
  slot: string;
}

export interface EmitState {
  /** Names assigned inside the closures being emitted (declared `nonlocal`), innermost last. */
  nonlocals: Set<string>[];
}

/** The parts of an expression context that differ between the reader and the writer. */
export type SideCtx = Pick<
  ExprCtx,
  "field" | "builtin" | "sizeof" | "offsetof" | "encodedSize" | "bytesof" | "encode"
>;

export abstract class Emitter<C extends EmitCtx, S extends EmitState> {
  readonly model: Model;
  readonly names: Names;
  readonly x: ExprCompiler;
  readonly types: TypeEmitter;
  readonly mod: ModuleCtx;
  protected st!: S;
  protected code!: Code;

  constructor(model: Model, names: Names, x: ExprCompiler, types: TypeEmitter, mod: ModuleCtx) {
    this.model = model;
    this.names = names;
    this.x = x;
    this.types = types;
    this.mod = mod;
  }

  protected abstract sideCtx(ctx: C): SideCtx;

  exprCtx(ctx: C): ExprCtx {
    const s = ctx.s;
    return {
      ...this.mod.exprBase(),
      param: (name, type) => {
        const p = s.params.find(q => q.name === name);
        if (p?.origin === "endian" || name === "endian") return { code: ctx.endian, kind: "other" };
        return this.x.typed(this.names.param(s, name), type);
      },
      it: type => {
        if (!ctx.it) throw new Error("`it` used outside a check or transform");
        return this.x.typed(ctx.it.code, ctx.it.type ?? type);
      },
      lambda: name => ctx.lambdas?.get(name) ?? name,
      fieldType: name => this.model.field(s, name)?.field?.type,
      ...this.sideCtx(ctx)
    };
  }

  protected attr(s: IrStruct, name: string): string {
    return this.names.attr(s, name);
  }

  expr(e: IrExpr, ctx: C): CExpr {
    return this.x.compile(e, this.exprCtx(ctx));
  }

  /** An integer (offsets, alignments). */
  num(e: IrExpr, ctx: C): string {
    return stripParens(this.x.asOffset(this.expr(e, ctx)));
  }

  /** A non-negative integer (lengths, counts). */
  len(e: IrExpr, ctx: C): string {
    return stripParens(this.x.asLen(this.expr(e, ctx)));
  }

  /** Arguments converted to their parameters' types (struct parameters, externs, codecs). */
  args(exprs: readonly IrExpr[], params: readonly { type: IrValueType }[], ctx: C): string[] {
    return exprs.map((a, i) => {
      const ce = this.expr(a, ctx);
      const p = params[i];
      return stripParens(p ? this.x.to(ce, p.type) : ce.code);
    });
  }

  leOf(e: "le" | "be" | "inherit", ctx: C): string {
    return e === "inherit" ? ctx.le : pyBool(e === "le");
  }

  /** Extra `align` arguments: the offset and whether the origin is the file start. */
  alignArgs(l: Extract<IrLayer, { kind: "align" | "alignEnd" }>, ctx: C): string {
    if (!l.offset && l.from !== "file") return "";
    const off = l.offset ? this.num(l.offset, ctx) : "0";
    return `, ${off}, ${pyBool(l.from === "file")}`;
  }

  /** A padding fill: a byte value, or a function of the byte's index. */
  fill(f: IrFill, ctx: C): string {
    if (f.kind === "byte") return String(f.value);
    const p = pyIdent(f.param);
    const lambdas = new Map(ctx.lambdas ?? []);
    lambdas.set(f.param, p);
    const body = this.expr(f.expr, { ...ctx, lambdas });
    return `(lambda ${p}: ${stripParens(body.code)})`;
  }

  /**
   * Emits a nested function whose body is what `f` emits, returning `f`'s expression (none if
   * null), and returns the function's name. Temporaries read from enclosing scopes are bound as
   * default arguments; struct-level locals assigned inside are declared `nonlocal`.
   */
  closure(isAsync: boolean, f: () => string | null, params: string[] = []): string {
    const parent = this.code;
    const opened = parent.mark;
    const name = parent.fresh("c");
    const inner = parent.child();
    this.code = inner;
    this.st.nonlocals.push(new Set());
    let result: string | null;
    try {
      result = f();
    } finally {
      this.code = parent;
    }
    const nl = this.st.nonlocals.pop()!;
    const binds = closureParams(inner.toString() + "\n" + (result ?? ""), opened);
    const sig = [...params.map(p => `${p}: _t.Any`), ...binds].join(", ");
    parent.line(`${isAsync ? "async " : ""}def ${name}(${sig}) -> _t.Any:`);
    parent.indent(() => {
      if (nl.size) parent.line(`nonlocal ${[...nl].sort().join(", ")}`);
      parent.append(inner);
      if (result !== null) parent.line(`return ${result}`);
      else if (inner.empty && !nl.size) parent.line("pass");
    });
    return name;
  }

  /** Assigns a struct-level local (declared nonlocal inside closures). */
  protected assignState(name: string, value: string): void {
    this.st.nonlocals.at(-1)?.add(name);
    this.code.line(`${name} = ${value}`);
  }
}
