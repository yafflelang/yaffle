/**
 * Program assembly: instantiates structs reachable from the export roots, runs the requirements
 * analysis for bound values (`$version`), lexically nested field references and `$index` over
 * every path, assigns implicit parameters, fills implicit arguments at every use site, and
 * computes the `async` / `usesEndian` flags.
 */
import { BOUND_PREFIX, OUTER_PREFIX, type UseSite } from "./ctx.ts";
import { isPlaceholder, type Elaborator } from "./elaborate.ts";
import type { Fix } from "./diagnostics.ts";
import type {
  IrConst,
  IrEnum,
  IrExpr,
  IrExtern,
  IrField,
  IrLayer,
  IrMember,
  IrParam,
  IrProgram,
  IrRoot,
  IrStruct,
  IrType,
  IrValueType
} from "../ir/index.ts";
import { IR_VERSION } from "../ir/index.ts";
import { visitExpr, visitMembers, visitStruct } from "../ir/walk.ts";
import type { StructResult } from "./model.ts";
import type { SourceFile, Span } from "./source.ts";
import type { FieldSym, ModuleInfo, ParamSym, StructSym } from "./symbols.ts";
import { PRIMS, coreType, displayValueType } from "./types.ts";

/** Why an instance needs a value: a read in its own body, or a use of an instance that needs it. */
type Witness =
  | { kind: "read"; file: SourceFile; span: Span }
  | { kind: "use"; use: UseSite; target: StructResult };

interface BoundNeed {
  name: string;
  type: IrValueType;
  witness: Witness;
}

interface OuterNeed {
  key: string;
  owner: StructSym;
  member: string;
  memberKind: "field" | "param";
  sym: FieldSym | ParamSym;
  type: IrValueType;
  witness: Witness;
}

interface InstanceInfo {
  result: StructResult;
  bound: Map<string, BoundNeed>;
  outer: Map<string, OuterNeed>;
  index?: Witness;
  /** Final implicit parameter names. */
  boundNames: Map<string, string>;
  outerNames: Map<string, string>;
  /** Uses of this instance from other instances. */
  callers: { from: InstanceInfo; use: UseSite }[];
}

interface OuterError {
  use: UseSite;
  need: OuterNeed;
  from: InstanceInfo;
}

export function assembleProgram(el: Elaborator, modules: ModuleInfo[]): IrProgram {
  const roots = exportRoots(el, modules);
  const a = new Assembly(el, roots);
  a.collectDirectNeeds();
  const outerErrors = a.propagateNeeds();
  a.reportNeeds(outerErrors);
  a.reportShadowing();
  reportBoundTypeConflicts(el);
  a.assignImplicitParams();
  a.fillImplicitArgs();
  a.renameProvisionalParams();
  checkRecursion(el, a.order, a.infos);
  for (const info of a.order) markStreamPieces(info.result.ir, a.infos);
  computeFlags(el, a.order);
  return programOf(el, modules, roots, a.order);
}

/** Non-generic exported structs, plus the extra roots tools ask for. */
function exportRoots(el: Elaborator, modules: ModuleInfo[]): StructSym[] {
  const extra = el.options.extraRoots ?? [];
  const roots: StructSym[] = [];
  for (const m of modules)
    for (const d of m.decls.values())
      if (
        d.kind === "struct" &&
        !d.typeParams.length &&
        (d.exported || extra.some(e => e.name === d.name && e.path === m.path))
      )
        roots.push(d);
  return roots;
}

class Assembly {
  readonly infos = new Map<string, InstanceInfo>();
  /** Instances in discovery order (breadth first from the roots). */
  readonly order: InstanceInfo[] = [];
  private readonly el: Elaborator;
  private readonly roots: StructSym[];

  constructor(el: Elaborator, roots: StructSym[]) {
    this.el = el;
    this.roots = roots;
    const work: StructResult[] = [];
    const ensure = (r: StructResult): InstanceInfo => {
      let info = this.infos.get(r.key);
      if (!info) {
        info = {
          result: r,
          bound: new Map(),
          outer: new Map(),
          boundNames: new Map(),
          outerNames: new Map(),
          callers: []
        };
        this.infos.set(r.key, info);
        this.order.push(info);
        work.push(r);
      }
      return info;
    };
    for (const r of roots) ensure(el.structResult(r));
    while (work.length) {
      const r = work.shift()!;
      const info = this.infos.get(r.key)!;
      for (const u of r.out.uses) {
        if (isOpenGenericUse(u)) continue;
        const target = ensure(el.instanceResult(u.target, u.typeArgs));
        target.callers.push({ from: info, use: u });
      }
    }
  }

  /** The instance a use refers to (undefined for uses inside unchecked generic bodies). */
  private targetOf(u: UseSite): InstanceInfo | undefined {
    if (isOpenGenericUse(u)) return undefined;
    return this.infos.get(this.el.instanceId(u.target, u.typeArgs));
  }

  /** What each instance reads itself: `$names`, enclosing structs' fields, `$index`. */
  collectDirectNeeds(): void {
    for (const info of this.order) {
      const out = info.result.out;
      for (const b of out.boundReads) {
        if (!info.bound.has(b.name))
          info.bound.set(b.name, {
            name: b.name,
            type: b.expr.type,
            witness: { kind: "read", file: b.file, span: b.span }
          });
      }
      for (const o of out.outerReads) {
        const key = `${this.el.idOf(o.owner)}.${o.member}`;
        if (!info.outer.has(key)) {
          info.outer.set(key, {
            key,
            owner: o.owner,
            member: o.member,
            memberKind: o.memberKind,
            sym: o.sym,
            type: o.expr.type,
            witness: { kind: "read", file: o.file, span: o.span }
          });
        }
      }
      const index = out.indexReads[0];
      if (index) info.index = { kind: "read", file: index.file, span: index.span };
    }
  }

  /** Propagates needs from used instances to their users, to a fixpoint. */
  propagateNeeds(): Map<string, OuterError> {
    const { el } = this;
    const outerErrors = new Map<string, OuterError>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const info of this.order) {
        for (const u of info.result.out.uses) {
          const target = this.targetOf(u);
          if (!target) continue;
          const needs: [string, IrValueType][] = [...target.bound.values()].map(b => [
            b.name,
            b.type
          ]);
          // declared `$` parameters the use leaves out are filled from the user's bindings
          for (const h of u.explicitHoles) {
            const p = u.target.params[h - 1];
            if (p && p.bound)
              needs.push([p.name, p.valueType ?? el.paramValueType(el.ctxForOwner(p.owner), p)]);
          }
          for (const [name, type] of needs) {
            if (u.localBound.has(name) || info.bound.has(name)) continue;
            info.bound.set(name, {
              name,
              type,
              witness: { kind: "use", use: u, target: target.result }
            });
            changed = true;
          }
          const sym = info.result.sym;
          for (const need of target.outer.values()) {
            const errorKey = `${u.file.path}:${u.span.start}:${need.key}`;
            if (sym === need.owner) {
              // available if the field is declared before the use
              if (need.memberKind === "field" && (need.sym as FieldSym).order >= u.position)
                outerErrors.set(errorKey, { use: u, need, from: info });
            } else if (!isNestedIn(sym, need.owner)) {
              outerErrors.set(errorKey, { use: u, need, from: info });
            } else if (!info.outer.has(need.key)) {
              info.outer.set(need.key, {
                ...need,
                witness: { kind: "use", use: u, target: target.result }
              });
              changed = true;
            }
          }
          if (target.index && !u.insideArray && !info.index) {
            info.index = { kind: "use", use: u, target: target.result };
            changed = true;
          }
        }
      }
    }
    return outerErrors;
  }

  /** Missing bindings on root paths, `$index` outside arrays, unavailable outer fields. */
  reportNeeds(outerErrors: Map<string, OuterError>): void {
    const { el } = this;
    const reportedReads = new Set<string>();
    for (const r of this.roots) {
      const info = this.infos.get(el.instanceId(r, []))!;
      const start = {
        file: r.module.file,
        span: r.nameSpan,
        message: `the path starts at export ${r.name}`
      };
      for (const need of info.bound.values()) {
        const { path, read } = this.tracePath(info, w => w.bound.get(need.name)?.witness);
        reportedReads.add(`${read.file.path}:${read.span.start}`);
        el.diags.report(
          read.file,
          read.span,
          "missing-binding",
          `$${need.name} is read here, but nothing binds it on the path ${path}. Bind it with a field \`${displayValueType(need.type)} $${need.name}\` before the use, or declare it as a parameter of ${r.name}.`,
          { related: [start], fixes: [rootParamFix(r, need.name, need.type, el)] }
        );
      }
      if (info.index) {
        const { path, read } = this.tracePath(info, w => w.index);
        el.diags.report(
          read.file,
          read.span,
          "index-unavailable",
          `$index is read here, but the path ${path} isn't inside an array.`,
          { related: [start] }
        );
      }
    }
    // values nothing binds anywhere, read in structs no root reaches
    for (const r of el.model.structs.values()) {
      for (const b of r.out.boundReads) {
        if (
          el.model.bindingSites.has(b.name) ||
          reportedReads.has(`${b.file.path}:${b.span.start}`)
        )
          continue;
        el.diags.report(
          b.file,
          b.span,
          "missing-binding",
          `Nothing binds $${b.name}. Bind it with a field \`u32 $${b.name}\` in an enclosing struct, or declare a parameter \`struct S(u32 $${b.name})\`.`
        );
      }
    }
    for (const { use, need, from } of outerErrors.values()) {
      const fs = need.sym;
      el.diags.report(
        use.file,
        use.span,
        "outer-unavailable",
        from.result.sym === need.owner
          ? `'${use.target.name}' reads '${need.member}' of ${need.owner.name}, which is declared after this use.`
          : `'${use.target.name}' reads '${need.member}' of the enclosing struct ${need.owner.name}, so it can only be used inside ${need.owner.name}.`,
        {
          related: [
            {
              file: fs.module.file,
              span: fs.nameSpan,
              message: `'${need.member}' is declared here`
            }
          ]
        }
      );
    }
  }

  /** Follows witnesses from `info` to the read, building `Root → field (Type) → …`. */
  private tracePath(
    info: InstanceInfo,
    next: (i: InstanceInfo) => Witness | undefined
  ): { path: string; read: { file: SourceFile; span: Span } } {
    const parts = [info.result.sym.name];
    let cur: InstanceInfo | undefined = info;
    const seen = new Set<InstanceInfo>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const w = next(cur);
      if (!w) break;
      if (w.kind === "read")
        return { path: parts.join(" → "), read: { file: w.file, span: w.span } };
      parts.push(`${w.use.fieldName || "?"} (${w.target.sym.name})`);
      cur = this.infos.get(w.target.key);
    }
    return {
      path: parts.join(" → "),
      read: { file: info.result.sym.module.file, span: info.result.sym.nameSpan }
    };
  }

  /** A `$name` field that hides a binding reaching its struct from a caller. */
  reportShadowing(): void {
    for (const info of this.order) {
      for (const f of info.result.sym.fields) {
        if (!f.bound || !f.name) continue;
        for (const c of info.callers) {
          const caller = c.from;
          if (!c.use.localBound.has(f.name) && !caller.bound.has(f.name)) continue;
          const src = c.use.localBound.get(f.name);
          const via = src
            ? ` (${src.kind === "field" ? "field" : "parameter"} ${src.kind === "field" || src.kind === "param" ? src.name : ""})`
            : "";
          this.el.diags.report(
            f.module.file,
            f.nameSpan,
            "bound-shadowing",
            `$${f.name} shadows the binding from ${caller.result.sym.name}${via}; the nearest binding wins.`
          );
          break;
        }
      }
    }
  }

  /** Implicit `bound` parameters sorted by name, then `outer` ones sorted by key (IR.md §1). */
  assignImplicitParams(): void {
    const { el } = this;
    for (const info of this.order) {
      const ir = info.result.ir;
      const taken = new Set(ir.params.map(p => p.name));
      const implicit: IrParam[] = [];
      const declaredBound = new Set(info.result.sym.params.filter(p => p.bound).map(p => p.name));
      for (const name of [...info.bound.keys()].sort()) {
        if (declaredBound.has(name)) continue;
        const need = info.bound.get(name)!;
        let pname = name;
        while (taken.has(pname)) pname = `${pname}_bound`;
        taken.add(pname);
        info.boundNames.set(name, pname);
        implicit.push({
          name: pname,
          type: el.boundType(name) ?? need.type,
          origin: "bound",
          boundName: name
        });
      }
      for (const key of [...info.outer.keys()].sort()) {
        const need = info.outer.get(key)!;
        let pname = need.member;
        while (taken.has(pname)) pname = `${pname}_outer`;
        taken.add(pname);
        info.outerNames.set(key, pname);
        implicit.push({ name: pname, type: need.type, origin: "outer" });
      }
      // keep only the declared params (a re-assembly must not duplicate implicit ones)
      ir.params = [
        ...ir.params.filter(
          p =>
            p.origin === "endian" ||
            p.origin === "explicit" ||
            (p.origin === "bound" && declaredBound.has(p.boundName ?? p.name))
        ),
        ...implicit
      ];
      el.model.needs.set(
        info.result.sym,
        [...info.bound.values()]
          .filter(b => !declaredBound.has(b.name))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          .map(b => ({
            name: b.name,
            type: el.boundType(b.name) ?? b.type,
            via:
              b.witness.kind === "read"
                ? "read here"
                : `via ${b.witness.use.fieldName || b.witness.target.sym.name} (${b.witness.target.sym.name})`
          }))
      );
    }
  }

  /** Appends implicit arguments at every use, and fills omitted declared `$` arguments. */
  fillImplicitArgs(): void {
    const { el } = this;
    for (const info of this.order) {
      const sym = info.result.sym;
      for (const u of info.result.out.uses) {
        const target = this.targetOf(u);
        if (!target) continue;
        const pass = (name: string, type: IrValueType): IrExpr => {
          const local = u.localBound.get(name);
          if (local) return local;
          const pname =
            info.boundNames.get(name) ??
            (sym.params.some(p => p.bound && p.name === name) ? name : undefined);
          return { kind: "param", name: pname ?? name, type };
        };
        const args = u.type.args.slice(0, 1 + u.target.params.length);
        for (let i = 1; i < args.length; i++) {
          if (isPlaceholder(args[i]!)) {
            const p = u.target.params[i - 1]!;
            args[i] = pass(p.name, p.valueType ?? el.paramValueType(el.ctxForOwner(p.owner), p));
          }
        }
        for (const p of target.result.ir.params.slice(1 + u.target.params.length)) {
          if (p.origin === "bound") args.push(pass(p.boundName ?? p.name, p.type));
          else if (p.origin === "outer") {
            const key = [...target.outerNames.entries()].find(([, n]) => n === p.name)?.[0];
            const need = key ? target.outer.get(key) : undefined;
            if (need && sym === need.owner)
              args.push({
                kind: need.memberKind === "field" ? "field" : "param",
                name: need.member,
                type: need.type
              });
            else if (need)
              args.push({
                kind: "param",
                name: info.outerNames.get(need.key) ?? need.member,
                type: need.type
              });
          }
        }
        u.type.args = args;
      }
    }
  }

  /** Renames the provisional `\0b:`/`\0o:` parameter references to the assigned names. */
  renameProvisionalParams(): void {
    for (const info of this.order) {
      visitStruct(info.result.ir, {
        expr: e => {
          if (e.kind !== "param") return;
          if (e.name.startsWith(BOUND_PREFIX)) {
            const n = e.name.slice(BOUND_PREFIX.length);
            e.name = info.boundNames.get(n) ?? n;
          } else if (e.name.startsWith(OUTER_PREFIX)) {
            const key = e.name.slice(OUTER_PREFIX.length);
            e.name = info.outerNames.get(key) ?? key.split(".").pop()!;
          }
        }
      });
    }
  }
}

/** A use inside a generic body checked with opaque type parameters: no instance exists. */
function isOpenGenericUse(u: UseSite): boolean {
  return u.target.typeParams.length > 0 && !u.typeArgs.length;
}

function isNestedIn(s: StructSym, owner: StructSym): boolean {
  for (let p = s.parent; p; p = p.parent) if (p === owner) return true;
  return false;
}

/** Bindings of one `$name` must have compatible types (integer widths may differ). */
function reportBoundTypeConflicts(el: Elaborator): void {
  for (const [name, sites] of el.model.bindingSites) {
    let first: { t: IrValueType; site: FieldSym | ParamSym } | undefined;
    for (const s of sites) {
      const t = s.valueType;
      if (!t || (t.kind === "struct" && t.struct.startsWith("<"))) continue;
      if (!first) {
        first = { t, site: s };
        continue;
      }
      const ok =
        (first.t.kind === "int" && t.kind === "int") ||
        JSON.stringify(first.t) === JSON.stringify(t);
      if (ok) continue;
      el.diags.report(
        s.module.file,
        s.nameSpan,
        "bound-type-conflict",
        `$${name} is bound as ${displayValueType(t, el.displayName)} here but as ${displayValueType(first.t, el.displayName)} elsewhere; readers need one type.`,
        {
          related: [
            {
              file: first.site.module.file,
              span: first.site.nameSpan,
              message: `bound as ${displayValueType(first.t, el.displayName)} here`
            }
          ]
        }
      );
    }
  }
}

function rootParamFix(r: StructSym, name: string, type: IrValueType, el: Elaborator): Fix {
  const t = displayValueType(type, el.displayName);
  const param = `${t === "int" ? "u32" : t} $${name}`;
  const d = r.decl;
  const insert = (at: number, newText: string): Fix => ({
    title: `Add parameter ${param} to ${r.name}`,
    edits: [{ file: r.module.file, span: { start: at, end: at }, newText }]
  });
  if (d.params && d.params.length)
    return insert(d.params[d.params.length - 1]!.span.end, `, ${param}`);
  // empty `()`
  if (d.params) return insert(d.name.span.end + 1, param);
  const at = d.typeParams.length
    ? d.typeParams[d.typeParams.length - 1]!.span.end + 1
    : d.name.span.end;
  return insert(at, `(${param})`);
}

/** Reports structs that contain themselves through unconditional inline fields. */
function checkRecursion(
  el: Elaborator,
  order: InstanceInfo[],
  infos: Map<string, InstanceInfo>
): void {
  type Edge = { to: string; field: IrField; result: StructResult };
  const edges = new Map<string, Edge[]>();
  for (const info of order) {
    const list: Edge[] = [];
    const visit = (ms: IrMember[]) => {
      for (const m of ms) {
        if (m.kind === "field" && !m.placement && !m.from) {
          const t = coreType(m.type);
          if (t.kind === "struct") list.push({ to: t.struct, field: m, result: info.result });
        } else if (m.kind === "block" && !m.condition) visit(m.members);
      }
    };
    visit(info.result.ir.members);
    edges.set(info.result.key, list);
  }
  const state = new Map<string, "active" | "done">();
  const reported = new Set<string>();
  const dfs = (k: string, stack: string[]) => {
    state.set(k, "active");
    for (const e of edges.get(k) ?? []) {
      if (state.get(e.to) === "active") {
        if (reported.has(e.result.key + e.field.name)) continue;
        reported.add(e.result.key + e.field.name);
        const fs = e.result.sym.fieldsByName.get(e.field.name)?.[0];
        if (fs) {
          const cycle = [...stack, e.to].join(" → ");
          el.diags.report(
            fs.module.file,
            fs.nameSpan,
            "recursive-struct",
            `'${e.field.name}' contains ${el.displayName(e.to)} inline, which contains itself (${cycle}): its size would be infinite. Use a pointer, an array or a condition.`
          );
        }
        continue;
      }
      if (!state.get(e.to) && infos.has(e.to)) dfs(e.to, [...stack, e.to]);
    }
    state.set(k, "done");
  };
  for (const info of order)
    if (!state.get(info.result.key)) dfs(info.result.key, [info.result.key]);
}

/**
 * For `T x from arr[*].piece`: the element struct's `piece` comes from `x` on write, and sizes
 * measuring it become optional inputs (split points for byte-exact rebuilds).
 */
function markStreamPieces(s: IrStruct, infos: Map<string, InstanceInfo>): void {
  const fields = new Map<string, IrField>();
  visitMembers(s.members, {
    member: m => {
      if (m.kind === "field") fields.set(m.name, m);
    }
  });
  for (const f of fields.values()) {
    if (!f.from || f.from.stream.kind !== "each") continue;
    const arr = fields.get(f.from.stream.array);
    const t = arr && coreType(arr.type);
    if (!t || t.kind !== "array") continue;
    const e = coreType(t.element);
    if (e.kind !== "struct") continue;
    const target = infos.get(e.struct);
    if (!target) continue;
    const piece = f.from.stream.field;
    visitMembers(target.result.ir.members, {
      member: m => {
        if (m.kind !== "field") return;
        if (m.name === piece) m.input = "absent";
        else if (m.derive && m.deriveKind === "auto" && measuresPiece(m.derive, piece))
          m.input = "optional";
      }
    });
  }
}

function measuresPiece(e: IrExpr, piece: string): boolean {
  let found = false;
  visitExpr(e, {
    expr: x => {
      if (
        x.kind === "call" &&
        x.callee.kind === "builtin" &&
        x.callee.name === "encodedSize" &&
        x.args[0]?.kind === "field" &&
        x.args[0].name === piece
      )
        found = true;
    }
  });
  return found;
}

/** `async` (an async codec anywhere inside) and `usesEndian`, propagated through struct uses. */
function computeFlags(el: Elaborator, order: InstanceInfo[]): void {
  const byId = new Map(order.map(i => [i.result.ir.id, i]));
  const asyncCodec = (id: string) => {
    const s = el.externsById.get(id);
    return !!s && s.kind === "codec" && s.decl.async;
  };
  for (const info of order) {
    const ir = info.result.ir;
    ir.async = [...info.result.out.codecs].some(asyncCodec);
    ir.usesEndian = structUsesEndianDirect(ir);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const info of order) {
      const ir = info.result.ir;
      const targets = structTargets(ir);
      for (const t of targets.all) {
        if (byId.get(t)?.result.ir.async && !ir.async) {
          ir.async = true;
          changed = true;
        }
      }
      if (!ir.usesEndian && targets.inheriting.some(t => byId.get(t)?.result.ir.usesEndian)) {
        ir.usesEndian = true;
        changed = true;
      }
    }
  }
}

function readsEndianParam(e: IrExpr): boolean {
  let found = false;
  visitExpr(e, {
    expr: x => {
      if (x.kind === "param" && x.name === "endian") found = true;
    }
  });
  return found;
}

/** An `@endian(v)` layer with a constant `v`: everything inside ignores the `endian` parameter. */
function fixesEndian(layers: IrLayer[]): boolean {
  return layers.some(l => l.kind === "endian" && !readsEndianParam(l.value));
}

/** Does the struct itself (not through other structs) depend on its `endian` parameter? */
function structUsesEndianDirect(s: IrStruct): boolean {
  if (fixesEndian(s.layers)) return false;
  let uses = false;
  const typeUses = (t: IrType, overridden: boolean): void => {
    switch (t.kind) {
      case "prim":
        if (!overridden && t.endian === "inherit" && PRIMS[t.prim].bytes > 1) uses = true;
        break;
      case "enum":
        if (!overridden && t.endian === "inherit") uses = true;
        break;
      case "string":
        if (!overridden && t.endian === "inherit" && t.unit > 1) uses = true;
        break;
      case "pointer":
        if (!overridden && t.storageEndian === "inherit" && PRIMS[t.storage].bytes > 1) uses = true;
        typeUses(t.target, overridden);
        break;
      case "array":
        typeUses(t.element, overridden);
        break;
      case "union":
        for (const v of t.variants) typeUses(v.type, overridden);
        break;
      case "transform":
        typeUses(t.inner, overridden);
        break;
      case "layered":
        typeUses(t.inner, overridden || fixesEndian(t.layers));
        break;
      default:
        break;
    }
  };
  const exprUses = (e: IrExpr, overridden: boolean) => {
    if (!overridden && readsEndianParam(e)) uses = true;
  };
  const members = (ms: IrMember[], overridden: boolean) => {
    for (const m of ms) {
      switch (m.kind) {
        case "field":
          // a virtual field's prim is only its value type: nothing is read with it
          if (m.virtual) exprUses(m.virtual.read, overridden);
          else typeUses(m.type, overridden);
          if (m.derive) exprUses(m.derive, overridden);
          for (const c of m.checks) exprUses(c.expr, overridden);
          break;
        case "bits":
          if (!overridden && m.endian === "inherit" && PRIMS[m.storage].bytes > 1) uses = true;
          break;
        case "block": {
          const ov = overridden || fixesEndian(m.layers);
          if (m.condition) exprUses(m.condition, overridden);
          members(m.members, ov);
          if (m.else) members(m.else, ov);
          break;
        }
        case "switch":
          exprUses(m.discriminant, overridden);
          for (const c of m.cases) members(c.members, overridden);
          if (m.default) members(m.default, overridden);
          break;
      }
    }
  };
  members(s.members, false);
  return uses;
}

/** Struct ids used by `s`, and those whose endian argument is still the inherited one. */
function structTargets(s: IrStruct): { all: string[]; inheriting: string[] } {
  const all: string[] = [];
  const inheriting: string[] = [];
  const typeWalk = (t: IrType, overridden: boolean) => {
    switch (t.kind) {
      case "struct": {
        all.push(t.struct);
        const endian = t.args[0];
        if (!overridden && endian?.kind === "param" && endian.name === "endian")
          inheriting.push(t.struct);
        break;
      }
      case "pointer":
        typeWalk(t.target, overridden);
        break;
      case "array":
        typeWalk(t.element, overridden);
        break;
      case "union":
        for (const v of t.variants) typeWalk(v.type, overridden);
        break;
      case "transform":
        typeWalk(t.inner, overridden);
        break;
      case "layered":
        typeWalk(t.inner, overridden || fixesEndian(t.layers));
        break;
      default:
        break;
    }
  };
  const members = (ms: IrMember[], overridden: boolean) => {
    for (const m of ms) {
      if (m.kind === "field") typeWalk(m.type, overridden);
      else if (m.kind === "block") {
        const ov = overridden || fixesEndian(m.layers);
        members(m.members, ov);
        if (m.else) members(m.else, ov);
      } else if (m.kind === "switch") {
        for (const c of m.cases) members(c.members, overridden);
        if (m.default) members(m.default, overridden);
      }
    }
  };
  members(s.members, fixesEndian(s.layers));
  return { all, inheriting };
}

/** The program: reachable structs, the enums and externs they use, exported constants. */
function programOf(
  el: Elaborator,
  modules: ModuleInfo[],
  roots: StructSym[],
  order: InstanceInfo[]
): IrProgram {
  const structs = order.map(i => i.result.ir);
  const enumIds = new Set<string>();
  const externIds = new Set<string>();
  for (const s of structs) {
    visitStruct(s, {
      type: t => {
        if (t.kind === "enum") enumIds.add(t.enum);
        if (t.kind === "extern") externIds.add(t.extern);
        if (t.kind === "layered")
          for (const l of t.layers) if (l.kind === "via") externIds.add(l.codec);
      },
      expr: e => {
        if (e.kind === "call" && e.callee.kind === "extern") externIds.add(e.callee.extern);
        if (e.kind === "literal" && e.value.kind === "enum") enumIds.add(e.value.enum);
        if (e.type.kind === "enum") enumIds.add(e.type.enum);
      }
    });
    for (const l of s.layers) if (l.kind === "via") externIds.add(l.codec);
    visitMembers(s.members, {
      member: m => {
        if (m.kind === "block")
          for (const l of m.layers) if (l.kind === "via") externIds.add(l.codec);
      }
    });
    for (const p of s.params) if (p.type.kind === "enum") enumIds.add(p.type.enum);
  }
  const enums: IrEnum[] = [];
  for (const id of enumIds) {
    const e = el.enumsById.get(id);
    if (!e) continue;
    const info = el.enumInfo(e);
    enums.push({
      id,
      name: el.nameOf(id),
      module: e.module.irPath,
      storage: info.storage,
      members: e.members.map(m => ({
        name: m.name,
        value: (info.values.get(m.name) ?? 0n).toString()
      })),
      open: info.open
    });
  }
  const externs: IrExtern[] = [];
  for (const id of externIds) {
    const x = externOf(el, id);
    if (x) externs.push(x);
  }
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  externs.sort(byId);
  enums.sort(byId);
  const consts: IrConst[] = [];
  for (const m of modules) {
    for (const d of m.decls.values()) {
      if (d.kind !== "const" || !d.exported) continue;
      const v = el.constLiteral(d);
      if (v) consts.push({ name: d.name, module: m.irPath, type: v.type, value: v.value });
    }
  }
  const irRoots: IrRoot[] = roots.map(r => ({
    struct: el.idOf(r),
    name: r.name,
    module: r.module.irPath
  }));
  return {
    version: IR_VERSION,
    modules: modules.map(m => ({ path: m.irPath, name: m.irName })),
    structs,
    enums,
    externs,
    consts,
    roots: irRoots
  };
}

function externOf(el: Elaborator, id: string): IrExtern | undefined {
  if (id === "uleb128" || id === "sleb128") {
    return {
      kind: "type",
      id,
      name: id,
      module: "",
      params: [],
      valueType: { kind: "int", bits: 64, signed: id === "sleb128" },
      builtin: true
    };
  }
  const s = el.externsById.get(id);
  if (!s) return undefined;
  if (s.kind === "externFn") {
    const sig = el.externFnSignature(s);
    return {
      kind: "fn",
      id,
      name: s.name,
      module: s.module.irPath,
      params: sig.params,
      returns: sig.returns
    };
  }
  if (s.kind === "codec") {
    const c = el.ctxForOwner(s);
    return {
      kind: "codec",
      id,
      name: s.name,
      module: s.module.irPath,
      params: s.params.map(p => ({ name: p.name, type: el.paramValueType(c, p) })),
      async: s.decl.async,
      ranged: s.decl.attrs.some(a => a.name.name === "ranged"),
      streaming: s.decl.attrs.some(a => a.name.name === "streaming")
    };
  }
  const sig = el.externTypeSignature(s);
  const x: IrExtern = {
    kind: "type",
    id,
    name: s.name,
    module: s.module.irPath,
    params: sig.params,
    valueType: sig.valueType
  };
  if (sig.fixedSize !== undefined) x.fixedSize = sig.fixedSize;
  return x;
}
