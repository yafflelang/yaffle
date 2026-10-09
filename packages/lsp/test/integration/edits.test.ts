/**
 * Synthetic edit sequences against the real server: typing a struct keystroke by keystroke,
 * random edits to every PROJECT format, edits that break and repair other files, and semantic token
 * deltas. After every step every feature must answer with results that fit the current text, and
 * nothing may be logged as an error.
 */
import { afterEach, describe, expect, it } from "vitest";
import type * as lsp from "vscode-languageserver";
import type { TestServer } from "../harness.ts";
import {
  decodeTokens,
  errorLogs,
  find,
  PROJECT,
  offsetAt,
  positionAt,
  startRealServer,
  validRange,
  WS
} from "./realServer.ts";

let t: TestServer;
afterEach(() => t?.dispose());

/** Every position-based and document feature at `position`; checks results against `text`. */
async function probe(uri: string, text: string, position: lsp.Position): Promise<void> {
  const doc = { textDocument: { uri } };
  const lines = text.split("\n");
  const whole = {
    start: { line: 0, character: 0 },
    end: { line: lines.length - 1, character: lines.at(-1)!.length }
  };
  const hover = await t.request<lsp.Hover | null>("textDocument/hover", { ...doc, position });
  if (hover?.range) expect(validRange(text, hover.range), JSON.stringify(hover.range)).toBe(true);
  const completion = await t.request<lsp.CompletionList>("textDocument/completion", {
    ...doc,
    position
  });
  for (const i of completion.items)
    if (i.textEdit && "range" in i.textEdit) expect(validRange(text, i.textEdit.range)).toBe(true);
  await t.request("textDocument/signatureHelp", { ...doc, position });
  for (const l of await t.request<lsp.Location[]>("textDocument/definition", { ...doc, position }))
    if (l.uri === uri) expect(validRange(text, l.range)).toBe(true);
  for (const h of await t.request<lsp.DocumentHighlight[]>("textDocument/documentHighlight", {
    ...doc,
    position
  }))
    expect(validRange(text, h.range)).toBe(true);
  const symbols = await t.request<lsp.DocumentSymbol[]>("textDocument/documentSymbol", doc);
  const visit = (list: lsp.DocumentSymbol[]) => {
    for (const s of list) {
      expect(validRange(text, s.range)).toBe(true);
      visit(s.children ?? []);
    }
  };
  visit(symbols);
  for (const h of await t.request<lsp.InlayHint[]>("textDocument/inlayHint", {
    ...doc,
    range: whole
  }))
    expect(validRange(text, { start: h.position, end: h.position })).toBe(true);
  for (const l of await t.request<lsp.CodeLens[]>("textDocument/codeLens", doc))
    expect(validRange(text, l.range)).toBe(true);
  for (const r of await t.request<lsp.FoldingRange[]>("textDocument/foldingRange", doc)) {
    expect(r.startLine).toBeLessThan(r.endLine);
    expect(r.endLine).toBeLessThan(lines.length);
  }
  const tokens = decodeTokens(
    (await t.request<lsp.SemanticTokens>("textDocument/semanticTokens/full", doc)).data
  );
  for (const tok of tokens)
    expect(tok.character + tok.length).toBeLessThanOrEqual(lines[tok.line]?.length ?? -1);
  await t.request("textDocument/codeAction", {
    ...doc,
    range: { start: position, end: position },
    context: { diagnostics: [] }
  });
}

describe("typing", () => {
  it("a new struct, keystroke by keystroke, at the end of archive.yfl", async () => {
    t = await startRealServer();
    const path = `${WS}/archive.yfl`;
    let text = PROJECT["archive.yfl"]!;
    const uri = await t.open(path, text);
    await t.settle();
    const typed =
      "\nstruct Extra @base {\n  u32 n\n  Entry *recs[n] : u32 @nullable\n  u8 pad[sizeof(Entry) - 4] @align(8)\n  layout { recs }\n}\n";
    for (const ch of typed) {
      const at = positionAt(text, text.length);
      await t.change(path, [{ range: { start: at, end: at }, text: ch }]);
      text += ch;
      await probe(uri, text, positionAt(text, text.length));
    }
    await t.settle();
    const p = t.diagnostics(path);
    expect(p?.diagnostics ?? [], JSON.stringify(p?.diagnostics)).toEqual([]);
    expect(errorLogs(t)).toEqual([]);
  });

  it("an attribute and a formula in the middle of an existing field", async () => {
    t = await startRealServer();
    const path = `${WS}/sealed.yfl`;
    let text = PROJECT["sealed.yfl"]!;
    const uri = await t.open(path, text);
    await t.settle();
    let offset = offsetAt(text, find(text, "  u64   stamp|"));
    for (const ch of " @align(8) where it != 0") {
      const at = positionAt(text, offset);
      await t.change(path, [{ range: { start: at, end: at }, text: ch }]);
      text = text.slice(0, offset) + ch + text.slice(offset);
      offset++;
      await probe(uri, text, positionAt(text, offset));
    }
    // then backspace it all away
    for (let i = 0; i < " @align(8) where it != 0".length; i++) {
      const end = positionAt(text, offset);
      const start = positionAt(text, offset - 1);
      await t.change(path, [{ range: { start, end }, text: "" }]);
      text = text.slice(0, offset - 1) + text.slice(offset);
      offset--;
      await probe(uri, text, positionAt(text, offset));
    }
    expect(text).toBe(PROJECT["sealed.yfl"]);
    await t.settle();
    expect(t.diagnostics(path)?.diagnostics ?? []).toEqual([]);
    expect(errorLogs(t)).toEqual([]);
  });
});

/** More with YAFFLE_FUZZ_STEPS=n (a longer local run). */
const STEPS = Number(process.env.YAFFLE_FUZZ_STEPS ?? 25);

describe("random edits to every format", () => {
  for (const name of Object.keys(PROJECT)) {
    it(name, async () => {
      t = await startRealServer();
      const path = `${WS}/${name}`;
      let text = PROJECT[name]!;
      const uri = await t.open(path, text);
      await t.settle();
      let seed = [...name].reduce((s, c) => s * 31 + c.charCodeAt(0), 7) >>> 0;
      const rnd = (n: number) => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed % Math.max(1, n);
      };
      const snippets = [
        "{",
        "}",
        "(",
        ")",
        "[",
        "]",
        "@",
        "$",
        ".",
        " at ",
        " = ",
        "\n",
        "u8 x",
        "struct",
        "//",
        '"',
        "*",
        ":",
        "0x"
      ];
      for (let step = 0; step < STEPS; step++) {
        const a = rnd(text.length);
        const kind = rnd(3);
        const b = kind === 0 ? Math.min(text.length, a + rnd(40)) : a;
        const insert = kind === 0 ? "" : snippets[rnd(snippets.length)]!;
        await t.change(path, [
          { range: { start: positionAt(text, a), end: positionAt(text, b) }, text: insert }
        ]);
        text = text.slice(0, a) + insert + text.slice(b);
        await probe(uri, text, positionAt(text, Math.min(text.length, a + insert.length)));
      }
      // the server still agrees with a full resync
      await t.change(path, PROJECT[name]!);
      await t.settle();
      expect(t.diagnostics(path)?.diagnostics ?? []).toEqual([]);
      expect(errorLogs(t)).toEqual([]);
    });
  }
});

describe("edits across files", () => {
  it("deleting an imported file's struct line by line breaks the importer, undo repairs it", async () => {
    t = await startRealServer();
    const notes = `${WS}/notes.yfl`;
    const archive = `${WS}/archive.yfl`;
    const original = PROJECT["notes.yfl"]!;
    await t.open(archive, PROJECT["archive.yfl"]!);
    await t.open(notes, original);
    await t.settle();
    let text = original;
    const versions: string[] = [];
    while (text.length) {
      versions.push(text);
      const cut = text.indexOf("\n");
      const start = positionAt(text, 0);
      const end = positionAt(text, cut < 0 ? text.length : cut + 1);
      await t.change(notes, [{ range: { start, end }, text: "" }]);
      text = cut < 0 ? "" : text.slice(cut + 1);
      await probe(t.uri(notes), text, { line: 0, character: 0 });
    }
    const broken = await t.waitForDiagnostics(archive, d => d.diagnostics.length > 0, 10_000);
    expect(broken.diagnostics.some(d => String(d.message).includes("Comment"))).toBe(true);
    // undo, one step at a time
    for (const v of versions.reverse()) await t.change(notes, v);
    await t.waitForDiagnostics(archive, d => d.diagnostics.length === 0, 10_000);
    expect(errorLogs(t)).toEqual([]);
  });

  it("closing a broken file falls back to the file on disk", async () => {
    t = await startRealServer();
    const notes = `${WS}/notes.yfl`;
    const archive = `${WS}/archive.yfl`;
    await t.open(archive, PROJECT["archive.yfl"]!);
    await t.open(notes, PROJECT["notes.yfl"]!);
    await t.settle();
    await t.change(notes, "// nothing here\n");
    await t.waitForDiagnostics(archive, d => d.diagnostics.length > 0, 10_000);
    await t.close(notes);
    await t.waitForDiagnostics(archive, d => d.diagnostics.length === 0, 10_000);
    // the closed file's own diagnostics are gone too
    await t.settle();
    expect(t.diagnostics(notes)?.diagnostics ?? []).toEqual([]);
  });
});

describe("semantic token deltas", () => {
  it("applying each delta to the previous tokens gives the full tokens", async () => {
    t = await startRealServer();
    const path = `${WS}/chunks.yfl`;
    let text = PROJECT["chunks.yfl"]!;
    const uri = await t.open(path, text);
    await t.settle();
    let previous = await t.request<lsp.SemanticTokens>("textDocument/semanticTokens/full", {
      textDocument: { uri }
    });
    let data = [...previous.data];
    const edits = [
      ["struct Pair { u32 key  u32 value }", "struct Pair { u32 key  u32 value  u32 extra }"],
      ["  u8  data[size] at offset\n", "  u8  data[size] at offset\n  u16 more @align(2)\n"],
      ["export struct ChunkFile {", "export struct ChunkFile @base {"]
    ] as const;
    for (const [from, to] of edits) {
      text = text.replace(from, to);
      await t.change(path, text);
      const delta = await t.request<lsp.SemanticTokensDelta | lsp.SemanticTokens>(
        "textDocument/semanticTokens/full/delta",
        {
          textDocument: { uri },
          previousResultId: previous.resultId
        }
      );
      if ("edits" in delta) {
        for (const e of [...delta.edits].sort((a, b) => b.start - a.start))
          data.splice(e.start, e.deleteCount, ...(e.data ?? []));
      } else data = [...delta.data];
      const full = await t.request<lsp.SemanticTokens>("textDocument/semanticTokens/full", {
        textDocument: { uri }
      });
      expect(data).toEqual(full.data);
      previous = { resultId: delta.resultId!, data: full.data };
      // the new identifiers are tokens
      const tokens = decodeTokens(full.data);
      const lines = text.split("\n");
      const words = tokens.map(tk =>
        lines[tk.line]!.slice(tk.character, tk.character + tk.length).replace(/^@/, "")
      );
      for (const w of to.match(/[A-Za-z_]\w*/g)!) if (!from.includes(w)) expect(words).toContain(w);
    }
    expect(errorLogs(t)).toEqual([]);
  });
});
