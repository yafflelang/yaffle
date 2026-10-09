import type * as A from "../frontend/ast.ts";
import { fixToCodeAction, toApiDiagnostic, sortDiagnostics } from "../frontend/diagnostics.ts";
import { BUILTIN_FUNCTIONS } from "../frontend/expr.ts";
import { formatSource } from "../frontend/format.ts";
import { lex } from "../frontend/lexer.ts";
import { SourceFile } from "../frontend/source.ts";
import type { FieldSym, ModuleInfo, ParamSym, StructSym, Sym } from "../frontend/symbols.ts";
import { displayValueType } from "../frontend/types.ts";
import { normalizePath } from "../frontend/util.ts";
import type {
  CodeAction,
  FormatOptions,
  CodeLens,
  CompletionItem,
  Diagnostic,
  DocumentSymbol,
  FoldingRange,
  Hover,
  InlayHint,
  LanguageService,
  Location,
  Position,
  ProjectConfig,
  ProjectHost,
  Range,
  RootParameter,
  SampleAnnotation,
  SemanticToken,
  SignatureHelp,
  TextEdit,
  WorkspaceEdit,
  WorkspaceSymbol
} from "./api.ts";
import { Workspace, type Analysis } from "./analysis.ts";
import { getCompletions, getSignatureHelp } from "./completion.ts";
import {
  attributeArgHover,
  attributeHover,
  boundHover,
  keywordHover,
  symbolHover
} from "./describe.ts";
import {
  codeLenses,
  documentSymbols,
  dollarOccurrences,
  foldingRanges,
  inlayHints,
  semanticTokens,
  workspaceSymbols
} from "./features.ts";
import { findLast, isExpr, nodePath, type Node } from "./locate.ts";
import { suggestLayoutEdit } from "./layoutSuggest.ts";
import {
  decodeWithSample,
  GeneratedCode,
  loadSample,
  rootParameters,
  sampleOptions
} from "./sample.ts";

export type * from "./api.ts";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

class YaffleLanguageService implements LanguageService {
  private readonly ws: Workspace;
  private readonly code = new GeneratedCode();

  constructor(host: ProjectHost) {
    this.ws = new Workspace(host);
  }

  private an(path: string): { an: Analysis; mod?: ModuleInfo } {
    const an = this.ws.get(path);
    const mod = an.module(path);
    return mod ? { an, mod } : { an };
  }

  updateFile(path: string, text: string): void {
    const p = normalizePath(path);
    if (this.ws.overlays.get(p) === text) return;
    this.ws.overlays.set(p, text);
    this.ws.bump();
  }

  closeFile(path: string): void {
    this.ws.overlays.delete(normalizePath(path));
    this.ws.bump();
  }

  setProject(config: ProjectConfig | undefined, rootDir: string | undefined): void {
    if (config && rootDir) this.ws.project = { config, rootDir: normalizePath(rootDir) };
    else delete this.ws.project;
    this.ws.bump();
  }

  getDiagnostics(path: string): Diagnostic[] {
    const { an } = this.an(path);
    return sortDiagnostics(an.diagnosticsFor(path).map(toApiDiagnostic));
  }

  getHover(path: string, position: Position): Hover | undefined {
    const { mod } = this.an(path);
    if (!mod) return undefined;
    const offset = mod.file.offsetAt(position);
    // the cursor right after a word (hover from the keyboard) also means that word
    const t = mod.file.text;
    const word = /[A-Za-z0-9_]/;
    const after = offset > 0 && word.test(t[offset - 1] ?? "") && !word.test(t[offset] ?? "");
    return (
      this.hoverAt(path, offset) ??
      (after ? this.hoverAt(path, offset - 1) : undefined) ??
      this.keywordHoverAt(mod, offset) ??
      (after ? this.keywordHoverAt(mod, offset - 1) : undefined)
    );
  }

  private keywordHoverAt(mod: ModuleInfo, offset: number): Hover | undefined {
    const line = mod.file.positionAt(offset).line;
    const start = mod.file.lineStarts[line]!;
    const end = mod.file.lineStarts[line + 1] ?? mod.file.text.length;
    const col = offset - start;
    const tok = lex(new SourceFile("/x", mod.file.text.slice(start, end))).tokens.find(
      k => k.kind === "ident" && k.start <= col && col < k.end
    );
    const doc = tok ? keywordHover(tok.value) : undefined;
    if (!tok || !doc) return undefined;
    return {
      contents: doc,
      range: mod.file.rangeOf({ start: start + tok.start, end: start + tok.end })
    };
  }

  private hoverAt(path: string, offset: number): Hover | undefined {
    const { an, mod } = this.an(path);
    if (!mod) return undefined;
    const nodes = nodePath(mod.ast, offset, false);
    const range = (span: { start: number; end: number }): Range => mod.file.rangeOf(span);
    const struct = this.structAt(an, nodes);
    const attr = findLast(nodes, n => n.kind === "Attribute") as A.Attribute | undefined;
    if (attr && offset >= attr.name.span.start && offset < attr.name.span.end) {
      const h = attributeHover(attr.name.name);
      return h ? { contents: h, range: range(attr.name.span) } : undefined;
    }
    // named arguments and words of attributes: `from: file`, `offset: 0x19`, `strict`
    if (attr) {
      for (const a of attr.args ?? []) {
        if (a.name && offset >= a.name.span.start && offset < a.name.span.end) {
          const h = attributeArgHover(attr.name.name, a.name.name);
          if (h) return { contents: h, range: range(a.name.span) };
        }
        const v = a.value;
        if (v.kind === "Name" && offset >= v.span.start && offset < v.span.end) {
          const h = attributeArgHover(attr.name.name, v.name);
          if (h) return { contents: h, range: range(v.span) };
        }
      }
    }
    // $values
    const dollar = findLast(nodes, n => n.kind === "Dollar") as A.DollarExpr | undefined;
    if (dollar) return { contents: boundHover(an, dollar.name, struct), range: range(dollar.span) };
    const fieldDecl = findLast(nodes, n => n.kind === "FieldDecl") as A.FieldDecl | undefined;
    if (
      fieldDecl?.bound &&
      fieldDecl.name &&
      offset >= fieldDecl.name.span.start - 1 &&
      offset <= fieldDecl.name.span.end
    ) {
      const f = an.fieldByDecl.get(fieldDecl);
      if (f) return { contents: symbolHover(an, f, nodes), range: range(fieldDecl.name.span) };
    }
    const ref = an.refAt(path, offset);
    if (ref && offset < ref.span.end)
      return { contents: symbolHover(an, ref.sym, nodes), range: range(ref.span) };
    const name = findLast(nodes, n => n.kind === "Name") as A.NameExpr | undefined;
    if (name && name.name === "null" && !ref) {
      const h = keywordHover("null");
      if (h) return { contents: h, range: range(name.span) };
    }
    if (name && BUILTIN_FUNCTIONS[name.name]) {
      return {
        contents: symbolHover(an, { kind: "builtinFn", name: name.name }, nodes),
        range: range(name.span)
      };
    }
    // a keyword argument of an attribute (`@split(fit)`): the attribute's documentation
    if (attr && name && !ref) {
      const h = attributeHover(attr.name.name);
      if (h) return { contents: h, range: range(name.span) };
    }
    const it = findLast(nodes, n => n.kind === "It");
    if (it) {
      const t = an.el.model.exprTypes.get(it as A.Expr);
      return {
        contents:
          "```yaffle\nit" +
          (t ? `: ${displayValueType(t, an.el.displayName)}` : "") +
          "\n```\n\nThe value of the field this clause belongs to.",
        range: range(it.span)
      };
    }
    // any other expression: its type
    const e = findLast(nodes, n => isExpr(n)) as A.Expr | undefined;
    if (e) {
      const t = an.el.model.exprTypes.get(e);
      if (t && e.kind !== "Error")
        return {
          contents: "```yaffle\n" + displayValueType(t, an.el.displayName) + "\n```",
          range: range(e.span)
        };
    }
    return undefined;
  }

  private structAt(an: Analysis, nodes: readonly Node[]): StructSym | undefined {
    const s = findLast(nodes, n => n.kind === "StructDecl") as A.StructDecl | undefined;
    return s ? an.structByDecl.get(s) : undefined;
  }

  getCompletions(path: string, position: Position): CompletionItem[] {
    const { an } = this.an(path);
    try {
      return getCompletions(an, normalizePath(path), position);
    } catch {
      return [];
    }
  }

  getSignatureHelp(path: string, position: Position): SignatureHelp | undefined {
    const { an } = this.an(path);
    return getSignatureHelp(an, normalizePath(path), position);
  }

  private symbolAt(
    an: Analysis,
    mod: ModuleInfo,
    position: Position
  ): { sym: Sym; span: { start: number; end: number } } | undefined {
    const offset = mod.file.offsetAt(position);
    const ref = an.refAt(mod.path, offset);
    if (ref) return { sym: ref.sym, span: ref.span };
    // `$name` → its binding sites
    const nodes = nodePath(mod.ast, offset, true);
    const dollar = findLast(nodes, n => n.kind === "Dollar") as A.DollarExpr | undefined;
    if (dollar) {
      const sites = an.el.model.bindingSites.get(dollar.name);
      const sym = localBinding(this.structAt(an, nodes), dollar.name) ?? sites?.[0];
      if (sym) return { sym, span: { start: dollar.span.start + 1, end: dollar.span.end } };
    }
    return undefined;
  }

  private declLocation(sym: Sym): Location | undefined {
    if (sym.kind === "builtinType" || sym.kind === "builtinFn") return undefined;
    return { path: sym.module.path, range: sym.module.file.rangeOf(sym.nameSpan) };
  }

  getDefinition(path: string, position: Position): Location[] {
    const { an, mod } = this.an(path);
    if (!mod) return [];
    const offset = mod.file.offsetAt(position);
    const nodes = nodePath(mod.ast, offset, true);
    const dollar = findLast(nodes, n => n.kind === "Dollar") as A.DollarExpr | undefined;
    if (dollar) {
      const local = localBinding(this.structAt(an, nodes), dollar.name);
      const sites = local ? [local] : (an.el.model.bindingSites.get(dollar.name) ?? []);
      return sites.map(s => ({ path: s.module.path, range: s.module.file.rangeOf(s.nameSpan) }));
    }
    // import path → the module
    const imp = findLast(nodes, n => n.kind === "ImportDecl") as A.ImportDecl | undefined;
    if (imp?.source && offset >= imp.source.span.start && offset <= imp.source.span.end) {
      const target = mod.importDecls.find(d => d.decl === imp)?.target;
      if (target)
        return [
          {
            path: target.path,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
          }
        ];
    }
    const s = this.symbolAt(an, mod, position);
    if (!s) return [];
    const loc = this.declLocation(s.sym);
    return loc ? [loc] : [];
  }

  getReferences(path: string, position: Position, includeDeclaration: boolean): Location[] {
    const { an, mod } = this.an(path);
    if (!mod) return [];
    const s = this.symbolAt(an, mod, position);
    if (!s) return [];
    const out: Location[] = [];
    const seen = new Set<string>();
    const add = (p: string, span: { start: number; end: number }) => {
      const m = an.module(p);
      if (!m) return;
      const key = `${p}:${span.start}:${span.end}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ path: p, range: m.file.rangeOf(span) });
    };
    for (const { path: p, ref } of an.referencesTo(s.sym)) {
      if (ref.decl && !includeDeclaration) continue;
      add(p, ref.span);
    }
    if (includeDeclaration && s.sym.kind !== "builtinType" && s.sym.kind !== "builtinFn")
      add(s.sym.module.path, s.sym.nameSpan);
    if ((s.sym.kind === "field" || s.sym.kind === "param") && s.sym.bound) {
      for (const m of an.allModules())
        for (const span of dollarOccurrences(m, s.sym.name)) add(m.path, span);
    }
    return out.sort((a, b) =>
      a.path < b.path
        ? -1
        : a.path > b.path
          ? 1
          : a.range.start.line - b.range.start.line ||
            a.range.start.character - b.range.start.character
    );
  }

  prepareRename(
    path: string,
    position: Position
  ): { range: Range; placeholder: string } | undefined {
    const { an, mod } = this.an(path);
    if (!mod) return undefined;
    const s = this.symbolAt(an, mod, position);
    if (!s || s.sym.kind === "builtinType" || s.sym.kind === "builtinFn") return undefined;
    return { range: mod.file.rangeOf(s.span), placeholder: s.sym.name };
  }

  rename(path: string, position: Position, newName: string): WorkspaceEdit | undefined {
    if (!IDENT.test(newName)) return undefined;
    const { an, mod } = this.an(path);
    if (!mod) return undefined;
    const s = this.symbolAt(an, mod, position);
    if (!s || s.sym.kind === "builtinType" || s.sym.kind === "builtinFn") return undefined;
    const changes: Record<string, TextEdit[]> = {};
    const seen = new Set<string>();
    const add = (p: string, span: { start: number; end: number }) => {
      const m = an.module(p);
      if (!m) return;
      const key = `${p}:${span.start}`;
      if (seen.has(key)) return;
      seen.add(key);
      (changes[p] ??= []).push({ range: m.file.rangeOf(span), newText: newName });
    };
    const target = s.sym;
    add(target.module.path, target.nameSpan);
    for (const { path: p, ref } of an.referencesTo(target)) {
      // uses through an import alias (`import { A as B }`) keep the alias
      const m = an.module(p);
      if (m && m.file.text.slice(ref.span.start, ref.span.end) !== target.name) continue;
      add(p, ref.span);
    }
    if ((target.kind === "field" || target.kind === "param") && target.bound) {
      for (const m of an.allModules())
        for (const span of dollarOccurrences(m, target.name)) add(m.path, span);
    }
    return { changes };
  }

  getDocumentSymbols(path: string): DocumentSymbol[] {
    const { an, mod } = this.an(path);
    return mod ? documentSymbols(an, mod) : [];
  }

  getWorkspaceSymbols(query: string): WorkspaceSymbol[] {
    return workspaceSymbols(this.ws.get(), query);
  }

  getInlayHints(path: string, range: Range): InlayHint[] {
    const { an, mod } = this.an(path);
    return mod ? inlayHints(an, mod, range) : [];
  }

  getCodeLenses(path: string): CodeLens[] {
    const { an, mod } = this.an(path);
    return mod ? codeLenses(an, mod) : [];
  }

  getCodeActions(path: string, range: Range, diagnostics: Diagnostic[]): CodeAction[] {
    const { an } = this.an(path);
    const p = normalizePath(path);
    const out: CodeAction[] = [];
    const seen = new Set<string>();
    const overlaps = (a: Range, b: Range) =>
      !(
        a.end.line < b.start.line ||
        (a.end.line === b.start.line && a.end.character < b.start.character) ||
        b.end.line < a.start.line ||
        (b.end.line === a.start.line && b.end.character < a.start.character)
      );
    const wanted = new Set(
      diagnostics.map(d => `${d.code}:${d.range.start.line}:${d.range.start.character}`)
    );
    for (const d of an.diagnosticsFor(p)) {
      const api = toApiDiagnostic(d);
      const key = `${api.code}:${api.range.start.line}:${api.range.start.character}`;
      if (!overlaps(api.range, range) && !wanted.has(key)) continue;
      for (const f of d.fixes ?? []) {
        const action = fixToCodeAction(f, [d.code]);
        const k = action.title + JSON.stringify(action.edit);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(action);
      }
    }
    return out;
  }

  getSemanticTokens(path: string): SemanticToken[] {
    const { an, mod } = this.an(path);
    return mod ? semanticTokens(an, mod) : [];
  }

  getFoldingRanges(path: string): FoldingRange[] {
    const { mod } = this.an(path);
    return mod ? foldingRanges(mod) : [];
  }

  format(path: string, options?: FormatOptions): TextEdit[] {
    const p = normalizePath(path);
    const text = this.ws.readFile(p);
    if (text === undefined) return [];
    const indent = options
      ? options.insertSpaces
        ? " ".repeat(Math.max(1, Math.min(16, options.tabSize || 2)))
        : "\t"
      : "  ";
    const r = formatSource(text, p, { indent });
    if (!r.formatted || r.text === text) return [];
    const lines = text.split(/\r?\n/);
    const last = lines.length - 1;
    return [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: last, character: lines[last]!.length }
        },
        newText: r.text
      }
    ];
  }

  /**
   * Checks the root for decodeSample/suggestLayout (declared in or imported into `path`); throws
   * user-facing errors.
   */
  private sampleRoot(path: string, root: string): StructSym {
    const { an, mod } = this.an(path);
    const name = path.split(/[\\/]/).pop() ?? path;
    if (!mod) throw new Error(`Can't read ${name}.`);
    const errors = an.diagnosticsFor(path).filter(d => d.severity === "error");
    const local = mod.decls.get(root);
    const s = local ?? mod.imports.get(root)?.target;
    if (!s || s.kind !== "struct") {
      const exported = [...mod.decls.values()]
        .filter(d => d.kind === "struct" && d.exported)
        .map(d => d.name);
      throw new Error(
        `No struct \`${root}\` in ${name}.${exported.length ? ` Exported structs: ${exported.join(", ")}.` : ""}`
      );
    }
    if (s.typeParams.length)
      throw new Error(`\`${root}\` is generic; pick a struct that uses it with concrete types.`);
    if (errors.length)
      throw new Error(
        `${name} has ${errors.length} error${errors.length === 1 ? "" : "s"}; fix ${errors.length === 1 ? "it" : "them"} before decoding a sample.`
      );
    return s;
  }

  async decodeSample(
    path: string,
    root: string,
    bytes: Uint8Array,
    args?: Record<string, unknown>
  ): Promise<SampleAnnotation[]> {
    const sym = this.sampleRoot(path, root);
    const sp = await loadSample(this.ws, this.code, path, sym);
    sampleOptions(sp, args);
    return decodeWithSample(sp, path, bytes, undefined, args);
  }

  getRootParameters(path: string, root: string): RootParameter[] {
    const sym = this.sampleRoot(path, root);
    const { an } = this.an(path);
    return rootParameters(an, sym);
  }

  async suggestLayout(
    path: string,
    root: string,
    bytes: Uint8Array,
    args?: Record<string, unknown>
  ): Promise<WorkspaceEdit | undefined> {
    const sym = this.sampleRoot(path, root);
    const sp = await loadSample(this.ws, this.code, path, sym);
    sampleOptions(sp, args);
    return suggestLayoutEdit(sp, bytes, args);
  }

  filesChanged(paths: string[]): void {
    for (const p of paths) this.ws.cache.delete(normalizePath(p));
    this.ws.bump();
  }

  getProjectFiles(): string[] {
    return this.ws
      .get()
      .allModules()
      .map(m => m.path)
      .sort();
  }

  dispose(): void {
    this.ws.dispose();
    this.code.dispose();
  }
}

/** A struct's own binding of `$name`: a bound field or a declared `$` parameter. */
function localBinding(
  struct: StructSym | undefined,
  name: string
): FieldSym | ParamSym | undefined {
  return (
    struct?.fields.find(f => f.bound && f.name === name) ??
    struct?.params.find(p => p.bound && p.name === name)
  );
}

export function createLanguageService(host: ProjectHost): LanguageService {
  return new YaffleLanguageService(host);
}
