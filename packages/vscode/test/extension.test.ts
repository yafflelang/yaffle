/**
 * Activation smoke test: load the *bundled* extension (dist/extension.cjs) against a stand-in
 * `vscode` module, activate it, and let vscode-languageclient start the bundled server over IPC
 * and complete the LSP handshake.
 */
import * as fs from "node:fs";
import Module, { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { build, ROOT } from "../scripts/build.ts";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

interface MockState {
  calls: { name: string; args: unknown[] }[];
  registeredCommands: Map<string, (...args: unknown[]) => unknown>;
  contentProviders: Map<
    string,
    { provideTextDocumentContent(uri: unknown, token: unknown): Promise<string> }
  >;
  messages: { type: string; args: unknown[] }[];
  configuration: Record<string, unknown>;
}

interface Api {
  client:
    { isRunning(): boolean; initializeResult?: { serverInfo?: { name: string } } } | undefined;
  restart(): Promise<void>;
}

interface Extension {
  activate(context: unknown): Promise<Api>;
  deactivate(): Promise<void>;
}

interface MockUri {
  scheme: string;
  path: string;
  toString(): string;
}

const vscode = require("./vscodeMock.cjs") as {
  __mock: MockState & {
    events: { didSave: { fire(doc: unknown): void } };
    responses: {
      symbols: unknown[];
      openDialog: MockUri[] | undefined;
      inputBox: (o: {
        title: string;
        value: string;
        validateInput: (t: string) => unknown;
      }) => string | undefined;
    };
    appliedEdits: { entries(): [string, { newText: string }[]][] }[];
    statusItems: { text: string; tooltip: string; visible: boolean }[];
  };
  Uri: { from(parts: object): MockUri; parse(s: string): MockUri; file(p: string): MockUri };
  Position: new (line: number, character: number) => unknown;
  SymbolKind: Record<string, number>;
  CancellationTokenSource: new () => { token: unknown };
  window: { activeTextEditor: unknown; visibleTextEditors: unknown[] };
};
const mock = vscode.__mock;

let tmp: string;
let extension: Extension;
let restoreLoad: () => void;

function context(dist: string) {
  return {
    subscriptions: [] as { dispose(): void }[],
    extensionPath: dist,
    extensionMode: 1,
    asAbsolutePath: (rel: string) => path.join(dist, rel.replace(/^dist\//, "")),
    workspaceState: {
      get: (_k: string): unknown => undefined,
      update: async (_k: string, _v: unknown): Promise<undefined> => undefined
    },
    globalState: { get: () => undefined, update: async () => undefined }
  };
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yaffle-ext-"));
  await build({ outdir: tmp });
  const original = (Module as unknown as { _load: (...args: unknown[]) => unknown })._load;
  (Module as unknown as { _load: (...args: unknown[]) => unknown })._load = function (
    request: unknown,
    ...rest: unknown[]
  ) {
    if (request === "vscode") return vscode;
    return original.call(this, request, ...rest);
  };
  restoreLoad = () => {
    (Module as unknown as { _load: unknown })._load = original;
  };
  extension = require(path.join(tmp, "extension.cjs")) as Extension;
}, 60_000);

afterAll(() => {
  restoreLoad?.();
  fs.rmSync(tmp, { recursive: true, force: true });
});

afterEach(async () => {
  await extension.deactivate();
  for (const key of Object.keys(mock.configuration)) delete mock.configuration[key];
  mock.messages.length = 0;
  mock.calls.length = 0;
});

describe("the bundled extension", () => {
  it("activates, registers every contributed command and starts the bundled server", async () => {
    const api = await extension.activate(context(tmp));
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      contributes: { commands: { command: string }[] };
    };
    expect([...mock.registeredCommands.keys()].sort()).toEqual(
      manifest.contributes.commands.map(c => c.command).sort()
    );
    expect(api.client?.isRunning()).toBe(true);
    expect(api.client?.initializeResult?.serverInfo?.name).toBe("yaffle-lsp");
    expect(mock.contentProviders.has("yaffle-ir")).toBe(true);
    expect(mock.messages.filter(m => m.type === "error")).toEqual([]);
  }, 30_000);

  it("serves IR views through yaffle/showIr", async () => {
    await extension.activate(context(tmp));
    const source = "file:///nowhere/a.yfl";
    const uri = vscode.Uri.from({
      scheme: "yaffle-ir",
      path: "/a.yfl.ir.jsonc",
      query: encodeURIComponent(source)
    });
    const text = await mock.contentProviders
      .get("yaffle-ir")!
      .provideTextDocumentContent(uri, new vscode.CancellationTokenSource().token);
    expect(text.startsWith(`// IR of ${source}\n`)).toBe(true);
  }, 30_000);

  it("peeks binding sources from code lens arguments", async () => {
    await extension.activate(context(tmp));
    const location = {
      uri: "file:///ws/a.yfl",
      range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }
    };
    await mock.registeredCommands.get("yaffle.showBindingSources")!(
      "/ws/a.yfl",
      { line: 0, character: 0 },
      [location]
    );
    const peek = mock.calls.find(
      c => c.name === "commands.executeCommand" && c.args[0] === "editor.action.showReferences"
    );
    expect(peek).toBeDefined();
    const locations = peek!.args[3] as {
      uri: { toString(): string };
      range: { start: { line: number } };
    }[];
    expect(locations).toHaveLength(1);
    expect(locations[0]!.uri.toString()).toBe("file:///ws/a.yfl");
    expect(locations[0]!.range.start.line).toBe(1);
    await mock.registeredCommands.get("yaffle.showBindingSources")!();
    expect(mock.messages.at(-1)).toEqual({
      type: "info",
      args: ["yaffle: no binding sources found."]
    });
  }, 30_000);

  it("asks for a .yfl file before sample commands", async () => {
    await extension.activate(context(tmp));
    await mock.registeredCommands.get("yaffle.decodeSample")!();
    await mock.registeredCommands.get("yaffle.suggestLayout")!();
    await mock.registeredCommands.get("yaffle.showIr")!();
    expect(mock.messages.map(m => m.args[0])).toEqual([
      "yaffle: open a .yfl file first.",
      "yaffle: open a .yfl file first.",
      "yaffle: open a .yfl file first."
    ]);
    // Clearing without a session is harmless.
    await mock.registeredCommands.get("yaffle.clearSample")!();
  }, 30_000);

  it("restarts the server", async () => {
    const api = await extension.activate(context(tmp));
    const first = api.client;
    await mock.registeredCommands.get("yaffle.restartServer")!();
    expect(api.client).not.toBe(first);
    expect(api.client?.isRunning()).toBe(true);
    expect(first?.isRunning()).toBe(false);
  }, 30_000);

  it("runs the server named by yaffle.server.path (TypeScript sources)", async () => {
    mock.configuration["yaffle.server.path"] = path.resolve(here, "../../lsp/src/main.ts");
    const api = await extension.activate(context(tmp));
    expect(api.client?.isRunning()).toBe(true);
    expect(api.client?.initializeResult?.serverInfo?.name).toBe("yaffle-lsp");
  }, 30_000);

  it("reports a missing server module instead of starting", async () => {
    const missing = path.join(tmp, "missing-server.js");
    mock.configuration["yaffle.server.path"] = missing;
    const api = await extension.activate(context(tmp));
    expect(api.client).toBeUndefined();
    expect(mock.messages).toEqual([
      {
        type: "error",
        args: [
          `yaffle: the language server module ${missing} does not exist (check yaffle.server.path).`
        ]
      }
    ]);
    // Commands still work and explain the situation.
    await mock.registeredCommands.get("yaffle.restartServer")!();
    expect(mock.messages).toHaveLength(2);
  }, 30_000);
});

describe("commands end to end (bundled server + fake service)", () => {
  interface Decoration {
    range: { start: { line: number; character: number } };
    hoverMessage: { value: string };
    renderOptions: { after: { contentText: string } };
  }
  let dir: string;
  let yfl: string;
  let sample: string;
  let decorations: Decoration[][];

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "yaffle-cmd-"));
    yfl = path.join(dir, "main.yfl");
    sample = path.join(dir, "h.bin");
    fs.writeFileSync(yfl, "struct Header {\n  u8 magic\n  u8 version\n}\n");
    fs.writeFileSync(sample, new Uint8Array([0x59, 3]));
    // The forked server inherits the environment: run it on the fake service.
    process.env.YAFFLE_LSP_SERVICE = path.resolve(
      here,
      "../../lsp/test/fixtures/fakeServiceModule.ts"
    );
  });

  afterAll(() => {
    delete process.env.YAFFLE_LSP_SERVICE;
    vscode.window.activeTextEditor = undefined;
    vscode.window.visibleTextEditors = [];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function activateWithEditor(ctx = context(tmp)) {
    decorations = [];
    const editor = {
      document: { uri: vscode.Uri.file(yfl), languageId: "yaffle" },
      selection: { active: new vscode.Position(0, 0) },
      setDecorations: (_type: unknown, list: Decoration[]) => decorations.push(list)
    };
    vscode.window.activeTextEditor = editor;
    vscode.window.visibleTextEditors = [editor];
    mock.responses.symbols = [
      { name: "Header", kind: vscode.SymbolKind.Struct, detail: "2 fields" }
    ];
    mock.responses.openDialog = [vscode.Uri.file(sample)];
    return extension.activate(ctx);
  }

  async function until(check: () => boolean, ms = 5000) {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  it("decodes a sample, decorates the fields, re-decodes on save and clears", async () => {
    await activateWithEditor();
    await mock.registeredCommands.get("yaffle.decodeSample")!();
    expect(mock.messages.filter(m => m.type === "error")).toEqual([]);
    const shown = decorations.at(-1)!;
    expect(shown.map(d => d.renderOptions.after.contentText)).toEqual(["= 89", "= 3"]);
    expect(shown[0]!.range.start).toEqual({ line: 1, character: 5 });
    expect(shown[0]!.hoverMessage.value).toContain("| `89` | 0x0 (0) | 1 |");

    fs.writeFileSync(sample, new Uint8Array([7, 8]));
    mock.events.didSave.fire({ languageId: "yaffle", uri: vscode.Uri.file(yfl) });
    await until(() => decorations.at(-1)?.[0]?.renderOptions.after.contentText === "= 7");

    const status = mock.statusItems.at(-1)!;
    expect(status).toMatchObject({ visible: true, text: "$(file-binary) h.bin: Header" });

    // A failing re-decode keeps the values but flags them as stale.
    fs.rmSync(sample);
    const before = decorations.length;
    mock.events.didSave.fire({ languageId: "yaffle", uri: vscode.Uri.file(yfl) });
    await until(() => status.text.startsWith("$(warning)"));
    expect(status.tooltip).toContain("Cannot read the sample file");
    expect(decorations.length).toBe(before);
    expect(mock.messages.filter(m => m.type === "error")).toEqual([]);

    await mock.registeredCommands.get("yaffle.clearSample")!();
    expect(decorations.at(-1)).toEqual([]);
    expect(status.visible).toBe(false);
    fs.writeFileSync(sample, new Uint8Array([0x59, 3]));
  }, 30_000);

  it("asks for root parameters (hex for byte arrays) and remembers them per file", async () => {
    const original = fs.readFileSync(yfl, "utf8");
    fs.writeFileSync(yfl, "struct Header(u8 $key[2], u32 n) {\n  u8 magic\n  u8 version\n}\n");
    const state = new Map<string, unknown>();
    const ctx = {
      ...context(tmp),
      workspaceState: {
        get: (k: string) => state.get(k),
        update: async (k: string, v: unknown) => void state.set(k, v)
      }
    };
    const answers: Record<string, string> = { $key: "AA bb", n: "0x10" };
    const asked: { title: string; value: string; check: (t: string) => unknown }[] = [];
    mock.responses.inputBox = (o: {
      title: string;
      value: string;
      validateInput: (t: string) => unknown;
    }) => {
      asked.push({ title: o.title, value: o.value, check: o.validateInput });
      const label = o.title.replace(/^.* needs /, "");
      return answers[label];
    };
    try {
      await activateWithEditor(ctx);
      await mock.registeredCommands.get("yaffle.decodeSample")!();
      expect(mock.messages.filter(m => m.type === "error")).toEqual([]);
      expect(asked.map(a => a.title)).toEqual([
        "yaffle: Header needs $key",
        "yaffle: Header needs n"
      ]);
      // validation in the input box: hex only, the declared length, the integer range
      expect(asked[0]!.check("zz")).toMatch(/Hex digits/);
      expect(asked[0]!.check("aabbcc")).toMatch(/2 bytes expected/);
      expect(asked[1]!.check("70000000000")).toMatch(/Out of range/);
      // the fake service echoes the arguments it was given after the first value
      expect(decorations.at(-1)![0]!.renderOptions.after.contentText).toBe(
        '= 89 {"key":"aabb","n":16}'
      );
      // the next time, the last answers are prefilled
      asked.length = 0;
      await mock.registeredCommands.get("yaffle.decodeSample")!();
      expect(asked.map(a => a.value)).toEqual(["AA bb", "0x10"]);
      // cancelling an input box cancels the command
      mock.responses.inputBox = () => undefined;
      const before = decorations.length;
      await mock.registeredCommands.get("yaffle.decodeSample")!();
      expect(decorations.length).toBe(before);
    } finally {
      mock.responses.inputBox = () => undefined;
      fs.writeFileSync(yfl, original);
    }
  }, 30_000);

  it("applies the suggested layout", async () => {
    await activateWithEditor();
    mock.appliedEdits.length = 0;
    await mock.registeredCommands.get("yaffle.suggestLayout")!();
    expect(mock.messages.filter(m => m.type === "error")).toEqual([]);
    expect(mock.appliedEdits).toHaveLength(1);
    const entries = mock.appliedEdits[0]!.entries();
    expect(entries.map(([uri]) => uri)).toEqual([vscode.Uri.file(yfl).toString()]);
    expect(entries[0]![1].map(e => e.newText)).toEqual(["  layout { 2 }\n"]);
  }, 30_000);

  it("shows the IR of the active file", async () => {
    await activateWithEditor();
    await mock.registeredCommands.get("yaffle.showIr")!();
    expect(mock.messages).toEqual([]);
    const uri = vscode.Uri.from({
      scheme: "yaffle-ir",
      path: "/main.yfl.ir.jsonc",
      query: encodeURIComponent(vscode.Uri.file(yfl).toString())
    });
    const text = await mock.contentProviders
      .get("yaffle-ir")!
      .provideTextDocumentContent(uri, new vscode.CancellationTokenSource().token);
    expect(text).toContain('"fake": true');
    expect(text).toContain(yfl);
  }, 30_000);
});
