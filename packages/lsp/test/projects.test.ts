import { afterEach, describe, expect, it } from "vitest";
import type * as lsp from "vscode-languageserver";
import { startTestServer, type TestServer, VSCODE_LIKE_CAPABILITIES } from "./harness.ts";

let t: TestServer;
afterEach(() => t?.dispose());

const CREATED = 1;
const CHANGED = 2;
const DELETED = 3;

const CONFIG = JSON.stringify({ sources: ["**/*.yfl"], targets: { ts: { out: "gen" } } });

async function fileEvent(path: string, type: number) {
  await t.client.sendNotification("workspace/didChangeWatchedFiles", {
    changes: [{ uri: t.uri(path), type }]
  });
  await t.settle();
}

describe("project discovery", () => {
  it("uses the nearest yaffle.json upwards", async () => {
    t = await startTestServer({
      workspaceFolders: ["/ws"],
      files: {
        "/ws/yaffle.json": CONFIG,
        "/ws/sub/yaffle.json": JSON.stringify({ sources: ["x/*.yfl"], targets: {} })
      }
    });
    await t.open("/ws/sub/deep/a.yfl", "struct A {}\n");
    await t.open("/ws/b.yfl", "struct B {}\n");
    await t.settle();
    const sub = t.fakeFor("/ws/sub");
    expect(sub.project?.config).toEqual({ sources: ["x/*.yfl"], targets: {} });
    expect(sub.callsTo("updateFile").map(c => c.args[0])).toEqual(["/ws/sub/deep/a.yfl"]);
    const root = t.fakeFor("/ws");
    expect(root.project?.config).toEqual({
      sources: ["**/*.yfl"],
      targets: { ts: { out: "gen" } }
    });
    expect(root.callsTo("updateFile").map(c => c.args[0])).toEqual(["/ws/b.yfl"]);
  });

  it("puts files without a yaffle.json in an inferred project", async () => {
    t = await startTestServer();
    await t.open("/tmp/scratch.yfl", "struct A {}\n");
    await t.settle();
    expect(t.fakes).toHaveLength(1);
    expect(t.fakes[0]!.callsTo("setProject")[0]!.args).toEqual([undefined, undefined]);
  });

  it("loads workspace-root projects at startup, for workspace symbols", async () => {
    t = await startTestServer({ workspaceFolders: ["/ws"], files: { "/ws/yaffle.json": CONFIG } });
    expect(t.fakes).toHaveLength(1);
    expect(t.fakes[0]!.project?.rootDir).toBe("/ws");
    await t.request("workspace/symbol", { query: "x" });
    expect(t.fakes[0]!.callsTo("getWorkspaceSymbols")[0]!.args).toEqual(["x"]);
  });

  it("finds a config on Windows paths, case-insensitively", async () => {
    t = await startTestServer({
      platform: "win32",
      workspaceFolders: ["c:\\ws"],
      files: { "C:\\WS\\yaffle.json": CONFIG }
    });
    await t.open("file:///C:/ws/sub/a.yfl", "struct A {}\n");
    await t.settle();
    const fake = t.fakeFor("c:\\ws");
    expect(fake.callsTo("updateFile")[0]!.args[0]).toBe("c:\\ws\\sub\\a.yfl");
  });

  it("publishes yaffle.json problems on the config file", async () => {
    t = await startTestServer({
      workspaceFolders: ["/ws"],
      files: { "/ws/yaffle.json": '{\n  "sources": "oops",\n  "targets": { "ts": {} }\n}\n' }
    });
    const p = await t.waitForDiagnostics("/ws/yaffle.json", d => d.diagnostics.length === 2);
    expect(p.diagnostics.map(d => [d.code, d.message, d.range.start.line])).toEqual([
      ["invalid-config", '"sources" must be an array of glob strings', 1],
      ["invalid-config", 'Target "ts" needs an "out" directory', 2]
    ]);
  });

  it("publishes problems of nested yaffle.json files when they load", async () => {
    t = await startTestServer({
      workspaceFolders: ["/ws"],
      files: { "/ws/sub/yaffle.json": '{ "sources": 1 }' }
    });
    expect(t.diagnostics("/ws/sub/yaffle.json")).toBeUndefined();
    await t.open("/ws/sub/a.yfl", "struct A {}\n");
    const p = await t.waitForDiagnostics("/ws/sub/yaffle.json", d => d.diagnostics.length === 1);
    expect(p.diagnostics[0]!.message).toBe('"sources" must be an array of glob strings');
    // The project goes away with its last file, and so do its config problems.
    await t.close("/ws/sub/a.yfl");
    await t.waitForDiagnostics("/ws/sub/yaffle.json", d => d.diagnostics.length === 0);
  });

  it("reports a config loader that throws as a config diagnostic", async () => {
    t = await startTestServer({
      workspaceFolders: ["/ws"],
      files: { "/ws/yaffle.json": "{}" },
      serverOptions: {
        loadProjectConfig: () => {
          throw new Error("boom");
        }
      }
    });
    const p = await t.waitForDiagnostics("/ws/yaffle.json", d => d.diagnostics.length === 1);
    expect(p.diagnostics[0]!.message).toBe("Cannot load yaffle.json: boom");
    expect(t.fakes[0]!.callsTo("setProject")[0]!.args).toEqual([undefined, "/ws"]);
  });

  it("uses an injected config loader", async () => {
    t = await startTestServer({
      workspaceFolders: ["/ws"],
      files: { "/ws/yaffle.json": "anything" },
      serverOptions: {
        loadProjectConfig: (path, host) => ({
          config: { sources: [host.readFile(path)!], targets: {} },
          diagnostics: []
        })
      }
    });
    const fake = await t.waitFor(() => t.fakes[0]);
    expect(fake.project?.config).toEqual({ sources: ["anything"], targets: {} });
  });
});

describe("watching yaffle.json", () => {
  it("reloads a project when its yaffle.json changes", async () => {
    t = await startTestServer({ workspaceFolders: ["/ws"], files: { "/ws/yaffle.json": CONFIG } });
    await t.open("/ws/a.yfl", "struct A {}\n");
    await t.settle();
    t.fs.write("/ws/yaffle.json", JSON.stringify({ sources: ["new/**"], targets: {} }));
    const diagnosticsCalls = t.fakes[0]!.callsTo("getDiagnostics").length;
    await fileEvent("/ws/yaffle.json", CHANGED);
    expect(t.fakes[0]!.project?.config?.sources).toEqual(["new/**"]);
    expect(t.fakes[0]!.callsTo("getDiagnostics").length).toBeGreaterThan(diagnosticsCalls);
    expect(t.refreshes).toEqual(
      expect.arrayContaining([
        "workspace/inlayHint/refresh",
        "workspace/codeLens/refresh",
        "workspace/semanticTokens/refresh"
      ])
    );
  });

  it("moves open files into a project when a yaffle.json appears above them", async () => {
    t = await startTestServer({ workspaceFolders: ["/ws"] });
    await t.open("/ws/sub/a.yfl", "ERROR\n");
    await t.settle();
    const inferred = t.fakes[0]!;
    expect(inferred.project?.rootDir).toBeUndefined();

    t.fs.write("/ws/sub/yaffle.json", CONFIG);
    await fileEvent("/ws/sub/yaffle.json", CREATED);
    const sub = t.fakeFor("/ws/sub");
    expect(sub.callsTo("updateFile").map(c => c.args)).toEqual([["/ws/sub/a.yfl", "ERROR\n"]]);
    expect(inferred.callsTo("closeFile").map(c => c.args[0])).toContain("/ws/sub/a.yfl");
    // The inferred project had no files left: it's gone.
    expect(inferred.callsTo("dispose")).toHaveLength(1);
    expect((await t.waitForDiagnostics("/ws/sub/a.yfl")).diagnostics).toHaveLength(1);
  });

  it("moves files back out when the yaffle.json is deleted", async () => {
    t = await startTestServer({
      workspaceFolders: ["/ws"],
      files: { "/ws/yaffle.json": CONFIG, "/ws/sub/yaffle.json": CONFIG }
    });
    await t.open("/ws/sub/a.yfl", "struct A {}\n");
    await t.settle();
    const sub = t.fakeFor("/ws/sub");
    t.fs.delete("/ws/sub/yaffle.json");
    await fileEvent("/ws/sub/yaffle.json", DELETED);
    expect(sub.callsTo("dispose")).toHaveLength(1);
    expect(
      t
        .fakeFor("/ws")
        .callsTo("updateFile")
        .map(c => c.args[0])
    ).toEqual(["/ws/sub/a.yfl"]);
  });

  it("drops a pinned workspace project when its yaffle.json is deleted", async () => {
    t = await startTestServer({
      workspaceFolders: ["/ws"],
      files: { "/ws/yaffle.json": "{ not json" }
    });
    await t.waitForDiagnostics("/ws/yaffle.json", d => d.diagnostics.length === 1);
    t.fs.delete("/ws/yaffle.json");
    await fileEvent("/ws/yaffle.json", DELETED);
    expect(t.fakes[0]!.callsTo("dispose")).toHaveLength(1);
    // Its config diagnostics are cleared.
    expect(t.diagnostics("/ws/yaffle.json")?.diagnostics).toEqual([]);
  });
});

describe("watching source files", () => {
  it("re-checks importers when an imported file changes on disk", async () => {
    t = await startTestServer({
      workspaceFolders: ["/ws"],
      files: { "/ws/yaffle.json": CONFIG, "/ws/b.yfl": "struct B {}\n" }
    });
    const a = await t.open("/ws/a.yfl", 'import { B } from "./b.yfl"\n');
    await t.settle();
    expect(t.diagnostics(a)?.diagnostics ?? []).toEqual([]);
    t.fs.write("/ws/b.yfl", "struct B { ERROR }\n");
    await fileEvent("/ws/b.yfl", CHANGED);
    const fake = t.fakes[0]!;
    expect(fake.callsTo("filesChanged").map(c => c.args[0])).toEqual([["/ws/b.yfl"]]);
    const p = await t.waitForDiagnostics(a, d => d.diagnostics.length === 1);
    expect(p.diagnostics[0]!.code).toBe("import-has-errors");
  });

  it("re-checks when a missing import is created", async () => {
    t = await startTestServer({ workspaceFolders: ["/ws"] });
    const a = await t.open("/ws/a.yfl", 'import { B } from "./b.yfl"\n');
    await t.waitForDiagnostics(a, d => d.diagnostics[0]?.code === "unresolved-import");
    t.fs.write("/ws/b.yfl", "struct B {}\n");
    await fileEvent("/ws/b.yfl", CREATED);
    await t.waitForDiagnostics(a, d => d.diagnostics.length === 0);
  });

  it("notifies a project of created/deleted files under its root even if unread", async () => {
    t = await startTestServer({ workspaceFolders: ["/ws"], files: { "/ws/yaffle.json": CONFIG } });
    await fileEvent("/ws/new.yfl", CREATED);
    expect(t.fakes[0]!.callsTo("filesChanged").map(c => c.args[0])).toEqual([["/ws/new.yfl"]]);
    await fileEvent("/elsewhere/new.yfl", CREATED);
    expect(t.fakes[0]!.callsTo("filesChanged")).toHaveLength(1);
  });

  it("ignores disk events for files open in the editor", async () => {
    t = await startTestServer({ workspaceFolders: ["/ws"], files: { "/ws/yaffle.json": CONFIG } });
    await t.open("/ws/a.yfl", "struct A {}\n");
    await t.settle();
    await fileEvent("/ws/a.yfl", CHANGED);
    expect(t.fakes[0]!.callsTo("filesChanged")).toEqual([]);
  });

  it("falls back to closeFile for services without filesChanged", async () => {
    t = await startTestServer({
      workspaceFolders: ["/ws"],
      files: { "/ws/yaffle.json": CONFIG, "/ws/b.yfl": "struct B {}\n" }
    });
    t.configureFakes(f => {
      (f as unknown as { filesChanged: undefined }).filesChanged = undefined;
    });
    await t.open("/ws/a.yfl", 'import { B } from "./b.yfl"\n');
    await t.settle();
    await fileEvent("/ws/b.yfl", CHANGED);
    expect(t.fakes[0]!.callsTo("closeFile").map(c => c.args[0])).toEqual(["/ws/b.yfl"]);
  });

  it("watches imported files outside the workspace", async () => {
    t = await startTestServer({
      workspaceFolders: ["/ws"],
      files: { "/lib/common.yfl": "struct C {}\n" }
    });
    await t.open("/ws/a.yfl", 'import { C } from "../lib/common.yfl"\n');
    const reg = await t.waitFor(
      () =>
        t.registrations.find(
          r =>
            r.method === "workspace/didChangeWatchedFiles" &&
            JSON.stringify(r.registerOptions).includes("file:///lib")
        ),
      2000,
      "external watcher"
    );
    expect(reg.registerOptions).toEqual({
      watchers: [
        { globPattern: { baseUri: "file:///lib", pattern: "{*.yfl,yaffle.json}" }, kind: 7 }
      ]
    });
  });

  it("doesn't register external watchers without relative pattern support", async () => {
    t = await startTestServer({
      workspaceFolders: ["/ws"],
      files: { "/lib/common.yfl": "struct C {}\n" },
      capabilities: {
        ...VSCODE_LIKE_CAPABILITIES,
        workspace: {
          ...VSCODE_LIKE_CAPABILITIES.workspace,
          didChangeWatchedFiles: { dynamicRegistration: true }
        }
      }
    });
    await t.open("/ws/a.yfl", 'import { C } from "../lib/common.yfl"\n');
    await t.settle();
    expect(
      t.registrations.filter(r => r.method === "workspace/didChangeWatchedFiles")
    ).toHaveLength(1);
  });
});

describe("project-wide diagnostics", () => {
  const files = {
    "/ws/yaffle.json": CONFIG,
    "/ws/a.yfl": "struct A { ERROR }\n",
    "/ws/b.yfl": "struct B {}\n"
  };
  const setupFake = (f: { projectFiles: string[] }) => {
    f.projectFiles = ["/ws/a.yfl", "/ws/b.yfl"];
  };

  it("checks project files that aren't open when the service lists them", async () => {
    t = await startTestServer({ workspaceFolders: ["/ws"], files, setupFake });
    const p = await t.waitForDiagnostics("/ws/a.yfl", d => d.diagnostics.length === 1);
    expect(p.version).toBeUndefined();
    const checked = t.fakes[0]!.callsTo("getDiagnostics").map(c => c.args[0]);
    expect(checked).toEqual(expect.arrayContaining(["/ws/a.yfl", "/ws/b.yfl"]));
    // Fixing the file on disk clears it.
    t.fs.write("/ws/a.yfl", "struct A {}\n");
    await fileEvent("/ws/a.yfl", CHANGED);
    await t.waitForDiagnostics("/ws/a.yfl", d => d.diagnostics.length === 0);
  });

  it("re-checks when diagnostics.scope changes", async () => {
    t = await startTestServer({ workspaceFolders: ["/ws"], files, setupFake });
    await t.waitForDiagnostics("/ws/a.yfl", d => d.diagnostics.length === 1);
    t.configuration = { diagnostics: { scope: "openFiles" } };
    await t.client.sendNotification("workspace/didChangeConfiguration", { settings: null });
    await t.waitForDiagnostics("/ws/a.yfl", d => d.diagnostics.length === 0);
    t.configuration = { diagnostics: { scope: "project" } };
    await t.client.sendNotification("workspace/didChangeConfiguration", { settings: null });
    await t.waitForDiagnostics("/ws/a.yfl", d => d.diagnostics.length === 1);
  });

  it("only checks open files with diagnostics.scope = openFiles", async () => {
    t = await startTestServer({
      workspaceFolders: ["/ws"],
      files,
      setupFake,
      configuration: { diagnostics: { scope: "openFiles" } }
    });
    await t.settle();
    expect(t.diagnostics("/ws/a.yfl")).toBeUndefined();
    expect(t.fakes[0]!.callsTo("getProjectFiles")).toEqual([]);
  });

  it("falls back to open files for services that can't list files", async () => {
    t = await startTestServer({
      workspaceFolders: ["/ws"],
      files,
      setupFake: f => {
        (f as unknown as { getProjectFiles: undefined }).getProjectFiles = undefined;
      }
    });
    await t.open("/ws/b.yfl", "struct B { ERROR }\n");
    await t.waitForDiagnostics("/ws/b.yfl", d => d.diagnostics.length === 1);
    expect(t.diagnostics("/ws/a.yfl")).toBeUndefined();
  });
});

describe("multiple projects", () => {
  it("merges diagnostics two projects report for the same file", async () => {
    t = await startTestServer({
      workspaceFolders: ["/ws"],
      files: { "/ws/p1/yaffle.json": CONFIG, "/ws/p2/yaffle.json": CONFIG }
    });
    await t.open("/ws/p1/a.yfl", "ELSEWHERE /ws/shared.yfl\n");
    await t.open("/ws/p2/b.yfl", "ELSEWHERE /ws/shared.yfl\n");
    const p = await t.waitForDiagnostics("/ws/shared.yfl", d => d.diagnostics.length === 2);
    expect(p.diagnostics.map(d => d.message).sort()).toEqual([
      "Reported from /ws/p1/a.yfl",
      "Reported from /ws/p2/b.yfl"
    ]);
    await t.change("/ws/p1/a.yfl", "nothing\n");
    const after = await t.waitForDiagnostics("/ws/shared.yfl", d => d.diagnostics.length === 1);
    expect(after.diagnostics[0]!.message).toBe("Reported from /ws/p2/b.yfl");
  });

  it("lets a project read another project's unsaved file contents", async () => {
    t = await startTestServer({
      workspaceFolders: ["/ws"],
      files: {
        "/ws/p1/yaffle.json": CONFIG,
        "/ws/p2/yaffle.json": CONFIG,
        "/ws/p2/b.yfl": "struct B {}\n"
      }
    });
    const a = await t.open("/ws/p1/a.yfl", 'import { B } from "../p2/b.yfl"\n');
    await t.settle();
    expect(t.diagnostics(a)?.diagnostics ?? []).toEqual([]);
    // b.yfl opens in p2 with unsaved errors: p1 sees them through the overlay.
    await t.open("/ws/p2/b.yfl", "struct B { ERROR }\n");
    const p = await t.waitForDiagnostics(a, d => d.diagnostics.length === 1);
    expect(p.diagnostics[0]!.code).toBe("import-has-errors");
    const p1 = t.fakeFor("/ws/p1");
    expect(p1.callsTo("filesChanged").map(c => c.args[0])).toEqual([["/ws/p2/b.yfl"]]);
    // Closing b reverts p1 to the disk contents.
    await t.close("/ws/p2/b.yfl");
    await t.waitForDiagnostics(a, d => d.diagnostics.length === 0);
  });

  it("routes workspace symbols through every project", async () => {
    t = await startTestServer({
      workspaceFolders: ["/ws"],
      files: { "/ws/p1/yaffle.json": CONFIG, "/ws/p2/yaffle.json": CONFIG }
    });
    await t.open("/ws/p1/a.yfl", "struct Alpha {\n}\n");
    await t.open("/ws/p2/b.yfl", "struct Beta {\n}\n");
    await t.settle();
    const symbols = await t.request<lsp.SymbolInformation[]>("workspace/symbol", { query: "" });
    expect(symbols.map(s => s.name).sort()).toEqual(["Alpha", "Beta"]);
  });
});

describe("workspace folders and settings", () => {
  it("loads and unloads projects as workspace folders change", async () => {
    t = await startTestServer({
      workspaceFolders: ["/ws"],
      files: { "/other/yaffle.json": CONFIG }
    });
    expect(t.fakes).toHaveLength(0);
    await t.client.sendNotification("workspace/didChangeWorkspaceFolders", {
      event: { added: [{ uri: t.uri("/other"), name: "other" }], removed: [] }
    });
    await t.settle();
    expect(t.fakes).toHaveLength(1);
    expect(t.fakes[0]!.project?.rootDir).toBe("/other");
    await t.client.sendNotification("workspace/didChangeWorkspaceFolders", {
      event: { added: [], removed: [{ uri: t.uri("/other"), name: "other" }] }
    });
    await t.settle();
    expect(t.fakes[0]!.callsTo("dispose")).toHaveLength(1);
  });

  it("pulls settings on change and refreshes inlay hints when toggled", async () => {
    t = await startTestServer({ workspaceFolders: ["/ws"] });
    const uri = await t.open("/ws/a.yfl", "struct A {\n  u32 count\n}\n");
    await t.settle();
    const range = { start: { line: 0, character: 0 }, end: { line: 3, character: 0 } };
    expect(
      await t.request<unknown[]>("textDocument/inlayHint", { textDocument: { uri }, range })
    ).toHaveLength(1);
    t.configuration = {
      inlayHints: { enabled: false },
      codeLens: { enabled: false },
      format: { enabled: false }
    };
    t.refreshes.length = 0;
    await t.client.sendNotification("workspace/didChangeConfiguration", { settings: null });
    await t.settle();
    expect(t.server.currentSettings.inlayHints.enabled).toBe(false);
    expect(t.refreshes).toEqual(["workspace/inlayHint/refresh", "workspace/codeLens/refresh"]);
    expect(
      await t.request<unknown[]>("textDocument/inlayHint", { textDocument: { uri }, range })
    ).toEqual([]);
    expect(await t.request<unknown[]>("textDocument/codeLens", { textDocument: { uri } })).toEqual(
      []
    );
    expect(
      await t.request("textDocument/formatting", {
        textDocument: { uri },
        options: { tabSize: 2, insertSpaces: true }
      })
    ).toBeNull();
  });

  it("takes pushed settings from clients without workspace/configuration", async () => {
    t = await startTestServer({ capabilities: {} });
    await t.client.sendNotification("workspace/didChangeConfiguration", {
      settings: { yaffle: { diagnostics: { delay: 42 }, codeLens: { enabled: false } } }
    });
    await t.settle();
    expect(t.server.currentSettings.diagnostics.delay).toBe(42);
    expect(t.server.currentSettings.codeLens.enabled).toBe(false);
  });

  it("accepts settings in initializationOptions", async () => {
    t = await startTestServer({
      capabilities: {},
      initializationOptions: { settings: { "inlayHints.enabled": false } }
    });
    expect(t.server.currentSettings.inlayHints.enabled).toBe(false);
  });
});
