/**
 * Conversions between the language service's types (paths, string kinds) and LSP types (URIs,
 * numeric kinds). All functions are total: malformed service results are sanitized rather than
 * forwarded, because some clients (VS Code included) reject a whole response over one bad range.
 */
import {
  CodeActionKind,
  CompletionItemKind,
  DiagnosticSeverity,
  DiagnosticTag,
  FoldingRangeKind,
  InlayHintKind,
  InsertTextFormat,
  MarkupKind,
  SymbolKind
} from "vscode-languageserver";
import type * as lsp from "vscode-languageserver";
import type * as svc from "yaffle/service";
import type { UriMapper } from "./uri.ts";

export interface ConvertContext {
  uris: UriMapper;
  /** The client renders markdown in hovers and documentation. */
  markdown: boolean;
  /** The client supports snippet completions. */
  snippets: boolean;
  /** The client supports `documentChanges` in workspace edits. */
  documentChanges: boolean;
  /** Version of an open document, or null when the document isn't open. */
  versionOf(uri: string): number | null;
}

// ---------------------------------------------------------------------------------------------
// Positions and ranges

function coord(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function toLspPosition(p: svc.Position | undefined): lsp.Position {
  return { line: coord(p?.line), character: coord(p?.character) };
}

function comparePositions(a: lsp.Position, b: lsp.Position): number {
  return a.line - b.line || a.character - b.character;
}

export function toLspRange(r: svc.Range | undefined): lsp.Range {
  const start = toLspPosition(r?.start);
  const end = toLspPosition(r?.end ?? r?.start);
  return comparePositions(start, end) <= 0 ? { start, end } : { start: end, end: start };
}

function rangeContains(outer: lsp.Range, inner: lsp.Range): boolean {
  return (
    comparePositions(outer.start, inner.start) <= 0 && comparePositions(inner.end, outer.end) <= 0
  );
}

function rangeUnion(a: lsp.Range, b: lsp.Range): lsp.Range {
  return {
    start: comparePositions(a.start, b.start) <= 0 ? a.start : b.start,
    end: comparePositions(a.end, b.end) >= 0 ? a.end : b.end
  };
}

export function toLspLocation(location: svc.Location, ctx: ConvertContext): lsp.Location {
  return { uri: ctx.uris.toUri(location.path), range: toLspRange(location.range) };
}

// ---------------------------------------------------------------------------------------------
// Diagnostics

const SEVERITY: Record<svc.Severity, lsp.DiagnosticSeverity> = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  info: DiagnosticSeverity.Information,
  hint: DiagnosticSeverity.Hint
};

const SEVERITY_BACK = Object.fromEntries(
  Object.entries(SEVERITY).map(([name, value]) => [value, name])
) as Record<number, svc.Severity>;

const DIAGNOSTIC_TAG = new Map<unknown, lsp.DiagnosticTag>([
  ["unnecessary", DiagnosticTag.Unnecessary],
  ["deprecated", DiagnosticTag.Deprecated]
]);

export function toLspDiagnostic(d: svc.Diagnostic, ctx: ConvertContext): lsp.Diagnostic {
  const result: lsp.Diagnostic = {
    range: toLspRange(d.range),
    severity: SEVERITY[d.severity] ?? DiagnosticSeverity.Error,
    source: "yaffle",
    message: typeof d.message === "string" && d.message !== "" ? d.message : "(no message)"
  };
  if (typeof d.code === "string" && d.code !== "") result.code = d.code;
  if (Array.isArray(d.related) && d.related.length > 0) {
    result.relatedInformation = d.related
      .filter(r => r && r.location && typeof r.location.path === "string")
      .map(r => ({ location: toLspLocation(r.location, ctx), message: String(r.message ?? "") }));
  }
  if (Array.isArray(d.tags)) {
    const tags = d.tags.flatMap(t => DIAGNOSTIC_TAG.get(t) ?? []);
    if (tags.length > 0) result.tags = tags;
  }
  return result;
}

/** Rebuild a service diagnostic from what the client sends back in a code action context. */
export function fromLspDiagnostic(d: lsp.Diagnostic, path: string): svc.Diagnostic {
  return {
    path,
    range: toLspRange(d.range),
    severity: SEVERITY_BACK[d.severity ?? DiagnosticSeverity.Error] ?? "error",
    code: d.code === undefined ? "" : String(d.code),
    message: messageText(d.message)
  };
}

function messageText(message: string | lsp.MarkupContent | undefined): string {
  if (typeof message === "string") return message;
  return typeof message?.value === "string" ? message.value : "";
}

/** Identity of a diagnostic for matching client-sent diagnostics to published ones. */
export function diagnosticKey(d: {
  range: lsp.Range;
  code?: string | number | undefined;
  message: string | lsp.MarkupContent;
}): string {
  const r = toLspRange(d.range);
  return `${r.start.line}:${r.start.character}-${r.end.line}:${r.end.character}|${String(d.code ?? "")}|${messageText(d.message)}`;
}

// ---------------------------------------------------------------------------------------------
// Markup and snippets

function toMarkup(text: string, ctx: ConvertContext): lsp.MarkupContent {
  return { kind: ctx.markdown ? MarkupKind.Markdown : MarkupKind.PlainText, value: text };
}

/**
 * Turn snippet syntax into the plain text it would insert with all defaults accepted, for
 * clients without snippet support: `${1:name}` → `name`, `${2|le,be|}` → `le`, `$0` → ``.
 */
export function snippetToPlain(snippet: string): string {
  let i = 0;
  const parse = (stopAt: string | undefined): string => {
    let out = "";
    while (i < snippet.length) {
      const c = snippet[i]!;
      if (c === "\\" && i + 1 < snippet.length && "$}\\,|".includes(snippet[i + 1]!)) {
        out += snippet[i + 1];
        i += 2;
        continue;
      }
      if (stopAt !== undefined && stopAt.includes(c)) return out;
      if (c === "$") {
        const next = snippet[i + 1];
        if (next !== undefined && /[0-9A-Za-z_]/.test(next)) {
          i++;
          while (i < snippet.length && /[0-9A-Za-z_]/.test(snippet[i]!)) i++;
          continue;
        }
        if (next === "{") {
          i += 2;
          while (i < snippet.length && /[0-9A-Za-z_]/.test(snippet[i]!)) i++;
          const sep = snippet[i];
          let value = "";
          if (sep === ":") {
            i++;
            value = parse("}");
          } else if (sep === "|") {
            i++;
            const first = parse(",|");
            while (i < snippet.length && snippet[i] !== "|") {
              i++;
              parse(",|");
            }
            i++; // the closing "|"
            value = first;
          } else if (sep === "/") {
            // ${VAR/regex/format/flags}: no default text.
            let slashes = 0;
            while (i < snippet.length && slashes < 3) {
              if (snippet[i] === "\\") i++;
              else if (snippet[i] === "/") slashes++;
              i++;
            }
            while (i < snippet.length && snippet[i] !== "}") i++;
          }
          if (snippet[i] === "}") i++;
          out += value;
          continue;
        }
      }
      out += c;
      i++;
    }
    return out;
  };
  return parse(undefined);
}

// ---------------------------------------------------------------------------------------------
// Completion, hover, signature help

const COMPLETION_KIND: Record<svc.CompletionKind, lsp.CompletionItemKind> = {
  keyword: CompletionItemKind.Keyword,
  struct: CompletionItemKind.Struct,
  enum: CompletionItemKind.Enum,
  enumMember: CompletionItemKind.EnumMember,
  type: CompletionItemKind.Interface,
  primitive: CompletionItemKind.TypeParameter,
  field: CompletionItemKind.Field,
  parameter: CompletionItemKind.Variable,
  bound: CompletionItemKind.Variable,
  builtin: CompletionItemKind.Function,
  function: CompletionItemKind.Function,
  codec: CompletionItemKind.Method,
  const: CompletionItemKind.Constant,
  attribute: CompletionItemKind.Property,
  module: CompletionItemKind.Module,
  snippet: CompletionItemKind.Snippet
};

export function toLspCompletion(item: svc.CompletionItem, ctx: ConvertContext): lsp.CompletionItem {
  const label = typeof item.label === "string" ? item.label : String(item.label);
  const result: lsp.CompletionItem = {
    label,
    kind: COMPLETION_KIND[item.kind] ?? CompletionItemKind.Text
  };
  if (item.detail) result.detail = item.detail;
  if (item.documentation) result.documentation = toMarkup(item.documentation, ctx);
  if (item.sortText) result.sortText = item.sortText;
  let text = item.insertText ?? label;
  const isSnippet = item.insertTextFormat === "snippet";
  if (isSnippet && ctx.snippets) {
    result.insertTextFormat = InsertTextFormat.Snippet;
  } else {
    if (isSnippet) text = snippetToPlain(text);
    result.insertTextFormat = InsertTextFormat.PlainText;
  }
  if (item.range) {
    result.textEdit = { range: toLspRange(item.range), newText: text };
    if (text !== label) result.filterText = label;
  } else if (text !== label) {
    result.insertText = text;
  }
  return result;
}

export function toLspHover(hover: svc.Hover, ctx: ConvertContext): lsp.Hover | null {
  if (typeof hover.contents !== "string" || hover.contents === "") return null;
  const result: lsp.Hover = { contents: toMarkup(hover.contents, ctx) };
  if (hover.range) result.range = toLspRange(hover.range);
  return result;
}

function clampIndex(value: unknown, length: number): number {
  if (length === 0) return 0;
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
  return Math.min(Math.max(n, 0), length - 1);
}

export function toLspSignatureHelp(
  help: svc.SignatureHelp,
  ctx: ConvertContext
): lsp.SignatureHelp | null {
  const signatures = Array.isArray(help.signatures) ? help.signatures : [];
  if (signatures.length === 0) return null;
  const activeSignature = clampIndex(help.activeSignature, signatures.length);
  return {
    signatures: signatures.map((sig, index) => {
      const parameters = (Array.isArray(sig.parameters) ? sig.parameters : []).map(p => {
        const param: lsp.ParameterInformation = { label: p.label };
        if (p.documentation) param.documentation = toMarkup(p.documentation, ctx);
        return param;
      });
      const info: lsp.SignatureInformation = { label: sig.label, parameters };
      if (sig.documentation) info.documentation = toMarkup(sig.documentation, ctx);
      if (index === activeSignature && typeof help.activeParameter === "number") {
        info.activeParameter = Math.max(0, Math.floor(help.activeParameter));
      }
      return info;
    }),
    activeSignature,
    activeParameter: Math.max(0, Math.floor(Number(help.activeParameter) || 0))
  };
}

// ---------------------------------------------------------------------------------------------
// Edits

export function toLspTextEdit(edit: svc.TextEdit): lsp.TextEdit {
  return { range: toLspRange(edit.range), newText: String(edit.newText ?? "") };
}

export function toLspWorkspaceEdit(
  edit: svc.WorkspaceEdit,
  ctx: ConvertContext
): lsp.WorkspaceEdit {
  const entries = Object.entries(edit.changes ?? {}).filter(([, edits]) => Array.isArray(edits));
  if (ctx.documentChanges) {
    return {
      documentChanges: entries.map(([path, edits]) => {
        const uri = ctx.uris.toUri(path);
        return {
          textDocument: { uri, version: ctx.versionOf(uri) },
          edits: edits.map(toLspTextEdit)
        };
      })
    };
  }
  const changes: Record<string, lsp.TextEdit[]> = {};
  for (const [path, edits] of entries) {
    const uri = ctx.uris.toUri(path);
    changes[uri] = [...(changes[uri] ?? []), ...edits.map(toLspTextEdit)];
  }
  return { changes };
}

/** Plain `changes` form (for the custom requests, whose clients apply edits themselves). */
export function toLspChanges(
  edit: svc.WorkspaceEdit,
  ctx: ConvertContext
): { changes: Record<string, lsp.TextEdit[]> } {
  return toLspWorkspaceEdit(edit, { ...ctx, documentChanges: false }) as {
    changes: Record<string, lsp.TextEdit[]>;
  };
}

// ---------------------------------------------------------------------------------------------
// Symbols

const SYMBOL_KIND: Record<svc.SymbolKind, lsp.SymbolKind> = {
  struct: SymbolKind.Struct,
  field: SymbolKind.Field,
  enum: SymbolKind.Enum,
  enumMember: SymbolKind.EnumMember,
  type: SymbolKind.Class,
  extern: SymbolKind.Function,
  const: SymbolKind.Constant,
  union: SymbolKind.Struct,
  module: SymbolKind.Module
};

function symbolKind(kind: svc.SymbolKind): lsp.SymbolKind {
  return SYMBOL_KIND[kind] ?? SymbolKind.Variable;
}

export function toLspDocumentSymbol(symbol: svc.DocumentSymbol): lsp.DocumentSymbol {
  let range = toLspRange(symbol.range);
  const selectionRange = symbol.selectionRange ? toLspRange(symbol.selectionRange) : range;
  // LSP requires selectionRange ⊆ range (VS Code rejects the whole response otherwise).
  if (!rangeContains(range, selectionRange)) range = rangeUnion(range, selectionRange);
  const children = Array.isArray(symbol.children) ? symbol.children.map(toLspDocumentSymbol) : [];
  for (const child of children) {
    if (!rangeContains(range, child.range)) range = rangeUnion(range, child.range);
  }
  const result: lsp.DocumentSymbol = {
    name: symbol.name || "(anonymous)",
    kind: symbolKind(symbol.kind),
    range,
    selectionRange
  };
  if (symbol.detail) result.detail = symbol.detail;
  if (children.length > 0) result.children = children;
  return result;
}

/** Flatten for clients without hierarchical document symbol support. */
export function flattenDocumentSymbols(
  symbols: lsp.DocumentSymbol[],
  uri: string
): lsp.SymbolInformation[] {
  const out: lsp.SymbolInformation[] = [];
  const visit = (list: lsp.DocumentSymbol[], container: string | undefined) => {
    for (const s of list) {
      const info: lsp.SymbolInformation = {
        name: s.name,
        kind: s.kind,
        location: { uri, range: s.range }
      };
      if (container !== undefined) info.containerName = container;
      out.push(info);
      if (s.children) visit(s.children, s.name);
    }
  };
  visit(symbols, undefined);
  return out;
}

export function toLspWorkspaceSymbol(
  symbol: svc.WorkspaceSymbol,
  ctx: ConvertContext
): lsp.SymbolInformation {
  const result: lsp.SymbolInformation = {
    name: symbol.name,
    kind: symbolKind(symbol.kind),
    location: toLspLocation(symbol.location, ctx)
  };
  if (symbol.containerName) result.containerName = symbol.containerName;
  return result;
}

// ---------------------------------------------------------------------------------------------
// Inlay hints, code lenses, folding, code actions

export function toLspInlayHint(hint: svc.InlayHint, ctx: ConvertContext): lsp.InlayHint {
  const result: lsp.InlayHint = {
    position: toLspPosition(hint.position),
    label: String(hint.label)
  };
  if (hint.kind === "type") result.kind = InlayHintKind.Type;
  else if (hint.kind === "parameter") result.kind = InlayHintKind.Parameter;
  if (hint.tooltip) result.tooltip = toMarkup(hint.tooltip, ctx);
  if (hint.paddingLeft !== undefined) result.paddingLeft = hint.paddingLeft;
  if (hint.paddingRight !== undefined) result.paddingRight = hint.paddingRight;
  return result;
}

function isServiceLocation(value: unknown): value is svc.Location {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.path === "string" && typeof v.range === "object" && v.range !== null && !("uri" in v)
  );
}

/** Convert service `{ path, range }` locations inside command arguments to LSP locations. */
export function convertCommandArguments(value: unknown, ctx: ConvertContext, depth = 0): unknown {
  if (depth > 6) return value;
  if (isServiceLocation(value)) return toLspLocation(value, ctx);
  if (Array.isArray(value)) return value.map(v => convertCommandArguments(v, ctx, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = convertCommandArguments(v, ctx, depth + 1);
    return out;
  }
  return value;
}

export function toLspCodeLens(lens: svc.CodeLens, ctx: ConvertContext): lsp.CodeLens {
  const command: lsp.Command = { title: String(lens.title ?? ""), command: lens.command?.id ?? "" };
  if (lens.command?.arguments !== undefined) {
    command.arguments = convertCommandArguments(lens.command.arguments, ctx) as unknown[];
  }
  return { range: toLspRange(lens.range), command };
}

const FOLDING_KIND: Record<string, string> = {
  comment: FoldingRangeKind.Comment,
  imports: FoldingRangeKind.Imports,
  region: FoldingRangeKind.Region
};

export function toLspFoldingRange(range: svc.FoldingRange): lsp.FoldingRange | undefined {
  const startLine = coord(range.startLine);
  const endLine = coord(range.endLine);
  if (endLine <= startLine) return undefined;
  const result: lsp.FoldingRange = { startLine, endLine };
  const kind = range.kind ? FOLDING_KIND[range.kind] : undefined;
  if (kind) result.kind = kind;
  return result;
}

const CODE_ACTION_KIND: Record<svc.CodeAction["kind"], string> = {
  quickfix: CodeActionKind.QuickFix,
  refactor: CodeActionKind.Refactor,
  source: CodeActionKind.Source
};

/** Whether `kind` is selected by the client's `only` filter (prefix match on dot segments). */
export function kindMatches(kind: string, only: string[] | undefined): boolean {
  if (!only || only.length === 0) return true;
  return only.some(o => kind === o || kind.startsWith(o + "."));
}

export function toLspCodeAction(
  action: svc.CodeAction,
  contextDiagnostics: lsp.Diagnostic[],
  ctx: ConvertContext
): lsp.CodeAction {
  const result: lsp.CodeAction = {
    title: action.title,
    kind: CODE_ACTION_KIND[action.kind] ?? CodeActionKind.QuickFix,
    edit: toLspWorkspaceEdit(action.edit ?? { changes: {} }, ctx)
  };
  if (action.diagnosticCodes && action.diagnosticCodes.length > 0) {
    const codes = new Set(action.diagnosticCodes);
    const matched = contextDiagnostics.filter(
      d => d.code !== undefined && codes.has(String(d.code))
    );
    if (matched.length > 0) result.diagnostics = matched;
  }
  if (action.isPreferred) result.isPreferred = true;
  return result;
}
