/** Unit tests of the runner's building blocks: hex, canonical JSON, filters, case validation. */
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  diffJson,
  escapePointerToken,
  formatDifferences,
  getPointer,
  jsonEqual,
  parsePointer
} from "../src/canonical.ts";
import { caseSelected, matchPattern, parseFilter, parseTargets } from "../src/filter.ts";
import { diffHex, isCanonicalHex, normalizeHex } from "../src/hex.ts";
import {
  findCaseDirs,
  loadCaseDir,
  loadExterns,
  resolveExternSpec,
  validateCaseFile
} from "../src/load.ts";
import { normalizeCase } from "../src/normalize.ts";
import { makeCaseRoot, tempDir } from "./fake.ts";

describe("hex", () => {
  it("normalizes whitespace, underscores and case", () => {
    expect(normalizeHex(" 0A bc_DE\n01 ")).toBe("0abcde01");
  });
  it("rejects odd lengths and non-hex", () => {
    expect(() => normalizeHex("abc")).toThrow(/odd/);
    expect(() => normalizeHex("zz")).toThrow(/invalid/);
  });
  it("recognizes canonical hex", () => {
    expect(isCanonicalHex("00ff")).toBe(true);
    expect(isCanonicalHex("00FF")).toBe(false);
  });
  it("describes the first difference", () => {
    expect(diffHex("0011", "0011")).toBeUndefined();
    const d = diffHex("00112233", "00119933")!;
    expect(d).toContain("offset 2 (0x2)");
    expect(d).toContain("[22]");
    expect(d).toContain("[99]");
    expect(diffHex("0011", "001122")).toContain("expected 2 bytes, got 3");
  });
});

describe("canonical JSON", () => {
  it("compares scalars exactly, including -0", () => {
    expect(jsonEqual(1, 1)).toBe(true);
    expect(jsonEqual(0, -0)).toBe(false);
    expect(jsonEqual("-0", "-0")).toBe(true);
    expect(jsonEqual("18446744073709551615", 2 ** 64)).toBe(false);
  });
  it("reports missing, extra and wrong fields with JSON Pointers", () => {
    const d = diffJson({ a: 1, b: { c: [1, 2] }, "x/y": 1 }, { a: 2, b: { c: [1, 3] }, z: true });
    const byKind = Object.fromEntries(d.map(x => [x.kind + ":" + x.pointer, x]));
    expect(byKind["value:/a"]).toBeDefined();
    expect(byKind["value:/b/c/1"]).toBeDefined();
    expect(byKind["missing:/x~1y"]).toBeDefined();
    expect(byKind["extra:/z"]).toBeDefined();
  });
  it("treats field order as significant", () => {
    const d = diffJson({ a: 1, b: 2 }, { b: 2, a: 1 });
    expect(d).toHaveLength(1);
    expect(d[0]!.kind).toBe("order");
    expect(formatDifferences(d)).toContain("declaration order");
  });
  it("reports type and length differences", () => {
    expect(diffJson([1], { 0: 1 })[0]!.kind).toBe("type");
    expect(diffJson(null, 0)[0]!.kind).toBe("type");
    expect(diffJson([1, 2], [1])[0]!.kind).toBe("length");
  });
  it("caps the number of differences", () => {
    const e = Array.from({ length: 50 }, (_, i) => i);
    expect(
      diffJson(
        e,
        e.map(x => x + 1),
        5
      )
    ).toHaveLength(5);
  });
  it("resolves JSON Pointers", () => {
    const doc = { a: [{ "m~n": 3, "p/q": 4 }], "": 5 };
    expect(getPointer(doc, "/a/0/m~0n")).toEqual({ found: true, value: 3 });
    expect(getPointer(doc, "/a/0/p~1q")).toEqual({ found: true, value: 4 });
    expect(getPointer(doc, "/")).toEqual({ found: true, value: 5 });
    expect(getPointer(doc, "")).toEqual({ found: true, value: doc });
    expect(getPointer(doc, "/a/1").found).toBe(false);
    expect(getPointer(doc, "/a/01").found).toBe(false);
    expect(getPointer(doc, "/b").found).toBe(false);
    expect(parsePointer("/a~1b/c")).toEqual(["a/b", "c"]);
    expect(escapePointerToken("a/b~c")).toBe("a~1b~0c");
    expect(() => parsePointer("a")).toThrow();
  });
  it("prints readable differences", () => {
    const text = formatDifferences(diffJson({ a: 1, list: [1, 2] }, { a: -0, list: [1] }));
    expect(text).toContain("/a: expected 1, got -0 (number)");
    expect(text).toContain("/list: array length 2 vs 1");
  });
});

describe("filters", () => {
  it("parses include and exclude patterns", () => {
    expect(parseFilter(" a, !b ,*c*,")).toEqual({ include: ["a", "*c*"], exclude: ["b"] });
    expect(parseFilter(undefined)).toEqual({ include: [], exclude: [] });
    expect(parseTargets("ts, rust")).toEqual(["ts", "rust"]);
    expect(parseTargets("")).toBeUndefined();
  });
  it("matches substrings and globs", () => {
    expect(matchPattern("u24", "primitives/u24 max")).toBe(true);
    expect(matchPattern("prim*max", "primitives/u24 max")).toBe(true);
    expect(matchPattern("prim*min", "primitives/u24 max")).toBe(false);
  });
  it("selects cases", () => {
    const f = parseFilter("primitives,extra/*,!slow");
    expect(caseSelected(f, "primitives", "u8")).toBe(true);
    expect(caseSelected(f, "primitives", "slow one")).toBe(false);
    expect(caseSelected(f, "extra/arrays", "0009")).toBe(true);
    expect(caseSelected(f, "strings", "utf8")).toBe(false);
    expect(caseSelected(parseFilter("!extra"), "extra/arrays", "x")).toBe(false);
    expect(caseSelected(parseFilter(""), "anything", "x")).toBe(true);
  });
});

describe("case file validation", () => {
  const valid = {
    cases: [
      { name: "p", root: "A", bytes: "01", json: { x: 1 } },
      { name: "s", root: "A", input: { x: 1 }, bytes: "01" },
      { name: "e", root: "A", bytes: "", error: { phase: "parse", code: "EOF", path: ["x"] } },
      { name: "w", root: "A", input: { x: 300 }, error: { phase: "serialize", code: "RANGE" } },
      {
        name: "f",
        root: "A",
        bytes: { file: "data/x.bin", offset: 4 },
        expect: [{ pointer: "/x", equals: 1 }]
      }
    ]
  };
  it("accepts every kind of case", () => {
    expect(validateCaseFile(valid).problems).toEqual([]);
  });
  const bad = (c: unknown) => validateCaseFile({ cases: [c] }).problems;
  it("rejects malformed cases", () => {
    expect(bad({ root: "A", bytes: "00", json: 1 })).toContain(
      "case #0: `name` must be a non-empty string"
    );
    expect(bad({ name: "x", root: "1A", bytes: "00", json: 1 })[0]).toMatch(/root/);
    expect(bad({ name: "x", root: "A", bytes: "0", json: 1 })[0]).toMatch(/odd/);
    expect(bad({ name: "x", root: "A", json: 1 })[0]).toMatch(/needs `bytes`/);
    expect(bad({ name: "x", root: "A", input: 1 })[0]).toMatch(/expected `bytes`/);
    expect(
      bad({ name: "x", root: "A", bytes: "00", error: { phase: "parse", code: "NOPE" } })[0]
    ).toMatch(/error.code/);
    expect(
      bad({ name: "x", root: "A", bytes: "00", error: { phase: "write", code: "EOF" } })[0]
    ).toMatch(/phase/);
    expect(
      bad({ name: "x", root: "A", bytes: "00", error: { phase: "serialize", code: "EOF" } })[0]
    ).toMatch(/needs `input`/);
    expect(bad({ name: "x", root: "A", bytes: "00", json: 1, input: 1 })[0]).toMatch(/not both/);
    expect(bad({ name: "x", root: "A", bytes: "00", json: 1, roundtrip: "yes" })[0]).toMatch(
      /roundtrip/
    );
    expect(bad({ name: "x", root: "A", bytes: "00", json: 1, typo: 1 })[0]).toMatch(
      /unknown key "typo"/
    );
    expect(
      bad({ name: "x", root: "A", bytes: "00", expect: [{ pointer: "a", equals: 1 }] })[0]
    ).toMatch(/JSON Pointer/);
    expect(bad({ name: "x", root: "A", bytes: "00", expect: [{ pointer: "/a" }] })[0]).toMatch(
      /no check/
    );
    expect(bad({ name: "x", root: "A", bytes: { file: "a", offset: -1 }, json: 1 })[0]).toMatch(
      /offset/
    );
    expect(bad({ name: "x", root: "A", bytes: "00", roundtrip: false })[0]).toMatch(/needs `json`/);
  });
  it("rejects duplicate names and bad files", () => {
    const p = validateCaseFile({
      cases: [
        { name: "a", root: "A", bytes: "", json: {} },
        { name: "a", root: "A", bytes: "", json: {} }
      ]
    }).problems;
    expect(p).toEqual(['case "a": duplicate name']);
    expect(validateCaseFile([]).problems[0]).toMatch(/object/);
    expect(validateCaseFile({ cases: 1 }).problems[0]).toMatch(/array/);
    expect(validateCaseFile({ cases: [], extra: 1 }).problems[0]).toMatch(/unknown top-level key/);
  });
});

describe("case directories", () => {
  it("finds directories with cases.json recursively", () => {
    const root = makeCaseRoot({
      a: { cases: [] },
      "b/c": { cases: [] },
      "b/.hidden": { cases: [] }
    });
    expect(findCaseDirs(root).map(d => d.slice(root.length + 1))).toEqual(["a", "b/c"]);
    expect(findCaseDirs(join(root, "nope"))).toEqual([]);
  });
  it("reports a missing schema, invalid JSON and missing files", () => {
    const root = makeCaseRoot({
      noschema: { cases: [], schema: null },
      badjson: { cases: "{ nope" },
      nofile: { cases: [{ name: "x", root: "A", bytes: { file: "missing.bin" }, json: {} }] }
    });
    expect(loadCaseDir(join(root, "noschema"), "noschema").problems).toContain(
      "missing schema.yfl"
    );
    expect(loadCaseDir(join(root, "badjson"), "badjson").problems[0]).toMatch(/cases.json/);
    expect(loadCaseDir(join(root, "nofile"), "nofile").problems[0]).toMatch(
      /missing.bin does not exist/
    );
  });
  it("keeps #ITEM suffixes and passes non-path specs through", () => {
    const root = makeCaseRoot({ d: { cases: [], files: { "impl/x.rs": "" } } });
    const problems: string[] = [];
    const dir = join(root, "d");
    expect(resolveExternSpec(dir, "./impl/x.rs#XOR", problems, "w")).toBe(
      join(dir, "impl", "x.rs") + "#XOR"
    );
    expect(resolveExternSpec(dir, "crate::hash::fnv1a", problems, "w")).toBe("crate::hash::fnv1a");
    expect(resolveExternSpec(dir, "../nope.rs#X", problems, "w")).toBe(
      join(root, "nope.rs") + "#X"
    );
    expect(problems).toEqual(["yaffle.json: w: ../nope.rs does not exist"]);
  });
  it("resolves extern paths relative to yaffle.json", () => {
    const root = makeCaseRoot({
      d: {
        cases: [],
        files: {
          "impl/x.ts": "export {}",
          "yaffle.json": JSON.stringify({
            sources: ["schema.yfl"],
            targets: {
              ts: { out: "o", externs: { xor: "./impl/x.ts", gone: "./impl/gone.ts" } },
              rust: { out: "o" }
            }
          })
        }
      }
    });
    const problems: string[] = [];
    const ex = loadExterns(join(root, "d"), problems);
    expect(ex.ts!.xor).toBe(join(root, "d", "impl", "x.ts"));
    expect(ex.rust).toBeUndefined();
    expect(problems[0]).toMatch(/gone.ts does not exist/);
  });
});

describe("case normalization", () => {
  it("normalizes hex and keeps it for round-trip checks", () => {
    const n = normalizeCase(
      { name: "a", root: "A", bytes: "0A 0b", expect: [], description: "d" },
      "/x",
      "/tmp/w",
      0
    );
    expect(n.case).toEqual({ name: "a", root: "A", bytes: "0a0b" });
    expect(n.inputHex).toBe("0a0b");
  });
  it("resolves files and slices", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "in.bin"), Buffer.from([1, 2, 3, 4, 5]));
    const work = join(dir, "work");
    const a = normalizeCase({ name: "a", root: "A", bytes: { file: "in.bin" } }, dir, work, 0);
    expect(a.case.bytes).toEqual({ file: join(dir, "in.bin") });
    expect(a.inputHex).toBe("0102030405");
    const b = normalizeCase(
      { name: "b", root: "A", bytes: { file: "in.bin", offset: 1, length: 3 } },
      dir,
      work,
      1
    );
    const f = (b.case.bytes as { file: string }).file;
    expect(f.startsWith(work)).toBe(true);
    expect([...readFileSync(f)]).toEqual([2, 3, 4]);
    expect(b.inputHex).toBe("020304");
    expect(() =>
      normalizeCase(
        { name: "e", root: "A", bytes: { file: "in.bin", offset: 4, length: 9 } },
        dir,
        work,
        4
      )
    ).toThrow(/past the end/);
    expect(existsSync(work)).toBe(true);
  });
});
