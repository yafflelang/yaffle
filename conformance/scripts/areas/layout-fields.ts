/**
 * Cases for conformance/cases/layout-fields: layout item attributes that read fields. Layout only
 * affects writing; reads follow the stored offsets.
 */
import { area, parse, ser, serr, type Case } from "../lib.ts";

const cases: Case[] = [];
const add = (...c: Case[]) => cases.push(...c);

// AlignByField: header [align, size, offset] (3 bytes), then `data` aligned to `align` from the
// file start.
add(
  parse("aligned to the entry's own field", "AlignByField", "04 02 04 00 aabb", {
    align: 4,
    size: 2,
    offset: 4,
    data: "aabb"
  }),
  ser("align 8 on write", "AlignByField", { align: 8, data: "cc" }, "08 01 08 0000000000 cc"),
  ser("align 1 adds no padding", "AlignByField", { align: 1, data: "ddeeff" }, "01 03 03 ddeeff"),
  ser(
    "a stored offset that doesn't follow the field is realigned on write",
    "AlignByField",
    { align: 4, data: "aabb" },
    "04 02 04 00 aabb"
  ),
  parse(
    "reads follow the stored offset, whatever the field says",
    "AlignByField",
    "04 02 03 aabb",
    { align: 4, size: 2, offset: 3, data: "aabb" },
    { roundtrip: false }
  ),
  serr("an alignment of 0 is out of range", "AlignByField", { align: 0, data: "aa" }, "RANGE")
);

// TwoTargets: header [shift, n1, o1, n2, o2] (5 bytes); `b` first, aligned to 1 << shift, then
// `a` aligned to 2.
add(
  parse(
    "an expression over a field, and item order",
    "TwoTargets",
    "03 01 0a 02 08 000000 2233 11",
    {
      shift: 3,
      n1: 1,
      o1: 10,
      n2: 2,
      o2: 8,
      a: "11",
      b: "2233"
    }
  ),
  ser(
    "shift 3 on write",
    "TwoTargets",
    { shift: 3, a: "11", b: "2233" },
    "03 01 0a 02 08 000000 2233 11"
  ),
  ser(
    "shift 0: b unaligned, a still aligned to 2",
    "TwoTargets",
    { shift: 0, a: "11", b: "2233" },
    "00 01 08 02 05 2233 00 11"
  )
);

// Records: [count] then count × [n, ofs]; each record's body aligned to count * 2 (a field of the
// struct that owns the layout, not of the record).
add(
  ser(
    "a pulled-out path aligned by the container's field",
    "Records",
    { recs: [{ body: "aa" }, { body: "bbcc" }] },
    // count=2 → align 4; header 1 + 2×2 = 5 bytes; body 0 at 8, body 1 at 12.
    "02 01 08 02 0c 000000 aa 000000 bbcc"
  ),
  parse("pulled-out bodies read back", "Records", "02 01 08 02 0c 000000 aa 000000 bbcc", {
    count: 2,
    recs: [
      { n: 1, ofs: 8, body: "aa" },
      { n: 2, ofs: 12, body: "bbcc" }
    ]
  })
);

export default area(
  "layout-fields",
  "Layout items that read fields: `layout { data @align(align) }`, expressions over fields, item order with field-driven alignment, and pulled-out paths aligned by the container's fields; an alignment of 0 is a RANGE error.",
  cases
);
