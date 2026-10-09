/** Writers: `write_body` per struct (docs/IR.md §3), relocation style on `yr::Writer`. */
import type {
  IrBits,
  IrExpr,
  IrField,
  IrFill,
  IrLayer,
  IrLayoutItem,
  IrStreamExpr,
  IrMember,
  IrSwitch,
  IrType
} from "../../ir/index.ts";
import { indent } from "./emit.ts";
import {
  asBool,
  asInt,
  compile,
  eqExpr,
  literal,
  load,
  tmp,
  toParamValue,
  toStored,
  encodingRust,
  type CExpr,
  type ExprCtx,
  type FieldRef
} from "./expr.ts";
import {
  cacheKey,
  codecArg,
  endianCode,
  findParam,
  paramRef,
  ptrFormat,
  typeHash
} from "./gen-read.ts";
import {
  BackendError,
  allFields,
  layoutExprs,
  measuredFields,
  memberExprs,
  effectiveLayers,
  endianVar,
  fieldAccess,
  fieldPlace,
  primInfo,
  splitLeading,
  structLayerCount,
  switchAccess,
  typeKey,
  walkExpr,
  type FieldInfo,
  type Model,
  type Shape,
  type StructModel
} from "./model.ts";
import { sanitize, strLit } from "./names.ts";

type Level = number | "all";

interface Val {
  /** A place expression holding the stored value. */
  place: string;
  /** Borrowed from the input value (lives for `'a`). */
  input: boolean;
}

/** A write environment at the top of a struct (or root value). */
function topEnv(endian: string, field = "", key = ""): WEnv {
  return { endian, indices: [], field, inVia: false, slots: new Map(), levels: 0, key };
}

/** Binds what a late closure captures: the position and `$index` where it was registered. */
const LATE_CAPTURES = "let __at = w.mark(); let __idx = w.index; let _ = (__at, __idx);";

/** A check run after layout: `body` returns its errors; `pre` binds values captured now. */
function lateCheck(body: string, pre = ""): string {
  return `{ ${pre}${LATE_CAPTURES} w.late_check(Box::new(move |__r: &yr::Resolver| -> yr::Result<()> { ${body} Ok(()) }))?; }`;
}

interface WEnv {
  endian: string;
  indices: string[];
  field: string;
  /** Inside a codec's decoded side (marks there don't survive the sub-base). */
  inVia: boolean;
  /** Slots of the field being written: level → slot variable. */
  slots: Map<Level, string[]>;
  /** Number of layers of the field's type (level "all" = this). */
  levels: number;
  /** Scope key of the value being written (pointer placeables). */
  key: string;
  /** Value of a late derived field (closure body expression) instead of `val`. */
  late?: { field: FieldInfo };
  /** The field whose own value (not an element) is being written, with its index depth. */
  self?: { field: string; depth: number };
  /** Compiling the arguments of `self`'s struct type. */
  selfArgs?: boolean;
  /** Compiled outside a writer (views): positions, `$index` and measurements are errors. */
  noWriter?: boolean;
}

/** Whether values of this type contain generated structs (written by reference, borrowed for 'a). */
function holdsStructs(t: IrType): boolean {
  switch (t.kind) {
    case "struct":
    case "union":
      return true;
    case "array":
      return holdsStructs(t.element);
    case "layered":
      return holdsStructs(t.inner);
    case "transform":
      return holdsStructs(t.inner);
    case "pointer":
      return holdsStructs(t.target);
    default:
      return false;
  }
}

export class WriteGen {
  private measured: Map<string, Set<Level>>;
  private slotVars = new Map<string, string>();
  /** Carrier fields of virtual streams: the variable holding the piece (`&'a Vec<u8>`). */
  private sources = new Map<string, string>();
  /** Stream arrays whose elements were synthesized: the variable holding them (`&'a Vec<E>`). */
  private overrides = new Map<string, string>();
  private out: string[] = [];
  private nest = 0;

  private m: Model;
  private sm: StructModel;
  constructor(m: Model, sm: StructModel) {
    this.m = m;
    this.sm = sm;
    this.measured = measuredFields([
      ...memberExprs(sm.ir.members, true),
      ...layoutExprs(sm.ir.layout ?? [])
    ]);
    for (const [f, levels] of this.measured) {
      for (const l of levels) this.slotVars.set(`${f}|${l}`, `m_${sanitize(f)}_${l}`);
    }
  }

  private slotVar(field: string, level: Level): string {
    const info = this.sm.fields.get(field);
    // IR layer indices count the use-site layers only.
    const n = info?.type
      ? effectiveLayers(this.m, info.type).layers.length - structLayerCount(this.m, info.type)
      : 0;
    const l: Level = level === n ? "all" : level;
    const v = this.slotVars.get(`${field}|${l}`) ?? this.slotVars.get(`${field}|${level}`);
    if (!v) throw new BackendError(`internal: no slot for ${field} level ${level}`);
    return v;
  }

  /** Expression context in the write context (eager or late). */
  ctx(
    env: WEnv,
    mode: "eager" | "late",
    it?: ExprCtx["it"],
    visiting: Set<string> = new Set()
  ): ExprCtx {
    const sm = this.sm;
    const ctx: ExprCtx = {
      ...(env.self && env.selfArgs ? { selfField: env.self.field } : {}),
      m: this.m,
      sm,
      mode,
      field: (name): FieldRef => {
        const f = sm.fields.get(name);
        if (!f) throw new BackendError(`${sm.name} has no field ${name}`);
        if (f.derive && f.input !== "required") {
          if (visiting.has(name))
            throw new BackendError(`${sm.name}.${name}: cyclic derived values`);
          const inner = this.ctx(env, mode, undefined, new Set([...visiting, name]));
          let e = compile(inner, f.derive);
          e = this.derivedValueView(f, e, inner);
          if (f.input === "optional") {
            const acc = fieldAccess(f, "v");
            const loaded = load("(*__x)", f.shape);
            if (loaded.t.k !== e.t.k)
              throw new BackendError(`${sm.name}.${name}: optional input of this type`);
            return {
              kind: "expr",
              e: {
                code: `(match ${acc.code} { Some(__x) => ${loaded.code}, None => ${e.code} })`,
                t: e.t
              }
            };
          }
          return { kind: "expr", e };
        }
        const src = this.sources.get(name) ?? this.overrides.get(name);
        if (src) return { kind: "place", place: `(*${src})`, shape: f.shape };
        if (!f.output) throw new BackendError(`${sm.name}.${name}: hidden field without a formula`);
        return { kind: "place", place: fieldPlace(f, "v"), shape: f.shape };
      },
      param: name => {
        const p = findParam(sm, name);
        if (p.ir.origin === "endian")
          return { kind: "expr", e: { code: env.endian, t: { k: "endian" } } };
        return paramRef(p);
      },
      slot: (field, level) => this.slotVar(field, level),
      offset: () => (mode === "late" ? `__r.offset_at(__at)` : `w.offset_now()?`),
      end: () =>
        mode === "late"
          ? `__r.region_len()`
          : `(Err::<i128, yr::YaffleError>(yr::YaffleError::derive("$end is not known while encoding")))?`,
      index: () =>
        mode === "late"
          ? `__idx.map(|__i| __i as i128).ok_or_else(|| yr::YaffleError::range("$index outside an array"))?`
          : `w.index_value()?`
    };
    if (it) ctx.it = it;
    if (env.noWriter) {
      const no = (): never => {
        throw new BackendError(`${sm.name}: needs the writer`);
      };
      Object.assign(ctx, { slot: no, offset: no, end: no, index: no });
    }
    return ctx;
  }

  /** A derived field's value as seen by expressions (transforms read the raw derive). */
  private derivedValueView(f: FieldInfo, raw: CExpr, ctx: ExprCtx): CExpr {
    const t = f.type ? effectiveLayers(this.m, f.type).inner : undefined;
    if (t && t.kind === "transform") {
      const c2 = { ...ctx, it: { e: raw } };
      return compile(c2, t.read);
    }
    return raw;
  }

  generate(): string[] {
    const sm = this.sm;
    const s = sm.ir;
    const params = sm.params.map(p => `${p.v}: ${this.m.paramType(p.shape, "'a ")}`);
    const lines: string[] = [];
    lines.push(
      `pub(crate) fn write_body<'a>(w: &mut yr::Writer<'a>, v: &'a Self${params.map(p => ", " + p).join("")}) -> yr::Result<()> {`
    );
    const body: string[] = [];
    this.out = body;
    if (s.base) this.emit("w.begin_base();");
    for (const sv of new Set(this.slotVars.values())) this.emit(`let ${sv} = w.slot();`);
    const env = topEnv(endianVar(sm));
    if (s.layout && (s.base || this.m.structBearing(s.id))) {
      this.emit(`w.set_layout(vec![${s.layout.map(it => this.layoutItem(it, env)).join(", ")}]);`);
    }
    const thisSlot = this.slotVars.get("$this|all");
    if (thisSlot) this.emit("let __this_start = w.mark();");
    this.streams(env);
    this.takeSources();
    this.members(s.members, env);
    if (thisSlot)
      this.emit(`{ let __sp = w.span_from(__this_start); w.set_slot(${thisSlot}, __sp); }`);
    if (s.base) {
      // `@alignEnd` of a `@base` struct pads its whole region, after its targets.
      for (const l of s.layers) {
        if (l.kind !== "alignEnd") continue;
        this.emit(`w.base_align_end(${this.alignExpr(l, env)})?;`);
      }
      this.emit("w.end_base_inline()?;");
    }
    this.emit("Ok(())");
    lines.push(...indent(body));
    lines.push("}");
    return lines;
  }

  /**
   * Whether writing a value of this type opens a layout scope: inline values that contain
   * placeables. Pointers don't: their placeable is registered directly under the field's key.
   */
  private scoped(t: IrType): boolean {
    const inner = effectiveLayers(this.m, t).inner;
    return inner.kind !== "pointer" && this.m.bearing(t);
  }

  /** Statements writing one field of `v` (views: re-encoding a field for an in-place patch). */
  fieldCode(f: IrField, endian: string): string[] {
    return this.capture(() => this.field(f, topEnv(endian)));
  }

  /**
   * Views ("append"): the placement alignments and the encoding statements of a target's content
   * (a placed field's type or a pointer's target type) held at `place`.
   */
  targetContent(
    t: IrType,
    place: string,
    endian: string,
    field: string
  ): { aligns: string[]; code: string[] } {
    const env = topEnv(endian, field);
    const { inner, layers } = effectiveLayers(this.m, t);
    const { aligns, rest } = leadingAligns(layers);
    const alignCode = aligns.map(a => this.alignExpr(a, { ...env, noWriter: true }));
    const code = this.capture(() =>
      this.layered(inner, rest, { place, input: true }, { ...env, levels: rest.length })
    );
    return { aligns: alignCode, code };
  }

  /** Declarations of every measurement slot of the struct. */
  slotDecls(): string[] {
    return [...new Set(this.slotVars.values())].map(sv => `let ${sv} = w.slot();`);
  }

  /** Statements writing a root value `v` (with struct-level layers) in `serialize_with`. */
  rootWrite(t: IrType, endian: string): string[] {
    const env = topEnv(endian, "$self", `yr::Key::Field("$root")`);
    return this.capture(() => {
      const s = t.kind === "struct" ? this.m.struct(t.struct).ir : undefined;
      const own: IrLayer[] = s && !s.base ? s.layers.filter(l => l.kind === "alignEnd") : [];
      if (own.length === 0) return this.writeType(t, { place: "(*v)", input: true }, env);
      // The root is the outermost base: its `@alignEnd` pads the whole file, after its targets.
      const { inner, layers } = effectiveLayers(this.m, t);
      const rest = layers.filter(l => !own.includes(l));
      this.layered(inner, rest, { place: "(*v)", input: true }, { ...env, levels: rest.length });
      for (const l of own) {
        if (l.kind !== "alignEnd") continue;
        this.emit(`w.base_align_end(${this.alignExpr(l, env)})?;`);
      }
    });
  }

  private emit(...l: string[]) {
    this.out.push(...l);
  }

  private capture(lines: () => void): string[] {
    const saved = this.out;
    const out: string[] = [];
    this.out = out;
    lines();
    this.out = saved;
    return out;
  }

  // ─── Virtual streams ───────────────────────────────────────────────────────

  private streams(env: WEnv): void {
    const froms = allFields(this.sm.ir.members).filter(f => f.from);
    const done = new Set<IrField>();
    const encode = (mem: IrField): string => {
      const place = fieldPlace(this.sm.fields.get(mem.name)!, "v");
      const sx = tmp("sx");
      const inner = this.capture(() =>
        this.writeType(
          mem.type,
          { place, input: true },
          { ...env, field: mem.name, inVia: true, slots: new Map(), levels: 0, key: mem.name }
        )
      );
      this.emit(
        `w.push_field(${strLit(mem.name)});`,
        `let ${sx}: Vec<u8> = {`,
        "    w.begin_space();",
        ...indent(inner),
        "    w.end_base()?",
        "};",
        "w.pop_path();"
      );
      return sx;
    };
    for (const mem of froms) {
      if (done.has(mem)) continue;
      const root = streamRoot(mem.from!.stream);
      const key = rootKey(root.root);
      const group = froms.filter(
        g => !done.has(g) && rootKey(streamRoot(g.from!.stream).root) === key
      );
      for (const g of group) done.add(g);
      let bytes: string;
      if (group.length === 1 && mem.from!.stream.kind !== "slice") bytes = encode(mem);
      else {
        // Slices: the stream is assembled from every slice field's encoding.
        const ctx = this.ctx(env, "eager");
        const parts = group.map(g => {
          const sx = encode(g);
          const r = streamRoot(g.from!.stream);
          const start = r.start ? asInt(compile(ctx, r.start)) : "0";
          const end = r.end ? `Some(${asInt(compile(ctx, r.end))})` : "None";
          return `yr::SlicePart { name: ${strLit(g.name)}, start: ${start}, end: ${end}, bytes: &${sx} }`;
        });
        bytes = tmp("sl");
        this.emit(
          `let ${bytes}: Vec<u8> = yr::assemble_slices(${this.carrierLength(root.root, env)}, &[${parts.join(", ")}])?;`
        );
      }
      const st = root.root;
      if (st.kind === "field") {
        this.emit(`w.push_pieces(${this.m.streamId(this.sm.ir.id, st.field)}, vec![${bytes}]);`);
      } else if (st.kind === "each") {
        const fit = group.some(g => g.from!.split?.policy === "fit");
        this.eachStream(st.array, st.field, bytes, env, fit);
      }
    }
  }

  /**
   * The length of a sliced field: its own `count` length when that doesn't depend on the
   * field itself (through derived fields), else `None` (the largest slice end).
   */
  private carrierLength(root: IrStreamExpr, env: WEnv): string {
    if (root.kind !== "field") return "None";
    const f = this.sm.fields.get(root.field);
    if (!f?.type) return "None";
    const t = effectiveLayers(this.m, f.type).inner;
    if (t.kind !== "bytes" || t.length.kind !== "count") return "None";
    const refers = (e: IrExpr, seen: Set<string>): boolean => {
      let hit = false;
      walkExpr(e, x => {
        if (hit || x.kind !== "field") return;
        if (x.name === root.field) hit = true;
        const g = this.sm.fields.get(x.name);
        if (g?.derive && g.input !== "required" && !seen.has(x.name))
          hit = refers(g.derive, new Set([...seen, x.name]));
      });
      return hit;
    };
    if (refers(t.length.expr, new Set())) return "None";
    return `Some(yr::int::len(${asInt(compile(this.ctx(env, "eager"), t.length.expr))})?)`;
  }

  /**
   * Splits a stream's encoded content into the pieces of `arr[*].field`: by the pieces' size
   * fields when the input gives them all, else by `@split(fit)` (the longest prefix whose encoded
   * element ends before the next element's offset). Missing elements are synthesized.
   */
  private eachStream(
    arrName: string,
    field: string,
    sx: string,
    env: WEnv,
    fitPolicy: boolean
  ): void {
    const arrDecl = allFields(this.sm.ir.members).find(f => f.name === arrName);
    const arr = this.sm.fields.get(arrName);
    if (!arrDecl || !arr) throw new BackendError(`unknown stream array ${arrName}`);
    const at = effectiveLayers(this.m, arrDecl.type).inner;
    if (at.kind !== "array") throw new BackendError(`stream ${arrName} is not an array`);
    const et = effectiveLayers(this.m, at.element).inner;
    if (et.kind !== "struct")
      throw new BackendError(`stream ${arrName} is not an array of structs`);
    const esm = this.m.struct(et.struct);
    const src = esm.fields.get(field);
    if (!src?.type) throw new BackendError(`${esm.name} has no field ${field}`);
    const id = this.m.streamId(esm.ir.id, field);
    const elemTy = esm.name;
    const ctx = this.ctx(env, "eager");
    const args = esm.params.map((pm, i) => toParamValue(ctx, compile(ctx, et.args[i]!), pm.shape));
    const hasInput = arr.output;
    const aplace = fieldPlace(arr, "v");
    // The pieces' decoded sizes: the innermost @size of the carrier, or its count field.
    const { inner: srcInner, layers } = effectiveLayers(this.m, src.type);
    const sizeLayer = layers.find(l => l.kind === "size");
    let sizeName: string | undefined;
    if (sizeLayer && sizeLayer.kind === "size" && sizeLayer.size.kind === "field")
      sizeName = sizeLayer.size.name;
    else if (
      srcInner.kind === "bytes" &&
      srcInner.length.kind === "count" &&
      srcInner.length.expr.kind === "field"
    )
      sizeName = srcInner.length.expr.name;
    const sizeField = sizeName ? esm.fields.get(sizeName) : undefined;
    const sizeOpt = !!sizeField && (sizeField.input === "optional" || sizeField.optionalTop);
    let sizes = "None";
    if (hasInput && sizeField) {
      sizes = sizeOpt
        ? `${aplace}.iter().map(|__e| __e.${sizeField.ident}.map(|__x| __x as usize)).collect::<Option<Vec<usize>>>()`
        : `Some(${aplace}.iter().map(|__e| __e.${sizeField.ident} as usize).collect::<Vec<usize>>())`;
      // No pieces in the input: the split policy decides.
      sizes = `if ${aplace}.is_empty() && !${sx}.is_empty() { None } else { ${sizes} }`;
    }
    // Split points measured from the piece (optional inputs) are recomputed for a new split.
    const measures = (e: IrExpr) => {
      let hit = false;
      walkExpr(e, x => {
        if (x.kind === "field" && x.name === field) hit = true;
      });
      return hit;
    };
    const clearSize = [...esm.fields.values()]
      .filter(x => x.derive && x.input === "optional" && measures(x.derive))
      .map(x => `__t.${x.ident} = None;`)
      .join(" ");
    const template = (k: string) =>
      hasInput
        ? `{ let mut __t: ${elemTy} = ${aplace}.get(${k}).cloned().unwrap_or_default(); ${clearSize} __t }`
        : `{ let mut __t: ${elemTy} = ${elemTy}::default(); ${clearSize} __t }`;
    let fit: string;
    if (!fitPolicy) {
      fit = `if ${sx}.is_empty() { Vec::new() } else { return Err(yr::YaffleError::input(${strLit(`the piece sizes of ${arrName}[*].${field} are required`)})) }`;
    } else if (at.elementPlacement) {
      const off = asInt(compile(ctx, at.elementPlacement));
      fit = [
        `{ let __si0 = w.index; let __r = yr::split_fit(&${sx},`,
        `    |__k: usize| -> yr::Result<(u64, u64)> { w.index = Some(__k); let __s = yr::int::to::<u64>(${off})?; w.index = Some(__k + 1); let __l = yr::int::to::<u64>(${off})?; Ok((__s, __l)) },`,
        `    |__k: usize, __piece: &[u8]| -> yr::Result<usize> { let __tt: ${elemTy} = ${template("__k")}; let __ar = yr::Arena::new(); let mut __w2 = yr::Writer::with_arena(&__ar); __w2.begin_space(); __w2.push_pieces(${id}, vec![__piece.to_vec()]); ${elemTy}::write_body(&mut __w2, &__tt${args.map(a => ", " + a).join("")})?; Ok(__w2.end_base()?.len()) });`,
        `  w.index = __si0; __r? }`
      ].join("\n");
    } else {
      fit = `if ${sx}.is_empty() { Vec::new() } else { vec![${sx}.clone()] }`;
    }
    const ov = `__ov_${sanitize(arrName)}`;
    this.overrides.set(arrName, ov);
    this.emit(
      `let __sizes: Option<Vec<usize>> = ${sizes};`,
      `let (__pieces, __synth): (Vec<Vec<u8>>, bool) = match __sizes { Some(__s) => (yr::split_sizes(&${sx}, &__s)?, false), None => (${fit}, true) };`,
      `let ${ov}: &'a Vec<${elemTy}> = if __synth { let __n = __pieces.len(); w.arena()?.alloc((0..__n).map(|__k| ${template("__k")}).collect::<Vec<${elemTy}>>()) } else { ${hasInput ? `&${aplace}` : "unreachable!()"} };`,
      `w.push_pieces(${id}, __pieces);`
    );
  }

  /** Carrier fields of virtual streams in this struct: their content is the stream's piece. */
  private takeSources(): void {
    for (const f of allFields(this.sm.ir.members)) {
      const sid = this.m.streamIds.get(`${this.sm.ir.id}.${f.name}`);
      if (sid === undefined) continue;
      const info = this.sm.byDecl.get(f)!;
      const v = `__src_${sanitize(f.name)}`;
      this.sources.set(f.name, v);
      let fallback = "w.arena()?.alloc(Vec::new())";
      if (info.output) {
        const acc = fieldAccess(info, "v");
        fallback = acc.opt
          ? `match ${acc.code} { Some(__x) => __x, None => w.arena()?.alloc(Vec::new()) }`
          : `&${acc.code}`;
      }
      this.emit(
        `let ${v}: &'a Vec<u8> = match w.take_piece(${sid}) { Some(__p) => w.arena()?.alloc(__p), None => ${fallback} };`
      );
    }
  }

  // ─── Members ───────────────────────────────────────────────────────────────

  private members(ms: IrMember[], env: WEnv): void {
    for (const mem of ms) {
      if (mem.kind === "field") this.field(mem, env);
      else if (mem.kind === "bits") this.bits(mem, env);
      else if (mem.kind === "block") {
        if (mem.condition) {
          const c = asBool(compile(this.ctx(env, "eager"), mem.condition));
          const thenL = this.capture(() =>
            this.blockLayers(mem.layers, env, e => this.members(mem.members, e))
          );
          const elseL = mem.else
            ? this.capture(() => this.blockLayers(mem.layers, env, e => this.members(mem.else!, e)))
            : [];
          this.emit(`if ${c} {`, ...indent(thenL));
          if (elseL.length) this.emit("} else {", ...indent(elseL));
          this.emit("}");
        } else this.blockLayers(mem.layers, env, e => this.members(mem.members, e));
      } else this.switch_(mem, env);
    }
  }

  private switch_(sw: IrSwitch, env: WEnv): void {
    const swm = this.sm.switches.find(x => x.ir === sw)!;
    const ctx = this.ctx(env, "eager");
    const d = compile(ctx, sw.discriminant);
    const dv = tmp("d");
    const cs = tmp("cs");
    this.emit(`let ${dv} = ${d.code};`);
    const conds = sw.cases.map(
      (c, i) =>
        `if ${c.values.map(v => eqExpr({ code: dv, t: d.t }, literal(ctx, v))).join(" || ") || "false"} { ${i} }`
    );
    const fallback = sw.default
      ? "-1"
      : `return Err(yr::YaffleError::new(yr::ErrorCode::Check, "no switch case matches the discriminant"))`;
    this.emit(
      `let ${cs}: i32 = ${conds.length ? conds.join(" else ") + ` else { ${fallback} }` : `{ ${fallback} }`};`
    );
    const acc = switchAccess(swm, "v");
    const arms: string[] = [];
    for (const variant of swm.variants) {
      const pat = swm.tuple
        ? `${swm.enumName}::${variant.name}(..)`
        : variant.members.length === 0
          ? `${swm.enumName}::${variant.name}`
          : `${swm.enumName}::${variant.name} { .. }`;
      const members = variant.caseIndex === -1 ? sw.default! : sw.cases[variant.caseIndex]!.members;
      const body = this.capture(() => this.members(members, env));
      arms.push(`(${variant.caseIndex}, Some(${pat})) => {`, ...indent(body), "}");
    }
    arms.push(`(_, None) => return Err(yr::YaffleError::input("missing switch value")),`);
    arms.push(
      `_ => return Err(yr::YaffleError::input("the switch value's variant does not match the discriminant")),`
    );
    this.emit(`match (${cs}, ${acc}) {`, ...indent(arms), "}");
  }

  /** Writes `layers` (innermost first) around a block's members. */
  private blockLayers(layers: IrLayer[], env: WEnv, inner: (env: WEnv) => void): void {
    if (layers.length === 0) return inner(env);
    const rest = layers.slice(0, -1);
    this.layer(layers[layers.length - 1]!, rest, env, "block", e =>
      this.blockLayers(rest, e, inner)
    );
  }

  /**
   * Writes the outermost layer `l` around `next` (the `rest` of the layers and the content,
   * written in the environment inside). A codec layer encodes what `next` writes in a byte space
   * of its own; `decoded` gets those bytes first.
   */
  private layer(
    l: IrLayer,
    rest: IrLayer[],
    env: WEnv,
    key: "block" | "value",
    next: (env: WEnv) => void,
    decoded: (pl: string) => void = () => {}
  ): void {
    const ctx = this.ctx(env, "eager");
    switch (l.kind) {
      case "align":
        this.emit(this.alignStmt(l, env));
        return next(env);
      case "padBefore":
        this.emit(this.padStmt(l, env));
        return next(env);
      case "padAfter":
        next(env);
        this.emit(this.padStmt(l, env));
        return;
      case "padUntil": {
        const s = tmp("s");
        this.emit(`let ${s} = w.mark();`);
        next(env);
        this.emit(
          `w.pad_until(${s}, yr::int::to::<u64>(${asInt(compile(ctx, l.size))})?, ${this.fill(l.fill, env)})?;`
        );
        return;
      }
      case "alignEnd":
        next(env);
        this.emit(this.alignStmt(l, env));
        return;
      case "size": {
        // A size that depends on the layout is not known while encoding: no window.
        if (this.m.isLateExpr(this.sm, l.size)) return next(env);
        const s = tmp("s");
        this.emit(`let ${s} = w.mark();`);
        next(env);
        this.emit(`w.size_end(${s}, yr::int::to::<u64>(${asInt(compile(ctx, l.size))})?)?;`);
        return;
      }
      case "endian": {
        const e = tmp("en");
        this.emit(`let ${e} = ${compile(ctx, l.value).code};`);
        return next({ ...env, endian: e });
      }
      case "strict":
        return next(env);
      case "via": {
        const pl = tmp("pl");
        const body = this.capture(() => next({ ...env, inVia: true }));
        this.emit(
          `let ${pl}: Rc<Vec<u8>> = {`,
          "    w.begin_space();",
          ...indent(body),
          "    Rc::new(w.end_base()?)",
          "};"
        );
        decoded(pl);
        this.viaEncode(l, rest, pl, env, key);
        return;
      }
    }
  }

  /** The statement writing a `padBefore`/`padAfter` layer's padding. */
  private padStmt(l: Extract<IrLayer, { kind: "padBefore" | "padAfter" }>, env: WEnv): string {
    const n = asInt(compile(this.ctx(env, "eager"), l.count));
    return `w.fill(yr::int::len(${n})?, &${this.fill(l.fill, env)})?;`;
  }

  /**
   * `yr::Align` of an `align`/`alignEnd` layer, evaluated in the write context (layout items
   * may read the owning struct's fields); below 1 is `RANGE`.
   */
  alignExpr(l: Extract<IrLayer, { kind: "align" | "alignEnd" }>, env: WEnv): string {
    const ctx = this.ctx(env, "eager");
    const to = asInt(compile(ctx, l.to));
    const fill = l.fill.kind === "byte" ? l.fill.value & 0xff : 0;
    const off = l.offset ? asInt(compile(ctx, l.offset)) : "0";
    return `yr::Align::checked(${to}, ${fill}u8, ${l.from === "file"}, ${off})?`;
  }

  /** The padding statement of an `align`/`alignEnd` layer. */
  private alignStmt(l: Extract<IrLayer, { kind: "align" | "alignEnd" }>, env: WEnv): string {
    const ctx = this.ctx(env, "eager");
    const to = `yr::int::to::<u64>(${asInt(compile(ctx, l.to))})?`;
    const off = l.offset ? asInt(compile(ctx, l.offset)) : "0";
    return `w.align(${to}, ${l.from === "file"}, ${off}, ${this.fill(l.fill, env)})?;`;
  }

  /**
   * Views (`replace_`): the alignment the struct's own layout gives field `field` (an item naming
   * exactly that field), evaluated over `v`; undefined if none.
   */
  ownLayoutAlign(field: string, endian: string): string | undefined {
    const it = (this.sm.ir.layout ?? []).find(
      i =>
        !i.group &&
        i.path !== "this" &&
        i.path.length === 1 &&
        i.path[0]!.kind === "field" &&
        i.path[0]!.name === field
    );
    const al = it?.layers.find(l => l.kind === "align");
    if (!al || al.kind !== "align") return undefined;
    return this.alignExpr(al, { ...topEnv(endian, field), noWriter: true });
  }

  /** A `yr::LayoutItem` (groups nest). */
  private layoutItem(it: IrLayoutItem, env: WEnv): string {
    const path =
      it.path === "this"
        ? "None"
        : `Some(vec![${it.path.map(seg => (seg.kind === "each" ? "yr::LSeg::Each" : `yr::LSeg::Field(${strLit(seg.name)})`)).join(", ")}])`;
    const al = it.layers.find(l => l.kind === "align");
    const align = al && al.kind === "align" ? `Some(${this.alignExpr(al, env)})` : "None";
    const group = it.group
      ? `Some(vec![${it.group.items.map(g => this.layoutItem(g, env)).join(", ")}])`
      : "None";
    return `yr::LayoutItem { path: ${path}, align: ${align}, group: ${group} }`;
  }

  private fill(f: IrFill, env: WEnv): string {
    if (f.kind === "byte") return `yr::WFill::Byte(${f.value & 0xff})`;
    const ctx = this.ctx(env, "eager");
    ctx.lambda = { [f.param]: "__fi" };
    return `yr::WFill::Fn(Rc::new(move |__fi: i128| -> yr::Result<u8> { Ok((${asInt(compile(ctx, f.expr))} & 255) as u8) }))`;
  }

  /** Encodes the plain bytes `pl` with the codec (reusing cached original bytes). */
  private viaEncode(
    l: Extract<IrLayer, { kind: "via" }>,
    rest: IrLayer[],
    pl: string,
    env: WEnv,
    key: string
  ): void {
    const codec = this.m.extern(l.codec);
    if (codec.kind !== "codec") throw new BackendError(`${codec.name} is not a codec`);
    const path = this.m.externPath(l.codec);
    const ctx = this.ctx(env, "eager");
    const args = tmp("args");
    const enc = tmp("enc");
    const hasSize = rest.some(x => x.kind === "size");
    this.emit(
      `let ${args}: Vec<yr::Arg> = vec![${l.args.map((a, i) => codecArg(compile(ctx, a), codec.params[i]?.type.kind)).join(", ")}];`
    );
    const encode = `w.codec_encode(&${path}, &${pl}, &${args}, ${hasSize ? `Some(${pl}.len())` : "None"})?`;
    if (this.sm.hasCache) {
      this.emit(
        `let ${enc}: Vec<u8> = match v.__cache.lookup(&${cacheKey(env.field || key, env.indices)}, &${pl}, &${args}) { Some(__c) => __c.as_ref().clone(), None => ${encode} };`
      );
    } else this.emit(`let ${enc}: Vec<u8> = ${encode};`);
    this.emit(`w.byte_vec(${enc});`);
  }

  // ─── Fields ────────────────────────────────────────────────────────────────

  /**
   * A virtual field writes no bytes; its parts are derived from it. The read expression
   * must give the value back (else `DERIVE`).
   */
  private virtualField(f: IrField, env: WEnv): void {
    this.emit(`w.push_field(${strLit(f.name)});`);
    const self: IrExpr = { kind: "field", name: f.name, type: { kind: "bigint" } };
    const late = this.m.isLateExpr(this.sm, f.virtual!.read);
    const mode = late ? "late" : "eager";
    const ctx = this.ctx({ ...env, field: f.name }, mode);
    const cond = eqExpr(compile(ctx, f.virtual!.read), compile(ctx, self));
    const fail = `return Err(yr::YaffleError::derive(${strLit(`the parts of ${f.name} don't give back its value`)}));`;
    if (late) this.emit(lateCheck(`if !${cond} { ${fail} }`));
    else this.emit(`if !${cond} { ${fail} }`);
    // Checks on the virtual value (`where …`) apply to the input value on write too.
    const info = this.sm.byDecl.get(f);
    if (info && f.checks.length > 0) {
      const place = deref(info.shape, fieldPlace(info, "v"));
      this.fieldChecks(f.checks, info, false, { place, input: true }, env, false);
    }
    this.emit("w.pop_path();");
  }

  private field(f: IrField, env: WEnv): void {
    if (f.from) return;
    if (f.virtual) return this.virtualField(f, env);
    const info = this.sm.byDecl.get(f)!;
    const fenv: WEnv = {
      ...env,
      field: f.name,
      slots: new Map(),
      levels: 0,
      key: `yr::Key::Field(${strLit(f.name)})`,
      self: { field: f.name, depth: env.indices.length }
    };
    this.emit(`w.push_field(${strLit(f.name)});`);
    const late = !!f.derive && f.input !== "required" && this.m.isLateField(this.sm, f.name);
    let type: IrType = f.type;
    let val: Val;
    if (late) {
      fenv.late = { field: info };
      type = stripTransform(f.type);
      val = { place: "", input: false };
    } else if (f.derive && f.input !== "required") {
      type = stripTransform(f.type);
      const d = tmp("d");
      const raw = compile(this.ctx(env, "eager"), f.derive);
      const shape = this.m.shapeOfType(type, "");
      // Computed values that contain structs (derived arrays) are borrowed by the writer for
      // its whole lifetime ('a), like inputs, so they live in the writer's arena.
      const pinned = holdsStructs(type);
      const rt = this.m.rustType(shape);
      const value =
        f.input === "optional"
          ? `match ${fieldAccess(info, "v").code} { Some(__x) => __x.clone(), None => ${toStored(this.ctx(env, "eager"), raw, shape)} }`
          : toStored(this.ctx(env, "eager"), raw, shape);
      this.emit(
        pinned ? `let ${d}: &'a ${rt} = w.arena()?.alloc(${value});` : `let ${d}: ${rt} = ${value};`
      );
      val = { place: pinned ? `(*${d})` : d, input: false };
    } else {
      const src = this.sources.get(f.name) ?? this.overrides.get(f.name);
      if (src) val = { place: `(*${src})`, input: true };
      else {
        if (!f.output)
          throw new BackendError(`${this.sm.name}.${f.name}: hidden field without a formula`);
        val = { place: deref(info.shape, fieldPlace(info, "v")), input: true };
      }
      if (f.derive && effectiveLayers(this.m, f.type).inner.kind !== "transform") {
        // `= expr` using `it` on an input field: normalize the input value on write.
        const d = tmp("d");
        const ictx = this.ctx(env, "eager", { place: val.place, shape: info.shape });
        this.emit(
          `let ${d}: ${this.m.rustType(info.shape)} = ${toStored(ictx, compile(ictx, f.derive), info.shape)};`
        );
        val = { place: d, input: false };
      }
    }
    if (f.placement) this.placed(f, type, val, fenv);
    else {
      // Leading alignment and padding are written before the field's measured span.
      const { inner, layers } = effectiveLayers(this.m, type);
      const { leading, rest } = splitLeading(layers);
      this.leadingPads(leading, fenv);
      const slots = this.fieldSlots(f.name, type, rest.length);
      const bearing = this.scoped(type);
      if (bearing) this.emit(`w.enter(yr::Key::Field(${strLit(f.name)}));`);
      this.layered(inner, rest, val, { ...fenv, slots, levels: rest.length });
      if (bearing) this.emit("w.leave();");
    }
    this.fieldChecks(f.checks, info, late, val, env, !!f.derive && f.input !== "required");
    this.emit("w.pop_path();");
  }

  /**
   * The slots of a field keyed by effective level (struct-level layers first, then the use-site
   * layers the IR's `encodedSize(x, k)` indices count). Levels at or above `restLen` are "all".
   */
  private fieldSlots(name: string, type: IrType, restLen: number): Map<Level, string[]> {
    const nStruct = structLayerCount(this.m, type);
    const slots = new Map<Level, string[]>();
    const add = (k: Level, v: string) => {
      const l = slots.get(k) ?? [];
      if (!l.includes(v)) l.push(v);
      slots.set(k, l);
    };
    for (const l of this.measured.get(name) ?? []) {
      const v = this.slotVar(name, l);
      if (l === "all") add("all", v);
      else {
        const eff = l + nStruct;
        add(eff >= restLen ? "all" : eff, v);
      }
    }
    return slots;
  }

  private leadingPads(leading: IrLayer[], env: WEnv): void {
    for (const l of leading) {
      if (l.kind === "align") this.emit(this.alignStmt(l, env));
      else if (l.kind === "padBefore") this.emit(this.padStmt(l, env));
    }
  }

  private fieldChecks(
    checks: IrField["checks"],
    info: FieldInfo,
    late: boolean,
    val: Val,
    env: WEnv,
    derived: boolean
  ): void {
    for (const c of checks) {
      if (c.strictOnly) continue;
      if (late || this.m.isLateExpr(this.sm, c.expr)) {
        const lctx = this.ctx(
          env,
          "late",
          late ? { e: this.lateValue(info, env) } : { place: val.place, shape: unbox(info.shape) }
        );
        if (!late && !val.input) continue;
        const cond = asBool(compile(lctx, c.expr));
        this.emit(
          lateCheck(
            `if !${cond} { return Err(yr::YaffleError::new(yr::ErrorCode::Check, ${strLit("check failed: " + c.message)})); }`
          )
        );
      } else {
        const cctx = this.ctx(env, "eager", { place: val.place, shape: unbox(info.shape) });
        if (derived && val.place === "") continue;
        const cond = asBool(compile(cctx, c.expr));
        this.emit(
          `if !${cond} { return Err(yr::YaffleError::new(yr::ErrorCode::Check, ${strLit("check failed: " + c.message)})); }`
        );
      }
    }
  }

  /** The late value of a derived field, as an expression evaluated in a fixup closure. */
  private lateValue(info: FieldInfo, env: WEnv): CExpr {
    if (!info.derive) throw new BackendError("lateValue of a field without a formula");
    return compile(this.ctx(env, "late"), info.derive);
  }

  /** Late byte-reads (slots read by bytesof/encode/crc of non-bytes) of an expression, transitively. */
  private lateReads(e: IrExpr, seen = new Set<string>()): string[] {
    const out: string[] = [];
    walkExpr(e, x => {
      if (x.kind === "call" && x.callee.kind === "builtin") {
        const n = x.callee.name;
        const a = x.args[0];
        if (a?.kind === "field") {
          if (n === "bytesof" || ((n === "crc32" || n === "adler32") && a.type.kind !== "bytes"))
            out.push(this.slotVar(a.name, "all"));
          if (n === "encode") out.push(this.slotVar(a.name, 0));
        }
      } else if (x.kind === "field" && !seen.has(x.name)) {
        const f = this.sm.fields.get(x.name);
        if (f?.derive && f.input !== "required" && this.m.isLateField(this.sm, x.name)) {
          seen.add(x.name);
          out.push(...this.lateReads(f.derive, seen));
        }
      }
    });
    return [...new Set(out)];
  }

  private placed(f: IrField, type: IrType, val: Val, env: WEnv): void {
    const pl = f.placement!;
    const ctx = this.ctx(env, "eager");
    const { inner, layers } = effectiveLayers(this.m, type);
    const { aligns, rest } = leadingAligns(layers);
    const alignCode = aligns.map(a => this.alignExpr(a, env));
    const opts = [`align: vec![${alignCode.join(", ")}]`];
    if (pl.constraint)
      opts.push(`constraint: Some((${pl.constraint.modulus}u64, ${pl.constraint.remainder}u64))`);
    if (pl.fixed) opts.push(`fixed: Some(yr::int::to::<u64>(${asInt(compile(ctx, pl.offset))})?)`);
    const pid = tmp("pid");
    const slots = this.fieldSlots(f.name, type, rest.length);
    const body = this.capture(() =>
      this.layered(inner, rest, val, { ...env, slots: withoutAll(slots), levels: rest.length })
    );
    const allSlots = slots.get("all") ?? [];
    if (pl.emptyIsNull && !env.late) {
      // `@nullable(empty)`: an empty array isn't placed, and its offset is 0.
      this.emit(
        `if ${val.place}.is_empty() {`,
        ...allSlots.map(s => `    w.set_slot(${s}, yr::Span::Null);`),
        "} else {",
        ...indent([
          `let ${pid} = w.place(None, yr::Key::Field(${strLit(f.name)}), yr::PlaceOpts { ${opts.join(", ")}, ..Default::default() }, |w: &mut yr::Writer<'a>| -> yr::Result<()> {`,
          ...indent(body),
          "    Ok(())",
          "})?;",
          ...allSlots.map(s => `w.set_slot(${s}, yr::Span::Place(${pid}));`)
        ]),
        "}"
      );
    } else {
      this.emit(
        `let ${pid} = w.place(None, yr::Key::Field(${strLit(f.name)}), yr::PlaceOpts { ${opts.join(", ")}, ..Default::default() }, |w: &mut yr::Writer<'a>| -> yr::Result<()> {`,
        ...indent(body),
        "    Ok(())",
        "})?;"
      );
      for (const s of allSlots) this.emit(`w.set_slot(${s}, yr::Span::Place(${pid}));`);
    }
    const all = allSlots[0];
    // The offset expression must agree with where the layout put the target.
    if (!pl.fixed && this.m.isLateExpr(this.sm, pl.offset)) {
      const sv = all ?? this.slotVars.get(`${f.name}|all`);
      if (sv) {
        const lctx = this.ctx(env, "late");
        const want = asInt(compile(lctx, pl.offset));
        // An empty target accepts any offset.
        const sized =
          !env.late &&
          (inner.kind === "array" || inner.kind === "bytes" || inner.kind === "string");
        const ne = sized ? `!${val.place}.is_empty()` : "true";
        this.emit(
          lateCheck(
            `if __ne && ${want} != __r.offset(${sv})? { return Err(yr::YaffleError::derive("the placement offset does not match where the target was placed")); }`,
            `let __ne: bool = ${ne}; `
          )
        );
      }
    }
  }

  private bits(b: IrBits, env: WEnv): void {
    const pi = primInfo(b.storage);
    const u = tmp("u");
    this.emit(`let mut ${u}: u64 = 0;`);
    for (const bf of b.fields) {
      if (bf.name === null) continue;
      const info = this.sm.byDecl.get(bf)!;
      this.emit(`w.push_field(${strLit(bf.name)});`);
      let x: string;
      if (bf.derive && bf.input !== "required") {
        if (this.m.isLateField(this.sm, bf.name))
          throw new BackendError(
            `${this.sm.name}.${bf.name}: layout-dependent bitfields are not supported`
          );
        x = asInt(compile(this.ctx(env, "eager"), bf.derive));
      } else {
        x = asInt(load(fieldPlace(info, "v"), info.shape));
      }
      const xv = tmp("bx");
      const signed =
        (bf.type.kind === "prim" && primInfo(bf.type.prim).signed) ||
        (bf.type.kind === "enum" && primInfo(this.m.enum(bf.type.enum).ir.storage).signed);
      const lo = signed ? `-(1i128 << ${bf.width - 1})` : "0";
      const hi = signed ? `(1i128 << ${bf.width - 1})` : `(1i128 << ${bf.width})`;
      this.emit(
        `let ${xv}: i128 = ${x};`,
        `if ${xv} < ${lo} || ${xv} >= ${hi} { return Err(yr::YaffleError::range(format!("{} does not fit in ${bf.width} bits", ${xv}))); }`,
        `${u} |= ((${xv} as u64) & ${bf.width >= 64 ? "u64::MAX" : `0x${((1n << BigInt(bf.width)) - 1n).toString(16)}u64`}) << ${bf.shift};`
      );
      for (const c of bf.checks) {
        if (c.strictOnly) continue;
        // `it` is the raw integer: checks that don't apply to it (enum members) are skipped.
        let cond: string;
        try {
          cond = asBool(
            compile(this.ctx(env, "eager", { e: { code: xv, t: { k: "int" } } }), c.expr)
          );
        } catch {
          continue;
        }
        this.emit(
          `if !${cond} { return Err(yr::YaffleError::new(yr::ErrorCode::Check, ${strLit("check failed: " + c.message)})); }`
        );
      }
      this.emit("w.pop_path();");
    }
    this.emit(`w.uint(${u}, ${pi.bytes}, ${endianCode(b.endian, env.endian)});`);
  }

  // ─── Types ─────────────────────────────────────────────────────────────────

  writeType(t: IrType, val: Val, env: WEnv): void {
    const { inner, layers } = effectiveLayers(this.m, t);
    this.layered(inner, layers, val, { ...env, levels: layers.length });
  }

  /** Writes `inner` wrapped in `layers` (innermost first); records measured levels. */
  private layered(inner: IrType, layers: IrLayer[], val: Val, env: WEnv): void {
    const isAll = layers.length === env.levels;
    const slots = [
      ...(env.slots.get(layers.length) ?? []),
      ...(isAll ? (env.slots.get("all") ?? []) : [])
    ];
    const mk = slots.length > 0 && !env.inVia ? tmp("mk") : undefined;
    if (mk) this.emit(`let ${mk} = w.mark();`);
    this.layeredInner(inner, layers, val, env);
    if (mk)
      this.emit(
        `{ let __sp = w.span_from(${mk}); ${slots.map(s => `w.set_slot(${s}, __sp.clone());`).join(" ")} }`
      );
  }

  private layeredInner(inner: IrType, layers: IrLayer[], val: Val, env: WEnv): void {
    if (layers.length === 0) return this.plain(inner, val, env);
    const l = layers[layers.length - 1]!;
    const rest = layers.slice(0, -1);
    if (l.kind === "via" && env.late)
      throw new BackendError(
        `${this.sm.name}.${env.field}: a layout-dependent value inside a codec`
      );
    const next = (e: WEnv) => this.layered(inner, rest, val, e);
    this.layer(l, rest, env, "value", next, pl => {
      // Levels inside this codec (above any inner codec) measure its decoded bytes.
      const innerVia = rest.findLastIndex(x => x.kind === "via");
      for (let k = innerVia + 1; k < layers.length; k++)
        for (const sv of env.slots.get(k) ?? [])
          this.emit(`w.set_slot(${sv}, yr::Span::Data(${pl}.clone()));`);
    });
  }

  private plain(t: IrType, val: Val, env: WEnv): void {
    if (env.late) return this.latePlain(t, env);
    const refKey = this.m.refKeys.has(typeKey(t)) && val.input ? typeHash(t) : undefined;
    const cm = refKey ? tmp("cm") : undefined;
    if (cm) this.emit(`let ${cm} = w.mark();`);
    this.plainInner(t, val, env);
    const cid =
      t.kind === "struct" && this.m.identStructs.has(t.struct) ? `${val.place}.__id.id` : "0";
    if (cm) this.emit(`w.candidate(&${val.place}, ${cid}, ${strLit(refKey!)}, ${cm})?;`);
  }

  private plainInner(t: IrType, val: Val, env: WEnv): void {
    const p = val.place;
    switch (t.kind) {
      case "prim":
        return this.emit(writePrim(t.prim, p, endianCode(t.endian, env.endian)));
      case "bool":
        return this.emit(`w.bool(${p});`);
      case "string": {
        const len =
          t.length.kind === "count"
            ? `yr::StrLen::Count(yr::int::len(${asInt(compile(this.ctx(env, "eager"), t.length.expr))})?)`
            : t.length.kind === "until"
              ? "yr::StrLen::Until"
              : "yr::StrLen::Rest";
        return this.emit(
          `w.string(&${p}, ${encodingRust(t.encoding)}, ${endianCode(t.endian, env.endian)}, ${len})?;`
        );
      }
      case "bytes": {
        if (t.length.kind === "count") this.lengthCheck(t.length.expr, `${p}.len()`, env);
        if (t.length.kind === "until") {
          const term = t.length.terminator;
          if (term.kind !== "literal" || term.value.kind !== "int")
            throw new BackendError("bytes terminator must be an integer literal");
          const tb = Number(term.value.value) & 0xff;
          this.emit(
            `if ${p}.contains(&${tb}u8) { return Err(yr::YaffleError::input("bytes contain their terminator")); }`,
            `w.bytes(&${p});`,
            `w.u8(${tb}u8);`
          );
          return;
        }
        return this.emit(`w.bytes(&${p});`);
      }
      case "array":
        return this.array(t, val, env);
      case "struct":
        return this.structValue(t, val, env);
      case "enum": {
        const en = this.m.enum(t.enum);
        const pi = primInfo(en.ir.storage);
        const e = endianCode(t.endian, env.endian);
        return this.emit(
          pi.signed
            ? `w.sint(${p}.to_raw() as i64, ${pi.bytes}, ${e});`
            : `w.uint(${p}.to_raw() as u64, ${pi.bytes}, ${e});`
        );
      }
      case "pointer":
        return this.pointer(t, val, env);
      case "extern":
        return this.externValue(t, val, env);
      case "union":
        return this.unionValue(t, val, env);
      case "transform":
        return this.transformValue(t, val, env);
      case "layered":
        return this.writeType(t, val, env);
    }
  }

  private structValue(t: Extract<IrType, { kind: "struct" }>, val: Val, env: WEnv): void {
    const p = val.place;
    const sm = this.m.struct(t.struct);
    // `offsetof(<this field>)` in the arguments is the current position.
    const own = env.self && env.self.depth === env.indices.length ? env.self.field : undefined;
    const ctx = this.ctx(own ? { ...env, selfArgs: true } : env, "eager");
    const args = sm.params.map((pm, i) => {
      const a = t.args[i];
      if (!a) throw new BackendError(`missing argument ${pm.ir.name} for ${sm.name}`);
      return toParamValue(ctx, compile(ctx, a), pm.shape);
    });
    // Computed struct values (`filter`/`sortedBy` over struct arrays) are
    // values of the same generated type, so they are written like inputs.
    return this.emit(`${sm.name}::write_body(w, &${p}${args.map(a => ", " + a).join("")})?;`);
  }

  private externValue(t: Extract<IrType, { kind: "extern" }>, val: Val, env: WEnv): void {
    const p = val.place;
    const ex = this.m.extern(t.extern);
    if (ex.kind !== "type") throw new BackendError(`${ex.name} is not an extern type`);
    const path = this.m.externPath(t.extern);
    const ctx = this.ctx(env, "eager");
    const b = tmp("b");
    this.emit(
      `let ${b} = yr::ExternType::write(&${path}, &${p}, &[${t.args.map((a, i) => codecArg(compile(ctx, a), ex.params[i]?.type.kind)).join(", ")}]).map_err(yr::YaffleError::codec)?;`
    );
    if (ex.fixedSize !== undefined)
      this.emit(
        `if ${b}.len() != ${ex.fixedSize} { return Err(yr::YaffleError::input("extern type wrote the wrong number of bytes")); }`
      );
    return this.emit(`w.byte_vec(${b});`);
  }

  private unionValue(t: Extract<IrType, { kind: "union" }>, val: Val, env: WEnv): void {
    const p = val.place;
    const u = this.m.unionFor(t, "");
    const arms: string[] = [];
    for (const v of u.variants) {
      const x = tmp("ux");
      const body = this.capture(() =>
        this.writeType(v.type, { place: deref(v.shape, `(*${x})`), input: val.input }, env)
      );
      arms.push(`${u.name}::${v.name}(${x}) => {`, ...indent(body), "}");
    }
    return this.emit(`match &${p} {`, ...indent(arms), "}");
  }

  private transformValue(t: Extract<IrType, { kind: "transform" }>, val: Val, env: WEnv): void {
    const p = val.place;
    const innerShape = this.m.shapeOfType(t.inner, "");
    if (!t.write) return this.writeType(t.inner, { place: `${p}.raw`, input: val.input }, env);
    const raw = tmp("raw");
    const valShape = this.m.shapeOfValue(t.valueType, "");
    const wctx = this.ctx(env, "eager", { place: p, shape: valShape });
    this.emit(
      `let ${raw}: ${this.m.rustType(innerShape)} = ${toStored(wctx, compile(wctx, t.write), innerShape)};`
    );
    if (valShape.k !== "float") {
      const rctx = this.ctx(env, "eager", { place: raw, shape: innerShape });
      const back = compile(rctx, t.read);
      this.emit(
        `if !${eqExpr(back, load(p, valShape))} { return Err(yr::YaffleError::input("the value does not round-trip through its transform")); }`
      );
    }
    return this.writeType(t.inner, { place: raw, input: false }, env);
  }

  /** A late derived value: reserved bytes filled after layout. */
  private latePlain(t: IrType, env: WEnv): void {
    const info = env.late!.field;
    const e = this.lateValue(info, env);
    const reads = info.derive ? this.lateReads(info.derive) : [];
    let width: number;
    let enc: string;
    if (t.kind === "prim") {
      const pi = primInfo(t.prim);
      width = pi.bytes;
      const en = endianCode(t.endian, env.endian);
      if (pi.float) {
        const f = e.t.k === "int" ? `(${e.code} as f64)` : e.code;
        enc =
          pi.bits === 16
            ? `Ok(yr::prim::enc_uint(yr::prim::f64_to_f16(${f}) as u64, 2, ${en}))`
            : pi.bits === 32
              ? `Ok(yr::prim::enc_uint((${f} as f32).to_bits() as u64, 4, ${en}))`
              : `Ok(yr::prim::enc_uint((${f}).to_bits(), 8, ${en}))`;
      } else enc = `yr::write::enc_int(${asInt(e)}, ${pi.bytes}, ${en}, ${pi.signed})`;
    } else if (t.kind === "enum") {
      const en = this.m.enum(t.enum);
      const pi = primInfo(en.ir.storage);
      width = pi.bytes;
      enc = `yr::write::enc_int(${asInt(e)}, ${pi.bytes}, ${endianCode(t.endian, env.endian)}, ${pi.signed})`;
    } else if (t.kind === "bool") {
      width = 1;
      enc = `Ok(vec![${asBool(e)} as u8])`;
    } else
      throw new BackendError(
        `${this.sm.name}.${info.name}: a layout-dependent value of type ${t.kind} is not supported`
      );
    this.emit(
      `{ ${LATE_CAPTURES} w.fixup(${width}, vec![${reads.join(", ")}], Box::new(move |__r: &yr::Resolver| -> yr::Result<Vec<u8>> { ${enc} }))?; }`
    );
  }

  private lengthCheck(expr: IrExpr, actual: string, env: WEnv): void {
    if (this.m.isLateExpr(this.sm, expr)) {
      // Checked after layout; the actual length is captured now.
      const n = tmp("ln");
      const lctx = this.ctx(env, "late");
      this.emit(
        lateCheck(
          `let __want = ${asInt(compile(lctx, expr))}; if __want != ${n} { return Err(yr::YaffleError::derive(format!("{} elements written, but the length expression gives {}", ${n}, __want))); }`,
          `let ${n} = ${actual} as i128; `
        )
      );
      return;
    }
    const want = asInt(compile(this.ctx(env, "eager"), expr));
    this.emit(
      `{ let __want = ${want}; if __want != ${actual} as i128 { return Err(yr::YaffleError::derive(format!("{} elements written, but the length expression gives {}", ${actual}, __want))); } }`
    );
  }

  private array(t: Extract<IrType, { kind: "array" }>, val: Val, env: WEnv): void {
    const p = val.place;
    const i = tmp("i");
    const e = tmp("e");
    const si = tmp("si");
    const eenv: WEnv = {
      ...env,
      indices: [...env.indices, i],
      slots: new Map(),
      levels: 0,
      key: `yr::Key::Index(${i})`
    };
    const elemBearing = this.scoped(t.element);
    if (t.length.kind === "count" && !t.elementPlacement)
      this.lengthCheck(t.length.expr, `${p}.len()`, env);
    const ctx = this.ctx(env, "eager");
    if (t.elementPlacement) {
      const off = asInt(compile(ctx, t.elementPlacement));
      if (t.length.kind === "count") this.lengthCheck(t.length.expr, `${p}.len()`, env);
      const body = this.capture(() =>
        this.writeType(t.element, { place: `(*${e})`, input: val.input }, eenv)
      );
      this.emit(
        `let ${si} = w.index;`,
        `for (${i}, ${e}) in ${p}.iter().enumerate() {`,
        `    w.index = Some(${i});`,
        `    let __off = yr::int::to::<u64>(${off})?;`,
        `    w.push_index(${i});`,
        `    w.place(None, yr::Key::Index(${i}), yr::PlaceOpts { fixed: Some(__off), ..Default::default() }, |w: &mut yr::Writer<'a>| -> yr::Result<()> {`,
        ...indent(body, 2),
        "        Ok(())",
        "    })?;",
        "    w.pop_path();",
        "}",
        `w.index = ${si};`
      );
      return;
    }
    const body = this.capture(() => {
      if (elemBearing) this.emit(`w.enter(yr::Key::Index(${i}));`);
      this.writeType(t.element, { place: `(*${e})`, input: val.input }, eenv);
      if (elemBearing) this.emit("w.leave();");
    });
    let termLines: string[] = [];
    if (t.length.kind === "until") {
      const term = compile(ctx, t.length.terminator);
      const elemShape = this.m.shapeOfType(t.element, "", false);
      body.unshift(
        `if ${eqExpr(load(`(*${e})`, elemShape), term)} { return Err(yr::YaffleError::input("an element equals the array's terminator")); }`
      );
      const tv = tmp("term");
      termLines = this.capture(() => {
        this.emit(`let ${tv}: ${this.m.rustType(elemShape)} = ${toStored(ctx, term, elemShape)};`);
        this.writeType(
          t.element,
          { place: tv, input: false },
          { ...eenv, key: "yr::Key::Index(usize::MAX)" }
        );
      });
    }
    if (t.length.kind === "before") {
      // Not written; an element equal to it would end the array early on read.
      const term = compile(ctx, t.length.terminator);
      const elemShape = this.m.shapeOfType(t.element, "", false);
      body.unshift(
        `if ${eqExpr(load(`(*${e})`, elemShape), term)} { return Err(yr::YaffleError::input("an element equals the array's terminator")); }`
      );
    }
    if (t.length.kind === "untilPredicate") {
      // The last element must satisfy the predicate and no earlier one may.
      const elemShape = this.m.shapeOfType(t.element, "", false);
      const pctx = this.ctx(env, "eager", { place: `(*${e})`, shape: elemShape });
      const pred = asBool(compile(pctx, t.length.predicate));
      body.unshift(
        `if ${pred} != (${i} + 1 == ${p}.len()) { return Err(yr::YaffleError::new(yr::ErrorCode::Check, "only the last element may satisfy the array's end condition")); }`
      );
      this.emit(
        `if ${p}.is_empty() { return Err(yr::YaffleError::new(yr::ErrorCode::Check, "an array ended by a condition can't be empty")); }`
      );
    }
    this.emit(
      `let ${si} = w.index;`,
      `for (${i}, ${e}) in ${p}.iter().enumerate() {`,
      `    w.index = Some(${i});`,
      `    w.push_index(${i});`,
      ...indent(body),
      "    w.pop_path();",
      "}",
      ...termLines,
      `w.index = ${si};`
    );
  }

  private pointer(t: Extract<IrType, { kind: "pointer" }>, val: Val, env: WEnv): void {
    const pi = primInfo(t.storage);
    const e = endianCode(t.storageEndian, env.endian);
    const tt = tmp("t");
    const lines: string[] = [];
    const tinner = effectiveLayers(this.m, t.target).inner;
    const identTarget = tinner.kind === "struct" && this.m.identStructs.has(tinner.struct);
    // `@origin(expr)`: evaluated after layout, like a write formula.
    let origin = "None";
    if (t.origin) {
      const want = asInt(compile(this.ctx(env, "late"), t.origin));
      lines.push(LATE_CAPTURES);
      origin = `Some(Box::new(move |__r: &yr::Resolver| -> yr::Result<i128> { Ok(${want}) }))`;
    }
    const fmt = ptrFormat(t, env.endian);
    if (t.ownership === "ref") {
      if (!val.input)
        throw new BackendError(`${this.sm.name}.${env.field}: @ref pointers need an input value`);
      lines.push(
        `w.ref_pointer(&**${tt}, ${identTarget ? `(**${tt}).__id.id` : "0"}, ${strLit(typeHash(t.target))}, ${fmt}, ${origin})?;`
      );
    } else {
      const { inner, layers } = effectiveLayers(this.m, t.target);
      const { aligns, rest } = leadingAligns(layers);
      const alignCode = aligns.map(a => this.alignExpr(a, env));
      const body = this.capture(() =>
        this.layered(
          inner,
          rest,
          { place: `(**${tt})`, input: val.input },
          { ...env, slots: new Map(), levels: rest.length }
        )
      );
      const pid = tmp("pid");
      lines.push(
        `let ${pid} = w.place(Some((${identTarget ? `(**${tt}).__id.key(Rc::as_ptr(${tt}) as *const () as usize)` : `Rc::as_ptr(${tt}) as *const () as usize`}, ${strLit(typeHash(t.target))})), ${env.key || 'yr::Key::Field("")'}, yr::PlaceOpts { align: vec![${alignCode.join(", ")}], ..Default::default() }, |w: &mut yr::Writer<'a>| -> yr::Result<()> {`,
        ...indent(body),
        "    Ok(())",
        "})?;",
        `w.pointer(${pid}, ${fmt}, ${origin})?;`
      );
    }
    if (t.nullValue !== undefined) {
      const nv = BigInt(t.nullValue);
      const nullWrite = pi.signed
        ? `w.sint(${nv}i64, ${pi.bytes}, ${e});`
        : `w.uint(${nv}u64, ${pi.bytes}, ${e});`;
      if (t.emptyIsNull) {
        // `@nullable(empty)`: an empty array is written as null.
        this.emit(
          "{",
          `    let ${tt} = &${val.place};`,
          `    if ${tt}.is_empty() { ${nullWrite} } else {`,
          ...indent(lines, 2),
          "    }",
          "}"
        );
        return;
      }
      this.emit(
        `match &${val.place} {`,
        `    None => { ${nullWrite} }`,
        `    Some(${tt}) => {`,
        ...indent(lines, 2),
        "    }",
        "}"
      );
    } else {
      this.emit("{", `    let ${tt} = &${val.place};`, ...indent(lines), "}");
    }
  }
}

function unbox(s: Shape): Shape {
  return s.k === "box" ? s.inner : s;
}

/** The value inside a boxed (recursive) field. */
function deref(s: Shape, place: string): string {
  return s.k === "box" ? `(*${place})` : place;
}

/** A type without its transform (derived values are raw). */
function stripTransform(t: IrType): IrType {
  if (t.kind === "transform") return t.inner;
  if (t.kind === "layered") return { ...t, inner: stripTransform(t.inner) };
  return t;
}

/** Outermost `align` layers of a placed target become placement alignments. */
function leadingAligns(layers: IrLayer[]): {
  aligns: Extract<IrLayer, { kind: "align" }>[];
  rest: IrLayer[];
} {
  const aligns: Extract<IrLayer, { kind: "align" }>[] = [];
  let n = layers.length;
  while (n > 0 && layers[n - 1]!.kind === "align") {
    aligns.unshift(layers[n - 1] as Extract<IrLayer, { kind: "align" }>);
    n--;
  }
  return { aligns: aligns.reverse(), rest: layers.slice(0, n) };
}

function withoutAll(slots: Map<Level, string[]>): Map<Level, string[]> {
  const m = new Map(slots);
  m.delete("all");
  return m;
}

function writePrim(p: string, place: string, e: string): string {
  const pi = primInfo(p as never);
  if (pi.float) {
    if (pi.bits === 16) return `w.f16(${place} as f32, ${e});`;
    if (pi.bits === 32) return `w.f32(${place} as f32, ${e});`;
    return `w.f64(${place} as f64, ${e});`;
  }
  const std = pi.bits === 8 || pi.bits === 16 || pi.bits === 32 || pi.bits === 64;
  if (pi.signed) {
    if (std) return `w.sint(${place} as i64, ${pi.bytes}, ${e});`;
    return `w.sint(yr::int::to_sbits(${place} as i128, ${pi.bits})?, ${pi.bytes}, ${e});`;
  }
  if (std) return `w.uint(${place} as u64, ${pi.bytes}, ${e});`;
  return `w.uint(yr::int::to_ubits(${place} as i128, ${pi.bits})?, ${pi.bytes}, ${e});`;
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
