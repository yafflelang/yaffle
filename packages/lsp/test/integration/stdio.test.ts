/**
 * The real executable (src/main.ts, no --service: the compiler wired in by default) over stdio,
 * on the test project written to a temporary directory.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import type * as lsp from "vscode-languageserver";
import {
  createProtocolConnection,
  type ProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter
} from "vscode-languageserver-protocol/node";
import { find, PROJECT, PROJECT_CONFIG } from "./realServer.ts";

const MAIN = fileURLToPath(new URL("../../src/main.ts", import.meta.url));

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "yaffle-lsp-stdio-"));
  writeFileSync(join(dir, "yaffle.json"), PROJECT_CONFIG);
  for (const [name, text] of Object.entries(PROJECT)) writeFileSync(join(dir, name), text);
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

let child: ChildProcess | undefined;
let client: ProtocolConnection | undefined;
afterEach(() => {
  client?.dispose();
  child?.kill();
});

async function until<T>(check: () => T | undefined, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

it("serves the test project with the real compiler", async () => {
  child = spawn(process.execPath, ["--conditions=development", MAIN, "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  const exited = new Promise<number | null>(resolve => child!.on("exit", code => resolve(code)));
  client = createProtocolConnection(
    new StreamMessageReader(child.stdout!),
    new StreamMessageWriter(child.stdin!)
  );
  const published: lsp.PublishDiagnosticsParams[] = [];
  const errors: string[] = [];
  client.onNotification("textDocument/publishDiagnostics", (p: lsp.PublishDiagnosticsParams) => {
    published.push(p);
  });
  client.onNotification("window/logMessage", (p: { type: number; message: string }) => {
    if (p.type === 1) errors.push(p.message);
  });
  client.onRequest("client/registerCapability", () => null);
  client.onRequest("workspace/configuration", (p: { items: unknown[] }) =>
    p.items.map(() => ({ diagnostics: { delay: 20 } }))
  );
  client.listen();

  const root = pathToFileURL(dir).href;
  await client.sendRequest("initialize", {
    processId: process.pid,
    rootUri: root,
    workspaceFolders: [{ uri: root, name: "project" }],
    capabilities: {
      workspace: { configuration: true },
      textDocument: { hover: { contentFormat: ["markdown"] } }
    }
  });
  await client.sendNotification("initialized", {});

  const text = PROJECT["archive.yfl"]!;
  const uri = pathToFileURL(join(dir, "archive.yfl")).href;
  await client.sendNotification("textDocument/didOpen", {
    textDocument: { uri, languageId: "yaffle", version: 1, text }
  });

  const hover = (await client.sendRequest("textDocument/hover", {
    textDocument: { uri },
    position: find(text, "Entry   ent|ries[n]")
  })) as lsp.Hover;
  expect((hover.contents as lsp.MarkupContent).value).toContain("Entry entries[n] at entriesOfs");

  const completion = (await client.sendRequest("textDocument/completion", {
    textDocument: { uri },
    position: find(text, "  |Entry   entries")
  })) as lsp.CompletionList;
  expect(completion.items.map(i => i.label)).toContain("Comment");

  expect(
    await client.sendRequest("textDocument/formatting", {
      textDocument: { uri },
      options: { tabSize: 2, insertSpaces: true }
    })
  ).toEqual([]);

  // an error appears and goes away again
  await client.sendNotification("textDocument/didChange", {
    textDocument: { uri, version: 2 },
    contentChanges: [{ text: text.replace("Entry   entries[n]", "Entrx   entries[n]") }]
  });
  const bad = await until(() =>
    published.find(p => p.uri === uri && p.version === 2 && p.diagnostics.length)
  );
  expect(bad.diagnostics[0]!.code).toBe("unknown-type");
  await client.sendNotification("textDocument/didChange", {
    textDocument: { uri, version: 3 },
    contentChanges: [{ text }]
  });
  await until(() =>
    published.find(p => p.uri === uri && p.version === 3 && p.diagnostics.length === 0)
  );

  const ir = (await client.sendRequest("yaffle/showIr", { textDocument: { uri } })) as {
    program: { structs: { name: string }[] };
  };
  expect(ir.program.structs.map(s => s.name)).toContain("Archive");

  expect(errors).toEqual([]);
  await client.sendRequest("shutdown");
  await client.sendNotification("exit");
  expect(await exited).toBe(0);
});
