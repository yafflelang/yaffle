/**
 * Struct body lowering: fields (types, arrays, pointers, transforms, layers, placement, streams,
 * formulas, checks), bitfields, blocks, if/else, switch and layout. Pass A lowers everything the
 * read side needs in declaration order; pass B lowers write-side formulas (which may reference any
 * field) and checks; then derive.ts fills in derived fields.
 */
import type * as A from "./ast.ts";
import { someExpr, typeRefName, unparen, walkExpr } from "./ast.ts";
import { ATTRIBUTES } from "./attributes.ts";
import type { Ctx, TypeArgBinding } from "./ctx.ts";
import { newOutputs } from "./ctx.ts";
import { analyzeDerivations } from "./derive.ts";
import { removalFix, replaceFix, type Fix } from "./diagnostics.ts";
import type { BaseType, Elaborator } from "./elaborate.ts";
import { constInt } from "./elaborate.ts";
import {
  coerce,
  convertTo,
  errorExpr,
  isError,
  lowerExpr,
  lowerFieldRef,
  lowerInItems,
  lowerOperandIn,
  lowerRegex
} from "./expr.ts";
import type {
  IrBits,
  IrBitField,
  IrBlock,
  IrEndianSpec,
  IrExpr,
  IrField,
  IrLayer,
  IrLayoutItem,
  IrLiteral,
  IrMember,
  IrParam,
  IrPathSegment,
  IrPointerType,
  IrPrimKind,
  IrSourceRef,
  IrStreamExpr,
  IrStringType,
  IrStruct,
  IrSwitch,
  IrTransformType,
  IrType,
  IrValueType
} from "../ir/index.ts";
import { containsIt } from "../ir/walk.ts";
import { partRange, invertVirtual, type PartRange } from "./virtual.ts";
import { checkSliceCarriers, markSliceCarriers } from "./slices.ts";
import type { FieldResult, StructResult } from "./model.ts";
import { printExpr, printInItems, printIrExpr } from "./printer.ts";
import { widenLeft, type Span } from "./source.ts";
import type { CondFrame, FieldSym, ModuleInfo, StructSym } from "./symbols.ts";
import {
  BIGINT,
  BOOL,
  ENDIAN,
  ERROR_TYPE,
  PRIMS,
  coreType,
  displayValueType,
  intPrim,
  intType,
  isErrorType,
  isIntType,
  isIrField,
  lookupBuiltinType,
  valueTypeOf
} from "./types.ts";

export function lowerStructBody(
  el: Elaborator,
  sym: StructSym,
  typeArgs: TypeArgBinding[],
  key: string
): StructResult {
  const checking = typeArgs.length === 0;
  const ctx: Ctx = {
    module: sym.module,
    struct: sym,
    owner: sym,
    report: checking,
    record: checking,
    typeArgs: new Map(
      sym.typeParams.map((tp, i) => [tp, typeArgs[i]!] as const).filter(([, b]) => !!b)
    ),
    lambdas: new Map(),
    side: "read",
    position: 0,
    frames: [],
    guards: [],
    insideArray: false,
    out: newOutputs(),
    fieldTypes: new Map()
  };
  const id = key;
  const ir: IrStruct = {
    id,
    name: el.nameOf(id),
    module: sym.module.irPath,
    source: sourceRef(sym.module, sym.decl.span),
    params: [],
    members: [],
    base: false,
    strict: false,
    layers: [],
    async: false,
    usesEndian: false
  };
  if (sym.doc) ir.doc = sym.doc;
  const result: StructResult = {
    sym,
    typeArgs,
    key,
    id,
    name: ir.name,
    ir,
    out: ctx.out,
    fields: new Map(),
    paramDerivations: new Map(),
    streamFields: new Set(),
    hiddenCandidates: [],
    done: false
  };
  el.results.set(key, result);
  if (checking) el.model.structs.set(sym, result);
  const lowerer = new BodyLowerer(el, ctx, sym, result);
  lowerer.run();
  result.done = true;
  return result;
}

function sourceRef(mod: ModuleInfo, span: Span): IrSourceRef {
  const r = mod.file.rangeOf(span);
  return { module: mod.irPath, start: r.start, end: r.end };
}

interface Flags {
  hidden?: A.Attribute;
  relative?: A.Attribute;
  nullable?: { attr: A.Attribute; value: string; empty?: boolean };
  origin?: A.Attribute;
  ref?: A.Attribute;
  encoding?: "utf8" | "ascii" | "latin1";
  encodingAttr?: A.Attribute;
  split?: { attr: A.Attribute; policy: "fit" | "sizes" };
}

/** The struct a layout item's path is resolved in. */
interface LayoutScope {
  sym: StructSym;
  fields: Map<FieldSym, FieldResult>;
}

interface PendingField {
  sym: FieldSym;
  decl: A.FieldDecl;
  frames: CondFrame[];
  guards: Ctx["guards"];
  ir: IrField | IrBitField;
  base?: BaseType;
  /** Endianness of the primitive (for four-character code constants). */
  endian?: IrEndianSpec;
}

class BodyLowerer {
  private readonly el: Elaborator;
  private readonly ctx: Ctx;
  private readonly sym: StructSym;
  private readonly result: StructResult;
  private readonly fieldOf = new Map<A.FieldDecl, FieldSym>();
  private readonly pending: PendingField[] = [];
  private cursor = 0;
  private bitOrder: "lsb" | "msb" = "lsb";
  private layoutMember?: A.LayoutMember;
  private readonly origins = new Map<A.FieldDecl, { attr: A.Attribute; pointer: IrPointerType }>();

  constructor(el: Elaborator, ctx: Ctx, sym: StructSym, result: StructResult) {
    this.el = el;
    this.ctx = ctx;
    this.sym = sym;
    this.result = result;
    for (const f of sym.fields) this.fieldOf.set(f.decl, f);
  }

  private get checking(): boolean {
    return this.ctx.report;
  }

  run(): void {
    const { el, ctx, sym, result } = this;
    const ir = result.ir;
    if (ctx.record) {
      el.recordRef(ctx, sym.nameSpan, sym, true);
      for (const tp of sym.typeParams) el.recordRef(ctx, tp.nameSpan, tp, true);
    }
    const params: IrParam[] = [
      {
        name: "endian",
        type: ENDIAN,
        origin: "endian",
        default: { kind: "literal", value: { kind: "endian", value: "le" }, type: ENDIAN }
      }
    ];
    for (const p of sym.params) {
      if (this.checking) el.checkParam({ ...ctx, side: "const" }, p);
      const t = el.paramValueType(ctx, p);
      const ip: IrParam = { name: p.name, type: t, origin: p.bound ? "bound" : "explicit" };
      if (p.bound) ip.boundName = p.name;
      if (p.decl.default) {
        const d = lowerExpr(
          el,
          { ...ctx, side: "const", report: false, record: false },
          p.decl.default,
          t
        );
        if (!isError(d)) ip.default = d;
      }
      params.push(ip);
    }
    ir.params = params;
    // struct attributes (layers: the one nearest `{` is innermost)
    const layerAttrs: A.Attribute[] = [];
    for (const a of sym.decl.attrs) {
      const spec = ATTRIBUTES[a.name.name];
      if (!el.checkAttrTarget(ctx, a, "struct")) continue;
      if (!spec) continue;
      if (a.name.name === "base") ir.base = true;
      else if (a.name.name === "strict") ir.strict = true;
      else if (a.name.name === "bitorder") this.bitOrder = this.bitOrderArg(a) ?? "lsb";
      else if (spec.layer) layerAttrs.push(a);
    }
    ir.layers = this.containerLayers({ ...ctx, position: 0 }, layerAttrs, "struct");
    ir.members = this.lowerMembers(sym.decl.members, [], []);
    for (const p of this.pending) this.lowerWriteSide(p);
    for (const p of this.pending) {
      const o = this.origins.get(p.decl);
      if (!o) continue;
      const octx: Ctx = {
        ...this.fieldCtx(p.sym, p.frames, p.guards),
        side: "write",
        position: Number.MAX_SAFE_INTEGER
      };
      const arg = o.attr.args?.[0];
      const e = arg ? lowerExpr(el, octx, arg.value, BIGINT) : errorExpr();
      if (!isError(e) && !isIntType(e.type))
        el.report(
          octx,
          arg!.value.span,
          "invalid-attribute-argument",
          "@origin takes an integer offset (e.g. offsetof(values))."
        );
      else if (!isError(e)) o.pointer.origin = e;
    }
    // fields consumed by `from` streams are derived on write: a `from field` carrier leaves the
    // input; a `from arr[*].piece` array is split by the writer; a field read only through slices
    // is assembled from them (slices.ts).
    for (const fr of result.fields.values()) {
      if (!isIrField(fr.ir) || !fr.ir.from) continue;
      const s = fr.ir.from.stream;
      if (s.kind === "field") {
        result.streamFields.add(s.field);
        for (const c of result.fields.values())
          if (c.sym.name === s.field && isIrField(c.ir)) c.ir.input = "absent";
      } else if (s.kind === "each") result.streamFields.add(s.array);
    }
    this.deriveVirtualParts();
    const sliceCarriers = markSliceCarriers(el, ctx, result);
    analyzeDerivations(el, ctx, result);
    checkSliceCarriers(el, ctx, result, sliceCarriers);
    this.checkRestNotLast(sym.decl.members);
    if (this.layoutMember) {
      const layout = this.lowerLayout(this.layoutMember);
      if (layout) ir.layout = layout;
    }
    // record the derive display for constants / formulas
    for (const f of result.fields.values()) {
      if (f.ir.derive && !f.deriveDisplay) f.deriveDisplay = printIrExpr(f.ir.derive);
    }
  }

  private bitOrderArg(a: A.Attribute): "lsb" | "msb" | undefined {
    const v = a.args?.[0] && unparen(a.args[0].value);
    if (v && v.kind === "Name" && (v.name === "lsb" || v.name === "msb")) return v.name;
    this.el.report(
      this.ctx,
      a.span,
      "invalid-attribute-argument",
      "@bitorder takes `lsb` or `msb`."
    );
    return undefined;
  }

  private symOf(f: A.FieldDecl): FieldSym {
    const s = this.fieldOf.get(f);
    if (s) return s;
    // shouldn't happen: the binder saw every field
    return this.sym.fields[this.cursor]!;
  }

  private fieldCtx(fs: FieldSym, frames: CondFrame[], guards: Ctx["guards"]): Ctx {
    return {
      ...this.ctx,
      side: "read",
      position: fs.order,
      frames,
      guards,
      self: fs,
      fieldName: fs.name
    };
  }

  // ── member lists ─────────────────────────────────────────────────────────

  private lowerMembers(
    members: A.Member[],
    frames: CondFrame[],
    guards: Ctx["guards"]
  ): IrMember[] {
    const out: IrMember[] = [];
    for (let i = 0; i < members.length; i++) {
      const m = members[i]!;
      switch (m.kind) {
        case "FieldDecl": {
          if (m.bitWidth && !m.pointer) {
            const run: A.FieldDecl[] = [m];
            while (i + 1 < members.length) {
              const n = members[i + 1]!;
              if (n.kind !== "FieldDecl" || !n.bitWidth || n.pointer) break;
              run.push(n);
              i++;
            }
            out.push(...this.lowerCBitfields(run, frames, guards));
          } else {
            const f = this.lowerField(m, frames, guards);
            if (f) out.push(f);
          }
          break;
        }
        case "BitsMember":
          out.push(...this.lowerBitsBlock(m, frames, guards));
          break;
        case "BlockMember": {
          const position = this.nextOrder();
          const bctx: Ctx = { ...this.ctx, position, frames, guards };
          const layers = this.containerLayers(bctx, m.attrs, "block");
          const members = this.lowerMembers(m.members, frames, guards);
          out.push({ kind: "block", source: sourceRef(this.sym.module, m.span), members, layers });
          break;
        }
        case "IfMember":
          out.push(this.lowerIf(m, frames, guards));
          break;
        case "SwitchMember":
          out.push(...this.lowerSwitch(m, frames, guards));
          break;
        case "LayoutMember":
          if (this.layoutMember) {
            this.el.report(
              this.ctx,
              m.span,
              "duplicate-declaration",
              "A struct can have only one layout block."
            );
          } else this.layoutMember = m;
          break;
        case "StructDecl":
        case "EnumDecl":
        case "UnionDecl":
          break;
      }
    }
    return out;
  }

  /** Order of the next field to be declared (for block/if/switch read-side expressions). */
  private nextOrder(): number {
    return this.cursor < this.sym.fields.length
      ? this.sym.fields[this.cursor]!.order
      : this.sym.fields.length;
  }

  private lowerIf(m: A.IfMember, frames: CondFrame[], guards: Ctx["guards"]): IrBlock {
    const position = this.nextOrder();
    const cctx: Ctx = { ...this.ctx, position, frames, guards };
    let condition: IrExpr = errorExpr();
    if (m.condition) {
      condition = lowerExpr(this.el, cctx, m.condition, BOOL);
      if (!isError(condition) && condition.type.kind !== "bool") {
        this.el.report(
          cctx,
          m.condition.span,
          "type-mismatch",
          `A condition must be bool, but this is ${displayValueType(condition.type, this.el.displayName)}.`
        );
      }
    }
    const layers = this.containerLayers(cctx, m.attrs, "block");
    const thenGuards = m.condition ? [...guards, { expr: m.condition, positive: true }] : guards;
    const elseGuards = m.condition ? [...guards, { expr: m.condition, positive: false }] : guards;
    const members = this.lowerMembers(m.then, [...frames, { member: m, branch: 0 }], thenGuards);
    const block: IrBlock = {
      kind: "block",
      source: sourceRef(this.sym.module, m.span),
      condition,
      members,
      layers
    };
    if (m.else)
      block.else = this.lowerMembers(m.else, [...frames, { member: m, branch: 1 }], elseGuards);
    return block;
  }

  private lowerSwitch(m: A.SwitchMember, frames: CondFrame[], guards: Ctx["guards"]): IrMember[] {
    const { el } = this;
    const position = this.nextOrder();
    const sctx: Ctx = { ...this.ctx, position, frames, guards };
    const disc = m.discriminant ? lowerExpr(el, sctx, m.discriminant) : errorExpr();
    const sw: IrSwitch = {
      kind: "switch",
      source: sourceRef(this.sym.module, m.span),
      discriminant: disc,
      cases: []
    };
    if (disc.kind === "field") sw.discriminantField = disc.name;
    if (
      !isError(disc) &&
      !["int", "bigint", "string", "bytes", "bool", "enum"].includes(disc.type.kind)
    ) {
      el.report(
        sctx,
        m.discriminant!.span,
        "type-mismatch",
        `Can't switch on ${displayValueType(disc.type, el.displayName)}.`
      );
    }
    const allowed = this.literalsOf(disc);
    const seen = new Map<string, A.Expr>();
    let sawDefault: A.SwitchCase | undefined;
    m.cases.forEach((c, i) => {
      const cframes = [...frames, { member: m, branch: i }];
      const values: IrLiteral[] = [];
      for (const v of c.values) {
        if (isError(disc)) {
          lowerExpr(el, { ...sctx, report: false }, v);
          continue;
        }
        const e = lowerOperandIn(el, sctx, v, disc);
        if (isError(e)) continue;
        if (e.kind !== "literal") {
          if (e.kind === "cond" && v.kind === "FourCC") {
            el.report(
              sctx,
              v.span,
              "fourcc-endian",
              `'${v.value}' depends on the endianness of '${printIrExpr(disc)}', which is inherited. Give the field a fixed endianness (e.g. u32le) or compare a char[4] field with a string.`
            );
          } else el.report(sctx, v.span, "invalid-case", "Case values must be constants.");
          continue;
        }
        if (!caseCompatible(disc.type, e.type)) {
          el.report(
            sctx,
            v.span,
            "invalid-case",
            `A ${displayValueType(e.type, el.displayName)} case can't match a ${displayValueType(disc.type, el.displayName)} discriminant.`
          );
          continue;
        }
        const k = JSON.stringify(e.value);
        const prev = seen.get(k);
        if (prev) {
          el.report(
            sctx,
            v.span,
            "unreachable-case",
            `This case is unreachable: ${printExpr(v)} is already handled.`,
            {
              related: [
                { file: this.sym.module.file, span: prev.span, message: "first handled here" }
              ],
              tags: ["unnecessary"]
            }
          );
          continue;
        }
        seen.set(k, v);
        if (allowed && !allowed.some(a => JSON.stringify(a) === k)) {
          el.report(
            sctx,
            v.span,
            "unreachable-case",
            `This case is unreachable: '${printIrExpr(disc)}' can only be ${allowed.map(a => printIrExpr({ kind: "literal", value: a, type: disc.type })).join(", ")}.`,
            {
              tags: ["unnecessary"]
            }
          );
        }
        values.push(e.value);
      }
      const members = this.lowerMembers(c.members, cframes, guards);
      if (c.isDefault) {
        if (sawDefault)
          el.report(sctx, c.span, "unreachable-case", "Only one default case is allowed.");
        sawDefault = c;
        sw.default = members;
      } else sw.cases.push({ values, members });
    });
    if (sawDefault && allowed && seen.size >= allowed.length) {
      el.report(
        sctx,
        sawDefault.span,
        "unreachable-case",
        "The default case is unreachable: every possible value is handled.",
        { tags: ["unnecessary"] }
      );
    }
    if (sawDefault && disc.type.kind === "bool" && seen.size >= 2) {
      el.report(
        sctx,
        sawDefault.span,
        "unreachable-case",
        "The default case is unreachable: both true and false are handled.",
        { tags: ["unnecessary"] }
      );
    }
    const layers = this.containerLayers(sctx, m.attrs, "block");
    if (layers.length) return [{ kind: "block", source: sw.source, members: [sw], layers }];
    return [sw];
  }

  /** Literal values a discriminant can take (from an `in (…)` on the field), if known. */
  private literalsOf(disc: IrExpr): IrLiteral[] | undefined {
    if (disc.kind !== "field") return undefined;
    const fs = this.sym.fieldsByName.get(disc.name);
    const p = fs && this.pending.find(x => x.sym === fs[0]);
    if (p && p.decl.clauses.inItems && p.decl.clauses.inItems.every(i => i.kind === "InValue")) {
      const c: Ctx = {
        ...this.ctx,
        report: false,
        record: false,
        side: "read",
        position: p.sym.order,
        it: p.base?.value ?? disc.type
      };
      const lits: IrLiteral[] = [];
      for (const it of p.decl.clauses.inItems) {
        if (it.kind !== "InValue") return undefined;
        const v = lowerOperandIn(this.el, c, it.value, disc);
        if (v.kind !== "literal") return undefined;
        lits.push(v.value);
      }
      return lits;
    }
    if (disc.type.kind === "enum") {
      const e = this.el.enumsById.get(disc.type.enum);
      if (e && !this.el.enumInfo(e).open)
        return e.members.map(m => ({
          kind: "enum",
          enum: (disc.type as { enum: string }).enum,
          member: m.name
        }));
    }
    return undefined;
  }

  // ── fields ───────────────────────────────────────────────────────────────

  private collectFlags(
    ctx: Ctx,
    attrs: A.Attribute[],
    pointer: boolean,
    hasAt = false
  ): { flags: Flags; layerAttrs: A.Attribute[] } {
    const { el } = this;
    const flags: Flags = {};
    const layerAttrs: A.Attribute[] = [];
    const seen = new Set<string>();
    for (const a of attrs) {
      const spec = ATTRIBUTES[a.name.name];
      if (!spec) {
        el.checkAttrTarget(ctx, a, "field");
        continue;
      }
      if (spec.layer) {
        layerAttrs.push(a);
        continue;
      }
      if (!el.checkAttrTarget(ctx, a, "field")) continue;
      if (seen.has(spec.name)) {
        this.reportDuplicateAttr(ctx, a, spec.name);
        continue;
      }
      seen.add(spec.name);
      const emptyNullable = spec.name === "nullable" && isWordArg(a, "empty");
      if (spec.pointerOnly && !pointer && !(emptyNullable && hasAt)) {
        el.report(
          ctx,
          a.name.span,
          "pointer-attribute",
          `@${spec.name} only applies to pointer fields (\`T *name : u64\`).`
        );
        continue;
      }
      switch (spec.name) {
        case "hidden":
          flags.hidden = a;
          break;
        case "relative":
          flags.relative = a;
          break;
        case "ref":
          flags.ref = a;
          break;
        case "origin":
          flags.origin = a;
          break;
        case "nullable": {
          let value = "0";
          if (emptyNullable) {
            flags.nullable = { attr: a, value, empty: true };
            break;
          }
          if (a.args?.[0]) {
            const v = lowerExpr(el, { ...ctx, side: "const" }, a.args[0].value, BIGINT);
            if (v.kind === "literal" && v.value.kind === "int") value = v.value.value;
            else if (!isError(v))
              el.report(
                ctx,
                a.args[0].value.span,
                "invalid-attribute-argument",
                "@nullable takes an integer constant."
              );
          }
          flags.nullable = { attr: a, value };
          break;
        }
        case "encoding": {
          const e = el.encodingArg(ctx, a);
          if (e) {
            flags.encoding = e;
            flags.encodingAttr = a;
          }
          break;
        }
        case "split": {
          const v = a.args?.[0] && unparen(a.args[0].value);
          if (v && v.kind === "Name" && (v.name === "fit" || v.name === "sizes"))
            flags.split = { attr: a, policy: v.name };
          else
            el.report(
              ctx,
              a.args?.[0]?.value.span ?? a.span,
              "invalid-attribute-argument",
              "@split takes `fit` or `sizes`."
            );
          break;
        }
      }
    }
    return { flags, layerAttrs };
  }

  private reportDuplicateAttr(ctx: Ctx, a: A.Attribute, name: string): void {
    const file = ctx.module.file;
    this.el.report(ctx, a.span, "duplicate-attribute", `@${name} appears more than once.`, {
      tags: ["unnecessary"],
      fixes: [removalFix(`Remove the duplicate @${name}`, file, widenLeft(file, a.span))]
    });
  }

  /** Layers of a struct or block: the attribute nearest `{` is innermost. */
  private containerLayers(ctx: Ctx, attrs: A.Attribute[], target: "block" | "struct"): IrLayer[] {
    return this.lowerLayerList(ctx, attrs, target)
      .map(x => x.layer)
      .reverse();
  }

  private lowerLayerList(
    ctx: Ctx,
    attrs: A.Attribute[],
    target: "field" | "block" | "struct"
  ): { layer: IrLayer; attr: A.Attribute }[] {
    const { el } = this;
    const out: { layer: IrLayer; attr: A.Attribute }[] = [];
    const seen = new Set<string>();
    for (const a of attrs) {
      const spec = ATTRIBUTES[a.name.name];
      if (!spec) {
        if (target !== "field") el.checkAttrTarget(ctx, a, target);
        continue;
      }
      if (!spec.layer) {
        if (target === "block") el.checkAttrTarget(ctx, a, "block");
        continue;
      }
      if (!el.checkAttrTarget(ctx, a, target)) continue;
      if (!spec.repeatable && seen.has(spec.name)) {
        this.reportDuplicateAttr(ctx, a, spec.name);
        continue;
      }
      seen.add(spec.name);
      const l = el.lowerLayer(ctx, a);
      if (l) out.push({ layer: l, attr: a });
    }
    return out;
  }

  private lowerField(
    f: A.FieldDecl,
    frames: CondFrame[],
    guards: Ctx["guards"]
  ): IrField | undefined {
    const { el } = this;
    const fs = this.symOf(f);
    this.cursor = fs.order + 1;
    const ctx = this.fieldCtx(fs, frames, guards);
    if (ctx.record && fs.name) el.recordRef(ctx, fs.nameSpan, fs, true);
    if (f.virtual) return this.lowerVirtual(f, fs, ctx, frames, guards);
    const { flags, layerAttrs } = this.collectFlags(ctx, f.attrs, f.pointer, !!f.clauses.at);
    const insideArray = f.arrays.length > 0;
    const elemCtx: Ctx = { ...ctx, insideArray: insideArray || ctx.insideArray };
    let base = el.lowerBaseType(elemCtx, f.type, insideArray);
    const endian =
      base && (base.ir.kind === "prim" || base.ir.kind === "enum") ? base.ir.endian : undefined;
    // @encoding: char arrays and str
    if (flags.encoding && base && !base.char) {
      if (base.ir.kind === "string" && base.ir.unit === 1)
        base = { ...base, ir: { ...base.ir, encoding: flags.encoding } };
      else
        el.report(
          ctx,
          flags.encodingAttr!.name.span,
          "invalid-attribute-target",
          "@encoding applies to char and str fields."
        );
    }
    // `T[n] *p`: array suffixes after the type (the pointer target for pointers)
    if (base && f.typeArrays.length) {
      const ir = el.applyArrays(elemCtx, base, f.typeArrays, flags.encoding);
      base = { ir, value: valueTypeOf(ir, undefined, el.externValueType) };
    } else if (!base) this.lowerQuietly(ctx, f.typeArrays);
    if (f.pointer) {
      const storage = this.pointerStorage(ctx, f);
      if (base) base = this.lowerPointer(ctx, f, base, storage, flags);
    }
    let type: IrType = base
      ? f.arrays.length
        ? el.applyArrays(ctx, base, f.arrays, flags.encoding)
        : base.char && flags.encoding
          ? { ...(base.ir as IrStringType), encoding: flags.encoding }
          : base.ir
      : errorIrType();
    if (!base) this.lowerQuietly(ctx, f.arrays);
    let value: IrValueType = base ? valueTypeOf(type, undefined, el.externValueType) : ERROR_TYPE;
    // transform (read side now; the explicit write is lowered with the write side)
    if (f.clauses.asRead) {
      if (f.clauses.formula && !f.clauses.asWrite) {
        el.report(
          ctx,
          f.clauses.spans.formula ?? f.span,
          "syntax-error",
          "With `as`, write the inverse after it: `as read = write`."
        );
      }
      if (base) {
        const t = el.lowerTransform(ctx, type, value, f.clauses.asRead, undefined);
        type = t.ir;
        value = t.value;
      } else lowerExpr(el, { ...ctx, report: false, it: ERROR_TYPE }, f.clauses.asRead);
    }
    // layers (postfix: leftmost innermost)
    const layerList = this.lowerLayerList(ctx, layerAttrs, "field");
    if (layerList.length) {
      type = { kind: "layered", inner: type, layers: layerList.map(x => x.layer) };
      this.checkCodecSizes(ctx, layerList);
    }
    const irField: IrField = {
      kind: "field",
      name: fs.name,
      source: sourceRef(this.sym.module, f.span),
      type,
      checks: [],
      hidden: !!flags.hidden,
      output: !flags.hidden,
      input: flags.hidden ? "absent" : "required"
    };
    if (fs.doc) irField.doc = fs.doc;
    if (f.bound && fs.name) irField.bind = fs.name;
    if (f.clauses.at) this.lowerPlacement(ctx, f, irField, flags);
    if (f.clauses.from) {
      const stream = this.lowerStream(ctx, f.clauses.from);
      if (stream) {
        irField.from = { stream };
        if (stream.kind === "each") irField.from.split = { policy: flags.split?.policy ?? "sizes" };
      }
    }
    if (flags.split && !(irField.from && irField.from.stream.kind === "each")) {
      el.report(
        ctx,
        flags.split.attr.name.span,
        "invalid-attribute-target",
        "@split only applies to `from arr[*].field` streams."
      );
    }
    if (f.bitWidth && f.pointer)
      el.report(
        ctx,
        f.bitWidth.span,
        "syntax-error",
        "Pointers take a storage type after ':', not a width."
      );
    const fr = this.recordField(ctx, f, irField, type, value, frames, guards, base, endian);
    const transform = coreTransform(type);
    if (transform?.writeInferred && transform.write)
      fr.inferredWrite = printIrExpr(transform.write);
    return irField;
  }

  /** Lowers expressions of a field whose type failed, for references and nested diagnostics. */
  private lowerQuietly(ctx: Ctx, arrays: A.ArraySuffix[]): void {
    for (const a of arrays) if (a.expr) lowerExpr(this.el, { ...ctx, report: false }, a.expr);
  }

  /** Records a lowered field for the write side, derivations and the language service. */
  private recordField(
    ctx: Ctx,
    f: A.FieldDecl,
    ir: IrField,
    type: IrType,
    value: IrValueType,
    frames: CondFrame[],
    guards: Ctx["guards"],
    base: BaseType | undefined,
    endian: IrEndianSpec | undefined
  ): FieldResult {
    const fs = this.symOf(f);
    ctx.fieldTypes.set(fs, { ir: type, value });
    if (this.checking) {
      fs.irType = type;
      fs.valueType = value;
    }
    const fr: FieldResult = { sym: fs, ir, type, value };
    this.result.fields.set(fs, fr);
    const pending: PendingField = { sym: fs, decl: f, frames, guards, ir };
    if (base) pending.base = base;
    if (endian) pending.endian = endian;
    this.pending.push(pending);
    return fr;
  }

  private lowerPointer(
    ctx: Ctx,
    f: A.FieldDecl,
    target: BaseType,
    storage: { prim: IrPrimKind; endian: IrEndianSpec } | undefined,
    flags: Flags
  ): BaseType {
    const p: IrPointerType = {
      kind: "pointer",
      storage: storage?.prim ?? "u64",
      storageEndian: storage?.endian ?? "inherit",
      target: target.ir,
      relative: !!flags.relative,
      ownership: flags.ref ? "ref" : "owned"
    };
    if (flags.nullable) p.nullValue = flags.nullable.value;
    if (flags.nullable?.empty) {
      if (isSequence(target.ir)) p.emptyIsNull = true;
      else
        this.el.report(
          ctx,
          flags.nullable.attr.span,
          "invalid-attribute-argument",
          "@nullable(empty) needs a pointer to an array (`T[n] *p : u64`)."
        );
    }
    // @origin may read any field, like a computed field: it is lowered with the write side
    if (flags.origin) this.origins.set(f, { attr: flags.origin, pointer: p });
    const nullable = flags.nullable && !flags.nullable.empty;
    return { ir: p, value: nullable ? { kind: "nullable", inner: target.value } : target.value };
  }

  /** `at offset`: a placement, or per-element placement when it uses `$index` of an array field. */
  private lowerPlacement(ctx: Ctx, f: A.FieldDecl, irField: IrField, flags: Flags): void {
    const { el } = this;
    const at = f.clauses.at!;
    if (f.clauses.from)
      el.report(
        ctx,
        f.clauses.spans.at ?? f.span,
        "syntax-error",
        "A field can't have both `at` and `from`."
      );
    const elementWise =
      f.arrays.length > 0 && someExpr(at, x => x.kind === "Dollar" && x.name === "index");
    const off = lowerExpr(el, { ...ctx, insideArray: elementWise || ctx.insideArray }, at, BIGINT);
    if (!isError(off) && !isIntType(off.type)) {
      el.report(
        ctx,
        at.span,
        "type-mismatch",
        `An offset must be an integer, but this is ${displayValueType(off.type, el.displayName)}.`
      );
    } else if (!isError(off)) {
      if (elementWise) {
        const arr = coreType(irField.type);
        if (arr.kind === "array") arr.elementPlacement = off;
      } else irField.placement = { offset: off, fixed: true };
    }
    if (flags.nullable?.empty && !f.pointer && irField.placement) {
      if (isSequence(irField.type)) irField.placement.emptyIsNull = true;
      else
        el.report(
          ctx,
          flags.nullable.attr.span,
          "invalid-attribute-argument",
          "@nullable(empty) on an `at` field needs an array."
        );
    }
  }

  /**
   * `virtual u40 size = (sizeHigh << 32) | sizeLow`: no bytes. The formula is the read side
   * (earlier fields only); the parts are derived from the value in `deriveVirtualParts`.
   */
  private lowerVirtual(
    f: A.FieldDecl,
    fs: FieldSym,
    ctx: Ctx,
    frames: CondFrame[],
    guards: Ctx["guards"]
  ): IrField | undefined {
    const { el } = this;
    const file = ctx.module.file;
    const bad = (span: Span, message: string, fixes?: Fix[]) =>
      el.report(ctx, span, "invalid-virtual", message, fixes ? { fixes } : {});
    for (const a of f.attrs) {
      if (!ATTRIBUTES[a.name.name]) {
        el.checkAttrTarget(ctx, a, "field");
        continue;
      }
      bad(a.span, `A virtual field has no bytes, so @${a.name.name} doesn't apply.`, [
        removalFix(`Remove @${a.name.name}`, file, widenLeft(file, a.span), true)
      ]);
    }
    if (f.pointer || f.arrays.length || f.typeArrays.length || f.bitWidth)
      bad(f.type.span, "A virtual field is a single integer (no arrays, pointers or widths).");
    for (const k of ["at", "from", "as"] as const) {
      const span = f.clauses.spans[k];
      if (span) bad(span, `A virtual field takes no \`${k}\`: it has no bytes.`);
    }
    let base = el.lowerBaseType(ctx, f.type);
    if (base && !(base.ir.kind === "prim" && !PRIMS[base.ir.prim].float)) {
      bad(
        f.type.span,
        `A virtual field must be an integer type (u8 … u64, i8 … i64), not ${displayValueType(base.value, el.displayName)}.`
      );
      base = undefined;
    }
    const type: IrType = base ? base.ir : errorIrType();
    const value: IrValueType = base ? base.value : ERROR_TYPE;
    const irField: IrField = {
      kind: "field",
      name: fs.name,
      source: sourceRef(this.sym.module, f.span),
      type,
      checks: [],
      hidden: false,
      output: true,
      input: "required"
    };
    if (fs.doc) irField.doc = fs.doc;
    if (f.bound && fs.name) irField.bind = fs.name;
    const formula = f.clauses.formula;
    if (!formula) {
      const end = f.name?.span.end ?? f.type.span.end;
      bad(f.name?.span ?? f.span, "A virtual field needs `= expression` over earlier fields.", [
        { title: "Add `= …`", edits: [{ file, span: { start: end, end }, newText: " = 0" }] }
      ]);
    } else {
      const read = lowerExpr(el, ctx, formula, BIGINT);
      if (!isError(read)) {
        if (!isIntType(read.type))
          bad(
            formula.span,
            `A virtual field's formula must be an integer, but this is ${displayValueType(read.type, el.displayName)}.`
          );
        else irField.virtual = { read: convertTo(read, BIGINT) };
      }
    }
    this.recordField(ctx, f, irField, type, value, frames, guards, base, undefined);
    return irField;
  }

  /** Derives the parts of every virtual field from its value. */
  private deriveVirtualParts(): void {
    const { el, ctx } = this;
    const fields = [...this.result.fields.values()];
    for (const v of fields) {
      if (!isIrField(v.ir) || !v.ir.virtual) continue;
      const decl = v.sym.decl;
      const vctx: Ctx = { ...ctx, frames: v.sym.frames, position: v.sym.order };
      // candidate parts: integer fields declared earlier (not transforms, not other virtuals)
      const ranges = new Map<string, PartRange>();
      const byName = new Map<string, FieldResult>();
      for (const c of fields) {
        if (c === v || c.sym.order >= v.sym.order || !c.sym.name) continue;
        if (isIrField(c.ir)) {
          let t = c.ir.type;
          if (t.kind === "layered") t = t.inner;
          if (t.kind !== "prim" || c.ir.virtual || c.ir.placement || c.ir.from) continue;
          const r = partRange(c.value, undefined, c.ir.checks);
          if (r) ranges.set(c.sym.name, r);
        } else {
          const r = partRange(c.value, c.bits?.width, c.ir.checks);
          if (r) ranges.set(c.sym.name, r);
        }
        byName.set(c.sym.name, c);
      }
      const value: IrExpr = { kind: "field", name: v.sym.name, type: v.value };
      const res = invertVirtual(v.ir.virtual.read, value, ranges);
      const formulaSpan = decl.clauses.spans.formula ?? decl.span;
      if (!res.ok) {
        const fixes: Fix[] = [];
        if (res.overlap && decl.clauses.formula) {
          const shifts: A.IntLit[] = [];
          walkExpr(decl.clauses.formula, x => {
            if (x.kind === "Binary" && x.op === "<<") {
              const r = unparen(x.right);
              if (r.kind === "Int" && r.value === res.overlap!.shift) shifts.push(r);
            }
          });
          if (shifts.length === 1)
            fixes.push(
              replaceFix(
                ctx.module.file,
                shifts[0]!.span,
                String(res.overlap.width),
                `Shift by ${res.overlap.width}`
              )
            );
        }
        el.report(vctx, formulaSpan, "virtual-not-invertible", res.message, { fixes });
        continue;
      }
      for (const p of res.parts) {
        const part = byName.get(p.name);
        if (!part) continue;
        const pd = part.sym.decl;
        if (part.ir.derive) {
          const span = pd.clauses.spans.formula ?? pd.clauses.spans.default ?? part.sym.nameSpan;
          const clause = pd.clauses.spans.formula ?? pd.clauses.spans.default;
          el.report(
            vctx,
            span,
            "virtual-not-invertible",
            `'${p.name}' is a part of the virtual field '${v.sym.name}', which derives it on write: remove its ${pd.clauses.spans.default ? "default" : "formula"}.`,
            clause
              ? {
                  fixes: [
                    removalFix(
                      `Remove the ${pd.clauses.spans.default ? "default" : "formula"}`,
                      ctx.module.file,
                      widenLeft(ctx.module.file, clause),
                      true
                    )
                  ],
                  related: [
                    {
                      file: ctx.module.file,
                      span: v.sym.nameSpan,
                      message: `'${v.sym.name}' is read from '${p.name}'`
                    }
                  ]
                }
              : {}
          );
          continue;
        }
        part.ir.derive = p.derive;
        part.ir.deriveKind = "auto";
        part.ir.input = "absent";
        part.deriveDisplay = printIrExpr(p.derive);
        part.deriveSource = `part of the virtual field ${v.sym.name}`;
      }
    }
  }

  private pointerStorage(
    ctx: Ctx,
    f: A.FieldDecl
  ): { prim: IrPrimKind; endian: IrEndianSpec } | undefined {
    const { el } = this;
    if (!f.storage) {
      el.report(
        ctx,
        f.starSpan ?? f.span,
        "pointer-storage",
        "A pointer needs a storage type: `T *name : u64`."
      );
      return undefined;
    }
    const name = typeRefName(f.storage);
    const b = intPrim(name);
    if (!b) {
      el.report(
        ctx,
        f.storage.span,
        "pointer-storage",
        `A pointer's storage must be an integer type (u32, u64, i32, …), not '${name}'.`
      );
      return undefined;
    }
    el.recordRef(ctx, f.storage.span, { kind: "builtinType", name });
    return b;
  }

  /** `@size` directly inside a non-streaming codec without an outer `@size`. */
  private checkCodecSizes(ctx: Ctx, list: { layer: IrLayer; attr: A.Attribute }[]): void {
    const { el } = this;
    list.forEach((x, i) => {
      if (x.layer.kind !== "via") return;
      const codec = el.externsById.get(x.layer.codec);
      if (!codec || codec.kind !== "codec") return;
      if (codec.decl.attrs.some(a => a.name.name === "streaming")) return;
      const outer = list.slice(i + 1).some(y => y.layer.kind === "size");
      const innerIdx = list.slice(0, i).findIndex(y => y.layer.kind === "size");
      if (outer || innerIdx < 0) return;
      const inner = list[innerIdx]!;
      const text = ctx.module.file.text.slice(inner.attr.span.start, inner.attr.span.end);
      const fixes: Fix[] = [];
      const hasOtherSize = list.slice(0, i).filter(y => y.layer.kind === "size").length > 1;
      if (!hasOtherSize) {
        fixes.push({
          title: `Move ${text} after @via(${codec.name})`,
          edits: [
            {
              file: ctx.module.file,
              span: widenLeft(ctx.module.file, inner.attr.span),
              newText: ""
            },
            {
              file: ctx.module.file,
              span: { start: x.attr.span.end, end: x.attr.span.end },
              newText: ` ${text}`
            }
          ],
          isPreferred: true
        });
      }
      el.report(
        ctx,
        inner.attr.span,
        "size-inside-codec",
        `'${codec.name}' isn't @streaming, so it needs its on-disk size: this @size measures the decoded side. Put an @size after @via(${codec.name}) (it can be derived).`,
        { fixes }
      );
    });
  }

  private lowerStream(ctx: Ctx, e: A.Expr): IrStreamExpr | undefined {
    const { el } = this;
    const u = unparen(e);
    if (u.kind === "Name") {
      const res = el.lookupValue(ctx, u.name, u.span);
      if (res.kind !== "field") {
        el.report(
          ctx,
          u.span,
          res.kind === "none" ? "unknown-name" : "invalid-stream",
          res.kind === "none"
            ? `Unknown field '${u.name}'.`
            : `A stream must be a bytes field of this struct.`
        );
        return undefined;
      }
      const ref = lowerFieldRef(el, ctx, res.syms, u.span, u.name);
      if (isError(ref)) return undefined;
      if (ref.type.kind !== "bytes") {
        el.report(
          ctx,
          u.span,
          "invalid-stream",
          `A stream must be a bytes field (u8[…]), but '${u.name}' is ${displayValueType(ref.type, el.displayName)}.`
        );
        return undefined;
      }
      return { kind: "field", field: u.name };
    }
    if (u.kind === "Member" && unparen(u.object).kind === "Each") {
      const each = unparen(u.object) as A.EachExpr;
      const arrNode = unparen(each.object);
      if (arrNode.kind !== "Name") {
        el.report(
          ctx,
          each.span,
          "invalid-stream",
          "Use `array[*].field` with an array field of this struct."
        );
        return undefined;
      }
      const res = el.lookupValue(ctx, arrNode.name, arrNode.span);
      if (res.kind !== "field") {
        el.report(ctx, arrNode.span, "unknown-name", `Unknown field '${arrNode.name}'.`);
        return undefined;
      }
      const arr = lowerFieldRef(el, ctx, res.syms, arrNode.span, arrNode.name);
      if (isError(arr)) return undefined;
      if (arr.type.kind !== "array" || arr.type.element.kind !== "struct") {
        el.report(
          ctx,
          arrNode.span,
          "invalid-stream",
          `'${arrNode.name}' must be an array of structs.`
        );
        return undefined;
      }
      const ft = el.structMember(ctx, arr.type.element.struct, u.name.name, u.name.span);
      if (!ft) {
        el.report(
          ctx,
          u.name.span,
          "unknown-member",
          `'${el.displayName(arr.type.element.struct)}' has no field '${u.name.name}'.`
        );
        return undefined;
      }
      if (ft.kind !== "bytes" && !isErrorType(ft)) {
        el.report(
          ctx,
          u.name.span,
          "invalid-stream",
          `'${u.name.name}' must be a bytes field to be joined into a stream.`
        );
        return undefined;
      }
      return { kind: "each", array: arrNode.name, field: u.name.name };
    }
    if (u.kind === "Slice") {
      const inner = this.lowerStream(ctx, u.object);
      if (!inner) return undefined;
      const start = u.start
        ? lowerExpr(el, ctx, u.start, BIGINT)
        : { kind: "literal" as const, value: { kind: "int" as const, value: "0" }, type: BIGINT };
      const out: IrStreamExpr = { kind: "slice", stream: inner, start };
      if (u.end) out.end = lowerExpr(el, ctx, u.end, BIGINT);
      for (const x of [out.start, out.kind === "slice" ? out.end : undefined]) {
        if (x && !isError(x) && !isIntType(x.type))
          el.report(ctx, u.span, "type-mismatch", "Slice bounds must be integers.");
      }
      return out;
    }
    el.report(
      ctx,
      e.span,
      "invalid-stream",
      "A stream is a bytes field, `array[*].field`, or a slice `stream[a..b]`."
    );
    return undefined;
  }

  // ── bitfields ────────────────────────────────────────────────────────────

  private lowerBitsBlock(m: A.BitsMember, frames: CondFrame[], guards: Ctx["guards"]): IrMember[] {
    const { el } = this;
    const position = this.nextOrder();
    const bctx: Ctx = { ...this.ctx, position, frames, guards };
    let order = this.bitOrder;
    const layerAttrs: A.Attribute[] = [];
    for (const a of m.attrs) {
      const spec = ATTRIBUTES[a.name.name];
      if (!spec) {
        el.checkAttrTarget(bctx, a, "bits");
        continue;
      }
      if (a.name.name === "bitorder") {
        if (el.checkAttrTarget(bctx, a, "bits")) order = this.bitOrderArg(a) ?? order;
      } else if (spec.layer) layerAttrs.push(a);
      else el.checkAttrTarget(bctx, a, "bits");
    }
    let storage: IrPrimKind = "u8";
    let endian: IrEndianSpec = "inherit";
    if (m.storage) {
      const name = typeRefName(m.storage);
      const b = intPrim(name);
      if (!b) {
        el.report(
          bctx,
          m.storage.span,
          "bitfield-type",
          `A bits block's storage must be an integer type, not '${name}'.`
        );
      } else {
        storage = b.prim;
        endian = b.endian;
        el.recordRef(bctx, m.storage.span, { kind: "builtinType", name });
      }
    }
    const bits = this.packBits(m.fields, storage, endian, order, frames, guards, true);
    const layers = this.containerLayers(
      bctx,
      layerAttrs.filter(
        a => a.name.name === "strict" || ATTRIBUTES[a.name.name]?.targets.includes("block")
      ),
      "block"
    );
    if (layers.length)
      return [{ kind: "block", source: sourceRef(this.sym.module, m.span), members: bits, layers }];
    return bits;
  }

  private lowerCBitfields(
    run: A.FieldDecl[],
    frames: CondFrame[],
    guards: Ctx["guards"]
  ): IrMember[] {
    // split the run into groups sharing a storage type
    const out: IrMember[] = [];
    let group: A.FieldDecl[] = [];
    let groupKey = "";
    const flush = () => {
      if (!group.length) return;
      const info = this.cStorage(group[0]!);
      out.push(
        ...this.packBits(group, info.prim, info.endian, this.bitOrder, frames, guards, false)
      );
      group = [];
    };
    for (const f of run) {
      const key = typeRefName(f.type);
      if (group.length && key !== groupKey) flush();
      groupKey = key;
      group.push(f);
    }
    flush();
    return out;
  }

  private cStorage(f: A.FieldDecl): { prim: IrPrimKind; endian: IrEndianSpec } {
    const name = typeRefName(f.type);
    const int = intPrim(name);
    if (int) return int;
    if (lookupBuiltinType(name)?.kind === "bool") return { prim: "u8", endian: "inherit" };
    const d = this.el.lookupDecl(this.ctx, name);
    if (d && d.kind === "enum") {
      const info = this.el.enumInfo(d);
      return { prim: info.storage, endian: info.endian };
    }
    return { prim: "u32", endian: "inherit" };
  }

  /** Packs bitfields into storage units (a new unit starts when the next field doesn't fit). */
  private packBits(
    fields: A.FieldDecl[],
    storage: IrPrimKind,
    endian: IrEndianSpec,
    order: "lsb" | "msb",
    frames: CondFrame[],
    guards: Ctx["guards"],
    explicitBlock: boolean
  ): IrBits[] {
    const { el } = this;
    const unitBits = PRIMS[storage].bytes * 8;
    const units: IrBits[] = [];
    let cur: IrBits | undefined;
    let used = 0;
    const newUnit = (f: A.FieldDecl) => {
      cur = {
        kind: "bits",
        source: sourceRef(this.sym.module, f.span),
        storage,
        endian,
        bitOrder: order,
        fields: []
      };
      units.push(cur);
      used = 0;
    };
    for (const f of fields) {
      const fs = this.symOf(f);
      this.cursor = fs.order + 1;
      const ctx = this.fieldCtx(fs, frames, guards);
      if (ctx.record && fs.name) el.recordRef(ctx, fs.nameSpan, fs, true);
      for (const a of f.attrs) {
        const spec = ATTRIBUTES[a.name.name];
        if (!spec) el.checkAttrTarget(ctx, a, "field");
        else
          el.report(
            ctx,
            a.name.span,
            "invalid-attribute-target",
            `@${spec.name} isn't allowed on bitfields.`
          );
      }
      let width = this.bitfieldWidth(ctx, f);
      const { type, value, maxWidth } = this.bitfieldType(ctx, f, storage, endian, width);
      if (f.bitWidth && (width < 0 || (width === 0 && fs.name) || width > maxWidth)) {
        el.report(
          ctx,
          f.bitWidth.span,
          "bitfield-width",
          width > maxWidth
            ? `${width} bits don't fit in ${typeRefName(f.type)} (${maxWidth} bits).`
            : "A named bitfield needs a width of at least 1."
        );
        width = Math.max(0, Math.min(width, maxWidth));
      }
      if (!cur || (width === 0 && !fs.name && !explicitBlock) || used + width > unitBits) {
        if (cur && explicitBlock && used + width > unitBits) {
          el.report(
            ctx,
            f.bitWidth?.span ?? f.span,
            "bitfield-overflow",
            `The bitfields need ${used + width} bits, but the storage unit ${storage} has ${unitBits}.`
          );
          width = Math.max(0, unitBits - used);
        } else if (!cur || !explicitBlock) newUnit(f);
      }
      if (width === 0) continue;
      const shift = order === "lsb" ? used : unitBits - used - width;
      used += width;
      const bf: IrBitField = {
        name: fs.name || null,
        shift,
        width,
        type,
        checks: [],
        output: !!fs.name,
        input: fs.name ? "required" : "absent"
      };
      cur!.fields.push(bf);
      if (fs.name) {
        ctx.fieldTypes.set(fs, { ir: type, value });
        if (this.checking) {
          fs.irType = type;
          fs.valueType = value;
        }
        const fr: FieldResult = {
          sym: fs,
          ir: bf,
          type,
          value,
          bits: { storage, shift, width, storageBits: unitBits, order, unit: cur! }
        };
        this.result.fields.set(fs, fr);
        this.pending.push({ sym: fs, decl: f, frames, guards, ir: bf, endian });
      } else if (f.clauses.formula || f.clauses.where || f.clauses.inItems) {
        el.report(ctx, f.span, "syntax-error", "Reserved bits can't have clauses.");
      }
    }
    // implicit reserved bits complete each unit
    for (const u of units) {
      const total = u.fields.reduce((s, f) => s + f.width, 0);
      if (total < unitBits)
        u.fields.push({
          name: null,
          shift: order === "lsb" ? total : 0,
          width: unitBits - total,
          type: { kind: "prim", prim: storage, endian },
          checks: [],
          output: false,
          input: "absent"
        });
    }
    return units;
  }

  private bitfieldWidth(ctx: Ctx, f: A.FieldDecl): number {
    if (!f.bitWidth) return 0;
    const w = lowerExpr(this.el, { ...ctx, side: "const" }, f.bitWidth, BIGINT);
    const n = constInt(w);
    if (n === undefined && !isError(w))
      this.el.report(
        ctx,
        f.bitWidth.span,
        "bitfield-width",
        "A bitfield width must be a constant."
      );
    return n ?? 0;
  }

  /** A bitfield's type: an integer (in the unit's byte order unless fixed), bool or enum. */
  private bitfieldType(
    ctx: Ctx,
    f: A.FieldDecl,
    storage: IrPrimKind,
    endian: IrEndianSpec,
    width: number
  ): { type: IrType; value: IrValueType; maxWidth: number } {
    const { el } = this;
    const tname = typeRefName(f.type);
    const tb = lookupBuiltinType(tname);
    if (tb && tb.kind === "prim" && !PRIMS[tb.prim].float) {
      el.recordRef(ctx, f.type.span, { kind: "builtinType", name: tname });
      return {
        type: { kind: "prim", prim: tb.prim, endian: tb.endian === "inherit" ? endian : tb.endian },
        value: intType(tb.prim),
        maxWidth: PRIMS[tb.prim].bytes * 8
      };
    }
    if (tb && tb.kind === "bool") {
      el.recordRef(ctx, f.type.span, { kind: "builtinType", name: tname });
      return { type: { kind: "bool" }, value: BOOL, maxWidth: 1 };
    }
    const fallback = {
      type: { kind: "prim", prim: storage, endian } as IrType,
      value: intType(storage),
      maxWidth: PRIMS[storage].bytes * 8
    };
    const b = el.lowerBaseType(ctx, f.type);
    if (b && b.ir.kind === "enum") {
      const e = el.enumsById.get(b.ir.enum);
      if (!e) return { ...fallback, type: b.ir, value: b.value };
      const info = el.enumInfo(e);
      const max = [...info.values.values()].reduce((m, v) => (v > m ? v : m), 0n);
      if (width > 0 && max >= 1n << BigInt(width)) {
        el.report(
          ctx,
          f.bitWidth!.span,
          "bitfield-width",
          `${width} bit${width === 1 ? "" : "s"} can't hold every value of '${e.name}' (up to ${max}).`
        );
      }
      return { type: b.ir, value: b.value, maxWidth: PRIMS[info.storage].bytes * 8 };
    }
    if (b) {
      el.report(
        ctx,
        f.type.span,
        "bitfield-type",
        `A bitfield must be an integer, bool or enum, not ${displayValueType(b.value, el.displayName)}.`
      );
    }
    return fallback;
  }

  // ── write side and checks ────────────────────────────────────────────────

  private lowerWriteSide(p: PendingField): void {
    const fs = p.sym;
    const f = p.decl;
    const fr = this.result.fields.get(fs);
    if (!fr) return;
    const value = fr.value;
    const rctx: Ctx = { ...this.fieldCtx(fs, p.frames, p.guards), it: value, selfIsIt: true };
    const wctx: Ctx = {
      ...this.ctx,
      side: "write",
      position: Number.MAX_SAFE_INTEGER,
      frames: p.frames,
      guards: p.guards,
      self: fs,
      it: value,
      fieldName: fs.name
    };
    this.lowerTransformWrite(p, fr, rctx, wctx);
    this.lowerFormula(p, fr, wctx);
    if (f.clauses.defaultValue) this.lowerDefault(p, fr, wctx, f.clauses.defaultValue);
    this.addChecks(p.ir, value, rctx, f.clauses, fs.name || "it");
    const extras = p.base?.extras;
    if (extras) {
      if (f.arrays.length) {
        this.el.report(
          rctx,
          f.type.span,
          "type-mismatch",
          `Type '${extras.alias.name}' has checks or a formula, which can't apply per element of an array.`
        );
      } else {
        const c: Ctx = { ...extras.ctx, it: value, out: this.ctx.out, report: false };
        this.addChecks(p.ir, value, c, extras.spec.clauses, fs.name || "it");
      }
    }
  }

  /** The explicit inverse of `as read = write`, or a hint when there is none. */
  private lowerTransformWrite(p: PendingField, fr: FieldResult, rctx: Ctx, wctx: Ctx): void {
    const { el } = this;
    const f = p.decl;
    const tr = isIrField(p.ir) ? coreTransform(p.ir.type) : undefined;
    if (!tr) return;
    const innerValue = valueTypeOf(tr.inner, undefined, el.externValueType);
    if (f.clauses.asWrite) {
      const w = lowerExpr(el, { ...wctx, it: tr.valueType }, f.clauses.asWrite, innerValue);
      if (isError(w)) return;
      if (!containsIt(w)) {
        el.report(
          wctx,
          f.clauses.asWrite.span,
          "not-invertible",
          "The inverse in `as … = …` must use `it` (the value being written)."
        );
      }
      tr.write = coerce(el, wctx, w, innerValue, f.clauses.asWrite, "The inverse");
      delete tr.writeInferred;
      delete fr.inferredWrite;
    } else if (!tr.write && f.clauses.asRead) {
      el.report(
        rctx,
        f.clauses.spans.as ?? f.clauses.asRead.span,
        "one-way-transform",
        `No inverse for this transform: '${p.sym.name}' is read-only in views, and its input stays the raw ${displayValueType(innerValue, el.displayName)}. Add \`= …\` with the inverse to make it writable.`
      );
    }
  }

  /**
   * `= formula` (or an alias's): a constant (checked on read), a formula the writer computes, or a
   * normalization of the input when it uses `it`. A virtual field's formula is its read side.
   */
  private lowerFormula(p: PendingField, fr: FieldResult, wctx: Ctx): void {
    const { el } = this;
    const f = p.decl;
    const ir = p.ir;
    const value = fr.value;
    const formula = f.clauses.formula ?? p.base?.extras?.spec.clauses.formula;
    if (!formula || f.virtual || (f.clauses.asRead && !f.clauses.formula)) return;
    const fctx: Ctx = f.clauses.formula
      ? wctx
      : { ...p.base!.extras!.ctx, side: "write", it: value, out: this.ctx.out };
    if (isIrField(ir) && coreType(ir.type).kind === "pointer") {
      el.report(
        fctx,
        formula.span,
        "type-mismatch",
        "Pointer values are computed by the writer from where the target is placed; remove the formula."
      );
      return;
    }
    if (isIrField(ir) && (value.kind === "struct" || value.kind === "union")) {
      el.report(
        fctx,
        formula.span,
        "type-mismatch",
        "Formulas need a scalar, string or bytes field."
      );
      return;
    }
    let e = lowerExpr(el, fctx, formula, value, p.endian ? { endian: p.endian } : {});
    if (!isError(e)) e = coerce(el, fctx, e, value, formula, `'${p.sym.name}'`);
    if (isError(e)) return;
    ir.derive = e;
    if (containsIt(e)) {
      ir.deriveKind = "formula";
    } else if (isConstantFormula(e)) {
      ir.deriveKind = "constant";
      ir.input = "absent";
      ir.checks.push({
        expr: { kind: "binary", op: "==", left: { kind: "it", type: value }, right: e, type: BOOL },
        message: `${p.sym.name || "reserved"} == ${printExpr(formula)}`,
        strictOnly: false
      });
      this.checkConstantFits(fctx, ir, e, formula);
    } else {
      ir.deriveKind = "formula";
      ir.input = "absent";
    }
  }

  /** `?= default`: an optional input, with the default when the input omits it. */
  private lowerDefault(p: PendingField, fr: FieldResult, wctx: Ctx, dflt: A.Expr): void {
    const { el } = this;
    const f = p.decl;
    const ir = p.ir;
    const value = fr.value;
    if (f.clauses.formula && !f.virtual) {
      el.report(
        wctx,
        f.clauses.spans.default ?? dflt.span,
        "syntax-error",
        "A field can't have both `=` and `?=`."
      );
      return;
    }
    if (
      isIrField(ir) &&
      (coreType(ir.type).kind === "pointer" || value.kind === "struct" || value.kind === "union")
    ) {
      el.report(wctx, dflt.span, "type-mismatch", "Defaults need a scalar, string or bytes field.");
      return;
    }
    const { it: _it, ...dctx } = wctx;
    let e = lowerExpr(el, dctx, dflt, value, p.endian ? { endian: p.endian } : {});
    if (!isError(e)) e = coerce(el, dctx, e, value, dflt, `The default of '${p.sym.name}'`);
    if (isError(e)) return;
    ir.derive = e;
    ir.deriveKind = "formula";
    if (!(isIrField(ir) && ir.hidden)) ir.input = "optional";
    this.checkConstantFits(dctx, ir, e, dflt);
  }

  /** Checks from `in (…)`, `in /re/` and `where` clauses. */
  private addChecks(
    ir: IrField | IrBitField,
    value: IrValueType,
    c: Ctx,
    clauses: A.FieldClauses,
    name: string
  ): void {
    const { el } = this;
    if (clauses.inItems) {
      const e = lowerInItems(el, c, { kind: "it", type: value }, clauses.inItems);
      if (!isError(e) && e.kind === "in") {
        ir.checks.push({
          expr: e,
          message: `${name} in ${printInItems(clauses.inItems)}`,
          strictOnly: false
        });
        if (isIrField(ir) && e.items.every(i => i.kind === "value" && i.value.kind === "literal")) {
          ir.literals = e.items.map(
            i => (i as { value: IrExpr & { kind: "literal" } }).value.value
          );
        }
      }
    }
    if (clauses.regex) {
      const e = lowerRegex(el, c, { kind: "it", type: value }, clauses.regex, undefined);
      if (!isError(e))
        ir.checks.push({
          expr: e,
          message: `${name} in /${clauses.regex.pattern}/`,
          strictOnly: false
        });
    }
    if (clauses.where) {
      const e = lowerExpr(el, c, clauses.where, BOOL);
      if (isError(e)) return;
      if (e.type.kind !== "bool") {
        el.report(
          c,
          clauses.where.span,
          "type-mismatch",
          `A where condition must be bool, but this is ${displayValueType(e.type, el.displayName)}.`
        );
      } else
        ir.checks.push({
          expr: e,
          message: printExpr(clauses.where, { itName: name }),
          strictOnly: false
        });
    }
  }

  private checkConstantFits(ctx: Ctx, ir: IrField | IrBitField, e: IrExpr, node: A.Expr): void {
    if (!isIrField(ir)) {
      const v = e.kind === "literal" && e.value.kind === "int" ? BigInt(e.value.value) : undefined;
      if (
        v !== undefined &&
        ir.type.kind === "prim" &&
        !PRIMS[ir.type.prim].signed &&
        v >= 1n << BigInt(ir.width)
      ) {
        this.el.report(
          ctx,
          node.span,
          "value-out-of-range",
          `${v} doesn't fit in ${ir.width} bits.`
        );
      }
      return;
    }
    const core = coreType(ir.type);
    if (e.kind !== "literal") return;
    if (core.kind === "string" && core.length.kind === "count" && e.value.kind === "string") {
      const n = constInt(core.length.expr);
      const units = encodedUnits(e.value.value, core.encoding);
      if (n !== undefined && units > n) {
        this.el.report(
          ctx,
          node.span,
          "string-too-long",
          `"${e.value.value}" needs ${units} code units, but '${ir.name}' holds ${n}.`
        );
      }
    }
    if (core.kind === "bytes" && core.length.kind === "count" && e.value.kind === "bytes") {
      const n = constInt(core.length.expr);
      const len = e.value.hex.length / 2;
      if (n !== undefined && len !== n) {
        this.el.report(
          ctx,
          node.span,
          len > n ? "string-too-long" : "type-mismatch",
          `The constant has ${len} bytes, but '${ir.name}' holds ${n}.`
        );
      }
    }
  }

  // ── layout ───────────────────────────────────────────────────────────────

  private lowerLayout(m: A.LayoutMember): IrLayoutItem[] | undefined {
    return this.lowerLayoutItems(m.items, { sym: this.sym, fields: this.result.fields });
  }

  /**
   * Lowers layout items relative to `scope`: the struct itself, or the element struct of a
   * per-element group.
   */
  private lowerLayoutItems(list: A.LayoutItem[], scope: LayoutScope): IrLayoutItem[] {
    const { el, ctx } = this;
    const items: IrLayoutItem[] = [];
    const seen = new Map<string, A.LayoutItem>();
    for (const it of list) {
      // item expressions see the struct's fields like computed fields
      const lctx: Ctx = { ...ctx, side: "write", position: Number.MAX_SAFE_INTEGER };
      const layers: IrLayer[] = [];
      for (const a of it.attrs) {
        if (!el.checkAttrTarget(lctx, a, "layoutItem")) continue;
        const l = el.lowerLayer(lctx, a, "layoutItem");
        if (l) layers.push(l);
      }
      if (it.path === "this") {
        if (it.group)
          el.report(ctx, it.group.span, "unknown-layout-path", "`this` can't have a group.");
        if (seen.has("this"))
          el.report(ctx, it.span, "duplicate-layout-item", "`this` is placed twice.", {
            tags: ["unnecessary"]
          });
        seen.set("this", it);
        items.push({ path: "this", layers });
        continue;
      }
      const key =
        it.path.map(s => (s.kind === "each" ? "[*]" : "." + s.name.name)).join("") +
        (it.group ? "{}" : "");
      const display = key.replace(/^\./, "").replace(/\{\}$/, "");
      if (seen.has(key)) {
        el.report(
          ctx,
          it.span,
          "duplicate-layout-item",
          `'${display}' is already placed by an earlier item.`,
          {
            tags: ["unnecessary"],
            related: [
              { file: this.sym.module.file, span: seen.get(key)!.span, message: "placed here" }
            ]
          }
        );
      }
      seen.set(key, it);
      const resolved = this.resolveLayoutPath(it.path, scope);
      if (!resolved) continue;
      const path: IrPathSegment[] = it.path.map(s =>
        s.kind === "each"
          ? { kind: "each" as const }
          : { kind: "field" as const, name: s.name.name }
      );
      if (it.group) {
        // the group's path names the array: `volumes[*] { … }` → path `volumes`
        const last = it.path[it.path.length - 1]!;
        let arrayType: IrType | undefined;
        if (last.kind === "each") {
          path.pop();
          arrayType = resolved.parent;
        } else {
          arrayType = resolved.type;
          el.report(
            ctx,
            last.span,
            "unknown-layout-path",
            `A layout group runs once per element: write '${display}[*] { … }'.`,
            {
              fixes: [
                {
                  title: "Add [*]",
                  edits: [
                    {
                      file: this.sym.module.file,
                      span: { start: last.span.end, end: last.span.end },
                      newText: "[*]"
                    }
                  ],
                  isPreferred: true
                }
              ]
            }
          );
        }
        const elemScope = arrayType && this.elementScope(arrayType);
        if (!elemScope) {
          el.report(
            ctx,
            it.span,
            "unknown-layout-path",
            `'${display}' must be an array of structs (or of pointers to structs) to group per element.`
          );
          continue;
        }
        const inner = this.lowerLayoutItems(it.group.items, elemScope);
        if (!it.group.items.length)
          el.report(ctx, it.group.span, "layout-not-placeable", "An empty group places nothing.");
        items.push({ path, layers, group: { items: inner } });
        continue;
      }
      if (!resolved.placeable && !this.containsPlaceables(resolved.type, new Set())) {
        el.report(
          ctx,
          it.span,
          "layout-not-placeable",
          `'${display}' has no pointer or \`at\` targets to place.`
        );
      }
      items.push({ path, layers });
    }
    return items;
  }

  /** The element struct of an array type (through pointers), as a scope for group items. */
  private elementScope(t: IrType): LayoutScope | undefined {
    const u = targetCore(t);
    if (u.kind !== "array") return undefined;
    const e = targetCore(u.element);
    return e.kind === "struct" ? this.structScope(e.struct) : undefined;
  }

  private structScope(id: string): LayoutScope | undefined {
    const inst = this.el.instancesById.get(id);
    if (!inst) return undefined;
    const r = this.el.results.get(id) ?? this.el.instanceResult(inst.sym, inst.typeArgs);
    return { sym: inst.sym, fields: r.fields };
  }

  private resolveLayoutPath(
    path: A.LayoutSegment[],
    scope: LayoutScope
  ): { type: IrType; placeable: boolean; parent?: IrType } | undefined {
    const { el, ctx } = this;
    let structSym: StructSym | undefined = scope.sym;
    let fields = scope.fields;
    let type: IrType | undefined;
    let parent: IrType | undefined;
    let placeable = false;
    for (const seg of path) {
      if (seg.kind === "each") {
        const t = type && targetCore(type);
        if (!t || t.kind !== "array") {
          el.report(ctx, seg.span, "unknown-layout-path", "`[*]` needs an array.");
          return undefined;
        }
        parent = type;
        type = t.element;
        placeable = false;
        continue;
      }
      if (type) {
        const t = targetCore(type);
        if (t.kind !== "struct") {
          el.report(
            ctx,
            seg.name.span,
            "unknown-layout-path",
            `Can't look up '${seg.name.name}': the path doesn't lead to a struct.`
          );
          return undefined;
        }
        const inner = this.structScope(t.struct);
        if (!inner) return undefined;
        structSym = inner.sym;
        fields = inner.fields;
      }
      const fs = structSym?.fieldsByName.get(seg.name.name)?.[0];
      if (!fs) {
        el.report(
          ctx,
          seg.name.span,
          "unknown-layout-path",
          `'${structSym?.name}' has no field '${seg.name.name}'.`
        );
        return undefined;
      }
      el.recordRef(ctx, seg.name.span, fs);
      const fr = fields.get(fs);
      if (!fr) return undefined;
      parent = type;
      type = fr.type;
      const ir = fr.ir as IrField;
      const core = coreType(fr.type);
      placeable =
        (ir.kind === "field" && !!ir.placement && !ir.placement.fixed) ||
        core.kind === "pointer" ||
        (core.kind === "array" && coreType(core.element).kind === "pointer");
    }
    return type ? { type, placeable, ...(parent ? { parent } : {}) } : undefined;
  }

  private containsPlaceables(t: IrType, seen: Set<string>): boolean {
    const u = coreType(t);
    if (u.kind === "pointer") return true;
    if (u.kind === "array") return this.containsPlaceables(u.element, seen);
    if (u.kind === "union") return u.variants.some(v => this.containsPlaceables(v.type, seen));
    if (u.kind !== "struct") return false;
    if (seen.has(u.struct)) return false;
    seen.add(u.struct);
    const scope = this.structScope(u.struct);
    if (!scope) return false;
    for (const f of scope.fields.values()) {
      const ir = f.ir as IrField;
      if (ir.kind === "field" && ir.placement) return true;
      if (this.containsPlaceables(f.type, seen)) return true;
    }
    return false;
  }

  // ── misc checks ──────────────────────────────────────────────────────────

  private checkRestNotLast(members: A.Member[]): void {
    const { el, ctx } = this;
    const inline = (m: A.Member): boolean => {
      if (m.kind === "FieldDecl") return !m.clauses.at && !m.clauses.from;
      return (
        m.kind === "BitsMember" ||
        m.kind === "BlockMember" ||
        m.kind === "IfMember" ||
        m.kind === "SwitchMember"
      );
    };
    const visit = (list: A.Member[]) => {
      list.forEach((m, i) => {
        if (m.kind === "FieldDecl" && inline(m)) {
          const fs = this.fieldOf.get(m);
          const fr = fs && this.result.fields.get(fs);
          if (fr && isIrField(fr.ir)) {
            const t = fr.ir.type;
            const hasSize =
              t.kind === "layered" && t.layers.some(l => l.kind === "size" || l.kind === "via");
            const core = coreType(t);
            const rest =
              (core.kind === "array" || core.kind === "bytes" || core.kind === "string") &&
              core.length.kind === "rest" &&
              !(core.kind === "array" && core.elementPlacement);
            if (rest && !hasSize && list.slice(i + 1).some(inline)) {
              el.report(
                ctx,
                m.name?.span ?? m.span,
                "rest-not-last",
                `'${fs!.name}' reads to the end of the region, so the fields after it would be empty. Give it a length or an @size.`
              );
            }
          }
        }
        if (m.kind === "BlockMember") visit(m.members);
        if (m.kind === "IfMember") {
          visit(m.then);
          if (m.else) visit(m.else);
        }
        if (m.kind === "SwitchMember") for (const c of m.cases) visit(c.members);
      });
    };
    visit(members);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function errorIrType(): IrType {
  return { kind: "struct", struct: "<error>", args: [] };
}

/** Strips layers, transforms and one pointer level. */
function targetCore(t: IrType): IrType {
  const u = coreType(t);
  return u.kind === "pointer" ? coreType(u.target) : u;
}

/** An array, bytes or string (through layers and transforms). */
function isSequence(t: IrType): boolean {
  const u = coreType(t);
  return u.kind === "array" || u.kind === "bytes" || u.kind === "string";
}

function coreTransform(t: IrType): IrTransformType | undefined {
  let x = t;
  while (x.kind === "layered") x = x.inner;
  return x.kind === "transform" ? x : undefined;
}

/** `@attr(word)` with a bare word argument, e.g. `@nullable(empty)`. */
function isWordArg(a: A.Attribute, word: string): boolean {
  const v = a.args?.[0] && unparen(a.args[0].value);
  return !!v && a.args!.length === 1 && v.kind === "Name" && v.name === word;
}

function caseCompatible(disc: IrValueType, v: IrValueType): boolean {
  if (isErrorType(disc) || isErrorType(v)) return true;
  if (isIntType(disc)) return isIntType(v);
  if (disc.kind === "enum") return v.kind === "enum" && v.enum === disc.enum;
  return disc.kind === v.kind;
}

/** A formula with no data dependencies (literals, and the `endian` parameter for character codes). */
function isConstantFormula(e: IrExpr): boolean {
  let ok = true;
  const visit = (x: IrExpr) => {
    switch (x.kind) {
      case "literal":
        return;
      case "param":
        if (x.name !== "endian") ok = false;
        return;
      case "binary":
        visit(x.left);
        visit(x.right);
        return;
      case "cond":
        visit(x.test);
        visit(x.then);
        visit(x.else);
        return;
      case "unary":
        visit(x.operand);
        return;
      case "convert":
        visit(x.operand);
        return;
      default:
        ok = false;
    }
  };
  visit(e);
  return ok;
}

function encodedUnits(s: string, encoding: string): number {
  switch (encoding) {
    case "utf8":
      return Buffer.byteLength(s, "utf8");
    case "utf16":
      return s.length;
    case "utf32":
      return [...s].length;
    default:
      return s.length;
  }
}
