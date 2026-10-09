/** Cases for conformance/cases/pointers. Offsets are worked out in the comments. */
import { area, parse, parseOnly, perr, ser, serr, w, type Case } from "../lib.ts";

const cases: Case[] = [];
const add = (...c: Case[]) => cases.push(...c);
const pt = (x: number, y: number) => ({ x, y });
const ptb = (x: number, y: number) => w().u16(x).u16(y);

// Owned: 4 inline bytes, the target follows at 4.
add(
  parse("owned pointer", "Owned", w().u32(4).raw(ptb(1, 2)), { p: pt(1, 2) }),
  ser(
    "owned pointer target placed after the inline bytes",
    "Owned",
    { p: pt(7, 8) },
    w().u32(4).raw(ptb(7, 8))
  ),
  parseOnly("owned pointer to a later offset", "Owned", w().u32(8).zeros(4).raw(ptb(1, 2)), {
    p: pt(1, 2)
  }),
  parseOnly("non-nullable zero offset points at the base", "Owned", w().u32(0), { p: pt(0, 0) }),
  // The path is left out: a reader may notice the target is outside the data before reading it.
  perr("owned pointer past the end", "Owned", w().u32(16), "EOF")
);

// Two pointers: 8 inline bytes, targets at 8 and 12; shared targets are written once.
add(
  parse("two pointers", "TwoPtrs", w().u32(8).u32(12).raw(ptb(1, 2)).raw(ptb(3, 4)), {
    a: pt(1, 2),
    b: pt(3, 4)
  }),
  parse("shared target becomes a $ref", "TwoPtrs", w().u32(8).u32(8).raw(ptb(1, 2)), {
    a: pt(1, 2),
    b: { $ref: "/a" }
  }),
  ser(
    "$ref writes the target once",
    "TwoPtrs",
    { a: pt(5, 6), b: { $ref: "/a" } },
    w().u32(8).u32(8).raw(ptb(5, 6))
  ),
  ser(
    "equal values without $ref are separate targets",
    "TwoPtrs",
    { a: pt(5, 6), b: pt(5, 6) },
    w().u32(8).u32(12).raw(ptb(5, 6)).raw(ptb(5, 6))
  ),
  parseOnly(
    "targets in reverse order",
    "TwoPtrs",
    w().u32(12).u32(8).raw(ptb(3, 4)).raw(ptb(1, 2)),
    { a: pt(1, 2), b: pt(3, 4) }
  ),
  serr("dangling $ref", "TwoPtrs", { a: pt(1, 2), b: { $ref: "/nope" } }, "INPUT", ["b"])
);

// Relative: the field is at 1, the target at 3, so the stored value is 2.
add(
  parse("relative pointer", "Rel", w().u8(0).int(16, 2).raw(ptb(1, 2)), { pad: 0, p: pt(1, 2) }),
  ser(
    "relative pointer on write",
    "Rel",
    { pad: 9, p: pt(1, 2) },
    w().u8(9).int(16, 2).raw(ptb(1, 2))
  ),
  parseOnly("relative pointer backwards", "Rel", w().u8(5).int(16, -1).u8(7), {
    pad: 5,
    p: pt(0xff05, 0x07ff)
  })
);

add(
  parse("nullable null", "Nullable", w().u32(0), { p: null }),
  parse("nullable set", "Nullable", w().u32(4).raw(ptb(1, 2)), { p: pt(1, 2) }),
  ser("nullable writes null", "Nullable", { p: null }, w().u32(0)),
  parse("nullable with a custom null", "NullableFF", w().u32(0xffffffff), { p: null }),
  parseOnly("custom null makes zero a real offset", "NullableFF", w().u32(0), { p: pt(0, 0) }),
  ser("custom null on write", "NullableFF", { p: null }, w().u32(0xffffffff)),
  ser("custom null set", "NullableFF", { p: pt(3, 4) }, w().u32(4).raw(ptb(3, 4)))
);

// Arrays of pointers: 1 + 4n inline bytes, then the targets in order.
add(
  parse("array of pointers", "PtrArray", w().u8(2).u32(9).u32(13).raw(ptb(1, 2)).raw(ptb(3, 4)), {
    n: 2,
    pts: [pt(1, 2), pt(3, 4)]
  }),
  parse(
    "array of pointers with a shared element",
    "PtrArray",
    w().u8(3).u32(13).u32(17).u32(13).raw(ptb(1, 2)).raw(ptb(3, 4)),
    { n: 3, pts: [pt(1, 2), pt(3, 4), { $ref: "/pts/0" }] }
  ),
  ser(
    "array of pointers on write",
    "PtrArray",
    { pts: [pt(1, 1)] },
    w().u8(1).u32(5).raw(ptb(1, 1))
  ),
  ser("array of pointers empty", "PtrArray", { pts: [] }, w().u8(0)),
  parse("pointer to a primitive", "PtrToPrim", w().u8(1).u32(0x12345678), { v: 0x12345678 }),
  parse("pointer to a string", "PtrToStr", w().u16(3).u8(7).cstr("hi"), { s: "hi", after: 7 }),
  ser(
    "pointer to a string on write",
    "PtrToStr",
    { s: "abc", after: 1 },
    w().u16(3).u8(1).cstr("abc")
  ),
  parse("pointer storage follows endianness", "PtrBe", w().u32(4, "be").u16(1, "be").u16(2, "be"), {
    p: pt(1, 2)
  })
);

// Linked lists and cycles.
add(
  parse("linked list", "List", "01 0a03 0b00", { first: { v: 10, next: { v: 11, next: null } } }),
  parse("linked list of three", "List", "01 0a03 0b05 0c00", {
    first: { v: 10, next: { v: 11, next: { v: 12, next: null } } }
  }),
  ser(
    "linked list on write is pre-order",
    "List",
    { first: { v: 1, next: { v: 2, next: null } } },
    "01 0103 0200"
  ),
  parse("self cycle", "List", "01 0a01", { first: { v: 10, next: { $ref: "/first" } } }),
  parse("two-node cycle", "List", "01 0a03 0b01", {
    first: { v: 10, next: { v: 11, next: { $ref: "/first" } } }
  }),
  ser(
    "cycle on write",
    "List",
    { first: { v: 4, next: { v: 5, next: { $ref: "/first" } } } },
    "01 0403 0501"
  )
);

// Pre-order: inline 3 bytes; p's Pt at 3; B at 7 then its Pt at 8; r's Pt at 12.
add(
  parse(
    "pre-order layout",
    "PreOrder",
    w().raw("03070c").raw(ptb(1, 2)).u8(8).raw(ptb(3, 4)).raw(ptb(5, 6)),
    { p: pt(1, 2), b: { q: pt(3, 4) }, r: pt(5, 6) }
  ),
  ser(
    "pre-order layout on write",
    "PreOrder",
    { p: pt(1, 2), b: { q: pt(3, 4) }, r: pt(5, 6) },
    w().raw("03070c").raw(ptb(1, 2)).u8(8).raw(ptb(3, 4)).raw(ptb(5, 6))
  )
);

// `at`.
add(
  parse("at", "At", w().u32(4).raw(ptb(1, 2)), { ofs: 4, p: pt(1, 2) }),
  ser("at derives the offset", "At", { p: pt(1, 2) }, w().u32(4).raw(ptb(1, 2))),
  parseOnly("at a later offset", "At", w().u32(8).zeros(4).raw(ptb(1, 2)), { ofs: 8, p: pt(1, 2) }),
  perr("at past the end", "At", w().u32(6).raw(ptb(1, 2)), "EOF", ["p", "y"]),
  parse("at an array", "AtArray", w().u8(2).u32(5).raw(ptb(1, 2)).raw(ptb(3, 4)), {
    n: 2,
    ofs: 5,
    items: [pt(1, 2), pt(3, 4)]
  }),
  parse("at an empty array points at the current position", "AtArray", w().u8(0).u32(5), {
    n: 0,
    ofs: 5,
    items: []
  }),
  ser("at an empty array on write", "AtArray", { items: [] }, w().u8(0).u32(5)),
  parse("at bytes", "AtBytes", w().u16(3).u16(4).raw("aabbcc"), { len: 3, ofs: 4, data: "aabbcc" })
);

// Linear `at`: constraint ≡ 0 mod 8 (inline is 1 byte, so the data goes to 8, sector 1).
add(
  parse("linear at", "Linear", w().u8(1).zeros(7).raw("01020304"), { sector: 1, data: "01020304" }),
  ser(
    "linear at honours the constraint",
    "Linear",
    { data: "aabbccdd" },
    w().u8(1).zeros(7).raw("aabbccdd")
  ),
  parseOnly("linear at a later sector", "Linear", w().u8(2).zeros(15).raw("01020304"), {
    sector: 2,
    data: "01020304"
  }),
  parse("linear at with a remainder", "LinearRem", w().u8(2).u8(0).zeros(2).raw("aabb"), {
    n: 2,
    slot: 0,
    data: "aabb"
  }),
  ser(
    "linear at with a remainder on write",
    "LinearRem",
    { data: "aabbcc" },
    w().u8(3).u8(0).zeros(2).raw("aabbcc")
  )
);

// Fixed placements: a and b are inputs; x goes exactly at a * b.
add(
  parse("fixed placement", "FixedAt", w().u8(2).u8(2).zeros(2).raw("aabb"), {
    a: 2,
    b: 2,
    x: "aabb"
  }),
  ser(
    "fixed placement on write",
    "FixedAt",
    { a: 2, b: 2, x: "aabb" },
    w().u8(2).u8(2).zeros(2).raw("aabb")
  ),
  ser(
    "fixed placement right after the inline bytes",
    "FixedAt",
    { a: 2, b: 1, x: "aabb" },
    w().u8(2).u8(1).raw("aabb")
  ),
  serr(
    "fixed placement overlapping the inline bytes",
    "FixedAt",
    { a: 1, b: 1, x: "aabb" },
    "OVERLAP"
  ),
  parseOnly("fixed placement overlap is fine on read", "FixedAt", "01 01 aa", {
    a: 1,
    b: 1,
    x: "01aa"
  }),
  parse("two fixed placements", "FixedTwo", w().raw("010305").raw("aabb").raw("ccdd"), {
    k: 1,
    o1: 3,
    o2: 5,
    p1: "aabb",
    p2: "ccdd"
  }),
  ser(
    "two fixed placements out of order",
    "FixedTwo",
    { k: 1, o1: 5, o2: 3, p1: "aabb", p2: "ccdd" },
    w().raw("010503").raw("ccdd").raw("aabb")
  ),
  ser(
    "two fixed placements with gaps",
    "FixedTwo",
    { k: 2, o1: 2, o2: 4, p1: "aabb", p2: "ccdd" },
    w().raw("020204").zeros(1).raw("aabb").zeros(2).raw("ccdd")
  ),
  serr(
    "two fixed placements overlapping",
    "FixedTwo",
    { k: 1, o1: 3, o2: 4, p1: "aabb", p2: "ccdd" },
    "OVERLAP"
  )
);

// @base: Sub starts at 1; its pointer counts from there (target at 3 = base + 2).
add(
  parse("pointer inside a base", "Based", w().u8(9).u8(1).u8(2).raw(ptb(1, 2)), {
    pre: 9,
    s: { a: 1, p: pt(1, 2) }
  }),
  ser(
    "pointer inside a base on write",
    "Based",
    { pre: 9, s: { a: 1, p: pt(1, 2) } },
    w().u8(9).u8(1).u8(2).raw(ptb(1, 2))
  ),
  parse("at inside a base", "BasedAt", w().u16(0).u8(1).raw("aabb"), {
    pre: 0,
    s: { ofs: 1, data: "aabb" }
  }),
  ser(
    "at inside a base on write",
    "BasedAt",
    { pre: 5, s: { data: "aabb" } },
    w().u16(5).u8(1).raw("aabb")
  ),
  parse(
    "pointer and at in declaration order",
    "Mixed",
    w().u8(2).u8(6).raw(ptb(1, 2)).raw("aabb"),
    { p: pt(1, 2), ofs: 6, tail: "aabb" }
  ),
  ser(
    "pointer and at in declaration order on write",
    "Mixed",
    { p: pt(1, 2), tail: "aabb" },
    w().u8(2).u8(6).raw(ptb(1, 2)).raw("aabb")
  )
);

// SameAddress: inline 5; a (empty) at 5, b at 5..7, c (empty) at 7, d at 7..9. No $refs: arrays and
// bytes are values, and empty a/c share their address with b/d.
add(
  parse(
    "empty and non-empty arrays at the same address",
    "SameAddress",
    "00 05 05 07 07 aabb 0100",
    {
      n: 0,
      ofsA: 5,
      ofsB: 5,
      ofsC: 7,
      ofsD: 7,
      a: "",
      b: "aabb",
      c: [],
      d: [1]
    }
  ),
  ser(
    "empty and non-empty arrays at the same address on write",
    "SameAddress",
    { a: "", b: "ccdd", c: [], d: [2] },
    "00 05 05 07 07 ccdd 0200"
  ),
  // NestedTarget: b at 0; Box at 1; its Pt at 2, stored as 2 (from the root base).
  parse(
    "offsets inside a target count from the base",
    "NestedTarget",
    w().raw("01 02").raw(ptb(1, 2)),
    { b: { inner: pt(1, 2) } }
  ),
  ser(
    "offsets inside a target on write",
    "NestedTarget",
    { b: { inner: pt(3, 4) } },
    w().raw("01 02").raw(ptb(3, 4))
  ),
  // RelInside: r at 0; RelBox at 1..3 (p at 2); Pt at 3, stored as 3 - 2 = 1.
  parse("relative pointer inside a target", "RelInside", w().raw("01 ee 01").raw(ptb(5, 6)), {
    r: { pad: 0xee, p: pt(5, 6) }
  }),
  ser(
    "relative pointer inside a target on write",
    "RelInside",
    { r: { pad: 0, p: pt(5, 6) } },
    w().raw("01 00 01").raw(ptb(5, 6))
  ),
  // Far: Big at 2..302, then p's Pt at 302: too far for a u8.
  serr(
    "pointer storage too small for the target offset",
    "Far",
    { big: { data: "00".repeat(300) }, p: pt(1, 1) },
    "RANGE",
    ["p"]
  ),
  // Items: inline 1 + 2 * 2; items[1].opt's Pt at 5.
  parse(
    "nullable pointers in an array of structs",
    "Items",
    w().raw("02 0700 0805").raw(ptb(9, 9)),
    {
      n: 2,
      items: [
        { v: 7, opt: null },
        { v: 8, opt: pt(9, 9) }
      ]
    }
  ),
  ser(
    "nullable pointers in an array of structs on write",
    "Items",
    {
      items: [
        { v: 1, opt: pt(1, 1) },
        { v: 2, opt: null },
        { v: 3, opt: pt(3, 3) }
      ]
    },
    w().raw("03 0107 0200 030b").raw(ptb(1, 1)).raw(ptb(3, 3))
  )
);

export default area(
  "pointers",
  "Owned/@relative/@nullable pointers, pointer arrays, $ref sharing, cycles, `at`, linear and fixed placements, overlaps, @base.",
  cases
);
