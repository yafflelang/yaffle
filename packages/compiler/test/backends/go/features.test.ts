/**
 * Go backend: strict padding, alignment offsets, virtual fields, derived arrays, writable stream
 * slices, per-element layout groups and layout items that read fields. Most cases use hand-built
 * IR (sources compiled by the frontend, then edited); the last group compiles them from source.
 * The cases run through the Go conformance adapter in parse and view mode.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adapter, type Case, type CaseResult } from "../../../src/backends/go/conformance.ts";
import { generateGoWithInfo } from "../../../src/backends/go/index.ts";
import type {
  IrExpr,
  IrField,
  IrLayer,
  IrMember,
  IrProgram,
  IrStruct,
  IrValueType
} from "../../../src/ir/index.ts";
import { ROOT, compileOk, hasGo } from "./harness.ts";

const d = hasGo ? describe : describe.skip;

// ── IR helpers ───────────────────────────────────────────────────────────────

function struct(p: IrProgram, name: string): IrStruct {
  const s = p.structs.find(x => x.name === name);
  if (!s) throw new Error(`no struct ${name}`);
  return s;
}

function fieldsOf(ms: IrMember[]): IrField[] {
  const out: IrField[] = [];
  for (const m of ms) {
    if (m.kind === "field") out.push(m);
    else if (m.kind === "block") {
      out.push(...fieldsOf(m.members));
      if (m.else) out.push(...fieldsOf(m.else));
    } else if (m.kind === "switch") {
      for (const c of m.cases) out.push(...fieldsOf(c.members));
      if (m.default) out.push(...fieldsOf(m.default));
    }
  }
  return out;
}

function field(p: IrProgram, s: string, name: string): IrField {
  const f = fieldsOf(struct(p, s).members).find(x => x.name === name);
  if (!f) throw new Error(`no field ${s}.${name}`);
  return f;
}

/** The layers of a field's type (it must be layered). */
function layers(f: IrField): IrLayer[] {
  if (f.type.kind !== "layered") throw new Error(`${f.name} has no layers`);
  return f.type.layers;
}

const u8: IrValueType = { kind: "int", bits: 8, signed: false };
const u32: IrValueType = { kind: "int", bits: 32, signed: false };
const bool: IrValueType = { kind: "bool" };
const lit = (n: number, type: IrValueType = { kind: "bigint" }): IrExpr => ({
  kind: "literal",
  value: { kind: "int", value: String(n) },
  type
});
const fld = (name: string, type: IrValueType): IrExpr => ({ kind: "field", name, type });
const builtin = (name: string, args: IrExpr[], type: IrValueType): IrExpr =>
  ({ kind: "call", callee: { kind: "builtin", name }, args, type }) as IrExpr;
const lambda = (param: string, type: IrValueType, body: IrExpr): IrExpr => ({
  kind: "lambda",
  param,
  type,
  body
});
const lp = (name: string, type: IrValueType): IrExpr => ({ kind: "lambdaParam", name, type });
const member = (object: IrExpr, name: string, type: IrValueType): IrExpr => ({
  kind: "member",
  object,
  name,
  type
});
const bin = (op: string, left: IrExpr, right: IrExpr, type: IrValueType = bool): IrExpr =>
  ({ kind: "binary", op, left, right, type }) as IrExpr;
const conv = (operand: IrExpr): IrExpr => ({ kind: "convert", operand, type: { kind: "bigint" } });

// ── running cases ────────────────────────────────────────────────────────────

async function runCases(
  name: string,
  program: IrProgram,
  cases: Case[],
  mode: "parse" | "view"
): Promise<CaseResult[]> {
  const workDir = join(ROOT, `features-${name}-${mode}`);
  mkdirSync(workDir, { recursive: true });
  const run = mode === "view" ? cases.filter(c => c.input === undefined) : cases;
  return adapter.run({
    caseDir: workDir,
    program,
    cases: run.map(c => ({
      ...c,
      bytes: typeof c.bytes === "string" ? c.bytes.replace(/[\s_]/g, "") : c.bytes
    })),
    workDir,
    externs: {},
    mode
  });
}

/** Runs the cases in parse and view mode and checks them like the conformance runner. */
async function check(name: string, program: IrProgram, cases: Case[]): Promise<void> {
  for (const mode of ["parse", "view"] as const) {
    const results = await runCases(name, program, cases, mode);
    for (const r of results) {
      const c = cases.find(x => x.name === r.name)!;
      const where = `${name} › ${c.name} (${mode})`;
      if (c.error) {
        expect(r.error?.code, `${where}: ${r.message ?? ""}`).toBe(c.error.code);
        expect(r.error?.phase, where).toBe(c.error.phase);
        if (c.error.path) expect(r.error?.path, where).toEqual(c.error.path);
        continue;
      }
      expect(r.message, where).toBeUndefined();
      expect(r.ok, `${where}: ${r.message ?? ""}`).toBe(true);
      if (c.json !== undefined) expect(r.json, where).toEqual(c.json);
      const want = typeof c.bytes === "string" ? c.bytes.replace(/[\s_]/g, "") : undefined;
      if (want !== undefined && c.roundtrip !== false) expect(r.bytes, where).toBe(want);
    }
  }
}

// ── strict padding ───────────────────────────────────────────────────────────

d("go: strict padding", () => {
  it("checks a strict layer's fill outside strict mode", async () => {
    const p = compileOk(`
export struct S {
  u8 a @padAfter(2)
  u8 b @padUntil(3, 0xee)
  u8 c @padAfter(1)
}`);
    for (const l of layers(field(p, "S", "a"))) if (l.kind === "padAfter") l.strict = true;
    for (const l of layers(field(p, "S", "b"))) if (l.kind === "padUntil") l.strict = true;
    await check("strict", p, [
      {
        name: "ok",
        root: "S",
        bytes: "01 0000 02 eeee 03 ff",
        json: { a: 1, b: 2, c: 3 },
        roundtrip: false
      },
      { name: "write", root: "S", input: { a: 1, b: 2, c: 3 }, bytes: "01 0000 02 eeee 03 00" },
      {
        name: "bad padAfter fill",
        root: "S",
        bytes: "01 0001 02 eeee 03 00",
        error: { phase: "parse", code: "CHECK", path: ["a"] }
      },
      {
        name: "bad padUntil fill",
        root: "S",
        bytes: "01 0000 02 ee00 03 00",
        error: { phase: "parse", code: "CHECK", path: ["b"] }
      }
    ]);
  }, 300_000);
});

// ── alignment offset and origin ──────────────────────────────────────────────

d("go: alignment origin and offset", () => {
  it("aligns with an offset, on read, write and in layout items", async () => {
    const p = compileOk(`
export struct S {
  u8 a
  u8 b @align(4)
  u8 n
  u8 ofs
  u8 data[n] at ofs
  layout { data @align(4) }
}`);
    const al = layers(field(p, "S", "b")).find(l => l.kind === "align")!;
    if (al.kind === "align") al.offset = lit(1);
    const item = struct(p, "S").layout![0]!;
    const il = item.layers[0]!;
    if (il.kind === "align") il.offset = lit(3);
    // b at 3: (3 + 1) % 4 == 0. data after the 6 inline bytes, at 9: (9 + 3) % 4 == 0.
    await check("align-offset", p, [
      {
        name: "parse",
        root: "S",
        bytes: "01 0000 02 02 09 000000 aabb",
        json: { a: 1, b: 2, n: 2, ofs: 9, data: "aabb" }
      },
      {
        name: "write",
        root: "S",
        input: { a: 1, b: 2, data: "aabb" },
        bytes: "01 0000 02 02 09 000000 aabb"
      }
    ]);
  }, 300_000);

  it("aligns from the file start inside a @base", async () => {
    const p = compileOk(`
struct Inner @base {
  u8 x
  u8 y @align(4)
}
export struct S {
  u8 pre
  Inner i
}`);
    const al = layers(field(p, "Inner", "y")).find(l => l.kind === "align")!;
    if (al.kind === "align") al.from = "file";
    await check("align-file", p, [
      {
        name: "parse",
        root: "S",
        bytes: "aa 01 0000 02",
        json: { pre: 170, i: { x: 1, y: 2 } }
      },
      { name: "write", root: "S", input: { pre: 170, i: { x: 1, y: 2 } }, bytes: "aa 01 0000 02" }
    ]);
  }, 300_000);
});

// ── virtual fields ───────────────────────────────────────────────────────────

d("go: virtual fields", () => {
  it("computes the value on read and derives the parts on write", async () => {
    const src = compileOk(`export struct T { u8 hi  u32 lo  u64 size = (hi << 32) | lo }`);
    const read = field(src, "T", "size").derive!;
    const p = compileOk(`
export struct S {
  u8  hi = size >> 32
  u32 lo = size & 0xffffffff
  u64 size
  u8  after
}`);
    const size = field(p, "S", "size");
    size.type = { kind: "prim", prim: "u40", endian: "inherit" };
    size.virtual = { read };
    delete size.derive;
    delete size.deriveKind;
    size.input = "required";
    for (const n of ["hi", "lo"]) field(p, "S", n).input = "absent";
    await check("virtual", p, [
      {
        name: "parse",
        root: "S",
        bytes: "01 02000000 07",
        json: { hi: 1, lo: 2, size: 4294967298, after: 7 }
      },
      { name: "write", root: "S", input: { size: 4294967298, after: 7 }, bytes: "01 02000000 07" },
      {
        name: "the largest value",
        root: "S",
        input: { size: 1099511627775, after: 7 },
        bytes: "ff ffffffff 07"
      }
    ]);
  }, 300_000);

  it("fails with DERIVE when the parts don't read back", async () => {
    const src = compileOk(`export struct T { u8 hi  u32 lo  u64 size = (hi << 32) | lo }`);
    const read = field(src, "T", "size").derive!;
    const p = compileOk(`
export struct S {
  u8  hi = size >> 33
  u32 lo = size & 0xffffffff
  u64 size
}`);
    const size = field(p, "S", "size");
    size.type = { kind: "prim", prim: "u40", endian: "inherit" };
    size.virtual = { read };
    delete size.derive;
    size.input = "required";
    for (const n of ["hi", "lo"]) field(p, "S", n).input = "absent";
    await check("virtual-derive", p, [
      {
        name: "mismatch",
        root: "S",
        input: { size: 4294967298 },
        bytes: "",
        error: { phase: "serialize", code: "DERIVE", path: ["size"] }
      }
    ]);
  }, 300_000);
});

// ── derived arrays and composite equality ────────────────────────────────────

d("go: derived arrays", () => {
  it("derives an index with indicesWhere and checks an order with sortedBy", async () => {
    const p = compileOk(`
struct Rec { u8 flag  u8 v }
export struct S { u8 r  Rec recs[r]  u8 s  u8 idx[s] }`);
    const recT: IrValueType = { kind: "struct", struct: "Rec" };
    const recsT: IrValueType = { kind: "array", element: recT };
    const idx = field(p, "S", "idx");
    idx.derive = builtin(
      "indicesWhere",
      [
        fld("recs", recsT),
        lambda("x", recT, bin("!=", member(lp("x", recT), "flag", u8), lit(0, u8)))
      ],
      { kind: "array", element: u32 }
    );
    idx.deriveKind = "formula";
    idx.input = "absent";
    const recs = field(p, "S", "recs");
    recs.checks.push({
      expr: bin(
        "==",
        { kind: "it", type: recsT },
        builtin(
          "sortedBy",
          [{ kind: "it", type: recsT }, lambda("k", recT, member(lp("k", recT), "v", u8))],
          recsT
        )
      ),
      message: "recs sorted by v",
      strictOnly: false
    });
    await check("indices", p, [
      {
        name: "write",
        root: "S",
        input: {
          recs: [
            { flag: 0, v: 1 },
            { flag: 1, v: 2 },
            { flag: 3, v: 3 }
          ]
        },
        bytes: "03 0001 0102 0303 02 0102"
      },
      {
        name: "parse",
        root: "S",
        bytes: "02 0001 0102 01 01",
        json: {
          r: 2,
          recs: [
            { flag: 0, v: 1 },
            { flag: 1, v: 2 }
          ],
          s: 1,
          idx: "01"
        }
      },
      {
        name: "unsorted on read",
        root: "S",
        bytes: "02 0002 0101 01 01",
        error: { phase: "parse", code: "CHECK", path: ["recs"] }
      },
      {
        name: "unsorted on write",
        root: "S",
        input: {
          recs: [
            { flag: 0, v: 2 },
            { flag: 1, v: 1 }
          ]
        },
        bytes: "",
        error: { phase: "serialize", code: "CHECK", path: ["recs"] }
      }
    ]);
  }, 300_000);

  it("maps, filters, joins and dedups", async () => {
    const p = compileOk(`
export struct S { u8 n  u8 a[n]  u8 m  u8 b[m] }`);
    const bytesT: IrValueType = { kind: "bytes" };
    const arrU8: IrValueType = { kind: "array", element: u8 };
    const b = field(p, "S", "b");
    // b = unique(concat(filter(a, x => x > 1), map(a, x => x + 1)))
    b.derive = builtin(
      "unique",
      [
        builtin(
          "concat",
          [
            builtin(
              "filter",
              [fld("a", bytesT), lambda("x", u8, bin(">", conv(lp("x", u8)), lit(1)))],
              arrU8
            ),
            builtin(
              "map",
              [
                fld("a", bytesT),
                lambda("x", u8, bin("+", conv(lp("x", u8)), lit(1), { kind: "bigint" }))
              ],
              { kind: "array", element: { kind: "int", bits: 16, signed: false } }
            )
          ],
          { kind: "array", element: { kind: "int", bits: 16, signed: false } }
        )
      ],
      { kind: "array", element: { kind: "int", bits: 16, signed: false } }
    );
    b.deriveKind = "formula";
    b.input = "absent";
    await check("derived", p, [
      // filter(a, > 1) = [3, 2]; map(a, + 1) = [2, 4, 3]; unique → [3, 2, 4]
      { name: "write", root: "S", input: { a: "010302" }, bytes: "03 010302 03 030204" },
      {
        name: "out of range for u8",
        root: "S",
        input: { a: "ff" },
        bytes: "",
        error: { phase: "serialize", code: "RANGE" }
      }
    ]);
  }, 300_000);
});

// ── slice carriers ───────────────────────────────────────────────────────────

d("go: writable stream slices", () => {
  it("assembles the sliced field from its slices", async () => {
    const p = compileOk(`
struct Inner { u16 a  u16 b }
export struct Sliced {
  u8    raw[8]
  Inner first  from raw[0..4]
  Inner second from raw[4..8]
}`);
    const raw = field(p, "Sliced", "raw");
    raw.carrier = "slices";
    raw.input = "absent";
    raw.hidden = true;
    raw.output = false;
    await check("slices", p, [
      {
        name: "parse",
        root: "Sliced",
        bytes: "0100 0200 0300 0400",
        json: { first: { a: 1, b: 2 }, second: { a: 3, b: 4 } }
      },
      {
        name: "write",
        root: "Sliced",
        input: { first: { a: 5, b: 6 }, second: { a: 7, b: 8 } },
        bytes: "0500 0600 0700 0800"
      }
    ]);
  }, 300_000);

  it("fails when overlapping slices disagree, and fills the rest with zeros", async () => {
    const p = compileOk(`
struct Inner { u16 a  u16 b }
export struct Sliced {
  u8    raw[10]
  Inner first  from raw[0..4]
  Inner second from raw[2..6]
}`);
    const raw = field(p, "Sliced", "raw");
    raw.carrier = "slices";
    raw.input = "absent";
    raw.hidden = true;
    raw.output = false;
    await check("slices-overlap", p, [
      {
        name: "agree",
        root: "Sliced",
        input: { first: { a: 1, b: 2 }, second: { a: 2, b: 3 } },
        bytes: "0100 0200 0300 00000000"
      },
      {
        name: "disagree",
        root: "Sliced",
        input: { first: { a: 1, b: 2 }, second: { a: 9, b: 3 } },
        bytes: "",
        error: { phase: "serialize", code: "DERIVE" }
      }
    ]);
  }, 300_000);
});

// ── per-element layout groups ────────────────────────────────────────────────

d("go: per-element layout groups", () => {
  it("places each element's targets together", async () => {
    const p = compileOk(`
struct Vol {
  u8 n
  u8 pOfs
  u8 qOfs
  u8 p[n] at pOfs
  u8 q[n] at qOfs
}
export struct S {
  u8  c
  u8  vOfs
  Vol vols[c] at vOfs
  layout {
    vols
    vols[*].p
    vols[*].q
  }
}`);
    const input = {
      vols: [
        { p: "aa", q: "bb" },
        { p: "cccc", q: "dddd" }
      ]
    };
    // Pull-out: all p, then all q.
    await check("groups-pullout", p, [
      { name: "write", root: "S", input, bytes: "02 02 01080b 02090c aa cccc bb dddd" }
    ]);
    struct(p, "S").layout = [
      { path: [{ kind: "field", name: "vols" }], layers: [] },
      {
        path: [{ kind: "field", name: "vols" }],
        layers: [],
        group: {
          items: [
            { path: [{ kind: "field", name: "p" }], layers: [] },
            { path: [{ kind: "field", name: "q" }], layers: [] }
          ]
        }
      }
    ];
    await check("groups", p, [
      { name: "write", root: "S", input, bytes: "02 02 010809 020a0c aa bb cccc dddd" },
      {
        name: "parse",
        root: "S",
        bytes: "02 02 010809 020a0c aa bb cccc dddd",
        json: {
          c: 2,
          vOfs: 2,
          vols: [
            { n: 1, pOfs: 8, qOfs: 9, p: "aa", q: "bb" },
            { n: 2, pOfs: 10, qOfs: 12, p: "cccc", q: "dddd" }
          ]
        }
      }
    ]);
  }, 300_000);
});

// ── layout item arguments that read fields ───────────────────────────────────

d("go: layout items that read fields", () => {
  it("aligns a target by a field of the struct", async () => {
    const p = compileOk(`
export struct S {
  u8 align
  u8 n
  u8 ofs
  u8 data[n] at ofs
  layout { data @align(align) }
}`);
    await check("dynamic-layout", p, [
      { name: "align 4", root: "S", input: { align: 4, data: "aa" }, bytes: "04 01 04 00 aa" },
      {
        name: "align 8",
        root: "S",
        input: { align: 8, data: "aa" },
        bytes: "08 01 08 0000000000 aa"
      }
    ]);
  }, 300_000);

  it("reads $index, parameters, defaults, and works in @base structs, groups and paths", async () => {
    const p = compileOk(`
struct E { u8 n  u8 o  u8 d[n] at o  layout { d @align($index + 1) } }
export struct Idx { u8 c  E es[c] }

struct P(u8 a) { u8 n  u8 o  u8 d[n] at o  layout { d @align(a) } }
export struct Par { u8 a  P(a) p }

export struct Opt { u8 align ?= 4  u8 n  u8 o  u8 d[n] at o  layout { d @align(align) } }

struct B @base { u8 a  u8 n  u8 o  u8 d[n] at o  layout { d @align(a) } }
export struct Bas { u8 c  B bs[c] }

struct V { u8 n  u8 po  u8 qo  u8 p[n] at po  u8 q[n] at qo }
export struct Grp { u8 a  u8 c  V vs[c]  layout { vs[*] { q @align(a)  p @align(a * 2) } } }

export struct Off { u8 a  i8 k  u8 n  u8 o  u8 d[n] at o  layout { d @align(a, offset: k) } }

export struct Neg { i8 a  u8 n  u8 o  u8 d[n] at o  layout { d @align(a) } }

struct Rec { u8 n  u8 ofs  u8 body[n] at ofs }
export struct Records { u8 count  Rec recs[count]  layout { recs[*].body @align(count * 2) } }
`);
    const grp = {
      a: 2,
      c: 2,
      vs: [
        { n: 1, po: 12, qo: 8, p: "01", q: "02" },
        { n: 1, po: 16, qo: 14, p: "03", q: "04" }
      ]
    };
    await check("dynamic-layout-more", p, [
      {
        name: "$index: element i aligned to i + 1",
        root: "Idx",
        input: { es: [{ d: "01" }, { d: "02" }, { d: "03" }] },
        bytes: "03 0107 0108 0109 01 02 03"
      },
      {
        name: "a parameter",
        root: "Par",
        input: { a: 4, p: { d: "09" } },
        bytes: "04 01 04 00 09"
      },
      {
        name: "an optional input's default",
        root: "Opt",
        input: { d: "aa" },
        bytes: "04 01 04 00 aa"
      },
      {
        name: "@base: each region aligns by its own field",
        root: "Bas",
        bytes: "02 0401040001 0201040002",
        json: {
          c: 2,
          bs: [
            { a: 4, n: 1, o: 4, d: "01" },
            { a: 2, n: 1, o: 4, d: "02" }
          ]
        }
      },
      {
        name: "@base: an alignment of 0 reports the element",
        root: "Bas",
        input: {
          bs: [
            { a: 4, d: "01" },
            { a: 0, d: "02" }
          ]
        },
        error: { phase: "serialize", code: "RANGE", path: ["bs", 1] }
      },
      {
        name: "a group's items read the container's field",
        root: "Grp",
        bytes: "0202 010c08 01100e 02 000000 01 00 04 00 03",
        json: grp
      },
      {
        name: "a group on write",
        root: "Grp",
        input: {
          a: 2,
          vs: [
            { p: "01", q: "02" },
            { p: "03", q: "04" }
          ]
        },
        bytes: "0202 010c08 01100e 02 000000 01 00 04 00 03"
      },
      {
        name: "an alignment offset read from a field",
        root: "Off",
        input: { a: 4, k: 1, d: "07" },
        bytes: "04 01 01 07 000000 07"
      },
      {
        name: "a negative alignment",
        root: "Neg",
        input: { a: -2, d: "aa" },
        error: { phase: "serialize", code: "RANGE", path: [] }
      },
      {
        name: "a pulled-out path",
        root: "Records",
        input: { recs: [{ body: "aa" }, { body: "bbcc" }] },
        bytes: "02 01 08 02 0c 000000 aa 000000 bbcc"
      },
      {
        // The arguments are evaluated per instance, like write formulas, even when the item
        // places nothing.
        name: "an alignment of 0 with nothing to place",
        root: "Records",
        input: { recs: [] },
        error: { phase: "serialize", code: "RANGE", path: [] }
      }
    ]);
  }, 300_000);

  it("rejects arguments that depend on sizes or positions", () => {
    const p = compileOk(`
export struct S { u8 h[3]  u8 n  u8 o  u8 d[n] at o  layout { d @align(sizeof(h)) } }`);
    expect(() => generateGoWithInfo(p, { externs: {}, targetOptions: {} })).toThrow(
      /not implemented: layout item arguments that depend on sizes/
    );
  });
});

// ── the same features from source ────────────────────────────────────────────

const FEATURES = `
struct Model { u8 size  u8 data[size] }

struct Rec {
  Model *model : u8 @nullable
  u8 v
}

export struct Pack {
  u8  r
  Rec records[r]
  u8  s
  u8  index[s] = indicesWhere(records, x => x.model != null)
}

struct Key { u8 name  u8 v }
export struct Keys {
  u8  n
  Key keys[n] where it == sortedBy(it, k => k.name)
}

export struct Node {
  u8  sizeHigh
  u32 sizeLow
  virtual u40 size = (sizeHigh << 32) | sizeLow
}

struct Header { u16 a  u16 b }
struct Footer { u16 c  u16 d }
export struct Overlay {
  u8     raw[8] @hidden
  Header hdr  from raw[0..4]
  Footer foot from raw[4..8]
}

export struct Pads {
  u8 a
  @padUntil(4, strict) { u8 b }
  u8 head[3] @align(4, offset: 1)
}

struct Vol {
  u8 n
  u8 pOfs
  u8 qOfs
  u8 p[n] at pOfs
  u8 q[n] at qOfs
}
export struct Vols {
  u8  c
  u8  vOfs
  Vol vols[c] at vOfs
  layout {
    vols
    vols[*] { p  q }
  }
}
`;

d("go: features from source", () => {
  it("runs every feature", async () => {
    const p = compileOk(FEATURES);
    await check("source", p, [
      {
        name: "indicesWhere over nullable pointers",
        root: "Pack",
        input: {
          records: [
            { model: { data: "aa" }, v: 1 },
            { model: null, v: 2 }
          ]
        },
        bytes: "02 0701 0002 01 00 01aa"
      },
      {
        name: "indicesWhere parse",
        root: "Pack",
        bytes: "02 0701 0002 01 00 01aa",
        json: {
          r: 2,
          records: [
            { model: { size: 1, data: "aa" }, v: 1 },
            { model: null, v: 2 }
          ],
          s: 1,
          index: "00"
        }
      },
      {
        name: "sorted keys",
        root: "Keys",
        bytes: "02 0105 0203",
        json: {
          n: 2,
          keys: [
            { name: 1, v: 5 },
            { name: 2, v: 3 }
          ]
        }
      },
      {
        name: "unsorted keys",
        root: "Keys",
        bytes: "02 0201 0103",
        error: { phase: "parse", code: "CHECK", path: ["keys"] }
      },
      {
        name: "virtual",
        root: "Node",
        bytes: "01 02000000",
        json: { sizeHigh: 1, sizeLow: 2, size: 4294967298 }
      },
      { name: "virtual write", root: "Node", input: { size: 4294967298 }, bytes: "01 02000000" },
      {
        name: "slices",
        root: "Overlay",
        bytes: "0100 0200 0300 0400",
        json: { hdr: { a: 1, b: 2 }, foot: { c: 3, d: 4 } }
      },
      {
        name: "strict fill and offset alignment",
        root: "Pads",
        bytes: "01 02 000000 0000 aabbcc",
        json: { a: 1, b: 2, head: "aabbcc" }
      },
      {
        name: "strict fill violated",
        root: "Pads",
        bytes: "01 02 000100 0000 aabbcc",
        error: { phase: "parse", code: "CHECK" }
      },
      {
        name: "layout group",
        root: "Vols",
        input: {
          vols: [
            { p: "aa", q: "bb" },
            { p: "cccc", q: "dddd" }
          ]
        },
        bytes: "02 02 010809 020a0c aa bb cccc dddd"
      }
    ]);
  }, 300_000);
});
