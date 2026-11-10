/**
 * Views: per struct an argument struct, `scan_body` (gen-read), and a `…View` type.
 *
 * Every view of a document shares a `yr::ViewRoot` (the bytes, the reader state with target
 * identities and decoded regions, and a node cache: every handle of one struct shares its
 * state). A struct view holds its scan: the shallow value (placeholders for targets, codec
 * regions and streams) and a span per field with the read context there. Fields with
 * placeholders are read on demand:
 *
 * - inline and `at` structs, arrays of structs, and pointer targets become views of their own;
 *   `materialize()` reads them through those views, with identity (`$ref`s, cycles);
 * - `from arr[*].field` streams decode only the pieces a read touches, when the pieces' decoded
 *   sizes are known from size fields;
 * - everything else is read at its span with the generated reader code (codec regions are
 *   decoded once and kept; `@ranged` ones block by block).
 */
import type { IrExpr, IrField, IrRoot, IrType } from "../../ir/index.ts";
import { indent } from "./emit.ts";
import { tmp } from "./expr.ts";
import { ReadGen, argAsParam, endianCode, identityPart, typeHash, type Env } from "./gen-read.ts";
import { paramBinds, paramField } from "./gen-root.ts";
import { WriteGen } from "./gen-write.ts";
import {
  BackendError,
  allFields,
  effectiveLayers,
  endianVar,
  rootType,
  fieldAccess,
  layoutExprs,
  primInfo,
  typeExprs,
  walkExpr,
  type FieldInfo,
  type Model,
  type RMember,
  type StructModel,
  type SwitchModel
} from "./model.ts";
import { sanitize, strLit } from "./names.ts";

function hasVia(m: Model, t: IrType): boolean {
  return effectiveLayers(m, t).layers.some(l => l.kind === "via");
}

/** The struct id a view of this type opens (through layers without codecs), if any. */
function viewStruct(m: Model, t: IrType): string | undefined {
  const { inner } = effectiveLayers(m, t);
  return inner.kind === "struct" && !hasVia(m, t) ? inner.struct : undefined;
}

/**
 * The struct id a view of this type opens through any layers: codec layers are decoded (kept by
 * the view root; `@ranged` ones block by block) and the view is in the decoded region.
 */
function viewStructAny(m: Model, t: IrType): string | undefined {
  const { inner } = effectiveLayers(m, t);
  return inner.kind === "struct" ? inner.struct : undefined;
}

/** How a field with placeholders is read on demand. */
type Plan =
  | { k: "struct"; sid: string }
  | { k: "structs"; sid: string }
  | { k: "target"; sid: string; t: Extract<IrType, { kind: "pointer" }> }
  | { k: "targets"; sid: string; t: Extract<IrType, { kind: "pointer" }> }
  | { k: "pieces"; arr: IrField; carrier: string; esid: string }
  | { k: "read" };

export class ViewGen {
  private m: Model;
  private sm: StructModel;
  private reads: ReadGen;
  /** Declarations whose `__get_k` exists. */
  private getters = new Set<IrField>();
  /** Declarations whose view function (`__view_k`, `__views_k`, `__tview_k`, `__tviews_k`) exists. */
  private viewFns = new Set<IrField>();

  /** The view function of `f` for its plan. */
  private viewFnOf(f: IrField): string[] {
    const plan = this.plan(f);
    switch (plan.k) {
      case "struct":
        return this.viewFn(f, plan.sid, "one");
      case "structs":
        return this.viewFn(f, plan.sid, "many");
      case "target":
        return this.targetViewFn(f, plan.sid, plan.t, "one");
      case "targets":
        return this.targetViewFn(f, plan.sid, plan.t, "many");
      default:
        throw new BackendError(`${this.name}.${f.name}: no view of this field`);
    }
  }

  constructor(m: Model, sm: StructModel) {
    this.m = m;
    this.sm = sm;
    this.reads = new ReadGen(m, sm);
  }

  private get name(): string {
    return this.sm.name;
  }

  private idx(f: IrField): number {
    return this.reads.fieldIndex.get(f)!;
  }

  private layoutRefsMemo: Set<string> | undefined;

  /** Fields the arguments of the struct's layout items read, groups included. */
  private layoutRefs(): Set<string> {
    if (!this.layoutRefsMemo) {
      const exprs = layoutExprs(this.sm.ir.layout ?? []);
      this.layoutRefsMemo = new Set(exprs.flatMap(x => [...valueRefs(x)]));
    }
    return this.layoutRefsMemo;
  }

  private paramBinds(): string[] {
    return this.sm.params.map(p => `let ${p.v} = ${argAsParam(p, `self.args.${p.v}`)};`);
  }

  private paramList(): string {
    return this.sm.params.map(p => ", " + p.v).join("");
  }

  /** Statements opening reader `r` over the span `__sp`'s region at `start`. */
  private readerAt(start: string): string[] {
    return [
      "let __g = self.ctx.space(__sp.region)?;",
      "let __src = __g.src();",
      "let __len = __src.len();",
      "let mut __rd = yr::Reader::over(__src, __sp.region, &self.ctx.shared, __sp.strict);",
      "let r = &mut __rd;",
      "r.base = __sp.base;",
      "r.end = yr::view::end_of(__sp.limit, __len);",
      "r.index = self.loc.index;",
      `r.pos = ${start};`,
      "let __sp_endian = __sp.endian;",
      "let __this_o: i128 = self.loc.start as i128 - self.loc.base as i128;",
      // Codec regions read on demand are recorded in the node's cache (byte-exact rebuilds).
      ...(this.sm.hasCache
        ? ["let mut __cache: yr::ViaCache = self.state.borrow().value.__cache.clone();"]
        : [])
    ];
  }

  private env(field: string): Env {
    return { rv: "r", endian: "__sp_endian", indices: [], field };
  }

  /** The span of declaration `f` (`__sp`), or a `no_span` error. */
  private spanOf(f: IrField): string[] {
    return [
      `let __sp = self.state.borrow().spans[${this.idx(f)}].ok_or_else(|| yr::view::no_span(${strLit(f.name)}))?;`
    ];
  }

  /** Every declaration of a field info (switch cases and if/else branches may repeat a field). */
  private declsOf(info: FieldInfo): IrField[] {
    const out: IrField[] = [];
    for (const [d, i] of this.sm.byDecl) if (i === info && d && "kind" in d) out.push(d as IrField);
    return out;
  }

  /** The first declaration of a field name. */
  private firstDecl(name: string): IrField | undefined {
    return allFields(this.sm.ir.members).find(f => f.name === name);
  }

  /**
   * Locals the reader code of an expression list refers to: earlier fields (from the shallow
   * value, or read on demand when they hold placeholders or are hidden) and measured offsets and
   * sizes (from spans).
   */
  private localBinds(exprs: IrExpr[], self: IrField): string[] {
    const names = new Set<string>();
    const measured = new Set<string>();
    for (const e of exprs) {
      walkExpr(e, x => {
        if (x.kind === "field") names.add(x.name);
        if (x.kind === "call" && x.callee.kind === "builtin" && x.args[0]?.kind === "field") {
          const n = x.callee.name;
          if (
            ["sizeof", "offsetof", "bytesof", "encode", "encodedSize", "crc32", "adler32"].includes(
              n
            )
          )
            measured.add(x.args[0].name);
        }
      });
    }
    const out: string[] = [];
    for (const n of names) {
      const f = this.sm.fields.get(n);
      if (!f) throw new BackendError(`${this.name} has no field ${n}`);
      const ty = this.m.rustType(f.shape);
      const decl = this.firstDecl(n);
      const lazy = !!decl && decl !== self && (this.m.lazyField(decl) || !f.output);
      if (lazy && decl && !f.conditional) {
        this.getters.add(decl);
        out.push(`let ${f.local}: ${ty} = self.__get_${this.idx(decl)}()?;`);
        continue;
      }
      if (!f.output)
        throw new BackendError(`${this.name}.${n}: hidden conditional field used by a view`);
      if (f.switches.length > 0)
        out.push(
          `let ${f.local}: Option<${ty}> = ${fieldAccess(f, "self.state.borrow().value").code}.cloned();`
        );
      else if (f.conditional || f.optionalTop)
        out.push(`let ${f.local}: Option<${ty}> = self.state.borrow().value.${f.ident}.clone();`);
      else if (f.input === "optional")
        out.push(
          `let ${f.local}: ${ty} = yr::take(self.state.borrow().value.${f.ident}.clone(), ${strLit(f.name)})?;`
        );
      else out.push(`let ${f.local}: ${ty} = self.state.borrow().value.${f.ident}.clone();`);
    }
    for (const n of measured) {
      const decl = this.firstDecl(n);
      const k = decl ? this.idx(decl) : undefined;
      const span = k === undefined ? "None" : `self.state.borrow().spans[${k}]`;
      out.push(
        `let (o_${sanitize(n)}, s_${sanitize(n)}): (i128, i128) = match ${span} { Some(__s) => (__s.start as i128 - __s.base as i128, (__s.end - __s.start) as i128), None => (0, 0) };`
      );
    }
    return out;
  }

  /** How declaration `f` is read on demand. */
  private plan(f: IrField): Plan {
    if (f.from) {
      const st = f.from.stream;
      if (st.kind === "each") {
        const arr = this.firstDecl(st.array);
        if (arr && !arr.from) {
          const { inner } = effectiveLayers(this.m, arr.type);
          if (inner.kind === "array" && !hasVia(this.m, arr.type)) {
            const esid = viewStruct(this.m, inner.element);
            if (esid) return { k: "pieces", arr, carrier: st.field, esid };
          }
        }
      }
      return { k: "read" };
    }
    const sid = viewStructAny(this.m, f.type);
    if (sid) return { k: "struct", sid };
    const { inner } = effectiveLayers(this.m, f.type);
    if (inner.kind === "array") {
      const el = viewStructAny(this.m, inner.element);
      if (el) return { k: "structs", sid: el };
      const ei = effectiveLayers(this.m, inner.element);
      if (ei.inner.kind === "pointer" && !ei.inner.origin && ei.layers.length === 0) {
        const t = viewStructAny(this.m, ei.inner.target);
        if (t) return { k: "targets", sid: t, t: ei.inner };
      }
    }
    if (!f.placement && inner.kind === "pointer" && !inner.origin && !hasVia(this.m, f.type)) {
      const t = viewStructAny(this.m, inner.target);
      if (t) return { k: "target", sid: t, t: inner };
    }
    return { k: "read" };
  }

  generate(): string[] {
    const name = this.name;
    const fieldItems = this.sm.members.flatMap(mm =>
      mm.k === "field"
        ? [...this.getter(mm), ...this.viewGetter(mm), ...this.setter(mm), ...this.replacer(mm)]
        : []
    );
    const materialize = this.materialize();
    const pieces = this.pieces();
    const lazy = this.lazyItems();
    return [
      `/// Arguments a \`${name}\` was read with (stored by views).`,
      "#[derive(Debug, Clone, Default)]",
      `pub struct ${name}__Args {`,
      ...this.sm.params.map(p => `    pub ${p.v}: ${this.m.rustType(p.shape)},`),
      "}",
      "",
      `/// A lazy view of \`${name}\`: members are read on demand; same-size edits are patched in place.`,
      "#[derive(Clone)]",
      `pub struct ${name}View {`,
      "    ctx: yr::ViewCtx,",
      "    loc: yr::Loc,",
      `    args: Rc<${name}__Args>,`,
      `    state: Rc<std::cell::RefCell<yr::ViewState<${name}>>>,`,
      "}",
      `impl ${name}View {`,
      ...indent([
        ...this.openFns(),
        ...this.spanFn(),
        ...this.refreshFns(),
        ...materialize,
        "/// The whole value, read through the view (`materialize`).",
        `pub fn parse(&self) -> yr::Result<${name}> {`,
        "    self.materialize()",
        "}",
        "/// The patches applied to the document so far.",
        "pub fn patches(&self) -> Vec<yr::Patch> {",
        "    self.ctx.patches()",
        "}",
        "/// The document's current bytes.",
        "pub fn commit(&self) -> yr::Result<Vec<u8>> {",
        "    self.ctx.bytes()",
        "}",
        ...fieldItems,
        ...pieces,
        ...lazy
      ]),
      "}"
    ];
  }

  /** Piece lengths of this struct's stream carriers (pieces of a `from arr[*].field`). */
  private pieces(): string[] {
    const out: string[] = [];
    for (const f of allFields(this.sm.ir.members)) {
      if (!this.m.streamIds.has(`${this.sm.ir.id}.${f.name}`)) continue;
      this.getters.add(f);
      out.push(...this.pieceLen(f));
    }
    return out;
  }

  /** On-demand readers and view functions (the sets grow while they are generated). */
  private lazyItems(): string[] {
    const out: string[] = [];
    const done = new Set<IrField>();
    const doneViews = new Set<IrField>();
    for (;;) {
      const next = [...this.getters].find(g => !done.has(g));
      if (next) {
        done.add(next);
        out.push(...this.lazyGetter(next));
        continue;
      }
      const nv = [...this.viewFns].find(g => !doneViews.has(g));
      if (!nv) return out;
      doneViews.add(nv);
      out.push(...this.viewFnOf(nv));
    }
  }

  private openFns(): string[] {
    const name = this.name;
    const cache = this.sm.hasCache;
    return [
      `/// The view of a scanned \`${name}\` (every handle of one struct shares its state).`,
      `pub fn open(ctx: &yr::ViewCtx, s: yr::Scan<${name}, ${name}__Args>) -> Self {`,
      "    let loc = s.loc;",
      "    let version = ctx.version();",
      `    let yr::Scan { ${cache ? "mut " : ""}value, spans, end_pos, args, .. } = s;`,
      ...(cache ? ["    value.__cache.share();"] : []),
      `    let state = ctx.node(loc.region, loc.start, ${strLit(name)}, &[${this.sm.params.flatMap(p => identityPart(p, `args.${p.v}`) ?? []).join(", ")}], move || std::cell::RefCell::new(yr::ViewState { value, spans, end_pos, version, edits: Default::default() }));`,
      `    ${name}View { ctx: ctx.clone(), loc, args: Rc::new(args), state }`,
      "}",
      "/// Where the struct's members start, and its base and region end.",
      "pub fn loc(&self) -> yr::Loc {",
      "    self.loc",
      "}",
      "/// The views' shared root.",
      "pub fn ctx(&self) -> &yr::ViewCtx {",
      "    &self.ctx",
      "}",
      "/// The members as scanned: targets, codec regions and streams are default placeholders.",
      `pub fn shallow(&self) -> ${name} {`,
      "    self.state.borrow().value.clone()",
      "}"
    ];
  }

  /** `span(field)`: a field declared in several branches has one span per branch. */
  private spanFn(): string[] {
    const arms: string[] = [];
    const seen = new Set<string>();
    for (const [f, k] of this.reads.fieldIndex) {
      if (seen.has(f.name)) continue;
      seen.add(f.name);
      const ks = allFields(this.sm.ir.members)
        .filter(g => g.name === f.name)
        .map(g => this.idx(g));
      arms.push(
        ks.length === 1
          ? `        ${strLit(f.name)} => ${k},`
          : `        ${strLit(f.name)} => { let st = self.state.borrow(); return [${ks.join(", ")}].iter().find_map(|&k| st.spans[k]); }`
      );
    }
    return [
      "/// The span of a field (inline bytes, the target address of pointers and `at` fields, and the read context).",
      "pub fn span(&self, field: &str) -> Option<yr::FieldSpan> {",
      "    let k: usize = match field {",
      ...arms,
      "        _ => return None,",
      "    };",
      "    self.state.borrow().spans[k]",
      "}"
    ];
  }

  private refreshFns(): string[] {
    return [
      "fn fresh(&self) -> yr::Result<()> {",
      "    if self.state.borrow().version != self.ctx.version() {",
      "        self.refresh()?;",
      "    }",
      "    Ok(())",
      "}",
      "/// Scans the members again (after patches).",
      "pub fn refresh(&self) -> yr::Result<()> {",
      "    let __s = {",
      "        let __g = self.ctx.space(self.loc.region)?;",
      "        let __src = __g.src();",
      "        let __len = __src.len();",
      "        let mut __rd = yr::Reader::over(__src, self.loc.region, &self.ctx.shared, self.loc.strict);",
      "        let r = &mut __rd;",
      "        r.pos = self.loc.start;",
      "        r.base = self.loc.base;",
      "        r.end = yr::view::end_of(self.loc.end, __len);",
      "        r.index = self.loc.index;",
      ...indent(this.paramBinds(), 2),
      `        ${this.name}::scan_body(r${this.paramList()})?`,
      "    };",
      "    let mut st = self.state.borrow_mut();",
      ...(this.sm.hasCache
        ? [
            "    let __keep = st.value.__cache.clone();",
            "    st.value = __s.value;",
            "    st.value.__cache = __keep;"
          ]
        : ["    st.value = __s.value;"]),
      "    st.spans = __s.spans;",
      "    st.end_pos = __s.end_pos;",
      "    st.version = self.ctx.version();",
      "    Ok(())",
      "}"
    ];
  }

  // ─── Materialize ─────────────────────────────────────────────────────────────

  /** `materialize()`: the whole value, with every placeholder read through the view. */
  private materialize(): string[] {
    const sm = this.sm;
    const name = this.name;
    const ident = this.m.identStructs.has(sm.ir.id);
    const fills: string[] = [];
    const visit = (members: RMember[]) => {
      for (const mm of members) {
        if (mm.k === "switch") {
          for (const v of mm.sw.variants) visit(v.members);
          continue;
        }
        for (const d of this.declsOf(mm.info)) {
          const pk = this.plan(d).k;
          const lazy = this.m.lazyField(d);
          if (!lazy && pk !== "struct" && pk !== "structs") continue;
          // Edits made through child views only show when the field is read through them.
          const cond = lazy ? "" : "self.ctx.is_structural() && ";
          this.getters.add(d);
          const k = this.idx(d);
          const assign = this.assign(mm, "__x");
          const edited = this.editable(mm)
            ? `!(self.ctx.edits_apply() && __edits.contains_key(&${this.idx(mm.info.ir!)})) && `
            : "";
          fills.push(
            `if ${edited}${cond}self.state.borrow().spans[${k}].is_some() { let __s = self.state.borrow().spans[${k}].unwrap(); let __x = self.__get_${k}().rf(${strLit(d.name)}, __s.start)?; ${assign} }`
          );
        }
      }
    };
    visit(sm.members);
    // the arguments that are part of the identity, as the reader's `begin_ident` gets them
    const idParts = `&[${sm.params.flatMap(p => identityPart(p, `self.args.${p.v}`) ?? []).join(", ")}]`;
    // Structural edits (set_ with a size change, or fields with placeholders).
    for (const mm of sm.members) {
      if (mm.k !== "field" || !this.editable(mm)) continue;
      const k = this.idx(mm.info.ir!);
      fills.push(
        `if let Some(__x) = yr::view::edit_of::<${this.m.rustType(mm.info.shape)}>(&self.ctx, &__edits, ${k}) { __v.${mm.info.ident} = __x; }`
      );
    }
    return [
      "/// The whole value, read through the view: placeholders are read on demand (targets",
      "/// with identity, as `parse` gives them).",
      `pub fn materialize(&self) -> yr::Result<${name}> {`,
      "    self.fresh()?;",
      ...(ident
        ? [
            `    let __id = self.ctx.begin_ident(self.loc.region, self.loc.start, ${strLit(name)}, ${idParts});`
          ]
        : []),
      `    let __res = (|| -> yr::Result<${name}> {`,
      "        let __edits = self.state.borrow().edits.clone();",
      `        let mut __v: ${name} = self.state.borrow().value.clone();`,
      ...indent(fills, 2),
      "        Ok(__v)",
      "    })();",
      ...(ident
        ? [`    self.ctx.end_ident(self.loc.region, self.loc.start, ${strLit(name)}, ${idParts});`]
        : []),
      ...(ident
        ? ["    let mut __v = __res?;", "    __v.__id = __id;", "    Ok(__v)"]
        : ["    __res"]),
      "}"
    ];
  }

  /** Assigns `x` to a member's place in `__v`. */
  private assign(mm: Extract<RMember, { k: "field" }>, x: string): string {
    const f = mm.info;
    if (f.switches.length > 0) {
      return `if let Some(__p) = ${switchAccessMut(f)} { *__p = ${x}; }`;
    }
    if (mm.optional) return `__v.${f.ident} = Some(${x});`;
    return `__v.${f.ident} = ${x};`;
  }

  // ─── On-demand readers ───────────────────────────────────────────────────────

  /** `__get_k`: declaration `f`'s value read on demand. */
  private lazyGetter(f: IrField): string[] {
    const info = this.sm.byDecl.get(f)!;
    const ty = this.m.rustType(info.shape);
    const k = this.idx(f);
    const head = [`fn __get_${k}(&self) -> yr::Result<${ty}> {`];
    const plan = this.plan(f);
    const viaViews = plan.k === "struct" || plan.k === "structs";
    if (!this.m.lazyField(f) && !viaViews) {
      // Read by the scan: the value is in the shallow value (stream carriers, hidden fields).
      if (info.output && info.switches.length === 0 && !info.conditional && !info.optionalTop)
        return [...head, `    Ok(self.state.borrow().value.${info.ident}.clone())`, "}"];
    }
    const wrap = (e: string) => (info.shape.k === "box" ? `Box::new(${e})` : e);
    if (plan.k !== "pieces" && plan.k !== "read") this.viewFns.add(f);
    switch (plan.k) {
      case "struct":
        return [...head, `    Ok(${wrap(`self.__view_${k}()?.materialize()?`)})`, "}"];
      case "structs":
        return [
          ...head,
          `    let __vs = self.__views_${k}()?;`,
          "    let mut __out = Vec::with_capacity(__vs.len());",
          "    for (__i, __e) in __vs.iter().enumerate() {",
          "        __out.push(__e.materialize().ri(__i)?);",
          "    }",
          "    Ok(__out)",
          "}"
        ];
      case "target": {
        const nullable = plan.t.nullValue !== undefined;
        const follow = this.followCode(plan.sid, plan.t, "__t");
        return [
          ...head,
          `    match self.__tview_${k}()? {`,
          `        None => ${nullable ? "Ok(None)" : `Err(yr::view::no_span(${strLit(f.name)}))`},`,
          `        Some(__t) => Ok(${nullable ? `Some(${follow})` : follow}),`,
          "    }",
          "}"
        ];
      }
      case "targets": {
        const nullable = plan.t.nullValue !== undefined;
        const follow = this.followCode(plan.sid, plan.t, "__t");
        return [
          ...head,
          `    let __vs = self.__tviews_${k}()?;`,
          "    let mut __out = Vec::with_capacity(__vs.len());",
          "    for (__i, __e) in __vs.into_iter().enumerate() {",
          "        let __x = (|| -> yr::Result<_> { Ok(match __e {",
          `            None => ${nullable ? "None" : `return Err(yr::view::no_span(${strLit(f.name)}))`},`,
          `            Some(__t) => ${nullable ? `Some(${follow})` : follow},`,
          "        }) })().ri(__i)?;",
          "        __out.push(__x);",
          "    }",
          "    Ok(__out)",
          "}"
        ];
      }
      case "pieces":
        return this.piecesGetter(f, plan, head);
      case "read":
        return this.readGetter(f, head);
    }
  }

  /** `ctx.follow` of a target view `v` (identity, cycles), as an expression of the target's `Rc`. */
  private followCode(sid: string, t: Extract<IrType, { kind: "pointer" }>, v: string): string {
    const tsm = this.m.struct(sid);
    const stub = this.m.identStructs.has(sid)
      ? `Some((${strLit(tsm.name)}, |__i: yr::Ident| ${tsm.name} { __id: __i, ..Default::default() }))`
      : "None";
    // The same identity as the reader's: integer-like arguments are part of the type.
    const parts = tsm.params.flatMap(p => identityPart(p, `${v}.args.${p.v}`) ?? []);
    return `self.ctx.follow(${v}.loc().region, ${v}.loc().start, ${strLit(typeHash(t.target))}, &[${parts.join(", ")}], ${stub}, || ${v}.materialize())?`;
  }

  /**
   * Where a field's value starts: its inline bytes, or its `at` target (with
   * `@nullable(empty)`, `pre` returns `empty` when there is none).
   */
  private startOf(f: IrField, empty: string): { pre: string[]; start: string } {
    if (!f.placement) return { pre: [], start: "__sp.start" };
    if (!f.placement.emptyIsNull)
      return { pre: [], start: `__sp.target.ok_or_else(|| yr::view::no_span(${strLit(f.name)}))?` };
    const pre = `let __t = match __sp.target { Some(__t) => __t, None => return Ok(${empty}) };`;
    return { pre: [pre], start: "__t" };
  }

  /** `__view_k` / `__views_k`: views of an inline or `at` struct, or of an array of them. */
  private viewFn(f: IrField, sid: string, n: "one" | "many"): string[] {
    const k = this.idx(f);
    const vn = this.m.struct(sid).name;
    const scanner = new ReadGen(this.m, this.sm, { wantScan: true });
    const binds = this.localBinds(
      [...typeExprs(f.type, false), ...(f.placement ? [f.placement.offset] : [])],
      f
    );
    const expr = scanner.readType(f.type, this.env(f.name));
    const scanTy = `yr::Scan<${vn}, ${vn}__Args>`;
    const { pre, start } = this.startOf(f, "Vec::new()");
    if (n === "one")
      return [
        `fn __view_${k}(&self) -> yr::Result<${vn}View> {`,
        ...indent([
          "self.fresh()?;",
          ...this.spanOf(f),
          ...binds,
          ...this.readerAt(start),
          ...this.paramBinds(),
          `let __s: ${scanTy} = (|| -> yr::Result<${scanTy}> { Ok(${expr}) })()?;`,
          `Ok(${vn}View::open(&self.ctx, __s))`
        ]),
        "}"
      ];
    return [
      `fn __views_${k}(&self) -> yr::Result<Vec<${vn}View>> {`,
      ...indent([
        "self.fresh()?;",
        ...this.spanOf(f),
        ...pre,
        ...binds,
        ...this.readerAt(start),
        ...this.paramBinds(),
        `let __all: Vec<${scanTy}> = (|| -> yr::Result<Vec<${scanTy}>> { Ok(${expr}) })()?;`,
        `Ok(__all.into_iter().map(|__s| ${vn}View::open(&self.ctx, __s)).collect())`
      ]),
      "}"
    ];
  }

  /** `__tview_k` / `__tviews_k`: views of pointer targets (scanned where they are). */
  private targetViewFn(
    f: IrField,
    sid: string,
    t: Extract<IrType, { kind: "pointer" }>,
    n: "one" | "many"
  ): string[] {
    const k = this.idx(f);
    const vn = this.m.struct(sid).name;
    const scanner = new ReadGen(this.m, this.sm, { wantScan: true });
    const binds = this.localBinds(typeExprs(f.type, false), f);
    const scanTy = `yr::Scan<${vn}, ${vn}__Args>`;
    if (n === "one") {
      const expr = scanner.readType(t.target, this.env(f.name));
      return [
        `fn __tview_${k}(&self) -> yr::Result<Option<${vn}View>> {`,
        ...indent([
          "self.fresh()?;",
          ...this.spanOf(f),
          "let __t = match __sp.target { Some(__t) => __t, None => return Ok(None) };",
          ...binds,
          ...this.readerAt("__t"),
          ...this.paramBinds(),
          `if __t > r.end { return Err(yr::YaffleError::eof(__sp.start, format!("pointer target 0x{:x} is outside the region", __t))); }`,
          `let __s: ${scanTy} = (|| -> yr::Result<${scanTy}> { Ok(${expr}) })()?;`,
          `Ok(Some(${vn}View::open(&self.ctx, __s)))`
        ]),
        "}"
      ];
    }
    const expr = scanner.readType(f.type, this.env(f.name));
    const nullable = t.nullValue !== undefined;
    const elTy = nullable ? `Option<Rc<${scanTy}>>` : `Rc<${scanTy}>`;
    const { pre, start } = this.startOf(f, "Vec::new()");
    const conv = nullable
      ? `__o.map(|__s| ${vn}View::open(&self.ctx, Rc::try_unwrap(__s).unwrap_or_else(|__s| (*__s).clone())))`
      : `Some(${vn}View::open(&self.ctx, Rc::try_unwrap(__o).unwrap_or_else(|__s| (*__s).clone())))`;
    return [
      `fn __tviews_${k}(&self) -> yr::Result<Vec<Option<${vn}View>>> {`,
      ...indent([
        "self.fresh()?;",
        ...this.spanOf(f),
        ...pre,
        ...binds,
        ...this.readerAt(start),
        ...this.paramBinds(),
        `let __all: Vec<${elTy}> = (|| -> yr::Result<Vec<${elTy}>> { Ok(${expr}) })()?;`,
        `Ok(__all.into_iter().map(|__o| ${conv}).collect())`
      ]),
      "}"
    ];
  }

  /** A field read at its span with the generated reader code. */
  private readGetter(f: IrField, head: string[]): string[] {
    const info = this.sm.byDecl.get(f)!;
    const ty = this.m.rustType(info.shape);
    const env = this.env(f.name);
    const binds = this.localBinds(
      [
        ...typeExprs(f.type, false),
        ...(f.placement ? [f.placement.offset] : []),
        ...f.checks.map(c => c.expr),
        ...(f.from ? streamExprs(f.from.stream) : [])
      ],
      f
    );
    const { inner, layers } = effectiveLayers(this.m, f.type);
    const { pre, start } = this.startOf(f, "Default::default()");
    let read: string;
    if (f.from) {
      read = this.reads.fromRead(f, env);
    } else if (f.placement) {
      read = this.reads.readType(f.type, env);
    } else if (inner.kind === "pointer" && inner.origin && layers.length === 0) {
      // `@origin`: the raw offset, then the target counted from base + origin.
      const raw = tmp("praw");
      const bytes = primInfo(inner.storage).bytes;
      read = `{ let ${raw}: u64 = r.uint(${bytes}, ${endianCode(inner.storageEndian, "__sp_endian")})?; ${this.reads.pointer(inner, env, raw)} }`;
    } else {
      read = this.reads.readType(f.type, env);
    }
    const wrapped = info.shape.k === "box" && !f.from ? `Box::new(${read})` : read;
    const checks = this.reads.checkCode(f, "__v", "__sp.start", env);
    return [
      ...head,
      ...indent([
        "self.fresh()?;",
        ...this.spanOf(f),
        ...pre,
        ...binds,
        ...this.readerAt(start),
        ...this.paramBinds(),
        `let __v: ${ty} = (|| -> yr::Result<${ty}> { Ok(${wrapped}) })()?;`,
        ...checks,
        "Ok(__v)"
      ]),
      "}"
    ];
  }

  /**
   * A `from arr[*].field` stream: a kept region whose pieces are decoded on first access when
   * every piece's decoded size is known from its size field; else the joined pieces.
   */
  private piecesGetter(f: IrField, plan: Extract<Plan, { k: "pieces" }>, head: string[]): string[] {
    const info = this.sm.byDecl.get(f)!;
    const ty = this.m.rustType(info.shape);
    const arrK = this.idx(plan.arr);
    this.viewFns.add(plan.arr);
    // The array's element views.
    const viewsFn = `__views_${arrK}`;
    const esm = this.m.struct(plan.esid);
    const carrier = allFields(esm.ir.members).find(g => g.name === plan.carrier);
    if (!carrier) throw new BackendError(`${esm.name} has no field ${plan.carrier}`);
    const ck = new ReadGen(this.m, esm).fieldIndex.get(carrier)!;
    const ev = `${esm.name}View`;
    const target = viewStruct(this.m, f.type);
    const env = this.env(f.name);
    let read: string[];
    if (target) {
      const tvn = this.m.struct(target).name;
      const scanner = new ReadGen(this.m, this.sm, { wantScan: true });
      const expr = scanner.readType(f.type, { ...env, rv: "__sr" });
      read = [
        `let __s: yr::Scan<${tvn}, ${tvn}__Args> = { let mut __sr_v = r.sub_space(&__space); let __sr = &mut __sr_v; (|| -> yr::Result<yr::Scan<${tvn}, ${tvn}__Args>> { Ok(${expr}) })()? };`,
        `let __v: ${ty} = ${info.shape.k === "box" ? "Box::new(" : ""}${tvn}View::open(&self.ctx, __s).materialize()?${info.shape.k === "box" ? ")" : ""};`
      ];
    } else {
      const expr = this.reads.readType(f.type, { ...env, rv: "__sr" });
      read = [
        `let __v: ${ty} = { let mut __sr_v = r.sub_space(&__space); let __sr = &mut __sr_v; (|| -> yr::Result<${ty}> { Ok(${expr}) })()? };`
      ];
    }
    const binds = this.localBinds(typeExprs(f.type, false), f);
    const checks = this.reads.checkCode(f, "__v", "__sp.start", env);
    return [
      ...head,
      ...indent([
        "self.fresh()?;",
        ...this.spanOf(f),
        `let __els: Rc<Vec<${ev}>> = Rc::new(self.${viewsFn}().rf(${strLit(plan.arr.name)}, __sp.start)?);`,
        "let mut __sizes: Option<Vec<usize>> = Some(Vec::with_capacity(__els.len()));",
        "for __e in __els.iter() {",
        `    match (__e.__piece_len_${ck}()?, __sizes.as_mut()) { (Some(__n), Some(__s)) => __s.push(__n), _ => { __sizes = None; break; } }`,
        "}",
        "let __e2 = __els.clone();",
        `let __piece: Rc<dyn Fn(usize) -> yr::Result<Vec<u8>>> = Rc::new(move |__k: usize| __e2[__k].__get_${ck}().rf(${strLit(plan.carrier)}, __e2[__k].loc().start).ri(__k).rf(${strLit(plan.arr.name)}, 0));`,
        `let __space = self.ctx.stream((__sp.region, __sp.start, yr::view::tag(${strLit(`${this.sm.ir.id}.${f.name}`)})), __sizes, __piece, || { let mut __all = Vec::new(); for (__k, __e) in __els.iter().enumerate() { __all.extend(__e.__get_${ck}().rf(${strLit(plan.carrier)}, __e.loc().start).ri(__k).rf(${strLit(plan.arr.name)}, 0)?); } Ok(__all) })?;`,
        ...binds,
        ...this.readerAt("__sp.start"),
        ...this.paramBinds(),
        ...read,
        ...checks,
        "Ok(__v)"
      ]),
      "}"
    ];
  }

  /**
   * `__piece_len_k` of a stream carrier: the decoded size of its piece, known without decoding
   * (the innermost `@size`, or the count of `u8 data[n]`), or `None`.
   */
  private pieceLen(f: IrField): string[] {
    const k = this.idx(f);
    const { inner, layers } = effectiveLayers(this.m, f.type);
    let size: IrExpr | undefined;
    if (inner.kind === "bytes") {
      if (inner.length.kind === "count") size = inner.length.expr;
      else if (inner.length.kind === "rest" && layers[0]?.kind === "size") size = layers[0].size;
    }
    if (!size)
      return [`fn __piece_len_${k}(&self) -> yr::Result<Option<usize>> {`, "    Ok(None)", "}"];
    const env = this.env(f.name);
    let code: string;
    try {
      code = this.reads.lengthOf(size, env);
    } catch {
      return [`fn __piece_len_${k}(&self) -> yr::Result<Option<usize>> {`, "    Ok(None)", "}"];
    }
    return [
      `fn __piece_len_${k}(&self) -> yr::Result<Option<usize>> {`,
      ...indent([
        "self.fresh()?;",
        ...this.spanOf(f),
        ...this.localBinds([size], f),
        ...this.readerAt("__sp.start"),
        ...this.paramBinds(),
        `Ok(Some((|| -> yr::Result<usize> { Ok(${code}) })()?))`
      ]),
      "}"
    ];
  }

  // ─── Public accessors ────────────────────────────────────────────────────────

  private memberType(mm: Extract<RMember, { k: "field" }>): string {
    const t = this.m.rustType(mm.info.shape);
    return mm.optional ? `Option<${t}>` : t;
  }

  private getter(mm: Extract<RMember, { k: "field" }>): string[] {
    const f = mm.info;
    const rt = this.memberType(mm);
    const head = [`/// \`${f.name}\`.`, `pub fn ${f.ident}(&self) -> yr::Result<${rt}> {`];
    const decls = this.declsOf(f).filter(d => this.m.lazyField(d));
    const edit = this.editable(mm)
      ? [
          `    if let Some(__x) = yr::view::edit_of::<${this.m.rustType(f.shape)}>(&self.ctx, &self.state.borrow().edits, ${this.idx(f.ir!)}) { return Ok(__x); }`
        ]
      : [];
    if (decls.length === 0)
      return [
        ...head,
        "    self.fresh()?;",
        ...edit,
        `    Ok(self.state.borrow().value.${f.ident}.clone())`,
        "}"
      ];
    for (const d of decls) this.getters.add(d);
    const tries = decls.map(
      d =>
        `if let Some(__s) = self.state.borrow().spans[${this.idx(d)}] { let __x = self.__get_${this.idx(d)}().rf(${strLit(d.name)}, __s.start)?; return Ok(${mm.optional ? "Some(__x)" : "__x"}); }`
    );
    return [
      ...head,
      "    self.fresh()?;",
      ...edit,
      ...indent(tries),
      mm.optional ? "    Ok(None)" : `    Err(yr::view::no_span(${strLit(f.name)}))`,
      "}"
    ];
  }

  private viewGetter(mm: Extract<RMember, { k: "field" }>): string[] {
    const f = mm.info;
    const decl = f.ir;
    if (!decl || decl.from || mm.optional) return [];
    const plan = this.plan(decl);
    const k = this.idx(decl);
    const base = f.ident.replace(/^r#/, "");
    if (plan.k === "struct" || plan.k === "structs" || plan.k === "target" || plan.k === "targets")
      this.viewFns.add(decl);
    switch (plan.k) {
      case "struct": {
        const vn = this.m.struct(plan.sid).name;
        return [
          `/// A view of \`${f.name}\`.`,
          `pub fn ${base}_view(&self) -> yr::Result<${vn}View> {`,
          `    self.__view_${k}().rf(${strLit(f.name)}, self.loc.start)`,
          "}"
        ];
      }
      case "structs": {
        const vn = this.m.struct(plan.sid).name;
        return [
          `/// Views of the elements of \`${f.name}\`.`,
          `pub fn ${base}_views(&self) -> yr::Result<Vec<${vn}View>> {`,
          `    self.__views_${k}().rf(${strLit(f.name)}, self.loc.start)`,
          "}"
        ];
      }
      case "target": {
        const vn = this.m.struct(plan.sid).name;
        const nullable = plan.t.nullValue !== undefined;
        return [
          `/// A view of the target of \`${f.name}\`.`,
          `pub fn ${base}_view(&self) -> yr::Result<${nullable ? `Option<${vn}View>` : `${vn}View`}> {`,
          `    let __v = self.__tview_${k}().rf(${strLit(f.name)}, self.loc.start)?;`,
          nullable ? "    Ok(__v)" : `    __v.ok_or_else(|| yr::view::no_span(${strLit(f.name)}))`,
          "}"
        ];
      }
      case "targets": {
        const vn = this.m.struct(plan.sid).name;
        const nullable = plan.t.nullValue !== undefined;
        return [
          `/// Views of the targets of \`${f.name}\`.`,
          `pub fn ${base}_views(&self) -> yr::Result<Vec<${nullable ? `Option<${vn}View>` : `${vn}View`}>> {`,
          `    let __v = self.__tviews_${k}().rf(${strLit(f.name)}, self.loc.start)?;`,
          nullable
            ? "    Ok(__v)"
            : `    __v.into_iter().map(|__o| __o.ok_or_else(|| yr::view::no_span(${strLit(f.name)}))).collect()`,
          "}"
        ];
      }
      default:
        return [];
    }
  }

  /**
   * `replace_<field>` ("append" strategy) for `at` fields and owned pointers: the new target is
   * appended to the document, and the struct's own bytes (pointer, offset and size fields) are
   * re-encoded in place with every target at its (old or new) position.
   */
  private replacer(mm: Extract<RMember, { k: "field" }>): string[] {
    const f = mm.info;
    const decl = f.ir;
    const direct = new Set(this.sm.ir.members.filter((x): x is IrField => x.kind === "field"));
    if (!decl || mm.optional || !direct.has(decl)) return [];
    const placeables = replaceable(this.m, this.sm);
    if (!placeables || !placeables.includes(decl)) return [];
    const inner = effectiveLayers(this.m, decl.type).inner;
    const isPtr = !decl.placement && inner.kind === "pointer";
    if (isPtr && inner.kind === "pointer" && inner.ownership !== "owned") return [];
    const emptyNull =
      (inner.kind === "pointer" && inner.emptyIsNull === true) ||
      decl.placement?.emptyIsNull === true;
    const targetType = decl.placement
      ? decl.type
      : inner.kind === "pointer"
        ? inner.target
        : undefined;
    if (!targetType || this.m.hasUnread(targetType) || hasVia(this.m, targetType)) return [];
    // Formulas may only depend on other targets through offsetof.
    const others = new Set(placeables.filter(p => p !== decl).map(p => p.name));
    for (const g of allFields(this.sm.ir.members)) {
      if (!g.derive || g.input === "required") continue;
      for (const n of valueRefs(g.derive)) if (others.has(n)) return [];
    }
    const wg = new WriteGen(this.m, this.sm);
    const nullable =
      isPtr && inner.kind === "pointer" && inner.nullValue !== undefined && !inner.emptyIsNull;
    const endian = endianVar(this.sm);
    let content: { aligns: string[]; code: string[] };
    let itemAlign: string | undefined;
    try {
      content = wg.targetContent(targetType, isPtr ? "(**__t)" : `v.${f.ident}`, endian, f.name);
      // The struct's own layout item for the field aligns it first (it may read fields).
      itemAlign = wg.ownLayoutAlign(decl.name, endian);
    } catch {
      return [];
    }
    const constraint = decl.placement?.constraint
      ? `Some((${decl.placement.constraint.modulus}u64, ${decl.placement.constraint.remainder}u64))`
      : "None";
    const appendBlock = [
      `let __al: Vec<yr::Align> = vec![${[...(itemAlign ? [itemAlign] : []), ...content.aligns].join(", ")}];`,
      "let __content = yr::view::encode_at(0, |w| -> yr::Result<()> {",
      ...indent([...wg.slotDecls(), ...content.code, "Ok(())"]),
      "})?;",
      `self.ctx.append(__base, &__al, ${constraint}, &__content)?`
    ];
    // `@nullable(empty)`: an empty value has no target (offset 0).
    const emptyCheck = emptyNull
      ? isPtr
        ? `(**__t).is_empty()`
        : `v.${f.ident}.is_empty()`
      : "false";
    const newPos = isPtr
      ? nullable
        ? [
            `let __new: Option<usize> = match &v.${f.ident} { None => None, Some(__t) => Some({`,
            ...indent(appendBlock, 1),
            "}) };"
          ]
        : [
            `let __new: Option<usize> = { let __t = &v.${f.ident}; if ${emptyCheck} { None } else { Some({`,
            ...indent(appendBlock, 1),
            "}) } };"
          ]
      : [
          `let __new: Option<usize> = if ${emptyCheck} { None } else { Some({`,
          ...indent(appendBlock, 1),
          "}) };"
        ];
    const presets: string[] = [];
    for (const g of placeables) {
      if (g === decl)
        presets.push("if let Some(__p) = __new { __pre.push((__p - __base) as u64); }");
      else {
        const kg = this.idx(g);
        presets.push(
          `if let Some(__t) = __st.spans[${kg}].and_then(|__s| __s.target) { __pre.push((__t - __base) as u64); }`
        );
      }
    }
    const baseExpr = this.sm.ir.base ? "self.loc.start" : "self.loc.base";
    return [
      `/// Replaces \`${f.name}\`'s target: the new target is appended to the document and this struct's`,
      '/// own bytes (offsets, sizes) are patched in place ("append" strategy).',
      `pub fn replace_${f.ident.replace(/^r#/, "")}(&self, value: ${this.m.rustType(f.shape)}) -> yr::Result<()> {`,
      ...indent([
        "self.fresh()?;",
        "if self.loc.region != 0 { return Err(yr::view::not_in_doc(" + strLit(f.name) + ")); }",
        "let mut __nv = self.state.borrow().value.clone();",
        `__nv.${f.ident} = value;`,
        "let v = &__nv;",
        ...this.paramBinds(),
        `let __base = ${baseExpr};`,
        ...newPos,
        "let __st = self.state.borrow();",
        "let mut __pre: Vec<u64> = Vec::new();",
        ...presets,
        "let (__start, __end) = (self.loc.start, __st.end_pos);",
        "drop(__st);",
        `let __bytes = yr::view::encode_inline(__start - self.loc.base, __pre, |w| ${this.name}::write_body(w, v${this.paramList()}))?;`,
        "yr::view::patch_inline(&self.ctx, __start, __end, &__bytes)?;",
        "self.refresh()"
      ]),
      "}"
    ];
  }

  /**
   * Whether a field can be patched in place: read by the scan (no placeholders), an input, in the
   * document, and nothing derived reads its value (derived values would go stale).
   */
  private patchable(decl: IrField): boolean {
    if (this.m.lazyField(decl) || decl.input !== "required" || decl.virtual) return false;
    if (decl.placement || decl.from) return false;
    for (const g of allFields(this.sm.ir.members)) {
      if (!g.derive || g.input === "required") continue;
      if (valueRefs(g.derive).has(decl.name)) return false;
    }
    // Layout items that read it: the targets may move, so `commit_with` lays them out again.
    if (this.layoutRefs().has(decl.name)) return false;
    return !this.m.contentRead(this.sm.ir.id, decl.name);
  }

  /**
   * `set_<field>`: patched in place when the new value has the same encoded size and nothing
   * derived depends on it; otherwise a structural edit that `commit_with` writes.
   */
  /** A field `set_` can edit: a direct, required or optional input of the output. */
  private editable(mm: Extract<RMember, { k: "field" }>): boolean {
    const decl = mm.info.ir;
    if (!decl || mm.optional || decl.input === "absent" || decl.virtual || !mm.info.output)
      return false;
    return this.sm.ir.members.includes(decl);
  }

  private setter(mm: Extract<RMember, { k: "field" }>): string[] {
    const f = mm.info;
    const decl = f.ir;
    if (!decl || !this.editable(mm)) return [];
    const k = this.idx(decl);
    const ty = this.m.rustType(f.shape);
    let inPlace: string[] = [];
    if (this.patchable(decl)) {
      const wg = new WriteGen(this.m, this.sm);
      const endian = endianVar(this.sm);
      try {
        const code = wg.fieldCode(decl, endian);
        inPlace = [
          `let __span = self.state.borrow().spans[${k}];`,
          "if let Some(__sp) = __span.filter(|__s| __s.region == 0) {",
          ...indent([
            "let mut __nv = self.state.borrow().value.clone();",
            `__nv.${f.ident} = value.clone();`,
            "let v = &__nv;",
            ...this.paramBinds(),
            "let __bytes = yr::view::encode_at(__sp.start - __sp.base, |w| -> yr::Result<()> {",
            ...indent([...wg.slotDecls(), ...code, "Ok(())"]),
            `}).rf(${strLit(f.name)}, __sp.start)?;`,
            "if __bytes.len() == __sp.end - __sp.start {",
            `    self.state.borrow_mut().edits.remove(&${k});`,
            "    self.ctx.patch(__sp.start, &__bytes)?;",
            "    return self.refresh();",
            "}"
          ]),
          "}"
        ];
      } catch {
        inPlace = [];
      }
    }
    return [
      `/// Sets \`${f.name}\`: in place when the encoding keeps its size, else a structural edit`,
      "/// (written by `commit_with`).",
      `pub fn set_${f.ident.replace(/^r#/, "")}(&self, value: ${ty}) -> yr::Result<()> {`,
      ...indent([
        "self.fresh()?;",
        ...inPlace,
        `self.state.borrow_mut().edits.insert(${k}, Rc::new(value));`,
        "self.ctx.mark_structural();",
        "Ok(())"
      ]),
      "}"
    ];
  }
}

/** Expressions of a stream (slice bounds). */
function streamExprs(st: NonNullable<IrField["from"]>["stream"], out: IrExpr[] = []): IrExpr[] {
  if (st.kind === "slice") {
    out.push(st.start);
    if (st.end) out.push(st.end);
    streamExprs(st.stream, out);
  } else if (st.kind === "field") {
    out.push({ kind: "field", name: st.field, type: { kind: "bytes" } });
  } else {
    out.push({
      kind: "field",
      name: st.array,
      type: { kind: "array", element: { kind: "bytes" } }
    });
  }
  return out;
}

/**
 * `Option<&mut T>` access to a switch field of `__v`: the outermost switch's accessor reaches
 * fields of nested switches too.
 */
function switchAccessMut(f: FieldInfo): string {
  const sw: SwitchModel = f.switches[0]!;
  const top = sw.optional ? `__v.${sw.ident}.as_mut()` : `Some(&mut __v.${sw.ident})`;
  return `${top}.and_then(|__s| __s.${f.acc}_mut())`;
}

/**
 * The fields whose targets `replace_` can replace with the "append" strategy, or undefined:
 * every placeable or `@ref` target must be a direct field (so a re-encoding of the struct's own
 * bytes can be given the targets' positions in order), in declaration order.
 */
function replaceable(m: Model, sm: StructModel): IrField[] | undefined {
  const direct = sm.ir.members.filter((x): x is IrField => x.kind === "field");
  const placeables = direct.filter(
    f => f.placement !== undefined || effectiveLayers(m, f.type).inner.kind === "pointer"
  );
  for (const f of allFields(sm.ir.members)) {
    if (f.from) return undefined;
    if (placeables.includes(f)) continue;
    if (f.placement || m.hasUnread(f.type)) return undefined;
  }
  return placeables;
}

/** Field names a formula refers to outside `offsetof(…)`. */
function valueRefs(e: IrExpr): Set<string> {
  const out = new Set<string>();
  walkExpr(e, x => {
    if (x.kind === "field") out.add(x.name);
    if (x.kind === "call" && x.callee.kind === "builtin" && x.callee.name === "offsetof")
      return false;
  });
  return out;
}

/** `view` / `view_with` / `view_source` for a root. */
export function genRootView(m: Model, root: IrRoot): string[] {
  const sm = m.struct(root.struct);
  const pname = m.paramsNames.get(root.struct)!;
  const name = sm.name;
  const scanner = new ReadGen(m, sm, { wantScan: true });
  const env = { rv: "r", endian: endianVar(sm), indices: [], field: "$self" };
  const expr = scanner.readType(rootType(sm), env);
  const bind = paramBinds(sm);
  if (sm.hasCache) bind.push("let mut __cache = yr::ViaCache::new();");
  return [
    `impl ${name} {`,
    "    /// A lazy view of bytes.",
    `    pub fn view(bytes: Vec<u8>) -> yr::Result<${name}View> {`,
    `        Self::view_with(bytes, &yr::ParseOptions::default(), &${pname}::default())`,
    "    }",
    `    pub fn view_with(bytes: Vec<u8>, opts: &yr::ParseOptions, params: &${pname}) -> yr::Result<${name}View> {`,
    "        Self::view_in(yr::ViewRoot::from_bytes(bytes, opts.strict), params)",
    "    }",
    "    /// A lazy view of a random-access source (a file): bytes are read in blocks on demand.",
    `    pub fn view_source(src: Box<dyn yr::Source>, opts: &yr::ParseOptions, params: &${pname}) -> yr::Result<${name}View> {`,
    "        Self::view_in(yr::ViewRoot::from_source(src, opts.strict), params)",
    "    }",
    "    /// The root view in a view root.",
    `    pub fn view_in(ctx: yr::ViewCtx, params: &${pname}) -> yr::Result<${name}View> {`,
    "        let __s = {",
    "            let __g = ctx.space(0)?;",
    "            let mut __rd = yr::Reader::over(__g.src(), 0, &ctx.shared, ctx.strict);",
    "            let r = &mut __rd;",
    ...indent(bind, 3),
    `            (|| -> yr::Result<yr::Scan<${name}, ${name}__Args>> { Ok(${expr}) })()?`,
    "        };",
    `        Ok(${name}View::open(&ctx, __s))`,
    "    }",
    "}",
    `impl ${name}View {`,
    "    /// The root parameters the view was opened with.",
    `    pub fn params(&self) -> ${pname} {`,
    `        ${pname} { ${sm.params.map(p => `${paramField(p)}: self.args.${p.v}.clone()`).join(", ")} }`,
    "    }",
    "    /// Applies every edit and returns the new bytes; the view then reads them (other handles",
    "    /// are stale after a structural commit). Same-size patches are already in place; structural",
    "    /// edits re-serialize the value read through the view (codec output and unchanged bytes are",
    "    /// kept): `Splice` shifts what follows each size change, `Append` keeps every target that",
    "    /// still fits where it was and moves the others to the end, `Error` rejects size changes.",
    "    pub fn commit_with(&self, grow: yr::Grow) -> yr::Result<Vec<u8>> {",
    "        if !self.ctx.is_structural() {",
    "            return self.ctx.bytes();",
    "        }",
    "        let params = self.params();",
    "        let old = self.ctx.bytes()?;",
    "        let new = match grow {",
    "            yr::Grow::Splice => self.materialize()?.serialize_with(&params)?,",
    "            yr::Grow::Append | yr::Grow::Error => {",
    "                // Where every target is: the document's own values, re-serialized.",
    "                let orig = self.ctx.without_edits(|| self.materialize())?;",
    "                let (same, places) = orig.serialize_layout(&params, None, true)?;",
    "                let edited = self.materialize()?;",
    "                if same != old {",
    "                    // Not a byte-exact rebuild: positions can't be kept.",
    "                    if grow == yr::Grow::Error { return Err(yr::YaffleError::input(\"the document doesn't rebuild byte for byte: size changes can't be checked\")); }",
    "                    edited.serialize_with(&params)?",
    "                } else {",
    "                    let sticky = places.iter().map(|(k, p, s)| (k.clone(), (*p, *s))).collect();",
    "                    let (out, now) = edited.serialize_layout(&params, Some(sticky), grow == yr::Grow::Error)?;",
    "                    if grow == yr::Grow::Error && (out.len() != old.len() || now != places) {",
    '                        return Err(yr::YaffleError::input("an edit changes a size (commit with Grow::Append or Grow::Splice)"));',
    "                    }",
    "                    out",
    "                }",
    "            }",
    "        };",
    "        self.ctx.record_commit(&old, &new);",
    "        self.ctx.rebind(new.clone());",
    "        self.state.borrow_mut().edits.clear();",
    "        self.refresh()?;",
    "        Ok(new)",
    "    }",
    "}"
  ];
}
