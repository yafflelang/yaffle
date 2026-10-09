/**
 * Rust backend: pointers, shared targets, placements and the layout engine (IR.md §4),
 * including a chunk-like container with pulled-out groups and `@ref` names into a pool.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { IrExpr } from "../../../src/ir/index.ts";
import { S, e, f, konst, len, lenOf, program, t, vt } from "./ir-builder.ts";
import { build, hasRust, type Built } from "./rust-utils.ts";
import { POOL, RECS, chunk, chunkBytes } from "./fixtures.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ptrs = program(
  [
    S("Node", [f("v", t.u8)]),
    S("P", [
      f("a", t.ptr(t.s("Node"))),
      f("b", t.ptr(t.s("Node"), { nullable: "0" })),
      f("c", t.ptr(t.s("Node"))),
      f("rel", t.ptr(t.u16, { storage: "i32", relative: true })),
      f("list", t.array(t.ptr(t.s("Node"), { storage: "u16" }), len.n(2))),
      f("ff", t.ptr(t.s("Node"), { nullable: "4294967295" }))
    ])
  ],
  ["P"]
);

const recType = vt.array(vt.struct("Rec"));
const places = program(
  [
    S("Rec", [f("id", t.u16), f("w", t.u16)]),
    S("Table", [
      f("count", t.u32, { derive: lenOf("recs", recType) }),
      f("recsOfs", t.u32, { derive: e.offsetof("recs", recType) }),
      f("data", t.bytes(len.n(4))),
      f("recs", t.array(t.s("Rec"), len.count(e.f("count"))), {
        placement: { offset: e.f("recsOfs") }
      })
    ]),
    S("Sectors", [
      f("n", t.u8, { derive: lenOf("blob", vt.bytes) }),
      f("sector", t.u8, { derive: e.div(e.offsetof("blob"), e.int(16)) }),
      f("blob", t.bytes(len.count(e.f("n", vt.u8))), {
        placement: {
          offset: e.mul(e.f("sector", vt.u8), e.int(16)),
          constraint: { modulus: "16", remainder: "0" }
        }
      })
    ]),
    S("Fixed", [
      f("ofsA", t.u8),
      f("ofsB", t.u8),
      f("a", t.bytes(len.n(2)), { placement: { offset: e.f("ofsA", vt.u8), fixed: true } }),
      f("b", t.bytes(len.n(2)), { placement: { offset: e.f("ofsB", vt.u8), fixed: true } }),
      f("c", t.ptr(t.bytes(len.n(3)), { storage: "u8" }))
    ]),
    S("Frag", [konst("magic", t.u8, e.int(0xf7), vt.u8), f("v", t.u8)]),
    S("Frags", [
      f("hdr", t.u32),
      f("frags", t.array(t.s("Frag"), len.rest, e.add(e.mul(e.index, e.int(8)), e.int(4))))
    ])
  ],
  ["Table", "Sectors", "Fixed", "Frags"]
);

// chunk-like container.
// ─── Tests ───────────────────────────────────────────────────────────────────

describe.skipIf(!hasRust)("rust backend: pointers and layout", () => {
  let b: Built;
  beforeAll(async () => {
    b = await build("yaffle_t_pointers", [
      { name: "ptrs", program: ptrs },
      { name: "places", program: places },
      { name: "chunk", program: chunk }
    ]);
  }, 600_000);

  it("compiles without warnings", () => {
    expect(b.warnings, b.log).toBe(0);
  });

  it("follows pointers and preserves shared targets", async () => {
    // this: a(4) b(4) c(4) rel(4) list(2x2) ff(4) = 24 ; a→24 (Node), c→24 (shared), rel → u16 at 25 (25-12=13),
    // list[0] → 27, list[1] → 28 ; ff null.
    const buf = Buffer.alloc(29);
    buf.writeUInt32LE(24, 0);
    buf.writeUInt32LE(0, 4);
    buf.writeUInt32LE(24, 8);
    buf.writeInt32LE(13, 12);
    buf.writeUInt16LE(27, 16);
    buf.writeUInt16LE(28, 18);
    buf.writeUInt32LE(0xffffffff, 20);
    buf.writeUInt8(0x11, 24);
    buf.writeUInt16LE(0x2233, 25);
    buf.writeUInt8(0x44, 27);
    buf.writeUInt8(0x55, 28);
    const bytes = buf.toString("hex");
    const json = await b.value({ op: "parse", module: "ptrs", root: "P", bytes });
    expect(json).toEqual({
      a: { v: 0x11 },
      b: null,
      c: { $ref: "/a" },
      rel: 0x2233,
      list: [{ v: 0x44 }, { v: 0x55 }],
      ff: null
    });
    expect(await b.value({ op: "rebuild", module: "ptrs", root: "P", bytes })).toBe(bytes);
    expect(await b.value({ op: "serialize", module: "ptrs", root: "P", json })).toBe(bytes);
    // Without the $ref, the target is written twice.
    const dup = (await b.value({
      op: "serialize",
      module: "ptrs",
      root: "P",
      json: { ...(json as object), c: { v: 0x11 } }
    })) as string;
    expect(dup.length / 2).toBe(30);
    const back = (await b.value({ op: "parse", module: "ptrs", root: "P", bytes: dup })) as Record<
      string,
      unknown
    >;
    expect(back["c"]).toEqual({ v: 0x11 });
  });

  it("reports pointers outside the region", async () => {
    const buf = Buffer.alloc(24);
    buf.writeUInt32LE(100, 0);
    const err = await b.error({
      op: "parse",
      module: "ptrs",
      root: "P",
      bytes: buf.toString("hex")
    });
    expect(err).toMatchObject({ code: "EOF", path: ["a"] });
  });

  it("places `at` targets after the inline bytes and derives their offsets", async () => {
    const bytes = "02000000" + "0c000000" + "aabbccdd" + "0100" + "0200" + "0300" + "0400";
    await roundtripEq(b, "places", "Table", bytes, {
      count: 2,
      recsOfs: 12,
      data: "aabbccdd",
      recs: [
        { id: 1, w: 2 },
        { id: 3, w: 4 }
      ]
    });
    // A layout that differs from the default reads fine, and rebuilds in the default layout.
    const moved =
      "02000000" + "10000000" + "aabbccdd" + "00000000" + "0100" + "0200" + "0300" + "0400";
    const json = await b.value({ op: "parse", module: "places", root: "Table", bytes: moved });
    expect(json).toMatchObject({ recsOfs: 16 });
    expect(await b.value({ op: "rebuild", module: "places", root: "Table", bytes: moved })).toBe(
      bytes
    );
  });

  it("satisfies placement constraints", async () => {
    // n=3, sector=1 → blob at 16
    const bytes = "03" + "01" + "00".repeat(14) + "010203";
    await roundtripEq(b, "places", "Sectors", bytes, { n: 3, sector: 1, blob: "010203" });
  });

  it("puts fixed placements exactly where they say and detects overlaps", async () => {
    // ofsA=6, ofsB=3: a at 6..8, b at 3..5 ; c is a pointer target placed after the inline bytes (3),
    // skipping fixed ranges: 3 bytes at 3 overlap b → after b at 5 overlaps a at 6 → after a at 8.
    const bytes = "06" + "03" + "08" + "bbbb" + "00" + "aaaa" + "cccccc";
    await roundtripEq(b, "places", "Fixed", bytes, {
      ofsA: 6,
      ofsB: 3,
      a: "aaaa",
      b: "bbbb",
      c: "cccccc"
    });
    const err = await b.error({
      op: "serialize",
      module: "places",
      root: "Fixed",
      json: { ofsA: 4, ofsB: 5, a: "aaaa", b: "bbbb", c: "cccccc" }
    });
    expect(err.code).toBe("OVERLAP");
    const inline = await b.error({
      op: "serialize",
      module: "places",
      root: "Fixed",
      json: { ofsA: 1, ofsB: 8, a: "aaaa", b: "bbbb", c: "cccccc" }
    });
    expect(inline.code).toBe("OVERLAP");
  });

  it("reads element placements until the region end", async () => {
    // hdr(4); frag i at 4 + 8i (2 bytes each); region of 20 bytes → frags at 4, 12 (20 >= end stops)
    const bytes = "aabbccdd" + "f701" + "000000000000" + "f702" + "000000000000";
    await roundtripEq(b, "places", "Frags", bytes.slice(0, 2 * 14), {
      hdr: 0xddccbbaa,
      frags: [
        { magic: 0xf7, v: 1 },
        { magic: 0xf7, v: 2 }
      ]
    });
  });

  it("lays out a chunk-like container byte for byte", async () => {
    const { bytes, offsets } = chunkBytes(POOL, RECS);
    const hex = bytes.toString("hex");
    const json = (await b.value({
      op: "parse",
      module: "chunk",
      root: "Chunk",
      bytes: hex
    })) as Record<string, unknown>;
    expect(json["pool"]).toEqual(POOL);
    expect(json["recordsOfs"]).toBe(offsets["recordsOfs"]);
    const records = json["records"] as Record<string, unknown>[];
    expect(records[0]!["name"]).toBe("beta");
    expect(records[1]!["model"]).toEqual({ n: 2, data: "0909" });
    expect((records[0]!["curves"] as Record<string, unknown>)["x"]).toEqual({
      n: 3,
      points: [0, 30, 45]
    });
    // recPtrs point at the records: one object per address and type.
    const recPtrs = json["recPtrs"] as Record<string, unknown>[];
    expect(recPtrs[0]).toEqual({ $ref: "/records/0" });
    expect(recPtrs[1]).toEqual({ $ref: "/records/1" });
    // Byte-exact rebuilds, directly and through JSON.
    expect(await b.value({ op: "rebuild", module: "chunk", root: "Chunk", bytes: hex })).toBe(hex);
    expect(await b.value({ op: "serialize", module: "chunk", root: "Chunk", json })).toBe(hex);
    expect(await b.value({ op: "jsonRebuild", module: "chunk", root: "Chunk", bytes: hex })).toBe(
      hex
    );
  });

  it("fails @ref pointers without an equal placed value", async () => {
    const { bytes } = chunkBytes(POOL, RECS);
    const json = (await b.value({
      op: "parse",
      module: "chunk",
      root: "Chunk",
      bytes: bytes.toString("hex")
    })) as Record<string, unknown>;
    const records = structuredClone(json["records"]) as Record<string, unknown>[];
    records[0]!["name"] = "nowhere";
    const err = await b.error({
      op: "serialize",
      module: "chunk",
      root: "Chunk",
      json: { ...json, records }
    });
    expect(err).toMatchObject({ code: "REF", path: ["records", 0, "name"] });
  });

  it("keeps nested bases self-contained", async () => {
    const { bytes } = chunkBytes(POOL, RECS.slice(0, 1));
    // The chunk starts 16-aligned: its struct-level @alignEnd counts from the enclosing base.
    const file = Buffer.alloc(16 + bytes.length + 4 + 8);
    file.writeUInt32LE(0xfeedface, 0);
    file.writeUInt32LE(bytes.length, 4);
    bytes.copy(file, 16);
    const trailerAt = 16 + bytes.length + 4;
    file.writeUInt32LE(trailerAt, 16 + bytes.length);
    file.writeUInt32LE(4, trailerAt);
    file.writeUInt32LE(0x04030201, trailerAt + 4);
    const hex = file.toString("hex");
    const json = (await b.value({
      op: "parse",
      module: "chunk",
      root: "File",
      bytes: hex
    })) as Record<string, unknown>;
    expect(json["size"]).toBe(bytes.length);
    expect(json["trailer"]).toEqual({ n: 4, data: "01020304" });
    expect(await b.value({ op: "rebuild", module: "chunk", root: "File", bytes: hex })).toBe(hex);
    expect(await b.value({ op: "serialize", module: "chunk", root: "File", json })).toBe(hex);
  });
});

async function roundtripEq(
  b: Built,
  module: string,
  root: string,
  bytes: string,
  json: unknown
): Promise<void> {
  const got = await b.value({ op: "parse", module, root, bytes });
  expect(got).toEqual(json);
  expect(await b.value({ op: "serialize", module, root, json: got })).toBe(bytes);
  expect(await b.value({ op: "rebuild", module, root, bytes })).toBe(bytes);
}

export type { IrExpr };
