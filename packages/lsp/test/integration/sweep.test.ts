/**
 * Every feature over every PROJECT format, through the real server: requests at every word of every
 * file (hover, completion, definition, highlights, signature help) and every per-file feature
 * (symbols, inlay hints, code lenses, folding, semantic tokens, formatting). Results must be
 * well formed for the document they refer to, and the server must log no errors.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type * as lsp from "vscode-languageserver";
import type { TestServer } from "../harness.ts";
import {
  decodeTokens,
  errorLogs,
  PROJECT,
  inCommentOrString,
  rangeInside,
  startRealServer,
  validRange,
  words,
  WS
} from "./realServer.ts";

let t: TestServer;
const uriOf = new Map<string, string>();
const textOfUri = new Map<string, string>();

beforeAll(async () => {
  t = await startRealServer();
  for (const [name, text] of Object.entries(PROJECT)) {
    const uri = await t.open(`${WS}/${name}`, text);
    uriOf.set(name, uri);
    textOfUri.set(uri, text);
  }
  await t.settle();
});

afterAll(() => t?.dispose());

const files = Object.keys(PROJECT);
const doc = (name: string) => ({ textDocument: { uri: uriOf.get(name)! } });

function expectLocation(l: lsp.Location): void {
  const text = textOfUri.get(l.uri);
  expect(text, `location in an unknown document ${l.uri}`).toBeDefined();
  expect(validRange(text!, l.range), JSON.stringify(l)).toBe(true);
}

describe.each(files)("%s", name => {
  const text = PROJECT[name]!;
  const code = words(text).filter(w => !inCommentOrString(text, w.offset));

  it("hover at every word: well formed, covering the word", async () => {
    let shown = 0;
    for (const w of code) {
      const position = { line: w.position.line, character: w.position.character + 1 };
      const hover = await t.request<lsp.Hover | null>("textDocument/hover", {
        ...doc(name),
        position
      });
      if (!hover) continue;
      shown++;
      const value = (hover.contents as lsp.MarkupContent).value;
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
      if (hover.range) {
        expect(validRange(text, hover.range)).toBe(true);
        expect(
          rangeInside({ start: position, end: position }, hover.range),
          `${w.word} ${JSON.stringify(hover.range)}`
        ).toBe(true);
      }
    }
    // nearly every identifier in code has something to say
    expect(shown / code.length).toBeGreaterThan(0.98);
    expect(errorLogs(t)).toEqual([]);
  });

  it("completion at every word start and end: well formed", async () => {
    let lists = 0;
    for (const w of code) {
      for (const delta of [0, w.word.length]) {
        const position = { line: w.position.line, character: w.position.character + delta };
        const list = await t.request<lsp.CompletionList>("textDocument/completion", {
          ...doc(name),
          position
        });
        expect(list.isIncomplete).toBe(false);
        if (list.items.length) lists++;
        const labels = new Set<string>();
        for (const item of list.items) {
          expect(typeof item.label).toBe("string");
          expect(labels.has(item.label + "|" + item.kind), `duplicate ${item.label}`).toBe(false);
          labels.add(item.label + "|" + item.kind);
          if (item.textEdit && "range" in item.textEdit)
            expect(validRange(text, item.textEdit.range)).toBe(true);
        }
      }
    }
    expect(lists).toBeGreaterThan(0);
    expect(errorLogs(t)).toEqual([]);
  });

  it("definition and highlights at every word: valid locations", async () => {
    let defs = 0;
    for (const w of code) {
      const position = { line: w.position.line, character: w.position.character + 1 };
      const locations = await t.request<lsp.Location[]>("textDocument/definition", {
        ...doc(name),
        position
      });
      for (const l of locations) expectLocation(l);
      if (locations.length) defs++;
      const highlights = await t.request<lsp.DocumentHighlight[]>(
        "textDocument/documentHighlight",
        {
          ...doc(name),
          position
        }
      );
      for (const h of highlights) expect(validRange(text, h.range)).toBe(true);
    }
    expect(defs).toBeGreaterThan(0);
    expect(errorLogs(t)).toEqual([]);
  });

  it("signature help inside every call and attribute argument list", async () => {
    let helped = 0;
    for (let i = text.indexOf("("); i >= 0; i = text.indexOf("(", i + 1)) {
      if (inCommentOrString(text, i)) continue;
      const before = text.slice(0, i + 1).split("\n");
      const position = { line: before.length - 1, character: before[before.length - 1]!.length };
      const help = await t.request<lsp.SignatureHelp | null>("textDocument/signatureHelp", {
        ...doc(name),
        position
      });
      if (!help) continue;
      helped++;
      expect(help.signatures.length).toBeGreaterThan(0);
      expect(help.activeSignature).toBeLessThan(help.signatures.length);
      for (const s of help.signatures) expect(s.label.length).toBeGreaterThan(0);
    }
    if (/\b(offsetof|sizeof|max|min)\(|@\w+\(/.test(text)) expect(helped).toBeGreaterThan(0);
    expect(errorLogs(t)).toEqual([]);
  });

  it("document symbols: nested, selection inside range", async () => {
    const symbols = await t.request<lsp.DocumentSymbol[]>("textDocument/documentSymbol", doc(name));
    expect(symbols.length).toBeGreaterThan(0);
    const visit = (list: lsp.DocumentSymbol[], parent?: lsp.DocumentSymbol) => {
      for (const s of list) {
        expect(validRange(text, s.range)).toBe(true);
        expect(rangeInside(s.selectionRange, s.range)).toBe(true);
        if (parent) expect(rangeInside(s.range, parent.range)).toBe(true);
        visit(s.children ?? [], s);
      }
    };
    visit(symbols);
    // every struct declared in the file is there
    for (const m of text.matchAll(/^(?:export )?struct (\w+)/gm))
      expect(symbols.map(s => s.name)).toContain(m[1]);
  });

  it("inlay hints: inside the document and the requested range", async () => {
    const lines = text.split("\n");
    const range = {
      start: { line: 0, character: 0 },
      end: { line: lines.length - 1, character: 0 }
    };
    const hints = await t.request<lsp.InlayHint[]>("textDocument/inlayHint", {
      ...doc(name),
      range
    });
    for (const h of hints) {
      expect(validRange(text, { start: h.position, end: h.position })).toBe(true);
      expect(String(h.label).length).toBeGreaterThan(0);
    }
    // a narrower range only returns hints inside it
    const half = {
      start: { line: 0, character: 0 },
      end: { line: Math.floor(lines.length / 2), character: 0 }
    };
    const some = await t.request<lsp.InlayHint[]>("textDocument/inlayHint", {
      ...doc(name),
      range: half
    });
    for (const h of some)
      expect(rangeInside({ start: h.position, end: h.position }, half)).toBe(true);
    expect(some.length).toBeLessThanOrEqual(hints.length);
  });

  it("code lenses: valid ranges, LSP locations in command arguments", async () => {
    const lenses = await t.request<lsp.CodeLens[]>("textDocument/codeLens", doc(name));
    for (const l of lenses) {
      expect(validRange(text, l.range)).toBe(true);
      expect(l.command?.title.length).toBeGreaterThan(0);
      if (l.command?.command === "yaffle.showBindingSources") {
        const [arg] = l.command.arguments as [{ uri: string; sources: lsp.Location[] }];
        expect(arg.uri).toBe(uriOf.get(name));
        for (const s of arg.sources) expectLocation(s);
      }
    }
  });

  it("folding ranges: one per multi-line struct at least, all ordered", async () => {
    const ranges = await t.request<lsp.FoldingRange[]>("textDocument/foldingRange", doc(name));
    const lines = text.split("\n").length;
    for (const r of ranges) {
      expect(r.startLine).toBeLessThan(r.endLine);
      expect(r.endLine).toBeLessThan(lines);
    }
    const multiLineStructs = [...text.matchAll(/^(?:export )?struct \w+[^\n]*\{\s*$/gm)].length;
    expect(ranges.length).toBeGreaterThanOrEqual(multiLineStructs);
  });

  it("semantic tokens: ordered, non-overlapping, inside their lines; range ⊆ full", async () => {
    const full = await t.request<lsp.SemanticTokens>("textDocument/semanticTokens/full", doc(name));
    const tokens = decodeTokens(full.data);
    expect(tokens.length).toBeGreaterThan(0);
    const lines = text.split("\n");
    let prevLine = -1;
    let prevEnd = 0;
    for (const tok of tokens) {
      expect(tok.type.startsWith("#")).toBe(false);
      expect(tok.length).toBeGreaterThan(0);
      expect(tok.character + tok.length).toBeLessThanOrEqual(lines[tok.line]!.length);
      if (tok.line === prevLine) expect(tok.character).toBeGreaterThanOrEqual(prevEnd);
      prevLine = tok.line;
      prevEnd = tok.character + tok.length;
    }
    const range = { start: { line: 10, character: 0 }, end: { line: 30, character: 0 } };
    const part = decodeTokens(
      (
        await t.request<lsp.SemanticTokens>("textDocument/semanticTokens/range", {
          ...doc(name),
          range
        })
      ).data
    );
    const key = (x: { line: number; character: number; length: number; type: string }) =>
      `${x.line}:${x.character}:${x.length}:${x.type}`;
    const all = new Set(tokens.map(key));
    for (const p of part) {
      expect(all.has(key(p))).toBe(true);
      expect(p.line >= 10 && p.line <= 30).toBe(true);
    }
  });

  it("formatting leaves the file alone; 4-space formatting is stable", async () => {
    const edits = await t.request<lsp.TextEdit[] | null>("textDocument/formatting", {
      ...doc(name),
      options: { tabSize: 2, insertSpaces: true }
    });
    expect(edits ?? []).toEqual([]);
    const four = await t.request<lsp.TextEdit[]>("textDocument/formatting", {
      ...doc(name),
      options: { tabSize: 4, insertSpaces: true }
    });
    expect(four.length).toBeGreaterThan(0);
    for (const e of four) expect(validRange(text, e.range)).toBe(true);
  });
});

describe("workspace symbols", () => {
  it("lists the declarations of every file, and filters by query", async () => {
    const all = await t.request<lsp.SymbolInformation[]>("workspace/symbol", { query: "" });
    const uris = new Set(all.map(s => s.location.uri));
    for (const name of files) expect(uris.has(uriOf.get(name)!), name).toBe(true);
    for (const s of all) expectLocation(s.location);
    const archive = await t.request<lsp.SymbolInformation[]>("workspace/symbol", {
      query: "Archive"
    });
    expect(archive.map(s => s.name)).toContain("Archive");
    expect(archive.every(s => /a.*r.*c/i.test(s.name))).toBe(true);
  });
});
