/** Cases for conformance/cases/features. Offsets are worked out in the comments. */
import { area, leb128, parse, parseOnly, perr, ser, w, xorBytes, type Case } from "../lib.ts";

const cases: Case[] = [];
const add = (...c: Case[]) => cases.push(...c);
const pt = (x: number, y: number) => ({ x, y });
const ptb = (x: number, y: number) => w().u16(x).u16(y);

// `until it.next == 0`: the element with next == 0 is the last one, and part of the array.
add(
  parse(
    "until predicate keeps the matching element",
    "UntilIt",
    w().u8(1).u8(1).u8(2).u8(0).u8(9),
    {
      banks: [
        { v: 1, next: 1 },
        { v: 2, next: 0 }
      ],
      after: 9
    }
  ),
  parse("until predicate on the first element", "UntilIt", w().u8(7).u8(0).u8(1), {
    banks: [{ v: 7, next: 0 }],
    after: 1
  })
);

// `before ""`: the empty string is left for `tail`.
add(
  parse("before does not consume the terminator", "Before", w().cstr("a").cstr("b").cstr(""), {
    pool: ["a", "b"],
    tail: ""
  }),
  parse("before with an empty array", "Before", w().cstr(""), { pool: [], tail: "" })
);

// Pointer to an array: 5 inline bytes (n, u32 pointer), the target at 5.
add(
  parse("pointer to an array", "PtrToArray", w().u8(2).u32(5).raw(ptb(1, 2)).raw(ptb(3, 4)), {
    n: 2,
    pts: [pt(1, 2), pt(3, 4)]
  }),
  ser(
    "pointer to an array derives its count",
    "PtrToArray",
    { pts: [pt(9, 8)] },
    w().u8(1).u32(5).raw(ptb(9, 8))
  )
);

// `@nullable(empty)`: an empty array is the null pointer 0.
add(
  parse("nullable(empty) reads 0 as empty", "PtrEmpty", w().u8(0).u32(0), { k: 0, steps: [] }),
  ser("nullable(empty) writes 0 for an empty array", "PtrEmpty", { steps: [] }, w().u8(0).u32(0)),
  parse("nullable(empty) with elements", "PtrEmpty", w().u8(1).u32(5).raw(ptb(1, 2)), {
    k: 1,
    steps: [pt(1, 2)]
  })
);

// Element-wise pointer arrays. ElemBytes: 3 length bytes and 3 u16 pointers, so the targets start
// at 9. The empty list is placed at the current position, so it shares 10 with the next list.
add(
  parse(
    "element-wise byte strings",
    "ElemBytes",
    w().raw("010002").u16(9).u16(10).u16(10).raw("aa bbcc"),
    { lens: "010002", lists: ["aa", "", "bbcc"] }
  ),
  ser(
    "element-wise byte string lengths are derived",
    "ElemBytes",
    { lists: ["", "11", "2233"] },
    w().raw("000102").u16(9).u16(9).u16(10).raw("11 2233")
  ),
  // ElemU16: 6 bytes of lengths and 6 of pointers, targets from 12.
  parse(
    "element-wise arrays",
    "ElemU16",
    w().u16(1).u16(0).u16(2).u16(12).u16(14).u16(14).u16(0xaa).u16(0xbb).u16(0xcc),
    { lens: [1, 0, 2], lists: [[0xaa], [], [0xbb, 0xcc]] }
  ),
  ser(
    "element-wise array lengths are derived",
    "ElemU16",
    { lists: [[1], [2, 3], []] },
    w().u16(1).u16(2).u16(0).u16(12).u16(14).u16(18).u16(1).u16(2).u16(3)
  )
);

// `@origin(4)`: Pool's inline bytes are hdr, name, pad[2], marker and "hi\0" (0..7); the string
// target goes at 8 = base + 4 + 4.
add(
  parse(
    "origin counts from base + origin",
    "Origin",
    w().u8(7).u8(4).zeros(2).u8(0xee).cstr("hi").cstr("ab"),
    { p: { hdr: 7, name: "ab", pad: "0000", marker: 0xee, text: "hi" } }
  )
);

// bytesof(body): the xor-encoded bytes, so b is the first encoded byte.
const enc = (a: number, c: number) => xorBytes([a, c], 0x55);
add(
  parse(
    "bytesof reads the bytes after the codec",
    "BytesOf",
    w().u8(enc(1, 2)[0]!).raw(enc(1, 2)),
    {
      b: enc(1, 2)[0],
      body: { a: 1, c: 2 }
    }
  ),
  ser(
    "bytesof is computed on write",
    "BytesOf",
    { body: { a: 0, c: 0 } },
    w().u8(0x55).raw(enc(0, 0))
  )
);

// Aggregates.
add(
  parse("sum of a byte string", "SumBytes", w().u8(3).raw("010203").u16(6), {
    n: 3,
    vals: "010203",
    total: 6
  }),
  ser(
    "sum of a byte string is computed on write",
    "SumBytes",
    { vals: "ffff" },
    w().u8(2).raw("ffff").u16(510)
  ),
  parse("sum of an array", "SumU16", w().u8(2).u16(0xffff).u16(1).u32(0x10000), {
    n: 2,
    vals: [0xffff, 1],
    total: 0x10000
  }),
  parse("min and max of a byte string", "MinMax", w().u8(3).raw("050109").u8(1).u8(9), {
    n: 3,
    vals: "050109",
    lo: 1,
    hi: 9
  }),
  ser(
    "min and max of a byte string are computed on write",
    "MinMax",
    { vals: "7f80" },
    w().u8(2).raw("7f80").u8(0x7f).u8(0x80)
  )
);

// uleb128 / sleb128 (u64 and i64 values: decimal strings). -2 is 0x7e; -128 is 0x80 0x7f.
add(
  parse("uleb128 and sleb128", "Leb", w().raw(leb128(300)).u8(0x7e).u8(5), {
    a: "300",
    b: "-2",
    after: 5
  }),
  parse("sleb128 over two bytes", "Leb", w().u8(0).raw("807f").u8(1), {
    a: "0",
    b: "-128",
    after: 1
  }),
  perr("uleb128 cut short", "Leb", w().u8(0x80), "EOF")
);

// A struct-level codec: Masked's two bytes xor 0x0f.
add(
  parse(
    "struct-level via",
    "StructVia",
    w()
      .raw(xorBytes([1, 2], 0x0f))
      .u8(7),
    {
      m: { a: 1, b: 2 },
      after: 7
    }
  )
);

// Both pointers point at 2, but Blob(1) and Blob(2) are different types there. The rebuild places
// them apart, so there is no round trip.
add(
  parseOnly(
    "same address, different struct arguments",
    "SameAddrArgs",
    w().u8(2).u8(2).raw("aabb"),
    {
      a: { d: "aa" },
      b: { d: "aabb" }
    }
  )
);

export default area("features", "Features of DESIGN.md not exercised by the other areas", cases);
