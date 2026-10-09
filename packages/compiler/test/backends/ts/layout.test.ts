/**
 * Placement: alignment origins and offsets, strict padding, layout groups and layout items whose
 * arguments read fields (IR.md §4.4). Each feature is tested on hand-written IR and through the
 * frontend (parse, serialize, canonical JSON, views, edits and rewrites).
 */
import { describe, expect, it, vi } from "vitest";
import type { IrLayoutItem } from "yaffle/ir";
import { build, buildSource, errorOf, expectRoundTrip, hex, toHex } from "./harness.ts";
import * as ir from "./ir.ts";

// Each test generates and typechecks several programs.
vi.setConfig({ testTimeout: 120_000 });

const {
  S,
  f,
  derived,
  program,
  u8,
  u16,
  array,
  count,
  ref,
  fr,
  len,
  vt,
  ptr,
  layered,
  L,
  layoutItem,
  layoutGroup
} = ir;

describe("alignment origin and offset", () => {
  it("offset from the base, and from: file inside a nested @base", async () => {
    const P = program({
      structs: [
        S("A", [f("a", u8), f("b", layered(u8, L.align(4, undefined, { offset: 1 })))]),
        S("In", [f("x", u8), f("y", layered(u8, L.align(4, undefined, { from: "file" })))], {
          base: true
        }),
        S("InB", [f("x", u8), f("y", layered(u8, L.align(4)))], { base: true }),
        S("Out", [f("p", u16), f("in", ref("In")), f("q", u8)]),
        S("OutB", [f("p", u16), f("in", ref("InB"))]),
        S("T", [f("x", u8), f("y", layered(u8, L.align(8, undefined, { from: "file" })))]),
        S("R", [f("t", ptr(ref("T"), "u8")), f("z", u8)])
      ],
      roots: ["A", "Out", "OutB", "R"]
    });
    const m = await build("align-origin", P);
    // (1 + 1) % 4 != 0 → pad until pos 3: (3 + 1) % 4 == 0.
    expect(m.A.parse(hex("01 0000 07"))).toEqual({ a: 1, b: 7 });
    expect(toHex(m.A.serialize({ a: 1, b: 7 }))).toBe("01000007");
    // In starts at 2; y is aligned to 4 from the file start (pos 4), not from In's start (pos 6).
    expect(m.Out.parse(hex("0100 05 00 09 0c"))).toEqual({ p: 1, in: { x: 5, y: 9 }, q: 12 });
    expect(toHex(m.Out.serialize({ p: 1, in: { x: 5, y: 9 }, q: 12 }))).toBe("01000500090c");
    expect(m.OutB.parse(hex("0100 05 000000 09"))).toEqual({ p: 1, in: { x: 5, y: 9 } });
    // A target whose start layout decides: the block is aligned so the file alignment holds.
    const r = m.R.serialize({ t: { x: 1, y: 2 }, z: 3 });
    expect(toHex(r)).toBe("0803" + "000000000000" + "01" + "00000000000000" + "02");
    expect(m.R.parse(r)).toEqual({ t: { x: 1, y: 2 }, z: 3 });
    // Views read the same.
    const v = m.Out.view(hex("0100 05 00 09 0c"));
    expect(v.in.y).toBe(9);
    expect(v.q).toBe(12);
  });

  it("a base's @alignEnd with an offset, and layout items with an offset", async () => {
    const P = program({
      structs: [
        S("B", [f("x", u8)], { base: true, layers: [L.alignEnd(4, undefined, { offset: 1 })] }),
        S("W", [f("b", ref("B")), f("z", u8)]),
        S("Leaf", [f("v", u8)]),
        S("L2", [f("a", ptr(ref("Leaf"), "u8"))], {
          layout: [layoutItem("a", L.align(4, undefined, { offset: 2 }))]
        })
      ],
      roots: ["W", "L2"]
    });
    const m = await build("align-end-offset", P);
    // B is 1 byte, padded until (size + 1) % 4 == 0 → 3 bytes.
    expect(m.W.parse(hex("07 0000 09"))).toEqual({ b: { x: 7 }, z: 9 });
    expect(toHex(m.W.serialize({ b: { x: 7 }, z: 9 }))).toBe("07000009");
    // The target goes where (pos + 2) % 4 == 0: pos 2.
    const out = m.L2.serialize({ a: { v: 5 } });
    expect(toHex(out)).toBe("02" + "00" + "05");
    expect(m.L2.parse(out)).toEqual({ a: { v: 5 } });
  });

  it("from source: aligns from the file start inside a base, with an offset, and checks strict padding", async () => {
    const m = await buildSource(
      "align-src",
      `struct Inner @base {
         u8  k
         u32 v @align(8, from: file)
         u32 w @align(8)
       }
       export struct A {
         u8    pre[3]
         Inner inner
         u8    n
         u8    head[n] @align(4, offset: 3)
         @padUntil(0x30, strict) { u8 a }
       }`
    );
    const value = {
      pre: hex("aabbcc"),
      inner: { k: 1, v: 2, w: 3 },
      n: 2,
      head: hex("eeff"),
      a: 9
    };
    const bytes: Uint8Array = m.A.serialize(value);
    const p = m.A.parse(bytes);
    expect(p.inner.v).toBe(2);
    expect(p.inner.w).toBe(3);
    // inner starts at 3: v aligned from the file start → 8; w aligned from the base (3) → 3 + 16
    expect(toHex(bytes.subarray(8, 12))).toBe("02000000");
    expect(toHex(bytes.subarray(19, 23))).toBe("03000000");
    expectRoundTrip(m.A, bytes);
    // A non-zero fill byte in the strict padding is a CHECK error even outside strict mode.
    const bad = new Uint8Array(bytes);
    bad[bad.length - 1] = 1;
    expect(() => m.A.parse(bad)).toThrow(/CHECK/);
    expect(() => m.A.view(bad).$plain()).toThrow(/CHECK/);
  });

  it("from source: sticky view commits keep a target that meets a layout item's file-origin residue", async () => {
    const m = await buildSource(
      "sticky-residue-src",
      `struct Blk @base {
         u8 n
         u8 ofs
         u8 data[n] at ofs
         layout { data @align(8, from: file, offset: 2) }
       }
       export struct L { u8 pre[3]  Blk blk }`
    );
    // blk at 3; data at file position p with (p + 2) % 8 == 0 → 6, which is 3 from the base.
    const bytes: Uint8Array = m.L.serialize({ pre: hex("010203"), blk: { data: hex("dddd") } });
    expect(toHex(bytes)).toBe("010203" + "0203" + "00" + "dddd");
    expect(toHex(m.L.view(bytes).$commit({ rewrite: true }))).toBe(toHex(bytes));
    const v = m.L.view(bytes);
    v.pre = hex("090909");
    expect(toHex(v.$commit({ rewrite: true }))).toBe("090909" + "0203" + "00" + "dddd");
  });
});

describe("strict padding layers", () => {
  it("checks the fill of a strict layer outside strict mode", async () => {
    const P = program({
      structs: [
        S("P", [
          f("a", layered(u8, L.padAfter(3, undefined, { strict: true }))),
          f("b", layered(u16, L.padUntil(4, ir.fillByte(0xff), { strict: true }))),
          f("c", layered(u8, L.padAfter(1)))
        ])
      ],
      roots: ["P"]
    });
    const m = await build("strict-padding", P);
    expect(m.P.parse(hex("01 000000 0200 ffff 03 55"))).toEqual({ a: 1, b: 2, c: 3 });
    expect(errorOf(() => m.P.parse(hex("01 000100 0200 ffff 03 00")))).toMatchObject({
      code: "CHECK",
      path: ["a"]
    });
    expect(errorOf(() => m.P.parse(hex("01 000000 0200 ff00 03 00")))).toMatchObject({
      code: "CHECK",
      path: ["b"]
    });
    // Non-strict padding (c) is still skipped unchecked.
    expect(toHex(m.P.serialize({ a: 1, b: 2, c: 3 }))).toBe("01000000" + "0200ffff" + "0300");
    const v = m.P.view(hex("01 000100 0200 ffff 03 00"));
    expect(errorOf(() => v.a).code).toBe("CHECK");
  });
});

describe("per-element layout groups", () => {
  const structs = (layout?: IrLayoutItem[]) => [
    S("Leaf", [f("v", u8)]),
    S("Vol", [f("a", ptr(ref("Leaf"), "u8")), f("b", ptr(ref("Leaf"), "u8"))]),
    S(
      "Top",
      [
        derived("n", u8, len(fr("vols", vt.array(vt.struct("Vol"))))),
        f("vols", array(ref("Vol"), count(fr("n", vt.int(8)))))
      ],
      layout ? { layout } : {}
    )
  ];
  const value = {
    vols: [
      { a: { v: 1 }, b: { v: 2 } },
      { a: { v: 3 }, b: { v: 4 } }
    ]
  };

  it("places each element's items in order", async () => {
    const plain = await build("groups-none", program({ structs: structs(), roots: ["Top"] }));
    expect(toHex(plain.Top.serialize(value))).toBe("02" + "0506" + "0708" + "01020304");
    const flat = await build(
      "groups-flat",
      program({
        structs: structs([layoutItem("vols[*].b"), layoutItem("vols[*].a")]),
        roots: ["Top"]
      })
    );
    expect(toHex(flat.Top.serialize(value))).toBe("02" + "0705" + "0806" + "02040103");
    const grouped = await build(
      "groups",
      program({
        structs: structs([layoutGroup("vols", [layoutItem("b"), layoutItem("a")])]),
        roots: ["Top"]
      })
    );
    const out = grouped.Top.serialize(value);
    expect(toHex(out)).toBe("02" + "0605" + "0807" + "02010403");
    expect(grouped.Top.parse(out)).toEqual({ n: 2, ...value });
  });

  it("elements that are targets come first in their group", async () => {
    const P = program({
      structs: [
        S("Leaf", [f("v", u8)]),
        S("Vol", [f("a", ptr(ref("Leaf"), "u8")), f("b", ptr(ref("Leaf"), "u8"))]),
        S(
          "Top",
          [
            derived("n", u8, len(fr("vols", vt.array(vt.struct("Vol"))))),
            f("vols", array(ptr(ref("Vol"), "u8"), count(fr("n", vt.int(8)))))
          ],
          { layout: [layoutGroup("vols", [layoutItem("b"), layoutItem("a")])] }
        )
      ],
      roots: ["Top"]
    });
    const m = await build("groups-ptrs", P);
    const out = m.Top.serialize(value);
    // vol0 @3, its b @5 and a @6; vol1 @7, its b @9 and a @10.
    expect(toHex(out)).toBe("02" + "0307" + "0605" + "02" + "01" + "0a09" + "04" + "03");
    expect(m.Top.parse(out)).toEqual({ n: 2, ...value });
  });

  it("groups apply their layers, and nested paths and leftovers work", async () => {
    const P = program({
      structs: [
        S("Leaf", [f("v", u8)]),
        S("Piece", [f("p", ptr(ref("Leaf"), "u8"))]),
        S("Vol", [
          f("pieces", array(ref("Piece"), count(2))),
          f("c", ptr(ref("Leaf"), "u8")),
          f("d", ptr(ref("Leaf"), "u8"))
        ]),
        S("Top", [f("vols", array(ref("Vol"), count(2)))], {
          layout: [layoutGroup("vols", [layoutItem("d"), layoutItem("pieces[*].p")], L.align(2))]
        })
      ],
      roots: ["Top"]
    });
    const m = await build("groups-nested", P);
    const leaf = (v: number): { v: number } => ({ v });
    const val = {
      vols: [
        { pieces: [{ p: leaf(1) }, { p: leaf(2) }], c: leaf(3), d: leaf(4) },
        { pieces: [{ p: leaf(5) }, { p: leaf(6) }], c: leaf(7), d: leaf(8) }
      ]
    };
    const out = m.Top.serialize(val);
    // inline 8 bytes; group order: d0 p0 p1 d1 p2 p3 (aligned 2), then leftovers c0 c1.
    expect(toHex(out.subarray(8))).toBe("0400010002000800050006" + "03" + "07");
    expect(m.Top.parse(out)).toEqual(val);
  });

  it("from source: places each element's group items in order, then the leftovers", async () => {
    const m = await buildSource(
      "groups-src",
      `struct Piece { u8 n }
       struct Volume {
         u8     nPieces
         Piece *pieces[nPieces] : u8
         Piece *extra : u8
       }
       export struct G {
         u8     nv
         Volume vols[nv]
         layout { vols[*] { pieces[*] } }
       }`
    );
    const value = {
      vols: [
        { pieces: [{ n: 1 }, { n: 2 }], extra: { n: 0xe1 } },
        { pieces: [{ n: 3 }], extra: { n: 0xe2 } }
      ]
    };
    const bytes: Uint8Array = m.G.serialize(value);
    // inline: nv(1) + vol0 (1 + 2 + 1) + vol1 (1 + 1 + 1) = 8, then 1, 2, 3, then e1, e2
    expect(toHex(bytes.subarray(8))).toBe("010203e1e2");
    expectRoundTrip(m.G, bytes);
  });
});

describe("layout items that read fields", () => {
  // Item arguments are evaluated per instance in the write context of the struct that owns the
  // layout (its fields, derived values and params).
  const ENTRY = `export struct E {
    u8 align
    u8 size
    u8 offset
    u8 data[size] at offset
    layout { data @align(align) }
  }`;

  it("aligns a target to the struct's own field; reads follow the stored offset", async () => {
    const m = await buildSource("layout-fields", ENTRY);
    expect(toHex(m.E.serialize({ align: 8, data: hex("cc") }))).toBe("080108" + "0000000000cc");
    expect(toHex(m.E.serialize({ align: 1, data: hex("ddeeff") }))).toBe("010303ddeeff");
    const v = m.E.parse(hex("04 02 03 aabb"));
    expect(v.offset).toBe(3);
    // Re-serializing realigns to the field.
    expect(toHex(m.E.serialize(v))).toBe("04020400aabb");
  });

  it("an alignment below 1 is RANGE", async () => {
    const m = await buildSource("layout-fields-range", ENTRY);
    expect(errorOf(() => m.E.serialize({ align: 0, data: hex("aa") })).code).toBe("RANGE");
  });

  it("derived fields, params, and items in groups read the owning struct", async () => {
    const m = await buildSource(
      "layout-fields-owner",
      `struct Piece { u8 n }
       struct Vol(u8 step) {
         u8     np
         Piece *pieces[np] : u8
         layout { pieces[*] @align(step) }
       }
       export struct P {
         u8       step
         u8       nv
         Vol(step) vols[nv]
       }
       export struct G {
         u8     shift
         u8     nv
         Vol(1) vols[nv]
         layout { vols[*] { pieces[*] @align(1 << shift) } }
       }
       struct Rec { u8 n  u8 ofs  u8 body[n] at ofs }
       export struct R {
         u8  count
         Rec recs[count]
         layout { recs[*].body @align(count * 2) }
       }`
    );
    // P: inline 1 + 1 + (1 + 2) = 5; step 4 → pieces at 8 and 12.
    const p = m.P.serialize({ step: 4, vols: [{ pieces: [{ n: 1 }, { n: 2 }] }] });
    expect(toHex(p)).toBe("040102080c" + "000000" + "01000000" + "02");
    expect(m.P.parse(p).vols[0].pieces.map((x: { n: number }) => x.n)).toEqual([1, 2]);
    // G: the group's alignment comes from G's field, not Vol's param (1).
    const g = m.G.serialize({ shift: 1, vols: [{ pieces: [{ n: 1 }] }, { pieces: [{ n: 2 }] }] });
    // inline 2 + (1 + 1) × 2 = 6; pieces at 6 and 8.
    expect(toHex(g)).toBe("0102" + "0106" + "0108" + "01" + "00" + "02");
    // R: `count` is derived (recs.length), so the alignment is 2 × 2 = 4.
    const r = m.R.serialize({ recs: [{ body: hex("aa") }, { body: hex("bbcc") }] });
    expect(toHex(r)).toBe("020108020c" + "000000aa" + "000000bbcc");
  });

  it("views: changing a field a layout item reads re-lays out on commit", async () => {
    const m = await buildSource("layout-fields-view", ENTRY);
    const bytes = hex("04 02 04 00 aabb");
    expect(toHex(m.E.view(bytes).$commit())).toBe(toHex(bytes));
    expect(toHex(m.E.view(bytes).$commit({ rewrite: true }))).toBe(toHex(bytes));
    const v = m.E.view(bytes);
    v.align = 8;
    const back = m.E.parse(v.$commit());
    expect(back.align).toBe(8);
    expect(back.offset % 8).toBe(0);
    expect(toHex(back.data)).toBe("aabb");
    // An alignment of 0 set through a view fails on commit.
    const z = m.E.view(bytes);
    z.align = 0;
    expect(errorOf(() => z.$commit()).code).toBe("RANGE");
  });
});
