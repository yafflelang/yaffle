import { afterEach, describe, expect, it } from "vitest";
import { SEMANTIC_TOKENS_LEGEND } from "../src/semanticTokens.ts";
import { startTestServer, type TestServer, VSCODE_LIKE_CAPABILITIES } from "./harness.ts";

let t: TestServer | undefined;
afterEach(() => {
  t?.dispose();
  t = undefined;
});

describe("initialize", () => {
  it("advertises every feature the server maps", async () => {
    t = await startTestServer();
    const caps = t.initializeResult!.capabilities;
    expect(t.initializeResult!.serverInfo).toEqual({ name: "yaffle-lsp", version: "0.1.0" });
    expect(caps.positionEncoding).toBe("utf-16");
    expect(caps.textDocumentSync).toEqual({
      openClose: true,
      change: 2,
      save: { includeText: false }
    });
    expect(caps.hoverProvider).toBe(true);
    expect(caps.completionProvider?.triggerCharacters).toEqual(
      expect.arrayContaining([".", "@", "$"])
    );
    expect(caps.signatureHelpProvider?.triggerCharacters).toEqual(["(", ","]);
    expect(caps.definitionProvider).toBe(true);
    expect(caps.referencesProvider).toBe(true);
    expect(caps.documentHighlightProvider).toBe(true);
    expect(caps.renameProvider).toEqual({ prepareProvider: true });
    expect(caps.documentSymbolProvider).toBeTruthy();
    expect(caps.workspaceSymbolProvider).toBe(true);
    expect(caps.inlayHintProvider).toBeTruthy();
    expect(caps.codeLensProvider).toEqual({ resolveProvider: false });
    expect(caps.codeActionProvider).toEqual({
      codeActionKinds: ["quickfix", "refactor", "source"],
      resolveProvider: false
    });
    expect(caps.semanticTokensProvider).toEqual({
      legend: SEMANTIC_TOKENS_LEGEND,
      full: { delta: true },
      range: true
    });
    expect(caps.foldingRangeProvider).toBe(true);
    expect(caps.documentFormattingProvider).toBe(true);
    expect(caps.documentOnTypeFormattingProvider).toEqual({
      firstTriggerCharacter: "@",
      moreTriggerCharacter: ["\n"]
    });
    expect(caps.workspace?.workspaceFolders).toEqual({
      supported: true,
      changeNotifications: true
    });
  });

  it("uses plain rename capability when the client lacks prepareSupport", async () => {
    t = await startTestServer({
      capabilities: { ...VSCODE_LIKE_CAPABILITIES, textDocument: { rename: {} } }
    });
    expect(t.initializeResult!.capabilities.renameProvider).toBe(true);
  });

  it("registers file watchers and configuration change notifications dynamically", async () => {
    t = await startTestServer();
    const watchers = t.registrations.find(r => r.method === "workspace/didChangeWatchedFiles");
    expect(watchers?.registerOptions).toEqual({
      watchers: [{ globPattern: "**/yaffle.json" }, { globPattern: "**/*.yfl" }]
    });
    const config = t.registrations.find(r => r.method === "workspace/didChangeConfiguration");
    expect(config?.registerOptions).toEqual({ section: "yaffle" });
    // the configuration pull follows `initialized` asynchronously
    const server = t;
    await server.waitFor(() => (server.configurationRequests.length ? true : undefined));
    expect(t.configurationRequests).toEqual([{ items: [{ section: "yaffle" }] }]);
  });

  it("does not register anything with a minimal client", async () => {
    t = await startTestServer({ capabilities: {} });
    expect(t.registrations).toEqual([]);
    expect(t.configurationRequests).toEqual([]);
  });

  it("handles shutdown and exit", async () => {
    t = await startTestServer();
    await t.open("/ws/a.yfl", "struct A {\n}\n");
    await t.settle();
    await t.request("shutdown", null);
    await t.client.sendNotification("exit");
    await t.waitFor(() => t!.exitCode, 1000, "exit");
    expect(t.exitCode).toBe(0);
  });
});
