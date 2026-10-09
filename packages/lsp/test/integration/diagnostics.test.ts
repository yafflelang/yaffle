/**
 * Diagnostics end to end on the real compiler: the test project is clean, edits produce and clear
 * diagnostics, and changes propagate across files (open and unopened importers).
 */
import { afterEach, describe, expect, it } from "vitest";
import type * as lsp from "vscode-languageserver";
import type { TestServer } from "../harness.ts";
import { errorLogs, find, PROJECT, startRealServer, validRange, WS } from "./realServer.ts";

let t: TestServer;
afterEach(() => t?.dispose());

const nonEmpty = (t: TestServer) =>
  t.published
    .filter(p => p.diagnostics.length > 0)
    .map(p => `${p.uri}: ${p.diagnostics.map(d => d.message).join("; ")}`);

describe("diagnostics on the test project", () => {
  it("the whole project is checked at startup and every file is clean", async () => {
    t = await startRealServer();
    await t.settle();
    // nothing published with problems, and the service read every format
    expect(nonEmpty(t)).toEqual([]);
    for (const name of Object.keys(PROJECT)) {
      await t.open(`${WS}/${name}`, PROJECT[name]!);
    }
    await t.settle();
    expect(nonEmpty(t)).toEqual([]);
    expect(errorLogs(t)).toEqual([]);
  });

  it("an edit produces a diagnostic with code, range and version, and undoing it clears it", async () => {
    t = await startRealServer();
    const path = `${WS}/archive.yfl`;
    const text = PROJECT["archive.yfl"]!;
    await t.open(path, text);
    await t.settle();
    const at = find(text, "Entry   entries");
    await t.change(path, [
      { range: { start: at, end: { ...at, character: at.character + 5 } }, text: "Entrx" }
    ]);
    const p = await t.waitForDiagnostics(path, d => d.diagnostics.length > 0, 10_000);
    expect(p.version).toBe(2);
    const d = p.diagnostics[0]!;
    expect(d.source).toBe("yaffle");
    expect(d.code).toBe("unknown-type");
    expect(d.message).toContain("Entrx");
    expect(d.range).toEqual({ start: at, end: { ...at, character: at.character + 5 } });
    await t.change(path, text);
    const cleared = await t.waitForDiagnostics(path, d => d.diagnostics.length === 0, 10_000);
    expect(cleared.version).toBe(3);
    expect(errorLogs(t)).toEqual([]);
  });

  it("renaming an imported struct breaks its open importer; renaming it back fixes it", async () => {
    t = await startRealServer();
    const notes = `${WS}/notes.yfl`;
    const archive = `${WS}/archive.yfl`;
    await t.open(archive, PROJECT["archive.yfl"]!);
    await t.open(notes, PROJECT["notes.yfl"]!);
    await t.settle();
    const broken = PROJECT["notes.yfl"]!.replace("struct Comment", "struct Comment2");
    await t.change(notes, broken);
    const p = await t.waitForDiagnostics(archive, d => d.diagnostics.length > 0, 10_000);
    expect(p.diagnostics.map(d => d.message).join("\n")).toContain("Comment");
    // the related import line points into archive.yfl
    for (const d of p.diagnostics) expect(validRange(PROJECT["archive.yfl"]!, d.range)).toBe(true);
    await t.change(notes, PROJECT["notes.yfl"]!);
    await t.waitForDiagnostics(archive, d => d.diagnostics.length === 0, 10_000);
    expect(errorLogs(t)).toEqual([]);
  });

  it("files that aren't open get diagnostics too (project scope), and lose them again", async () => {
    t = await startRealServer();
    const common = `${WS}/common.yfl`;
    const archive = `${WS}/archive.yfl`;
    await t.open(common, PROJECT["common.yfl"]!);
    await t.settle();
    await t.change(common, PROJECT["common.yfl"]!.replace(/struct Attrs\b/, "struct Attrs2"));
    const p = await t.waitForDiagnostics(archive, d => d.diagnostics.length > 0, 10_000);
    expect(p.version).toBeUndefined();
    expect(p.diagnostics.some(d => String(d.message).includes("Attrs"))).toBe(true);
    await t.change(common, PROJECT["common.yfl"]!);
    await t.waitForDiagnostics(archive, d => d.diagnostics.length === 0, 10_000);
  });

  it("a syntax error is reported where it is, and the rest of the file still analyzes", async () => {
    t = await startRealServer();
    const path = `${WS}/chunks.yfl`;
    const text = PROJECT["chunks.yfl"]!;
    await t.open(path, text);
    await t.settle();
    const at = find(text, "struct Slot {");
    await t.change(path, [{ range: { start: at, end: at }, text: "struct Broken { u8 a[ }\n" }]);
    const p = await t.waitForDiagnostics(path, d => d.diagnostics.length > 0, 10_000);
    const errors = p.diagnostics.filter(d => d.severity === 1);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every(d => d.range.start.line === at.line)).toBe(true);
    // hover still works below the error
    const uri = t.uri(path);
    const hover = await t.request<lsp.Hover | null>("textDocument/hover", {
      textDocument: { uri },
      position: find(
        text.replace("struct Slot {", "struct Broken { u8 a[ }\nstruct Slot {"),
        "Pair    pairs",
        0,
        2
      )
    });
    expect(hover).not.toBeNull();
  });

  it("problems in yaffle.json are published on the config file", async () => {
    t = await startRealServer({
      files: { "/ws/bad/yaffle.json": '{ "sources": 3 }', "/ws/bad/a.yfl": "struct A { u8 x }\n" },
      workspaceFolders: ["/ws/bad"]
    });
    await t.settle();
    const p = await t.waitForDiagnostics(
      "/ws/bad/yaffle.json",
      d => d.diagnostics.length > 0,
      10_000
    );
    expect(p.diagnostics[0]!.source).toBe("yaffle");
  });
});
