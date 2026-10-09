/**
 * View scans: the parts of `scan_X` that differ from `read_X`. A scan reads the cheap and needed
 * fields of a struct; the rest (targets, codec regions, struct contents, byte arrays, streams) get
 * a lazy closure that reads the field on access, while the scan only moves past them and records
 * where their struct values are ("kids", with their type arguments and identity key) so child
 * views need no reads. Byte arrays also get a byte store, read on demand.
 */
import type { IrField, IrLayer, IrStreamExpr, IrType } from "../../ir/index.ts";
import { hasOrigin, lazyType, stripLayers, usesPosition, viaKidLayer } from "./analysis.ts";
import { str } from "./code.ts";
import { streamElement, type RCtx, type ReadEmitter } from "./read.ts";

type StructType = Extract<IrType, { kind: "struct" }>;
type ArrayType = Extract<IrType, { kind: "array" }>;
type Via = Extract<IrLayer, { kind: "via" }>;

export class ScanEmitter {
  private readonly r: ReadEmitter;

  constructor(reader: ReadEmitter) {
    this.r = reader;
  }

  /** A field in a view scan. */
  field(f: IrField, ctx: RCtx): void {
    const rd = this.r;
    const c = rd.code;
    const r = ctx.r;
    c.line(`fr.field = ${str(f.name)};`);
    const fi = rd.fieldIndex(ctx.s, f.name);
    const fs = `ns.fields[${fi}]`;
    const needed = rd.st.needed.has(f.name) || f.checks.length > 0 || hasOrigin(f.type);
    const lazy = !needed && (f.placement !== undefined || f.from !== undefined || lazyType(f.type));
    const fctx: RCtx = {
      ...ctx,
      slot: `${ctx.s.id}.${f.name}`,
      field: f.name,
      fieldIndex: fi,
      scanMode: lazy ? "kids" : "record"
    };
    const ext = rd.st.needExtent.has(f.name) ? rd.extent(f.name) : undefined;
    let start = `${r}.pos`;
    if ((f.checks.length > 0 || ext) && !f.placement && !f.from) {
      start = c.fresh("s");
      c.line(`const std::int64_t ${start} = ${r}.pos;`);
      if (ext) c.line(`${ext.start} = ${start};`);
    }
    c.line(`${fs}.start = ${r}.pos;`);
    const dst = rd.dest(f.name, ctx);
    if (f.placement) {
      const { o, addr } = rd.placementAddress(f, ctx);
      if (ext) c.line(`${ext.start} = ${addr};`);
      start = addr;
      const emptyNull = f.placement.emptyIsNull === true;
      c.line(`${fs}.target = ${emptyNull ? `${o} == 0 ? -1 : ` : ""}${addr};`);
      const readTarget = (to: string, x: RCtx): void =>
        rd.withEmptyNull(f, o, to, () => rd.emitTarget(f.type, to, addr, x, false));
      if (lazy) {
        this.lazyClosure(f, fi, ctx, x => readTarget("dst_", x));
        this.targetKids(f.type, addr, emptyNull ? `if (${o} != 0)` : "", fctx);
      } else readTarget(dst, fctx);
      if (ext) {
        const size = rd.model.staticSize(f.type);
        c.line(
          `${ext.end} = ${size !== undefined ? `${addr} + ${size}` : `${r}.last_target_end`};`
        );
      }
    } else if (f.from) {
      this.from(f, fi, ctx, fctx, lazy, dst);
    } else {
      const s0 = c.fresh("s0");
      c.line(`[[maybe_unused]] const std::int64_t ${s0} = ${r}.pos;`);
      const raw = rd.rawDst(f, ctx);
      if (lazy) this.lazyClosure(f, fi, ctx, x => rd.read(f.type, "dst_", { ...x, rawDst: raw }));
      rd.read(f.type, dst, {
        ...fctx,
        rawDst: raw,
        deferPointer: stripLayers(f.type).kind === "pointer"
      });
      if (ext) c.line(`${ext.end} = ${r}.pos;`);
      this.fieldStore(f, fi, ctx, s0, lazy, dst);
    }
    c.line(`${fs}.end = ${r}.pos;`);
    if (!lazy) rd.emitChecks(f.checks, f.type, dst, start, ctx);
  }

  /** The struct values of a lazy `at` field's target at `addr`, for child views. */
  private targetKids(t: IrType, addr: string, guard: string, ctx: RCtx): void {
    const rd = this.r;
    const x = stripLayers(t);
    if (x.kind !== "struct" && !(x.kind === "array" && lazyType(x.element))) return;
    rd.code.block(guard, () => {
      if (x.kind === "struct") this.pushKid(x, this.loc(addr, "-1", ctx), ctx);
      else this.peekKids(x, addr, ctx);
    });
  }

  /** Scans an array of targets at `addr` into a throwaway value, recording its kids. */
  private peekKids(t: ArrayType, addr: string, ctx: RCtx): void {
    const rd = this.r;
    const dummy = rd.code.fresh("kd");
    rd.code.line(`${rd.types.type(t)} ${dummy};`);
    rd.peekAt(addr, ctx, () => rd.read(t, dummy, { ...ctx, depth: 0 }));
  }

  /** `yaffle::Loc` of a struct at `addr` in the space being scanned. */
  private loc(addr: string, index: string, ctx: RCtx): string {
    const r = ctx.r;
    return `yaffle::Loc{sc.space, ${addr}, ${r}.base, ${r}.raw_end(), ${index}, ${r}.strict}`;
  }

  /**
   * `T x from stream`: the stream is a byte space of the document (a PieceStore for
   * `arr[*].piece`, the source field's store, a slice of either), created when first read. A
   * struct-typed field gets a child view at the start of that space.
   */
  private from(f: IrField, fi: number, ctx: RCtx, fctx: RCtx, lazy: boolean, dst: string): void {
    const rd = this.r;
    const c = rd.code;
    const r = ctx.r;
    const s0 = c.fresh("s0");
    c.line(`const std::int64_t ${s0} = ${r}.pos;`);
    const build = this.streamStore(f.from!.stream, ctx);
    const sp = this.space(ctx, f, s0, "=, ", build("ns_", "d_"));
    if (stripLayers(f.type).kind === "bytes")
      c.line(
        `ns.fields[${fi}].store = [${sp}](yaffle::Doc& d_) -> yaffle::StorePtr { return d_.store(${sp}); };`
      );
    const loc = `yaffle::Loc{${sp}, 0, 0, yaffle::kUnknownEnd, -1, ${r}.strict}`;
    if (lazy) {
      this.lazyClosure(
        f,
        fi,
        ctx,
        x => rd.read(f.type, "dst_", { ...x, scanMode: undefined }),
        loc
      );
    } else {
      // Read now (later expressions use it); the scan builds the stream from what it has read.
      c.line(`sc.doc->prime(${sp}, ${build("ns", "(*sc.doc)")});`);
      c.block("", () => {
        const sr = c.fresh("sr");
        c.line(`yaffle::Reader ${sr} = sc.doc->reader(${loc});`);
        rd.read(f.type, dst, { ...fctx, r: sr, scanMode: undefined });
      });
    }
    const t = f.type;
    if (t.kind === "struct" && rd.model.struct(t.struct).layers.length === 0)
      this.pushKid(t, loc, fctx);
  }

  /**
   * Registers a byte space of the document whose store, built on first use from the struct's
   * scan (`ns_`, `d_`), is `store`; returns the local holding its id.
   */
  private space(ctx: RCtx, f: IrField, s0: string, capture: string, store: string): string {
    const c = this.r.code;
    const S = this.r.model.structName(ctx.s.id);
    const sp = c.fresh("sp");
    const key = `std::to_string(sc.space) + ":" + std::to_string(${s0}) + ${str(`:${ctx.s.id}.${f.name}`)}`;
    c.line(
      `const int ${sp} = sc.doc->space(${key}, ${ctx.r}.outer >= 0 ? ${ctx.r}.outer : ${s0}, [${capture}self_ = yaffle::self_of(sc)](yaffle::Doc& d_) -> yaffle::StorePtr { auto& ns_ = d_.scan<${S}>(self_, ${str(ctx.s.id)}, scan_entry_${S}); return ${store}; });`
    );
    return sp;
  }

  /**
   * The store of a stream expression, as C++ code over a scan (`ns`) and a document (`d`).
   * Slice bounds are evaluated now into locals (they use earlier fields).
   */
  private streamStore(st: IrStreamExpr, ctx: RCtx): (ns: string, d: string) => string {
    const rd = this.r;
    const c = rd.code;
    switch (st.kind) {
      case "field": {
        const fi = rd.fieldIndex(ctx.s, st.field);
        return (ns, d) => `yaffle::field_store(${d}, ${ns}.fields[${fi}], ${str(st.field)})`;
      }
      case "each": {
        const fa = rd.fieldIndex(ctx.s, st.array);
        const es = streamElement(rd.model, ctx.s, st.array);
        const E = rd.model.structName(es);
        const pf = rd.fieldIndex(rd.model.struct(es), st.field);
        return (ns, d) =>
          `yaffle::piece_store<${E}>(${d}, ${ns}.fields[${fa}].kids, ${str(es)}, scan_entry_${E}, ${pf}, ${str(st.array)}, ${str(st.field)})`;
      }
      case "slice": {
        const inner = this.streamStore(st.stream, ctx);
        const a = c.fresh("sla");
        c.line(`const yaffle::i128 ${a} = ${rd.int(st.start, ctx)};`);
        let b = "std::nullopt";
        if (st.end) {
          const e = c.fresh("slb");
          c.line(`const yaffle::i128 ${e} = ${rd.int(st.end, ctx)};`);
          b = `std::optional<yaffle::i128>(${e})`;
        }
        return (ns, d) => `yaffle::slice_store(${inner(ns, d)}, ${a}, ${b})`;
      }
    }
  }

  /**
   * After a bytes field (or a struct through a codec): its known length and its value as a byte
   * store, read on demand: a slice of the space for plain bytes, a RangedStore for a `@ranged`
   * codec region, the value decoded whole otherwise. A struct through one codec gets a child view
   * in the decoded space.
   */
  private fieldStore(
    f: IrField,
    fi: number,
    ctx: RCtx,
    s0: string,
    lazy: boolean,
    dst: string
  ): void {
    const rd = this.r;
    const c = rd.code;
    const r = ctx.r;
    const fs = `ns.fields[${fi}]`;
    const t = f.type;
    const x = stripLayers(t);
    const layers = t.kind === "layered" ? t.layers : [];
    if (x.kind === "struct") {
      const v = viaKidLayer(rd.model, t);
      if (v === undefined || !lazy) return;
      const via = layers[v] as Via;
      const codec = rd.model.codec(via.codec);
      const inner = v > 0 ? (layers[v - 1] as Extract<IrLayer, { kind: "size" }>) : undefined;
      const cc = this.codecCtx(via, ctx, inner ? rd.len(inner.size, ctx) : undefined);
      const ranged = codec.ranged && !codec.async && !inner;
      this.codecStore(fs, ranged ? "ranged_store" : "decoded_store", via, cc, s0, ctx);
      const sp = this.space(
        ctx,
        f,
        s0,
        "",
        `yaffle::field_store(d_, ns_.fields[${fi}], ${str(f.name)})`
      );
      const end = inner ? rd.len(inner.size, ctx) : "yaffle::kUnknownEnd";
      this.pushKid(x, `yaffle::Loc{${sp}, 0, 0, ${end}, -1, ${r}.strict}`, {
        ...ctx,
        fieldIndex: fi
      });
      return;
    }
    if (x.kind !== "bytes") return;
    if (!lazy) {
      c.line(
        `${fs}.store = [b_ = std::make_shared<const yaffle::Bytes>(${dst})](yaffle::Doc&) -> yaffle::StorePtr { return std::make_shared<yaffle::MemStore>(b_); };`
      );
      c.line(`${fs}.length = static_cast<std::int64_t>(${dst}.size());`);
      return;
    }
    // The value's length, when the scan knows it without reading the value.
    let len: string | undefined;
    if (x.length.kind === "count" && !usesPosition(x.length.expr)) len = rd.len(x.length.expr, ctx);
    else if (layers[0]?.kind === "size" && !usesPosition(layers[0].size))
      len = rd.len(layers[0].size, ctx);
    else if (!layers.length) len = `(${r}.pos - ${s0})`;
    if (len) c.line(`${fs}.length = ${len};`);
    if (!layers.length) {
      c.line(
        `${fs}.store = [sp_ = sc.space, a_ = ${s0}, n_ = ${r}.pos - ${s0}](yaffle::Doc& d_) -> yaffle::StorePtr { return std::make_shared<yaffle::SliceStore>(d_.store(sp_), a_, n_); };`
      );
      return;
    }
    const v0 = layers[0];
    if (
      v0?.kind === "via" &&
      layers.slice(1).every(l => l.kind === "size") &&
      rd.model.codec(v0.codec).ranged &&
      !rd.model.codec(v0.codec).async &&
      !rd.model.codec(v0.codec).streaming &&
      x.length.kind === "rest"
    ) {
      this.codecStore(fs, "ranged_store", v0, this.codecCtx(v0, ctx, undefined), s0, ctx);
      c.line(`${fs}.length = ${r}.pos - ${s0};`);
      return;
    }
    // Anything else: the value, read (decoded) whole on first use.
    c.line(
      `${fs}.store = [lz_ = ${fs}.lazy](yaffle::Doc&) -> yaffle::StorePtr { return std::make_shared<yaffle::LazyStore>([lz_]() -> std::shared_ptr<const yaffle::Bytes> { auto b_ = std::make_shared<yaffle::Bytes>(); lz_(b_.get()); return b_; }); };`
    );
  }

  /** `fs.store`: the codec region [s0, pos) of the space, through `ranged_store`/`decoded_store`. */
  private codecStore(fs: string, fn: string, via: Via, cc: string, s0: string, ctx: RCtx): void {
    const r = ctx.r;
    const codec = this.r.model.codec(via.codec);
    this.r.code.line(
      `${fs}.store = [sp_ = sc.space, a_ = ${s0}, n_ = ${r}.pos - ${s0}, cc_ = ${cc}, at_ = ${r}.at(${s0})](yaffle::Doc& d_) -> yaffle::StorePtr { return yaffle::${fn}(d_.store(sp_), a_, n_, ${this.r.names.extern(via.codec)}, ${str(codec.name)}, cc_, at_); };`
    );
  }

  /** A codec context with the layer's arguments (evaluated now), as a local; returns its name. */
  private codecCtx(l: Via, ctx: RCtx, outputSize: string | undefined): string {
    const rd = this.r;
    const cc = rd.code.fresh("cc");
    const args = rd.args(rd.model.codec(l.codec).params, l.args, ctx);
    rd.codecCtx(
      cc,
      args,
      outputSize !== undefined ? `static_cast<std::size_t>(${outputSize})` : undefined
    );
    return cc;
  }

  /** Records the location and arguments of a struct value of the field being scanned. */
  pushKid(t: StructType, loc: string, ctx: RCtx): void {
    const rd = this.r;
    const name = rd.model.structName(t.struct);
    const args = rd.structArgs(t.struct, t.args, ctx);
    rd.code.line(
      `ns.fields[${ctx.fieldIndex}].kids.push_back(yaffle::Kid{${loc}, std::make_shared<const ${name}_Args>(${name}_Args{${args.join(", ")}}), ${rd.targetKey(t, ctx)}});`
    );
  }

  /** The kid of a null pointer (`loc.pos < 0`). */
  nullKid(ctx: RCtx): void {
    this.r.code.line(
      `ns.fields[${ctx.fieldIndex}].kids.push_back(yaffle::Kid{yaffle::Loc{0, -1, 0, 0, -1, false}, nullptr, {}});`
    );
  }

  /** A shallow scan of a struct value only moves past it (its kid was just pushed). */
  skipStruct(name: string, args: string[], ctx: RCtx): void {
    const c = this.r.code;
    const tmp = c.fresh("ks");
    c.block("", () => {
      c.line(`yaffle::NodeScan<${name}> ${tmp};`);
      c.line(
        `yaffle::ScanCtx ${tmp}c{sc.doc, sc.space, &ns.fields[${ctx.fieldIndex}].kids.back()};`
      );
      c.line(`scan_${name}(${[ctx.r, `${tmp}c`, tmp, ...args].join(", ")});`);
    });
  }

  /**
   * A pointer target at `addr` in a scan: records its address and, for struct targets, its kid.
   * Returns whether the target is read now (not in a shallow scan).
   */
  pointerTarget(t: Extract<IrType, { kind: "pointer" }>, addr: string, ctx: RCtx): boolean {
    const tx = stripLayers(t.target);
    if (ctx.depth === 0) this.r.code.line(`ns.fields[${ctx.fieldIndex}].target = ${addr};`);
    if (tx.kind === "struct") this.pushKid(tx, this.loc(addr, "-1", ctx), ctx);
    if (ctx.scanMode !== "kids") return true;
    if (tx.kind === "array" && lazyType(tx.element)) this.peekKids(tx, addr, ctx);
    return false;
  }

  /** Elements of `T x[n] at f($index)` are scanned when accessed in shallow scans. */
  lazyKids(t: ArrayType, ctx: RCtx): boolean {
    const el = t.element;
    return (
      ctx.scanMode === "kids" &&
      ctx.fieldIndex !== undefined &&
      el.kind === "struct" &&
      this.r.model.struct(el.struct).layers.length === 0
    );
  }

  /**
   * Element `i` of a placed array, scanned when it is accessed (outside `@base` regions, whose
   * extent needs every element).
   */
  lazyElement(t: ArrayType, addr: string, i: string, ctx: RCtx, read: () => void): void {
    this.r.code.chain([
      [
        `if (${ctx.r}.bases == 0)`,
        () => this.pushKid(stripLayers(t.element) as StructType, this.loc(addr, i, ctx), ctx)
      ],
      ["else", read]
    ]);
  }

  /** Counted arrays of static-size structs in shallow scans: elements located by arithmetic. */
  staticKids(t: ArrayType, ctx: RCtx): boolean {
    const m = this.r.model;
    return (
      t.length.kind === "count" &&
      ctx.scanMode === "kids" &&
      ctx.fieldIndex !== undefined &&
      t.element.kind === "struct" &&
      m.struct(t.element.struct).layers.length === 0 &&
      (m.staticSize(t.element) ?? 0) > 0
    );
  }

  /**
   * Elements located by arithmetic and read when accessed (they check their own bounds then, so
   * errors name the element as parse would).
   */
  staticArray(t: ArrayType, a: string, i: string, ctx: RCtx, ectx: RCtx): void {
    const rd = this.r;
    const c = rd.code;
    const r = ctx.r;
    if (t.length.kind !== "count") throw new Error("staticArray needs a counted array");
    const n = c.fresh("n");
    const es = rd.model.staticSize(t.element)!;
    const p0 = c.fresh("p");
    c.line(`const std::int64_t ${n} = ${rd.count(t.length.expr, ctx, es)};`);
    c.line(`const std::int64_t ${p0} = ${r}.pos;`);
    c.block(`for (std::int64_t ${i} = 0; ${i} < ${n}; ${i}++)`, () => {
      c.line(`${a}.emplace_back();`);
      this.pushKid(t.element as StructType, this.loc(`${p0} + ${i} * ${es}`, i, ectx), ectx);
    });
    c.line(`${r}.pos = ${p0} + ${n} * ${es};`);
  }

  /** The lazy closure of a scanned field: reads it from where it starts. */
  private lazyClosure(
    f: IrField,
    fi: number,
    ctx: RCtx,
    body: (ctx: RCtx) => void,
    loc?: string
  ): void {
    const rd = this.r;
    const c = rd.code;
    const T = rd.types.type(f.type);
    const lz = c.fresh("lz");
    const S = rd.model.structName(ctx.s.id);
    c.line(`const yaffle::Loc ${lz} = ${loc ?? `sc.loc(${ctx.r})`};`);
    c.line(`ns.fields[${fi}].loaded = false;`);
    c.line(`ns.fields[${fi}].lazy = [=, doc_ = sc.doc](void* out_) {`);
    c.indent(() => {
      c.line(`yaffle::Reader r2 = doc_->reader(${lz});`);
      c.line(`yaffle::Frame fr;`);
      c.line(`fr.field = ${str(f.name)};`);
      c.line(`[[maybe_unused]] ${S}& v = *vp_;`);
      c.line(`auto& dst_ = *static_cast<${T}*>(out_);`);
      c.rethrow(
        () =>
          body({
            ...ctx,
            r: "r2",
            scan: false,
            scanMode: undefined,
            fieldIndex: undefined,
            deferPointer: false,
            slot: `${ctx.s.id}.${f.name}`,
            field: f.name
          }),
        "e.prefix(fr);"
      );
    });
    c.line(`};`);
  }
}
