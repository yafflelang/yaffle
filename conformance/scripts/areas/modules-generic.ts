/** Cases for conformance/cases/modules-generic: generics exported from one file, used in another. */
import { area, parse, ser, w, type Case } from "../lib.ts";

const pt = (x: number, y: number) => ({ x, y });

// UsesSpan: inline 4 bytes; pts.items at 4..12, nums.items at 12..16.
const span = w().raw("02 04 02 0c").u16(1).u16(2).u16(3).u16(4).u16(7).u16(8);
const pair = w().u8(9).u16(1).u16(2).u8(3).u8(4).u16(0x0506, "be");

const cases: Case[] = [
  parse("imported generic instantiated twice", "UsesSpan", span, {
    pts: { n: 2, ofs: 4, items: [pt(1, 2), pt(3, 4)] },
    nums: { n: 2, ofs: 12, items: [7, 8] }
  }),
  ser(
    "imported generic on write",
    "UsesSpan",
    { pts: { items: [] }, nums: { items: [1] } },
    w().raw("00 04 01 04").u16(1)
  ),
  parse("imported generic with two parameters, nested", "UsesPair", pair, {
    a: { first: 9, second: pt(1, 2) },
    b: { first: { first: 3, second: 4 }, second: 0x0506 }
  }),
  ser(
    "imported generic with two parameters on write",
    "UsesPair",
    { a: { first: 9, second: pt(1, 2) }, b: { first: { first: 3, second: 4 }, second: 0x0506 } },
    pair
  )
];

export default area(
  "modules-generic",
  "Generic structs exported from one file and instantiated in another.",
  cases
);
