/**
 * Writer emitter: one `Write_X` method per struct (`WriteAsync_X` when its members reach an async
 * codec), relocation-style code over `Rt.Writer` following docs/IR.md §3 and §4.
 *
 * Derived values are evaluated where they are written when they depend only on values; values
 * that depend on sizes, positions or encodings are written as placeholders and computed by fixups
 * after layout. References to a derived field inline its `derive` expression.
 */
import type {
  IrBitField,
  IrBits,
  IrCheck,
  IrExpr,
  IrField,
  IrLayer,
  IrLayoutItem,
  IrMember,
  IrStreamExpr,
  IrStruct,
  IrType,
  IrValueType
} from "../../ir/index.ts";
import {
  elementUsesIndex,
  exprUses,
  extentFields,
  literalInt,
  stripLayers,
  usesIndex,
  usesIt,
  valueTypeOf,
  walkExpr
} from "./analysis.ts";
import { Code, ident, str } from "./code.ts";
import { Emitter, type EmitCtx } from "./emitter.ts";
import { encName, paren, stripParens, type CExpr, type ExprCtx } from "./expr.ts";

interface WCtx extends EmitCtx {
  /** Inside a fixup closure: positions and sizes are final. */
  deferred: boolean;
  /** Extent variable of the field being written (stage recording). */
  extent?: string | undefined;
  /** Field name being written (for placeable names). */
  fieldName: string;
  /** The value inside the current layers (codec reuse key). */
  reuse?: string | undefined;
  /** Code of `$offset` (deferred checks capture the position where the field started). */
  offsetCode?: string | undefined;
  /** Code of `$end` (deferred checks: the end of the finished region). */
  endCode?: string | undefined;
  /** The value of a one-way transform is its raw value (fields keep it in a separate member). */
  raw?: boolean | undefined;
}

/** What a derived value depends on, in increasing order of how late it can be computed. */
type DeriveClass = "value" | "size" | "position" | "content";
const RANK: Record<DeriveClass, number> = { value: 0, size: 1, position: 2, content: 3 };

interface StructState {
  /** Fields (and "this") whose extents are recorded. */
  extents: Set<string>;
  maxDepth: number;
  /** Derived fields being inlined (cycle detection). */
  inlining: string[];
  /** Fields whose value the stream prepass computed: their local variable and C# type. */
  overrides: Map<string, { code: string; cs: string }>;
}

export class WriteEmitter extends Emitter<WCtx> {
  private st!: StructState;
  private readonly classMemo = new Map<string, DeriveClass>();

  private begin(code: Code, extents = new Set<string>()): void {
    this.st = { extents, maxDepth: 0, inlining: [], overrides: new Map() };
    this.code = code;
  }

  private structCtx(
    s: IrStruct,
    opts: { async: boolean; index: string; slot?: string; field?: string }
  ): WCtx {
    return {
      s,
      endian: "endian",
      le: "__le",
      async: opts.async,
      index: opts.index,
      depth: 0,
      deferred: false,
      slot: opts.slot ?? this.model.className(s.id),
      fieldName: opts.field ?? ""
    };
  }

  /**
   * The struct's layout as a hoisted constant, or `Rt.Layouts.Instance` when item arguments read
   * fields: each instance then builds its own (see instanceLayout).
   */
  layoutConst(s: IrStruct): string {
    if (!s.layout || !s.layout.length) return "null";
    if (dynamicLayout(s.layout)) return "Rt.Layouts.Instance";
    return this.mod.hoist(
      layoutLiteral(s.layout),
      "Rt.LayoutItem[]",
      `layout_${this.model.className(s.id)}_`
    );
  }

  /**
   * The layout of one instance whose item arguments read fields: evaluated like write formulas,
   * in the owning struct's write context.
   */
  private instanceLayout(s: IrStruct, ctx: WCtx): string {
    return layoutLiteral(s.layout!, e => {
      if (this.deriveClass(s, e) !== "value")
        throw new Error("not implemented: layout item arguments that depend on sizes or positions");
      return this.num(e, ctx);
    });
  }

  emitStruct(out: Code, s: IrStruct): void {
    const name = this.model.className(s.id);
    const async = this.model.bodyAsync(s.id);
    this.begin(out.child(), extentFields(s, true));
    const hasL = this.model.membersHavePlaceables(s.members);
    const ctx = this.structCtx(s, { async, index: "__index" });
    const pre = this.capture(() => this.emitStreamPrepass(s, ctx)).body;
    // Layouts that read fields are built per instance, before the members (errors carry the
    // struct's own path).
    const dynamic = hasL && s.layout !== undefined && dynamicLayout(s.layout);
    const lay = this.capture(() => {
      if (!dynamic) return;
      if (!pre.empty) this.code.line(`__f = "";`);
      this.code.line(`__L.Layout = ${this.instanceLayout(s, ctx)};`);
    }).body;
    const body = this.capture(() =>
      this.emitMembers(s.members, ctx, hasL ? "__L" : undefined)
    ).body;

    const params = s.params.map(p => `${this.types.valueType(p.type)} ${ident(p.name)}`);
    const fn = async ? `WriteAsync_${name}` : `Write_${name}`;
    const exported = !s.base && hasL;
    const retT = exported ? "Rt.LStruct" : "void";
    const ret = async ? (retT === "void" ? "async ValueTask" : `async ValueTask<${retT}>`) : retT;
    out.block(
      `internal static ${ret} ${fn}(${["Rt.Writer __w", `${name}? __in`, ...params].join(", ")})`,
      () => {
        out.line(`bool __le = endian == Rt.Endian.Le;`);
        out.line(
          `var __v = __in ?? throw new Rt.YaffleException(Rt.ErrorCode.INPUT, "expected an object, got null");`
        );
        for (const [f, m] of this.requiredRefFields(s, s.members))
          out.line(`if (__v.${m} is null) throw Rt.Err.Missing(${str(f)});`);
        if (usesIndex(s, true)) out.line(`long __index = __w.Index;`);
        const emitBody = (): void => {
          // A base's `@alignEnd` pads its whole region, after its targets.
          if (s.base)
            for (const l of s.layers)
              if (l.kind === "alignEnd") out.line(`${this.regionAlignEnd(l, ctx)};`);
          if (hasL)
            out.line(`var __L = new Rt.LStruct(${dynamic ? "null" : this.layoutConst(s)});`);
          for (const f of this.st.extents) {
            if (f === "this")
              out.line(`var __x_this = ${s.base ? "__w.RegionExtent()" : "__w.Extent()"};`);
            else out.line(`Rt.Extent ${extentName(f)} = null!;`);
          }
          out.line(`string __f = "";`);
          const idx = Array.from({ length: this.st.maxDepth }, (_, i) => `__i${i}`);
          if (idx.length) out.line(`long ${idx.map(i => `${i} = -1`).join(", ")};`);
          // The frame lets fixups that run after layout report this struct's path.
          out.line(`__w.Enter(() => new object[] { ${["__f", ...idx].join(", ")} });`);
          out.chain([
            [
              "try",
              () => {
                out.append(pre);
                out.append(lay);
                out.append(body);
                if (this.st.extents.has("this") && !s.base) out.line(`__w.Close(__x_this);`);
              }
            ],
            [
              `catch (Rt.YaffleException __e) when (__e.Prefix(${["__f", ...idx].join(", ")}))`,
              () => out.line("throw;")
            ],
            ["finally", () => out.line(`__w.Leave();`)]
          ]);
        };
        if (s.base) {
          const call = async ? "await __w.BaseAsync" : "__w.Base";
          out.line(`${call}(${this.layoutConst(s)}, ${async ? "async " : ""}__ww =>`);
          out.block(
            "",
            () => {
              emitBody();
              out.line(hasL ? "return __L;" : "return null;");
            },
            ", __v);"
          );
        } else {
          emitBody();
          if (exported) out.line("return __L;");
        }
      }
    );
  }

  /** Emits the write of a root struct (params are locals); returns the layout entry or null. */
  rootWrite(out: Code, s: IrStruct, value: string, async: boolean): string | null {
    this.begin(out);
    const ctx = this.structCtx(s, { async, index: "-1L" });
    const args: IrExpr[] = s.params.map(p => ({ kind: "param", name: p.name, type: p.type }));
    // The root is its file's base: `@alignEnd` pads the whole region, after the targets.
    const ends = s.base ? [] : s.layers.filter(l => l.kind === "alignEnd");
    for (const l of ends) if (l.kind === "alignEnd") out.line(`${this.regionAlignEnd(l, ctx)};`);
    const layers = ends.length ? s.layers.filter(l => l.kind !== "alignEnd") : undefined;
    return this.struct(s.id, args, value, ctx, layers);
  }

  /**
   * The body of a view's in-place encoder for a scalar field (statements over `__w` and `__v`), or
   * undefined if the field's encoding depends on sizes, positions or targets (then setting it is
   * structural).
   */
  encoderFor(s: IrStruct, name: string): Code | undefined {
    const fr = this.model.field(s, name);
    if (!fr) return undefined;
    const f = fr.field;
    if (f && (f.placement || f.from || f.virtual || !patchableType(f.type))) return undefined;
    const savedCode = this.code;
    const savedSt = this.st;
    const body = new Code();
    this.begin(body);
    const ctx = this.structCtx(s, {
      async: false,
      index: "-1L",
      slot: `${this.model.className(s.id)}.${name}`,
      field: name
    });
    try {
      if (f) {
        const vt = valueTypeOf(this.model, f.type);
        const checks = f.deriveKind === "constant" ? [] : f.checks.filter(ch => !ch.strictOnly);
        const v = body.fresh("val");
        body.line(`var ${v} = ${this.inputCode(f.name, vt, ctx).code};`);
        this.emitWriteChecks(checks, v, vt, ctx, "CHECK");
        if (this.write(f.type, v, ctx)) return undefined;
      } else {
        const bits = findBits(s.members, name);
        if (!bits) return undefined;
        body.line(`string __f = "";`);
        this.emitBits(bits, ctx);
        body.line(`_ = __f;`);
      }
      if (this.st.extents.size) return undefined;
    } catch {
      return undefined;
    } finally {
      this.code = savedCode;
      this.st = savedSt;
    }
    return body;
  }

  /**
   * Unconditional required input fields that can be missing (reference types, and the raw values
   * of one-way transforms), checked for null on entry: `[field name, member]`.
   */
  private requiredRefFields(s: IrStruct, ms: readonly IrMember[]): [string, string][] {
    const out: [string, string][] = [];
    for (const m of ms) {
      if (m.kind === "field") {
        if (m.input !== "required" || m.hidden || this.st.overrides.has(m.name) || m.from) continue;
        const f = this.model.field(s, m.name);
        if (!f) continue;
        const info = this.types.field(s, f);
        if (this.types.oneWay(m) && m.output) out.push([m.name, this.model.rawMember(s, m.name)]);
        else if (!info.valueType && !info.nullable) out.push([m.name, info.member]);
      } else if (m.kind === "block" && !m.condition)
        out.push(...this.requiredRefFields(s, m.members));
    }
    return out;
  }

  /** Required input fields of a conditional branch (checked when the branch is taken). */
  private requiredFields(ms: readonly IrMember[]): string[] {
    const out: string[] = [];
    for (const m of ms) {
      if (m.kind === "field") {
        if (m.input === "required" && !m.hidden && !this.st.overrides.has(m.name) && !m.from)
          out.push(m.name);
      } else if (m.kind === "bits") {
        for (const b of m.fields) if (b.name !== null && b.input === "required") out.push(b.name);
      } else if (m.kind === "block" && !m.condition) out.push(...this.requiredFields(m.members));
    }
    return out;
  }

  /** Emits presence checks for the required fields of a taken branch. */
  private need(s: IrStruct, ms: readonly IrMember[]): void {
    const req = this.requiredFields(ms);
    if (!req.length) return;
    this.code.line(`__f = "";`);
    for (const name of req) {
      const f = this.model.field(s, name)!;
      const info = this.types.field(s, f);
      let member: string | undefined;
      if (f.field && this.types.oneWay(f.field)) member = this.model.rawMember(s, name);
      else if (info.nullable || !info.valueType) member = info.member;
      if (member) this.code.line(`if (__v.${member} is null) throw Rt.Err.Missing(${str(name)});`);
    }
  }

  // ── derive classification ─────────────────────────────────────────────────

  private deriveClass(s: IrStruct, e: IrExpr, seen: string[] = []): DeriveClass {
    let cls: DeriveClass = "value";
    const bump = (c: DeriveClass): void => {
      if (RANK[c] > RANK[cls]) cls = c;
    };
    walkExpr(e, x => {
      if (x.kind === "call" && x.callee.kind === "builtin") {
        const n = x.callee.name;
        if (n === "sizeof" || n === "encodedSize") bump("size");
        else if (n === "offsetof") bump("position");
        else if (n === "bytesof" || n === "encode") bump("content");
      } else if (x.kind === "builtinValue" && (x.name === "offset" || x.name === "end"))
        bump("position");
      else if (x.kind === "field") {
        const f = this.model.field(s, x.name);
        const decl = f?.field ?? f?.bit;
        if (decl?.derive && decl.input !== "required" && !seen.includes(x.name))
          bump(this.fieldClass(s, x.name, [...seen, x.name]));
      }
    });
    return cls;
  }

  private fieldClass(s: IrStruct, name: string, seen: string[] = []): DeriveClass {
    const key = `${s.id}.${name}`;
    const hit = this.classMemo.get(key);
    if (hit) return hit;
    const f = this.model.field(s, name);
    const d = f?.field?.derive ?? f?.bit?.derive;
    const c = d ? this.deriveClass(s, d, seen.length ? seen : [name]) : "value";
    this.classMemo.set(key, c);
    return c;
  }

  // ── expression context ────────────────────────────────────────────────────

  exprCtx(ctx: WCtx): ExprCtx {
    return {
      ...this.commonExprCtx(ctx),
      field: (name, type) => this.fieldRef(name, type, ctx),
      builtin: name => {
        if (name === "offset") return ctx.offsetCode ?? "__w.Position";
        if (name === "end")
          return (
            ctx.endCode ??
            `Rt.Err.Fail<long>(Rt.ErrorCode.DERIVE, "$end is not available on write")`
          );
        return ctx.index;
      },
      sizeof: f => `${this.extentVar(f)}.Size`,
      offsetof: f => `${this.extentVar(f)}.Pos`,
      encodedSize: (f, k) => `${this.extentVar(f)}.Stage(${k})`,
      bytesof: f => `${this.extentVar(f)}.Bytes()`,
      encode: f => `${this.extentVar(f)}.PlainBytes()`
    };
  }

  private extentVar(f: string): string {
    this.st.extents.add(f);
    return extentName(f);
  }

  /** The input value of a field (non-null value code). */
  private inputCode(name: string, type: IrValueType, ctx: WCtx): CExpr {
    const s = ctx.s;
    const f = this.model.field(s, name);
    if (!f) throw new Error(`unknown field ${name} in ${s.name}`);
    const info = this.types.field(s, f);
    const cs = this.types.valueType(type);
    let code = `__v.${info.member}`;
    if (f.field && this.types.oneWay(f.field) && ctx.raw) {
      code = `__v.${this.model.rawMember(s, name)}.GetValueOrDefault()`;
    } else if (info.base === "object") code = `Rt.Values.As<${cs}>(${code})`;
    else if (info.nullable) code = info.valueType ? `${code}.GetValueOrDefault()` : `${code}!`;
    const c = this.x.typed(code, type);
    if (info.base !== "object" && info.base !== c.cs && c.kind !== "other") c.cs = info.base;
    return c;
  }

  /** `__v.X.HasValue` / `__v.X is not null`: an optional input was given. */
  private given(s: IrStruct, name: string): string {
    const info = this.types.field(s, this.model.field(s, name)!);
    return info.valueType ? `__v.${info.member}.HasValue` : `__v.${info.member} is not null`;
  }

  /** A field reference in the write context: input value, or the inlined derive. */
  private fieldRef(name: string, type: IrValueType, ctx: WCtx): CExpr {
    const override = this.st.overrides.get(name);
    if (override) return { ...this.x.typed(override.code, type), cs: override.cs };
    const f = this.model.field(ctx.s, name);
    if (!f) throw new Error(`unknown field ${name} in ${ctx.s.name}`);
    const decl = f.field ?? f.bit!;
    const derive = decl.derive;
    if (decl.input === "required" && !(f.field?.hidden ?? false)) {
      if (derive && usesIt(derive)) {
        const i = this.inputCode(name, type, ctx);
        return this.x.compile(derive, this.exprCtx({ ...ctx, it: { code: i.code, type } }));
      }
      return this.inputCode(name, type, ctx);
    }
    if (!derive) return this.inputCode(name, type, ctx);
    if (this.st.inlining.includes(name))
      throw new Error(`derive cycle through ${name} in ${ctx.s.name}`);
    this.st.inlining.push(name);
    const d = this.x.compile(derive, this.exprCtx({ ...ctx, it: undefined }));
    this.st.inlining.pop();
    if (decl.input !== "optional") return d;
    const i = this.inputCode(name, type, ctx);
    const has = this.given(ctx.s, name);
    if (d.kind === "int" && i.kind === "int") {
      const range: [bigint, bigint] = [
        d.range![0] < i.range![0] ? d.range![0] : i.range![0],
        d.range![1] > i.range![1] ? d.range![1] : i.range![1]
      ];
      const cs = range[0] >= -(1n << 63n) && range[1] < 1n << 63n ? "long" : "Int128";
      return {
        code: `(${has} ? ${this.x.conv(i, cs)} : ${this.x.conv(d, cs)})`,
        kind: "int",
        cs,
        range
      };
    }
    return { ...d, code: `(${has} ? ${i.code} : ${d.code})` };
  }

  // ── members ───────────────────────────────────────────────────────────────

  private emitMembers(ms: readonly IrMember[], ctx: WCtx, L: string | undefined): void {
    const c = this.code;
    for (const m of ms) {
      switch (m.kind) {
        case "field":
          this.emitField(m, ctx, L);
          break;
        case "bits":
          this.emitBits(m, ctx);
          break;
        case "block": {
          const body = (): void => {
            this.emitLayers(
              m.layers,
              m.layers.length - 1,
              ctx,
              inner => {
                this.emitMembers(m.members, inner, L);
                return null;
              },
              "",
              undefined,
              this.model.membersAsync(m.members)
            );
          };
          if (m.condition) {
            const cond = this.expr(m.condition, ctx).code;
            const parts: [string, () => void][] = [
              [
                `if (${stripParens(cond)})`,
                () => {
                  this.need(ctx.s, m.members);
                  body();
                }
              ]
            ];
            const els = m.else;
            if (els) {
              parts.push([
                "else",
                () => {
                  this.need(ctx.s, els);
                  this.emitMembers(els, ctx, L);
                }
              ]);
            }
            c.chain(parts);
          } else c.block("", body);
          break;
        }
        case "switch": {
          const d = c.fresh("d");
          const disc = this.expr(m.discriminant, ctx);
          c.line(`var ${d} = ${disc.code};`);
          const dExpr: CExpr = { ...disc, code: d };
          const branch = (members: readonly IrMember[]): void => {
            this.need(ctx.s, members);
            this.emitMembers(members, ctx, L);
          };
          const parts: [string, () => void][] = m.cases.map((cs, k) => {
            const conds = cs.values.map(v =>
              this.x.equality(
                "==",
                dExpr,
                this.x.literal(v, m.discriminant.type, this.exprCtx(ctx))
              )
            );
            return [`${k ? "else if" : "if"} (${conds.join(" || ")})`, () => branch(cs.members)];
          });
          const def = m.default;
          const last = def
            ? () => branch(def)
            : () =>
                c.line(
                  `throw new Rt.YaffleException(Rt.ErrorCode.CHECK, $"no case matches {${d}}");`
                );
          if (parts.length) c.chain([...parts, ["else", last]]);
          else c.block("", last);
          break;
        }
      }
    }
  }

  /** The value written for a field: input, or derive (immediately or as a fixup). */
  private emitField(f: IrField, ctx: WCtx, L: string | undefined): void {
    if (f.from) return; // Encoded by the stream prepass into its source fields.
    const c = this.code;
    c.line(`__f = ${str(f.name)};`);
    const fctx: WCtx = { ...ctx, slot: `${ctx.s.id}.${f.name}`, fieldName: f.name };
    if (f.virtual) {
      this.emitVirtual(f, fctx);
      return;
    }
    const ext = this.st.extents.has(f.name) ? extentName(f.name) : undefined;
    const vt = valueTypeOf(this.model, f.type);
    const override = this.st.overrides.get(f.name);
    if (override) {
      this.emitFieldValue(f, override.code, fctx, L, ext, "value");
    } else if (this.types.oneWay(f) && f.output && f.input === "required") {
      // One-way transform: the writer stores the raw value (the input type keeps it).
      const raw = `__v.${this.model.rawMember(ctx.s, f.name)}`;
      const value = `(${raw} ?? throw Rt.Err.Missing(${str(f.name)}))`;
      this.emitFieldValue(f, value, { ...fctx, raw: true }, L, ext, "value");
    } else if (f.input === "required" && !f.hidden) {
      // `u8 flags = it | 0x80`: the input is normalized by the formula on write.
      const value =
        f.derive && usesIt(f.derive)
          ? this.x.to(this.fieldRef(f.name, vt, fctx), vt, f.name)
          : this.inputCode(f.name, vt, fctx).code;
      this.emitFieldValue(f, value, fctx, L, ext, "value");
    } else if (f.derive) {
      const cls = this.fieldClass(ctx.s, f.name);
      if (f.input === "optional" && cls !== "value") {
        // Use the input when given, else compute after layout.
        c.block(`if (${this.given(ctx.s, f.name)})`, () =>
          this.emitFieldValue(f, this.inputCode(f.name, vt, fctx).code, fctx, L, ext, "value")
        );
        c.block("else", () => {
          const d = this.expr(f.derive!, fctx);
          this.emitFieldValue(f, this.x.to(d, vt, f.name), fctx, L, ext, cls);
        });
        return;
      }
      this.emitFieldValue(
        f,
        this.x.to(this.fieldRef(f.name, vt, fctx), vt, f.name),
        fctx,
        L,
        ext,
        cls
      );
    } else this.emitFieldValue(f, this.inputCode(f.name, vt, fctx).code, fctx, L, ext, "value");
  }

  /**
   * A virtual field: no bytes. The value comes from the input (or its default), and the fields it
   * is computed from derive themselves from it. Here the value is validated, and its read
   * expression must give it back (DERIVE otherwise).
   */
  private emitVirtual(f: IrField, ctx: WCtx): void {
    const c = this.code;
    const vt = valueTypeOf(this.model, f.type);
    const val = c.fresh("vv");
    c.line(`var ${val} = ${this.x.to(this.fieldRef(f.name, vt, ctx), vt, f.name)};`);
    const t = stripLayers(f.type);
    if (t.kind === "prim" && t.prim[0] !== "f")
      c.line(`Rt.Ck.Prim((Int128)${val}, Rt.Prim.${t.prim.toUpperCase()}, ${str(f.name)});`);
    const checks = f.checks.filter(ch => !ch.strictOnly);
    this.emitWriteChecks(checks, val, vt, ctx, f.input === "absent" ? "DERIVE" : "CHECK");
    const later = this.deriveClass(ctx.s, f.virtual!.read) !== "value";
    const back = this.expr(f.virtual!.read, { ...ctx, deferred: later });
    const cs = this.types.valueType(vt);
    const check = `Rt.Check.Virtual<${cs}>(${val}, ${this.x.to(back, vt, f.name)}, ${str(f.name)})`;
    c.line(later ? `__w.DeferCheck(() => ${check});` : `${check};`);
  }

  private emitFieldValue(
    f: IrField,
    value: string,
    ctx: WCtx,
    L: string | undefined,
    ext: string | undefined,
    cls: DeriveClass
  ): void {
    const c = this.code;
    const deferred = cls !== "value";
    // Checks: derived values are checked when computed (DERIVE), inputs before writing (CHECK).
    // Constants are correct by construction; their checks only matter on read.
    const checks = f.deriveKind === "constant" ? [] : f.checks.filter(ch => !ch.strictOnly);
    let v = value;
    if (!deferred && (checks.length || !/^[A-Za-z0-9_.]+$/.test(value))) {
      v = c.fresh("val");
      c.line(`var ${v} = ${value};`);
      if (!ctx.raw)
        this.emitWriteChecks(
          checks,
          v,
          valueTypeOf(this.model, f.type),
          ctx,
          f.input !== "absent" ? "CHECK" : "DERIVE"
        );
    }
    if (f.placement) {
      this.emitPlaced(f, v, ctx, L, ext);
      return;
    }
    if (ext) c.line(`${ext} = __w.Extent();`);
    const entry = deferred
      ? this.writeDeferred(f.type, value, { ...ctx, extent: ext }, cls, checks)
      : this.write(f.type, v, { ...ctx, extent: ext });
    if (ext) c.line(`__w.Close(${ext});`);
    if (entry && L) c.line(`${L}.Set(${str(f.name)}, ${entry});`);
  }

  /** An `at` field: its value is a placeable the layout positions. */
  private emitPlaced(
    f: IrField,
    v: string,
    ctx: WCtx,
    L: string | undefined,
    ext: string | undefined
  ): void {
    const c = this.code;
    const placement = f.placement!;
    const P = c.fresh("P");
    const opts: string[] = [];
    if (placement.fixed) opts.push(`Fixed = ${this.num(placement.offset, ctx)}`);
    if (placement.constraint)
      opts.push(
        `Constraint = (${placement.constraint.modulus}L, ${placement.constraint.remainder}L)`
      );
    // The extent exists before the content is written: its layers record stage sizes into it.
    if (ext) c.line(`${ext} = __w.PendingExtent();`);
    const async = ctx.async && this.model.isAsyncType(f.type);
    const body = this.entryLambda(async, () =>
      this.write(f.type, v, { ...ctx, async, extent: ext })
    );
    const optText = opts.length ? `new Rt.PlaceOptions { ${opts.join(", ")} }` : "null";
    const place = async ? "await __w.PlaceAsync" : "__w.Place";
    c.line(`var ${P} = ${place}(${str(f.name)}, ${v}, ${body}, ${optText}, __v);`);
    if (ext) c.line(`__w.BindExtent(${ext}, ${P}${placement.emptyIsNull ? ", true" : ""});`);
    if (L) c.line(`${L}.Set(${str(f.name)}, ${P});`);
    if (!placement.fixed) {
      const off = this.expr(placement.offset, { ...ctx, deferred: true });
      if (off.code !== `${extentName(f.name)}.Pos`) {
        c.line(
          `__w.DeferCheck(() => Rt.Check.Placement(${this.x.asLong(off)}, ${P}, ${str(f.name)}));`
        );
      }
    }
  }

  /** `if (!cond) throw …` for each check (`it` = `value`). */
  private emitWriteChecks(
    checks: readonly IrCheck[],
    value: string,
    vt: IrValueType,
    ctx: WCtx,
    code: "CHECK" | "DERIVE"
  ): void {
    for (const ch of checks) {
      // `$end` is unknown while writing; such checks only apply on read.
      if (exprUses(ch.expr, e => e.kind === "builtinValue" && e.name === "end")) continue;
      this.code.line(this.checkLine(ch, { ...ctx, it: { code: value, type: vt } }, code));
    }
  }

  private checkLine(ch: IrCheck, ctx: WCtx, code: "CHECK" | "DERIVE"): string {
    const cond = this.expr(ch.expr, ctx).code;
    return `if (!${paren(cond)}) throw new Rt.YaffleException(Rt.ErrorCode.${code}, ${str(`check failed: ${ch.message}`)});`;
  }

  /** Writes a derived value whose computation needs sizes/positions/content (a fixup). */
  private writeDeferred(
    t: IrType,
    value: string,
    ctx: WCtx,
    cls: DeriveClass,
    checks: readonly IrCheck[]
  ): string | null {
    const phase = cls === "content" ? 2 : 0;
    const fvt = valueTypeOf(this.model, t);
    const compute = (raw: string, out: (it: string) => string): string => {
      const body = new Code();
      body.line("() =>");
      body.block("", () => {
        body.line(`var __it = ${raw};`);
        for (const ch of checks)
          body.line(
            this.checkLine(
              ch,
              { ...ctx, deferred: true, it: { code: "__it", type: fvt } },
              "DERIVE"
            )
          );
        body.line(`return ${out("__it")};`);
      });
      return body.toString();
    };
    const leaf = (tt: IrType, raw: string, lctx: WCtx): string | null => {
      const c = this.code;
      switch (tt.kind) {
        case "prim": {
          const prim = `Rt.Prim.${tt.prim.toUpperCase()}`;
          const le = this.leOf(tt.endian, lctx);
          if (tt.prim[0] === "f")
            c.line(
              `__w.DeferFloat(${prim}, ${le}, ${compute(raw, it => `(double)${it}`)}, ${phase});`
            );
          else
            c.line(
              `__w.DeferInt(${prim}, ${le}, ${compute(raw, it => `(Int128)${it}`)}, ${phase});`
            );
          return null;
        }
        case "bool":
          c.line(
            `__w.DeferInt(Rt.Prim.U8, true, ${compute(raw, it => `(Int128)(${it} ? 1 : 0)`)}, ${phase});`
          );
          return null;
        case "enum": {
          const en = this.model.enum(tt.enum);
          c.line(
            `__w.DeferInt(Rt.Prim.${en.storage.toUpperCase()}, ${this.leOf(tt.endian, lctx)}, ${compute(raw, it => `(Int128)${this.mod.enumFn(tt.enum, "Value")}(${it})`)}, ${phase});`
          );
          return null;
        }
        case "transform": {
          if (!tt.write) return leaf(tt.inner, raw, lctx);
          const w = this.expr(tt.write, {
            ...lctx,
            deferred: true,
            it: { code: `(${raw})`, type: tt.valueType }
          });
          return leaf(tt.inner, this.x.to(w, valueTypeOf(this.model, tt.inner)), lctx);
        }
        case "layered":
          return this.emitLayers(
            tt.layers,
            tt.layers.length - 1,
            lctx,
            inner => leaf(tt.inner, raw, inner),
            lctx.slot,
            lctx.extent
          );
        case "bytes":
        case "string": {
          const n = this.model.staticSize(tt);
          if (n === undefined) break;
          const conv = (it: string): string =>
            tt.kind === "string"
              ? `Rt.Strings.EncodeFixed(${it}, ${n}, ${tt.unit}, Rt.TextEncoding.${encName(tt.encoding)}, ${this.leOf(tt.endian, lctx)})`
              : it;
          c.line(`__w.DeferBytes(${n}, ${compute(raw, conv)}, ${phase});`);
          return null;
        }
      }
      throw new Error(`cannot write a deferred derived value of type ${tt.kind}`);
    };
    return leaf(t, value, ctx);
  }

  /** A `Func<Rt.LEntry?>` (or async) lambda around `f`'s statements, returning its entry. */
  private entryLambda(async: boolean, f: () => string | null, param?: string): string {
    const { body: inner, value: entry } = this.capture(f);
    const body = new Code();
    body.line(`${async ? "async " : ""}${param ? `${param} =>` : "() =>"}`);
    body.block("", () => {
      body.append(inner);
      body.line(`return ${entry ?? "null"};`);
    });
    return body.toString();
  }

  // ── types ─────────────────────────────────────────────────────────────────

  /** Emits the write of `value` with type `t`; returns code of the produced layout entry, or null. */
  private write(t: IrType, value: string, ctx: WCtx): string | null {
    if (!this.model.isRefTarget(t)) return this.writeInner(t, value, ctx);
    const s = this.code.fresh("rs");
    this.code.line(`int ${s} = __w.Offset;`);
    const e = this.writeInner(t, value, ctx);
    this.code.line(`__w.RefSite(${str(this.model.typeKey(t))}, ${s}, ${value});`);
    return e;
  }

  private writeInner(t: IrType, value: string, ctx: WCtx): string | null {
    const c = this.code;
    switch (t.kind) {
      case "prim":
        c.line(primWrite(t.prim, value, this.leOf(t.endian, ctx)));
        return null;
      case "bool":
        c.line(`__w.Bool(${value});`);
        return null;
      case "string": {
        const le = t.unit === 1 ? "true" : this.leOf(t.endian, ctx);
        if (t.length.kind !== "count" && t.length.kind !== "until" && t.length.kind !== "rest")
          throw new Error(`not implemented: ${t.length.kind} strings`);
        const mode = { count: "Count", until: "Until", rest: "Rest" }[t.length.kind];
        const n = t.length.kind === "count" ? `, ${this.len(t.length.expr, ctx)}` : "";
        c.line(
          `__w.Str(${value}, ${t.unit}, Rt.TextEncoding.${encName(t.encoding)}, ${le}, Rt.StrMode.${mode}${n});`
        );
        return null;
      }
      case "bytes": {
        if (t.length.kind === "count") {
          const n = this.lengthCheck(t.length.expr, ctx, `Rt.Check.Bytes(${value}).Length`);
          c.line(n === undefined ? `__w.Bytes(${value});` : `__w.BytesN(${value}, ${n});`);
        } else if (t.length.kind === "until") {
          c.line(`__w.BytesUntil(${value}, ${this.num(t.length.terminator, ctx)});`);
        } else c.line(`__w.Bytes(${value});`);
        return null;
      }
      case "array":
        return this.array(t, value, ctx);
      case "struct":
        return this.struct(t.struct, t.args, value, ctx);
      case "enum": {
        const en = this.model.enum(t.enum);
        const raw = `${this.mod.enumFn(t.enum, "Value")}(${value})`;
        c.line(primWrite(en.storage, raw, this.leOf(t.endian, ctx)));
        return null;
      }
      case "pointer":
        return this.pointer(t, value, ctx);
      case "extern": {
        const x = this.model.extern(t.extern);
        const args = this.args(t.args, x.params, ctx);
        const fixed = x.kind === "type" && x.fixedSize !== undefined ? x.fixedSize : -1;
        c.line(
          `__w.Extern(${this.mod.extern(t.extern)}, ${value}, new object[] { ${args.join(", ")} }, ${fixed});`
        );
        return null;
      }
      case "union":
        return this.union(t, value, ctx);
      case "transform":
        return this.transform(t, value, ctx);
      case "layered":
        return this.emitLayers(
          t.layers,
          t.layers.length - 1,
          { ...ctx, reuse: value },
          inner => this.write(t.inner, value, inner),
          ctx.slot,
          ctx.extent,
          this.model.isAsyncType(t.inner)
        );
    }
  }

  private union(t: Extract<IrType, { kind: "union" }>, value: string, ctx: WCtx): string | null {
    const c = this.code;
    const u = c.fresh("u");
    const l = c.fresh("l");
    const hasL = this.model.hasPlaceables(t);
    c.line(`var ${u} = Rt.Check.Union(${value});`);
    if (hasL) c.line(`Rt.LEntry? ${l} = null;`);
    c.line(`switch (${u}.Type)`);
    c.block("", () => {
      for (const vr of t.variants) {
        c.line(`case ${str(vr.name)}:`);
        c.block("", () => {
          const cs = this.types.nonNull(this.types.type(vr.type));
          const e = this.write(vr.type, `Rt.Check.Variant<${cs}>(${u})`, ctx);
          if (e && hasL) c.line(`${l} = ${e};`);
          c.line("break;");
        });
      }
      c.line("default:");
      c.indent(() =>
        c.line(
          `throw new Rt.YaffleException(Rt.ErrorCode.INPUT, $"unknown union variant {${u}.Type}");`
        )
      );
    });
    return hasL ? l : null;
  }

  private transform(
    t: Extract<IrType, { kind: "transform" }>,
    value: string,
    ctx: WCtx
  ): string | null {
    const c = this.code;
    if (!t.write) {
      if (ctx.raw) return this.write(t.inner, value, { ...ctx, raw: false });
      c.line(
        `throw new Rt.YaffleException(Rt.ErrorCode.INPUT, "not implemented: writing a one-way transform outside a field");`
      );
      return null;
    }
    const val = c.fresh("tv");
    c.line(`var ${val} = ${value};`);
    const raw = c.fresh("raw");
    const innerVt = valueTypeOf(this.model, t.inner);
    const w = this.expr(t.write, { ...ctx, it: { code: val, type: t.valueType } });
    c.line(`var ${raw} = ${this.x.to(w, innerVt)};`);
    // Round trip: read(write(v)) must give v back (floats: within half a storage step).
    const back = this.expr(t.read, { ...ctx, it: { code: raw, type: innerVt } });
    if (t.valueType.kind === "float" && innerVt.kind === "int") {
      const rawCs = this.types.valueType(innerVt);
      const rawNext = `((${rawCs})(${raw} + 1))`;
      const nextExpr = this.expr(t.read, { ...ctx, it: { code: rawNext, type: innerVt } });
      c.line(
        `Rt.Check.FloatRoundTrip((double)${val}, ${this.x.asDouble(back)}, ${this.x.asDouble(nextExpr)});`
      );
    } else {
      c.line(`Rt.Check.RoundTrip<object?>(${val}, ${this.x.to(back, t.valueType)});`);
    }
    return this.write(t.inner, raw, ctx);
  }

  /**
   * The length a count expression gives, for checking the written value. When it depends on sizes
   * or positions (`u8 gap[tOfs - 0x19 - $offset]`), the check runs after layout instead and this
   * returns undefined.
   */
  private lengthCheck(e: IrExpr, ctx: WCtx, actual: string): string | undefined {
    if (this.deriveClass(ctx.s, e) === "value") return this.len(e, ctx);
    const m = this.code.fresh("m");
    this.code.line(`var ${m} = __w.Mark();`);
    const n = this.len(e, {
      ...ctx,
      deferred: true,
      offsetCode: `${m}.Abs`,
      endCode: `(long)${m}.Block.Region.Output!.Length`
    });
    this.code.line(`__w.DeferCheck(() => Rt.Check.Length(${actual}, ${n}));`);
    return undefined;
  }

  private struct(
    id: string,
    args: readonly IrExpr[],
    value: string,
    ctx: WCtx,
    layersOverride?: readonly IrLayer[]
  ): string | null {
    const s = this.model.struct(id);
    const layers =
      layersOverride ?? (s.base ? s.layers.filter(l => l.kind !== "alignEnd") : s.layers);
    const async = this.model.bodyAsync(id);
    const call = (inner: WCtx): string | null => {
      // Layers may run this inside a closure (codec regions): emit into the current builder.
      const c = this.code;
      const argCode = this.args(args, s.params, inner);
      if (async && !inner.async)
        throw new Error(`async struct ${s.name} written in a sync context`);
      const fn = this.mod.structFn(id, async ? "WriteAsync" : "Write");
      const callExpr = `${async ? "await " : ""}${fn}(${["__w", value, ...argCode].join(", ")})`;
      if (!this.model.structHasPlaceables(id)) {
        c.line(`${callExpr};`);
        return null;
      }
      const l = c.fresh("l");
      c.line(`var ${l} = ${callExpr};`);
      return l;
    };
    if (!layers.length) return call(ctx);
    return this.emitLayers(
      layers,
      layers.length - 1,
      { ...ctx, reuse: value },
      call,
      `${ctx.slot}#${s.name}`,
      undefined,
      async
    );
  }

  private array(t: Extract<IrType, { kind: "array" }>, value: string, ctx: WCtx): string | null {
    const c = this.code;
    const depth = ctx.depth;
    this.st.maxDepth = Math.max(this.st.maxDepth, depth + 1);
    const a = c.fresh("a");
    const i = c.fresh("i");
    const hasL = this.model.hasPlaceables(t);
    c.line(`var ${a} = Rt.Check.Array(${value});`);
    if (t.length.kind === "count") {
      const n = this.lengthCheck(t.length.expr, ctx, `${a}.Count`);
      if (n !== undefined) c.line(`Rt.Check.Length(${a}.Count, ${n});`);
    }
    const la = hasL ? c.fresh("la") : undefined;
    if (la) c.line(`var ${la} = new Rt.LArray();`);
    const setIndex = elementUsesIndex(this.model, t.element, true);
    const saved = setIndex ? c.fresh("ix") : undefined;
    if (saved) c.line(`long ${saved} = __w.Index;`);
    const ectx: WCtx = { ...ctx, index: i, depth: depth + 1, extent: undefined };
    const term =
      t.length.kind === "until" || t.length.kind === "before"
        ? this.expr(t.length.terminator, ctx)
        : undefined;
    const pred = t.length.kind === "untilPredicate" ? t.length.predicate : undefined;
    const evt = valueTypeOf(this.model, t.element);
    c.block(`for (int ${i} = 0; ${i} < ${a}.Count; ${i}++)`, () => {
      c.line(`__i${depth} = ${i};`);
      if (saved) c.line(`__w.Index = ${i};`);
      const el = c.fresh("el");
      c.line(`var ${el} = ${a}[${i}];`);
      if (term) {
        const eq = this.x.equality("==", this.x.typed(el, evt), term);
        c.line(
          `if (${stripParens(eq)}) throw new Rt.YaffleException(Rt.ErrorCode.INPUT, "an element equals the terminator");`
        );
      }
      if (pred) {
        // `until <predicate>`: only the last element may satisfy it (and it must).
        const cond = this.expr(pred, { ...ctx, it: { code: el, type: evt } }).code;
        c.line(
          `if (${paren(cond)} != (${i} == ${a}.Count - 1)) throw new Rt.YaffleException(Rt.ErrorCode.CHECK, "until: only the last element may (and must) end the array");`
        );
      }
      const elv = elementValue(t.element, el);
      if (t.elementPlacement) {
        const off = this.num(t.elementPlacement, { ...ectx, index: `(long)${i}` });
        const async = ctx.async && this.model.isAsyncType(t.element);
        const body = this.entryLambda(async, () => this.write(t.element, elv, { ...ectx, async }));
        const P = c.fresh("P");
        const place = async ? "await __w.PlaceAsync" : "__w.Place";
        c.line(
          `var ${P} = ${place}(${str(`${ctx.fieldName}[]`)}, ${el}, ${body}, new Rt.PlaceOptions { Fixed = ${off} });`
        );
        if (la) c.line(`${la}.Push(${P});`);
      } else {
        const e = this.write(t.element, elv, ectx);
        if (la) c.line(`${la}.Push(${e ?? "null"});`);
      }
    });
    if (pred) {
      c.line(
        `if (${a}.Count == 0) throw new Rt.YaffleException(Rt.ErrorCode.CHECK, "until: the array needs an element that ends it");`
      );
    }
    if (term && t.length.kind === "until") {
      c.line(`__i${depth} = ${a}.Count;`);
      if (saved) c.line(`__w.Index = ${a}.Count;`);
      const e = this.write(t.element, this.x.to(term, evt), ectx);
      if (la && e) c.line(`${la}.Push(${e});`);
    }
    if (saved) c.line(`__w.Index = ${saved};`);
    c.line(`__i${depth} = -1;`);
    return la ?? null;
  }

  private pointer(
    t: Extract<IrType, { kind: "pointer" }>,
    value: string,
    ctx: WCtx
  ): string | null {
    const c = this.code;
    const tv = c.fresh("tv");
    c.line(`var ${tv} = ${value};`);
    const nullable = t.nullValue !== undefined && !t.emptyIsNull;
    const nv = t.nullValue !== undefined ? this.x.intLit(BigInt(t.nullValue), "Int128") : "null";
    const le = this.leOf(t.storageEndian, ctx);
    const prim = `Rt.Prim.${t.storage.toUpperCase()}`;
    const tctx: WCtx = { ...ctx, extent: undefined };
    const targetCs = this.types.nonNull(this.types.type(t.target));
    const targetVal = !nullable
      ? tv
      : this.types.isValueType(targetCs)
        ? `${tv}.GetValueOrDefault()`
        : `${tv}!`;
    // `@nullable(empty)`: an empty array is written as the null value (no target).
    const isNull = t.emptyIsNull ? `Rt.Check.IsEmpty(${tv})` : nullable ? `${tv} is null` : "false";
    // `@origin(expr)`: the stored value is relative to base + origin (computed after layout).
    const origin = t.origin
      ? `, () => ${this.x.asLong(this.expr(t.origin, { ...ctx, deferred: true }))}`
      : "";
    const async = ctx.async && this.model.isAsyncType(t.target);
    if (t.ownership === "ref") {
      const body = this.entryLambda(
        false,
        () => this.write(t.target, targetVal, { ...tctx, async: false }),
        "_"
      );
      const v = isNull === "false" ? `(object?)${tv}` : `${isNull} ? null : (object?)${tv}`;
      c.line(
        `__w.RefPointer(${prim}, ${le}, ${str(this.model.typeKey(t.target))}, ${v}, () => __w.SubRegion(${body}), ${t.relative}, ${nv}${origin});`
      );
      return null;
    }
    const P = c.fresh("P");
    const body = this.entryLambda(async, () => this.write(t.target, targetVal, { ...tctx, async }));
    const key = str(this.model.typeKey(t.target));
    const owner = ctx.depth === 0 ? "__in" : "null";
    const target = `${async ? "await __w.TargetAsync" : "__w.Target"}(${tv}, ${key}, ${str(ctx.fieldName)}, ${body}, null, ${owner})`;
    c.line(
      isNull === "false"
        ? `Rt.Placeable? ${P} = ${target};`
        : `Rt.Placeable? ${P} = ${isNull} ? null : ${target};`
    );
    c.line(`__w.Pointer(${prim}, ${le}, ${P}, ${t.relative}, ${nv}${origin});`);
    return P;
  }

  // ── bits ──────────────────────────────────────────────────────────────────

  private emitBits(b: IrBits, ctx: WCtx): void {
    const c = this.code;
    const u = c.fresh("u");
    c.line(`ulong ${u} = 0;`);
    for (const f of b.fields) {
      if (f.name === null) continue;
      c.line(`__f = ${str(f.name)};`);
      const bits = this.bitsOf(f, this.bitFieldValue(f, ctx), ctx);
      c.line(f.shift ? `${u} |= ${bits} << ${f.shift};` : `${u} |= ${bits};`);
    }
    c.line(`__w.Bits(Rt.Prim.${b.storage.toUpperCase()}, ${u}, ${this.leOf(b.endian, ctx)});`);
  }

  private bitFieldValue(f: IrBitField, ctx: WCtx): string {
    const vt = valueTypeOf(this.model, f.type);
    const v =
      f.input !== "required" && f.derive
        ? this.x.to(this.fieldRef(f.name!, vt, ctx), vt, f.name!)
        : this.inputCode(f.name!, vt, ctx).code;
    const checks = f.checks.filter(ch => !ch.strictOnly);
    if (!checks.length) return v;
    const tmp = this.code.fresh("val");
    this.code.line(`var ${tmp} = ${v};`);
    this.emitWriteChecks(checks, tmp, vt, ctx, f.input === "absent" ? "DERIVE" : "CHECK");
    return tmp;
  }

  private bitsOf(f: IrBitField, value: string, ctx: WCtx): string {
    let t = f.type;
    if (t.kind === "layered") t = t.inner;
    if (t.kind === "transform" && t.write) {
      const w = this.expr(t.write, { ...ctx, it: { code: value, type: t.valueType } });
      return this.bitsOfType(t.inner, this.x.to(w, valueTypeOf(this.model, t.inner)), f.width);
    }
    if (t.kind === "transform") t = t.inner;
    return this.bitsOfType(t, value, f.width);
  }

  /** The bits of a bitfield's value (`Rt.Ck.Bits` checks that it fits the width). */
  private bitsOfType(t: IrType, value: string, width: number): string {
    if (t.kind === "bool") return `Rt.Ck.Bits(${value})`;
    if (t.kind === "enum")
      return `Rt.Ck.Bits(${this.mod.enumFn(t.enum, "Value")}(${value}), ${width}, false)`;
    if (t.kind === "prim") return `Rt.Ck.Bits(${value}, ${width}, ${t.prim[0] === "i"})`;
    return `Rt.Ck.Bits(${value}, ${width}, false)`;
  }

  // ── layers ────────────────────────────────────────────────────────────────

  private emitLayers(
    layers: readonly IrLayer[],
    idx: number,
    ctx: WCtx,
    inner: (ctx: WCtx) => string | null,
    slot: string,
    extent: string | undefined,
    valueAsync = false
  ): string | null {
    if (idx < 0) return inner(ctx);
    const l = layers[idx]!;
    const c = this.code;
    const recordStage = (k: number, sizeExpr: string): void => {
      if (extent) c.line(`${extent}.SetStage(${k}, ${sizeExpr});`);
    };
    const next = (x: WCtx): string | null => {
      const s = extent ? c.fresh("so") : undefined;
      if (s) c.line(`int ${s} = __w.Offset;`);
      const e = this.emitLayers(layers, idx - 1, x, inner, slot, extent, valueAsync);
      if (s) recordStage(idx, `__w.Offset - ${s}`);
      return e;
    };
    switch (l.kind) {
      case "align":
        c.line(`${this.alignCall(l, ctx)};`);
        return next(ctx);
      case "padBefore":
        c.line(`__w.Pad(${this.len(l.count, ctx)}, ${this.fill(l.fill, ctx)});`);
        return next(ctx);
      case "padAfter": {
        const e = next(ctx);
        c.line(`__w.Pad(${this.len(l.count, ctx)}, ${this.fill(l.fill, ctx)});`);
        return e;
      }
      case "padUntil": {
        const s = c.fresh("s");
        c.line(`int ${s} = __w.Offset;`);
        const e = next(ctx);
        c.line(`__w.PadUntil(${s}, ${this.len(l.size, ctx)}, ${this.fill(l.fill, ctx)});`);
        return e;
      }
      case "alignEnd": {
        const e = next(ctx);
        c.line(`${this.alignCall(l, ctx)};`);
        return e;
      }
      case "size": {
        const s = c.fresh("s");
        c.line(`int ${s} = __w.Offset;`);
        const e = next(ctx);
        c.line(`__w.SizeWindow(${s}, ${this.len(l.size, ctx)});`);
        return e;
      }
      case "via": {
        const codec = this.model.codec(l.codec);
        const args = this.args(l.args, codec.params, ctx);
        const plain = c.fresh("plain");
        // Whether what the codec wraps (inner layers and the value) awaits.
        const innerAsync =
          ctx.async &&
          (layers.slice(0, idx).some(ll => ll.kind === "via" && this.model.codec(ll.codec).async) ||
            valueAsync);
        const body = this.entryLambda(
          innerAsync,
          () =>
            this.emitLayers(
              layers,
              idx - 1,
              { ...ctx, async: innerAsync },
              inner,
              slot,
              extent,
              valueAsync
            ),
          "_"
        );
        c.line(
          `var ${plain} = ${innerAsync ? "await __w.SubRegionAsync" : "__w.SubRegion"}(${body});`
        );
        recordStage(idx, `${plain}.Length`);
        if (extent) c.line(`${extent}.Plain ??= ${plain};`);
        // An inner size layer gives the decoded size.
        const sized = layers
          .slice(0, idx)
          .reverse()
          .find(ll => ll.kind === "via" || ll.kind === "size");
        const outSize = sized?.kind === "size" ? `, ${plain}.Length` : "";
        const cctx = `new Rt.CodecContext(new object[] { ${args.join(", ")} }${outSize})`;
        const reuse = `Rt.Codecs.Reuse(${ctx.reuse ?? "null"}, ${str(`${slot}#${idx}`)}, ${plain})`;
        if (codec.async && !ctx.async)
          throw new Error(`async codec ${codec.name} in a sync writer`);
        const enc = `Rt.Codecs.Encode${codec.async ? "Async" : ""}(${this.mod.extern(l.codec)}, ${str(codec.name)}, ${plain}, ${cctx})`;
        c.line(`__w.Raw(${reuse} ?? ${codec.async ? "await " : ""}${enc});`);
        return null;
      }
      case "endian": {
        const e = c.fresh("en");
        const le = c.fresh("le");
        c.line(`var ${e} = ${this.expr(l.value, ctx).code};`);
        c.line(`bool ${le} = ${e} == Rt.Endian.Le;`);
        return next({ ...ctx, endian: e, le });
      }
      case "strict":
        return next(ctx);
    }
  }

  /** `align`/`alignEnd` padding; with an origin or offset through `AlignAt`. */
  private alignCall(l: Extract<IrLayer, { kind: "align" | "alignEnd" }>, ctx: WCtx): string {
    const to = this.num(l.to, ctx);
    const fill = this.fill(l.fill, ctx);
    if (l.from !== "file" && !l.offset) return `__w.Align(${to}, ${fill})`;
    const off = l.offset ? this.num(l.offset, ctx) : "0L";
    return `__w.AlignAt(${to}, ${fill}, ${l.from === "file"}, ${off})`;
  }

  /** A base's (or the root's) `@alignEnd`: pads its whole region, after its targets. */
  private regionAlignEnd(l: Extract<IrLayer, { kind: "alignEnd" }>, ctx: WCtx): string {
    const to = this.num(l.to, ctx);
    const off = l.offset ? this.num(l.offset, ctx) : "0L";
    return `__w.RegionAlignEnd(${to}, ${l.from === "file"}, ${off})`;
  }

  // ── virtual streams ───────────────────────────────────────────────────────

  /**
   * `from` fields: encode the value, then hand the bytes to the stream's source fields. Fields
   * reading slices of one stream are assembled into it together. Later `from` fields go first: a
   * stream's source may itself be a `from` field (or a slice carrier) whose value is only known
   * once its own readers are encoded.
   */
  private emitStreamPrepass(s: IrStruct, ctx: WCtx): void {
    const c = this.code;
    const froms: IrField[] = [];
    for (const f of this.model.fields(s)) {
      if (f.field?.from && !froms.some(g => g.name === f.name)) froms.push(f.field);
    }
    const encode = (g: IrField): string => {
      const enc = c.fresh("stream");
      const vt = valueTypeOf(this.model, g.type);
      const async = ctx.async && this.model.isAsyncType(g.type);
      const override = this.st.overrides.get(g.name);
      const value = override ? override.code : this.inputCode(g.name, vt, ctx).code;
      const body = this.entryLambda(
        async,
        () => this.write(g.type, value, { ...ctx, async, fieldName: g.name }),
        "_"
      );
      c.line(`__f = ${str(g.name)};`);
      const info = this.types.field(s, this.model.field(s, g.name)!);
      if (!override && !info.valueType)
        c.line(`if (__v.${info.member} is null) throw Rt.Err.Missing(${str(g.name)});`);
      c.line(`var ${enc} = ${async ? "await __w.SubRegionAsync" : "__w.SubRegion"}(${body});`);
      return enc;
    };
    const done = new Set<string>();
    for (let k = froms.length - 1; k >= 0; k--) {
      const fld = froms[k]!;
      if (done.has(fld.name)) continue;
      const root = streamRoot(fld.from!.stream);
      const group = froms.filter(
        g => !done.has(g.name) && rootKey(streamRoot(g.from!.stream).root) === rootKey(root.root)
      );
      for (const g of group) done.add(g.name);
      const policy = group.find(g => g.from!.split)?.from!.split?.policy;
      if (group.length === 1 && fld.from!.stream.kind !== "slice") {
        this.streamTargets(fld.from!.stream, encode(fld), s, ctx, policy);
        continue;
      }
      // Slices: the stream is assembled from every slice field's encoding.
      const parts: string[] = [];
      for (const g of [...group].reverse()) {
        const r = streamRoot(g.from!.stream);
        const enc = encode(g);
        const start = r.start ? this.num(r.start, ctx) : "0L";
        const end = r.end ? `(long?)${paren(this.num(r.end, ctx))}` : "null";
        parts.push(`new Rt.SlicePart(${str(g.name)}, ${start}, ${end}, ${enc})`);
      }
      const assembled = c.fresh("slices");
      c.line(`__f = "";`);
      c.line(
        `var ${assembled} = Rt.Slices.Assemble(${this.carrierLength(s, root.root, ctx)}, new Rt.SlicePart[] { ${parts.join(", ")} });`
      );
      this.streamTargets(root.root, assembled, s, ctx, policy);
    }
  }

  /**
   * Length of a sliced field: its own `count` length when that doesn't depend on the field itself,
   * else null (the largest slice end).
   */
  private carrierLength(s: IrStruct, root: IrStreamExpr, ctx: WCtx): string {
    if (root.kind !== "field") return "null";
    const f = this.model.field(s, root.field)?.field;
    if (!f) return "null";
    const t = stripLayers(f.type);
    if (t.kind !== "bytes" || t.length.kind !== "count") return "null";
    if (this.refersTo(s, t.length.expr, root.field, [])) return "null";
    return `(long?)${paren(this.len(t.length.expr, ctx))}`;
  }

  /** True if `e` (with derived fields inlined) references field `name`. */
  private refersTo(s: IrStruct, e: IrExpr, name: string, seen: string[]): boolean {
    return exprUses(e, x => {
      if (x.kind !== "field") return false;
      if (x.name === name) return true;
      const fr = this.model.field(s, x.name);
      const decl = fr?.field ?? fr?.bit;
      return (
        decl?.derive !== undefined &&
        decl.input !== "required" &&
        !seen.includes(x.name) &&
        this.refersTo(s, decl.derive, name, [...seen, x.name])
      );
    });
  }

  private streamTargets(
    st: IrStreamExpr,
    bytes: string,
    s: IrStruct,
    ctx: WCtx,
    policy: string | undefined
  ): void {
    const c = this.code;
    if (st.kind === "field") {
      const local = c.fresh("sf");
      c.line(`var ${local} = ${bytes};`);
      this.st.overrides.set(st.field, { code: local, cs: "byte[]" });
      return;
    }
    // Slices are assembled by the prepass and never reach here.
    if (st.kind === "slice") throw new Error("internal: a stream slice reached streamTargets");
    // each: split into the elements' bytes fields, by the pieces' size fields from the input,
    // else by the @split policy (fit: the longest piece whose element fits before the next one).
    const { array: el, element: es } = this.model.structArray(s, st.array);
    const elemCls = this.model.className(es.id);
    const pieceMember = this.model.member(es, st.field);
    const piece = this.model.field(es, st.field)?.field;
    const sizeField = piece ? innerSizeField(piece.type) : undefined;
    const local = c.fresh("els");
    let fitOffset = "null";
    let fitSize = "null";
    if (policy === "fit" && el.elementPlacement) {
      const k = c.fresh("k");
      fitOffset = `(long ${k}) => ${this.num(el.elementPlacement, { ...ctx, index: k })}`;
      const e = c.fresh("fe");
      const elemT = el.element;
      const lam = this.entryLambda(
        false,
        () => this.write(elemT, e, { ...ctx, async: false, index: "-1L", fieldName: st.array }),
        "_"
      );
      fitSize = `(${elemCls} ${e}) => (long)__w.SubRegion(${lam}).Length`;
    }
    const sizeRef = sizeField ? this.model.field(es, sizeField) : undefined;
    const sizeInfo = sizeRef ? this.types.field(es, sizeRef) : undefined;
    const arrValue = `__v.${this.types.field(s, this.model.field(s, st.array)!).member}`;
    const pe = c.fresh("pe");
    const pd = c.fresh("pd");
    const getSize = sizeInfo ? `(${elemCls} ${pe}) => (long?)${pe}.${sizeInfo.member}` : "null";
    // A derived size field the writer recomputes needs no clearing (it ignores the input).
    const clearSize = sizeInfo?.nullable
      ? `(${elemCls} ${pe}) => ${pe}.${sizeInfo.member} = null`
      : "null";
    c.line(
      `var ${local} = Rt.StreamSplit.Split<${elemCls}>(${arrValue}, ${bytes}, (${elemCls} ${pe}) => ${pe}.${pieceMember}, (${elemCls} ${pe}, byte[] ${pd}) => ${pe}.${pieceMember} = ${pd}, ` +
        `${getSize}, ${clearSize}, () => new ${elemCls}(), (${elemCls} ${pe}) => ${pe}.__Clone(), ${fitOffset}, ${fitSize});`
    );
    this.st.overrides.set(st.array, { code: local, cs: `List<${elemCls}>` });
  }
}

function primWrite(p: string, value: string, le: string): string {
  if (p === "u8" || p === "i8") return `__w.${p.toUpperCase()}(${value});`;
  return `__w.${p.toUpperCase()}(${value}, ${le});`;
}

/** An element value of a list (reference-typed elements may be null: INPUT). */
function elementValue(t: IrType, el: string): string {
  const x = stripLayers(t);
  if (x.kind === "string" || x.kind === "bytes" || x.kind === "array")
    return `(${el} ?? throw new Rt.YaffleException(Rt.ErrorCode.INPUT, "null element"))`;
  return el;
}

/** The field or `each` stream under any slices, and the composed slice bounds. */
function streamRoot(st: IrStreamExpr): {
  root: IrStreamExpr;
  start: IrExpr | undefined;
  end: IrExpr | undefined;
} {
  if (st.kind !== "slice") return { root: st, start: undefined, end: undefined };
  const inner = streamRoot(st.stream);
  const plus = (a: IrExpr | undefined, b: IrExpr): IrExpr =>
    a ? { kind: "binary", op: "+", left: a, right: b, type: { kind: "bigint" } } : b;
  return {
    root: inner.root,
    start: plus(inner.start, st.start),
    end: st.end ? plus(inner.start, st.end) : inner.end
  };
}

function rootKey(st: IrStreamExpr): string {
  return st.kind === "field"
    ? `f:${st.field}`
    : st.kind === "each"
      ? `e:${st.array}.${st.field}`
      : "";
}

function extentName(f: string): string {
  return f === "this" ? "__x_this" : `__x_${ident(f).replace(/^@/, "")}`;
}

/** The field a stream piece's length comes from (its count, or its outer `@size`), if any. */
function innerSizeField(t: IrType): string | undefined {
  const fieldOf = (e: IrExpr): string | undefined => {
    while (e.kind === "convert") e = e.operand;
    return e.kind === "field" ? e.name : undefined;
  };
  if (t.kind === "bytes" && t.length.kind === "count") return fieldOf(t.length.expr);
  if (t.kind !== "layered") return undefined;
  for (const l of t.layers) {
    if (l.kind === "via") return undefined;
    if (l.kind === "size") return fieldOf(l.size);
  }
  return undefined;
}

/** True if a layout item layer argument is not a constant. */
function dynamicLayout(items: readonly IrLayoutItem[]): boolean {
  return items.some(
    it =>
      it.layers.some(l => {
        const args =
          l.kind === "align" || l.kind === "alignEnd"
            ? [l.to, l.offset]
            : l.kind === "padBefore" || l.kind === "padAfter"
              ? [l.count]
              : [];
        return args.some(e => e !== undefined && literalInt(e) === undefined);
      }) ||
      (it.group !== undefined && dynamicLayout(it.group.items))
  );
}

/**
 * Layout items as a C# array literal. Layer arguments are constants, or compiled by `num`
 * (instance layouts).
 */
function layoutLiteral(items: readonly IrLayoutItem[], num?: (e: IrExpr) => string): string {
  const n = (e: IrExpr): string => {
    const v = literalInt(e);
    if (v !== undefined) return String(v);
    if (!num) throw new Error("layout item layers with non-constant arguments need an instance");
    return num(e);
  };
  const layer = (l: IrLayer): string | undefined => {
    switch (l.kind) {
      case "align":
        if (l.offset || l.from === "file")
          return `Rt.LayoutLayer.AlignAt(${n(l.to)}, ${l.offset ? n(l.offset) : 0}, ${l.from === "file"})`;
        return `Rt.LayoutLayer.Align(${n(l.to)})`;
      case "alignEnd":
        return `Rt.LayoutLayer.AlignEnd(${n(l.to)})`;
      case "padBefore":
        return `Rt.LayoutLayer.PadBefore(${n(l.count)})`;
      case "padAfter":
        return `Rt.LayoutLayer.PadAfter(${n(l.count)})`;
      default:
        return undefined;
    }
  };
  const parts = items.map(it => {
    const path =
      it.path === "this"
        ? "null"
        : `new string[] { ${it.path.map(seg => (seg.kind === "each" ? `"*"` : str(seg.name))).join(", ")} }`;
    const layers = it.layers.map(layer).filter(Boolean);
    const group = it.group ? ` { Group = ${layoutLiteral(it.group.items, num)} }` : "";
    return `new Rt.LayoutItem(${[path, ...layers].join(", ")})${group}`;
  });
  return `new Rt.LayoutItem[] { ${parts.join(", ")} }`;
}

/** Types whose encoding has a size independent of position and context (patchable in views). */
function patchableType(t: IrType): boolean {
  switch (t.kind) {
    case "prim":
    case "bool":
    case "enum":
      return true;
    case "string":
    case "bytes":
      return t.length.kind === "count";
    case "transform":
      return t.write !== undefined && patchableType(t.inner);
    case "layered":
      return (
        t.layers.every(
          l =>
            l.kind === "endian" ||
            l.kind === "strict" ||
            (l.kind === "size" && literalInt(l.size) !== undefined) ||
            (l.kind === "padUntil" && literalInt(l.size) !== undefined)
        ) && patchableType(t.inner)
      );
    default:
      return false;
  }
}

/** The bits member holding the named bitfield. */
function findBits(ms: readonly IrMember[], name: string): IrBits | undefined {
  for (const m of ms) {
    if (m.kind === "bits" && m.fields.some(b => b.name === name)) return m;
    const nested =
      m.kind === "block"
        ? [m.members, m.else ?? []]
        : m.kind === "switch"
          ? [...m.cases.map(c => c.members), m.default ?? []]
          : [];
    for (const n of nested) {
      const x = findBits(n, name);
      if (x) return x;
    }
  }
  return undefined;
}
