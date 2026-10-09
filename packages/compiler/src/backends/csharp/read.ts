/**
 * Reader emitter: one `Read_X` method per struct (`ReadAsync_X` for structs whose members reach
 * an async codec), imperative code over `Rt.Reader` following docs/IR.md §2, and the view scanner
 * `Scan_X` (the same reader in scan mode).
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
  elementUsesIndex,
  exprUses,
  isStructType,
  literalInt,
  stripLayers,
  stripType,
  usesIndex,
  valueTypeOf
} from "./analysis.ts";
import { Code, ident, str } from "./code.ts";
import { Emitter, type EmitCtx } from "./emitter.ts";
import { encName, paren, stripParens, type CExpr, type ExprCtx } from "./expr.ts";
import { IMPL } from "./module.ts";
import type { Types } from "./types.ts";
import { deferOf, viewKind, type Defer } from "./views.ts";

export interface RCtx extends EmitCtx {
  /** Reader variable. */
  r: string;
  /** The field being read (for deferred pointer assignments). */
  field?: string | undefined;
  /** Where the field's value goes (pointers with `@origin` assign it after the members). */
  lvalue?: string | undefined;
  /** View scan mode (`Scan_X`): children are view nodes, targets and regions load lazily. */
  scan?: boolean | undefined;
  /** The ViewNode variable (scan mode). */
  node?: string | undefined;
  /** Path segments (C# expressions) of the current value relative to the node (scan mode). */
  seg?: string[] | undefined;
}

interface StructState {
  /** Start/end position variables of the fields whose extents expressions read. */
  extents: Map<string, { start: string; end: string }>;
  maxDepth: number;
  /** Statements run after the members (pointers with `@origin`). */
  deferred: string[];
  /** The raw value of the last one-way transform read. */
  rawLocal: string | undefined;
}

export class ReadEmitter extends Emitter<RCtx> {
  private st!: StructState;

  private begin(code: Code): void {
    this.st = { extents: new Map(), maxDepth: 0, deferred: [], rawLocal: undefined };
    this.code = code;
  }

  private structCtx(s: IrStruct, opts: { async: boolean; index: string; scan: boolean }): RCtx {
    return {
      s,
      r: "__r",
      endian: "endian",
      le: "__le",
      async: opts.async,
      index: opts.index,
      depth: 0,
      slot: this.model.className(s.id),
      scan: opts.scan,
      node: opts.scan ? "__n" : undefined,
      seg: []
    };
  }

  /** Emits `Read_X` (or `ReadAsync_X`), or the view scanner `Scan_X`. */
  emitStruct(out: Code, s: IrStruct, scan = false): void {
    const name = this.model.className(s.id);
    const async = scan ? false : this.model.bodyAsync(s.id);
    this.begin(out.child());
    const body = this.code;
    const ctx = this.structCtx(s, { async, index: "__index", scan });
    this.emitMembers(s.members, ctx);
    // A base's `@alignEnd` pads its whole region (after its targets), counted from its own start.
    const ends = s.base ? s.layers.filter(l => l.kind === "alignEnd") : [];
    const tail = this.capture(() => {
      if (!ends.length) return;
      this.code.line(`__r.Pos = Math.Max(__r.Pos, __r.MaxEnd);`);
      for (const l of ends)
        this.code.line(`${this.alignCall(l, ctx, l.strict ? "true" : "__r.Strict")};`);
    }).body;
    const params = s.params.map(p => `${this.types.valueType(p.type)} ${ident(p.name)}`);
    const fn = scan ? `Scan_${name}` : async ? `ReadAsync_${name}` : `Read_${name}`;
    const ret = scan ? "void" : async ? `async ValueTask<${name}>` : name;
    const head = scan
      ? ["Rt.Reader __r", `${name} __v`, "Rt.ViewNode __n", ...params]
      : ["Rt.Reader __r", ...params];
    out.block(`internal static ${ret} ${fn}(${head.join(", ")})`, () => {
      out.line(`bool __le = endian == Rt.Endian.Le;`);
      // A pre-registered object (identity per address and type, cycles) or a fresh one.
      if (!scan) out.line(`var __v = __r.TakeInto<${name}>() ?? new ${name}();`);
      if (usesIndex(s)) out.line(`long __index = __r.Index;`);
      for (const [n, e] of this.st.extents) {
        out.line(
          n === "this"
            ? `int ${e.start} = __r.Pos, ${e.end} = -1;`
            : `int ${e.start} = -1, ${e.end} = -1;`
        );
      }
      out.line(`string __f = "";`);
      const idx = Array.from({ length: this.st.maxDepth }, (_, i) => `__i${i}`);
      if (idx.length) out.line(`long ${idx.map(i => `${i} = -1`).join(", ")};`);
      if (s.base) {
        out.line(`int __base = __r.Base;`);
        out.line(`int __max = __r.MaxEnd;`);
        out.line(`__r.Base = __r.Pos;`);
        out.line(`__r.MaxEnd = __r.Pos;`);
      }
      const parts: [string, () => void][] = [
        [
          "try",
          () => {
            out.append(body);
            for (const d of this.st.deferred) out.line(d);
            if (ends.length) out.line(`__f = "";`);
            out.append(tail);
            if (s.base) {
              out.line(`__r.Pos = Math.Max(__r.Pos, __r.MaxEnd);`);
              out.line(`__r.MaxEnd = Math.Max(__max, __r.Pos);`);
            }
          }
        ],
        [
          `catch (Rt.YaffleException __e) when (__e.Prefix(${["__f", ...idx].join(", ")}))`,
          () => out.line("throw;")
        ]
      ];
      if (s.base) parts.push(["finally", () => out.line("__r.Base = __base;")]);
      out.chain(parts);
      if (!scan) out.line("return __v;");
    });
  }

  /**
   * The body of `ScanRoot_X`: scans a view's root (its struct-level layers around `Scan_X`) into
   * the root node's value. Root parameters are the method's locals.
   */
  rootScan(out: Code, s: IrStruct): void {
    this.begin(out);
    const name = this.model.className(s.id);
    const ctx = this.structCtx(s, { async: false, index: "-1L", scan: true });
    const layers = s.base ? s.layers.filter(l => l.kind !== "alignEnd") : s.layers;
    const args = s.params.map(p =>
      this.x.to(this.expr({ kind: "param", name: p.name, type: p.type }, ctx), p.type)
    );
    out.line(`var __v = new ${name}();`);
    out.line(`__n.Value = __v;`);
    out.line(`__n.Root.Register(__v, __n);`);
    this.emitLayers(
      layers,
      layers.length - 1,
      ctx,
      inner => {
        this.code.line(`${IMPL}.Scan_${name}(${[inner.r, "__v", "__n", ...args].join(", ")});`);
        return "";
      },
      name
    );
    out.line("return __v;");
  }

  /** Emits the read of a root struct (params are locals named after them); returns the value expression. */
  rootRead(out: Code, s: IrStruct, async: boolean): string {
    this.begin(out);
    const ctx = this.structCtx(s, { async, index: "-1L", scan: false });
    const args: IrExpr[] = s.params.map(p => ({ kind: "param", name: p.name, type: p.type }));
    return this.struct(s.id, args, ctx);
  }

  // ── expression context ────────────────────────────────────────────────────

  exprCtx(ctx: RCtx): ExprCtx {
    const r = ctx.r;
    const size = (f: string): string => {
      const e = this.extent(f);
      return `((long)(${e.end} - ${e.start}))`;
    };
    const bytes = (f: string): string => {
      const e = this.extent(f);
      return `${r}.PeekBytes(${e.start}, ${e.end})`;
    };
    return {
      ...this.commonExprCtx(ctx),
      field: (name, type) => this.fieldRef(ctx.s, name, type),
      builtin: name => {
        if (name === "offset") return `((long)(${r}.Pos - ${r}.Base))`;
        if (name === "end") return `((long)(${r}.End - ${r}.Base))`;
        return ctx.index;
      },
      sizeof: size,
      offsetof: f => `((long)(${this.extent(f).start} - ${r}.Base))`,
      encodedSize: size,
      bytesof: bytes,
      encode: bytes
    };
  }

  /** A field reference on the read side: the property of the value being read. */
  private fieldRef(s: IrStruct, name: string, type: IrValueType): CExpr {
    const f = this.model.field(s, name);
    if (!f) throw new Error(`unknown field ${name} in ${s.name}`);
    const info = this.types.field(s, f);
    const cs = this.types.valueType(type);
    let code = `__v.${info.member}`;
    if (info.base === "object") code = `((${cs})${code}!)`;
    else if (info.nullable) code = info.valueType ? `${code}.GetValueOrDefault()` : `${code}!`;
    const c = this.x.typed(code, type);
    if (info.base !== "object" && info.base !== c.cs && c.kind !== "other") c.cs = info.base;
    return c;
  }

  private extent(f: string): { start: string; end: string } {
    let e = this.st.extents.get(f);
    if (!e) {
      const id = f === "this" ? "this" : ident(f).replace(/^@/, "");
      e = { start: `__s_${id}`, end: `__e_${id}` };
      this.st.extents.set(f, e);
    }
    return e;
  }

  /** A count read from the data: EOF if the region cannot hold that many units. */
  private count(e: IrExpr, ctx: RCtx, unit: number): string {
    const lit = literalInt(e);
    if (lit !== undefined && lit >= 0) return `${lit}L`;
    const c = this.expr(e, ctx);
    const code = c.cs === "long" || c.cs === "ulong" || c.cs === "Int128" ? c.code : this.x.wide(c);
    if (c.kind !== "int" || c.cs === "BigInteger")
      return `${ctx.r}.Count(Rt.Ck.Len(${code}), ${unit})`;
    return `${ctx.r}.Count(${code}, ${unit})`;
  }

  private strictCode(ctx: RCtx): string {
    return ctx.s.strict ? "true" : `${ctx.r}.Strict`;
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
                return "";
              },
              `${ctx.slot}.block`
            );
          };
          if (m.condition) {
            const cond = this.expr(m.condition, ctx).code;
            const parts: [string, () => void][] = [[`if (${stripParens(cond)})`, body]];
            const els = m.else;
            if (els) parts.push(["else", () => this.emitMembers(els, ctx)]);
            c.chain(parts);
          } else c.block("", body);
          break;
        }
        case "switch": {
          const c = this.code;
          const d = c.fresh("d");
          const disc = this.expr(m.discriminant, ctx);
          c.line(`var ${d} = ${disc.code};`);
          const dExpr: CExpr = { ...disc, code: d };
          const parts: [string, () => void][] = m.cases.map((cs, k) => {
            const conds = cs.values.map(v =>
              this.x.equality(
                "==",
                dExpr,
                this.x.literal(v, m.discriminant.type, this.exprCtx(ctx))
              )
            );
            return [
              `${k ? "else if" : "if"} (${conds.join(" || ")})`,
              () => this.emitMembers(cs.members, ctx)
            ];
          });
          const def = m.default;
          const last = def
            ? () => this.emitMembers(def, ctx)
            : () =>
                c.line(
                  `throw ${ctx.r}.Error(Rt.ErrorCode.CHECK, $"no case matches {${d}}", ${ctx.r}.Pos);`
                );
          if (parts.length) c.chain([...parts, ["else", last]]);
          else c.block("", last);
          break;
        }
      }
    }
  }

  private emitField(f: IrField, ctx: RCtx): void {
    const c = this.code;
    c.line(`__f = ${str(f.name)};`);
    const fctx: RCtx = {
      ...ctx,
      slot: `${ctx.s.id}.${f.name}`,
      field: f.name,
      seg: ctx.scan ? [str(f.name)] : ctx.seg
    };
    if (f.virtual) {
      this.emitVirtual(f, fctx);
      return;
    }
    const defer = ctx.scan ? deferOf(this.model, ctx.s, f) : undefined;
    if (defer) {
      this.emitDeferred(f, defer, fctx);
      return;
    }
    const r = ctx.r;
    const ext = this.model.readExtents(ctx.s).has(f.name) ? this.extent(f.name) : undefined;
    let start = `${r}.Pos`;
    if ((f.checks.length > 0 || ext !== undefined || ctx.scan) && !f.placement) {
      if (ext) {
        start = ext.start;
        c.line(`${start} = ${r}.Pos;`);
      } else {
        start = c.fresh("s");
        c.line(`int ${start} = ${r}.Pos;`);
      }
    }
    const tgt = `__v.${this.model.member(ctx.s, f.name)}`;
    let checkValue = tgt;
    const assign = (v: string): void => {
      if (f.checks.length && v !== "default!") {
        const val = c.fresh("val");
        c.line(`var ${val} = ${v};`);
        c.line(`${tgt} = ${val};`);
        checkValue = val;
      } else c.line(`${tgt} = ${v};`);
    };
    if (f.placement) {
      let off = this.num(f.placement.offset, ctx);
      const emptyNull = f.placement.emptyIsNull === true;
      if (emptyNull) {
        const o = c.fresh("o");
        c.line(`long ${o} = ${off};`);
        off = o;
      }
      const addr = c.fresh("at");
      c.line(`long ${addr} = ${r}.Base + ${off};`);
      if (ext) c.line(`${ext.start} = (int)${addr};`);
      start = `(int)${addr}`;
      const follow = this.follow(f.type, addr, this.targetKey(f.type, ctx), fctx);
      assign(emptyNull ? `${off} == 0 ? ${emptyValue(f.type, this.types)} : ${follow}` : follow);
      if (ext) {
        const size = this.model.staticSize(f.type);
        c.line(
          `${ext.end} = ${size !== undefined ? `(int)${addr} + ${size}` : `${r}.LastTargetEnd`};`
        );
      }
    } else if (f.from && ctx.scan) {
      // A view reads the stream as its own byte space (here eagerly: the field has checks).
      assign(this.loadStream(f, fctx));
    } else if (f.from) {
      const stream = this.stream(f.from.stream, ctx);
      const sr = c.fresh("sr");
      c.line(`var ${sr} = ${r}.Sub(${stream});`);
      assign(this.read(f.type, { ...fctx, r: sr }));
    } else {
      this.st.rawLocal = undefined;
      assign(this.read(f.type, { ...fctx, lvalue: f.type.kind === "pointer" ? tgt : undefined }));
      // One-way transforms: canonical JSON shows the raw value.
      if (this.st.rawLocal && f.output && this.types.oneWay(f))
        c.line(`__v.${this.model.rawMember(ctx.s, f.name)} = ${this.st.rawLocal};`);
      if (ext) c.line(`${ext.end} = ${r}.Pos;`);
    }
    const fr = this.model.field(ctx.s, f.name)!;
    const info = this.types.field(ctx.s, fr);
    const itCode =
      checkValue === tgt && info.nullable
        ? info.valueType
          ? `${tgt}.GetValueOrDefault()`
          : `${tgt}!`
        : checkValue;
    this.emitChecks(f.checks, valueTypeOf(this.model, f.type), itCode, start, ctx);
    if (ctx.scan) {
      // View bookkeeping: the field's range and what was read (commits compare against it).
      const fi = this.viewIndex(ctx.s, f.name);
      const kind = viewKind(this.model, ctx.s, fr);
      if (kind === "Eager" || kind === "Child")
        c.line(`__n.Field(${fi}, ${start}, ${r}.Pos, ${tgt});`);
      else if (kind === "Lazy") {
        c.line(`__n.Range(${fi}, ${start}, ${r}.Pos);`);
        c.line(`Rt.Views.Loaded(__n, ${fi}, ${tgt});`);
      }
    }
  }

  /** A virtual field: no bytes; its value is computed here (and range-checked and checked). */
  private emitVirtual(f: IrField, ctx: RCtx): void {
    const c = this.code;
    const vt = valueTypeOf(this.model, f.type);
    const tmp = c.fresh("vv");
    c.line(`var ${tmp} = ${this.x.to(this.expr(f.virtual!.read, ctx), vt, f.name)};`);
    c.line(`__v.${this.model.member(ctx.s, f.name)} = ${tmp};`);
    this.emitChecks(f.checks, vt, tmp, `${ctx.r}.Pos`, ctx);
    if (ctx.scan)
      c.line(`__n.Field(${this.viewIndex(ctx.s, f.name)}, ${ctx.r}.Pos, ${ctx.r}.Pos, ${tmp});`);
  }

  /** Index of a field in the struct's view metadata. */
  private viewIndex(s: IrStruct, name: string): number {
    return this.model.uniqueFields(s).findIndex(f => f.name === name);
  }

  /** A deferred field of a view scan: skip its bytes now, read them on first access. */
  private emitDeferred(f: IrField, d: Defer, ctx: RCtx): void {
    const c = this.code;
    const r = ctx.r;
    const s = ctx.s;
    const fi = this.viewIndex(s, f.name);
    const slot = `__v.__S_${this.model.member(s, f.name)}`;
    const propCs = this.types.field(s, this.model.field(s, f.name)!).type;
    const b = c.fresh("b");
    const e = c.fresh("e");
    const start = c.fresh("s");
    c.line(`int ${b} = ${r}.Base, ${e} = ${r}.End, ${start} = ${r}.Pos;`);
    const defer = (value: string): void => {
      c.line(`${slot}.Defer(Rt.Views.Lazy<${propCs}>(__n, ${fi}, () => ${value}));`);
    };
    const target = (t: IrType, addr: string): string => {
      const key = this.targetKey(t, ctx);
      const k = c.fresh("k");
      c.line(`string ${k} = ${key};`);
      return this.loadTarget(t, "__n", `${fi}`, addr, b, e, k, ctx);
    };
    switch (d.kind) {
      case "target": {
        const p = f.placement!;
        const o = c.fresh("o");
        c.line(`long ${o} = ${this.num(p.offset, ctx)};`);
        const addr = c.fresh("at");
        c.line(`long ${addr} = ${r}.Base + ${o};`);
        c.line(`__n.Target(${fi}, ${addr});`);
        const load = target(f.type, addr);
        defer(p.emptyIsNull ? `${o} == 0 ? ${emptyValue(f.type, this.types)} : ${load}` : load);
        return;
      }
      case "pointer": {
        const t = f.type as Extract<IrType, { kind: "pointer" }>;
        const { p, relativeTo, off, nv } = this.readPointer(t, ctx);
        c.line(`__n.Range(${fi}, ${start}, ${r}.Pos);`);
        const addr = c.fresh("at");
        c.line(`long ${addr} = ${relativeTo ? `${relativeTo} + ${off}` : `${r}.Base + ${off}`};`);
        if (nv) c.line(`if (${p} != ${nv}) __n.Target(${fi}, ${addr});`);
        else c.line(`__n.Target(${fi}, ${addr});`);
        const load = target(t.target, addr);
        const empty = t.emptyIsNull ? emptyValue(t.target, this.types) : "null";
        defer(nv ? `${p} == ${nv} ? ${empty} : ${load}` : load);
        return;
      }
      case "bytes": {
        const t = f.type as Extract<IrType, { kind: "bytes" }>;
        const n = c.fresh("n");
        c.line(
          `long ${n} = ${t.length.kind === "count" ? this.count(t.length.expr, ctx, 1) : `${r}.End - ${r}.Pos`};`
        );
        c.line(`Rt.Views.Skip(${r}, ${n});`);
        c.line(`__n.Range(${fi}, ${start}, ${r}.Pos);`);
        // A stream piece (or source) is a window of this space: readable without loading it.
        c.line(`__n.Bytes(${fi}, ${n}, () => Rt.Views.Window(__n, ${start}, ${n}));`);
        defer(`Rt.Views.LoadBytes(__n, ${start}, ${b}, ${e}, ${n})`);
        return;
      }
      case "array":
        this.emitDeferredArray(f, d.elementSize, { b, e, start, fi, slot, propCs }, ctx);
        return;
      case "region":
        this.emitDeferredRegion(f, d.via, { b, e, start, fi, slot, propCs }, ctx, defer);
        return;
      case "stream":
        defer(this.loadStream(f, ctx));
        return;
    }
  }

  /** A deferred array of fixed-size elements: skipped now, read whole on first access. */
  private emitDeferredArray(
    f: IrField,
    elementSize: number,
    v: { b: string; e: string; start: string; fi: number; slot: string; propCs: string },
    ctx: RCtx
  ): void {
    const c = this.code;
    const r = ctx.r;
    const t = f.type as Extract<IrType, { kind: "array" }>;
    if (t.length.kind !== "count") throw new Error("deferred arrays need a count");
    const n = c.fresh("n");
    c.line(`long ${n} = ${this.count(t.length.expr, ctx, elementSize)};`);
    const elemCs = this.types.type(t.element);
    const ra = c.fresh("ra");
    const a = c.fresh("a");
    const i = c.fresh("i");
    const ci = c.fresh("ci");
    const setIndex = elementUsesIndex(this.model, t.element);
    const { body } = this.capture(() => {
      const body = this.code;
      body.line(`var ${ra} = __n.ReaderAt(${v.start}, ${v.b}, ${v.e});`);
      body.line(`var ${a} = new List<${elemCs}>((int)Math.Min(${n}, 4096));`);
      body.line(`long ${ci} = -1;`);
      body.chain([
        [
          "try",
          () =>
            body.block(`for (long ${i} = 0; ${i} < ${n}; ${i}++)`, () => {
              body.line(`${ci} = ${i};`);
              if (setIndex) body.line(`${ra}.Index = ${i};`);
              const el = this.read(t.element, {
                ...ctx,
                r: ra,
                index: i,
                depth: ctx.depth + 1,
                seg: [...(ctx.seg ?? []), i]
              });
              body.line(`${a}.Add(${el});`);
            })
        ],
        [`catch (Rt.YaffleException __x) when (__x.Prefix("", ${ci}))`, () => body.line("throw;")]
      ]);
      body.line(`return ${a};`);
    });
    const ld = c.fresh("ld");
    c.line(`var ${ld} = Rt.Views.Lazy<${v.propCs}>(__n, ${v.fi}, () =>`);
    c.block("", () => c.append(body));
    c.line(");");
    // The loader runs right away when the region is too short: the error names the element.
    c.line(`Rt.Views.Skip(${r}, ${n} * ${elementSize}, ${ld});`);
    c.line(`__n.Range(${v.fi}, ${v.start}, ${r}.Pos);`);
    c.line(`${v.slot}.Defer(${ld});`);
  }

  /** A deferred codec region (`@size(n) @via(c) …`): decoded on first access. */
  private emitDeferredRegion(
    f: IrField,
    k: number,
    v: { b: string; e: string; start: string; fi: number; slot: string; propCs: string },
    ctx: RCtx,
    defer: (value: string) => void
  ): void {
    const c = this.code;
    const r = ctx.r;
    const t = f.type as Extract<IrType, { kind: "layered" }>;
    const windows: string[] = [];
    for (let li = t.layers.length - 1; li > k; li--) {
      const l = t.layers[li]!;
      if (l.kind !== "size") throw new Error("expected a size layer");
      const w = c.fresh("w");
      c.line(`int ${w} = ${r}.Window(${this.len(l.size, ctx)});`);
      windows.push(w);
    }
    const rs = c.fresh("rs");
    const re = c.fresh("re");
    c.line(`int ${rs} = ${r}.Pos, ${re} = ${r}.End;`);
    c.line(`${r}.Pos = ${r}.End;`);
    for (const w of windows.reverse()) c.line(`${r}.CloseWindow(${w}, ${this.strictCode(ctx)});`);
    c.line(`__n.Range(${v.fi}, ${v.start}, ${r}.Pos);`);
    const l = t.layers[k] as Extract<IrLayer, { kind: "via" }>;
    const codec = this.model.codec(l.codec);
    const cctx = this.codecCtx(t.layers, k, ctx);
    const cv = c.fresh("cc");
    c.line(`var ${cv} = ${cctx};`);
    const rr = c.fresh("rr");
    const nn = c.fresh("nn");
    const inner = this.lambda(
      () =>
        this.emitLayers(
          t.layers,
          k - 1,
          { ...ctx, r: rr, node: nn },
          x => this.read(t.inner, x),
          ctx.slot
        ),
      { params: `Rt.Reader ${rr}, Rt.ViewNode ${nn}` }
    );
    const ranged = codec.ranged && !codec.async;
    const region = `${this.mod.extern(l.codec)}, ${str(codec.name)}, ${cv}, ${codec.async}`;
    const regionSlot = str(`${ctx.slot}#${k}`);
    // Decoded bytes whose length is known without decoding (`u8 data[] @size(exp) @via(c) …`):
    // a stream joining them decodes only the pieces a read reaches.
    const len = this.decodedBytesLength(t, k, ctx, `${re} - ${rs}`);
    if (len !== undefined) {
      const ln = c.fresh("ln");
      c.line(`long ${ln} = ${len};`);
      c.line(
        `__n.Bytes(${v.fi}, ${ln}, () => Rt.SliceStore.Of(Rt.Views.RegionStore(__n, ${rs}, ${re}, ${region}, ${ranged}, ${regionSlot}), 0, ${ln}));`
      );
    }
    defer(
      `Rt.Views.LoadRegion<${this.types.nonNull(v.propCs)}>(__n, ${rs}, ${re}, ${region}, ${regionSlot}, ${inner}, ${ranged})`
    );
  }

  /** A view's read of a `from` field: a fresh region over a lazily joined store of the stream. */
  private loadStream(f: IrField, ctx: RCtx): string {
    const propCs = this.types.field(ctx.s, this.model.field(ctx.s, f.name)!).type;
    const rs = this.code.fresh("rs");
    const ns = this.code.fresh("ns");
    const inner = this.lambda(() => this.read(f.type, { ...ctx, r: rs, node: ns }), {
      params: `Rt.Reader ${rs}, Rt.ViewNode ${ns}`
    });
    return `Rt.Views.LoadStream<${this.types.nonNull(propCs)}>(__n, ${this.streamStore(f.from!.stream, ctx)}, ${inner})`;
  }

  /** A stream's bytes (a parse) or store (a view, where pieces stay unread until a read reaches them). */
  private streamOf(s: IrStreamExpr, ctx: RCtx, view: boolean): string {
    switch (s.kind) {
      case "field": {
        if (!this.model.field(ctx.s, s.field)?.field)
          throw new Error(`unknown stream field ${s.field}`);
        const value = this.fieldRef(ctx.s, s.field, { kind: "bytes" }).code;
        return view
          ? `Rt.Views.FieldStore(__n, __v, ${this.viewIndex(ctx.s, s.field)}, () => Rt.Check.Bytes(${value}))`
          : value;
      }
      case "each": {
        const { element } = this.model.structArray(ctx.s, s.array);
        const arr = this.fieldRef(ctx.s, s.array, {
          kind: "array",
          element: { kind: "struct", struct: element.id }
        }).code;
        const cls = this.model.className(element.id);
        const p = this.code.fresh("e");
        const piece = `(${cls} ${p}) => Rt.Check.Bytes(${p}.${this.model.member(element, s.field)})`;
        return view
          ? `Rt.Views.Pieces<${cls}>(__n.Root, ${arr}, ${this.viewIndex(element, s.field)}, ${piece})`
          : `Rt.Codecs.Join(Rt.Values.Map(${arr}, ${piece}))`;
      }
      case "slice": {
        const inner = this.streamOf(s.stream, ctx, view);
        const a = this.num(s.start, ctx);
        const b = s.end ? this.num(s.end, ctx) : "null";
        return `Rt.${view ? "Views" : "Codecs"}.Slice(${inner}, ${a}, ${b})`;
      }
    }
  }

  private stream(s: IrStreamExpr, ctx: RCtx): string {
    return this.streamOf(s, ctx, false);
  }

  private streamStore(s: IrStreamExpr, ctx: RCtx): string {
    return this.streamOf(s, ctx, true);
  }

  /**
   * The decoded length of a deferred codec region holding plain bytes, when it is known without
   * decoding: the inner count or innermost `@size`, or (for `@ranged` codecs, which keep lengths)
   * the encoded window. Undefined when it depends on the decoded data.
   */
  private decodedBytesLength(
    t: Extract<IrType, { kind: "layered" }>,
    k: number,
    ctx: RCtx,
    encodedLength: string
  ): string | undefined {
    const inner = t.inner;
    if (inner.kind !== "bytes") return undefined;
    const below = t.layers.slice(0, k);
    if (!below.every(l => l.kind === "size")) return undefined;
    const positional = (e: IrExpr): boolean =>
      exprUses(e, x => x.kind === "builtinValue" && x.name !== "index");
    if (inner.length.kind === "count")
      return positional(inner.length.expr) ? undefined : this.len(inner.length.expr, ctx);
    if (inner.length.kind !== "rest") return undefined;
    const first = below[0];
    if (first && first.kind === "size")
      return positional(first.size) ? undefined : this.len(first.size, ctx);
    const codec = this.model.codec((t.layers[k] as Extract<IrLayer, { kind: "via" }>).codec);
    return codec.ranged && !codec.async ? `(long)(${encodedLength})` : undefined;
  }

  /**
   * `new Rt.CodecContext(args, outputSize)` of the via layer `layers[idx]` (an inner size layer
   * gives the output size).
   */
  private codecCtx(layers: readonly IrLayer[], idx: number, ctx: RCtx): string {
    const l = layers[idx] as Extract<IrLayer, { kind: "via" }>;
    const args = this.args(l.args, this.model.codec(l.codec).params, ctx);
    let outSize: string | undefined;
    for (let k = idx - 1; k >= 0; k--) {
      const ll = layers[k]!;
      if (ll.kind === "via") break;
      if (ll.kind === "size") {
        outSize = this.len(ll.size, ctx);
        break;
      }
    }
    return `new Rt.CodecContext(new object[] { ${args.join(", ")} }${outSize !== undefined ? `, (int)${paren(outSize)}` : ""})`;
  }

  private emitChecks(
    checks: readonly { expr: IrExpr; message: string; strictOnly: boolean }[],
    vt: IrValueType,
    value: string,
    start: string,
    ctx: RCtx
  ): void {
    for (const ch of checks) {
      const cond = this.expr(ch.expr, { ...ctx, it: { code: value, type: vt } }).code;
      const guard = ch.strictOnly ? `${this.strictCode(ctx)} && ` : "";
      this.code.line(
        `if (${guard}!${paren(cond)}) ${ctx.r}.CheckFail(${str(ch.message)}, ${start});`
      );
    }
  }

  /**
   * A C# lambda around what `f` emits: `(params) => value`, or a block body ending in
   * `return value;` when `f` emitted statements. `cast` and `wrap` adjust the value.
   */
  private lambda(
    f: () => string,
    opts: {
      params?: string;
      async?: boolean;
      cast?: string;
      wrap?: ((v: string) => string) | undefined;
    } = {}
  ): string {
    const { body, value: v } = this.capture(f);
    const head = `${opts.async ? "async " : ""}(${opts.params ?? ""}) =>`;
    const cast = opts.cast ? `(${opts.cast})${paren(v)}` : v;
    const value = opts.wrap ? opts.wrap(cast) : cast;
    if (body.empty) return `${head} ${value}`;
    const out = new Code();
    out.line(head);
    out.block("", () => {
      out.append(body);
      out.line(`return ${value};`);
    });
    return out.toString();
  }

  /** Reads a pointer or `at` target at `addr` (identity per address and type key). */
  private follow(t: IrType, addr: string, key: string, ctx: RCtx): string {
    // Views: one value per (space, address, type) across the whole view.
    if (ctx.scan)
      return this.loadTarget(t, ctx.node!, "-1", addr, `${ctx.r}.Base`, `${ctx.r}.End`, key, ctx);
    const async = ctx.async && this.model.isAsyncType(t);
    const body = this.lambda(() => this.read(t, { ...ctx, async, lvalue: undefined }), { async });
    const cs = this.types.nonNull(this.types.type(t));
    const m = isStructType(t) ? "TargetStruct" : "Target";
    if (async) return `await ${ctx.r}.${m}Async<${cs}>(${addr}, ${key}, ${body})`;
    return `${ctx.r}.${m}<${cs}>(${addr}, ${key}, ${body})`;
  }

  /** A view's read of a target on access (`Rt.Views.LoadTarget`). */
  private loadTarget(
    t: IrType,
    node: string,
    fi: string,
    addr: string,
    base: string,
    end: string,
    key: string,
    ctx: RCtx
  ): string {
    const rt = this.code.fresh("rt");
    const body = this.lambda(() => this.read(t, { ...ctx, r: rt, lvalue: undefined }), {
      params: `Rt.Reader ${rt}`
    });
    const cs = this.types.nonNull(this.types.type(t));
    return `Rt.Views.LoadTarget<${cs}>(${node}, ${fi}, ${addr}, ${base}, ${end}, ${key}, ${body})`;
  }

  // ── types ─────────────────────────────────────────────────────────────────

  /** Emits statements for reading `t`; returns an expression to evaluate right after them. */
  read(t: IrType, ctx: RCtx): string {
    // Struct values pointers can target are one object per (address, type), inline elements
    // included. (View scans: Rt.Views.Child keeps identity per view.)
    if (t.kind === "struct" && !ctx.scan && this.model.identityStructs.has(t.struct)) {
      const key = this.targetKey(t, ctx);
      const async = ctx.async && this.model.isAsyncType(t);
      const body = this.lambda(() => this.readInner(t, { ...ctx, async }), { async });
      const cs = this.model.className(t.struct);
      return async
        ? `await ${ctx.r}.InlineAsync<${cs}>(${key}, ${body})`
        : `${ctx.r}.Inline<${cs}>(${key}, ${body})`;
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
        return `${r}.Bool(${this.strictCode(ctx)})`;
      case "string": {
        const le = t.unit === 1 ? "true" : this.leOf(t.endian, ctx);
        const enc = `Rt.TextEncoding.${encName(t.encoding)}`;
        if (t.length.kind === "count")
          return `${r}.Str(${this.count(t.length.expr, ctx, t.unit)}, ${t.unit}, ${enc}, ${le})`;
        if (t.length.kind === "until") return `${r}.StrUntil(${t.unit}, ${enc}, ${le})`;
        if (t.length.kind === "rest") return `${r}.StrRest(${t.unit}, ${enc}, ${le})`;
        throw new Error(`not implemented: ${t.length.kind} strings`);
      }
      case "bytes":
        if (t.length.kind === "count") return `${r}.Bytes(${this.count(t.length.expr, ctx, 1)})`;
        if (t.length.kind === "until")
          return `${r}.BytesUntil(${this.num(t.length.terminator, ctx)})`;
        if (t.length.kind === "rest") return `${r}.BytesRest()`;
        throw new Error(`not implemented: ${t.length.kind} bytes`);
      case "array":
        return this.arrayLoop(t, ctx);
      case "struct":
        return this.struct(t.struct, t.args, ctx);
      case "enum": {
        const en = this.model.enum(t.enum);
        const s = c.fresh("s");
        c.line(`int ${s} = ${r}.Pos;`);
        const raw = prim(en.storage, this.leOf(t.endian, ctx), r);
        return `${this.mod.enumFn(t.enum, "Read")}(${raw}, ${r}, ${s})`;
      }
      case "pointer":
        return this.pointer(t, ctx);
      case "extern": {
        const x = this.model.extern(t.extern);
        const args = this.args(t.args, x.params, ctx);
        const fixed = x.kind === "type" && x.fixedSize !== undefined ? x.fixedSize : -1;
        return `${r}.Extern(${this.mod.extern(t.extern)}, new object[] { ${args.join(", ")} }, ${fixed})`;
      }
      case "union":
        return this.union(t, ctx);
      case "transform": {
        const it = c.fresh("it");
        c.line(`var ${it} = ${this.read(t.inner, ctx)};`);
        if (!t.write) this.st.rawLocal = it;
        const v = this.expr(t.read, {
          ...ctx,
          it: { code: it, type: valueTypeOf(this.model, t.inner) }
        });
        return this.x.to(v, t.valueType);
      }
      case "layered":
        return this.emitLayers(
          t.layers,
          t.layers.length - 1,
          ctx,
          inner => this.read(t.inner, inner),
          ctx.slot
        );
    }
  }

  private union(t: Extract<IrType, { kind: "union" }>, ctx: RCtx): string {
    if (ctx.scan) {
      // Views read unions completely (untracked: commits re-serialize).
      if (this.model.isAsyncType(t)) throw new Error("not implemented: views of async unions");
      const v = this.read(t, { ...ctx, scan: false, async: false });
      return `Rt.Views.Opaque(${ctx.node}, ${v})`;
    }
    if (ctx.async && this.model.isAsyncType(t)) {
      // Every variant is a Func<ValueTask<object?>>; sync variants wrap their value.
      const alts = t.variants.map(v => {
        const va = this.model.isAsyncType(v.type);
        const body = this.lambda(() => this.read(v.type, { ...ctx, async: va }), {
          async: va,
          cast: "object?",
          wrap: va ? undefined : x => `new ValueTask<object?>(${x})`
        });
        return `(${str(v.name)}, ${body})`;
      });
      return `(await ${ctx.r}.UnionAsync(${alts.join(", ")}))`;
    }
    const alts = t.variants.map(v => {
      const body = this.lambda(() => this.read(v.type, { ...ctx, async: false }), {
        cast: "object?"
      });
      return `(${str(v.name)}, ${body})`;
    });
    return `${ctx.r}.Union(${alts.join(", ")})`;
  }

  private struct(id: string, args: readonly IrExpr[], ctx: RCtx): string {
    const s = this.model.struct(id);
    const call = (inner: RCtx): string => {
      const argCode = this.args(args, s.params, inner);
      const cls = this.model.className(id);
      if (inner.scan) {
        // A view node: scanned now, one object per (space, position, type) across the view.
        const c = this.code;
        const locals = argCode.map(a => {
          const l = c.fresh("ca");
          c.line(`var ${l} = ${a};`);
          return l;
        });
        const y = c.fresh("y");
        const yn = c.fresh("yn");
        const segs = inner.seg ?? [];
        return `Rt.Views.Child<${cls}>(${inner.r}, ${inner.node}, ${IMPL}.Info_${cls}, new object[] { ${locals.join(", ")} }, new object[] { ${segs.join(", ")} }, (${cls} ${y}, Rt.ViewNode ${yn}) => ${IMPL}.Scan_${cls}(${[inner.r, y, yn, ...locals].join(", ")}))`;
      }
      const async = this.model.bodyAsync(id);
      if (async && !inner.async) throw new Error(`async struct ${s.name} read in a sync context`);
      const callExpr = `${this.mod.structFn(id, async ? "ReadAsync" : "Read")}(${[inner.r, ...argCode].join(", ")})`;
      return async ? `(await ${callExpr})` : callExpr;
    };
    // A base's `@alignEnd` is applied inside its reader (relative to its own start).
    const layers = s.base ? s.layers.filter(l => l.kind !== "alignEnd") : s.layers;
    if (!layers.length) return call(ctx);
    return this.emitLayers(layers, layers.length - 1, ctx, call, `${ctx.slot}#${s.name}`);
  }

  private arrayLoop(t: Extract<IrType, { kind: "array" }>, ctx: RCtx): string {
    const c = this.code;
    const r = ctx.r;
    const depth = ctx.depth;
    this.st.maxDepth = Math.max(this.st.maxDepth, depth + 1);
    const a = c.fresh("a");
    const i = c.fresh("i");
    const elemType = this.types.type(t.element);
    const ectx: RCtx = {
      ...ctx,
      index: i,
      depth: depth + 1,
      seg: ctx.scan ? [...(ctx.seg ?? []), i] : ctx.seg
    };
    const setIndex = elementUsesIndex(this.model, t.element);
    c.line(`var ${a} = new List<${elemType}>();`);
    const savedIndex = setIndex ? c.fresh("ix") : "";
    if (setIndex) c.line(`long ${savedIndex} = ${r}.Index;`);
    const loopBody = (read: () => string, post?: (el: string) => void): void => {
      c.line(`__i${depth} = ${i};`);
      if (setIndex) c.line(`${r}.Index = ${i};`);
      const v = read();
      if (post) post(v);
      else c.line(`${a}.Add(${v});`);
    };
    if (t.elementPlacement) {
      const place = t.elementPlacement;
      const readAt = (): string => {
        const off = this.num(place, ectx);
        const addr = c.fresh("at");
        c.line(`long ${addr} = ${r}.Base + ${off};`);
        if (t.length.kind === "rest") c.line(`if (${addr} >= ${r}.End) break;`);
        const async = ctx.async && this.model.isAsyncType(t.element);
        const body = this.lambda(() => this.read(t.element, { ...ectx, async }), { async });
        return async
          ? `await ${r}.PeekAtAsync<${elemType}>(${addr}, ${body})`
          : `${r}.PeekAt<${elemType}>(${addr}, ${body})`;
      };
      if (t.length.kind === "count") {
        const n = c.fresh("n");
        c.line(`long ${n} = ${this.len(t.length.expr, ctx)};`);
        c.block(`for (long ${i} = 0; ${i} < ${n}; ${i}++)`, () => loopBody(readAt));
      } else if (t.length.kind === "rest") {
        c.block(`for (long ${i} = 0; ; ${i}++)`, () => loopBody(readAt));
      } else {
        const len = t.length;
        c.block(`for (long ${i} = 0; ; ${i}++)`, () =>
          loopBody(readAt, el => this.terminated(len, t.element, el, a, undefined, ctx))
        );
      }
    } else if (t.length.kind === "count") {
      const n = c.fresh("n");
      const es = this.model.staticSize(t.element);
      c.line(`long ${n} = ${this.count(t.length.expr, ctx, es ?? 1)};`);
      c.block(`for (long ${i} = 0; ${i} < ${n}; ${i}++)`, () =>
        loopBody(() => this.read(t.element, ectx))
      );
    } else if (t.length.kind === "rest") {
      c.block(`for (long ${i} = 0; ${r}.Pos < ${r}.End; ${i}++)`, () =>
        loopBody(() => this.read(t.element, ectx))
      );
    } else {
      const len = t.length;
      const p = c.fresh("p");
      c.block(`for (long ${i} = 0; ; ${i}++)`, () => {
        c.line(`int ${p} = ${r}.Pos;`);
        loopBody(
          () => this.read(t.element, ectx),
          el => this.terminated(len, t.element, el, a, p, ctx)
        );
      });
    }
    if (setIndex) c.line(`${r}.Index = ${savedIndex};`);
    c.line(`__i${depth} = -1;`);
    return a;
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
    const e = c.fresh("el");
    c.line(`var ${e} = ${el};`);
    const vt = valueTypeOf(this.model, elem);
    if (len.kind === "untilPredicate") {
      c.line(`${a}.Add(${e});`);
      const cond = this.expr(len.predicate, { ...ctx, it: { code: e, type: vt } }).code;
      c.line(`if (${stripParens(cond)}) break;`);
      return;
    }
    if (len.kind !== "until" && len.kind !== "before")
      throw new Error(`unexpected length ${len.kind}`);
    const eq = this.x.equality("==", this.x.typed(e, vt), this.expr(len.terminator, ctx));
    if (len.kind === "before" && pos) {
      c.block(`if (${stripParens(eq)})`, () => {
        c.line(`${ctx.r}.Pos = ${pos};`);
        c.line("break;");
      });
    } else c.line(`if (${stripParens(eq)}) break;`);
    c.line(`${a}.Add(${e});`);
  }

  /**
   * Reads a pointer's stored value `p`: the target is at `relativeTo` (relative pointers) or the
   * base, plus `off`. `nv` is the stored value meaning null, if any.
   */
  private readPointer(
    t: Extract<IrType, { kind: "pointer" }>,
    ctx: RCtx
  ): { p: string; relativeTo: string | undefined; off: string; nv: string | undefined } {
    const c = this.code;
    const at = c.fresh("pa");
    if (t.relative) c.line(`int ${at} = ${ctx.r}.Pos;`);
    const p = c.fresh("p");
    const storageCs = this.types.primType(t.storage);
    c.line(`var ${p} = ${prim(t.storage, this.leOf(t.storageEndian, ctx), ctx.r)};`);
    return {
      p,
      relativeTo: t.relative ? at : undefined,
      off: storageCs === "ulong" ? `Rt.Ck.Off(${p})` : `(long)${p}`,
      nv: t.nullValue !== undefined ? this.x.intLit(BigInt(t.nullValue), storageCs) : undefined
    };
  }

  private pointer(t: Extract<IrType, { kind: "pointer" }>, ctx: RCtx): string {
    const { p, relativeTo, off, nv } = this.readPointer(t, ctx);
    // `@origin(expr)`: target = base + origin + value; the origin may use positions of later
    // fields, so a field's pointer is followed once the struct's members are read. (Elements of
    // an array of pointers are followed right away: their origin may only use earlier fields.)
    const origin = t.origin ? this.num(t.origin, ctx) : undefined;
    const addr = relativeTo
      ? `${relativeTo} + ${off}`
      : `${ctx.r}.Base + ${origin !== undefined ? `${origin} + ` : ""}${off}`;
    const key = this.targetKey(t.target, ctx);
    const empty = t.emptyIsNull ? emptyValue(t.target, this.types) : "null";
    const follow = this.follow(t.target, addr, key, { ...ctx, lvalue: undefined });
    const value = nv === undefined ? follow : `${p} == ${nv} ? ${empty} : ${follow}`;
    if (origin === undefined || ctx.lvalue === undefined) return value;
    this.st.deferred.push(`__f = ${str(ctx.field ?? "")}; ${ctx.lvalue} = ${value};`);
    return "default!";
  }

  /** Identity key of a target: type key, plus argument values for parameterized structs. */
  private targetKey(t: IrType, ctx: RCtx): string {
    const inner = stripType(t);
    // Layers don't change which value sits at an address: key by the type underneath.
    const base = this.model.typeKey(stripLayers(t));
    const exprs: IrExpr[] = [];
    if (inner.kind === "struct") exprs.push(...inner.args);
    if (
      (inner.kind === "bytes" || inner.kind === "string" || inner.kind === "array") &&
      inner.length.kind === "count"
    ) {
      exprs.push(inner.length.expr);
    }
    if (!exprs.length) return str(base);
    const parts = exprs.map(a => `{${paren(this.expr(a, ctx).code)}}`);
    return `$"${base.replace(/[{}"\\]/g, ch => (ch === "{" ? "{{" : ch === "}" ? "}}" : `\\${ch}`))}(${parts.join(",")})"`;
  }

  private emitBits(b: IrBits, ctx: RCtx): void {
    const c = this.code;
    const u = c.fresh("u");
    const s = c.fresh("s");
    const storage = `Rt.Prim.${b.storage.toUpperCase()}`;
    c.line(`int ${s} = ${ctx.r}.Pos;`);
    c.line(`ulong ${u} = ${ctx.r}.Bits(${storage}, ${this.leOf(b.endian, ctx)});`);
    for (const f of b.fields) {
      const mask =
        f.width >= 64 ? "ulong.MaxValue" : `0x${((1n << BigInt(f.width)) - 1n).toString(16)}UL`;
      const raw = f.shift ? `((${u} >> ${f.shift}) & ${mask})` : `(${u} & ${mask})`;
      if (f.name === null) {
        c.line(
          `if (${this.strictCode(ctx)} && ${raw} != 0) throw ${ctx.r}.Error(Rt.ErrorCode.CHECK, "reserved bits are not zero", ${s});`
        );
        continue;
      }
      c.line(`__f = ${str(f.name)};`);
      const val = this.bitValue(f.type, raw, f.width, ctx, s);
      const tmp = c.fresh("bv");
      c.line(`var ${tmp} = ${val};`);
      c.line(`__v.${this.model.member(ctx.s, f.name)} = ${tmp};`);
      this.emitChecks(f.checks, valueTypeOf(this.model, f.type), tmp, s, ctx);
      if (ctx.scan)
        c.line(`__n.Field(${this.viewIndex(ctx.s, f.name)}, ${s}, ${ctx.r}.Pos, ${tmp});`);
    }
  }

  private bitValue(t: IrType, raw: string, width: number, ctx: RCtx, start: string): string {
    const inner = t.kind === "layered" ? t.inner : t;
    const int = (p: string): string => {
      const cs = this.types.primType(p);
      return p[0] === "i" ? `(${cs})Rt.Check.SignExtend(${raw}, ${width})` : `(${cs})${raw}`;
    };
    if (inner.kind === "bool") return `${raw} != 0`;
    if (inner.kind === "enum") {
      const v = int(this.model.enum(inner.enum).storage);
      return `${this.mod.enumFn(inner.enum, "Read")}(${v}, ${ctx.r}, ${start})`;
    }
    if (inner.kind === "prim") return int(inner.prim);
    if (inner.kind === "transform") {
      const it = this.code.fresh("it");
      this.code.line(`var ${it} = ${this.bitValue(inner.inner, raw, width, ctx, start)};`);
      const v = this.expr(inner.read, {
        ...ctx,
        it: { code: it, type: valueTypeOf(this.model, inner.inner) }
      });
      return this.x.to(v, inner.valueType);
    }
    return raw;
  }

  // ── layers ────────────────────────────────────────────────────────────────

  /**
   * Emits layers `layers[idx]` (outermost) down to `layers[0]` around `inner`. Returns the
   * expression of the value (assigned to a temp when post-processing follows). An empty string
   * means "no value" (blocks).
   */
  private emitLayers(
    layers: readonly IrLayer[],
    idx: number,
    ctx: RCtx,
    inner: (ctx: RCtx) => string,
    slot: string
  ): string {
    if (idx < 0) return inner(ctx);
    const l = layers[idx]!;
    const c = this.code;
    const r = ctx.r;
    // `strict` padding is checked even outside strict mode.
    const strict = "strict" in l && l.strict ? "true" : this.strictCode(ctx);
    const next = (x: RCtx): string => this.emitLayers(layers, idx - 1, x, inner, slot);
    const capture = (x: RCtx): string => {
      const v = next(x);
      if (v === "") return v;
      const t = c.fresh("t");
      c.line(`var ${t} = ${v};`);
      return t;
    };
    switch (l.kind) {
      case "align":
        c.line(`${this.alignCall(l, ctx, strict)};`);
        return next(ctx);
      case "padBefore":
        c.line(`${r}.Pad(${this.len(l.count, ctx)}, ${this.fill(l.fill, ctx)}, ${strict});`);
        return next(ctx);
      case "padAfter": {
        const v = capture(ctx);
        c.line(`${r}.Pad(${this.len(l.count, ctx)}, ${this.fill(l.fill, ctx)}, ${strict});`);
        return v;
      }
      case "padUntil": {
        const s = c.fresh("s");
        c.line(`int ${s} = ${r}.Pos;`);
        const v = capture(ctx);
        c.line(
          `${r}.PadUntil(${s}, ${this.len(l.size, ctx)}, ${this.fill(l.fill, ctx)}, ${strict});`
        );
        return v;
      }
      case "alignEnd": {
        const v = capture(ctx);
        c.line(`${this.alignCall(l, ctx, strict)};`);
        return v;
      }
      case "size": {
        const w = c.fresh("w");
        c.line(`int ${w} = ${r}.Window(${this.len(l.size, ctx)});`);
        const v = capture(ctx);
        c.line(`${r}.CloseWindow(${w}, ${strict});`);
        return v;
      }
      case "via":
        return this.emitVia(layers, idx, ctx, next, slot);
      case "endian": {
        const e = c.fresh("en");
        const le = c.fresh("le");
        c.line(`var ${e} = ${this.expr(l.value, ctx).code};`);
        c.line(`bool ${le} = ${e} == Rt.Endian.Le;`);
        return next({ ...ctx, endian: e, le });
      }
      case "strict": {
        const sv = c.fresh("st");
        c.line(`bool ${sv} = ${r}.Strict;`);
        c.line(`${r}.Strict = true;`);
        const v = capture(ctx);
        c.line(`${r}.Strict = ${sv};`);
        return v;
      }
    }
  }

  /** A codec layer: decode, then read the decoded bytes as their own region. */
  private emitVia(
    layers: readonly IrLayer[],
    idx: number,
    ctx: RCtx,
    next: (ctx: RCtx) => string,
    slot: string
  ): string {
    const c = this.code;
    const r = ctx.r;
    const l = layers[idx] as Extract<IrLayer, { kind: "via" }>;
    const codec = this.model.codec(l.codec);
    const cctx = this.codecCtx(layers, idx, ctx);
    const impl = `${this.mod.extern(l.codec)}, ${str(codec.name)}`;
    const reuseSlot = str(`${slot}#${idx}`);
    if (ctx.scan && !codec.streaming) {
      // Views: the region is decoded once per view and scanned as its own byte space.
      const rs = c.fresh("rs");
      const re = c.fresh("re");
      c.line(`int ${rs} = ${r}.Pos, ${re} = ${r}.End;`);
      c.line(`${r}.Pos = ${r}.End;`);
      const rr = c.fresh("rr");
      const nn = c.fresh("nn");
      const inner = this.lambda(
        () => {
          const v = next({ ...ctx, r: rr, node: nn });
          return v === "" ? "0" : v;
        },
        { params: `Rt.Reader ${rr}, Rt.ViewNode ${nn}` }
      );
      const t = c.fresh("t");
      c.line(
        `var ${t} = Rt.Views.LoadRegion(${ctx.node}, ${rs}, ${re}, ${impl}, ${cctx}, ${codec.async}, ${reuseSlot}, ${inner}, ${codec.ranged && !codec.async});`
      );
      return t;
    }
    if (ctx.scan) {
      // A streaming codec in a view: decoded now, its content read untracked.
      c.line(`Rt.Views.Opaque(${ctx.node}, 0);`);
      ctx = { ...ctx, scan: false };
    }
    const s = c.fresh("s");
    const input = c.fresh("in");
    const d = c.fresh("d");
    c.line(`int ${s} = ${r}.Pos;`);
    c.line(`var ${input} = ${r}.Peek(${r}.Pos, ${r}.End);`);
    if (codec.async && !ctx.async) throw new Error(`async codec ${codec.name} in a sync reader`);
    const call = `Rt.Codecs.Decode${codec.async ? "Async" : ""}(${impl}, ${input}, ${cctx}, ${codec.streaming}, ${r}.At(${s}))`;
    c.line(`var ${d} = ${codec.async ? "await " : ""}${call};`);
    const sr = c.fresh("sr");
    c.line(`var ${sr} = ${r}.Decoded(${d}.Output, ${s});`);
    const v = next({ ...ctx, r: sr });
    if (v === "") {
      c.line(`${r}.Pos = ${s} + ${d}.Consumed;`);
      return v;
    }
    const t = c.fresh("t");
    c.line(`var ${t} = ${v};`);
    c.line(`${r}.Pos = ${s} + ${d}.Consumed;`);
    c.line(
      `Rt.Codecs.Remember(${t}, ${reuseSlot}, ${input}.Slice(0, ${d}.Consumed), ${d}.Output);`
    );
    return t;
  }

  /**
   * `align`/`alignEnd` padding (no trailing `;`). With an origin or offset:
   * `(pos - origin + offset) % to == 0`, the origin being the base or the byte space's start.
   */
  private alignCall(
    l: Extract<IrLayer, { kind: "align" | "alignEnd" }>,
    ctx: RCtx,
    strict: string
  ): string {
    const r = ctx.r;
    const to = this.num(l.to, ctx);
    const fill = this.fill(l.fill, ctx);
    if (l.from !== "file" && !l.offset) return `${r}.Align(${to}, ${fill}, ${strict})`;
    const off = l.offset ? this.num(l.offset, ctx) : "0L";
    return `${r}.AlignAt(${to}, ${fill}, ${strict}, ${l.from === "file"}, ${off})`;
  }
}

/** A primitive read: `__r.U32(le)`, `__r.U8()`. */
function prim(p: string, le: string, r: string): string {
  return p === "u8" || p === "i8" ? `${r}.${p.toUpperCase()}()` : `${r}.${p.toUpperCase()}(${le})`;
}

/** The empty value of an array, bytes or string type (for `@nullable(empty)`). */
function emptyValue(t: IrType, types: Types): string {
  const x = stripLayers(t);
  if (x.kind === "bytes") return "System.Array.Empty<byte>()";
  if (x.kind === "string") return '""';
  return `new ${types.type(x)}()`;
}
