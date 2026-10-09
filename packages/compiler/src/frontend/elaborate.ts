/**
 * The elaborator: name resolution, constants, enums, externs, and type lowering. Struct bodies are
 * lowered by members.ts; expressions by expr.ts. The same code runs in check mode (diagnostics,
 * language-service records, generic parameters opaque) and lower mode (generic instances).
 */
import type * as A from "./ast.ts";
import { someExpr, typeRefName, unparen } from "./ast.ts";
import { ATTRIBUTES, targetLabel, type AttrTarget } from "./attributes.ts";
import type { Ctx, TypeArgBinding, UseSite } from "./ctx.ts";
import { BOUND_PREFIX, newOutputs, useSiteScope } from "./ctx.ts";
import {
  DiagnosticBag,
  removalFix,
  replaceFix,
  type DiagOptions,
  type DiagnosticCode,
  type Fix
} from "./diagnostics.ts";
import {
  BUILTIN_FUNCTIONS,
  coerce,
  errorExpr,
  isError,
  lit,
  lowerConstExpr,
  lowerExpr,
  lowerFieldRef,
  matchArgs
} from "./expr.ts";
import type {
  IrEndianSpec,
  IrExpr,
  IrFill,
  IrLayer,
  IrLength,
  IrLiteral,
  IrMember,
  IrPrimKind,
  IrStringType,
  IrStructType,
  IrTransformType,
  IrType,
  IrValueType
} from "../ir/index.ts";
import { invertTransform } from "./invert.ts";
import { lowerStructBody } from "./members.ts";
import { visitType } from "../ir/walk.ts";
import { SemanticModel, type StructResult } from "./model.ts";
import { concreteIntType } from "./range.ts";
import type { Span } from "./source.ts";
import {
  allDecls,
  type AliasSym,
  type CodecSym,
  type ConstSym,
  type DeclSym,
  type EnumMemberSym,
  type EnumSym,
  type ExternFnSym,
  type ExternTypeSym,
  type FieldSym,
  type ModuleInfo,
  type NamespaceSym,
  type ParamSym,
  type StructSym,
  type Sym,
  type TypeParamSym,
  type UnionSym
} from "./symbols.ts";
import {
  BIGINT,
  BOOL,
  BUILTIN_TYPE_NAMES,
  BYTES,
  ENDIAN,
  ERROR_TYPE,
  PRIMS,
  STRING,
  U8,
  coreType,
  intPrim,
  intRange,
  intType,
  isErrorType,
  lookupBuiltinType,
  typeParamType,
  valueTypeOf
} from "./types.ts";
import { closest, relativePath, dirname, sanitizeIdent } from "./util.ts";

/** Padding layers: they take a fill and the `strict` word. */
const PADDING_LAYERS = new Set(["align", "alignEnd", "padBefore", "padAfter", "padUntil"]);

/** C and Ghidra type names, for a quick fix to the yaffle type. */
const C_TYPE_NAMES: Record<string, string> = {
  int: "i32",
  uint: "u32",
  short: "i16",
  ushort: "u16",
  byte: "u8",
  word: "u16",
  dword: "u32",
  qword: "u64",
  float: "f32",
  double: "f64",
  longlong: "i64",
  ulonglong: "u64",
  undefined: "u8",
  undefined1: "u8",
  undefined2: "u16",
  undefined4: "u32",
  undefined8: "u64",
  uint8_t: "u8",
  uint16_t: "u16",
  uint32_t: "u32",
  uint64_t: "u64",
  int8_t: "i8",
  int16_t: "i16",
  int32_t: "i32",
  int64_t: "i64"
};

export type ValueRes =
  | { kind: "lambda"; type: IrValueType }
  | { kind: "paramArg"; expr: IrExpr; sym: ParamSym }
  | { kind: "field"; syms: FieldSym[] }
  | { kind: "param"; sym: ParamSym }
  | { kind: "outerField"; syms: FieldSym[]; owner: StructSym }
  | { kind: "outerParam"; sym: ParamSym; owner: StructSym }
  | { kind: "decl"; sym: DeclSym }
  | { kind: "namespace"; sym: NamespaceSym }
  | { kind: "builtinFn"; name: string }
  | { kind: "enumMember"; sym: EnumMemberSym }
  | { kind: "none" };

export type TypeSymRes =
  | { kind: "decl"; sym: StructSym | EnumSym | UnionSym | AliasSym | ExternTypeSym }
  | { kind: "typeParam"; sym: TypeParamSym }
  | { kind: "builtin"; name: string }
  | { kind: "none" };

/** Clauses carried by a type alias that apply to the field using it. */
export interface AliasExtras {
  alias: AliasSym;
  ctx: Ctx;
  spec: A.TypeSpec;
}

/** A field's base type before array suffixes. */
export interface BaseType {
  ir: IrType;
  value: IrValueType;
  /** char/char16/char32: the innermost array suffix makes a string. */
  char?: { unit: 1 | 2 | 4 };
  /** A plain u8: the innermost array suffix makes bytes. */
  byte?: boolean;
  /** Alias clauses (in/where/=) to merge into the field. */
  extras?: AliasExtras;
  /** The type is a struct (for arrays-of-struct `$index` handling). */
  struct?: StructSym;
}

export interface EnumInfo {
  storage: IrPrimKind;
  endian: IrEndianSpec;
  open: boolean;
  values: Map<string, bigint>;
}

export interface ElaboratorOptions {
  /** yaffle.json targets, for extern implementation checks. */
  targets?: Record<string, { externs?: Record<string, string> }>;
  /** Structs that are roots as if exported (tools: decoding a sample with any struct). */
  extraRoots?: { path: string; name: string }[];
}

export class Elaborator {
  readonly diags: DiagnosticBag;
  readonly model = new SemanticModel();
  readonly modules: ModuleInfo[];
  readonly options: ElaboratorOptions;

  private readonly ids = new Map<DeclSym, string>();
  private readonly idNames = new Map<string, string>();
  private readonly displayNames = new Map<string, string>();
  readonly instancesById = new Map<string, { sym: StructSym; typeArgs: TypeArgBinding[] }>();
  readonly enumsById = new Map<string, EnumSym>();
  readonly externsById = new Map<string, ExternFnSym | CodecSym | ExternTypeSym>();
  private readonly usedNames = new Set<string>();

  private readonly constCache = new Map<ConstSym, IrExpr | "pending">();
  private readonly enumCache = new Map<EnumSym, EnumInfo>();
  readonly results = new Map<string, StructResult>();
  private readonly paramTypeCache = new Map<ParamSym, IrValueType>();
  private readonly aliasStack: AliasSym[] = [];
  private readonly boundTypeCache = new Map<string, IrValueType | undefined>();
  /** Built-in extern types used (uleb128/sleb128). */
  readonly builtinExterns = new Set<string>();
  readonly displayName = (id: string): string => this.displayNames.get(id) ?? id;

  constructor(modules: ModuleInfo[], diags: DiagnosticBag, options: ElaboratorOptions = {}) {
    this.modules = modules;
    this.diags = diags;
    this.options = options;
    this.assignIds();
    this.collectBindingSites();
  }

  // ── ids ──────────────────────────────────────────────────────────────────

  private assignIds(): void {
    const all: DeclSym[] = this.modules.flatMap(m => allDecls(m));
    const qualifiedOf = (d: DeclSym): string =>
      d.kind === "struct" || d.kind === "enum" || d.kind === "union" ? d.qualified : d.name;
    const counts = new Map<string, number>();
    for (const d of all) {
      if (!this.needsId(d)) continue;
      const q = qualifiedOf(d);
      counts.set(q, (counts.get(q) ?? 0) + 1);
    }
    for (const d of all) {
      if (!this.needsId(d)) continue;
      const q = qualifiedOf(d);
      const id = counts.get(q)! > 1 ? `${d.module.irName}::${q}` : q;
      this.ids.set(d, id);
      this.displayNames.set(id, q);
      let name = sanitizeIdent(counts.get(q)! > 1 ? `${d.module.irName}_${q}` : q);
      while (this.usedNames.has(name)) name += "_";
      this.usedNames.add(name);
      this.idNames.set(id, name);
      if (d.kind === "struct" && !d.typeParams.length)
        this.instancesById.set(id, { sym: d, typeArgs: [] });
      if (d.kind === "enum") this.enumsById.set(id, d);
      if (d.kind === "externFn" || d.kind === "codec" || d.kind === "externType")
        this.externsById.set(id, d);
    }
  }

  private needsId(d: DeclSym): boolean {
    return (
      d.kind === "struct" ||
      d.kind === "enum" ||
      d.kind === "externFn" ||
      d.kind === "codec" ||
      d.kind === "externType"
    );
  }

  idOf(sym: DeclSym): string {
    return this.ids.get(sym) ?? sym.name;
  }

  nameOf(id: string): string {
    return this.idNames.get(id) ?? sanitizeIdent(id);
  }

  /** Id and name of a (possibly generic) struct instance. */
  instanceId(sym: StructSym, typeArgs: TypeArgBinding[]): string {
    const base = this.idOf(sym);
    if (!sym.typeParams.length) return base;
    if (!typeArgs.length) return `${base}<${sym.typeParams.map(t => t.name).join(", ")}>`;
    const id = `${base}<${typeArgs.map(t => t.display).join(", ")}>`;
    if (!this.instancesById.has(id)) {
      this.instancesById.set(id, { sym, typeArgs });
      let name = sanitizeIdent(`${this.nameOf(base)}_${typeArgs.map(t => t.display).join("_")}`);
      while (this.usedNames.has(name)) name += "_";
      this.usedNames.add(name);
      this.idNames.set(id, name);
      this.displayNames.set(id, `${sym.qualified}<${typeArgs.map(t => t.display).join(", ")}>`);
    }
    return id;
  }

  // ── reporting ────────────────────────────────────────────────────────────

  report(ctx: Ctx, span: Span, code: DiagnosticCode, message: string, opts?: DiagOptions): void {
    if (ctx.report) this.diags.report(ctx.module.file, span, code, message, opts);
  }

  recordRef(ctx: Ctx, span: Span, sym: Sym, decl = false): void {
    if (ctx.record) this.model.addRef(ctx.module, span, sym, decl);
  }

  // ── contexts ─────────────────────────────────────────────────────────────

  moduleCtx(mod: ModuleInfo, report = true): Ctx {
    return {
      module: mod,
      report,
      record: report,
      typeArgs: new Map(),
      lambdas: new Map(),
      side: "const",
      position: 0,
      frames: [],
      guards: [],
      insideArray: false,
      out: newOutputs(),
      fieldTypes: new Map()
    };
  }

  // ── binding sites ────────────────────────────────────────────────────────

  private collectBindingSites(): void {
    for (const mod of this.modules) {
      for (const d of allDecls(mod)) {
        if (d.kind !== "struct") continue;
        for (const f of d.fields) {
          if (f.bound && f.name) this.addBindingSite(f.name, f);
        }
        for (const p of d.params) {
          if (p.bound && p.name) this.addBindingSite(p.name, p);
        }
      }
    }
  }

  private addBindingSite(name: string, site: FieldSym | ParamSym): void {
    let list = this.model.bindingSites.get(name);
    if (!list) this.model.bindingSites.set(name, (list = []));
    list.push(site);
  }

  isBoundName(name: string): boolean {
    return this.model.bindingSites.has(name);
  }

  /** The value type of `$name`, unified over every binding site. */
  boundType(name: string): IrValueType | undefined {
    if (this.boundTypeCache.has(name)) return this.boundTypeCache.get(name);
    this.boundTypeCache.set(name, undefined);
    const sites = this.model.bindingSites.get(name) ?? [];
    let t: IrValueType | undefined;
    for (const s of sites) {
      const st =
        s.kind === "field"
          ? this.bindingFieldType(s)
          : this.paramValueType(this.ctxForOwner(s.owner), s);
      if (!st || isErrorType(st)) continue;
      t = t ? (widenBound(t, st) ?? t) : st;
    }
    this.boundTypeCache.set(name, t);
    return t;
  }

  private bindingFieldType(f: FieldSym): IrValueType | undefined {
    if (f.valueType) return f.valueType;
    const r = this.results.get(this.idOf(f.owner));
    const t = r?.fields.get(f)?.value;
    if (t) return t;
    if (!f.owner.typeParams.length && !this.results.has(this.idOf(f.owner))) {
      this.structResult(f.owner);
      return f.valueType ?? this.results.get(this.idOf(f.owner))?.fields.get(f)?.value;
    }
    return undefined;
  }

  /** A silent context for resolving names in a declaration's parameters (externs: module scope). */
  ctxForOwner(owner: ParamSym["owner"]): Ctx {
    const c = this.moduleCtx(owner.module, false);
    if (owner.kind === "struct" || owner.kind === "union" || owner.kind === "alias")
      c.owner = owner;
    return c;
  }

  // ── name lookup ──────────────────────────────────────────────────────────

  /** Owner chain for lexical lookup: the owner, then enclosing structs. */
  private ownerChain(ctx: Ctx): (StructSym | UnionSym | AliasSym)[] {
    const out: (StructSym | UnionSym | AliasSym)[] = [];
    let o: StructSym | UnionSym | AliasSym | undefined = ctx.owner ?? ctx.struct;
    while (o) {
      out.push(o);
      o = o.kind === "alias" ? undefined : o.parent;
    }
    return out;
  }

  /** Looks up a declaration name in lexical scope (nested decls, module, imports). */
  lookupDecl(ctx: Ctx, name: string): DeclSym | NamespaceSym | undefined {
    for (const o of this.ownerChain(ctx)) {
      if (o.kind === "struct") {
        const n = o.nested.get(name);
        if (n) return n;
      }
    }
    const mod = ctx.module;
    const d = mod.decls.get(name);
    if (d) return d;
    const imp = mod.imports.get(name);
    if (imp) {
      imp.used = true;
      return imp.target;
    }
    const ns = mod.namespaces.get(name);
    if (ns) {
      ns.used = true;
      return ns;
    }
    return undefined;
  }

  lookupValue(ctx: Ctx, name: string, span: Span): ValueRes {
    const lam = ctx.lambdas.get(name);
    if (lam) return { kind: "lambda", type: lam };
    if (ctx.paramArgs) {
      for (const [p, e] of ctx.paramArgs)
        if (p.name === name) return { kind: "paramArg", expr: e, sym: p };
    }
    const s = ctx.struct;
    if (s) {
      const fs = s.fieldsByName.get(name);
      if (fs) return { kind: "field", syms: fs };
      const p = s.params.find(x => x.name === name);
      if (p) {
        this.recordRef(ctx, span, p);
        return { kind: "param", sym: p };
      }
      let o = s.parent;
      while (o) {
        const ofs = o.fieldsByName.get(name);
        if (ofs) {
          this.recordRef(ctx, span, ofs[0]!);
          return { kind: "outerField", syms: ofs, owner: o };
        }
        const op = o.params.find(x => x.name === name);
        if (op) {
          this.recordRef(ctx, span, op);
          return { kind: "outerParam", sym: op, owner: o };
        }
        o = o.parent;
      }
    }
    const d = this.lookupDecl(ctx, name);
    if (d) {
      this.recordRef(ctx, span, d);
      if (d.kind === "namespace") return { kind: "namespace", sym: d };
      return { kind: "decl", sym: d };
    }
    if (name in BUILTIN_FUNCTIONS) return { kind: "builtinFn", name };
    return { kind: "none" };
  }

  suggestName(ctx: Ctx, name: string): string | undefined {
    const names: string[] = [];
    if (ctx.struct && ctx.side !== "const") {
      for (const f of ctx.struct.fields) {
        if (ctx.side === "read" && f.order >= ctx.position) continue;
        names.push(f.name);
      }
      names.push(...ctx.struct.params.map(p => p.name));
      let o = ctx.struct.parent;
      while (o) {
        names.push(...o.fields.map(f => f.name), ...o.params.map(p => p.name));
        o = o.parent;
      }
    }
    for (const [n, d] of ctx.module.decls)
      if (d.kind === "const" || d.kind === "enum") names.push(n);
    for (const [n] of ctx.module.imports) names.push(n);
    names.push(...ctx.lambdas.keys());
    return closest(name, names);
  }

  suggestFunction(name: string): string | undefined {
    const names = [...Object.keys(BUILTIN_FUNCTIONS)];
    for (const m of this.modules)
      for (const [n, d] of m.decls) if (d.kind === "externFn") names.push(n);
    return closest(name, names);
  }

  /** Resolves `Enum`, `ns`, `ns.Enum`, `Struct.Nested` paths used in expressions. */
  resolveStaticPath(ctx: Ctx, e: A.Expr): DeclSym | NamespaceSym | undefined {
    const u = unparen(e);
    if (u.kind === "Name") {
      if (ctx.struct && ctx.side !== "const") {
        if (ctx.struct.fieldsByName.has(u.name) || ctx.struct.params.some(p => p.name === u.name))
          return undefined;
        let o = ctx.struct.parent;
        while (o) {
          if (o.fieldsByName.has(u.name) || o.params.some(p => p.name === u.name)) return undefined;
          o = o.parent;
        }
      }
      if (ctx.lambdas.has(u.name)) return undefined;
      if (ctx.paramArgs && [...ctx.paramArgs.keys()].some(p => p.name === u.name)) return undefined;
      const d = this.lookupDecl(ctx, u.name);
      if (d) this.recordRef(ctx, u.span, d);
      return d;
    }
    if (u.kind === "Member") {
      const base = this.resolveStaticPath(ctx, u.object);
      if (!base) return undefined;
      let r: DeclSym | undefined;
      if (base.kind === "namespace") r = base.target?.decls.get(u.name.name);
      else if (base.kind === "struct") r = base.nested.get(u.name.name);
      if (r) this.recordRef(ctx, u.name.span, r);
      return r;
    }
    return undefined;
  }

  enumMemberById(enumId: string, name: string): EnumMemberSym | undefined {
    return this.enumsById.get(enumId)?.members.find(m => m.name === name);
  }

  enumMemberNames(enumId: string): string[] {
    return this.enumsById.get(enumId)?.members.map(m => m.name) ?? [];
  }

  isTypeName(ctx: Ctx, name: string): boolean {
    const d = this.lookupDecl(ctx, name);
    return !!lookupBuiltinType(name) || (!!d && isTypeDecl(d));
  }

  // ── field presence ───────────────────────────────────────────────────────

  fieldPresent(ctx: Ctx, cands: FieldSym[]): boolean {
    const frames = ctx.frames;
    const exprKey = (e: A.Expr) => JSON.stringify(stripSpans(e));
    const guardOk = (c: FieldSym, from: number): boolean => {
      for (let i = from; i < c.frames.length; i++) {
        const f = c.frames[i]!;
        if (f.member.kind !== "IfMember" || !f.member.condition) return false;
        const key = exprKey(f.member.condition);
        const want = f.branch === 0;
        if (!ctx.guards.some(g => g.positive === want && exprKey(g.expr) === key)) return false;
      }
      return true;
    };
    const shared = (c: FieldSym): number => {
      let i = 0;
      while (
        i < c.frames.length &&
        i < frames.length &&
        c.frames[i]!.member === frames[i]!.member &&
        c.frames[i]!.branch === frames[i]!.branch
      )
        i++;
      return i;
    };
    for (const c of cands) {
      const s = shared(c);
      if (s === c.frames.length) return true;
      if (guardOk(c, s)) return true;
    }
    // alternatives: every branch of some if/switch declares the field
    const covers = (cs: FieldSym[], depth: number): boolean => {
      if (cs.some(c => c.frames.length <= depth)) return true;
      const groups = new Map<A.IfMember | A.SwitchMember, FieldSym[]>();
      for (const c of cs) {
        const m = c.frames[depth]!.member;
        let g = groups.get(m);
        if (!g) groups.set(m, (g = []));
        g.push(c);
      }
      for (const [m, g] of groups) {
        const branches = m.kind === "IfMember" ? (m.else ? [0, 1] : []) : m.cases.map((_, i) => i);
        if (!branches.length) continue;
        if (
          branches.every(b =>
            covers(
              g.filter(c => c.frames[depth]!.branch === b),
              depth + 1
            )
          )
        )
          return true;
      }
      return false;
    };
    // candidates sharing the context's frames up to some depth
    let depth = Infinity;
    for (const c of cands) depth = Math.min(depth, shared(c));
    if (!Number.isFinite(depth)) return false;
    const relevant = cands.filter(c => shared(c) >= depth);
    return covers(relevant, depth);
  }

  // ── bound values ─────────────────────────────────────────────────────────

  lowerBoundRef(ctx: Ctx, name: string, span: Span): IrExpr {
    const s = ctx.struct;
    if (s) {
      const p = s.params.find(x => x.bound && x.name === name);
      if (p) {
        this.recordRef(ctx, span, p);
        return { kind: "param", name: p.name, type: this.paramValueType(ctx, p) };
      }
      const fs = (s.fieldsByName.get(name) ?? []).filter(f => f.bound);
      const visible = fs.filter(
        f => f !== ctx.self && (ctx.side !== "read" || f.order < ctx.position)
      );
      if (visible.length) return lowerFieldRef(this, ctx, visible, span, name);
    }
    // With no binding site anywhere, the read is still recorded (typed as an integer) so the
    // path analysis can report it with the path and a quick fix; unreachable structs get a plain
    // "nothing binds" error from the assembly.
    const type = this.boundType(name) ?? BIGINT;
    const expr = { kind: "param" as const, name: BOUND_PREFIX + name, type };
    ctx.out.boundReads.push({ name, file: ctx.module.file, span, expr });
    return expr;
  }

  /** $names bound in the current struct before `position` (and declared `$` params). */
  localBindings(struct: StructSym, position: number, ctx: Ctx): Map<string, IrExpr> {
    const out = new Map<string, IrExpr>();
    for (const p of struct.params) {
      if (p.bound)
        out.set(p.name, { kind: "param", name: p.name, type: this.paramValueType(ctx, p) });
    }
    for (const f of struct.fields) {
      if (f.bound && f.name && f.order < position) {
        const t = ctx.fieldTypes.get(f)?.value ?? f.valueType;
        if (t) out.set(f.name, { kind: "field", name: f.name, type: t });
      }
    }
    return out;
  }

  // ── constants ────────────────────────────────────────────────────────────

  constValue(sym: ConstSym, ctx: Ctx, span: Span): IrExpr {
    const cached = this.constCache.get(sym);
    if (cached === "pending") {
      this.report(ctx, span, "const-cycle", `Constant '${sym.name}' depends on itself.`);
      return errorExpr();
    }
    if (cached) return structuredClone(cached);
    this.constCache.set(sym, "pending");
    const c = this.moduleCtx(sym.module, ctx.report && ctx.module === sym.module);
    c.record = ctx.record && ctx.module === sym.module;
    const v = this.lowerConstDecl(sym, c);
    this.constCache.set(sym, v);
    return structuredClone(v);
  }

  private lowerConstDecl(sym: ConstSym, ctx: Ctx): IrExpr {
    const d = sym.decl;
    if (!d.value) return errorExpr();
    let t: IrValueType | undefined;
    if (d.type) {
      const base = this.lowerBaseType(ctx, d.type);
      t = base ? suffixedValueType(base, d.arrays.length) : ERROR_TYPE;
    }
    const v = lowerConstExpr(this, ctx, d.value, t);
    if (isError(v)) return v;
    if (t) return coerce(this, ctx, v, t, d.value, `Constant '${sym.name}'`);
    // an untyped integer constant gets the smallest standard type holding it
    if (v.kind === "literal" && v.value.kind === "int" && v.type.kind === "bigint")
      return { ...v, type: concreteIntType(v) };
    return v;
  }

  constLiteral(sym: ConstSym): { type: IrValueType; value: IrLiteral } | undefined {
    const v = this.constValue(sym, this.moduleCtx(sym.module, false), sym.nameSpan);
    if (v.kind !== "literal" || isErrorType(v.type)) return undefined;
    return { type: v.type, value: v.value };
  }

  // ── enums ────────────────────────────────────────────────────────────────

  enumInfo(sym: EnumSym, report = false): EnumInfo {
    const cached = this.enumCache.get(sym);
    if (cached) return cached;
    const ctx = this.moduleCtx(sym.module, report);
    if (sym.parent) ctx.owner = sym.parent;
    const info: EnumInfo = { storage: "u32", endian: "inherit", open: false, values: new Map() };
    this.enumCache.set(sym, info);
    const d = sym.decl;
    if (d.storage) {
      const b = intPrim(typeRefName(d.storage));
      if (b) {
        info.storage = b.prim;
        info.endian = b.endian;
        this.recordRef(ctx, d.storage.span, { kind: "builtinType", name: d.storage.name[0]!.name });
      } else {
        this.report(
          ctx,
          d.storage.span,
          "type-mismatch",
          "An enum's storage must be an integer type (u8, u16be, …)."
        );
      }
    } else {
      this.report(
        ctx,
        d.name.span,
        "type-mismatch",
        `Enum '${sym.name}' needs a storage type, e.g. \`enum ${sym.name} : u8 { … }\`.`
      );
    }
    for (const a of d.attrs) {
      if (a.name.name === "open") info.open = true;
      this.checkAttrTarget(ctx, a, "enum");
    }
    const st = intType(info.storage);
    let next = 0n;
    const byValue = new Map<string, EnumMemberSym>();
    for (const m of sym.members) {
      let v = next;
      if (m.decl.value) {
        const e = lowerConstExpr(this, ctx, m.decl.value, st);
        if (e.kind === "literal" && e.value.kind === "int") v = BigInt(e.value.value);
        else if (!isError(e))
          this.report(
            ctx,
            m.decl.value.span,
            "type-mismatch",
            "Enum values must be integer constants."
          );
      }
      const range = intRange(st);
      if (range && (v < range[0] || v > range[1])) {
        this.report(
          ctx,
          m.decl.value?.span ?? m.nameSpan,
          "enum-value-range",
          `${v} doesn't fit the enum's storage ${info.storage}.`
        );
      }
      const prev = byValue.get(v.toString());
      if (prev) {
        this.report(
          ctx,
          m.nameSpan,
          "duplicate-enum-value",
          `'${m.name}' has the same value (${v}) as '${prev.name}'.`,
          {
            related: [
              {
                file: sym.module.file,
                span: prev.nameSpan,
                message: `'${prev.name}' is declared here`
              }
            ]
          }
        );
      } else byValue.set(v.toString(), m);
      m.value = v;
      info.values.set(m.name, v);
      this.recordRef(ctx, m.nameSpan, m, true);
      next = v + 1n;
    }
    return info;
  }

  // ── attributes (shared checks) ───────────────────────────────────────────

  checkAttrTarget(ctx: Ctx, a: A.Attribute, target: AttrTarget): boolean {
    const spec = ATTRIBUTES[a.name.name];
    if (!spec) {
      const suggestion = closest(a.name.name, Object.keys(ATTRIBUTES));
      const fixes: Fix[] = suggestion
        ? [replaceFix(ctx.module.file, a.name.span, `@${suggestion}`, `Change to @${suggestion}`)]
        : [];
      this.report(
        ctx,
        a.name.span,
        "unknown-attribute",
        `Unknown attribute @${a.name.name}.${suggestion ? ` Did you mean @${suggestion}?` : ""}`,
        { fixes }
      );
      return false;
    }
    if (!spec.targets.includes(target)) {
      const where = spec.targets.map(targetLabel).join(", ");
      this.report(
        ctx,
        a.name.span,
        "invalid-attribute-target",
        `@${spec.name} isn't allowed on ${targetLabel(target)}; it applies to ${where}.`
      );
      return false;
    }
    // `from:`/`offset:` and the `strict` word don't take positional slots
    const argc = (a.args ?? []).filter(x => {
      if (x.name && spec.named?.some(n => n.name === x.name!.name)) return false;
      const v = unparen(x.value);
      if (
        spec.strictWord &&
        !x.name &&
        v.kind === "Name" &&
        v.name === "strict" &&
        !ctx.struct?.fieldsByName.has("strict")
      )
        return false;
      return true;
    }).length;
    const min = spec.args.filter(x => !x.optional).length;
    if (argc < min || argc > spec.args.length) {
      const sig = spec.args.length
        ? `(${spec.args.map(x => (x.optional ? x.name + "?" : x.name)).join(", ")})`
        : "";
      this.report(
        ctx,
        a.argsSpan ?? a.span,
        "invalid-attribute-argument",
        `@${spec.name}${sig} takes ${spec.args.length === min ? min : `${min} to ${spec.args.length}`} argument${spec.args.length === 1 ? "" : "s"}, but ${argc} ${argc === 1 ? "was" : "were"} given.`
      );
      return false;
    }
    return true;
  }

  // ── types ────────────────────────────────────────────────────────────────

  /** Resolves the symbol a type reference names. Records references. */
  lookupTypeSym(ctx: Ctx, ref: A.TypeRef): TypeSymRes {
    const parts = ref.name;
    const first = parts[0];
    if (!first || !first.name) return { kind: "none" };
    if (parts.length === 1) {
      const name = first.name;
      for (const o of this.ownerChain(ctx)) {
        const tp = o.typeParams.find(t => t.name === name);
        if (tp) {
          if (o !== (ctx.owner ?? ctx.struct)) {
            this.report(
              ctx,
              first.span,
              "unknown-type",
              `Nested declarations can't use the enclosing struct's type parameter ${name}.`
            );
            return { kind: "none" };
          }
          this.recordRef(ctx, first.span, tp);
          return { kind: "typeParam", sym: tp };
        }
      }
      const d = this.lookupDecl(ctx, name);
      if (d && d.kind !== "namespace") {
        this.recordRef(ctx, first.span, d);
        if (isTypeDecl(d)) return { kind: "decl", sym: d };
        this.report(
          ctx,
          first.span,
          "not-a-type",
          `'${name}' is a ${d.kind === "externFn" ? "function" : d.kind}, not a type.`
        );
        return { kind: "none" };
      }
      if (d && d.kind === "namespace") {
        this.report(
          ctx,
          first.span,
          "not-a-type",
          `'${name}' is a namespace; use ${name}.TypeName.`
        );
        return { kind: "none" };
      }
      if (lookupBuiltinType(name)) {
        this.recordRef(ctx, first.span, { kind: "builtinType", name });
        return { kind: "builtin", name };
      }
      this.reportUnknownType(ctx, first);
      return { kind: "none" };
    }
    // qualified: ns.Type, Struct.Nested, ns.Struct.Nested
    let cur: DeclSym | NamespaceSym | undefined = this.lookupDecl(ctx, first.name);
    if (!cur) {
      this.reportUnknownType(ctx, first);
      return { kind: "none" };
    }
    this.recordRef(ctx, first.span, cur);
    for (const part of parts.slice(1)) {
      let nxt: DeclSym | undefined;
      if (cur.kind === "namespace") nxt = cur.target?.decls.get(part.name);
      else if (cur.kind === "struct") nxt = cur.nested.get(part.name);
      if (!nxt) {
        this.report(ctx, part.span, "unknown-type", `'${cur.name}' has no type '${part.name}'.`);
        return { kind: "none" };
      }
      this.recordRef(ctx, part.span, nxt);
      cur = nxt;
    }
    if (isTypeDecl(cur)) return { kind: "decl", sym: cur };
    this.report(
      ctx,
      ref.span,
      "not-a-type",
      `'${parts.map(p => p.name).join(".")}' is not a type.`
    );
    return { kind: "none" };
  }

  private reportUnknownType(ctx: Ctx, id: A.Ident): void {
    if (!ctx.report) return;
    const names = new Set<string>(BUILTIN_TYPE_NAMES);
    for (const o of this.ownerChain(ctx)) {
      if (o.kind === "struct") for (const n of o.nested.keys()) names.add(n);
      for (const t of o.typeParams) names.add(t.name);
    }
    for (const [n, d] of ctx.module.decls)
      if (d.kind !== "const" && d.kind !== "externFn" && d.kind !== "codec") names.add(n);
    for (const n of ctx.module.imports.keys()) names.add(n);
    const suggestion = closest(id.name, names);
    const fixes: Fix[] = [];
    if (suggestion) fixes.push(replaceFix(ctx.module.file, id.span, suggestion));
    // offer to import it from another module that declares it
    for (const m of this.modules) {
      if (m === ctx.module) continue;
      const d = m.decls.get(id.name);
      if (d && d.kind !== "const" && d.kind !== "externFn" && d.kind !== "codec") {
        fixes.push(this.importFix(ctx.module, m, id.name));
      }
    }
    const g = C_TYPE_NAMES[id.name];
    if (g && !suggestion) fixes.unshift(replaceFix(ctx.module.file, id.span, g));
    this.report(
      ctx,
      id.span,
      "unknown-type",
      `Unknown type '${id.name}'.${suggestion ? ` Did you mean '${suggestion}'?` : g ? ` Did you mean '${g}'?` : ""}`,
      { fixes }
    );
  }

  importFix(into: ModuleInfo, from: ModuleInfo, name: string): Fix {
    let rel = relativePath(dirname(into.path), from.path);
    if (!rel.startsWith(".")) rel = "./" + rel;
    const imports = into.ast.decls.filter(d => d.kind === "ImportDecl");
    const last = imports[imports.length - 1];
    const at = last ? last.span.end : 0;
    const text = `${last ? "\n" : ""}import { ${name} } from "${rel}"${last ? "" : "\n\n"}`;
    return {
      title: `Import '${name}' from "${rel}"`,
      edits: [{ file: into.file, span: { start: at, end: at }, newText: text }]
    };
  }

  /** Lowers a type reference (without array suffixes) to a base type. */
  /** `insideArray` overrides `ctx.insideArray` for struct uses (`$index` availability). */
  lowerBaseType(ctx: Ctx, ref: A.TypeRef, insideArray?: boolean): BaseType | undefined {
    const res = this.lookupTypeSym(ctx, ref);
    const noArgs = (what: string) => {
      if (ref.args)
        this.report(
          ctx,
          ref.argsSpan ?? ref.span,
          "wrong-argument-count",
          `${what} takes no arguments.`
        );
      if (ref.typeArgs)
        this.report(ctx, ref.span, "wrong-type-argument-count", `${what} takes no type arguments.`);
    };
    switch (res.kind) {
      case "none":
        if (ref.args) for (const a of ref.args) lowerExpr(this, { ...ctx, report: false }, a.value);
        return undefined;
      case "builtin": {
        const b = lookupBuiltinType(res.name)!;
        noArgs(`'${res.name}'`);
        switch (b.kind) {
          case "prim":
            return {
              ir: { kind: "prim", prim: b.prim, endian: b.endian },
              value: intType(b.prim),
              ...(b.prim === "u8" ? { byte: true } : {})
            };
          case "bool":
            return { ir: { kind: "bool" }, value: BOOL };
          case "char":
            return {
              ir: stringType(b.unit, { kind: "count", expr: intLiteral(1) }),
              value: STRING,
              char: { unit: b.unit }
            };
          case "str":
            return {
              ir: stringType(b.unit, { kind: "until", terminator: intLiteral(0) }),
              value: STRING
            };
          case "leb": {
            const id = b.signed ? "sleb128" : "uleb128";
            this.builtinExterns.add(id);
            return {
              ir: { kind: "extern", extern: id, args: [] },
              value: { kind: "int", bits: 64, signed: b.signed }
            };
          }
        }
        break;
      }
      case "typeParam": {
        noArgs(`Type parameter ${res.sym.name}`);
        const binding = ctx.typeArgs.get(res.sym);
        if (!binding) {
          return {
            ir: { kind: "struct", struct: `<T:${res.sym.name}>`, args: [] },
            value: typeParamType(res.sym.name)
          };
        }
        return this.lowerTypeArgBinding(ctx, binding, insideArray);
      }
      case "decl": {
        const s = res.sym;
        switch (s.kind) {
          case "struct":
            return this.lowerStructUse(ctx, s, ref, insideArray);
          case "enum": {
            noArgs(`Enum '${s.name}'`);
            const info = this.enumInfo(s);
            const id = this.idOf(s);
            return {
              ir: { kind: "enum", enum: id, endian: info.endian },
              value: { kind: "enum", enum: id }
            };
          }
          case "union":
            return this.lowerUnionUse(ctx, s, ref, insideArray);
          case "alias":
            return this.lowerAliasUse(ctx, s, ref, insideArray);
          case "externType": {
            if (ref.typeArgs)
              this.report(
                ctx,
                ref.span,
                "wrong-type-argument-count",
                `'${s.name}' takes no type arguments.`
              );
            const sig = this.externTypeSignature(s);
            const args =
              matchArgs(
                this,
                ctx,
                ref.args ?? [],
                sig.params.map(p => ({ name: p.name, type: p.type, optional: false })),
                ref.argsSpan ?? ref.span,
                `'${s.name}'`
              ) ?? [];
            const id = this.idOf(s);
            return {
              ir: { kind: "extern", extern: id, args },
              value: sig.valueType
            };
          }
        }
      }
    }
    return undefined;
  }

  private lowerTypeArgBinding(
    ctx: Ctx,
    binding: TypeArgBinding,
    insideArray: boolean | undefined
  ): BaseType | undefined {
    const site = useSiteScope(ctx);
    const c: Ctx = {
      ...binding.scope,
      out: ctx.out,
      report: false,
      record: false,
      insideArray: ctx.insideArray,
      ...(site ? { site } : {})
    };
    const base = this.lowerBaseType(c, binding.ast.type, insideArray);
    if (!base) return undefined;
    if (!binding.ast.arrays.length) return base;
    const ir = this.applyArrays(c, base, binding.ast.arrays);
    return { ir, value: valueTypeOf(ir, undefined, this.externValueType) };
  }

  readonly externValueType = (id: string): IrValueType => {
    if (id === "uleb128") return { kind: "int", bits: 64, signed: false };
    if (id === "sleb128") return { kind: "int", bits: 64, signed: true };
    const s = this.externsById.get(id);
    if (s && s.kind === "externType") return this.externTypeSignature(s).valueType;
    return BIGINT;
  };

  /** Resolves generic type arguments at a use site. */
  typeArgBindings(
    ctx: Ctx,
    owner: StructSym | UnionSym | AliasSym,
    ref: A.TypeRef
  ): TypeArgBinding[] | undefined {
    const tps = owner.typeParams;
    const given = ref.typeArgs ?? [];
    if (!tps.length) {
      if (ref.typeArgs)
        this.report(ctx, ref.span, "wrong-type-argument-count", `'${owner.name}' isn't generic.`);
      return [];
    }
    if (given.length !== tps.length) {
      this.report(
        ctx,
        ref.span,
        "wrong-type-argument-count",
        `'${owner.name}' takes ${tps.length} type argument${tps.length === 1 ? "" : "s"} (${tps.map(t => t.name).join(", ")}), but ${given.length} ${given.length === 1 ? "was" : "were"} given.`
      );
      return undefined;
    }
    const out: TypeArgBinding[] = [];
    for (const ta of given) {
      // a scratch lowering finds out whether the argument uses runtime values
      const scratch = newOutputs();
      const probe: Ctx = {
        ...ctx,
        out: scratch,
        report: false,
        record: false,
        side: ctx.side === "const" ? "read" : ctx.side
      };
      const pbase = this.lowerBaseType(probe, ta.type);
      const pir =
        pbase && (ta.arrays.length ? this.applyArrays(probe, pbase, ta.arrays) : pbase.ir);
      let usesRuntime =
        scratch.boundReads.length > 0 ||
        scratch.outerReads.length > 0 ||
        scratch.indexReads.length > 0;
      if (pir) {
        visitType(pir, {
          expr: e => {
            if (
              e.kind === "field" ||
              e.kind === "builtinValue" ||
              (e.kind === "param" && e.name !== "endian")
            )
              usesRuntime = true;
          }
        });
      }
      const c: Ctx = {
        ...ctx,
        out: newOutputs(),
        side: "const",
        fieldTypes: ctx.fieldTypes,
        report: ctx.report && !usesRuntime
      };
      const base = this.lowerBaseType(c, ta.type);
      const ir = base && (ta.arrays.length ? this.applyArrays(c, base, ta.arrays) : base.ir);
      if (usesRuntime)
        this.report(
          ctx,
          ta.span,
          "generic-argument",
          "Generic type arguments can only use constants, not fields or parameters."
        );
      if (!ir || usesRuntime) return undefined;
      const key = JSON.stringify(stripArgs(ir));
      out.push({
        ast: ta,
        scope: { ...ctx, out: newOutputs(), site: undefined, record: false, report: false },
        key,
        display: irTypeDisplay(ir, this)
      });
    }
    return out;
  }

  private lowerStructUse(
    ctx: Ctx,
    s: StructSym,
    ref: A.TypeRef,
    insideArray: boolean | undefined
  ): BaseType | undefined {
    const typeArgs = this.typeArgBindings(ctx, s, ref);
    if (!typeArgs) {
      if (ref.args) for (const a of ref.args) lowerExpr(this, { ...ctx, report: false }, a.value);
      return undefined;
    }
    const id = this.instanceId(s, typeArgs);
    // explicit arguments (declared `$` params may be omitted: filled from the binding environment)
    const params = s.params.map(p => ({
      name: p.name,
      type: this.paramValueType(this.ctxForOwner(s), p),
      optional: p.bound || !!p.decl.default,
      ...(p.decl.default && !p.bound
        ? {
            defaultValue: () =>
              lowerConstExpr(
                this,
                { ...this.ctxForOwner(s), report: false },
                p.decl.default!,
                this.paramValueType(this.ctxForOwner(s), p)
              )
          }
        : {})
    }));
    const argCtx: Ctx = { ...ctx, side: ctx.side === "const" ? "const" : "read" };
    const args = this.matchStructArgs(argCtx, s, ref, params);
    const type: IrStructType = {
      kind: "struct",
      struct: id,
      args: [{ kind: "param", name: "endian", type: ENDIAN }, ...args.map(a => a ?? placeholder())]
    };
    this.recordUse(ctx, type, s, typeArgs, ref.span, insideArray ?? ctx.insideArray, args);
    return { ir: type, value: { kind: "struct", struct: id }, struct: s };
  }

  /** Matches struct arguments; omitted bound params give `undefined` (patched later). */
  private matchStructArgs(
    ctx: Ctx,
    s: StructSym,
    ref: A.TypeRef,
    params: { name: string; type: IrValueType; optional: boolean; defaultValue?: () => IrExpr }[]
  ): (IrExpr | undefined)[] {
    const out: (IrExpr | undefined)[] = params.map(() => undefined);
    const given = ref.args ?? [];
    let positional = 0;
    for (const a of given) {
      let idx: number;
      if (a.name) {
        idx = params.findIndex(p => p.name === a.name!.name);
        if (idx < 0) {
          this.report(
            ctx,
            a.name.span,
            "unknown-argument",
            `'${s.name}' has no parameter '${a.name.name}'.`
          );
          lowerExpr(this, ctx, a.value);
          continue;
        }
        const p = s.params[idx];
        if (p) this.recordRef(ctx, a.name.span, p);
      } else {
        idx = positional++;
        if (idx >= params.length) {
          this.report(
            ctx,
            a.span,
            "wrong-argument-count",
            `'${s.name}' takes ${params.length} argument${params.length === 1 ? "" : "s"}, but more were given.`
          );
          lowerExpr(this, ctx, a.value);
          continue;
        }
      }
      if (out[idx]) {
        this.report(
          ctx,
          a.span,
          "duplicate-argument",
          `Parameter '${params[idx]!.name}' is given twice.`
        );
        continue;
      }
      const p = params[idx]!;
      const v = lowerExpr(this, ctx, a.value, p.type);
      out[idx] = coerce(this, ctx, v, p.type, a.value, `Argument '${p.name}'`);
    }
    params.forEach((p, i) => {
      if (out[i]) return;
      if (p.defaultValue) out[i] = p.defaultValue();
      else if (!p.optional) {
        this.report(
          ctx,
          ref.argsSpan ?? ref.span,
          "wrong-argument-count",
          `'${s.name}' is missing argument '${p.name}'.`
        );
        out[i] = errorExpr();
      }
    });
    return out;
  }

  private recordUse(
    ctx: Ctx,
    type: IrStructType,
    target: StructSym,
    typeArgs: TypeArgBinding[],
    span: Span,
    insideArray: boolean,
    explicit: (IrExpr | undefined)[]
  ): void {
    const site = useSiteScope(ctx);
    const use: UseSite = {
      type,
      target,
      typeArgs,
      position: site?.position ?? 0,
      localBound: site ? this.localBindings(site.struct, site.position, ctx) : new Map(),
      insideArray,
      file: ctx.module.file,
      span,
      fieldName: site?.fieldName ?? "",
      explicitHoles: explicit.flatMap((a, i) => (a ? [] : [i + 1]))
    };
    ctx.out.uses.push(use);
  }

  private lowerUnionUse(
    ctx: Ctx,
    u: UnionSym,
    ref: A.TypeRef,
    insideArray: boolean | undefined
  ): BaseType | undefined {
    const typeArgs = this.typeArgBindings(ctx, u, ref);
    if (!typeArgs) return undefined;
    const params = u.params.map(p => ({
      name: p.name,
      type: this.paramValueType(this.ctxForOwner(u), p),
      optional: false
    }));
    const args = matchArgs(
      this,
      ctx,
      ref.args ?? [],
      params,
      ref.argsSpan ?? ref.span,
      `'${u.name}'`
    );
    if (!args) return undefined;
    const site = useSiteScope(ctx);
    const c: Ctx = {
      ...ctx,
      module: u.module,
      owner: u,
      struct: undefined,
      paramArgs: new Map(u.params.map((p, i) => [p, args[i]!])),
      typeArgs: new Map(
        u.typeParams.map((tp, i) => [tp, typeArgs[i]!] as const).filter(([, b]) => !!b)
      ),
      report: false,
      record: false,
      side: "read",
      ...(site ? { site } : {})
    };
    const variants: { name: string; type: IrType }[] = [];
    for (const v of u.decl.variants) {
      const b = this.lowerBaseType(c, v, insideArray);
      if (!b) return undefined;
      variants.push({ name: v.name[v.name.length - 1]!.name, type: b.ir });
    }
    return {
      ir: { kind: "union", variants },
      value: {
        kind: "union",
        variants: variants.map(v => ({
          name: v.name,
          type: valueTypeOf(v.type, undefined, this.externValueType)
        }))
      }
    };
  }

  /** Checks a union declaration on its own. */
  checkUnion(u: UnionSym): void {
    const ctx = this.moduleCtx(u.module);
    ctx.owner = u;
    ctx.side = "read";
    ctx.paramArgs = new Map(
      u.params.map(p => [
        p,
        { kind: "param", name: p.name, type: this.paramValueType(ctx, p) } as IrExpr
      ])
    );
    this.recordRef(ctx, u.nameSpan, u, true);
    for (const p of u.params) this.recordRef(ctx, p.nameSpan, p, true);
    for (const tp of u.typeParams) this.recordRef(ctx, tp.nameSpan, tp, true);
    const names = new Map<string, A.TypeRef>();
    for (const v of u.decl.variants) {
      this.lowerBaseType(ctx, v);
      const n = v.name[v.name.length - 1]!.name;
      const prev = names.get(n);
      if (prev) {
        this.report(ctx, v.span, "duplicate-variant", `Variant '${n}' is listed twice.`, {
          related: [{ file: u.module.file, span: prev.span, message: "first listed here" }]
        });
      } else names.set(n, v);
    }
    for (const a of u.decl.attrs) {
      if (!ATTRIBUTES[a.name.name]) this.checkAttrTarget(ctx, a, "struct");
      else
        this.report(
          ctx,
          a.name.span,
          "invalid-attribute-target",
          `@${a.name.name} isn't allowed on unions.`
        );
    }
  }

  private lowerAliasUse(
    ctx: Ctx,
    al: AliasSym,
    ref: A.TypeRef,
    insideArray: boolean | undefined
  ): BaseType | undefined {
    if (this.aliasStack.includes(al)) {
      this.diags.report(
        ctx.module.file,
        ref.span,
        "alias-cycle",
        `Type alias '${al.name}' refers to itself (${[...this.aliasStack.slice(this.aliasStack.indexOf(al)).map(a => a.name), al.name].join(" → ")}).`
      );
      return undefined;
    }
    const typeArgs = this.typeArgBindings(ctx, al, ref);
    if (!typeArgs) return undefined;
    const params = al.params.map(p => ({
      name: p.name,
      type: this.paramValueType(this.ctxForOwner(al), p),
      optional: false,
      ...(p.decl.default
        ? {
            defaultValue: () =>
              lowerConstExpr(
                this,
                { ...this.ctxForOwner(al), report: false },
                p.decl.default!,
                this.paramValueType(this.ctxForOwner(al), p)
              )
          }
        : {})
    }));
    const args = matchArgs(
      this,
      ctx,
      ref.args ?? [],
      params,
      ref.argsSpan ?? ref.span,
      `'${al.name}'`
    );
    if (!args) return undefined;
    const body = al.decl.body;
    if (!body) return undefined;
    const site = useSiteScope(ctx);
    const c: Ctx = {
      ...ctx,
      module: al.module,
      owner: al,
      struct: undefined,
      paramArgs: new Map(al.params.map((p, i) => [p, args[i]!])),
      typeArgs: new Map(
        al.typeParams.map((tp, i) => [tp, typeArgs[i]!] as const).filter(([, b]) => !!b)
      ),
      report: false,
      record: false,
      side: ctx.side === "const" ? "const" : "read",
      ...(site ? { site } : {})
    };
    this.aliasStack.push(al);
    try {
      return this.lowerTypeSpec(c, body, insideArray);
    } finally {
      this.aliasStack.pop();
    }
  }

  /** Lowers a type alias body (type, arrays, transform, layers). */
  lowerTypeSpec(ctx: Ctx, spec: A.TypeSpec, insideArray?: boolean): BaseType | undefined {
    const base = this.lowerBaseType(ctx, spec.type, insideArray);
    if (!base) return undefined;
    let encoding: "utf8" | "ascii" | "latin1" | undefined;
    for (const a of spec.attrs) {
      if (a.name.name === "encoding") encoding = this.encodingArg(ctx, a);
    }
    const b2: BaseType =
      encoding && base.char ? { ...base, ir: withEncoding(base.ir, encoding) } : base;
    let ir = spec.arrays.length
      ? this.applyArrays(ctx, b2, spec.arrays, encoding)
      : encoding
        ? withEncoding(b2.ir, encoding)
        : b2.ir;
    let value = valueTypeOf(ir, undefined, this.externValueType);
    if (spec.clauses.asRead) {
      const t = this.lowerTransform(ctx, ir, value, spec.clauses.asRead, spec.clauses.asWrite);
      ir = t.ir;
      value = t.value;
    }
    const layers = this.lowerLayers(ctx, spec.attrs, "alias");
    if (layers.length) ir = { kind: "layered", inner: ir, layers };
    const out: BaseType = { ir, value };
    if (!spec.arrays.length && !spec.clauses.asRead && !layers.length) {
      if (base.char) out.char = base.char;
      if (base.byte) out.byte = true;
    }
    if (base.struct && !spec.arrays.length) out.struct = base.struct;
    if (spec.clauses.inItems || spec.clauses.regex || spec.clauses.where || spec.clauses.formula) {
      out.extras = { alias: ctx.owner as AliasSym, ctx, spec };
    }
    return out;
  }

  /** Checks a type alias declaration on its own. */
  checkAlias(al: AliasSym): void {
    const ctx = this.moduleCtx(al.module);
    ctx.owner = al;
    ctx.side = "read";
    ctx.paramArgs = new Map(
      al.params.map(p => [
        p,
        { kind: "param", name: p.name, type: this.paramValueType(ctx, p) } as IrExpr
      ])
    );
    this.recordRef(ctx, al.nameSpan, al, true);
    for (const p of al.params) this.recordRef(ctx, p.nameSpan, p, true);
    for (const tp of al.typeParams) this.recordRef(ctx, tp.nameSpan, tp, true);
    const body = al.decl.body;
    if (!body) return;
    this.aliasStack.push(al);
    try {
      const b = this.lowerTypeSpec(ctx, body);
      for (const a of body.attrs) {
        const spec = ATTRIBUTES[a.name.name];
        if (!spec) this.checkAttrTarget(ctx, a, "alias");
        else if (!spec.layer && a.name.name !== "encoding") this.checkAttrTarget(ctx, a, "alias");
      }
      if (b && body.clauses.formula) {
        // a constant alias: check the formula type
        const c: Ctx = { ...ctx, side: "write", it: b.value };
        const v = lowerExpr(this, c, body.clauses.formula, b.value);
        coerce(this, c, v, b.value, body.clauses.formula, "The formula");
      }
      if (b && (body.clauses.inItems || body.clauses.where || body.clauses.regex)) {
        const c: Ctx = { ...ctx, it: b.value };
        if (body.clauses.where) lowerExpr(this, c, body.clauses.where, BOOL);
      }
    } finally {
      this.aliasStack.pop();
    }
  }

  encodingArg(ctx: Ctx, a: A.Attribute): "utf8" | "ascii" | "latin1" | undefined {
    const v = a.args?.[0]?.value;
    const u = v && unparen(v);
    if (!u || u.kind !== "String" || !["utf8", "ascii", "latin1", "utf-8"].includes(u.value)) {
      this.report(
        ctx,
        v?.span ?? a.span,
        "invalid-attribute-argument",
        '@encoding takes "utf8", "ascii" or "latin1".'
      );
      return undefined;
    }
    return u.value === "utf-8" ? "utf8" : (u.value as "utf8" | "ascii" | "latin1");
  }

  /** Applies C-style array suffixes (the last suffix is the innermost dimension). */
  applyArrays(
    ctx: Ctx,
    base: BaseType,
    arrays: A.ArraySuffix[],
    encoding?: "utf8" | "ascii" | "latin1"
  ): IrType {
    let t: IrType = base.ir;
    for (let i = arrays.length - 1; i >= 0; i--) {
      const a = arrays[i]!;
      const innermost = i === arrays.length - 1;
      if (innermost && base.char) {
        const s = t as IrStringType;
        t = {
          kind: "string",
          unit: s.unit,
          encoding: encoding ?? s.encoding,
          endian: "inherit",
          length: this.lowerLength(ctx, a, STRING, "string")
        };
      } else if (innermost && base.byte) {
        t = { kind: "bytes", length: this.lowerLength(ctx, a, U8, "bytes") };
      } else {
        const elemValue = valueTypeOf(t, undefined, this.externValueType);
        t = { kind: "array", element: t, length: this.lowerLength(ctx, a, elemValue, "array") };
      }
    }
    return t;
  }

  lowerLength(
    ctx: Ctx,
    a: A.ArraySuffix,
    elem: IrValueType,
    target: "string" | "bytes" | "array"
  ): IrLength {
    if (a.mode === "rest" || !a.expr) return { kind: "rest" };
    const expr = a.expr;
    const usesIt = someExpr(expr, x => x.kind === "It");
    if (a.mode === "before" || usesIt) {
      if (target !== "array") {
        this.report(
          ctx,
          a.span,
          "not-implemented",
          `\`[${a.mode} …]\`${usesIt ? " with a predicate" : ""} is only implemented for arrays, not ${target === "string" ? "strings" : "bytes"}.`
        );
        return { kind: "rest" };
      }
      if (usesIt) {
        if (a.mode === "before") {
          this.report(
            ctx,
            expr.span,
            "invalid-length",
            "`before` takes a value; use `until <condition>` for a predicate."
          );
          return { kind: "rest" };
        }
        // inclusive predicate: `until it.nextOfs == 0`
        const p = lowerExpr(this, { ...ctx, it: elem, insideArray: true }, expr, BOOL);
        if (!isError(p) && p.type.kind !== "bool") {
          this.report(
            ctx,
            expr.span,
            "type-mismatch",
            "An `until` condition using `it` must be bool."
          );
          return { kind: "rest" };
        }
        return { kind: "untilPredicate", predicate: p };
      }
      return this.lowerTerminator(ctx, "before", expr, elem);
    }
    if (a.mode === "until") {
      if (target !== "string") return this.lowerTerminator(ctx, "until", expr, elem);
      const v = lowerConstExpr(this, ctx, expr);
      if (!isError(v) && !(v.kind === "literal" && v.value.kind === "int" && v.value.value === "0"))
        this.report(
          ctx,
          expr.span,
          "invalid-length",
          "Strings can only be terminated by 0 (`[until 0]`)."
        );
      return { kind: "until", terminator: intLiteral(0) };
    }
    const v = lowerExpr(this, ctx, expr);
    if (!isError(v) && v.type.kind !== "int" && v.type.kind !== "bigint") {
      this.report(
        ctx,
        expr.span,
        "type-mismatch",
        `An array length must be an integer, but this is ${v.type.kind === "float" ? "a float" : v.type.kind}.`,
        v.type.kind === "float"
          ? {
              fixes: [
                {
                  title: "Wrap in round()",
                  edits: [
                    {
                      file: ctx.module.file,
                      span: expr.span,
                      newText: `round(${ctx.module.file.text.slice(expr.span.start, expr.span.end)})`
                    }
                  ]
                }
              ]
            }
          : {}
      );
      return { kind: "count", expr: errorExpr() };
    }
    const n = v.kind === "literal" && v.value.kind === "int" ? BigInt(v.value.value) : undefined;
    if (n !== undefined && n < 0n)
      this.report(ctx, expr.span, "value-out-of-range", "An array length can't be negative.");
    return { kind: "count", expr: v };
  }

  /** `[until v]` / `[before v]` on an array: elements are compared with `v` as values. */
  private lowerTerminator(
    ctx: Ctx,
    kind: "until" | "before",
    expr: A.Expr,
    elem: IrValueType
  ): IrLength {
    if (elem.kind === "struct" || elem.kind === "array" || elem.kind === "union") {
      this.report(
        ctx,
        expr.span,
        "invalid-length",
        `\`${kind}\` needs scalar or string elements (compared as values).`
      );
      return { kind: "rest" };
    }
    const v = lowerExpr(this, ctx, expr, elem);
    return { kind, terminator: coerce(this, ctx, v, elem, expr, "The terminator") };
  }

  /** `as read [= write]`: returns the transform type. The write side is filled by members.ts. */
  lowerTransform(
    ctx: Ctx,
    inner: IrType,
    innerValue: IrValueType,
    read: A.Expr,
    write: A.Expr | undefined
  ): { ir: IrType; value: IrValueType } {
    const r = lowerExpr(this, { ...ctx, it: innerValue }, read);
    if (isError(r)) return { ir: inner, value: innerValue };
    // integer results get the smallest standard type holding their static range
    const valueType = r.type.kind === "bigint" ? concreteIntType(r) : r.type;
    const t: IrTransformType = {
      kind: "transform",
      inner,
      read: r,
      valueType
    };
    if (write) {
      const wctx: Ctx = { ...ctx, side: ctx.side === "const" ? "const" : "write", it: valueType };
      const w = lowerExpr(this, wctx, write, innerValue);
      if (!isError(w)) t.write = coerce(this, wctx, w, innerValue, write, "The write formula");
    } else {
      const inv = invertTransform(r, innerValue, valueType);
      if (inv) {
        t.write = inv;
        t.writeInferred = true;
      }
    }
    return { ir: t, value: valueType };
  }

  /** Lowers the layer attributes of a type alias (others are skipped; the caller checks them). */
  lowerLayers(ctx: Ctx, attrs: A.Attribute[], target: AttrTarget): IrLayer[] {
    const out: IrLayer[] = [];
    const seen = new Set<string>();
    for (const a of attrs) {
      const spec = ATTRIBUTES[a.name.name];
      if (!spec || !spec.layer) continue;
      if (!this.checkAttrTarget(ctx, a, target)) continue;
      if (!spec.repeatable && seen.has(spec.name)) {
        this.report(ctx, a.span, "duplicate-attribute", `@${spec.name} appears more than once.`, {
          fixes: [removalFix(`Remove the duplicate @${spec.name}`, ctx.module.file, a.span)],
          tags: ["unnecessary"]
        });
        continue;
      }
      seen.add(spec.name);
      const l = this.lowerLayer(ctx, a);
      if (l) out.push(l);
    }
    return out;
  }

  lowerLayer(ctx: Ctx, a: A.Attribute, target?: AttrTarget): IrLayer | undefined {
    const name = a.name.name;
    const args = this.layerArgs(ctx, a, target);
    if (!args) return undefined;
    const { slots, named } = args;
    const withStrict = <T extends object>(l: T): T & { strict?: true } =>
      args.strict ? { ...l, strict: true as const } : l;
    switch (name) {
      case "size":
        return { kind: "size", size: this.intArg(ctx, slots[0], "The size") };
      case "align":
      case "alignEnd":
        return withStrict({
          kind: name as "align" | "alignEnd",
          to: this.intArg(ctx, slots[0], "The alignment"),
          fill: this.fillArg(ctx, slots[1]),
          ...this.alignOrigin(ctx, named)
        });
      case "padBefore":
      case "padAfter":
        return withStrict({
          kind: name as "padBefore" | "padAfter",
          count: this.intArg(ctx, slots[0], "The padding"),
          fill: this.fillArg(ctx, slots[1])
        });
      case "padUntil":
        return withStrict({
          kind: "padUntil" as const,
          size: this.intArg(ctx, slots[0], "The size"),
          fill: this.fillArg(ctx, slots[1])
        });
      case "endian": {
        const x = slots[0];
        if (!x) return undefined;
        const v = lowerExpr(this, ctx, x.value, ENDIAN);
        if (!isError(v) && v.type.kind !== "endian") {
          this.report(
            ctx,
            x.value.span,
            "invalid-attribute-argument",
            "@endian takes `le`, `be` or an expression of those."
          );
          return undefined;
        }
        return { kind: "endian", value: v };
      }
      case "strict":
        return { kind: "strict" };
      case "via":
        return this.lowerVia(ctx, a);
    }
    return undefined;
  }

  /**
   * Sorts a layer attribute's arguments: positional ones into the spec's slots, named ones
   * (`from:`, `offset:`, or a spec name), and the `strict` word that may end a padding's list.
   */
  private layerArgs(
    ctx: Ctx,
    a: A.Attribute,
    target: AttrTarget | undefined
  ): { slots: (A.Arg | undefined)[]; named: Map<string, A.Arg>; strict: boolean } | undefined {
    const name = a.name.name;
    const specArgs = ATTRIBUTES[name]?.args ?? [];
    const padding = PADDING_LAYERS.has(name);
    const aligning = name === "align" || name === "alignEnd";
    const positional: A.Arg[] = [];
    const named = new Map<string, A.Arg>();
    let strictArg: A.Arg | undefined;
    const strictIsField = !!ctx.struct?.fieldsByName.has("strict");
    for (const x of a.args ?? []) {
      if (x.name) {
        const n = x.name.name;
        const allowed = [...specArgs.map(s => s.name), ...(aligning ? ["from", "offset"] : [])];
        if (!allowed.includes(n)) {
          const suggestion = closest(n, allowed);
          this.report(
            ctx,
            x.name.span,
            "invalid-attribute-argument",
            `@${name} has no argument named '${n}'.${suggestion ? ` Did you mean '${suggestion}'?` : allowed.length ? ` Its arguments are ${allowed.map(s => `'${s}'`).join(", ")}.` : ""}`,
            suggestion ? { fixes: [replaceFix(ctx.module.file, x.name.span, suggestion)] } : {}
          );
        } else if (named.has(n)) {
          this.report(ctx, x.span, "duplicate-argument", `'${n}' is given twice.`);
        } else named.set(n, x);
        continue;
      }
      const u = unparen(x.value);
      if (padding && u.kind === "Name" && u.name === "strict" && !strictIsField) {
        if (positional.length === 0) {
          this.report(
            ctx,
            u.span,
            "invalid-attribute-argument",
            `@${name} needs its ${specArgs[0]?.name ?? "size"} first: @${name}(n, strict).`
          );
          return undefined;
        }
        if (strictArg) {
          this.report(ctx, x.span, "duplicate-argument", "`strict` is given twice.", {
            tags: ["unnecessary"]
          });
          continue;
        }
        strictArg = x;
        continue;
      }
      if (strictArg && padding) {
        this.report(
          ctx,
          x.span,
          "invalid-attribute-argument",
          `\`strict\` comes last: @${name}(n, fill, strict).`
        );
        return undefined;
      }
      positional.push(x);
    }
    if (strictArg && target === "layoutItem") {
      this.report(
        ctx,
        strictArg.span,
        "invalid-attribute-argument",
        "`strict` has no effect in a layout item: gaps between targets aren't read."
      );
      strictArg = undefined;
    }
    const slots: (A.Arg | undefined)[] = specArgs.map(() => undefined);
    positional.forEach((x, i) => {
      if (i < specArgs.length) slots[i] = x;
      else
        this.report(
          ctx,
          x.span,
          "invalid-attribute-argument",
          `@${name} takes ${specArgs.length ? `at most ${specArgs.length} argument${specArgs.length === 1 ? "" : "s"}` : "no arguments"}${padding ? " (plus `strict`)" : ""}.`
        );
    });
    specArgs.forEach((s, i) => {
      const x = named.get(s.name);
      if (!x) return;
      if (slots[i]) this.report(ctx, x.span, "duplicate-argument", `'${s.name}' is given twice.`);
      else slots[i] = x;
    });
    return { slots, named, strict: !!strictArg };
  }

  private intArg(ctx: Ctx, x: A.Arg | undefined, what: string): IrExpr {
    if (!x) return errorExpr();
    const v = lowerExpr(this, ctx, x.value, BIGINT);
    if (!isError(v) && v.type.kind !== "int" && v.type.kind !== "bigint") {
      this.report(ctx, x.value.span, "invalid-attribute-argument", `${what} must be an integer.`);
      return errorExpr();
    }
    return v;
  }

  /** A padding fill: a constant byte or a function of the byte index (`i => …`). */
  private fillArg(ctx: Ctx, x: A.Arg | undefined): IrFill {
    if (!x) return { kind: "byte", value: 0 };
    const u = unparen(x.value);
    if (u.kind === "Lambda") {
      const c: Ctx = { ...ctx, lambdas: new Map([...ctx.lambdas, [u.param.name, BIGINT]]) };
      const body = lowerExpr(this, c, u.body, BIGINT);
      if (!isError(body) && body.type.kind !== "int" && body.type.kind !== "bigint") {
        this.report(
          ctx,
          u.body.span,
          "invalid-attribute-argument",
          "A fill function must return an integer byte."
        );
      }
      if (ctx.record)
        this.model.addRef(
          ctx.module,
          u.param.span,
          { kind: "lambdaParam", name: u.param.name, nameSpan: u.param.span, module: ctx.module },
          true
        );
      return { kind: "fn", param: u.param.name, expr: body };
    }
    const v = lowerConstExpr(this, ctx, x.value, BIGINT);
    if (v.kind === "literal" && v.value.kind === "int") {
      const n = Number(v.value.value);
      if (n < 0 || n > 255)
        this.report(ctx, x.value.span, "invalid-attribute-argument", "A fill byte must be 0..255.");
      return { kind: "byte", value: n & 0xff };
    }
    return { kind: "byte", value: 0 };
  }

  /** `from: file | base` and `offset: n` of @align/@alignEnd (only non-defaults are emitted). */
  private alignOrigin(ctx: Ctx, named: Map<string, A.Arg>): { from?: "file"; offset?: IrExpr } {
    const out: { from?: "file"; offset?: IrExpr } = {};
    const f = named.get("from");
    if (f) {
      const u = unparen(f.value);
      if (u.kind === "Name" && (u.name === "file" || u.name === "base")) {
        if (u.name === "file") out.from = "file";
      } else {
        const word = u.kind === "Name" ? u.name : "";
        const suggestion = word ? closest(word, ["file", "base"]) : undefined;
        this.report(
          ctx,
          f.value.span,
          "invalid-attribute-argument",
          `\`from\` is \`file\` (the start of the file, decoded region or stream) or \`base\` (the nearest @base, the default).${suggestion ? ` Did you mean '${suggestion}'?` : ""}`,
          suggestion ? { fixes: [replaceFix(ctx.module.file, f.value.span, suggestion)] } : {}
        );
      }
    }
    const o = named.get("offset");
    if (o) {
      const v = this.intArg(ctx, o, "The offset");
      if (!isError(v) && !(v.kind === "literal" && v.value.kind === "int" && v.value.value === "0"))
        out.offset = v;
    }
    return out;
  }

  private lowerVia(ctx: Ctx, a: A.Attribute): IrLayer | undefined {
    const x = a.args?.[0];
    if (!x) return undefined;
    const u = unparen(x.value);
    const callee = u.kind === "Call" ? u.callee : u;
    const args = u.kind === "Call" ? u.args : [];
    const argsSpan = u.kind === "Call" ? u.argsSpan : u.span;
    const sym = this.resolveStaticPath(ctx, callee);
    if (!sym || sym.kind !== "codec") {
      const names: string[] = [];
      for (const m of this.modules)
        for (const [n, d] of m.decls) if (d.kind === "codec") names.push(n);
      const nm = callee.kind === "Name" ? callee.name : "";
      const suggestion = nm ? closest(nm, names) : undefined;
      this.report(
        ctx,
        callee.span,
        "unknown-codec",
        sym
          ? `'${sym.name}' is not a codec.`
          : `Unknown codec '${nm}'.${suggestion ? ` Did you mean '${suggestion}'?` : " Declare it with `extern codec`."}`,
        suggestion ? { fixes: [replaceFix(ctx.module.file, callee.span, suggestion)] } : {}
      );
      return undefined;
    }
    const params = sym.params.map(p => ({
      name: p.name,
      type: this.paramValueType(this.ctxForOwner(sym), p),
      optional: false
    }));
    const lowered = matchArgs(this, ctx, args, params, argsSpan, `codec '${sym.name}'`);
    if (!lowered) return undefined;
    const id = this.idOf(sym);
    ctx.out.codecs.add(id);
    return { kind: "via", codec: id, args: lowered };
  }

  // ── params and externs ───────────────────────────────────────────────────

  paramValueType(ctx: Ctx, p: ParamSym): IrValueType {
    const cached = this.paramTypeCache.get(p);
    if (cached) return cached;
    const owner = p.owner;
    const generic =
      (owner.kind === "struct" || owner.kind === "union" || owner.kind === "alias") &&
      owner.typeParams.length > 0;
    const c = this.ctxForOwner(owner);
    c.report = ctx.report && owner.module === ctx.module && !this.paramTypeCache.has(p);
    if (!p.decl.type) return ERROR_TYPE;
    this.paramTypeCache.set(p, ERROR_TYPE);
    const base = this.lowerBaseType({ ...c, report: false, record: false }, p.decl.type);
    const t = base ? suffixedValueType(base, p.decl.arrays.length, true) : ERROR_TYPE;
    if (!generic) this.paramTypeCache.set(p, t);
    else this.paramTypeCache.delete(p);
    p.valueType = t;
    return t;
  }

  /** Checks a parameter declaration (reports unknown types etc.). */
  checkParam(ctx: Ctx, p: ParamSym): void {
    this.recordRef(ctx, p.nameSpan, p, true);
    if (!p.decl.type) return;
    this.lowerBaseType({ ...ctx, side: "const" }, p.decl.type);
    if (p.decl.default) {
      const t = this.paramValueType(ctx, p);
      const v = lowerConstExpr(this, ctx, p.decl.default, t);
      coerce(this, ctx, v, t, p.decl.default, `The default of '${p.name}'`);
    }
  }

  externFnSignature(s: ExternFnSym): {
    params: { name: string; type: IrValueType }[];
    returns: IrValueType;
  } {
    const c = this.ctxForOwner(s);
    const params = s.params.map(p => ({ name: p.name, type: this.paramValueType(c, p) }));
    let returns: IrValueType = ERROR_TYPE;
    if (s.decl.returns) {
      const b = this.lowerBaseType({ ...c, report: false, record: false }, s.decl.returns);
      if (b) returns = suffixedValueType(b, s.decl.returnArrays.length);
    }
    return { params, returns };
  }

  externTypeSignature(s: ExternTypeSym): {
    params: { name: string; type: IrValueType }[];
    valueType: IrValueType;
    fixedSize?: number;
  } {
    const c = this.ctxForOwner(s);
    const params = s.params.map(p => ({ name: p.name, type: this.paramValueType(c, p) }));
    let valueType: IrValueType = ERROR_TYPE;
    if (s.decl.valueType) {
      const b = this.lowerBaseType({ ...c, report: false, record: false }, s.decl.valueType);
      if (b) valueType = b.char ? STRING : b.value;
    }
    let fixedSize: number | undefined;
    for (const a of s.decl.attrs) {
      if (a.name.name === "size" && a.args?.[0]) {
        const v = lowerConstExpr(this, { ...c, report: false }, a.args[0].value, BIGINT);
        if (v.kind === "literal" && v.value.kind === "int") fixedSize = Number(v.value.value);
      }
    }
    return { params, valueType, ...(fixedSize !== undefined ? { fixedSize } : {}) };
  }

  /** Checks an extern declaration. */
  checkExtern(s: ExternFnSym | CodecSym | ExternTypeSym): void {
    const ctx = this.ctxForOwner(s);
    ctx.report = true;
    ctx.record = true;
    this.recordRef(ctx, s.nameSpan, s, true);
    for (const p of s.params) this.checkParam(ctx, p);
    if (s.kind === "externFn") {
      if (s.decl.returns) this.lowerBaseType(ctx, s.decl.returns);
    } else if (s.kind === "codec") {
      for (const a of s.decl.attrs) this.checkAttrTarget(ctx, a, "codec");
    } else {
      if (s.decl.valueType) {
        const b = this.lowerBaseType(ctx, s.decl.valueType);
        if (b && (b.value.kind === "struct" || b.value.kind === "union")) {
          this.report(
            ctx,
            s.decl.valueType.span,
            "type-mismatch",
            "An extern type's value type must be a scalar, string or bytes."
          );
        }
      }
      for (const a of s.decl.attrs) {
        if (!this.checkAttrTarget(ctx, a, "externType")) continue;
        if (a.name.name === "size" && a.args?.[0]) {
          const v = lowerConstExpr(this, ctx, a.args[0].value, BIGINT);
          if (
            !isError(v) &&
            !(v.kind === "literal" && v.value.kind === "int" && BigInt(v.value.value) > 0n)
          ) {
            this.report(
              ctx,
              a.args[0].value.span,
              "invalid-attribute-argument",
              "@size on an extern type takes a positive constant."
            );
          }
        }
      }
    }
    // implementation for each configured target
    const targets = this.options.targets;
    if (targets) {
      for (const [t, cfg] of Object.entries(targets)) {
        if (!cfg.externs || !(s.name in cfg.externs)) {
          this.report(
            ctx,
            s.nameSpan,
            "extern-missing-implementation",
            `Extern '${s.name}' has no implementation for target '${t}'. Add it to targets.${t}.externs in yaffle.json.`
          );
        }
      }
    }
  }

  // ── structs ──────────────────────────────────────────────────────────────

  /** Check-mode result of a struct declaration (generic ones are checked with opaque type parameters). */
  structResult(sym: StructSym): StructResult {
    const key = this.instanceId(sym, []);
    const existing = this.results.get(key);
    if (existing) return existing;
    return lowerStructBody(this, sym, [], key);
  }

  /** Id of the struct (instance) being lowered in `ctx`. */
  currentStructId(ctx: Ctx): string {
    const s = ctx.struct;
    if (!s) return "<error>";
    const args = s.typeParams.map(tp => ctx.typeArgs.get(tp));
    return this.instanceId(s, args.every((a): a is TypeArgBinding => !!a) ? args : []);
  }

  /** Lowering result of a generic instance (or the check result for non-generic structs). */
  instanceResult(sym: StructSym, typeArgs: TypeArgBinding[]): StructResult {
    if (!sym.typeParams.length) return this.structResult(sym);
    const key = this.instanceId(sym, typeArgs);
    const existing = this.results.get(key);
    if (existing) return existing;
    return lowerStructBody(this, sym, typeArgs, key);
  }

  /** The value type of a field of a struct instance (for member access). */
  structMember(ctx: Ctx, structId: string, name: string, span: Span): IrValueType | undefined {
    const inst = this.instancesById.get(structId);
    if (!inst) return undefined;
    const fs = inst.sym.fieldsByName.get(name);
    if (!fs) return undefined;
    this.recordRef(ctx, span, fs[0]!);
    const r =
      this.results.get(structId) ??
      (inst.typeArgs.length
        ? this.instanceResult(inst.sym, inst.typeArgs)
        : this.structResult(inst.sym));
    const t = r.fields.get(fs[0]!)?.value;
    return t ?? ERROR_TYPE;
  }

  outerFieldValueType(f: FieldSym): IrValueType {
    if (f.valueType) return f.valueType;
    const r = this.results.get(this.instanceId(f.owner, [])) ?? this.structResult(f.owner);
    return r.fields.get(f)?.value ?? f.valueType ?? ERROR_TYPE;
  }

  /** `s.length` for a string: code units in the string's own encoding. */
  stringLength(ctx: Ctx, obj: IrExpr): IrExpr {
    const st = this.stringTypeOf(ctx, obj);
    if (!st)
      return { kind: "call", callee: { kind: "builtin", name: "len" }, args: [obj], type: BIGINT };
    const bytes: IrExpr = {
      kind: "call",
      callee: { kind: "builtin", name: "encodedLength" },
      args: [
        obj,
        lit({ kind: "int", value: String(st.unit) }, BIGINT),
        lit({ kind: "string", value: st.encoding }, STRING)
      ],
      type: BIGINT
    };
    if (st.unit === 1) return bytes;
    return {
      kind: "binary",
      op: "/",
      left: bytes,
      right: lit({ kind: "int", value: String(st.unit) }, BIGINT),
      type: BIGINT
    };
  }

  private stringTypeOf(ctx: Ctx, e: IrExpr): IrStringType | undefined {
    if (e.kind !== "field" || !ctx.struct) return undefined;
    const fs = ctx.struct.fieldsByName.get(e.name);
    const t = fs && ctx.fieldTypes.get(fs[0]!)?.ir;
    const core = t && coreType(t);
    return core?.kind === "string" ? core : undefined;
  }

  staticSizeOfNamedType(ctx: Ctx, e: A.NameExpr): number | undefined {
    const ref: A.TypeRef = {
      kind: "TypeRef",
      name: [{ kind: "Ident", name: e.name, span: e.span }],
      span: e.span
    };
    const c: Ctx = { ...ctx, report: false, side: "const", out: newOutputs() };
    const res = this.lookupTypeSym(c, ref);
    if (res.kind === "none") return undefined;
    const b = this.lowerBaseType(c, ref);
    if (!b) return undefined;
    return this.staticSize(b.ir);
  }

  /** Static byte size of a type, if it doesn't depend on data. */
  staticSize(t: IrType, seen = new Set<string>()): number | undefined {
    switch (t.kind) {
      case "prim":
        return PRIMS[t.prim].bytes;
      case "bool":
        return 1;
      case "enum": {
        const e = this.enumsById.get(t.enum);
        return e ? PRIMS[this.enumInfo(e).storage].bytes : undefined;
      }
      case "string": {
        if (t.length.kind !== "count") return undefined;
        const n = constInt(t.length.expr);
        return n === undefined ? undefined : n * t.unit;
      }
      case "bytes": {
        if (t.length.kind !== "count") return undefined;
        return constInt(t.length.expr);
      }
      case "array": {
        if (t.length.kind !== "count" || t.elementPlacement) return undefined;
        const n = constInt(t.length.expr);
        const e = this.staticSize(t.element, seen);
        return n === undefined || e === undefined ? undefined : n * e;
      }
      case "pointer":
        return PRIMS[t.storage].bytes;
      case "extern": {
        const s = this.externsById.get(t.extern);
        return s && s.kind === "externType" ? this.externTypeSignature(s).fixedSize : undefined;
      }
      case "union": {
        const sizes = t.variants.map(v => this.staticSize(v.type, seen));
        if (sizes.some(s => s === undefined)) return undefined;
        return sizes.every(s => s === sizes[0]) ? sizes[0] : undefined;
      }
      case "transform":
        return this.staticSize(t.inner, seen);
      case "layered":
        return this.layeredStaticSize(t.inner, t.layers, seen);
      case "struct": {
        if (seen.has(t.struct)) return undefined;
        const inst = this.instancesById.get(t.struct);
        if (!inst) return undefined;
        const r =
          this.results.get(t.struct) ??
          (inst.typeArgs.length
            ? this.instanceResult(inst.sym, inst.typeArgs)
            : this.structResult(inst.sym));
        if (!r.done) return undefined;
        seen.add(t.struct);
        try {
          const inner = this.membersStaticSize(r.ir.members, seen);
          if (inner === undefined) return undefined;
          return r.ir.layers.length ? this.layersSize(inner, r.ir.layers) : inner;
        } finally {
          seen.delete(t.struct);
        }
      }
    }
  }

  private layeredStaticSize(
    inner: IrType,
    layers: IrLayer[],
    seen: Set<string>
  ): number | undefined {
    // the outermost size layer fixes the size regardless of the inside
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i]!;
      if (l.kind === "size") {
        const n = constInt(l.size);
        if (n === undefined) return undefined;
        return this.layersSize(n, layers.slice(i + 1));
      }
      if (l.kind === "via") return undefined;
    }
    const s = this.staticSize(inner, seen);
    return s === undefined ? undefined : this.layersSize(s, layers);
  }

  private layersSize(size: number | undefined, layers: IrLayer[]): number | undefined {
    let s = size;
    for (const l of layers) {
      if (s === undefined) return undefined;
      switch (l.kind) {
        case "size":
          s = constInt(l.size);
          break;
        case "padBefore":
        case "padAfter": {
          const n = constInt(l.count);
          s = n === undefined ? undefined : s + n;
          break;
        }
        case "padUntil": {
          const n = constInt(l.size);
          s = n === undefined ? undefined : Math.max(n, s);
          break;
        }
        case "align":
        case "alignEnd":
        case "via":
          return undefined;
        default:
          break;
      }
    }
    return s;
  }

  membersStaticSize(members: IrMember[], seen = new Set<string>()): number | undefined {
    let total = 0;
    for (const m of members) {
      switch (m.kind) {
        case "field": {
          if (m.placement || m.from || m.virtual) continue;
          const s = this.staticSize(m.type, seen);
          if (s === undefined) return undefined;
          total += s;
          break;
        }
        case "bits":
          total += PRIMS[m.storage].bytes;
          break;
        case "block": {
          const a = this.membersStaticSize(m.members, seen);
          // both branches of a condition must have the same size
          if (m.condition && a !== this.membersStaticSize(m.else ?? [], seen)) return undefined;
          const c = this.layersSize(a, m.layers);
          if (c === undefined) return undefined;
          total += c;
          break;
        }
        case "switch": {
          const sizes = [
            ...m.cases.map(c => this.membersStaticSize(c.members, seen)),
            ...(m.default ? [this.membersStaticSize(m.default, seen)] : [])
          ];
          if (
            !sizes.length ||
            sizes.some(s => s === undefined) ||
            !sizes.every(s => s === sizes[0])
          )
            return undefined;
          total += sizes[0]!;
          break;
        }
      }
    }
    return total;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function isTypeDecl(
  d: DeclSym | NamespaceSym
): d is StructSym | EnumSym | UnionSym | AliasSym | ExternTypeSym {
  return (
    d.kind === "struct" ||
    d.kind === "enum" ||
    d.kind === "union" ||
    d.kind === "alias" ||
    d.kind === "externType"
  );
}

function intLiteral(n: number): IrExpr {
  return { kind: "literal", value: { kind: "int", value: String(n) }, type: BIGINT };
}

function stringType(unit: 1 | 2 | 4, length: IrLength): IrType {
  const encoding = unit === 1 ? "utf8" : unit === 2 ? "utf16" : "utf32";
  return { kind: "string", unit, encoding, endian: "inherit", length };
}

/**
 * The value type of a declared type with `arrays` suffixes: `char[n]` is a string, `u8[n]` bytes.
 * With `charArrays`, `char names[k][n]` is an array of strings (parameters); otherwise a string.
 */
function suffixedValueType(base: BaseType, arrays: number, charArrays = false): IrValueType {
  if (base.char) return charArrays && arrays > 1 ? { kind: "array", element: STRING } : STRING;
  if (!arrays) return base.value;
  if (base.byte && arrays === 1) return BYTES;
  let t = base.value;
  for (let i = 0; i < arrays; i++) t = { kind: "array", element: t };
  return t;
}

/** An omitted declared `$` argument, replaced by the binding after the requirements analysis. */
function placeholder(): IrExpr {
  return {
    kind: "literal",
    value: { kind: "int", value: "0" },
    type: { kind: "struct", struct: "<hole>" }
  };
}

export function isPlaceholder(e: IrExpr): boolean {
  return e.kind === "literal" && e.type.kind === "struct" && e.type.struct === "<hole>";
}

export function constInt(e: IrExpr): number | undefined {
  if (e.kind === "literal" && e.value.kind === "int") return Number(e.value.value);
  if (e.kind === "convert") return constInt(e.operand);
  return undefined;
}

function widenBound(a: IrValueType, b: IrValueType): IrValueType | undefined {
  if (JSON.stringify(a) === JSON.stringify(b)) return a;
  if (a.kind === "int" && b.kind === "int") {
    return {
      kind: "int",
      bits: Math.max(a.bits, b.bits) as typeof a.bits,
      signed: a.signed || b.signed
    };
  }
  return undefined;
}

function withEncoding(t: IrType, encoding: "utf8" | "ascii" | "latin1"): IrType {
  if (t.kind === "string" && t.unit === 1) return { ...t, encoding };
  return t;
}

function stripArgs(t: IrType): unknown {
  return JSON.parse(
    JSON.stringify(t, (k, v) =>
      k === "args" && Array.isArray(v)
        ? v.filter((a: IrExpr) => !(a.kind === "param" && a.name === "endian"))
        : v
    )
  );
}

function stripSpans(e: unknown): unknown {
  return JSON.parse(
    JSON.stringify(e, (k, v) =>
      k === "span" || k === "opSpan" || k === "argsSpan" || k === "raw"
        ? undefined
        : typeof v === "bigint"
          ? v.toString()
          : v
    )
  );
}

/** Display of a lowered type for instance names: `Point`, `char[4]`, `Blob(16)`. */
function irTypeDisplay(t: IrType, el: Elaborator): string {
  const lenStr = (l: IrLength) =>
    l.kind === "count" ? `[${constInt(l.expr) ?? "?"}]` : l.kind === "until" ? "[until]" : "[]";
  switch (t.kind) {
    case "prim":
      return t.prim + (t.endian === "inherit" ? "" : t.endian);
    case "bool":
      return "bool";
    case "string":
      return (t.unit === 1 ? "char" : t.unit === 2 ? "char16" : "char32") + lenStr(t.length);
    case "bytes":
      return "u8" + lenStr(t.length);
    case "array":
      return irTypeDisplay(t.element, el) + lenStr(t.length);
    case "struct": {
      const base = el.displayName(t.struct);
      const args = t.args.filter(a => !(a.kind === "param" && a.name === "endian"));
      if (!args.length) return base;
      return `${base}(${args.map(a => (a.kind === "literal" ? (a.value.kind === "int" ? a.value.value : JSON.stringify((a.value as { value?: unknown }).value ?? "")) : "?")).join(", ")})`;
    }
    case "enum":
      return el.displayName(t.enum);
    case "pointer":
      return `${irTypeDisplay(t.target, el)}*`;
    case "extern":
      return el.displayName(t.extern);
    case "union":
      return t.variants.map(v => v.name).join("|");
    case "transform":
    case "layered":
      return irTypeDisplay(t.inner, el);
  }
}
