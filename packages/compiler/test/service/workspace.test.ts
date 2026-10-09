import { describe, expect, it } from "vitest";
import { createLanguageService } from "../../src/service/index.ts";
import { host, open } from "./util.ts";

describe("language service: diagnostics and workspace", () => {
  it("reports diagnostics for an open file", () => {
    const { ls, path } = open("struct S { u32 count  u8 d[cnt] }");
    const d = ls.getDiagnostics(path);
    expect(d.map(x => [x.code, x.path, x.range.start])).toEqual([
      ["unknown-name", path, { line: 0, character: 27 }]
    ]);
    expect(d[0]!.fixes?.[0]?.title).toBe("Change to 'count'");
  });

  it("updates diagnostics when the file changes", () => {
    const { ls, path } = open("struct S { u8 d[n] }");
    expect(ls.getDiagnostics(path).length).toBe(1);
    ls.updateFile(path, "struct S { u8 n  u8 d[n] }");
    expect(ls.getDiagnostics(path)).toEqual([]);
  });

  it("routes diagnostics to the file they belong to", () => {
    const ls = createLanguageService(host({ "/w/lib.yfl": "export struct L { u8 x[nope] }" }));
    ls.updateFile("/w/main.yfl", 'import { L } from "./lib.yfl"\nexport struct M { L l }');
    expect(ls.getDiagnostics("/w/main.yfl")).toEqual([]);
    expect(ls.getDiagnostics("/w/lib.yfl").map(d => d.code)).toEqual(["unknown-name"]);
  });

  it("falls back to the host's contents on close", () => {
    const h = host({ "/w/a.yfl": "struct A { u8 x }" });
    const ls = createLanguageService(h);
    ls.updateFile("/w/a.yfl", "struct A { u8 x[nope] }");
    expect(ls.getDiagnostics("/w/a.yfl").length).toBe(1);
    ls.closeFile("/w/a.yfl");
    expect(ls.getDiagnostics("/w/a.yfl")).toEqual([]);
  });

  it("re-reads files changed on disk", () => {
    const h = host({ "/w/lib.yfl": "export struct L { u8 x }" });
    const ls = createLanguageService(h);
    ls.updateFile("/w/main.yfl", 'import { L } from "./lib.yfl"\nexport struct M { L l }');
    expect(ls.getDiagnostics("/w/main.yfl")).toEqual([]);
    h.files["/w/lib.yfl"] = "export struct Other { u8 x }";
    ls.filesChanged(["/w/lib.yfl"]);
    expect(ls.getDiagnostics("/w/main.yfl").map(d => d.code)).toContain("unknown-import-name");
  });

  it("expands project sources through the host and lists project files", () => {
    const h = host({
      "/p/yaffle.json": "{}",
      "/p/formats/a.yfl": 'import { C } from "../lib/c.yfl"\nexport struct A { C c }',
      "/p/formats/sub/b.yfl": "export struct B { u8 x[oops] }",
      "/p/lib/c.yfl": "export struct C { u8 v }",
      "/p/formats/notes.txt": "not yaffle"
    });
    const ls = createLanguageService(h);
    ls.setProject({ sources: ["formats/**/*.yfl"], targets: {} }, "/p");
    expect(ls.getProjectFiles()).toEqual([
      "/p/formats/a.yfl",
      "/p/formats/sub/b.yfl",
      "/p/lib/c.yfl"
    ]);
    expect(ls.getDiagnostics("/p/formats/sub/b.yfl").map(d => d.code)).toEqual(["unknown-name"]);
    ls.setProject(undefined, undefined);
    expect(ls.getProjectFiles()).toEqual([]);
  });

  it("checks extern implementations against the project's targets", () => {
    const { ls, path } = open("extern codec zstd\nexport struct S { u8 x }");
    expect(ls.getDiagnostics(path)).toEqual([]);
    ls.setProject({ sources: [], targets: { ts: { out: "gen" } } }, "/w");
    expect(ls.getDiagnostics(path).map(d => d.code)).toEqual(["extern-missing-implementation"]);
  });

  it("module paths are relative to the project root", () => {
    const { ls, path } = open("export struct S { u8 x }", "/w/sub/main.yfl");
    ls.setProject({ sources: [], targets: {} }, "/w");
    expect(ls.getDiagnostics(path)).toEqual([]);
  });

  it("works with virtual untitled paths and win32-style paths", () => {
    for (const p of [
      "/untitled/Untitled-1.yfl",
      "/__yaffle_virtual__/untitled/Untitled-1",
      "\\\\yaffle-virtual\\untitled\\Untitled-1",
      "c:/work/main.yfl",
      "c:\\work\\main.yfl"
    ]) {
      const ls = createLanguageService(host({}, false));
      ls.updateFile(p, "struct S { u32 count  u8 d[cnt] }");
      const d = ls.getDiagnostics(p);
      expect(
        d.map(x => [x.code, x.path]),
        p
      ).toEqual([["unknown-name", p]]);
      expect(ls.getHover(p, { line: 0, character: 17 })?.contents, p).toContain("u32 count");
    }
  });

  it("reports unresolvable imports from virtual documents as a normal diagnostic", () => {
    const ls = createLanguageService(host({}, false));
    const p = "/__yaffle_virtual__/untitled/Untitled-1";
    ls.updateFile(p, 'import { A } from "./a.yfl"\nstruct S { u8 x }');
    expect(ls.getDiagnostics(p).map(d => d.code)).toEqual(["import-not-found"]);
  });

  it("resolves imports with win32 paths", () => {
    const ls = createLanguageService(host({ "c:\\w\\lib.yfl": "export struct L { u8 x }" }, false));
    ls.updateFile("c:\\w\\main.yfl", 'import { L } from "./lib.yfl"\nexport struct M { L l }');
    expect(ls.getDiagnostics("c:\\w\\main.yfl")).toEqual([]);
  });

  it("caches parses: an unchanged file isn't re-parsed", () => {
    const { ls, path, text } = open("struct S { u8 x }");
    const a = ls.getDocumentSymbols(path);
    ls.updateFile(path, text);
    const b = ls.getDocumentSymbols(path);
    expect(b).toEqual(a);
  });

  it("dispose drops everything", () => {
    const { ls, path } = open("struct S { u8 x[nope] }");
    expect(ls.getDiagnostics(path).length).toBe(1);
    ls.dispose();
    // the file is gone from the overlay: it isn't in the host either
    expect(ls.getDocumentSymbols(path)).toEqual([]);
  });

  it("decodeSample and suggestLayout reject with user-facing errors", async () => {
    const { ls, path } = open("export struct S { u8 x }");
    await expect(ls.decodeSample(path, "Nope", new Uint8Array(4))).rejects.toThrow(
      "No struct `Nope` in main.yfl. Exported structs: S."
    );
    await expect(ls.suggestLayout(path, "Nope", new Uint8Array(4))).rejects.toThrow(
      "No struct `Nope`"
    );
    const broken = open("export struct S { u8 x[nope] }");
    await expect(broken.ls.decodeSample(broken.path, "S", new Uint8Array(0))).rejects.toThrow(
      "main.yfl has 1 error; fix it before decoding a sample."
    );
    ls.dispose();
    broken.ls.dispose();
  });

  it("never throws on broken input", () => {
    const texts = [
      "",
      "struct",
      "struct S {",
      "struct S { u8 x[",
      "@@@",
      "struct S { switch (",
      "import {",
      "export",
      "struct S { if (x) {",
      'struct S { char t[4] = "PA'
    ];
    for (const t of texts) {
      const { ls, path } = open(t);
      expect(() => {
        ls.getDiagnostics(path);
        ls.getHover(path, { line: 0, character: t.length });
        ls.getCompletions(path, { line: 0, character: t.length });
        ls.getSignatureHelp(path, { line: 0, character: t.length });
        ls.getDocumentSymbols(path);
        ls.getSemanticTokens(path);
        ls.getFoldingRanges(path);
        ls.getInlayHints(path, {
          start: { line: 0, character: 0 },
          end: { line: 9, character: 0 }
        });
        ls.getCodeLenses(path);
        ls.format(path);
        ls.getDefinition(path, { line: 0, character: 3 });
        ls.getReferences(path, { line: 0, character: 3 }, true);
        ls.prepareRename(path, { line: 0, character: 8 });
      }, t).not.toThrow();
    }
  });
});
