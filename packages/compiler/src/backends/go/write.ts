/**
 * Writer emitter: one `writeX` function per struct, relocation-style code over yaffle.Writer
 * following docs/IR.md §3 and §4.
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
import { Code, fixUnused, funcLit, goStr, stripParens } from "./code.ts";
import { Emitter, paramList, structCtx, type EmitCtx } from "./emitter.ts";
import { encConst, formatInt, type CExpr, type ExprCtx } from "./expr.ts";
import {
  dynamicLayout,
  innerSizeField,
  leafMembers,
  literalInt,
  patchableType,
  stripLayers,
  usesIndex,
  writeSideExtents
} from "./irutil.ts";
import { containsIt, walkExpr } from "../../ir/walk.ts";
import {
  BackendError,
  isNilable,
  primConst,
  primGo,
  primSize,
  valueTypeOf,
  type GoField
} from "./model.ts";

interface WCtx extends EmitCtx {
  /** Extent variable of the field being written (stage recording). */
  extent?: string | undefined;
  fieldName: string;
  /** Code of the value inside the current layers when it is a struct (codec reuse). */
  reuse?: string | undefined;
  /** Inside an array: targets have no owner field. */
  inArray: boolean;
  /** `$offset` and `$end` in a check that runs after layout. */
  offsetCode?: string | undefined;
  endCode?: string | undefined;
}

/** What a derived value depends on: values only, or sizes, positions or encoded content. */
type DeriveClass = "value" | "size" | "position" | "content";

/** A stream with its slices peeled off: a carrier field or the pieces of an array. */
type RootStream = Exclude<IrStreamExpr, { kind: "slice" }>;

interface StructState {
  /** Fields with extents (sizeof/offsetof/…), in the order of their extent variables. */
  extents: Set<string>;
  /** Extents some expression reads. */
  extentRead: Set<string>;
  /** Derived fields being inlined (cycle detection). */
  inlining: string[];
  /** Fields whose value is given (stream sources: the stream's encoding). */
  overrides: Map<string, CExpr>;
}

function emptyState(): StructState {
  return { extents: new Set(), extentRead: new Set(), inlining: [], overrides: new Map() };
}

function writeCtx(s: IrStruct, index: string, slot: string, fieldName = ""): WCtx {
  return { ...structCtx(s, index, slot), fieldName, inArray: false };
}

export class WriteEmitter extends Emitter<WCtx> {
  private st!: StructState;
  private readonly classMemo = new Map<string, DeriveClass>();

  /**
   * The struct's layout as a package variable, or "nil" (no layout, or one whose item arguments
   * read fields: each instance builds its own, see instanceLayout).
   */
  layoutVar(s: IrStruct): string {
    if (!s.layout || !s.layout.length || dynamicLayout(s.layout)) return "nil";
    return this.mod.hoist(layoutLiteral(s.layout), `layout${this.model.structName(s.id)}`);
  }

  /**
   * The layout of one instance, for a layout whose item arguments read fields: evaluated like
   * computed fields, in the struct's write context once its fields are written, and checked by
   * yaffle.InstanceLayout (an alignment below 1 is RANGE).
   */
  private instanceLayout(s: IrStruct, ctx: WCtx): string {
    const items = layoutLiteral(s.layout!, (e, what) => {
      if (this.deriveClass(s, e) !== "value")
        throw new BackendError(
          "not implemented: layout item arguments that depend on sizes, positions or encodings"
        );
      return this.x.asOffset(this.expr(e, ctx), what);
    });
    return `yaffle.InstanceLayout(${items})`;
  }

  /**
   * The body of a view patch encoder for a scalar field: statements writing the field of `v`
   * (inside yaffle.EncodeWith), or undefined if its encoding depends on sizes, positions or
   * targets (then setting it is structural).
   */
  encoderBody(s: IrStruct, name: string): string | undefined {
    const fr = this.model.field(s, name);
    if (!fr) return undefined;
    const f = fr.field;
    if (f && (f.placement || f.from || f.virtual || f.carrier || !patchableType(f.type)))
      return undefined;
    const savedCode = this.code;
    const savedSt = this.st;
    this.st = emptyState();
    const body = new Code();
    this.code = body;
    const ctx = writeCtx(s, "-1", `${this.model.structName(s.id)}.${name}`, name);
    try {
      body.line(`w.Field(fr, ${goStr(name)})`);
      if (f) {
        const checks = f.deriveKind === "constant" ? [] : f.checks.filter(ch => !ch.strictOnly);
        const val = this.inputValue(this.model.goField(s, name));
        this.emitWriteChecks(
          checks,
          this.x.typed(val, valueTypeOf(this.model, f.type)),
          ctx,
          "CHECK"
        );
        if (this.write(f.type, val, ctx)) return undefined;
      } else {
        const bits = leafMembers(s.members).find(
          (m): m is IrBits => m.kind === "bits" && m.fields.some(b => b.name === name)
        );
        if (!bits) return undefined;
        this.emitBits(bits, ctx);
      }
      if (this.st.extents.size) return undefined;
      return body.toString();
    } catch {
      return undefined;
    } finally {
      this.code = savedCode;
      this.st = savedSt;
    }
  }

  emitStruct(out: Code, s: IrStruct): void {
    const name = this.model.structName(s.id);
    this.st = { ...emptyState(), extents: writeSideExtents(s) };
    const hasL = this.model.membersHavePlaceables(s.members);
    const body = new Code();
    this.code = body;
    const ctx = writeCtx(s, "index", name);
    this.emitStreamPrepass(s, ctx);
    this.emitMembers(s.members, ctx, hasL ? "L" : undefined);
    const returns = this.model.structHasPlaceables(s.id);
    const fn = new Code();
    fn.block(
      `func write${name}(w *yaffle.Writer, v *${name}, ${paramList(this.model, s)})${returns ? " *yaffle.LStruct" : ""}`,
      () => {
        fn.block("if v == nil", () => fn.line(`yaffle.Fail(yaffle.INPUT, "missing value")`));
        fn.declareLe(body.toString());
        if (usesIndex(s, true)) fn.line(`index := w.Index`);
        const emitBody = (): void => {
          fn.line(`fr := w.Enter()`);
          this.emitNeeds(fn, s, s.members, false);
          if (s.base) {
            for (const l of s.layers) if (l.kind === "alignEnd") fn.line(this.alignEnd(l, ctx));
          }
          if (hasL) fn.line(`L := yaffle.NewLStruct(${this.layoutVar(s)})`);
          for (const f of this.st.extents) {
            const xv = this.extentName(f);
            if (f === "this") fn.line(`${xv} := ${s.base ? "w.RegionExtent()" : "w.Extent()"}`);
            else fn.line(`var ${xv} *yaffle.Extent`);
            if (!this.st.extentRead.has(f)) fn.line(`_ = ${xv}`);
          }
          fn.append(body);
          if (this.st.extents.has("this") && !s.base)
            fn.line(`w.Close(${this.extentName("this")})`);
          if (hasL && s.layout && dynamicLayout(s.layout)) {
            // Errors in the arguments report the struct, not its last field.
            fn.line(`w.Field(fr, "")`);
            fn.line(`L.Layout = ${this.instanceLayout(s, ctx)}`);
          }
          fn.line(`w.Leave(fr)`);
        };
        if (s.base) {
          fn.line(`w.Base(${this.layoutVar(s)}, func() yaffle.LEntry {`);
          fn.indent(() => {
            emitBody();
            fn.line(hasL ? "return L" : "return nil");
          });
          fn.line(`}, v)`);
        } else {
          emitBody();
          if (returns) fn.line(hasL ? "return L" : "return nil");
        }
      }
    );
    out.line(fixUnused(fn.toString()));
  }

  /** Emits the write of a root struct (params are locals); returns the layout entry code or null. */
  rootWrite(out: Code, s: IrStruct, value: string): string | null {
    this.st = emptyState();
    this.code = out;
    const ctx = writeCtx(s, "-1", this.model.structName(s.id));
    const args: IrExpr[] = s.params.map(p => ({ kind: "param", name: p.name, type: p.type }));
    // A root's @alignEnd pads the whole output (a @base struct handles its own).
    const ends = s.base ? [] : s.layers.filter(l => l.kind === "alignEnd");
    for (const l of ends) out.line(this.alignEnd(l, ctx));
    const layers = ends.length ? s.layers.filter(l => l.kind !== "alignEnd") : undefined;
    return this.struct(s.id, args, value, ctx, layers);
  }

  /** `yaffle.Need` for each required field of a member list (missing values are INPUT). */
  private emitNeeds(c: Code, s: IrStruct, ms: readonly IrMember[], conditional: boolean): void {
    for (const g of this.requiredFields(s, ms, conditional))
      c.line(`yaffle.Need(w.PS, fr, v.${g.go} == nil, ${goStr(g.name)})`);
  }

  /** Required nilable input fields of the unconditional part of a member list. */
  private requiredFields(s: IrStruct, ms: readonly IrMember[], conditional: boolean): GoField[] {
    const out: GoField[] = [];
    for (const m of ms) {
      if (m.kind === "field") {
        if (m.input !== "required" || m.hidden || m.from || this.st.overrides.has(m.name)) continue;
        const g = this.model.goField(s, m.name);
        if (!isNilable(g.type)) continue;
        // A nullable pointer's nil is null, not missing.
        const t = stripLayers(m.type);
        if (t.kind === "pointer" && t.nullValue !== undefined && !g.ptr) continue;
        if (g.nilAbsent || (!conditional && g.type.startsWith("*"))) out.push(g);
      } else if (m.kind === "bits") {
        for (const b of m.fields) {
          if (b.name === null || b.input !== "required") continue;
          const g = this.model.goField(s, b.name);
          if (g.ptr) out.push(g);
        }
      } else if (m.kind === "block" && !m.condition)
        out.push(...this.requiredFields(s, m.members, conditional));
    }
    return out;
  }

  // ── derive classification ─────────────────────────────────────────────────

  private deriveClass(s: IrStruct, e: IrExpr, seen: string[] = []): DeriveClass {
    let cls: DeriveClass = "value";
    const rank = { value: 0, size: 1, position: 2, content: 3 };
    const bump = (c: DeriveClass): void => {
      if (rank[c] > rank[cls]) cls = c;
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
        const d = f?.field?.derive ?? f?.bit?.derive;
        const input = f?.field?.input ?? f?.bit?.input;
        if (d && input !== "required" && !seen.includes(x.name))
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
      mode: "write",
      field: (name, type) => this.fieldRef(name, type, ctx),
      builtin: name => {
        if (name === "offset") return ctx.offsetCode ?? "w.Position()";
        if (name === "end")
          return ctx.endCode ?? `yaffle.FailInt(yaffle.DERIVE, "$end is not available on write")`;
        return ctx.index;
      },
      sizeof: f => `${this.extentVar(f)}.Size()`,
      offsetof: f => `${this.extentVar(f)}.Pos()`,
      encodedSize: (f, k) => `${this.extentVar(f)}.StageSize(${k})`,
      bytesof: f => `${this.extentVar(f)}.Bytes()`,
      encode: f => `${this.extentVar(f)}.PlainBytes()`
    };
  }

  private extentName(f: string): string {
    const list = [...this.st.extents];
    let i = list.indexOf(f);
    if (i < 0) {
      this.st.extents.add(f);
      i = list.length;
    }
    return `xt${i + 1}`;
  }

  private extentVar(f: string): string {
    this.st.extentRead.add(f);
    return this.extentName(f);
  }

  /** A field reference in the write context: input value, or the inlined derive. */
  private fieldRef(name: string, type: IrValueType, ctx: WCtx): CExpr {
    const override = this.st.overrides.get(name);
    if (override) return override;
    const f = this.model.field(ctx.s, name);
    if (!f) throw new BackendError(`unknown field ${name} in ${ctx.s.name}`);
    const g = this.model.goField(ctx.s, name);
    const input = f.field ? f.field.input : f.bit!.input;
    const derive = f.field ? f.field.derive : f.bit!.derive;
    const inputCode = (): CExpr => this.x.typed(this.inputValue(g), type, !g.ptr);
    if (input === "required" && !f.field?.hidden) {
      if (derive && containsIt(derive))
        return this.x.compile(derive, this.exprCtx({ ...ctx, it: inputCode() }));
      return inputCode();
    }
    if (!derive) return inputCode();
    if (this.st.inlining.includes(name))
      throw new BackendError(`derive cycle through ${name} in ${ctx.s.name}`);
    this.st.inlining.push(name);
    const d = this.x.compile(derive, this.exprCtx({ ...ctx, it: undefined }));
    this.st.inlining.pop();
    if (input === "optional" && g.ptr) {
      const vt = valueTypeOf(this.model, f.field ? f.field.type : f.bit!.type);
      const dv = this.x.to(d, vt, this.exprCtx(ctx), name);
      return this.x.typed(
        `yaffle.Or(v.${g.go}, func() ${g.valueType} { return ${dv} })`,
        vt,
        false
      );
    }
    return d;
  }

  // ── members ───────────────────────────────────────────────────────────────

  private emitMembers(ms: readonly IrMember[], ctx: WCtx, L: string | undefined): void {
    for (const m of ms) {
      if (m.kind === "field") this.emitField(m, ctx, L);
      else if (m.kind === "bits") this.emitBits(m, ctx);
      else if (m.kind === "block") this.emitBlock(m, ctx, L);
      else this.emitSwitch(m, ctx, L);
    }
  }

  /** A branch: its required fields, then its members. */
  private emitBranch(ms: readonly IrMember[], ctx: WCtx, L: string | undefined): void {
    this.emitNeeds(this.code, ctx.s, ms, true);
    this.emitMembers(ms, ctx, L);
  }

  private emitBlock(
    m: Extract<IrMember, { kind: "block" }>,
    ctx: WCtx,
    L: string | undefined
  ): void {
    const c = this.code;
    const body = (): void => {
      this.emitLayers(m.layers, m.layers.length - 1, ctx, `${ctx.slot}.block`, undefined, inner => {
        this.emitMembers(m.members, inner, L);
        return null;
      });
    };
    if (m.condition) {
      const parts: [string, () => void][] = [
        [
          `if ${stripParens(this.expr(m.condition, ctx).code)}`,
          () => {
            this.emitNeeds(c, ctx.s, m.members, true);
            body();
          }
        ]
      ];
      const els = m.else;
      if (els) parts.push(["else", () => this.emitBranch(els, ctx, L)]);
      c.chain(parts);
    } else if (m.layers.length) c.block("", body);
    else this.emitMembers(m.members, ctx, L);
  }

  private emitSwitch(
    m: Extract<IrMember, { kind: "switch" }>,
    ctx: WCtx,
    L: string | undefined
  ): void {
    const c = this.code;
    const d = c.fresh("d");
    const disc = this.expr(m.discriminant, ctx);
    c.line(`${d} := ${disc.code}`);
    const parts: [string, () => void][] = m.cases.map((cs, i) => {
      const conds = cs.values.map(v =>
        stripParens(
          this.x.equality(
            "==",
            { ...disc, code: d },
            this.x.literal(v, this.exprCtx(ctx)),
            this.exprCtx(ctx)
          )
        )
      );
      const cond = conds.length > 1 ? conds.map(x => `(${x})`).join(" || ") : conds[0];
      return [`${i ? "else if" : "if"} ${cond}`, () => this.emitBranch(cs.members, ctx, L)];
    });
    const def = m.default;
    const last = def
      ? () => this.emitBranch(def, ctx, L)
      : () => c.line(`yaffle.Fail(yaffle.CHECK, "no case matches %v", ${d})`);
    if (parts.length) c.chain([...parts, ["else", last]]);
    else last();
  }

  /** The Go value of an input field (dereferenced). */
  private inputValue(g: GoField): string {
    return g.ptr ? `yaffle.Get(v.${g.go}, ${goStr(g.name)})` : `v.${g.go}`;
  }

  /** The value written for a field: input, or derive (immediately or as a fixup). */
  private emitField(f: IrField, ctx: WCtx, L: string | undefined): void {
    const c = this.code;
    if (f.from) return;
    c.line(`w.Field(fr, ${goStr(f.name)})`);
    const g = this.model.goField(ctx.s, f.name);
    const fctx: WCtx = { ...ctx, slot: `${ctx.s.id}.${f.name}`, fieldName: f.name };
    if (f.virtual) {
      this.emitVirtual(f, fctx);
      return;
    }
    const ext = this.st.extents.has(f.name) ? this.extentName(f.name) : undefined;
    const vt = valueTypeOf(this.model, f.type);
    const toVt = (d: CExpr): string => this.x.to(d, vt, this.exprCtx(fctx), f.name);
    let value: string;
    let cls: DeriveClass = "value";
    const override = this.st.overrides.get(f.name);
    if (override) value = override.code;
    else if (f.input === "required" && !f.hidden) {
      if (g.raw) value = g.ptr ? `yaffle.Get(v.${g.raw.go}, ${goStr(f.name)})` : `v.${g.raw.go}`;
      else
        value =
          f.derive && containsIt(f.derive)
            ? toVt(this.fieldRef(f.name, vt, fctx))
            : this.inputValue(g);
    } else if (f.derive) {
      cls = this.fieldClass(ctx.s, f.name);
      if (f.input === "optional" && cls !== "value" && g.ptr) {
        // A given value is written as is; otherwise the derive runs after layout.
        c.chain([
          [
            `if v.${g.go} != nil`,
            () => this.emitFieldValue(f, `(*v.${g.go})`, fctx, L, ext, "value")
          ],
          [
            "else",
            () => this.emitFieldValue(f, toVt(this.expr(f.derive!, fctx)), fctx, L, ext, cls)
          ]
        ]);
        return;
      }
      value = toVt(this.fieldRef(f.name, vt, fctx));
    } else value = this.inputValue(g);
    this.emitFieldValue(f, value, fctx, L, ext, cls);
  }

  /**
   * A virtual field writes no bytes. Its value is the input (or the default); the fields it is
   * read from derive from it, and reading it back from them must give the value again.
   */
  private emitVirtual(f: IrField, ctx: WCtx): void {
    const c = this.code;
    const vt = valueTypeOf(this.model, f.type);
    const value = this.fieldRef(f.name, vt, ctx);
    const tmp = c.fresh("val");
    c.line(`${tmp} := ${this.x.to(value, vt, this.exprCtx(ctx), f.name)}`);
    const checks = f.checks.filter(ch => !ch.strictOnly);
    this.emitWriteChecks(checks, this.x.typed(tmp, vt), ctx, "CHECK");
    const back = this.expr(f.virtual!.read, ctx);
    const eq = this.x.equality("!=", this.x.typed(tmp, vt), back, this.exprCtx(ctx));
    const fail = `yaffle.FailMsg(yaffle.DERIVE, ${goStr(`${f.name} does not read back from the fields it is made of`)})`;
    if (this.deriveClass(ctx.s, f.virtual!.read) === "value") {
      c.block(`if ${stripParens(eq)}`, () => c.line(fail));
    } else {
      c.line(`w.DeferCheck(0, func() {`);
      c.indent(() => c.block(`if ${stripParens(eq)}`, () => c.line(fail)));
      c.line("})");
    }
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
    const checks = f.deriveKind === "constant" ? [] : f.checks.filter(ch => !ch.strictOnly);
    let v = value;
    if (!deferred && (checks.length || !/^[A-Za-z0-9_.()*]+$/.test(value))) {
      v = c.fresh("val");
      c.line(`${v} := ${value}`);
      const vt = valueTypeOf(this.model, f.type);
      this.emitWriteChecks(
        checks,
        this.x.typed(v, vt),
        ctx,
        f.input !== "absent" ? "CHECK" : "DERIVE"
      );
    }
    if (f.placement) {
      this.emitPlaced(f, v, ctx, L, ext);
      return;
    }
    if (ext) c.line(`${ext} = w.Extent()`);
    const entry = deferred
      ? this.writeDeferred(f.type, value, { ...ctx, extent: ext }, cls, checks)
      : this.write(f.type, v, { ...ctx, extent: ext });
    if (ext) c.line(`w.Close(${ext})`);
    if (entry && L) c.line(`${L}.Set(${goStr(f.name)}, ${entry})`);
  }

  /** An `at` field: a placeable at its offset (fixed, or checked against where it lands). */
  private emitPlaced(
    f: IrField,
    v: string,
    ctx: WCtx,
    L: string | undefined,
    ext: string | undefined
  ): void {
    const c = this.code;
    const placement = f.placement!;
    const P = c.fresh("pl");
    const opts: string[] = [];
    if (placement.fixed) opts.push(`Fixed: ${this.num(placement.offset, ctx)}`, "HasFixed: true");
    if (placement.constraint)
      opts.push(
        `Modulus: ${placement.constraint.modulus}`,
        `Remainder: ${placement.constraint.remainder}`
      );
    if (ext) c.line(`${ext} = w.Extent()`);
    const body = this.entryClosure(() => this.write(f.type, v, { ...ctx, extent: ext }));
    c.line(
      `${P} := w.Place(${goStr(f.name)}, ${this.identity(f.type, v)}, ${body}, yaffle.PlaceOpts{${opts.join(", ")}}, v)`
    );
    if (ext) c.line(`w.BindExtent(${ext}, ${P}, ${placement.emptyIsNull === true})`);
    if (L) c.line(`${L}.Set(${goStr(f.name)}, ${P})`);
    if (!placement.fixed) {
      const offCode = this.num(placement.offset, ctx);
      if (!(ext && offCode === `${ext}.Pos()`)) {
        c.line(
          `w.DeferCheck(0, func() { yaffle.CheckPlacement(${offCode}, ${P}, ${goStr(f.name)}) })`
        );
      }
    }
  }

  private emitWriteChecks(
    checks: readonly IrCheck[],
    value: CExpr,
    ctx: WCtx,
    code: "CHECK" | "DERIVE"
  ): void {
    for (const ch of checks) {
      let usesEnd = false;
      walkExpr(ch.expr, e => {
        if (e.kind === "builtinValue" && e.name === "end") usesEnd = true;
      });
      if (!usesEnd) this.emitCheck(this.code, ch, value, ctx, code);
    }
  }

  /** `if !check { fail }` with `it` bound to value. */
  private emitCheck(
    out: Code,
    ch: IrCheck,
    value: CExpr,
    ctx: WCtx,
    code: "CHECK" | "DERIVE"
  ): void {
    const cond = this.expr(ch.expr, { ...ctx, it: value }).code;
    out.block(`if !${wrapP(cond)}`, () =>
      out.line(`yaffle.FailMsg(yaffle.${code}, ${goStr(`check failed: ${ch.message}`)})`)
    );
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
    const vt = valueTypeOf(this.model, t);
    const compute = (raw: string, retType: string): string => {
      if (!checks.length) return `func() ${retType} { return ${raw} }`;
      const body = new Code();
      body.block(`func() ${retType}`, () => {
        body.line(`it := ${raw}`);
        for (const ch of checks) this.emitCheck(body, ch, this.x.typed("it", vt), ctx, "DERIVE");
        body.line("return it");
      });
      return body.toString();
    };
    const leaf = (tt: IrType, raw: string, lctx: WCtx): string | null => {
      const c = this.code;
      switch (tt.kind) {
        case "prim":
        case "enum": {
          const prim = tt.kind === "prim" ? tt.prim : this.model.enum(tt.enum).storage;
          c.line(
            `w.DeferPrim(${primConst(prim)}, ${this.leOf(tt.endian, lctx)}, ${phase}, ${compute(raw, "any")})`
          );
          return null;
        }
        case "bool":
          c.line(`w.DeferPrim(yaffle.U8, true, ${phase}, ${compute(raw, "any")})`);
          return null;
        case "transform": {
          if (!tt.write) return leaf(tt.inner, raw, lctx);
          const w = this.expr(tt.write, {
            ...lctx,
            it: this.x.typed(`(${raw})`, tt.valueType, false)
          });
          const innerVt = valueTypeOf(this.model, tt.inner);
          return leaf(tt.inner, this.x.to(w, innerVt, this.exprCtx(lctx), lctx.fieldName), lctx);
        }
        case "layered":
          return this.emitLayers(
            tt.layers,
            tt.layers.length - 1,
            lctx,
            lctx.slot,
            lctx.extent,
            inner => leaf(tt.inner, raw, inner)
          );
        case "bytes":
        case "string": {
          const n = this.model.staticSize(tt);
          if (n === undefined) break;
          const conv =
            tt.kind === "string"
              ? `yaffle.EncodeFixedString(${raw}, ${n}, ${encConst(tt.encoding)}, ${tt.unit === 1 ? "true" : this.leOf(tt.endian, lctx)})`
              : raw;
          c.line(`w.DeferBytes(${n}, ${phase}, ${compute(conv, "[]byte")})`);
          return null;
        }
      }
      throw new BackendError(`cannot write a deferred derived value of type ${tt.kind}`);
    };
    return leaf(t, value, ctx);
  }

  /** A func literal returning an LEntry around what f emits. */
  private entryClosure(f: () => string | null): string {
    const { inner, value } = this.capture(f);
    const body = new Code();
    body.block("func() yaffle.LEntry", () => {
      body.append(inner);
      body.line(`return ${value ?? "nil"}`);
    });
    return body.toString();
  }

  /** The identity key of a value (struct/union pointers, slices) for target sharing. */
  private identity(t: IrType, value: string): string {
    const g = this.model.goType(t);
    if (g.startsWith("*")) return value;
    if (g.startsWith("[]") && g !== "[]byte") return `yaffle.SliceID(${value})`;
    return "nil";
  }

  // ── types ─────────────────────────────────────────────────────────────────

  /** Emits the write of value with type t; returns code of the produced layout entry, or null. */
  private write(t: IrType, value: string, ctx: WCtx): string | null {
    if (!this.model.isRefTarget(t)) return this.writeInner(t, value, ctx);
    // A possible @ref target: its encoding is registered where it lands.
    const s = this.code.fresh("rs");
    this.code.line(`${s} := w.Offset()`);
    const e = this.writeInner(t, value, ctx);
    this.code.line(`w.RefSite(${goStr(this.model.typeKey(t))}, ${s}, ${this.identity(t, value)})`);
    return e;
  }

  private writeInner(t: IrType, value: string, ctx: WCtx): string | null {
    const c = this.code;
    switch (t.kind) {
      case "prim":
        c.line(this.primWrite(t.prim, value, this.leOf(t.endian, ctx)));
        return null;
      case "bool":
        c.line(`w.Bool(${value})`);
        return null;
      case "string": {
        const le = t.unit === 1 ? "true" : this.leOf(t.endian, ctx);
        const mode = t.length.kind === "count" ? "'c'" : t.length.kind === "until" ? "'u'" : "'r'";
        const n = t.length.kind === "count" ? this.len(t.length.expr, ctx) : "0";
        c.line(`w.Str(${value}, ${t.unit}, ${encConst(t.encoding)}, ${le}, ${mode}, ${n})`);
        return null;
      }
      case "bytes": {
        const n =
          t.length.kind === "count" ? this.lengthCheck(t.length.expr, ctx, value) : undefined;
        if (n !== undefined) c.line(`w.BytesN(${value}, ${n})`);
        else if (t.length.kind === "until")
          c.line(`w.BytesUntil(${value}, ${this.byteOf(this.expr(t.length.terminator, ctx))})`);
        else c.line(`w.Bytes(${value})`);
        return null;
      }
      case "array":
        return this.array(t, value, ctx);
      case "struct":
        return this.struct(t.struct, t.args, value, ctx);
      case "enum": {
        const st = this.model.enum(t.enum).storage;
        c.line(this.primWrite(st, `${primGo(st)}(${value})`, this.leOf(t.endian, ctx)));
        return null;
      }
      case "pointer":
        return this.pointer(t, value, ctx);
      case "extern": {
        const x = this.model.extern(t.extern);
        if (x.kind !== "type") throw new BackendError(`extern ${x.name} is not a type`);
        const args = this.args(t.args, x.params, ctx);
        c.line(
          `yaffle.WriteExtern[${this.model.goValueType(x.valueType)}](w, ${this.mod.extern(t.extern)}, ${value}, []any{${args.join(", ")}}, ${x.fixedSize ?? -1})`
        );
        return null;
      }
      case "union":
        return this.union(t, value, ctx);
      case "transform":
        return this.transform(t, value, ctx);
      case "layered": {
        const inner = stripLayers(t.inner);
        return this.emitLayers(
          t.layers,
          t.layers.length - 1,
          { ...ctx, reuse: inner.kind === "struct" ? value : undefined },
          ctx.slot,
          ctx.extent,
          x => this.write(t.inner, value, x)
        );
      }
    }
  }

  private union(t: Extract<IrType, { kind: "union" }>, value: string, ctx: WCtx): string | null {
    const c = this.code;
    const info = this.model.unionOf(t);
    const u = c.fresh("u");
    const hasL = this.model.hasPlaceables(t);
    const l = hasL ? c.fresh("l") : "";
    c.line(`${u} := ${value}`);
    c.block(`if ${u} == nil`, () => c.line(`yaffle.Fail(yaffle.INPUT, "missing union value")`));
    if (hasL) c.line(`var ${l} yaffle.LEntry`);
    c.line(`switch ${u}.Type {`);
    t.variants.forEach((vr, i) => {
      c.line(`case ${goStr(vr.name)}:`);
      c.indent(() => {
        const e = this.write(vr.type, `${u}.${info.variants[i]!.go}`, ctx);
        if (e && hasL) c.line(`${l} = ${e}`);
      });
    });
    c.line("default:");
    c.indent(() => c.line(`yaffle.Fail(yaffle.INPUT, "unknown union variant %q", ${u}.Type)`));
    c.line("}");
    return hasL ? l : null;
  }

  /** A two-way transform: the value is written through `write` and must read back. */
  private transform(
    t: Extract<IrType, { kind: "transform" }>,
    value: string,
    ctx: WCtx
  ): string | null {
    if (!t.write) return this.write(t.inner, value, ctx);
    const c = this.code;
    const val = c.fresh("tv");
    c.line(`${val} := ${value}`);
    const innerVt = valueTypeOf(this.model, t.inner);
    const ectx = this.exprCtx(ctx);
    const w = this.expr(t.write, { ...ctx, it: this.x.typed(val, t.valueType) });
    const raw = c.fresh("raw");
    const untyped = w.gt === "untyped";
    c.line(`${raw} := ${untyped ? `int64(${w.code})` : w.code}`);
    const rawC: CExpr = { code: raw, gt: untyped ? "int64" : w.gt, kind: w.kind, safe: true };
    if (w.range) rawC.range = w.range;
    const back = this.expr(t.read, { ...ctx, it: rawC });
    const value64 = this.x.asFloat(this.x.typed(val, t.valueType));
    if (t.valueType.kind === "float" && innerVt.kind === "int") {
      // A float stored as an integer must be within half a step of what reads back.
      const r = rawC.range ?? [-(1n << 63n), (1n << 63n) - 2n];
      const range: [bigint, bigint] = [r[0] + 1n, r[1] + 1n];
      const rawNext: CExpr =
        rawC.gt === "int64" && r[1] < (1n << 63n) - 1n
          ? { code: `(${raw} + 1)`, gt: "int64", kind: "int", range }
          : {
              code: `yaffle.BigAdd(${this.x.asBig(rawC, ectx)}, yaffle.BigI(1))`,
              gt: "big",
              kind: "int",
              range
            };
      const next = this.expr(t.read, { ...ctx, it: rawNext });
      c.line(
        `yaffle.CheckFloatRoundTrip(${value64}, ${this.x.asFloat(back)}, ${this.x.asFloat(next)})`
      );
    } else if (t.valueType.kind === "float") {
      c.line(
        `yaffle.CheckFloatRoundTrip(${value64}, ${this.x.asFloat(back)}, ${this.x.asFloat(back)})`
      );
    } else {
      c.line(`yaffle.CheckRoundTrip(${val}, ${this.x.to(back, t.valueType, ectx)})`);
    }
    return this.write(t.inner, this.x.to(rawC, innerVt, ectx, ctx.fieldName), ctx);
  }

  /**
   * The length a count expression gives, for checking the written value. When it depends on sizes
   * or positions (`u8 gap[tOfs - 0x19 - $offset]`), the check runs after layout instead and this
   * returns undefined.
   */
  private lengthCheck(e: IrExpr, ctx: WCtx, value: string): string | undefined {
    if (this.deriveClass(ctx.s, e) === "value") return this.len(e, ctx);
    const m = this.code.fresh("m");
    this.code.line(`${m} := w.Mark()`);
    const n = this.len(e, { ...ctx, offsetCode: `${m}.Abs()`, endCode: `${m}.RegionEnd()` });
    this.code.line(`w.DeferCheck(0, func() { yaffle.CheckLength(len(${value}), ${n}) })`);
    return undefined;
  }

  private primWrite(p: string, value: string, le: string): string {
    switch (p) {
      case "u8":
        return `w.U8(${value})`;
      case "i8":
        return `w.I8(${value})`;
      case "f16":
        return `w.F16(float64(${value}), ${le})`;
      case "u24":
        return `w.Uint(yaffle.U24, uint64(${value}), ${le})`;
      case "i24":
        return `w.Int(yaffle.I24, int64(${value}), ${le})`;
      case "u40":
      case "u48":
      case "u56":
        return `w.Uint(${primConst(p)}, ${value}, ${le})`;
      case "i40":
      case "i48":
      case "i56":
        return `w.Int(${primConst(p)}, ${value}, ${le})`;
      default:
        return `w.${p.toUpperCase()}(${value}, ${le})`;
    }
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
    const call = (inner: WCtx): string | null => {
      const callExpr = `write${this.model.structName(id)}(${["w", value, ...this.structArgs(s, args, inner)].join(", ")})`;
      if (!this.model.structHasPlaceables(s.id)) {
        this.code.line(callExpr);
        return null;
      }
      const l = this.code.fresh("l");
      this.code.line(`${l} := ${callExpr}`);
      return l;
    };
    if (!layers.length) return call(ctx);
    return this.emitLayers(
      layers,
      layers.length - 1,
      { ...ctx, reuse: value },
      `${ctx.slot}#${s.name}`,
      undefined,
      call
    );
  }

  private array(t: Extract<IrType, { kind: "array" }>, value: string, ctx: WCtx): string | null {
    const c = this.code;
    const a = c.fresh("a");
    const i = c.fresh("i");
    const el = c.fresh("el");
    const ix = c.fresh("ix");
    c.line(`${a} := ${value}`);
    if (t.length.kind === "count") {
      const n = this.lengthCheck(t.length.expr, ctx, a);
      if (n !== undefined && n !== `len(${value})` && n !== `len(${a})`)
        c.line(`yaffle.CheckLength(len(${a}), ${n})`);
    }
    const la = this.model.hasPlaceables(t) ? c.fresh("la") : undefined;
    if (la) c.line(`${la} := &yaffle.LArray{}`);
    const setIndex = this.elementUsesIndex(t.element, true);
    c.line(`${ix} := w.PushIndex()`);
    const saved = setIndex ? c.fresh("ri") : undefined;
    if (saved) c.line(`${saved} := w.Index`);
    const ectx: WCtx = { ...ctx, index: i, inArray: true, extent: undefined, idx: [...ctx.idx, i] };
    const elemVt = valueTypeOf(this.model, t.element);
    const term =
      t.length.kind === "until" || t.length.kind === "before"
        ? this.expr(t.length.terminator, ctx)
        : undefined;
    const pred = t.length.kind === "untilPredicate" ? t.length.predicate : undefined;
    c.block(`for ${i}, ${el} := range ${a}`, () => {
      c.line(`w.SetIndex(${ix}, ${i})`);
      if (saved) c.line(`w.Index = ${i}`);
      const elC = this.x.typed(el, elemVt);
      if (term) {
        const eq = this.x.equality("==", elC, term, this.exprCtx(ctx));
        c.block(`if ${stripParens(eq)}`, () =>
          c.line(`yaffle.Fail(yaffle.INPUT, "an element equals the terminator")`)
        );
      }
      if (pred) {
        const cond = this.expr(pred, { ...ctx, it: elC }).code;
        c.block(`if ${cond} != (${i} == len(${a})-1)`, () =>
          c.line(
            `yaffle.Fail(yaffle.CHECK, "until: only the last element may (and must) end the array")`
          )
        );
      }
      if (t.elementPlacement) {
        const off = this.num(t.elementPlacement, ectx);
        const body = this.entryClosure(() => this.write(t.element, el, ectx));
        const P = c.fresh("pl");
        c.line(
          `${P} := w.Place(${goStr(`${ctx.fieldName}[]`)}, ${this.identity(t.element, el)}, ${body}, yaffle.PlaceOpts{Fixed: ${off}, HasFixed: true}, nil)`
        );
        if (la) c.line(`${la}.Push(${P})`);
      } else {
        const e = this.write(t.element, el, ectx);
        if (la) c.line(`${la}.Push(${e ?? "nil"})`);
      }
    });
    if (pred)
      c.block(`if len(${a}) == 0`, () =>
        c.line(`yaffle.Fail(yaffle.CHECK, "until: the array needs an element that ends it")`)
      );
    if (term && t.length.kind === "until") {
      c.line(`w.SetIndex(${ix}, len(${a}))`);
      if (saved) c.line(`w.Index = len(${a})`);
      const e = this.write(t.element, this.x.to(term, elemVt, this.exprCtx(ctx)), ectx);
      if (la && e) c.line(`${la}.Push(${e})`);
    }
    if (saved) c.line(`w.Index = ${saved}`);
    c.line(`w.PopIndex(${ix})`);
    return la ?? null;
  }

  private pointer(
    t: Extract<IrType, { kind: "pointer" }>,
    value: string,
    ctx: WCtx
  ): string | null {
    const c = this.code;
    const tv = c.fresh("tv");
    c.line(`${tv} := ${value}`);
    const nv =
      t.nullValue !== undefined
        ? this.mod.hoist(
            `yaffle.Ptr(uint64(${formatInt(BigInt.asUintN(64, BigInt(t.nullValue)))}))`,
            "null"
          )
        : "nil";
    const le = this.leOf(t.storageEndian, ctx);
    const tctx: WCtx = { ...ctx, extent: undefined };
    const isNull = t.emptyIsNull
      ? `len(${tv}) == 0`
      : t.nullValue !== undefined
        ? `${tv} == nil`
        : "false";
    const targetValue = this.model.goType(t) !== this.model.goType(t.target) ? `(*${tv})` : tv;
    const origin = t.origin ? funcLit("func() int", this.num(t.origin, ctx)) : "nil";
    const prim = primConst(t.storage);
    const target = (): string => this.entryClosure(() => this.write(t.target, targetValue, tctx));
    if (t.ownership === "ref") {
      const body = target();
      const identity = this.identity(t.target, tv);
      c.line(
        `w.RefPointer(${prim}, ${le}, ${goStr(this.model.typeKey(t.target))}, ${isNull}, ${identity}, ${funcLit("func() []byte", `w.EncodeAlone(${body})`)}, ${t.relative}, ${nv}, ${origin})`
      );
      return null;
    }
    const P = c.fresh("pl");
    const body = target();
    const key = goStr(this.model.typeKey(t.target));
    const owner = ctx.inArray ? "nil" : "v";
    const call = `w.Target(${this.identity(t.target, targetValue)}, ${key}, ${goStr(ctx.fieldName)}, ${body}, yaffle.PlaceOpts{}, ${owner})`;
    if (isNull === "false") c.line(`${P} := ${call}`);
    else {
      c.line(`var ${P} *yaffle.Placeable`);
      c.block(`if !(${isNull})`, () => c.line(`${P} = ${call}`));
    }
    c.line(`w.Pointer(${prim}, ${le}, ${P}, ${t.relative}, ${nv}, ${origin})`);
    return P;
  }

  // ── bits ──────────────────────────────────────────────────────────────────

  private emitBits(b: IrBits, ctx: WCtx): void {
    const c = this.code;
    const u = c.fresh("u");
    c.line(`var ${u} uint64`);
    for (const f of b.fields) {
      if (f.name === null) continue;
      c.line(`w.Field(fr, ${goStr(f.name)})`);
      const bits = this.bitsOf(f, this.bitFieldValue(f, ctx), ctx);
      c.line(f.shift ? `${u} |= ${bits} << ${f.shift}` : `${u} |= ${bits}`);
    }
    const le = primSize(b.storage) === 1 ? "true" : this.leOf(b.endian, ctx);
    c.line(`w.Uint(${primConst(b.storage)}, ${u}, ${le})`);
  }

  private bitFieldValue(f: IrBitField, ctx: WCtx): string {
    const vt = valueTypeOf(this.model, f.type);
    const g = this.model.goField(ctx.s, f.name!);
    const v =
      f.input !== "required" && f.derive
        ? this.x.to(this.fieldRef(f.name!, vt, ctx), vt, this.exprCtx(ctx), f.name!)
        : this.inputValue(g);
    const checks = f.checks.filter(ch => !ch.strictOnly);
    if (!checks.length) return v;
    const tmp = this.code.fresh("val");
    this.code.line(`${tmp} := ${v}`);
    this.emitWriteChecks(
      checks,
      this.x.typed(tmp, vt),
      ctx,
      f.input === "absent" ? "DERIVE" : "CHECK"
    );
    return tmp;
  }

  private bitsOf(f: IrBitField, value: string, ctx: WCtx): string {
    let t = f.type;
    if (t.kind === "layered") t = t.inner;
    if (t.kind === "transform" && t.write) {
      const w = this.expr(t.write, { ...ctx, it: this.x.typed(value, t.valueType) });
      const innerVt = valueTypeOf(this.model, t.inner);
      return this.bitsOfType(t.inner, this.x.to(w, innerVt, this.exprCtx(ctx), f.name!), f.width);
    }
    if (t.kind === "transform") t = t.inner;
    return this.bitsOfType(t, value, f.width);
  }

  private bitsOfType(t: IrType, value: string, width: number): string {
    if (t.kind === "bool") return `yaffle.BoolBit(${value})`;
    const signed =
      (t.kind === "enum" && this.model.enum(t.enum).storage[0] === "i") ||
      (t.kind === "prim" && t.prim[0] === "i");
    return signed
      ? `yaffle.BitsI(int64(${value}), ${width})`
      : `yaffle.BitsU(uint64(${value}), ${width})`;
  }

  // ── layers ────────────────────────────────────────────────────────────────

  /**
   * Emits layers[idx] down to layers[0] (outermost first) around inner, recording the size after
   * each stage in extent (encodedSize). Returns the layout entry of the value, or null.
   */
  private emitLayers(
    layers: readonly IrLayer[],
    idx: number,
    ctx: WCtx,
    slot: string,
    extent: string | undefined,
    inner: (ctx: WCtx) => string | null
  ): string | null {
    if (idx < 0) return inner(ctx);
    const l = layers[idx]!;
    const c = this.code;
    const next = (x: WCtx): string | null => {
      const s = extent ? c.fresh("so") : undefined;
      if (s) c.line(`${s} := w.Offset()`);
      const e = this.emitLayers(layers, idx - 1, x, slot, extent, inner);
      if (s) c.line(`${extent}.Stage(${idx}, w.Offset()-${s})`);
      return e;
    };
    // Layers that measure what the inner ones wrote: close gets the start offset's local.
    const around = (close: (start: string) => string): string | null => {
      const s = c.fresh("s");
      c.line(`${s} := w.Offset()`);
      const e = next(ctx);
      c.line(close(s));
      return e;
    };
    switch (l.kind) {
      case "align":
        c.line(this.alignCall(l, ctx));
        return next(ctx);
      case "padBefore":
        c.line(`w.Pad(${this.len(l.count, ctx)}, ${this.fill(l.fill, ctx)})`);
        return next(ctx);
      case "padAfter": {
        const e = next(ctx);
        c.line(`w.Pad(${this.len(l.count, ctx)}, ${this.fill(l.fill, ctx)})`);
        return e;
      }
      case "padUntil":
        return around(s => `w.PadUntil(${s}, ${this.len(l.size, ctx)}, ${this.fill(l.fill, ctx)})`);
      case "alignEnd": {
        const e = next(ctx);
        c.line(this.alignCall(l, ctx));
        return e;
      }
      case "size":
        return around(s => `w.SizeWindow(${s}, ${this.len(l.size, ctx)})`);
      case "via":
        this.emitVia(l, layers, idx, ctx, slot, extent, inner);
        return null;
      case "endian": {
        const e = c.fresh("e");
        const le = c.fresh("le");
        c.line(`${e} := ${this.expr(l.value, ctx).code}`);
        c.line(`${le} := ${e} == yaffle.LE`);
        return next({ ...ctx, endian: e, le });
      }
      case "strict":
        return next(ctx);
    }
  }

  /**
   * A codec layer: the inner layers are encoded on their own, then encoded by the codec, unless
   * the plain bytes are unchanged since the read (codec reuse: the original encoding is kept).
   */
  private emitVia(
    l: Extract<IrLayer, { kind: "via" }>,
    layers: readonly IrLayer[],
    idx: number,
    ctx: WCtx,
    slot: string,
    extent: string | undefined,
    inner: (ctx: WCtx) => string | null
  ): void {
    const c = this.code;
    const codec = this.model.codec(l.codec);
    const args = this.args(l.args, codec.params, ctx);
    const plain = c.fresh("pln");
    const body = this.entryClosure(() =>
      this.emitLayers(layers, idx - 1, ctx, slot, extent, inner)
    );
    c.line(`${plain} := w.EncodeAlone(${body})`);
    if (extent) {
      c.line(`${extent}.Stage(${idx}, len(${plain}))`);
      c.line(`${extent}.SetPlain(${plain})`);
    }
    let outSize = "-1";
    for (let k = idx - 1; k >= 0; k--) {
      const ll = layers[k]!;
      if (ll.kind === "via") break;
      if (ll.kind === "size") {
        outSize = `len(${plain})`;
        break;
      }
    }
    const slotKey = `${slot}#${idx}`;
    const meta = ctx.reuse ? `${ctx.reuse}.yfl` : "v.yfl";
    const slotCode = ctx.reuse ? goStr(slotKey) : this.slotCode(slotKey, ctx);
    const enc = c.fresh("enc");
    c.line(`${enc} := ${meta}.ReuseCodec(${slotCode}, ${plain})`);
    c.block(`if ${enc} == nil`, () =>
      c.line(
        `${enc} = yaffle.Encode(${this.mod.extern(l.codec)}, ${goStr(codec.name)}, ${plain}, &yaffle.CodecCtx{Context: w.Ctx, Args: []any{${args.join(", ")}}, OutputSize: ${outSize}})`
      )
    );
    c.line(`w.Bytes(${enc})`);
  }

  /** An `align`/`alignEnd` layer on write: from the base or the file, with an offset. */
  private alignCall(l: Extract<IrLayer, { kind: "align" | "alignEnd" }>, ctx: WCtx): string {
    const to = this.num(l.to, ctx);
    const fill = this.fill(l.fill, ctx);
    if (l.from === "file" || l.offset) {
      const off = l.offset ? this.num(l.offset, ctx) : "0";
      return `w.AlignAt(${to}, ${off}, ${l.from === "file"}, ${fill})`;
    }
    return `w.Align(${to}, ${fill})`;
  }

  /** A base struct's `@alignEnd`: the size of its whole region. */
  private alignEnd(l: Extract<IrLayer, { kind: "alignEnd" }>, ctx: WCtx): string {
    const to = this.num(l.to, ctx);
    if (l.from === "file" || l.offset) {
      const off = l.offset ? this.num(l.offset, ctx) : "0";
      return `w.Region.AlignEndAt(${to}, ${off}, ${l.from === "file"})`;
    }
    return `w.Region.AlignEnd = yaffle.Lcm(w.Region.AlignEnd, ${to})`;
  }

  // ── streams ───────────────────────────────────────────────────────────────

  /**
   * `from` fields: encode the value, then hand the bytes to the stream's source fields. Slices of
   * one stream are assembled into it: zero-filled, each slice's encoding at its start, overlapping
   * slices agreeing.
   */
  private emitStreamPrepass(s: IrStruct, ctx: WCtx): void {
    const c = this.code;
    interface Part {
      enc: string;
      start: string;
      end: string;
      policy: string | undefined;
    }
    const roots = new Map<string, { stream: RootStream; parts: Part[]; sliced: boolean }>();
    for (const f of this.model.fields(s)) {
      const fld = f.field;
      if (!fld?.from) continue;
      const g = this.model.goField(s, fld.name);
      const enc = c.fresh("str");
      const body = this.entryClosure(() =>
        this.write(fld.type, this.inputValue(g), {
          ...ctx,
          fieldName: fld.name,
          slot: `${s.id}.${fld.name}`
        })
      );
      c.line(`w.Field(fr, ${goStr(fld.name)})`);
      c.line(`${enc} := w.EncodeAlone(${body})`);
      // Peel slices: the part's offsets within the root stream.
      let st = fld.from.stream;
      const slices: Extract<IrStreamExpr, { kind: "slice" }>[] = [];
      while (st.kind === "slice") {
        slices.unshift(st);
        st = st.stream;
      }
      const starts: string[] = [];
      let end = "-1";
      for (const sl of slices) {
        const base = starts.length ? starts.join(" + ") : "0";
        if (sl.end) {
          const e = this.num(sl.end, ctx);
          end = base === "0" ? e : `${base} + ${e}`;
        }
        starts.push(this.num(sl.start, ctx));
      }
      const key = st.kind === "field" ? `f:${st.field}` : `e:${st.array}.${st.field}`;
      let root = roots.get(key);
      if (!root) roots.set(key, (root = { stream: st, parts: [], sliced: false }));
      if (slices.length) root.sliced = true;
      root.parts.push({
        enc,
        start: starts.length ? starts.join(" + ") : "0",
        end,
        policy: fld.from.split?.policy
      });
    }
    for (const { stream, parts, sliced } of roots.values()) {
      if (!sliced && parts.length === 1) {
        this.streamTargets(stream, parts[0]!.enc, s, ctx, parts[0]!.policy);
        continue;
      }
      const buf = c.fresh("asm");
      const list = parts.map(p => `{Start: ${p.start}, End: ${p.end}, Data: ${p.enc}}`);
      c.line(
        `${buf} := yaffle.AssembleSlices(${this.carrierSize(s, stream, ctx)}, []yaffle.SlicePart{${list.join(", ")}})`
      );
      this.streamTargets(stream, buf, s, ctx, parts.find(p => p.policy)?.policy);
    }
  }

  /** The carrier's own length when it is known up front, else -1 (the largest slice end). */
  private carrierSize(s: IrStruct, stream: RootStream, ctx: WCtx): string {
    if (stream.kind !== "field") return "-1";
    const carrier = this.model.field(s, stream.field)?.field;
    const t = carrier && stripLayers(carrier.type);
    if (!t || t.kind !== "bytes" || t.length.kind !== "count") return "-1";
    const n = t.length.expr;
    let known = literalInt(n) !== undefined;
    let x = n;
    while (x.kind === "convert") x = x.operand;
    if (x.kind === "field") {
      const lf = this.model.field(s, x.name);
      known = (lf?.field?.input ?? lf?.bit?.input) === "required";
    } else if (x.kind === "param") known = true;
    return known ? this.len(n, ctx) : "-1";
  }

  /** Hands a stream's encoding to its source: the carrier field, or the pieces of an array. */
  private streamTargets(
    st: RootStream,
    bytes: string,
    s: IrStruct,
    ctx: WCtx,
    policy: string | undefined
  ): void {
    const c = this.code;
    if (st.kind === "field") {
      this.st.overrides.set(st.field, { code: bytes, gt: "[]byte", kind: "bytes", safe: true });
      return;
    }
    const arr = this.model.field(s, st.array)?.field;
    if (!arr) throw new BackendError(`unknown stream array ${st.array}`);
    const at = stripLayers(arr.type);
    if (at.kind !== "array") throw new BackendError(`${st.array} is not an array`);
    const es = this.model.elementStruct(s, st.array);
    if (!es) throw new BackendError(`${st.array} elements are not structs`);
    const en = this.model.structName(es.id);
    const ag = this.model.goField(s, st.array);
    const pg = this.model.goField(es, st.field);
    const piece = this.model.field(es, st.field)?.field;
    const sizeField = piece ? innerSizeField(piece.type) : undefined;
    const sg = sizeField ? this.model.goField(es, sizeField) : undefined;
    const spec: [string, string][] = [
      ["Piece", `func(e *${en}) []byte { return e.${pg.go} }`],
      [
        "SetPiece",
        `func(e *${en}, b []byte) *${en} {\n\tx := ${en}{}\n\tif e != nil {\n\t\tx = *e\n\t}\n\tx.${pg.go} = b\n\treturn &x\n}`
      ],
      ["New", `func() *${en} { return &${en}{} }`]
    ];
    if (sg?.ptr) {
      spec.push([
        "Size",
        `func(e *${en}) (int, bool) {\n\tif e.${sg.go} == nil {\n\t\treturn 0, false\n\t}\n\treturn int(*e.${sg.go}), true\n}`
      ]);
      spec.push([
        "ClearSize",
        `func(e *${en}) *${en} {\n\tx := *e\n\tx.${sg.go} = nil\n\treturn &x\n}`
      ]);
    } else if (sg) {
      spec.push(["Size", `func(e *${en}) (int, bool) { return int(e.${sg.go}), true }`]);
    }
    if (policy === "fit" && at.elementPlacement) {
      const off = this.num(at.elementPlacement, { ...ctx, index: "k" });
      const call = this.entryClosure(() =>
        this.write(at.element, "e", { ...ctx, index: "-1", fieldName: st.array, idx: [] })
      );
      spec.push(["Offset", `func(k int) int { return ${off} }`]);
      spec.push(["Measure", funcLit(`func(e *${en}) int`, `len(w.EncodeAlone(${call}))`)]);
    }
    const els = c.fresh("els");
    const spv = c.fresh("sp");
    c.line(`${spv} := yaffle.SplitSpec[*${en}]{}`);
    for (const [k, fn] of spec) c.line(`${spv}.${k} = ${fn}`);
    c.line(`${els} := yaffle.SplitStream(v.${ag.go}, ${bytes}, ${spv})`);
    this.st.overrides.set(st.array, { code: els, gt: `[]*${en}`, kind: "other", safe: true });
  }
}

/** Layout items as a Go literal. Layer arguments are constants, or compiled by `num`. */
export function layoutLiteral(
  items: readonly IrLayoutItem[],
  num?: (e: IrExpr, what: string) => string
): string {
  const n = (e: IrExpr, what = "alignment"): string => {
    const v = literalInt(e);
    if (v !== undefined) return String(v);
    if (!num)
      throw new BackendError("not implemented: layout item layers with non-constant arguments");
    return num(e, what);
  };
  const parts = items.map(it => {
    const fields: string[] = [];
    if (it.path === "this") fields.push("This: true");
    else
      fields.push(
        `Path: []string{${it.path.map(seg => (seg.kind === "each" ? `"*"` : goStr(seg.name))).join(", ")}}`
      );
    const layers: string[] = [];
    for (const l of it.layers) {
      if (l.kind === "align" || l.kind === "alignEnd") {
        const kind = l.kind === "align" ? "yaffle.LAlign" : "yaffle.LAlignEnd";
        const extra: string[] = [];
        if (l.offset) extra.push(`Offset: ${n(l.offset, "alignment offset")}`);
        if (l.from === "file") extra.push("File: true");
        layers.push(`{${[`Kind: ${kind}`, `N: ${n(l.to)}`, ...extra].join(", ")}}`);
      } else if (l.kind === "padBefore" || l.kind === "padAfter") {
        const kind = l.kind === "padBefore" ? "yaffle.LPadBefore" : "yaffle.LPadAfter";
        layers.push(`{Kind: ${kind}, N: ${n(l.count, "padding")}}`);
      }
    }
    if (layers.length) fields.push(`Layers: []yaffle.LayoutLayer{${layers.join(", ")}}`);
    if (it.group) fields.push(`Group: ${layoutLiteral(it.group.items, num)}`);
    return `{${fields.join(", ")}}`;
  });
  return `[]yaffle.LayoutItem{${parts.join(", ")}}`;
}

function wrapP(cond: string): string {
  return (/^\(.*\)$/.test(cond) && stripParens(cond) !== cond) || /^[A-Za-z0-9_.]+$/.test(cond)
    ? cond
    : `(${cond})`;
}
