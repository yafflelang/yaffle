/**
 * Reader emitter: one `read_X(yaffle::Reader&, X&, params…)` function per struct, filling a value
 * in place (docs/IR.md §2). Every type is read "into" a destination lvalue. View scans (`scan_X`)
 * are emitted by the same code in scan mode, with the scan-specific parts in scan.ts.
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
  elementUsesIndex,
  extentFields,
  isOneWay,
  literalInt,
  neededFields,
  primSize,
  strip,
  stripLayers,
  valueTypeOf
} from "./analysis.ts";
import { Code, intLit, str } from "./code.ts";
import { Emitter, sizeInside, type EmitCtx } from "./emitter.ts";
import type { ExprCompiler, ExprCtx } from "./expr.ts";
import type { Model } from "./model.ts";
import type { Names } from "./names.ts";
import { ScanEmitter } from "./scan.ts";
import { primCppType, type TypeMapper } from "./types.ts";

export interface RCtx extends EmitCtx {
  /** Reader variable. */
  r: string;
  /** Current field (for deferred pointer follows). */
  field?: string | undefined;
  /** Destination of a one-way transform's raw value (field level). */
  rawDst?: string | undefined;
  /** Field-level pointers with `@origin` are followed after the members (deferred). */
  deferPointer?: boolean | undefined;
  /** Strict expression override. */
  strict?: string | undefined;
  /** Emitting a view scan (`scan_X`). */
  scan?: boolean | undefined;
  /**
   * Scan mode of the value being read: "kids" skips what views read lazily (struct contents,
   * pointer targets, codec regions, byte arrays) and records struct locations; "record" reads
   * normally but records struct locations too.
   */
  scanMode?: "kids" | "record" | undefined;
  /** Index of the field being scanned (its FieldScan). */
  fieldIndex?: number | undefined;
}

interface StructState {
  /** Start/end variables of fields whose extent read-side expressions use. */
  extents: Map<string, { start: string; end: string }>;
  needExtent: Set<string>;
  /** Some pointer is followed after the members (`deferred_`). */
  deferred: boolean;
  /** Scan mode: fields later read-side expressions use (always read in full). */
  needed: Set<string>;
}

export class ReadEmitter extends Emitter<RCtx> {
  st!: StructState;
  readonly scanner: ScanEmitter;

  constructor(model: Model, x: ExprCompiler, types: TypeMapper, names: Names) {
    super(model, x, types, names);
    this.scanner = new ScanEmitter(this);
  }

  private reset(needExtent = new Set<string>(), needed = new Set<string>()): void {
    this.st = { extents: new Map(), needExtent, deferred: false, needed };
  }

  prototype(s: IrStruct): string {
    const name = this.model.structName(s.id);
    return `static void read_${name}(yaffle::Reader& r, ${name}& v${this.params(s)})`;
  }

  scanPrototype(s: IrStruct): string {
    const name = this.model.structName(s.id);
    return `static void scan_${name}(yaffle::Reader& r, [[maybe_unused]] yaffle::ScanCtx& sc, yaffle::NodeScan<${name}>& ns${this.params(s)})`;
  }

  /** Index of a field in the struct's FieldScan table (declaration order of distinct names). */
  fieldIndex(s: IrStruct, name: string): number {
    return this.model.uniqueFields(s).findIndex(f => f.name === name);
  }

  /** `read_X`, or with `scan` the view scan `scan_X`. */
  emitStruct(out: Code, s: IrStruct, scan = false): void {
    this.reset(extentFields(s, false), scan ? neededFields(s) : undefined);
    const body = out.child();
    this.code = body;
    const ctx: RCtx = {
      s,
      r: "r",
      endian: "endian",
      le: "le",
      index: "index",
      depth: 0,
      slot: s.id,
      meta: !scan && this.model.usesMeta(s) ? "v.yaffle_meta_" : undefined,
      strict: s.strict ? "true" : undefined,
      scan
    };
    this.emitMembers(s.members, ctx);
    // A base's `@alignEnd` pads its whole region, targets included.
    const tail = body.child();
    const ends = s.base ? s.layers.filter(isAlignEnd) : [];
    if (ends.length) {
      this.code = tail;
      tail.line(`fr.field = "";`);
      tail.line(`r.pos = std::max(r.pos, r.max_end);`);
      for (const l of ends)
        tail.line(
          `${this.alignCall(l, ctx)}, ${this.fill(l.fill, ctx)}, ${l.strict ? "true" : this.strictCode(ctx)});`
        );
      this.code = body;
    }
    out.block(scan ? this.scanPrototype(s) : this.prototype(s), () => {
      if (scan) {
        const n = this.model.structName(s.id);
        out.line(`[[maybe_unused]] ${n}& v = ns.v;`);
        out.line(`[[maybe_unused]] ${n}* const vp_ = &ns.v;`);
        out.line(`ns.fields.resize(${this.model.uniqueFields(s).length});`);
      }
      out.line(`[[maybe_unused]] const bool le = endian == yaffle::Endian::le;`);
      out.line(`[[maybe_unused]] const std::int64_t index = r.index;`);
      for (const [n, e] of this.st.extents) {
        if (n === "this") out.line(`[[maybe_unused]] const std::int64_t ${e.start} = r.pos;`);
        else out.line(`[[maybe_unused]] std::int64_t ${e.start} = -1, ${e.end} = -1;`);
      }
      if (this.st.deferred) out.line(`std::vector<std::function<void()>> deferred_;`);
      out.line(`yaffle::Frame fr;`);
      if (s.base) {
        out.line(`[[maybe_unused]] const std::int64_t base_start_ = r.pos;`);
        out.line(`[[maybe_unused]] std::int64_t inline_end_ = r.pos;`);
        out.line(`yaffle::BaseScope base_(r);`);
      }
      out.rethrow(() => {
        out.append(body);
        if (this.st.deferred) out.line(`for (auto& d : deferred_) d();`);
        if (s.base) out.line(`inline_end_ = r.pos;`);
        out.append(tail);
      }, "e.prefix(fr);");
      if (s.base) {
        out.line(`base_.finish();`);
        // Where the base was (sticky layout of view commits).
        if (!scan)
          out.line(`r.note_base(&v, base_start_, inline_end_ - base_start_, r.pos - base_start_);`);
      }
    });
  }

  private rootCtx(s: IrStruct): RCtx {
    return { s, r: "r", endian: "endian", le: "le", index: "-1", depth: 0, slot: s.id };
  }

  /** Emits the read of a root struct into `dst` (root parameters are locals). */
  rootRead(out: Code, s: IrStruct, dst: string): void {
    this.reset();
    this.code = out;
    this.read(rootType(s), dst, this.rootCtx(s));
  }

  /** The identity key of a root struct value (root parameters are locals), for views. */
  rootKey(s: IrStruct): string {
    this.reset();
    return this.targetKey(rootType(s), this.rootCtx(s));
  }

  /** `r.align(to` or, with an origin or offset, `r.align_at(to, origin, offset`. */
  alignCall(l: Extract<IrLayer, { kind: "align" | "alignEnd" }>, ctx: RCtx): string {
    const r = ctx.r;
    if (l.from !== "file" && !l.offset) return `${r}.align(${this.int(l.to, ctx)}`;
    const origin = l.from === "file" ? "0" : `${r}.base`;
    const offset = l.offset ? this.int(l.offset, ctx) : "0";
    return `${r}.align_at(${this.int(l.to, ctx)}, ${origin}, ${offset}`;
  }

  // ── expression context ────────────────────────────────────────────────────

  exprCtx(ctx: RCtx): ExprCtx {
    const r = ctx.r;
    const span = (f: string): string => {
      const e = this.extent(f);
      return `(${e.end} - ${e.start})`;
    };
    const bytes = (f: string): string => {
      const e = this.extent(f);
      return `yaffle::to_bytes(${r}.peek_bytes(${e.start}, ${e.end}))`;
    };
    return {
      ...this.baseExprCtx(ctx),
      field: (name, type) => this.x.typed(this.fieldValue(ctx.s, name), type),
      builtin: name => {
        if (name === "offset") return `(${r}.pos - ${r}.base)`;
        if (name === "end") return `(${r}.end() - ${r}.base)`;
        return ctx.index;
      },
      sizeof: span,
      offsetof: f => `(${this.extent(f).start} - ${r}.base)`,
      encodedSize: span,
      bytesof: bytes,
      encode: bytes
    };
  }

  /** The start/end variables of a field's extent (registered on first use). */
  extent(f: string): { start: string; end: string } {
    let e = this.st.extents.get(f);
    if (!e) {
      const n = f === "this" ? "this" : f.replace(/[^A-Za-z0-9_]/g, "_");
      e = { start: `s_${n}_`, end: `e_${n}_` };
      this.st.extents.set(f, e);
    }
    return e;
  }

  /** A count read from the data: EOF if the region cannot hold that many units. */
  count(e: IrExpr, ctx: RCtx, unit: number): string {
    const lit = literalInt(e);
    if (lit !== undefined && lit >= 0) return `INT64_C(${lit})`;
    return `${ctx.r}.count(${this.int(e, ctx)}, ${unit})`;
  }

  strictCode(ctx: RCtx): string {
    return ctx.strict ?? `${ctx.r}.strict`;
  }

  // ── members ───────────────────────────────────────────────────────────────

  emitMembers(ms: readonly IrMember[], ctx: RCtx): void {
    for (const m of ms) {
      switch (m.kind) {
        case "field":
          this.emitField(m, ctx);
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
                inner => this.emitMembers(m.members, inner),
                `${ctx.slot}.block`
              ),
            els => this.emitMembers(els, ctx)
          );
          break;
        case "switch":
          this.emitSwitch(
            m,
            ctx,
            ms => this.emitMembers(ms, ctx),
            `${ctx.r}.fail(yaffle::ErrorCode::Check, "no case matches");`
          );
          break;
      }
    }
  }

  /** The destination lvalue of a field (emplacing optional members first). */
  dest(name: string, ctx: RCtx): string {
    const m = `v.${this.model.member(name)}`;
    if (this.model.isOptionalMember(ctx.s, name)) {
      this.code.line(`${m}.emplace();`);
      return `(*${m})`;
    }
    return m;
  }

  /** `virtual u40 size = …`: no bytes; the value is computed where it is declared. */
  private emitVirtual(f: IrField, ctx: RCtx): void {
    const c = this.code;
    c.line(`fr.field = ${str(f.name)};`);
    if (ctx.scan) {
      const fi = this.fieldIndex(ctx.s, f.name);
      c.line(`ns.fields[${fi}].start = ns.fields[${fi}].end = ${ctx.r}.pos;`);
    }
    const dst = this.dest(f.name, ctx);
    const v = this.expr(f.virtual!.read, ctx);
    c.line(`${dst} = ${this.x.to(v, valueTypeOf(this.model, f.type))};`);
    this.emitChecks(f.checks, f.type, dst, `${ctx.r}.pos`, ctx);
  }

  emitField(f: IrField, ctx: RCtx): void {
    if (f.virtual) {
      this.emitVirtual(f, ctx);
      return;
    }
    if (ctx.scan) {
      this.scanner.field(f, ctx);
      return;
    }
    const c = this.code;
    c.line(`fr.field = ${str(f.name)};`);
    const fctx: RCtx = { ...ctx, slot: `${ctx.s.id}.${f.name}`, field: f.name };
    const ext = this.st.needExtent.has(f.name) ? this.extent(f.name) : undefined;
    let start = `${ctx.r}.pos`;
    if ((f.checks.length > 0 || ext) && !f.placement && !f.from) {
      if (ext) {
        c.line(`${ext.start} = ${ctx.r}.pos;`);
        start = ext.start;
      } else {
        start = c.fresh("s");
        c.line(`const std::int64_t ${start} = ${ctx.r}.pos;`);
      }
    }
    const dst = this.dest(f.name, ctx);
    if (f.placement) {
      const { o, addr } = this.placementAddress(f, ctx);
      if (ext) c.line(`${ext.start} = ${addr};`);
      start = addr;
      this.withEmptyNull(f, o, dst, () => this.emitTarget(f.type, dst, addr, fctx, false));
      const size = this.model.staticSize(f.type);
      const targetEnd = size !== undefined ? `${addr} + ${size}` : `${ctx.r}.last_target_end`;
      if (ext) c.line(`${ext.end} = ${targetEnd};`);
      // Where the target was (sticky layout of view commits).
      if (ctx.r === "r")
        c.line(
          `if (r.origins) r.note_slot(&v, ${str(f.name)}, ${addr}, ${size !== undefined ? String(size) : `r.last_target_end - ${addr}`});`
        );
    } else if (f.from) {
      const stream = this.stream(f.from.stream, ctx);
      const sr = c.fresh("sr");
      c.line(
        `auto ${sr} = ${ctx.r}.sub(std::make_shared<const yaffle::Bytes>(${stream}), ${ctx.r}.pos);`
      );
      this.read(f.type, dst, { ...fctx, r: sr });
    } else {
      this.read(f.type, dst, {
        ...fctx,
        rawDst: this.rawDst(f, ctx),
        deferPointer: stripLayers(f.type).kind === "pointer"
      });
      if (ext) c.line(`${ext.end} = ${ctx.r}.pos;`);
    }
    this.emitChecks(f.checks, f.type, dst, start, ctx);
  }

  /** `o` = an `at` field's offset, `addr` = its absolute address (locals). */
  placementAddress(f: IrField, ctx: RCtx): { o: string; addr: string } {
    const c = this.code;
    const off = this.x.asOffset(this.expr(f.placement!.offset, ctx));
    const o = c.fresh("o");
    c.line(`const std::int64_t ${o} = ${off};`);
    const addr = c.fresh("at");
    c.line(`const std::int64_t ${addr} = ${ctx.r}.base + ${o};`);
    return { o, addr };
  }

  /** Runs `read`, or with `@nullable(empty)` placements sets `dst` empty for offset 0. */
  withEmptyNull(f: IrField, o: string, dst: string, read: () => void): void {
    if (!f.placement?.emptyIsNull) {
      read();
      return;
    }
    this.code.chain([
      [`if (${o} == 0)`, () => this.code.line(`${dst} = {};`)],
      ["else", read]
    ]);
  }

  /** Where a one-way transform field keeps its raw value. */
  rawDst(f: IrField, ctx: RCtx): string | undefined {
    return isOneWay(f.type) && f.output ? `v.${this.names.rawMember(ctx.s, f.name)}` : undefined;
  }

  emitChecks(
    checks: readonly { expr: IrExpr; message: string; strictOnly: boolean }[],
    t: IrType,
    value: string,
    start: string,
    ctx: RCtx
  ): void {
    for (const ch of checks) {
      const ictx: RCtx = { ...ctx, it: { code: value, type: valueTypeOf(this.model, t) } };
      const cond = this.expr(ch.expr, ictx).code;
      const guard = ch.strictOnly ? `${this.strictCode(ctx)} && ` : "";
      this.code.line(
        `if (${guard}!${parenthesized(cond)}) ${ctx.r}.check_fail(${str(ch.message)}, ${start});`
      );
    }
  }

  /** The joined bytes of a stream expression (parse; views use byte spaces instead). */
  private stream(s: IrStreamExpr, ctx: RCtx): string {
    switch (s.kind) {
      case "field":
        return `yaffle::Bytes(${this.fieldValue(ctx.s, s.field)})`;
      case "each": {
        const pf = this.pieceAccess(ctx.s, s.array, s.field);
        return `yaffle::join_pieces(${this.fieldValue(ctx.s, s.array)}, [](const auto& e_) -> const yaffle::Bytes& { return ${pf}; })`;
      }
      case "slice": {
        const inner = this.stream(s.stream, ctx);
        const a = this.int(s.start, ctx);
        const b = s.end ? this.int(s.end, ctx) : "std::nullopt";
        return `yaffle::slice_stream(${inner}, ${a}, ${b})`;
      }
    }
  }

  /** Access to the current value of a field of the struct being read. */
  private fieldValue(s: IrStruct, name: string): string {
    const m = `v.${this.model.member(name)}`;
    return this.model.isOptionalMember(s, name) ? `yaffle::obj(${m})` : m;
  }

  /** `e_.piece` for an element of `arr` (a bytes field of the element struct). */
  private pieceAccess(s: IrStruct, array: string, field: string): string {
    const es = this.model.struct(streamElement(this.model, s, array));
    const acc = `yaffle::obj(e_).${this.model.member(field)}`;
    return this.model.isOptionalMember(es, field) ? `yaffle::obj(${acc})` : acc;
  }

  // ── types ─────────────────────────────────────────────────────────────────

  /** Emits statements reading `t` into the lvalue `dst`. */
  read(t: IrType, dst: string, ctx: RCtx): void {
    const c = this.code;
    const r = ctx.r;
    switch (t.kind) {
      case "prim":
        c.line(`${dst} = ${this.prim(t.prim, this.leOf(t.endian, ctx), r)};`);
        return;
      case "bool":
        c.line(`${dst} = ${r}.boolean(${this.strictCode(ctx)});`);
        return;
      case "string": {
        const le = t.unit === 1 ? "true" : this.leOf(t.endian, ctx);
        const enc = `yaffle::Encoding::${t.encoding}`;
        if (t.length.kind === "count")
          c.line(
            `${dst} = ${r}.str(${this.count(t.length.expr, ctx, t.unit)}, ${t.unit}, ${enc}, ${le});`
          );
        else if (t.length.kind === "until")
          c.line(`${dst} = ${r}.str_until(${t.unit}, ${enc}, ${le});`);
        else c.line(`${dst} = ${r}.str_rest(${t.unit}, ${enc}, ${le});`);
        return;
      }
      case "bytes":
        if (ctx.scanMode === "kids" && t.length.kind !== "until") {
          // Views read byte arrays on access: skip them.
          if (t.length.kind === "count") {
            const n = c.fresh("n");
            c.line(`const std::int64_t ${n} = ${this.count(t.length.expr, ctx, 1)};`);
            c.line(`${r}.need(${n});`);
            c.line(`${r}.pos += ${n};`);
          } else c.line(`${r}.skip_to_end();`);
          return;
        }
        if (t.length.kind === "count")
          c.line(`${dst} = ${r}.bytes(${this.count(t.length.expr, ctx, 1)});`);
        else if (t.length.kind === "until")
          c.line(`${dst} = ${r}.bytes_until(${this.int(t.length.terminator, ctx)});`);
        else c.line(`${dst} = ${r}.bytes_rest();`);
        return;
      case "array":
        this.array(t, dst, ctx);
        return;
      case "struct":
        this.struct(t, dst, ctx);
        return;
      case "enum": {
        const en = this.model.enum(t.enum);
        const s = c.fresh("s");
        c.line(`[[maybe_unused]] const std::int64_t ${s} = ${r}.pos;`);
        const name = this.model.enumName(t.enum);
        c.line(
          `${dst} = static_cast<${name}>(${this.prim(en.storage, this.leOf(t.endian, ctx), r)});`
        );
        if (!en.open) this.enumCheck(name, dst, s, ctx);
        return;
      }
      case "pointer":
        this.pointer(t, dst, ctx);
        return;
      case "extern": {
        const xd = this.model.extern(t.extern);
        const args = this.args(xd.params, t.args, ctx);
        const fixed = xd.kind === "type" && xd.fixedSize !== undefined ? xd.fixedSize : -1;
        const vt = this.types.type(t);
        c.line(
          `${dst} = static_cast<${vt}>(${r}.extern_read(${this.names.extern(t.extern)}, ${fixed}${args.map(a => ", " + a).join("")}));`
        );
        return;
      }
      case "union":
        this.union(t, dst, ctx);
        return;
      case "transform": {
        const it = c.fresh("it");
        c.line(`${this.types.type(t.inner)} ${it}{};`);
        this.read(t.inner, it, {
          ...ctx,
          rawDst: undefined,
          deferPointer: false,
          scanMode: undefined
        });
        if (!t.write && ctx.rawDst) c.line(`${ctx.rawDst} = ${it};`);
        const ictx: RCtx = { ...ctx, it: { code: it, type: valueTypeOf(this.model, t.inner) } };
        c.line(`${dst} = ${this.x.to(this.expr(t.read, ictx), t.valueType)};`);
        return;
      }
      case "layered":
        this.emitLayers(t.layers, ctx, inner => this.read(t.inner, dst, inner), ctx.slot);
        return;
    }
  }

  private enumCheck(name: string, value: string, start: string, ctx: RCtx): void {
    this.code.line(
      `if (!valid_${name}(${value})) ${ctx.r}.fail_at(yaffle::ErrorCode::Check, "value is not a member of the enum", ${start});`
    );
  }

  /** Tries each variant in order; the first that reads wins, else a UNION error. */
  private union(t: Extract<IrType, { kind: "union" }>, dst: string, ctx: RCtx): void {
    const c = this.code;
    const r = ctx.r;
    const ut = this.types.type(t);
    const us = c.fresh("us");
    const ue = c.fresh("ue");
    const errs = c.fresh("uerr");
    const done = c.fresh("udone");
    c.line(`const std::int64_t ${us} = ${r}.pos;`);
    c.line(`const std::int64_t ${ue} = ${r}.raw_end();`);
    c.line(`std::vector<yaffle::Error> ${errs};`);
    c.line(`bool ${done} = false;`);
    t.variants.forEach((v, i) => {
      c.block(`if (!${done})`, () => {
        c.chain([
          [
            "try",
            () => {
              const tmp = c.fresh("u");
              c.line(`${ut} ${tmp}(std::in_place_index<${i}>);`);
              this.read(v.type, `std::get<${i}>(${tmp})`, {
                ...ctx,
                rawDst: undefined,
                deferPointer: false,
                scanMode: undefined
              });
              c.line(`${dst} = std::move(${tmp});`);
              c.line(`${done} = true;`);
            }
          ],
          [
            "catch (yaffle::Error& e)",
            () => {
              c.line(`e.prefix(${str(v.name)});`);
              c.line(`${errs}.push_back(std::move(e));`);
              c.line(`${r}.pos = ${us};`);
              c.line(`${r}.set_end(${ue});`);
            }
          ]
        ]);
      });
    });
    c.line(`if (!${done}) ${r}.union_fail(std::move(${errs}), ${us});`);
  }

  prim(p: string, le: string, r: string): string {
    switch (p) {
      case "u8":
      case "i8":
        return `${r}.${p}()`;
      case "u24":
        return `static_cast<std::uint32_t>(${r}.uN(3, ${le}))`;
      case "i24":
        return `static_cast<std::int32_t>(${r}.iN(3, ${le}))`;
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

  /** Reads a struct into an existing object `obj` (struct-level layers included). */
  structInto(t: Extract<IrType, { kind: "struct" }>, obj: string, ctx: RCtx): void {
    const s = this.model.struct(t.struct);
    const call = (inner: RCtx): void => {
      const args = this.structArgs(t.struct, t.args, inner);
      const name = this.model.structName(t.struct);
      if (inner.scanMode && inner.fieldIndex !== undefined) {
        this.scanner.pushKid(t, `sc.loc(${inner.r})`, inner);
        if (inner.scanMode === "kids") {
          this.scanner.skipStruct(name, args, inner);
          return;
        }
      }
      this.code.line(`read_${name}(${[inner.r, obj, ...args].join(", ")});`);
    };
    // A base's `@alignEnd` is applied inside its reader (relative to its own start).
    const layers = s.base ? s.layers.filter(l => l.kind !== "alignEnd") : s.layers;
    if (!layers.length) {
      call(ctx);
      return;
    }
    // Codec origins of struct-level layers are kept on the struct value itself.
    const lctx: RCtx = { ...ctx, meta: this.model.usesMeta(s) ? `${obj}.yaffle_meta_` : undefined };
    this.emitLayers(
      layers,
      lctx,
      inner => call({ ...inner, meta: ctx.meta }),
      `${ctx.slot}#${s.name}`
    );
  }

  private struct(t: Extract<IrType, { kind: "struct" }>, dst: string, ctx: RCtx): void {
    const c = this.code;
    const name = this.model.structName(t.struct);
    if (ctx.scanMode === "kids") this.structInto(t, "", ctx);
    else if (this.model.identityStructs.has(t.struct)) {
      // One object per (address, type), inline values included.
      c.line(`${dst} = ${ctx.r}.inline_obj<${name}>(${this.targetKey(t, ctx)}, [&](${name}& o_) {`);
      c.indent(() => this.structInto(t, "o_", ctx));
      c.line(`});`);
    } else if (this.model.isShared(t.struct)) {
      c.line(`${dst} = std::make_shared<${name}>();`);
      this.structInto(t, `(*${dst})`, ctx);
    } else this.structInto(t, dst, ctx);
  }

  /** Runs the statements of `read` at absolute `addr`, then restores the position. */
  peekAt(addr: string, ctx: RCtx, read: () => void): void {
    this.code.line(`${ctx.r}.peek_at(${addr}, [&]() {`);
    this.code.indent(read);
    this.code.line(`});`);
  }

  private array(t: Extract<IrType, { kind: "array" }>, dst: string, ctx: RCtx): void {
    const c = this.code;
    const r = ctx.r;
    const depth = ctx.depth;
    if (depth >= 16) throw new Error("arrays nested deeper than 16 levels are not supported");
    const a = c.fresh("a");
    const i = c.fresh("i");
    const elemT = this.types.type(t.element);
    const ectx: RCtx = {
      ...ctx,
      index: i,
      depth: depth + 1,
      rawDst: undefined,
      deferPointer: false
    };
    const setIndex = elementUsesIndex(this.model, t.element);
    c.line(`std::vector<${elemT}> ${a};`);
    if (setIndex) c.line(`yaffle::Restore<std::int64_t> ${c.fresh("rix")}(${r}.index);`);
    const head = (): void => {
      c.line(`fr.idx[${depth}] = ${i};`);
      if (setIndex) c.line(`${r}.index = ${i};`);
    };
    const pushRead = (): void => {
      c.line(`${a}.emplace_back();`);
      this.read(t.element, `${a}.back()`, ectx);
    };
    if (t.elementPlacement) this.placedArray(t, a, i, head, ctx, ectx);
    else if (this.scanner.staticKids(t, ctx)) this.scanner.staticArray(t, a, i, ctx, ectx);
    else if (t.length.kind === "count") {
      const n = c.fresh("n");
      const es = this.model.staticSize(t.element);
      c.line(`const std::int64_t ${n} = ${this.count(t.length.expr, ctx, es ?? 1)};`);
      c.line(`if (${n} <= ${r}.room()) ${a}.reserve(static_cast<std::size_t>(${n}));`);
      c.block(`for (std::int64_t ${i} = 0; ${i} < ${n}; ${i}++)`, () => {
        head();
        pushRead();
      });
    } else if (t.length.kind === "rest") {
      c.block(`for (std::int64_t ${i} = 0; ${r}.more(); ${i}++)`, () => {
        head();
        pushRead();
      });
    } else {
      const len = t.length;
      c.block(`for (std::int64_t ${i} = 0; ; ${i}++)`, () => {
        head();
        const p = c.fresh("p");
        c.line(`[[maybe_unused]] const std::int64_t ${p} = ${r}.pos;`);
        const el = c.fresh("el");
        c.line(`${elemT} ${el}{};`);
        this.read(t.element, el, ectx);
        this.terminated(len, t.element, el, a, p, ctx);
      });
    }
    c.line(`fr.idx[${depth}] = -1;`);
    c.line(`${dst} = std::move(${a});`);
  }

  /** `T x[n] at f($index)`: each element at its own offset. */
  private placedArray(
    t: Extract<IrType, { kind: "array" }>,
    a: string,
    i: string,
    head: () => void,
    ctx: RCtx,
    ectx: RCtx
  ): void {
    const c = this.code;
    const r = ctx.r;
    const elemT = this.types.type(t.element);
    const lazyKids = this.scanner.lazyKids(t, ctx);
    const body = (term?: IrLength): void => {
      head();
      const off = this.x.asOffset(this.expr(t.elementPlacement!, ectx));
      const addr = c.fresh("at");
      c.line(`const std::int64_t ${addr} = ${r}.base + ${off};`);
      if (t.length.kind === "rest") c.line(`if (${r}.past_end(${addr})) break;`);
      if (term) {
        const el = c.fresh("el");
        c.line(`${elemT} ${el}{};`);
        this.peekAt(addr, ctx, () => this.read(t.element, el, ectx));
        this.terminated(term, t.element, el, a, undefined, ctx);
        return;
      }
      c.line(`${a}.emplace_back();`);
      const read = (): void =>
        this.peekAt(addr, ctx, () => this.read(t.element, `${a}.back()`, ectx));
      if (lazyKids) this.scanner.lazyElement(t, addr, i, ectx, read);
      else read();
    };
    if (t.length.kind === "count") {
      const n = c.fresh("n");
      c.line(`const std::int64_t ${n} = ${this.len(t.length.expr, ctx)};`);
      c.block(`for (std::int64_t ${i} = 0; ${i} < ${n}; ${i}++)`, () => body());
    } else if (t.length.kind === "rest") {
      c.block(`for (std::int64_t ${i} = 0; ; ${i}++)`, () => body());
    } else {
      const len = t.length;
      c.block(`for (std::int64_t ${i} = 0; ; ${i}++)`, () => body(len));
    }
  }

  /**
   * After reading element `el` of a terminated array: `until v` drops the terminator, `before v`
   * also gives its bytes back, `until <predicate>` keeps the element that ends it.
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
    const vt = valueTypeOf(this.model, elem);
    if (len.kind === "untilPredicate") {
      c.line(`${a}.push_back(std::move(${el}));`);
      const cond = this.expr(len.predicate, { ...ctx, it: { code: `${a}.back()`, type: vt } }).code;
      c.line(`if (${cond}) break;`);
      return;
    }
    if (len.kind !== "until" && len.kind !== "before")
      throw new Error(`unexpected length ${len.kind}`);
    const eq = this.x.equality("==", this.x.typed(el, vt), this.expr(len.terminator, ctx));
    if (len.kind === "before" && pos)
      c.block(`if (${eq})`, () => c.line(`${ctx.r}.pos = ${pos};`).line("break;"));
    else c.line(`if (${eq}) break;`);
    c.line(`${a}.push_back(std::move(${el}));`);
  }

  /**
   * Reads a pointer or `at` target at absolute `addr` into `dst`. Struct targets (and, for
   * pointers, array and union targets) are shared objects with identity; the rest are values.
   */
  emitTarget(t: IrType, dst: string, addr: string, ctx: RCtx, sharedObj: boolean): void {
    const c = this.code;
    const r = ctx.r;
    const x = stripLayers(t);
    const tctx: RCtx = { ...ctx, rawDst: undefined, deferPointer: false };
    if (x.kind === "struct" || sharedObj) {
      const T = x.kind === "struct" ? this.model.structName(x.struct) : this.types.type(x);
      c.line(`${dst} = ${r}.target_obj<${T}>(${addr}, ${this.targetKey(t, ctx)}, [&](${T}& o_) {`);
      c.indent(() => {
        if (x.kind === "struct") this.structIntoLayered(t, "o_", tctx);
        else this.read(t, "o_", tctx);
      });
      c.line(`});`);
      return;
    }
    c.line(`${dst} = ${r}.target_value(${addr}, [&]() {`);
    c.indent(() => {
      c.line(`${this.types.type(t)} tv_{};`);
      this.read(t, "tv_", tctx);
      c.line(`return tv_;`);
    });
    c.line(`});`);
  }

  /** A (possibly layered) struct read into a pre-registered object. */
  private structIntoLayered(t: IrType, obj: string, ctx: RCtx): void {
    if (t.kind === "struct") this.structInto(t, obj, ctx);
    else if (t.kind === "layered")
      this.emitLayers(
        t.layers,
        ctx,
        inner => this.structIntoLayered(t.inner, obj, inner),
        ctx.slot
      );
    else throw new Error("unexpected layered target");
  }

  private pointer(t: Extract<IrType, { kind: "pointer" }>, dst: string, ctx: RCtx): void {
    const c = this.code;
    const r = ctx.r;
    const pa = c.fresh("pa");
    if (t.relative) c.line(`const std::int64_t ${pa} = ${r}.pos;`);
    const p = c.fresh("p");
    c.line(
      `const ${primCppType(t.storage)} ${p} = ${this.prim(t.storage, this.leOf(t.storageEndian, ctx), r)};`
    );
    const off =
      t.storage === "u64"
        ? `yaffle::offset(static_cast<yaffle::i128>(${p}), "pointer")`
        : `static_cast<std::int64_t>(${p})`;
    const origin = t.origin ? this.x.asOffset(this.expr(t.origin, ctx)) : undefined;
    const defer = origin !== undefined && ctx.deferPointer === true;
    const shared = this.types.sharedTarget(t.target);
    const tx = stripLayers(t.target);
    const emptyValue = (): string => {
      if (!t.emptyIsNull) return shared ? "nullptr" : "std::nullopt";
      return shared ? `std::make_shared<${this.types.type(tx)}>()` : "{}";
    };
    const follow = (): void => {
      const addr = c.fresh("at");
      const base = t.relative
        ? `${pa} + ${off}`
        : `${r}.base + ${origin !== undefined ? `${origin} + ` : ""}${off}`;
      c.line(`const std::int64_t ${addr} = ${base};`);
      if (ctx.scanMode && ctx.fieldIndex !== undefined) {
        if (!this.scanner.pointerTarget(t, addr, ctx)) return;
        this.emitTarget(t.target, dst, addr, { ...ctx, scanMode: undefined }, shared);
        return;
      }
      this.emitTarget(t.target, dst, addr, ctx, shared);
    };
    const body = (): void => {
      if (t.nullValue === undefined) {
        follow();
        return;
      }
      c.chain([
        [
          `if (static_cast<yaffle::i128>(${p}) == ${intLit(BigInt(t.nullValue))})`,
          () => {
            if (ctx.scanMode && ctx.fieldIndex !== undefined && tx.kind === "struct")
              this.scanner.nullKid(ctx);
            if (ctx.scanMode !== "kids") c.line(`${dst} = ${emptyValue()};`);
          }
        ],
        ["else", follow]
      ]);
    };
    if (!defer) {
      body();
      return;
    }
    // `@origin(expr)` may use positions of later fields: follow once the members are read.
    this.st.deferred = true;
    c.line(`deferred_.push_back([&, ${p}${t.relative ? `, ${pa}` : ""}]() {`);
    c.indent(() => {
      c.line(`fr.field = ${str(ctx.field ?? "")};`);
      body();
    });
    c.line(`});`);
  }

  /** Identity key of a target: type key, plus argument values for parameterized structs. */
  targetKey(t: IrType, ctx: RCtx): string {
    const inner = strip(t);
    const base = this.model.typeKey(stripLayers(t));
    const exprs: IrExpr[] = [];
    if (inner.kind === "struct") exprs.push(...inner.args);
    if (
      (inner.kind === "bytes" || inner.kind === "string" || inner.kind === "array") &&
      inner.length.kind === "count"
    )
      exprs.push(inner.length.expr);
    if (!exprs.length) return `std::string(${str(base)})`;
    const parts = exprs.map(a => `yaffle::key_part(${this.expr(a, ctx).code})`);
    return `std::string(${str(base + "(")}) + ${parts.join(' + "," + ')} + ")"`;
  }

  emitBits(b: IrBits, ctx: RCtx): void {
    const c = this.code;
    const size = primSize(b.storage);
    const u = c.fresh("u");
    const s = c.fresh("s");
    c.line(`[[maybe_unused]] const std::int64_t ${s} = ${ctx.r}.pos;`);
    c.line(`const std::uint64_t ${u} = ${ctx.r}.uN(${size}, ${this.leOf(b.endian, ctx)});`);
    for (const f of b.fields) {
      const raw = extractBits(u, f.shift, f.width);
      if (f.name === null) {
        c.line(
          `if (${this.strictCode(ctx)} && ${raw} != 0) ${ctx.r}.fail_at(yaffle::ErrorCode::Check, "reserved bits are not zero", ${s});`
        );
        continue;
      }
      c.line(`fr.field = ${str(f.name)};`);
      if (ctx.scan) {
        const fi = this.fieldIndex(ctx.s, f.name);
        c.line(`ns.fields[${fi}].start = ${s};`);
        c.line(`ns.fields[${fi}].end = ${s} + ${size};`);
      }
      const dst = this.dest(f.name, ctx);
      this.bitValue(f.type, raw, f.width, dst, ctx, s);
      this.emitChecks(f.checks, f.type, dst, s, ctx);
    }
  }

  private bitValue(
    t: IrType,
    raw: string,
    width: number,
    dst: string,
    ctx: RCtx,
    start: string
  ): void {
    const c = this.code;
    const inner = t.kind === "layered" ? t.inner : t;
    if (inner.kind === "bool") c.line(`${dst} = ${raw} != 0;`);
    else if (inner.kind === "enum") {
      const name = this.model.enumName(inner.enum);
      c.line(`${dst} = static_cast<${name}>(${raw});`);
      if (!this.model.enum(inner.enum).open) this.enumCheck(name, dst, start, ctx);
    } else if (inner.kind === "prim") {
      const ct = primCppType(inner.prim);
      if (inner.prim[0] === "i")
        c.line(`${dst} = static_cast<${ct}>(yaffle::sign_extend(${raw}, ${width}));`);
      else c.line(`${dst} = static_cast<${ct}>(${raw});`);
    } else if (inner.kind === "transform") {
      const it = c.fresh("it");
      c.line(`${this.types.type(inner.inner)} ${it}{};`);
      this.bitValue(inner.inner, raw, width, it, ctx, start);
      const v = this.expr(inner.read, {
        ...ctx,
        it: { code: it, type: valueTypeOf(this.model, inner.inner) }
      });
      c.line(`${dst} = ${this.x.to(v, inner.valueType)};`);
    } else c.line(`${dst} = static_cast<${this.types.type(t)}>(${raw});`);
  }

  // ── layers ────────────────────────────────────────────────────────────────

  /** Emits `layers` (the last is outermost) around `inner`. */
  emitLayers(
    layers: readonly IrLayer[],
    ctx: RCtx,
    inner: (ctx: RCtx) => void,
    slot: string,
    idx = layers.length - 1
  ): void {
    if (idx < 0) {
      inner(ctx);
      return;
    }
    const l = layers[idx]!;
    const c = this.code;
    const r = ctx.r;
    // A strict padding layer checks its fill outside strict mode too.
    const strict = "strict" in l && l.strict ? "true" : this.strictCode(ctx);
    const next = (x: RCtx): void => this.emitLayers(layers, x, inner, slot, idx - 1);
    switch (l.kind) {
      case "align":
        c.line(`${this.alignCall(l, ctx)}, ${this.fill(l.fill, ctx)}, ${strict});`);
        next(ctx);
        return;
      case "padBefore":
        c.line(`${r}.pad(${this.int(l.count, ctx)}, ${this.fill(l.fill, ctx)}, ${strict});`);
        next(ctx);
        return;
      case "padAfter":
        next(ctx);
        c.line(`${r}.pad(${this.int(l.count, ctx)}, ${this.fill(l.fill, ctx)}, ${strict});`);
        return;
      case "padUntil": {
        const s = c.fresh("s");
        c.line(`const std::int64_t ${s} = ${r}.pos;`);
        next(ctx);
        c.line(
          `${r}.pad_until(${s}, ${this.int(l.size, ctx)}, ${this.fill(l.fill, ctx)}, ${strict});`
        );
        return;
      }
      case "alignEnd":
        next(ctx);
        c.line(`${this.alignCall(l, ctx)}, ${this.fill(l.fill, ctx)}, ${strict});`);
        return;
      case "size": {
        const w = c.fresh("w");
        c.line(`const std::int64_t ${w} = ${r}.window(${this.len(l.size, ctx)});`);
        next(ctx);
        c.line(`${r}.close_window(${w}, ${strict});`);
        return;
      }
      case "via":
        this.via(l, ctx, next, `${slot}#${idx}`, sizeInside(layers, idx));
        return;
      case "endian": {
        const e = c.fresh("e");
        const le = c.fresh("le");
        c.line(`const yaffle::Endian ${e} = ${this.expr(l.value, ctx).code};`);
        c.line(`[[maybe_unused]] const bool ${le} = ${e} == yaffle::Endian::le;`);
        next({ ...ctx, endian: e, le });
        return;
      }
      case "strict":
        c.block("", () => {
          c.line(`yaffle::Restore<bool> ${c.fresh("st")}(${r}.strict, true);`);
          next({ ...ctx, strict: "true" });
        });
        return;
    }
  }

  /** A codec layer: decodes the window and reads the inner layers from the decoded bytes. */
  private via(
    l: Extract<IrLayer, { kind: "via" }>,
    ctx: RCtx,
    next: (ctx: RCtx) => void,
    slot: string,
    size: IrExpr | undefined
  ): void {
    const c = this.code;
    const r = ctx.r;
    const codec = this.model.codec(l.codec);
    if (ctx.scanMode === "kids" && !codec.streaming) {
      // Views decode codec regions on access: skip the encoded window.
      c.line(`${r}.skip_to_end();`);
      return;
    }
    if (ctx.scanMode) ctx = { ...ctx, scanMode: undefined };
    const args = this.args(codec.params, l.args, ctx);
    const outSize = size ? `static_cast<std::size_t>(${this.len(size, ctx)})` : undefined;
    c.block("", () => {
      const s = c.fresh("s");
      const input = c.fresh("in");
      const cc = c.fresh("cc");
      const d = c.fresh("d");
      const dec = c.fresh("dec");
      const sr = c.fresh("r");
      c.line(`const std::int64_t ${s} = ${r}.pos;`);
      c.line(`const yaffle::BytesView ${input} = ${r}.peek_bytes(${r}.pos, ${r}.end());`);
      this.codecCtx(cc, args, outSize);
      c.line(
        `yaffle::Decoded ${d} = yaffle::codec_decode(${this.names.extern(l.codec)}, ${str(codec.name)}, ${input}, ${cc}, ${codec.streaming}, ${r}.at(${s}));`
      );
      c.line(`auto ${dec} = std::make_shared<const yaffle::Bytes>(std::move(${d}.output));`);
      c.line(`auto ${sr} = ${r}.sub(${dec}, ${s});`);
      next({ ...ctx, r: sr });
      c.line(`${r}.pos = ${s} + static_cast<std::int64_t>(${d}.consumed);`);
      if (ctx.meta)
        c.line(
          `${ctx.meta}.remember(yaffle::slot_key(${str(slot)}, fr), ${input}.first(${d}.consumed), *${dec});`
        );
    });
  }
}

/** The type of a root struct's value (its parameters are locals). */
export function rootType(s: IrStruct): Extract<IrType, { kind: "struct" }> {
  return {
    kind: "struct",
    struct: s.id,
    args: s.params.map(p => ({ kind: "param", name: p.name, type: p.type }))
  };
}

/** The element struct of the array a `from arr[*].piece` stream reads. */
export function streamElement(model: Model, s: IrStruct, array: string): string {
  const af = model.field(s, array)?.field;
  const at = af ? strip(af.type) : undefined;
  const et = at?.kind === "array" ? strip(at.element) : undefined;
  if (et?.kind !== "struct") throw new Error(`stream array ${array} has no struct elements`);
  return et.struct;
}

function isAlignEnd(l: IrLayer): l is Extract<IrLayer, { kind: "alignEnd" }> {
  return l.kind === "alignEnd";
}

function extractBits(u: string, shift: number, width: number): string {
  const mask =
    width >= 64 ? "~UINT64_C(0)" : `UINT64_C(${((1n << BigInt(width)) - 1n).toString()})`;
  return shift ? `((${u} >> ${shift}) & ${mask})` : `(${u} & ${mask})`;
}

/** `cond` in parentheses, unless it already is one parenthesized expression. */
function parenthesized(cond: string): string {
  if (!/^\(.*\)$/.test(cond)) return `(${cond})`;
  let depth = 0;
  for (let i = 0; i < cond.length - 1; i++) {
    if (cond[i] === "(") depth++;
    else if (cond[i] === ")") depth--;
    if (depth === 0) return `(${cond})`;
  }
  return cond;
}
