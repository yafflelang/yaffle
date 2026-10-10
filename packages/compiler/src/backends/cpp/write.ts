/**
 * Writer emitter: one `write_X(yaffle::Writer&, const X&, endian, params…)` function per struct,
 * relocation-style code over yaffle::Writer following docs/IR.md §3 and §4.
 *
 * Derived values are evaluated where they are written when they depend only on values; values that
 * depend on sizes, positions or encodings are written as placeholders and computed by fixups
 * (lambdas) after layout. References to a derived field inline its `derive` expression.
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
  findBits,
  innerSizeField,
  isOneWay,
  patchableType,
  constLayoutArg,
  dynamicLayout,
  primSize,
  strip,
  stripLayers,
  usesIt,
  valueTypeOf,
  walkExpr,
  type LayoutArg
} from "./analysis.ts";
import { Code, intLit, localName, str } from "./code.ts";
import { Emitter, sizeInside, type EmitCtx } from "./emitter.ts";
import type { CExpr, ExprCtx } from "./expr.ts";
import { rootType } from "./read.ts";
import { primCppType } from "./types.ts";

interface WCtx extends EmitCtx {
  /** The value is the raw (inner) value of a one-way transform (field level). */
  raw?: boolean | undefined;
  /** Inside a fixup lambda: positions and sizes are final. */
  deferred: boolean;
  /** Extent variable of the field being written (stage recording). */
  extent?: string | undefined;
  /** Field name being written (placeable names). */
  fieldName: string;
  /** Code of `$offset` (deferred checks capture the position where the field started). */
  offsetCode?: string | undefined;
  /** Code of `$end` (deferred checks: the end of the finished region). */
  endCode?: string | undefined;
}

type DeriveClass = "value" | "size" | "position" | "content";

interface StructState {
  /** Fields with an extent variable (sizes, positions, encodings used by expressions). */
  extents: Set<string>;
  /** Derived fields being inlined (cycle detection). */
  inlining: string[];
  /** Values that replace a field's input (stream sources, patch encoders). */
  overrides: Map<string, string>;
}

export class WriteEmitter extends Emitter<WCtx> {
  private st!: StructState;
  private readonly classMemo = new Map<string, DeriveClass>();
  /** Layout constants by struct id. */
  readonly layouts = new Map<string, string>();

  private reset(extents = new Set<string>()): void {
    this.st = { extents, inlining: [], overrides: new Map() };
  }

  /**
   * The struct's layout constant, or "nullptr" (no layout, or one whose item arguments read
   * fields: each instance builds its own, see instanceLayout).
   */
  layoutRef(s: IrStruct): string {
    if (!s.layout || !s.layout.length || dynamicLayout(s.layout)) return "nullptr";
    const name = `layout_${this.model.structName(s.id)}`;
    this.layouts.set(s.id, `static const yaffle::Layout ${name} = ${layoutLiteral(s.layout)};`);
    return `&${name}`;
  }

  /**
   * The layout of one instance when item arguments read fields: a `yaffle::Layout` initializer
   * whose arguments are evaluated like computed fields, or undefined (static layout).
   */
  private instanceLayout(s: IrStruct, ctx: WCtx): string | undefined {
    if (!s.layout || !s.layout.length || !dynamicLayout(s.layout)) return undefined;
    return layoutLiteral(s.layout, (e, what) => {
      if (this.deriveClass(s, e) !== "value")
        throw new Error("not implemented: layout item arguments that depend on sizes or positions");
      const n = this.x.asI64(this.x.compile(e, this.exprCtx(ctx)));
      if (what === "align") return `yaffle::layout_alignment(${n})`;
      if (what === "pad") return `yaffle::layout_padding(${n})`;
      return n;
    });
  }

  returnsL(s: IrStruct): boolean {
    return !s.base && this.model.membersHavePlaceables(s.members);
  }

  prototype(s: IrStruct): string {
    const name = this.model.structName(s.id);
    const ret = this.returnsL(s) ? "std::shared_ptr<yaffle::LStruct>" : "void";
    return `static ${ret} write_${name}(yaffle::Writer& w, const ${name}& v_${this.params(s)})`;
  }

  emitStruct(out: Code, s: IrStruct): void {
    this.reset(extentFields(s, true));
    const hasL = this.model.membersHavePlaceables(s.members);
    const body = out.child();
    this.code = body;
    const ctx: WCtx = {
      s,
      endian: "endian",
      le: "le",
      index: "index",
      depth: 0,
      deferred: false,
      slot: s.id,
      fieldName: "",
      meta: this.model.usesMeta(s) ? "self->yaffle_meta_" : undefined
    };
    this.emitStreamPrepass(s, ctx);
    // An instance layout is built before the members (stream sources are known by then).
    const own = hasL ? this.instanceLayout(s, ctx) : undefined;
    if (own) body.line(`L->own(${own});`);
    this.emitMembers(s.members, ctx, hasL ? "L" : undefined);

    out.block(this.prototype(s), () => {
      out.line(`[[maybe_unused]] const ${this.model.structName(s.id)}* const self = &v_;`);
      out.line(`[[maybe_unused]] const bool le = endian == yaffle::Endian::le;`);
      out.line(`[[maybe_unused]] const std::int64_t index = w.index;`);
      const emitBody = (): void => {
        if (s.base) {
          // A base's `@alignEnd` pads its whole region, after its targets.
          for (const l of s.layers)
            if (l.kind === "alignEnd") out.line(this.regionAlignEnd(l, ctx));
        }
        if (hasL) out.line(`auto L = std::make_shared<yaffle::LStruct>(${this.layoutRef(s)});`);
        for (const f of this.st.extents) {
          if (f === "this")
            out.line(
              `[[maybe_unused]] const yaffle::ExtentPtr x_this_ = ${s.base ? "w.region_extent()" : "w.extent()"};`
            );
          else
            out.line(
              `const yaffle::ExtentPtr ${extentName(f)} = std::make_shared<yaffle::Extent>(nullptr, 0);`
            );
        }
        out.line(`yaffle::Frame fr;`);
        out.line(`yaffle::FrameScope fs_(w, fr);`);
        out.rethrow(() => {
          out.append(body);
          if (this.st.extents.has("this") && !s.base) out.line(`w.close(x_this_);`);
        }, "e.prefix(fr);");
      };
      if (s.base) {
        out.line(`w.base(${this.layoutRef(s)}, [&]() -> yaffle::LEntry {`);
        out.indent(() => {
          emitBody();
          out.line(hasL ? "return yaffle::lentry(L);" : "return yaffle::LEntry();");
        });
        out.line(`}, self);`);
      } else {
        emitBody();
        if (hasL) out.line("return L;");
      }
    });
  }

  /**
   * In-place patch encoder of a field (views): `static yaffle::Bytes enc_X_f(const T& val,
   * const X& v_, const X_Args& a)`, or undefined when the field's encoding depends on positions,
   * sizes or targets (setting it is then a structural edit).
   */
  encoderFor(s: IrStruct, name: string): string | undefined {
    const fr = this.model.field(s, name);
    if (!fr) return undefined;
    if (
      fr.field &&
      (fr.field.placement ||
        fr.field.from ||
        fr.field.virtual ||
        !patchableType(fr.field.type) ||
        isOneWay(fr.field.type))
    )
      return undefined;
    const savedCode = this.code;
    const savedSt = this.st;
    this.reset();
    const body = new Code();
    this.code = body;
    const ctx: WCtx = {
      s,
      endian: "endian",
      le: "le",
      index: "index",
      depth: 0,
      deferred: false,
      slot: `${s.id}.${name}`,
      fieldName: name
    };
    let valType: string;
    try {
      if (fr.field) {
        const f = fr.field;
        valType = this.types.type(f.type);
        const checks = f.deriveKind === "constant" ? [] : f.checks.filter(ch => !ch.strictOnly);
        this.emitWriteChecks(checks, "val", valueTypeOf(this.model, f.type), ctx, "Check");
        if (this.write(f.type, "val", ctx)) return undefined;
      } else {
        const bits = findBits(s.members, name);
        if (!bits) return undefined;
        valType = this.types.type(fr.bit!.type);
        this.st.overrides.set(name, "val");
        this.emitBits(bits, ctx);
      }
      if (this.st.extents.size) return undefined;
    } catch {
      return undefined;
    } finally {
      this.code = savedCode;
      this.st = savedSt;
    }
    const sname = this.model.structName(s.id);
    const out = new Code();
    out.block(
      `[[maybe_unused]] static yaffle::Bytes enc_${sname}_${this.model.member(name)}(const ${valType}& val, const ${sname}& v_, [[maybe_unused]] const ${sname}_Args& a, [[maybe_unused]] std::int64_t index)`,
      () => {
        out.line(`[[maybe_unused]] const ${sname}* const self = &v_;`);
        out.line(`[[maybe_unused]] const yaffle::Endian endian = a.endian;`);
        out.line(`[[maybe_unused]] const bool le = endian == yaffle::Endian::le;`);
        for (const p of s.params)
          if (p.origin !== "endian")
            out.line(`[[maybe_unused]] const auto& ${localName(p.name)} = a.${localName(p.name)};`);
        out.line(`return yaffle::encode_standalone([&](yaffle::Writer& w) {`);
        out.indent(() => {
          out.line(`yaffle::Frame fr;`);
          out.line(`fr.field = ${str(name)};`);
          out.line(`yaffle::FrameScope fs_(w, fr);`);
          out.append(body);
        });
        out.line(`});`);
      }
    );
    return out.toString();
  }

  /** Emits the write of a root struct (params are locals); returns the layout entry code. */
  rootWrite(out: Code, s: IrStruct, value: string): string | null {
    this.reset();
    this.code = out;
    const ctx: WCtx = {
      s,
      endian: "endian",
      le: "le",
      index: "-1",
      depth: 0,
      deferred: false,
      slot: s.id,
      fieldName: "",
      meta: this.model.usesMeta(s) ? `yaffle::obj(${value}).yaffle_meta_` : undefined
    };
    const t = rootType(s);
    if (s.base) return this.struct(t, value, ctx);
    // The root is its file's base: `@alignEnd` pads the whole region, after the targets.
    for (const l of s.layers) if (l.kind === "alignEnd") out.line(this.regionAlignEnd(l, ctx));
    const inline = s.layers.filter(l => l.kind !== "alignEnd");
    return this.struct(t, value, ctx, inline.length < s.layers.length ? inline : undefined);
  }

  // ── derive classification ─────────────────────────────────────────────────

  deriveClass(s: IrStruct, e: IrExpr, seen: string[] = []): DeriveClass {
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
      else if (x.kind === "field" && this.inlinedDerive(s, x.name) && !seen.includes(x.name))
        bump(this.fieldClass(s, x.name, [...seen, x.name]));
    });
    return cls;
  }

  /** The derive a reference to field `name` evaluates (fields that are not required inputs). */
  private inlinedDerive(s: IrStruct, name: string): IrExpr | undefined {
    const f = this.model.field(s, name);
    const d = f?.field?.derive ?? f?.bit?.derive;
    const input = f?.field?.input ?? f?.bit?.input;
    return input !== "required" ? d : undefined;
  }

  fieldClass(s: IrStruct, name: string, seen: string[] = []): DeriveClass {
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
      ...this.baseExprCtx(ctx),
      field: (name, type) => this.fieldRef(name, type, ctx),
      builtin: name => {
        if (name === "offset") return ctx.offsetCode ?? "w.position()";
        if (name === "end") return ctx.endCode ?? "yaffle::end_unavailable()";
        return ctx.index;
      },
      sizeof: f => `${this.extentVar(f)}->size()`,
      offsetof: f => `${this.extentVar(f)}->pos()`,
      encodedSize: (f, k) => `${this.extentVar(f)}->stage(${k})`,
      bytesof: f => `yaffle::to_bytes(${this.extentVar(f)}->bytes())`,
      encode: f => `yaffle::to_bytes(${this.extentVar(f)}->plain_bytes())`
    };
  }

  private extentVar(f: string): string {
    this.st.extents.add(f);
    return extentName(f);
  }

  /** Access to the input member of a field (dereferenced when it is a std::optional). */
  inputMember(s: IrStruct, name: string): string {
    const m = `self->${this.model.member(name)}`;
    return this.model.isOptionalMember(s, name) ? `(*${m})` : m;
  }

  /** A field reference in the write context: the input value, or the inlined derive. */
  fieldRef(name: string, type: IrValueType, ctx: WCtx): CExpr {
    const override = this.st.overrides.get(name);
    if (override) return this.x.typed(override, type);
    const f = this.model.field(ctx.s, name);
    if (!f) throw new Error(`unknown field ${name} in ${ctx.s.name}`);
    const input = f.field ? f.field.input : f.bit!.input;
    const derive = f.field ? f.field.derive : f.bit!.derive;
    const hidden = f.field?.hidden ?? false;
    const inputCode = (): CExpr => this.x.typed(this.inputMember(ctx.s, name), type);
    if (input === "required" && !hidden) {
      if (derive && usesIt(derive)) {
        const i = inputCode();
        return this.x.compile(derive, this.exprCtx({ ...ctx, it: { code: i.code, type } }));
      }
      return inputCode();
    }
    if (!derive) return inputCode();
    if (this.st.inlining.includes(name))
      throw new Error(`derive cycle through ${name} in ${ctx.s.name}`);
    this.st.inlining.push(name);
    const d = this.x.compile(derive, this.exprCtx({ ...ctx, it: undefined }));
    this.st.inlining.pop();
    if (input === "optional") {
      const m = `self->${this.model.member(name)}`;
      const i = this.x.typed(`(*${m})`, type);
      if (d.repr === "int" && i.repr === "int") {
        const range: [bigint, bigint] = [
          d.range![0] < i.range![0] ? d.range![0] : i.range![0],
          d.range![1] > i.range![1] ? d.range![1] : i.range![1]
        ];
        return {
          code: `(${m} ? ${this.x.asI128(i)} : ${this.x.asI128(d)})`,
          repr: "int",
          range,
          it: "i128"
        };
      }
      return { ...d, code: `(${m} ? ${this.x.to(i, type)} : ${this.x.to(d, type)})` };
    }
    return d;
  }

  // ── members ───────────────────────────────────────────────────────────────

  /** Presence checks of the required inputs of a conditional branch. */
  protected override enterBranch(ms: readonly IrMember[], ctx: WCtx): void {
    const req: string[] = [];
    const collect = (list: readonly IrMember[]): void => {
      for (const m of list) {
        if (m.kind === "field") {
          if (m.input === "required" && !m.hidden && !this.st.overrides.has(m.name))
            req.push(m.name);
        } else if (m.kind === "bits") {
          for (const b of m.fields) if (b.name !== null && b.input === "required") req.push(b.name);
        } else if (m.kind === "block" && !m.condition) collect(m.members);
      }
    };
    collect(ms);
    const opt = req.filter(n => this.model.isOptionalMember(ctx.s, n));
    if (!opt.length) return;
    this.code.line(`fr.field = "";`);
    for (const n of opt)
      this.code.line(`if (!self->${this.model.member(n)}) yaffle::missing(${str(n)});`);
  }

  emitMembers(ms: readonly IrMember[], ctx: WCtx, L: string | undefined): void {
    for (const m of ms) {
      switch (m.kind) {
        case "field":
          this.emitField(m, ctx, L);
          break;
        case "bits":
          this.emitBits(m, ctx);
          break;
        case "block":
          this.emitBlock(
            m,
            ctx,
            () =>
              this.emitLayers(
                m.layers,
                ctx,
                inner => {
                  this.emitMembers(m.members, inner, L);
                  return null;
                },
                `${ctx.slot}.block`,
                undefined
              ),
            els => this.emitMembers(els, ctx, L)
          );
          break;
        case "switch":
          this.emitSwitch(
            m,
            ctx,
            ms => this.emitMembers(ms, ctx, L),
            `yaffle::fail(yaffle::ErrorCode::Check, "no case matches");`
          );
          break;
      }
    }
  }

  /**
   * `virtual u40 size = …`: no bytes. The value comes from the input (its parts
   * derive from it); its checks apply, and the read expression over the parts must give it back.
   */
  private emitVirtual(f: IrField, ctx: WCtx): void {
    const c = this.code;
    c.line(`fr.field = ${str(f.name)};`);
    const fctx: WCtx = { ...ctx, slot: `${ctx.s.id}.${f.name}`, fieldName: f.name };
    const vt = valueTypeOf(this.model, f.type);
    const value = this.x.to(this.fieldRef(f.name, vt, fctx), vt);
    const tmp = c.fresh("val");
    c.line(`const auto ${tmp} = ${value};`);
    this.emitWriteChecks(
      f.checks.filter(ch => !ch.strictOnly),
      tmp,
      vt,
      fctx,
      f.input !== "absent" ? "Check" : "Derive"
    );
    const back = this.expr(f.virtual!.read, fctx);
    const eq = this.x.equality("==", back, this.x.typed(tmp, vt));
    c.line(
      `if (!${eq}) yaffle::fail(yaffle::ErrorCode::Derive, ${str(`${f.name} does not read back from the fields it is stored in`)});`
    );
  }

  emitField(f: IrField, ctx: WCtx, L: string | undefined): void {
    const c = this.code;
    if (f.from) return; // encoded by the stream prepass into its source fields
    if (f.virtual) {
      this.emitVirtual(f, ctx);
      return;
    }
    c.line(`fr.field = ${str(f.name)};`);
    const fctx: WCtx = { ...ctx, slot: `${ctx.s.id}.${f.name}`, fieldName: f.name };
    const ext = this.st.extents.has(f.name) ? extentName(f.name) : undefined;
    const vt = valueTypeOf(this.model, f.type);
    let value: string;
    let cls: DeriveClass = "value";
    const override = this.st.overrides.get(f.name);
    if (override) value = override;
    else if (isOneWay(f.type) && f.input !== "absent") {
      // One-way transform: the input is the raw value.
      value = `yaffle::val(self->${this.names.rawMember(ctx.s, f.name)}, "raw value of ${f.name}")`;
    } else if (f.input === "required" && !f.hidden) {
      value =
        f.derive && usesIt(f.derive)
          ? this.x.to(this.fieldRef(f.name, vt, fctx), vt)
          : this.inputMember(ctx.s, f.name);
    } else if (f.derive) {
      cls = this.fieldClass(ctx.s, f.name);
      if (f.input === "optional" && cls !== "value") {
        // Use the input when given, else compute after layout.
        c.chain([
          [
            `if (self->${this.model.member(f.name)})`,
            () =>
              this.emitFieldValue(f, `(*self->${this.model.member(f.name)})`, fctx, L, ext, "value")
          ],
          [
            "else",
            () => {
              const d = this.expr(f.derive!, fctx);
              this.emitFieldValue(f, this.x.to(d, vt), fctx, L, ext, cls);
            }
          ]
        ]);
        return;
      }
      value = this.x.to(this.fieldRef(f.name, vt, fctx), vt);
    } else value = this.inputMember(ctx.s, f.name);
    this.emitFieldValue(f, value, fctx, L, ext, cls);
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
    // Derived values are checked when computed (DERIVE), inputs before writing (CHECK). Constants
    // are correct by construction; their checks only matter on read.
    const checks = f.deriveKind === "constant" ? [] : f.checks.filter(ch => !ch.strictOnly);
    const vt = valueTypeOf(this.model, f.type);
    let v = value;
    if (!deferred && (checks.length || !/^[A-Za-z0-9_>.()*-]+$/.test(value))) {
      const tmp = c.fresh("val");
      c.line(`const auto& ${tmp} = ${value};`);
      v = tmp;
      this.emitWriteChecks(checks, v, vt, ctx, f.input !== "absent" ? "Check" : "Derive");
    }
    if (f.placement) {
      const P = c.fresh("P");
      const po = c.fresh("po");
      c.line(`yaffle::PlaceOptions ${po};`);
      if (f.placement.fixed)
        c.line(`${po}.fixed = ${this.x.asOffset(this.expr(f.placement.offset, ctx))};`);
      if (f.placement.constraint)
        c.line(
          `${po}.constraint = yaffle::Constraint{${f.placement.constraint.modulus}, ${f.placement.constraint.remainder}};`
        );
      // The extent exists before the content is written: its layers record stage sizes into it.
      if (ext) c.line(`w.open(${ext});`);
      const body = this.lambdaBody(() =>
        this.write(f.type, v, { ...ctx, extent: ext, raw: isOneWay(f.type) })
      );
      c.line(
        `yaffle::Placeable* ${P} = w.place(${str(f.name)}, [&]() -> yaffle::LEntry ${body}, ${po}, self);`
      );
      if (ext) c.line(`w.bind_extent(${ext}, ${P}${f.placement.emptyIsNull ? ", true" : ""});`);
      if (L) c.line(`${L}->set(${str(f.name)}, yaffle::lentry(${P}));`);
      if (!f.placement.fixed) {
        const off = this.expr(f.placement.offset, { ...ctx, deferred: true });
        if (off.code !== `${extentName(f.name)}->pos()`) {
          c.line(
            `w.defer_check([=, &w]() { yaffle::check_placement(${this.x.asOffset(off)}, ${P}, ${str(f.name)}); });`
          );
        }
      }
      return;
    }
    if (ext) c.line(`w.open(${ext});`);
    const entry = deferred
      ? this.writeDeferred(f.type, value, { ...ctx, extent: ext }, cls, checks)
      : this.write(f.type, v, { ...ctx, extent: ext, raw: isOneWay(f.type) });
    if (ext) c.line(`w.close(${ext});`);
    if (entry && L) c.line(`${L}->set(${str(f.name)}, ${entry});`);
  }

  private emitWriteChecks(
    checks: readonly IrCheck[],
    value: string,
    vt: IrValueType,
    ctx: WCtx,
    code: "Check" | "Derive"
  ): void {
    for (const ch of checks) {
      // `$end` is unknown while writing; such checks only apply on read.
      if (exprUses(ch.expr, e => e.kind === "builtinValue" && e.name === "end")) continue;
      const cond = this.expr(ch.expr, { ...ctx, it: { code: value, type: vt } }).code;
      this.code.line(
        `if (!(${cond})) yaffle::fail(yaffle::ErrorCode::${code}, ${str(`check failed: ${ch.message}`)});`
      );
    }
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
    const compute = (raw: string, ret: string, conv: (v: string) => string): string => {
      const body = new Code();
      body.block(`[=, &w]() -> ${ret}`, () => {
        body.line(`const auto it_ = ${raw};`);
        for (const ch of checks) {
          const cond = this.expr(ch.expr, {
            ...ctx,
            deferred: true,
            it: { code: "it_", type: vt }
          }).code;
          body.line(
            `if (!(${cond})) yaffle::fail(yaffle::ErrorCode::Derive, ${str(`check failed: ${ch.message}`)});`
          );
        }
        body.line(`return ${conv("it_")};`);
      });
      return body.toString();
    };
    const leaf = (tt: IrType, raw: string, lctx: WCtx): string | null => {
      const c = this.code;
      switch (tt.kind) {
        case "prim":
        case "enum": {
          const prim = tt.kind === "enum" ? this.model.enum(tt.enum).storage : tt.prim;
          const le = this.leOf(tt.endian, lctx);
          if (prim[0] === "f")
            c.line(
              `w.defer_float(yaffle::Prim::${prim}, ${le}, ${compute(raw, "double", v => `static_cast<double>(${v})`)}, ${phase});`
            );
          else
            c.line(
              `w.defer_prim(yaffle::Prim::${prim}, ${le}, ${compute(raw, "yaffle::i128", v => `static_cast<yaffle::i128>(${v})`)}, ${phase});`
            );
          return null;
        }
        case "bool":
          c.line(
            `w.defer_prim(yaffle::Prim::u8, true, ${compute(raw, "yaffle::i128", v => `(${v} ? 1 : 0)`)}, ${phase});`
          );
          return null;
        case "transform": {
          if (tt.write) {
            const w = this.expr(tt.write, {
              ...lctx,
              deferred: true,
              it: { code: `(${raw})`, type: tt.valueType }
            });
            return leaf(tt.inner, this.x.to(w, valueTypeOf(this.model, tt.inner)), lctx);
          }
          return leaf(tt.inner, raw, lctx);
        }
        case "layered":
          return this.emitLayers(
            tt.layers,
            lctx,
            inner => leaf(tt.inner, raw, inner),
            lctx.slot,
            lctx.extent
          );
        case "bytes":
        case "string": {
          const n = this.model.staticSize(tt);
          if (n !== undefined) {
            const conv =
              tt.kind === "string"
                ? (v: string) =>
                    `yaffle::encode_fixed_string(${v}, ${n}, ${tt.unit}, yaffle::Encoding::${tt.encoding}, ${this.leOf(tt.endian, lctx)})`
                : (v: string) => `yaffle::Bytes(${v})`;
            c.line(`w.defer_bytes(${n}, ${compute(raw, "yaffle::Bytes", conv)}, ${phase});`);
            return null;
          }
          break;
        }
        default:
          break;
      }
      throw new Error(`cannot write a deferred derived value of type ${tt.kind}`);
    };
    return leaf(t, value, ctx);
  }

  /** `{ …statements…; return entry; }` for `[&]() -> yaffle::LEntry` lambdas. */
  private lambdaBody(f: () => string | null): string {
    const saved = this.code;
    const inner = saved.child();
    this.code = inner;
    const entry = f();
    this.code = saved;
    const body = new Code();
    body.block("", () => {
      body.append(inner);
      body.line(entry ? `return yaffle::lentry(${entry});` : "return yaffle::LEntry();");
    });
    return body.toString();
  }

  // ── types ─────────────────────────────────────────────────────────────────

  /** Emits the write of `value` with type `t`; returns code of the produced layout entry, or null. */
  write(t: IrType, value: string, ctx: WCtx): string | null {
    const c = this.code;
    const refKey = this.model.isRefTarget(t) ? this.model.typeKey(t) : undefined;
    if (refKey) {
      const s = c.fresh("rs");
      c.line(`const std::int64_t ${s} = w.offset();`);
      const e = this.writeInner(t, value, ctx);
      c.line(`w.ref_site(${str(refKey)}, ${s}, yaffle::identity_of(${value}));`);
      return e;
    }
    return this.writeInner(t, value, ctx);
  }

  private writeInner(t: IrType, value: string, ctx: WCtx): string | null {
    const c = this.code;
    switch (t.kind) {
      case "prim":
        c.line(this.primWrite(t.prim, value, this.leOf(t.endian, ctx)));
        return null;
      case "bool":
        c.line(`w.boolean(${value});`);
        return null;
      case "string": {
        const le = t.unit === 1 ? "true" : this.leOf(t.endian, ctx);
        const mode =
          t.length.kind === "count" ? "Count" : t.length.kind === "until" ? "Until" : "Rest";
        const n = t.length.kind === "count" ? `, ${this.len(t.length.expr, ctx)}` : "";
        c.line(
          `w.str(${value}, ${t.unit}, yaffle::Encoding::${t.encoding}, ${le}, yaffle::Writer::StrMode::${mode}${n});`
        );
        return null;
      }
      case "bytes": {
        if (t.length.kind === "count") {
          const n = this.lengthCheck(t.length.expr, ctx, value);
          if (n === undefined) c.line(`w.bytes(${value});`);
          else c.line(`w.bytes_n(${value}, ${n});`);
        } else if (t.length.kind === "until") {
          c.line(`w.bytes_until(${value}, ${this.int(t.length.terminator, ctx)});`);
        } else c.line(`w.bytes(${value});`);
        return null;
      }
      case "array":
        return this.array(t, value, ctx);
      case "struct":
        return this.struct(t, value, ctx);
      case "enum": {
        const en = this.model.enum(t.enum);
        const name = this.model.enumName(t.enum);
        if (!en.open)
          c.line(
            `if (!valid_${name}(${value})) yaffle::fail(yaffle::ErrorCode::Check, "value is not a member of the enum");`
          );
        c.line(
          this.primWrite(
            en.storage,
            `static_cast<${primCppType(en.storage)}>(${value})`,
            this.leOf(t.endian, ctx)
          )
        );
        return null;
      }
      case "pointer":
        return this.pointer(t, value, ctx);
      case "extern": {
        const xd = this.model.extern(t.extern);
        const args = this.args(xd.params, t.args, ctx);
        const fixed = xd.kind === "type" && xd.fixedSize !== undefined ? xd.fixedSize : -1;
        c.line(
          `w.extern_write(${this.names.extern(t.extern)}, ${value}, ${fixed}${args.map(a => ", " + a).join("")});`
        );
        return null;
      }
      case "union": {
        const u = c.fresh("u");
        const l = c.fresh("l");
        const hasL = this.model.hasPlaceables(t);
        c.line(`const auto& ${u} = ${value};`);
        if (hasL) c.line(`yaffle::LEntry ${l};`);
        c.block(`switch (${u}.index())`, () => {
          t.variants.forEach((vr, i) => {
            c.line(`case ${i}: {`);
            c.indent(() => {
              const e = this.write(vr.type, `std::get<${i}>(${u})`, ctx);
              if (e && hasL) c.line(`${l} = yaffle::lentry(${e});`);
              c.line("break;");
            });
            c.line("}");
          });
          c.line(`default:`);
          c.indent(() =>
            c.line(`yaffle::fail(yaffle::ErrorCode::Input, "unknown union variant");`)
          );
        });
        return hasL ? l : null;
      }
      case "transform": {
        if (!t.write) {
          if (ctx.raw) return this.write(t.inner, value, { ...ctx, raw: false });
          // Below the field level the raw value of a one-way transform is not kept.
          c.line(
            `yaffle::fail(yaffle::ErrorCode::Input, "not implemented: writing a one-way transform below the field level");`
          );
          return null;
        }
        const val = c.fresh("tv");
        c.line(`const auto& ${val} = ${value};`);
        const raw = c.fresh("raw");
        const innerVt = valueTypeOf(this.model, t.inner);
        const w = this.expr(t.write, { ...ctx, it: { code: val, type: t.valueType } });
        c.line(`const ${this.types.type(t.inner)} ${raw} = ${this.x.to(w, innerVt)};`);
        // Round trip: read(write(v)) must give v back (floats: within half a storage step).
        const back = this.expr(t.read, { ...ctx, it: { code: raw, type: innerVt } });
        if (t.valueType.kind === "float" && innerVt.kind === "int") {
          const rawNext = `(static_cast<yaffle::i128>(${raw}) + 1)`;
          const next = this.expr(t.read, {
            ...ctx,
            it: { code: rawNext, type: { kind: "bigint" } }
          });
          c.line(
            `yaffle::check_float_round_trip(static_cast<double>(${val}), ${this.x.asF64(back)}, ${this.x.asF64(next)});`
          );
        } else {
          c.line(`yaffle::check_round_trip(${val}, ${this.x.to(back, t.valueType)});`);
        }
        return this.write(t.inner, raw, ctx);
      }
      case "layered":
        return this.emitLayers(
          t.layers,
          ctx,
          inner => this.write(t.inner, value, inner),
          ctx.slot,
          ctx.extent
        );
    }
  }

  /**
   * The length a count expression gives, for checking the written value. When it depends on sizes
   * or positions, the check runs after layout instead and this returns undefined.
   */
  lengthCheck(e: IrExpr, ctx: WCtx, value: string): string | undefined {
    if (this.deriveClass(ctx.s, e) === "value") return this.len(e, ctx);
    const m = this.code.fresh("m");
    const sz = this.code.fresh("sz");
    this.code.line(`const yaffle::Mark ${m} = w.mark();`);
    this.code.line(`const std::int64_t ${sz} = yaffle::size_of(${value});`);
    const n = this.int(e, {
      ...ctx,
      deferred: true,
      offsetCode: `${m}.abs()`,
      endCode: `static_cast<std::int64_t>(${m}.block->region->output->size())`
    });
    this.code.line(`w.defer_check([=, &w]() { yaffle::check_length(${sz}, ${n}); });`);
    return undefined;
  }

  primWrite(p: string, value: string, le: string): string {
    switch (p) {
      case "u8":
        return `w.u8(${value});`;
      case "u16":
      case "u32":
      case "u64":
        return `w.uint(${primSize(p)}, ${value}, ${le});`;
      case "i8":
      case "i16":
      case "i32":
      case "i64":
        return `w.uint(${primSize(p)}, static_cast<std::uint64_t>(${value}), ${le});`;
      case "f16":
        return `w.f16(${value}, ${le});`;
      case "f32":
        return `w.f32(${value}, ${le});`;
      case "f64":
        return `w.f64(${value}, ${le});`;
      default:
        return `w.prim(yaffle::Prim::${p}, static_cast<yaffle::i128>(${value}), ${le});`;
    }
  }

  struct(
    t: Extract<IrType, { kind: "struct" }>,
    value: string,
    ctx: WCtx,
    layersOverride?: readonly IrLayer[]
  ): string | null {
    const s = this.model.struct(t.struct);
    const layers =
      layersOverride ?? (s.base ? s.layers.filter(l => l.kind !== "alignEnd") : s.layers);
    const obj = this.model.isShared(t.struct) ? `yaffle::obj(${value})` : value;
    const call = (inner: WCtx): string | null => {
      const c = this.code;
      const args = this.structArgs(t.struct, t.args, inner);
      const callExpr = `write_${this.model.structName(t.struct)}(${["w", obj, ...args].join(", ")})`;
      if (this.returnsL(s)) {
        const l = c.fresh("l");
        c.line(`auto ${l} = ${callExpr};`);
        return l;
      }
      c.line(`${callExpr};`);
      return null;
    };
    if (!layers.length) return call(ctx);
    // Codec origins of struct-level layers are kept on the struct value itself.
    const lctx: WCtx = { ...ctx, meta: this.model.usesMeta(s) ? `${obj}.yaffle_meta_` : undefined };
    return this.emitLayers(
      layers,
      lctx,
      inner => call({ ...inner, meta: ctx.meta }),
      `${ctx.slot}#${s.name}`,
      undefined
    );
  }

  private array(t: Extract<IrType, { kind: "array" }>, value: string, ctx: WCtx): string | null {
    const c = this.code;
    const depth = ctx.depth;
    const a = c.fresh("a");
    const i = c.fresh("i");
    const hasL = this.model.hasPlaceables(t);
    c.line(`const auto& ${a} = ${value};`);
    if (t.length.kind === "count") {
      const n = this.lengthCheck(t.length.expr, ctx, a);
      if (n !== undefined) c.line(`yaffle::check_length(yaffle::size_of(${a}), ${n});`);
    }
    const la = hasL ? c.fresh("la") : undefined;
    if (la) c.line(`auto ${la} = std::make_shared<yaffle::LArray>();`);
    const setIndex = elementUsesIndex(this.model, t.element);
    if (setIndex) c.line(`yaffle::Restore<std::int64_t> ${c.fresh("rix")}(w.index);`);
    const ectx: WCtx = {
      ...ctx,
      raw: false,
      index: `static_cast<std::int64_t>(${i})`,
      depth: depth + 1,
      extent: undefined
    };
    const vt = valueTypeOf(this.model, t.element);
    let term: CExpr | undefined;
    if (t.length.kind === "until" || t.length.kind === "before")
      term = this.expr(t.length.terminator, ctx);
    const pred = t.length.kind === "untilPredicate" ? t.length.predicate : undefined;
    c.block(`for (std::size_t ${i} = 0; ${i} < ${a}.size(); ${i}++)`, () => {
      c.line(`fr.idx[${depth}] = static_cast<std::int64_t>(${i});`);
      if (setIndex) c.line(`w.index = static_cast<std::int64_t>(${i});`);
      const el = c.fresh("el");
      c.line(`const auto& ${el} = ${a}[${i}];`);
      if (term) {
        const eq = this.x.equality("==", this.x.typed(el, vt), term);
        c.line(
          `if (${eq}) yaffle::fail(yaffle::ErrorCode::Input, "an element equals the terminator");`
        );
      }
      if (pred) {
        const cond = this.expr(pred, { ...ctx, it: { code: el, type: vt } }).code;
        c.line(
          `if (static_cast<bool>(${cond}) != (${i} + 1 == ${a}.size())) yaffle::fail(yaffle::ErrorCode::Check, "until: only the last element may (and must) end the array");`
        );
      }
      if (t.elementPlacement) {
        const off = this.x.asOffset(this.expr(t.elementPlacement, ectx));
        const body = this.lambdaBody(() => this.write(t.element, el, ectx));
        const P = c.fresh("P");
        const po = c.fresh("po");
        c.line(`yaffle::PlaceOptions ${po};`);
        c.line(`${po}.fixed = ${off};`);
        c.line(
          `yaffle::Placeable* ${P} = w.place(${str(`${ctx.fieldName}[]`)}, [&]() -> yaffle::LEntry ${body}, ${po});`
        );
        if (la) c.line(`${la}->push(yaffle::lentry(${P}));`);
      } else {
        const e = this.write(t.element, el, ectx);
        if (la) c.line(`${la}->push(${e ? `yaffle::lentry(${e})` : "yaffle::LEntry()"});`);
      }
    });
    if (pred)
      c.line(
        `if (${a}.empty()) yaffle::fail(yaffle::ErrorCode::Check, "until: the array needs an element that ends it");`
      );
    if (term && t.length.kind === "until") {
      c.line(`fr.idx[${depth}] = static_cast<std::int64_t>(${a}.size());`);
      if (setIndex) c.line(`w.index = static_cast<std::int64_t>(${a}.size());`);
      const tv = c.fresh("term");
      c.line(`const ${this.types.type(t.element)} ${tv} = ${this.x.to(term, vt)};`);
      const e = this.write(t.element, tv, {
        ...ectx,
        index: `static_cast<std::int64_t>(${a}.size())`
      });
      if (la && e) c.line(`${la}->push(yaffle::lentry(${e}));`);
    }
    c.line(`fr.idx[${depth}] = -1;`);
    return la ?? null;
  }

  private pointer(
    t: Extract<IrType, { kind: "pointer" }>,
    value: string,
    ctx: WCtx
  ): string | null {
    const c = this.code;
    const tv = c.fresh("tv");
    c.line(`const auto& ${tv} = ${value};`);
    const nv =
      t.nullValue !== undefined
        ? `std::optional<yaffle::i128>(${intLit(BigInt(t.nullValue))})`
        : "std::nullopt";
    const le = this.leOf(t.storageEndian, ctx);
    const tctx: WCtx = { ...ctx, extent: undefined, raw: false };
    const shared = this.types.sharedTarget(t.target);
    const x = stripLayers(t.target);
    const optionalValue = !shared && t.nullValue !== undefined && !t.emptyIsNull;
    // `@nullable(empty)`: an empty array is written as the null value (no target).
    const isNull = t.emptyIsNull
      ? `(yaffle::size_of(${tv}) == 0)`
      : shared || optionalValue
        ? `!${tv}`
        : "false";
    const target = x.kind === "struct" ? tv : shared || optionalValue ? `(*${tv})` : tv;
    const ident = shared ? `${tv}.get()` : "nullptr";
    const origin = t.origin
      ? `, [=, &w]() -> std::int64_t { return ${this.x.asOffset(this.expr(t.origin, { ...ctx, deferred: true }))}; }`
      : "";
    if (t.ownership === "ref") {
      const body = this.lambdaBody(() => this.write(t.target, target, tctx));
      const enc = new Code();
      enc.block(`[=, &w]() mutable`, () => {
        enc.line(`yaffle::Frame fr;`);
        enc.line(`return w.encode_alone([&]() -> yaffle::LEntry ${body});`);
      });
      c.line(
        `w.ref_pointer(yaffle::Prim::${t.storage}, ${le}, ${str(this.model.typeKey(t.target))}, ${isNull}, ${ident}, ${enc.toString()}, ${t.relative}, ${nv}${origin});`
      );
      return null;
    }
    const P = c.fresh("P");
    const body = this.lambdaBody(() => this.write(t.target, target, tctx));
    const key = str(this.model.typeKey(t.target));
    c.line(
      `yaffle::Placeable* ${P} = ${isNull} ? nullptr : w.target(${ident}, ${key}, ${str(ctx.fieldName)}, [&]() -> yaffle::LEntry ${body}${ctx.depth === 0 ? ", yaffle::PlaceOptions{}, self" : ""});`
    );
    c.line(`w.pointer(yaffle::Prim::${t.storage}, ${le}, ${P}, ${t.relative}, ${nv}${origin});`);
    return P;
  }

  // ── bits ──────────────────────────────────────────────────────────────────

  emitBits(b: IrBits, ctx: WCtx): void {
    const c = this.code;
    const u = c.fresh("u");
    c.line(`std::uint64_t ${u} = 0;`);
    for (const f of b.fields) {
      if (f.name === null) continue;
      c.line(`fr.field = ${str(f.name)};`);
      const value = this.bitFieldValue(f, ctx);
      const bits = this.bitsOf(f, value, ctx);
      c.line(f.shift ? `${u} |= ${bits} << ${f.shift};` : `${u} |= ${bits};`);
    }
    c.line(`w.uint(${primSize(b.storage)}, ${u}, ${this.leOf(b.endian, ctx)});`);
  }

  private bitFieldValue(f: IrBitField, ctx: WCtx): string {
    const vt = valueTypeOf(this.model, f.type);
    let v: string;
    const override = this.st.overrides.get(f.name!);
    if (override) v = override;
    else if (f.input === "required") v = this.inputMember(ctx.s, f.name!);
    else if (f.derive) v = this.x.to(this.fieldRef(f.name!, vt, ctx), vt);
    else v = this.inputMember(ctx.s, f.name!);
    const checks = f.checks.filter(ch => !ch.strictOnly);
    if (checks.length) {
      const tmp = this.code.fresh("val");
      this.code.line(`const auto ${tmp} = ${v};`);
      this.emitWriteChecks(checks, tmp, vt, ctx, f.input === "absent" ? "Derive" : "Check");
      return tmp;
    }
    return v;
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

  private bitsOfType(t: IrType, value: string, width: number): string {
    if (t.kind === "bool") return `static_cast<std::uint64_t>(${value} ? 1 : 0)`;
    if (t.kind === "enum")
      return `yaffle::bits_of(static_cast<yaffle::i128>(${value}), ${width}, false)`;
    if (t.kind === "prim")
      return `yaffle::bits_of(static_cast<yaffle::i128>(${value}), ${width}, ${t.prim[0] === "i"})`;
    return `yaffle::bits_of(static_cast<yaffle::i128>(${value}), ${width}, false)`;
  }

  // ── layers ────────────────────────────────────────────────────────────────

  /** An alignment call: `w.align(to, fill)`, or with an origin or offset `w.align_at(…)`. */
  alignCall(l: Extract<IrLayer, { kind: "align" | "alignEnd" }>, ctx: WCtx): string {
    if (l.from !== "file" && !l.offset)
      return `w.align(${this.int(l.to, ctx)}, ${this.fill(l.fill, ctx)})`;
    const offset = l.offset ? this.int(l.offset, ctx) : "0";
    return `w.align_at(${this.int(l.to, ctx)}, ${this.fill(l.fill, ctx)}, ${l.from === "file"}, ${offset})`;
  }

  /** A base's or the root's `@alignEnd`: pads the whole region. */
  regionAlignEnd(l: Extract<IrLayer, { kind: "alignEnd" }>, ctx: WCtx): string {
    if (l.from !== "file" && !l.offset)
      return `w.region->align_end = yaffle::lcm(w.region->align_end, ${this.x.asI64(this.expr(l.to, ctx))});`;
    const offset = l.offset ? this.int(l.offset, ctx) : "0";
    return `w.region_align_end(${this.int(l.to, ctx)}, ${l.from === "file"}, ${offset});`;
  }

  /** Emits `layers` (the last is outermost) around `inner`; returns its layout entry. */
  emitLayers(
    layers: readonly IrLayer[],
    ctx: WCtx,
    inner: (ctx: WCtx) => string | null,
    slot: string,
    extent: string | undefined,
    idx = layers.length - 1
  ): string | null {
    if (idx < 0) return inner(ctx);
    const l = layers[idx]!;
    const c = this.code;
    const next = (x: WCtx): string | null => {
      const s = extent ? c.fresh("so") : undefined;
      if (s) c.line(`const std::int64_t ${s} = w.offset();`);
      const e = this.emitLayers(layers, x, inner, slot, extent, idx - 1);
      if (s) c.line(`${extent}->set_stage(${idx}, w.offset() - ${s});`);
      return e;
    };
    switch (l.kind) {
      case "align":
        c.line(`${this.alignCall(l, ctx)};`);
        return next(ctx);
      case "padBefore":
        c.line(`w.pad(${this.int(l.count, ctx)}, ${this.fill(l.fill, ctx)});`);
        return next(ctx);
      case "padAfter": {
        const e = next(ctx);
        c.line(`w.pad(${this.int(l.count, ctx)}, ${this.fill(l.fill, ctx)});`);
        return e;
      }
      case "padUntil": {
        const s = c.fresh("s");
        c.line(`const std::int64_t ${s} = w.offset();`);
        const e = next(ctx);
        c.line(`w.pad_until(${s}, ${this.int(l.size, ctx)}, ${this.fill(l.fill, ctx)});`);
        return e;
      }
      case "alignEnd": {
        const e = next(ctx);
        c.line(`${this.alignCall(l, ctx)};`);
        return e;
      }
      case "size": {
        const s = c.fresh("s");
        c.line(`const std::int64_t ${s} = w.offset();`);
        const e = next(ctx);
        c.line(`w.size_window(${s}, ${this.int(l.size, ctx)});`);
        return e;
      }
      case "via": {
        const codec = this.model.codec(l.codec);
        const args = this.args(codec.params, l.args, ctx);
        const plain = c.fresh("plain");
        const body = this.lambdaBody(() =>
          this.emitLayers(layers, ctx, inner, slot, extent, idx - 1)
        );
        c.line(
          `const yaffle::Bytes ${plain} = w.sub_region(nullptr, [&]() -> yaffle::LEntry ${body});`
        );
        if (extent) {
          c.line(`${extent}->set_stage(${idx}, static_cast<std::int64_t>(${plain}.size()));`);
          c.line(`if (!${extent}->plain) ${extent}->plain = ${plain};`);
        }
        const cc = c.fresh("cc");
        this.codecCtx(cc, args, sizeInside(layers, idx) ? `${plain}.size()` : undefined);
        const reuse = c.fresh("reuse");
        c.line(
          `const yaffle::Bytes* ${reuse} = ${ctx.meta ? `${ctx.meta}.reuse(yaffle::slot_key(${str(`${slot}#${idx}`)}, fr), ${plain})` : "nullptr"};`
        );
        c.line(`if (${reuse}) w.bytes(*${reuse});`);
        c.line(
          `else w.bytes(yaffle::codec_encode(${this.names.extern(l.codec)}, ${str(codec.name)}, ${plain}, ${cc}));`
        );
        return null;
      }
      case "endian": {
        const e = c.fresh("e");
        const le = c.fresh("le");
        c.line(`const yaffle::Endian ${e} = ${this.expr(l.value, ctx).code};`);
        c.line(`[[maybe_unused]] const bool ${le} = ${e} == yaffle::Endian::le;`);
        return next({ ...ctx, endian: e, le });
      }
      case "strict":
        return next(ctx);
    }
  }

  // ── streams ───────────────────────────────────────────────────────────────

  /** `from` fields: encode the value, then hand the bytes to the stream's source fields. */
  private emitStreamPrepass(s: IrStruct, ctx: WCtx): void {
    const c = this.code;
    const froms = this.model
      .fields(s)
      .map(f => f.field)
      .filter((f): f is IrField => f?.from !== undefined);
    // Later `from` fields first: a stream's source may itself be a `from` field (or a slice
    // carrier) whose value is only known once its own readers are encoded.
    const done = new Set<string>();
    for (let k = froms.length - 1; k >= 0; k--) {
      const fld = froms[k]!;
      if (done.has(fld.name)) continue;
      const root = streamRoot(fld.from!.stream);
      const group = froms.filter(
        g => !done.has(g.name) && rootKey(streamRoot(g.from!.stream).root) === rootKey(root.root)
      );
      for (const g of group) done.add(g.name);
      const encode = (g: IrField): string => {
        const enc = c.fresh("stream");
        const value = this.st.overrides.get(g.name) ?? this.inputMember(s, g.name);
        c.line(`fr.field = ${str(g.name)};`);
        const body = this.lambdaBody(() =>
          this.write(g.type, value, { ...ctx, fieldName: g.name })
        );
        c.line(
          `const yaffle::Bytes ${enc} = w.sub_region(nullptr, [&]() -> yaffle::LEntry ${body});`
        );
        return enc;
      };
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
        const start = r.start ? this.x.asOffset(this.expr(r.start, ctx)) : "0";
        const end = r.end
          ? `std::optional<std::int64_t>(${this.x.asOffset(this.expr(r.end, ctx))})`
          : "std::nullopt";
        parts.push(`yaffle::SlicePart{${str(g.name)}, ${start}, ${end}, &${enc}}`);
      }
      const length = this.carrierLength(s, root.root, ctx);
      const assembled = c.fresh("slices");
      c.line(`fr.field = ${str(root.root.kind === "field" ? root.root.field : fld.name)};`);
      c.line(
        `const yaffle::Bytes ${assembled} = yaffle::assemble_slices(${length}, {${parts.join(", ")}});`
      );
      this.streamTargets(root.root, assembled, s, ctx, policy);
    }
  }

  /**
   * Length of a sliced field: its own `count` length when that doesn't depend on the field
   * itself, else none (the largest slice end).
   */
  private carrierLength(s: IrStruct, root: IrStreamExpr, ctx: WCtx): string {
    if (root.kind !== "field") return "std::nullopt";
    const f = this.model.field(s, root.field)?.field;
    if (!f) return "std::nullopt";
    const t = stripLayers(f.type);
    if (t.kind !== "bytes" || t.length.kind !== "count") return "std::nullopt";
    if (this.refersTo(s, t.length.expr, root.field, [])) return "std::nullopt";
    return `std::optional<std::int64_t>(${this.len(t.length.expr, ctx)})`;
  }

  /** True if `e` (with derived fields inlined) references field `name`. */
  private refersTo(s: IrStruct, e: IrExpr, name: string, seen: string[]): boolean {
    let found = false;
    walkExpr(e, x => {
      if (found || x.kind !== "field") return;
      if (x.name === name) {
        found = true;
        return;
      }
      const d = this.inlinedDerive(s, x.name);
      if (d && !seen.includes(x.name)) found = this.refersTo(s, d, name, [...seen, x.name]);
    });
    return found;
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
      c.line(`const auto ${local} = std::make_shared<const yaffle::Bytes>(${bytes});`);
      this.st.overrides.set(st.field, `(*${local})`);
      return;
    }
    if (st.kind === "slice") {
      // Slices are assembled by the prepass and never reach here.
      throw new Error("internal: a stream slice reached streamTargets");
    }
    // each: split into the elements' bytes fields, by the pieces' size fields from the input,
    // else by the @split policy (fit: the longest piece whose element fits before the next one).
    const arr = this.model.field(s, st.array)?.field;
    if (!arr) throw new Error(`unknown stream array ${st.array}`);
    const el = stripLayers(arr.type);
    if (el.kind !== "array") throw new Error(`${st.array} is not an array`);
    const et = strip(el.element);
    if (et.kind !== "struct") throw new Error(`${st.array} elements are not structs`);
    const es = this.model.struct(et.struct);
    const piece = this.model.field(es, st.field)?.field;
    const sizeField = piece ? innerSizeField(piece.type) : undefined;
    const E = this.types.type(el.element);
    const ename = this.model.structName(et.struct);
    const shared = this.model.isShared(et.struct);
    const pm = this.model.member(st.field);
    const pieceOpt = this.model.isOptionalMember(es, st.field);
    const sizeOpt = sizeField !== undefined && this.model.isOptionalMember(es, sizeField);
    const local = c.fresh("els");
    const fit = c.fresh("fit");
    c.line(`std::optional<yaffle::FitPolicy<${E}>> ${fit};`);
    if (policy === "fit" && el.elementPlacement) {
      const off = this.x.asOffset(this.expr(el.elementPlacement, { ...ctx, index: "k_" }));
      const body = this.lambdaBody(() =>
        this.write(el.element, "e_", { ...ctx, index: "-1", fieldName: st.array })
      );
      const sizeFn = new Code();
      sizeFn.block(`[&](const ${E}& e_) -> std::int64_t`, () =>
        sizeFn.line(
          `return static_cast<std::int64_t>(w.encode_alone([&]() -> yaffle::LEntry ${body}).size());`
        )
      );
      c.line(
        `${fit} = yaffle::FitPolicy<${E}>{[&](std::int64_t k_) -> std::int64_t { return ${off}; }, ${sizeFn.toString()}};`
      );
    }
    const given = sizeField
      ? `[&](const ${E}& e_) -> std::optional<std::int64_t> { ${
          sizeOpt
            ? `const auto& s_ = yaffle::obj(e_).${this.model.member(sizeField)}; if (!s_) return std::nullopt; return static_cast<std::int64_t>(*s_);`
            : `return static_cast<std::int64_t>(yaffle::obj(e_).${this.model.member(sizeField)});`
        } }`
      : `[&](const ${E}&) -> std::optional<std::int64_t> { return std::nullopt; }`;
    const pieceOf = `[&](const ${E}& e_) -> const yaffle::Bytes& { return ${pieceOpt ? `yaffle::obj(yaffle::obj(e_).${pm})` : `yaffle::obj(e_).${pm}`}; }`;
    const mut = shared
      ? `auto c_ = std::make_shared<${ename}>(yaffle::obj(e_)); auto& o_ = *c_;`
      : `${E} c_ = e_; auto& o_ = c_;`;
    const clear = sizeOpt ? ` if (clear_) o_.${this.model.member(sizeField!)}.reset();` : "";
    const withPiece = `[&](const ${E}& e_, yaffle::Bytes p_, [[maybe_unused]] bool clear_) -> ${E} { ${mut} o_.${pm} = std::move(p_);${clear} return c_; }`;
    const elems = this.inputMember(s, st.array);
    c.line(
      `const auto ${local} = std::make_shared<const std::vector<${E}>>(yaffle::split_stream<${E}>(${elems}, ${bytes}, ${sizeField !== undefined}, ${given}, ${pieceOf}, ${withPiece}, ${fit}));`
    );
    this.st.overrides.set(st.array, `(*${local})`);
  }
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
  return f === "this" ? "x_this_" : `x_${f.replace(/[^A-Za-z0-9_]/g, "_")}_`;
}

/** Layout items as a C++ initializer: constant arguments, or compiled by `num` (instance layouts). */
function layoutLiteral(
  items: readonly IrLayoutItem[],
  num?: (e: IrExpr, what: LayoutArg) => string
): string {
  const parts = items.map(it => layoutItemLiteral(it, num));
  // Instance layouts are a statement in a writer: one line.
  return num ? `{${parts.join(", ")}}` : `{\n    ${parts.join(",\n    ")}\n}`;
}

function layoutItemLiteral(it: IrLayoutItem, num?: (e: IrExpr, what: LayoutArg) => string): string {
  const n = (e: IrExpr, what: LayoutArg): string => {
    const v = constLayoutArg(e, what);
    if (v !== undefined) return String(v);
    if (!num) throw new Error("not implemented: layout item layers with non-constant arguments");
    return num(e, what);
  };
  const layers = it.layers
    .map(l => {
      switch (l.kind) {
        case "align":
          if (l.from === "file" || l.offset)
            return `yaffle::layout_align_at(${n(l.to, "align")}, ${l.offset ? n(l.offset, "offset") : 0}, ${l.from === "file"})`;
          return `yaffle::layout_align(${n(l.to, "align")})`;
        case "alignEnd":
          return `yaffle::layout_align_end(${n(l.to, "align")})`;
        case "padBefore":
          return `yaffle::layout_pad_before(${n(l.count, "pad")})`;
        case "padAfter":
          return `yaffle::layout_pad_after(${n(l.count, "pad")})`;
        default:
          return undefined;
      }
    })
    .filter(Boolean);
  const ls = `{${layers.join(", ")}}`;
  if (it.path === "this") return `yaffle::layout_this(${ls})`;
  const path = it.path.map(seg => (seg.kind === "each" ? `"*"` : str(seg.name))).join(", ");
  if (it.group)
    return `yaffle::layout_group({${path}}, {${it.group.items.map(g => layoutItemLiteral(g, num)).join(", ")}}, ${ls})`;
  return `yaffle::layout_item({${path}}, ${ls})`;
}
