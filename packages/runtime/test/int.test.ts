import { describe, expect, it } from "vitest";
import * as rt from "../src/index.ts";
import { code } from "./helpers.ts";

describe("integer semantics (IR.md §6)", () => {
  it("division truncates toward zero, % takes the sign of the dividend", () => {
    expect(rt.div(7, 2)).toBe(3);
    expect(rt.div(-7, 2)).toBe(-3);
    expect(rt.div(7, -2)).toBe(-3);
    expect(Object.is(rt.div(-1, 2), 0)).toBe(true);
    expect(rt.mod(-7, 2)).toBe(-1);
    expect(rt.mod(7, -2)).toBe(1);
    expect(Object.is(rt.mod(-4, 2), 0)).toBe(true);
    expect(rt.divBig(-7n, 2n)).toBe(-3n);
    expect(rt.modBig(-7n, 2n)).toBe(-1n);
    expect(code(() => rt.div(1, 0))).toBe("RANGE");
    expect(code(() => rt.modBig(1n, 0n))).toBe("RANGE");
  });

  it("shifts are exact and arithmetic", () => {
    expect(rt.shl(1, 40)).toBe(2 ** 40);
    expect(rt.shlBig(1n, 63)).toBe(2n ** 63n);
    expect(rt.shr(-5, 1)).toBe(-3);
    expect(rt.shrBig(-5n, 1)).toBe(-3n);
    expect(code(() => rt.shl(1, 64))).toBe("RANGE");
    expect(code(() => rt.shr(1, -1))).toBe("RANGE");
  });

  it("round half away from zero", () => {
    expect(rt.round(2.5)).toBe(3);
    expect(rt.round(-2.5)).toBe(-3);
    expect(rt.round(0.49999999999999994)).toBe(0);
    expect(Object.is(rt.round(-0.4), 0)).toBe(true);
    expect(code(() => rt.round(NaN))).toBe("RANGE");
  });

  it("conversions and lengths", () => {
    expect(rt.num(5n)).toBe(5);
    expect(code(() => rt.num(2n ** 60n))).toBe("RANGE");
    expect(code(() => rt.num(2 ** 60))).toBe("RANGE");
    expect(rt.big(3)).toBe(3n);
    expect(code(() => rt.big(1.5))).toBe("RANGE");
    expect(rt.len(4n)).toBe(4);
    expect(code(() => rt.len(-1))).toBe("RANGE");
    expect(rt.min(3n, 2n)).toBe(2n);
    expect(rt.max(3, 7)).toBe(7);
    expect(rt.absBig(-4n)).toBe(4n);
  });

  it("structural equality and table lookups", () => {
    expect(rt.equals(1, 1n)).toBe(true);
    expect(rt.equals(NaN, NaN)).toBe(true);
    expect(rt.equals(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(rt.equals(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(rt.equals([1, [2, 3n]], [1, [2, 3]])).toBe(true);
    expect(rt.equals({ a: 1, b: "x" }, { a: 1, b: "x" })).toBe(true);
    expect(rt.equals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(rt.equals("a", 1)).toBe(false);
    expect(rt.indexOf(["a", "b"], "b")).toBe(1);
    expect(code(() => rt.indexOf(["a"], "z"))).toBe("INPUT");
  });
});
