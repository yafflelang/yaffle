import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  build,
  compile,
  compileSource,
  loadProjectConfig,
  projectSources,
  validateIr,
  backends
} from "../../src/index.ts";
import type { Backend } from "../../src/backends/index.ts";
import { memoryHost } from "../helpers.ts";

describe("compileSource / compile", () => {
  it("returns a valid program and no diagnostics for valid code", () => {
    const r = compileSource("export struct S { u32 n  u8 d[n] }");
    expect(r.diagnostics).toEqual([]);
    expect(r.program).toBeDefined();
    expect(validateIr(r.program!)).toEqual([]);
  });

  it("returns no program when there are errors, but keeps warnings", () => {
    expect(compileSource("export struct S { u8 d[nope] }").program).toBeUndefined();
    const w = compileSource("export struct S { u32 n = d.length * 8  u8 d[(n + 7) / 8] }");
    expect(w.program).toBeDefined();
    expect(w.diagnostics.map(d => d.severity)).toEqual(["warning"]);
  });

  it("resolves imports through the host and sorts diagnostics", () => {
    const host = memoryHost({
      "/m/lib.yfl": "export struct L { u8 x[a] }\nexport struct K { u8 y[b] }"
    });
    const r = compileSource(
      'import { L, K } from "./lib.yfl"\nexport struct M { L l  K k  u8 z[c] }',
      "/m/main.yfl",
      host
    );
    expect(r.diagnostics.map(d => [d.path, d.range.start.line, d.code])).toEqual([
      ["/m/lib.yfl", 0, "unknown-name"],
      ["/m/lib.yfl", 1, "unknown-name"],
      ["/m/main.yfl", 1, "unknown-name"]
    ]);
  });

  it("compiles several entries at once (shared modules once)", () => {
    const host = memoryHost({
      "/p/a.yfl": 'import { C } from "./c.yfl"\nexport struct A { C c }',
      "/p/b.yfl": 'import { C } from "./c.yfl"\nexport struct B { C c }',
      "/p/c.yfl": "struct C { u8 v }"
    });
    const r = compile(["/p/a.yfl", "/p/b.yfl"], host);
    expect(r.program!.modules.map(m => m.path)).toEqual(["c.yfl", "a.yfl", "b.yfl"]);
    expect(r.program!.roots.map(x => x.name)).toEqual(["A", "B"]);
    expect(r.program!.structs.filter(s => s.id === "C").length).toBe(1);
  });

  it("disambiguates same-named structs from different modules", () => {
    const host = memoryHost({
      "/p/a.yfl": 'import { B } from "./b.yfl"\nexport struct Header { u8 a  B b }',
      "/p/b.yfl": "struct Header { u16 z }\nexport struct B { Header h }"
    });
    const r = compile(["/p/a.yfl"], host);
    expect(r.diagnostics).toEqual([]);
    expect(r.program!.structs.map(s => [s.id, s.name]).sort()).toEqual([
      ["B", "B"],
      ["a::Header", "a_Header"],
      ["b::Header", "b_Header"]
    ]);
    expect(validateIr(r.program!)).toEqual([]);
  });

  it("rootDir controls module paths", () => {
    const r = compileSource("export struct S { u8 x }", "/proj/formats/x.yfl", undefined, {
      rootDir: "/proj"
    });
    expect(r.program!.modules).toEqual([{ path: "formats/x.yfl", name: "formats/x" }]);
  });

  it("produces plain JSON (round-trips exactly)", () => {
    const p = compileSource(
      "export struct S { u64 big = 18446744073709551615  f32 f = 1.5 }"
    ).program!;
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });
});

describe("loadProjectConfig", () => {
  const load = (text: string) =>
    loadProjectConfig("/p/yaffle.json", memoryHost({ "/p/yaffle.json": text }));

  it("loads a valid config (JSONC: comments and trailing commas)", () => {
    const r = load(`{
  // sources
  "sources": ["formats/**/*.yfl"],
  "targets": {
    "ts":   { "out": "tool/src/gen", "externs": { "pathHash": "./src/hash.ts" }, "inlineRuntime": true, },
    "rust": { "out": "format/src/gen",  "externs": { "pathHash": "crate::hash::path_hash" } },
  },
}`);
    expect(r.diagnostics).toEqual([]);
    expect(r.config).toEqual({
      sources: ["formats/**/*.yfl"],
      targets: {
        ts: { out: "tool/src/gen", externs: { pathHash: "./src/hash.ts" }, inlineRuntime: true },
        rust: { out: "format/src/gen", externs: { pathHash: "crate::hash::path_hash" } }
      }
    });
  });

  it("defaults sources to every .yfl file", () => {
    expect(load("{}").config).toEqual({ sources: ["**/*.yfl"], targets: {} });
  });

  it("reports invalid configs", () => {
    const cases: [string, string][] = [
      ["not json", "Invalid JSON"],
      ["[]", "must contain an object"],
      ['{ "sources": "x" }', '"sources" must be an array'],
      ['{ "targets": [] }', '"targets" must be an object'],
      ['{ "targets": { "ts": {} } }', "targets.ts.out must be a string"],
      [
        '{ "targets": { "ts": { "out": "x", "externs": { "a": 1 } } } }',
        "targets.ts.externs must map"
      ],
      ['{ "srcs": [] }', 'Unknown key "srcs"']
    ];
    for (const [text, msg] of cases) {
      const r = load(text);
      expect(r.config, text).toBeUndefined();
      expect(r.diagnostics.map(d => d.code)).toContain("config-error");
      expect(r.diagnostics.map(d => d.message).join("\n"), text).toContain(msg);
    }
  });

  it("reports unreadable files", () => {
    const r = loadProjectConfig("/nope/yaffle.json", memoryHost({}));
    expect(r.diagnostics[0]!.message).toContain("Can't read");
  });
});

describe("build", () => {
  const fake: Backend = {
    name: "fake",
    generate(program, options) {
      return [
        {
          path: "out.json",
          contents: JSON.stringify({
            roots: program.roots.map(r => r.name),
            externs: options.externs,
            targetOptions: options.targetOptions
          })
        }
      ];
    }
  };

  it("runs backends with externs and target options (dry run)", () => {
    const host = memoryHost({ "/p/a.yfl": "extern codec zstd\nexport struct S { u8 x }" });
    const r = build(
      {
        config: {
          sources: [],
          targets: {
            fake: { out: "gen", externs: { zstd: "./codecs/zstd.ts" }, inlineRuntime: true }
          }
        },
        rootDir: "/p"
      },
      undefined,
      undefined,
      { host, backends: { fake }, dryRun: true, entries: ["/p/a.yfl"] }
    );
    expect(r.diagnostics).toEqual([]);
    expect(r.outputs.length).toBe(1);
    expect(r.outputs[0]!.outDir).toBe("/p/gen");
    expect(JSON.parse(r.outputs[0]!.files[0]!.contents)).toEqual({
      roots: ["S"],
      externs: { zstd: "../codecs/zstd.ts" },
      targetOptions: { inlineRuntime: true }
    });
  });

  it("writes files and expands the sources globs", () => {
    const dir = mkdtempSync(join(tmpdir(), "yaffle-build-"));
    try {
      mkdirSync(join(dir, "formats/x"), { recursive: true });
      writeFileSync(join(dir, "formats/x/a.yfl"), "export struct A { u8 v }");
      writeFileSync(join(dir, "formats/b.yfl"), "export struct B { u8 w }");
      const config = { sources: ["formats/**/*.yfl"], targets: { fake: { out: "gen" } } };
      expect(projectSources(config, dir)).toEqual([
        join(dir, "formats/b.yfl"),
        join(dir, "formats/x/a.yfl")
      ]);
      const r = build({ config, rootDir: dir }, "fake", undefined, { backends: { fake } });
      expect(r.diagnostics).toEqual([]);
      expect(JSON.parse(readFileSync(join(dir, "gen/out.json"), "utf8")).roots).toEqual(["B", "A"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns about missing extern implementations for the targets being built", () => {
    const host = memoryHost({ "/p/a.yfl": "extern codec zstd\nexport struct S { u8 x }" });
    const r = build(
      { config: { sources: [], targets: { fake: { out: "gen" } } }, rootDir: "/p" },
      undefined,
      undefined,
      { host, backends: { fake }, dryRun: true, entries: ["/p/a.yfl"] }
    );
    expect(r.diagnostics.map(d => d.code)).toEqual(["extern-missing-implementation"]);
    expect(r.outputs.length).toBe(1);
  });

  it("the default registry has the ts and rust backends (and more)", () => {
    expect(Object.keys(backends)).toEqual(expect.arrayContaining(["rust", "ts"]));
  });
});
