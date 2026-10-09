/** Cases for conformance/cases/derived-arrays: derived arrays and array checks. */
import { area, parse, parseOnly, perr, ser, serr, type Case } from "../lib.ts";

const cases: Case[] = [];
const add = (...c: Case[]) => cases.push(...c);

// Index: r at 0, s at 1, records at 2..7 (model pointer, flags), index at 8..9; then the model
// targets in record order: records[0].model at 10, records[2].model at 11.
const records = [
  { model: { x: 7 }, flags: 1 },
  { model: null, flags: 0 },
  { model: { x: 9 }, flags: 2 }
];
const indexBytes = "03 02 0a01 0000 0b02 0002 07 09";
add(
  parse("indicesWhere: the records with a model", "Index", indexBytes, {
    r: 3,
    s: 2,
    records,
    index: "0002"
  }),
  ser("indicesWhere on write", "Index", { records }, indexBytes),
  ser("a stale index in the input is ignored", "Index", { records, index: "01" }, indexBytes),
  parseOnly("formulas aren't checked on read", "Index", "03 02 0a01 0000 0b02 0001 07 09", {
    r: 3,
    s: 2,
    records,
    index: "0001"
  }),
  ser("indicesWhere of nothing", "Index", { records: [] }, "00 00"),
  ser(
    "indicesWhere matching nothing",
    "Index",
    {
      records: [
        { model: null, flags: 0 },
        { model: null, flags: 5 }
      ]
    },
    "02 00 0000 0005"
  )
);

// IndexChecked: the same bytes; the index is an input, checked against the rule.
add(
  parse("a check stating the rule", "IndexChecked", indexBytes, {
    r: 3,
    s: 2,
    records,
    index: "0002"
  }),
  perr(
    "a check stating the rule fails on read",
    "IndexChecked",
    "03 02 0a01 0000 0b02 0001 07 09",
    "CHECK",
    ["index"]
  ),
  serr(
    "a check stating the rule fails on write",
    "IndexChecked",
    { records, index: "0001" },
    "CHECK",
    ["index"]
  ),
  ser(
    "a check stating the rule passes on write",
    "IndexChecked",
    { records, index: "0002" },
    indexBytes
  )
);

// Sorted: keys compared by name (code points).
const key = (name: string) => ({ len: new TextEncoder().encode(name).length, name });
add(
  parse("sorted keys", "Sorted", "02 0161 026263", { n: 2, keys: [key("a"), key("bc")] }),
  parse("upper case sorts first (code points)", "Sorted", "02 0142 0161", {
    n: 2,
    keys: [key("B"), key("a")]
  }),
  parse("equal keys are sorted", "Sorted", "02 0161 0161", { n: 2, keys: [key("a"), key("a")] }),
  // U+FFFF < U+1F600 by code point, although UTF-16 orders 0xFFFF after the surrogate 0xD83D
  parse("code point order, not UTF-16 order", "Sorted", "02 03efbfbf 04f09f9880", {
    n: 2,
    keys: [key("￿"), key("\u{1f600}")]
  }),
  perr("unsorted keys fail the check", "Sorted", "02 0162 0161", "CHECK", ["keys"]),
  perr("code point order: reversed", "Sorted", "02 04f09f9880 03efbfbf", "CHECK", ["keys"]),
  serr("unsorted keys fail on write", "Sorted", { keys: [{ name: "b" }, { name: "a" }] }, "CHECK", [
    "keys"
  ]),
  ser("sorted keys on write", "Sorted", { keys: [{ name: "a" }, { name: "b" }] }, "02 0161 0162")
);

// Derived: items (id, kind) = (5, 1), (20, 0), (12, 1).
//   ids = [5, 20, 12]; kinds = unique([1, 0, 1]) = [1, 0]; big = filter(ids, > 10) = [20, 12];
//   all = ids ++ kinds = [5, 20, 12, 1, 0]; byKind = ids sorted (stably) by kind = [20, 5, 12].
const items = [
  { id: 5, kind: 1 },
  { id: 20, kind: 0 },
  { id: 12, kind: 1 }
];
const derived = "03 0501 1400 0c01  03 05140c  02 0100  02 140c  05 05140c0100  03 14050c";
add(
  parse("map, unique, filter, concat and sortedBy", "Derived", derived, {
    n: 3,
    items,
    nIds: 3,
    ids: "05140c",
    nKinds: 2,
    kinds: "0100",
    nBig: 2,
    big: "140c",
    nAll: 5,
    all: "05140c0100",
    nByKind: 3,
    byKind: "14050c"
  }),
  ser("derived arrays on write", "Derived", { items }, derived),
  ser("derived arrays of nothing", "Derived", { items: [] }, "00 00 00 00 00 00")
);

// Structs: items (1, 0), (2, 0), (3, 1): odd = items with an odd id; positions = kind == 0 (u16).
const sItems = [
  { id: 1, kind: 0 },
  { id: 2, kind: 0 },
  { id: 3, kind: 1 }
];
const structs = "03 0100 0200 0301  02 0100 0301  02 0000 0100";
add(
  parse("a derived array of structs and of u16", "Structs", structs, {
    n: 3,
    items: sItems,
    nOdd: 2,
    odd: [sItems[0], sItems[2]],
    nPos: 2,
    positions: [0, 1]
  }),
  ser("a derived array of structs on write", "Structs", { items: sItems }, structs)
);

// Empties: r at 0, records at 1..4, nEmpty at 5, empty at 6; records[0].model at 7.
add(
  parse("x == null", "Empties", "02 0700 0000 01 01 01", {
    r: 2,
    records: [
      { model: { x: 1 }, flags: 0 },
      { model: null, flags: 0 }
    ],
    nEmpty: 1,
    empty: "01"
  }),
  ser(
    "x == null on write",
    "Empties",
    {
      records: [
        { model: { x: 1 }, flags: 0 },
        { model: null, flags: 0 }
      ]
    },
    "02 0700 0000 01 01 01"
  )
);

// Sorts: blobs by their bytes ("01" < "0100" < "02"), desc by 0 - v (descending).
const blobs = [
  { len: 1, data: "01" },
  { len: 2, data: "0100" },
  { len: 1, data: "02" }
];
add(
  parse("sorted by bytes and by a computed key", "Sorts", "03 0101 020100 0102  04 09050501", {
    n: 3,
    blobs,
    m: 4,
    desc: "09050501"
  }),
  perr("bytes out of order", "Sorts", "02 0102 0101  00", "CHECK", ["blobs"]),
  perr("not descending", "Sorts", "00  02 0109", "CHECK", ["desc"])
);

// Overflow: doubled = xs · 2 must fit u8.
add(
  parse("a derived u8 array", "Overflow", "02 0102 0204", { n: 2, xs: "0102", doubled: "0204" }),
  ser("a derived u8 array on write", "Overflow", { xs: "0102" }, "02 0102 0204"),
  serr("a derived element out of range", "Overflow", { xs: "01c8" }, "RANGE")
);

export default area(
  "derived-arrays",
  "Derived arrays: indicesWhere (a set index), map, filter, unique, concat and sortedBy in formulas (counts derived from them), a check stating the rule, sorted keys by code point, bytes and computed keys, arrays of structs and u16, x == null, and range errors.",
  cases
);
