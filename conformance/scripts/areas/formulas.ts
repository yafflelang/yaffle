/** Cases for conformance/cases/formulas. */
import {
  adler32,
  area,
  crc32,
  parse,
  parseOnly,
  perr,
  ser,
  serr,
  sum8,
  w,
  type Case
} from "../lib.ts";

const cases: Case[] = [];
const add = (...c: Case[]) => cases.push(...c);

const body = w().u16(2).raw("aabb");
add(
  parse("sizeof a struct", "Sized", w().u32(4).raw(body), { size: 4, body: { a: 2, b: "aabb" } }),
  ser(
    "sizeof derived on write",
    "Sized",
    { body: { b: "010203" } },
    w().u32(5).u16(3).raw("010203")
  ),
  parseOnly("sizeof is not checked on read", "Sized", w().u32(9).raw(body), {
    size: 9,
    body: { a: 2, b: "aabb" }
  }),
  ser("sizeof an empty body", "Sized", { body: { b: "" } }, w().u32(2).u16(0)),
  parse("sizeof an array", "SizedArray", w().u16(12).u32(1).u32(2).u32(3), {
    n: 12,
    items: [1, 2, 3]
  }),
  ser(
    "sizeof an array derived",
    "SizedArray",
    { items: [4, 5, 6] },
    w().u16(12).u32(4).u32(5).u32(6)
  )
);

const abcd = [0x61, 0x62, 0x63, 0x64];
add(
  parse("crc32 of bytes", "Crc", w().u32(crc32(abcd)).raw(abcd), {
    crc: crc32(abcd),
    data: "61626364"
  }),
  ser(
    "crc32 computed on write",
    "Crc",
    { data: "00000000" },
    w()
      .u32(crc32([0, 0, 0, 0]))
      .zeros(4)
  ),
  parseOnly("crc32 is not checked on read", "Crc", w().u32(0).raw(abcd), {
    crc: 0,
    data: "61626364"
  }),
  ser(
    "crc32 of a struct is over its bytes",
    "CrcStruct",
    { body: { b: "aabb" } },
    w().u32(crc32(body.out)).raw(body)
  ),
  parse("crc32 of a struct", "CrcStruct", w().u32(crc32(body.out)).raw(body), {
    crc: crc32(body.out),
    body: { a: 2, b: "aabb" }
  }),
  ser(
    "adler32 after the data",
    "Adler",
    { data: "010203" },
    w()
      .raw("010203")
      .u32(adler32([1, 2, 3]))
  ),
  parse(
    "adler32",
    "Adler",
    w()
      .raw("616263")
      .u32(adler32([0x61, 0x62, 0x63])),
    { data: "616263", check: 0x024d0127 }
  )
);

add(
  parse("offsetof a later field", "Ofs", "04 aabbcc dd", { ofs: 4, a: "aabbcc", b: 0xdd }),
  ser("offsetof derived", "Ofs", { a: "000000", b: 1 }, "04 000000 01"),
  parse("extern fn sum8", "Sum", w().u8(10).raw("01020304"), { s: 10, data: "01020304" }),
  ser(
    "extern fn sum8 wraps",
    "Sum",
    { data: "ffff0200" },
    w()
      .u8(sum8([0xff, 0xff, 2, 0]))
      .raw("ffff0200")
  ),
  ser(
    "extern fn over encode(struct)",
    "SumEncoded",
    { body: { b: "cc" } },
    w()
      .u16(1)
      .raw("cc")
      .u8(sum8([1, 0, 0xcc]))
  ),
  parse("extern fn over encode(struct) parse", "SumEncoded", w().u16(1).raw("cc").u8(0xcd), {
    body: { a: 1, b: "cc" },
    s: 0xcd
  })
);

add(
  parse("chosen reverse", "Flags", w().u32(16).raw("0102"), { n: 16, flags: "0102" }),
  ser("chosen reverse on write", "Flags", { flags: "ff" }, w().u32(8).raw("ff")),
  ser("chosen reverse empty", "Flags", { flags: "" }, w().u32(0)),
  parseOnly("chosen reverse is lossy for other values", "Flags", w().u32(10).raw("0102"), {
    n: 10,
    flags: "0102"
  }),
  parse("constant expression", "ConstExpr", "07000000", { x: 7 }),
  perr("constant expression is checked like a constant", "ConstExpr", "08000000", "CHECK", ["x"]),
  ser("constant expression written", "ConstExpr", {}, "07000000"),
  parse("formula over later fields", "Later", "05 02 03", { total: 5, a: 2, b: 3 }),
  ser("formula over later fields on write", "Later", { a: 10, b: 20 }, "1e 0a 14"),
  serr("formula result out of range", "Later", { a: 200, b: 100 }, "RANGE", ["total"]),
  parse("min and max", "MinMax", "05 03 03 05", { a: 5, b: 3, lo: 3, hi: 5 }),
  ser("min and max on write", "MinMax", { a: 1, b: 9 }, "01 09 01 09"),
  parse("constant length", "ConstLen", "03 010203", { n: 3, data: "010203" }),
  perr("constant length mismatch on read", "ConstLen", "02 0102", "CHECK", ["n"]),
  ser("constant length on write", "ConstLen", { data: "aabbcc" }, "03 aabbcc"),
  serr("constant length contradicts the array", "ConstLen", { data: "01" }, "DERIVE", ["data"]),
  parse("bitwise", "Bitwise", "34 12 3412 cb 26", {
    lo: 0x34,
    hi: 0x12,
    packed: 0x1234,
    inv: 0xcb,
    x: 0x26
  }),
  ser("bitwise on write", "Bitwise", { lo: 0xff, hi: 0x00 }, "ff 00 ff00 00 ff"),
  ser("conditional formula low", "Cond", { v: 5 }, "05 01"),
  ser("conditional formula high", "Cond", { v: 20 }, "14 02"),
  parse("conditional formula parse", "Cond", "14 02", { v: 20, kind: 2 })
);

export default area(
  "formulas",
  "Write formulas: sizeof, offsetof, crc32, adler32, encode, min/max, extern fn, later fields, chosen reverses.",
  cases
);
