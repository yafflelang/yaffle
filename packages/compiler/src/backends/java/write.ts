/**
 * Writer emitter: one `write(Writer, value, params…)` method per struct, relocation-style code over
 * the runtime `Writer` following docs/IR.md §3 and §4.
 *
 * Derived values are evaluated where they are written when they depend only on values; values
 * that depend on sizes, positions or encodings are written as placeholders and computed by
 * fixups after layout. References to a derived field inline its `derive` expression.
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
  exprHas,
  forEachMember,
  isOneWay,
  layoutConstant,
  layoutExprs,
  layoutUsesIndex,
  literalInt,
  patchableType,
  primSize,
  unlayer,
  usesIndex,
  usesIt,
  writeExtentFields
} from "./analysis.ts";
import { Code, ident, longLit, str, stripParens, wrap } from "./code.ts";
import { Emitter, type EmitCtx } from "./emitter.ts";
import type { CExpr, ExprCtx } from "./expr.ts";
import { isPrimitive, refInput } from "./model.ts";

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
}

/** What a derived value depends on, in increasing order of lateness. */
type DeriveClass = "value" | "size" | "position" | "content";

const RANK: Record<DeriveClass, number> = { value: 0, size: 1, position: 2, content: 3 };

interface StructState {
  extents: Set<string>;
  maxDepth: number;
  /** Derives being inlined (cycle detection). */
  inlining: string[];
  /** Field values computed before the members (stream sources, slice carriers). */
  overrides: Map<string, string>;
}

const newState = (extents = new Set<string>()): StructState => ({
  extents,
  maxDepth: 0,
  inlining: [],
  overrides: new Map()
});

type ArrayType = Extract<IrType, { kind: "array" }>;

export class WriteEmitter extends Emitter<WCtx> {
  private st!: StructState;
  private readonly classMemo = new Map<string, DeriveClass>();

  protected structUsesIndex(s: IrStruct): boolean {
    return usesIndex(s) || layoutUsesIndex(s);
  }

  private rootCtx(s: IrStruct, slot: string, fieldName = ""): WCtx {
    return {
      s,
      endian: "endian",
      le: "$le",
      index: "-1L",
      depth: 0,
      deferred: false,
      slot,
      fieldName
    };
  }

  /**
   * The layout of a region rooted at `s` (the root, a `@base`): the hoisted constant, or
   * `LayoutItem.OWN` when `s`'s writer computes its items.
   */
  regionLayout(s: IrStruct): string {
    if (!s.layout?.length) return "null";
    const LI = this.use("LayoutItem");
    if (!layoutConstant(s.layout)) return `${LI}.OWN`;
    return this.cls.hoist(
      layoutLiteral(s.layout, LI, e => String(literalInt(e))),
      `${LI}[]`,
      "LAYOUT"
    );
  }

  /**
   * `$L.layout(…)` for a struct whose layout items read fields: the layers' arguments are
   * evaluated in the struct's write context, after its fields are written.
   */
  private emitDynamicLayout(s: IrStruct, ctx: WCtx): void {
    if (!s.layout?.length || layoutConstant(s.layout)) return;
    for (const e of layoutExprs(s.layout)) {
      const c = this.deriveClass(s, e);
      if (c === "position" || c === "content") {
        // Circular: positions and final encodings are only known after layout.
        throw new Error(
          `${s.name}: layout item arguments can't depend on positions or encoded content`
        );
      }
    }
    const items = layoutLiteral(s.layout, this.use("LayoutItem"), e => this.num(e, ctx));
    this.code.line(`$fr.f = "";`);
    this.code.line(`$L.layout(${items});`);
  }

  /** True if the struct's writer returns its layout structure. */
  returnsL(s: IrStruct): boolean {
    return !s.base && this.model.membersHavePlaceables(s);
  }

  emitStruct(out: Code, s: IrStruct): void {
    const name = this.model.className(s.id);
    this.st = newState(writeExtentFields(s));
    const hasL = this.model.membersHavePlaceables(s);
    const body = new Code();
    this.code = body;
    const ctx: WCtx = { ...this.rootCtx(s, name), index: "$index" };
    this.emitStreamPrepass(s, ctx);
    this.emitMembers(s.members, ctx, hasL ? "$L" : undefined);
    if (hasL) this.emitDynamicLayout(s, ctx);

    const params = s.params.map(p => `${this.model.javaValueType(p.type)} ${ident(p.name)}`);
    const ret = this.returnsL(s) ? this.use("LStruct") : "void";
    const W = this.use("Writer");
    out.block(`static ${ret} write(${[`${W} $w`, `${name} $v`, ...params].join(", ")})`, () => {
      if (s.params.some(p => p.origin === "endian")) {
        out.line(`final boolean $le = endian == ${this.use("Endian")}.LE;`);
      }
      out.line(`${this.use("Rt")}.need($v);`);
      for (const req of this.requiredChecks(s, s.members)) out.line(req);
      if (this.structUsesIndex(s)) out.line(`final long $index = $w.index;`);
      const ownThis = this.st.extents.has("this") && !s.base;
      const emitBody = (inLambda: boolean): void => {
        // A base's `@alignEnd` pads its whole region, after its targets.
        if (s.base) {
          for (const l of s.layers)
            if (l.kind === "alignEnd") out.line(this.regionAlignEnd(l, ctx));
        }
        if (hasL) {
          const LS = this.use("LStruct");
          const own = s.layout?.length && !layoutConstant(s.layout);
          out.line(`final ${LS} $L = new ${LS}(${own ? "" : this.regionLayout(s)});`);
        }
        const X = this.use("Extent");
        for (const f of this.st.extents) {
          if (f === "this") {
            out.line(`final ${X} $x_this = ${s.base ? "$w.regionExtent()" : `new ${X}()`};`);
          } else out.line(`final ${X} ${extVar(f)} = new ${X}();`);
        }
        const F = this.use("Frame");
        out.line(`final ${F} $fr = new ${F}(${this.st.maxDepth || ""});`);
        out.line(`$w.enter($fr);`);
        out.chain([
          [
            "try",
            () => {
              if (ownThis) out.line(`$w.start($x_this);`);
              out.append(body);
              if (ownThis) out.line(`$w.close($x_this);`);
            }
          ],
          [`catch (${this.use("YaffleException")} $e)`, () => out.line(`throw $fr.rethrow($e);`)],
          ["finally", () => out.line(`$w.leave();`)]
        ]);
        if (hasL) out.line("return $L;");
        else if (inLambda) out.line("return null;");
      };
      if (s.base) {
        out.line(`$w.base(${this.regionLayout(s)}, () -> {`);
        out.indent(() => emitBody(true));
        out.line(`}, $v);`);
      } else emitBody(false);
    });
  }

  /**
   * Emits into `body` with fresh struct state. False if `f` returns false, throws, or the code
   * needs extents (then the value can't be encoded on its own).
   */
  private standalone(body: Code, f: () => boolean): boolean {
    const savedCode = this.code;
    const savedSt = this.st;
    this.st = newState();
    this.code = body;
    try {
      return f() && !this.st.extents.size;
    } catch {
      return false;
    } finally {
      this.code = savedCode;
      this.st = savedSt;
    }
  }

  /**
   * A view encoder for one field: `($nv, $ov, $a) -> bytes` (new value, the struct's plain value
   * with it applied, the struct's arguments), or undefined if the field's encoding depends on
   * sizes, positions or targets (then setting it is structural).
   */
  encoderFor(s: IrStruct, name: string): string | undefined {
    const fr = this.model.field(s, name);
    if (!fr) return undefined;
    const f = fr.field;
    if (f && (f.placement || f.from || f.virtual || f.carrier || !patchableType(f.type))) {
      return undefined;
    }
    const body = new Code();
    const ctx = this.rootCtx(s, `${this.model.className(s.id)}.${name}`, name);
    const ok = this.standalone(body, () => {
      if (!f) {
        const bits = findBits(s.members, name);
        if (bits) this.emitBits(bits, ctx);
        return bits !== undefined;
      }
      const vt = this.model.valueTypeOf(f.type);
      const jt = this.model.javaValueType(vt);
      const R = this.use("Rt");
      const v = jt.includes("<")
        ? `${R}.cast($nv)`
        : this.cls.castFromObject(jt, `${R}.nonNull($nv, "a value")`);
      body.line(`final ${jt} $val = ${v};`);
      const checks = f.deriveKind === "constant" ? [] : f.checks.filter(ch => !ch.strictOnly);
      this.emitWriteChecks(checks, "$val", vt, ctx, "CHECK");
      return !this.write(f.type, "$val", ctx);
    });
    if (!ok) return undefined;
    const sname = this.model.className(s.id);
    const F = this.use("Frame");
    const out = new Code();
    out.line(`($nv, $ov, $a) -> ${this.use("Api")}.encode($w -> {`);
    out.indent(() => {
      out.line(`final ${sname} $v = (${sname}) $ov;`);
      s.params.forEach((p, i) => {
        const jt = this.model.javaValueType(p.type);
        out.line(`final ${jt} ${ident(p.name)} = ${this.cls.castFromObject(jt, `$a[${i}]`)};`);
      });
      if (s.params.some(p => p.origin === "endian")) {
        out.line(`final boolean $le = endian == ${this.use("Endian")}.LE;`);
      }
      out.line(`final ${F} $fr = new ${F}();`);
      out.line(`$fr.f = ${str(name)};`);
      out.append(body);
    });
    out.line("})");
    return out.toString();
  }

  /** Encoder of one element of a lazy scalar array (`le`: the little-endian flag in scope). */
  elementEncoder(s: IrStruct, t: IrType, le: string): string | undefined {
    if (!patchableType(t) || t.kind === "transform") return undefined;
    const body = new Code();
    const ctx: WCtx = { ...this.rootCtx(s, ""), le };
    const vt = this.model.valueTypeOf(t);
    const jt = this.model.javaValueType(vt);
    const ok = this.standalone(body, () => {
      body.line(
        `final ${jt} $val = ${this.cls.castFromObject(jt, `${this.use("Rt")}.nonNull($ev, "a value")`)};`
      );
      return !this.write(t, "$val", ctx);
    });
    if (!ok) return undefined;
    const out = new Code();
    out.line(`$ev -> ${this.use("Api")}.encode($w -> {`);
    out.indent(() => out.append(body));
    out.line("})");
    return out.toString();
  }

  /** Emits the write of a root struct (params are locals); returns the layout entry or null. */
  rootWrite(out: Code, s: IrStruct, value: string): string | null {
    this.st = newState();
    this.code = out;
    const ctx = this.rootCtx(s, this.model.className(s.id));
    const args: IrExpr[] = s.params.map(p => ({ kind: "param", name: p.name, type: p.type }));
    if (s.base) return this.struct(s.id, args, value, ctx);
    // The root is its file's base: `@alignEnd` pads the whole region, after the targets.
    for (const l of s.layers) if (l.kind === "alignEnd") out.line(this.regionAlignEnd(l, ctx));
    return this.struct(
      s.id,
      args,
      value,
      ctx,
      s.layers.filter(l => l.kind !== "alignEnd")
    );
  }

  /** `Rt.req` checks for required reference-typed fields of the unconditional part of a member list. */
  requiredChecks(s: IrStruct, ms: readonly IrMember[]): string[] {
    const out: string[] = [];
    for (const name of this.requiredFields(ms)) {
      const fi = this.model.fieldInfo(s, name);
      const target = fi.raw ?? fi;
      if (isPrimitive(target.type)) continue;
      const fr = this.model.field(s, name);
      const ft = fr?.field?.type ?? fr?.bit?.type;
      if (ft && this.model.valueTypeOf(ft).kind === "nullable") continue;
      out.push(`${this.use("Rt")}.req($v.${target.java}, ${str(name)});`);
    }
    return out;
  }

  /** Required input fields of the unconditional part of a member list. */
  private requiredFields(ms: readonly IrMember[]): string[] {
    const out: string[] = [];
    for (const m of ms) {
      if (m.kind === "field") {
        if (m.input === "required" && !m.hidden && !this.st.overrides.has(m.name)) out.push(m.name);
      } else if (m.kind === "bits") {
        for (const b of m.fields) if (b.name !== null && b.input === "required") out.push(b.name);
      } else if (m.kind === "block" && !m.condition) out.push(...this.requiredFields(m.members));
    }
    return out;
  }

  // ── derive classification ───────────────────────────────────────────────────

  deriveClass(s: IrStruct, e: IrExpr, seen: string[] = []): DeriveClass {
    let cls: DeriveClass = "value";
    const bump = (c: DeriveClass): void => {
      if (RANK[c] > RANK[cls]) cls = c;
    };
    exprHas(e, x => {
      if (x.kind === "call" && x.callee.kind === "builtin") {
        const n = x.callee.name;
        if (n === "sizeof" || n === "encodedSize") bump("size");
        else if (n === "offsetof") bump("position");
        else if (n === "bytesof" || n === "encode") bump("content");
      } else if (x.kind === "builtinValue" && (x.name === "offset" || x.name === "end")) {
        bump("position");
      } else if (x.kind === "field") {
        const f = this.model.field(s, x.name);
        const d = f?.field?.derive ?? f?.bit?.derive;
        if (d && f && refInput(f) !== "required" && !seen.includes(x.name)) {
          bump(this.fieldClass(s, x.name, [...seen, x.name]));
        }
      }
      return false;
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

  // ── expression context ──────────────────────────────────────────────────────

  exprCtx(ctx: WCtx): ExprCtx {
    return {
      ...this.commonExprCtx(ctx),
      field: (name, type) => this.fieldRef(name, type, ctx),
      builtin: name => {
        if (name === "offset") return ctx.offsetCode ?? "$w.position()";
        if (name === "end") return ctx.endCode ?? `${this.use("Rt")}.endUnavailable()`;
        return ctx.index;
      },
      sizeof: f => `${this.extentVar(f)}.size()`,
      offsetof: f => `(long) ${this.extentVar(f)}.pos()`,
      encodedSize: (f, k) => `${this.extentVar(f)}.stage(${k})`,
      bytesof: f => `${this.extentVar(f)}.bytes()`,
      encode: f => `${this.extentVar(f)}.plainBytes()`
    };
  }

  private extentVar(f: string): string {
    this.st.extents.add(f);
    return extVar(f);
  }

  /** The input value of a field as a typed CExpr (boxed fields unboxed). */
  private inputExpr(s: IrStruct, name: string, type: IrValueType): CExpr {
    const fi = this.model.fieldInfo(s, name);
    if (fi.raw) {
      const boxed = /^(java\.lang\.)?(Integer|Long|Double|Float|Boolean)$/.test(fi.raw.type);
      return this.x.fieldValue(`$v.${fi.raw.java}`, boxed, fi.type, type);
    }
    return this.x.fieldValue(`$v.${fi.java}`, fi.boxed, fi.type, type);
  }

  /** A field reference in the write context: input value, or the inlined derive. */
  fieldRef(name: string, type: IrValueType, ctx: WCtx): CExpr {
    const override = this.st.overrides.get(name);
    if (override) return this.x.typed(override, type);
    const f = this.model.field(ctx.s, name);
    if (!f) throw new Error(`unknown field ${name} in ${ctx.s.name}`);
    const input = refInput(f);
    const derive = f.field ? f.field.derive : f.bit!.derive;
    if (input === "required" && !f.field?.hidden) {
      const i = this.inputExpr(ctx.s, name, type);
      // `u8 flags = it | 0x80`: the input is normalized by the formula.
      if (derive && usesIt(derive)) {
        return this.x.compile(derive, this.exprCtx({ ...ctx, it: { code: i.code, type } }));
      }
      return i;
    }
    if (!derive) return this.inputExpr(ctx.s, name, type);
    if (this.st.inlining.includes(name)) {
      throw new Error(`derive cycle through ${name} in ${ctx.s.name}`);
    }
    this.st.inlining.push(name);
    const d = this.x.compile(derive, this.exprCtx({ ...ctx, it: undefined }));
    this.st.inlining.pop();
    if (input !== "optional") return d;
    const fi = this.model.fieldInfo(ctx.s, name);
    const i = this.inputExpr(ctx.s, name, type);
    return this.x.cond({ code: `$v.${fi.java} != null`, repr: "bool" }, i, d, this.exprCtx(ctx));
  }

  // ── members ─────────────────────────────────────────────────────────────────

  emitMembers(ms: readonly IrMember[], ctx: WCtx, L: string | undefined): void {
    const c = this.code;
    // A branch first checks the required fields it holds.
    const branch = (members: readonly IrMember[], run: () => void): void => {
      const req = this.requiredChecks(ctx.s, members);
      if (req.length) {
        c.line(`$fr.f = "";`);
        for (const r of req) c.line(r);
      }
      run();
    };
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
              undefined
            );
          };
          const els = m.else;
          if (m.condition) {
            this.emitIf(
              m.condition,
              ctx,
              () => branch(m.members, body),
              els && (() => branch(els, () => this.emitMembers(els, ctx, L)))
            );
          } else c.block("", body);
          break;
        }
        case "switch":
          this.emitSwitch(
            m,
            ctx,
            ms => branch(ms, () => this.emitMembers(ms, ctx, L)),
            d => this.fail("CHECK", `"no case matches " + ${d}`)
          );
          break;
      }
    }
  }

  /** The value written for a field: input, or derive (immediately or as a fixup). */
  emitField(f: IrField, ctx: WCtx, L: string | undefined): void {
    const c = this.code;
    if (f.from) return; // encoded by the stream prepass into its source fields
    c.line(`$fr.f = ${str(f.name)};`);
    const fctx: WCtx = { ...ctx, slot: `${ctx.s.id}.${f.name}`, fieldName: f.name };
    if (f.virtual) {
      this.emitVirtual(f, f.virtual.read, fctx);
      return;
    }
    const ext = this.st.extents.has(f.name) ? extVar(f.name) : undefined;
    const vt = this.model.valueTypeOf(f.type);
    const ectx = this.exprCtx(fctx);
    const fi = this.model.fieldInfo(ctx.s, f.name);
    const inputCode = (): string => {
      const code = `$v.${fi.raw ? fi.raw.java : fi.java}`;
      // A field with different types in different branches: this branch's type.
      if (!fi.raw && fi.type === this.model.lang("Object"))
        return this.x.unbox(code, vt, true).code;
      return code;
    };
    const override = this.st.overrides.get(f.name);
    let value: string;
    let cls: DeriveClass = "value";
    if (override) value = override;
    else if (f.input === "required" && !f.hidden) {
      value =
        f.derive && usesIt(f.derive)
          ? this.x.to(this.fieldRef(f.name, vt, fctx), vt, ectx)
          : inputCode();
    } else if (f.derive) {
      cls = this.fieldClass(ctx.s, f.name);
      if (f.input === "optional" && cls !== "value") {
        // Use the input when given, else compute after layout.
        c.block(`if ($v.${fi.java} != null)`, () =>
          this.emitFieldValue(f, this.unboxed(inputCode(), vt, fi.boxed), fctx, L, ext, "value")
        );
        c.block("else", () => {
          const d = this.expr(f.derive!, fctx);
          this.emitFieldValue(f, this.x.to(d, vt, ectx), fctx, L, ext, cls);
        });
        return;
      }
      value = this.x.to(this.fieldRef(f.name, vt, fctx), vt, ectx);
    } else value = inputCode();
    this.emitFieldValue(f, value, fctx, L, ext, cls);
  }

  /**
   * A virtual field writes no bytes: its value comes from the input (or its default), the fields
   * it is read from derive from it, and reading it back from them must give the value (DERIVE
   * otherwise).
   */
  private emitVirtual(f: IrField, read: IrExpr, ctx: WCtx): void {
    const c = this.code;
    const vt = this.model.valueTypeOf(f.type);
    const ectx = this.exprCtx(ctx);
    const fi = this.model.fieldInfo(ctx.s, f.name);
    const value =
      f.input === "optional" && f.derive
        ? this.x.to(this.fieldRef(f.name, vt, ctx), vt, ectx)
        : this.unboxed(`$v.${fi.java}`, vt, fi.boxed);
    const tmp = c.fresh("$val");
    c.line(`final ${this.model.javaValueType(vt)} ${tmp} = ${value};`);
    this.emitWriteChecks(
      f.checks.filter(ch => !ch.strictOnly),
      tmp,
      vt,
      ctx,
      "CHECK"
    );
    const back = this.x.to(this.expr(read, { ...ctx, deferred: true }), vt, ectx);
    const check = `${this.use("Rt")}.checkVirtual(${tmp}, ${back}, ${str(f.name)})`;
    if (this.deriveClass(ctx.s, read) === "value") c.line(`${check};`);
    else c.line(`$w.deferCheck(() -> ${check}, 0);`);
  }

  private unboxed(code: string, vt: IrValueType, boxed: boolean): string {
    return boxed ? `${code}.${this.model.javaValueType(vt, false)}Value()` : code;
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
    // Derived values are checked when computed (DERIVE), inputs before writing (CHECK).
    // Constants are correct by construction and one-way transforms write their raw value: their
    // checks only matter on read.
    const oneWay = isOneWay(f.type);
    const checks =
      f.deriveKind === "constant" || oneWay ? [] : f.checks.filter(ch => !ch.strictOnly);
    const vt = this.model.valueTypeOf(oneWay ? oneWayInner(f.type) : f.type);
    let v = value;
    if (!deferred && (checks.length || f.placement || /[^A-Za-z0-9_$.]/.test(value))) {
      v = c.fresh("$val");
      c.line(`final ${this.model.javaValueType(vt)} ${v} = ${value};`);
      this.emitWriteChecks(checks, v, vt, ctx, f.input !== "absent" ? "CHECK" : "DERIVE");
    }
    if (f.placement) {
      this.emitPlaced(f, v, ctx, L, ext);
      return;
    }
    if (ext) c.line(`$w.start(${ext});`);
    const entry = deferred
      ? this.writeDeferred(f.type, value, { ...ctx, extent: ext }, cls, checks)
      : this.write(f.type, v, { ...ctx, extent: ext });
    if (ext) c.line(`$w.close(${ext});`);
    if (entry && L) c.line(`${L}.set(${str(f.name)}, ${entry});`);
  }

  /** An `at` field: a placeable, and (when its offset can move) a check that the offset holds. */
  private emitPlaced(
    f: IrField,
    v: string,
    ctx: WCtx,
    L: string | undefined,
    ext: string | undefined
  ): void {
    const c = this.code;
    const placement = f.placement!;
    const P = c.fresh("$P");
    const Pl = this.use("Placeable");
    let opts = "null";
    if (placement.fixed) opts = `${Pl}.PlaceOptions.fixedAt(${this.num(placement.offset, ctx)})`;
    else if (placement.constraint) {
      const { modulus, remainder } = placement.constraint;
      opts = `${Pl}.PlaceOptions.constraint(${longLit(BigInt(modulus))}, ${longLit(BigInt(remainder))})`;
    }
    const body = this.entryClosure(() => this.write(f.type, v, { ...ctx, extent: ext }));
    c.line(`final ${Pl} ${P} = $w.place(${str(f.name)}, ${v}, () -> ${body}, ${opts}, $v);`);
    if (ext) c.line(`$w.bindExtent(${ext}, ${P}, ${placement.emptyIsNull === true});`);
    if (L) c.line(`${L}.set(${str(f.name)}, ${P});`);
    if (placement.fixed) return;
    const dctx = { ...ctx, deferred: true };
    const off = this.expr(placement.offset, dctx);
    if (off.code === `(long) ${extVar(f.name)}.pos()`) return;
    c.line(
      `$w.deferCheck(() -> ${this.use("Rt")}.checkPlacement(${this.x.asLong(off, this.exprCtx(dctx))}, ${P}, ${str(f.name)}), 0);`
    );
  }

  /** `throw new YaffleException(code, message);` (`message`: Java code of a string). */
  private fail(code: string, message: string): string {
    return `throw new ${this.use("YaffleException")}(${this.use("ErrorCode")}.${code}, ${message});`;
  }

  /** `if (!check) throw …` lines. */
  private checkLines(
    checks: readonly IrCheck[],
    value: string,
    vt: IrValueType,
    ctx: WCtx,
    code: "CHECK" | "DERIVE"
  ): string[] {
    return checks.map(ch => {
      const cond = this.expr(ch.expr, { ...ctx, it: { code: value, type: vt } }).code;
      return `if (!${wrap(cond)}) ${this.fail(code, str(`check failed: ${ch.message}`))}`;
    });
  }

  private emitWriteChecks(
    checks: readonly IrCheck[],
    value: string,
    vt: IrValueType,
    ctx: WCtx,
    code: "CHECK" | "DERIVE"
  ): void {
    // `$end` is unknown while writing: such checks only apply on read.
    const now = checks.filter(
      ch => !exprHas(ch.expr, e => e.kind === "builtinValue" && e.name === "end")
    );
    for (const l of this.checkLines(now, value, vt, ctx, code)) this.code.line(l);
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
    const vt = this.model.valueTypeOf(t);
    const P = this.use("Prim");
    /** A Supplier<Object> lambda computing `raw` (the field's Java value), after the checks. */
    const compute = (raw: string, rawType: IrValueType): string => {
      const norm = (code: string): string =>
        this.x.reprOf(rawType) === "u64" ? `${this.use("Ints")}.u64(${code})` : code;
      if (!checks.length) return `() -> ${norm(raw)}`;
      const body = new Code();
      body.line("() -> {");
      body.indent(() => {
        body.line(`final ${this.model.javaValueType(rawType)} $it = ${raw};`);
        for (const l of this.checkLines(checks, "$it", vt, { ...ctx, deferred: true }, "DERIVE")) {
          body.line(l);
        }
        body.line(`return ${norm("$it")};`);
      });
      body.line("}");
      return body.toString();
    };
    const leaf = (tt: IrType, raw: string, rawType: IrValueType, lctx: WCtx): string | null => {
      const c = this.code;
      switch (tt.kind) {
        case "prim":
          c.line(
            `$w.deferPrim(${P}.${tt.prim.toUpperCase()}, ${this.leOf(tt.endian, lctx)}, ${compute(raw, rawType)}, ${phase});`
          );
          return null;
        case "bool":
          c.line(`$w.deferPrim(${P}.U8, true, ${compute(raw, rawType)}, ${phase});`);
          return null;
        case "enum": {
          const storage = this.model.enum(tt.enum).storage.toUpperCase();
          const v = compute(`${wrap(raw)}.value()`, { kind: "int", bits: 64, signed: true });
          c.line(`$w.deferPrim(${P}.${storage}, ${this.leOf(tt.endian, lctx)}, ${v}, ${phase});`);
          return null;
        }
        case "transform": {
          if (!tt.write) return leaf(tt.inner, raw, rawType, lctx);
          const innerVt = this.model.valueTypeOf(tt.inner);
          const w = this.expr(tt.write, {
            ...lctx,
            deferred: true,
            it: { code: `(${raw})`, type: tt.valueType }
          });
          return leaf(tt.inner, this.x.to(w, innerVt, this.exprCtx(lctx)), innerVt, lctx);
        }
        case "layered":
          return this.emitLayers(
            tt.layers,
            tt.layers.length - 1,
            lctx,
            inner => leaf(tt.inner, raw, rawType, inner),
            lctx.slot,
            lctx.extent
          );
        case "bytes":
        case "string": {
          const n = this.model.staticSize(tt);
          if (n === undefined) break;
          const conv =
            tt.kind === "string"
              ? `${this.use("Rt")}.encodeFixedString(${raw}, ${n}, ${tt.unit}, ${this.use("Encoding")}.${tt.encoding.toUpperCase()}, ${this.leOf(tt.endian, lctx)})`
              : raw;
          c.line(`$w.deferBytes(${n}, ${compute(conv, { kind: "bytes" })}, ${phase});`);
          return null;
        }
      }
      throw new Error(`cannot write a deferred derived value of type ${tt.kind}`);
    };
    // Booleans are stored as 0/1.
    if (unlayer(t).kind === "bool") {
      return leaf(t, `(${value} ? 1 : 0)`, { kind: "int", bits: 8, signed: false }, ctx);
    }
    return leaf(t, value, vt, ctx);
  }

  /** A lambda body: what `f` emits, then it returns `f`'s layout entry (or null). */
  private entryClosure(f: () => string | null): string {
    return this.closure(() => f() ?? "null", true);
  }

  // ── types ───────────────────────────────────────────────────────────────────

  /**
   * Emits the write of `value` (Java code of the type's Java representation) with type `t`;
   * returns code of the produced layout entry, or null.
   */
  write(t: IrType, value: string, ctx: WCtx): string | null {
    if (!this.model.isRefTarget(t)) return this.writeInner(t, value, ctx);
    const s = this.code.fresh("$rs");
    this.code.line(`final int ${s} = $w.offset();`);
    const e = this.writeInner(t, value, ctx);
    this.code.line(`$w.refSite(${str(this.model.typeKey(t))}, ${s}, ${value});`);
    return e;
  }

  private writeInner(t: IrType, value: string, ctx: WCtx): string | null {
    const c = this.code;
    switch (t.kind) {
      case "prim":
        c.line(this.primWrite(t.prim, value, this.leOf(t.endian, ctx)));
        return null;
      case "bool":
        c.line(`$w.bool(${value});`);
        return null;
      case "string": {
        const le = t.unit === 1 ? "true" : this.leOf(t.endian, ctx);
        const enc = `${this.use("Encoding")}.${t.encoding.toUpperCase()}`;
        if (t.length.kind === "count") {
          c.line(
            `$w.strFixed(${value}, ${t.unit}, ${enc}, ${le}, ${this.len(t.length.expr, ctx)});`
          );
        } else if (t.length.kind === "until") {
          c.line(`$w.strUntil(${value}, ${t.unit}, ${enc}, ${le});`);
        } else c.line(`$w.strRest(${value}, ${t.unit}, ${enc}, ${le});`);
        return null;
      }
      case "bytes": {
        if (t.length.kind === "count") {
          const n = this.lengthCheck(t.length.expr, ctx, value, true);
          c.line(n === undefined ? `$w.bytes(${value});` : `$w.bytesN(${value}, ${n});`);
        } else if (t.length.kind === "until") {
          c.line(`$w.bytesUntil(${value}, ${this.num(t.length.terminator, ctx)});`);
        } else c.line(`$w.bytes(${value});`);
        return null;
      }
      case "array":
        return this.array(t, value, ctx);
      case "struct":
        return this.struct(t.struct, t.args, value, ctx);
      case "enum": {
        const storage = this.model.enum(t.enum).storage;
        const v = `${this.use("Rt")}.nonNull(${value}, "an enum member").value()`;
        const le = this.leOf(t.endian, ctx);
        if (storage === "u64") c.line(`$w.u64(${v}, ${le});`);
        else c.line(`$w.prim(${this.use("Prim")}.${storage.toUpperCase()}, ${v}, ${le});`);
        return null;
      }
      case "pointer":
        return this.pointer(t, value, ctx);
      case "extern": {
        const x = this.model.extern(t.extern);
        const args = this.argCodes(x.params, t.args, ctx);
        const fixed = x.kind === "type" && x.fixedSize !== undefined ? x.fixedSize : -1;
        c.line(
          `$w.extern(${this.cls.externObj(t.extern)}, ${value}, new Object[] {${args.join(", ")}}, ${fixed});`
        );
        return null;
      }
      case "union": {
        const un = this.model.unionOfT(t);
        const u = c.fresh("$u");
        const l = c.fresh("$l");
        const hasL = this.model.hasPlaceables(t);
        c.line(`final ${un.name} ${u} = ${this.use("Rt")}.nonNull(${value}, "a union value");`);
        if (hasL) c.line(`${this.use("LEntry")} ${l} = null;`);
        c.block(`switch (${u})`, () => {
          t.variants.forEach((vr, i) => {
            const pv = c.fresh("$uv");
            c.block(`case ${un.name}.${un.variants[i]!.java} ${pv} ->`, () => {
              const e = this.write(vr.type, `${pv}.value()`, ctx);
              if (e && hasL) c.line(`${l} = ${e};`);
            });
          });
        });
        return hasL ? l : null;
      }
      case "transform":
        return t.write ? this.transform(t, value, ctx) : this.write(t.inner, value, ctx);
      case "layered":
        return this.emitLayers(
          t.layers,
          t.layers.length - 1,
          { ...ctx, reuse: value },
          inner => this.write(t.inner, value, inner),
          ctx.slot,
          ctx.extent
        );
    }
  }

  /** A transform with an inverse: the raw value, checked to read back as the value. */
  private transform(
    t: Extract<IrType, { kind: "transform" }>,
    value: string,
    ctx: WCtx
  ): string | null {
    const c = this.code;
    const ectx = this.exprCtx(ctx);
    const val = c.fresh("$tv");
    c.line(`final ${this.model.javaValueType(t.valueType)} ${val} = ${value};`);
    const raw = c.fresh("$raw");
    const innerVt = this.model.valueTypeOf(t.inner);
    const w = this.expr(t.write!, { ...ctx, it: { code: val, type: t.valueType } });
    c.line(`final ${this.model.javaValueType(innerVt)} ${raw} = ${this.x.to(w, innerVt, ectx)};`);
    // read(write(v)) must give v back (floats: within half a storage step).
    const back = this.expr(t.read, { ...ctx, it: { code: raw, type: innerVt } });
    const R = this.use("Rt");
    if (t.valueType.kind === "float" && innerVt.kind === "int") {
      const next = this.expr(t.read, {
        ...ctx,
        it: { code: `((long) ${raw} + 1L)`, type: { kind: "int", bits: 64, signed: true } }
      });
      c.line(
        `${R}.checkFloatRoundTrip(${val}, ${this.x.asDouble(back, ectx)}, ${this.x.asDouble(next, ectx)});`
      );
    } else {
      c.line(`${R}.checkRoundTrip(${val}, ${this.x.to(back, t.valueType, ectx)});`);
    }
    return this.write(t.inner, raw, ctx);
  }

  /**
   * The length a count expression gives, for checking the written value. When it depends on
   * sizes or positions (`u8 gap[tOfs - 0x19 - $offset]`), the check runs after layout instead and
   * this returns undefined.
   */
  private lengthCheck(e: IrExpr, ctx: WCtx, value: string, bytes: boolean): string | undefined {
    if (this.deriveClass(ctx.s, e) === "value") return this.len(e, ctx);
    const m = this.code.fresh("$m");
    this.code.line(`final ${this.use("Writer")}.Mark ${m} = $w.mark();`);
    const n = this.len(e, {
      ...ctx,
      deferred: true,
      offsetCode: `${m}.pos()`,
      endCode: `${m}.regionEnd()`
    });
    const size = bytes ? `${value}.length` : `${value}.size()`;
    this.code.line(`$w.deferCheck(() -> ${this.use("Rt")}.checkLength(${size}, ${n}), 0);`);
    return undefined;
  }

  /** A primitive write of `value` (in the prim's Java representation). */
  private primWrite(p: string, value: string, le: string): string {
    switch (p) {
      case "u8":
        return `$w.u8(${value});`;
      case "u64":
      case "f16":
      case "f32":
      case "f64":
        return `$w.${p}(${value}, ${le});`;
      default:
        return `$w.prim(${this.use("Prim")}.${p.toUpperCase()}, ${value}, ${le});`;
    }
  }

  private struct(
    id: string,
    args: readonly IrExpr[],
    value: string,
    ctx: WCtx,
    layers: readonly IrLayer[] = this.outerLayers(this.model.struct(id))
  ): string | null {
    const s = this.model.struct(id);
    const call = (inner: WCtx): string | null => {
      const argCode = this.argCodes(s.params, args, inner);
      const callExpr = `${this.model.className(id)}.write(${["$w", value, ...argCode].join(", ")})`;
      if (!this.returnsL(s)) {
        this.code.line(`${callExpr};`);
        return null;
      }
      const l = this.code.fresh("$l");
      this.code.line(`final ${this.use("LStruct")} ${l} = ${callExpr};`);
      return l;
    };
    if (!layers.length) return call(ctx);
    return this.emitLayers(
      layers,
      layers.length - 1,
      { ...ctx, reuse: value },
      call,
      `${ctx.slot}#${s.name}`,
      undefined
    );
  }

  private array(t: ArrayType, value: string, ctx: WCtx): string | null {
    const c = this.code;
    const depth = ctx.depth;
    this.st.maxDepth = Math.max(this.st.maxDepth, depth + 1);
    const a = c.fresh("$a");
    const k = c.fresh("$k");
    const i = c.fresh("$i");
    const R = this.use("Rt");
    c.line(
      `final ${this.use("List")}<${this.model.javaType(t.element, true)}> ${a} = ${R}.nonNull(${value}, "an array");`
    );
    if (t.length.kind === "count") {
      const n = this.lengthCheck(t.length.expr, ctx, a, false);
      if (n !== undefined) c.line(`${R}.checkLength(${a}.size(), ${n});`);
    }
    const la = this.model.hasPlaceables(t) ? c.fresh("$la") : undefined;
    if (la) c.line(`final ${this.use("LArray")} ${la} = new ${this.use("LArray")}();`);
    const saved = this.elementUsesIndex(t.element) ? c.fresh("$ix") : undefined;
    if (saved) c.line(`final int ${saved} = $w.index;`);
    const ectx: WCtx = { ...ctx, index: `(long) ${i}`, depth: depth + 1, extent: undefined };
    const evt = this.model.valueTypeOf(t.element);
    const term =
      t.length.kind === "until" || t.length.kind === "before"
        ? this.expr(t.length.terminator, ctx)
        : undefined;
    const pred = t.length.kind === "untilPredicate" ? t.length.predicate : undefined;
    const ectxE = this.exprCtx(ctx);
    c.block(`for (int ${k} = 0; ${k} < ${a}.size(); ${k}++)`, () => {
      c.line(`final int ${i} = ${k};`);
      c.line(`$fr.i[${depth}] = ${i};`);
      if (saved) c.line(`$w.index = ${i};`);
      const el = c.fresh("$el");
      const prim = this.model.javaType(t.element, false);
      if (evt.kind === "nullable") c.line(`final ${prim} ${el} = ${a}.get(${i});`);
      else c.line(`final ${prim} ${el} = ${R}.nonNull(${a}.get(${i}), "an array element");`);
      if (term) {
        const eq = this.x.equality("==", this.x.typed(el, evt), term, ectxE);
        c.line(
          `if (${stripParens(eq)}) ${this.fail("INPUT", `"an element equals the terminator"`)}`
        );
      }
      if (pred) {
        // `until <predicate>`: only the last element may satisfy it (and it must).
        const cond = this.expr(pred, { ...ctx, it: { code: el, type: evt } }).code;
        c.line(
          `if ((${cond}) != (${i} == ${a}.size() - 1)) ${this.fail("CHECK", `"until: only the last element may (and must) end the array"`)}`
        );
      }
      if (t.elementPlacement) {
        const off = this.num(t.elementPlacement, ectx);
        const body = this.entryClosure(() => this.write(t.element, el, ectx));
        const P = c.fresh("$P");
        const Pl = this.use("Placeable");
        c.line(
          `final ${Pl} ${P} = $w.place(${str(`${ctx.fieldName}[]`)}, ${el}, () -> ${body}, ${Pl}.PlaceOptions.fixedAt(${off}), null);`
        );
        if (la) c.line(`${la}.push(${P});`);
      } else {
        const e = this.write(t.element, el, ectx);
        if (la) c.line(`${la}.push(${e ?? "null"});`);
      }
    });
    if (pred) {
      c.line(
        `if (${a}.isEmpty()) ${this.fail("CHECK", `"until: the array needs an element that ends it"`)}`
      );
    }
    if (term && t.length.kind === "until") {
      c.line(`$fr.i[${depth}] = ${a}.size();`);
      if (saved) c.line(`$w.index = ${a}.size();`);
      const tv = c.fresh("$term");
      c.line(`final ${this.model.javaValueType(evt)} ${tv} = ${this.x.to(term, evt, ectxE)};`);
      const e = this.write(t.element, tv, { ...ectx, index: `(long) ${a}.size()` });
      if (la && e) c.line(`${la}.push(${e});`);
    }
    if (saved) c.line(`$w.index = ${saved};`);
    c.line(`$fr.i[${depth}] = -1;`);
    return la ?? null;
  }

  private pointer(
    t: Extract<IrType, { kind: "pointer" }>,
    value: string,
    ctx: WCtx
  ): string | null {
    const c = this.code;
    const tv = c.fresh("$tv");
    const targetJ = this.model.javaType(t.target, t.nullValue !== undefined && !t.emptyIsNull);
    c.line(`final ${targetJ} ${tv} = ${value};`);
    const nv = t.nullValue !== undefined ? longLit(BigInt.asIntN(64, BigInt(t.nullValue))) : "null";
    const le = this.leOf(t.storageEndian, ctx);
    const tctx: WCtx = { ...ctx, extent: undefined };
    // `@nullable(empty)`: an empty array is written as the null value (no target).
    const isNull = t.emptyIsNull
      ? `${this.use("Rt")}.isEmpty(${tv})`
      : isPrimitive(targetJ)
        ? undefined
        : `${tv} == null`;
    const orNull = (v: string): string => (isNull ? `${isNull} ? null : ${v}` : v);
    // `@origin(expr)`: the stored value is relative to base + origin (computed after layout).
    const dctx = { ...ctx, deferred: true };
    const origin = t.origin
      ? `() -> ${this.x.asLong(this.expr(t.origin, dctx), this.exprCtx(dctx))}`
      : "null";
    const kind = `${this.use("Prim")}.${t.storage.toUpperCase()}`;
    // A nullable boxed target is written as its primitive.
    const prim = this.model.javaType(t.target, false);
    const typedTv = prim !== targetJ && isPrimitive(prim) ? `${tv}.${prim}Value()` : tv;
    const key = str(this.model.typeKey(t.target));
    if (t.ownership === "ref") {
      const body = this.entryClosure(() => this.write(t.target, typedTv, tctx));
      c.line(
        `$w.refPointer(${kind}, ${le}, ${key}, ${orNull(tv)}, () -> $w.encodeAlone(() -> ${body}), ${t.relative}, ${nv}, ${origin});`
      );
      return null;
    }
    const P = c.fresh("$P");
    const body = this.entryClosure(() => this.write(t.target, typedTv, tctx));
    const owner = ctx.depth === 0 ? "$v" : "null";
    const target = `$w.target(${tv}, ${key}, ${str(ctx.fieldName)}, () -> ${body}, null, ${owner})`;
    c.line(`final ${this.use("Placeable")} ${P} = ${orNull(target)};`);
    c.line(`$w.pointer(${kind}, ${le}, ${P}, ${t.relative}, ${nv}, ${origin});`);
    return P;
  }

  // ── bits ────────────────────────────────────────────────────────────────────

  emitBits(b: IrBits, ctx: WCtx): void {
    const c = this.code;
    const u = c.fresh("$u");
    c.line(`long ${u} = 0;`);
    for (const f of b.fields) {
      if (f.name === null) continue;
      c.line(`$fr.f = ${str(f.name)};`);
      const bits = this.bitsOf(f, this.bitFieldValue(f, ctx), ctx);
      c.line(f.shift ? `${u} |= ${bits} << ${f.shift};` : `${u} |= ${bits};`);
    }
    const size = primSize(b.storage);
    const le = this.leOf(b.endian, ctx);
    if (size === 8) c.line(`$w.u64(${u}, ${le});`);
    else if (size === 1) c.line(`$w.u8(${u});`);
    else c.line(`$w.prim(${this.use("Prim")}.U${size * 8}, ${u}, ${le});`);
  }

  private bitFieldValue(f: IrBitField, ctx: WCtx): string {
    const vt = this.model.valueTypeOf(f.type);
    const v =
      f.input !== "required" && f.derive
        ? this.x.to(this.fieldRef(f.name!, vt, ctx), vt, this.exprCtx(ctx))
        : this.inputExpr(ctx.s, f.name!, vt).code;
    const checks = f.checks.filter(ch => !ch.strictOnly);
    if (!checks.length) return v;
    const tmp = this.code.fresh("$val");
    this.code.line(`final ${this.model.javaValueType(vt)} ${tmp} = ${v};`);
    this.emitWriteChecks(checks, tmp, vt, ctx, f.input === "absent" ? "DERIVE" : "CHECK");
    return tmp;
  }

  private bitsOf(f: IrBitField, value: string, ctx: WCtx): string {
    let t = f.type;
    if (t.kind === "layered") t = t.inner;
    if (t.kind === "transform" && t.write) {
      const innerVt = this.model.valueTypeOf(t.inner);
      const w = this.expr(t.write, { ...ctx, it: { code: value, type: t.valueType } });
      return this.bitsOfType(t.inner, this.x.to(w, innerVt, this.exprCtx(ctx)), f.width);
    }
    if (t.kind === "transform") t = t.inner;
    return this.bitsOfType(t, value, f.width);
  }

  private bitsOfType(t: IrType, value: string, width: number): string {
    const R = this.use("Rt");
    if (t.kind === "bool") return `(${value} ? 1L : 0L)`;
    if (t.kind === "enum") {
      return `${R}.bitsOf(${R}.nonNull(${value}, "an enum member").value(), ${width}, false)`;
    }
    if (t.kind === "prim" && t.prim === "u64") return `${R}.bitsOfU64(${value}, ${width})`;
    const signed = t.kind === "prim" && t.prim[0] === "i";
    return `${R}.bitsOf(${value}, ${width}, ${signed})`;
  }

  // ── layers ──────────────────────────────────────────────────────────────────

  emitLayers(
    layers: readonly IrLayer[],
    idx: number,
    ctx: WCtx,
    inner: (ctx: WCtx) => string | null,
    slot: string,
    extent: string | undefined
  ): string | null {
    if (idx < 0) return inner(ctx);
    const l = layers[idx]!;
    const c = this.code;
    const recordStage = (k: number, sizeExpr: string): void => {
      if (extent) c.line(`${extent}.stage(${k}, ${sizeExpr});`);
    };
    const next = (x: WCtx): string | null => {
      const s = extent ? c.fresh("$so") : undefined;
      if (s) c.line(`final int ${s} = $w.offset();`);
      const e = this.emitLayers(layers, idx - 1, x, inner, slot, extent);
      if (s) recordStage(idx, `$w.offset() - ${s}`);
      return e;
    };
    switch (l.kind) {
      case "align":
        c.line(this.alignWrite(l, ctx));
        return next(ctx);
      case "padBefore":
        c.line(`$w.pad(${this.num(l.count, ctx)}, ${this.fill(l.fill, ctx)});`);
        return next(ctx);
      case "padAfter": {
        const e = next(ctx);
        c.line(`$w.pad(${this.num(l.count, ctx)}, ${this.fill(l.fill, ctx)});`);
        return e;
      }
      case "padUntil": {
        const s = c.fresh("$s");
        c.line(`final int ${s} = $w.offset();`);
        const e = next(ctx);
        c.line(`$w.padUntil(${s}, ${this.num(l.size, ctx)}, ${this.fill(l.fill, ctx)});`);
        return e;
      }
      case "alignEnd": {
        const e = next(ctx);
        c.line(this.alignWrite(l, ctx));
        return e;
      }
      case "size": {
        const s = c.fresh("$s");
        c.line(`final int ${s} = $w.offset();`);
        const e = next(ctx);
        c.line(`$w.sizeWindow(${s}, ${this.num(l.size, ctx)});`);
        return e;
      }
      case "via": {
        const codec = this.model.codec(l.codec);
        const args = this.argCodes(codec.params, l.args, ctx);
        const plain = c.fresh("$plain");
        const body = this.entryClosure(() => {
          this.emitLayers(layers, idx - 1, ctx, inner, slot, extent);
          return null;
        });
        c.line(`final byte[] ${plain} = $w.subRegion(() -> ${body});`);
        recordStage(idx, `${plain}.length`);
        if (extent) c.line(`${extent}.plain(${plain});`);
        // The decoded size, when an inner `@size` gives it.
        let outSize = "-1";
        for (let k = idx - 1; k >= 0; k--) {
          const kind = layers[k]!.kind;
          if (kind === "via") break;
          if (kind === "size") {
            outSize = `${plain}.length`;
            break;
          }
        }
        const cc = `new ${this.use("CodecCtx")}(new Object[] {${args.join(", ")}}, ${outSize}, 0)`;
        const Cs = this.use("Codecs");
        const reuse = c.fresh("$reuse");
        c.line(
          `final byte[] ${reuse} = ${Cs}.reuse(${ctx.reuse ?? "null"}, ${str(`${slot}#${idx}`)}, ${plain});`
        );
        c.line(
          `$w.raw(${reuse} != null ? ${reuse} : ${Cs}.encode(${this.cls.externObj(l.codec)}, ${str(codec.name)}, ${plain}, ${cc}));`
        );
        return null;
      }
      case "endian": {
        const e = c.fresh("$e");
        const le = c.fresh("$le");
        const E = this.use("Endian");
        c.line(`final ${E} ${e} = ${this.expr(l.value, ctx).code};`);
        c.line(`final boolean ${le} = ${e} == ${E}.LE;`);
        return next({ ...ctx, endian: e, le });
      }
      case "strict":
        return next(ctx);
    }
  }

  /** An `align`/`alignEnd` write: from the base, or from the byte space and/or with an offset. */
  private alignWrite(l: Extract<IrLayer, { kind: "align" | "alignEnd" }>, ctx: WCtx): string {
    const fill = this.fill(l.fill, ctx);
    if (l.from !== "file" && !l.offset) return `$w.align(${this.num(l.to, ctx)}, ${fill});`;
    const off = l.offset ? this.num(l.offset, ctx) : "0L";
    return `$w.alignAt(${this.num(l.to, ctx)}, ${fill}, ${l.from === "file"}, ${off});`;
  }

  /** `$w.regionAlignEnd` for a base's (or root's) `@alignEnd`. */
  private regionAlignEnd(l: Extract<IrLayer, { kind: "alignEnd" }>, ctx: WCtx): string {
    if (l.from !== "file" && !l.offset) return `$w.regionAlignEnd(${this.num(l.to, ctx)});`;
    const off = l.offset ? this.num(l.offset, ctx) : "0L";
    return `$w.regionAlignEnd(${this.num(l.to, ctx)}, ${l.from === "file"}, ${off});`;
  }

  // ── streams ─────────────────────────────────────────────────────────────────

  /**
   * `from` fields: encode the value, then hand the bytes to the stream's source fields (they are
   * written with these overrides).
   */
  private emitStreamPrepass(s: IrStruct, ctx: WCtx): void {
    const c = this.code;
    /** Slice carriers: carrier field → its slices' bounds and encodings. */
    const carriers = new Map<string, { start: string; end: string; bytes: string }[]>();
    for (const f of this.model.fields(s)) {
      const fld = f.field;
      if (!fld?.from) continue;
      const st = fld.from.stream;
      let carrier: string | undefined;
      if (st.kind === "slice") {
        const src = st.stream;
        const cf = src.kind === "field" ? this.model.field(s, src.field)?.field : undefined;
        // A slice of a field that isn't a carrier is read-only: that field carries the bytes.
        if (cf?.carrier !== "slices") continue;
        carrier = cf.name;
      }
      const enc = c.fresh("$stream");
      const fi = this.model.fieldInfo(s, fld.name);
      const body = this.entryClosure(() =>
        this.write(fld.type, `$v.${fi.java}`, { ...ctx, fieldName: fld.name })
      );
      c.line(`$fr.f = ${str(fld.name)};`);
      c.line(`final byte[] ${enc} = $w.subRegion(() -> ${body});`);
      if (carrier !== undefined && st.kind === "slice") {
        const start = this.num(st.start, ctx);
        const slice = { start, end: st.end ? this.num(st.end, ctx) : "-1L", bytes: enc };
        carriers.set(carrier, [...(carriers.get(carrier) ?? []), slice]);
        continue;
      }
      this.streamTargets(st, enc, s, ctx, fld.from.split?.policy);
    }
    for (const [name, slices] of carriers) {
      const t = unlayer(this.model.field(s, name)!.field!.type);
      let len = "-1L";
      if (t.kind === "bytes" && t.length.kind === "count") {
        const lit = literalInt(t.length.expr);
        if (lit !== undefined) len = `${lit}L`;
        else if (this.lengthIsInput(s, t.length.expr)) len = this.num(t.length.expr, ctx);
      }
      const v = c.fresh("$carrier");
      const list = (k: "start" | "end" | "bytes"): string => slices.map(x => x[k]).join(", ");
      c.line(`$fr.f = ${str(name)};`);
      c.line(
        `final byte[] ${v} = ${this.use("Streams")}.assembleSlices(${len}, new long[] {${list("start")}}, new long[] {${list("end")}}, new byte[][] {${list("bytes")}});`
      );
      this.st.overrides.set(name, v);
    }
  }

  /** True if a length expression only reads input fields and parameters (no derived values). */
  private lengthIsInput(s: IrStruct, e: IrExpr): boolean {
    return !exprHas(e, x => {
      if (x.kind === "field") {
        const f = this.model.field(s, x.name);
        return !f || refInput(f) !== "required";
      }
      return x.kind === "call" || x.kind === "builtinValue";
    });
  }

  private streamTargets(
    st: IrStreamExpr,
    bytes: string,
    s: IrStruct,
    ctx: WCtx,
    policy: string | undefined
  ): void {
    if (st.kind === "field") {
      this.st.overrides.set(st.field, bytes);
      return;
    }
    // Slices of joined pieces: their bytes come from the pieces' own fields (read-only).
    if (st.kind === "slice") return;
    // each: split into the elements' bytes fields, by the pieces' size fields from the input,
    // else by the @split policy (fit: the longest piece whose element fits before the next one).
    const c = this.code;
    const arr = this.model.field(s, st.array)?.field;
    if (!arr) throw new Error(`unknown stream array ${st.array}`);
    const el = unlayer(arr.type);
    if (el.kind !== "array") throw new Error(`${st.array} is not an array`);
    const et = unlayer(el.element);
    if (et.kind !== "struct") throw new Error(`${st.array} elements are not structs`);
    const es = this.model.struct(et.struct);
    const E = this.model.className(es.id);
    const piece = this.model.field(es, st.field)?.field;
    const sizeField = piece ? innerSizeField(piece.type) : undefined;
    const pieceJ = this.model.fieldInfo(es, st.field).java;
    const sizeFi = sizeField ? this.model.fieldInfo(es, sizeField) : undefined;
    const local = c.fresh("$els");
    const S = this.use("Streams");
    const Long = this.model.lang("Long");
    let size = "null";
    if (sizeFi?.boxed) {
      size = `$pe.${sizeFi.java} == null ? null : ${Long}.valueOf($pe.${sizeFi.java}.longValue())`;
    } else if (sizeFi) size = `${Long}.valueOf($pe.${sizeFi.java})`;
    const pieces = new Code();
    pieces.line(`new ${S}.Pieces<${E}>() {`);
    pieces.indent(() => {
      pieces.line("@Override");
      pieces.block(`public byte[] piece(${E} $pe)`, () => pieces.line(`return $pe.${pieceJ};`));
      pieces.line("@Override");
      pieces.block(`public ${Long} size(${E} $pe)`, () => pieces.line(`return ${size};`));
      pieces.line("@Override");
      pieces.block(`public boolean hasSizeField()`, () =>
        pieces.line(`return ${sizeFi !== undefined};`)
      );
      pieces.line("@Override");
      pieces.block(`public ${E} with(${E} $pe, byte[] $piece, boolean $clear)`, () => {
        pieces.line(`final ${E} $c = $pe == null ? new ${E}() : $pe.copy();`);
        pieces.line(`$c.${pieceJ} = $piece;`);
        if (sizeFi?.nullable) pieces.line(`if ($clear) $c.${sizeFi.java} = null;`);
        pieces.line("return $c;");
      });
    });
    pieces.line("}");
    let fit = "null";
    if (policy === "fit" && el.elementPlacement) {
      const kk = c.fresh("$kk");
      const off = this.num(el.elementPlacement, { ...ctx, index: `(long) ${kk}` });
      const ee = c.fresh("$ee");
      const call = this.entryClosure(() =>
        this.write(el.element, ee, { ...ctx, index: "-1L", fieldName: st.array })
      );
      fit = `new ${S}.Fit<${E}>(${kk} -> ${this.use("Ints")}.toInt(${off}), ${ee} -> $w.encodeAlone(() -> ${call}).length)`;
    }
    const arrFi = this.model.fieldInfo(s, st.array);
    c.line(
      `final ${this.use("List")}<${E}> ${local} = ${S}.splitStream($v.${arrFi.java}, ${bytes}, ${pieces.toString()}, ${fit});`
    );
    this.st.overrides.set(st.array, local);
  }
}

/** The raw (inner) type of a one-way transform field. */
function oneWayInner(t: IrType): IrType {
  const u = unlayer(t);
  return u.kind === "transform" ? u.inner : u;
}

function findBits(ms: readonly IrMember[], name: string): IrBits | undefined {
  let found: IrBits | undefined;
  forEachMember(ms, m => {
    if (!found && m.kind === "bits" && m.fields.some(b => b.name === name)) found = m;
  });
  return found;
}

function extVar(f: string): string {
  return f === "this" ? "$x_this" : `$x_${f.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

/** The field a piece's size comes from: its count, or the size of its innermost `@size` window. */
function innerSizeField(t: IrType): string | undefined {
  const fieldOf = (e: IrExpr): string | undefined => {
    while (e.kind === "convert") e = e.operand;
    return e.kind === "field" ? e.name : undefined;
  };
  if (t.kind === "bytes") return t.length.kind === "count" ? fieldOf(t.length.expr) : undefined;
  if (t.kind !== "layered") return undefined;
  for (const l of t.layers) {
    if (l.kind === "via") return undefined;
    if (l.kind === "size") return fieldOf(l.size);
  }
  return undefined;
}

/** Layout items as a Java array initializer; `n` gives the code of a layer argument (a long). */
export function layoutLiteral(
  items: readonly IrLayoutItem[],
  LI: string,
  n: (e: IrExpr) => string
): string {
  const item = (it: IrLayoutItem): string => {
    const path =
      it.path === "this"
        ? "null"
        : `new String[] {${it.path.map(seg => (seg.kind === "each" ? `"*"` : str(seg.name))).join(", ")}}`;
    const layers = it.layers.flatMap(l => {
      switch (l.kind) {
        case "align":
          if (l.from !== "file" && !l.offset) return [`${LI}.align(${n(l.to)})`];
          return [
            `${LI}.alignAt(${n(l.to)}, ${l.offset ? n(l.offset) : "0"}, ${l.from === "file"})`
          ];
        case "alignEnd":
          return [`${LI}.alignEnd(${n(l.to)})`];
        case "padBefore":
          return [`${LI}.padBefore(${n(l.count)})`];
        case "padAfter":
          return [`${LI}.padAfter(${n(l.count)})`];
        default:
          return [];
      }
    });
    if (!it.group) return `${LI}.of(${[path, ...layers].join(", ")})`;
    const sub = layoutLiteral(it.group.items, LI, n);
    return `${LI}.group(${[path, sub, ...layers].join(", ")})`;
  };
  return `new ${LI}[] {${items.map(item).join(", ")}}`;
}
