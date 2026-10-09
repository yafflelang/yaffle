/** Cases for conformance/cases/generics. */
import { area, big, leb128, parse, perr, ser, w, xorBytes, type Case } from "../lib.ts";

const cases: Case[] = [];
const add = (...c: Case[]) => cases.push(...c);
const pt = (x: number, y: number) => ({ x, y });

// UsesSpan: inline 4 bytes; pts.items at 4..12, nums.items at 12..18.
add(
  parse(
    "generic struct instantiated twice",
    "UsesSpan",
    w().raw("02 04 03 0c").u16(1).u16(2).u16(3).u16(4).u16(10).u16(11).u16(12),
    {
      pts: { n: 2, ofs: 4, items: [pt(1, 2), pt(3, 4)] },
      nums: { n: 3, ofs: 12, items: [10, 11, 12] }
    }
  ),
  ser(
    "generic struct on write",
    "UsesSpan",
    { pts: { items: [pt(5, 6)] }, nums: { items: [] } },
    w().raw("01 04 00 08").u16(5).u16(6)
  ),
  parse(
    "generic with two parameters, nested",
    "UsesPair",
    w().u8(1).u16(2, "be").u16(3).u16(4).u8(5).u8(6),
    { p: { first: 1, second: 2 }, q: { first: pt(3, 4), second: { first: 5, second: 6 } } }
  ),
  parse("generic pointer", "UsesBoxed", w().raw("0206").u16(1).u16(2).u32(0x12345678), {
    a: { value: pt(1, 2) },
    b: { value: 0x12345678 }
  }),
  ser(
    "generic pointer on write",
    "UsesBoxed",
    { a: { value: pt(0, 0) }, b: { value: 1 } },
    w().raw("0206").u16(0).u16(0).u32(1)
  )
);

add(
  parse(
    "type aliases",
    "UsesAlias",
    w().int(16, 384).int(32, 40).text("abc").zeros(5).u24(0x010203, "be"),
    { f: 1.5, g: 2.5, n: "abc", c: 0x010203 }
  ),
  ser(
    "type aliases on write",
    "UsesAlias",
    { f: -2, g: 0.0625, n: "", c: 1 },
    w().int(16, -512).int(32, 1).zeros(8).u24(1, "be")
  ),
  parse(
    "alias with byte layers on elements",
    "UsesEnc",
    w()
      .u8(2)
      .raw(xorBytes(w().u16(1).u16(2).out, 0x5a))
      .raw(xorBytes(w().u16(3).u16(4).out, 0x5a)),
    { n: 2, pts: [pt(1, 2), pt(3, 4)] }
  )
);

add(
  parse(
    "extern type",
    "UsesVarInt",
    w()
      .raw(leb128(300))
      .raw(leb128(2n ** 63n))
      .u8(7),
    { a: "300", b: big(2n ** 63n), after: 7 }
  ),
  parse(
    "extern type extremes",
    "UsesVarInt",
    w()
      .raw(leb128(0))
      .raw(leb128(2n ** 64n - 1n))
      .u8(1),
    { a: "0", b: big(2n ** 64n - 1n), after: 1 }
  ),
  ser(
    "extern type on write",
    "UsesVarInt",
    { a: "127", b: "128", after: 2 },
    w().raw("7f 8001").u8(2)
  ),
  perr("extern type needs more bytes at the end", "UsesVarInt", "ac", "EOF", ["a"]),
  parse(
    "array of extern types",
    "VarList",
    w()
      .u8(3)
      .raw(leb128(1))
      .raw(leb128(128))
      .raw(leb128(2n ** 64n - 1n)),
    { n: 3, vals: ["1", "128", big(2n ** 64n - 1n)] }
  ),
  ser(
    "array of extern types on write",
    "VarList",
    { vals: ["16384"] },
    w().u8(1).raw(leb128(16384))
  ),
  parse("fixed-size extern type", "UsesBcd", "2026 0a", { year: 2026, month: 10 }),
  ser("fixed-size extern type on write", "UsesBcd", { year: 1999, month: 12 }, "1999 0c"),
  perr("fixed-size extern type eof", "UsesBcd", "20", "EOF", ["year"])
);

add(
  // UsesAliasSpan: s.n, s.ofs inline; the items at 2.
  parse("alias of an instantiation", "UsesAliasSpan", w().raw("01 02").u16(1).u16(2), {
    s: { n: 1, ofs: 2, items: [pt(1, 2)] }
  }),
  parse("generic with a value parameter", "UsesArr", w().u8(2).u16(1).u16(2), {
    count: 2,
    a: { items: [1, 2] }
  }),
  ser(
    "generic with a value parameter on write",
    "UsesArr",
    { count: 1, a: { items: [7] } },
    w().u8(1).u16(7)
  ),
  parse(
    "generic over an extern type and an enum",
    "UsesExternArg",
    w().raw(leb128(300)).u8(7).u8(2).u8(9),
    {
      v: { first: "300", second: 7 },
      k: { first: "B", second: 9 }
    }
  ),
  ser(
    "generic over an extern type and an enum on write",
    "UsesExternArg",
    { v: { first: "1", second: 2 }, k: { first: "A", second: 3 } },
    "01 02 01 03"
  )
);

export default area(
  "generics",
  "Generic structs (one and two parameters, nested, pointers), type aliases with transforms/parameters/layers, extern types.",
  cases
);
