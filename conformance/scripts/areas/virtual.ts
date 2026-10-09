/** Cases for conformance/cases/virtual: virtual fields. */
import { area, big, parse, perr, ser, serr, type Case } from "../lib.ts";

const cases: Case[] = [];
const add = (...c: Case[]) => cases.push(...c);

// Split: size = sizeHigh · 2^32 + sizeLow (u40 is a JSON number).
add(
  parse("bit concatenation", "Split", "01 02000000", {
    sizeHigh: 1,
    sizeLow: 2,
    size: 2 ** 32 + 2
  }),
  ser("bit concatenation on write", "Split", { size: 0x123456789a }, "12 9a785634"),
  ser("zero", "Split", { size: 0 }, "00 00000000"),
  ser("the largest u40", "Split", { size: 2 ** 40 - 1 }, "ff ffffffff"),
  ser(
    "parts in the input are ignored",
    "Split",
    { sizeHigh: 9, sizeLow: 9, size: 5 },
    "00 05000000"
  ),
  serr("a value beyond the virtual type", "Split", { size: 2 ** 40 }, "RANGE"),
  serr("the virtual value is required", "Split", {}, "INPUT", ["size"])
);

// Decimal: v = hi · 1000 + mid · 10 + lo with mid in 0..99 and lo in 0..9.
add(
  parse("mixed radix", "Decimal", "0c 22 05", { hi: 12, mid: 34, lo: 5, v: 12345 }),
  ser("mixed radix on write", "Decimal", { v: 12345 }, "0c 22 05"),
  ser("mixed radix: small values", "Decimal", { v: 7 }, "00 00 07"),
  serr("mixed radix: the top part overflows", "Decimal", { v: 999999 }, "RANGE"),
  perr("a part's own check still applies on read", "Decimal", "01 64 00", "CHECK", ["mid"])
);

// Linear: bytes = (n - 1) · 4, so n = (bytes + 4) / 4.
add(
  parse("linear", "Linear", "0300", { n: 3, bytes: 8 }),
  ser("linear on write", "Linear", { bytes: 8 }, "0300"),
  serr("linear: a value that doesn't read back", "Linear", { bytes: 6 }, "DERIVE"),
  perr("linear: a read value beyond the virtual type", "Linear", "0000", "RANGE", ["bytes"])
);

// Nested shifts: v = a · 2^16 + b · 2^8 + c.
add(
  parse("nested shifts", "Nested", "01 02 03", { a: 1, b: 2, c: 3, v: 0x010203 }),
  ser("nested shifts on write", "Nested", { v: 0x0a0b0c }, "0a 0b 0c"),
  serr("nested shifts: the top part overflows", "Nested", { v: 0x1000000 }, "RANGE")
);

// Bits: the u16 unit holds lo (bits 0..11) and tag (12..15); v = hi · 2^12 + lo.
add(
  parse("a part in a bits unit", "Bits", "45a3 12", { lo: 0x345, tag: 10, hi: 0x12, v: 0x12345 }),
  ser("a part in a bits unit on write", "Bits", { tag: 10, v: 0x12345 }, "45a3 12"),
  serr("the bits unit's other fields stay inputs", "Bits", { v: 0x12345 }, "INPUT", ["tag"])
);

// Default: v ?= 0x1234.
add(
  parse("default: read", "Default", "abcd", { hi: 0xab, lo: 0xcd, v: 0xabcd }),
  ser("default when the input leaves it out", "Default", {}, "1234"),
  ser("a given value wins over the default", "Default", { v: 0x0102 }, "0102")
);

// Used: n is the length of data.
add(
  parse("a virtual length", "Used", "0003 aabbcc", { hi: 0, lo: 3, n: 3, data: "aabbcc" }),
  ser("a virtual length on write", "Used", { n: 2, data: "aabb" }, "0002 aabb"),
  serr("a virtual length that disagrees with the data", "Used", { n: 3, data: "aa" }, "DERIVE"),
  perr("a virtual length past the end", "Used", "0003 aa", "EOF", ["data"])
);

// Signed: v = hi · 2^32 + lo with a signed hi (i64: a JSON string).
add(
  parse("signed top part: -1", "Signed", "ff ffffffff", { hi: -1, lo: 0xffffffff, v: big(-1) }),
  parse("signed top part: positive", "Signed", "7f 00000000", {
    hi: 0x7f,
    lo: 0,
    v: big(0x7f00000000)
  }),
  ser("signed top part on write", "Signed", { v: big(-(2n ** 32n)) }, "ff 00000000"),
  ser("signed top part: -2", "Signed", { v: big(-2) }, "ff feffffff"),
  serr("signed top part overflows", "Signed", { v: big(2n ** 39n) }, "RANGE")
);

// Checked: v % 2 == 0.
add(
  parse("check on a virtual value", "Checked", "0002", { hi: 0, lo: 2, v: 2 }),
  perr("check on a virtual value fails on read", "Checked", "0003", "CHECK", ["v"]),
  serr("check on a virtual value fails on write", "Checked", { v: 3 }, "CHECK", ["v"]),
  ser("check on a virtual value passes on write", "Checked", { v: 4 }, "0004")
);

// Vols: virtual fields in array elements.
add(
  parse("virtual fields in array elements", "Vols", "02 01 02000000 00 ffffffff", {
    n: 2,
    vols: [
      { sizeHigh: 1, sizeLow: 2, size: 2 ** 32 + 2 },
      { sizeHigh: 0, sizeLow: 0xffffffff, size: 0xffffffff }
    ]
  }),
  ser(
    "virtual fields in array elements on write",
    "Vols",
    { vols: [{ size: 5 }, { size: 2 ** 32 }] },
    "02 00 05000000 01 00000000"
  )
);

export default area(
  "virtual",
  "Virtual fields: bit concatenation, mixed radix (with `in` ranges), linear forms, nested shifts, parts in bits units, `?=` defaults, a virtual length, a signed top part, checks, and array elements; range, read-back and input errors.",
  cases
);
