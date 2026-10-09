/** Cases for conformance/cases/arrays. */
import { area, big, parse, parseOnly, perr, ser, serr, w, type Case } from "../lib.ts";

const cases: Case[] = [];
const add = (...c: Case[]) => cases.push(...c);
const p = (x: number, y: number) => ({ x, y });
const hexOf = (n: number, start = 0) =>
  w()
    .raw(Array.from({ length: n }, (_, i) => (start + i) & 0xff))
    .hex();

// ── Counts ──────────────────────────────────────────────────────────────────────────────────────
add(
  parse("counted structs", "Counted", "02000000 0102 0304", {
    count: 2,
    items: [p(1, 2), p(3, 4)]
  }),
  parse("counted zero", "Counted", "00000000", { count: 0, items: [] }),
  perr("counted eof inside an element", "Counted", "03000000 0102 0304 05", "EOF", [
    "items",
    2,
    "y"
  ]),
  perr("counted eof at an element", "Counted", "03000000 0102 0304", "EOF", ["items", 2, "x"]),
  ser("counted derives the count", "Counted", { items: [p(9, 8)] }, "01000000 0908"),
  ser("counted ignores a given count", "Counted", { count: 7, items: [p(9, 8)] }, "01000000 0908"),
  ser(
    "counted u8 255 elements",
    "CountedU8",
    { items: Array.from({ length: 255 }, () => p(0, 1)) },
    w().u8(255).raw("0001".repeat(255))
  ),
  serr(
    "counted u8 256 elements overflow the count",
    "CountedU8",
    { items: Array.from({ length: 256 }, () => p(0, 1)) },
    "RANGE",
    ["count"]
  ),
  parse("u64 count is a string", "CountU64", "0300000000000000 aabbcc", { n: "3", b: "aabbcc" }),
  perr("huge u64 count runs out of bytes", "CountU64", "ffffffffffffffff aabb", "EOF", ["b"]),
  ser("u64 count derived", "CountU64", { b: "0102" }, "0200000000000000 0102"),
  parse("fixed count", "FixedCount", "0100 0200 0300", { v: [1, 2, 3] }),
  serr("fixed count with the wrong length", "FixedCount", { v: [1, 2] }, "DERIVE", ["v"]),
  parse("bool array", "BoolArr", "03 000100", { n: 3, flags: [false, true, false] }),
  parseOnly("bool array nonzero is true", "BoolArr", "01 05", { n: 1, flags: [true] }),
  parse("i8 array is an array of numbers", "I8Arr", "02 ff80", { n: 2, vals: [-1, -128] }),
  parse("u8 array is bytes", "U8Arr", "03 0102ff", { n: 3, vals: "0102ff" }),
  parse("u8 array empty is an empty hex string", "U8Arr", "00", { n: 0, vals: "" }),
  ser("u8 array from hex", "U8Arr", { vals: "deadbeef" }, "04 deadbeef"),
  serr("u8 array odd hex is invalid input", "U8Arr", { vals: "abc" }, "INPUT", ["vals"]),
  serr("u8 array uppercase or non-hex is invalid input", "U8Arr", { vals: "zz" }, "INPUT", [
    "vals"
  ]),
  parse("f32 array keeps special values", "F32Arr", "02 0000c07f 00000080", {
    n: 2,
    vals: ["NaN", "-0"]
  }),
  parse("u64 array elements are strings", "U64Arr", "01 ffffffffffffffff", {
    n: 1,
    vals: [big(2n ** 64n - 1n)]
  })
);

// ── until ───────────────────────────────────────────────────────────────────────────────────────
add(
  parse("until terminator", "Until", "0100 0200 ffff", { list: [1, 2] }),
  parse("until immediately", "Until", "ffff", { list: [] }),
  perr("until missing terminator", "Until", "0100 0200", "EOF", ["list", 2]),
  ser("until writes the terminator", "Until", { list: [7] }, "0700 ffff"),
  serr("until element equal to the terminator", "Until", { list: [1, 0xffff] }, "INPUT", [
    "list",
    1
  ]),
  parse("until bytes", "UntilBytes", "616200", { data: "6162" }),
  ser("until bytes writes the terminator", "UntilBytes", { data: "ff" }, "ff00"),
  serr("until bytes containing the terminator", "UntilBytes", { data: "6100" }, "INPUT", ["data"]),
  parse("until a negative terminator", "UntilSigned", "01 02 ff 07", { vals: [1, 2], after: 7 }),
  parse("until compares values, not raw bytes", "UntilSigned", "80 ff 00", {
    vals: [-128],
    after: 0
  })
);

// ── [] to the end of the region ─────────────────────────────────────────────────────────────────
add(
  parse("rest of the input", "Rest", "05 0100 0200", { tag: 5, vals: [1, 2] }),
  parse("rest empty", "Rest", "05", { tag: 5, vals: [] }),
  perr("rest element crossing the end", "Rest", "05 0100 02", "EOF", ["vals", 1]),
  parse("rest bytes", "RestBytes", "01 aabb", { tag: 1, rest: "aabb" }),
  parse("rest bytes empty", "RestBytes", "01", { tag: 1, rest: "" }),
  ser("rest bytes write", "RestBytes", { tag: 2, rest: "00ff" }, "02 00ff"),
  parse("rest structs", "RestStructs", "0102 0304", { pts: [p(1, 2), p(3, 4)] }),
  perr("rest structs partial element", "RestStructs", "0102 03", "EOF", ["pts", 1, "y"]),
  ser("rest structs write", "RestStructs", { pts: [p(5, 6)] }, "0506")
);

// ── Shared counts ───────────────────────────────────────────────────────────────────────────────
add(
  parse("shared count", "Shared", "02 0100 0200 0a0b", { n: 2, a: [1, 2], b: "0a0b" }),
  ser("shared count derived", "Shared", { a: [3], b: "0c" }, "01 0300 0c"),
  ser("shared count both empty", "Shared", { a: [], b: "" }, "00"),
  serr("shared counts disagree", "Shared", { a: [1, 2], b: "0a0b0c" }, "DERIVE")
);

// ── Reversible arithmetic ───────────────────────────────────────────────────────────────────────
add(
  parse("pairs * 2", "Pairs", "02 0100 0200 0300 0400", { pairs: 2, ids: [1, 2, 3, 4] }),
  ser("pairs derived by halving", "Pairs", { ids: [5, 6] }, "01 0500 0600"),
  ser("pairs zero", "Pairs", { ids: [] }, "00"),
  serr("pairs odd length", "Pairs", { ids: [1, 2, 3] }, "DERIVE"),
  parse("plus one", "PlusOne", "02 aabbcc", { nMinus1: 2, data: "aabbcc" }),
  ser("plus one derived", "PlusOne", { data: "aa" }, "00 aa"),
  serr("plus one empty array makes the count negative", "PlusOne", { data: "" }, "RANGE", [
    "nMinus1"
  ]),
  parse("minus two", "MinusTwo", "05 aabbcc", { nPlus2: 5, data: "aabbcc" }),
  ser("minus two derived", "MinusTwo", { data: "" }, "02"),
  perr("minus two negative length on read", "MinusTwo", "01", "RANGE", ["data"]),
  serr("minus two count overflows", "MinusTwo", { data: hexOf(254) }, "RANGE", ["nPlus2"]),
  parse("shifted", "Shifted", w().u8(2).raw(hexOf(8)), { words: 2, data: hexOf(8) }),
  ser("shifted derived", "Shifted", { data: hexOf(4, 9) }, w().u8(1).raw(hexOf(4, 9))),
  serr("shifted not divisible", "Shifted", { data: hexOf(5) }, "DERIVE"),
  parse("affine", "Affine", w().u16(2).raw(hexOf(8)), { n: 2, v: hexOf(8) }),
  ser("affine derived", "Affine", { v: hexOf(5) }, w().u16(1).raw(hexOf(5))),
  ser("affine minimum", "Affine", { v: hexOf(2) }, w().u16(0).raw(hexOf(2))),
  serr("affine not divisible", "Affine", { v: hexOf(4) }, "DERIVE")
);

// ── Irreversible counts ─────────────────────────────────────────────────────────────────────────
add(
  parse("irreversible count", "Irreversible", "0a 0102", { n: 10, flags: "0102" }),
  parse("irreversible count zero", "Irreversible", "00", { n: 0, flags: "" }),
  ser("irreversible count is an input", "Irreversible", { n: 9, flags: "ff01" }, "09 ff01"),
  serr("irreversible count disagrees", "Irreversible", { n: 10, flags: "01" }, "DERIVE"),
  serr("irreversible count missing", "Irreversible", { flags: "01" }, "INPUT", ["n"]),
  parse("product count", "Product", "02 03 0100 0200 0300 0400 0500 0600", {
    rows: 2,
    cols: 3,
    cells: [1, 2, 3, 4, 5, 6]
  }),
  ser("product count inputs", "Product", { rows: 1, cols: 2, cells: [7, 8] }, "01 02 0700 0800"),
  serr("product count disagrees", "Product", { rows: 2, cols: 3, cells: [1, 2, 3, 4, 5] }, "DERIVE")
);

// ── Nested and negative counts ──────────────────────────────────────────────────────────────────
add(
  parse("nested counts", "Nested", "02 01aa 02bbcc", {
    n: 2,
    rows: [
      { m: 1, vals: "aa" },
      { m: 2, vals: "bbcc" }
    ]
  }),
  ser(
    "nested counts derived",
    "Nested",
    { rows: [{ vals: "" }, { vals: "0102" }] },
    "02 00 020102"
  ),
  perr("negative count", "SignedCount", "ff", "RANGE", ["b"]),
  parse("signed count positive", "SignedCount", "02 aabb", { n: 2, b: "aabb" }),
  ser("signed count derived", "SignedCount", { b: "01" }, "01 01"),
  serr("signed count overflow", "SignedCount", { b: hexOf(128) }, "RANGE", ["n"])
);

export default area(
  "arrays",
  "Counts, until, rest, derived/shared counts, reversible count arithmetic with divisibility, irreversible counts.",
  cases
);
