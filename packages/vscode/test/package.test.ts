/**
 * Packaging smoke tests: the manifest's contributions are consistent and valid, the extension
 * builds, `vsce package` produces a .vsix with the right files, and the bundled server runs.
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter
} from "vscode-languageserver-protocol/node";
import { DEFAULT_SETTINGS, snippetToPlain } from "@yafflelang/lsp";
import { build, ROOT } from "../scripts/build.ts";
import { COMMANDS } from "../src/commands.ts";
import { dump, tokenize } from "./tokenize.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  main: string;
  publisher: string;
  engines: { vscode: string };
  activationEvents: string[];
  contributes: {
    languages: { id: string; extensions: string[]; configuration: string }[];
    grammars: { language: string; scopeName: string; path: string }[];
    snippets: { language: string; path: string }[];
    jsonValidation: { fileMatch: string; url: string }[];
    commands: { command: string; title: string; category: string }[];
    menus: Record<string, { command: string; when?: string }[]>;
    configuration: { properties: Record<string, { type: string; default: unknown }> };
    configurationDefaults: Record<string, unknown>;
  };
  scripts: Record<string, string>;
};

const readJson = (rel: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));

describe("manifest", () => {
  it("declares the yaffle language for .yfl with grammar, snippets and configuration", () => {
    const c = manifest.contributes;
    expect(c.languages).toEqual([expect.objectContaining({ id: "yaffle", extensions: [".yfl"] })]);
    expect(c.grammars).toEqual([
      { language: "yaffle", scopeName: "source.yaffle", path: "./syntaxes/yaffle.tmLanguage.json" }
    ]);
    for (const file of [
      c.languages[0]!.configuration,
      c.grammars[0]!.path,
      c.snippets[0]!.path,
      c.jsonValidation[0]!.url
    ]) {
      expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
      expect(() => readJson(file), file).not.toThrow();
    }
    expect(manifest.main).toBe("./dist/extension.cjs");
    expect(manifest.publisher).toBeTruthy();
  });

  it("contributes exactly the commands the extension registers", () => {
    const contributed = manifest.contributes.commands.map(c => c.command).sort();
    expect(contributed).toEqual(Object.values(COMMANDS).sort());
    for (const c of manifest.contributes.commands) expect(c.category).toBe("yaffle");
    const titles = Object.fromEntries(manifest.contributes.commands.map(c => [c.command, c.title]));
    expect(titles["yaffle.showIr"]).toBe("Show IR");
    expect(titles["yaffle.decodeSample"]).toBe("Decode Sample File…");
    expect(titles["yaffle.suggestLayout"]).toBe("Suggest Layout from Sample…");
    for (const items of Object.values(manifest.contributes.menus)) {
      for (const item of items) expect(contributed).toContain(item.command);
    }
  });

  it("has a setting for everything the server reads, plus server path and trace", () => {
    const props = manifest.contributes.configuration.properties;
    const flatten = (o: object, prefix: string): [string, unknown][] =>
      Object.entries(o).flatMap(([k, v]) =>
        v !== null && typeof v === "object"
          ? flatten(v as object, `${prefix}${k}.`)
          : [[`${prefix}${k}`, v]]
      );
    for (const [key, value] of flatten(DEFAULT_SETTINGS, "yaffle.")) {
      expect(props[key], key).toBeDefined();
      expect(props[key]!.default, key).toEqual(value);
    }
    expect(props["yaffle.server.path"]?.type).toBe("string");
    expect(props["yaffle.server.runtime"]?.type).toBe("string");
    expect(props["yaffle.trace.server"]).toMatchObject({
      enum: ["off", "messages", "verbose"],
      default: "off"
    });
    expect(manifest.contributes.configurationDefaults["[yaffle]"]).toMatchObject({
      "editor.formatOnType": true
    });
  });

  it("builds and packages without bundled node_modules", () => {
    expect(manifest.scripts["vscode:prepublish"]).toContain("scripts/build.ts");
    expect(manifest.scripts.package).toContain("--no-dependencies");
  });
});

describe("language configuration", () => {
  const config = readJson("language-configuration.json") as {
    comments: { lineComment: string; blockComment: [string, string] };
    wordPattern: string;
    indentationRules: { increaseIndentPattern: string; decreaseIndentPattern: string };
    onEnterRules: {
      beforeText: string;
      afterText?: string;
      action: { indent: string; appendText?: string };
    }[];
    autoClosingPairs: { open: string; close: string }[];
  };

  it("has yaffle's comments and pairs", () => {
    expect(config.comments).toEqual({ lineComment: "//", blockComment: ["/*", "*/"] });
    expect(config.autoClosingPairs.map(p => p.open)).toEqual(
      expect.arrayContaining(["{", "[", "(", '"', "'"])
    );
  });

  it("treats $bound values, @attributes and numbers as words", () => {
    const word = new RegExp(config.wordPattern, "g");
    const words = (s: string) => s.match(word);
    expect(words("u32 $version @align(0x1F_00) 1_000")).toEqual([
      "u32",
      "$version",
      "@align",
      "0x1F_00",
      "1_000"
    ]);
  });

  it("indents after unclosed brackets, not inside comments", () => {
    const inc = new RegExp(config.indentationRules.increaseIndentPattern);
    const dec = new RegExp(config.indentationRules.decreaseIndentPattern);
    expect(inc.test("struct A {")).toBe(true);
    expect(inc.test('  @endian(order == "MM" ? be : le) {')).toBe(true);
    expect(inc.test("extern codec chacha20(")).toBe(true);
    expect(inc.test("struct A { u8 x }")).toBe(false);
    expect(inc.test("  u8 x // {")).toBe(false);
    expect(inc.test("  u64 offset @align(8)")).toBe(false);
    expect(dec.test("  }")).toBe(true);
    expect(dec.test("  u8 x")).toBe(false);
  });

  it("has @-continuation-friendly on-enter rules", () => {
    const rule = (text: string) =>
      config.onEnterRules.find(r => new RegExp(r.beforeText).test(text) && !r.afterText);
    expect(rule("               @padAfter(8)")?.action.indent).toBe("none");
    expect(rule("  @strict")?.action.indent).toBe("none");
    expect(rule("  @endian(x) {")).toBeUndefined();
    expect(rule('  case "ARCV":')?.action.indent).toBe("indent");
    expect(rule("  default:")?.action.indent).toBe("indent");
    expect(rule("/** doc")?.action.appendText).toBe(" * ");
  });
});

describe("snippets", () => {
  const snippets = readJson("snippets/yaffle.code-snippets") as Record<
    string,
    { prefix: string | string[]; body: string[]; description: string }
  >;

  it("cover the common constructs", () => {
    const prefixes = Object.values(snippets).flatMap(s =>
      Array.isArray(s.prefix) ? s.prefix : [s.prefix]
    );
    for (const p of [
      "struct",
      "enum",
      "bits",
      "union",
      "switch",
      "if",
      "import",
      "codec",
      "fn",
      "type",
      "layout",
      "ptr",
      "via"
    ]) {
      expect(prefixes).toContain(p);
    }
  });

  it.each(Object.entries(snippets))("%s expands to valid yaffle", async (_name, snippet) => {
    expect(snippet.description).toBeTruthy();
    const text = snippetToPlain(snippet.body.join("\n"));
    expect(text).not.toMatch(/\$\{|\$\d/);
    const tokens = await tokenize(text);
    const illegal = tokens.filter(t => t.scopes.some(s => s.startsWith("invalid.")));
    expect(illegal, dump(tokens)).toEqual([]);
    // Each placeholder default parses: no stray identifiers left at the root scope.
    const bare = tokens.filter(t => /\w/.test(t.text) && t.scopes.length === 1);
    expect(bare, dump(tokens)).toEqual([]);
  });
});

describe("yaffle.json schema", () => {
  it("describes sources and targets", () => {
    const schema = readJson("schemas/yaffle.schema.json") as {
      properties: Record<string, unknown>;
      definitions: { target: { required: string[] } };
    };
    expect(Object.keys(schema.properties)).toEqual(["sources", "targets"]);
    expect(schema.definitions.target.required).toEqual(["out"]);
  });
});

/** Entry names (and a reader) of a zip file, from its central directory. */
function readZip(file: string): { names: string[]; read(name: string): Buffer } {
  const buf = fs.readFileSync(file);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, { method: number; size: number; offset: number }>();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    entries.set(buf.toString("utf8", p + 46, p + 46 + nameLen), { method, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) throw new Error(`no ${name} in ${file}`);
      const start =
        e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
      const data = buf.subarray(start, start + e.size);
      return e.method === 8 ? zlib.inflateRawSync(data) : data;
    }
  };
}

describe("build and package", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yaffle-vsix-"));
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("bundles the extension (CommonJS) and the server (ESM)", async () => {
    const out = await build({ outdir: path.join(tmp, "dist") });
    const ext = fs.readFileSync(out.extension, "utf8");
    expect(ext).toContain('require("vscode")');
    expect(ext).not.toMatch(/^import /m);
    const server = fs.readFileSync(out.server, "utf8");
    expect(server.startsWith("#!/usr/bin/env node\nimport { createRequire")).toBe(true);
    const version = spawnSync(process.execPath, [out.server, "--version"], { encoding: "utf8" });
    expect(version.stdout.trim()).toBe("yaffle-lsp 0.1.0");
  });

  it("packages a .vsix with vsce", () => {
    const vsix = path.join(tmp, "yaffle.vsix");
    const vsce = path.join(ROOT, "..", "..", "node_modules", ".bin", "vsce");
    const result = spawnSync(
      vsce,
      ["package", "--no-dependencies", "--allow-missing-repository", "--skip-license", "-o", vsix],
      { cwd: ROOT, encoding: "utf8", timeout: 120_000 }
    );
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const zip = readZip(vsix);
    expect(zip.names.sort()).toEqual(
      [
        "[Content_Types].xml",
        "extension.vsixmanifest",
        "extension/package.json",
        "extension/language-configuration.json",
        "extension/dist/extension.cjs",
        "extension/dist/server.mjs",
        "extension/syntaxes/yaffle.tmLanguage.json",
        "extension/snippets/yaffle.code-snippets",
        "extension/schemas/yaffle.schema.json"
      ].sort()
    );
    const packed = JSON.parse(zip.read("extension/package.json").toString("utf8")) as {
      main: string;
    };
    expect(packed.main).toBe("./dist/extension.cjs");
    const vsixManifest = zip.read("extension.vsixmanifest").toString("utf8");
    expect(vsixManifest).toContain('Id="yaffle-vscode"');
    expect(zip.read("extension/dist/server.mjs").toString("utf8")).toContain("yaffle-lsp");
  }, 180_000);

  it("runs the bundled server against a service module over stdio", async () => {
    const out = await build({ outdir: path.join(tmp, "dist2") });
    const fake = path.resolve(here, "../../lsp/test/fixtures/fakeServiceModule.ts");
    const child = spawn(process.execPath, [out.server, "--stdio", "--service", fake], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    const client = createProtocolConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin)
    );
    const published: { uri: string; diagnostics: unknown[] }[] = [];
    client.onNotification(
      "textDocument/publishDiagnostics",
      (p: { uri: string; diagnostics: unknown[] }) => {
        published.push(p);
      }
    );
    client.listen();
    try {
      await client.sendRequest("initialize", { processId: null, rootUri: null, capabilities: {} });
      await client.sendNotification("initialized", {});
      const uri = pathToFileURL(path.join(tmp, "a.yfl")).href;
      await client.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: "yaffle", version: 1, text: "struct A { ERROR }\n" }
      });
      for (
        let i = 0;
        i < 200 && !published.some(p => p.uri === uri && p.diagnostics.length > 0);
        i++
      ) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(published.find(p => p.uri === uri)?.diagnostics).toHaveLength(1);
      await client.sendRequest("shutdown");
      await client.sendNotification("exit");
      const code = await new Promise(resolve => child.on("exit", resolve));
      expect(code).toBe(0);
    } finally {
      client.dispose();
      child.kill();
    }
  });
});
