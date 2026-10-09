/**
 * The frontend driver: loads modules (following imports), parses, binds, resolves imports,
 * checks every declaration, and assembles the IR program.
 */
import type * as A from "./ast.ts";
import { DiagnosticBag, removalFix, replaceFix, type Diag, type Fix } from "./diagnostics.ts";
import { Elaborator, type ElaboratorOptions } from "./elaborate.ts";
import { reportHiddenUnderivable } from "./derive.ts";
import { assembleProgram } from "./instances.ts";
import { parse } from "./parser.ts";
import { SourceFile, type Span } from "./source.ts";
import { allDecls, bindModule, type ModuleInfo, type NamespaceSym } from "./symbols.ts";
import type { IrField, IrProgram } from "../ir/index.ts";
import { coreType } from "./types.ts";
import { closest, commonDir, dirname, joinPath, normalizePath, relativePath } from "./util.ts";

interface FrontendHost {
  readFile(path: string): string | undefined;
  fileExists(path: string): boolean;
}

interface ParsedFile {
  text: string;
  file: SourceFile;
  module: A.Module;
  diagnostics: Diag[];
}

/** Parse results by path, reused while the text is unchanged (the language service keeps one). */
export class ParseCache {
  private readonly entries = new Map<string, ParsedFile>();

  get(path: string, text: string): ParsedFile {
    const e = this.entries.get(path);
    if (e && e.text === text) return e;
    const file = new SourceFile(path, text);
    const bag = new DiagnosticBag();
    const { module } = parse(file, bag);
    const parsed: ParsedFile = { text, file, module, diagnostics: bag.items };
    this.entries.set(path, parsed);
    return parsed;
  }

  delete(path: string): void {
    this.entries.delete(path);
  }
}

export interface FrontendOptions extends ElaboratorOptions {
  /** Directory module paths are relative to (default: the common directory of all modules). */
  rootDir?: string;
  parseCache?: ParseCache;
  /** Assemble the IR even if there are errors (for tools); default false. */
  assembleOnError?: boolean;
}

export interface FrontendResult {
  modules: ModuleInfo[];
  /** All diagnostics (syntax and semantic), deduplicated. */
  diagnostics: Diag[];
  program?: IrProgram;
  elaborator: Elaborator;
  hasErrors: boolean;
}

function resolveImportPath(fromFile: string, spec: string, host: FrontendHost): string | undefined {
  const base = joinPath(dirname(fromFile), spec);
  const candidates = /\.[A-Za-z0-9]+$/.test(spec) ? [base] : [base + ".yfl", base];
  for (const c of candidates) if (host.fileExists(c)) return c;
  return undefined;
}

export function runFrontend(
  entries: string[],
  host: FrontendHost,
  options: FrontendOptions = {}
): FrontendResult {
  const diags = new DiagnosticBag();
  const cache = options.parseCache ?? new ParseCache();
  const modules = new Map<string, ModuleInfo>();
  const queue = entries.map(e => normalizePath(e));
  const missing = new Set<string>();

  const load = (path: string): ModuleInfo | undefined => {
    const existing = modules.get(path);
    if (existing) return existing;
    const text = host.readFile(path);
    if (text === undefined) {
      missing.add(path);
      return undefined;
    }
    const parsed = cache.get(path, text);
    for (const d of parsed.diagnostics) diags.add(d);
    const mod: ModuleInfo = {
      path,
      irPath: path,
      irName: path,
      file: parsed.file,
      ast: parsed.module,
      decls: new Map(),
      imports: new Map(),
      namespaces: new Map(),
      importDecls: []
    };
    modules.set(path, mod);
    for (const d of parsed.module.decls) {
      if (d.kind !== "ImportDecl" || !d.source) continue;
      const target = resolveImportPath(path, d.source.value, host);
      if (target) queue.push(target);
    }
    return mod;
  };
  while (queue.length) load(queue.shift()!);
  for (const m of missing) {
    if (entries.map(normalizePath).includes(m)) {
      const f = new SourceFile(m, "");
      diags.report(f, { start: 0, end: 0 }, "import-not-found", `File not found: ${m}`);
    }
  }

  // module paths relative to the root
  const all = [...modules.values()];
  const root = options.rootDir ? normalizePath(options.rootDir) : commonDir(all.map(m => m.path));
  for (const m of all) {
    m.irPath = relativePath(root, m.path);
    m.irName = m.irPath.replace(/\.[^./]+$/, "");
  }

  for (const m of all) bindModule(m, diags);
  for (const m of all) resolveImports(m, modules, host, diags);
  // dependency order (imports before importers; cycles allowed)
  const ordered: ModuleInfo[] = [];
  const state = new Map<ModuleInfo, number>();
  const visit = (m: ModuleInfo) => {
    if (state.has(m)) return;
    state.set(m, 1);
    for (const d of m.importDecls) if (d.target) visit(d.target);
    state.set(m, 2);
    ordered.push(m);
  };
  for (const e of entries) {
    const m = modules.get(normalizePath(e));
    if (m) visit(m);
  }
  for (const m of all) visit(m);

  const el = new Elaborator(ordered, diags, options);
  checkAll(el, ordered);
  let program: IrProgram | undefined;
  const beforeAssembly = diags.hasErrors;
  try {
    program = assembleProgram(el, ordered);
  } catch (err) {
    // erroneous programs may not assemble; their diagnostics already explain why
    if (!beforeAssembly) throw err;
  }
  // unused imports (after everything resolved names)
  for (const m of ordered) reportUnusedImports(m, diags);
  const hasErrors = diags.hasErrors;
  const result: FrontendResult = {
    modules: ordered,
    diagnostics: diags.items,
    elaborator: el,
    hasErrors
  };
  if (program && !hasErrors) result.program = program;
  else if (program && options.assembleOnError) result.program = program;
  return result;
}

function resolveImports(
  m: ModuleInfo,
  modules: Map<string, ModuleInfo>,
  host: FrontendHost,
  diags: DiagnosticBag
): void {
  for (const d of m.ast.decls) {
    if (d.kind !== "ImportDecl") continue;
    const entry: { decl: A.ImportDecl; target?: ModuleInfo } = { decl: d };
    m.importDecls.push(entry);
    if (!d.source) continue;
    const path = resolveImportPath(m.path, d.source.value, host);
    const target = path ? modules.get(path) : undefined;
    if (!target) {
      diags.report(
        m.file,
        d.source.span,
        "import-not-found",
        `Can't find module "${d.source.value}".`,
        { fixes: [removeImportFix(m.file, d.span)] }
      );
      continue;
    }
    entry.target = target;
    if (target === m) {
      diags.report(m.file, d.source.span, "import-not-found", "A module can't import itself.");
      continue;
    }
    if (d.namespace && d.namespace.name) {
      const name = d.namespace.name;
      if (m.decls.has(name) || m.imports.has(name) || m.namespaces.has(name)) {
        diags.report(
          m.file,
          d.namespace.span,
          "duplicate-import",
          `'${name}' is already declared in this module.`
        );
        continue;
      }
      const ns: NamespaceSym = {
        kind: "namespace",
        name,
        module: m,
        nameSpan: d.namespace.span,
        decl: d,
        target,
        used: false
      };
      m.namespaces.set(name, ns);
    }
    for (const spec of d.names ?? []) {
      const name = spec.name.name;
      const local = spec.alias?.name ?? name;
      if (!name) continue;
      const sym = target.decls.get(name);
      if (!sym) {
        const suggestion = closest(name, target.decls.keys());
        diags.report(
          m.file,
          spec.name.span,
          "unknown-import-name",
          `"${d.source.value}" doesn't declare '${name}'.${suggestion ? ` Did you mean '${suggestion}'?` : ""}`,
          suggestion ? { fixes: [replaceFix(m.file, spec.name.span, suggestion)] } : {}
        );
      }
      if (m.decls.has(local) || m.imports.has(local) || m.namespaces.has(local)) {
        const prev = m.decls.get(local) ?? m.imports.get(local)?.spec.name;
        diags.report(
          m.file,
          (spec.alias ?? spec.name).span,
          "duplicate-import",
          `'${local}' is already declared in this module.`,
          prev && "nameSpan" in prev
            ? {
                related: [{ file: m.file, span: prev.nameSpan, message: "declared here" }]
              }
            : {}
        );
        continue;
      }
      m.imports.set(local, { spec, decl: d, ...(sym ? { target: sym } : {}), used: false });
    }
  }
}

function reportUnusedImports(m: ModuleInfo, diags: DiagnosticBag): void {
  for (const d of m.ast.decls) {
    if (d.kind !== "ImportDecl") continue;
    const specs = d.names ?? [];
    const unused = specs.filter(s => {
      const b = m.imports.get(s.alias?.name ?? s.name.name);
      return b && b.decl === d && !b.used && b.target;
    });
    const nsUnused = d.namespace ? m.namespaces.get(d.namespace.name) : undefined;
    if (nsUnused && !nsUnused.used) {
      diags.report(
        m.file,
        d.namespace!.span,
        "unused-import",
        `'${d.namespace!.name}' is never used.`,
        { tags: ["unnecessary"], fixes: [removeImportFix(m.file, d.span)] }
      );
    }
    if (!unused.length) continue;
    const all = unused.length === specs.length;
    for (const s of unused) {
      const fix: Fix = all
        ? removeImportFix(m.file, d.span)
        : removalFix(`Remove '${s.name.name}'`, m.file, specRemovalSpan(m.file, s));
      diags.report(
        m.file,
        s.span,
        "unused-import",
        `'${s.alias?.name ?? s.name.name}' is imported but never used.`,
        { tags: ["unnecessary"], fixes: [fix] }
      );
    }
  }
}

/** Removes an import declaration with its line break. */
function removeImportFix(file: SourceFile, span: Span): Fix {
  let end = span.end;
  if (file.text[end] === "\r") end++;
  if (file.text[end] === "\n") end++;
  return removalFix("Remove the import", file, { start: span.start, end });
}

/** One name of an import list, with its comma. */
function specRemovalSpan(file: SourceFile, s: A.ImportSpec): Span {
  const t = file.text;
  let end = s.span.end;
  let j = end;
  while (t[j] === " ") j++;
  if (t[j] === ",") {
    end = j + 1;
    while (t[end] === " ") end++;
    return { start: s.span.start, end };
  }
  let start = s.span.start;
  let k = start - 1;
  while (k >= 0 && t[k] === " ") k--;
  if (t[k] === ",") start = k;
  return { start, end };
}

/** Checks every declaration of every module (diagnostics + language-service records). */
function checkAll(el: Elaborator, modules: ModuleInfo[]): void {
  for (const m of modules) {
    for (const d of allDecls(m)) {
      switch (d.kind) {
        case "const": {
          const ctx = el.moduleCtx(m);
          el.recordRef(ctx, d.nameSpan, d, true);
          if (d.decl.type) el.lowerBaseType(ctx, d.decl.type);
          el.constValue(d, ctx, d.nameSpan);
          break;
        }
        case "enum":
          el.recordRef(el.moduleCtx(m), d.nameSpan, d, true);
          el.enumInfo(d, true);
          break;
        case "externFn":
        case "codec":
        case "externType":
          el.checkExtern(d);
          break;
        case "alias":
          el.checkAlias(d);
          break;
        case "union":
          el.checkUnion(d);
          break;
        case "struct":
          break;
      }
    }
  }
  for (const m of modules) for (const d of allDecls(m)) if (d.kind === "struct") el.structResult(d);
  // @hidden fields must be derivable; pieces of `from arr[*].piece` streams are
  const pieces = new Set<string>();
  for (const r of el.model.structs.values()) {
    for (const fr of r.fields.values()) {
      const ir = fr.ir as IrField;
      if (ir.kind !== "field" || !ir.from || ir.from.stream.kind !== "each") continue;
      const arr = [...r.fields.values()].find(
        x => x.sym.name === (ir.from!.stream as { array: string }).array
      );
      const t = arr && coreType(arr.type);
      if (!t || t.kind !== "array") continue;
      let e = t.element;
      while (e.kind === "layered" || e.kind === "transform" || e.kind === "pointer")
        e = e.kind === "pointer" ? e.target : e.inner;
      if (e.kind !== "struct") continue;
      const inst = el.instancesById.get(e.struct);
      if (inst) pieces.add(`${el.idOf(inst.sym)}.${ir.from.stream.field}`);
    }
  }
  for (const r of el.model.structs.values()) {
    for (const f of r.hiddenCandidates)
      if (!pieces.has(`${el.idOf(r.sym)}.${f.sym.name}`)) reportHiddenUnderivable(el, f);
  }
  // import specs reference their targets
  for (const m of modules) {
    for (const [, b] of m.imports) if (b.target) el.model.addRef(m, b.spec.name.span, b.target);
  }
}
