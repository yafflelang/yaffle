import { describe, expect, it } from "vitest";
import {
  PRIMS,
  checkPrim,
  floatToHalf,
  halfToFloat,
  primMax,
  primMin,
  readPrim,
  readUintNBig,
  writePrim,
  type PrimKind
} from "../src/index.ts";
import { code } from "./helpers.ts";

const KINDS = Object.keys(PRIMS) as PrimKind[];

describe("half precision", () => {
  it("round-trips every non-NaN half bit pattern", () => {
    for (let h = 0; h < 0x10000; h++) {
      const f = halfToFloat(h);
      if (Number.isNaN(f)) continue;
      expect(floatToHalf(f)).toBe(h);
    }
  });

  it("rounds to nearest even and saturates to infinity", () => {
    expect(floatToHalf(1)).toBe(0x3c00);
    expect(floatToHalf(65504)).toBe(0x7bff);
    expect(floatToHalf(65520)).toBe(0x7c00);
    expect(floatToHalf(1e9)).toBe(0x7c00);
    expect(floatToHalf(-0)).toBe(0x8000);
    expect(floatToHalf(2 ** -24)).toBe(1);
    expect(floatToHalf(2 ** -25)).toBe(0); // tie to even
    expect(floatToHalf(1 + 2 ** -11)).toBe(0x3c00); // tie to even (down)
    expect(floatToHalf(1 + 3 * 2 ** -11)).toBe(0x3c02); // tie to even (up)
    expect(floatToHalf(NaN)).toBe(0x7e00);
    expect(halfToFloat(0x7c00)).toBe(Infinity);
    expect(halfToFloat(0xfc00)).toBe(-Infinity);
  });
});

describe("integers", () => {
  it("reads and writes every kind in both byte orders", () => {
    const buf = new Uint8Array(16);
    const dv = new DataView(buf.buffer);
    for (const k of KINDS) {
      const p = PRIMS[k];
      const values: (number | bigint)[] = p.float
        ? [0, 1.5, -2.25, 1024]
        : [primMin(k), primMax(k), 0n, 1n, p.signed ? -1n : 2n].map(b => (p.big ? b : Number(b)));
      for (const le of [true, false]) {
        for (const v of values) {
          writePrim(buf, dv, 3, k, v, le);
          expect(readPrim(buf, dv, 3, k, le), `${k} ${le} ${v}`).toEqual(v);
        }
      }
    }
  });

  it("byte order of odd sizes", () => {
    const buf = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
    const dv = new DataView(buf.buffer);
    expect(readPrim(buf, dv, 0, "u24", true)).toBe(0x030201);
    expect(readPrim(buf, dv, 0, "u24", false)).toBe(0x010203);
    expect(readPrim(buf, dv, 0, "u56", false)).toBe(0x01020304050607n);
    expect(readUintNBig(buf, 0, 7, true)).toBe(0x07060504030201n);
  });

  it("checkPrim validates type and range", () => {
    expect(checkPrim(255, "u8")).toBe(255);
    expect(checkPrim(5n, "u16")).toBe(5);
    expect(checkPrim(5, "u64")).toBe(5n);
    expect(checkPrim(1.5, "f32")).toBe(1.5);
    expect(code(() => checkPrim(256, "u8"))).toBe("RANGE");
    expect(code(() => checkPrim(-1, "u32"))).toBe("RANGE");
    expect(code(() => checkPrim(2n ** 64n, "u64"))).toBe("RANGE");
    expect(code(() => checkPrim(-(2n ** 63n) - 1n, "i64"))).toBe("RANGE");
    expect(code(() => checkPrim(0.5, "u8"))).toBe("RANGE");
    expect(code(() => checkPrim("1", "u8"))).toBe("INPUT");
    expect(code(() => checkPrim(null, "u64"))).toBe("INPUT");
    expect(code(() => checkPrim(NaN, "u8"))).toBe("INPUT");
    expect(code(() => checkPrim(2 ** 53, "u64"))).toBe("none");
  });
});
