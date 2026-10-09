/**
 * Reader emitter: one `_read_X` function per struct (`_read_async_X` for async structs, and the
 * view scanner `_scan_X`), imperative code over `_rt.Reader` following docs/IR.md §2.
 *
 * Scan mode reads a struct for a lazy view: composite children (inline structs, arrays, targets,
 * bytes, codec regions, streams) stay lazy and each field's byte range is recorded in `_R`.
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
import {
  alignEnds,
  decodedSize,
  derivedFrom,
  elementUsesIndex,
  emptyValue,
  inlineLayers,
  isOneWay,
  reachesAsync,
  readSideExtents,
  structUnderLayers,
  usesIndex,
  valueTypeOf
} from "./analysis.ts";
import { pyBool, pyInt, pyStr, pyTuple, paren, stripParens, type Code } from "./code.ts";
import { Emitter, type EmitCtx, type EmitState, type SideCtx } from "./emitter.ts";
import { detachedCtx, type CExpr, type ExprCompiler, type ExprCtx } from "./expr.ts";
import { elementStructOf, literalInt, primSize, stripType, unlayer, type Model } from "./model.ts";
import type { ModuleCtx } from "./module.ts";
import type { Names } from "./names.ts";
import type { TypeEmitter } from "./types.ts";
import type { WriteEmitter } from "./write.ts";

export interface RCtx extends EmitCtx {
  /** Reader variable. */
  r: string;
  /** The field being read. */
  field?: string | undefined;
  /** Where the field's value goes (pointers with `@origin` assign it after the members). */
  lvalue?: string | undefined;
  /** The struct value being read (codec reuse owner), "None" at the root. */
  owner?: string | undefined;
  /** View scan mode. */
  scan?: boolean | undefined;
  /** Path segments (a Python list display) of child views created here (scan mode). */
  seg?: string | undefined;
}

/** `[a, b]` + `c` → `[a, b, c]` (Python list displays of path segments). */
function segPlus(seg: string | undefined, x: string): string {
  const s = seg ?? "[]";
  return s === "[]" ? `[${x}]` : `${s.slice(0, -1)}, ${x}]`;
}

interface ReadState extends EmitState {
  /** Locals holding the values of hidden fields. */
  hidden: Map<string, string>;
  /** Start/end locals of fields whose extents read-side expressions use. */
  extents: Map<string, { start: string; end: string }>;
  needExtent: Set<string>;
  maxDepth: number;
  /** Statements run after the members (pointers with `@origin`). */
  deferred: string[][];
}

export class ReadEmitter extends Emitter<RCtx, ReadState> {
  /** Lazy scalar arrays in views get element encoders from the writer (in-place patches). */
  private readonly writer: WriteEmitter;
  private lastRaw: string | undefined;

  constructor(
    model: Model,
    names: Names,
    x: ExprCompiler,
    types: TypeEmitter,
    mod: ModuleCtx,
    writer: WriteEmitter
  ) {
    super(model, names, x, types, mod);
    this.writer = writer;
  }

  private freshState(needExtent: Set<string>): ReadState {
    return {
      hidden: new Map(),
      extents: new Map(),
      needExtent,
      maxDepth: 0,
      deferred: [],
      nonlocals: []
    };
  }

  /** Emits `_read_X` (or `_read_async_X`, or the view scanner `_scan_X`). */
  emitStruct(out: Code, s: IrStruct, async: boolean, scan = false): void {
    const cls = this.names.structClass(s.id);
    this.st = this.freshState(readSideExtents(s));
    const body = out.child();
    this.code = body;
    const ctx: RCtx = {
      s,
      r: "_r",
      endian: "endian",
      le: "_le",
      async,
      index: "_index",
      depth: 0,
      slot: cls,
      scan,
      seg: "[_p[0]]"
    };
    for (const f of this.model.fields(s)) {
      if (f.field && !f.field.output) this.st.hidden.set(f.name, `_h_${this.attr(s, f.name)}`);
    }
    this.emitMembers(s.members, ctx);
    // A base's `@alignEnd` pads its whole region (after its targets), from its own start.
    const tail = body.child();
    const ends = s.base ? alignEnds(s.layers) : [];
    if (ends.length) {
      this.code = tail;
      if (scan) tail.line(`_r.inline_end = _r.pos`);
      tail.line(`_r.pos = max(_r.pos, _r.max_end)`);
      for (const l of ends) {
        tail.line(
          `_r.align(${this.num(l.to, ctx)}, ${this.fill(l.fill, ctx)}, ${l.strict ? "True" : "_r.strict"}${this.alignArgs(l, ctx)})`
        );
      }
      this.code = body;
    }
    const params = this.types.params(s);
    const fn = scan ? `_scan_${cls}` : async ? `_read_async_${cls}` : `_read_${cls}`;
    const ret = scan ? "tuple[_t.Any, dict[str, tuple[int, int]]]" : cls;
    out.block(
      `${async ? "async " : ""}def ${fn}(${["_r: _rt.Reader", ...params].join(", ")}) -> ${ret}`,
      () => {
        if (s.params.some(p => p.origin === "endian")) out.line(`_le = endian == "le"`);
        if (scan) {
          out.line(`_v: _t.Any = _rt.Values()`);
          out.line(`_R: dict[str, tuple[int, int]] = {}`);
        } else out.line(`_v = _r.take_into(${cls})`);
        if (usesIndex(s)) out.line(`_index = _r.index`);
        for (const local of this.st.hidden.values()) out.line(`${local}: _t.Any = None`);
        for (const [n, e] of this.st.extents) {
          out.line(n === "this" ? `${e.start} = _r.pos` : `${e.start} = -1`);
          out.line(`${e.end} = -1`);
        }
        out.line(`_p: list[_t.Any] = ${pathSlots(this.st.maxDepth)}`);
        if (s.base) {
          out.line(`_base = _r.base`);
          out.line(`_max = _r.max_end`);
          out.line(`_r.base = _r.pos`);
          out.line(`_r.max_end = _r.pos`);
        }
        out.block("try", () => {
          out.append(body);
          for (const d of this.st.deferred) for (const l of d) out.line(l);
          if (ends.length) out.line(`_p[0] = ""`);
          out.append(tail);
        });
        out.block("except _rt.YaffleError as _e", () => {
          out.line(`_e.prefix(*_p)`);
          if (s.base) {
            out.line(`_r.base = _base`);
            out.line(`_r.max_end = _max`);
          }
          out.line("raise");
        });
        if (s.base) {
          if (scan && !ends.length) out.line(`_r.inline_end = _r.pos`);
          out.line(`_r.pos = max(_r.pos, _r.max_end)`);
          out.line(`_r.base = _base`);
          out.line(`_r.max_end = max(_max, _r.pos)`);
        }
        out.line(scan ? "return _v, _R" : "return _v");
      }
    );
  }

  /** Emits the read of a root struct (params are locals named after them); returns the value. */
  rootRead(out: Code, s: IrStruct, async: boolean): string {
    this.st = this.freshState(new Set());
    this.code = out;
    const ctx: RCtx = {
      s,
      r: "_r",
      endian: "endian",
      le: "_le",
      async,
      index: "-1",
      depth: 0,
      slot: this.names.structClass(s.id),
      owner: "None"
    };
    const args: IrExpr[] = s.params.map(p => ({ kind: "param", name: p.name, type: p.type }));
    return this.struct(s.id, args, ctx);
  }

  protected sideCtx(ctx: RCtx): SideCtx {
    const s = ctx.s;
    const r = ctx.r;
    const width = (f: string): string => {
      const e = this.extent(f);
      return `(${e.end} - ${e.start})`;
    };
    const bytes = (f: string): string => {
      const e = this.extent(f);
      return `${r}.peek_bytes(${e.start}, ${e.end})`;
    };
    return {
      field: (name, type) => {
        const hidden = this.st.hidden.get(name);
        if (hidden) return this.x.typed(hidden, type);
        const v = `_v.${this.attr(s, name)}`;
        return this.x.typed(ctx.scan && this.lazyField(s, name) ? `_rt.force(${v})` : v, type);
      },
      builtin: name => {
        if (name === "offset") return `(${r}.pos - ${r}.base)`;
        if (name === "end") return `(${r}.end - ${r}.base)`;
        return ctx.index;
      },
      sizeof: width,
      offsetof: f => `(${this.extent(f).start} - ${r}.base)`,
      encodedSize: width,
      bytesof: bytes,
      encode: bytes
    };
  }

  private extent(f: string): { start: string; end: string } {
    let e = this.st.extents.get(f);
    if (!e) {
      const id = f.replace(/\W/g, "_");
      e = { start: `_s_${id}`, end: `_e_${id}` };
      this.st.extents.set(f, e);
    }
    return e;
  }

  /** A count read from the data: EOF if the region cannot hold that many units. */
  private count(e: IrExpr, ctx: RCtx, unit: number): string {
    const lit = literalInt(e);
    if (lit !== undefined && lit >= 0) return String(lit);
    return `${ctx.r}.count(${stripParens(this.expr(e, ctx).code)}, ${unit})`;
  }

  // ── members ───────────────────────────────────────────────────────────────

  private emitMembers(ms: readonly IrMember[], ctx: RCtx): void {
    for (const m of ms) {
      switch (m.kind) {
        case "field":
          this.emitField(m, ctx);
          break;
        case "bits":
          this.emitBits(m, ctx);
          break;
        case "block": {
          const c = this.code;
          const body = (): void => {
            this.emitLayers(
              m.layers,
              m.layers.length - 1,
              ctx,
              inner => {
                this.emitMembers(m.members, inner);
                return null;
              },
              `${ctx.slot}.block`
            );
          };
          if (!m.condition) {
            body();
            break;
          }
          const parts: [string, () => void][] = [
            [`if ${stripParens(this.expr(m.condition, ctx).code)}`, body]
          ];
          const els = m.else;
          if (els) parts.push(["else", () => this.emitMembers(els, ctx)]);
          c.chain(parts);
          break;
        }
        case "switch": {
          const c = this.code;
          const d = c.fresh("d");
          c.line(`${d} = ${stripParens(this.expr(m.discriminant, ctx).code)}`);
          const parts = m.cases.map((cs, i): [string, () => void] => {
            const conds = cs.values.map(
              v => `${d} == ${this.x.literal(v, m.discriminant.type, this.exprCtx(ctx)).code}`
            );
            return [
              `${i ? "elif" : "if"} ${conds.join(" or ")}`,
              () => this.emitMembers(cs.members, ctx)
            ];
          });
          const def = m.default;
          const last = def
            ? () => this.emitMembers(def, ctx)
            : () => c.line(`${ctx.r}.fail("CHECK", f"no case matches {${d}!r}")`);
          if (parts.length) c.chain([...parts, ["else", last]]);
          else last();
          break;
        }
      }
    }
  }

  private strictCode(ctx: RCtx): string {
    return ctx.s.strict ? "True" : `${ctx.r}.strict`;
  }

  private target(f: IrField, s: IrStruct): string {
    return this.st.hidden.get(f.name) ?? `_v.${this.attr(s, f.name)}`;
  }

  private assignTarget(f: IrField, s: IrStruct, value: string): void {
    const hidden = this.st.hidden.get(f.name);
    if (hidden) this.assignState(hidden, value);
    else this.code.line(`_v.${this.attr(s, f.name)} = ${value}`);
  }

  private emitField(f: IrField, ctx: RCtx): void {
    const c = this.code;
    c.line(`_p[0] = ${pyStr(f.name)}`);
    if (f.virtual) {
      // No bytes: the value is computed from earlier fields.
      const v = this.virtualValue(f, this.expr(f.virtual.read, ctx), ctx);
      this.assignTarget(f, ctx.s, v);
      this.emitChecks(f.checks, f.type, this.target(f, ctx.s), `${ctx.r}.pos`, ctx);
      return;
    }
    const attr = this.attr(ctx.s, f.name);
    const fctx: RCtx = {
      ...ctx,
      slot: `${ctx.s.id}.${f.name}`,
      field: f.name,
      seg: ctx.scan ? `[${pyStr(f.name)}]` : ctx.seg
    };
    const ext = this.st.needExtent.has(f.name) ? this.extent(f.name) : undefined;
    const needStart = f.checks.length > 0 || ext !== undefined || (ctx.scan && !f.from);
    let start = `${ctx.r}.pos`;
    if (needStart && !f.placement) {
      if (ext) {
        start = ext.start;
        this.assignState(start, `${ctx.r}.pos`);
      } else {
        start = c.fresh("s");
        c.line(`${start} = ${ctx.r}.pos`);
      }
    }
    const tgt = this.target(f, ctx.s);
    if (f.placement) {
      let off = this.num(f.placement.offset, ctx);
      const emptyNull = f.placement.emptyIsNull === true;
      if (emptyNull) {
        const o = c.fresh("o");
        c.line(`${o} = ${off}`);
        off = o;
      }
      const addr = c.fresh("at");
      c.line(`${addr} = ${ctx.r}.base + ${paren(off)}`);
      if (ext) this.assignState(ext.start, addr);
      start = addr;
      const key = this.targetKey(f.type, ctx);
      const orEmpty = (v: string): string =>
        emptyNull ? `${emptyValue(f.type)} if ${off} == 0 else ${v}` : v;
      const size = this.model.staticSize(f.type);
      if (ctx.scan) {
        const lfn = this.closure(false, () => this.read(f.type, { ...fctx, r: "_rv", seg: "[]" }), [
          "_rv"
        ]);
        this.assignTarget(
          f,
          ctx.s,
          orEmpty(`_rt.lazy_target(${ctx.r}, ${addr}, ${key}, ${lfn}, [${pyStr(f.name)}])`)
        );
        c.line(`_R[${pyStr(attr)}] = (${addr}, ${addr})`);
        if (ext) this.assignState(ext.end, size !== undefined ? `${addr} + ${size}` : addr);
        this.emitChecks(f.checks, f.type, `_rt.force(${tgt})`, start, ctx);
        return;
      }
      const call = this.targetCall(f.type, addr, key, fctx);
      this.assignTarget(f, ctx.s, orEmpty(ctx.async ? `await ${call}` : call));
      if (ext) {
        this.assignState(
          ext.end,
          size !== undefined ? `${addr} + ${size}` : `${ctx.r}.last_target_end`
        );
      }
    } else if (f.from && ctx.scan) {
      const stream = this.stream(f.from.stream, ctx);
      const sfn = this.closure(false, () => stream);
      const lfn = this.closure(false, () => this.read(f.type, { ...fctx, r: "_rv", seg: "[]" }), [
        "_rv"
      ]);
      this.assignTarget(f, ctx.s, `_rt.lazy_stream(${sfn}, ${ctx.r}.strict, ${lfn})`);
    } else if (f.from) {
      const stream = this.stream(f.from.stream, ctx);
      const sr = c.fresh("sr");
      c.line(`${sr} = ${ctx.r}.sub(${stream})`);
      this.assignTarget(f, ctx.s, this.read(f.type, { ...fctx, r: sr }));
    } else {
      this.lastRaw = undefined;
      const v = this.read(f.type, { ...fctx, lvalue: f.type.kind === "pointer" ? tgt : undefined });
      this.assignTarget(f, ctx.s, v);
      // Canonical JSON shows a one-way transform's raw value.
      if (this.lastRaw && isOneWay(f.type) && f.output)
        c.line(`_rt.set_raw(_v, ${pyStr(attr)}, ${this.lastRaw})`);
      // Hidden stream pieces stay reachable for the parent's `from arr[*].piece`.
      if (!f.output && this.model.streamPieces.has(`${ctx.s.id}.${f.name}`)) {
        c.line(`_rt.set_hidden(_v, ${pyStr(attr)}, ${tgt})`);
      }
      if (ext) this.assignState(ext.end, `${ctx.r}.pos`);
      if (ctx.scan) c.line(`_R[${pyStr(attr)}] = (${start}, ${ctx.r}.pos)`);
    }
    const checkValue = ctx.scan && this.lazyField(ctx.s, f.name) ? `_rt.force(${tgt})` : tgt;
    this.emitChecks(f.checks, f.type, checkValue, start, ctx);
  }

  /** A pointer or `at` target read at `addr` (the call, without `await`). */
  private targetCall(t: IrType, addr: string, key: string, ctx: RCtx): string {
    const fn = this.closure(ctx.async, () => this.read(t, { ...ctx, lvalue: undefined }));
    const sid = structUnderLayers(t);
    const suffix = ctx.async ? "_async" : "";
    return sid
      ? `${ctx.r}.target_struct${suffix}(${addr}, ${key}, ${fn}, ${this.mod.structClass(sid)})`
      : `${ctx.r}.target${suffix}(${addr}, ${key}, ${fn})`;
  }

  /** A virtual field's value from its read expression, checked against its declared type. */
  private virtualValue(f: IrField, v: CExpr, ctx: RCtx): string {
    const t = unlayer(f.type);
    const code = stripParens(this.x.to(v, valueTypeOf(this.model, t)));
    if (t.kind === "prim") return `_rt.check_value(${code}, ${pyStr(t.prim)})`;
    if (t.kind === "enum") return this.enumRead(t.enum, code, ctx, `${ctx.r}.pos`);
    if (t.kind === "bool") return `bool(${code})`;
    return code;
  }

  private enumRead(id: string, raw: string, ctx: RCtx, at: string): string {
    const en = this.model.enum(id);
    return `_rt.enum_read(${this.mod.enumRef(id, "members")}, ${raw}, ${pyBool(en.open)}, ${ctx.r}, ${at})`;
  }

  /** In scan mode, values of this field may be lazy (bytes, targets, codec regions, streams). */
  private lazyField(s: IrStruct, name: string): boolean {
    const f = this.model.field(s, name)?.field;
    if (!f) return false;
    if (f.placement || f.from) return true;
    const visit = (t: IrType): boolean => {
      if (t.kind === "bytes") return t.length.kind !== "until";
      if (t.kind === "pointer") return true;
      if (t.kind === "layered") return t.layers.some(l => l.kind === "via") || visit(t.inner);
      return false;
    };
    return visit(f.type);
  }

  private emitChecks(
    checks: readonly { expr: IrExpr; message: string; strictOnly: boolean }[],
    t: IrType,
    value: string,
    start: string,
    ctx: RCtx
  ): void {
    for (const ch of checks) {
      const ictx: RCtx = { ...ctx, it: { code: value, type: valueTypeOf(this.model, t) } };
      const cond = this.expr(ch.expr, ictx).code;
      const guard = ch.strictOnly ? `${this.strictCode(ctx)} and ` : "";
      this.code.line(
        `if ${guard}not ${paren(cond)}: ${ctx.r}.check_fail(${pyStr(ch.message)}, ${start})`
      );
    }
  }

  private stream(s: IrStreamExpr, ctx: RCtx): string {
    switch (s.kind) {
      case "field": {
        const f = this.model.field(ctx.s, s.field)?.field;
        if (!f) throw new Error(`unknown stream field ${s.field}`);
        // Views read a window of the field's space when it is lazy (ranged regions, sources).
        return ctx.scan ? `_rt.stream_field(${this.target(f, ctx.s)})` : this.target(f, ctx.s);
      }
      case "each": {
        const f = this.model.field(ctx.s, s.array)?.field;
        if (!f) throw new Error(`unknown stream array ${s.array}`);
        const esId = elementStructOf(f.type);
        const es = esId ? this.model.struct(esId) : undefined;
        const attr = es ? this.attr(es, s.field) : s.field;
        if (ctx.scan) {
          // Views decode only the pieces a read touches.
          const len = es ? this.pieceLengthFn(es, s.field) : undefined;
          return `_rt.stream_each(${this.target(f, ctx.s)}, ${pyStr(attr)}, ${pyStr(s.field)}${len ? `, ${len}` : ""})`;
        }
        return `_rt.join_stream(_rt.pieces(${this.target(f, ctx.s)}, ${pyStr(attr)}))`;
      }
      case "slice": {
        const inner = this.stream(s.stream, ctx);
        const a = this.num(s.start, ctx);
        const b = s.end ? this.num(s.end, ctx) : undefined;
        const fn = ctx.scan ? "_rt.stream_slice" : "_rt.slice_stream";
        return `${fn}(${inner}, ${a}${b !== undefined ? `, ${b}` : ""})`;
      }
    }
  }

  /**
   * `lambda _e: <decoded length>` of a stream piece `es.field` when its own size fields state it
   * (`u8 data[n]`, `u8 data[] @size(exp) @via(zstd)`), so views map stream offsets to pieces
   * without decoding them. Undefined when the length is only known after decoding.
   */
  private pieceLengthFn(es: IrStruct, field: string): string | undefined {
    const fr = this.model.field(es, field);
    if (!fr?.field || fr.conditional) return undefined;
    const lengthOf = (t: IrType): IrExpr | undefined => {
      if (t.kind === "bytes") return t.length.kind === "count" ? t.length.expr : undefined;
      if (t.kind !== "layered" || t.inner.kind !== "bytes") return undefined;
      const len = t.inner.length;
      if (len.kind === "count") return len.expr;
      if (len.kind !== "rest") return undefined;
      for (const l of t.layers) {
        if (l.kind === "size") return l.size;
        if (l.kind !== "endian" && l.kind !== "strict") return undefined;
      }
      return undefined;
    };
    const e = lengthOf(fr.field.type);
    if (!e) return undefined;
    let ok = true;
    const unsupported = (): string => {
      ok = false;
      return "None";
    };
    const ctx: ExprCtx = {
      ...detachedCtx(unsupported),
      ...this.mod.exprBase(),
      field: (name, type) => {
        const g = this.model.field(es, name);
        if (!g || g.conditional || !(g.field ?? g.bit!).output) ok = false;
        return this.x.typed(`_e.${this.attr(es, name)}`, type);
      }
    };
    let code: string;
    try {
      code = stripParens(this.x.asLen(this.x.compile(e, ctx)));
    } catch {
      return undefined;
    }
    return ok ? `(lambda _e: ${code})` : undefined;
  }

  // ── types ─────────────────────────────────────────────────────────────────

  /** Emits statements for reading `t`; returns an expression to evaluate right after them. */
  read(t: IrType, ctx: RCtx): string {
    // Struct values pointers can target are one object per (address, type), inline ones too.
    if (t.kind === "struct" && !ctx.scan && this.model.identityStructs.has(t.struct)) {
      const key = this.targetKey(t, ctx);
      const cls = this.mod.structClass(t.struct);
      const fn = this.closure(ctx.async, () => this.readInner(t, ctx));
      return ctx.async
        ? `await ${ctx.r}.inline_async(${key}, ${fn}, ${cls})`
        : `${ctx.r}.inline(${key}, ${fn}, ${cls})`;
    }
    return this.readInner(t, ctx);
  }

  private readInner(t: IrType, ctx: RCtx): string {
    const r = ctx.r;
    const c = this.code;
    switch (t.kind) {
      case "prim":
        return prim(t.prim, this.leOf(t.endian, ctx), r);
      case "bool":
        return `${r}.bool(${this.strictCode(ctx)})`;
      case "string": {
        const le = t.unit === 1 ? "True" : this.leOf(t.endian, ctx);
        const tail = `${t.unit}, ${pyStr(t.encoding)}, ${le})`;
        if (t.length.kind === "count")
          return `${r}.str(${this.count(t.length.expr, ctx, t.unit)}, ${tail}`;
        return t.length.kind === "until" ? `${r}.str_until(${tail}` : `${r}.str_rest(${tail}`;
      }
      case "bytes":
        if (ctx.scan && t.length.kind === "count")
          return `_rt.lazy_bytes(${r}, ${this.count(t.length.expr, ctx, 1)})`;
        if (ctx.scan && t.length.kind === "rest")
          return `_rt.lazy_bytes(${r}, ${r}.end - ${r}.pos)`;
        if (t.length.kind === "count") return `${r}.bytes(${this.count(t.length.expr, ctx, 1)})`;
        if (t.length.kind === "until")
          return `${r}.bytes_until(${this.num(t.length.terminator, ctx)})`;
        return `${r}.bytes_rest()`;
      case "array":
        return this.array(t, ctx);
      case "struct":
        return this.struct(t.struct, t.args, ctx);
      case "enum": {
        const s = c.fresh("s");
        c.line(`${s} = ${r}.pos`);
        const raw = prim(this.model.enum(t.enum).storage, this.leOf(t.endian, ctx), r);
        return this.enumRead(t.enum, raw, ctx, s);
      }
      case "pointer":
        return this.pointer(t, ctx);
      case "extern": {
        const x = this.model.extern(t.extern);
        const args = this.args(t.args, x.params, ctx);
        const fixed = x.kind === "type" && x.fixedSize !== undefined ? `, ${x.fixedSize}` : "";
        const call = `${r}.extern(${this.mod.extern(t.extern)}, ${pyTuple(args)}${fixed})`;
        if (x.kind === "type") {
          const k = this.x.kindOf(x.valueType);
          if (k === "int") return `_rt.host_int(${call}, ${pyStr(x.name)})`;
          if (k === "float") return `_rt.host_float(${call}, ${pyStr(x.name)})`;
        }
        return call;
      }
      case "union": {
        // Union values in views are snapshots (read with the plain readers).
        const vctx: RCtx = { ...ctx, scan: false };
        if (ctx.scan && !ctx.async && t.variants.some(v => reachesAsync(this.model, v.type)))
          return `_rt.fail("INPUT", "not supported: views of unions with async codecs")`;
        const alts = t.variants.map(v => {
          const fn = this.closure(ctx.async, () => this.read(v.type, vctx));
          return `(${pyStr(v.name)}, ${fn})`;
        });
        const call = `${r}.union${ctx.async ? "_async" : ""}(${pyTuple(alts)})`;
        return ctx.async ? `(await ${call})` : call;
      }
      case "transform": {
        const it = c.fresh("it");
        c.line(`${it} = ${this.read(t.inner, ctx)}`);
        if (!t.write) this.lastRaw = it;
        const ictx: RCtx = { ...ctx, it: { code: it, type: valueTypeOf(this.model, t.inner) } };
        return this.x.to(this.expr(t.read, ictx), t.valueType);
      }
      case "layered":
        return (
          this.emitLayers(
            t.layers,
            t.layers.length - 1,
            ctx,
            inner => this.read(t.inner, inner),
            ctx.slot
          ) ?? "None"
        );
    }
  }

  private struct(id: string, args: readonly IrExpr[], ctx: RCtx): string {
    const s = this.model.struct(id);
    const call = (inner: RCtx): string => {
      const argCode = this.args(args, s.params, inner);
      if (inner.scan) {
        const info = this.mod.structFn(id, "view");
        return `_rt.view_child(${inner.r}, ${info}, ${pyTuple(argCode)}, ${inner.seg ?? "[]"})`;
      }
      const isAsync = s.async && inner.async;
      const fn = this.mod.structFn(id, isAsync ? "read_async" : "read");
      const callExpr = `${fn}(${[inner.r, ...argCode].join(", ")})`;
      return isAsync ? `(await ${callExpr})` : callExpr;
    };
    const layers = inlineLayers(s);
    if (!layers.length) return call(ctx);
    return this.emitLayers(layers, layers.length - 1, ctx, call, `${ctx.slot}#${s.name}`) ?? "None";
  }

  private array(t: Extract<IrType, { kind: "array" }>, ctx: RCtx): string {
    if (!ctx.scan) return this.arrayLoop(t, ctx);
    const es = this.model.staticSize(t.element);
    if (t.length.kind === "count" && !t.elementPlacement && es !== undefined && es > 0) {
      const n = this.code.fresh("n");
      this.code.line(`${n} = ${this.count(t.length.expr, ctx, es)}`);
      const ectx: RCtx = { ...ctx, r: "_rv", index: "_i", seg: segPlus(ctx.seg, "_i") };
      const fn = this.closure(false, () => this.read(t.element, ectx), ["_rv", "_i"]);
      const enc =
        (ctx.field && derivedFrom(ctx.s).has(ctx.field)
          ? undefined
          : this.writer.elementEncoder(this.code, ctx.s, t.element)) ?? "None";
      return `_rt.lazy_array(${ctx.r}, ${n}, ${es}, ${fn}, ${enc}, ${ctx.seg ?? "[]"})`;
    }
    return `_rt.array_of(${this.arrayLoop(t, ctx)}, ${ctx.seg ?? "[]"})`;
  }

  private arrayLoop(t: Extract<IrType, { kind: "array" }>, ctx: RCtx): string {
    const c = this.code;
    const r = ctx.r;
    const depth = ctx.depth;
    this.st.maxDepth = Math.max(this.st.maxDepth, depth + 1);
    const slot = `_p[${depth + 1}]`;
    const a = c.fresh("a");
    const i = c.fresh("i");
    const ectx: RCtx = {
      ...ctx,
      index: i,
      depth: depth + 1,
      seg: ctx.scan ? segPlus(ctx.seg, i) : ctx.seg
    };
    const setIndex = elementUsesIndex(this.model, t.element);
    c.line(`${a}: list[_t.Any] = []`);
    const savedIndex = setIndex ? c.fresh("ix") : "";
    if (setIndex) c.line(`${savedIndex} = ${r}.index`);
    /** One element: `read` emits it; `post` consumes it (default: append). */
    const element = (read: () => string, post?: (el: string) => void): void => {
      c.line(`${slot} = ${i}`);
      if (setIndex) c.line(`${r}.index = ${i}`);
      const v = read();
      if (post) post(v);
      else c.line(`${a}.append(${stripParens(v)})`);
    };
    const loop = (head: string, step: () => void): void => {
      c.line(`${i} = -1`);
      c.block(head, () => {
        c.line(`${i} += 1`);
        step();
      });
    };
    const len = t.length;
    if (t.elementPlacement) {
      const place = t.elementPlacement;
      const readAt = (): string => {
        const addr = c.fresh("at");
        c.line(`${addr} = ${r}.base + ${paren(this.num(place, ectx))}`);
        if (len.kind === "rest") c.line(`if ${addr} >= ${r}.end: break`);
        const fn = this.closure(ctx.async, () => this.read(t.element, ectx));
        return ctx.async
          ? `(await ${r}.peek_at_async(${addr}, ${fn}))`
          : `${r}.peek_at(${addr}, ${fn})`;
      };
      if (len.kind === "count") {
        const n = c.fresh("n");
        c.line(`${n} = ${this.len(len.expr, ctx)}`);
        c.block(`for ${i} in range(${n})`, () => element(readAt));
      } else if (len.kind === "rest") {
        loop("while True", () => element(readAt));
      } else {
        loop("while True", () =>
          element(readAt, el => this.terminated(len, t.element, el, a, undefined, ctx))
        );
      }
    } else if (len.kind === "count") {
      const n = c.fresh("n");
      c.line(`${n} = ${this.count(len.expr, ctx, this.model.staticSize(t.element) ?? 1)}`);
      c.block(`for ${i} in range(${n})`, () => element(() => this.read(t.element, ectx)));
    } else if (len.kind === "rest") {
      c.line(`${i} = 0`);
      c.block(`while ${r}.pos < ${r}.end`, () => {
        element(() => this.read(t.element, ectx));
        c.line(`${i} += 1`);
      });
    } else {
      const p = c.fresh("q");
      loop("while True", () => {
        c.line(`${p} = ${r}.pos`);
        element(
          () => this.read(t.element, ectx),
          el => this.terminated(len, t.element, el, a, p, ctx)
        );
      });
    }
    if (setIndex) c.line(`${r}.index = ${savedIndex}`);
    c.line(`${slot} = -1`);
    return a;
  }

  /**
   * After reading element `el` of a terminated array: `until v` drops the terminator, `before v`
   * gives its bytes back (not consumed), `until <predicate>` keeps the element that ends it.
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
    c.line(`${e} = ${stripParens(el)}`);
    if (len.kind === "untilPredicate") {
      c.line(`${a}.append(${e})`);
      const it = { code: e, type: valueTypeOf(this.model, elem) };
      const cond = this.expr(len.predicate, { ...ctx, it }).code;
      c.line(`if ${stripParens(cond)}: break`);
      return;
    }
    if (len.kind !== "until" && len.kind !== "before")
      throw new Error(`unexpected length ${len.kind}`);
    const eq = `${e} == ${this.expr(len.terminator, ctx).code}`;
    if (len.kind === "before" && pos)
      c.block(`if ${eq}`, () => {
        c.line(`${ctx.r}.pos = ${pos}`);
        c.line("break");
      });
    else c.line(`if ${eq}: break`);
    c.line(`${a}.append(${e})`);
  }

  private pointer(t: Extract<IrType, { kind: "pointer" }>, ctx: RCtx): string {
    const c = this.code;
    const r = ctx.r;
    let at = "";
    if (t.relative) {
      at = c.fresh("pa");
      c.line(`${at} = ${r}.pos`);
    }
    const p = c.fresh("ptr");
    c.line(`${p} = ${prim(t.storage, this.leOf(t.storageEndian, ctx), r)}`);
    // `@origin(expr)`: target = base + origin + value. A field's origin may use positions of
    // later fields, so the target is followed once the struct's members are read. (Elements of
    // an array of pointers are followed right away: their origin may only use earlier fields.)
    const defer = t.origin !== undefined && ctx.lvalue !== undefined;
    const key = this.targetKey(t.target, ctx);
    const empty = t.emptyIsNull ? emptyValue(t.target) : "None";
    const follow = (): string => {
      const origin = t.origin ? this.num(t.origin, ctx) : undefined;
      const addr = t.relative
        ? `${at} + ${p}`
        : `${r}.base + ${origin !== undefined ? `${paren(origin)} + ` : ""}${p}`;
      if (ctx.scan) {
        const lfn = this.closure(
          false,
          () => this.read(t.target, { ...ctx, r: "_rv", seg: "[]", lvalue: undefined }),
          ["_rv"]
        );
        const seg = ctx.seg && ctx.seg.startsWith("[") ? ctx.seg : "[]";
        return `_rt.lazy_target(${r}, ${addr}, ${key}, ${lfn}, ${seg})`;
      }
      const call = this.targetCall(t.target, addr, key, ctx);
      return ctx.async ? `(await ${call})` : call;
    };
    const orNull = (v: string): string =>
      t.nullValue === undefined ? v : `${empty} if ${p} == ${pyInt(BigInt(t.nullValue))} else ${v}`;
    if (!defer) return orNull(follow());
    // The follow goes into a statement list run after the members.
    const saved = this.code;
    const later = saved.child();
    this.code = later;
    later.line(`_p[0] = ${pyStr(ctx.field ?? "")}`);
    later.line(`${ctx.lvalue} = ${orNull(follow())}`);
    this.code = saved;
    this.st.deferred.push(later.toString().split("\n"));
    return "None";
  }

  /** Identity key of a target: type key, plus argument values for parameterized structs. */
  private targetKey(t: IrType, ctx: RCtx): string {
    const base = this.model.typeKey(unlayer(t));
    const inner = stripType(t);
    const exprs: IrExpr[] = [];
    if (inner.kind === "struct") exprs.push(...inner.args);
    if (
      (inner.kind === "bytes" || inner.kind === "string" || inner.kind === "array") &&
      inner.length.kind === "count"
    ) {
      exprs.push(inner.length.expr);
    }
    if (!exprs.length) return pyStr(base);
    const parts = exprs.map(a => stripParens(this.expr(a, ctx).code));
    return `(${[pyStr(base), ...parts].join(", ")})`;
  }

  private emitBits(b: IrBits, ctx: RCtx): void {
    const c = this.code;
    const size = primSize(b.storage);
    const u = c.fresh("u");
    const s = c.fresh("s");
    c.line(`${s} = ${ctx.r}.pos`);
    c.line(`${u} = ${prim(b.storage, this.leOf(b.endian, ctx), ctx.r)}`);
    for (const f of b.fields) {
      const mask = pyInt((1n << BigInt(f.width)) - 1n);
      const raw = f.shift ? `((${u} >> ${f.shift}) & ${mask})` : `(${u} & ${mask})`;
      if (f.name === null) {
        c.line(
          `if ${this.strictCode(ctx)} and ${raw} != 0: ${ctx.r}.fail("CHECK", "reserved bits are not zero", ${s})`
        );
        continue;
      }
      c.line(`_p[0] = ${pyStr(f.name)}`);
      const val = this.bitValue(f.type, raw, f.width, ctx, s);
      const attr = this.attr(ctx.s, f.name);
      let target: string;
      if (f.output) {
        target = `_v.${attr}`;
        c.line(`${target} = ${val}`);
        if (ctx.scan) c.line(`_R[${pyStr(attr)}] = (${s}, ${s} + ${size})`);
      } else {
        target = `_h_${attr}`;
        this.st.hidden.set(f.name, target);
        this.assignState(target, val);
      }
      this.emitChecks(f.checks, f.type, target, s, ctx);
    }
  }

  private bitValue(t: IrType, raw: string, width: number, ctx: RCtx, start: string): string {
    const inner = t.kind === "layered" ? t.inner : t;
    switch (inner.kind) {
      case "bool":
        return `${raw} != 0`;
      case "enum":
        return this.enumRead(inner.enum, raw, ctx, start);
      case "prim":
        return inner.prim[0] === "i" ? `_rt.sign_extend(${raw}, ${width})` : raw;
      case "transform": {
        const it = this.code.fresh("it");
        this.code.line(`${it} = ${this.bitValue(inner.inner, raw, width, ctx, start)}`);
        const v = this.expr(inner.read, {
          ...ctx,
          it: { code: it, type: valueTypeOf(this.model, inner.inner) }
        });
        return this.x.to(v, inner.valueType);
      }
      default:
        return raw;
    }
  }

  // ── layers ────────────────────────────────────────────────────────────────

  /**
   * Emits layers `layers[idx]` (outermost) down to `layers[0]` around `inner`. Returns the
   * expression of the value (assigned to a temp when post-processing follows).
   */
  private emitLayers(
    layers: readonly IrLayer[],
    idx: number,
    ctx: RCtx,
    inner: (ctx: RCtx) => string | null,
    slot: string
  ): string | null {
    if (idx < 0) return inner(ctx);
    const l = layers[idx]!;
    const c = this.code;
    const r = ctx.r;
    // `strict` on a padding layer checks its fill even outside strict mode.
    const strict = "strict" in l && l.strict ? "True" : this.strictCode(ctx);
    const next = (x: RCtx): string | null => this.emitLayers(layers, idx - 1, x, inner, slot);
    const capture = (x: RCtx): string | null => {
      const v = next(x);
      if (v === null) return null;
      const t = c.fresh("t");
      c.line(`${t} = ${stripParens(v)}`);
      return t;
    };
    switch (l.kind) {
      case "align":
        c.line(
          `${r}.align(${this.num(l.to, ctx)}, ${this.fill(l.fill, ctx)}, ${strict}${this.alignArgs(l, ctx)})`
        );
        return next(ctx);
      case "padBefore":
        c.line(`${r}.pad(${this.len(l.count, ctx)}, ${this.fill(l.fill, ctx)}, ${strict})`);
        return next(ctx);
      case "padAfter": {
        const v = capture(ctx);
        c.line(`${r}.pad(${this.len(l.count, ctx)}, ${this.fill(l.fill, ctx)}, ${strict})`);
        return v;
      }
      case "padUntil": {
        const s = c.fresh("s");
        c.line(`${s} = ${r}.pos`);
        const v = capture(ctx);
        c.line(
          `${r}.pad_until(${s}, ${this.len(l.size, ctx)}, ${this.fill(l.fill, ctx)}, ${strict})`
        );
        return v;
      }
      case "alignEnd": {
        const v = capture(ctx);
        c.line(
          `${r}.align(${this.num(l.to, ctx)}, ${this.fill(l.fill, ctx)}, ${strict}${this.alignArgs(l, ctx)})`
        );
        return v;
      }
      case "size": {
        const w = c.fresh("w");
        c.line(`${w} = ${r}.window(${this.len(l.size, ctx)})`);
        const v = capture(ctx);
        c.line(`${r}.close_window(${w}, ${strict})`);
        return v;
      }
      case "via": {
        const codec = this.model.codec(l.codec);
        const args = this.args(l.args, codec.params, ctx);
        const size = decodedSize(layers, idx);
        const ctxObj = `_rt.CodecContext([${args.join(", ")}]${size ? `, ${this.len(size, ctx)}` : ""})`;
        const host = this.mod.extern(l.codec);
        if (ctx.scan) {
          // Views decode codec regions on access.
          const lfn = this.closure(false, () => next({ ...ctx, r: "_rv" }), ["_rv"]);
          return `_rt.lazy_region(${r}, ${host}, ${pyStr(codec.name)}, ${ctxObj}, ${pyBool(codec.streaming)}, ${pyBool(codec.ranged)}, ${pyStr(`${slot}#${idx}`)}, ${lfn}${codec.async ? ", True" : ""})`;
        }
        if (codec.async && !ctx.async)
          throw new Error(`async codec ${codec.name} in a sync reader`);
        const s = c.fresh("s");
        const input = c.fresh("in");
        const d = c.fresh("d");
        c.line(`${s} = ${r}.pos`);
        c.line(`${input} = ${r}.peek_bytes(${r}.pos, ${r}.end)`);
        const decode = codec.async ? "await _rt.decode_async" : "_rt.decode";
        c.line(
          `${d} = ${decode}(${host}, ${pyStr(codec.name)}, ${input}, ${ctxObj}, ${pyBool(codec.streaming)}, ${r}.at(${s}))`
        );
        const sr = c.fresh("sr");
        c.line(`${sr} = ${r}.decoded(${d}[0], ${s})`);
        const v = next({ ...ctx, r: sr });
        const t = c.fresh("t");
        c.line(`${t} = ${v === null ? "None" : stripParens(v)}`);
        c.line(`${r}.pos = ${s} + ${d}[1]`);
        c.line(
          `_rt.remember_codec(${t}, ${pyStr(`${slot}#${idx}`)}, ${input}[: ${d}[1]], ${d}[0], ${ctx.owner ?? "_v"})`
        );
        return v === null ? null : t;
      }
      case "endian": {
        const e = c.fresh("en");
        const le = c.fresh("le");
        c.line(`${e} = ${stripParens(this.expr(l.value, ctx).code)}`);
        c.line(`${le} = ${e} == "le"`);
        return next({ ...ctx, endian: e, le });
      }
      case "strict": {
        const sv = c.fresh("st");
        c.line(`${sv} = ${r}.strict`);
        c.line(`${r}.strict = True`);
        // Restored on errors too (a union may go on with its next variant).
        let v: string | null = null;
        c.block("try", () => {
          v = capture(ctx);
        });
        c.block("finally", () => c.line(`${r}.strict = ${sv}`));
        return v;
      }
    }
  }
}

/** The initial path list: the field slot and one index slot per array nesting level. */
export function pathSlots(depth: number): string {
  return `[${['""', ...Array.from({ length: depth }, () => "-1")].join(", ")}]`;
}

/** A primitive read. */
function prim(p: string, le: string, r: string): string {
  switch (p) {
    case "u8":
    case "i8":
      return `${r}.${p}()`;
    case "u24":
    case "u40":
    case "u48":
    case "u56":
      return `${r}.u_n(${primSize(p)}, ${le})`;
    case "i24":
    case "i40":
    case "i48":
    case "i56":
      return `${r}.i_n(${primSize(p)}, ${le})`;
    default:
      return `${r}.${p}(${le})`;
  }
}
