import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type * as lsp from "vscode-languageserver";
import { TOKEN_MODIFIERS, TOKEN_TYPES } from "../src/semanticTokens.ts";
import { startTestServer, type TestServer, VSCODE_LIKE_CAPABILITIES } from "./harness.ts";

const MAIN = "/ws/main.yfl";
const SRC = [
  'import { Span } from "./common.yfl"', // 0
  "struct Entry {", // 1
  "  u32 count", // 2
  "  u16 kind   ", // 3 (trailing spaces, for formatting)
  "}", // 4
  "struct Table {", // 5
  "  u32 $version", // 6
  "  Entry entries", // 7
  "  u8 data @align(8, 0)", // 8
  "}", // 9
  ""
].join("\n");

const pos = (line: number, character: number) => ({ line, character });
const range = (sl: number, sc: number, el: number, ec: number) => ({
  start: pos(sl, sc),
  end: pos(el, ec)
});

let t: TestServer;
let uri: string;

async function setup(options: Parameters<typeof startTestServer>[0] = {}) {
  t = await startTestServer({
    files: { "/ws/common.yfl": "struct Span {\n  u64 n\n}\n" },
    workspaceFolders: ["/ws"],
    ...options
  });
  uri = await t.open(MAIN, SRC);
  await t.settle();
}

afterEach(() => t?.dispose());

describe("request mappings (VS Code-like client)", () => {
  beforeEach(() => setup());

  it("hover → markdown MarkupContent with range", async () => {
    const hover = await t.request<lsp.Hover>("textDocument/hover", {
      textDocument: { uri },
      position: pos(7, 3)
    });
    expect(hover.contents).toEqual({
      kind: "markdown",
      value: "```yaffle\nEntry\n```\nHover for `Entry`"
    });
    expect(hover.range).toEqual(range(7, 2, 7, 7));
    const call = t.fakes[0]!.callsTo("getHover").at(-1)!;
    expect(call.args).toEqual([MAIN, pos(7, 3)]);
  });

  it("hover on nothing → null", async () => {
    const hover = await t.request("textDocument/hover", {
      textDocument: { uri },
      position: pos(4, 5)
    });
    expect(hover).toBeNull();
  });

  it("completion → kinds, details, documentation, snippets and text edits", async () => {
    const list = await t.request<lsp.CompletionList>("textDocument/completion", {
      textDocument: { uri },
      position: pos(8, 5)
    });
    expect(list.isIncomplete).toBe(false);
    const byLabel = new Map(list.items.map(i => [i.label, i]));
    expect(byLabel.get("u32")).toMatchObject({ kind: 25, detail: "4 bytes", insertTextFormat: 1 });
    expect(byLabel.get("count")).toMatchObject({
      kind: 5,
      sortText: "0",
      documentation: { kind: "markdown", value: "The **count**" }
    });
    expect(byLabel.get("$version")).toMatchObject({
      kind: 6,
      textEdit: { range: range(8, 4, 8, 5), newText: "$version" }
    });
    expect(byLabel.get("struct")).toMatchObject({
      kind: 15,
      insertTextFormat: 2,
      insertText: "struct ${1:Name} {\n  ${2:u32} ${3:field}\n}$0"
    });
    expect(byLabel.get("@align")?.kind).toBe(10);
    expect(byLabel.get("zstd")?.kind).toBe(2);
  });

  it("signature help → active parameter from the service", async () => {
    const help = await t.request<lsp.SignatureHelp>("textDocument/signatureHelp", {
      textDocument: { uri },
      position: pos(8, 20)
    });
    expect(help.activeSignature).toBe(0);
    expect(help.activeParameter).toBe(1);
    expect(help.signatures[0]).toEqual({
      label: "@align(n: u64, fill?: u8)",
      documentation: { kind: "markdown", value: "Pad before the field" },
      parameters: [
        { label: "n: u64", documentation: { kind: "markdown", value: "alignment" } },
        { label: "fill?: u8" }
      ],
      activeParameter: 1
    });
    const none = await t.request("textDocument/signatureHelp", {
      textDocument: { uri },
      position: pos(2, 4)
    });
    expect(none).toBeNull();
  });

  it("definition → locations with the client's URIs", async () => {
    const defs = await t.request<lsp.Location[]>("textDocument/definition", {
      textDocument: { uri },
      position: pos(7, 4)
    });
    expect(defs).toEqual([{ uri, range: range(1, 7, 1, 12) }]);
  });

  it("references honour includeDeclaration", async () => {
    const all = await t.request<lsp.Location[]>("textDocument/references", {
      textDocument: { uri },
      position: pos(7, 4),
      context: { includeDeclaration: true }
    });
    expect(all).toEqual([
      { uri, range: range(1, 7, 1, 12) },
      { uri, range: range(7, 2, 7, 7) }
    ]);
    const refs = await t.request<lsp.Location[]>("textDocument/references", {
      textDocument: { uri },
      position: pos(7, 4),
      context: { includeDeclaration: false }
    });
    expect(refs).toEqual([{ uri, range: range(7, 2, 7, 7) }]);
    expect(t.fakes[0]!.callsTo("getReferences").at(-1)!.args[2]).toBe(false);
  });

  it("document highlights come from same-file references", async () => {
    const highlights = await t.request<lsp.DocumentHighlight[]>("textDocument/documentHighlight", {
      textDocument: { uri },
      position: pos(1, 8)
    });
    expect(highlights).toEqual([
      { range: range(1, 7, 1, 12), kind: 1 },
      { range: range(7, 2, 7, 7), kind: 1 }
    ]);
  });

  it("prepareRename → range and placeholder, or null", async () => {
    const ok = await t.request("textDocument/prepareRename", {
      textDocument: { uri },
      position: pos(1, 9)
    });
    expect(ok).toEqual({ range: range(1, 7, 1, 12), placeholder: "Entry" });
    const no = await t.request("textDocument/prepareRename", {
      textDocument: { uri },
      position: pos(1, 2)
    });
    expect(no).toBeNull();
  });

  it("rename → versioned documentChanges", async () => {
    const edit = await t.request<lsp.WorkspaceEdit>("textDocument/rename", {
      textDocument: { uri },
      position: pos(1, 9),
      newName: "Record"
    });
    expect(edit).toEqual({
      documentChanges: [
        {
          textDocument: { uri, version: 1 },
          edits: [
            { range: range(1, 7, 1, 12), newText: "Record" },
            { range: range(7, 2, 7, 7), newText: "Record" }
          ]
        }
      ]
    });
  });

  it("rename where the service refuses → an error the editor can show", async () => {
    await expect(
      t.request("textDocument/rename", { textDocument: { uri }, position: pos(1, 2), newName: "x" })
    ).rejects.toThrow("This element can't be renamed.");
  });

  it("document symbols → hierarchical", async () => {
    const symbols = await t.request<lsp.DocumentSymbol[]>("textDocument/documentSymbol", {
      textDocument: { uri }
    });
    expect(symbols.map(s => [s.name, s.kind, s.detail])).toEqual([
      ["Entry", 23, "2 fields"],
      ["Table", 23, "3 fields"]
    ]);
    expect(symbols[0]!.range).toEqual(range(1, 0, 4, 1));
    expect(symbols[0]!.selectionRange).toEqual(range(1, 7, 1, 12));
    expect(symbols[0]!.children!.map(c => [c.name, c.kind, c.detail])).toEqual([
      ["count", 8, "u32"],
      ["kind", 8, "u16"]
    ]);
  });

  it("workspace symbols → SymbolInformation with URIs", async () => {
    const symbols = await t.request<lsp.SymbolInformation[]>("workspace/symbol", { query: "tab" });
    expect(symbols).toEqual([
      {
        name: "Table",
        kind: 23,
        location: { uri, range: range(5, 7, 5, 12) },
        containerName: "fake"
      }
    ]);
  });

  it("inlay hints → kind, tooltip and padding", async () => {
    const hints = await t.request<lsp.InlayHint[]>("textDocument/inlayHint", {
      textDocument: { uri },
      range: range(0, 0, 10, 0)
    });
    expect(hints).toEqual([
      {
        position: pos(2, 11),
        label: "= entries.length",
        kind: 1,
        tooltip: { kind: "markdown", value: "Derived from the **length of entries**" },
        paddingLeft: true
      }
    ]);
    expect(t.fakes[0]!.callsTo("getInlayHints").at(-1)!.args[1]).toEqual(range(0, 0, 10, 0));
  });

  it("code lenses → commands, with service locations converted to LSP locations", async () => {
    const lenses = await t.request<lsp.CodeLens[]>("textDocument/codeLens", {
      textDocument: { uri }
    });
    expect(lenses).toHaveLength(2);
    expect(lenses[1]).toEqual({
      range: range(5, 0, 5, 0),
      command: {
        title: "needs: $version (u32)",
        command: "yaffle.showBindingSources",
        arguments: [MAIN, pos(5, 0), [{ uri, range: range(5, 7, 5, 8) }]]
      }
    });
  });

  it("folding ranges → struct blocks", async () => {
    const ranges = await t.request<lsp.FoldingRange[]>("textDocument/foldingRange", {
      textDocument: { uri }
    });
    expect(ranges).toEqual([
      { startLine: 1, endLine: 4 },
      { startLine: 5, endLine: 9 }
    ]);
  });

  it("formatting → text edits", async () => {
    const edits = await t.request<lsp.TextEdit[]>("textDocument/formatting", {
      textDocument: { uri },
      options: { tabSize: 2, insertSpaces: true }
    });
    expect(edits).toEqual([{ range: range(3, 10, 3, 13), newText: "" }]);
    expect(t.fakes[0]!.callsTo("format").at(-1)!.args).toEqual([
      MAIN,
      { tabSize: 2, insertSpaces: true }
    ]);
  });

  it("semantic tokens: full, delta and range", async () => {
    const full = await t.request<lsp.SemanticTokens>("textDocument/semanticTokens/full", {
      textDocument: { uri }
    });
    expect(full.resultId).toBeDefined();
    const decoded = decode(full.data);
    expect(decoded.slice(0, 4)).toEqual([
      { line: 0, char: 0, length: 6, type: "keyword", modifiers: [] },
      { line: 0, char: 16, length: 4, type: "keyword", modifiers: [] },
      { line: 1, char: 0, length: 6, type: "keyword", modifiers: [] },
      { line: 2, char: 2, length: 3, type: "type", modifiers: ["defaultLibrary"] }
    ]);
    expect(decoded).toContainEqual({
      line: 6,
      char: 6,
      length: 8,
      type: "variable",
      modifiers: ["readonly"]
    });

    // Same content: an empty delta.
    const same = await t.request<lsp.SemanticTokensDelta>(
      "textDocument/semanticTokens/full/delta",
      {
        textDocument: { uri },
        previousResultId: full.resultId
      }
    );
    expect(same.edits).toEqual([]);

    // Change line 2's type: the delta replaces just that token's type.
    await t.change(MAIN, [{ range: range(2, 2, 2, 5), text: "u64" }]);
    const delta = await t.request<lsp.SemanticTokensDelta>(
      "textDocument/semanticTokens/full/delta",
      {
        textDocument: { uri },
        previousResultId: same.resultId
      }
    );
    expect(delta.resultId).not.toBe(same.resultId);
    expect(delta.edits.length).toBe(0); // u32 → u64: same token kind and position
    await t.change(MAIN, [{ range: range(2, 2, 2, 5), text: "Foo" }]);
    const delta2 = await t.request<lsp.SemanticTokensDelta>(
      "textDocument/semanticTokens/full/delta",
      {
        textDocument: { uri },
        previousResultId: delta.resultId
      }
    );
    expect(delta2.edits).toHaveLength(1);

    // Unknown previous id: full result.
    const unknown = await t.request<lsp.SemanticTokens>("textDocument/semanticTokens/full/delta", {
      textDocument: { uri },
      previousResultId: "nope"
    });
    expect(unknown.data).toBeDefined();

    const ranged = await t.request<lsp.SemanticTokens>("textDocument/semanticTokens/range", {
      textDocument: { uri },
      range: range(6, 0, 7, 0)
    });
    expect(decode(ranged.data)).toEqual([
      { line: 6, char: 2, length: 3, type: "type", modifiers: ["defaultLibrary"] },
      { line: 6, char: 6, length: 8, type: "variable", modifiers: ["readonly"] }
    ]);
  });

  it("on-type formatting aligns `@` continuation lines", async () => {
    const doc = "struct A {\n  u64 offset   @align(8)\n  @\n}\n";
    const u = await t.open("/ws/align.yfl", doc);
    const edits = await t.request<lsp.TextEdit[]>("textDocument/onTypeFormatting", {
      textDocument: { uri: u },
      position: pos(2, 3),
      ch: "@",
      options: { tabSize: 2, insertSpaces: true }
    });
    expect(edits).toEqual([{ range: range(2, 0, 2, 2), newText: " ".repeat(15) }]);
  });

  it("on-type formatting returns to the field indentation after Enter on a continuation", async () => {
    const doc =
      "struct A {\n  u64 offset   @align(8)\n               @padAfter(8)\n               \n}\n";
    const u = await t.open("/ws/enter.yfl", doc);
    const edits = await t.request<lsp.TextEdit[]>("textDocument/onTypeFormatting", {
      textDocument: { uri: u },
      position: pos(3, 15),
      ch: "\n",
      options: { tabSize: 2, insertSpaces: true }
    });
    expect(edits).toEqual([{ range: range(3, 0, 3, 15), newText: "  " }]);
    const none = await t.request("textDocument/onTypeFormatting", {
      textDocument: { uri: u },
      position: pos(1, 5),
      ch: "x",
      options: { tabSize: 2, insertSpaces: true }
    });
    expect(none).toBeNull();
  });
});

describe("code actions", () => {
  beforeEach(() => setup());

  it("returns quick fixes for published diagnostics, plus the service's actions", async () => {
    await t.change(MAIN, SRC.replace("u16 kind", "u16 ERROR").replace("u8 data", "u8 WARN"));
    const published = await t.waitForDiagnostics(MAIN, p => p.diagnostics.length === 2);
    const actions = await t.request<lsp.CodeAction[]>("textDocument/codeAction", {
      textDocument: { uri },
      range: range(3, 0, 8, 0),
      context: { diagnostics: published.diagnostics }
    });
    const titles = actions.map(a => a.title);
    expect(titles).toEqual(["Silence warning", "Sort fields", "Extract struct", "Remove ERROR"]);
    const removeError = actions.find(a => a.title === "Remove ERROR")!;
    expect(removeError.kind).toBe("quickfix");
    expect(removeError.isPreferred).toBe(true);
    expect(removeError.diagnostics?.map(d => d.code)).toEqual(["fake-error"]);
    expect(removeError.edit).toEqual({
      documentChanges: [
        { textDocument: { uri, version: 2 }, edits: [{ range: range(3, 6, 3, 11), newText: "" }] }
      ]
    });
    // The service received its own diagnostic objects back (with fixes and related info).
    const sent = t.fakes[0]!.callsTo("getCodeActions").at(-1)!.args[2] as {
      code: string;
      fixes?: unknown[];
    }[];
    expect(sent.map(d => d.code)).toEqual(["fake-error", "fake-warning"]);
    expect(sent[0]!.fixes).toHaveLength(1);
  });

  it("filters by context.only", async () => {
    const actions = await t.request<lsp.CodeAction[]>("textDocument/codeAction", {
      textDocument: { uri },
      range: range(0, 0, 0, 0),
      context: { diagnostics: [], only: ["source"] }
    });
    expect(actions.map(a => a.title)).toEqual(["Sort fields"]);
  });

  it("rebuilds diagnostics the server never published", async () => {
    await t.request<lsp.CodeAction[]>("textDocument/codeAction", {
      textDocument: { uri },
      range: range(0, 0, 0, 3),
      context: {
        diagnostics: [
          { range: range(0, 0, 0, 3), severity: 2, code: "fake-warning", message: "from elsewhere" }
        ]
      }
    });
    const sent = t.fakes[0]!.callsTo("getCodeActions").at(-1)!.args[2];
    expect(sent).toEqual([
      {
        path: MAIN,
        range: range(0, 0, 0, 3),
        severity: "warning",
        code: "fake-warning",
        message: "from elsewhere"
      }
    ]);
  });

  it("ignores other tools' diagnostics", async () => {
    await t.request<lsp.CodeAction[]>("textDocument/codeAction", {
      textDocument: { uri },
      range: range(0, 0, 0, 3),
      context: {
        diagnostics: [
          { range: range(0, 0, 0, 3), code: "typo", message: "Unknown word", source: "cSpell" },
          { range: range(0, 0, 0, 3), code: "fake-warning", message: "ours", source: "yaffle" }
        ]
      }
    });
    const sent = t.fakes[0]!.callsTo("getCodeActions").at(-1)!.args[2] as { code: string }[];
    expect(sent.map(d => d.code)).toEqual(["fake-warning"]);
  });
});

describe("request mappings (minimal client)", () => {
  beforeEach(() => setup({ capabilities: {} }));

  it("hover falls back to markdown when the client states no formats", async () => {
    const hover = await t.request<lsp.Hover>("textDocument/hover", {
      textDocument: { uri },
      position: pos(7, 3)
    });
    expect((hover.contents as lsp.MarkupContent).kind).toBe("markdown");
  });

  it("snippets become plain text without snippet support", async () => {
    const list = await t.request<lsp.CompletionList>("textDocument/completion", {
      textDocument: { uri },
      position: pos(8, 5)
    });
    const struct = list.items.find(i => i.label === "struct")!;
    expect(struct.insertTextFormat).toBe(1);
    expect(struct.insertText).toBe("struct Name {\n  u32 field\n}");
  });

  it("rename uses `changes` without documentChanges support", async () => {
    const edit = await t.request<lsp.WorkspaceEdit>("textDocument/rename", {
      textDocument: { uri },
      position: pos(1, 9),
      newName: "Record"
    });
    expect(edit).toEqual({
      changes: {
        [uri]: [
          { range: range(1, 7, 1, 12), newText: "Record" },
          { range: range(7, 2, 7, 7), newText: "Record" }
        ]
      }
    });
  });

  it("document symbols are flattened without hierarchical support", async () => {
    const symbols = await t.request<lsp.SymbolInformation[]>("textDocument/documentSymbol", {
      textDocument: { uri }
    });
    expect(symbols.map(s => [s.name, s.containerName])).toEqual([
      ["Entry", undefined],
      ["count", "Entry"],
      ["kind", "Entry"],
      ["Table", undefined],
      ["$version", "Table"],
      ["entries", "Table"],
      ["data", "Table"]
    ]);
    expect(symbols[0]!.location).toEqual({ uri, range: range(1, 0, 4, 1) });
  });
});

describe("Windows paths", () => {
  it("maps locations in other files and edits of open files to the right URIs", async () => {
    t = await startTestServer({
      platform: "win32",
      workspaceFolders: ["c:\\ws"],
      files: { "C:\\ws\\common.yfl": "struct Span {\n}\n" }
    });
    // The client spells the open document with an uppercase drive and no escaping.
    const mainUri = "file:///C:/ws/main.yfl";
    await t.open(mainUri, "struct Main {\n  Span s\n}\n");
    await t.settle();
    const fake = t.fakes[0]!;
    // Make the service know common.yfl (as if it had been imported).
    fake.files.set("c:\\ws\\common.yfl", "struct Span {\n}\n");
    const defs = await t.request<lsp.Location[]>("textDocument/definition", {
      textDocument: { uri: mainUri },
      position: pos(1, 3)
    });
    expect(defs).toEqual([{ uri: "file:///c%3A/ws/common.yfl", range: range(0, 7, 0, 11) }]);
    const edit = await t.request<lsp.WorkspaceEdit>("textDocument/rename", {
      textDocument: { uri: mainUri },
      position: pos(0, 8),
      newName: "Top"
    });
    expect(edit.documentChanges).toEqual([
      {
        textDocument: { uri: mainUri, version: 1 },
        edits: [{ range: range(0, 7, 0, 11), newText: "Top" }]
      }
    ]);
    expect(fake.callsTo("getDefinition")[0]!.args[0]).toBe("c:\\ws\\main.yfl");
  });
});

describe("plaintext-only client", () => {
  beforeEach(() =>
    setup({
      capabilities: {
        ...VSCODE_LIKE_CAPABILITIES,
        textDocument: {
          ...VSCODE_LIKE_CAPABILITIES.textDocument,
          hover: { contentFormat: ["plaintext"] }
        }
      }
    })
  );

  it("hover is plaintext", async () => {
    const hover = await t.request<lsp.Hover>("textDocument/hover", {
      textDocument: { uri },
      position: pos(7, 3)
    });
    expect((hover.contents as lsp.MarkupContent).kind).toBe("plaintext");
  });
});

function decode(data: number[]) {
  const out: { line: number; char: number; length: number; type: string; modifiers: string[] }[] =
    [];
  let line = 0;
  let char = 0;
  for (let i = 0; i < data.length; i += 5) {
    const dl = data[i]!;
    line += dl;
    char = dl === 0 ? char + data[i + 1]! : data[i + 1]!;
    const mods = data[i + 4]!;
    out.push({
      line,
      char,
      length: data[i + 2]!,
      type: TOKEN_TYPES[data[i + 3]!]!,
      modifiers: TOKEN_MODIFIERS.filter((_m, bit) => mods & (1 << bit))
    });
  }
  return out;
}
