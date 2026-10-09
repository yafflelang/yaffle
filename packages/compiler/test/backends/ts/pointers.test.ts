/** Pointers, shared targets, bases, `at` placements, fixed placements, layout and `@ref`. */
import { describe, expect, it } from "vitest";
import { build, dv, errorOf, hex, toHex } from "./harness.ts";
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
  f32,
  array,
  bytes,
  count,
  until,
  ref,
  fr,
  len,
  vt,
  ptr,
  cstr,
  placed,
  offsetof,
  block,
  L,
  layoutItem,
  mul,
  div,
  int,
  strLit,
  str
} = ir;

describe("pointers", () => {
  it("owned, nullable and relative pointers; targets after the inline bytes", async () => {
    const P = program({
      structs: [
        S("Node", [f("v", u16)]),
        S("Root", [
          f("a", ptr(ref("Node"), "u32")),
          f("b", ptr(ref("Node"), "u32", { nullable: true })),
          f("c", ptr(ref("Node"), "i32", { relative: true })),
          f("s", ptr(cstr, "u16"))
        ])
      ],
      roots: ["Root"]
    });
    const m = await build("ptr", P);
    const value = { a: { v: 1 }, b: null, c: { v: 3 }, s: "hi" };
    const out: Uint8Array = m.Root.serialize(value);
    // inline: a(4) b(4) c(4) s(2) = 14; targets in declaration order: a@14, c@16, s@18
    expect(toHex(out)).toBe(
      "0e000000" + "00000000" + "08000000" + "1200" + "0100" + "0300" + "686900"
    );
    expect(m.Root.parse(out)).toEqual(value);
    const withB = m.Root.serialize({ ...value, b: { v: 2 } });
    expect(m.Root.parse(withB)).toEqual({ ...value, b: { v: 2 } });
    expect(() => m.Root.serialize({ ...value, a: null })).toThrow(/not nullable/);
    const bad = m.Root.safeParse(hex("ff000000"));
    expect(bad.error.code).toBe("EOF");
    expect(bad.error.path).toEqual(["a"]);
  });

  it("shared targets: same offset → same object; written once; JSON $ref", async () => {
    const P = program({
      structs: [
        S("Model", [f("id", u32)]),
        S("Rec", [f("m", ptr(ref("Model"), "u32"))]),
        S("Root", [
          derived("n", u8, len(fr("recs", vt.array(vt.struct("Rec"))))),
          f("recs", array(ref("Rec"), count(fr("n", vt.int(8)))))
        ])
      ],
      roots: ["Root"]
    });
    const m = await build("ptr-shared", P);
    const shared = { id: 7 };
    const value = { recs: [{ m: shared }, { m: { id: 8 } }, { m: shared }] };
    const out: Uint8Array = m.Root.serialize(value);
    expect(out.length).toBe(1 + 3 * 4 + 2 * 4);
    expect(dv(out).getUint32(1, true)).toBe(dv(out).getUint32(9, true));
    const v = m.Root.parse(out);
    expect(v.recs[0].m).toBe(v.recs[2].m);
    expect(v.recs[0].m).not.toBe(v.recs[1].m);
    const j = m.Root.toJson(v);
    expect(j).toEqual({
      n: 3,
      recs: [{ m: { id: 7 } }, { m: { id: 8 } }, { m: { $ref: "/recs/0/m" } }]
    });
    const back = m.Root.fromJson(JSON.parse(JSON.stringify(j)));
    expect(back.recs[2].m).toBe(back.recs[0].m);
    expect(toHex(m.Root.serialize(back))).toBe(toHex(out));
  });

  it("nested @base: offsets count from the base struct", async () => {
    const P = program({
      structs: [
        S("Inner", [f("p", ptr(u32, "u8")), f("q", ptr(u32, "u8"))], { base: true }),
        S("Outer", [f("pre", u16), f("inner", ref("Inner")), f("post", u8)])
      ],
      roots: ["Outer"]
    });
    const m = await build("base", P);
    const out = m.Outer.serialize({ pre: 1, inner: { p: 5, q: 6 }, post: 9 });
    // Inner region: p q (2 bytes) then targets at 2 and 6 → 10 bytes; then post
    expect(toHex(out)).toBe("0100" + "0206" + "05000000" + "06000000" + "09");
    expect(m.Outer.parse(out)).toEqual({ pre: 1, inner: { p: 5, q: 6 }, post: 9 });
  });

  it("arrays of pointers, pointer to an array target", async () => {
    const P = program({
      structs: [
        S("Pts", [
          derived("n", u32, len(fr("points", vt.array(vt.float(32))))),
          f("points", ptr(array(f32, count(fr("n"))), "u32"))
        ]),
        S("Root", [f("list", array(ptr(u16, "u8"), count(3))), f("pts", ref("Pts"))])
      ],
      roots: ["Root"]
    });
    const m = await build("ptr-arrays", P);
    const value = { list: [1, 2, 3], pts: { points: [1.5, 2.5] } };
    const out = m.Root.serialize(value);
    expect(m.Root.parse(out)).toEqual({ list: [1, 2, 3], pts: { n: 2, points: [1.5, 2.5] } });
    // list targets come right after the inline bytes (3 + 8 = 11)
    expect(Array.from(out.subarray(0, 3))).toEqual([11, 13, 15]);
  });
});

describe("placements", () => {
  it("`at` with a linear reverse gets a placement constraint", async () => {
    const P = program({
      structs: [
        S("Disk", [
          f("magic", u32),
          derived("sector", u32, div(offsetof("data"), 0x100)),
          derived("size", u32, len(fr("data", vt.bytes))),
          f("data", bytes(count(fr("size"))), {
            placement: placed(mul(fr("sector"), 0x100), { modulus: 0x100 })
          })
        ])
      ],
      roots: ["Disk"]
    });
    const m = await build("at-constraint", P);
    const out: Uint8Array = m.Disk.serialize({ magic: 1, data: new Uint8Array([1, 2, 3]) });
    expect(out.length).toBe(0x103);
    expect(dv(out).getUint32(4, true)).toBe(1);
    expect(Array.from(out.subarray(0x100))).toEqual([1, 2, 3]);
    expect(m.Disk.parse(out)).toEqual({
      magic: 1,
      sector: 1,
      size: 3,
      data: new Uint8Array([1, 2, 3])
    });
  });

  it("fixed placements go exactly there and overlaps are errors", async () => {
    const P = program({
      structs: [
        S("Fixed", [
          f("ofsA", u16),
          f("ofsB", u16),
          f("a", bytes(count(4)), { placement: placed(fr("ofsA"), { fixed: true }) }),
          f("b", bytes(count(4)), { placement: placed(fr("ofsB"), { fixed: true }) }),
          f("c", ptr(u8, "u8"))
        ])
      ],
      roots: ["Fixed"]
    });
    const m = await build("fixed", P);
    const out: Uint8Array = m.Fixed.serialize({
      ofsA: 16,
      ofsB: 5,
      a: new Uint8Array([1, 1, 1, 1]),
      b: new Uint8Array([2, 2, 2, 2]),
      c: 9
    });
    expect(out.length).toBe(21);
    expect(Array.from(out.subarray(16, 20))).toEqual([1, 1, 1, 1]);
    expect(Array.from(out.subarray(5, 9))).toEqual([2, 2, 2, 2]);
    // Layout reaches a (fixed at 16) first: the running position moves past it, so c goes at 20.
    expect(out[4]).toBe(20);
    expect(out[20]).toBe(9);
    const four = { a: new Uint8Array(4), b: new Uint8Array(4), c: 1 };
    expect(errorOf(() => m.Fixed.serialize({ ofsA: 8, ofsB: 10, ...four })).code).toBe("OVERLAP");
    expect(errorOf(() => m.Fixed.serialize({ ofsA: 2, ofsB: 20, ...four })).code).toBe("OVERLAP");
  });

  it("element placements: each element at its own offset", async () => {
    const P = program({
      structs: [
        S("Frag", [constant("magic", u16, 0xf7f3), f("v", u16)]),
        S("Blocks", [
          f("frags", array(ref("Frag"), ir.rest, ir.call("max", [mul(ir.$index, 0x10), int(4)])))
        ])
      ],
      roots: ["Blocks"]
    });
    const m = await build("element-placement", P);
    const value = { frags: [{ v: 1 }, { v: 2 }, { v: 3 }] };
    const out: Uint8Array = m.Blocks.serialize(value);
    expect(out.length).toBe(0x24);
    expect(dv(out).getUint16(4, true)).toBe(0xf7f3);
    expect(dv(out).getUint16(0x10 + 2, true)).toBe(2);
    expect(m.Blocks.parse(out)).toEqual({ frags: value.frags.map(x => ({ magic: 0xf7f3, ...x })) });
  });
});

/**
 * A container with layout rules: records with their models pulled out into one
 * group, per-record targets in the record's own layout, curves with `this` last, motion names
 * as `@ref` pointers into a string pool.
 */
function chunkIr() {
  return program({
    structs: [
      S("Pair", [f("x", f32), f("y", f32)]),
      S("Curve", [
        derived("n", u64, len(fr("points", vt.array(vt.struct("Pair"))))),
        f("points", ptr(array(ref("Pair"), count(fr("n", vt.int(64)))), "u64"))
      ]),
      S(
        "Curves",
        [f("x", ptr(ref("Curve"))), f("y", ptr(ref("Curve"))), f("a", f32), f("b", f32)],
        {
          layout: [
            layoutItem("x.points"),
            layoutItem("y.points"),
            layoutItem("x"),
            layoutItem("y"),
            layoutItem("this")
          ]
        }
      ),
      S("Motion", [
        f("name", ptr(cstr, "u64", { ref: true })),
        f("steps", u16),
        constant("pad", bytes(count(6)), new Uint8Array(6))
      ]),
      S(
        "Record",
        [
          f("model", ptr(bytes(count(16)), "u64", { nullable: true })),
          derived("nMotions", u16, len(fr("motions", vt.array(vt.struct("Motion"))))),
          f("motions", ptr(array(ref("Motion"), count(fr("nMotions", vt.int(16)))), "u64")),
          f("curves", ptr(ref("Curves"), "u64", { nullable: true })),
          f("flags", u16),
          constant("zero", u16, 0)
        ],
        { layout: [layoutItem("curves"), layoutItem("motions")] }
      ),
      S(
        "Chunk",
        [
          block(
            [
              constant("tag", str(count(4), "ascii"), "CHNK"),
              derived("size", u32, int(0)),
              derived("r", u8, len(fr("records", vt.array(vt.struct("Record"))))),
              derived("recordsOfs", u64, offsetof("records")),
              derived("recPtrsOfs", u64, offsetof("recPtrs"))
            ],
            { layers: [L.padUntil(0x20)] }
          ),
          f("pool", array(cstr, until(strLit(""))), {}),
          f("records", array(ref("Record"), count(fr("r", vt.int(8)))), {
            placement: placed(fr("recordsOfs", vt.int(64)))
          }),
          f("recPtrs", array(ptr(ref("Record"), "u64", { ref: true }), count(fr("r", vt.int(8)))), {
            placement: placed(fr("recPtrsOfs", vt.int(64)))
          })
        ],
        {
          base: true,
          layers: [L.alignEnd(0x10)],
          layout: [
            layoutItem("records[*].model", L.align(0x40)),
            layoutItem("records[*]", L.align(8)),
            layoutItem("records", L.align(8)),
            layoutItem("recPtrs")
          ]
        }
      ),
      S("File", [f("chunk", ref("Chunk"))])
    ],
    roots: ["File"]
  });
}

describe("layout (container with target groups)", () => {
  it("pulls models out, orders per-record targets, resolves @ref names into the pool", async () => {
    const P = chunkIr();
    const m = await build("chunk", P);
    const curves = (k: number) => ({
      x: {
        points: [
          { x: 0, y: k },
          { x: 30, y: k + 1 }
        ]
      },
      y: { points: [{ x: 1, y: 2 }] },
      a: 1.5,
      b: 2.5
    });
    const records = [
      {
        model: new Uint8Array(16).fill(0xaa),
        motions: [
          { name: "idle", steps: 1 },
          { name: "walk", steps: 2 }
        ],
        curves: curves(1),
        flags: 3
      },
      { model: null, motions: [], curves: null, flags: 0 },
      {
        model: new Uint8Array(16).fill(0xbb),
        motions: [{ name: "walk", steps: 5 }],
        curves: curves(5),
        flags: 1
      }
    ];
    const value = { chunk: { pool: ["idle", "run", "walk"], records, recPtrs: records } };
    const out: Uint8Array = m.File.serialize(value);
    const v = m.File.parse(out);
    expect(v.chunk.pool).toEqual(["idle", "run", "walk"]);
    expect(v.chunk.records.map((r: { flags: number }) => r.flags)).toEqual([3, 0, 1]);
    expect(v.chunk.records[0].motions.map((x: { name: string }) => x.name)).toEqual([
      "idle",
      "walk"
    ]);
    expect(v.chunk.records[0].curves.x.points).toEqual([
      { x: 0, y: 1 },
      { x: 30, y: 2 }
    ]);
    // recPtrs are @ref pointers to the records themselves: same objects after parsing
    expect(v.chunk.recPtrs[2]).toBe(v.chunk.records[2]);
    // names point into the pool (pool starts at 0x20: "idle\0run\0walk\0\0")
    const d = dv(out);
    const recordsOfs = Number(d.getBigUint64(9, true));
    const recPtrsOfs = Number(d.getBigUint64(17, true));
    expect(recordsOfs % 8).toBe(0);
    expect(Number(d.getBigUint64(recPtrsOfs, true))).toBe(recordsOfs);
    expect(Number(d.getBigUint64(recPtrsOfs + 16, true))).toBe(recordsOfs + 2 * 0x1e);
    const rec0 = recordsOfs;
    const model0 = Number(d.getBigUint64(rec0, true));
    const model2 = Number(d.getBigUint64(rec0 + 2 * 0x1e, true));
    const motions0 = Number(d.getBigUint64(rec0 + 10, true));
    const curves0 = Number(d.getBigUint64(rec0 + 18, true));
    // pulled out: both models first (0x40-aligned), back to back
    expect(model0 % 0x40).toBe(0);
    expect(model2).toBe(model0 + 0x40);
    expect(curves0).toBeGreaterThan(model2);
    // Record layout { curves, motions }: curves unit before motions
    expect(motions0).toBeGreaterThan(curves0);
    // Curves layout { x.points, y.points, x, y, this }: the Curves struct comes last in its unit
    const cx = Number(d.getBigUint64(curves0, true));
    const xPoints = Number(d.getBigUint64(cx + 8, true));
    expect(xPoints).toBeLessThan(cx);
    expect(cx).toBeLessThan(curves0);
    // names: motion 0 "idle" → pool+0, motion 1 "walk" → pool+9
    expect(Number(d.getBigUint64(motions0, true))).toBe(0x20);
    expect(Number(d.getBigUint64(motions0 + 16, true))).toBe(0x20 + 9);
    // byte-exact rebuild from the parsed value
    expect(toHex(m.File.serialize(v))).toBe(toHex(out));
    // and through JSON
    const j = JSON.parse(JSON.stringify(m.File.toJson(v)));
    expect(j.chunk.recPtrs[0]).toEqual({ $ref: "/chunk/records/0" });
    expect(toHex(m.File.serialize(m.File.fromJson(j)))).toBe(toHex(out));
    // alignEnd(0x10) pads the whole base region
    expect(out.length % 0x10).toBe(0);
  });

  it("a @ref without an equal placed value is a REF error", async () => {
    const P = program({
      structs: [
        S("R", [
          f("pool", array(cstr, until(strLit("")))),
          f("name", ptr(cstr, "u32", { ref: true }))
        ])
      ],
      roots: ["R"]
    });
    const m = await build("ref-missing", P);
    const out = m.R.serialize({ pool: ["a", "bb"], name: "bb" });
    expect(toHex(out)).toBe("610062620000" + "02000000");
    expect(m.R.parse(out)).toEqual({ pool: ["a", "bb"], name: "bb" });
    expect(errorOf(() => m.R.serialize({ pool: ["a"], name: "zz" }))).toMatchObject({
      code: "REF",
      path: ["name"]
    });
  });
});
