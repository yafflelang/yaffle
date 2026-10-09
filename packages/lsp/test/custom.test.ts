import { afterEach, describe, expect, it } from "vitest";
import type { CompileFunction } from "../src/server.ts";
import {
  DecodeSampleMethod,
  type DecodeSampleResult,
  ShowIrMethod,
  type ShowIrResult,
  SuggestLayoutMethod,
  type SuggestLayoutResult
} from "../src/protocol.ts";
import { startTestServer, type TestServer } from "./harness.ts";

let t: TestServer;
afterEach(() => t?.dispose());

const SRC = "struct Header {\n  u8 magic\n  u8 version\n}\n";
const range = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec }
});

describe("yaffle/showIr", () => {
  it("compiles the file with unsaved contents and returns the IR as JSON", async () => {
    const seen: { entries: string[]; main: string | undefined; dep: string | undefined }[] = [];
    const compile: CompileFunction = (entries, host) => {
      seen.push({ entries, main: host.readFile(entries[0]!), dep: host.readFile("/ws/dep.yfl") });
      return {
        program: { version: 1, structs: [{ name: "Header", big: 2n ** 70n }], roots: [] },
        diagnostics: [
          {
            path: "/ws/dep.yfl",
            range: range(0, 0, 0, 1),
            severity: "warning",
            code: "w",
            message: "careful"
          }
        ]
      };
    };
    t = await startTestServer({
      files: { "/ws/dep.yfl": "struct Dep {}\n" },
      serverOptions: { compile }
    });
    const uri = await t.open("/ws/main.yfl", "on disk? no: unsaved\n");
    const result = await t.request<ShowIrResult>(ShowIrMethod, { textDocument: { uri } });
    expect(seen).toEqual([
      { entries: ["/ws/main.yfl"], main: "on disk? no: unsaved\n", dep: "struct Dep {}\n" }
    ]);
    expect(result).toEqual({
      program: {
        version: 1,
        structs: [{ name: "Header", big: "1180591620717411303424" }],
        roots: []
      },
      diagnostics: [
        {
          uri: t.uri("/ws/dep.yfl"),
          range: range(0, 0, 0, 1),
          severity: "warning",
          code: "w",
          message: "careful"
        }
      ]
    });
  });

  it("returns null program with diagnostics when compilation fails", async () => {
    t = await startTestServer({
      serverOptions: {
        compile: entries => ({
          diagnostics: [
            {
              path: entries[0]!,
              range: range(1, 0, 1, 2),
              severity: "error",
              code: "e",
              message: "bad"
            }
          ]
        })
      }
    });
    const uri = await t.open("/ws/main.yfl", "x\n");
    const result = await t.request<ShowIrResult>(ShowIrMethod, { textDocument: { uri } });
    expect(result.program).toBeNull();
    expect(result.diagnostics).toEqual([
      { uri, range: range(1, 0, 1, 2), severity: "error", code: "e", message: "bad" }
    ]);
  });

  it("reports a compiler crash as an error message", async () => {
    t = await startTestServer({
      serverOptions: {
        compile: () => {
          throw new Error("compile not implemented yet");
        }
      }
    });
    const uri = await t.open("/ws/main.yfl", "x\n");
    const result = await t.request<ShowIrResult>(ShowIrMethod, { textDocument: { uri } });
    expect(result).toEqual({
      program: null,
      diagnostics: [],
      error: "The compiler failed: compile not implemented yet"
    });
  });

  it("explains when no compiler is wired in", async () => {
    t = await startTestServer();
    const uri = await t.open("/ws/main.yfl", "x\n");
    const result = await t.request<ShowIrResult>(ShowIrMethod, { textDocument: { uri } });
    expect(result.error).toMatch(/no compiler/);
  });

  it("rejects malformed params", async () => {
    t = await startTestServer();
    await expect(t.request(ShowIrMethod, { nope: true })).rejects.toMatchObject({ code: -32602 });
  });
});

describe("yaffle/decodeSample", () => {
  it("decodes a sample file read by the server", async () => {
    t = await startTestServer({ files: { "/samples/h.bin": new Uint8Array([0x59, 3]) } });
    const uri = await t.open("/ws/main.yfl", SRC);
    const result = await t.request<DecodeSampleResult>(DecodeSampleMethod, {
      textDocument: { uri },
      root: "Header",
      sample: { uri: t.uri("/samples/h.bin") }
    });
    expect(result).toEqual({
      annotations: [
        { uri, range: range(1, 5, 1, 10), value: "89", offset: 0, size: 1 },
        { uri, range: range(2, 5, 2, 12), value: "3", offset: 1, size: 1 }
      ]
    });
    const call = t.fakes[0]!.callsTo("decodeSample")[0]!;
    expect(call.args[0]).toBe("/ws/main.yfl");
    expect(call.args[1]).toBe("Header");
    expect([...(call.args[2] as Uint8Array)]).toEqual([0x59, 3]);
  });

  it("isn't cancelled by an edit that arrives meanwhile (unlike position requests)", async () => {
    t = await startTestServer();
    const uri = await t.open("/ws/main.yfl", SRC);
    const pending = t.request<DecodeSampleResult>(DecodeSampleMethod, {
      textDocument: { uri },
      root: "Header",
      sample: { base64: Buffer.from([1, 2]).toString("base64") }
    });
    void t.change("/ws/main.yfl", SRC + "\n");
    expect((await pending).annotations).toHaveLength(2);
  });

  it("accepts inline base64 bytes", async () => {
    t = await startTestServer();
    const uri = await t.open("/ws/main.yfl", SRC);
    const result = await t.request<DecodeSampleResult>(DecodeSampleMethod, {
      textDocument: { uri },
      root: "Header",
      sample: { base64: Buffer.from([7, 8]).toString("base64") }
    });
    expect(result.annotations.map(a => a.value)).toEqual(["7", "8"]);
  });

  it("reports an unreadable sample", async () => {
    t = await startTestServer();
    const uri = await t.open("/ws/main.yfl", SRC);
    const result = await t.request<DecodeSampleResult>(DecodeSampleMethod, {
      textDocument: { uri },
      root: "Header",
      sample: { uri: t.uri("/samples/missing.bin") }
    });
    expect(result).toEqual({
      annotations: [],
      error: "Cannot read the sample file /samples/missing.bin"
    });
  });

  it("passes the service's error to the user", async () => {
    t = await startTestServer();
    const uri = await t.open("/ws/main.yfl", SRC);
    const result = await t.request<DecodeSampleResult>(DecodeSampleMethod, {
      textDocument: { uri },
      root: "Nope",
      sample: { base64: "AA==" }
    });
    expect(result).toEqual({ annotations: [], error: "No struct Nope" });
  });

  it("validates params", async () => {
    t = await startTestServer();
    const uri = await t.open("/ws/main.yfl", SRC);
    await expect(
      t.request(DecodeSampleMethod, { textDocument: { uri }, root: "", sample: { base64: "" } })
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      t.request(DecodeSampleMethod, { textDocument: { uri }, root: "Header" })
    ).rejects.toMatchObject({
      code: -32602
    });
  });
});

describe("yaffle/suggestLayout", () => {
  it("returns the service's edit keyed by URI", async () => {
    t = await startTestServer();
    const uri = await t.open("/ws/main.yfl", SRC);
    const result = await t.request<SuggestLayoutResult>(SuggestLayoutMethod, {
      textDocument: { uri },
      root: "Header",
      sample: { base64: Buffer.from([1, 2, 3]).toString("base64") }
    });
    expect(result).toEqual({
      edit: { changes: { [uri]: [{ range: range(3, 0, 3, 0), newText: "  layout { 3 }\n" }] } }
    });
  });

  it("returns null when there is nothing to suggest", async () => {
    t = await startTestServer();
    const uri = await t.open("/ws/main.yfl", SRC);
    const result = await t.request<SuggestLayoutResult>(SuggestLayoutMethod, {
      textDocument: { uri },
      root: "Missing",
      sample: { base64: "" }
    });
    expect(result).toEqual({ edit: null });
  });

  it("reports service failures", async () => {
    t = await startTestServer();
    t.configureFakes(f => f.failing.add("suggestLayout"));
    const uri = await t.open("/ws/main.yfl", SRC);
    const result = await t.request<SuggestLayoutResult>(SuggestLayoutMethod, {
      textDocument: { uri },
      root: "Header",
      sample: { base64: "" }
    });
    expect(result).toEqual({ edit: null, error: "fake suggestLayout failure" });
  });
});
