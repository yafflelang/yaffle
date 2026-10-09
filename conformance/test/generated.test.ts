/**
 * The committed cases.json files must match their generators (conformance/scripts), and the
 * generator library must compute values correctly (it is the independent oracle).
 */
import { describe, expect, it } from "vitest";
import { outdatedAreas } from "../scripts/gen-cases.ts";
import { adler32, crc32, f16Bits, f16Value, fl, leb128, rleEncode, w } from "../scripts/lib.ts";

describe("generated cases", () => {
  it("are up to date (run node conformance/scripts/gen-cases.ts)", () => {
    expect(outdatedAreas()).toEqual([]);
  });
});

describe("generator library", () => {
  it("encodes integers in both byte orders", () => {
    expect(w().u16(0x1234).hex()).toBe("3412");
    expect(w().u24(0x123456, "be").hex()).toBe("123456");
    expect(w().int(40, -1).hex()).toBe("ffffffffff");
    expect(
      w()
        .u64(2n ** 64n - 1n)
        .hex()
    ).toBe("ffffffffffffffff");
    expect(() => w().u8(256)).toThrow();
    expect(() => w().int(8, -129)).toThrow();
  });
  it("converts f16 like IEEE 754", () => {
    const known: [number, number][] = [
      [1, 0x3c00],
      [-2, 0xc000],
      [65504, 0x7bff],
      [2 ** -24, 0x0001],
      [2 ** -14, 0x0400],
      [0.1, 0x2e66],
      [65520, 0x7c00],
      [Infinity, 0x7c00],
      [-0, 0x8000],
      [1 / 3, 0x3555]
    ];
    for (const [v, bits] of known) expect(f16Bits(v), String(v)).toBe(bits);
    for (let bits = 0; bits < 0x7c00; bits += 37) expect(f16Bits(f16Value(bits))).toBe(bits);
    expect(f16Bits(NaN)).toBe(0x7e00);
  });
  it("writes canonical float JSON", () => {
    expect([fl(NaN), fl(Infinity), fl(-Infinity), fl(-0), fl(1.5)]).toEqual([
      "NaN",
      "Infinity",
      "-Infinity",
      "-0",
      1.5
    ]);
  });
  it("computes checksums and codecs", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(adler32(new TextEncoder().encode("Wikipedia"))).toBe(0x11e60398);
    expect(rleEncode([1, 1, 1, 2])).toEqual([3, 1, 1, 2]);
    expect(leb128(300)).toEqual([0xac, 0x02]);
  });
});
