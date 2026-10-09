/** Cases for conformance/cases/primitives (see its schema.yfl). */
import {
  area,
  big,
  f16Bits,
  f16Value,
  f32j,
  fl,
  parse,
  parseOnly,
  perr,
  ser,
  serr,
  w,
  type Case
} from "../lib.ts";

const cases: Case[] = [];
const add = (...c: Case[]) => cases.push(...c);

// ── Unsigned integers, inherited endianness (root default le) ──────────────────────────────────
add(
  parse("u8 zero", "U8", "00", { v: 0 }),
  parse("u8 one", "U8", "01", { v: 1 }),
  parse("u8 0x7f", "U8", "7f", { v: 127 }),
  parse("u8 0x80", "U8", "80", { v: 128 }),
  parse("u8 max", "U8", "ff", { v: 255 }),
  perr("u8 eof", "U8", "", "EOF", ["v"]),

  parse("u16 le", "U16", "3412", { v: 0x1234 }),
  parse("u16 max", "U16", "ffff", { v: 65535 }),
  parse("u16 be by root argument", "U16", "1234", { v: 0x1234 }, { args: { endian: "be" } }),
  perr("u16 eof", "U16", "01", "EOF", ["v"]),

  parse("u24 le", "U24", "563412", { v: 0x123456 }),
  parse("u24 max", "U24", "ffffff", { v: 0xffffff }),
  parse("u24 be by root argument", "U24", "123456", { v: 0x123456 }, { args: { endian: "be" } }),
  perr("u24 eof", "U24", "0102", "EOF", ["v"]),

  parse("u32 le", "U32", "efbeadde", { v: 0xdeadbeef }),
  parse("u32 max", "U32", "ffffffff", { v: 4294967295 }),
  parse(
    "u32 be by root argument",
    "U32",
    "deadbeef",
    { v: 0xdeadbeef },
    { args: { endian: "be" } }
  ),
  perr("u32 eof", "U32", "010203", "EOF", ["v"]),

  parse("u40 le", "U40", "9a78563412", { v: 0x123456789a }),
  parse("u40 max", "U40", "ffffffffff", { v: 2 ** 40 - 1 }),
  perr("u40 eof", "U40", "01020304", "EOF", ["v"]),

  parse("u48 le", "U48", "bc9a78563412", { v: 0x123456789abc }),
  parse("u48 max", "U48", "ffffffffffff", { v: 2 ** 48 - 1 }),

  parse("u56 le is a string", "U56", "cdab8967452301", { v: big(0x0123456789abcdn) }),
  parse("u56 small is still a string", "U56", "01000000000000", { v: "1" }),
  parse("u56 max", "U56", "ffffffffffffff", { v: big(2n ** 56n - 1n) }),

  parse("u64 le", "U64", "0807060504030201", { v: big(0x0102030405060708n) }),
  parse("u64 zero", "U64", "0000000000000000", { v: "0" }),
  parse("u64 2^53+1 keeps precision", "U64", "0100000000002000", { v: big(2n ** 53n + 1n) }),
  parse("u64 max", "U64", "ffffffffffffffff", { v: "18446744073709551615" }),
  parse(
    "u64 be by root argument",
    "U64",
    "0102030405060708",
    { v: big(0x0102030405060708n) },
    { args: { endian: "be" } }
  ),
  perr("u64 eof", "U64", "01020304050607", "EOF", ["v"])
);

// ── Fixed endianness suffixes ───────────────────────────────────────────────────────────────────
add(
  parse("u16le", "U16le", "3412", { v: 0x1234 }),
  parse("u16le ignores root be", "U16le", "3412", { v: 0x1234 }, { args: { endian: "be" } }),
  parse("u24le", "U24le", "563412", { v: 0x123456 }),
  parse("u32le", "U32le", "78563412", { v: 0x12345678 }),
  parse("u64le", "U64le", "0807060504030201", { v: big(0x0102030405060708n) }),
  parse("u16be", "U16be", "1234", { v: 0x1234 }),
  parse("u16be ignores root le", "U16be", "1234", { v: 0x1234 }, { args: { endian: "le" } }),
  parse("u24be", "U24be", "123456", { v: 0x123456 }),
  parse("u32be", "U32be", "12345678", { v: 0x12345678 }),
  parse("u40be", "U40be", "123456789a", { v: 0x123456789a }),
  parse("u48be", "U48be", "123456789abc", { v: 0x123456789abc }),
  parse("u56be", "U56be", "0123456789abcd", { v: big(0x0123456789abcdn) }),
  parse("u64be", "U64be", "0102030405060708", { v: big(0x0102030405060708n) }),
  parse("u64be max", "U64be", "ffffffffffffffff", { v: "18446744073709551615" })
);

// ── Signed integers ─────────────────────────────────────────────────────────────────────────────
add(
  parse("i8 zero", "I8", "00", { v: 0 }),
  parse("i8 -1", "I8", "ff", { v: -1 }),
  parse("i8 min", "I8", "80", { v: -128 }),
  parse("i8 max", "I8", "7f", { v: 127 }),
  parse("i16 -2", "I16", "feff", { v: -2 }),
  parse("i16 min", "I16", "0080", { v: -32768 }),
  parse("i16 max", "I16", "ff7f", { v: 32767 }),
  parse("i24 -1", "I24", "ffffff", { v: -1 }),
  parse("i24 min", "I24", "000080", { v: -8388608 }),
  parse("i24 max", "I24", "ffff7f", { v: 8388607 }),
  parse("i24 sign extends 0x800000+1", "I24", "010080", { v: -8388607 }),
  parse("i32 min", "I32", "00000080", { v: -2147483648 }),
  parse("i32 -1", "I32", "ffffffff", { v: -1 }),
  parse("i32 max", "I32", "ffffff7f", { v: 2147483647 }),
  parse("i40 -1", "I40", "ffffffffff", { v: -1 }),
  parse("i40 min", "I40", "0000000080", { v: -(2 ** 39) }),
  parse("i40 max", "I40", "ffffffff7f", { v: 2 ** 39 - 1 }),
  parse("i48 min", "I48", "000000000080", { v: -(2 ** 47) }),
  parse("i48 -2", "I48", "feffffffffff", { v: -2 }),
  parse("i56 -1 is a string", "I56", "ffffffffffffff", { v: "-1" }),
  parse("i56 min", "I56", "00000000000080", { v: big(-(2n ** 55n)) }),
  parse("i56 max", "I56", "ffffffffffff7f", { v: big(2n ** 55n - 1n) }),
  parse("i64 min", "I64", "0000000000000080", { v: "-9223372036854775808" }),
  parse("i64 max", "I64", "ffffffffffffff7f", { v: "9223372036854775807" }),
  parse("i64 -1", "I64", "ffffffffffffffff", { v: "-1" }),
  parse(
    "i64 be by root argument",
    "I64",
    "fffffffffffffffe",
    { v: "-2" },
    { args: { endian: "be" } }
  ),
  parse("i16be", "I16be", "fffe", { v: -2 }),
  parse("i24be", "I24be", "800000", { v: -8388608 }),
  parse("i32be", "I32be", "80000000", { v: -2147483648 }),
  parse("i40be", "I40be", "ffffffffff", { v: -1 }),
  parse("i48be", "I48be", "800000000000", { v: -(2 ** 47) }),
  parse("i56be", "I56be", "fffffffffffffe", { v: "-2" }),
  parse("i64be", "I64be", "8000000000000000", { v: "-9223372036854775808" })
);

// ── Floats ──────────────────────────────────────────────────────────────────────────────────────
const f16 = (name: string, bits: number, root = "F16") => {
  const b = w().f16bits(bits, root === "F16be" ? "be" : "le");
  return parse(name, root, b, { v: fl(f16Value(bits)) });
};
add(
  f16("f16 one", 0x3c00),
  f16("f16 -2", 0xc000),
  f16("f16 max", 0x7bff),
  f16("f16 smallest subnormal", 0x0001),
  f16("f16 largest subnormal", 0x03ff),
  f16("f16 smallest normal", 0x0400),
  f16("f16 one third", 0x3555),
  f16("f16 zero", 0x0000),
  f16("f16 negative zero", 0x8000),
  f16("f16 infinity", 0x7c00),
  f16("f16 negative infinity", 0xfc00),
  f16("f16 canonical NaN", 0x7e00),
  f16("f16be one", 0x3c00, "F16be"),
  f16("f16be 0.5", 0x3800, "F16be"),
  parseOnly("f16 NaN payload reads as NaN", "F16", w().f16bits(0x7c01), { v: "NaN" }),
  parseOnly("f16 negative NaN reads as NaN", "F16", w().f16bits(0xfe00), { v: "NaN" }),
  ser("f16 writes NaN canonically", "F16", { v: "NaN" }, "007e"),
  ser("f16 writes -0", "F16", { v: "-0" }, "0080"),
  ser("f16 writes -Infinity", "F16", { v: "-Infinity" }, "00fc"),
  ser(
    "f16 rounds to nearest even (1 + 2^-11 -> 1)",
    "F16",
    { v: 1 + 2 ** -11 },
    w().f16bits(f16Bits(1 + 2 ** -11))
  ),
  ser(
    "f16 rounds to nearest even (1 + 3*2^-11 -> 1 + 2^-9)",
    "F16",
    { v: 1 + 3 * 2 ** -11 },
    w().f16bits(0x3c02)
  ),
  ser("f16 rounds 0.1", "F16", { v: 0.1 }, w().f16bits(0x2e66)),

  parse("f32 1.5", "F32", "0000c03f", { v: 1.5 }),
  parse("f32 0.1 is the f32 value", "F32", "cdcccc3d", { v: f32j(0.1) }),
  parse("f32 -0", "F32", "00000080", { v: "-0" }),
  parse("f32 zero", "F32", "00000000", { v: 0 }),
  parse("f32 infinity", "F32", "0000807f", { v: "Infinity" }),
  parse("f32 negative infinity", "F32", "000080ff", { v: "-Infinity" }),
  parse("f32 canonical NaN", "F32", "0000c07f", { v: "NaN" }),
  parse("f32 max", "F32", "ffff7f7f", { v: 3.4028234663852886e38 }),
  parse("f32 smallest subnormal", "F32", "01000000", { v: 1.401298464324817e-45 }),
  parse("f32 smallest normal", "F32", "00008000", { v: 1.1754943508222875e-38 }),
  parse("f32 -123.25", "F32", "0080f6c2", { v: -123.25 }),
  parseOnly("f32 signaling NaN reads as NaN", "F32", "0100807f", { v: "NaN" }),
  parseOnly("f32 negative NaN reads as NaN", "F32", "0000c0ff", { v: "NaN" }),
  ser("f32 writes NaN canonically", "F32", { v: "NaN" }, "0000c07f"),
  ser("f32 writes Infinity", "F32", { v: "Infinity" }, "0000807f"),
  ser("f32 rounds a double to nearest", "F32", { v: 0.1 }, "cdcccc3d"),
  ser("f32 writes an integer-valued number", "F32", { v: 16777216 }, "0000804b"),
  parse("f32be 1.5", "F32be", "3fc00000", { v: 1.5 }),
  parse("f32le ignores root be", "F32le", "0000c03f", { v: 1.5 }, { args: { endian: "be" } }),
  parse("f32 be by root argument", "F32", "3fc00000", { v: 1.5 }, { args: { endian: "be" } }),

  parse("f64 one", "F64", "000000000000f03f", { v: 1 }),
  parse("f64 0.1", "F64", "9a9999999999b93f", { v: 0.1 }),
  parse("f64 -0", "F64", "0000000000000080", { v: "-0" }),
  parse("f64 canonical NaN", "F64", "000000000000f87f", { v: "NaN" }),
  parse("f64 infinity", "F64", "000000000000f07f", { v: "Infinity" }),
  parse("f64 negative infinity", "F64", "000000000000f0ff", { v: "-Infinity" }),
  parse("f64 smallest subnormal", "F64", "0100000000000000", { v: 5e-324 }),
  parse("f64 max", "F64", "ffffffffffffef7f", { v: 1.7976931348623157e308 }),
  parse("f64 2^53", "F64", "0000000000004043", { v: 2 ** 53 }),
  parseOnly("f64 NaN payload reads as NaN", "F64", "010000000000f07f", { v: "NaN" }),
  ser("f64 writes NaN canonically", "F64", { v: "NaN" }, "000000000000f87f"),
  ser("f64 writes -0", "F64", { v: "-0" }, "0000000000000080"),
  parse("f64be one", "F64be", "3ff0000000000000", { v: 1 }),
  perr("f64 eof", "F64", "00000000000000", "EOF", ["v"]),
  perr("f16 eof", "F16", "00", "EOF", ["v"])
);

// ── bool ────────────────────────────────────────────────────────────────────────────────────────
add(
  parse("bool false", "Bool", "00", { v: false }),
  parse("bool true", "Bool", "01", { v: true }),
  parseOnly("bool nonzero reads as true", "Bool", "02", { v: true }),
  parseOnly("bool 0xff reads as true", "Bool", "ff", { v: true }),
  ser("bool writes 1 for true", "Bool", { v: true }, "01"),
  ser("bool writes 0 for false", "Bool", { v: false }, "00"),
  perr("bool strict rejects 2", "Bool", "02", "CHECK", ["v"], { strict: true }),
  parse("bool strict accepts 1", "Bool", "01", { v: true }, { strict: true }),
  perr("bool eof", "Bool", "", "EOF", ["v"])
);

// ── Write-side range checks ─────────────────────────────────────────────────────────────────────
add(
  ser("u8 writes 255", "U8", { v: 255 }, "ff"),
  serr("u8 256 is out of range", "U8", { v: 256 }, "RANGE", ["v"]),
  serr("u8 -1 is out of range", "U8", { v: -1 }, "RANGE", ["v"]),
  serr("i8 -129 is out of range", "I8", { v: -129 }, "RANGE", ["v"]),
  serr("i8 128 is out of range", "I8", { v: 128 }, "RANGE", ["v"]),
  ser("i8 writes -128", "I8", { v: -128 }, "80"),
  serr("u24 2^24 is out of range", "U24", { v: 16777216 }, "RANGE", ["v"]),
  ser("i24 writes -1", "I24", { v: -1 }, "ffffff"),
  serr("i24 2^23 is out of range", "I24", { v: 8388608 }, "RANGE", ["v"]),
  serr("u32 2^32 is out of range", "U32", { v: 4294967296 }, "RANGE", ["v"]),
  serr("u40 2^40 is out of range", "U40", { v: 2 ** 40 }, "RANGE", ["v"]),
  ser("u48 writes max", "U48", { v: 2 ** 48 - 1 }, "ffffffffffff"),
  serr("u56 2^56 is out of range", "U56", { v: big(2n ** 56n) }, "RANGE", ["v"]),
  ser("u64 writes max", "U64", { v: "18446744073709551615" }, "ffffffffffffffff"),
  serr("u64 2^64 is out of range", "U64", { v: "18446744073709551616" }, "RANGE", ["v"]),
  serr("u64 negative is out of range", "U64", { v: "-1" }, "RANGE", ["v"]),
  ser("i64 writes min", "I64", { v: "-9223372036854775808" }, "0000000000000080"),
  serr("i64 2^63 is out of range", "I64", { v: "9223372036854775808" }, "RANGE", ["v"]),
  serr("u8 missing field", "U8", {}, "INPUT", ["v"]),
  serr("u8 string is the wrong type", "U8", { v: "1" }, "INPUT", ["v"]),
  serr("bool number is the wrong type", "Bool", { v: 1 }, "INPUT", ["v"]),
  ser("u16 writes be by root argument", "U16", { v: 0x1234 }, "1234", { args: { endian: "be" } }),
  ser("u16be writes be", "U16be", { v: 0x1234 }, "1234")
);

// ── Several fields ──────────────────────────────────────────────────────────────────────────────
const mixed = w()
  .u8(1)
  .u16(0x0203)
  .u24(0x040506, "be")
  .int(32, -7)
  .f32(2.5, "be")
  .u64(2n ** 63n)
  .bool(true)
  .int(16, -300, "le")
  .f16(-0.5);
const mixedJson = {
  a: 1,
  b: 0x0203,
  c: 0x040506,
  d: -7,
  e: 2.5,
  f: big(2n ** 63n),
  g: true,
  h: -300,
  i: -0.5
};
add(
  parse("mixed fields", "Mixed", mixed, mixedJson),
  parse(
    "mixed fields with root be",
    "Mixed",
    w()
      .u8(1)
      .u16(0x0203, "be")
      .u24(0x040506, "be")
      .int(32, -7, "be")
      .f32(2.5, "be")
      .u64(2n ** 63n, "be")
      .bool(true)
      .int(16, -300, "le")
      .f16(-0.5, "be"),
    mixedJson,
    { args: { endian: "be" } }
  ),
  perr("mixed fields eof in the middle", "Mixed", mixed.hex().slice(0, 2 * 12), "EOF", ["e"]),
  ser("mixed fields serialize", "Mixed", mixedJson, mixed),
  parse("semicolons", "Semicolons", "01 0200 ff", { a: 1, b: 2, c: -1 }),
  parse("trailing bytes after the root are ignored", "U8", "0102", { v: 1 }, { roundtrip: false })
);

export default area(
  "primitives",
  "Integer widths, signedness, floats (NaN, ±Infinity, -0, subnormals), bool, endianness suffixes and root endianness.",
  cases
);
