/**
 * Reader emitter: one `read(Reader, params…)` method per struct (and for views a `scan` method),
 * imperative code over the runtime `Reader` following docs/IR.md §2.
 *
 * Java lambdas may only capture effectively final locals, so generated readers keep mutable state
 * in objects: the current field and array indices live in a `Frame` (`$fr`), field extents for
 * `sizeof`/`offsetof` on read in an `int[]` (`$x`), and hidden fields on the struct object.
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
  IrType,
  IrValueType
} from "../../ir/index.ts";
import {
  isOneWay,
  literalInt,
  pieceLength,
  primSize,
  readExtentFields,
  structUnder,
  unlayer,
  usesIndex
} from "./analysis.ts";
import { Code, ident, longLit, str, stripParens, wrap } from "./code.ts";
import { Emitter, type EmitCtx } from "./emitter.ts";
import type { ExprCtx } from "./expr.ts";
import { lazyType, viewFields } from "./views.ts";

export interface RCtx extends EmitCtx {
  /** Reader variable. */
  r: string;
  /** The field being read. */
  field?: string | undefined;
  /** Where the field's value goes (pointers with `@origin` assign it after the members). */
  lvalue?: string | undefined;
  /** View scan mode: composite fields become view values (child nodes, lists, lazies). */
  scan?: boolean | undefined;
  /** The ViewScan variable (scan mode). */
  vs?: string | undefined;
  /** Frame code for view paths ("$fr" in the struct body, "null" inside lazy closures). */
  frame?: string | undefined;
}

interface StructState {
  /** Extent slots in `$x`: field → index of its start (end = index + 1). */
  extents: Map<string, number>;
  needExtent: Set<string>;
  maxDepth: number;
  /** Statements run after the members (pointers with `@origin`). */
  deferred: string[];
}

type ArrayType = Extract<IrType, { kind: "array" }>;

/** The value a deferred pointer read returns: the assignment happens after the members. */
const DEFERRED = "/*deferred*/";

export class ReadEmitter extends Emitter<RCtx> {
  private st!: StructState;
  /** The raw value of the last one-way transform read (JSON shows it). */
  private lastRaw: string | undefined;
  /** Scan mode: fields exposed as view values. */
  private viewSet = new Set<string>();
  /** Scan mode: fields emitted as view values so far (stream sources read them back). */
  private viewEmitted = new Set<string>();
  /** Encoder of one element of a lazy scalar array (in-place patches), or undefined. */
  elementEncoder:
    | ((s: IrStruct, t: IrType, le: string, field: string | undefined) => string | undefined)
    | undefined;

  protected structUsesIndex(s: IrStruct): boolean {
    return usesIndex(s);
  }

  /**
   * Emits `static X read(Reader $r, params…)`, or with `scan` the view scanner `static X
   * scan(Reader $r, ViewScan $vs, params…)`.
   */
  emitStruct(out: Code, s: IrStruct, scan = false): void {
    const name = this.model.className(s.id);
    this.st = { extents: new Map(), needExtent: readExtentFields(s), maxDepth: 0, deferred: [] };
    this.viewSet = scan ? viewFields(s, this.model) : new Set();
    this.viewEmitted = new Set();
    const body = new Code();
    this.code = body;
    const ctx: RCtx = {
      s,
      r: "$r",
      endian: "endian",
      le: "$le",
      index: "$index",
      depth: 0,
      slot: name,
      scan,
      vs: scan ? "$vs" : undefined,
      frame: "$fr"
    };
    this.emitMembers(s.members, ctx);
    // A base's `@alignEnd` pads its whole region (after its targets), counted from its own start.
    const tail = body.child();
    const ends = s.base ? s.layers.filter(l => l.kind === "alignEnd") : [];
    if (s.base) tail.line("$r.inlineEnd = $r.pos;");
    if (ends.length) {
      tail.line(`$r.pos = Math.max($r.pos, $r.maxEnd);`);
      for (const l of ends) tail.line(this.alignRead(l, ctx, l.strict ? "true" : "$r.strict"));
    }

    const params = s.params.map(p => `${this.model.javaValueType(p.type)} ${ident(p.name)}`);
    const R = this.use("Reader");
    const head = scan
      ? `static ${name} scan(${[`${R} $r`, `${this.use("ViewScan")} $vs`, ...params].join(", ")})`
      : `static ${name} read(${[`${R} $r`, ...params].join(", ")})`;
    out.block(head, () => {
      if (s.params.some(p => p.origin === "endian")) {
        out.line(`final boolean $le = endian == ${this.use("Endian")}.LE;`);
      }
      if (scan) out.line(`final ${name} $v = new ${name}();`);
      else out.line(`final ${name} $v = $r.takeInto() instanceof ${name} $o ? $o : new ${name}();`);
      if (usesIndex(s)) out.line(`final long $index = $r.index;`);
      if (this.st.extents.size) {
        out.line(`final int[] $x = new int[${this.st.extents.size * 2}];`);
        out.line(`${this.use("Arrays")}.fill($x, -1);`);
        const t = this.st.extents.get("this");
        if (t !== undefined) out.line(`$x[${t}] = $r.pos;`);
      }
      const F = this.use("Frame");
      out.line(`final ${F} $fr = new ${F}(${this.st.maxDepth || ""});`);
      if (s.base) {
        out.line(`final int $start = $r.pos;`);
        out.line(`final int $base = $r.base;`);
        out.line(`final int $max = $r.maxEnd;`);
        out.line(`$r.base = $r.pos;`);
        out.line(`$r.maxEnd = $r.pos;`);
      }
      out.chain([
        [
          "try",
          () => {
            out.append(body);
            for (const d of this.st.deferred) out.line(d);
            if (ends.length) out.line(`$fr.f = "";`);
            out.append(tail);
          }
        ],
        [`catch (${this.use("YaffleException")} $e)`, () => out.line(`throw $fr.rethrow($e);`)]
      ]);
      if (s.base) {
        out.line(`final int $inline = $r.inlineEnd;`);
        out.line(`$r.pos = Math.max($r.pos, $r.maxEnd);`);
        out.line(`$r.base = $base;`);
        out.line(`$r.maxEnd = Math.max($max, $r.pos);`);
        if (!scan) out.line(`if ($r.tracking()) $r.noteRegion($v, $start, $inline);`);
        out.line(`$r.inlineEnd = $inline;`);
      }
      out.line("return $v;");
    });
  }

  /** Emits the read of a root struct (params are locals named after them); returns the value. */
  rootRead(out: Code, s: IrStruct): string {
    this.st = { extents: new Map(), needExtent: new Set(), maxDepth: 0, deferred: [] };
    this.code = out;
    const ctx: RCtx = {
      s,
      r: "$r",
      endian: "endian",
      le: "$le",
      index: "-1L",
      depth: 0,
      slot: this.model.className(s.id)
    };
    const args: IrExpr[] = s.params.map(p => ({ kind: "param", name: p.name, type: p.type }));
    return this.struct(s.id, args, ctx);
  }

  // ── expression context ──────────────────────────────────────────────────────

  exprCtx(ctx: RCtx): ExprCtx {
    const r = ctx.r;
    const span = (f: string): string => {
      const e = this.extent(f);
      return `($x[${e + 1}] - $x[${e}])`;
    };
    const bytes = (f: string): string => {
      const e = this.extent(f);
      return `${r}.peekBytes($x[${e}], $x[${e + 1}])`;
    };
    return {
      ...this.commonExprCtx(ctx),
      field: (name, type) => {
        const fi = this.model.fieldInfo(ctx.s, name);
        return this.x.fieldValue(`$v.${fi.java}`, fi.boxed, fi.type, type);
      },
      builtin: name => {
        if (name === "offset") return `(long) (${r}.pos - ${r}.base)`;
        if (name === "end") return `(long) (${r}.end - ${r}.base)`;
        return ctx.index;
      },
      sizeof: span,
      offsetof: f => `(long) ($x[${this.extent(f)}] - ${r}.base)`,
      encodedSize: span,
      bytesof: bytes,
      encode: bytes
    };
  }

  private extent(f: string): number {
    let e = this.st.extents.get(f);
    if (e === undefined) {
      e = this.st.extents.size * 2;
      this.st.extents.set(f, e);
    }
    return e;
  }

  /** A count read from the data: EOF if the region cannot hold that many units. */
  count(e: IrExpr, ctx: RCtx, unit: number): string {
    const lit = literalInt(e);
    if (lit !== undefined && lit >= 0 && lit <= 0x7fffffff) return String(lit);
    const c = this.expr(e, ctx);
    if (c.repr === "u64") return `${ctx.r}.countU64(${c.code}, ${unit})`;
    if (c.repr === "big") return `${ctx.r}.count(${c.code}, ${unit})`;
    if (c.repr === "int" && c.range && c.range[0] >= 0n && unit === 1 && c.range[1] < 1n << 31n) {
      return `${ctx.r}.count(${c.code}, 1)`;
    }
    return `${ctx.r}.count(${this.x.asLong(c, this.exprCtx(ctx))}, ${unit})`;
  }

  // ── members ─────────────────────────────────────────────────────────────────

  emitMembers(ms: readonly IrMember[], ctx: RCtx): void {
    for (const m of ms) {
      switch (m.kind) {
        case "field":
          this.emitField(m, ctx);
          break;
        case "bits":
          this.emitBits(m, ctx);
          break;
        case "block": {
          // Views read the members of codec-wrapped blocks eagerly.
          const bctx =
            ctx.scan && m.layers.some(l => l.kind === "via") ? { ...ctx, scan: false } : ctx;
          const body = (): void => {
            this.emitLayers(
              m.layers,
              m.layers.length - 1,
              bctx,
              inner => {
                this.emitMembers(m.members, inner);
                return undefined;
              },
              `${ctx.slot}.block`
            );
          };
          const els = m.else;
          if (m.condition) {
            this.emitIf(m.condition, ctx, body, els && (() => this.emitMembers(els, ctx)));
          } else this.code.block("", body);
          break;
        }
        case "switch":
          this.emitSwitch(
            m,
            ctx,
            ms => this.emitMembers(ms, ctx),
            d => `throw ${ctx.r}.error(${this.use("ErrorCode")}.CHECK, "no case matches " + ${d});`
          );
          break;
      }
    }
  }

  strictCode(ctx: RCtx): string {
    return ctx.s.strict ? "true" : `${ctx.r}.strict`;
  }

  /** The Java field a field of the struct being read is stored in. */
  private target(ctx: RCtx, name: string): string {
    return `$v.${this.model.fieldInfo(ctx.s, name).java}`;
  }

  /** A conditional nullable field: its branch was taken (JSON shows a null value as `null`). */
  private markPresent(f: IrField, ctx: RCtx): void {
    const p = this.model.fieldInfo(ctx.s, f.name).present;
    if (p) this.code.line(`$v.${p} = true;`);
  }

  /** The absolute address of an `at` field; `orEmpty` wraps its value for `@nullable(empty)`. */
  private placement(f: IrField, ctx: RCtx): { addr: string; orEmpty: (v: string) => string } {
    const c = this.code;
    let off = this.num(f.placement!.offset, ctx);
    const emptyNull = f.placement!.emptyIsNull === true;
    if (emptyNull) {
      const o = c.fresh("$o");
      c.line(`final long ${o} = ${off};`);
      off = o;
    }
    const addr = c.fresh("$at");
    c.line(`final long ${addr} = ${ctx.r}.base + ${off};`);
    const orEmpty = (v: string): string =>
      emptyNull ? `${off} == 0 ? ${this.emptyValue(f.type)} : ${v}` : v;
    return { addr, orEmpty };
  }

  emitField(f: IrField, ctx: RCtx): void {
    const c = this.code;
    if (ctx.scan) {
      if (this.viewSet.has(f.name)) {
        this.emitViewField(f, ctx);
        return;
      }
      // Plain fields are read as usual; the scan records their byte range.
      const s0 = c.fresh("$s");
      c.line(`final int ${s0} = ${ctx.r}.pos;`);
      this.emitField(f, { ...ctx, scan: false });
      if (!f.placement && !f.from && !f.virtual) {
        c.line(`${ctx.vs}.range(${str(f.name)}, ${s0}, ${ctx.r}.pos);`);
      }
      return;
    }
    c.line(`$fr.f = ${str(f.name)};`);
    this.markPresent(f, ctx);
    const fctx: RCtx = { ...ctx, slot: `${ctx.s.id}.${f.name}`, field: f.name };
    const ext = this.st.needExtent.has(f.name) ? this.extent(f.name) : undefined;
    let start = `${ctx.r}.pos`;
    if ((f.checks.length > 0 || ext !== undefined) && !f.placement) {
      if (ext !== undefined) {
        c.line(`$x[${ext}] = ${ctx.r}.pos;`);
        start = `$x[${ext}]`;
      } else {
        start = c.fresh("$s");
        c.line(`final int ${start} = ${ctx.r}.pos;`);
      }
    }
    const tgt = this.target(ctx, f.name);
    if (f.placement) {
      const { addr, orEmpty } = this.placement(f, ctx);
      if (ext !== undefined) c.line(`$x[${ext}] = (int) ${addr};`);
      start = addr;
      c.line(`${tgt} = ${orEmpty(this.follow(f.type, addr, fctx))};`);
      if (ext !== undefined) {
        const size = this.model.staticSize(f.type);
        const end = size !== undefined ? `(int) ${addr} + ${size}` : `${ctx.r}.lastTargetEnd`;
        c.line(`$x[${ext + 1}] = ${end};`);
      }
    } else if (f.from) {
      const stream = this.stream(f.from.stream, ctx);
      const sr = c.fresh("$sr");
      c.line(`final ${this.use("Reader")} ${sr} = ${ctx.r}.sub(${stream});`);
      c.line(`${tgt} = ${this.read(f.type, { ...fctx, r: sr })};`);
    } else if (f.virtual) {
      c.line(`${tgt} = ${this.virtualValue(f, f.virtual.read, ctx)};`);
    } else {
      this.lastRaw = undefined;
      const v = this.read(f.type, { ...fctx, lvalue: f.type.kind === "pointer" ? tgt : undefined });
      if (v !== DEFERRED) c.line(`${tgt} = ${v};`);
      const raw = this.model.fieldInfo(ctx.s, f.name).raw;
      if (this.lastRaw && isOneWay(f.type) && raw) c.line(`$v.${raw.java} = ${this.lastRaw};`);
      if (ext !== undefined) c.line(`$x[${ext + 1}] = ${ctx.r}.pos;`);
    }
    this.emitChecks(f.checks, f.type, this.itCode(ctx.s, f.name, f.type), start, ctx);
  }

  /** A virtual field's value: computed from earlier fields, range-checked against its type. */
  private virtualValue(f: IrField, read: IrExpr, ctx: RCtx): string {
    const vt = this.model.valueTypeOf(f.type);
    const ectx = this.exprCtx(ctx);
    const ce = this.expr(read, ctx);
    const t = unlayer(f.type);
    if (t.kind !== "prim" || t.prim[0] === "f") return this.x.to(ce, vt, ectx);
    const raw =
      ce.repr === "big" || ce.repr === "u64" ? this.x.asBig(ce, ectx) : this.x.asLong(ce, ectx);
    const v = `${this.use("Ints")}.check(${raw}, ${this.use("Prim")}.${t.prim.toUpperCase()})`;
    return this.model.javaValueType(vt) === "int" ? `(int) ${v}` : v;
  }

  // ── view scans ──────────────────────────────────────────────────────────────

  /** Scan mode: a field exposed as a view value (child node, list, lazy bytes/target/region/stream). */
  private emitViewField(f: IrField, ctx: RCtx): void {
    const c = this.code;
    const vs = ctx.vs!;
    const put = (v: string): void => {
      c.line(`${vs}.put(${str(f.name)}, ${v});`);
    };
    c.line(`$fr.f = ${str(f.name)};`);
    this.markPresent(f, ctx);
    const fctx: RCtx = { ...ctx, slot: `${ctx.s.id}.${f.name}`, field: f.name };
    this.viewEmitted.add(f.name);
    const frame = ctx.frame ?? "null";
    if (f.placement) {
      const { addr, orEmpty } = this.placement(f, ctx);
      put(orEmpty(this.lazyTarget(f.type, addr, fctx)));
    } else if (f.from?.stream.kind === "each") {
      // Pieces: decoded only when a read touches them (when their sizes are known).
      const st = f.from.stream;
      const p = this.pieceFns(st, ctx);
      put(
        `${vs}.lazyPieces(${ctx.r}, ${p.source}, ${str(st.field)}, ${p.piece}, ${p.len}, ${frame}, ${this.scanLambda(f.type, fctx)})`
      );
    } else if (f.from) {
      const stream = this.stream(f.from.stream, ctx);
      put(
        `${vs}.lazyStream(${ctx.r}, () -> ${stream}, ${frame}, ${this.scanLambda(f.type, fctx)})`
      );
    } else {
      const s0 = c.fresh("$s");
      c.line(`final int ${s0} = ${ctx.r}.pos;`);
      const lvalue = f.type.kind === "pointer" ? "deferred" : undefined;
      const v = this.scanType(f.type, { ...fctx, lvalue });
      if (v !== DEFERRED) put(v);
      c.line(`${vs}.range(${str(f.name)}, ${s0}, ${ctx.r}.pos);`);
    }
  }

  /** A lambda `(Reader, ViewScan) -> value` scanning `t` (targets, regions, streams). */
  private scanLambda(t: IrType, ctx: RCtx): string {
    const r2 = this.code.fresh("$r");
    const vs2 = this.code.fresh("$vs");
    const body = this.closure(() =>
      this.scanType(t, { ...ctx, r: r2, vs: vs2, frame: "null", lvalue: undefined })
    );
    return `(${r2}, ${vs2}) -> ${body}`;
  }

  /** A pointer or `at` target read on access. */
  private lazyTarget(t: IrType, addr: string, ctx: RCtx): string {
    const key = this.targetKey(t, ctx);
    return `${ctx.vs}.lazyTarget(${ctx.r}, ${addr}, ${key}, ${this.scanLambda(t, ctx)}, ${ctx.frame ?? "null"})`;
  }

  /** Scan mode: the view value of a value of type `t`. */
  private scanType(t: IrType, ctx: RCtx): string {
    switch (t.kind) {
      case "layered":
        return this.emitLayers(
          t.layers,
          t.layers.length - 1,
          ctx,
          inner => this.scanType(t.inner, inner),
          ctx.slot
        )!;
      case "struct":
        return this.struct(t.struct, t.args, ctx);
      case "array":
        if (lazyType(t)) return this.scanArray(t, ctx);
        break;
      case "bytes":
        if (t.length.kind === "count") {
          return `${ctx.vs}.lazyBytes(${ctx.r}, ${this.count(t.length.expr, ctx, 1)})`;
        }
        if (t.length.kind === "rest") {
          return `${ctx.vs}.lazyBytes(${ctx.r}, ${ctx.r}.end - ${ctx.r}.pos)`;
        }
        break;
      case "pointer":
        return this.pointer(t, ctx);
    }
    return this.read(t, { ...ctx, scan: false });
  }

  /** An element of a scanned array: struct elements are child nodes, pointers lazy targets. */
  private scanElem(t: IrType, ctx: RCtx): string {
    const x = unlayer(t);
    if (x.kind === "struct" || x.kind === "pointer") return this.scanType(t, ctx);
    return this.read(t, { ...ctx, scan: false });
  }

  private scanArray(t: ArrayType, ctx: RCtx): string {
    const c = this.code;
    const vs = ctx.vs!;
    const frame = ctx.frame ?? "null";
    const es = this.model.staticSize(t.element);
    if (t.elementPlacement) return this.scanPlacedArray(t, t.elementPlacement, ctx);
    if (t.length.kind === "count" && es !== undefined && es > 0) {
      const n = c.fresh("$n");
      c.line(`final int ${n} = ${this.count(t.length.expr, ctx, es)};`);
      const i = c.fresh("$i");
      const r2 = c.fresh("$r");
      const vs2 = c.fresh("$vs");
      const ectx: RCtx = { ...ctx, r: r2, vs: vs2, frame: "null", index: `(long) ${i}` };
      const body = this.closure(() => this.scanElem(t.element, ectx));
      const enc = this.elementEncoder?.(ctx.s, t.element, ctx.le, ctx.field) ?? "null";
      return `${vs}.lazyArray(${ctx.r}, ${n}, ${es}, (${r2}, ${vs2}, ${i}) -> ${body}, ${enc}, ${frame})`;
    }
    const a = this.loop(t, ctx, "Object", {
      head: (k, r) => {
        if (t.length.kind !== "count") return `for (int ${k} = 0; ${r}.pos < ${r}.end; ${k}++)`;
        const n = c.fresh("$n");
        c.line(`final int ${n} = ${this.count(t.length.expr, ctx, es ?? 1)};`);
        return `for (int ${k} = 0; ${k} < ${n}; ${k}++)`;
      },
      body: (ectx, a) => c.line(`${a}.add(${this.scanElem(t.element, ectx)});`)
    });
    return `${vs}.arrayOf(${a}, ${frame})`;
  }

  /** `T items[n] at expr($index)` (struct elements): child nodes at the elements' offsets. */
  private scanPlacedArray(t: ArrayType, place: IrExpr, ctx: RCtx): string {
    const a = this.loop(t, ctx, "Object", {
      head: k => this.placedHead(t, k, ctx),
      body: (ectx, a) => {
        const addr = this.elementAddress(t, place, ectx);
        const body = this.closure(() => this.scanElem(t.element, ectx));
        this.code.line(`${a}.add(${ctx.r}.peekAt(${addr}, () -> ${body}));`);
      }
    });
    return `${ctx.vs}.arrayOf(${a}, ${ctx.frame ?? "null"})`;
  }

  emitChecks(
    checks: readonly { expr: IrExpr; message: string; strictOnly: boolean }[],
    t: IrType,
    value: string,
    start: string,
    ctx: RCtx
  ): void {
    for (const ch of checks) {
      const ictx: RCtx = { ...ctx, it: { code: value, type: this.model.valueTypeOf(t) } };
      const cond = this.expr(ch.expr, ictx).code;
      const guard = ch.strictOnly ? `${this.strictCode(ctx)} && ` : "";
      this.code.line(
        `if (${guard}!${wrap(cond)}) throw ${ctx.r}.checkFail(${str(ch.message)}, ${start});`
      );
    }
  }

  /** Code of a field value used as `it` (boxed conditional fields are unboxed). */
  private itCode(s: IrStruct, name: string, t: IrType): string {
    const fi = this.model.fieldInfo(s, name);
    const code = `$v.${fi.java}`;
    if (fi.boxed) return `${code}.${this.model.javaType(t, false)}Value()`;
    if (fi.type === this.model.lang("Object")) {
      return this.x.unbox(code, this.model.valueTypeOf(t), true).code;
    }
    return code;
  }

  /** Reads a pointer or `at` target of type `t` at absolute `addr` (identity per address and type). */
  private follow(t: IrType, addr: string, ctx: RCtx): string {
    const key = this.targetKey(t, ctx);
    const body = this.closure(() => this.read(t, { ...ctx, lvalue: undefined }));
    const st = structUnder(t);
    if (st) {
      const name = this.model.className(st);
      return `${ctx.r}.targetStruct(${addr}, ${key}, ${name}::new, () -> ${body})`;
    }
    return `${ctx.r}.target(${addr}, ${key}, () -> ${body})`;
  }

  // ── streams ─────────────────────────────────────────────────────────────────

  /** True if `name` was emitted as a view value by the scan being emitted (`ctx.vs` set). */
  private scannedView(name: string, ctx: RCtx): boolean {
    return ctx.vs !== undefined && this.viewEmitted.has(name);
  }

  /** The element struct of `arr[*].field` streams. */
  private pieceStruct(s: Extract<IrStreamExpr, { kind: "each" }>, ctx: RCtx): IrStruct {
    const f = this.model.field(ctx.s, s.array);
    if (!f?.field) throw new Error(`unknown stream array ${s.array}`);
    const t = unlayer(f.field.type);
    const et = t.kind === "array" ? unlayer(t.element) : undefined;
    if (et?.kind !== "struct") throw new Error(`${s.array} elements are not structs`);
    return this.model.struct(et.struct);
  }

  /**
   * Views: the parts of an `arr[*].field` stream: the array's value (element nodes if the scan
   * made them), the piece of a plain element, and the piece's decoded length from a plain
   * element's scalars ("null" when not known without decoding).
   */
  private pieceFns(
    s: Extract<IrStreamExpr, { kind: "each" }>,
    ctx: RCtx
  ): { source: string; piece: string; len: string } {
    const source = this.scannedView(s.array, ctx)
      ? `${ctx.vs}.got(${str(s.array)})`
      : this.target(ctx, s.array);
    const es = this.pieceStruct(s, ctx);
    const E = this.model.className(es.id);
    const e = this.code.fresh("$pe");
    const piece = `${e} -> ((${E}) ${e}).${this.model.fieldInfo(es, s.field).java}`;
    const pf = this.model.field(es, s.field)?.field;
    const lenExpr = pf ? pieceLength(pf.type) : undefined;
    return { source, piece, len: lenExpr ? this.pieceLen(es, lenExpr) : "null" };
  }

  /** `e -> length` over a plain element's scalars, or "null" if the length needs more than them. */
  private pieceLen(es: IrStruct, lenExpr: IrExpr): string {
    const pe = this.code.fresh("$pe");
    const E = this.model.className(es.id);
    const unsupported = (): never => {
      throw new Error("not a function of the element's fields");
    };
    const ectx: ExprCtx = {
      ...this.cls.constExprCtx(),
      field: (name, type) => {
        const fi = this.model.fieldInfo(es, name);
        return this.x.fieldValue(`((${E}) ${pe}).${fi.java}`, fi.boxed, fi.type, type);
      },
      param: unsupported,
      builtin: unsupported,
      sizeof: unsupported,
      offsetof: unsupported
    };
    try {
      return `${pe} -> ${this.x.asLong(this.x.compile(lenExpr, ectx), ectx)}`;
    } catch {
      return "null";
    }
  }

  private stream(s: IrStreamExpr, ctx: RCtx): string {
    switch (s.kind) {
      case "field": {
        if (!this.model.field(ctx.s, s.field)?.field) {
          throw new Error(`unknown stream field ${s.field}`);
        }
        if (this.scannedView(s.field, ctx)) {
          return `${this.use("ViewScan")}.bytesOf(${ctx.vs}.got(${str(s.field)}))`;
        }
        return this.target(ctx, s.field);
      }
      case "each": {
        if (!this.model.field(ctx.s, s.array)?.field) {
          throw new Error(`unknown stream array ${s.array}`);
        }
        if (ctx.vs !== undefined) {
          const p = this.pieceFns(s, ctx);
          return `${this.use("ViewScan")}.joinPieces(${p.source}, ${str(s.field)}, ${p.piece})`;
        }
        const piece = this.model.fieldInfo(this.pieceStruct(s, ctx), s.field).java;
        const e = this.code.fresh("$pe");
        return `${this.use("Streams")}.join(${this.target(ctx, s.array)}.stream().map(${e} -> ${e}.${piece}).toList())`;
      }
      case "slice": {
        const inner = this.stream(s.stream, ctx);
        const a = this.num(s.start, ctx);
        const b = s.end ? this.num(s.end, ctx) : "-1L";
        return `${this.use("Streams")}.slice(${inner}, ${a}, ${b})`;
      }
    }
  }

  // ── types ───────────────────────────────────────────────────────────────────

  /** Emits statements for reading `t`; returns an expression to evaluate right after them. */
  read(t: IrType, ctx: RCtx): string {
    // Struct values pointers can target are one object per (address, type), inline ones too.
    if (t.kind === "struct" && this.model.identityStructs.has(t.struct)) {
      const key = this.targetKey(t, ctx);
      const name = this.model.className(t.struct);
      const body = this.closure(() => this.readInner(t, ctx));
      return `${ctx.r}.inline(${key}, ${name}::new, () -> ${body})`;
    }
    return this.readInner(t, ctx);
  }

  private readInner(t: IrType, ctx: RCtx): string {
    const r = ctx.r;
    const c = this.code;
    switch (t.kind) {
      case "prim":
        return this.prim(t.prim, this.leOf(t.endian, ctx), r);
      case "bool":
        return `${r}.bool(${this.strictCode(ctx)})`;
      case "string": {
        const le = t.unit === 1 ? "true" : this.leOf(t.endian, ctx);
        const enc = `${this.use("Encoding")}.${t.encoding.toUpperCase()}`;
        if (t.length.kind === "count") {
          return `${r}.str(${this.count(t.length.expr, ctx, t.unit)}, ${t.unit}, ${enc}, ${le})`;
        }
        if (t.length.kind === "until") return `${r}.strUntil(${t.unit}, ${enc}, ${le})`;
        return `${r}.strRest(${t.unit}, ${enc}, ${le})`;
      }
      case "bytes":
        if (t.length.kind === "count") return `${r}.bytes(${this.count(t.length.expr, ctx, 1)})`;
        if (t.length.kind === "until")
          return `${r}.bytesUntil(${this.num(t.length.terminator, ctx)})`;
        return `${r}.bytesRest()`;
      case "array":
        return this.array(t, ctx);
      case "struct":
        return this.struct(t.struct, t.args, ctx);
      case "enum": {
        const s = c.fresh("$s");
        c.line(`final int ${s} = ${r}.pos;`);
        const raw = this.prim(this.model.enum(t.enum).storage, this.leOf(t.endian, ctx), r);
        return this.enumValue(t.enum, raw, ctx, s);
      }
      case "pointer":
        return this.pointer(t, ctx);
      case "extern": {
        const x = this.model.extern(t.extern);
        const args = this.argCodes(x.params, t.args, ctx);
        const fixed = x.kind === "type" && x.fixedSize !== undefined ? x.fixedSize : -1;
        const call = `${r}.extern(${this.cls.externObj(t.extern)}, new Object[] {${args.join(", ")}}, ${fixed})`;
        return x.kind === "type" ? this.hostValue(call, x.valueType) : call;
      }
      case "union": {
        const u = this.model.unionOfT(t);
        const alts = t.variants.map((v, i) => {
          const body = this.closure(
            () => `new ${u.name}.${u.variants[i]!.java}(${this.read(v.type, ctx)})`
          );
          return `() -> ${body}`;
        });
        const names = `new String[] {${t.variants.map(v => str(v.name)).join(", ")}}`;
        return `${r}.<${u.name}>union(${names}, ${alts.join(", ")})`;
      }
      case "transform": {
        const it = c.fresh("$it");
        const innerVt = this.model.valueTypeOf(t.inner);
        c.line(`final ${this.model.javaValueType(innerVt)} ${it} = ${this.read(t.inner, ctx)};`);
        if (!t.write) this.lastRaw = it;
        return this.transformed(t, it, innerVt, ctx);
      }
      case "layered":
        return this.emitLayers(
          t.layers,
          t.layers.length - 1,
          ctx,
          inner => this.read(t.inner, inner),
          ctx.slot
        )!;
    }
  }

  /** A transform's value from its raw value `it`. */
  private transformed(
    t: Extract<IrType, { kind: "transform" }>,
    it: string,
    innerVt: IrValueType,
    ctx: RCtx
  ): string {
    const v = this.expr(t.read, { ...ctx, it: { code: it, type: innerVt } });
    return this.x.to(v, t.valueType, this.exprCtx(ctx));
  }

  /** An enum value from its raw value (a closed enum checks membership). */
  private enumValue(id: string, raw: string, ctx: RCtx, start: string): string {
    const name = this.model.enumName(id);
    return this.model.enum(id).open
      ? `${name}.of(${raw})`
      : `${name}.read(${raw}, ${ctx.r}, ${start})`;
  }

  /** Validates/converts a value returned by host code to its declared value type. */
  hostValue(code: string, t: IrValueType): string {
    const j = this.model.javaValueType(t, false);
    const R = this.use("Rt");
    switch (j) {
      case "int":
        return `(int) ${R}.hostLong(${code})`;
      case "long":
        return `${R}.hostLong(${code})`;
      case "double":
        return `${R}.hostDouble(${code})`;
      case "float":
        return `(float) ${R}.hostDouble(${code})`;
      case "boolean":
        return `${R}.hostValue(${code}, Boolean.class)`;
      default:
        return j.includes("<") ? `${R}.<${j}>cast(${code})` : `${R}.hostValue(${code}, ${j}.class)`;
    }
  }

  prim(p: string, le: string, r: string): string {
    switch (p) {
      case "u8":
      case "i8":
        return `${r}.${p}()`;
      case "u40":
      case "u48":
      case "u56":
        return `${r}.uN(${primSize(p)}, ${le})`;
      case "i40":
      case "i48":
      case "i56":
        return `${r}.iN(${primSize(p)}, ${le})`;
      default:
        return `${r}.${p}(${le})`;
    }
  }

  struct(id: string, args: readonly IrExpr[], ctx: RCtx): string {
    const s = this.model.struct(id);
    const name = this.model.className(id);
    const call = (inner: RCtx): string => {
      const argCode = this.argCodes(s.params, args, inner);
      if (inner.scan) {
        return `${inner.vs}.child(${inner.r}, ${name}.INFO, new Object[] {${argCode.join(", ")}}, ${inner.frame ?? "null"})`;
      }
      return `${name}.read(${[inner.r, ...argCode].join(", ")})`;
    };
    const layers = this.outerLayers(s);
    if (!layers.length) return call(ctx);
    return this.emitLayers(layers, layers.length - 1, ctx, call, `${ctx.slot}#${s.name}`)!;
  }

  /**
   * Emits `final List<elem> a = new ArrayList<>()` and a loop over its elements (`head` gives the
   * loop header, `pre` runs before the frame index is set); returns `a`.
   */
  private loop(
    t: ArrayType,
    ctx: RCtx,
    elem: string,
    o: {
      head: (k: string, r: string) => string;
      pre?: () => void;
      body: (ectx: RCtx, a: string) => void;
    }
  ): string {
    const c = this.code;
    const r = ctx.r;
    const depth = ctx.depth;
    this.st.maxDepth = Math.max(this.st.maxDepth, depth + 1);
    const a = c.fresh("$a");
    const k = c.fresh("$k");
    const i = c.fresh("$i");
    const ectx: RCtx = { ...ctx, index: `(long) ${i}`, depth: depth + 1 };
    const setIndex = this.elementUsesIndex(t.element);
    c.line(`final ${this.use("List")}<${elem}> ${a} = new ${this.use("ArrayList")}<>();`);
    const saved = setIndex ? c.fresh("$ix") : "";
    if (setIndex) c.line(`final int ${saved} = ${r}.index;`);
    c.block(o.head(k, r), () => {
      c.line(`final int ${i} = ${k};`);
      o.pre?.();
      c.line(`$fr.i[${depth}] = ${i};`);
      if (setIndex) c.line(`${r}.index = ${i};`);
      o.body(ectx, a);
    });
    if (setIndex) c.line(`${r}.index = ${saved};`);
    c.line(`$fr.i[${depth}] = -1;`);
    return a;
  }

  /** The loop header of an array with element placements. */
  private placedHead(t: ArrayType, k: string, ctx: RCtx): string {
    if (t.length.kind !== "count") return `for (int ${k} = 0; ; ${k}++)`;
    const n = this.code.fresh("$n");
    this.code.line(`final int ${n} = ${this.len(t.length.expr, ctx)};`);
    return `for (int ${k} = 0; ${k} < ${n}; ${k}++)`;
  }

  /** The absolute address of a placed element (a `rest` array stops at the region end). */
  private elementAddress(t: ArrayType, place: IrExpr, ectx: RCtx): string {
    const c = this.code;
    const off = this.num(place, ectx);
    const addr = c.fresh("$at");
    c.line(`final long ${addr} = ${ectx.r}.base + ${off};`);
    if (t.length.kind === "rest") c.line(`if (${addr} >= ${ectx.r}.end) break;`);
    return addr;
  }

  private array(t: ArrayType, ctx: RCtx): string {
    const c = this.code;
    const r = ctx.r;
    const elem = this.model.javaType(t.element, true);
    const len = t.length;
    const place = t.elementPlacement;
    if (place) {
      const readAt = (ectx: RCtx): string => {
        const addr = this.elementAddress(t, place, ectx);
        return `${r}.peekAt(${addr}, () -> ${this.closure(() => this.read(t.element, ectx))})`;
      };
      return this.loop(t, ctx, elem, {
        head: k =>
          len.kind === "count" ? this.placedHead(t, k, ctx) : `for (int ${k} = 0; ; ${k}++)`,
        body: (ectx, a) => {
          const v = readAt(ectx);
          if (len.kind === "count" || len.kind === "rest") c.line(`${a}.add(${v});`);
          else this.terminated(len, t.element, v, a, undefined, ctx);
        }
      });
    }
    if (len.kind === "count" || len.kind === "rest") {
      return this.loop(t, ctx, elem, {
        head: k => {
          if (len.kind === "rest") return `for (int ${k} = 0; ${r}.pos < ${r}.end; ${k}++)`;
          const n = c.fresh("$n");
          const es = this.model.staticSize(t.element);
          c.line(`final int ${n} = ${this.count(len.expr, ctx, es ?? 1)};`);
          return `for (int ${k} = 0; ${k} < ${n}; ${k}++)`;
        },
        body: (ectx, a) => c.line(`${a}.add(${this.read(t.element, ectx)});`)
      });
    }
    let p = "";
    return this.loop(t, ctx, elem, {
      head: k => {
        p = c.fresh("$p");
        return `for (int ${k} = 0; ; ${k}++)`;
      },
      pre: () => c.line(`final int ${p} = ${r}.pos;`),
      body: (ectx, a) => this.terminated(len, t.element, this.read(t.element, ectx), a, p, ctx)
    });
  }

  /**
   * After reading element `el` of a terminated array: `until v` drops the terminator, `before v`
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
    const e = c.fresh("$el");
    const vt = this.model.valueTypeOf(elem);
    c.line(`final ${this.model.javaValueType(vt)} ${e} = ${el};`);
    if (len.kind === "untilPredicate") {
      c.line(`${a}.add(${e});`);
      const cond = this.expr(len.predicate, { ...ctx, it: { code: e, type: vt } }).code;
      c.line(`if (${stripParens(cond)}) break;`);
      return;
    }
    if (len.kind !== "until" && len.kind !== "before") {
      throw new Error(`unexpected length ${len.kind}`);
    }
    const eq = this.x.equality(
      "==",
      this.x.typed(e, vt),
      this.expr(len.terminator, ctx),
      this.exprCtx(ctx)
    );
    if (len.kind === "before" && pos) {
      c.block(`if (${stripParens(eq)})`, () => c.line(`${ctx.r}.pos = ${pos};`).line("break;"));
    } else c.line(`if (${stripParens(eq)}) break;`);
    c.line(`${a}.add(${e});`);
  }

  private pointer(t: Extract<IrType, { kind: "pointer" }>, ctx: RCtx): string {
    const c = this.code;
    const r = ctx.r;
    const at = c.fresh("$pa");
    if (t.relative) c.line(`final int ${at} = ${r}.pos;`);
    const p = c.fresh("$p");
    c.line(`final long ${p} = ${this.prim(t.storage, this.leOf(t.storageEndian, ctx), r)};`);
    const off = t.storage === "u64" ? `${this.use("Ints")}.u64ToLong(${p})` : p;
    // `@origin(expr)`: target = base + origin + value; the origin may use positions of later
    // fields, so a field's pointer is followed once the struct's members are read. (Elements of
    // an array of pointers are followed right away: their origin may only use earlier fields.)
    const origin = t.origin ? this.num(t.origin, ctx) : undefined;
    const addr = t.relative
      ? `${at} + ${off}`
      : `${r}.base + ${origin !== undefined ? `${origin} + ` : ""}${off}`;
    const tctx = { ...ctx, lvalue: undefined };
    let follow = ctx.scan
      ? this.lazyTarget(t.target, addr, tctx)
      : this.follow(t.target, addr, tctx);
    if (t.nullValue !== undefined) {
      const empty = t.emptyIsNull ? this.emptyValue(t.target) : "null";
      follow = `${p} == ${longLit(BigInt.asIntN(64, BigInt(t.nullValue)))} ? ${empty} : ${follow}`;
    }
    if (origin === undefined || ctx.lvalue === undefined) return follow;
    const assign = ctx.scan
      ? `${ctx.vs}.put(${str(ctx.field ?? "")}, ${follow});`
      : `${ctx.lvalue} = ${follow};`;
    this.st.deferred.push(`$fr.f = ${str(ctx.field ?? "")};\n${assign}`);
    return DEFERRED;
  }

  /** Identity key of a target: type key, plus argument values for parameterized structs. */
  targetKey(t: IrType, ctx: RCtx): string {
    const keyed = unlayer(t);
    const inner = keyed.kind === "transform" ? unlayer(keyed.inner) : keyed;
    const base = this.model.typeKey(keyed);
    const exprs: IrExpr[] = [];
    if (inner.kind === "struct") exprs.push(...inner.args);
    if (
      (inner.kind === "bytes" || inner.kind === "string" || inner.kind === "array") &&
      inner.length.kind === "count"
    ) {
      exprs.push(inner.length.expr);
    }
    if (!exprs.length) return str(base);
    const parts = exprs.map(a => wrap(this.expr(a, ctx).code));
    return `${str(`${base}(`)} + ${parts.join(' + "," + ')} + ")"`;
  }

  emitBits(b: IrBits, ctx: RCtx): void {
    const c = this.code;
    const size = primSize(b.storage);
    const u = c.fresh("$u");
    const s = c.fresh("$s");
    c.line(`final int ${s} = ${ctx.r}.pos;`);
    const le = this.leOf(b.endian, ctx);
    const raw =
      size === 8
        ? `${ctx.r}.u64(${le})`
        : size === 1
          ? `${ctx.r}.u8()`
          : `${ctx.r}.prim(${this.use("Prim")}.U${size * 8}, ${le})`;
    c.line(`final long ${u} = ${raw};`);
    for (const f of b.fields) {
      const bits = extractBits(u, f.shift, f.width);
      if (f.name === null) {
        c.line(
          `if (${this.strictCode(ctx)} && ${bits} != 0) throw ${ctx.r}.error(${this.use("ErrorCode")}.CHECK, "reserved bits are not zero", ${s});`
        );
        continue;
      }
      c.line(`$fr.f = ${str(f.name)};`);
      c.line(`${this.target(ctx, f.name)} = ${this.bitValue(f.type, bits, f.width, ctx, s)};`);
      if (ctx.scan) c.line(`${ctx.vs}.range(${str(f.name)}, ${s}, ${s} + ${size});`);
      this.emitChecks(f.checks, f.type, this.itCode(ctx.s, f.name, f.type), s, ctx);
    }
  }

  private bitValue(t: IrType, raw: string, width: number, ctx: RCtx, start: string): string {
    const inner = t.kind === "layered" ? t.inner : t;
    switch (inner.kind) {
      case "bool":
        return `${wrap(raw)} != 0`;
      case "enum":
        return this.enumValue(inner.enum, raw, ctx, start);
      case "prim": {
        const code =
          inner.prim[0] === "i" ? `${this.use("Bytes")}.signExtend(${raw}, ${width})` : raw;
        return this.model.javaType(inner) === "int" ? `(int) ${wrap(code)}` : code;
      }
      case "transform": {
        const it = this.code.fresh("$it");
        const innerVt = this.model.valueTypeOf(inner.inner);
        const v = this.bitValue(inner.inner, raw, width, ctx, start);
        this.code.line(`final ${this.model.javaValueType(innerVt)} ${it} = ${v};`);
        return this.transformed(inner, it, innerVt, ctx);
      }
      default:
        return raw;
    }
  }

  // ── layers ──────────────────────────────────────────────────────────────────

  /**
   * Emits layers `layers[idx]` (outermost) down to `layers[0]` around `inner`. Returns the
   * expression of the value (assigned to a temp when post-processing follows), or undefined for
   * member blocks.
   */
  emitLayers(
    layers: readonly IrLayer[],
    idx: number,
    ctx: RCtx,
    inner: (ctx: RCtx) => string | undefined,
    slot: string
  ): string | undefined {
    if (idx < 0) return inner(ctx);
    const l = layers[idx]!;
    const c = this.code;
    const r = ctx.r;
    const strict = this.strictCode(ctx);
    const next = (x: RCtx): string | undefined => this.emitLayers(layers, idx - 1, x, inner, slot);
    const capture = (x: RCtx): string | undefined => {
      const v = next(x);
      if (v === undefined) return v;
      const t = c.fresh("$t");
      c.line(`final var ${t} = ${v};`);
      return t;
    };
    // A `strict` padding layer checks its fill even outside strict mode.
    const padStrict = (x: { strict?: true }): string => (x.strict ? "true" : strict);
    switch (l.kind) {
      case "align":
        c.line(this.alignRead(l, ctx, padStrict(l)));
        return next(ctx);
      case "padBefore":
        c.line(`${r}.pad(${this.num(l.count, ctx)}, ${this.fill(l.fill, ctx)}, ${padStrict(l)});`);
        return next(ctx);
      case "padAfter": {
        const v = capture(ctx);
        c.line(`${r}.pad(${this.num(l.count, ctx)}, ${this.fill(l.fill, ctx)}, ${padStrict(l)});`);
        return v;
      }
      case "padUntil": {
        const s = c.fresh("$s");
        c.line(`final int ${s} = ${r}.pos;`);
        const v = capture(ctx);
        c.line(
          `${r}.padUntil(${s}, ${this.num(l.size, ctx)}, ${this.fill(l.fill, ctx)}, ${padStrict(l)});`
        );
        return v;
      }
      case "alignEnd": {
        const v = capture(ctx);
        c.line(this.alignRead(l, ctx, padStrict(l)));
        return v;
      }
      case "size": {
        const w = c.fresh("$w");
        c.line(`final int ${w} = ${r}.window(${this.num(l.size, ctx)});`);
        const v = capture(ctx);
        c.line(`${r}.closeWindow(${w}, ${strict});`);
        return v;
      }
      case "via":
        return this.via(layers, idx, ctx, next, slot);
      case "endian": {
        const e = c.fresh("$e");
        const le = c.fresh("$le");
        const E = this.use("Endian");
        c.line(`final ${E} ${e} = ${this.expr(l.value, ctx).code};`);
        c.line(`final boolean ${le} = ${e} == ${E}.LE;`);
        return next({ ...ctx, endian: e, le });
      }
      case "strict": {
        const sv = c.fresh("$st");
        c.line(`final boolean ${sv} = ${r}.strict;`);
        c.line(`${r}.strict = true;`);
        const v = capture(ctx);
        c.line(`${r}.strict = ${sv};`);
        return v;
      }
    }
  }

  /** A codec layer: decoded now, or (scan mode) a region views decode on access. */
  private via(
    layers: readonly IrLayer[],
    idx: number,
    ctx: RCtx,
    next: (x: RCtx) => string | undefined,
    slot: string
  ): string | undefined {
    const l = layers[idx] as Extract<IrLayer, { kind: "via" }>;
    const c = this.code;
    const r = ctx.r;
    const codec = this.model.codec(l.codec);
    const args = this.argCodes(codec.params, l.args, ctx);
    // The decoded size, when an inner `@size` gives it.
    let outSize = "-1";
    for (let k = idx - 1; k >= 0; k--) {
      const ll = layers[k]!;
      if (ll.kind === "via") break;
      if (ll.kind === "size") {
        outSize = this.len(ll.size, ctx);
        break;
      }
    }
    const cc = `new ${this.use("CodecCtx")}(new Object[] {${args.join(", ")}}, ${outSize}, 0)`;
    const host = this.cls.externObj(l.codec);
    const key = str(`${slot}#${idx}`);
    if (ctx.scan) {
      const r2 = c.fresh("$r");
      const vs2 = c.fresh("$vs");
      const body = this.closure(
        () => next({ ...ctx, r: r2, vs: vs2, frame: "null", lvalue: undefined }) ?? "null"
      );
      return `${ctx.vs}.lazyRegion(${r}, ${host}, ${str(codec.name)}, ${cc}, ${codec.streaming}, ${codec.ranged}, ${key}, ${ctx.frame ?? "null"}, (${r2}, ${vs2}) -> ${body})`;
    }
    const s = c.fresh("$s");
    const input = c.fresh("$in");
    const d = c.fresh("$d");
    c.line(`final int ${s} = ${r}.pos;`);
    c.line(`final byte[] ${input} = ${r}.peekBytes(${r}.pos, ${r}.end);`);
    c.line(
      `final ${this.use("Decoded")} ${d} = ${this.use("Codecs")}.decode(${host}, ${str(codec.name)}, ${input}, ${cc}, ${codec.streaming}, ${r}.at(${s}));`
    );
    const sr = c.fresh("$sr");
    c.line(`final ${this.use("Reader")} ${sr} = ${r}.decoded(${d}.output(), ${s});`);
    const v = next({ ...ctx, r: sr });
    if (v === undefined) {
      c.line(`${r}.pos = ${s} + ${d}.consumed();`);
      return undefined;
    }
    const t = c.fresh("$t");
    c.line(`final var ${t} = ${v};`);
    c.line(`${r}.pos = ${s} + ${d}.consumed();`);
    const enc = `${d}.consumed() == ${input}.length ? ${input} : ${this.use("Arrays")}.copyOf(${input}, ${d}.consumed())`;
    c.line(`${this.use("Codecs")}.remember(${t}, ${key}, ${enc}, ${d}.output());`);
    return t;
  }

  /** An `align`/`alignEnd` read: from the base, or from the byte space and/or with an offset. */
  alignRead(
    l: Extract<IrLayer, { kind: "align" | "alignEnd" }>,
    ctx: RCtx,
    strict: string
  ): string {
    const r = ctx.r;
    const fill = this.fill(l.fill, ctx);
    if (l.from !== "file" && !l.offset) {
      return `${r}.align(${this.num(l.to, ctx)}, ${fill}, ${strict});`;
    }
    const off = l.offset ? this.num(l.offset, ctx) : "0L";
    return `${r}.alignAt(${this.num(l.to, ctx)}, ${l.from === "file"}, ${off}, ${fill}, ${strict});`;
  }

  /** The empty value of an array, bytes or string type (for `@nullable(empty)`). */
  emptyValue(t: IrType): string {
    const u = unlayer(t);
    if (u.kind === "bytes") return "new byte[0]";
    if (u.kind === "string") return '""';
    return `new ${this.use("ArrayList")}<${this.model.javaType(u.kind === "array" ? u.element : u, true)}>()`;
  }
}

/** Code extracting `width` bits at `shift` from the long `u`. */
function extractBits(u: string, shift: number, width: number): string {
  if (width >= 64) return u;
  const mask = longLit((1n << BigInt(width)) - 1n);
  if (shift === 0) return `(${u} & ${mask})`;
  if (shift + width === 64) return `(${u} >>> ${shift})`;
  return `((${u} >>> ${shift}) & ${mask})`;
}
