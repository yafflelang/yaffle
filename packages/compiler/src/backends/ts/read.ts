/**
 * Reader emitter: one `read_X` function per struct (plus `readAsync_X` for async structs),
 * imperative code over `$rt.Reader` following docs/IR.md §2.
 */
import type {
  IrBits,
  IrExpr,
  IrField,
  IrFill,
  IrLayer,
  IrLength,
  IrMember,
  IrStreamExpr,
  IrStruct,
  IrType,
  IrValueType
} from "../../ir/index.ts";
import { Code, group, ident, prop, str, ungroup } from "./code.ts";
import { ExprCompiler, constCtx, formatInt, type CExpr, type ExprCtx } from "./expr.ts";
import {
  Model,
  decodedSizeLayer,
  isOneWay,
  literalInt,
  primIsBig,
  primSize,
  readSideExtents,
  someExpr,
  stripLayers,
  usesIndex,
  valueTypeOf
} from "./model.ts";
import type { ModuleCtx } from "./module.ts";
import type { TypeEmitter } from "./types.ts";

export interface RCtx {
  s: IrStruct;
  /** Reader variable. */
  r: string;
  endian: string;
  le: string;
  async: boolean;
  /** Code of `$index`. */
  index: string;
  /** Array nesting depth (path index variables `$i0`, `$i1`, …). */
  depth: number;
  /** Code of `it` when compiling checks and transforms. */
  it?: { code: string; type: IrValueType } | undefined;
  /** Lambda parameter names → code. */
  lambdas?: Map<string, string> | undefined;
  /** Field slot (for codec-reuse keys). */
  slot: string;
  /** View scan mode: composite children stay lazy and field ranges are recorded. */
  scan: boolean;
  /** Path segments code for child views created here (scan mode). */
  seg: string;
  /** The field being read (scan mode). */
  field?: string | undefined;
  /** Where the field's value goes (pointers with `@origin` assign it after the members). */
  lvalue?: string | undefined;
}

interface StructState {
  /** Locals holding the values of fields that are not part of the output. */
  hidden: Map<string, string>;
  /** Locals holding the start and end of fields whose extent expressions use. */
  extents: Map<string, { start: string; end: string }>;
  /** Fields whose extent read-side expressions use. */
  needExtent: Set<string>;
  /** Array nesting depth reached (path index variables `$i0`, `$i1`, …). */
  maxDepth: number;
  /** Statements run after the members (pointers with `@origin`). */
  deferred: string[];
}

function freshState(needExtent: Set<string>): StructState {
  return { hidden: new Map(), extents: new Map(), needExtent, maxDepth: 0, deferred: [] };
}

export class ReadEmitter {
  readonly model: Model;
  readonly x: ExprCompiler;
  readonly types: TypeEmitter;
  readonly mod: ModuleCtx;
  private st!: StructState;
  private code!: Code;

  private lastRaw: string | undefined;

  /** Encoder for patching elements of lazy scalar arrays in place (set by the backend). */
  elementEncoder:
    ((s: IrStruct, t: IrType, field: string | undefined) => string | undefined) | undefined;

  constructor(model: Model, x: ExprCompiler, types: TypeEmitter, mod: ModuleCtx) {
    this.model = model;
    this.x = x;
    this.types = types;
    this.mod = mod;
  }

  /** Emits `read_X` (or `readAsync_X`, or the view scanner `scan_X`). */
  emitStruct(out: Code, s: IrStruct, async: boolean, scan = false): void {
    const name = this.model.structName(s.id);
    this.st = freshState(readSideExtents(s));
    const body = new Code();
    this.code = body;
    const ctx: RCtx = {
      s,
      r: "$r",
      endian: "endian",
      le: "$le",
      async,
      index: "$index",
      depth: 0,
      slot: name,
      scan,
      seg: "[$f]"
    };
    for (const f of this.model.fields(s)) {
      if (f.field && !f.field.output) this.st.hidden.set(f.name, `$h_${ident(f.name)}`);
    }
    this.emitMembers(s.members, ctx);
    // A base's `@alignEnd` pads its whole region (after its targets), counted from its own start.
    const tail = body.child();
    const ends = s.base ? s.layers.filter(l => l.kind === "alignEnd") : [];
    if (ends.length) {
      this.code = tail;
      if (scan) tail.line(`$r.inlineEnd = $r.pos;`);
      tail.line(`$r.pos = Math.max($r.pos, $r.maxEnd);`);
      for (const l of ends) {
        if (l.kind === "alignEnd")
          tail.line(`${this.alignCall(l, ctx, l.strict ? "true" : "$r.strict")};`);
      }
      this.code = body;
    }

    const params = s.params.map(p => `${ident(p.name)}: ${this.paramType(p.type)}`);
    const fn = scan ? `scan_${name}` : async ? `readAsync_${name}` : `read_${name}`;
    const ret = scan ? "$rt.Scanned" : async ? `Promise<${name}>` : name;
    out.block(
      `export ${async ? "async " : ""}function ${fn}($r: $rt.Reader${params.map(p => ", " + p).join("")}): ${ret}`,
      () => {
        if (s.params.some(p => p.origin === "endian")) out.line(`const $le = endian === "le";`);
        // A pre-registered object (identity per address and type, cycles) or a fresh one.
        out.line(
          scan ? `const $v = {} as ${name}$R;` : `const $v = ($r.takeInto() ?? {}) as ${name}$R;`
        );
        if (scan) out.line(`const $R: $rt.Ranges = {};`);
        if (usesIndex(s)) out.line(`const $index = $r.index;`);
        for (const [fname, local] of this.st.hidden) {
          const f = this.model.field(s, fname)!.field!;
          out.line(`let ${local}!: ${this.types.type(f.type, "out")};`);
        }
        for (const [n, e] of this.st.extents) {
          out.line(
            n === "this"
              ? `const ${e.start} = $r.pos, ${e.end} = -1;`
              : `let ${e.start} = -1, ${e.end} = -1;`
          );
        }
        out.line(`let $f = "";`);
        for (let i = 0; i < this.st.maxDepth; i++) out.line(`let $i${i} = -1;`);
        const idx = Array.from({ length: this.st.maxDepth }, (_, i) => `, $i${i}`).join("");
        if (s.base) {
          out.line(`const $base = $r.base;`);
          out.line(`const $max = $r.maxEnd;`);
          out.line(`$r.base = $r.pos;`);
          out.line(`$r.maxEnd = $r.pos;`);
        }
        out.chain([
          [
            "try",
            () => {
              out.append(body);
              for (const d of this.st.deferred) out.line(d);
              if (ends.length) out.line(`$f = "";`);
              out.append(tail);
            }
          ],
          ["catch ($e)", () => out.line(`$rt.rethrowAt($e, $f${idx});`)]
        ]);
        if (s.base) {
          if (scan && !ends.length) out.line(`$r.inlineEnd = $r.pos;`);
          out.line(`$r.pos = Math.max($r.pos, $r.maxEnd);`);
          out.line(`$r.base = $base;`);
          out.line(`$r.maxEnd = Math.max($max, $r.pos);`);
        }
        out.line(scan ? "return [$v, $R];" : `return $v as unknown as ${name};`);
      }
    );
  }

  paramType(t: IrValueType): string {
    return this.types.valueType(t, "out");
  }

  /** Emits the read of a root struct (params are locals named after them); returns the value expression. */
  rootRead(out: Code, s: IrStruct, async: boolean): string {
    this.st = freshState(new Set());
    this.code = out;
    const ctx: RCtx = {
      s,
      r: "$r",
      endian: "endian",
      le: "$le",
      async,
      index: "-1",
      depth: 0,
      slot: this.model.structName(s.id),
      scan: false,
      seg: "[]"
    };
    const args: IrExpr[] = s.params.map(p => ({ kind: "param", name: p.name, type: p.type }));
    return this.struct(s.id, args, ctx);
  }

  // ── expression context ────────────────────────────────────────────────────

  exprCtx(ctx: RCtx): ExprCtx {
    const s = ctx.s;
    return {
      mode: "read",
      field: (name, type) => {
        const hidden = this.st.hidden.get(name);
        if (hidden) return this.x.typed(hidden, type);
        if (ctx.scan && this.lazyField(s, name))
          return this.x.typed(`$rt.force(${prop("$v", name)})`, type);
        return this.x.typed(prop("$v", name), type);
      },
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
        if (name === "offset") return `(${ctx.r}.pos - ${ctx.r}.base)`;
        if (name === "end") return `(${ctx.r}.end - ${ctx.r}.base)`;
        return ctx.index;
      },
      sizeof: f => {
        const e = this.extent(f);
        return `(${e.end} - ${e.start})`;
      },
      offsetof: f => {
        const e = this.extent(f);
        return `(${e.start} - ${ctx.r}.base)`;
      },
      encodedSize: f => {
        const e = this.extent(f);
        return `(${e.end} - ${e.start})`;
      },
      bytesof: f => {
        const e = this.extent(f);
        return `${ctx.r}.peekBytes(${e.start}, ${e.end})`;
      },
      encode: f => {
        const e = this.extent(f);
        return `${ctx.r}.peekBytes(${e.start}, ${e.end})`;
      },
      externFn: id => this.mod.extern(id),
      hoist: (code, hint) => this.mod.hoist(code, hint),
      fieldType: name => this.model.field(s, name)?.field?.type
    };
  }

  private extent(f: string): { start: string; end: string } {
    let e = this.st.extents.get(f);
    if (!e) {
      e = { start: `$s_${ident(f)}`, end: `$e_${ident(f)}` };
      this.st.extents.set(f, e);
    }
    return e;
  }

  expr(e: IrExpr, ctx: RCtx): CExpr {
    return this.x.compile(e, this.exprCtx(ctx));
  }

  num(e: IrExpr, ctx: RCtx, what = "value"): string {
    const c = this.expr(e, ctx);
    return what === "length" ? this.x.asLen(c) : this.x.asOffset(c);
  }

  len(e: IrExpr, ctx: RCtx): string {
    return this.x.asLen(this.expr(e, ctx));
  }

  /** A count read from the data: EOF if the region cannot hold that many units. */
  count(e: IrExpr, ctx: RCtx, unit: number): string {
    const lit = literalInt(e);
    if (lit !== undefined && lit >= 0) return String(lit);
    return `${ctx.r}.count(${this.expr(e, ctx).code}, ${unit})`;
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
        case "block": {
          const c = this.code;
          const body = (): void => {
            this.emitLayers(
              m.layers,
              m.layers.length - 1,
              ctx,
              inner => {
                this.emitMembers(m.members, inner);
                return "undefined";
              },
              `${ctx.slot}.block`
            );
          };
          if (m.condition) {
            const cond = this.expr(m.condition, ctx).code;
            const parts: [string, () => void][] = [[`if (${ungroup(cond)})`, body]];
            const els = m.else;
            if (els) parts.push(["else", () => this.emitMembers(els, ctx)]);
            c.chain(parts);
          } else c.block("", body);
          break;
        }
        case "switch": {
          const c = this.code;
          const d = c.fresh("$d");
          const disc = this.expr(m.discriminant, ctx);
          c.line(`const ${d} = ${disc.code};`);
          const dExpr: CExpr = { ...disc, code: d };
          const parts: [string, () => void][] = [];
          for (const cs of m.cases) {
            const conds = cs.values.map(v =>
              this.x.equality("==", dExpr, this.x.literal(v, m.discriminant.type, this.constCtx))
            );
            parts.push([
              `${parts.length ? "else if" : "if"} (${conds.join(" || ")})`,
              () => this.emitMembers(cs.members, ctx)
            ]);
          }
          const def = m.default;
          const fail = (): void => {
            c.line(`${ctx.r}.fail("CHECK", \`no case matches \${String(${d})}\`);`);
          };
          const last = def ? () => this.emitMembers(def, ctx) : fail;
          if (parts.length) c.chain([...parts, ["else", last]]);
          else if (def) c.block("", last);
          else last();
          break;
        }
      }
    }
  }

  private get constCtx(): ExprCtx {
    return constCtx(this.mod);
  }

  strictCode(ctx: RCtx): string {
    return ctx.s.strict ? "true" : `${ctx.r}.strict`;
  }

  private target(f: IrField): string {
    return this.st.hidden.get(f.name) ?? prop("$v", f.name);
  }

  emitField(f: IrField, ctx: RCtx): void {
    const c = this.code;
    c.line(`$f = ${str(f.name)};`);
    const fctx: RCtx = {
      ...ctx,
      slot: `${ctx.s.id}.${f.name}`,
      seg: ctx.scan ? `[${str(f.name)}]` : ctx.seg,
      field: f.name
    };
    if (f.virtual) {
      // `virtual u40 size = …`: no bytes; the value is computed here.
      const tgtV = this.target(f);
      const vtV = valueTypeOf(this.model, f.type);
      const v = this.expr(f.virtual.read, fctx);
      c.line(`${tgtV} = ${this.x.toChecked(v, vtV, `virtual ${f.name}`)};`);
      this.emitChecks(f.checks, f.type, tgtV, `${ctx.r}.pos`, ctx);
      return;
    }
    const ext = this.st.needExtent.has(f.name) ? this.extent(f.name) : undefined;
    const needStart = f.checks.length > 0 || ext !== undefined || (ctx.scan && !f.from);
    let start = `${ctx.r}.pos`;
    if (needStart && !f.placement) {
      start = ext ? ext.start : c.fresh("$s");
      c.line(ext ? `${start} = ${ctx.r}.pos;` : `const ${start} = ${ctx.r}.pos;`);
    }
    const tgt = this.target(f);
    const fType = this.types.type(f.type, "out");
    if (f.placement) {
      let off = this.num(f.placement.offset, ctx);
      // `@nullable(empty)`: offset 0 reads as an empty array.
      const emptyNull = f.placement.emptyIsNull === true;
      if (emptyNull) {
        const o = c.fresh("$o");
        c.line(`const ${o} = ${off};`);
        off = o;
      }
      const addr = c.fresh("$at");
      c.line(`const ${addr} = ${ctx.r}.base + ${off};`);
      const orEmpty = (x: string): string =>
        emptyNull ? `${off} === 0 ? ${emptyValue(f.type)} : ${x}` : x;
      if (ext) c.line(`${ext.start} = ${addr};`);
      start = addr;
      const key = this.targetKey(f.type, ctx);
      if (ctx.scan) {
        const v = this.inClosure(f.type, { ...fctx, r: "$r2", seg: "[]" });
        c.line(
          `${tgt} = ${orEmpty(`$rt.lazyTarget(${ctx.r}, ${addr}, ${key}, ($r2) => ${v}, [${str(f.name)}])`)};`
        );
        c.line(`$R[${str(f.name)}] = [${addr}, ${addr}];`);
      } else {
        const v = this.inClosure(f.type, fctx);
        const m = targetMethod(f.type);
        if (ctx.async)
          c.line(
            `${tgt} = ${orEmpty(`await ${ctx.r}.${m}Async(${addr}, ${key}, async () => ${v})`)};`
          );
        else c.line(`${tgt} = ${orEmpty(`${ctx.r}.${m}(${addr}, ${key}, () => ${v})`)};`);
      }
      if (ext) {
        const size = this.model.staticSize(f.type);
        c.line(
          `${ext.end} = ${size !== undefined ? `${addr} + ${size}` : `${ctx.r}.lastTargetEnd`};`
        );
      }
    } else if (f.from) {
      const stream = this.stream(f.from.stream, ctx);
      if (ctx.scan) {
        // Views read from the stream lazily: only the pieces a read touches are decoded.
        const v = this.inClosure(f.type, { ...fctx, r: "$r2", seg: "[]" });
        c.line(
          `${tgt} = $rt.lazyStream(${ctx.r}, ${str(`${ctx.s.id}.${f.name}`)}, () => ${stream}, ${ctx.r}.strict, ($r2) => ${v}, [${str(f.name)}]) as ${fType};`
        );
      } else {
        const sr = c.fresh("$sr");
        c.line(`const ${sr} = ${ctx.r}.sub(${stream});`);
        const v = this.read(f.type, { ...fctx, r: sr });
        c.line(`${tgt} = ${v};`);
      }
    } else {
      this.lastRaw = undefined;
      const v = this.read(f.type, { ...fctx, lvalue: f.type.kind === "pointer" ? tgt : undefined });
      c.line(`${tgt} = ${v};`);
      // One-way transforms: canonical JSON shows the raw value.
      if (this.lastRaw && isOneWay(f.type) && f.output)
        c.line(`$rt.setRaw($v, ${str(f.name)}, ${this.lastRaw});`);
      // Hidden stream pieces stay reachable for the parent's `from arr[*].piece`.
      const piece = this.model.streamPieces.has(`${ctx.s.id}.${f.name}`);
      if (!f.output && piece) {
        c.line(`$rt.setHidden($v, ${str(f.name)}, ${tgt});`);
      }
      // Views: a piece's decoded length, when the schema reads it (`@size(exp) @via(zstd)`),
      // maps stream offsets to pieces without decoding them.
      if (ctx.scan && piece) {
        const n = this.pieceLength(f.type, ctx);
        if (n !== undefined) c.line(`$rt.knownLength(${tgt}, ${n});`);
      }
      if (ext) c.line(`${ext.end} = ${ctx.r}.pos;`);
      if (ctx.scan) c.line(`$R[${str(f.name)}] = [${start}, ${ctx.r}.pos];`);
    }
    const checkValue = ctx.scan && this.lazyField(ctx.s, f.name) ? `$rt.force(${tgt})` : tgt;
    this.emitChecks(f.checks, f.type, checkValue, start, ctx);
  }

  /** In scan mode, values of this field may be `Lazy` (bytes, targets, codec regions, streams). */
  lazyField(s: IrStruct, name: string): boolean {
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
        `if (${guard}!${group(cond)}) ${ctx.r}.checkFail(${str(ch.message)}, ${start});`
      );
    }
  }

  /** Emits whatever `f` emits inside an arrow function body; `f` returns the result expression. */
  private closureOf(f: () => string): string {
    const saved = this.code;
    const inner = saved.child();
    this.code = inner;
    const v = f();
    this.code = saved;
    if (inner.empty) return v;
    const body = new Code();
    body.line("{");
    body.indent(() => {
      body.append(inner);
      body.line(`return ${v};`);
    });
    body.line("}");
    return body.toString();
  }

  /** Emits the read of `t` inside an arrow function body; returns the function body text. */
  private inClosure(t: IrType, ctx: RCtx): string {
    return this.closureOf(() => this.read(t, ctx));
  }

  /** A stream's bytes (parse), or a byte store over them (scan: decoded on demand). */
  private stream(s: IrStreamExpr, ctx: RCtx): string {
    switch (s.kind) {
      case "field": {
        const f = this.model.field(ctx.s, s.field);
        if (!f?.field) throw new Error(`unknown stream field ${s.field}`);
        return ctx.scan ? `$rt.streamOf(${this.target(f.field)})` : this.target(f.field);
      }
      case "each": {
        const f = this.model.field(ctx.s, s.array);
        if (!f?.field) throw new Error(`unknown stream array ${s.array}`);
        if (ctx.scan) return `$rt.viewPieces(${this.target(f.field)}, ${str(s.field)})`;
        return `$rt.joinStream($rt.pieces(${this.target(f.field)}, ${str(s.field)}))`;
      }
      case "slice": {
        const inner = this.stream(s.stream, ctx);
        const a = this.num(s.start, ctx);
        const b = s.end ? this.num(s.end, ctx) : undefined;
        const fn = ctx.scan ? "$rt.streamSlice" : "$rt.sliceStream";
        return `${fn}(${inner}, ${a}${b !== undefined ? `, ${b}` : ""})`;
      }
    }
  }

  /**
   * The decoded length of a stream piece, from earlier fields, when the read states it: a counted
   * `u8[n]`, or `u8[]` inside `@size(n)` (the innermost layer, under any codec). Undefined
   * when only decoding tells.
   */
  private pieceLength(t: IrType, ctx: RCtx): string | undefined {
    let inner = t;
    let first: IrLayer | undefined;
    if (t.kind === "layered") {
      inner = t.inner;
      first = t.layers[0];
    }
    if (inner.kind !== "bytes") return undefined;
    let e: IrExpr | undefined;
    if (inner.length.kind === "count") e = inner.length.expr;
    else if (inner.length.kind === "rest" && first?.kind === "size") e = first.size;
    if (!e) return undefined;
    const positional = someExpr(e, x => x.kind === "builtinValue" && x.name !== "index");
    return positional ? undefined : this.len(e, ctx);
  }

  // ── types ─────────────────────────────────────────────────────────────────

  /** Emits statements for reading `t`; returns an expression to evaluate right after them. */
  read(t: IrType, ctx: RCtx): string {
    // Struct values pointers can target are one object per (address, type), inline elements
    // included.
    if (t.kind === "struct" && !ctx.scan && this.model.identityStructs.has(t.struct)) {
      const key = this.targetKey(t, ctx);
      const body = this.closureOf(() => this.readInner(t, ctx));
      return ctx.async
        ? `await ${ctx.r}.inlineAsync(${key}, async () => ${body})`
        : `${ctx.r}.inline(${key}, () => ${body})`;
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
        if (t.length.kind === "count") {
          return `${r}.str(${this.count(t.length.expr, ctx, t.unit)}, ${t.unit}, ${str(t.encoding)}, ${le})`;
        }
        if (t.length.kind === "until") return `${r}.strUntil(${t.unit}, ${str(t.encoding)}, ${le})`;
        return `${r}.strRest(${t.unit}, ${str(t.encoding)}, ${le})`;
      }
      case "bytes":
        if (ctx.scan && t.length.kind === "count")
          return `$rt.lazyBytes(${r}, ${this.count(t.length.expr, ctx, 1)})`;
        if (ctx.scan && t.length.kind === "rest") return `$rt.lazyRest(${r})`;
        if (t.length.kind === "count") return `${r}.bytes(${this.count(t.length.expr, ctx, 1)})`;
        if (t.length.kind === "until")
          return `${r}.bytesUntil(${this.x.asNum(this.expr(t.length.terminator, ctx))})`;
        return `${r}.bytesRest()`;
      case "array":
        return this.array(t, ctx);
      case "struct":
        return this.struct(t.struct, t.args, ctx);
      case "enum": {
        const en = this.model.enum(t.enum);
        const s = c.fresh("$s");
        c.line(`const ${s} = ${r}.pos;`);
        const raw = this.prim(en.storage, this.leOf(t.endian, ctx), r);
        return `$rt.enumRead(${this.mod.enumRef(t.enum, "names")}, ${raw}, ${en.open}, ${r}, ${s})`;
      }
      case "pointer":
        return this.pointer(t, ctx);
      case "extern": {
        const x = this.model.extern(t.extern);
        const args = this.x.args(t.args, x.params, this.exprCtx(ctx));
        const fixed = x.kind === "type" && x.fixedSize !== undefined ? `, ${x.fixedSize}` : "";
        const call = `${r}.extern(${this.mod.extern(t.extern)}, [${args.join(", ")}]${fixed})`;
        return x.kind === "type" ? this.hostValue(call, x.valueType) : call;
      }
      case "union": {
        const vctx: RCtx = { ...ctx, scan: false };
        const alts = t.variants.map(v => {
          const body = this.inClosure(v.type, vctx);
          return `[${str(v.name)}, ${ctx.async ? "async " : ""}() => ${body}]`;
        });
        const ut = this.types.type(t, "out");
        if (ctx.async) return `(await ${r}.unionAsync<unknown>([${alts.join(", ")}])) as ${ut}`;
        return `${r}.union<unknown>([${alts.join(", ")}]) as ${ut}`;
      }
      case "transform": {
        const it = c.fresh("$it");
        c.line(`const ${it} = ${this.read(t.inner, ctx)};`);
        if (!t.write) this.lastRaw = it;
        const ictx: RCtx = { ...ctx, it: { code: it, type: valueTypeOf(this.model, t.inner) } };
        const v = this.expr(t.read, ictx);
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

  /** Validates/converts a value returned by host code to its declared value type. */
  hostValue(code: string, t: IrValueType): string {
    if (t.kind === "int")
      return t.bits > 48
        ? `$rt.big(${code} as bigint | number)`
        : `$rt.num(${code} as bigint | number)`;
    if (t.kind === "float") return `Number(${code})`;
    return `(${code} as ${this.types.valueType(t, "out")})`;
  }

  leOf(e: "le" | "be" | "inherit", ctx: RCtx): string {
    return e === "inherit" ? ctx.le : e === "le" ? "true" : "false";
  }

  prim(p: string, le: string, r: string): string {
    switch (p) {
      case "u8":
        return `${r}.u8()`;
      case "i8":
        return `${r}.i8()`;
      case "u16":
      case "i16":
      case "u32":
      case "i32":
      case "u64":
      case "i64":
      case "f16":
      case "f32":
      case "f64":
      case "u56":
      case "i56":
        return `${r}.${p}(${le})`;
      case "u24":
      case "u40":
      case "u48":
        return `${r}.uN(${primSize(p)}, ${le})`;
      case "i24":
      case "i40":
      case "i48":
        return `${r}.iN(${primSize(p)}, ${le})`;
    }
    throw new Error(`unknown prim ${p}`);
  }

  struct(id: string, args: readonly IrExpr[], ctx: RCtx): string {
    const s = this.model.struct(id);
    const call = (inner: RCtx): string => {
      const argCode = this.x.args(args, s.params, this.exprCtx(inner));
      if (inner.scan) {
        const info = this.mod.structFn(id, "$view");
        return `$rt.child<${this.model.structName(id)}>(${inner.r}, ${info}, [${argCode.join(", ")}], () => ${inner.seg})`;
      }
      const fn = this.mod.structFn(id, s.async && inner.async ? "readAsync" : "read");
      const callExpr = `${fn}(${[inner.r, ...argCode].join(", ")})`;
      return s.async && inner.async ? `await ${callExpr}` : callExpr;
    };
    // A base's `@alignEnd` is applied inside its reader (relative to its own start).
    const layers = s.base ? s.layers.filter(l => l.kind !== "alignEnd") : s.layers;
    if (!layers.length) return call(ctx);
    return this.emitLayers(layers, layers.length - 1, ctx, call, `${ctx.slot}#${s.name}`);
  }

  private array(t: Extract<IrType, { kind: "array" }>, ctx: RCtx): string {
    if (ctx.scan) {
      const es = this.model.staticSize(t.element);
      if (t.length.kind === "count" && !t.elementPlacement && es !== undefined && es > 0) {
        const n = this.code.fresh("$n");
        this.code.line(`const ${n} = ${this.count(t.length.expr, ctx, es)};`);
        const ectx: RCtx = { ...ctx, r: "$r2", index: "$i", seg: `[...${ctx.seg}, $i]` };
        const body = this.inClosure(t.element, ectx);
        const elemType = this.types.type(t.element, "out");
        const enc = this.elementEncoder?.(ctx.s, t.element, ctx.field) ?? "undefined";
        return `$rt.lazyArray<${elemType}>(${ctx.r}, ${n}, ${es}, ($r2: $rt.Reader, $i: number) => ${body}, ${enc}, () => ${ctx.seg})`;
      }
      if (t.elementPlacement && (t.length.kind === "count" || t.length.kind === "rest")) {
        // Elements at their own offsets: counted from the offsets alone, read on access.
        const place = t.elementPlacement;
        const n = t.length.kind === "count" ? this.len(t.length.expr, ctx) : "undefined";
        const off = this.closureOf(() => this.num(place, { ...ctx, index: "$i" }));
        const ectx: RCtx = { ...ctx, r: "$r2", index: "$i", seg: `[...${ctx.seg}, $i]` };
        const body = this.inClosure(t.element, ectx);
        const elemType = this.types.type(t.element, "out");
        return `$rt.placedArray<${elemType}>(${ctx.r}, ${n}, ($i: number) => ${off}, ($r2: $rt.Reader, $i: number) => ${body}, () => ${ctx.seg})`;
      }
      const a = this.arrayLoop(t, ctx);
      return `$rt.arrayOf(${a}, () => ${ctx.seg})`;
    }
    return this.arrayLoop(t, ctx);
  }

  private arrayLoop(t: Extract<IrType, { kind: "array" }>, ctx: RCtx): string {
    const c = this.code;
    const r = ctx.r;
    const depth = ctx.depth;
    this.st.maxDepth = Math.max(this.st.maxDepth, depth + 1);
    const a = c.fresh("$a");
    const i = c.fresh("$i");
    const elemType = this.types.type(t.element, "out");
    const ectx: RCtx = {
      ...ctx,
      index: i,
      depth: depth + 1,
      seg: ctx.scan ? `[...${ctx.seg}, ${i}]` : ctx.seg
    };
    const setIndex = this.model.elementUsesIndex(t.element);
    c.line(`const ${a}: ${/[|&]/.test(elemType) ? `(${elemType})` : elemType}[] = [];`);
    const savedIndex = setIndex ? c.fresh("$ix") : "";
    if (setIndex) c.line(`const ${savedIndex} = ${r}.index;`);
    const loopBody = (pre: () => void, read: () => string, post?: (el: string) => void): void => {
      pre();
      c.line(`$i${depth} = ${i};`);
      if (setIndex) c.line(`${r}.index = ${i};`);
      const v = read();
      if (post) post(v);
      else c.line(`${a}.push(${v});`);
    };
    if (t.elementPlacement) {
      const place = t.elementPlacement;
      const readAt = (): string => {
        const off = this.num(place, ectx);
        const addr = c.fresh("$at");
        c.line(`const ${addr} = ${r}.base + ${off};`);
        if (t.length.kind === "rest") c.line(`if (${addr} >= ${r}.end) break;`);
        const body = this.inClosure(t.element, ectx);
        return ctx.async
          ? `await ${r}.peekAtAsync(${addr}, async () => ${body})`
          : `${r}.peekAt(${addr}, () => ${body})`;
      };
      if (t.length.kind === "count") {
        const n = c.fresh("$n");
        c.line(`const ${n} = ${this.len(t.length.expr, ctx)};`);
        c.block(`for (let ${i} = 0; ${i} < ${n}; ${i}++)`, () => loopBody(() => {}, readAt));
      } else if (t.length.kind === "rest") {
        c.block(`for (let ${i} = 0; ; ${i}++)`, () => loopBody(() => {}, readAt));
      } else {
        const len = t.length;
        c.block(`for (let ${i} = 0; ; ${i}++)`, () =>
          loopBody(
            () => {},
            readAt,
            el => this.terminated(len, t.element, el, a, undefined, ctx)
          )
        );
      }
    } else if (t.length.kind === "count") {
      const n = c.fresh("$n");
      const es = this.model.staticSize(t.element);
      c.line(`const ${n} = ${this.count(t.length.expr, ctx, es ?? 1)};`);
      c.block(`for (let ${i} = 0; ${i} < ${n}; ${i}++)`, () =>
        loopBody(
          () => {},
          () => this.read(t.element, ectx)
        )
      );
    } else if (t.length.kind === "rest") {
      c.block(`for (let ${i} = 0; ${r}.pos < ${r}.end; ${i}++)`, () =>
        loopBody(
          () => {},
          () => this.read(t.element, ectx)
        )
      );
    } else {
      const len = t.length;
      const p = c.fresh("$p");
      c.block(`for (let ${i} = 0; ; ${i}++)`, () =>
        loopBody(
          () => c.line(`const ${p} = ${r}.pos;`),
          () => this.read(t.element, ectx),
          el => this.terminated(len, t.element, el, a, p, ctx)
        )
      );
    }
    if (setIndex) c.line(`${r}.index = ${savedIndex};`);
    c.line(`$i${depth} = -1;`);
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
    const e = c.fresh("$el");
    c.line(`const ${e} = ${el};`);
    const vt = valueTypeOf(this.model, elem);
    if (len.kind === "untilPredicate") {
      c.line(`${a}.push(${e});`);
      const cond = this.expr(len.predicate, { ...ctx, it: { code: e, type: vt } }).code;
      c.line(`if (${cond}) break;`);
      return;
    }
    if (len.kind !== "until" && len.kind !== "before")
      throw new Error(`unexpected length ${len.kind}`);
    const eq = this.x.equality("==", this.x.typed(e, vt), this.expr(len.terminator, ctx));
    if (len.kind === "before" && pos)
      c.block(`if (${eq})`, () => c.line(`${ctx.r}.pos = ${pos};`).line("break;"));
    else c.line(`if (${eq}) break;`);
    c.line(`${a}.push(${e});`);
  }

  private pointer(t: Extract<IrType, { kind: "pointer" }>, ctx: RCtx): string {
    const c = this.code;
    const r = ctx.r;
    const big = primIsBig(t.storage);
    const at = c.fresh("$pa");
    if (t.relative) c.line(`const ${at} = ${r}.pos;`);
    const p = c.fresh("$p");
    c.line(`const ${p} = ${this.prim(t.storage, this.leOf(t.storageEndian, ctx), r)};`);
    const off = big ? `$rt.num(${p}, "pointer")` : p;
    // `@origin(expr)`: target = base + origin + value; the origin may use positions of later
    // fields, so a field's pointer is followed once the struct's members are read. (Elements of
    // an array of pointers are followed right away: their origin may only use earlier fields.)
    const origin = t.origin ? this.x.asOffset(this.expr(t.origin, ctx)) : undefined;
    const defer = origin !== undefined && ctx.lvalue !== undefined;
    const addr = t.relative
      ? `${at} + ${off}`
      : `${r}.base + ${origin !== undefined ? `${origin} + ` : ""}${off}`;
    const key = this.targetKey(t.target, ctx);
    const empty = t.emptyIsNull ? emptyValue(t.target) : "null";
    const wrap = (follow: string): string => {
      if (t.nullValue === undefined) return follow;
      const nv = big ? `${BigInt(t.nullValue)}n` : formatInt(BigInt(t.nullValue));
      return `${p} === ${nv} ? ${empty} : ${follow}`;
    };
    if (ctx.scan) {
      const lbody = this.inClosure(t.target, { ...ctx, r: "$r2", seg: "[]" });
      const seg = ctx.seg.startsWith("[") ? ctx.seg : "[]";
      const lazy = wrap(`$rt.lazyTarget(${r}, ${addr}, ${key}, ($r2) => ${lbody}, ${seg})`);
      if (!defer) return lazy;
      this.st.deferred.push(`$f = ${str(ctx.field ?? "")}; ${ctx.lvalue} = ${lazy};`);
      return "undefined as never";
    }
    const body = this.inClosure(t.target, { ...ctx, lvalue: undefined });
    const m = targetMethod(t.target);
    const follow = wrap(
      ctx.async
        ? `await ${r}.${m}Async(${addr}, ${key}, async () => ${body})`
        : `${r}.${m}(${addr}, ${key}, () => ${body})`
    );
    if (!defer) return follow;
    this.st.deferred.push(`$f = ${str(ctx.field ?? "")}; ${ctx.lvalue} = ${follow};`);
    return "undefined as never";
  }

  /** Identity key of a target: type key, plus argument values for parameterized structs. */
  targetKey(t: IrType, ctx: RCtx): string {
    let inner = t;
    while (inner.kind === "layered" || inner.kind === "transform") inner = inner.inner;
    // Layers don't change which value sits at an address: key by the type underneath.
    let keyed = t;
    while (keyed.kind === "layered") keyed = keyed.inner;
    const base = this.model.typeKey(keyed);
    // Same address, same type: arguments and lengths are part of the type.
    const exprs: IrExpr[] = [];
    if (inner.kind === "struct") exprs.push(...inner.args);
    if (
      (inner.kind === "bytes" || inner.kind === "string" || inner.kind === "array") &&
      inner.length.kind === "count"
    ) {
      exprs.push(inner.length.expr);
    }
    if (exprs.length) {
      const parts = exprs.map(a => `\${String(${this.expr(a, ctx).code})}`);
      return `\`${base.replace(/[`$\\]/g, "\\$&")}(${parts.join(",")})\``;
    }
    return str(base);
  }

  emitBits(b: IrBits, ctx: RCtx): void {
    const c = this.code;
    const size = primSize(b.storage);
    const u = c.fresh("$u");
    const s = c.fresh("$s");
    c.line(`const ${s} = ${ctx.r}.pos;`);
    c.line(`const ${u} = ${this.prim(b.storage, this.leOf(b.endian, ctx), ctx.r)};`);
    const big = primIsBig(b.storage);
    for (const f of b.fields) {
      const raw = extractBits(u, f.shift, f.width, size * 8, big);
      if (f.name === null) {
        c.line(
          `if (${this.strictCode(ctx)} && ${raw.code} !== ${raw.big ? "0n" : "0"}) ${ctx.r}.fail("CHECK", "reserved bits are not zero", ${s});`
        );
        continue;
      }
      c.line(`$f = ${str(f.name)};`);
      const val = this.bitValue(f.type, raw, f.width, ctx, s);
      const target = f.output ? prop("$v", f.name) : `$h_${ident(f.name)}`;
      if (!f.output) {
        this.st.hidden.set(f.name, target);
      }
      c.line(`${target} = ${val};`);
      if (ctx.scan) c.line(`$R[${str(f.name)}] = [${s}, ${s} + ${size}];`);
      this.emitChecks(f.checks, f.type, target, s, ctx);
    }
  }

  private bitValue(
    t: IrType,
    raw: { code: string; big: boolean },
    width: number,
    ctx: RCtx,
    start: string
  ): string {
    const inner = t.kind === "layered" ? t.inner : t;
    if (inner.kind === "bool") return `${raw.code} !== ${raw.big ? "0n" : "0"}`;
    if (inner.kind === "enum") {
      const en = this.model.enum(inner.enum);
      const v = raw.big && !primIsBig(en.storage) ? `Number(${raw.code})` : raw.code;
      return `$rt.enumRead(${this.mod.enumRef(inner.enum, "names")}, ${v}, ${en.open}, ${ctx.r}, ${start})`;
    }
    if (inner.kind === "prim") {
      const signed = inner.prim[0] === "i";
      const wantBig = primIsBig(inner.prim);
      let code = raw.code;
      if (raw.big && !wantBig) code = `Number(${code})`;
      if (!raw.big && wantBig) code = `BigInt(${code})`;
      if (signed) {
        if (wantBig) code = `BigInt.asIntN(${width}, ${code})`;
        else code = `$rt.signExtend(${code}, ${width})`;
      }
      return code;
    }
    if (inner.kind === "transform") {
      const it = this.code.fresh("$it");
      this.code.line(`const ${it} = ${this.bitValue(inner.inner, raw, width, ctx, start)};`);
      const v = this.expr(inner.read, {
        ...ctx,
        it: { code: it, type: valueTypeOf(this.model, inner.inner) }
      });
      return this.x.to(v, inner.valueType);
    }
    return raw.code;
  }

  // ── layers ────────────────────────────────────────────────────────────────

  /**
   * Emits layers `layers[idx]` (outermost) down to `layers[0]` around `inner`. Returns the
   * expression of the value (assigned to a temp when post-processing follows).
   */
  emitLayers(
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
    // `@padUntil(0x80, strict)`: this padding is checked even outside strict mode.
    const strict = "strict" in l && l.strict ? "true" : this.strictCode(ctx);
    const next = (x: RCtx): string => this.emitLayers(layers, idx - 1, x, inner, slot);
    const capture = (x: RCtx): string => {
      const v = next(x);
      if (v === "undefined") return v;
      const t = c.fresh("$t");
      c.line(`const ${t} = ${v};`);
      return t;
    };
    switch (l.kind) {
      case "align":
        c.line(`${this.alignCall(l, ctx, strict)};`);
        return next(ctx);
      case "padBefore":
        c.line(`${r}.pad(${this.len(l.count, ctx)}, ${this.fill(l.fill, ctx)}, ${strict});`);
        return next(ctx);
      case "padAfter": {
        const v = capture(ctx);
        c.line(`${r}.pad(${this.len(l.count, ctx)}, ${this.fill(l.fill, ctx)}, ${strict});`);
        return v;
      }
      case "padUntil": {
        const s = c.fresh("$s");
        c.line(`const ${s} = ${r}.pos;`);
        const v = capture(ctx);
        c.line(
          `${r}.padUntil(${s}, ${this.len(l.size, ctx)}, ${this.fill(l.fill, ctx)}, ${strict});`
        );
        return v;
      }
      case "alignEnd": {
        const v = capture(ctx);
        c.line(`${this.alignCall(l, ctx, strict)};`);
        return v;
      }
      case "size": {
        const w = c.fresh("$w");
        c.line(`const ${w} = ${r}.window(${this.len(l.size, ctx)});`);
        const v = capture(ctx);
        c.line(`${r}.closeWindow(${w}, ${strict});`);
        return v;
      }
      case "via": {
        const codec = this.model.codec(l.codec);
        const args = this.x.args(l.args, codec.params, this.exprCtx(ctx));
        const sizeLayer = decodedSizeLayer(layers, idx);
        const outSize = sizeLayer && this.len(sizeLayer.size, ctx);
        const ctxObj = `{ args: [${args.join(", ")}]${outSize !== undefined ? `, outputSize: ${outSize}` : ""} }`;
        if (ctx.scan) {
          // Views decode codec regions on access.
          const body = this.closureOf(() => next({ ...ctx, r: "$r2" }));
          const opts = `{ streaming: ${codec.streaming}, ranged: ${codec.ranged}, async: ${codec.async}, slot: ${str(`${slot}#${idx}`)} }`;
          return `$rt.lazyRegion(${r}, ${this.mod.extern(l.codec)}, ${str(codec.name)}, ${ctxObj}, ${opts}, ($r2) => ${body})`;
        }
        const s = c.fresh("$s");
        const input = c.fresh("$in");
        const d = c.fresh("$d");
        c.line(`const ${s} = ${r}.pos;`);
        c.line(`const ${input} = ${r}.peekBytes(${r}.pos, ${r}.end);`);
        const call = `$rt.decode${codec.async ? "Async" : ""}(${this.mod.extern(l.codec)}, ${str(codec.name)}, ${input}, ${ctxObj}, ${codec.streaming}, ${r}.at(${s}))`;
        if (codec.async && !ctx.async)
          throw new Error(`async codec ${codec.name} in a sync reader`);
        c.line(`const ${d} = ${codec.async ? "await " : ""}${call};`);
        const sr = c.fresh("$sr");
        c.line(`const ${sr} = ${r}.decoded(${d}.output, ${s});`);
        const v = next({ ...ctx, r: sr });
        const t = c.fresh("$t");
        c.line(`const ${t} = ${v};`);
        c.line(`${r}.pos = ${s} + ${d}.consumed;`);
        c.line(
          `$rt.rememberCodec(${t}, ${str(`${slot}#${idx}`)}, ${input}.subarray(0, ${d}.consumed), ${d}.output);`
        );
        return t;
      }
      case "endian": {
        const e = c.fresh("$e");
        const le = c.fresh("$le");
        c.line(`const ${e} = ${this.expr(l.value, ctx).code} as $rt.Endian;`);
        c.line(`const ${le} = ${e} === "le";`);
        return next({ ...ctx, endian: e, le });
      }
      case "strict": {
        const sv = c.fresh("$st");
        c.line(`const ${sv} = ${r}.strict;`);
        c.line(`${r}.strict = true;`);
        const v = capture(ctx);
        c.line(`${r}.strict = ${sv};`);
        return v;
      }
    }
  }

  /**
   * `align` / `alignEnd` padding (no trailing `;`). With an origin or offset:
   * `(pos - origin + offset) % to == 0`, the origin being the base or the byte space's start.
   */
  alignCall(
    l: Extract<IrLayer, { kind: "align" | "alignEnd" }>,
    ctx: RCtx,
    strict: string
  ): string {
    const r = ctx.r;
    const to = this.num(l.to, ctx);
    const fill = this.fill(l.fill, ctx);
    if (l.from !== "file" && !l.offset) return `${r}.align(${to}, ${fill}, ${strict})`;
    const origin = l.from === "file" ? "0" : `${r}.base`;
    const off = l.offset ? this.num(l.offset, ctx) : "0";
    return `${r}.alignAt(${to}, ${fill}, ${strict}, ${origin}, ${off})`;
  }

  fill(f: IrFill, ctx: RCtx): string {
    if (f.kind === "byte") return String(f.value);
    const p = ident(f.param);
    const lambdas = new Map(ctx.lambdas ?? []);
    lambdas.set(f.param, p);
    const body = this.expr(f.expr, { ...ctx, lambdas });
    return `(${p}: number) => ${this.x.asNum(body)}`;
  }
}

function extractBits(
  u: string,
  shift: number,
  width: number,
  storageBits: number,
  big: boolean
): { code: string; big: boolean } {
  if (big) {
    const mask = (1n << BigInt(width)) - 1n;
    const code = shift ? `((${u} >> ${shift}n) & ${mask}n)` : `(${u} & ${mask}n)`;
    return { code: width > 48 ? code : `Number(${code})`, big: width > 48 };
  }
  if (storageBits <= 32) {
    if (width >= 32 || (shift + width === 32 && shift > 0)) {
      return { code: `(${u} >>> ${shift})`, big: false };
    }
    const mask = `0x${(2 ** width - 1).toString(16)}`;
    return { code: shift ? `((${u} >>> ${shift}) & ${mask})` : `(${u} & ${mask})`, big: false };
  }
  const div = shift ? `Math.floor(${u} / ${2 ** shift})` : u;
  return { code: `(${div} % ${2 ** width})`, big: false };
}

/** The empty value of an array, bytes or string type (for `@nullable(empty)`). */
function emptyValue(t: IrType): string {
  const x = stripLayers(t);
  return x.kind === "bytes" ? "new Uint8Array(0)" : x.kind === "string" ? '""' : "[]";
}

/** Target reader method: structs are read into a pre-registered object (cycles). */
function targetMethod(t: IrType): "targetStruct" | "target" {
  return stripLayers(t).kind === "struct" ? "targetStruct" : "target";
}
