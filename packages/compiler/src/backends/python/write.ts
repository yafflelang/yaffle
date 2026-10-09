/**
 * Writer emitter: one `_write_X` function per struct (`_write_async_X` for async structs),
 * relocation-style code over `_rt.Writer` following docs/IR.md §3 and §4.
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
  alignEnds,
  decodedSize,
  elementUsesIndex,
  findBits,
  inlineLayers,
  innerSizeField,
  patchableType,
  usesIndex,
  usesIt,
  valueTypeOf,
  writeSideExtents
} from "./analysis.ts";
import { pyBool, pyInt, pyStr, pyTuple, paren, stripParens, type Code } from "./code.ts";
import { Emitter, type EmitCtx, type EmitState, type SideCtx } from "./emitter.ts";
import type { CExpr } from "./expr.ts";
import { literalInt, someExpr, stripType, unlayer, walkExpr } from "./model.ts";
import { pathSlots } from "./read.ts";

export interface WCtx extends EmitCtx {
  /** Extent variable of the field being written (stage sizes are recorded into it). */
  extent?: string | undefined;
  /** Field name being written (placeable names). */
  fieldName: string;
  /** The value inside the current layers (codec reuse key). */
  reuse?: string | undefined;
  /** Code of `$offset` (deferred checks capture the position where the field started). */
  offsetCode?: string | undefined;
  /** Code of `$end` (deferred checks: the end of the finished region). */
  endCode?: string | undefined;
  /** The struct value being written ("None" at the root). */
  owner?: string | undefined;
}

/** What a derived value depends on, in increasing order of how late it can be computed. */
type DeriveClass = "value" | "size" | "position" | "content";

const RANK: Record<DeriveClass, number> = { value: 0, size: 1, position: 2, content: 3 };

interface WriteState extends EmitState {
  /** Fields whose extents are recorded, and those whose stage sizes are recorded too. */
  extents: Set<string>;
  stages: Set<string>;
  maxDepth: number;
  /** Derived fields whose derive is being inlined (cycle detection). */
  inlining: string[];
  /** Fields whose values come from a local instead of the input (stream sources). */
  overrides: Map<string, string>;
  /** Virtual field → the local holding its validated input. */
  virtuals: Map<string, string>;
}

function freshState(): WriteState {
  return {
    extents: new Set(),
    stages: new Set(),
    maxDepth: 0,
    inlining: [],
    overrides: new Map(),
    nonlocals: [],
    virtuals: new Map()
  };
}

export class WriteEmitter extends Emitter<WCtx, WriteState> {
  private readonly classMemo = new Map<string, DeriveClass>();

  private rootCtx(s: IrStruct, async: boolean, slot: string, fieldName = ""): WCtx {
    return { s, endian: "endian", le: "_le", async, index: "-1", depth: 0, slot, fieldName };
  }

  /**
   * The struct's layout as a module constant; `None` if it has none or its layer arguments are
   * evaluated on write (then the writer sets `_L.layout`, and a root or base region takes its
   * layout from its root struct's `LStruct`).
   */
  layoutConst(s: IrStruct): string {
    if (!s.layout || !s.layout.length || layoutIsDynamic(s.layout)) return "None";
    return this.mod.hoist(layoutLiteral(s.layout), `layout_${this.names.structClass(s.id)}_`);
  }

  /**
   * Evaluates the layout's layer arguments in the struct's write context (inputs, inlined
   * derives, params, `$index`). Emitted after the members, so every local that a field reference
   * may use exists; layout runs after the whole region is written anyway.
   */
  private emitDynamicLayout(s: IrStruct, ctx: WCtx): void {
    if (!s.layout || !s.layout.length || !layoutIsDynamic(s.layout)) return;
    const lit = layoutLiteral(s.layout, (e, what) => {
      const code = this.num(e, ctx);
      if (what === "align") return `_rt.layout_align(${code})`;
      if (what === "pad") return `_rt.layout_pad(${code})`;
      return code;
    });
    this.code.line(`_p[0] = ""`);
    this.code.line(`_L.layout = ${lit}`);
  }

  private extentVar(f: string): string {
    this.st.extents.add(f);
    return `_x_${f.replace(/\W/g, "_")}`;
  }

  emitStruct(out: Code, s: IrStruct, async: boolean): void {
    const cls = this.names.structClass(s.id);
    this.st = { ...freshState(), ...writeSideExtents(s) };
    const hasL = this.model.membersHavePlaceables(s.members);
    const body = out.child();
    this.code = body;
    const ctx: WCtx = { ...this.rootCtx(s, async, cls), index: "_index" };
    this.emitVirtualInputs(s, ctx);
    this.emitStreamPrepass(s, ctx);
    this.emitMembers(s.members, ctx, hasL ? "_L" : undefined);
    if (hasL) this.emitDynamicLayout(s, ctx);

    const params = this.types.params(s);
    const fn = async ? `_write_async_${cls}` : `_write_${cls}`;
    const ret = !s.base && hasL ? "_rt.LStruct" : "None";
    out.block(
      `${async ? "async " : ""}def ${fn}(${["_w: _rt.Writer", "_v: _t.Any", ...params].join(", ")}) -> ${ret}`,
      () => {
        if (s.params.some(p => p.origin === "endian")) out.line(`_le = endian == "le"`);
        out.line(`_rt.need(_v, ${needList(this.requiredFields(s.members, s))})`);
        if (usesIndex(s, true)) out.line(`_index = _w.index`);
        const emitBody = (): void => {
          // A base's `@alignEnd` pads its whole region, after its targets.
          if (s.base) for (const l of alignEnds(s.layers)) out.line(this.regionEnd(l, ctx));
          if (hasL) out.line(`_L = _rt.LStruct(${this.layoutConst(s)})`);
          for (const f of this.st.extents) {
            if (f === "this")
              out.line(`_x_this = ${s.base ? "_w.region_extent()" : "_w.extent()"}`);
            else out.line(`${this.extentVar(f)}: _t.Any = None`);
          }
          out.line(`_p: list[_t.Any] = ${pathSlots(this.st.maxDepth)}`);
          // The frame lets fixups that run after layout report this struct's path.
          out.line(`_w.enter(_p)`);
          out.block("try", () => {
            out.append(body);
            if (this.st.extents.has("this") && !s.base) out.line(`_w.close(_x_this)`);
          });
          out.block("except _rt.YaffleError as _e", () => {
            out.line(`_e.prefix(*_p)`);
            out.line("raise");
          });
          out.block("finally", () => out.line(`_w.leave()`));
          if (hasL) out.line("return _L");
        };
        if (!s.base) {
          emitBody();
          return;
        }
        // A base is written into its own region.
        const name = out.fresh("cb");
        out.line(`${async ? "async " : ""}def ${name}() -> _t.Any:`);
        out.indent(emitBody);
        if (!hasL) out.indent(() => out.line("return None"));
        out.line(
          `${async ? "await _w.base_async" : "_w.base"}(${this.layoutConst(s)}, ${name}, _v)`
        );
      }
    );
  }

  /** Emits the write of a root struct (params are locals); returns the layout entry or null. */
  rootWrite(out: Code, s: IrStruct, value: string, async: boolean): string | null {
    this.st = freshState();
    this.code = out;
    const ctx: WCtx = { ...this.rootCtx(s, async, this.names.structClass(s.id)), owner: "None" };
    const args: IrExpr[] = s.params.map(p => ({ kind: "param", name: p.name, type: p.type }));
    // The root is its file's base: `@alignEnd` pads the whole region, after the targets.
    if (!s.base) for (const l of alignEnds(s.layers)) out.line(this.regionEnd(l, ctx));
    const layers = s.layers.filter(l => l.kind !== "alignEnd");
    return this.struct(s.id, args, value, ctx, layers);
  }

  /**
   * Emits into `body` what `write` emits with a fresh state, unless it fails or needs extents
   * (then the value's encoding depends on sizes or positions). Returns whether it succeeded.
   */
  private isolated(body: Code, write: () => boolean): boolean {
    const savedCode = this.code;
    const savedSt = this.st;
    this.st = freshState();
    this.code = body;
    try {
      return write() && this.st.extents.size === 0;
    } catch {
      return false;
    } finally {
      this.code = savedCode;
      this.st = savedSt;
    }
  }

  /**
   * A view patch encoder for a scalar field: emits a module-level function
   * `(_val, _v, *params) -> bytes` into `out` and returns its name, or undefined if the field's
   * encoding depends on sizes, positions or targets (then setting it is structural).
   */
  encoderFor(out: Code, s: IrStruct, name: string): string | undefined {
    const fr = this.model.field(s, name);
    if (!fr) return undefined;
    const f = fr.field;
    if (f && (f.placement || f.from || !patchableType(f.type))) return undefined;
    const ctx = this.rootCtx(s, false, `${this.names.structClass(s.id)}.${name}`, name);
    const body = out.child();
    const ok = this.isolated(body, () => {
      if (f) {
        const checks = f.deriveKind === "constant" ? [] : f.checks.filter(ch => !ch.strictOnly);
        this.emitWriteChecks(checks, "_val", valueTypeOf(this.model, f.type), ctx, "CHECK");
        return this.write(f.type, "_val", ctx) === null;
      }
      const bits = findBits(s.members, name);
      if (bits) this.emitBits(bits, ctx);
      return bits !== undefined;
    });
    if (!ok) return undefined;
    const fn = `_enc_${this.names.structClass(s.id)}_${this.attr(s, name)}`;
    const params = s.params.map(p => `${this.names.param(s, p.name)}: _t.Any`);
    out.block(`def ${fn}(${["_val: _t.Any", "_v: _t.Any", ...params].join(", ")}) -> bytes`, () => {
      if (s.params.some(p => p.origin === "endian")) out.line(`_le = endian == "le"`);
      out.line(`_p: list[_t.Any] = [${pyStr(name)}]`);
      out.block(`def _body(_w: _rt.Writer) -> None`, () => out.append(body));
      out.line(`return _rt.serialize_with(None, _body)`);
    });
    out.line("");
    return fn;
  }

  /**
   * Encoder of one element of a lazy scalar array: emits a nested function into `code` (the scan
   * function, whose `_le` it uses) and returns its name, or undefined.
   */
  elementEncoder(code: Code, s: IrStruct, t: IrType): string | undefined {
    if (!patchableType(t) || t.kind === "transform") return undefined;
    const body = code.child();
    const ok = this.isolated(
      body,
      () => this.write(t, "_val", this.rootCtx(s, false, "")) === null
    );
    if (!ok) return undefined;
    const fn = code.fresh("ee");
    code.block(`def ${fn}(_val: _t.Any) -> bytes`, () => {
      code.block(`def _body(_w: _rt.Writer) -> None`, () => code.append(body));
      code.line(`return _rt.serialize_with(None, _body)`);
    });
    return fn;
  }

  /** Required input fields of the unconditional part of a member list. */
  private requiredFields(ms: readonly IrMember[], s: IrStruct): { attr: string; name: string }[] {
    const out: { attr: string; name: string }[] = [];
    for (const m of ms) {
      if (m.kind === "field") {
        if (m.input === "required" && !m.hidden && !this.st.overrides.has(m.name))
          out.push({ attr: this.attr(s, m.name), name: m.name });
      } else if (m.kind === "bits") {
        for (const b of m.fields)
          if (b.name !== null && b.input === "required")
            out.push({ attr: this.attr(s, b.name), name: b.name });
      } else if (m.kind === "block" && !m.condition) out.push(...this.requiredFields(m.members, s));
    }
    return out;
  }

  /** Checks the required inputs of a conditional branch before it is written. */
  private needFields(ms: readonly IrMember[], s: IrStruct): void {
    const req = this.requiredFields(ms, s);
    if (!req.length) return;
    this.code.line(`_p[0] = ""`);
    this.code.line(`_rt.need(_v, ${needList(req)})`);
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
        const d = f?.field?.derive ?? f?.bit?.derive;
        const input = f?.field?.input ?? f?.bit?.input;
        if (d && input !== "required" && !seen.includes(x.name)) {
          bump(this.fieldClass(s, x.name, [...seen, x.name]));
        }
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

  protected sideCtx(ctx: WCtx): SideCtx {
    return {
      field: (name, type) => this.fieldRef(name, type, ctx),
      builtin: name => {
        if (name === "offset") return ctx.offsetCode ?? "_w.position";
        if (name === "end")
          return ctx.endCode ?? '_rt.fail("DERIVE", "$end is not available on write")';
        return ctx.index;
      },
      sizeof: f => `${this.extentVar(f)}.size`,
      offsetof: f => `${this.extentVar(f)}.pos`,
      encodedSize: (f, k) => `${this.extentVar(f)}.stage(${k})`,
      bytesof: f => `${this.extentVar(f)}.bytes()`,
      encode: f => `${this.extentVar(f)}.plain_bytes()`
    };
  }

  /** A field reference in the write context: the input value, or the inlined derive. */
  private fieldRef(name: string, type: IrValueType, ctx: WCtx): CExpr {
    const override = this.st.overrides.get(name);
    if (override) return this.x.typed(override, type);
    const f = this.model.field(ctx.s, name);
    if (!f) throw new Error(`unknown field ${name} in ${ctx.s.name}`);
    const { input, derive } = f.field ?? f.bit!;
    const hidden = f.field?.hidden ?? false;
    const attr = this.attr(ctx.s, name);
    const inputExpr = hidden
      ? `_rt.field_value(_v, ${pyStr(attr)})`
      : input === "optional"
        ? `getattr(_v, ${pyStr(attr)}, None)`
        : `_v.${attr}`;
    const inputCode = (): CExpr => this.x.typed(inputExpr, type);
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
      // Not a temporary's name (`_g_N`): it is bound inside the expression itself, so closures
      // must not bind it as a default argument.
      const g = `_g_${++this.code.counter.n}`;
      return { ...d, code: `(${g} if (${g} := ${inputExpr}) is not None else ${d.code})` };
    }
    return d;
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
            this.emitLayers(m.layers, m.layers.length - 1, ctx, inner => {
              this.emitMembers(m.members, inner, L);
              return null;
            });
          };
          if (!m.condition) {
            body();
            break;
          }
          const parts: [string, () => void][] = [
            [
              `if ${stripParens(this.expr(m.condition, ctx).code)}`,
              () => {
                this.needFields(m.members, ctx.s);
                body();
              }
            ]
          ];
          const els = m.else;
          if (els) {
            parts.push([
              "else",
              () => {
                this.needFields(els, ctx.s);
                this.emitMembers(els, ctx, L);
              }
            ]);
          }
          c.chain(parts);
          break;
        }
        case "switch": {
          const d = c.fresh("d");
          c.line(`${d} = ${stripParens(this.expr(m.discriminant, ctx).code)}`);
          const branch = (members: readonly IrMember[]): void => {
            this.needFields(members, ctx.s);
            this.emitMembers(members, ctx, L);
          };
          const parts = m.cases.map((cs, i): [string, () => void] => {
            const conds = cs.values.map(
              v => `${d} == ${this.x.literal(v, m.discriminant.type, this.exprCtx(ctx)).code}`
            );
            return [`${i ? "elif" : "if"} ${conds.join(" or ")}`, () => branch(cs.members)];
          });
          const def = m.default;
          const last = def
            ? () => branch(def)
            : () => c.line(`_rt.fail("CHECK", f"no case matches {${d}!r}")`);
          if (parts.length) c.chain([...parts, ["else", last]]);
          else last();
          break;
        }
      }
    }
  }

  /** The value written for a field: input, or derive (immediately or as a fixup). */
  private emitField(f: IrField, ctx: WCtx, L: string | undefined): void {
    const c = this.code;
    if (f.from) return; // encoded by the stream prepass into its source fields
    c.line(`_p[0] = ${pyStr(f.name)}`);
    if (f.virtual) {
      this.emitVirtual(f, ctx);
      return;
    }
    const fctx: WCtx = { ...ctx, slot: `${ctx.s.id}.${f.name}`, fieldName: f.name };
    const ext = this.st.extents.has(f.name) ? this.extentVar(f.name) : undefined;
    const vt = valueTypeOf(this.model, f.type);
    const attr = this.attr(ctx.s, f.name);
    let value: string;
    let cls: DeriveClass = "value";
    const override = this.st.overrides.get(f.name);
    if (override) value = override;
    else if (f.input === "required" && !f.hidden) {
      // `u8 flags = it | 0x80`: the input is normalized by the formula on write.
      value =
        f.derive && usesIt(f.derive)
          ? this.x.to(this.fieldRef(f.name, vt, fctx), vt)
          : `_v.${attr}`;
    } else if (f.derive) {
      cls = this.fieldClass(ctx.s, f.name);
      if (f.input === "optional" && cls !== "value") {
        // The input when given, else computed after layout.
        c.block(`if getattr(_v, ${pyStr(attr)}, None) is not None`, () =>
          this.emitFieldValue(f, `_v.${attr}`, fctx, L, ext, "value")
        );
        c.block("else", () => {
          const d = this.expr(f.derive!, fctx);
          this.emitFieldValue(f, this.x.to(d, vt), fctx, L, ext, cls);
        });
        return;
      }
      value = this.x.to(this.fieldRef(f.name, vt, fctx), vt);
    } else value = f.hidden ? `_rt.field_value(_v, ${pyStr(attr)})` : `_v.${attr}`;
    this.emitFieldValue(f, value, fctx, L, ext, cls);
  }

  /**
   * A virtual field writes no bytes. Its input value is validated, and the fields it is computed
   * from (derived from it) must give it back: `read` over their derived values equals the input,
   * else DERIVE.
   */
  private emitVirtual(f: IrField, ctx: WCtx): void {
    const fctx: WCtx = { ...ctx, slot: `${ctx.s.id}.${f.name}`, fieldName: f.name };
    // Unconditional virtual inputs were validated up front (emitVirtualInputs).
    const val = this.st.virtuals.get(f.name) ?? this.virtualInput(f, fctx);
    const read = f.virtual!.read;
    const msg = `virtual field ${f.name}: its parts don't read back as the value`;
    const emitCheck = (): void => {
      const back = stripParens(this.expr(read, fctx).code);
      this.code.line(`if not _rt.equals(${back}, ${val}): _rt.fail("DERIVE", ${pyStr(msg)})`);
    };
    if (this.deriveClass(ctx.s, read) === "value") {
      emitCheck();
      return;
    }
    // The parts depend on sizes or positions: checked once they are known.
    this.deferCheck(emitCheck);
  }

  /** `_w.defer_check(…)` of a closure whose body `emit` emits. */
  private deferCheck(emit: () => void): void {
    const chk = this.closure(false, () => {
      emit();
      return null;
    });
    this.code.line(`_w.defer_check(${chk})`);
  }

  /** Validates a virtual field's input value (type and checks); returns the local holding it. */
  private virtualInput(f: IrField, fctx: WCtx): string {
    const c = this.code;
    const vt = valueTypeOf(this.model, f.type);
    const val = c.fresh("val");
    c.line(`${val} = ${stripParens(this.x.to(this.fieldRef(f.name, vt, fctx), vt))}`);
    const t = unlayer(f.type);
    if (t.kind === "prim") c.line(`${val} = _rt.check_value(${val}, ${pyStr(t.prim)})`);
    else if (t.kind === "enum") c.line(this.enumValue(t.enum, val));
    else if (t.kind === "bool") c.line(`_rt.bool_bit(${val})`);
    const checks = f.checks.filter(ch => !ch.strictOnly);
    this.emitWriteChecks(checks, val, vt, fctx, "CHECK");
    return val;
  }

  /**
   * Virtual inputs are validated before anything is written: the fields derived from them come
   * first in the struct, and a bad input is reported at the virtual field.
   */
  private emitVirtualInputs(s: IrStruct, ctx: WCtx): void {
    for (const m of s.members) {
      if (m.kind !== "field" || !m.virtual) continue;
      this.code.line(`_p[0] = ${pyStr(m.name)}`);
      const fctx: WCtx = { ...ctx, slot: `${s.id}.${m.name}`, fieldName: m.name };
      this.st.virtuals.set(m.name, this.virtualInput(m, fctx));
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
    // Derived values are checked when computed (DERIVE), inputs before writing (CHECK).
    // Constants are correct by construction; their checks only matter on read.
    const checks = f.deriveKind === "constant" ? [] : f.checks.filter(ch => !ch.strictOnly);
    const vt = valueTypeOf(this.model, f.type);
    let v = value;
    if (!deferred && (checks.length || !/^[A-Za-z0-9_.]+$/.test(value))) {
      v = c.fresh("val");
      c.line(`${v} = ${stripParens(value)}`);
      this.emitWriteChecks(checks, v, vt, ctx, f.input !== "absent" ? "CHECK" : "DERIVE");
    }
    if (f.placement) {
      this.emitPlaced(f, f.placement, v, ctx, L, ext);
      return;
    }
    if (ext) this.assignState(ext, "_w.extent()");
    const vctx = { ...ctx, extent: ext };
    const entry = deferred
      ? this.writeDeferred(f.type, value, vctx, cls, checks)
      : this.write(f.type, v, vctx);
    if (ext) c.line(`_w.close(${ext})`);
    if (entry && L) c.line(`${L}.set(${pyStr(f.name)}, ${entry})`);
  }

  /** An `at` field: its value goes into a placeable of the base region. */
  private emitPlaced(
    f: IrField,
    placement: NonNullable<IrField["placement"]>,
    v: string,
    ctx: WCtx,
    L: string | undefined,
    ext: string | undefined
  ): void {
    const c = this.code;
    const P = c.fresh("P");
    const opts: string[] = [];
    if (placement.fixed) opts.push(`fixed=${this.num(placement.offset, ctx)}`);
    if (placement.constraint) {
      const { modulus, remainder } = placement.constraint;
      opts.push(`constraint=(${modulus}, ${remainder})`);
    }
    // The extent exists before the content is written: its layers record stage sizes into it.
    if (ext) this.assignState(ext, "_w.extent()");
    const fn = this.closure(ctx.async, () => this.write(f.type, v, { ...ctx, extent: ext }));
    opts.push(`owner=${ctx.owner ?? "_v"}`);
    const place = ctx.async ? "await _w.place_async" : "_w.place";
    c.line(`${P} = ${place}(${pyStr(f.name)}, ${v}, ${fn}, ${opts.join(", ")})`);
    if (ext) c.line(`_w.bind_extent(${ext}, ${P}${placement.emptyIsNull ? ", True" : ""})`);
    if (L) c.line(`${L}.set(${pyStr(f.name)}, ${P})`);
    if (placement.fixed) return;
    // The read-side offset expression must agree with where layout put the value.
    const off = this.expr(placement.offset, ctx);
    if (off.code === `${this.extentVar(f.name)}.pos`) return;
    this.deferCheck(() =>
      this.code.line(
        `_rt.check_placement(${stripParens(this.x.asOffset(off))}, ${P}, ${pyStr(f.name)})`
      )
    );
  }

  /** `if not cond: fail(code, …)` per check; `it` is `value`. */
  private emitWriteChecks(
    checks: readonly IrCheck[],
    value: string,
    vt: IrValueType,
    ctx: WCtx,
    code: "CHECK" | "DERIVE"
  ): void {
    for (const ch of checks) {
      // `$end` is unknown while writing: such checks only apply on read.
      if (someExpr(ch.expr, e => e.kind === "builtinValue" && e.name === "end")) continue;
      const cond = this.expr(ch.expr, { ...ctx, it: { code: value, type: vt } }).code;
      this.code.line(
        `if not ${paren(cond)}: _rt.fail(${pyStr(code)}, ${pyStr(`check failed: ${ch.message}`)})`
      );
    }
  }

  /** Writes a derived value whose computation needs sizes, positions or content (a fixup). */
  private writeDeferred(
    t: IrType,
    value: string,
    ctx: WCtx,
    cls: DeriveClass,
    checks: readonly IrCheck[]
  ): string | null {
    const phase = cls === "content" ? 2 : 0;
    const vt = valueTypeOf(this.model, t);
    const compute = (raw: string): string =>
      this.closure(false, () => {
        if (!checks.length) return stripParens(raw);
        const it = this.code.fresh("it");
        this.code.line(`${it} = ${stripParens(raw)}`);
        for (const ch of checks) {
          const cond = this.expr(ch.expr, { ...ctx, it: { code: it, type: vt } }).code;
          this.code.line(
            `if not ${paren(cond)}: _rt.fail("DERIVE", ${pyStr(`check failed: ${ch.message}`)})`
          );
        }
        return it;
      });
    const leaf = (tt: IrType, raw: string, lctx: WCtx): string | null => {
      const c = this.code;
      switch (tt.kind) {
        case "prim":
          c.line(
            `_w.defer_prim(${pyStr(tt.prim)}, ${this.leOf(tt.endian, lctx)}, ${compute(raw)}, ${phase})`
          );
          return null;
        case "bool":
          c.line(`_w.defer_prim("u8", True, ${compute(`(1 if ${raw} else 0)`)}, ${phase})`);
          return null;
        case "enum": {
          const storage = pyStr(this.model.enum(tt.enum).storage);
          c.line(
            `_w.defer_prim(${storage}, ${this.leOf(tt.endian, lctx)}, ${compute(this.enumValue(tt.enum, raw))}, ${phase})`
          );
          return null;
        }
        case "transform": {
          if (!tt.write) return leaf(tt.inner, raw, lctx);
          const w = this.expr(tt.write, { ...lctx, it: { code: paren(raw), type: tt.valueType } });
          return leaf(tt.inner, this.x.to(w, valueTypeOf(this.model, tt.inner)), lctx);
        }
        case "layered":
          return this.emitLayers(tt.layers, tt.layers.length - 1, lctx, inner =>
            leaf(tt.inner, raw, inner)
          );
        case "bytes":
        case "string": {
          const n = this.model.staticSize(tt);
          if (n === undefined) break;
          const conv =
            tt.kind === "string"
              ? `_rt.encode_fixed_string(${stripParens(raw)}, ${n}, ${tt.unit}, ${pyStr(tt.encoding)}, ${this.leOf(tt.endian, lctx)})`
              : raw;
          c.line(`_w.defer_bytes(${n}, ${compute(conv)}, ${phase})`);
          return null;
        }
      }
      throw new Error(`cannot write a deferred derived value of type ${tt.kind}`);
    };
    return leaf(t, value, ctx);
  }

  private enumValue(id: string, v: string): string {
    const en = this.model.enum(id);
    return `_rt.enum_value(${this.mod.enumRef(id, "values")}, ${this.mod.enumRef(id, "members")}, ${pyBool(en.open)}, ${stripParens(v)})`;
  }

  // ── types ─────────────────────────────────────────────────────────────────

  /** Emits the write of `value` with type `t`; returns code of the produced layout entry, or null. */
  private write(t: IrType, value: string, ctx: WCtx): string | null {
    if (!this.model.isRefTarget(t)) return this.writeInner(t, value, ctx);
    // A possible `@ref` target: its encoding is registered as a ref site.
    const s = this.code.fresh("rs");
    this.code.line(`${s} = _w.offset`);
    const e = this.writeInner(t, value, ctx);
    this.code.line(`_w.ref_site(${pyStr(this.model.typeKey(t))}, ${s}, ${stripParens(value)})`);
    return e;
  }

  private writeInner(t: IrType, value: string, ctx: WCtx): string | null {
    const c = this.code;
    const v = stripParens(value);
    switch (t.kind) {
      case "prim":
        c.line(primWrite(t.prim, v, this.leOf(t.endian, ctx)));
        return null;
      case "bool":
        c.line(`_w.bool(${v})`);
        return null;
      case "string": {
        const le = t.unit === 1 ? "True" : this.leOf(t.endian, ctx);
        const n = t.length.kind === "count" ? `, ${this.len(t.length.expr, ctx)}` : "";
        c.line(`_w.str(${v}, ${t.unit}, ${pyStr(t.encoding)}, ${le}, ${pyStr(t.length.kind)}${n})`);
        return null;
      }
      case "bytes": {
        if (t.length.kind === "count") {
          const n = this.lengthCheck(t.length.expr, ctx, value);
          c.line(n === undefined ? `_w.bytes(${v})` : `_w.bytes_n(${v}, ${n})`);
        } else if (t.length.kind === "until") {
          c.line(`_w.bytes_until(${v}, ${this.num(t.length.terminator, ctx)})`);
        } else c.line(`_w.bytes(${v})`);
        return null;
      }
      case "array":
        return this.array(t, value, ctx);
      case "struct":
        return this.struct(t.struct, t.args, value, ctx);
      case "enum": {
        const storage = this.model.enum(t.enum).storage;
        c.line(primWrite(storage, this.enumValue(t.enum, v), this.leOf(t.endian, ctx)));
        return null;
      }
      case "pointer":
        return this.pointer(t, value, ctx);
      case "extern": {
        const x = this.model.extern(t.extern);
        const args = this.args(t.args, x.params, ctx);
        const fixed = x.kind === "type" && x.fixedSize !== undefined ? x.fixedSize : -1;
        c.line(`_w.extern(${this.mod.extern(t.extern)}, ${v}, ${pyTuple(args)}, ${fixed})`);
        return null;
      }
      case "union": {
        const u = c.fresh("u");
        const l = c.fresh("l");
        const hasL = this.model.hasPlaceables(t);
        c.line(`${u} = _rt.union_value(${v})`);
        if (hasL) c.line(`${l}: _t.Any = None`);
        const parts = t.variants.map((vr, i): [string, () => void] => [
          `${i ? "elif" : "if"} ${u}.type == ${pyStr(vr.name)}`,
          () => {
            const e = this.write(vr.type, `${u}.value`, ctx);
            if (e && hasL) c.line(`${l} = ${e}`);
          }
        ]);
        parts.push([
          "else",
          () => c.line(`_rt.fail("INPUT", f"unknown union variant {${u}.type!r}")`)
        ]);
        c.chain(parts);
        return hasL ? l : null;
      }
      case "transform": {
        if (!t.write) return this.write(t.inner, value, ctx);
        const val = c.fresh("tv");
        c.line(`${val} = ${v}`);
        const raw = c.fresh("raw");
        const innerVt = valueTypeOf(this.model, t.inner);
        const w = this.expr(t.write, { ...ctx, it: { code: val, type: t.valueType } });
        c.line(`${raw} = ${stripParens(this.x.to(w, innerVt))}`);
        // Round trip: read(write(v)) must give v back (floats: within half a storage step).
        const readBack = (it: string): string =>
          stripParens(
            this.x.to(this.expr(t.read, { ...ctx, it: { code: it, type: innerVt } }), t.valueType)
          );
        if (t.valueType.kind === "float" && innerVt.kind === "int") {
          c.line(
            `_rt.check_float_round_trip(${val}, ${readBack(raw)}, ${readBack(`(${raw} + 1)`)})`
          );
        } else c.line(`_rt.check_round_trip(${val}, ${readBack(raw)})`);
        return this.write(t.inner, raw, ctx);
      }
      case "layered":
        return this.emitLayers(t.layers, t.layers.length - 1, { ...ctx, reuse: value }, inner =>
          this.write(t.inner, value, inner)
        );
    }
  }

  /**
   * The length a count expression gives, for checking the written value. When it depends on
   * sizes or positions (`u8 gap[tOfs - 0x19 - $offset]`), the check runs after layout instead and
   * this returns undefined.
   */
  private lengthCheck(e: IrExpr, ctx: WCtx, value: string): string | undefined {
    if (this.deriveClass(ctx.s, e) === "value") return this.len(e, ctx);
    const m = this.code.fresh("m");
    this.code.line(`${m} = _w.mark()`);
    const n = this.len(e, {
      ...ctx,
      offsetCode: `(${m}.block.pos + ${m}.at)`,
      endCode: `len(${m}.block.region.output)`
    });
    this.deferCheck(() =>
      this.code.line(`_rt.check_length(_rt.size_of(${stripParens(value)}), ${n})`)
    );
    return undefined;
  }

  private struct(
    id: string,
    args: readonly IrExpr[],
    value: string,
    ctx: WCtx,
    layers: readonly IrLayer[] = inlineLayers(this.model.struct(id))
  ): string | null {
    const s = this.model.struct(id);
    const call = (inner: WCtx): string | null => {
      const isAsync = s.async && inner.async;
      const fn = this.mod.structFn(id, isAsync ? "write_async" : "write");
      const argCode = this.args(args, s.params, inner);
      const callExpr = `${isAsync ? "await " : ""}${fn}(${["_w", stripParens(value), ...argCode].join(", ")})`;
      if (!this.model.structHasPlaceables(id)) {
        this.code.line(callExpr);
        return null;
      }
      const l = this.code.fresh("l");
      this.code.line(`${l} = ${callExpr}`);
      return l;
    };
    if (!layers.length) return call(ctx);
    return this.emitLayers(
      layers,
      layers.length - 1,
      { ...ctx, reuse: value, extent: undefined, slot: `${ctx.slot}#${s.name}` },
      call
    );
  }

  private array(t: Extract<IrType, { kind: "array" }>, value: string, ctx: WCtx): string | null {
    const c = this.code;
    const depth = ctx.depth;
    this.st.maxDepth = Math.max(this.st.maxDepth, depth + 1);
    const slot = `_p[${depth + 1}]`;
    const a = c.fresh("a");
    const i = c.fresh("i");
    const hasL = this.model.hasPlaceables(t);
    c.line(`${a} = _rt.array_value(${stripParens(value)})`);
    if (t.length.kind === "count") {
      const n = this.lengthCheck(t.length.expr, ctx, a);
      if (n !== undefined && n !== `len(${a})`) c.line(`_rt.check_length(len(${a}), ${n})`);
    }
    const la = hasL ? c.fresh("la") : undefined;
    if (la) c.line(`${la} = _rt.LArray()`);
    const setIndex = elementUsesIndex(this.model, t.element, true);
    const saved = setIndex ? c.fresh("ix") : undefined;
    if (saved) c.line(`${saved} = _w.index`);
    const ectx: WCtx = { ...ctx, index: i, depth: depth + 1, extent: undefined };
    const term =
      t.length.kind === "until" || t.length.kind === "before"
        ? this.expr(t.length.terminator, ctx)
        : undefined;
    const pred = t.length.kind === "untilPredicate" ? t.length.predicate : undefined;
    const el = c.fresh("el");
    c.block(`for ${i}, ${el} in enumerate(${a})`, () => {
      c.line(`${slot} = ${i}`);
      if (saved) c.line(`_w.index = ${i}`);
      if (term)
        c.line(`if ${el} == ${term.code}: _rt.fail("INPUT", "an element equals the terminator")`);
      if (pred) {
        // `until <predicate>`: only the last element may satisfy it (and it must).
        const it = { code: el, type: valueTypeOf(this.model, t.element) };
        const cond = this.expr(pred, { ...ctx, it }).code;
        c.line(
          `if bool(${stripParens(cond)}) != (${i} == len(${a}) - 1): _rt.fail("CHECK", "until: only the last element may (and must) end the array")`
        );
      }
      if (t.elementPlacement) {
        const off = this.num(t.elementPlacement, ectx);
        const fn = this.closure(ctx.async, () => this.write(t.element, el, ectx));
        const P = c.fresh("P");
        const place = ctx.async ? "await _w.place_async" : "_w.place";
        c.line(`${P} = ${place}(${pyStr(`${ctx.fieldName}[]`)}, ${el}, ${fn}, fixed=${off})`);
        if (la) c.line(`${la}.push(${P})`);
      } else {
        const e = this.write(t.element, el, ectx);
        if (la) c.line(`${la}.push(${e ?? "None"})`);
      }
    });
    if (pred)
      c.line(`if not ${a}: _rt.fail("CHECK", "until: the array needs an element that ends it")`);
    if (term && t.length.kind === "until") {
      c.line(`${slot} = len(${a})`);
      if (saved) c.line(`_w.index = len(${a})`);
      const e = this.write(t.element, this.x.to(term, valueTypeOf(this.model, t.element)), ectx);
      if (la && e) c.line(`${la}.push(${e})`);
    }
    if (saved) c.line(`_w.index = ${saved}`);
    c.line(`${slot} = -1`);
    return la ?? null;
  }

  private pointer(
    t: Extract<IrType, { kind: "pointer" }>,
    value: string,
    ctx: WCtx
  ): string | null {
    const c = this.code;
    const tv = c.fresh("tv");
    c.line(`${tv} = ${stripParens(value)}`);
    const nv = t.nullValue !== undefined ? pyInt(BigInt(t.nullValue)) : "None";
    const le = this.leOf(t.storageEndian, ctx);
    const tctx: WCtx = { ...ctx, extent: undefined };
    // `@nullable(empty)`: an empty array is written as the null value (no target).
    const isNull = t.emptyIsNull ? `_rt.is_empty(${tv})` : `${tv} is None`;
    // `@origin(expr)`: the stored value is relative to base + origin (computed after layout).
    const o = t.origin;
    const origin = o ? `, ${this.closure(false, () => this.num(o, ctx))}` : "";
    const rel = pyBool(t.relative);
    const key = pyStr(this.model.typeKey(t.target));
    if (t.ownership === "ref") {
      const body = this.closure(false, () => this.write(t.target, tv, tctx));
      const enc = this.closure(false, () => `_w.encode_alone(${body})`);
      c.line(
        `_w.ref_pointer(${pyStr(t.storage)}, ${le}, ${key}, None if ${isNull} else ${tv}, ${enc}, ${rel}, ${nv}${origin})`
      );
      return null;
    }
    const P = c.fresh("P");
    const fn = this.closure(ctx.async, () => this.write(t.target, tv, tctx));
    const owner = ctx.depth === 0 ? `, owner=${ctx.owner ?? "_v"}` : "";
    const target = ctx.async ? "await _w.target_async" : "_w.target";
    c.line(
      `${P} = None if ${isNull} else ${target}(${tv}, ${key}, ${pyStr(ctx.fieldName)}, ${fn}${owner})`
    );
    c.line(`_w.pointer(${pyStr(t.storage)}, ${le}, ${P}, ${rel}, ${nv}${origin})`);
    return P;
  }

  // ── bits ──────────────────────────────────────────────────────────────────

  private emitBits(b: IrBits, ctx: WCtx): void {
    const c = this.code;
    const u = c.fresh("u");
    c.line(`${u} = 0`);
    for (const f of b.fields) {
      if (f.name === null) continue;
      c.line(`_p[0] = ${pyStr(f.name)}`);
      const bits = this.bitsOf(f, this.bitFieldValue(f, ctx), ctx);
      c.line(f.shift ? `${u} |= ${bits} << ${f.shift}` : `${u} |= ${bits}`);
    }
    c.line(primWrite(b.storage, u, this.leOf(b.endian, ctx)));
  }

  private bitFieldValue(f: IrBitField, ctx: WCtx): string {
    const vt = valueTypeOf(this.model, f.type);
    const v =
      f.input !== "required" && f.derive
        ? this.x.to(this.fieldRef(f.name!, vt, ctx), vt)
        : `_v.${this.attr(ctx.s, f.name!)}`;
    const checks = f.checks.filter(ch => !ch.strictOnly);
    if (!checks.length) return v;
    const tmp = this.code.fresh("val");
    this.code.line(`${tmp} = ${stripParens(v)}`);
    this.emitWriteChecks(checks, tmp, vt, ctx, f.input === "absent" ? "DERIVE" : "CHECK");
    return tmp;
  }

  /** A bitfield value as unsigned bits of its width. */
  private bitsOf(f: IrBitField, value: string, ctx: WCtx): string {
    let t = f.type.kind === "layered" ? f.type.inner : f.type;
    let v = value;
    if (t.kind === "transform") {
      if (t.write) {
        const w = this.expr(t.write, { ...ctx, it: { code: value, type: t.valueType } });
        v = this.x.to(w, valueTypeOf(this.model, t.inner));
      }
      t = t.inner;
    }
    v = stripParens(v);
    if (t.kind === "bool") return `_rt.bool_bit(${v})`;
    if (t.kind === "enum") return `_rt.bits_of(${this.enumValue(t.enum, v)}, ${f.width}, False)`;
    const signed = t.kind === "prim" && t.prim[0] === "i";
    return `_rt.bits_of(${v}, ${f.width}, ${pyBool(signed)})`;
  }

  // ── layers ────────────────────────────────────────────────────────────────

  /**
   * Emits layers `layers[idx]` (outermost) down to `layers[0]` around `inner`; returns the layout
   * entry `inner` produced. `ctx.extent` (if set) records the size after each stage.
   */
  private emitLayers(
    layers: readonly IrLayer[],
    idx: number,
    ctx: WCtx,
    inner: (ctx: WCtx) => string | null
  ): string | null {
    if (idx < 0) return inner(ctx);
    const l = layers[idx]!;
    const c = this.code;
    const extent = ctx.extent;
    const recordStage = (sizeExpr: string): void => {
      if (extent) c.line(`${extent}.stages[${idx}] = ${sizeExpr}`);
    };
    const next = (x: WCtx): string | null => {
      const s = extent ? c.fresh("so") : undefined;
      if (s) c.line(`${s} = _w.offset`);
      const e = this.emitLayers(layers, idx - 1, x, inner);
      if (s) recordStage(`_w.offset - ${s}`);
      return e;
    };
    switch (l.kind) {
      case "align":
        c.line(
          `_w.align(${this.num(l.to, ctx)}, ${this.fill(l.fill, ctx)}${this.alignArgs(l, ctx)})`
        );
        return next(ctx);
      case "padBefore":
        c.line(`_w.pad(${this.len(l.count, ctx)}, ${this.fill(l.fill, ctx)})`);
        return next(ctx);
      case "padAfter": {
        const e = next(ctx);
        c.line(`_w.pad(${this.len(l.count, ctx)}, ${this.fill(l.fill, ctx)})`);
        return e;
      }
      case "padUntil": {
        const s = c.fresh("s");
        c.line(`${s} = _w.offset`);
        const e = next(ctx);
        c.line(`_w.pad_until(${s}, ${this.len(l.size, ctx)}, ${this.fill(l.fill, ctx)})`);
        return e;
      }
      case "alignEnd": {
        const e = next(ctx);
        c.line(
          `_w.align(${this.num(l.to, ctx)}, ${this.fill(l.fill, ctx)}${this.alignArgs(l, ctx)})`
        );
        return e;
      }
      case "size": {
        const s = c.fresh("s");
        c.line(`${s} = _w.offset`);
        const e = next(ctx);
        c.line(`_w.size_window(${s}, ${this.len(l.size, ctx)})`);
        return e;
      }
      case "via": {
        const codec = this.model.codec(l.codec);
        const args = this.args(l.args, codec.params, ctx);
        const plain = c.fresh("plain");
        const fn = this.closure(ctx.async, () => this.emitLayers(layers, idx - 1, ctx, inner));
        const sub = ctx.async ? "await _w.sub_region_async" : "_w.sub_region";
        c.line(`${plain} = ${sub}(None, ${fn})`);
        recordStage(`len(${plain})`);
        if (extent) c.line(`if ${extent}.plain is None: ${extent}.plain = bytes(${plain})`);
        const size = decodedSize(layers, idx) ? `, len(${plain})` : "";
        const ctxObj = `_rt.CodecContext([${args.join(", ")}]${size})`;
        if (codec.async && !ctx.async)
          throw new Error(`async codec ${codec.name} in a sync writer`);
        const enc = c.fresh("enc");
        c.line(
          `${enc} = _rt.reuse_codec(${stripParens(ctx.reuse ?? "None")}, ${pyStr(`${ctx.slot}#${idx}`)}, ${plain})`
        );
        const encode = codec.async ? "await _rt.encode_async" : "_rt.encode";
        c.block(`if ${enc} is None`, () =>
          c.line(
            `${enc} = ${encode}(${this.mod.extern(l.codec)}, ${pyStr(codec.name)}, ${plain}, ${ctxObj})`
          )
        );
        c.line(`_w.raw(${enc})`);
        return null;
      }
      case "endian": {
        const e = c.fresh("en");
        const le = c.fresh("le");
        c.line(`${e} = ${stripParens(this.expr(l.value, ctx).code)}`);
        c.line(`${le} = ${e} == "le"`);
        return next({ ...ctx, endian: e, le });
      }
      case "strict":
        return next(ctx);
    }
  }

  /** A base's (or the root's) `@alignEnd`: pads the end of its whole region. */
  private regionEnd(l: Extract<IrLayer, { kind: "alignEnd" }>, ctx: WCtx): string {
    return `_w.region.end_align(${this.num(l.to, ctx)}${this.alignArgs(l, ctx)})`;
  }

  // ── virtual streams ───────────────────────────────────────────────────────

  /**
   * `from` fields: encode the value, then hand the bytes to the stream's source fields (they are
   * written with these overrides).
   */
  private emitStreamPrepass(s: IrStruct, ctx: WCtx): void {
    const c = this.code;
    /** Slice carrier field → `(start, end, bytes)` tuples of its slices. */
    const carriers = new Map<string, string[]>();
    for (const f of this.model.fields(s)) {
      const fld = f.field;
      if (!fld?.from) continue;
      const st = fld.from.stream;
      const carrier = st.kind === "slice" ? this.sliceCarrier(s, st) : undefined;
      // A slice of a field that stays an input is read-only (its value isn't written).
      if (st.kind === "slice" && !carrier) continue;
      c.line(`_p[0] = ${pyStr(fld.name)}`);
      const fn = this.closure(ctx.async, () =>
        this.write(fld.type, `_v.${this.attr(s, fld.name)}`, { ...ctx, fieldName: fld.name })
      );
      const enc = c.fresh("stream");
      c.line(`${enc} = ${ctx.async ? "await _w.sub_region_async" : "_w.sub_region"}(None, ${fn})`);
      if (st.kind === "slice" && carrier) {
        const a = this.num(st.start, ctx);
        const b = st.end ? this.num(st.end, ctx) : "None";
        carriers.set(carrier, [...(carriers.get(carrier) ?? []), `(${a}, ${b}, ${enc})`]);
      } else if (st.kind === "field") {
        const local = c.fresh("sf");
        c.line(`${local} = bytes(${enc})`);
        this.st.overrides.set(st.field, local);
      } else if (st.kind === "each") {
        this.splitStream(st, enc, s, ctx, fld.from.split?.policy);
      }
    }
    // Each carrier is assembled from its slices: zero-filled, every slice's encoding at its start.
    for (const [name, parts] of carriers) {
      const t = stripType(this.model.field(s, name)!.field!.type);
      const n =
        t.kind === "bytes" && t.length.kind === "count" ? this.len(t.length.expr, ctx) : "None";
      const local = c.fresh("carrier");
      c.line(`_p[0] = ${pyStr(name)}`);
      c.line(`${local} = _rt.assemble_slices(${n}, [${parts.join(", ")}])`);
      this.st.overrides.set(name, local);
    }
  }

  /** The carrier field a slice stream writes into, if the slice is writable. */
  private sliceCarrier(
    s: IrStruct,
    st: Extract<IrStreamExpr, { kind: "slice" }>
  ): string | undefined {
    if (st.stream.kind !== "field") return undefined;
    const base = this.model.field(s, st.stream.field)?.field;
    return base?.carrier === "slices" ? base.name : undefined;
  }

  /**
   * `from arr[*].field`: the stream's bytes split into the elements' bytes fields, by the
   * pieces' size fields in the input, else by the `@split` policy (fit: the longest piece whose
   * element fits before the next one).
   */
  private splitStream(
    st: Extract<IrStreamExpr, { kind: "each" }>,
    bytes: string,
    s: IrStruct,
    ctx: WCtx,
    policy: string | undefined
  ): void {
    const c = this.code;
    const arr = this.model.field(s, st.array)?.field;
    if (!arr) throw new Error(`unknown stream array ${st.array}`);
    const el = unlayer(arr.type);
    if (el.kind !== "array") throw new Error(`${st.array} is not an array`);
    const et = unlayer(el.element);
    if (et.kind !== "struct") throw new Error(`${st.array} elements are not structs`);
    const es = this.model.struct(et.struct);
    const piece = this.model.field(es, st.field)?.field;
    const sizeField = piece ? innerSizeField(piece.type) : undefined;
    const local = c.fresh("els");
    let fit = "None";
    if (policy === "fit" && el.elementPlacement) {
      const off = this.num(el.elementPlacement, { ...ctx, index: "_k" });
      const elemT = el.element;
      const size = this.closure(
        false,
        () => {
          const write = this.closure(false, () =>
            this.write(elemT, "_x", { ...ctx, index: "-1", fieldName: st.array })
          );
          return `len(_w.encode_alone(${write}))`;
        },
        ["_x"]
      );
      fit = `((lambda _k: ${off}), ${size})`;
    }
    const cls = this.mod.structClass(et.struct);
    const sizeAttr = sizeField ? pyStr(this.attr(es, sizeField)) : "None";
    c.line(
      `${local} = _rt.split_stream(getattr(_v, ${pyStr(this.attr(s, st.array))}, None), ${pyStr(this.attr(es, st.field))}, bytes(${bytes}), ${sizeAttr}, ${fit}, lambda: ${cls}.__new__(${cls}))`
    );
    this.st.overrides.set(st.array, local);
  }
}

/** `_rt.need`'s field list: attribute names, or `(attribute, name)` when they differ. */
function needList(fields: { attr: string; name: string }[]): string {
  return pyTuple(
    fields.map(f => (f.attr === f.name ? pyStr(f.attr) : `(${pyStr(f.attr)}, ${pyStr(f.name)})`))
  );
}

function primWrite(p: string, value: string, le: string): string {
  if (p === "u8") return `_w.u8(${value})`;
  if (p === "u16" || p === "u32" || p === "u64") return `_w.${p}(${value}, ${le})`;
  return `_w.prim(${pyStr(p)}, ${value}, ${le})`;
}

// ── layout literals ─────────────────────────────────────────────────────────

/** How `layoutLiteral` turns a layer argument into code: alignments, pad counts, offsets. */
type LayoutArg = (e: IrExpr, what: "align" | "pad" | "offset") => string;

/** A constant that `_rt.layout_align` / `_rt.layout_pad` would reject (checked on write). */
function badConst(v: number, what: "align" | "pad" | "offset"): boolean {
  return (what === "align" && v < 1) || (what === "pad" && v < 0);
}

const constLayoutArg: LayoutArg = (e, what) => {
  const v = literalInt(e);
  if (v === undefined || badConst(v, what))
    throw new Error("layout item layers must have valid constant arguments");
  return String(v);
};

/**
 * True if a layout's layer arguments are evaluated when the struct is written (they read fields,
 * parameters or `$index`; a constant alignment below 1 is a `RANGE` error on write too).
 */
function layoutIsDynamic(items: readonly IrLayoutItem[]): boolean {
  let dynamic = false;
  layoutLiteral(items, (e, what) => {
    const v = literalInt(e);
    if (v === undefined || badConst(v, what)) dynamic = true;
    return "0";
  });
  return dynamic;
}

/**
 * Layout items as a Python literal: `((path, layers[, group]), …)` where a path is `"this"` or a
 * tuple of field names (`"*"` for `[*]`), layers are `(kind, n[, offset, from_file])` and a
 * per-element group carries its nested items. `arg` compiles each layer argument (by default
 * constants only).
 */
function layoutLiteral(items: readonly IrLayoutItem[], arg: LayoutArg = constLayoutArg): string {
  const parts = items.map(it => {
    const path =
      it.path === "this"
        ? `"this"`
        : pyTuple(it.path.map(seg => (seg.kind === "each" ? `"*"` : pyStr(seg.name))));
    const layers: string[] = [];
    for (const l of it.layers) {
      if (l.kind === "align" || l.kind === "alignEnd") {
        const to = arg(l.to, "align");
        const tail =
          l.offset || l.from === "file"
            ? `, ${l.offset ? arg(l.offset, "offset") : 0}, ${pyBool(l.from === "file")}`
            : "";
        layers.push(`(${pyStr(l.kind)}, ${to}${tail})`);
      } else if (l.kind === "padBefore" || l.kind === "padAfter") {
        layers.push(`(${pyStr(l.kind)}, ${arg(l.count, "pad")})`);
      }
    }
    const group = it.group ? `, ${layoutLiteral(it.group.items, arg)}` : "";
    return `(${path}, ${pyTuple(layers)}${group})`;
  });
  return pyTuple(parts);
}
