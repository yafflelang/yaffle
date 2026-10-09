/** Cases for conformance/cases/streams-slices: slices of a stream (read side only). */
import { area, parseOnly, type Case } from "../lib.ts";

const cases: Case[] = [
  parseOnly("slices of a stream", "Sliced", "0100 0200 0300 0400", {
    raw: "0100020003000400",
    first: { a: 1, b: 2 },
    second: { a: 3, b: 4 },
    tail: "0400"
  }),
  parseOnly("overlapping slices see the same bytes", "Sliced", "ffff 0100 0200 0300", {
    raw: "ffff010002000300",
    first: { a: 0xffff, b: 1 },
    second: { a: 2, b: 3 },
    tail: "0300"
  })
];

export default area(
  "streams-slices",
  "Slices of a stream: `from raw[a..b]` and `from raw[a..]`, parse only.",
  cases
);
