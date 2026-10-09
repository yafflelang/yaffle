/**
 * Integration-test support: the language server running on the real compiler (the real
 * `createLanguageService`, `compile` and `loadProjectConfig`), over the in-memory transport of
 * the test harness, with the project of project.ts in an in-memory workspace (`/ws/project`, with
 * its own yaffle.json).
 */
import type * as lsp from "vscode-languageserver";
import { compile, createLanguageService, loadProjectConfig } from "yaffle";
import { TOKEN_TYPES } from "../../src/semanticTokens.ts";
import { startTestServer, type TestServer, type TestServerOptions } from "../harness.ts";
import { PROJECT, PROJECT_CONFIG } from "./project.ts";

export { PROJECT, PROJECT_CONFIG };

export const WS = "/ws/project";

/** The project's files under `WS`, plus `extra` (path → text). */
export function projectFiles(extra: Record<string, string> = {}): Record<string, string> {
  const files: Record<string, string> = { [`${WS}/yaffle.json`]: PROJECT_CONFIG };
  for (const [name, text] of Object.entries(PROJECT)) files[`${WS}/${name}`] = text;
  for (const [path, text] of Object.entries(extra)) files[path] = text;
  return files;
}

/** Start the server on the real compiler. */
export async function startRealServer(options: TestServerOptions = {}): Promise<TestServer> {
  return startTestServer({
    files: projectFiles(),
    workspaceFolders: [WS],
    delay: 5,
    ...options,
    serverOptions: {
      createService: host => createLanguageService(host),
      compile: (entries, host) => compile(entries, host),
      loadProjectConfig: (path, host) => loadProjectConfig(path, host),
      ...options.serverOptions
    }
  });
}

/** Errors the server logged (service exceptions are logged, not thrown). */
export function errorLogs(t: TestServer): string[] {
  return t.logs.filter(l => l.type === 1).map(l => l.message);
}

// ── positions and edits ────────────────────────────────────────────────────────────────────

export function positionAt(text: string, offset: number): lsp.Position {
  const before = text.slice(0, offset);
  const line = before.split("\n").length - 1;
  return { line, character: offset - (before.lastIndexOf("\n") + 1) };
}

export function offsetAt(text: string, p: lsp.Position): number {
  const lines = text.split("\n");
  let o = 0;
  for (let i = 0; i < p.line && i < lines.length; i++) o += lines[i]!.length + 1;
  return o + p.character;
}

/**
 * The position of the `occurrence`-th match of `needle` (0-based), `delta` characters into it.
 * `needle` may contain a `|` marking the position (removed before searching).
 */
export function find(text: string, needle: string, occurrence = 0, delta = 0): lsp.Position {
  const bar = needle.indexOf("|");
  const plain = bar >= 0 ? needle.slice(0, bar) + needle.slice(bar + 1) : needle;
  let at = -1;
  for (let i = 0; i <= occurrence; i++) {
    at = text.indexOf(plain, at + 1);
    if (at < 0) throw new Error(`'${plain}' (#${occurrence}) not found`);
  }
  return positionAt(text, at + (bar >= 0 ? bar : delta));
}

export function applyEdits(text: string, edits: lsp.TextEdit[]): string {
  const sorted = [...edits].sort(
    (a, b) => offsetAt(text, b.range.start) - offsetAt(text, a.range.start)
  );
  let out = text;
  for (const e of sorted) {
    out =
      out.slice(0, offsetAt(out, e.range.start)) +
      e.newText +
      out.slice(offsetAt(out, e.range.end));
  }
  return out;
}

/** The edits per URI of a workspace edit (either form). */
export function editsByUri(edit: lsp.WorkspaceEdit): Map<string, lsp.TextEdit[]> {
  const out = new Map<string, lsp.TextEdit[]>();
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) out.set(uri, [...edits]);
  for (const dc of edit.documentChanges ?? []) {
    if (!("textDocument" in dc)) continue;
    const list = out.get(dc.textDocument.uri) ?? [];
    for (const e of dc.edits) if ("newText" in e) list.push(e);
    out.set(dc.textDocument.uri, list);
  }
  return out;
}

// ── semantic tokens ─────────────────────────────────────────────────────────────────────────

export interface DecodedToken {
  line: number;
  character: number;
  length: number;
  type: string;
  modifiers: number;
}

export function decodeTokens(data: number[]): DecodedToken[] {
  const out: DecodedToken[] = [];
  let line = 0;
  let character = 0;
  for (let i = 0; i + 4 < data.length + 1; i += 5) {
    const dl = data[i]!;
    line += dl;
    character = dl ? data[i + 1]! : character + data[i + 1]!;
    out.push({
      line,
      character,
      length: data[i + 2]!,
      type: TOKEN_TYPES[data[i + 3]!] ?? `#${data[i + 3]}`,
      modifiers: data[i + 4]!
    });
  }
  return out;
}

/** Every identifier-ish word in the text with its position (for sweeping requests). */
export function words(text: string): { word: string; position: lsp.Position; offset: number }[] {
  const out: { word: string; position: lsp.Position; offset: number }[] = [];
  const re = /[$@]?[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)))
    out.push({ word: m[0], position: positionAt(text, m.index), offset: m.index });
  return out;
}

/** Whether an offset is inside a `//` or `/* … *\/` comment or a string (approximation). */
export function inCommentOrString(text: string, offset: number): boolean {
  let i = 0;
  while (i < offset) {
    const c = text[i]!;
    if (c === "/" && text[i + 1] === "/") {
      const e = text.indexOf("\n", i);
      if (e < 0 || e >= offset) return true;
      i = e;
    } else if (c === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      if (e < 0 || e + 2 > offset) return true;
      i = e + 2;
    } else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"' && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      if (j >= offset) return true;
      i = j + 1;
    } else i++;
  }
  return false;
}

export function rangeInside(r: lsp.Range, outer: lsp.Range): boolean {
  const le = (a: lsp.Position, b: lsp.Position) =>
    a.line < b.line || (a.line === b.line && a.character <= b.character);
  return le(outer.start, r.start) && le(r.end, outer.end);
}

/** A range is well formed for the text: ordered, inside the document. */
export function validRange(text: string, r: lsp.Range): boolean {
  const lines = text.split("\n");
  const ok = (p: lsp.Position) =>
    p.line >= 0 &&
    p.line < lines.length &&
    p.character >= 0 &&
    p.character <= lines[p.line]!.length;
  const ordered =
    r.start.line < r.end.line ||
    (r.start.line === r.end.line && r.start.character <= r.end.character);
  return ok(r.start) && ok(r.end) && ordered;
}
