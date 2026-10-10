/**
 * Cases for conformance/cases/align-origin: `@align`/`@alignEnd` with `from: file | base` and
 * `offset: k`. Positions are worked out in the comments (absolute, from the file start, unless
 * said otherwise).
 */
import { area, parse, parseOnly, perr, ser, w, type Case } from "../lib.ts";

const cases: Case[] = [];
const add = (...c: Case[]) => cases.push(...c);

// Offset: a at 0..1; tail at the first pos with (pos + 3) % 4 == 0 after 2, which is 5; after at 8.
add(
  parse("offset: a block that ends aligned", "Offset", "0102 000000 aabbcc dd", {
    a: 0x0201,
    tail: "aabbcc",
    after: 0xdd
  }),
  ser("offset on write", "Offset", { a: 1, tail: "010203", after: 4 }, "0100 000000 010203 04"),
  parseOnly("offset padding isn't checked without strict", "Offset", "0102 ffffff aabbcc dd", {
    a: 0x0201,
    tail: "aabbcc",
    after: 0xdd
  }),
  perr("offset padding past the end", "Offset", "0102 0000", "EOF", ["tail"])
);

// OffsetField: k at 0; v at the first pos ≥ 1 with (pos + k) % 8 == 0.
add(
  parse("offset from a field: k = 5 puts v at 3", "OffsetField", "05 0000 77", { k: 5, v: 0x77 }),
  parse("offset from a field: k = 7 needs no padding", "OffsetField", "07 77", { k: 7, v: 0x77 }),
  parse(
    "offset from a field: k = 0 is plain alignment",
    "OffsetField",
    w().u8(0).zeros(7).u8(0x77),
    {
      k: 0,
      v: 0x77
    }
  ),
  ser("offset from a field on write", "OffsetField", { k: 6, v: 1 }, "06 00 01")
);

// EndOffset: a at 0; pad after until (end + 2) % 8 == 0, so the end is 6; b at 6..7.
add(
  parse("alignEnd with an offset", "EndOffset", "aa 0000000000 0201", { a: 0xaa, b: 0x0102 }),
  ser("alignEnd with an offset on write", "EndOffset", { a: 1, b: 2 }, "01 0000000000 0200")
);

// Origin: pre 0..2; Inner (@base) at 3: x at 3; y aligned from the base: 3 + 4 = 7;
// z aligned from the file: 8 (from the base it would be 3 + 8 = 11).
add(
  parse("from: file inside a @base", "Origin", "010203 11 000000 22 33", {
    pre: "010203",
    inner: { x: 0x11, y: 0x22, z: 0x33 }
  }),
  ser(
    "from: file inside a @base on write",
    "Origin",
    { pre: "aabbcc", inner: { x: 1, y: 2, z: 3 } },
    "aabbcc 01 000000 02 03"
  ),
  // z needs no padding at 8 (aligned from the file), but its byte is missing
  perr("from: file padding past the end", "Origin", "010203 11 000000 22", "EOF", ["inner", "z"])
);
add(
  parse("from: base written out", "ExplicitBase", "010203 11 000000 22", {
    pre: "010203",
    inner: { x: 0x11, y: 0x22 }
  }),
  ser(
    "from: base on write",
    "ExplicitBase",
    { pre: "000000", inner: { x: 1, y: 2 } },
    "000000 01 000000 02"
  )
);

// UsesEndFile: pre 0..2; EndFile at 3, a at 3, the end (4) aligned to 8 from the file; post at 8.
add(
  parse("alignEnd from the file", "UsesEndFile", "010203 aa 00000000 bb", {
    pre: "010203",
    e: { a: 0xaa },
    post: 0xbb
  }),
  ser(
    "alignEnd from the file on write",
    "UsesEndFile",
    { pre: "000000", e: { a: 1 }, post: 2 },
    "000000 01 00000000 02"
  )
);

// InStream: pre at 0, raw at 1..8. In the stream, a at 0, b at 4 (aligned from the stream's
// start, not the file's: that would be stream offset 3), c at 5..7.
add(
  parse("from: file is the start of a stream", "InStream", "ff aa000000bb010203", {
    pre: 0xff,
    raw: "aa000000bb010203",
    s: { a: 0xaa, b: 0xbb, c: "010203" }
  }),
  ser(
    "from: file in a stream on write",
    "InStream",
    { pre: 1, s: { a: 2, b: 3, c: "040506" } },
    "01 02000000 03 040506"
  )
);

// LayoutOrigin: pre 0..2; Blk (@base) at 3: n at 3, ofs at 4; data aligned to 8 from the file:
// 8, which is 5 from the base (ofs = 5).
add(
  parse("layout item aligned from the file", "LayoutOrigin", "010203 02 05 000000 dddd", {
    pre: "010203",
    blk: { n: 2, ofs: 5, data: "dddd" }
  }),
  ser(
    "layout item aligned from the file on write",
    "LayoutOrigin",
    { pre: "000000", blk: { data: "0102" } },
    "000000 02 05 000000 0102"
  )
);

// Both: pre 0..2; Inner2 at 3: a at 3; b (5 bytes) at the first pos ≥ 4 with (pos + 5) % 8 == 0
// from the file: 11, so it ends at 16.
add(
  parse("from: file and offset together", "Both", "010203 aa 00000000000000 0102030405", {
    pre: "010203",
    i: { a: 0xaa, b: "0102030405" }
  }),
  ser(
    "from: file and offset together on write",
    "Both",
    { pre: "000000", i: { a: 1, b: "0a0b0c0d0e" } },
    "000000 01 00000000000000 0a0b0c0d0e"
  )
);

export default area(
  "align-origin",
  "Alignment origin and offset: `@align(n, offset: k)`, offsets from fields, `@alignEnd` with an offset, `from: file` inside a @base, a struct-level `@alignEnd(…, from: file)`, a stream as the file, layout items, and both together.",
  cases
);
