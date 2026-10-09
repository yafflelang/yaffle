/** Cases for conformance/cases/padding. */
import { area, parse, parseOnly, perr, ser, serr, w, type Case } from "../lib.ts";

const cases: Case[] = [];
const add = (...c: Case[]) => cases.push(...c);

add(
  parse("pad before", "PadBefore", w().u8(1).zeros(3).u32(2), { a: 1, b: 2 }),
  parseOnly("pad before skips without checking", "PadBefore", w().u8(1).raw("ffffff").u32(2), {
    a: 1,
    b: 2
  }),
  ser("pad before writes zeros", "PadBefore", { a: 1, b: 2 }, w().u8(1).zeros(3).u32(2)),
  parse("pad after with a fill byte", "PadAfter", w().u32(7).fill(4, 0xcc).u8(9), { b: 7, c: 9 }),
  parseOnly("pad after fill not checked", "PadAfter", w().u32(7).zeros(4).u8(9), { b: 7, c: 9 }),
  ser("pad after writes the fill", "PadAfter", { b: 7, c: 9 }, w().u32(7).fill(4, 0xcc).u8(9)),
  perr("pad after past the end", "PadAfter", w().u32(7).fill(2, 0xcc), "EOF", ["b"]),
  parse("align", "Align", w().u8(1).zeros(7).raw("01020304"), { x: 1, data: "01020304" }),
  ser(
    "align writes zero padding",
    "Align",
    { x: 1, data: "aabbccdd" },
    w().u8(1).zeros(7).raw("aabbccdd")
  ),
  perr("align past the end", "Align", w().u8(1).zeros(3), "EOF", ["data"]),
  parse("align already aligned", "AlignNoop", w().u32(5).raw("0102"), { x: 5, y: "0102" }),
  parse("align fill function", "AlignFn", w().u8(1).raw("a0a1a2a3a4a5a6").raw("0102"), {
    x: 1,
    tail: "0102"
  }),
  ser(
    "align fill function on write",
    "AlignFn",
    { x: 9, tail: "ffff" },
    w().u8(9).raw("a0a1a2a3a4a5a6").raw("ffff")
  ),
  parseOnly("align fill function not checked", "AlignFn", w().u8(1).zeros(7).raw("0102"), {
    x: 1,
    tail: "0102"
  }),
  perr(
    "align fill function checked in strict mode",
    "AlignFn",
    w().u8(1).zeros(7).raw("0102"),
    "CHECK",
    ["tail"],
    { strict: true }
  ),
  parse(
    "align fill function accepted in strict mode",
    "AlignFn",
    w().u8(1).raw("a0a1a2a3a4a5a6").raw("0102"),
    { x: 1, tail: "0102" },
    { strict: true }
  ),
  parse("align several fields", "AlignBig", w().u8(1).zeros(7).u64(2).u8(3).zeros(3).u32(4), {
    a: 1,
    b: "2",
    c: 3,
    d: 4
  })
);

add(
  parse("pad until", "PadUntil", w().cstr("hello").fill(2, 0xff).u8(7), {
    name: "hello",
    after: 7
  }),
  ser(
    "pad until writes the fill",
    "PadUntil",
    { name: "hi", after: 1 },
    w().cstr("hi").fill(5, 0xff).u8(1)
  ),
  ser(
    "pad until exactly full",
    "PadUntil",
    { name: "1234567", after: 1 },
    w().cstr("1234567").u8(1)
  ),
  perr("pad until content too large", "PadUntil", w().cstr("hellohello").u8(1), "CHECK", ["name"]),
  serr(
    "pad until content too large on write",
    "PadUntil",
    { name: "12345678", after: 1 },
    "INPUT",
    ["name"]
  ),
  parse("pad until exact size", "PadUntilExact", w().text("ABCD").u8(1), { tag: "ABCD", after: 1 }),
  parse("pad until a struct", "PadUntilStruct", w().u8(1).u16(2).zeros(3).u8(3), {
    s: { a: 1, b: 2 },
    after: 3
  }),
  ser(
    "pad until a struct on write",
    "PadUntilStruct",
    { s: { a: 1, b: 2 }, after: 3 },
    w().u8(1).u16(2).zeros(3).u8(3)
  ),
  parse("struct-level pad until", "UsesHeader", w().text("TEST").u32(5).zeros(8).u8(1), {
    h: { tag: "TEST", n: 5 },
    after: 1
  }),
  ser(
    "struct-level pad until on write",
    "UsesHeader",
    { h: { n: 5 }, after: 1 },
    w().text("TEST").u32(5).zeros(8).u8(1)
  ),
  parse("struct-level align end", "UsesTail", w().u8(1).u8(2).raw("0304").zeros(4).u8(5), {
    pre: 1,
    s: { a: 2, b: "0304" },
    post: 5
  }),
  ser(
    "struct-level align end on write",
    "UsesTail",
    { pre: 1, s: { a: 2, b: "0304" }, post: 5 },
    w().u8(1).u8(2).raw("0304").zeros(4).u8(5)
  ),
  parse("align counts from the nearest base", "Based", w().u8(9).u8(1).zeros(3).u8(2), {
    pre: 9,
    s: { a: 1, b: 2 }
  }),
  ser(
    "align counts from the nearest base on write",
    "Based",
    { pre: 9, s: { a: 1, b: 2 } },
    w().u8(9).u8(1).zeros(3).u8(2)
  ),
  parse("dynamic pad count", "PadExpr", w().u8(3).zeros(3).u8(7), { n: 3, v: 7 }),
  parse("dynamic pad count zero", "PadExpr", w().u8(0).u8(7), { n: 0, v: 7 }),
  ser("dynamic pad count is an input", "PadExpr", { n: 2, v: 7 }, w().u8(2).zeros(2).u8(7))
);

add(
  parse("size window with padding", "SizeLayer", w().raw("0102").zeros(2).u8(3), {
    data: "0102",
    after: 3
  }),
  ser(
    "size window writes padding",
    "SizeLayer",
    { data: "0102", after: 3 },
    w().raw("0102").zeros(2).u8(3)
  ),
  parseOnly("size window padding not checked", "SizeLayer", w().raw("0102").raw("ffff").u8(3), {
    data: "0102",
    after: 3
  }),
  perr(
    "size window padding checked in strict mode",
    "SizeLayer",
    w().raw("0102").raw("ff00").u8(3),
    "CHECK",
    ["data"],
    { strict: true }
  ),
  parse("size window bounds a rest array", "SizeRest", w().u8(3).raw("aabbcc").u8(1), {
    n: 3,
    data: "aabbcc",
    after: 1
  }),
  ser(
    "size of a rest array is derived",
    "SizeRest",
    { data: "0102", after: 9 },
    w().u8(2).raw("0102").u8(9)
  ),
  perr("size window past the end", "SizeRest", w().u8(5).raw("aabb"), "EOF", ["data"])
);

add(
  parse("strict padding zero", "StrictPad", w().u8(1).zeros(2).u8(2), { a: 1, b: 2 }),
  perr("strict padding nonzero", "StrictPad", w().u8(1).raw("0100").u8(2), "CHECK", ["a"]),
  parse("strict struct fill", "StrictStruct", w().u8(1).raw("eeee").u8(2), { a: 1, b: 2 }),
  perr("strict struct wrong fill", "StrictStruct", w().u8(1).zeros(2).u8(2), "CHECK", ["a"]),
  parse("strict fill function", "StrictFn", w().u8(1).raw("010203").u8(2), { x: 1, y: 2 }),
  perr("strict fill function mismatch", "StrictFn", w().u8(1).raw("010303").u8(2), "CHECK", ["y"]),
  ser("strict fill function on write", "StrictFn", { x: 1, y: 2 }, w().u8(1).raw("010203").u8(2)),
  parseOnly("lax padding not checked", "LaxPad", w().u8(1).raw("ffff").u8(2), { a: 1, b: 2 }),
  perr(
    "lax padding checked in strict mode",
    "LaxPad",
    w().u8(1).raw("ffff").u8(2),
    "CHECK",
    ["a"],
    { strict: true }
  ),
  parse(
    "lax padding zero in strict mode",
    "LaxPad",
    w().u8(1).zeros(2).u8(2),
    { a: 1, b: 2 },
    { strict: true }
  )
);

add(
  parse("attribute order: align then pad", "Order1", w().u8(1).zeros(3).zeros(1).u16(0x0203), {
    a: 1,
    v: 0x0203
  }),
  ser(
    "attribute order: align then pad on write",
    "Order1",
    { a: 1, v: 2 },
    w().u8(1).zeros(4).u16(2)
  ),
  parse("attribute order: pad then align", "Order2", w().u8(1).zeros(3).u16(0x0203), {
    a: 1,
    v: 0x0203
  }),
  ser(
    "attribute order: pad then align on write",
    "Order2",
    { a: 1, v: 2 },
    w().u8(1).zeros(3).u16(2)
  ),
  parse("attribute order: pad after then align end", "Order3", w().u8(1).zeros(3).u8(2), {
    a: 1,
    b: 2
  }),
  parse("continued attribute lines", "Continued", w().u8(1).zeros(7).u64(2).zeros(2).u8(3), {
    a: 1,
    b: "2",
    c: 3
  }),
  ser(
    "continued attribute lines on write",
    "Continued",
    { a: 1, b: "2", c: 3 },
    w().u8(1).zeros(7).u64(2).zeros(2).u8(3)
  )
);

add(
  parse("align an array's start", "AlignArray", w().u8(1).zeros(3).raw("01020304"), {
    a: 1,
    pts: [
      { x: 1, y: 2 },
      { x: 3, y: 4 }
    ]
  }),
  ser(
    "align an array's start on write",
    "AlignArray",
    {
      a: 9,
      pts: [
        { x: 5, y: 6 },
        { x: 7, y: 8 }
      ]
    },
    w().u8(9).zeros(3).raw("05060708")
  ),
  serr(
    "fixed-count array with the wrong length",
    "AlignArray",
    { a: 9, pts: [{ x: 5, y: 6 }] },
    "DERIVE",
    ["pts"]
  ),
  parse(
    "struct-level align end pads every element",
    "PaddedElements",
    w().u8(10).zeros(3).u8(11).zeros(3).u8(12).zeros(3).u8(0xff),
    { es: [{ v: 10 }, { v: 11 }, { v: 12 }], after: 255 }
  ),
  ser(
    "struct-level align end pads every element on write",
    "PaddedElements",
    { es: [{ v: 1 }, { v: 2 }, { v: 3 }], after: 4 },
    w().u8(1).zeros(3).u8(2).zeros(3).u8(3).zeros(3).u8(4)
  )
);

export default area(
  "padding",
  "@padBefore/@padAfter/@align/@padUntil/@alignEnd/@size, fill bytes and functions, @strict, attribute order.",
  cases
);
