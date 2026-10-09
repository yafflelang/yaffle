/** Cases for conformance/cases/bitfields. Bit packing is computed explicitly per case. */
import { area, big, parse, parseOnly, perr, ser, serr, w, type Case } from "../lib.ts";

const cases: Case[] = [];
const add = (...c: Case[]) => cases.push(...c);

/** Packs fields LSB first: [value, width] pairs. */
function lsb(...fields: [number | bigint, number][]): bigint {
  let v = 0n;
  let shift = 0n;
  for (const [x, width] of fields) {
    const mask = (1n << BigInt(width)) - 1n;
    v |= (BigInt(x) & mask) << shift;
    shift += BigInt(width);
  }
  return v;
}

add(
  // compressed=1 (bit 0), kind=Vram=1 (bits 1..3), reserved 0: 0b0000_0011.
  parse("bits lsb first", "Bits8", w().u8(Number(lsb([1, 1], [1, 3], [0, 4]))), {
    compressed: true,
    kind: "Vram"
  }),
  parse("bits enum member", "Bits8", w().u8(Number(lsb([0, 1], [5, 3], [0, 4]))), {
    compressed: false,
    kind: "Pool"
  }),
  perr("bits unknown enum value", "Bits8", w().u8(Number(lsb([0, 1], [2, 3], [0, 4]))), "CHECK", [
    "kind"
  ]),
  parseOnly(
    "bits reserved ignored by default",
    "Bits8",
    w().u8(Number(lsb([1, 1], [0, 3], [0xf, 4]))),
    { compressed: true, kind: "Sys" }
  ),
  perr(
    "bits reserved checked in strict mode",
    "Bits8",
    w().u8(Number(lsb([1, 1], [0, 3], [0xf, 4]))),
    "CHECK",
    undefined,
    { strict: true }
  ),
  ser(
    "bits on write",
    "Bits8",
    { compressed: true, kind: "Pool" },
    w().u8(Number(lsb([1, 1], [5, 3], [0, 4])))
  ),
  // msb: hi takes bits 7..5, lo bits 4..0. 0b101_00011 = 0xa3.
  parse("bits msb first", "Msb", "a3", { hi: 5, lo: 3 }),
  ser("bits msb first on write", "Msb", { hi: 7, lo: 0 }, "e0"),
  serr("bits value too wide", "Msb", { hi: 8, lo: 0 }, "RANGE", ["hi"]),
  // s = low nibble sign-extended, u = high nibble.
  parse("bits signed member is sign extended", "Signed", "3f", { s: -1, u: 3 }),
  parse("bits signed member positive", "Signed", "37", { s: 7, u: 3 }),
  parse("bits signed member minimum", "Signed", "08", { s: -8, u: 0 }),
  ser("bits signed member on write", "Signed", { s: -2, u: 1 }, "1e"),
  serr("bits signed member out of range", "Signed", { s: 8, u: 0 }, "RANGE", ["s"]),
  parse("bits in a u32 unit", "Wide", w().u32(Number(lsb([0x12345, 20], [0xabc, 12]))), {
    a: 0x12345,
    b: 0xabc
  }),
  ser("bits in a u32 unit on write", "Wide", { a: 0xfffff, b: 0 }, w().u32(0x000fffff)),
  parse(
    "bits unit follows endianness",
    "WideBe",
    w().u16(Number(lsb([0xa, 4], [0x123, 12])), "be"),
    { a: 0xa, b: 0x123 }
  ),
  parse(
    "bits unit follows root be",
    "Wide",
    w().u32(Number(lsb([1, 20], [2, 12])), "be"),
    { a: 1, b: 2 },
    { args: { endian: "be" } }
  ),
  parse("unnamed reserved bits", "Reserved", "05", { a: 5 }),
  parseOnly("unnamed reserved bits ignored", "Reserved", "f5", { a: 5 }),
  perr("unnamed reserved bits strict", "Reserved", "f5", "CHECK", undefined, { strict: true }),
  ser("unnamed reserved bits written as zero", "Reserved", { a: 9 }, "09"),
  parse("constant in bits", "WithConst", w().u8(Number(lsb([3, 4], [0xa, 4]))), {
    version: 3,
    flags: 0xa
  }),
  perr("constant in bits mismatch", "WithConst", w().u8(Number(lsb([2, 4], [0xa, 4]))), "CHECK", [
    "version"
  ]),
  ser("constant in bits on write", "WithConst", { flags: 1 }, w().u8(Number(lsb([3, 4], [1, 4])))),
  parse(
    "count in bits",
    "BitCount",
    w()
      .u8(Number(lsb([2, 4], [7, 4])))
      .raw("aabb"),
    { n: 2, tag: 7, data: "aabb" }
  ),
  ser(
    "count in bits derived",
    "BitCount",
    { tag: 1, data: "010203" },
    w()
      .u8(Number(lsb([3, 4], [1, 4])))
      .raw("010203")
  ),
  serr(
    "count in bits overflows its width",
    "BitCount",
    { tag: 1, data: "00".repeat(16) },
    "RANGE",
    ["n"]
  )
);

add(
  parse(
    "c-style run",
    "CStyle",
    w()
      .u16(Number(lsb([0xabc, 12], [0xd, 4])))
      .u8(1),
    { sizeHigh: 0xabc, level: 0xd, after: 1 }
  ),
  ser(
    "c-style run on write",
    "CStyle",
    { sizeHigh: 1, level: 2, after: 3 },
    w()
      .u16(Number(lsb([1, 12], [2, 4])))
      .u8(3)
  ),
  parse(
    "c-style type change starts a new unit",
    "CStyleBreak",
    w()
      .u8(Number(lsb([5, 3], [0x1f, 5])))
      .u16(Number(lsb([0x1ff, 9], [0x7f, 7]))),
    { a: 5, b: 0x1f, c: 0x1ff, d: 0x7f }
  ),
  parse(
    "bits in a u64 unit",
    "Bits64",
    w().u64(lsb([0x123456789an, 40], [0xfedcb, 20], [0xe, 4])),
    { lo: big(0x123456789an), mid: 0xfedcb, top: 0xe }
  ),
  ser(
    "bits in a u64 unit on write",
    "Bits64",
    { lo: "1", mid: 0, top: 0xf },
    w().u64(lsb([1, 40], [0, 20], [0xf, 4]))
  )
);

export default area(
  "bitfields",
  "bits blocks (lsb/msb, bool/enum/signed members, reserved, constants, derived counts), C-style runs.",
  cases
);
