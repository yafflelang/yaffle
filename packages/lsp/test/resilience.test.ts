import { afterEach, describe, expect, it } from "vitest";
import type * as lsp from "vscode-languageserver";
import { CancellationTokenSource } from "vscode-languageserver-protocol";
import { startTestServer, type TestServer } from "./harness.ts";

let t: TestServer;
afterEach(() => t?.dispose());

const pos = (line: number, character: number) => ({ line, character });
const range = (sl: number, sc: number, el: number, ec: number) => ({
  start: pos(sl, sc),
  end: pos(el, ec)
});

const ALL_METHODS = [
  "updateFile",
  "closeFile",
  "getDiagnostics",
  "getHover",
  "getCompletions",
  "getSignatureHelp",
  "getDefinition",
  "getReferences",
  "prepareRename",
  "rename",
  "getDocumentSymbols",
  "getWorkspaceSymbols",
  "getInlayHints",
  "getCodeLenses",
  "getCodeActions",
  "getSemanticTokens",
  "getFoldingRanges",
  "format",
  "decodeSample",
  "suggestLayout"
];

/** Every request a client can send for a document, with its expected empty answer. */
function everyRequest(uri: string): [string, unknown, unknown][] {
  const td = { textDocument: { uri } };
  return [
    ["textDocument/hover", { ...td, position: pos(0, 1) }, null],
    ["textDocument/completion", { ...td, position: pos(0, 1) }, { isIncomplete: false, items: [] }],
    ["textDocument/signatureHelp", { ...td, position: pos(0, 1) }, null],
    ["textDocument/definition", { ...td, position: pos(0, 1) }, []],
    [
      "textDocument/references",
      { ...td, position: pos(0, 1), context: { includeDeclaration: true } },
      []
    ],
    ["textDocument/documentHighlight", { ...td, position: pos(0, 1) }, []],
    ["textDocument/prepareRename", { ...td, position: pos(0, 1) }, null],
    ["textDocument/documentSymbol", td, []],
    ["workspace/symbol", { query: "" }, []],
    ["textDocument/inlayHint", { ...td, range: range(0, 0, 5, 0) }, []],
    ["textDocument/codeLens", td, []],
    [
      "textDocument/codeAction",
      { ...td, range: range(0, 0, 0, 0), context: { diagnostics: [] } },
      []
    ],
    ["textDocument/semanticTokens/full", td, { resultId: expect.any(String), data: [] }],
    ["textDocument/semanticTokens/range", { ...td, range: range(0, 0, 5, 0) }, { data: [] }],
    ["textDocument/foldingRange", td, []],
    ["textDocument/formatting", { ...td, options: { tabSize: 2, insertSpaces: true } }, []]
  ];
}

describe("a service that throws everywhere", () => {
  it("answers every request with an empty result and keeps running", async () => {
    t = await startTestServer();
    t.configureFakes(f => ALL_METHODS.forEach(m => f.failing.add(m)));
    const uri = await t.open("/ws/a.yfl", "struct A {\n  u32 x\n}\n");
    await t.settle();
    for (const [method, params, expected] of everyRequest(uri)) {
      expect(await t.request(method, params), method).toEqual(expected);
    }
    // Rename fails with a message rather than crashing.
    await expect(
      t.request("textDocument/rename", { textDocument: { uri }, position: pos(0, 1), newName: "B" })
    ).rejects.toThrow("can't be renamed");
    // Errors were logged, with the method and project.
    const errors = t.logs.filter(l => l.type === 1).map(l => l.message);
    expect(
      errors.some(m =>
        m.includes("getHover (inferred project) failed: Error: fake getHover failure")
      )
    ).toBe(true);
    expect(errors.some(m => m.includes("updateFile"))).toBe(true);

    // Once the service recovers, everything works again.
    t.fakes[0]!.failing.clear();
    await t.change("/ws/a.yfl", "struct A {\n  u32 ERROR\n}\n");
    await t.waitForDiagnostics(uri, d => d.diagnostics.length === 1);
    const hover = await t.request<lsp.Hover>("textDocument/hover", {
      textDocument: { uri },
      position: pos(0, 1)
    });
    expect(hover).not.toBeNull();
  });

  it("throttles repeated identical errors in the log", async () => {
    t = await startTestServer();
    const uri = await t.open("/ws/a.yfl", "struct A {}\n");
    await t.settle();
    t.fakes[0]!.failing.add("getHover");
    for (let i = 0; i < 10; i++) {
      await t.request("textDocument/hover", { textDocument: { uri }, position: pos(0, 1) });
    }
    const hoverErrors = t.logs.filter(l => l.message.includes("getHover"));
    expect(hoverErrors).toHaveLength(3);
    expect(t.server.reporter.total).toBe(10);
  });
});

describe("a service that fails to start", () => {
  it("serves empty results and tells the user once", async () => {
    t = await startTestServer({
      serverOptions: {
        createService: () => {
          throw new Error("language service not implemented yet");
        }
      }
    });
    const uri = await t.open("/ws/a.yfl", "struct A {}\n");
    await t.open("/other/b.yfl", "struct B {}\n");
    await t.settle();
    for (const [method, params, expected] of everyRequest(uri)) {
      expect(await t.request(method, params), method).toEqual(expected);
    }
    expect(t.shownMessages).toEqual([
      {
        type: 1,
        message:
          "yaffle: the language service failed to start for inferred project: language service not implemented yet"
      }
    ]);
  });

  it("treats a factory returning nothing as a failure", async () => {
    t = await startTestServer({
      serverOptions: { createService: () => undefined as never }
    });
    const uri = await t.open("/ws/a.yfl", "x");
    expect(
      await t.request("textDocument/hover", { textDocument: { uri }, position: pos(0, 0) })
    ).toBeNull();
    expect(t.shownMessages).toHaveLength(1);
  });
});

describe("malformed service results are sanitized", () => {
  it("coerces wrong shapes and invalid ranges", async () => {
    t = await startTestServer();
    t.configureFakes(f => {
      f.overrides.getCompletions = () => "not an array";
      f.overrides.getDefinition = () => [
        { path: "/ws/a.yfl", range: { start: { line: -4, character: Number.NaN } } }
      ];
      f.overrides.getHover = () => ({ contents: "" });
      f.overrides.getFoldingRanges = () => [
        { startLine: 3, endLine: 1 },
        { startLine: 0, endLine: 2, kind: "bogus" }
      ];
      f.overrides.getDocumentSymbols = () => [
        {
          name: "",
          kind: "nonsense",
          range: range(5, 0, 6, 0),
          selectionRange: range(1, 0, 1, 3),
          children: [
            {
              name: "c",
              kind: "field",
              range: range(9, 0, 9, 1),
              selectionRange: range(9, 0, 9, 1)
            }
          ]
        }
      ];
      f.overrides.getSemanticTokens = () => [
        { line: 0, character: 0, length: 3, type: "keyword", modifiers: ["bogus", "declaration"] },
        { line: 0, character: 1, length: 5, type: "type", modifiers: [] }, // overlaps
        { line: 0, character: 8, length: 99, type: "type", modifiers: [] }, // clamped to the line
        { line: 1, character: 0, length: 2, type: "nope", modifiers: [] }, // unknown type
        { line: 1, character: 0, length: 0, type: "type", modifiers: [] }, // empty
        { line: -1, character: 0, length: 2, type: "type", modifiers: [] }, // negative
        null
      ];
      f.overrides.getSignatureHelp = () => ({
        signatures: [],
        activeSignature: 0,
        activeParameter: 0
      });
      f.overrides.getDiagnostics = () => [
        null,
        { path: "", range: range(0, 4, 0, 2), severity: "weird", code: "", message: "" }
      ];
    });
    const uri = await t.open("/ws/a.yfl", "abc defgh\nxy\n");
    const completions = await t.request<lsp.CompletionList>("textDocument/completion", {
      textDocument: { uri },
      position: pos(0, 0)
    });
    expect(completions.items).toEqual([]);
    expect(
      await t.request("textDocument/definition", { textDocument: { uri }, position: pos(0, 0) })
    ).toEqual([{ uri, range: range(0, 0, 0, 0) }]);
    expect(
      await t.request("textDocument/hover", { textDocument: { uri }, position: pos(0, 0) })
    ).toBeNull();
    expect(await t.request("textDocument/foldingRange", { textDocument: { uri } })).toEqual([
      { startLine: 0, endLine: 2 }
    ]);
    const symbols = await t.request<lsp.DocumentSymbol[]>("textDocument/documentSymbol", {
      textDocument: { uri }
    });
    expect(symbols[0]).toMatchObject({ name: "(anonymous)", kind: 13, range: range(1, 0, 9, 1) });
    const tokens = await t.request<lsp.SemanticTokens>("textDocument/semanticTokens/full", {
      textDocument: { uri }
    });
    expect(tokens.data).toEqual([0, 0, 3, 10, 1, 0, 8, 1, 4, 0]);
    expect(
      await t.request("textDocument/signatureHelp", { textDocument: { uri }, position: pos(0, 0) })
    ).toBeNull();
    const p = await t.waitForDiagnostics(uri, d => d.diagnostics.length === 1);
    expect(p.diagnostics[0]).toEqual({
      range: range(0, 2, 0, 4),
      severity: 1,
      source: "yaffle",
      message: "(no message)"
    });
  });
});

describe("protocol robustness", () => {
  it("answers cancelled requests with RequestCancelled", async () => {
    t = await startTestServer();
    const uri = await t.open("/ws/a.yfl", "struct A {}\n");
    await t.settle();
    const source = new CancellationTokenSource();
    const pending = t.client.sendRequest(
      "textDocument/hover",
      { textDocument: { uri }, position: pos(0, 1) },
      source.token
    );
    source.cancel();
    await expect(pending).rejects.toMatchObject({ code: -32800 });
    const calls = t.fakes[0]!.callsTo("getHover");
    expect(calls).toHaveLength(0);
  });

  it("answers requests overtaken by an edit with ContentModified", async () => {
    t = await startTestServer();
    const uri = await t.open("/ws/a.yfl", "struct A {}\n");
    await t.settle();
    const pending = t.client.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position: pos(0, 1)
    });
    void t.change("/ws/a.yfl", "struct B {}\n");
    await expect(pending).rejects.toMatchObject({ code: -32801 });
  });

  it("rejects requests without a text document", async () => {
    t = await startTestServer();
    await expect(t.request("textDocument/hover", { position: pos(0, 0) })).rejects.toMatchObject({
      code: -32602
    });
    // Still alive.
    expect(await t.request("workspace/symbol", { query: "" })).toEqual([]);
  });

  it("serves requests for files that aren't open, through the host", async () => {
    t = await startTestServer({ files: { "/ws/closed.yfl": "struct Closed {\n}\n" } });
    const hover = await t.request<lsp.Hover>("textDocument/hover", {
      textDocument: { uri: t.uri("/ws/closed.yfl") },
      position: pos(0, 9)
    });
    expect((hover.contents as lsp.MarkupContent).value).toContain("Closed");
  });

  it("survives notifications about unknown documents", async () => {
    t = await startTestServer();
    await t.client.sendNotification("textDocument/didChange", {
      textDocument: { uri: t.uri("/ws/never-opened.yfl"), version: 2 },
      contentChanges: [{ text: "x" }]
    });
    await t.client.sendNotification("textDocument/didClose", {
      textDocument: { uri: t.uri("/ws/never.yfl") }
    });
    await t.client.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [null, { uri: 5 }]
    });
    await t.settle();
    expect(await t.request("workspace/symbol", { query: "" })).toEqual([]);
  });

  it("applies incremental changes correctly (including CRLF and surrogate pairs)", async () => {
    t = await startTestServer();
    await t.open("/ws/a.yfl", "// 🐦 yaffle\r\nstruct A {\r\n  u32 x\r\n}\r\n");
    // Replace `x` (line 2, UTF-16 column 6) and insert after the emoji (2 code units).
    await t.change("/ws/a.yfl", [
      { range: range(2, 6, 2, 7), text: "count" },
      { range: range(0, 5, 0, 5), text: "!" }
    ]);
    await t.settle();
    const last = t.fakes[0]!.callsTo("updateFile").at(-1)!.args[1];
    expect(last).toBe("// 🐦! yaffle\r\nstruct A {\r\n  u32 count\r\n}\r\n");
  });
});
