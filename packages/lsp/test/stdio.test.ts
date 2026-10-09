/**
 * End-to-end: run the real `yaffle-lsp` entry point (src/main.ts) as a child process over stdio,
 * against a real directory on disk.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { PublishDiagnosticsParams } from "vscode-languageserver";
import {
  createProtocolConnection,
  type ProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter
} from "vscode-languageserver-protocol/node";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.resolve(here, "../src/main.ts");
const FAKE = path.resolve(here, "fixtures/fakeServiceModule.ts");

interface Session {
  child: ChildProcess;
  client: ProtocolConnection;
  published: PublishDiagnosticsParams[];
  shown: { type: number; message: string }[];
  stderr: string[];
  exited: Promise<number | null>;
}

const sessions: Session[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const s of sessions.splice(0)) {
    s.client.dispose();
    s.child.kill();
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function start(args: string[]): Session {
  const child = spawn(process.execPath, ["--conditions=development", MAIN, ...args], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  const client = createProtocolConnection(
    new StreamMessageReader(child.stdout!),
    new StreamMessageWriter(child.stdin!)
  );
  const session: Session = {
    child,
    client,
    published: [],
    shown: [],
    stderr: [],
    exited: new Promise(resolve => child.on("exit", code => resolve(code)))
  };
  child.stderr!.on("data", (d: Buffer) => session.stderr.push(d.toString()));
  client.onNotification("textDocument/publishDiagnostics", (p: PublishDiagnosticsParams) => {
    session.published.push(p);
  });
  client.onNotification("window/showMessage", (p: { type: number; message: string }) => {
    session.shown.push(p);
  });
  client.onNotification("window/logMessage", () => undefined);
  client.onRequest("client/registerCapability", () => null);
  client.onRequest("workspace/configuration", (p: { items: unknown[] }) =>
    p.items.map(() => ({ diagnostics: { delay: 20 } }))
  );
  client.listen();
  sessions.push(session);
  return session;
}

async function until<T>(check: () => T | undefined, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yaffle-lsp-"));
  dirs.push(dir);
  fs.writeFileSync(
    path.join(dir, "yaffle.json"),
    JSON.stringify({ sources: ["*.yfl"], targets: {} })
  );
  fs.writeFileSync(path.join(dir, "b.yfl"), "struct B { ERROR }\n");
  return dir;
}

const capabilities = {
  workspace: { configuration: true, didChangeWatchedFiles: { dynamicRegistration: true } },
  textDocument: { hover: { contentFormat: ["markdown"] } }
};

describe("yaffle-lsp over stdio", () => {
  it("serves a real session against a fake service module", async () => {
    const dir = workspace();
    const s = start(["--stdio", "--service", FAKE]);
    const init = await s.client.sendRequest("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(dir).href,
      workspaceFolders: [{ uri: pathToFileURL(dir).href, name: "ws" }],
      capabilities
    });
    expect((init as { serverInfo: { name: string } }).serverInfo.name).toBe("yaffle-lsp");
    await s.client.sendNotification("initialized", {});

    const uri = pathToFileURL(path.join(dir, "a.yfl")).href;
    await s.client.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "yaffle",
        version: 1,
        text: 'import { B } from "./b.yfl"\nstruct A {}\n'
      }
    });
    // The import is read from disk through the server's host.
    const p = await until(() => s.published.find(x => x.uri === uri && x.diagnostics.length > 0));
    expect(p.diagnostics[0]!.code).toBe("import-has-errors");

    const hover = (await s.client.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position: { line: 1, character: 8 }
    })) as { contents: { value: string } };
    expect(hover.contents.value).toContain("Hover for `A`");

    const ir = (await s.client.sendRequest("yaffle/showIr", { textDocument: { uri } })) as {
      program: unknown;
    };
    expect(ir.program).toEqual({ fake: true, entries: [path.join(dir, "a.yfl")] });

    await s.client.sendRequest("shutdown");
    await s.client.sendNotification("exit");
    expect(await s.exited).toBe(0);
  });

  it("runs on the compiler wired in by default, whatever its state", async () => {
    const dir = workspace();
    const s = start(["--stdio"]);
    await s.client.sendRequest("initialize", {
      processId: null,
      rootUri: pathToFileURL(dir).href,
      capabilities
    });
    await s.client.sendNotification("initialized", {});
    const uri = pathToFileURL(path.join(dir, "a.yfl")).href;
    await s.client.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId: "yaffle", version: 1, text: "struct A {}\n" }
    });
    const hover = await s.client.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position: { line: 0, character: 8 }
    });
    // The compiler's language service may or may not be implemented yet; either way the
    // server must answer.
    expect(hover === null || typeof hover === "object").toBe(true);
    await s.client.sendRequest("shutdown");
    await s.client.sendNotification("exit");
    expect(await s.exited).toBe(0);
  });

  it("defaults to stdio when no transport is given", async () => {
    const s = start(["--service", FAKE]);
    const init = await s.client.sendRequest("initialize", {
      processId: null,
      rootUri: null,
      capabilities: {}
    });
    expect(init).toHaveProperty("capabilities");
    await s.client.sendRequest("shutdown");
    await s.client.sendNotification("exit");
    expect(await s.exited).toBe(0);
  });

  it("prints its version and usage", () => {
    const version = spawnSync(process.execPath, ["--conditions=development", MAIN, "--version"], {
      encoding: "utf8"
    });
    expect(version.stdout.trim()).toBe("yaffle-lsp 0.1.0");
    const help = spawnSync(process.execPath, ["--conditions=development", MAIN, "--help"], {
      encoding: "utf8"
    });
    expect(help.stdout).toMatch(/^Usage: yaffle-lsp/);
  });

  it("fails clearly on a bad --service module", () => {
    const result = spawnSync(
      process.execPath,
      ["--conditions=development", MAIN, "--stdio", "--service", MAIN + ".missing"],
      {
        encoding: "utf8",
        input: ""
      }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^yaffle-lsp: /);
  });
});
