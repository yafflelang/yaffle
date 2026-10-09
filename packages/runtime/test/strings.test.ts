import { describe, expect, it } from "vitest";
import * as rt from "../src/index.ts";
import { code } from "./helpers.ts";

describe("strings", () => {
  const samples: [rt.StringEncoding, string][] = [
    ["utf8", "héllo wörld 😀"],
    ["ascii", "plain text"],
    ["latin1", "café ÿ"],
    ["utf16", "wïde 😀 text"],
    ["utf32", "z😀ü"]
  ];

  for (const [enc, s] of samples) {
    for (const le of [true, false]) {
      it(`${enc} ${le ? "le" : "be"} round-trips`, () => {
        const b = rt.encodeString(s, enc, le);
        const unit = rt.unitOf(enc);
        expect(b.length).toBe(rt.encodedLength(s, enc) * unit);
        expect(rt.decodeString(b, 0, b.length / unit, enc, le)).toBe(s);
      });
    }
  }

  it("keeps a leading BOM in UTF-8", () => {
    const b = new Uint8Array([0xef, 0xbb, 0xbf, 0x41]);
    expect(rt.decodeString(b, 0, 4, "utf8", true)).toBe("﻿A");
  });

  it("invalid input is CHECK on read and INPUT on write", () => {
    expect(code(() => rt.decodeString(new Uint8Array([0xc3, 0x28]), 0, 2, "utf8", true))).toBe(
      "CHECK"
    );
    expect(code(() => rt.decodeString(new Uint8Array([0x80]), 0, 1, "ascii", true))).toBe("CHECK");
    expect(
      code(() => rt.decodeString(new Uint8Array([0x00, 0xd8, 0x41, 0x00]), 0, 2, "utf16", true))
    ).toBe("CHECK");
    expect(code(() => rt.decodeString(new Uint8Array([0x00, 0xdc]), 0, 1, "utf16", true))).toBe(
      "CHECK"
    );
    expect(code(() => rt.decodeString(new Uint8Array([0, 0, 0x11, 0]), 0, 1, "utf32", true))).toBe(
      "CHECK"
    );
    expect(code(() => rt.encodeString("é", "ascii", true))).toBe("INPUT");
    expect(code(() => rt.encodeString("Ā", "latin1", true))).toBe("INPUT");
    expect(code(() => rt.encodeString("a\0b", "utf8", true))).toBe("INPUT");
    expect(code(() => rt.encodeString("\ud800", "utf16", true))).toBe("INPUT");
    expect(code(() => rt.encodeString(5, "utf8", true))).toBe("INPUT");
  });

  it("finds NUL units", () => {
    expect(rt.findNulUnit(new Uint8Array([1, 2, 0, 3]), 0, 4, 1)).toBe(2);
    expect(rt.findNulUnit(new Uint8Array([1, 0, 0, 2, 0, 0]), 0, 3, 2)).toBe(2);
    expect(rt.findNulUnit(new Uint8Array([1, 0, 0, 2, 3, 0]), 0, 3, 2)).toBe(-1);
    expect(rt.findNulUnit(new Uint8Array([1, 0, 0, 0, 0, 0]), 0, 3, 2)).toBe(1);
    expect(rt.isWellFormed("a😀")).toBe(true);
    expect(rt.isWellFormed("a\udc00")).toBe(false);
  });
});

describe("checksums", () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  it("crc32 and adler32 known values", () => {
    expect(rt.crc32(enc("123456789"))).toBe(0xcbf43926);
    expect(rt.crc32(new Uint8Array(0))).toBe(0);
    expect(rt.crc32(enc("456789"), rt.crc32(enc("123")))).toBe(0xcbf43926);
    expect(rt.adler32(enc("Wikipedia"))).toBe(0x11e60398);
    expect(rt.adler32(new Uint8Array(0))).toBe(1);
    const big = new Uint8Array(100000).fill(0xff);
    expect(rt.adler32(big)).toBe(
      rt.adler32(big.subarray(50000), rt.adler32(big.subarray(0, 50000)))
    );
  });
});

describe("canonical JSON helpers", () => {
  it("hex, floats, integers", () => {
    expect(rt.toHex(new Uint8Array([0, 0xab, 0xff]))).toBe("00abff");
    expect(Array.from(rt.fromHex("00 AB ff"))).toEqual([0, 0xab, 0xff]);
    expect(code(() => rt.fromHex("abc"))).toBe("INPUT");
    expect(code(() => rt.fromHex("zz"))).toBe("INPUT");
    expect(rt.floatToJson(-0)).toBe("-0");
    expect(rt.floatToJson(NaN)).toBe("NaN");
    expect(rt.floatToJson(1.5)).toBe(1.5);
    expect(Object.is(rt.floatFromJson("-0"), -0)).toBe(true);
    expect(rt.floatFromJson("-Infinity")).toBe(-Infinity);
    expect(code(() => rt.floatFromJson("x"))).toBe("INPUT");
    expect(rt.intFromJson(12)).toBe(12);
    expect(code(() => rt.intFromJson("12"))).toBe("INPUT");
    expect(code(() => rt.intFromJson(1.5))).toBe("RANGE");
    expect(rt.bigFromJson("18446744073709551615")).toBe(2n ** 64n - 1n);
    expect(code(() => rt.bigFromJson(7))).toBe("INPUT");
    expect(code(() => rt.objectFromJson([]))).toBe("INPUT");
    expect(rt.ptr("/a", "x/y~z")).toBe("/a/x~1y~0z");
  });

  it("$ref round trip of shared objects", () => {
    const shared = { id: 1 };
    const t = new rt.ToJsonCtx();
    expect(t.ref(shared, "/a")).toBeUndefined();
    expect(t.ref(shared, "/b")).toEqual({ $ref: "/a" });
    expect(t.ref(5, "/c")).toBeUndefined();
    const f = new rt.FromJsonCtx();
    const obj = f.register("/a", { id: 1 });
    expect(f.deref({ $ref: "/a" })!.value).toBe(obj);
    expect(f.deref({ $ref: "/a", x: 1 })).toBeUndefined();
    expect(code(() => f.deref({ $ref: "/missing" }))).toBe("INPUT");
    const arr = f.arr([1, 2], "/xs", (e: unknown) => rt.intFromJson(e));
    expect(f.arr({ $ref: "/xs" }, "/ys", () => 0)).toBe(arr);
    try {
      f.arr([1, "x"], "/zs", (e: unknown) => rt.intFromJson(e));
    } catch (e) {
      expect((e as rt.YaffleError).path).toEqual([1]);
    }
    expect(rt.unionFromJson({ type: "A", value: 1 }, { A: (j: unknown) => j }, "/u")).toEqual({
      type: "A",
      value: 1
    });
    expect(code(() => rt.unionFromJson({ type: "B" }, { A: (j: unknown) => j }, "/u"))).toBe(
      "INPUT"
    );
    expect(rt.enumFromJson({ A: 1 }, "A", false)).toBe("A");
    expect(rt.enumFromJson({ A: 1 }, 5, true)).toBe(5);
    expect(code(() => rt.enumFromJson({ A: 1 }, 5, false))).toBe("INPUT");
    expect(rt.firstOf([() => rt.intFromJson("x"), () => 2])).toBe(2);
    expect(rt.tryOr(() => rt.intFromJson("x"), undefined)).toBeUndefined();
  });
});

describe("errors", () => {
  it("paths are prefixed while unwinding and formatted", () => {
    const e = new rt.YaffleError("CHECK", "bad", 0x10);
    e.prefix("entries", 3);
    e.prefix("root");
    expect(e.path).toEqual(["root", "entries", 3]);
    expect(e.message).toBe("CHECK at root.entries[3] (offset 0x10): bad");
    try {
      rt.rethrowAt(new rt.YaffleError("EOF", "x"), "a", -1, 2);
    } catch (x) {
      expect((x as rt.YaffleError).path).toEqual(["a", 2]);
    }
    const plain = new Error("host");
    expect(() => rt.rethrowAt(plain, "a")).toThrow(plain);
    expect(rt.safe(() => 1)).toEqual({ ok: true, value: 1 });
    expect(rt.safe(() => rt.fail("RANGE", "r")).ok).toBe(false);
    expect(() =>
      rt.safe(() => {
        throw new Error("x");
      })
    ).toThrow("x");
    expect(rt.formatPath(["a", 0, "b"])).toBe("a[0].b");
  });
});
