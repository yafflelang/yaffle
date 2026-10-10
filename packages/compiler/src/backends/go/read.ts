/**
 * Reader emitter: one `readX` function per struct, imperative code over yaffle.Reader following
 * docs/IR.md §2.
 */
import type {
  IrBits,
  IrExpr,
  IrField,
  IrLayer,
  IrLength,
  IrMember,
  IrStreamExpr,
  IrStruct,
  IrType
} from "../../ir/index.ts";
import { Code, fixUnused, funcLit, goStr, local, stripParens } from "./code.ts";
import { Emitter, paramList, structCtx, type EmitCtx } from "./emitter.ts";
import { encConst, formatInt, type ExprCtx } from "./expr.ts";
import { isOneWay, literalInt, readSideExtents, stripLayers, usesIndex } from "./irutil.ts";
import { BackendError, primGo, primSize, valueTypeOf, type GoField } from "./model.ts";
import { childSafe, needsDeepScan, scanFacts } from "./viewinfo.ts";

interface RCtx extends EmitCtx {
  /** Reader variable. */
  r: string;
  field?: string | undefined;
  /** Where a pointer field's value goes (pointers with `@origin` assign it after the members). */
  lvalue?: ((value: string) => string) | undefined;
  /** Views: a codec region of this field may be skipped by a shallow scan (decoded on access). */
  lazyVia?: boolean | undefined;
  /** Views: this stream piece may be left undecoded by a shallow scan (yaffle.JoinPieces). */
  lazyPiece?: boolean | undefined;
}

/** Locals holding a field's start and end, for read-side sizeof/offsetof/bytesof. */
interface Ext {
  start: string;
  end: string;
  useStart: boolean;
  useEnd: boolean;
}

interface StructState {
  extents: Map<string, Ext>;
  needExtent: Set<string>;
  /** Statements run after the members (pointers with `@origin`). */
  deferred: string[];
  /** Views: fields whose codec regions a shallow scan may skip. */
  lazyVia: Set<string>;
  /** Views: stream pieces a shallow scan may leave undecoded. */
  lazyPieces: Set<string>;
  /** Views: `from` fields a shallow scan doesn't read. */
  deferFrom: Set<string>;
}

/** Returned by read: the value was assigned already (a pointer with `@origin`). */
const ASSIGNED = "\u0000assigned";

function emptyState(): StructState {
  return {
    extents: new Map(),
    needExtent: new Set(),
    deferred: [],
    lazyVia: new Set(),
    lazyPieces: new Set(),
    deferFrom: new Set()
  };
}

export class ReadEmitter extends Emitter<RCtx> {
  private st!: StructState;
  /** The raw value of the last one-way transform read (stored next to the value). */
  private lastRaw: string | undefined;
  /** Generate view support (readers record their arguments while a view scans). */
  views = true;

  /** Emits `readX`. */
  emitStruct(out: Code, s: IrStruct): void {
    const name = this.model.structName(s.id);
    const facts = this.views ? scanFacts(this.model, s) : undefined;
    this.st = {
      ...emptyState(),
      needExtent: readSideExtents(s),
      lazyVia: facts?.lazyVia ?? new Set(),
      lazyPieces: facts?.lazyPieces ?? new Set(),
      deferFrom: facts?.deferFrom ?? new Set()
    };
    const body = new Code();
    this.code = body;
    const ctx: RCtx = { ...structCtx(s, "index", name), r: "r" };
    this.emitMembers(s.members, ctx);
    for (const d of this.st.deferred) body.line(d);
    const ends = s.base ? s.layers.filter(l => l.kind === "alignEnd") : [];
    if (s.base) body.line(`r.MarkInline()`);
    if (ends.length) {
      body.line(`r.Field(fr, "")`);
      body.line(`r.Pos = max(r.Pos, r.MaxEnd)`);
      for (const l of ends) body.line(this.alignCall(l, ctx));
    }
    const fn = new Code();
    fn.block(`func read${name}(r *yaffle.Reader, ${paramList(this.model, s)}) *${name}`, () => {
      fn.line(`v := yaffle.Into[${name}](r)`);
      fn.declareLe(body.toString());
      if (usesIndex(s)) fn.line(`index := r.Index`);
      for (const [n, e] of this.st.extents) {
        if (n === "this") {
          if (e.useStart) fn.line(`${e.start} := r.Pos`);
          continue;
        }
        if (e.useStart) fn.line(`${e.start} := -1`);
        if (e.useEnd) fn.line(`${e.end} := -1`);
      }
      fn.line(`fr := r.EnterV(v)`);
      if (this.views) {
        const args = s.params.map(p => (p.origin === "endian" ? "endian" : local(p.name)));
        fn.block("if r.Scanning()", () =>
          fn.line(`r.NoteArgs(${[`yaffle.ChildSafe(${childSafe(s)})`, ...args].join(", ")})`)
        );
      }
      // Views: read-side expressions that read targets need them followed while scanning.
      const deep = this.views && needsDeepScan(this.model, s);
      if (deep) fn.line(`dp := r.BeginDeep()`);
      if (s.base) {
        fn.line(`base0, max0 := r.Base, r.MaxEnd`);
        fn.line(`sh := r.BeginBase()`);
        fn.line(`r.Base, r.MaxEnd = r.Pos, r.Pos`);
      }
      fn.append(body);
      fn.line(`r.Leave(fr)`);
      if (deep) fn.line(`r.EndDeep(dp)`);
      if (s.base) {
        fn.line(`r.Pos = max(r.Pos, r.MaxEnd)`);
        fn.line(`r.Base, r.MaxEnd = base0, max(max0, r.Pos)`);
        fn.line(`r.EndBase(sh)`);
      }
      fn.line(`return v`);
    });
    out.line(fixUnused(fn.toString()));
  }

  /** Emits the read of a root struct (params are locals named after them); returns the value. */
  rootRead(out: Code, s: IrStruct): string {
    this.st = emptyState();
    this.code = out;
    const args: IrExpr[] = s.params.map(p => ({ kind: "param", name: p.name, type: p.type }));
    return this.struct(s.id, args, { ...structCtx(s, "-1", this.model.structName(s.id)), r: "r" });
  }

  // ── expression context ────────────────────────────────────────────────────

  exprCtx(ctx: RCtx): ExprCtx {
    const r = ctx.r;
    const extent = (f: string, end: boolean): Ext => this.extent(f, end);
    return {
      ...this.commonExprCtx(ctx),
      mode: "read",
      field: (name, type) => {
        const g = this.model.goField(ctx.s, name);
        return this.x.typed(this.value(g), type);
      },
      builtin: name => {
        if (name === "offset") return `(${r}.Pos - ${r}.Base)`;
        if (name === "end") return `(${r}.End - ${r}.Base)`;
        return ctx.index;
      },
      sizeof: f => {
        const e = extent(f, true);
        return `(${e.end} - ${e.start})`;
      },
      offsetof: f => `(${extent(f, false).start} - ${r}.Base)`,
      encodedSize: f => {
        const e = extent(f, true);
        return `(${e.end} - ${e.start})`;
      },
      bytesof: f => {
        const e = extent(f, true);
        return `${r}.PeekBytes(${e.start}, ${e.end})`;
      },
      encode: f => {
        const e = extent(f, true);
        return `${r}.PeekBytes(${e.start}, ${e.end})`;
      }
    };
  }

  /** The locals of a field's extent (declared by emitStruct when used). */
  private extent(f: string, end: boolean): Ext {
    let e = this.st.extents.get(f);
    if (!e) {
      const n = this.st.extents.size + 1;
      e = { start: `xs${n}`, end: `xe${n}`, useStart: false, useEnd: false };
      this.st.extents.set(f, e);
    }
    e.useStart = true;
    if (end) e.useEnd = true;
    return e;
  }

  /** A count read from the data: EOF if the region can't hold that many units. */
  private count(e: IrExpr, ctx: RCtx, unit: number): string {
    const lit = literalInt(e);
    if (lit !== undefined && lit >= 0) return String(lit);
    const c = this.expr(e, ctx);
    if (c.gt === "big") return `${ctx.r}.CountBig(${c.code}, ${unit})`;
    if (c.gt === "uint64") return `${ctx.r}.CountU(${c.code}, ${unit})`;
    if (c.range && c.range[1] > (1n << 63n) - 1n)
      return `${ctx.r}.CountBig(${this.x.asBig(c, this.exprCtx(ctx))}, ${unit})`;
    return `${ctx.r}.Count(${this.x.asI64(c, true)}, ${unit})`;
  }

  private strictCode(ctx: RCtx): string {
    return ctx.s.strict ? "true" : `${ctx.r}.Strict`;
  }

  /** A field's value in the struct being read (`v`). */
  private value(g: GoField): string {
    return g.ptr ? `(*v.${g.go})` : `v.${g.go}`;
  }

  /** Assignment of a field's value. */
  private assign(g: GoField, value: string): string {
    return g.ptr ? `v.${g.go} = yaffle.Ptr(${value})` : `v.${g.go} = ${value}`;
  }

  // ── members ───────────────────────────────────────────────────────────────

  private emitMembers(ms: readonly IrMember[], ctx: RCtx): void {
    for (const m of ms) {
      if (m.kind === "field") this.emitField(m, ctx);
      else if (m.kind === "bits") this.emitBits(m, ctx);
      else if (m.kind === "block") this.emitBlock(m, ctx);
      else this.emitSwitch(m, ctx);
    }
  }

  private emitBlock(m: Extract<IrMember, { kind: "block" }>, ctx: RCtx): void {
    const c = this.code;
    const body = (): void => {
      this.emitLayers(m.layers, m.layers.length - 1, ctx, `${ctx.slot}.block`, undefined, inner => {
        this.emitMembers(m.members, inner);
        return ASSIGNED;
      });
    };
    if (m.condition) {
      const parts: [string, () => void][] = [
        [`if ${stripParens(this.expr(m.condition, ctx).code)}`, body]
      ];
      const els = m.else;
      if (els) parts.push(["else", () => this.emitMembers(els, ctx)]);
      c.chain(parts);
    } else if (m.layers.length) c.block("", body);
    else this.emitMembers(m.members, ctx);
  }

  private emitSwitch(m: Extract<IrMember, { kind: "switch" }>, ctx: RCtx): void {
    const c = this.code;
    const d = c.fresh("d");
    const disc = this.expr(m.discriminant, ctx);
    c.line(`${d} := ${disc.code}`);
    const ectx = this.exprCtx(ctx);
    const parts: [string, () => void][] = m.cases.map((cs, i) => {
      const conds = cs.values.map(v =>
        stripParens(this.x.equality("==", { ...disc, code: d }, this.x.literal(v, ectx), ectx))
      );
      const cond = conds.length > 1 ? conds.map(x => `(${x})`).join(" || ") : conds[0];
      return [`${i ? "else if" : "if"} ${cond}`, () => this.emitMembers(cs.members, ctx)];
    });
    const def = m.default;
    const last = def
      ? () => this.emitMembers(def, ctx)
      : () => c.line(`${ctx.r}.Fail(yaffle.CHECK, "no case matches %v", ${d})`);
    if (parts.length) c.chain([...parts, ["else", last]]);
    else last();
  }

  private emitField(f: IrField, ctx: RCtx): void {
    const c = this.code;
    c.line(`${ctx.r}.Field(fr, ${goStr(f.name)})`);
    const g = this.model.goField(ctx.s, f.name);
    const fctx: RCtx = { ...ctx, slot: `${ctx.s.id}.${f.name}`, field: f.name };
    const ext = this.st.needExtent.has(f.name) ? this.extent(f.name, true) : undefined;
    let start = `${ctx.r}.Pos`;
    if ((f.checks.length || ext) && !f.placement) {
      if (ext) {
        start = ext.start;
        c.line(`${start} = ${ctx.r}.Pos`);
      } else {
        start = c.fresh("s");
        c.line(`${start} := ${ctx.r}.Pos`);
      }
    }
    if (f.virtual) {
      // No bytes: the value is computed from earlier fields.
      const val = this.expr(f.virtual.read, ctx);
      c.line(
        this.assign(g, this.x.to(val, valueTypeOf(this.model, f.type), this.exprCtx(ctx), f.name))
      );
    } else if (f.placement) {
      start = this.emitPlaced(f, g, fctx, ext);
    } else if (f.from) {
      this.emitFrom(f, g, fctx);
    } else {
      this.lastRaw = undefined;
      const v = this.read(f.type, {
        ...fctx,
        lvalue: f.type.kind === "pointer" ? val => this.assign(g, val) : undefined,
        lazyVia: this.st.lazyVia.has(f.name),
        lazyPiece: this.st.lazyPieces.has(f.name)
      });
      if (v !== ASSIGNED) c.line(this.assign(g, v));
      if (this.lastRaw && isOneWay(f.type) && g.raw) {
        const raw = this.lastRaw;
        c.line(g.ptr ? `v.${g.raw.go} = yaffle.Ptr(${raw})` : `v.${g.raw.go} = ${raw}`);
      }
      if (ext) c.line(`${ext.end} = ${ctx.r}.Pos`);
    }
    this.emitChecks(f.checks, f.type, this.value(g), start, ctx);
  }

  /** An `at` field: its target is read at the offset. Returns the address local. */
  private emitPlaced(f: IrField, g: GoField, ctx: RCtx, ext: Ext | undefined): string {
    const c = this.code;
    const placement = f.placement!;
    const o = c.fresh("o");
    c.line(`${o} := ${this.num(placement.offset, ctx)}`);
    const addr = c.fresh("at");
    c.line(`${addr} := ${ctx.r}.Base + ${o}`);
    if (ext) c.line(`${ext.start} = ${addr}`);
    const follow = `${this.targetFn(f.type)}(${ctx.r}, ${addr}, ${this.targetKey(f.type, ctx)}, ${this.inClosure(f.type, ctx)})`;
    if (placement.emptyIsNull) {
      c.chain([
        [
          `if ${o} == 0`,
          () => {
            if (this.views) c.line(`${ctx.r}.NoTarget()`);
            c.line(this.assign(g, emptyValue(f.type, this.model)));
          }
        ],
        ["else", () => c.line(this.assign(g, follow))]
      ]);
    } else c.line(this.assign(g, follow));
    if (ext) {
      const size = this.model.staticSize(f.type);
      c.line(`${ext.end} = ${size !== undefined ? `${addr} + ${size}` : `${ctx.r}.LastTargetEnd`}`);
    }
    return addr;
  }

  /** A field read from a stream; views may defer the read to a getter. */
  private emitFrom(f: IrField, g: GoField, ctx: RCtx): void {
    const c = this.code;
    const readFrom = (view: boolean): string => {
      const stream = this.stream(f.from!.stream, ctx);
      const sr = c.fresh("sr");
      this.code.line(`${sr} := ${ctx.r}.${view ? "SubView" : "Sub"}(${stream})`);
      return this.read(f.type, { ...ctx, r: sr });
    };
    if (this.st.deferFrom.has(f.name)) {
      const closure = this.closureOf("any", () => readFrom(true));
      c.chain([
        [`if ${ctx.r}.Lazy()`, () => c.line(`${ctx.r}.Defer(${goStr(f.name)}, ${closure})`)],
        ["else", () => c.line(this.assign(g, readFrom(false)))]
      ]);
    } else c.line(this.assign(g, readFrom(false)));
  }

  private emitChecks(
    checks: readonly { expr: IrExpr; message: string; strictOnly: boolean }[],
    t: IrType,
    value: string,
    start: string,
    ctx: RCtx
  ): void {
    for (const ch of checks) {
      const it = this.x.typed(value, valueTypeOf(this.model, t));
      const cond = this.expr(ch.expr, { ...ctx, it }).code;
      const guard = ch.strictOnly ? `${this.strictCode(ctx)} && ` : "";
      this.code.block(`if ${guard}!${wrapNot(cond)}`, () => {
        this.code.line(`${ctx.r}.CheckFail(${goStr(ch.message)}, ${start})`);
      });
    }
  }

  /** Emits whatever f emits inside a func literal returning `goType`. */
  private closureOf(goType: string, f: () => string): string {
    const { inner, value } = this.capture(f);
    if (inner.empty) return funcLit(`func() ${goType}`, value);
    const body = new Code();
    body.block(`func() ${goType}`, () => {
      body.append(inner);
      body.line(`return ${value}`);
    });
    return body.toString();
  }

  /** The read of t inside a func literal. */
  private inClosure(t: IrType, ctx: RCtx): string {
    return this.closureOf(this.model.goType(t), () => this.read(t, ctx));
  }

  private targetFn(t: IrType): string {
    return stripLayers(t).kind === "struct" ? "yaffle.TargetStruct" : "yaffle.Target";
  }

  private stream(st: IrStreamExpr, ctx: RCtx): string {
    switch (st.kind) {
      case "field":
        return `yaffle.BytesStream(v.${this.model.goField(ctx.s, st.field).go})`;
      case "each": {
        const g = this.model.goField(ctx.s, st.array);
        const et = this.model.elementStruct(ctx.s, st.array);
        if (!et) throw new BackendError(`${st.array} is not an array of structs`);
        const pg = this.model.goField(et, st.field);
        const en = this.model.structName(et.id);
        return `yaffle.JoinPieces(v.${g.go}, func(x *${en}) []byte { return x.${pg.go} }, func(x *${en}) *yaffle.Meta { return &x.yfl }, ${goStr(st.field)})`;
      }
      case "slice": {
        const inner = this.stream(st.stream, ctx);
        const start = this.num(st.start, ctx);
        const end = st.end ? this.num(st.end, ctx) : "-1";
        return `yaffle.SliceOf(${inner}, ${start}, ${end})`;
      }
    }
  }

  // ── types ─────────────────────────────────────────────────────────────────

  /** Emits statements for reading t; returns an expression to evaluate right after them. */
  private read(t: IrType, ctx: RCtx): string {
    if (ctx.lazyVia && t.kind !== "layered" && t.kind !== "struct")
      ctx = { ...ctx, lazyVia: false };
    if (ctx.lazyPiece && t.kind !== "layered") ctx = { ...ctx, lazyPiece: false };
    if (t.kind === "struct" && this.model.identityStructs.has(t.struct)) {
      const key = this.targetKey(t, ctx);
      const body = this.closureOf(this.model.goType(t), () => this.readInner(t, ctx));
      return `yaffle.Inline(${ctx.r}, ${key}, ${body})`;
    }
    return this.readInner(t, ctx);
  }

  private readInner(t: IrType, ctx: RCtx): string {
    const r = ctx.r;
    switch (t.kind) {
      case "prim":
        return this.prim(t.prim, this.leOf(t.endian, ctx), r);
      case "bool":
        return `${r}.Bool(${this.strictCode(ctx)})`;
      case "string": {
        const le = t.unit === 1 ? "true" : this.leOf(t.endian, ctx);
        const enc = encConst(t.encoding);
        if (t.length.kind === "count")
          return `${r}.Str(${this.count(t.length.expr, ctx, t.unit)}, ${t.unit}, ${enc}, ${le})`;
        if (t.length.kind === "until") return `${r}.StrUntil(${t.unit}, ${enc}, ${le})`;
        return `${r}.StrRest(${t.unit}, ${enc}, ${le})`;
      }
      case "bytes":
        if (t.length.kind === "count") return `${r}.Bytes(${this.count(t.length.expr, ctx, 1)})`;
        if (t.length.kind === "until")
          return `${r}.BytesUntil(${this.byteOf(this.expr(t.length.terminator, ctx))})`;
        return `${r}.BytesRest()`;
      case "array":
        return this.array(t, ctx);
      case "struct":
        return this.struct(t.struct, t.args, ctx);
      case "enum": {
        const raw = this.prim(this.model.enum(t.enum).storage, this.leOf(t.endian, ctx), r);
        if (this.model.enum(t.enum).open) return `${this.model.enumName(t.enum)}(${raw})`;
        const s = this.code.fresh("s");
        this.code.line(`${s} := ${r}.Pos`);
        return this.checkedEnum(t.enum, raw, s, ctx);
      }
      case "pointer":
        return this.pointer(t, ctx);
      case "extern": {
        const x = this.model.extern(t.extern);
        if (x.kind !== "type") throw new BackendError(`extern ${x.name} is not a type`);
        const args = this.args(t.args, x.params, ctx);
        const vt = this.model.goValueType(x.valueType);
        const fixed = x.fixedSize ?? -1;
        return `yaffle.ReadExtern[${vt}](${r}, ${this.mod.extern(t.extern)}, []any{${args.join(", ")}}, ${fixed})`;
      }
      case "union":
        return this.union(t, ctx);
      case "transform": {
        const it = this.code.fresh("it");
        this.code.line(`${it} := ${this.read(t.inner, ctx)}`);
        if (!t.write) this.lastRaw = it;
        const itc = this.x.typed(it, valueTypeOf(this.model, t.inner));
        const v = this.expr(t.read, { ...ctx, it: itc });
        return this.x.to(v, t.valueType, this.exprCtx(ctx));
      }
      case "layered":
        return this.emitLayers(t.layers, t.layers.length - 1, ctx, ctx.slot, t.inner, inner =>
          this.read(t.inner, inner)
        );
    }
  }

  /** A value of a closed enum (CHECK unless it is a member). */
  private checkedEnum(id: string, raw: string, start: string, ctx: RCtx): string {
    const c = this.code;
    const e = c.fresh("e");
    c.line(`${e} := ${this.model.enumName(id)}(${raw})`);
    c.block(`if !${e}.IsKnown()`, () =>
      c.line(`${ctx.r}.FailAt(yaffle.CHECK, ${start}, "%d is not a member of the enum", ${e})`)
    );
    return e;
  }

  private union(t: Extract<IrType, { kind: "union" }>, ctx: RCtx): string {
    const c = this.code;
    const info = this.model.unionOf(t);
    const u = c.fresh("u");
    c.line(`${u} := &${info.go}{}`);
    c.line(
      `${ctx.r}.Union([]string{${t.variants.map(v => goStr(v.name)).join(", ")}}, func(i int) {`
    );
    c.indent(() => {
      c.line("switch i {");
      t.variants.forEach((v, i) => {
        c.line(`case ${i}:`);
        c.indent(() => {
          c.line(`${u}.${info.variants[i]!.go} = ${this.read(v.type, ctx)}`);
          c.line(`${u}.Type = ${goStr(v.name)}`);
        });
      });
      c.line("}");
    });
    c.line("})");
    return u;
  }

  private prim(p: string, le: string, r: string): string {
    switch (p) {
      case "u8":
        return `${r}.U8()`;
      case "i8":
        return `${r}.I8()`;
      case "u24":
        return `uint32(${r}.UN(3, ${le}))`;
      case "i24":
        return `int32(${r}.IN(3, ${le}))`;
      case "u40":
      case "u48":
      case "u56":
        return `${r}.UN(${primSize(p)}, ${le})`;
      case "i40":
      case "i48":
      case "i56":
        return `${r}.IN(${primSize(p)}, ${le})`;
      default:
        return `${r}.${p.toUpperCase()}(${le})`;
    }
  }

  private struct(id: string, args: readonly IrExpr[], ctx: RCtx): string {
    const s = this.model.struct(id);
    const call = (inner: RCtx): string =>
      `read${this.model.structName(id)}(${[inner.r, ...this.structArgs(s, args, inner)].join(", ")})`;
    const layers = s.base ? s.layers.filter(l => l.kind !== "alignEnd") : s.layers;
    if (!layers.length) return call(ctx);
    return this.emitLayers(
      layers,
      layers.length - 1,
      ctx,
      `${ctx.slot}#${s.name}`,
      { kind: "struct", struct: id, args: [] },
      call
    );
  }

  private array(t: Extract<IrType, { kind: "array" }>, ctx: RCtx): string {
    const c = this.code;
    const r = ctx.r;
    const a = c.fresh("a");
    const i = c.fresh("i");
    const ix = c.fresh("ix");
    const elemGo = this.model.goType(t.element);
    const ectx: RCtx = { ...ctx, index: i, idx: [...ctx.idx, i] };
    const setIndex = this.elementUsesIndex(t.element, false);
    const es = this.model.staticSize(t.element);
    const loopBody = (read: () => string, post?: (el: string) => void): void => {
      c.line(`${r}.SetIndex(${ix}, ${i})`);
      if (setIndex) c.line(`${r}.Index = ${i}`);
      const v = read();
      if (post) post(v);
      else c.line(`${a} = append(${a}, ${v})`);
    };
    let n: string | undefined;
    if (t.length.kind === "count") {
      n = c.fresh("n");
      c.line(
        `${n} := ${t.elementPlacement ? this.len(t.length.expr, ctx) : this.count(t.length.expr, ctx, es ?? 1)}`
      );
      const capHint =
        es !== undefined && es > 0 && !t.elementPlacement
          ? `min(${n}, (${r}.End-${r}.Pos)/${es})`
          : `min(${n}, 1024)`;
      c.line(`${a} := make([]${elemGo}, 0, ${capHint})`);
    } else c.line(`${a} := []${elemGo}{}`);
    c.line(`${ix} := ${r}.PushIndex()`);
    const savedIndex = setIndex ? c.fresh("ri") : "";
    if (setIndex) c.line(`${savedIndex} := ${r}.Index`);
    const len = t.length;
    const place = t.elementPlacement;
    // Placed elements are read at their offsets; the others where the previous one ended.
    const readEl = (): string => {
      if (!place) return this.read(t.element, ectx);
      const addr = c.fresh("at");
      c.line(`${addr} := ${r}.Base + ${this.num(place, ectx)}`);
      if (len.kind === "rest") c.block(`if ${addr} >= ${r}.End`, () => c.line("break"));
      return `yaffle.PeekAt(${r}, ${addr}, ${this.inClosure(t.element, ectx)})`;
    };
    if (len.kind === "count") {
      c.block(`for ${i} := 0; ${i} < ${n}; ${i}++`, () => loopBody(readEl));
    } else if (len.kind === "rest") {
      const cond = place ? "" : `${r}.Pos < ${r}.End`;
      c.block(`for ${i} := 0; ${cond}; ${i}++`, () => loopBody(readEl));
    } else {
      // A terminator read inline that `before` gives back: the position before it.
      const p = place ? undefined : c.fresh("p");
      c.block(`for ${i} := 0; ; ${i}++`, () => {
        if (p) c.line(`${p} := ${r}.Pos`);
        loopBody(readEl, el => this.terminated(len, t.element, el, a, p, ctx));
      });
    }
    if (setIndex) c.line(`${r}.Index = ${savedIndex}`);
    c.line(`${r}.PopIndex(${ix})`);
    return a;
  }

  /**
   * After reading element el of a terminated array: `until v` drops the terminator, `before v`
   * also gives its bytes back (not consumed), `until <predicate>` keeps the element that ends it.
   */
  private terminated(
    len: IrLength,
    elem: IrType,
    el: string,
    a: string,
    pos: string | undefined,
    ctx: RCtx
  ): void {
    const c = this.code;
    const e = c.fresh("el");
    c.line(`${e} := ${el}`);
    const vt = valueTypeOf(this.model, elem);
    if (len.kind === "untilPredicate") {
      c.line(`${a} = append(${a}, ${e})`);
      const cond = this.expr(len.predicate, { ...ctx, it: this.x.typed(e, vt) }).code;
      c.block(`if ${stripParens(cond)}`, () => c.line("break"));
      return;
    }
    if (len.kind !== "until" && len.kind !== "before")
      throw new BackendError(`unexpected length ${len.kind}`);
    const term = this.expr(len.terminator, ctx);
    const eq = this.x.equality("==", this.x.typed(e, vt), term, this.exprCtx(ctx));
    c.block(`if ${stripParens(eq)}`, () => {
      if (len.kind === "before" && pos) c.line(`${ctx.r}.Pos = ${pos}`);
      c.line("break");
    });
    c.line(`${a} = append(${a}, ${e})`);
  }

  private pointer(t: Extract<IrType, { kind: "pointer" }>, ctx: RCtx): string {
    const c = this.code;
    const r = ctx.r;
    const at = c.fresh("pa");
    if (t.relative) c.line(`${at} := ${r}.Pos`);
    const p = c.fresh("p");
    c.line(`${p} := ${this.prim(t.storage, this.leOf(t.storageEndian, ctx), r)}`);
    const storageGo = primGo(t.storage);
    const off =
      storageGo === "uint64"
        ? `yaffle.OffU(${p}, "pointer")`
        : storageGo === "int64"
          ? `yaffle.Off(${p}, "pointer")`
          : `int(${p})`;
    const origin = t.origin ? this.num(t.origin, ctx) : undefined;
    const addr = t.relative
      ? `${at} + ${off}`
      : `${r}.Base + ${origin !== undefined ? `${origin} + ` : ""}${off}`;
    const key = this.targetKey(t.target, ctx);
    const goT = this.model.goType(t);
    const body = this.inClosure(t.target, { ...ctx, lvalue: undefined });
    let follow = `${this.targetFn(t.target)}(${r}, ${addr}, ${key}, ${body})`;
    if (goT !== this.model.goType(t.target)) follow = `yaffle.Ptr(${follow})`;
    const emit = (assign: (v: string) => string): string => {
      const out = new Code();
      if (t.nullValue === undefined) return out.line(assign(follow)).toString();
      const nv = formatInt(BigInt(t.nullValue));
      // Views record null pointers too, so element targets keep their indices.
      const none = (): void => {
        if (this.views) out.line(`${r}.NoTarget()`);
      };
      if (t.emptyIsNull) {
        out.chain([
          [
            `if ${p} == ${nv}`,
            () => {
              none();
              out.line(assign(emptyValue(t.target, this.model)));
            }
          ],
          ["else", () => out.line(assign(follow))]
        ]);
      } else if (this.views) {
        out.chain([
          [`if ${p} != ${nv}`, () => out.line(assign(follow))],
          ["else", none]
        ]);
      } else out.block(`if ${p} != ${nv}`, () => out.line(assign(follow)));
      return out.toString();
    };
    // With an @origin, the target is followed after the members (the origin may come later).
    if (origin !== undefined && ctx.lvalue) {
      this.st.deferred.push(`${r}.Field(fr, ${goStr(ctx.field ?? "")})`, emit(ctx.lvalue));
      return ASSIGNED;
    }
    if (t.nullValue === undefined) return follow;
    const tmp = c.fresh("t");
    c.line(`var ${tmp} ${goT}`);
    c.line(emit(v => `${tmp} = ${v}`));
    return tmp;
  }

  /** Identity key of a target: type key, plus argument values for parameterized structs. */
  private targetKey(t: IrType, ctx: RCtx): string {
    const keyed = stripLayers(t);
    let inner = keyed;
    while (inner.kind === "transform") inner = stripLayers(inner.inner);
    const base = this.model.typeKey(keyed);
    const exprs: IrExpr[] = [];
    if (inner.kind === "struct") exprs.push(...inner.args);
    if (
      (inner.kind === "bytes" || inner.kind === "string" || inner.kind === "array") &&
      inner.length.kind === "count"
    )
      exprs.push(inner.length.expr);
    if (!exprs.length) return goStr(base);
    const parts = exprs.map(a => {
      const ce = this.expr(a, ctx);
      const typed = (ce.kind === "int" && ce.gt === "untyped") || ce.kind === "enum";
      return `yaffle.KeyArg(${typed ? `int64(${ce.code})` : ce.code})`;
    });
    return `${goStr(base + "(")} + ${parts.join(` + "," + `)} + ")"`;
  }

  private emitBits(b: IrBits, ctx: RCtx): void {
    const c = this.code;
    const u = c.fresh("u");
    const s = c.fresh("s");
    c.line(`${s} := ${ctx.r}.Pos`);
    const le = primSize(b.storage) === 1 ? "true" : this.leOf(b.endian, ctx);
    c.line(`${u} := ${ctx.r}.Uint(${`yaffle.${b.storage.toUpperCase()}`}, ${le})`);
    for (const f of b.fields) {
      const mask = formatInt((1n << BigInt(f.width)) - 1n);
      const raw = f.shift ? `((${u} >> ${f.shift}) & ${mask})` : `(${u} & ${mask})`;
      if (f.name === null) {
        c.block(`if ${this.strictCode(ctx)} && ${raw} != 0`, () =>
          c.line(`${ctx.r}.FailAt(yaffle.CHECK, ${s}, "reserved bits are not zero")`)
        );
        continue;
      }
      c.line(`${ctx.r}.Field(fr, ${goStr(f.name)})`);
      const g = this.model.goField(ctx.s, f.name);
      c.line(this.assign(g, this.bitValue(f.type, raw, f.width, ctx, s)));
      this.emitChecks(f.checks, f.type, this.value(g), s, ctx);
    }
  }

  private bitValue(t: IrType, raw: string, width: number, ctx: RCtx, start: string): string {
    const inner = t.kind === "layered" ? t.inner : t;
    if (inner.kind === "bool") return `${raw} != 0`;
    if (inner.kind === "enum") {
      if (this.model.enum(inner.enum).open) return `${this.model.enumName(inner.enum)}(${raw})`;
      return this.checkedEnum(inner.enum, raw, start, ctx);
    }
    if (inner.kind === "prim") {
      const go = primGo(inner.prim);
      if (inner.prim[0] === "i") return `${go}(yaffle.SignExtend(${raw}, ${width}))`;
      return go === "uint64" ? raw : `${go}(${raw})`;
    }
    if (inner.kind === "transform") {
      const it = this.code.fresh("it");
      this.code.line(`${it} := ${this.bitValue(inner.inner, raw, width, ctx, start)}`);
      const v = this.expr(inner.read, {
        ...ctx,
        it: this.x.typed(it, valueTypeOf(this.model, inner.inner))
      });
      return this.x.to(v, inner.valueType, this.exprCtx(ctx));
    }
    return raw;
  }

  // ── layers ────────────────────────────────────────────────────────────────

  /**
   * Emits layers[idx] down to layers[0] (outermost first) around inner, and returns the value
   * expression (or ASSIGNED).
   */
  private emitLayers(
    layers: readonly IrLayer[],
    idx: number,
    ctx: RCtx,
    slot: string,
    innerType: IrType | undefined,
    inner: (ctx: RCtx) => string
  ): string {
    if (idx < 0) return inner(ctx);
    const l = layers[idx]!;
    const c = this.code;
    const r = ctx.r;
    const next = (x: RCtx): string => this.emitLayers(layers, idx - 1, x, slot, innerType, inner);
    const capture = (x: RCtx): string => {
      const v = next(x);
      if (v === ASSIGNED) return v;
      const t = c.fresh("t");
      c.line(`${t} := ${v}`);
      return t;
    };
    // A padding layer marked strict checks its fill even outside strict mode.
    const strictOf = (x: { strict?: true }): string => (x.strict ? "true" : this.strictCode(ctx));
    switch (l.kind) {
      case "align":
        c.line(this.alignCall(l, ctx));
        return next(ctx);
      case "padBefore":
        c.line(`${r}.Pad(${this.len(l.count, ctx)}, ${this.fill(l.fill, ctx)}, ${strictOf(l)})`);
        return next(ctx);
      case "padAfter": {
        const v = capture(ctx);
        c.line(`${r}.Pad(${this.len(l.count, ctx)}, ${this.fill(l.fill, ctx)}, ${strictOf(l)})`);
        return v;
      }
      case "padUntil": {
        const s = c.fresh("s");
        c.line(`${s} := ${r}.Pos`);
        const v = capture(ctx);
        c.line(
          `${r}.PadUntil(${s}, ${this.len(l.size, ctx)}, ${this.fill(l.fill, ctx)}, ${strictOf(l)})`
        );
        return v;
      }
      case "alignEnd": {
        const v = capture(ctx);
        c.line(this.alignCall(l, ctx));
        return v;
      }
      case "size": {
        const w = c.fresh("w");
        c.line(`${w} := ${r}.Window(${this.len(l.size, ctx)})`);
        const v = capture(ctx);
        c.line(`${r}.CloseWindow(${w}, ${this.strictCode(ctx)})`);
        return v;
      }
      case "via":
        return this.emitVia(l, layers, idx, ctx, slot, innerType, next);
      case "endian": {
        const e = c.fresh("e");
        const le = c.fresh("le");
        c.line(`${e} := ${this.expr(l.value, ctx).code}`);
        c.line(`${le} := ${e} == yaffle.LE`);
        return next({ ...ctx, endian: e, le });
      }
      case "strict": {
        const sv = c.fresh("st");
        c.line(`${sv} := ${r}.Strict`);
        c.line(`${r}.Strict = true`);
        const v = capture(ctx);
        c.line(`${r}.Strict = ${sv}`);
        return v;
      }
    }
  }

  /**
   * A codec layer: the rest of the region is decoded and the inner layers read from the decoded
   * bytes, remembered for codec reuse. A view's shallow scan may leave the region undecoded: a
   * deferred read (lazy codec region) or a lazy stream piece.
   */
  private emitVia(
    l: Extract<IrLayer, { kind: "via" }>,
    layers: readonly IrLayer[],
    idx: number,
    ctx: RCtx,
    slot: string,
    innerType: IrType | undefined,
    next: (x: RCtx) => string
  ): string {
    const c = this.code;
    const r = ctx.r;
    const codec = this.model.codec(l.codec);
    const args = this.args(l.args, codec.params, ctx);
    let outSize = "-1";
    for (let k = idx - 1; k >= 0; k--) {
      const ll = layers[k]!;
      if (ll.kind === "via") break;
      if (ll.kind === "size") {
        outSize = this.len(ll.size, ctx);
        break;
      }
    }
    const s = c.fresh("s");
    const input = c.fresh("in");
    const d = c.fresh("d");
    c.line(`${s} := ${r}.Pos`);
    c.line(`${input} := ${r}.PeekBytes(${r}.Pos, ${r}.End)`);
    const cctx = `&yaffle.CodecCtx{Context: ${r}.Ctx, Args: []any{${args.join(", ")}}, OutputSize: ${outSize}}`;
    const impl = this.mod.extern(l.codec);
    const decode = (out: string): string =>
      `${out} := yaffle.Decode(${impl}, ${goStr(codec.name)}, ${input}, ${cctx}, ${r}.At(${s}))`;
    const slotKey = `${slot}#${idx}`;
    const isStruct = innerType !== undefined && stripLayers(innerType).kind === "struct";
    // The decoded bytes are remembered by the struct inside, or by the struct owning the field.
    const remember = (value: string | undefined, consumed: string): string =>
      value && isStruct
        ? `${value}.yfl.RememberCodec(${goStr(slotKey)}, ${input}${consumed}, ${d})`
        : `v.yfl.RememberCodec(${this.slotCode(slotKey, ctx)}, ${input}${consumed}, ${d})`;

    if ((ctx.lazyVia || ctx.lazyPiece) && !codec.streaming && innerType) {
      const t = c.fresh("t");
      c.line(`var ${t} ${this.model.goType(innerType)}`);
      const lazyRead = (): string => {
        const sr = c.fresh("sr");
        const x = { ...ctx, lazyVia: false, lazyPiece: false };
        if (codec.ranged && !ctx.lazyPiece) {
          this.code.line(
            `${sr} := ${r}.RangedView(${impl}, ${goStr(codec.name)}, ${input}, ${cctx}, ${s})`
          );
        } else {
          const dd = c.fresh("d");
          this.code.line(decode(dd));
          this.code.line(`${sr} := ${r}.${ctx.lazyPiece ? "Decoded" : "DecodedView"}(${dd}, ${s})`);
        }
        return next({ ...x, r: sr });
      };
      // The piece's decoded length, when the data states it (`@size(n)` right inside the codec).
      let pieceSize = "-1";
      if (idx === 1 && layers[0]!.kind === "size" && innerType.kind === "bytes") {
        if (innerType.length.kind === "rest") pieceSize = outSize;
      }
      const field = goStr(ctx.field ?? "");
      c.chain([
        [
          `if !${r}.Lazy()`,
          () => {
            c.line(decode(d));
            const sr = c.fresh("sr");
            c.line(`${sr} := ${r}.Decoded(${d}, ${s})`);
            c.line(`${t} = ${next({ ...ctx, r: sr, lazyVia: false })}`);
            c.line(remember(t, ""));
          }
        ],
        [
          "else",
          () => {
            if (ctx.lazyPiece) {
              const cl = this.closureOf("[]byte", lazyRead);
              c.line(`v.yfl.SetLazyPiece(${field}, ${r}.NewLazyPiece(${pieceSize}, ${cl}))`);
            } else c.line(`${r}.Defer(${field}, ${this.closureOf("any", lazyRead)})`);
          }
        ]
      ]);
      c.line(`${r}.Pos = ${s} + len(${input})`);
      return t;
    }

    let consumed = `len(${input})`;
    if (codec.streaming) {
      consumed = c.fresh("n");
      c.line(
        `${d}, ${consumed} := yaffle.DecodeStreaming(${impl}, ${goStr(codec.name)}, ${input}, ${cctx}, ${r}.At(${s}))`
      );
    } else c.line(decode(d));
    const sr = c.fresh("sr");
    c.line(`${sr} := ${r}.Decoded(${d}, ${s})`);
    const v = next({ ...ctx, r: sr });
    const t = v === ASSIGNED ? undefined : c.fresh("t");
    if (t) c.line(`${t} := ${v}`);
    c.line(`${r}.Pos = ${s} + ${consumed}`);
    c.line(remember(t, `[:${consumed}]`));
    return t ?? ASSIGNED;
  }

  /** An `align`/`alignEnd` layer on read: from the base or the file, with an offset. */
  private alignCall(l: Extract<IrLayer, { kind: "align" | "alignEnd" }>, ctx: RCtx): string {
    const strict = l.strict ? "true" : this.strictCode(ctx);
    const to = this.num(l.to, ctx);
    const fill = this.fill(l.fill, ctx);
    if (l.from === "file" || l.offset) {
      const off = l.offset ? this.num(l.offset, ctx) : "0";
      return `${ctx.r}.AlignAt(${to}, ${off}, ${l.from === "file"}, ${fill}, ${strict})`;
    }
    return `${ctx.r}.Align(${to}, ${fill}, ${strict})`;
  }
}

/** The empty value of an array, bytes or string type (for `@nullable(empty)`). */
export function emptyValue(t: IrType, model: { goType(t: IrType): string }): string {
  const x = stripLayers(t);
  return x.kind === "string" ? '""' : `${model.goType(x)}{}`;
}

function wrapNot(cond: string): string {
  return cond.startsWith("(") && stripParens(cond) !== cond ? cond : `(${cond})`;
}
