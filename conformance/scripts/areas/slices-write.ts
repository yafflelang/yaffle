/** Cases for conformance/cases/slices-write: writable stream slices. */
import { area, parse, parseOnly, ser, serr, xorBytes, toHex, type Case } from "../lib.ts";

const cases: Case[] = [];
const add = (...c: Case[]) => cases.push(...c);

const hdr = { a: 1, b: 2 };
const foot = { x: 3 };
const plain = "0100 0200 03000000";

// Overlay: raw (hidden) = hdr's 4 bytes then foot's 4 bytes.
add(
  parse("a hidden field assembled from its slices", "Overlay", plain, { hdr, foot }),
  ser(
    "assembled from its slices on write",
    "Overlay",
    { hdr: { a: 0x1234, b: 5 }, foot: { x: 6 } },
    "3412 0500 06000000"
  )
);

// Visible: raw is in the output but derived from its slices.
add(
  parse("a visible carrier", "Visible", plain, { raw: "0100020003000000", hdr, foot }),
  ser("a visible carrier on write", "Visible", { hdr, foot }, plain),
  ser(
    "the carrier's own value in the input is ignored",
    "Visible",
    { raw: "ffffffffffffffff", hdr, foot },
    plain
  )
);

// Gaps: bytes 0..1 and 6..7 aren't covered; they're written as zeros.
add(
  parseOnly("gaps are read but not kept", "Gaps", "ffff 0100 0200 ffff", { hdr }),
  ser("gaps are zero-filled on write", "Gaps", { hdr }, "0000 0100 0200 0000")
);

// Sized: raw (a `[]` in @size(n)) is as long as its largest slice end; n is its size.
add(
  parse("an assembled field in a size window", "Sized", "06 0100 0200 aabb", {
    n: 6,
    raw: "01000200aabb",
    hdr,
    tail: "aabb"
  }),
  ser(
    "an assembled field in a size window on write",
    "Sized",
    { hdr, tail: "aabb" },
    "06 0100 0200 aabb"
  ),
  ser("an assembled field: empty tail", "Sized", { hdr, tail: "" }, "04 0100 0200")
);

// Overlap: second at 4..8 and tail at 6.. share bytes 6..7.
const second = { a: 3, b: 4 };
add(
  parse("overlapping slices that agree", "Overlap", "0100 0200 0300 0400", {
    raw: "0100020003000400",
    first: hdr,
    second,
    tail: "0400"
  }),
  ser(
    "overlapping slices that agree on write",
    "Overlap",
    { first: hdr, second, tail: "0400" },
    "0100 0200 0300 0400"
  ),
  serr(
    "overlapping slices that disagree",
    "Overlap",
    { first: hdr, second, tail: "ffff" },
    "DERIVE"
  )
);

// Coded: raw is the decoded side of xor(0x5a); n is the size on disk.
const decoded = [0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x00, 0x00];
const coded = "08 " + toHex(xorBytes(decoded, 0x5a));
add(
  parse("slices of a codec's decoded content", "Coded", coded, {
    n: 8,
    raw: toHex(decoded),
    hdr,
    foot
  }),
  ser("slices of a codec's decoded content on write", "Coded", { hdr, foot }, coded)
);

// Bounded: head = raw[0..h], body = raw[h..6], h an input.
add(
  parse("slice bounds from a field", "Bounded", "02 aabb ccddeeff", {
    h: 2,
    head: "aabb",
    body: "ccddeeff"
  }),
  ser(
    "slice bounds from a field on write",
    "Bounded",
    { h: 4, head: "01020304", body: "0506" },
    "04 01020304 0506"
  )
);

export default area(
  "slices-write",
  "Writable stream slices: a hidden or visible field assembled from its `from` slices, zero-filled gaps, a `[]` field in an @size window, overlapping slices that agree or disagree, slices of a codec's decoded side, and bounds from a field.",
  cases
);
