/**
 * Writer emitter: one `write_X` function per struct (plus `writeAsync_X` for async structs),
 * relocation-style code over `$rt.Writer` following docs/IR.md §3 and §4.
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
  IrFill,
  IrLayer,
  IrLayoutItem,
  IrMember,
  IrStreamExpr,
  IrStruct,
  IrType,
  IrValueType
} from "../../ir/index.ts";
import { Code, group, ident, prop, str, ungroup } from "./code.ts";
import { ExprCompiler, formatInt, type CExpr, type ExprCtx } from "./expr.ts";
import {
  Model,
  decodedSizeLayer,
  allMembers,
  forEachDerive,
  forEachExtentRef,
  forEachLayoutArg,
  forEachOrigin,
  forEachReadExpr,
  isOneWay,
  layoutUsesIndex,
  literalInt,
  primIsBig,
  someExpr,
  stripLayers,
  usesIndex,
  valueTypeOf,
  walkExpr,
  type LayoutArgKind
} from "./model.ts";
import type { ModuleCtx } from "./module.ts";
import type { TypeEmitter } from "./types.ts";

interface WCtx {
  s: IrStruct;
  endian: string;
  le: string;
  async: boolean;
  index: string;
  depth: number;
  it?: { code: string; type: IrValueType } | undefined;
  lambdas?: Map<string, string> | undefined;
  /** Inside a fixup closure: positions and sizes are final. */
  deferred: boolean;
  slot: string;
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

type DeriveClass = "value" | "size" | "position" | "content";

interface StructState {
  /** Fields (or "this") whose extent the struct's expressions use. */
  extents: Set<string>;
  /** Array nesting depth reached (path index variables `$i0`, `$i1`, …). */
  maxDepth: number;
  /** Derived fields being inlined (cycle detection). */
  inlining: string[];
  /** Fields whose value is a local computed earlier (stream pieces, slice carriers). */
  overrides: Map<string, string>;
}

function freshState(): StructState {
  return { extents: new Set(), maxDepth: 0, inlining: [], overrides: new Map() };
}

function rootCtx(s: IrStruct, async: boolean, slot: string, fieldName: string): WCtx {
  return {
    s,
    endian: "endian",
    le: "$le",
    async,
    index: "-1",
    depth: 0,
    deferred: false,
    slot,
    fieldName
  };
}

/** `(head) => $rt.encodeWith(($w) => { prelude; body })`. */
function encoderFn(head: string, prelude: readonly string[], body: Code): string {
  const out = new Code();
  out.line(`${head} =>`);
  out.indent(() => {
    out.line("$rt.encodeWith(($w) => {");
    out.indent(() => {
      for (const l of prelude) out.line(l);
      out.append(body);
    });
    out.line("})");
  });
  return out.toString();
}

export class WriteEmitter {
  readonly model: Model;
  readonly x: ExprCompiler;
  readonly types: TypeEmitter;
  readonly mod: ModuleCtx;
  private st!: StructState;
  private code!: Code;
  private readonly classMemo = new Map<string, DeriveClass>();

  constructor(model: Model, x: ExprCompiler, types: TypeEmitter, mod: ModuleCtx) {
    this.model = model;
    this.x = x;
    this.types = types;
    this.mod = mod;
  }

  /**
   * The struct's layout items as a hoisted constant, or "undefined" when it has none or when they
   * read fields (the struct's writer then sets them per instance on its `LStruct`, which the
   * layout engine prefers over the region's).
   */
  layoutConst(s: IrStruct): string {
    if (!s.layout || !s.layout.length || !layoutIsConstant(s.layout)) return "undefined";
    return this.mod.hoist(
      `${layoutLiteral(s.layout, constantLayoutArg)} as const`,
      `layout_${ident(s.name)}_`
    );
  }

  /**
   * Layout items that read fields as a TS expression evaluated in the struct's
   * write context (fields, params, `$index`), like its write formulas; undefined if constant.
   */
  private dynamicLayout(s: IrStruct, ctx: WCtx): string | undefined {
    if (!s.layout || !s.layout.length || layoutIsConstant(s.layout)) return undefined;
    return layoutLiteral(s.layout, (e, what) => {
      const v = literalInt(e);
      if (v !== undefined && (what === "offset" || v >= (what === "align" ? 1 : 0))) return `${v}`;
      const c = this.expr(e, ctx);
      if (what === "offset") return this.x.asOffset(c);
      return what === "align" ? `$rt.layoutAlign(${c.code})` : `$rt.len(${c.code}, "padding")`;
    });
  }

  emitStruct(out: Code, s: IrStruct, async: boolean): void {
    const name = this.model.structName(s.id);
    this.st = freshState();
    collectExtents(s, this.st.extents);
    const hasL = this.model.membersHavePlaceables(s.members);
    const body = new Code();
    this.code = body;
    const ctx = { ...rootCtx(s, async, name, ""), index: "$index" };
    this.emitStreamPrepass(s, ctx);
    this.emitMembers(s.members, ctx, hasL ? "$L" : undefined);
    const dynLayout = hasL ? this.dynamicLayout(s, ctx) : undefined;

    const params = s.params.map(p => `${ident(p.name)}: ${this.types.valueType(p.type, "out")}`);
    const fn = async ? `writeAsync_${name}` : `write_${name}`;
    const exported = !s.base && hasL;
    const ret = exported ? "$rt.LStruct" : "void";
    out.block(
      `export ${async ? "async " : ""}function ${fn}($w: $rt.Writer, $in: ${name}Input${params.map(p => ", " + p).join("")}): ${async ? `Promise<${ret}>` : ret}`,
      () => {
        if (s.params.some(p => p.origin === "endian")) out.line(`const $le = endian === "le";`);
        out.line(`const $v = $in as unknown as ${name}$W;`);
        const req = this.requiredFields(s.members);
        out.line(`$rt.need($v, [${req.map(str).join(", ")}]);`);
        if (usesIndex(s) || (dynLayout && layoutUsesIndex(s.layout!)))
          out.line(`const $index = $w.index;`);
        const emitBody = (): void => {
          if (s.base) {
            // A base's `@alignEnd` pads its whole region, after its targets.
            for (const l of s.layers) {
              if (l.kind === "alignEnd") out.line(`${this.regionAlignEnd(l, ctx)};`);
            }
          }
          if (hasL) out.line(`const $L = new $rt.LStruct(${this.layoutConst(s)});`);
          for (const f of this.st.extents) {
            if (f === "this") {
              // `sizeof(this)` / `offsetof(this)`: the struct itself (a base: its whole region).
              out.line(`const $x_this_ = ${s.base ? "$w.regionExtent()" : "$w.extent()"};`);
            } else out.line(`let $x_${ident(f)}!: $rt.Extent;`);
          }
          out.line(`let $f = "";`);
          for (let i = 0; i < this.st.maxDepth; i++) out.line(`let $i${i} = -1;`);
          const idx = Array.from({ length: this.st.maxDepth }, (_, i) => `, $i${i}`).join("");
          // The frame lets fixups that run after layout report this struct's path.
          out.line(`$w.enter(() => [$f${idx}]);`);
          out.chain([
            [
              "try",
              () => {
                out.append(body);
                if (this.st.extents.has("this") && !s.base) out.line(`$w.close($x_this_);`);
                if (dynLayout) {
                  // Item arguments read the struct's fields, once all of them are written.
                  out.line(`$f = "";`);
                  out.line(`$L.layout = ${dynLayout};`);
                }
              }
            ],
            ["catch ($e)", () => out.line(`$rt.rethrowAt($e, $f${idx});`)],
            ["finally", () => out.line(`$w.leave();`)]
          ]);
          if (hasL) out.line("return $L;");
        };
        if (s.base) {
          const call = async ? "await $w.baseAsync" : "$w.base";
          out.line(`${call}(${this.layoutConst(s)}, ${async ? "async " : ""}() => {`);
          out.indent(emitBody);
          out.line(`}, $in);`);
        } else emitBody();
      }
    );
  }

  /** Emits the write of a root struct (params are locals); returns the layout entry or null. */
  rootWrite(out: Code, s: IrStruct, value: string, async: boolean): string | null {
    this.st = freshState();
    this.code = out;
    const ctx = rootCtx(s, async, this.model.structName(s.id), "");
    const args: IrExpr[] = s.params.map(p => ({ kind: "param", name: p.name, type: p.type }));
    if (!s.base) {
      // The root is its file's base: `@alignEnd` pads the whole region, after the targets.
      const ends = s.layers.filter(l => l.kind === "alignEnd");
      for (const l of ends) {
        if (l.kind === "alignEnd") out.line(`${this.regionAlignEnd(l, ctx)};`);
      }
      if (ends.length) {
        return this.struct(
          s.id,
          args,
          value,
          ctx,
          s.layers.filter(l => l.kind !== "alignEnd")
        );
      }
    }
    return this.struct(s.id, args, value, ctx);
  }

  /**
   * A view patch encoder for a scalar field: `($val, $v, ...params) => bytes`, or undefined if the
   * field's encoding depends on sizes, positions or targets (then setting it is structural).
   */
  encoderFor(s: IrStruct, name: string): string | undefined {
    const fr = this.model.field(s, name);
    if (!fr) return undefined;
    const f = fr.field;
    if (f && (f.placement || f.from || f.virtual || !patchableType(f.type))) return undefined;
    const sname = this.model.structName(s.id);
    const ctx = rootCtx(s, false, `${sname}.${name}`, name);
    let valType = "";
    const body = this.encoderBody(() => {
      if (f) {
        valType = this.types.fieldType(f, "in");
        const checks = f.deriveKind === "constant" ? [] : f.checks.filter(ch => !ch.strictOnly);
        this.emitWriteChecks(checks, "$val", valueTypeOf(this.model, f.type), ctx, "CHECK");
        return !this.write(f.type, "$val", ctx);
      }
      const bits = [...allMembers(s.members)].find(
        (m): m is IrBits => m.kind === "bits" && m.fields.some(b => b.name === name)
      );
      if (!bits) return false;
      valType = this.types.type(fr.bit!.type, "in");
      this.emitBits(bits, ctx);
      return true;
    });
    if (!body) return undefined;
    const params = s.params.map(p => `, ${ident(p.name)}: ${this.types.valueType(p.type, "out")}`);
    const prelude = s.params.some(p => p.origin === "endian")
      ? [`const $le = endian === "le";`]
      : [];
    prelude.push(`let $f = ${str(name)};`, `void $f;`);
    return encoderFn(`($val: ${valType}, $v: ${sname}$W${params.join("")})`, prelude, body);
  }

  /** Encoder for one element of a lazy scalar array (uses the scan function's `$le`). */
  elementEncoder(s: IrStruct, t: IrType): string | undefined {
    if (!patchableType(t) || t.kind === "transform") return undefined;
    const ctx = rootCtx(s, false, "", "");
    const body = this.encoderBody(() => !this.write(t, "$val", ctx));
    return body && encoderFn(`($val: ${this.types.type(t, "in")})`, [], body);
  }

  /**
   * The code `emit` writes with a fresh struct state, or undefined if it returned false, threw, or
   * needed extents (sizes or positions).
   */
  private encoderBody(emit: () => boolean): Code | undefined {
    const saved = { code: this.code, st: this.st };
    this.st = freshState();
    const body = new Code();
    this.code = body;
    try {
      return emit() && !this.st.extents.size ? body : undefined;
    } catch {
      return undefined;
    } finally {
      this.code = saved.code;
      this.st = saved.st;
    }
  }

  /** Checks that the input has the fields a conditional branch requires. */
  private needBranchFields(ms: readonly IrMember[]): void {
    const req = this.requiredFields(ms);
    if (req.length) this.code.line(`$f = "";`).line(`$rt.need($v, [${req.map(str).join(", ")}]);`);
  }

  private emitBranch(ms: readonly IrMember[], ctx: WCtx, L: string | undefined): void {
    this.needBranchFields(ms);
    this.emitMembers(ms, ctx, L);
  }

  /** Required input fields of the unconditional part of a member list. */
  requiredFields(ms: readonly IrMember[]): string[] {
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

  // ── derive classification ─────────────────────────────────────────────────

  deriveClass(s: IrStruct, e: IrExpr, seen: string[] = []): DeriveClass {
    let cls: DeriveClass = "value";
    const bump = (c: DeriveClass): void => {
      const rank = { value: 0, size: 1, position: 2, content: 3 };
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
        if (d && input !== "required" && !seen.includes(x.name)) {
          bump(this.fieldClass(s, x.name, [...seen, x.name]));
        }
      }
    });
    return cls;
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
    const s = ctx.s;
    return {
      mode: "write",
      field: (name, type) => this.fieldRef(name, type, ctx),
      param: (name, type) => {
        const p = s.params.find(q => q.name === name);
        if (p?.origin === "endian" || name === "endian") return { code: ctx.endian, repr: "other" };
        return this.x.typed(ident(name), type);
      },
      it: type => {
        if (!ctx.it) throw new Error("`it` used outside a check or transform");
        return this.x.typed(ctx.it.code, ctx.it.type ?? type);
      },
      lambda: name => ctx.lambdas?.get(name) ?? ident(name),
      builtin: name => {
        if (name === "offset") return ctx.offsetCode ?? "$w.position";
        if (name === "end")
          return ctx.endCode ?? '$rt.fail("DERIVE", "$end is not available on write")';
        return ctx.index;
      },
      sizeof: f => `${this.extentVar(f)}.size`,
      offsetof: f => `${this.extentVar(f)}.pos`,
      encodedSize: (f, k) => `${this.extentVar(f)}.stage(${k})`,
      bytesof: f => `${this.extentVar(f)}.bytes()`,
      encode: f => `${this.extentVar(f)}.plainBytes()`,
      externFn: id => this.mod.extern(id),
      hoist: (code, hint) => this.mod.hoist(code, hint),
      fieldType: name => this.model.field(s, name)?.field?.type
    };
  }

  private extentVar(f: string): string {
    if (!this.st.extents.has(f)) this.st.extents.add(f);
    return `$x_${ident(f)}`;
  }

  /** A field reference in the write context: input value, or the inlined derive. */
  fieldRef(name: string, type: IrValueType, ctx: WCtx): CExpr {
    const override = this.st.overrides.get(name);
    if (override) return this.x.typed(override, type);
    const f = this.model.field(ctx.s, name);
    if (!f) throw new Error(`unknown field ${name} in ${ctx.s.name}`);
    const input = f.field ? f.field.input : f.bit!.input;
    const derive = f.field ? f.field.derive : f.bit!.derive;
    const hidden = f.field?.hidden ?? false;
    const inputCode = (): CExpr => {
      const code = prop("$v", name);
      const c = this.x.typed(code, type);
      if (c.repr === "big") return { ...c, code: `$rt.big(${code})` };
      return c;
    };
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
      const i = inputCode();
      if (d.repr === "big" || i.repr === "big") {
        return {
          code: `(${prop("$v", name)} !== undefined ? ${this.x.asBig(i)} : ${this.x.asBig(d)})`,
          repr: "big",
          range: d.range ?? i.range!
        };
      }
      return { ...d, code: `(${prop("$v", name)} !== undefined ? ${i.code} : ${d.code})` };
    }
    return d;
  }

  expr(e: IrExpr, ctx: WCtx): CExpr {
    return this.x.compile(e, this.exprCtx(ctx));
  }

  len(e: IrExpr, ctx: WCtx): string {
    return this.x.asLen(this.expr(e, ctx));
  }

  num(e: IrExpr, ctx: WCtx): string {
    return this.x.asOffset(this.expr(e, ctx));
  }

  // ── members ───────────────────────────────────────────────────────────────

  emitMembers(ms: readonly IrMember[], ctx: WCtx, L: string | undefined): void {
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
              undefined
            );
          };
          if (m.condition) {
            const cond = this.expr(m.condition, ctx).code;
            const parts: [string, () => void][] = [
              [
                `if (${ungroup(cond)})`,
                () => {
                  this.needBranchFields(m.members);
                  body();
                }
              ]
            ];
            const els = m.else;
            if (els) parts.push(["else", () => this.emitBranch(els, ctx, L)]);
            c.chain(parts);
          } else c.block("", body);
          break;
        }
        case "switch": {
          const d = c.fresh("$d");
          const disc = this.expr(m.discriminant, ctx);
          c.line(`const ${d} = ${disc.code};`);
          const dExpr: CExpr = { ...disc, code: d };
          const branch = (members: readonly IrMember[]): void => this.emitBranch(members, ctx, L);
          const parts: [string, () => void][] = [];
          for (const cs of m.cases) {
            const conds = cs.values.map(v =>
              this.x.equality(
                "==",
                dExpr,
                this.x.literal(v, m.discriminant.type, this.exprCtx(ctx))
              )
            );
            parts.push([
              `${parts.length ? "else if" : "if"} (${conds.join(" || ")})`,
              () => branch(cs.members)
            ]);
          }
          const def = m.default;
          const last = def
            ? () => branch(def)
            : () => c.line(`$rt.fail("CHECK", \`no case matches \${String(${d})}\`);`);
          if (parts.length) c.chain([...parts, ["else", last]]);
          else if (def) c.block("", last);
          else last();
          break;
        }
      }
    }
  }

  /** The value written for a field: input, or derive (immediately or as a fixup). */
  emitField(f: IrField, ctx: WCtx, L: string | undefined): void {
    const c = this.code;
    if (f.from) {
      // Encoded by the stream prepass into its source fields; takes no space here.
      return;
    }
    c.line(`$f = ${str(f.name)};`);
    const fctx: WCtx = { ...ctx, slot: `${ctx.s.id}.${f.name}`, fieldName: f.name };
    if (f.virtual) {
      this.emitVirtual(f, fctx);
      return;
    }
    const ext = this.st.extents.has(f.name) ? `$x_${ident(f.name)}` : undefined;
    const vt = valueTypeOf(this.model, f.type);
    let value: string;
    let deferredClass: DeriveClass = "value";
    const override = this.st.overrides.get(f.name);
    if (override) value = override;
    else if (f.input === "required" && !f.hidden) {
      // `u8 flags = it | 0x80`: the input is normalized by the formula on write.
      value =
        f.derive && usesIt(f.derive)
          ? this.x.to(this.fieldRef(f.name, vt, fctx), vt)
          : prop("$v", f.name);
      // One-way transforms take the raw value: a parse result or a view holds the transformed
      // one and remembers the raw value it was read from.
      if (isOneWay(f.type) && value === prop("$v", f.name)) {
        value = `($rt.rawInput($v, ${str(f.name)}, ${value}) as typeof ${value})`;
      }
    } else if (f.derive) {
      deferredClass = this.fieldClass(ctx.s, f.name);
      if (f.input === "optional" && deferredClass !== "value") {
        // Use the input when given, else compute after layout.
        const present = `${prop("$v", f.name)} !== undefined`;
        c.block(`if (${present})`, () =>
          this.emitFieldValue(f, prop("$v", f.name), fctx, L, ext, "value")
        );
        c.block("else", () => {
          const d = this.expr(f.derive!, fctx);
          this.emitFieldValue(f, this.x.to(d, vt), fctx, L, ext, deferredClass);
        });
        return;
      }
      const d = this.fieldRef(f.name, vt, fctx);
      value = this.x.to(d, vt);
    } else value = prop("$v", f.name);
    this.emitFieldValue(f, value, fctx, L, ext, deferredClass);
  }

  /**
   * `virtual u40 size = (sizeHigh << 32) | sizeLow`: no bytes. The value comes from
   * the input (or its default); the fields it is computed from derive themselves from it. Here the
   * value is validated and the read expression must give it back (DERIVE otherwise).
   */
  private emitVirtual(f: IrField, ctx: WCtx): void {
    const c = this.code;
    const vt = valueTypeOf(this.model, f.type);
    const val = c.fresh("$val");
    c.line(`const ${val} = ${this.x.to(this.fieldRef(f.name, vt, ctx), vt)};`);
    const t = stripLayers(f.type);
    if (t.kind === "prim" && t.prim[0] !== "f") c.line(`$rt.checkPrim(${val}, ${str(t.prim)});`);
    const checks = f.checks.filter(ch => !ch.strictOnly);
    this.emitWriteChecks(checks, val, vt, ctx, f.input === "absent" ? "DERIVE" : "CHECK");
    const later = this.deriveClass(ctx.s, f.virtual!.read) !== "value";
    const back = this.expr(f.virtual!.read, { ...ctx, deferred: later });
    const check = `$rt.checkVirtual(${val}, ${this.x.to(back, vt)}, ${str(f.name)})`;
    c.line(later ? `$w.deferCheck(() => ${check});` : `${check};`);
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
    const vt = valueTypeOf(this.model, f.type);
    let v = value;
    if (!deferred && (checks.length || /[^A-Za-z0-9_$.]/.test(value))) {
      const tmp = c.fresh("$val");
      c.line(`const ${tmp} = ${value};`);
      v = tmp;
      this.emitWriteChecks(checks, v, vt, ctx, f.input !== "absent" ? "CHECK" : "DERIVE");
    }
    if (f.placement) {
      const P = c.fresh("$P");
      const opts: string[] = [];
      if (f.placement.fixed) opts.push(`fixed: ${this.num(f.placement.offset, ctx)}`);
      if (f.placement.constraint) {
        opts.push(
          `constraint: { modulus: ${f.placement.constraint.modulus}, remainder: ${f.placement.constraint.remainder} }`
        );
      }
      // The extent exists before the content is written: its layers record stage sizes into it.
      if (ext) c.line(`${ext} = $w.pendingExtent();`);
      const body = this.inClosure(() => this.write(f.type, v, { ...ctx, extent: ext }));
      const optText = `, ${opts.length ? `{ ${opts.join(", ")} }` : "undefined"}, $in`;
      if (ctx.async)
        c.line(
          `const ${P} = await $w.placeAsync(${str(f.name)}, ${v}, async () => ${body}${optText});`
        );
      else c.line(`const ${P} = $w.place(${str(f.name)}, ${v}, () => ${body}${optText});`);
      if (ext) c.line(`$w.bindExtent(${ext}, ${P}${f.placement.emptyIsNull ? ", true" : ""});`);
      if (L) c.line(`${L}.set(${str(f.name)}, ${P});`);
      if (!f.placement.fixed) {
        const off = this.expr(f.placement.offset, { ...ctx, deferred: true });
        if (!isTrivialOffset(off.code, f.name)) {
          c.line(
            `$w.deferCheck(() => $rt.checkPlacement(${this.x.asNum(off)}, ${P}, ${str(f.name)}));`
          );
        }
      }
      return;
    }
    if (ext) c.line(`${ext} = $w.extent();`);
    const entry = deferred
      ? this.writeDeferred(f.type, value, { ...ctx, extent: ext }, cls, checks)
      : this.write(f.type, v, { ...ctx, extent: ext });
    if (ext) c.line(`$w.close(${ext});`);
    if (entry && L) c.line(`${L}.set(${str(f.name)}, ${entry});`);
  }

  private emitWriteChecks(
    checks: readonly IrCheck[],
    value: string,
    vt: IrValueType,
    ctx: WCtx,
    code: "CHECK" | "DERIVE"
  ): void {
    for (const ch of checks) {
      // `$end` is unknown while writing; such checks only apply on read.
      if (someExpr(ch.expr, e => e.kind === "builtinValue" && e.name === "end")) continue;
      const cond = this.expr(ch.expr, { ...ctx, it: { code: value, type: vt } }).code;
      this.code.line(
        `if (!${group(cond)}) $rt.fail(${str(code)}, ${str(`check failed: ${ch.message}`)});`
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
    const compute = (raw: string): string => {
      if (!checks.length) return `() => ${raw}`;
      const body = new Code();
      body.line("() => {");
      body.indent(() => {
        body.line(`const $it = ${raw};`);
        for (const ch of checks) {
          const cond = this.expr(ch.expr, {
            ...ctx,
            deferred: true,
            it: { code: "$it", type: vt }
          }).code;
          body.line(
            `if (!${group(cond)}) $rt.fail("DERIVE", ${str(`check failed: ${ch.message}`)});`
          );
        }
        body.line("return $it;");
      });
      body.line("}");
      return body.toString();
    };
    const leaf = (tt: IrType, raw: string, lctx: WCtx): string | null => {
      const c = this.code;
      switch (tt.kind) {
        case "prim":
          c.line(
            `$w.deferPrim(${str(tt.prim)}, ${this.leOf(tt.endian, lctx)}, ${compute(raw)}, ${phase});`
          );
          return null;
        case "bool":
          c.line(`$w.deferPrim("u8", true, ${compute(`(${raw} ? 1 : 0)`)}, ${phase});`);
          return null;
        case "enum": {
          const en = this.model.enum(tt.enum);
          c.line(
            `$w.deferPrim(${str(en.storage)}, ${this.leOf(tt.endian, lctx)}, ${compute(`$rt.enumValue(${this.mod.enumRef(tt.enum, "values")}, ${raw})`)}, ${phase});`
          );
          return null;
        }
        case "pointer":
        case "transform": {
          if (tt.kind === "transform" && tt.write) {
            const it = `(${raw})`;
            const w = this.expr(tt.write, {
              ...lctx,
              deferred: true,
              it: { code: it, type: tt.valueType }
            });
            return leaf(tt.inner, this.x.to(w, valueTypeOf(this.model, tt.inner)), lctx);
          }
          if (tt.kind === "transform") return leaf(tt.inner, raw, lctx);
          break;
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
          if (n !== undefined) {
            const conv =
              tt.kind === "string"
                ? `$rt.encodeFixedString(${raw}, ${n}, ${tt.unit}, ${str(tt.encoding)}, ${this.leOf(tt.endian, lctx)})`
                : raw;
            c.line(`$w.deferBytes(${n}, ${compute(conv)}, ${phase});`);
            return null;
          }
          break;
        }
      }
      throw new Error(`cannot write a deferred derived value of type ${tt.kind}`);
    };
    return leaf(t, value, ctx);
  }

  /** Emits what `f` emits as an arrow body returning `f`'s expression. */
  private closureOf(f: () => string): string {
    const saved = this.code;
    const inner = saved.child();
    this.code = inner;
    const v = f();
    this.code = saved;
    const body = new Code();
    body.line("{");
    body.indent(() => {
      body.append(inner);
      body.line(`return ${v};`);
    });
    body.line("}");
    return body.toString();
  }

  private inClosure(f: () => string | null): string {
    const saved = this.code;
    const inner = saved.child();
    this.code = inner;
    const entry = f();
    this.code = saved;
    const body = new Code();
    body.line("{");
    body.indent(() => {
      body.append(inner);
      if (entry) body.line(`return ${entry};`);
    });
    body.line("}");
    return body.toString();
  }

  // ── types ─────────────────────────────────────────────────────────────────

  /** Emits the write of `value` with type `t`; returns code of the produced layout entry, or null. */
  write(t: IrType, value: string, ctx: WCtx): string | null {
    const c = this.code;
    const refKey = this.model.isRefTarget(t) ? this.model.typeKey(t) : undefined;
    if (refKey) {
      const s = c.fresh("$rs");
      c.line(`const ${s} = $w.offset;`);
      const e = this.writeInner(t, value, ctx);
      c.line(`$w.refSite(${str(refKey)}, ${s}, ${value});`);
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
        c.line(`$w.bool(${value});`);
        return null;
      case "string": {
        const le = t.unit === 1 ? "true" : this.leOf(t.endian, ctx);
        const mode = t.length.kind;
        const n = t.length.kind === "count" ? `, ${this.len(t.length.expr, ctx)}` : "";
        c.line(`$w.str(${value}, ${t.unit}, ${str(t.encoding)}, ${le}, ${str(mode)}${n});`);
        return null;
      }
      case "bytes": {
        if (t.length.kind === "count") {
          const n = this.lengthCheck(t.length.expr, ctx, value);
          if (n === undefined) c.line(`$w.bytes(${value});`);
          else c.line(`$w.bytesN(${value}, ${n});`);
        } else if (t.length.kind === "until") {
          c.line(`$w.bytesUntil(${value}, ${this.x.asNum(this.expr(t.length.terminator, ctx))});`);
        } else c.line(`$w.bytes(${value});`);
        return null;
      }
      case "array":
        return this.array(t, value, ctx);
      case "struct":
        return this.struct(t.struct, t.args, value, ctx);
      case "enum": {
        const en = this.model.enum(t.enum);
        c.line(
          this.primWrite(
            en.storage,
            `$rt.enumValue(${this.mod.enumRef(t.enum, "values")}, ${value})`,
            this.leOf(t.endian, ctx)
          )
        );
        return null;
      }
      case "pointer":
        return this.pointer(t, value, ctx);
      case "extern": {
        const x = this.model.extern(t.extern);
        const args = this.x.args(t.args, x.params, this.exprCtx(ctx));
        const fixed = x.kind === "type" && x.fixedSize !== undefined ? x.fixedSize : -1;
        c.line(
          `$w.extern(${this.mod.extern(t.extern)}, ${value}, [${args.join(", ")}], ${fixed});`
        );
        return null;
      }
      case "union": {
        const u = c.fresh("$u");
        const l = c.fresh("$l");
        const hasL = this.model.hasPlaceables(t);
        c.line(`const ${u} = $rt.unionValue(${value});`);
        if (hasL) c.line(`let ${l}: $rt.LEntry | undefined;`);
        c.block(`switch (${u}.type)`, () => {
          for (const vr of t.variants) {
            c.line(`case ${str(vr.name)}: {`);
            c.indent(() => {
              const e = this.write(
                vr.type,
                `(${u}.value as ${this.types.type(vr.type, "in")})`,
                ctx
              );
              if (e && hasL) c.line(`${l} = ${e};`);
              c.line("break;");
            });
            c.line("}");
          }
          c.line(`default:`);
          c.indent(() =>
            c.line(`$rt.fail("INPUT", \`unknown union variant \${String(${u}.type)}\`);`)
          );
        });
        return hasL ? l : null;
      }
      case "transform": {
        if (!t.write) return this.write(t.inner, value, ctx);
        const val = c.fresh("$tv");
        c.line(`const ${val} = ${value};`);
        const raw = c.fresh("$raw");
        const innerVt = valueTypeOf(this.model, t.inner);
        const w = this.expr(t.write, { ...ctx, it: { code: val, type: t.valueType } });
        c.line(`const ${raw} = ${this.x.to(w, innerVt)};`);
        // Round trip: read(write(v)) must give v back (floats: within half a storage step).
        const back = this.expr(t.read, { ...ctx, it: { code: raw, type: innerVt } });
        if (t.valueType.kind === "float" && innerVt.kind === "int") {
          const rawNext = innerVt.bits > 48 ? `(${raw} + 1n)` : `(${raw} + 1)`;
          const next = this.expr(t.read, { ...ctx, it: { code: rawNext, type: innerVt } });
          c.line(
            `$rt.checkFloatRoundTrip(${val}, ${this.x.to(back, t.valueType)}, ${this.x.to(next, t.valueType)});`
          );
        } else {
          c.line(`$rt.checkRoundTrip(${val}, ${this.x.to(back, t.valueType)});`);
        }
        return this.write(t.inner, raw, ctx);
      }
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

  /**
   * The length a count expression gives, for checking the written value. When it depends on
   * sizes or positions (`u8 gap[tOfs - 0x19 - $offset]`), the check runs after layout instead and
   * this returns undefined.
   */
  lengthCheck(e: IrExpr, ctx: WCtx, value: string): string | undefined {
    if (this.deriveClass(ctx.s, e) === "value") return this.len(e, ctx);
    const m = this.code.fresh("$m");
    this.code.line(`const ${m} = $w.mark();`);
    const n = this.len(e, {
      ...ctx,
      deferred: true,
      offsetCode: `(${m}.block.pos + ${m}.at)`,
      endCode: `${m}.block.region.output!.length`
    });
    this.code.line(`$w.deferCheck(() => $rt.checkLength($rt.arrayValue(${value}).length, ${n}));`);
    return undefined;
  }

  leOf(e: "le" | "be" | "inherit", ctx: WCtx): string {
    return e === "inherit" ? ctx.le : e === "le" ? "true" : "false";
  }

  primWrite(p: string, value: string, le: string): string {
    if (p === "u8") return `$w.u8(${value});`;
    return `$w.prim(${str(p)}, ${value}, ${le});`;
  }

  struct(
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
      // Layers may run this inside a closure (codec regions): emit into the current builder.
      const c = this.code;
      const argCode = this.x.args(args, s.params, this.exprCtx(inner));
      const isAsync = s.async && inner.async;
      const fn = this.mod.structFn(id, isAsync ? "writeAsync" : "write");
      const callExpr = `${isAsync ? "await " : ""}${fn}(${["$w", value, ...argCode].join(", ")})`;
      if (this.model.structHasPlaceables(id)) {
        const l = c.fresh("$l");
        c.line(`const ${l} = ${callExpr};`);
        return l;
      }
      c.line(`${callExpr};`);
      return null;
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

  private array(t: Extract<IrType, { kind: "array" }>, value: string, ctx: WCtx): string | null {
    const c = this.code;
    const depth = ctx.depth;
    this.st.maxDepth = Math.max(this.st.maxDepth, depth + 1);
    const a = c.fresh("$a");
    const i = c.fresh("$i");
    const hasL = this.model.hasPlaceables(t);
    c.line(`const ${a} = $rt.arrayValue(${value});`);
    if (t.length.kind === "count") {
      const n = this.lengthCheck(t.length.expr, ctx, a);
      if (n !== undefined && n !== `${value}.length`) c.line(`$rt.checkLength(${a}.length, ${n});`);
    }
    const la = hasL ? c.fresh("$la") : undefined;
    if (la) c.line(`const ${la} = new $rt.LArray();`);
    const setIndex = this.model.elementUsesIndex(t.element);
    const saved = setIndex ? c.fresh("$ix") : undefined;
    if (saved) c.line(`const ${saved} = $w.index;`);
    const ectx: WCtx = { ...ctx, index: i, depth: depth + 1, extent: undefined };
    const elemT = this.types.type(t.element, "in");
    let term: CExpr | undefined;
    if (t.length.kind === "until" || t.length.kind === "before")
      term = this.expr(t.length.terminator, ctx);
    const pred = t.length.kind === "untilPredicate" ? t.length.predicate : undefined;
    c.block(`for (let ${i} = 0; ${i} < ${a}.length; ${i}++)`, () => {
      c.line(`$i${depth} = ${i};`);
      if (saved) c.line(`$w.index = ${i};`);
      const el = c.fresh("$el");
      c.line(`const ${el} = ${a}[${i}] as ${/[|&]/.test(elemT) ? `(${elemT})` : elemT};`);
      if (term) {
        const eq = this.x.equality(
          "==",
          this.x.typed(el, valueTypeOf(this.model, t.element)),
          term
        );
        c.line(`if (${eq}) $rt.fail("INPUT", "an element equals the terminator");`);
      }
      if (pred) {
        // `until <predicate>`: only the last element may satisfy it (and it must).
        const cond = this.expr(pred, {
          ...ctx,
          it: { code: el, type: valueTypeOf(this.model, t.element) }
        }).code;
        c.line(
          `if ((${cond}) !== (${i} === ${a}.length - 1)) $rt.fail("CHECK", "until: only the last element may (and must) end the array");`
        );
      }
      if (t.elementPlacement) {
        const off = this.num(t.elementPlacement, ectx);
        const body = this.inClosure(() => this.write(t.element, el, ectx));
        const P = c.fresh("$P");
        if (ctx.async)
          c.line(
            `const ${P} = await $w.placeAsync(${str(`${ctx.fieldName}[]`)}, ${el}, async () => ${body}, { fixed: ${off} });`
          );
        else
          c.line(
            `const ${P} = $w.place(${str(`${ctx.fieldName}[]`)}, ${el}, () => ${body}, { fixed: ${off} });`
          );
        if (la) c.line(`${la}.push(${P});`);
      } else {
        const e = this.write(t.element, el, ectx);
        if (la) c.line(`${la}.push(${e ?? "undefined"});`);
      }
    });
    if (pred)
      c.line(
        `if (${a}.length === 0) $rt.fail("CHECK", "until: the array needs an element that ends it");`
      );
    if (term && t.length.kind === "until") {
      c.line(`$i${depth} = ${a}.length;`);
      if (saved) c.line(`$w.index = ${a}.length;`);
      const e = this.write(t.element, this.x.to(term, valueTypeOf(this.model, t.element)), ectx);
      if (la && e) c.line(`${la}.push(${e});`);
    }
    if (saved) c.line(`$w.index = ${saved};`);
    c.line(`$i${depth} = -1;`);
    return la ?? null;
  }

  private pointer(
    t: Extract<IrType, { kind: "pointer" }>,
    value: string,
    ctx: WCtx
  ): string | null {
    const c = this.code;
    const tv = c.fresh("$tv");
    c.line(`const ${tv} = ${value};`);
    const nv = t.nullValue !== undefined ? `${BigInt(t.nullValue)}n` : "undefined";
    const le = this.leOf(t.storageEndian, ctx);
    const tctx: WCtx = { ...ctx, extent: undefined };
    const tType = this.types.type(t.target, "in");
    const typedTv = `(${tv} as ${/[|&]/.test(tType) ? `(${tType})` : tType})`;
    // `@nullable(empty)`: an empty array is written as the null value (no target).
    const isNull = t.emptyIsNull ? `$rt.isEmpty(${tv})` : `${tv} === null`;
    // `@origin(expr)`: the stored value is relative to base + origin (computed after layout).
    const origin = t.origin
      ? `, () => ${this.x.asNum(this.expr(t.origin, { ...ctx, deferred: true }))}`
      : "";
    if (t.ownership === "ref") {
      const body = this.inClosure(() => this.write(t.target, typedTv, tctx));
      const enc = `$w.encodeAlone(() => ${body})`;
      c.line(
        `$w.refPointer(${str(t.storage)}, ${le}, ${str(this.model.typeKey(t.target))}, ${isNull} ? null : ${tv}, () => ${enc}, ${t.relative}, ${nv}${origin});`
      );
      return null;
    }
    const P = c.fresh("$P");
    const body = this.inClosure(() => this.write(t.target, typedTv, tctx));
    const key = str(this.model.typeKey(t.target));
    if (ctx.async) {
      c.line(
        `const ${P} = ${isNull} ? null : await $w.targetAsync(${tv}, ${key}, ${str(ctx.fieldName)}, async () => ${body}${ctx.depth === 0 ? ", undefined, $in" : ""});`
      );
    } else {
      c.line(
        `const ${P} = ${isNull} ? null : $w.target(${tv}, ${key}, ${str(ctx.fieldName)}, () => ${body}${ctx.depth === 0 ? ", undefined, $in" : ""});`
      );
    }
    c.line(`$w.pointer(${str(t.storage)}, ${le}, ${P}, ${t.relative}, ${nv}${origin});`);
    return `(${P} ?? undefined)`;
  }

  // ── bits ──────────────────────────────────────────────────────────────────

  emitBits(b: IrBits, ctx: WCtx): void {
    const c = this.code;
    const big = primIsBig(b.storage);
    const u = c.fresh("$u");
    c.line(`let ${u} = ${big ? "0n" : "0"};`);
    for (const f of b.fields) {
      if (f.name === null) continue;
      c.line(`$f = ${str(f.name)};`);
      const value = this.bitFieldValue(f, ctx);
      const bits = this.bitsOf(f, value, ctx, big);
      if (big) c.line(`${u} |= ${bits} << ${f.shift}n;`);
      else c.line(`${u} += ${bits} * ${formatInt(1n << BigInt(f.shift))};`);
    }
    c.line(this.primWrite(b.storage, u, this.leOf(b.endian, ctx)));
  }

  private bitFieldValue(f: IrBitField, ctx: WCtx): string {
    const vt = valueTypeOf(this.model, f.type);
    let v: string;
    if (f.input === "required") v = prop("$v", f.name!);
    else if (f.derive) v = this.x.to(this.fieldRef(f.name!, vt, ctx), vt);
    else v = prop("$v", f.name!);
    const checks = f.checks.filter(ch => !ch.strictOnly);
    if (checks.length) {
      const tmp = this.code.fresh("$val");
      this.code.line(`const ${tmp} = ${v};`);
      this.emitWriteChecks(checks, tmp, vt, ctx, f.input === "absent" ? "DERIVE" : "CHECK");
      return tmp;
    }
    return v;
  }

  private bitsOf(f: IrBitField, value: string, ctx: WCtx, big: boolean): string {
    let t = f.type;
    if (t.kind === "layered") t = t.inner;
    if (t.kind === "transform" && t.write) {
      const w = this.expr(t.write, { ...ctx, it: { code: value, type: t.valueType } });
      return this.bitsOfType(t.inner, this.x.to(w, valueTypeOf(this.model, t.inner)), f.width, big);
    }
    if (t.kind === "transform") t = t.inner;
    return this.bitsOfType(t, value, f.width, big);
  }

  private bitsOfType(t: IrType, value: string, width: number, big: boolean): string {
    const fn = big ? "$rt.bitsOfBig" : "$rt.bitsOf";
    if (t.kind === "bool") return big ? `BigInt($rt.boolBit(${value}))` : `$rt.boolBit(${value})`;
    if (t.kind === "enum") {
      return `${fn}($rt.enumValue(${this.mod.enumRef(t.enum, "values")}, ${value}), ${width}, false)`;
    }
    if (t.kind === "prim") return `${fn}(${value}, ${width}, ${t.prim[0] === "i"})`;
    return `${fn}(${value}, ${width}, false)`;
  }

  // ── layers ────────────────────────────────────────────────────────────────

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
      if (extent) c.line(`${extent}.stages[${k}] = ${sizeExpr};`);
    };
    const next = (x: WCtx): string | null => {
      const s = extent ? c.fresh("$so") : undefined;
      if (s) c.line(`const ${s} = $w.offset;`);
      const e = this.emitLayers(layers, idx - 1, x, inner, slot, extent);
      if (s) recordStage(idx, `$w.offset - ${s}`);
      return e;
    };
    switch (l.kind) {
      case "align": {
        c.line(`${this.alignCall(l, ctx)};`);
        return next(ctx);
      }
      case "padBefore":
        c.line(`$w.pad(${this.len(l.count, ctx)}, ${this.fill(l.fill, ctx)});`);
        return next(ctx);
      case "padAfter": {
        const e = next(ctx);
        c.line(`$w.pad(${this.len(l.count, ctx)}, ${this.fill(l.fill, ctx)});`);
        return e;
      }
      case "padUntil": {
        const s = c.fresh("$s");
        c.line(`const ${s} = $w.offset;`);
        const e = next(ctx);
        c.line(`$w.padUntil(${s}, ${this.len(l.size, ctx)}, ${this.fill(l.fill, ctx)});`);
        return e;
      }
      case "alignEnd": {
        const e = next(ctx);
        c.line(`${this.alignCall(l, ctx)};`);
        return e;
      }
      case "size": {
        const s = c.fresh("$s");
        c.line(`const ${s} = $w.offset;`);
        const e = next(ctx);
        c.line(`$w.sizeWindow(${s}, ${this.len(l.size, ctx)});`);
        return e;
      }
      case "via": {
        const codec = this.model.codec(l.codec);
        const args = this.x.args(l.args, codec.params, this.exprCtx(ctx));
        const plain = c.fresh("$plain");
        const asyncInner = ctx.async;
        const body = this.inClosure(() =>
          this.emitLayers(layers, idx - 1, ctx, inner, slot, extent)
        );
        if (asyncInner)
          c.line(`const ${plain} = await $w.subRegionAsync(undefined, async () => ${body});`);
        else c.line(`const ${plain} = $w.subRegion(undefined, () => ${body});`);
        recordStage(idx, `${plain}.length`);
        if (extent) c.line(`${extent}.plain ??= ${plain};`);
        const outSize = decodedSizeLayer(layers, idx) ? `, outputSize: ${plain}.length` : "";
        const ctxObj = `{ args: [${args.join(", ")}]${outSize} }`;
        const reuse = `$rt.reuseCodec(${ctx.reuse ?? "undefined"}, ${str(`${slot}#${idx}`)}, ${plain})`;
        const enc = `$rt.encode${codec.async ? "Async" : ""}(${this.mod.extern(l.codec)}, ${str(codec.name)}, ${plain}, ${ctxObj})`;
        if (codec.async && !ctx.async)
          throw new Error(`async codec ${codec.name} in a sync writer`);
        c.line(
          `$w.raw(${reuse} ?? ${codec.async ? "(await " : ""}${enc}${codec.async ? ")" : ""});`
        );
        return null;
      }
      case "endian": {
        const e = c.fresh("$e");
        const le = c.fresh("$le");
        c.line(`const ${e} = ${this.expr(l.value, ctx).code} as $rt.Endian;`);
        c.line(`const ${le} = ${e} === "le";`);
        return next({ ...ctx, endian: e, le });
      }
      case "strict":
        return next(ctx);
    }
  }

  /** `align`/`alignEnd` padding; with an origin or offset through `alignAt`. */
  alignCall(l: Extract<IrLayer, { kind: "align" | "alignEnd" }>, ctx: WCtx): string {
    const to = this.num(l.to, ctx);
    const fill = this.fill(l.fill, ctx);
    if (l.from !== "file" && !l.offset) return `$w.align(${to}, ${fill})`;
    const off = l.offset ? this.num(l.offset, ctx) : "0";
    return `$w.alignAt(${to}, ${fill}, ${l.from === "file"}, ${off})`;
  }

  /** A base's (or the root's) `@alignEnd`: pads its whole region, after its targets. */
  regionAlignEnd(l: Extract<IrLayer, { kind: "alignEnd" }>, ctx: WCtx): string {
    const off = l.offset ? this.num(l.offset, ctx) : "0";
    return `$w.regionAlignEnd(${this.num(l.to, ctx)}, ${l.from === "file"}, ${off})`;
  }

  fill(f: IrFill, ctx: WCtx): string {
    if (f.kind === "byte") return String(f.value);
    const p = ident(f.param);
    const lambdas = new Map(ctx.lambdas ?? []);
    lambdas.set(f.param, p);
    const body = this.expr(f.expr, { ...ctx, lambdas });
    return `(${p}: number) => ${this.x.asNum(body)}`;
  }

  // ── virtual streams ───────────────────────────────────────────────────────

  /**
   * `from` fields: encode the value, then hand the bytes to the stream's source fields (they are
   * written with these overrides).
   */
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
        const enc = c.fresh("$stream");
        const value = this.st.overrides.get(g.name) ?? prop("$v", g.name);
        const body = this.inClosure(() => this.write(g.type, value, { ...ctx, fieldName: g.name }));
        c.line(`$f = ${str(g.name)};`);
        c.line(
          `const ${enc} = ${ctx.async ? "await $w.subRegionAsync" : "$w.subRegion"}(undefined, ${ctx.async ? "async " : ""}() => ${body});`
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
        const start = r.start ? this.num(r.start, ctx) : "0";
        const end = r.end ? this.num(r.end, ctx) : "undefined";
        parts.push(`{ name: ${str(g.name)}, start: ${start}, end: ${end}, bytes: ${enc} }`);
      }
      const length = this.carrierLength(s, root.root, ctx);
      const assembled = c.fresh("$slices");
      c.line(`const ${assembled} = $rt.assembleSlices(${length}, [${parts.join(", ")}]);`);
      this.streamTargets(root.root, assembled, s, ctx, policy);
    }
  }

  /**
   * Length of a sliced field: its own `count` length when that doesn't depend on the field
   * itself, else undefined (the largest slice end).
   */
  private carrierLength(s: IrStruct, root: IrStreamExpr, ctx: WCtx): string {
    if (root.kind !== "field") return "undefined";
    const f = this.model.field(s, root.field)?.field;
    if (!f) return "undefined";
    const t = stripLayers(f.type);
    if (t.kind !== "bytes" || t.length.kind !== "count") return "undefined";
    if (this.refersTo(s, t.length.expr, root.field, [])) return "undefined";
    return this.len(t.length.expr, ctx);
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
      const fr = this.model.field(s, x.name);
      const d = fr?.field?.derive ?? fr?.bit?.derive;
      const input = fr?.field?.input ?? fr?.bit?.input;
      if (d && input !== "required" && !seen.includes(x.name))
        found = this.refersTo(s, d, name, [...seen, x.name]);
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
      const local = c.fresh("$sf");
      c.line(`const ${local} = ${bytes};`);
      this.st.overrides.set(st.field, local);
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
    let el = arr.type;
    while (el.kind === "layered") el = el.inner;
    if (el.kind !== "array") throw new Error(`${st.array} is not an array`);
    let et = el.element;
    while (et.kind === "layered") et = et.inner;
    if (et.kind !== "struct") throw new Error(`${st.array} elements are not structs`);
    const es = this.model.struct(et.struct);
    const piece = this.model.field(es, st.field)?.field;
    const sizeField = piece ? innerSizeField(piece.type) : undefined;
    const local = c.fresh("$els");
    let fit = "undefined";
    if (policy === "fit" && el.elementPlacement) {
      const off = this.num(el.elementPlacement, { ...ctx, index: "$k" });
      const elemT = this.types.type(el.element, "in");
      const call = this.closureOf(() => {
        const e = this.write(el.element, `($e as ${elemT})`, {
          ...ctx,
          index: "-1",
          fieldName: st.array
        });
        return e ?? "undefined";
      });
      fit = `{ offset: ($k: number) => ${off}, size: ($e: unknown) => $w.encodeAlone(() => ${call}).length }`;
    }
    c.line(
      `const ${local} = $rt.splitStream(${prop("$v", st.array)}, ${str(st.field)}, ${bytes}, ${sizeField ? str(sizeField) : "undefined"}, ${fit});`
    );
    this.st.overrides.set(st.array, local);
  }
}

/** Fields that need extents (sizeof/offsetof/… anywhere in the struct). */
function collectExtents(s: IrStruct, extents: Set<string>): void {
  const scan = (e: IrExpr): void => forEachExtentRef(e, name => extents.add(name));
  forEachReadExpr(s, scan);
  forEachOrigin(s, scan);
  if (s.layout) forEachLayoutArg(s.layout, scan);
  forEachDerive(s.members, scan);
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

/** The field a piece's length reads (`u8 data[n]` or `@size(n)` outside any codec), if any. */
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

/** True if an expression mentions `it` (a formula applied to the field's own input). */
function usesIt(e: IrExpr): boolean {
  return someExpr(e, x => x.kind === "it");
}

function isTrivialOffset(code: string, field: string): boolean {
  return code === `$x_${ident(field)}.pos`;
}

/** True if every layout layer argument is a literal (else they read fields). */
function layoutIsConstant(items: readonly IrLayoutItem[]): boolean {
  let constant = true;
  forEachLayoutArg(items, e => {
    if (literalInt(e) === undefined) constant = false;
  });
  return constant;
}

function constantLayoutArg(e: IrExpr): string {
  const v = literalInt(e);
  if (v === undefined) throw new Error("expected a constant layout argument");
  return `${v}`;
}

/** Layout items as a TS literal; `arg` gives the code of each layer argument. */
function layoutLiteral(
  items: readonly IrLayoutItem[],
  arg: (e: IrExpr, what: LayoutArgKind) => string
): string {
  const parts = items.map(it => {
    const path =
      it.path === "this"
        ? `"this"`
        : `[${it.path.map(seg => (seg.kind === "each" ? `"*"` : str(seg.name))).join(", ")}]`;
    const layers = it.layers
      .map(l => {
        switch (l.kind) {
          case "align": {
            // An origin or offset makes the item's alignment a residue.
            const extra =
              (l.offset ? `, offset: ${arg(l.offset, "offset")}` : "") +
              (l.from === "file" ? ", file: true" : "");
            return `{ kind: "align", to: ${arg(l.to, "align")}${extra} }`;
          }
          case "alignEnd":
            return `{ kind: "alignEnd", to: ${arg(l.to, "align")} }`;
          case "padBefore":
            return `{ kind: "padBefore", count: ${arg(l.count, "count")} }`;
          case "padAfter":
            return `{ kind: "padAfter", count: ${arg(l.count, "count")} }`;
          default:
            return undefined;
        }
      })
      .filter(Boolean);
    const group = it.group ? `, group: ${layoutLiteral(it.group.items, arg)}` : "";
    return `{ path: ${path}, layers: [${layers.join(", ")}]${group} }`;
  });
  return `[${parts.join(", ")}]`;
}
