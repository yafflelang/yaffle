/** Unit tests for the extension's pure modules. */
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { renderAnnotations } from "../src/annotations.ts";
import { collectLocations, formatIr } from "../src/format.ts";
import { resolveServerLaunch } from "../src/launch.ts";
import { argPrompt, parseArg } from "../src/args.ts";

const r = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec }
});

describe("resolveServerLaunch", () => {
  const base = { runtime: undefined, bundledServer: "/ext/dist/server.mjs", workspaceRoot: "/ws" };

  it("uses the bundled server by default", () => {
    expect(resolveServerLaunch({ ...base, serverPath: undefined })).toEqual({
      kind: "module",
      module: "/ext/dist/server.mjs",
      runtime: undefined,
      execArgv: []
    });
    expect(resolveServerLaunch({ ...base, serverPath: "   " }).kind).toBe("module");
  });

  it("runs JavaScript modules with Node, relative to the workspace", () => {
    expect(
      resolveServerLaunch({ ...base, serverPath: "tools/lsp/main.js", runtime: " /usr/bin/node " })
    ).toEqual({
      kind: "module",
      module: path.resolve("/ws", "tools/lsp/main.js"),
      runtime: "/usr/bin/node",
      execArgv: []
    });
    expect(resolveServerLaunch({ ...base, serverPath: "/abs/server.cjs" })).toMatchObject({
      kind: "module",
      module: "/abs/server.cjs"
    });
  });

  it("runs TypeScript modules with the development condition", () => {
    expect(resolveServerLaunch({ ...base, serverPath: "/repo/packages/lsp/src/main.ts" })).toEqual({
      kind: "module",
      module: "/repo/packages/lsp/src/main.ts",
      runtime: undefined,
      execArgv: ["--conditions=development"]
    });
  });

  it("starts anything else as an executable", () => {
    expect(resolveServerLaunch({ ...base, serverPath: "yaffle-lsp" })).toEqual({
      kind: "executable",
      command: "yaffle-lsp",
      args: []
    });
    expect(resolveServerLaunch({ ...base, serverPath: "./bin/yaffle-lsp" })).toEqual({
      kind: "executable",
      command: path.resolve("/ws", "bin/yaffle-lsp"),
      args: []
    });
  });

  it("expands ~ and copes without a workspace", () => {
    const home = process.env.HOME ?? "";
    expect(
      resolveServerLaunch({ ...base, workspaceRoot: undefined, serverPath: "~/lsp.mjs" })
    ).toMatchObject({
      module: path.join(home, "lsp.mjs")
    });
    expect(
      resolveServerLaunch({ ...base, workspaceRoot: undefined, serverPath: "rel.js" })
    ).toMatchObject({
      module: "rel.js"
    });
  });
});

describe("renderAnnotations", () => {
  it("renders one decoration per field, with a hover table", () => {
    const out = renderAnnotations([
      { uri: "file:///a.yfl", range: r(1, 2, 1, 7), value: "17", offset: 0, size: 4 },
      { uri: "file:///a.yfl", range: r(2, 2, 2, 5), value: '"ARCV"', offset: 4, size: 4 }
    ]);
    expect(out).toEqual([
      {
        uri: "file:///a.yfl",
        range: r(1, 2, 1, 7),
        text: "= 17",
        hover: "**17**\n\n| value | offset | size |\n|---|---|---|\n| `17` | 0x0 (0) | 4 |"
      },
      expect.objectContaining({ text: '= "ARCV"' })
    ]);
  });

  it("groups values of array elements and caps the inline text", () => {
    const many = Array.from({ length: 30 }, (_v, i) => ({
      uri: "file:///a.yfl",
      range: r(3, 0, 3, 3),
      value: String(i),
      offset: i * 2,
      size: 2
    }));
    const [only] = renderAnnotations(many);
    expect(only!.text).toBe("= 0, 1, 2, 3, … (30 values)");
    expect(only!.hover.startsWith("**30 values**")).toBe(true);
    expect(only!.hover.split("\n").filter(l => l.startsWith("| `"))).toHaveLength(20);
    expect(only!.hover.endsWith("| … | | |")).toBe(true);
  });

  it("clips long values and escapes table characters", () => {
    const [a] = renderAnnotations([
      { uri: "u", range: r(0, 0, 0, 1), value: "x|`".repeat(40), offset: 255, size: 1 }
    ]);
    expect(a!.text.length).toBe(80);
    expect(a!.text.endsWith("…")).toBe(true);
    expect(a!.hover).toContain("x\\|\\`");
    expect(a!.hover).toContain("0xff (255)");
  });
});

describe("formatIr", () => {
  it("prints the IR with diagnostics as comments", () => {
    const text = formatIr(
      {
        program: { version: 1 },
        diagnostics: [
          {
            uri: "file:///a.yfl",
            range: r(2, 4, 2, 5),
            severity: "warning",
            code: "lossy-formula",
            message: "Lossy"
          },
          {
            uri: "file:///b.yfl",
            range: r(0, 0, 0, 1),
            severity: "info",
            code: "x",
            message: "Elsewhere"
          }
        ]
      },
      "file:///a.yfl"
    );
    expect(text).toBe(
      [
        "// IR of file:///a.yfl",
        "// warning 3:5 Lossy [lossy-formula]",
        "// info file:///b.yfl 1:1 Elsewhere [x]",
        "{",
        '  "version": 1',
        "}",
        ""
      ].join("\n")
    );
  });

  it("explains a missing program", () => {
    expect(formatIr({ program: null, diagnostics: [] }, "s")).toBe(
      "// IR of s\n// No IR: fix the errors above.\n"
    );
    expect(formatIr({ program: null, diagnostics: [], error: "The compiler failed: x" }, "s")).toBe(
      "// IR of s\n// The compiler failed: x\n"
    );
  });
});

describe("collectLocations", () => {
  it("finds LSP locations anywhere in command arguments", () => {
    const loc = { uri: "file:///a.yfl", range: r(0, 0, 0, 1) };
    expect(collectLocations(["/a.yfl", { line: 0, character: 0 }, [loc, { nested: loc }]])).toEqual(
      [loc, loc]
    );
    expect(collectLocations(undefined)).toEqual([]);
    expect(collectLocations([{ path: "/a", range: r(0, 0, 0, 0) }])).toEqual([]);
  });
});

describe("root arguments", () => {
  const bytes = {
    name: "key",
    label: "$key",
    type: "u8[4]",
    kind: "bytes" as const,
    length: 4,
    optional: false
  };
  const u64 = {
    name: "nonce",
    label: "$nonce",
    type: "u64",
    kind: "int" as const,
    bits: 64,
    signed: false,
    optional: false
  };
  const i8 = { ...u64, name: "d", label: "d", type: "i8", bits: 8, signed: true };
  it("bytes: hex with separators, lowercased, with the declared length", () => {
    expect(parseArg(bytes, "DE AD be:ef")).toEqual({ value: "deadbeef" });
    expect(parseArg(bytes, "0xdeadbeef")).toEqual({ value: "deadbeef" });
    expect(parseArg(bytes, "dead")).toEqual({ error: "4 bytes expected, got 2." });
    expect(parseArg(bytes, "xyz1").error).toMatch(/Hex digits/);
    expect(parseArg(bytes, "abc").error).toMatch(/even number/);
    expect(parseArg(bytes, "").error).toBe("$key is required.");
  });
  it("integers: decimal, hex and binary, range-checked; 64-bit ones as decimal strings", () => {
    expect(parseArg(u64, "0x35ab1f58c5e12109")).toEqual({ value: "3867219171165151497" });
    expect(parseArg(u64, "-1").error).toMatch(/Out of range/);
    expect(parseArg(i8, "-128")).toEqual({ value: -128 });
    expect(parseArg(i8, "0b101")).toEqual({ value: 5 });
    expect(parseArg(i8, "128").error).toMatch(/Out of range for i8/);
    expect(parseArg(i8, "1.5").error).toMatch(/An integer/);
  });
  it("optional parameters may be left empty; other kinds", () => {
    expect(parseArg({ ...i8, optional: true }, " ")).toEqual({});
    expect(parseArg({ ...i8, kind: "bool" }, "yes")).toEqual({ value: true });
    expect(parseArg({ ...i8, kind: "enum", members: ["A", "B"] }, "C").error).toBe("One of A, B.");
    expect(parseArg({ ...i8, kind: "float" }, "2.5")).toEqual({ value: 2.5 });
    expect(argPrompt({ ...i8, optional: true, defaultText: "3" })).toBe(
      "d: i8 — an integer (decimal or 0x…); empty for the default (3)"
    );
  });
});
