/** The Rust conformance adapter, on a hand-made case directory (merged contract). */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  adapter,
  caseDependencies,
  jsonEqual,
  resolveExterns,
  type Case
} from "../../../src/backends/rust/conformance.ts";
import { L, S, codec, e, f, konst, len, lenOf, program, t, vt } from "./ir-builder.ts";
import { hasRust, scratch } from "./rust-utils.ts";

const XOR_RS = `
use yaffle as yr;
pub struct Xor;
pub const XOR: Xor = Xor;
impl yr::Codec for Xor {
    fn decode(&self, input: &[u8], _: &yr::CodecCtx) -> Result<Vec<u8>, String> { Ok(input.iter().map(|b| b ^ 0xff).collect()) }
    fn encode(&self, input: &[u8], _: &yr::CodecCtx) -> Result<Vec<u8>, String> { Ok(input.iter().map(|b| b ^ 0xff).collect()) }
}
`;

const prog = program(
  [
    S("Table", [
      konst("magic", t.u16, e.int(0x4c50), vt.u16),
      f("count", t.u8, { derive: lenOf("items", vt.array(vt.u16)) }),
      f("items", t.array(t.u16, len.count(e.f("count", vt.u8)))),
      f("n", t.u8, { derive: e.encodedSize("secret", 1) }),
      f("secret", t.layered(t.bytes(len.rest), L.via("xor"), L.size(e.f("n", vt.u8))))
    ])
  ],
  ["Table"],
  { externs: [codec("xor")] }
);

describe("rust adapter helpers", () => {
  it("compares canonical JSON", () => {
    expect(jsonEqual({ a: 1, b: [1, "x"] }, { b: [1, "x"], a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(jsonEqual([1], [1, 2])).toBe(false);
    expect(jsonEqual(null, {})).toBe(false);
  });

  it("maps externs and dependencies", () => {
    const dir = scratch("conformance-helpers");
    writeFileSync(join(dir, "a.rs"), "pub fn f() {}");
    writeFileSync(
      join(dir, "yaffle.json"),
      JSON.stringify({
        targets: { rust: { dependencies: { zstd: "0.13", x: { version: "1", features: ["y"] } } } }
      })
    );
    const r = resolveExterns({
      f: join(dir, "a.rs"),
      g: `${join(dir, "a.rs")}#G`,
      h: "crate::h::H"
    });
    expect(r.externs).toEqual({ f: "crate::ext_a::f", g: "crate::ext_a::G", h: "crate::h::H" });
    expect(Object.keys(r.sources)).toEqual(["ext_a"]);
    expect(caseDependencies(dir)).toEqual([
      'zstd = "0.13"',
      'x = { version = "1", features = ["y"] }'
    ]);
  });
});

describe.skipIf(!hasRust)("rust conformance adapter", () => {
  it("is available", async () => {
    expect(await adapter.available()).toBe(true);
  });

  it("runs parse, serialize, round-trip and error cases", async () => {
    const dir = scratch("conformance-case");
    writeFileSync(join(dir, "xor.rs"), XOR_RS);
    const input = join(dir, "input.bin");
    writeFileSync(input, Buffer.from("504c" + "0101" + "00" + "02" + "fefd", "hex"));
    const cases: Case[] = [
      {
        name: "basic",
        root: "Table",
        bytes: "504c" + "020100" + "0200" + "02" + "fefd",
        json: { magic: 0x4c50, count: 2, items: [1, 2], n: 2, secret: "0102" }
      },
      {
        name: "from file",
        root: "Table",
        bytes: { file: input },
        json: { magic: 0x4c50, count: 1, items: [1], n: 2, secret: "0102" }
      },
      { name: "rebuild by value", root: "Table", bytes: { file: input }, roundtrip: "value" },
      { name: "no round trip", root: "Table", bytes: "504c" + "00" + "00", roundtrip: false },
      {
        name: "serialize",
        root: "Table",
        input: { items: [7], secret: "" },
        bytes: "504c" + "01" + "0700" + "00"
      },
      {
        name: "bad magic",
        root: "Table",
        bytes: "ffff",
        error: { phase: "parse", code: "CHECK", path: ["magic"] }
      },
      {
        name: "eof",
        root: "Table",
        bytes: "504c02",
        error: { phase: "parse", code: "EOF", path: ["items", 0] }
      },
      {
        name: "bad input",
        root: "Table",
        input: { items: [70000], secret: "" },
        error: { phase: "serialize", code: "RANGE", path: ["items", 0] }
      },
      // Deliberately wrong expectations: reported, not crashing.
      { name: "wrong json", root: "Table", bytes: "504c" + "00" + "00", json: { magic: 1 } },
      { name: "wrong code", root: "Table", bytes: "ffff", error: { phase: "parse", code: "EOF" } }
    ];
    const results = await adapter.run({
      caseDir: dir,
      program: prog,
      cases,
      workDir: scratch("conformance-work"),
      externs: { xor: `${join(dir, "xor.rs")}#XOR` }
    });
    const byName = Object.fromEntries(results.map(r => [r.name, r]));
    for (const n of [
      "basic",
      "from file",
      "rebuild by value",
      "no round trip",
      "serialize",
      "bad magic",
      "eof",
      "bad input"
    ]) {
      expect(byName[n], JSON.stringify(byName[n])).toMatchObject({ ok: true });
    }
    expect(byName["basic"]!.bytes).toBe("504c" + "020100" + "0200" + "02" + "fefd");
    expect(byName["from file"]!.json).toEqual({
      magic: 0x4c50,
      count: 1,
      items: [1],
      n: 2,
      secret: "0102"
    });
    expect(byName["from file"]!.bytes).toBeUndefined();
    expect(byName["no round trip"]!.bytes).toBeUndefined();
    expect(byName["bad magic"]!.error).toMatchObject({
      phase: "parse",
      code: "CHECK",
      path: ["magic"],
      offset: 0
    });
    expect(byName["bad input"]!.error).toMatchObject({
      phase: "serialize",
      code: "RANGE",
      path: ["items", 0],
      offset: -1
    });
    expect(byName["wrong json"]).toMatchObject({ ok: false });
    expect(byName["wrong json"]!.json).toEqual({
      magic: 0x4c50,
      count: 0,
      items: [],
      n: 0,
      secret: ""
    });
    expect(byName["wrong code"]).toMatchObject({ ok: false });
    expect(byName["wrong code"]!.error!.code).toBe("CHECK");
  }, 300_000);

  it("throws on build failures and skips unsupported programs", async () => {
    await expect(
      adapter.run({
        caseDir: scratch("conformance-bad"),
        program: prog,
        cases: [{ name: "x", root: "Table", bytes: "00" }],
        workDir: scratch("conformance-bad-work"),
        externs: { xor: "crate::nowhere::XOR" }
      })
    ).rejects.toThrow(/cargo build failed/);
    await expect(
      adapter.run({
        caseDir: scratch("conformance-bad"),
        program: prog,
        cases: [{ name: "x", root: "Table", bytes: "00" }],
        workDir: scratch("conformance-bad-work"),
        externs: {}
      })
    ).rejects.toThrow(/not implemented/);
  }, 300_000);
});
