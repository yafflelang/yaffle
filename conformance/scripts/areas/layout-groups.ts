/**
 * Cases for conformance/cases/layout-groups: per-element layout groups. Pointers are u8 offsets
 * from the file start; the positions are worked out in the comments.
 */
import { area, parse, parseOnly, ser, type Case } from "../lib.ts";

const cases: Case[] = [];
const add = (...c: Case[]) => cases.push(...c);
const leaf = (v: number) => ({ v });
const item = (a: number, b: number, c: number) => ({ a: leaf(a), b: leaf(b), c: leaf(c) });

// Group, n = 2. Inline: n at 0, item0 (a, b, c pointers) at 1..3, item1 at 4..6.
// Group: c0 7, b0 8, c1 9, b1 10; leftovers: a0 11, a1 12.
const two = [item(0xa0, 0xb0, 0xc0), item(0xa1, 0xb1, 0xc1)];
add(
  parse(
    "group: for each item c then b, a's are leftovers",
    "Group",
    "02 0b0807 0c0a09 c0b0c1b1a0a1",
    {
      n: 2,
      items: two
    }
  ),
  ser("group on write", "Group", { items: two }, "02 0b0807 0c0a09 c0b0c1b1a0a1"),
  // n = 1: inline 4 bytes; c0 4, b0 5, a0 6
  ser("group, one element", "Group", { items: [item(1, 2, 3)] }, "01 060504 030201"),
  parse("group, no elements", "Group", "00", { n: 0, items: [] }),
  // the default order (a0 b0 c0 a1 b1 c1) reads too, but rebuilds in the group's order
  parseOnly("other orders read too", "Group", "02 070809 0a0b0c a0b0c0a1b1c1", {
    n: 2,
    items: two
  })
);

// PullThenGroup: inline 7; a0 7, a1 8; then b0 9, c0 10, b1 11, c1 12.
add(
  parse("pull-out item before a group", "PullThenGroup", "02 07090a 080b0c a0a1b0c0b1c1", {
    n: 2,
    items: two
  }),
  ser(
    "pull-out item before a group on write",
    "PullThenGroup",
    { items: two },
    "02 07090a 080b0c a0a1b0c0b1c1"
  )
);

// GroupAlign: inline 7. Element 0: c0 at align(7, 4) = 8; b0 at align(9, 2) = 10 (its own
// @align(2) replaces the group's 4); a0 at align(11, 4) = 12. Element 1: c1 16, b1 18, a1 20.
const aligned = "02 0c0a08 141210 00 c0 00 b0 00 a0 000000 c1 00 b1 00 a1";
add(
  parse("group layers apply to nested items without their own", "GroupAlign", aligned, {
    n: 2,
    items: two
  }),
  ser("group alignment on write", "GroupAlign", { items: two }, aligned)
);

// NodesThis: inline n, two node pointers (0..2). Group: node0 (`this`) 3..4, y0 5, x0 6, node1
// 7..8, y1 9, x1 10.
const nodes = [
  { x: leaf(0x10), y: leaf(0x20) },
  { x: leaf(0x11), y: leaf(0x21) }
];
add(
  parse("this in a group places the element", "NodesThis", "02 0307 0605 20 10 0a09 21 11", {
    n: 2,
    nodes
  }),
  ser("this in a group on write", "NodesThis", { nodes }, "02 0307 0605 20 10 0a09 21 11")
);

// NodesLeftover: inline 3. For each element, its own bytes come first (as in a unit, since the
// group doesn't name `this`), then y: node0 3..4, y0 5, node1 6..7, y1 8. The x targets the
// group doesn't name are leftovers after it: x0 9, x1 10.
const leftover = "02 0306 0905 20 0a08 21 10 11";
add(
  parse(
    "without this, each element comes first; unnamed targets are leftovers",
    "NodesLeftover",
    leftover,
    {
      n: 2,
      nodes
    }
  ),
  ser("elements first, leftovers after the group, on write", "NodesLeftover", { nodes }, leftover)
);

// Nested: n at 0; outer0 = m at 1, node at 2..3; outer1 = m at 4, nodes at 5..8. Inline end 9.
// outer0.inner0: y 9, x 10; outer1.inner0: y 11, x 12; outer1.inner1: y 13, x 14.
const outers = [
  { m: 1, inner: [{ x: leaf(0x10), y: leaf(0x20) }] },
  {
    m: 2,
    inner: [
      { x: leaf(0x11), y: leaf(0x21) },
      { x: leaf(0x12), y: leaf(0x22) }
    ]
  }
];
const nested = "02 01 0a09 02 0c0b 0e0d 20 10 21 11 22 12";
add(
  parse("nested groups", "Nested", nested, { n: 2, outers }),
  ser("nested groups on write", "Nested", { outers: outers.map(o => ({ inner: o.inner })) }, nested)
);

// Volumes: n, volsOfs (0..1); vols at 2 (vol0 2..4, vol1 5..7); then vol0: points 8, pieces 9;
// vol1: points 10..11, pieces 12..13.
const vols = [
  { np: 1, piecesOfs: 9, pointsOfs: 8, pieces: [leaf(0x50)], points: [leaf(0x70)] },
  {
    np: 2,
    piecesOfs: 12,
    pointsOfs: 10,
    pieces: [leaf(0x51), leaf(0x52)],
    points: [leaf(0x71), leaf(0x72)]
  }
];
const volBytes = "02 02 010908 020c0a 70 50 7172 5152";
add(
  parse("per volume: its points, then its pieces", "Volumes", volBytes, {
    n: 2,
    volsOfs: 2,
    vols
  }),
  ser(
    "per volume groups on write",
    "Volumes",
    { vols: vols.map(v => ({ pieces: v.pieces, points: v.points })) },
    volBytes
  ),
  // one volume with no pieces: empty targets at the current position (3)
  ser("empty targets in a group", "Volumes", { vols: [{ pieces: [], points: [] }] }, "01 02 000505")
);

// Nullable: inline 5. Group @align(2): opt0: q null (nothing), p0 at 6; opt1: q1 at 8, p null.
const opts = [
  { p: leaf(0x31), q: null },
  { p: null, q: leaf(0x42) }
];
add(
  parse("null targets in a group add no alignment", "Nullable", "02 0600 0008 00 31 00 42", {
    n: 2,
    opts
  }),
  ser("null targets in a group on write", "Nullable", { opts }, "02 0600 0008 00 31 00 42")
);

export default area(
  "layout-groups",
  "Per-element layout groups `arr[*] { … }`: order per element, claims, leftovers, alignment inheritance, `this`, nesting, per-volume groups, null and empty targets.",
  cases
);
