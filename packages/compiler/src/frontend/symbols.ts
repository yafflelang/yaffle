/**
 * Symbols and the binder: modules, declarations, lexical scopes, imports, and the flattened field
 * list of every struct (blocks, branches, cases and bitfields flatten into their struct).
 */
import type * as A from "./ast.ts";
import type { DiagnosticBag } from "./diagnostics.ts";
import type { SourceFile, Span } from "./source.ts";
import type { IrType, IrValueType } from "../ir/index.ts";

export interface ModuleInfo {
  /** Absolute path. */
  path: string;
  /** Project-relative path with forward slashes ("formats/demo/archive.yfl"). */
  irPath: string;
  /** irPath without extension. */
  irName: string;
  file: SourceFile;
  ast: A.Module;
  /** Top-level declarations by name. */
  decls: Map<string, DeclSym>;
  /** Imported names (`import { a as b }` → "b"). */
  imports: Map<string, ImportBinding>;
  /** `import * as ns`. */
  namespaces: Map<string, NamespaceSym>;
  /** Resolved import declarations. */
  importDecls: { decl: A.ImportDecl; target?: ModuleInfo }[];
}

interface ImportBinding {
  spec: A.ImportSpec;
  decl: A.ImportDecl;
  target?: DeclSym;
  used: boolean;
}

export type DeclSym =
  StructSym | EnumSym | UnionSym | AliasSym | ExternFnSym | CodecSym | ExternTypeSym | ConstSym;

export type Sym =
  | DeclSym
  | EnumMemberSym
  | FieldSym
  | ParamSym
  | TypeParamSym
  | NamespaceSym
  | BuiltinTypeSym
  | BuiltinFnSym
  | LambdaParamSym;

interface SymBase {
  name: string;
  module: ModuleInfo;
  /** The span of the declaring identifier. */
  nameSpan: Span;
  doc?: string;
}

export interface StructSym extends SymBase {
  kind: "struct";
  decl: A.StructDecl;
  parent?: StructSym;
  /** Qualified name inside the module: "Chunk.Record". */
  qualified: string;
  /** Nested declarations. */
  nested: Map<string, DeclSym>;
  typeParams: TypeParamSym[];
  params: ParamSym[];
  /** All fields in declaration order (flattened). */
  fields: FieldSym[];
  /** Fields by name; a name declared in alternative branches has several entries. */
  fieldsByName: Map<string, FieldSym[]>;
  exported: boolean;
}

export interface EnumSym extends SymBase {
  kind: "enum";
  decl: A.EnumDecl;
  parent?: StructSym;
  qualified: string;
  members: EnumMemberSym[];
  exported: boolean;
}

export interface EnumMemberSym extends SymBase {
  kind: "enumMember";
  decl: A.EnumMember;
  owner: EnumSym;
  /** Filled by the checker. */
  value?: bigint;
}

export interface UnionSym extends SymBase {
  kind: "union";
  decl: A.UnionDecl;
  parent?: StructSym;
  qualified: string;
  typeParams: TypeParamSym[];
  params: ParamSym[];
  exported: boolean;
}

export interface AliasSym extends SymBase {
  kind: "alias";
  decl: A.TypeAliasDecl;
  typeParams: TypeParamSym[];
  params: ParamSym[];
  exported: boolean;
}

export interface ExternFnSym extends SymBase {
  kind: "externFn";
  decl: A.ExternFnDecl;
  params: ParamSym[];
  exported: boolean;
}

export interface CodecSym extends SymBase {
  kind: "codec";
  decl: A.ExternCodecDecl;
  params: ParamSym[];
  exported: boolean;
}

export interface ExternTypeSym extends SymBase {
  kind: "externType";
  decl: A.ExternTypeDecl;
  params: ParamSym[];
  exported: boolean;
}

export interface ConstSym extends SymBase {
  kind: "const";
  decl: A.ConstDecl;
  exported: boolean;
}

export interface CondFrame {
  member: A.IfMember | A.SwitchMember;
  /** if: 0 = then, 1 = else; switch: case index. */
  branch: number;
}

export interface FieldSym extends SymBase {
  kind: "field";
  decl: A.FieldDecl;
  owner: StructSym;
  /** Declaration order within the owner (pre-order over the member tree). */
  order: number;
  /** Enclosing conditional branches, outermost first. */
  frames: CondFrame[];
  /** Declared inside a `bits` block or a C-style bitfield run. */
  bitfield: boolean;
  /** `u32 $version` */
  bound: boolean;
  /** Filled by the checker. */
  irType?: IrType;
  valueType?: IrValueType;
}

export interface ParamSym extends SymBase {
  kind: "param";
  decl: A.ParamDecl;
  owner: StructSym | UnionSym | AliasSym | ExternFnSym | CodecSym | ExternTypeSym;
  index: number;
  bound: boolean;
  valueType?: IrValueType;
}

export interface TypeParamSym extends SymBase {
  kind: "typeParam";
  ident: A.Ident;
  owner: StructSym | UnionSym | AliasSym;
  index: number;
}

export interface NamespaceSym extends SymBase {
  kind: "namespace";
  decl: A.ImportDecl;
  target?: ModuleInfo;
  used: boolean;
}

interface BuiltinTypeSym {
  kind: "builtinType";
  name: string;
}

interface BuiltinFnSym {
  kind: "builtinFn";
  name: string;
}

export interface LambdaParamSym {
  kind: "lambdaParam";
  name: string;
  nameSpan: Span;
  module: ModuleInfo;
  /** What the parameter stands for, for hovers ("element of records"). Fill functions: unset. */
  detail?: string;
  type?: IrValueType;
}

// ─────────────────────────────────────────────────────────────────────────────
// Binder
// ─────────────────────────────────────────────────────────────────────────────

/** Words that can't name declarations (types, constants, externs). */
const RESERVED_TYPE_NAMES = new Set([
  "struct",
  "enum",
  "union",
  "type",
  "extern",
  "import",
  "export",
  "const",
  "if",
  "else",
  "switch",
  "case",
  "default",
  "layout",
  "bits",
  "this",
  "at",
  "from",
  "as",
  "in",
  "where",
  "until",
  "true",
  "false",
  "it",
  "le",
  "be",
  "virtual",
  "null"
]);

/** Words that are literals in expressions, so a field with that name could never be read. */
const RESERVED_VALUE_NAMES = new Set(["it", "true", "false", "le", "be", "this", "null"]);

function checkReserved(
  mod: ModuleInfo,
  id: A.Ident,
  set: Set<string>,
  what: string,
  diags: DiagnosticBag
): void {
  if (id.name && set.has(id.name)) {
    diags.report(
      mod.file,
      id.span,
      "reserved-word",
      `'${id.name}' is a keyword and can't be used as a ${what} name.`
    );
  }
}

function reportDuplicate(
  diags: DiagnosticBag,
  mod: ModuleInfo,
  span: Span,
  code: "duplicate-declaration" | "duplicate-enum-member" | "duplicate-param" | "duplicate-field",
  message: string,
  first: Span,
  firstMessage = "first declared here"
): void {
  diags.report(mod.file, span, code, message, {
    related: [{ file: mod.file, span: first, message: firstMessage }]
  });
}

/** Creates symbols for a module's declarations (imports are resolved separately). */
export function bindModule(mod: ModuleInfo, diags: DiagnosticBag): void {
  for (const d of mod.ast.decls) {
    if (d.kind === "ImportDecl") continue;
    checkReserved(
      mod,
      d.name,
      RESERVED_TYPE_NAMES,
      d.kind === "ConstDecl" ? "constant" : "declaration",
      diags
    );
    if ("typeParams" in d)
      for (const tp of d.typeParams)
        checkReserved(mod, tp, RESERVED_TYPE_NAMES, "type parameter", diags);
    const sym = createDeclSym(d, mod, undefined, diags);
    if (!sym || !d.name.name) continue;
    const existing = mod.decls.get(d.name.name);
    if (existing) {
      reportDuplicate(
        diags,
        mod,
        d.name.span,
        "duplicate-declaration",
        `'${d.name.name}' is already declared in this module.`,
        existing.nameSpan
      );
      continue;
    }
    mod.decls.set(d.name.name, sym);
  }
}

function createDeclSym(
  d: Exclude<A.Decl, A.ImportDecl> | A.StructDecl | A.EnumDecl | A.UnionDecl,
  mod: ModuleInfo,
  parent: StructSym | undefined,
  diags: DiagnosticBag
): DeclSym | undefined {
  const base = {
    name: d.name.name,
    module: mod,
    nameSpan: d.name.span,
    ...(d.doc ? { doc: d.doc } : {}),
    exported: d.exported
  };
  const qualified = parent ? `${parent.qualified}.${d.name.name}` : d.name.name;
  switch (d.kind) {
    case "StructDecl": {
      const sym: StructSym = {
        kind: "struct",
        ...base,
        decl: d,
        qualified,
        nested: new Map(),
        typeParams: [],
        params: [],
        fields: [],
        fieldsByName: new Map(),
        ...(parent ? { parent } : {})
      };
      bindGenericParams(sym, d, mod, diags);
      bindStructBody(sym, diags);
      return sym;
    }
    case "EnumDecl": {
      const sym: EnumSym = {
        kind: "enum",
        ...base,
        decl: d,
        qualified,
        members: [],
        ...(parent ? { parent } : {})
      };
      const seen = new Map<string, EnumMemberSym>();
      for (const m of d.members) {
        const prev = seen.get(m.name.name);
        if (prev) {
          reportDuplicate(
            diags,
            mod,
            m.name.span,
            "duplicate-enum-member",
            `Enum member '${m.name.name}' is declared twice.`,
            prev.nameSpan
          );
          continue;
        }
        const ms: EnumMemberSym = {
          kind: "enumMember",
          name: m.name.name,
          module: mod,
          nameSpan: m.name.span,
          decl: m,
          owner: sym,
          ...(m.doc ? { doc: m.doc } : {})
        };
        seen.set(m.name.name, ms);
        sym.members.push(ms);
      }
      return sym;
    }
    case "UnionDecl": {
      const sym: UnionSym = {
        kind: "union",
        ...base,
        decl: d,
        qualified,
        typeParams: [],
        params: [],
        ...(parent ? { parent } : {})
      };
      bindGenericParams(sym, d, mod, diags);
      return sym;
    }
    case "TypeAliasDecl": {
      const sym: AliasSym = { kind: "alias", ...base, decl: d, typeParams: [], params: [] };
      bindGenericParams(sym, d, mod, diags);
      return sym;
    }
    case "ExternFnDecl": {
      const sym: ExternFnSym = { kind: "externFn", ...base, decl: d, params: [] };
      sym.params = bindParams(d.params, sym, mod, diags);
      return sym;
    }
    case "ExternCodecDecl": {
      const sym: CodecSym = { kind: "codec", ...base, decl: d, params: [] };
      sym.params = bindParams(d.params, sym, mod, diags);
      return sym;
    }
    case "ExternTypeDecl": {
      const sym: ExternTypeSym = { kind: "externType", ...base, decl: d, params: [] };
      sym.params = bindParams(d.params, sym, mod, diags);
      return sym;
    }
    case "ConstDecl":
      return { kind: "const", ...base, decl: d };
  }
}

/** Type parameters and value parameters of a struct, union or alias. */
function bindGenericParams(
  sym: StructSym | UnionSym | AliasSym,
  d: { typeParams: A.Ident[]; params?: A.ParamDecl[] | undefined },
  mod: ModuleInfo,
  diags: DiagnosticBag
): void {
  sym.typeParams = d.typeParams.map((tp, index) => ({
    kind: "typeParam",
    name: tp.name,
    module: mod,
    nameSpan: tp.span,
    ident: tp,
    owner: sym,
    index
  }));
  sym.params = bindParams(d.params ?? [], sym, mod, diags);
}

function bindParams(
  params: A.ParamDecl[],
  owner: ParamSym["owner"],
  mod: ModuleInfo,
  diags: DiagnosticBag
): ParamSym[] {
  const seen = new Map<string, ParamSym>();
  return params.map((p, index) => {
    const ps: ParamSym = {
      kind: "param",
      name: p.name.name,
      module: mod,
      nameSpan: p.name.span,
      decl: p,
      owner,
      index,
      bound: p.bound
    };
    if (p.name.name) {
      const prev = seen.get(p.name.name);
      if (prev)
        reportDuplicate(
          diags,
          mod,
          p.name.span,
          "duplicate-param",
          `Parameter '${p.name.name}' is declared twice.`,
          prev.nameSpan
        );
      else seen.set(p.name.name, ps);
    }
    return ps;
  });
}

/** Binds a struct's fields (flattened through blocks, branches, cases and bits) and nested declarations. */
function bindStructBody(sym: StructSym, diags: DiagnosticBag): void {
  const mod = sym.module;
  let order = 0;
  const addField = (f: A.FieldDecl, frames: CondFrame[], inBits: boolean) => {
    if (f.name) checkReserved(mod, f.name, RESERVED_VALUE_NAMES, "field", diags);
    const fs: FieldSym = {
      kind: "field",
      name: f.name?.name ?? "",
      module: mod,
      nameSpan: f.name?.span ?? { start: f.type.span.end, end: f.type.span.end },
      decl: f,
      owner: sym,
      order: order++,
      frames,
      bitfield: inBits || (!!f.bitWidth && !f.pointer),
      bound: f.bound,
      ...(f.doc ? { doc: f.doc } : {})
    };
    sym.fields.push(fs);
    if (!fs.name) return;
    const list = sym.fieldsByName.get(fs.name);
    if (!list) {
      sym.fieldsByName.set(fs.name, [fs]);
      return;
    }
    // the same name is allowed only in mutually exclusive branches
    const clash = list.find(o => !exclusive(o.frames, frames));
    if (clash)
      reportDuplicate(
        diags,
        mod,
        fs.nameSpan,
        "duplicate-field",
        `Field '${fs.name}' is already declared in '${sym.name}'.`,
        clash.nameSpan
      );
    list.push(fs);
  };
  const visit = (members: A.Member[], frames: CondFrame[]) => {
    for (const m of members) {
      switch (m.kind) {
        case "FieldDecl":
          addField(m, frames, false);
          break;
        case "BitsMember":
          for (const f of m.fields) addField(f, frames, true);
          break;
        case "BlockMember":
          visit(m.members, frames);
          break;
        case "IfMember":
          visit(m.then, [...frames, { member: m, branch: 0 }]);
          if (m.else) visit(m.else, [...frames, { member: m, branch: 1 }]);
          break;
        case "SwitchMember":
          m.cases.forEach((c, i) => visit(c.members, [...frames, { member: m, branch: i }]));
          break;
        case "StructDecl":
        case "EnumDecl":
        case "UnionDecl": {
          checkReserved(mod, m.name, RESERVED_TYPE_NAMES, "declaration", diags);
          const nested = createDeclSym(m, mod, sym, diags);
          if (!nested || !m.name.name) break;
          const prev = sym.nested.get(m.name.name);
          if (prev)
            reportDuplicate(
              diags,
              mod,
              m.name.span,
              "duplicate-declaration",
              `'${m.name.name}' is already declared in this struct.`,
              prev.nameSpan
            );
          else sym.nested.set(m.name.name, nested);
          break;
        }
        case "LayoutMember":
          break;
      }
    }
  };
  visit(sym.decl.members, []);
  for (const p of sym.params) {
    const clash = sym.fieldsByName.get(p.name)?.[0];
    if (clash)
      reportDuplicate(
        diags,
        mod,
        clash.nameSpan,
        "duplicate-declaration",
        `'${p.name}' is both a parameter and a field of '${sym.name}'.`,
        p.nameSpan,
        "parameter declared here"
      );
  }
}

/** True if two frame paths are in different branches of a shared if/switch. */
export function exclusive(a: CondFrame[], b: CondFrame[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i]!.member !== b[i]!.member) return false;
    if (a[i]!.branch !== b[i]!.branch) return true;
  }
  return false;
}

/** All declaration symbols of a module, including nested ones. */
export function allDecls(mod: ModuleInfo): DeclSym[] {
  const out: DeclSym[] = [];
  const visit = (d: DeclSym) => {
    out.push(d);
    if (d.kind === "struct") for (const n of d.nested.values()) visit(n);
  };
  for (const d of mod.decls.values()) visit(d);
  return out;
}
