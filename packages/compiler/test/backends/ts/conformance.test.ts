/** The conformance adapter runs parse, roundtrip, serialize and error cases through generated code. */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adapter, jsonDiff, type Case } from "../../../src/backends/ts/conformance.ts";
import { OUT } from "./harness.ts";
import { EXTERNS_TS } from "./fixtures/externs.ts";
import * as ir from "./ir.ts";

const {
  S,
  f,
  derived,
  constant,
  program,
  u8,
  u16,
  u32,
  u64,
  array,
  count,
  ref,
  fr,
  len,
  vt,
  layered,
  L,
  codecDecl,
  encodedSize,
  bytes,
  rest
} = ir;

function dirs(name: string): { caseDir: string; workDir: string } {
  const caseDir = join(OUT, `conf-${name}`, "case");
  const workDir = join(OUT, `conf-${name}`, "work");
  rmSync(join(OUT, `conf-${name}`), { recursive: true, force: true });
  mkdirSync(caseDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  return { caseDir, workDir };
}

describe("conformance adapter", () => {
  it("runs parse/roundtrip, serialize and error cases", async () => {
    const P = program({
      structs: [
        S("Entry", [f("x", u16), f("y", u16)]),
        S(
          "Table",
          [
            constant("magic", u32, 0x56435241),
            derived("count", u32, len(fr("entries", vt.array(vt.struct("Entry"))))),
            f("entries", array(ref("Entry"), count(fr("count")))),
            f("big", u64)
          ],
          { params: [ir.p("version", vt.int(32), "bound")] }
        )
      ],
      roots: ["Table"]
    });
    const { caseDir, workDir } = dirs("basic");
    writeFileSync(
      join(caseDir, "input.bin"),
      Buffer.from("4152435600000000ffffffffffffffff", "hex")
    );
    const json = {
      magic: 0x56435241,
      count: 1,
      entries: [{ x: 1, y: 2 }],
      big: "18446744073709551615"
    };
    const cases: Case[] = [
      {
        name: "parse",
        root: "Table",
        args: { version: 1 },
        bytes: "415243560100000001000200ffffffffffffffff",
        json
      },
      {
        name: "file",
        root: "Table",
        args: { version: 1 },
        bytes: { file: join(caseDir, "input.bin") },
        json: { ...json, count: 0, entries: [] }
      },
      {
        name: "serialize",
        root: "Table",
        args: { version: 1 },
        input: { entries: [], big: "1" },
        bytes: "41524356000000000100000000000000"
      },
      {
        name: "bad magic",
        root: "Table",
        args: { version: 1 },
        bytes: "ffff0000",
        error: { phase: "parse", code: "CHECK", path: ["magic"] }
      },
      {
        name: "eof",
        root: "Table",
        args: { version: 1 },
        bytes: "415243560200000001000200",
        error: { phase: "parse", code: "EOF", path: ["entries", 1, "x"] }
      },
      {
        name: "range",
        root: "Table",
        args: { version: 1 },
        input: { entries: [{ x: 70000, y: 0 }], big: "0" },
        error: { phase: "serialize", code: "RANGE", path: ["entries", 0, "x"] }
      },
      {
        name: "wrong json (fails)",
        root: "Table",
        args: { version: 1 },
        bytes: "415243560100000001000200ffffffffffffffff",
        json: { ...json, big: "1" }
      },
      {
        name: "wrong code (fails)",
        root: "Table",
        args: { version: 1 },
        bytes: "ffff0000",
        error: { phase: "parse", code: "EOF" }
      }
    ];
    const results = await adapter.run({ caseDir, program: P, cases, workDir });
    const byName = Object.fromEntries(results.map(r => [r.name, r]));
    for (const n of ["parse", "file", "serialize", "bad magic", "eof", "range"]) {
      expect(byName[n], `${n}: ${byName[n]?.message}`).toMatchObject({ ok: true });
    }
    expect(byName["wrong json (fails)"]!.ok).toBe(false);
    expect(byName["wrong json (fails)"]!.message).toMatch(/\/big/);
    expect(byName["wrong code (fails)"]!.ok).toBe(false);
    expect(byName["parse"]!.json).toEqual(json);
    expect(await adapter.available()).toBe(true);
  });

  it("finds externs through the case's yaffle.json", async () => {
    const P = program({
      structs: [
        S("Packed", [
          derived("comp", u32, encodedSize("data", 1)),
          f("data", layered(bytes(rest), L.via("zstd"), L.size(fr("comp")))),
          f("after", u8)
        ])
      ],
      externs: [codecDecl("zstd")],
      roots: ["Packed"]
    });
    const { caseDir, workDir } = dirs("externs");
    mkdirSync(join(caseDir, "impl"), { recursive: true });
    writeFileSync(join(caseDir, "impl", "codecs.ts"), EXTERNS_TS);
    writeFileSync(
      join(caseDir, "yaffle.json"),
      JSON.stringify({ targets: { ts: { externs: { zstd: "./impl/codecs.ts" } } } })
    );
    const cases: Case[] = [
      { name: "rt", root: "Packed", input: { data: "00112233", after: 7 }, bytes: "" }
    ];
    // First learn the bytes, then check a parse + roundtrip case against them.
    const first = await adapter.run({ caseDir, program: P, cases, workDir });
    const out = first[0]!.bytes!;
    const second = await adapter.run({
      caseDir,
      program: P,
      cases: [
        {
          name: "parse",
          root: "Packed",
          bytes: out,
          json: { comp: (out.length - 10) / 2, data: "00112233", after: 7 }
        }
      ],
      workDir: workDir + "2"
    });
    expect(second[0], second[0]!.message).toMatchObject({ ok: true });
  });

  it("jsonDiff reports the first difference", () => {
    expect(jsonDiff({ a: [1, 2] }, { a: [1, 2] })).toBeUndefined();
    expect(jsonDiff({ a: [1, 3] }, { a: [1, 2] })).toBe("/a/1: expected 2, got 3");
    expect(jsonDiff({ a: 1 }, { a: 1, b: 2 })).toBe("/b: missing");
  });
});
