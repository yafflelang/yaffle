/**
 * yaffle/decodeSample and yaffle/suggestLayout through the real server: samples given inline
 * (base64) or as a file the server reads, annotations on the client's URIs, layout edits that
 * apply to the document.
 */
import { afterEach, describe, expect, it } from "vitest";
import type * as lsp from "vscode-languageserver";
import type {
  DecodeSampleResult,
  RootParametersResult,
  SuggestLayoutResult
} from "../../src/protocol.ts";
import type { TestServer } from "../harness.ts";
import { applyEdits, errorLogs, find, startRealServer } from "./realServer.ts";

let t: TestServer;
afterEach(() => t?.dispose());

const SCHEMA = `export struct File {
  u32  count
  u32  itemsOfs
  Item items[count] at itemsOfs
  Blob *extra : u32
}

struct Item {
  u16  id
  u16  size
  u8[size] *payload : u32
}

struct Blob { u32 n  u8 data[n] }
`;

/**
 * A sample of SCHEMA written in a non-default order: the payloads first (16-aligned), then the
 * blob, then the items array (4-aligned).
 */
function sample(): Uint8Array {
  const b = new Uint8Array(0x40);
  const v = new DataView(b.buffer);
  v.setUint32(0, 2, true); // count
  v.setUint32(4, 0x30, true); // itemsOfs
  v.setUint32(8, 0x28, true); // extra
  b.set([1, 2, 3], 0x10); // items[0].payload
  b.set([4, 5, 6, 7, 8], 0x20); // items[1].payload
  v.setUint32(0x28, 2, true); // extra: n, data
  b.set([0xee, 0xee], 0x2c);
  v.setUint16(0x30, 7, true); // items[0]: id, size, payload
  v.setUint16(0x32, 3, true);
  v.setUint32(0x34, 0x10, true);
  v.setUint16(0x38, 8, true); // items[1]
  v.setUint16(0x3a, 5, true);
  v.setUint32(0x3c, 0x20, true);
  return b;
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

const KEYED = `export struct Keyed(u8 $key[2], u64 $nonce, u8 n = 2) {
  u8  data[n]
  u8  k[2] where it == $key
  u64 seen = $nonce
}
`;

describe("root arguments", () => {
  it("yaffle/rootParameters lists what a root needs", async () => {
    t = await startRealServer({ files: { "/ws/s/main.yfl": KEYED }, workspaceFolders: ["/ws/s"] });
    const uri = await t.open("/ws/s/main.yfl", KEYED);
    const result = await t.request<RootParametersResult>("yaffle/rootParameters", {
      textDocument: { uri },
      root: "Keyed"
    });
    expect(result.error).toBeUndefined();
    expect(result.parameters.map(p => [p.name, p.label, p.kind, p.optional])).toEqual([
      ["key", "$key", "bytes", false],
      ["nonce", "$nonce", "int", false],
      ["n", "n", "int", true]
    ]);
    expect(result.parameters[0]!.length).toBe(2);
    const missing = await t.request<RootParametersResult>("yaffle/rootParameters", {
      textDocument: { uri },
      root: "Nope"
    });
    expect(missing).toEqual({ parameters: [], error: expect.stringMatching(/No struct `Nope`/) });
    expect(errorLogs(t)).toEqual([]);
  });

  it("yaffle/decodeSample decodes with the arguments", async () => {
    t = await startRealServer({ files: { "/ws/s/main.yfl": KEYED }, workspaceFolders: ["/ws/s"] });
    const uri = await t.open("/ws/s/main.yfl", KEYED);
    const bytes = new Uint8Array([1, 2, 0xaa, 0xbb, 5, 0, 0, 0, 0, 0, 0, 0]);
    const decode = (args: unknown) =>
      t.request<DecodeSampleResult>("yaffle/decodeSample", {
        textDocument: { uri },
        root: "Keyed",
        sample: { base64: b64(bytes) },
        args
      });
    const ok = await decode({ key: "aabb", nonce: "5" });
    expect(ok.error).toBeUndefined();
    expect(ok.annotations.map(a => a.value)).toEqual(["[2 bytes] 01 02", "[2 bytes] aa bb", "5"]);
    const wrongKey = await decode({ key: "0000", nonce: "5" });
    expect(wrongKey.annotations.map(a => a.value)).toEqual([expect.stringMatching(/^⚠ CHECK/)]);
    const unknown = await decode({ nope: 1 });
    expect(unknown.error).toMatch(/Keyed has no parameter `nope`/);
    const bad = await t
      .request("yaffle/decodeSample", {
        textDocument: { uri },
        root: "Keyed",
        sample: { base64: b64(bytes) },
        args: [1]
      })
      .catch((e: Error) => e);
    expect(bad).toBeInstanceOf(Error);
  });
});

describe("yaffle/decodeSample", () => {
  it("annotates the document's fields with decoded values, on the client's URI", async () => {
    t = await startRealServer({ files: { "/ws/s/main.yfl": SCHEMA }, workspaceFolders: ["/ws/s"] });
    const uri = await t.open("/ws/s/main.yfl", SCHEMA);
    const result = await t.request<DecodeSampleResult>("yaffle/decodeSample", {
      textDocument: { uri },
      root: "File",
      sample: { base64: b64(sample()) }
    });
    expect(result.error).toBeUndefined();
    const lines = SCHEMA.split("\n");
    const at = (needle: string) =>
      result.annotations
        .filter(a => lines[a.range.start.line]!.includes(needle))
        .map(a => [a.value, a.offset, a.size]);
    expect(at("u32  count")).toEqual([["2", 0, 4]]);
    expect(at("u16  id")).toEqual([
      ["7", 0x30, 2],
      ["8", 0x38, 2]
    ]);
    expect(at("u8[size] *payload")).toEqual([
      ["→ [3 bytes] 01 02 03 @0x10", 0x34, 4],
      ["→ [5 bytes] 04 05 06 07 08 @0x20", 0x3c, 4]
    ]);
    expect(at("Item items[count]")).toEqual([["[2 items]", 0x30, 16]]);
    expect(result.annotations.every(a => a.uri === uri)).toBe(true);
    expect(errorLogs(t)).toEqual([]);
  });

  it("reads a sample file the client names", async () => {
    t = await startRealServer({
      files: { "/ws/s/main.yfl": SCHEMA, "/ws/s/sample.bin": sample() },
      workspaceFolders: ["/ws/s"]
    });
    const uri = await t.open("/ws/s/main.yfl", SCHEMA);
    const result = await t.request<DecodeSampleResult>("yaffle/decodeSample", {
      textDocument: { uri },
      root: "File",
      sample: { uri: t.uri("/ws/s/sample.bin") }
    });
    expect(result.annotations.length).toBeGreaterThan(5);
  });

  it("uses the unsaved text of the document", async () => {
    t = await startRealServer({ files: { "/ws/s/main.yfl": SCHEMA }, workspaceFolders: ["/ws/s"] });
    const uri = await t.open("/ws/s/main.yfl", SCHEMA);
    await t.change("/ws/s/main.yfl", SCHEMA.replace("u16  id", "u16  ident"));
    const result = await t.request<DecodeSampleResult>("yaffle/decodeSample", {
      textDocument: { uri },
      root: "File",
      sample: { base64: b64(sample()) }
    });
    const line = find(SCHEMA.replace("u16  id", "u16  ident"), "u16  ident").line;
    expect(result.annotations.filter(a => a.range.start.line === line).map(a => a.value)).toEqual([
      "7",
      "8"
    ]);
  });
});

describe("yaffle/suggestLayout", () => {
  it("returns layout rules as an edit that reproduces the sample's order", async () => {
    t = await startRealServer({ files: { "/ws/s/main.yfl": SCHEMA }, workspaceFolders: ["/ws/s"] });
    const uri = await t.open("/ws/s/main.yfl", SCHEMA);
    const result = await t.request<SuggestLayoutResult>("yaffle/suggestLayout", {
      textDocument: { uri },
      root: "File",
      sample: { base64: b64(sample()) }
    });
    expect(result.error).toBeUndefined();
    const edits = result.edit!.changes[uri]!;
    const after = applyEdits(SCHEMA, edits as lsp.TextEdit[]);
    expect(after).toMatch(/items\[\*\](\.payload)? +@align\(0x10\)/);
    // applying it, the sample follows the schema: nothing more to suggest
    await t.change("/ws/s/main.yfl", after);
    const again = await t.request<SuggestLayoutResult>("yaffle/suggestLayout", {
      textDocument: { uri },
      root: "File",
      sample: { base64: b64(sample()) }
    });
    expect(again).toEqual({ edit: null });
    expect(errorLogs(t)).toEqual([]);
  });
});
