/** Unit tests for the pure helpers: conversions, tokens, settings, config loading, alignment. */
import { describe, expect, it } from "vitest";
import { alignAttributeLine, reindentAfterContinuation } from "../src/attributeAlign.ts";
import { fallbackLoadProjectConfig, resolveSettings, stripJsonComments } from "../src/config.ts";
import {
  type ConvertContext,
  convertCommandArguments,
  kindMatches,
  snippetToPlain,
  toLspCodeLens,
  toLspDocumentSymbol,
  toLspRange,
  toLspSignatureHelp,
  toLspWorkspaceEdit
} from "../src/convert.ts";
import { DiagnosticsStore } from "../src/diagnostics.ts";
import { MemoryFileSystem } from "../src/fs.ts";
import { DEFAULT_SETTINGS } from "../src/protocol.ts";
import { ErrorReporter, SafeService } from "../src/safe.ts";
import {
  encodeTokens,
  prepareTokens,
  SemanticTokensCache,
  TOKEN_TYPES
} from "../src/semanticTokens.ts";
import { UriMapper } from "../src/uri.ts";

const r = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec }
});

function ctx(overrides: Partial<ConvertContext> = {}): ConvertContext {
  return {
    uris: new UriMapper("posix"),
    markdown: true,
    snippets: true,
    documentChanges: false,
    versionOf: () => null,
    ...overrides
  };
}

describe("snippetToPlain", () => {
  it.each([
    ["struct ${1:Name} {\n  $0\n}", "struct Name {\n  \n}"],
    ["${1:outer ${2:inner}}", "outer inner"],
    ["u32${1|le,be|}", "u32le"],
    ["@align(${1:8})$0", "@align(8)"],
    ["cost: \\$5 \\} \\\\", "cost: $5 } \\"],
    ["$TM_FILENAME_BASE", ""],
    ["${TM_FILENAME/(.*)\\..+$/$1/}x", "x"],
    ["${2}", ""],
    ["plain", "plain"],
    ["$", "$"]
  ])("%j → %j", (snippet, plain) => {
    expect(snippetToPlain(snippet)).toBe(plain);
  });
});

describe("conversions", () => {
  it("sanitizes ranges", () => {
    expect(toLspRange(r(3, 4, 1, 2))).toEqual(r(1, 2, 3, 4));
    expect(toLspRange(undefined)).toEqual(r(0, 0, 0, 0));
    expect(
      toLspRange({
        start: { line: 1.7, character: -2 },
        end: { line: Infinity, character: 3 }
      } as never)
    ).toEqual(r(0, 3, 1, 0));
  });

  it("keeps selectionRange and children inside the symbol range", () => {
    const s = toLspDocumentSymbol({
      name: "S",
      kind: "struct",
      range: r(2, 0, 3, 0),
      selectionRange: r(1, 0, 1, 1),
      children: [{ name: "f", kind: "field", range: r(5, 0, 5, 2), selectionRange: r(5, 0, 5, 2) }]
    });
    expect(s.range).toEqual(r(1, 0, 5, 2));
  });

  it("converts workspace edits in both shapes", () => {
    const edit = { changes: { "/a.yfl": [{ range: r(0, 0, 0, 1), newText: "x" }] } };
    expect(toLspWorkspaceEdit(edit, ctx())).toEqual({
      changes: { "file:///a.yfl": [{ range: r(0, 0, 0, 1), newText: "x" }] }
    });
    expect(toLspWorkspaceEdit(edit, ctx({ documentChanges: true, versionOf: () => 4 }))).toEqual({
      documentChanges: [
        {
          textDocument: { uri: "file:///a.yfl", version: 4 },
          edits: [{ range: r(0, 0, 0, 1), newText: "x" }]
        }
      ]
    });
    expect(toLspWorkspaceEdit({ changes: { "/b.yfl": "nope" } } as never, ctx())).toEqual({
      changes: {}
    });
  });

  it("converts locations nested in command arguments, and nothing else", () => {
    const args = [
      "/a.yfl",
      { path: "/a.yfl", range: r(0, 0, 0, 1) },
      { nested: [{ path: "/b.yfl", range: r(1, 0, 1, 1) }], path: "kept" },
      { uri: "x", path: "/c.yfl", range: r(0, 0, 0, 0) }
    ];
    expect(convertCommandArguments(args, ctx())).toEqual([
      "/a.yfl",
      { uri: "file:///a.yfl", range: r(0, 0, 0, 1) },
      { nested: [{ uri: "file:///b.yfl", range: r(1, 0, 1, 1) }], path: "kept" },
      { uri: "x", path: "/c.yfl", range: r(0, 0, 0, 0) }
    ]);
  });

  it("gives command-less lenses an inert command so they still render", () => {
    expect(toLspCodeLens({ range: r(0, 0, 0, 0), title: "needs: $v" }, ctx())).toEqual({
      range: r(0, 0, 0, 0),
      command: { title: "needs: $v", command: "" }
    });
  });

  it("clamps signature indices", () => {
    const help = toLspSignatureHelp(
      {
        signatures: [{ label: "f(a)", parameters: [{ label: "a" }] }],
        activeSignature: 7,
        activeParameter: -3
      },
      ctx()
    );
    expect(help?.activeSignature).toBe(0);
    expect(help?.activeParameter).toBe(0);
  });

  it("matches code action kinds against `only`", () => {
    expect(kindMatches("quickfix", undefined)).toBe(true);
    expect(kindMatches("refactor.extract", ["refactor"])).toBe(true);
    expect(kindMatches("refactorx", ["refactor"])).toBe(false);
    expect(kindMatches("source", ["quickfix", "source"])).toBe(true);
  });
});

describe("semantic tokens", () => {
  it("encodes relative positions", () => {
    const tokens = prepareTokens([
      { line: 2, character: 4, length: 3, type: "keyword", modifiers: [] },
      {
        line: 0,
        character: 1,
        length: 2,
        type: "struct",
        modifiers: ["declaration", "deprecated"]
      },
      { line: 2, character: 10, length: 1, type: "number", modifiers: [] }
    ]);
    expect(encodeTokens(tokens)).toEqual([
      0,
      1,
      2,
      TOKEN_TYPES.indexOf("struct"),
      0b1001,
      2,
      4,
      3,
      TOKEN_TYPES.indexOf("keyword"),
      0,
      0,
      6,
      1,
      TOKEN_TYPES.indexOf("number"),
      0
    ]);
  });

  it("computes minimal deltas", () => {
    const cache = new SemanticTokensCache();
    const a = prepareTokens([
      { line: 0, character: 0, length: 1, type: "keyword", modifiers: [] },
      { line: 1, character: 0, length: 1, type: "keyword", modifiers: [] },
      { line: 2, character: 0, length: 1, type: "keyword", modifiers: [] }
    ]);
    const full = cache.full("u", a);
    const b = prepareTokens([
      { line: 0, character: 0, length: 1, type: "keyword", modifiers: [] },
      { line: 1, character: 0, length: 5, type: "keyword", modifiers: [] },
      { line: 2, character: 0, length: 1, type: "keyword", modifiers: [] }
    ]);
    const delta = cache.delta("u", full.resultId!, b);
    expect(delta).toEqual({
      resultId: expect.any(String),
      edits: [{ start: 7, deleteCount: 1, data: [5] }]
    });
    // Applying the delta to the old data gives the new data.
    const applied = [...full.data];
    applied.splice(7, 1, 5);
    expect(applied).toEqual(encodeTokens(b));
    cache.forget("u");
    expect("data" in cache.delta("u", "1", b)).toBe(true);
  });
});

describe("settings", () => {
  it("merges nested, flat and partial settings over defaults", () => {
    expect(resolveSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(resolveSettings({ diagnostics: { delay: 50 } }).diagnostics.delay).toBe(50);
    expect(resolveSettings({ yaffle: { codeLens: { enabled: false } } }).codeLens.enabled).toBe(
      false
    );
    expect(resolveSettings({ "format.enabled": false }).format.enabled).toBe(false);
    expect(resolveSettings({ diagnostics: { delay: "soon" } }).diagnostics.delay).toBe(250);
    expect(resolveSettings({ diagnostics: { delay: 1e9 } }).diagnostics.delay).toBe(10_000);
    expect(resolveSettings({ inlayHints: { enabled: "yes" } }).inlayHints.enabled).toBe(true);
    expect(resolveSettings({ diagnostics: { scope: "openFiles" } }).diagnostics).toEqual({
      delay: 250,
      scope: "openFiles"
    });
    expect(resolveSettings({ diagnostics: { scope: "everything" } }).diagnostics.scope).toBe(
      "project"
    );
  });
});

describe("yaffle.json fallback loader", () => {
  const load = (text: string | undefined) =>
    fallbackLoadProjectConfig("/p/yaffle.json", {
      readFile: () => text,
      fileExists: () => text !== undefined
    });

  it("accepts JSONC", () => {
    const result = load(`{
      // comment
      "sources": ["a/**/*.yfl", "b.yfl"], /* block */
      "targets": { "ts": { "out": "gen", "externs": { "h": "./h.ts" } }, },
    }`);
    expect(result).toEqual({
      config: {
        sources: ["a/**/*.yfl", "b.yfl"],
        targets: { ts: { out: "gen", externs: { h: "./h.ts" } } }
      },
      diagnostics: []
    });
  });

  it("defaults sources and targets", () => {
    expect(load("{}").config).toEqual({ sources: ["**/*.yfl"], targets: {} });
  });

  it("reports JSON errors with a position", () => {
    const result = load('{\n  "sources": [\n}');
    expect(result.config).toBeUndefined();
    expect(result.diagnostics[0]).toMatchObject({
      code: "invalid-config",
      severity: "error",
      path: "/p/yaffle.json"
    });
    expect(result.diagnostics[0]!.message).toMatch(/^Invalid JSON/);
  });

  it("reports a missing file and non-object roots", () => {
    expect(load(undefined).diagnostics[0]!.message).toBe("Cannot read yaffle.json");
    expect(load("[1]").diagnostics[0]!.message).toBe("yaffle.json must contain an object");
    expect(load('{ "targets": [] }').diagnostics[0]!.message).toBe('"targets" must be an object');
  });

  it("keeps strings containing comment markers intact", () => {
    expect(stripJsonComments('{"a": "http://x/*y*/"} // z')).toBe('{"a": "http://x/*y*/"}     ');
  });
});

describe("@ continuation alignment", () => {
  const doc = (text: string) => {
    const lines = text.split("\n");
    return (n: number) => lines[n];
  };

  it("aligns with the first postfix attribute of the field above", () => {
    const get = doc("  u64 offset   @align(8)\n  @");
    expect(alignAttributeLine(get, 1, 3)).toEqual({
      line: 1,
      oldIndent: 2,
      newIndent: " ".repeat(15)
    });
  });

  it("aligns with a continuation line above, skipping blanks and comments", () => {
    const get = doc("  u64 offset   @align(8)\n               @padAfter(8)\n\n  // note\n@");
    expect(alignAttributeLine(get, 4, 1)).toEqual({
      line: 4,
      oldIndent: 0,
      newIndent: " ".repeat(15)
    });
  });

  it("keeps tab indentation of the field above", () => {
    const get = doc("\tu8 x @strict\n\t@");
    expect(alignAttributeLine(get, 1, 2)).toEqual({ line: 1, oldIndent: 1, newIndent: "\t     " });
  });

  it("aligns with the name of a field without attributes (as the formatter does)", () => {
    expect(alignAttributeLine(doc("  u32  version in (2..4)\n@"), 1, 1)).toEqual({
      line: 1,
      oldIndent: 0,
      newIndent: " ".repeat(7)
    });
    expect(alignAttributeLine(doc("  Record *recPtrs[r] : u64\n  @"), 1, 3)).toEqual({
      line: 1,
      oldIndent: 2,
      newIndent: " ".repeat(10)
    });
    expect(alignAttributeLine(doc("  TableIndex(n, t) index\n  @"), 1, 3)).toEqual({
      line: 1,
      oldIndent: 2,
      newIndent: " ".repeat(19)
    });
  });

  it("ignores @ inside strings and comments, block starts, and non-leading @", () => {
    // the @ in the string or comment isn't an attribute: the name is the column
    expect(alignAttributeLine(doc('  char t[4] = "@x"\n  @'), 1, 3)).toEqual({
      line: 1,
      oldIndent: 2,
      newIndent: " ".repeat(7)
    });
    expect(alignAttributeLine(doc("  u8 x // @later\n  @"), 1, 3)).toEqual({
      line: 1,
      oldIndent: 2,
      newIndent: " ".repeat(5)
    });
    expect(alignAttributeLine(doc("struct A @base {\n  @"), 1, 3)).toBeUndefined();
    expect(alignAttributeLine(doc("  u8 x @a\n  y @"), 1, 5)).toBeUndefined();
    expect(alignAttributeLine(doc("@"), 0, 1)).toBeUndefined();
    expect(alignAttributeLine(doc("  u8 x @a\n       @"), 1, 8)).toBeUndefined();
  });
});

describe("Enter after @ continuation lines", () => {
  const doc = (text: string) => {
    const lines = text.split("\n");
    return (n: number) => lines[n];
  };

  it("returns to the field indentation", () => {
    const get = doc("  u64 offset   @align(8)\n               @padAfter(8)\n               ");
    expect(reindentAfterContinuation(get, 2)).toEqual({ line: 2, oldIndent: 15, newIndent: "  " });
  });

  it("skips several continuation and comment lines", () => {
    const get = doc("\tu8 x @a\n      @b\n      // c\n      @d\n      ");
    expect(reindentAfterContinuation(get, 4)).toEqual({ line: 4, oldIndent: 6, newIndent: "\t" });
  });

  it("leaves block attributes, attribute lines and non-continuations alone", () => {
    expect(reindentAfterContinuation(doc("struct A {\n  @padUntil(0x80)\n  "), 2)).toBeUndefined();
    expect(reindentAfterContinuation(doc("  u8 x @a\n       @b {\n         "), 2)).toBeUndefined();
    expect(reindentAfterContinuation(doc("  u8 x @a\n       @b\n       @c"), 2)).toBeUndefined();
    expect(reindentAfterContinuation(doc("  u8 x\n  u8 y\n  "), 2)).toBeUndefined();
    expect(reindentAfterContinuation(doc("  u8 x @a\n  @b\n  "), 2)).toBeUndefined();
    expect(reindentAfterContinuation(doc("@a\n"), 1)).toBeUndefined();
    expect(reindentAfterContinuation(doc("  u8 x @a\n\n       @b\n "), 3)).toBeUndefined();
  });
});

describe("DiagnosticsStore", () => {
  it("publishes unions per file and only on change", () => {
    const sent: [string, number][] = [];
    const store = new DiagnosticsStore((uri, ds) => sent.push([uri, ds.length]));
    const d = (message: string) => ({
      lsp: { range: r(0, 0, 0, 1), message, severity: 1 as const },
      original: { path: "/a", range: r(0, 0, 0, 1), severity: "error" as const, code: "", message }
    });
    store.set("p1", new Map([["file:///a", [d("x")]]]));
    store.set("p2", new Map([["file:///a", [d("y"), d("x")]]]));
    store.set("p2", new Map([["file:///a", [d("x"), d("y")]]])); // same union: not re-sent
    store.clearSource("p1"); // x is still reported by p2: not re-sent
    store.clearSource("p2");
    expect(sent).toEqual([
      ["file:///a", 1],
      ["file:///a", 2],
      ["file:///a", 0]
    ]);
    expect(store.uris()).toEqual([]);
  });
});

describe("SafeService", () => {
  it("coerces results and reports a missing inner service", () => {
    const logged: string[] = [];
    const reporter = new ErrorReporter({
      error: m => logged.push(m),
      warn() {},
      info() {},
      log() {}
    });
    const dead = new SafeService(undefined, reporter, "x");
    expect(dead.getCompletions("/a", { line: 0, character: 0 })).toEqual([]);
    expect(dead.attempt("decodeSample", () => 1)).toMatchObject({ ok: false });
    const odd = new SafeService({ getHover: () => "string" } as never, reporter, "x");
    expect(odd.getHover("/a", { line: 0, character: 0 })).toBeUndefined();
    expect(odd.getDiagnostics("/a")).toEqual([]); // not a function → TypeError → []
    expect(logged.length).toBe(1);
  });
});

describe("MemoryFileSystem", () => {
  it("reads, lists and is case-insensitive on win32", () => {
    const fs = new MemoryFileSystem("win32", { "C:\\ws\\A.yfl": "a", "c:\\ws\\sub\\b.yfl": "b" });
    expect(fs.readFile("c:\\WS\\a.yfl")).toBe("a");
    expect(fs.fileExists("c:\\ws\\sub\\B.YFL")).toBe(true);
    expect(fs.readDirectory("c:\\ws")).toEqual(["A.yfl", "sub/"]);
    fs.delete("c:\\ws\\a.yfl");
    expect(fs.readFile("c:\\ws\\A.yfl")).toBeUndefined();
    expect([...fs.readBinary("c:\\ws\\sub\\b.yfl")!]).toEqual([98]);
  });
});
