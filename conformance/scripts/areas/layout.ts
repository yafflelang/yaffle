/** Cases for conformance/cases/layout. Positions are worked out in the comments. */
import { area, parse, parseOnly, ser, serr, w, type Case, type W } from "../lib.ts";

const cases: Case[] = [];
const add = (...c: Case[]) => cases.push(...c);
const leaf = (v: number) => ({ v });

// Reorder: m at 0; Mid at 1..3 (this first), then b at 3, then a at 4.
add(
  parse("layout reorders targets", "Reorder", "01 0403 bb aa", {
    m: { a: leaf(0xaa), b: leaf(0xbb) }
  }),
  ser(
    "layout reorders targets on write",
    "Reorder",
    { m: { a: leaf(1), b: leaf(2) } },
    "01 0403 02 01"
  ),
  parseOnly("default order also parses", "Reorder", "01 0304 aa bb", {
    m: { a: leaf(0xaa), b: leaf(0xbb) }
  }),
  // ThisMiddle: b at 1, M2 at 2..4, a at 4.
  parse("this between targets", "ThisMiddle", "02 bb 0401 aa", {
    m: { a: leaf(0xaa), b: leaf(0xbb) }
  }),
  ser(
    "this between targets on write",
    "ThisMiddle",
    { m: { a: leaf(1), b: leaf(2) } },
    "02 02 0401 01"
  ),
  // ThisLast: a at 1, b at 2, M3 at 3..5.
  parse("this after targets", "ThisLast", "03 aa bb 0102", { m: { a: leaf(0xaa), b: leaf(0xbb) } }),
  ser(
    "this after targets on write",
    "ThisLast",
    { m: { a: leaf(1), b: leaf(2) } },
    "03 01 02 0102"
  ),
  // Leftovers: Three at 1..4, c at 4, then a at 5 and b at 6.
  parse("leftovers in default order", "Leftovers", "01 050604 cc aa bb", {
    t: { a: leaf(0xaa), b: leaf(0xbb), c: leaf(0xcc) }
  }),
  ser(
    "leftovers on write",
    "Leftovers",
    { t: { a: leaf(1), b: leaf(2), c: leaf(3) } },
    "01 050604 03 01 02"
  )
);

// Pull: inline 2; m1.b at 2, m2.b at 3, Mid1 at 4..6 + its a at 6, Mid2 at 7..9 + its a at 9.
const pullJson = { m1: { a: leaf(0x11), b: leaf(0x12) }, m2: { a: leaf(0x21), b: leaf(0x22) } };
add(
  parse("pulling inner targets out", "Pull", "0407 12 22 0602 11 0903 21", pullJson),
  ser("pulling inner targets out on write", "Pull", pullJson, "0407 12 22 0602 11 0903 21"),
  // PullEach: inline 3; a0 at 3, a1 at 4; Mid0 at 5..7 + b0 at 7; Mid1 at 8..10 + b1 at 10.
  parse("pulling out of every element", "PullEach", "02 0508 10 11 0307 20 040a 21", {
    n: 2,
    ms: [
      { a: leaf(0x10), b: leaf(0x20) },
      { a: leaf(0x11), b: leaf(0x21) }
    ]
  }),
  // One element: n 0, ms0 1 → Mid at 3; a at 2; Mid at 3..5 (a → 2, b → 5); b at 5.
  ser(
    "pulling out of every element, one element",
    "PullEach",
    { ms: [{ a: leaf(1), b: leaf(2) }] },
    "01 03 01 0205 02"
  )
);

// Item alignment: a at 4, b at 8.
add(
  parse("item alignment", "ItemAlign", w().raw("0408").zeros(2).u8(0xaa).zeros(3).u8(0xbb), {
    a: leaf(0xaa),
    b: leaf(0xbb)
  }),
  ser(
    "item alignment on write",
    "ItemAlign",
    { a: leaf(1), b: leaf(2) },
    w().raw("0408").zeros(2).u8(1).zeros(3).u8(2)
  ),
  // ItemAlignNested: Two at 4..6 (align 4), x at 8 (inherits align 4), y at 10 (its own align 2).
  parse(
    "nested items inherit the item alignment unless they set their own",
    "ItemAlignNested",
    w().u8(4).zeros(3).raw("080a").zeros(2).u8(0x77).zeros(1).u8(0x88),
    { t: { x: leaf(0x77), y: leaf(0x88) } }
  ),
  ser(
    "nested item alignment on write",
    "ItemAlignNested",
    { t: { x: leaf(1), y: leaf(2) } },
    w().u8(4).zeros(3).raw("080a").zeros(2).u8(1).zeros(1).u8(2)
  ),
  // ConstraintInLayout: inline 2; data first at 4 (≡ 0 mod 4, so sector 1), then a at 6.
  parse("constraint inside a layout item", "ConstraintInLayout", "06 01 0000 0102 aa", {
    a: leaf(0xaa),
    sector: 1,
    data: "0102"
  }),
  ser(
    "constraint inside a layout item on write",
    "ConstraintInLayout",
    { a: leaf(9), data: "0304" },
    "06 01 0000 0304 09"
  )
);

// TwoLevels: m at 0; m.d.x pulled out first: Leaf at 1; then m's unit without it: Mid2 at 2..4,
// its d target Deep at 4 (x already placed, so Deep holds 1), its l target Leaf at 5.
add(
  parse("pulling out two levels deep", "TwoLevels", "02 11 0405 01 22", {
    m: { d: { x: leaf(0x11) }, l: leaf(0x22) }
  }),
  ser(
    "pulling out two levels deep on write",
    "TwoLevels",
    { m: { d: { x: leaf(1) }, l: leaf(2) } },
    "02 01 0405 01 02"
  ),
  // ThisAligned: t at 0; T3's unit: a at 1, then `this` at align 4 = 4.
  parse("aligned this", "ThisAligned", "04 aa 0000 01", { t: { a: leaf(0xaa) } }),
  ser("aligned this on write", "ThisAligned", { t: { a: leaf(7) } }, "04 07 0000 01"),
  // NullItem: o at 0; Opt at 1..3; a null (nothing placed, no padding), b at 3.
  parse("null item adds no alignment", "NullItem", "01 0003 bb", { o: { a: null, b: leaf(0xbb) } }),
  ser("null item on write", "NullItem", { o: { a: null, b: leaf(1) } }, "01 0003 01"),
  // Non-null: a at align 4 = 4, b at 5.
  parse("non-null item aligned", "NullItem", "01 0405 00 aa bb", {
    o: { a: leaf(0xaa), b: leaf(0xbb) }
  }),
  ser(
    "non-null item aligned on write",
    "NullItem",
    { o: { a: leaf(1), b: leaf(2) } },
    "01 0405 00 01 02"
  ),
  // InlineEach: inline 4 (two Pair2); y0 at 4, y1 at 5, then x0 at 6, x1 at 7.
  parse("each over an inline array", "InlineEach", "0604 0705 20 21 10 11", {
    ps: [
      { x: leaf(0x10), y: leaf(0x20) },
      { x: leaf(0x11), y: leaf(0x21) }
    ]
  }),
  ser(
    "each over an inline array on write",
    "InlineEach",
    {
      ps: [
        { x: leaf(1), y: leaf(2) },
        { x: leaf(3), y: leaf(4) }
      ]
    },
    "0604 0705 02 04 01 03"
  ),
  // RefField: h inline at 0..4; again points back at it.
  parse("@ref to an inline field", "RefField", "0100 0200 00", {
    h: { a: 1, b: 2 },
    again: { $ref: "/h" }
  }),
  ser(
    "@ref to an inline field by identity",
    "RefField",
    { h: { a: 1, b: 2 }, again: { $ref: "/h" } },
    "0100 0200 00"
  ),
  ser(
    "@ref to an inline field by equal value",
    "RefField",
    { h: { a: 1, b: 2 }, again: { a: 1, b: 2 } },
    "0100 0200 00"
  ),
  serr(
    "@ref to an inline field without an equal value",
    "RefField",
    { h: { a: 1, b: 2 }, again: { a: 9, b: 9 } },
    "REF",
    ["again"]
  )
);

// Records: inline 2; y0 at 2, y1 at 4 (align 2); x0 at 5; the records at 6.
const recordsJson = {
  n: 2,
  recsOfs: 6,
  recs: [
    { x: leaf(0x10), y: leaf(0x20) },
    { x: null, y: leaf(0x21) }
  ]
};
add(
  parse(
    "records with targets pulled out per field",
    "Records",
    "02 06 20 00 21 10 0502 0004",
    recordsJson
  ),
  ser(
    "records with targets pulled out per field on write",
    "Records",
    { recs: recordsJson.recs },
    "02 06 20 00 21 10 0502 0004"
  ),
  ser("records with no targets", "Records", { recs: [{ x: null, y: null }] }, "01 02 0000")
);

// RefPool: pool "ab\0cd\0\0" at 0..7, n at 7, items at 8.
add(
  parse("@ref into a pool", "RefPool", w().cstr("ab").cstr("cd").u8(0).u8(2).raw("0300"), {
    pool: ["ab", "cd"],
    n: 2,
    items: [{ name: "cd" }, { name: "ab" }]
  }),
  ser(
    "@ref resolves to the equal pooled string",
    "RefPool",
    { pool: ["ab", "cd"], items: [{ name: "ab" }, { name: "cd" }, { name: "cd" }] },
    w().cstr("ab").cstr("cd").u8(0).u8(3).raw("000303")
  ),
  ser(
    "@ref picks the first equal value",
    "RefPool",
    { pool: ["x", "x"], items: [{ name: "x" }] },
    w().cstr("x").cstr("x").u8(0).u8(1).raw("00")
  ),
  serr("@ref without an equal value", "RefPool", { pool: ["ab"], items: [{ name: "zz" }] }, "REF", [
    "items",
    0,
    "name"
  ]),
  parseOnly(
    "@ref may point into the middle of a string on read",
    "RefPool",
    w().cstr("abc").u8(0).u8(1).raw("01"),
    { pool: ["abc"], n: 1, items: [{ name: "bc" }] }
  )
);

// ── MiniContainer ────────────────────────────────────────────────────────────────────────────────────
interface MiniRecord {
  model: string | null; // data hex
  curves: { x: string; y: string; a: number } | null; // points hex
  motions: { name: string; v: number }[];
}

/** Lays out a MiniContainer exactly as the schema's layout rules say (see the comments in schema.yfl). */
function miniContainer(
  pool: string[],
  records: MiniRecord[],
  index: number[]
): { bytes: W; json: unknown; input: unknown } {
  const out = w().zeros(0x10);
  const poolAt: Record<string, number> = {};
  for (const s of pool) {
    if (!(s in poolAt)) poolAt[s] = out.length;
    out.cstr(s);
  }
  out.u8(0);
  const align = (n: number) => out.align(n);
  // 1. records[*].model @align(8)
  const modelAt: (number | null)[] = records.map(r => {
    if (r.model === null) return null;
    align(8);
    const at = out.length;
    out.u8(r.model.length / 2).raw(r.model);
    return at;
  });
  // 2. records[*] @align(2): per record, curves unit (x.points, y.points, x, y, this), then motions.
  const curvesAt: (number | null)[] = [];
  const motionsAt: number[] = [];
  for (const r of records) {
    if (r.curves === null) curvesAt.push(null);
    else {
      align(2);
      const xp = out.length;
      out.raw(r.curves.x);
      align(2);
      const yp = out.length;
      out.raw(r.curves.y);
      align(2);
      const xAt = out.length;
      out.u8(r.curves.x.length / 2).u8(xp);
      align(2);
      const yAt = out.length;
      out.u8(r.curves.y.length / 2).u8(yp);
      align(2);
      curvesAt.push(out.length);
      out.u8(xAt).u8(yAt).u8(r.curves.a);
    }
    align(2);
    motionsAt.push(out.length);
    for (const m of r.motions) out.u8(poolAt[m.name]!).u8(m.v);
  }
  // 3. records @align(4)
  align(4);
  const recordsOfs = out.length;
  records.forEach((r, i) =>
    out
      .u8(modelAt[i] ?? 0)
      .u8(curvesAt[i] ?? 0)
      .u8(r.motions.length)
      .u8(motionsAt[i]!)
  );
  // 4. recPtrs, 5. index, then @alignEnd(0x10).
  const recPtrsOfs = out.length;
  records.forEach((_, i) => out.u8(recordsOfs + 4 * i));
  const indexOfs = out.length;
  out.raw(index);
  align(0x10);
  out.patch(
    0,
    w().text("CHNK").u8(records.length).u8(index.length).u8(recordsOfs).u8(indexOfs).u8(recPtrsOfs)
  );

  const recJson = records.map((r, i) => {
    const xp = r.curves ? out.out[out.out[curvesAt[i]!]! + 1]! : 0;
    const yp = r.curves ? out.out[out.out[curvesAt[i]! + 1]! + 1]! : 0;
    return {
      model: r.model === null ? null : { size: r.model.length / 2, data: r.model },
      curves:
        r.curves === null
          ? null
          : {
              x: { n: r.curves.x.length / 2, pointsOfs: xp, points: r.curves.x },
              y: { n: r.curves.y.length / 2, pointsOfs: yp, points: r.curves.y },
              a: r.curves.a
            },
      nMotions: r.motions.length,
      motionsOfs: motionsAt[i],
      motions: r.motions
    };
  });
  const hexIndex = w().raw(index).hex();
  const json = {
    magic: "CHNK",
    r: records.length,
    s: index.length,
    recordsOfs,
    indexOfs,
    recPtrsOfs,
    pool,
    records: recJson,
    index: hexIndex,
    recPtrs: records.map((_, i) => ({ $ref: `/records/${i}` }))
  };
  const input = {
    pool,
    records: records.map(r => ({
      model: r.model === null ? null : { data: r.model },
      curves:
        r.curves === null
          ? null
          : { x: { points: r.curves.x }, y: { points: r.curves.y }, a: r.curves.a },
      motions: r.motions
    })),
    index: hexIndex,
    recPtrs: records.map((_, i) => ({ $ref: `/records/${i}` }))
  };
  return { bytes: out, json, input };
}

const two = miniContainer(
  ["idle", "walk"],
  [
    {
      model: "010203",
      curves: { x: "0a0b", y: "0c", a: 0x55 },
      motions: [
        { name: "walk", v: 1 },
        { name: "idle", v: 2 }
      ]
    },
    { model: null, curves: null, motions: [] }
  ],
  [0]
);
const three = miniContainer(
  ["a", "bb", "ccc", "unused"],
  [
    { model: "ff", curves: { x: "01", y: "0203", a: 1 }, motions: [{ name: "ccc", v: 3 }] },
    {
      model: "1122334455",
      curves: { x: "", y: "07", a: 2 },
      motions: [
        { name: "a", v: 4 },
        { name: "bb", v: 5 }
      ]
    },
    { model: null, curves: null, motions: [] }
  ],
  [0, 1]
);
// The first two-record layout, checked by hand: header 0..16, pool 16..27, model at 32, x.points 36,
// y.points 38, x 40, y 42, curves 44, motions 48, records 52, recPtrs 60, index 62, end 64.
if (two.bytes.length !== 64 || (two.json as { recordsOfs: number }).recordsOfs !== 52) {
  throw new Error("MiniContainer layout drifted from the hand-checked offsets");
}
add(
  parse("mini container", "MiniContainer", two.bytes, two.json),
  ser("mini container from its input", "MiniContainer", two.input, two.bytes),
  parse(
    "mini container with three records and an unused string",
    "MiniContainer",
    three.bytes,
    three.json
  ),
  ser(
    "mini container with three records from its input",
    "MiniContainer",
    three.input,
    three.bytes
  ),
  serr(
    "mini container motion name missing from the pool",
    "MiniContainer",
    { ...(two.input as object), pool: ["idle"] },
    "REF",
    ["records", 0, "motions", 0, "name"]
  )
);

export default area(
  "layout",
  "layout items, this, leftovers, pulling out, item alignment, constraints, @ref pools and a miniature container format.",
  cases
);
