/** What the reader and writer emitters share: contexts, expressions, arguments, branches. */
import type { IrExpr, IrFill, IrLayer, IrMember, IrStruct, IrValueType } from "../../ir/index.ts";
import { localName, type Code } from "./code.ts";
import type { CExpr, ExprCompiler, ExprCtx } from "./expr.ts";
import type { Model } from "./model.ts";
import type { Names } from "./names.ts";
import type { TypeMapper } from "./types.ts";

export interface EmitCtx {
  s: IrStruct;
  endian: string;
  le: string;
  /** Code of `$index`. */
  index: string;
  /** Array nesting depth (the frame's index slot). */
  depth: number;
  it?: { code: string; type: IrValueType } | undefined;
  lambdas?: Map<string, string> | undefined;
  /** Codec-reuse slot. */
  slot: string;
  /** Expression of the Meta that remembers codec origins (undefined: none). */
  meta?: string | undefined;
}

type Block = Extract<IrMember, { kind: "block" }>;
type Switch = Extract<IrMember, { kind: "switch" }>;

export abstract class Emitter<C extends EmitCtx> {
  /** The builder statements go to. */
  code!: Code;

  readonly model: Model;
  readonly x: ExprCompiler;
  readonly types: TypeMapper;
  readonly names: Names;

  constructor(model: Model, x: ExprCompiler, types: TypeMapper, names: Names) {
    this.model = model;
    this.x = x;
    this.types = types;
    this.names = names;
  }

  abstract exprCtx(ctx: C): ExprCtx;

  /** Runs at the start of every conditional branch. */
  protected enterBranch(_ms: readonly IrMember[], _ctx: C): void {}

  /** The expression-context entries reading and writing have in common. */
  protected baseExprCtx(
    ctx: C
  ): Pick<ExprCtx, "param" | "it" | "lambda" | "externFn" | "fieldType"> {
    const s = ctx.s;
    return {
      param: (name, type) => {
        const p = s.params.find(q => q.name === name);
        if (p?.origin === "endian" || name === "endian")
          return { code: ctx.endian, repr: "endian" };
        return this.x.typed(localName(name), type);
      },
      it: type => {
        if (!ctx.it) throw new Error("`it` used outside a check or transform");
        return this.x.typed(ctx.it.code, ctx.it.type ?? type);
      },
      lambda: name => ctx.lambdas?.get(name) ?? localName(name),
      externFn: id => this.names.extern(id),
      fieldType: name => this.model.field(s, name)?.field?.type
    };
  }

  expr(e: IrExpr, ctx: C): CExpr {
    return this.x.compile(e, this.exprCtx(ctx));
  }

  /** An integer expression as an i128 (for runtime helpers that range-check it). */
  int(e: IrExpr, ctx: C): string {
    return this.x.asI128(this.expr(e, ctx));
  }

  len(e: IrExpr, ctx: C): string {
    return this.x.asLen(this.expr(e, ctx));
  }

  leOf(e: "le" | "be" | "inherit", ctx: C): string {
    return e === "inherit" ? ctx.le : e === "le" ? "true" : "false";
  }

  /** Parameter list of a struct's reader or writer (after the reader/writer and the value). */
  params(s: IrStruct): string {
    return s.params
      .map(p =>
        p.origin === "endian"
          ? `, [[maybe_unused]] yaffle::Endian endian`
          : `, [[maybe_unused]] ${this.types.paramType(p.type)} ${localName(p.name)}`
      )
      .join("");
  }

  /** Arguments converted to their parameters' types (codecs, extern types, structs). */
  args(
    params: readonly { type: IrValueType; origin?: string }[],
    args: readonly IrExpr[],
    ctx: C
  ): string[] {
    return args.map((a, i) => {
      const ce = this.expr(a, ctx);
      const p = params[i];
      return p && p.origin !== "endian" ? this.x.to(ce, p.type) : ce.code;
    });
  }

  /** Arguments of a struct use site. */
  structArgs(id: string, args: readonly IrExpr[], ctx: C): string[] {
    return this.args(this.model.struct(id).params, args, ctx);
  }

  /** Declares a `yaffle::CodecCtx` named `cc` with the codec's arguments and decoded size. */
  codecCtx(cc: string, args: readonly string[], outputSize?: string): void {
    this.code.line(`yaffle::CodecCtx ${cc};`);
    for (const a of args) this.code.line(`${cc}.args.emplace_back(${a});`);
    if (outputSize !== undefined) this.code.line(`${cc}.output_size = ${outputSize};`);
  }

  fill(f: IrFill, ctx: C): string {
    if (f.kind === "byte") return `yaffle::Fill(${f.value})`;
    const p = localName(f.param);
    const lambdas = new Map(ctx.lambdas ?? []);
    lambdas.set(f.param, p);
    const body = this.expr(f.expr, { ...ctx, lambdas });
    return `yaffle::Fill::of([&](std::int64_t ${p}) -> yaffle::i128 { return ${this.x.asI128(body)}; })`;
  }

  /** A conditional block (`if`/`else`) or a plain scope; `body` emits the block itself. */
  emitBlock(m: Block, ctx: C, body: () => void, members: (ms: readonly IrMember[]) => void): void {
    const c = this.code;
    if (!m.condition) {
      c.block("", body);
      return;
    }
    const parts: [string, () => void][] = [
      [
        `if (${this.expr(m.condition, ctx).code})`,
        () => {
          this.enterBranch(m.members, ctx);
          body();
        }
      ]
    ];
    const els = m.else;
    if (els)
      parts.push([
        "else",
        () => {
          this.enterBranch(els, ctx);
          members(els);
        }
      ]);
    c.chain(parts);
  }

  /** A switch: an if/else-if chain over the cases, then the default or the `noMatch` statement. */
  emitSwitch(m: Switch, ctx: C, members: (ms: readonly IrMember[]) => void, noMatch: string): void {
    const c = this.code;
    const d = c.fresh("d");
    const disc = this.expr(m.discriminant, ctx);
    c.line(`const auto ${d} = ${disc.code};`);
    const dExpr: CExpr = { ...disc, code: d };
    const branch = (ms: readonly IrMember[]) => (): void => {
      this.enterBranch(ms, ctx);
      members(ms);
    };
    const parts: [string, () => void][] = m.cases.map((cs, i) => {
      const conds = cs.values.map(v =>
        this.x.equality("==", dExpr, this.x.literal(v, m.discriminant.type))
      );
      return [`${i ? "else if" : "if"} (${conds.join(" || ")})`, branch(cs.members)];
    });
    const last = m.default ? branch(m.default) : () => c.line(noMatch);
    if (parts.length) c.chain([...parts, ["else", last]]);
    else if (m.default) c.block("", last);
    else last();
  }
}

/** The `@size` directly inside layer `idx` (a codec's decoded size), if any. */
export function sizeInside(layers: readonly IrLayer[], idx: number): IrExpr | undefined {
  for (let k = idx - 1; k >= 0; k--) {
    const l = layers[k]!;
    if (l.kind === "via") return undefined;
    if (l.kind === "size") return l.size;
  }
  return undefined;
}
