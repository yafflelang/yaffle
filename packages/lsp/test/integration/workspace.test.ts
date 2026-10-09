/**
 * Workspace-level behaviour on the real compiler: on-disk changes reported by the file watcher,
 * yaffle.json changes, files outside any project, untitled documents, and Windows paths.
 */
import { afterEach, describe, expect, it } from "vitest";
import type * as lsp from "vscode-languageserver";
import type { TestServer } from "../harness.ts";
import { errorLogs, find, PROJECT, PROJECT_CONFIG, startRealServer, WS } from "./realServer.ts";

let t: TestServer;
afterEach(() => t?.dispose());

const CHANGED = 2;
const CREATED = 1;
const DELETED = 3;

describe("files on disk", () => {
  it("an imported file changed on disk updates its open importer", async () => {
    t = await startRealServer();
    const archive = `${WS}/archive.yfl`;
    await t.open(archive, PROJECT["archive.yfl"]!);
    await t.settle();
    t.fs.write(
      `${WS}/notes.yfl`,
      PROJECT["notes.yfl"]!.replace("struct Comment", "struct Renamed")
    );
    await t.client.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri: t.uri(`${WS}/notes.yfl`), type: CHANGED }]
    });
    await t.waitForDiagnostics(archive, d => d.diagnostics.length > 0, 10_000);
    t.fs.write(`${WS}/notes.yfl`, PROJECT["notes.yfl"]!);
    await t.client.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri: t.uri(`${WS}/notes.yfl`), type: CHANGED }]
    });
    await t.waitForDiagnostics(archive, d => d.diagnostics.length === 0, 10_000);
  });

  it("a deleted import is reported, and recreating it fixes the importer", async () => {
    t = await startRealServer();
    const archive = `${WS}/archive.yfl`;
    await t.open(archive, PROJECT["archive.yfl"]!);
    await t.settle();
    t.fs.delete(`${WS}/common.yfl`);
    await t.client.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri: t.uri(`${WS}/common.yfl`), type: DELETED }]
    });
    const p = await t.waitForDiagnostics(archive, d => d.diagnostics.length > 0, 10_000);
    expect(p.diagnostics.map(d => d.code)).toContain("import-not-found");
    t.fs.write(`${WS}/common.yfl`, PROJECT["common.yfl"]!);
    await t.client.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri: t.uri(`${WS}/common.yfl`), type: CREATED }]
    });
    await t.waitForDiagnostics(archive, d => d.diagnostics.length === 0, 10_000);
  });

  it("a broken yaffle.json is reported on it, and fixing it clears that", async () => {
    t = await startRealServer();
    await t.open(`${WS}/archive.yfl`, PROJECT["archive.yfl"]!);
    await t.settle();
    t.fs.write(`${WS}/yaffle.json`, "{ not json");
    await t.client.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri: t.uri(`${WS}/yaffle.json`), type: CHANGED }]
    });
    await t.waitForDiagnostics(`${WS}/yaffle.json`, d => d.diagnostics.length > 0, 10_000);
    t.fs.write(`${WS}/yaffle.json`, PROJECT_CONFIG);
    await t.client.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri: t.uri(`${WS}/yaffle.json`), type: CHANGED }]
    });
    await t.waitForDiagnostics(`${WS}/yaffle.json`, d => d.diagnostics.length === 0, 10_000);
    expect(errorLogs(t)).toEqual([]);
  });
});

describe("documents outside a project", () => {
  it("a loose file and an untitled document get the full service", async () => {
    t = await startRealServer();
    const loose = "/elsewhere/loose.yfl";
    const text = "struct Loose {\n  u32 n\n  u8  data[n]\n}\n";
    await t.open(loose, text);
    const untitled = "untitled:Untitled-1";
    await t.open(untitled, "export struct U{u16 n;Nope x[n]}\n");
    const p = await t.waitForDiagnostics(untitled, d => d.diagnostics.length > 0, 10_000);
    expect(p.diagnostics[0]!.code).toBe("unknown-type");
    const hover = await t.request<lsp.Hover>("textDocument/hover", {
      textDocument: { uri: t.uri(loose) },
      position: find(text, "u8  da|ta")
    });
    expect((hover.contents as lsp.MarkupContent).value).toContain("u8 data[n]");
    const fmt = await t.request<lsp.TextEdit[]>("textDocument/formatting", {
      textDocument: { uri: untitled },
      options: { tabSize: 2, insertSpaces: true }
    });
    expect(fmt).toHaveLength(1);
    expect(errorLogs(t)).toEqual([]);
  });
});

describe("Windows paths", () => {
  const root = "C:\\ws\\project";
  const winFiles = (): Record<string, string> => {
    const files: Record<string, string> = { [`${root}\\yaffle.json`]: PROJECT_CONFIG };
    for (const [name, text] of Object.entries(PROJECT)) files[`${root}\\${name}`] = text;
    return files;
  };

  it("imports resolve, navigation and rename work across files, URIs keep the client's spelling", async () => {
    t = await startRealServer({ platform: "win32", files: winFiles(), workspaceFolders: [root] });
    const archivePath = `${root}\\archive.yfl`;
    // VS Code sends lower-case drive letters, percent-encoded
    const archiveUri = "file:///c%3A/ws/project/archive.yfl";
    const archive = PROJECT["archive.yfl"]!;
    await t.open(archiveUri, archive);
    await t.settle();
    expect(t.diagnostics(archiveUri)?.diagnostics ?? []).toEqual([]);
    const def = await t.request<lsp.Location[]>("textDocument/definition", {
      textDocument: { uri: archiveUri },
      position: find(archive, "  Comm|ent *note")
    });
    expect(def).toHaveLength(1);
    expect(def[0]!.uri.toLowerCase()).toMatch(/^file:\/\/\/c(%3a|:)\/ws\/project\/notes\.yfl$/);
    const edit = await t.request<lsp.WorkspaceEdit>("textDocument/rename", {
      textDocument: { uri: archiveUri },
      position: find(archive, "  Comm|ent *note"),
      newName: "Models"
    });
    const uris = (edit.documentChanges ?? []).map(d =>
      "textDocument" in d ? d.textDocument.uri : ""
    );
    expect(uris).toContain(archiveUri);
    expect(uris.some(u => /notes\.yfl$/i.test(u))).toBe(true);
    // an error in a file is published on the URI the client used
    await t.change(archiveUri, archive.replace("Entry   entries", "Entrx   entries"));
    const p = await t.waitForDiagnostics(archiveUri, d => d.diagnostics.length > 0, 10_000);
    expect(p.uri).toBe(archiveUri);
    void archivePath;
    expect(errorLogs(t)).toEqual([]);
  });
});
