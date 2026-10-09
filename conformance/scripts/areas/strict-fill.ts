/** Cases for conformance/cases/strict-fill: the `strict` word on padding layers. */
import { area, parse, parseOnly, perr, ser, type Case } from "../lib.ts";

const cases: Case[] = [];
const add = (...c: Case[]) => cases.push(...c);

// PadStrict: a at 0, zero padding 1..3 (checked), b at 4.
add(
  parse("strict padUntil: zeros", "PadStrict", "01 000000 02", { a: 1, b: 2 }),
  perr("strict padUntil: a nonzero byte", "PadStrict", "01 000100 02", "CHECK", ["a"]),
  ser("strict padUntil on write", "PadStrict", { a: 1, b: 2 }, "01 000000 02")
);

// FillStrict: the fill byte 0xff is what's checked.
add(
  parse("strict fill byte", "FillStrict", "01 ffffff 02", { a: 1, b: 2 }),
  perr("strict fill byte mismatch", "FillStrict", "01 ff00ff 02", "CHECK", ["a"]),
  perr("strict fill byte: zeros are wrong too", "FillStrict", "01 000000 02", "CHECK", ["a"]),
  ser("strict fill byte on write", "FillStrict", { a: 1, b: 2 }, "01 ffffff 02")
);

// AlignStrict: b aligned to 4, the padding 1..3 checked.
add(
  parse("strict align", "AlignStrict", "01 000000 02", { a: 1, b: 2 }),
  perr("strict align mismatch", "AlignStrict", "01 000001 02", "CHECK", ["b"]),
  ser("strict align on write", "AlignStrict", { a: 7, b: 8 }, "07 000000 08")
);

// BeforeAfter: [2 bytes before][a][1 byte 0xcc after], both checked.
add(
  parse("strict padBefore and padAfter", "BeforeAfter", "0000 aa cc", { a: 0xaa }),
  perr("strict padBefore mismatch", "BeforeAfter", "0100 aa cc", "CHECK", ["a"]),
  perr("strict padAfter mismatch", "BeforeAfter", "0000 aa 00", "CHECK", ["a"]),
  ser("strict padBefore and padAfter on write", "BeforeAfter", { a: 5 }, "0000 05 cc")
);

// OnlyThisPadding: a, 1 strict byte, 2 unchecked bytes, b at 4.
add(
  parseOnly("only the strict padding is checked", "OnlyThisPadding", "01 00 ffff 02", {
    a: 1,
    b: 2
  }),
  perr("the strict padding of several", "OnlyThisPadding", "01 05 0000 02", "CHECK", ["a"]),
  ser("mixed padding on write", "OnlyThisPadding", { a: 1, b: 2 }, "01 00 0000 02")
);

// UsesEndStrict: e.a at 0, the struct's end aligned to 4 (checked), b at 4.
add(
  parse("strict struct-level alignEnd", "UsesEndStrict", "01 000000 02", { e: { a: 1 }, b: 2 }),
  perr("strict struct-level alignEnd mismatch", "UsesEndStrict", "01 000900 02", "CHECK"),
  ser(
    "strict struct-level alignEnd on write",
    "UsesEndStrict",
    { e: { a: 1 }, b: 2 },
    "01 000000 02"
  )
);

// BlockStrict: a at 0, b at 1, the block padded to 4 (checked), c at 4.
add(
  parse("strict block padding", "BlockStrict", "01 02 0000 03", { a: 1, b: 2, c: 3 }),
  perr("strict block padding mismatch", "BlockStrict", "01 02 0100 03", "CHECK"),
  ser("strict block padding on write", "BlockStrict", { a: 1, b: 2, c: 3 }, "01 02 0000 03")
);

// FnStrict: the fill function gives a0 a1 a2 for the padding 1..3.
add(
  parse("strict fill function", "FnStrict", "01 a0a1a2 02", { a: 1, b: 2 }),
  perr("strict fill function mismatch", "FnStrict", "01 a0a1a3 02", "CHECK", ["b"]),
  ser("strict fill function on write", "FnStrict", { a: 1, b: 2 }, "01 a0a1a2 02")
);

export default area(
  "strict-fill",
  "The strict fill shorthand: `@padUntil(n, strict)`, with a fill byte or function, on @align, @padBefore/@padAfter, a struct-level @alignEnd and a block, checked on read without @strict; other padding stays unchecked.",
  cases
);
