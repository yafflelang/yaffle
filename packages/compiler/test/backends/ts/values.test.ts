/** Strings, bytes, arrays, enums, bitfields, bools, floats: read, write, JSON, errors. */
import { describe, expect, it } from "vitest";
import { build, errorOf, hex, toHex } from "./harness.ts";
import * as ir from "./ir.ts";

const {
  S,
  f,
  derived,
  constant,
  program,
  u8,
  u16,
  u32,
  u64,
  i8,
  array,
  bytes,
  count,
  until,
  rest,
  ref,
  fr,
  len,
  vt,
  str,
  cstr,
  enumT,
  enumDecl,
  bits,
  check,
  it: itE,
  inSet,
  regex,
  call,
  strLit,
  bin
} = ir;

describe("strings", () => {
  it("fixed, NUL-terminated and rest strings in every encoding", async () => {
    const P = program({
      structs: [
        S("Strs", [
          f("fixed", str(count(8))),
          f("c", cstr),
          f("ascii", str(count(4), "ascii")),
          f("latin", str(count(3), "latin1")),
          f("w16", str(until(0), "utf16")),
          f("w16be", str(count(3), "utf16", "be")),
          f("w32", str(until(0), "utf32")),
          derived("n", u8, call("len", [fr("title", vt.string)])),
          f("title", str(count(fr("n", vt.int(8))))),
          f("tail", str(rest))
        ])
      ],
      roots: ["Strs"]
    });
    const m = await build("strings", P);
    const value = {
      fixed: "héllo",
      c: "path/to",
      ascii: "AB",
      latin: "éÿ",
      w16: "wïde😀",
      w16be: "abc",
      w32: "z😀",
      title: "ünï",
      tail: "rest"
    };
    const out: Uint8Array = m.Strs.serialize(value);
    const v = m.Strs.parse(out);
    expect(v).toEqual({ ...value, n: 5 });
    expect(toHex(out.subarray(0, 8))).toBe("68c3a96c6c6f0000");
    expect(toHex(m.Strs.serialize(v))).toBe(toHex(out));
    expect(m.Strs.fromJson(m.Strs.toJson(v))).toEqual(v);
  });

  it("drops data after the NUL in fixed strings and rejects bad encodings", async () => {
    const P = program({
      structs: [S("A", [f("s", str(count(4), "ascii"))]), S("U", [f("s", str(count(2)))])],
      roots: ["A", "U"]
    });
    const m = await build("strings-errors", P);
    expect(m.A.parse(hex("41004243")).s).toBe("A");
    const e1 = m.A.safeParse(hex("41804243"));
    expect(e1.error.code).toBe("CHECK");
    expect(e1.error.path).toEqual(["s"]);
    expect(m.U.safeParse(hex("c328")).error.code).toBe("CHECK");
    expect(() => m.A.serialize({ s: "toolong" })).toThrow(/exceeds the length/);
    expect(errorOf(() => m.A.serialize({ s: "é" }))).toMatchObject({ code: "INPUT", path: ["s"] });
    expect(() => m.A.serialize({ s: "a\0b" })).toThrow(/NUL/);
  });
});

describe("bytes and arrays", () => {
  it("count, until and rest lengths", async () => {
    const P = program({
      structs: [
        S("B", [
          derived("n", u8, len(fr("a", vt.bytes))),
          f("a", bytes(count(fr("n", vt.int(8))))),
          f("b", bytes(until(0xff))),
          f("list", array(u16, until(0xffff))),
          f("tail", array(u16, rest))
        ])
      ],
      roots: ["B"]
    });
    const m = await build("bytes", P);
    const value = {
      a: new Uint8Array([1, 2]),
      b: new Uint8Array([3, 4, 5]),
      list: [1, 2, 3],
      tail: [7, 8]
    };
    const out = m.B.serialize(value);
    expect(toHex(out)).toBe("02" + "0102" + "030405ff" + "010002000300ffff" + "07000800");
    const v = m.B.parse(out);
    expect(v).toEqual({ n: 2, ...value });
    expect(m.B.toJson(v)).toEqual({ n: 2, a: "0102", b: "030405", list: [1, 2, 3], tail: [7, 8] });
    expect(() => m.B.serialize({ ...value, b: new Uint8Array([0xff]) })).toThrow(/terminator/);
    expect(() => m.B.serialize({ ...value, list: [0xffff] })).toThrow(/terminator/);
    // rest of u16 with an odd byte left over → EOF
    const odd = m.B.safeParse(hex("00ffffff07"));
    expect(odd.error.code).toBe("EOF");
    expect(odd.error.path).toEqual(["tail", 0]);
  });

  it("non-derivable lengths stay inputs and are checked (DERIVE)", async () => {
    const P = program({
      structs: [S("Flags", [f("n", u32), f("flags", bytes(count(ir.div(ir.add(fr("n"), 7), 8))))])],
      roots: ["Flags"]
    });
    const m = await build("flags", P);
    const out = m.Flags.serialize({ n: 9, flags: new Uint8Array([1, 2]) });
    expect(toHex(out)).toBe("090000000102");
    expect(errorOf(() => m.Flags.serialize({ n: 9, flags: new Uint8Array([1]) }))).toMatchObject({
      code: "DERIVE",
      path: ["flags"]
    });
  });

  it("shared counts must agree", async () => {
    const P = program({
      structs: [
        S("Two", [
          derived("n", u8, len(fr("a", vt.array(vt.int(8))))),
          f("a", array(u8, count(fr("n", vt.int(8))))),
          f("b", array(u8, count(fr("n", vt.int(8)))))
        ])
      ],
      roots: ["Two"]
    });
    const m = await build("shared-count", P);
    expect(toHex(m.Two.serialize({ a: [1, 2], b: [3, 4] }))).toBe("0201020304");
    expect(m.Two.safeParse(hex("0201020304")).ok).toBe(true);
    expect(errorOf(() => m.Two.serialize({ a: [1, 2], b: [3] }))).toMatchObject({
      code: "DERIVE",
      path: ["b"]
    });
  });

  it("arrays of structs with $index", async () => {
    const P = program({
      structs: [
        S("El", [
          f("v", u8),
          f("idx", u8, { checks: [check(bin("==", itE(vt.int(8)), ir.$index), "idx == $index")] })
        ]),
        S("Arr", [
          derived("n", u8, len(fr("els", vt.array(vt.struct("El"))))),
          f("els", array(ref("El"), count(fr("n", vt.int(8)))))
        ])
      ],
      roots: ["Arr"]
    });
    const m = await build("index", P);
    const v = m.Arr.parse(hex("03" + "0a00" + "0b01" + "0c02"));
    expect(v.els).toEqual([
      { v: 10, idx: 0 },
      { v: 11, idx: 1 },
      { v: 12, idx: 2 }
    ]);
    const bad = m.Arr.safeParse(hex("02" + "0a00" + "0b05"));
    expect(bad.error.code).toBe("CHECK");
    expect(bad.error.path).toEqual(["els", 1, "idx"]);
    expect(() => m.Arr.serialize({ els: [{ v: 1, idx: 1 }] })).toThrow(/idx == \$index/);
  });
});

describe("enums", () => {
  it("closed and open enums", async () => {
    const P = program({
      structs: [S("E", [f("k", enumT("Kind")), f("o", enumT("Open"))])],
      enums: [enumDecl("Kind", "u16", { Sys: 0, Gpu: 1 }), enumDecl("Open", "u8", { A: 1 }, true)],
      roots: ["E"]
    });
    const m = await build("enums", P);
    expect(m.E.parse(hex("010001"))).toEqual({ k: "Gpu", o: "A" });
    expect(m.E.parse(hex("010009"))).toEqual({ k: "Gpu", o: 9 });
    const bad = m.E.safeParse(hex("050001"));
    expect(bad.error.code).toBe("CHECK");
    expect(bad.error.path).toEqual(["k"]);
    expect(toHex(m.E.serialize({ k: "Sys", o: 7 }))).toBe("000007");
    expect(() => m.E.serialize({ k: "Nope", o: 1 })).toThrow(/not a member/);
    expect(m.E.toJson({ k: "Sys", o: 7 })).toEqual({ k: "Sys", o: 7 });
    expect(m.Kind).toEqual({ Sys: 0, Gpu: 1 });
  });
});

describe("bitfields", () => {
  it("lsb-first fields, bool, enum, signed and reserved bits", async () => {
    const P = program({
      structs: [
        S("Bits", [
          bits("u16", [
            { name: "flag", width: 1, type: ir.bool },
            { name: "kind", width: 3, type: enumT("K") },
            { name: "neg", width: 4, type: i8 },
            { name: null, width: 4 },
            { name: "hi", width: 4, type: u8 }
          ])
        ])
      ],
      enums: [enumDecl("K", "u8", { A: 0, B: 5 })],
      roots: ["Bits"]
    });
    const m = await build("bits", P);
    const value = { flag: true, kind: "B", neg: -2, hi: 0xa };
    const out = m.Bits.serialize(value);
    // flag 1 | kind 5<<1 | neg (0xe)<<4 | hi 0xa<<12 = 0xa0eb
    expect(toHex(out)).toBe("eba0");
    expect(m.Bits.parse(out)).toEqual(value);
    expect(m.Bits.parse(hex("eba5"))).toEqual(value);
    expect(m.Bits.safeParse(hex("eba5"), { strict: true }).error.code).toBe("CHECK");
    expect(() => m.Bits.serialize({ ...value, hi: 16 })).toThrow(/does not fit/);
    expect(() => m.Bits.serialize({ ...value, neg: -9 })).toThrow(/does not fit/);
  });

  it("msb-first and 64-bit storage", async () => {
    const P = program({
      structs: [
        S("Msb", [
          bits(
            "u8",
            [
              { name: "a", width: 2, type: u8 },
              { name: "b", width: 6, type: u8 }
            ],
            { bitOrder: "msb" }
          )
        ]),
        S("Wide", [
          bits(
            "u64",
            [
              { name: "lo", width: 40, type: u64 },
              { name: "hi", width: 24, type: u32 }
            ],
            { endian: "be" }
          )
        ])
      ],
      roots: ["Msb", "Wide"]
    });
    const m = await build("bits-msb", P);
    expect(m.Msb.parse(hex("c5"))).toEqual({ a: 3, b: 5 });
    expect(toHex(m.Msb.serialize({ a: 3, b: 5 }))).toBe("c5");
    const w = { lo: 0x123456789an, hi: 0xabcdef };
    const out = m.Wide.serialize(w);
    expect(toHex(out)).toBe("abcdef123456789a");
    expect(m.Wide.parse(out)).toEqual(w);
  });
});

describe("constants and checks", () => {
  it("in, ranges, regex and where", async () => {
    const P = program({
      structs: [
        S("C", [
          f("order", str(count(2), "ascii"), {
            literals: [
              { kind: "string", value: "II" },
              { kind: "string", value: "MM" }
            ],
            checks: [
              check(inSet(itE(vt.string), strLit("II"), strLit("MM")), 'order in ("II", "MM")')
            ]
          }),
          f("version", u32, {
            checks: [check(inSet(itE(), 1, 2, [5, 9]), "version in (1, 2, 5..9)")]
          }),
          f("ver", cstr, {
            checks: [check(regex(itE(vt.string), "v\\d\\.\\d{1,2}"), "ver in /v\\d\\.\\d{1,2}/")]
          }),
          f("size", u32, { checks: [check(bin("==", bin("%", itE(), 4), 0), "size % 4 == 0")] })
        ])
      ],
      roots: ["C"]
    });
    const m = await build("checks", P);
    const good = { order: "MM", version: 7, ver: "v1.23", size: 8 };
    const out = m.C.serialize(good);
    expect(m.C.parse(out)).toEqual(good);
    for (const [k, v] of [
      ["order", "XX"],
      ["version", 4],
      ["ver", "v1.234"],
      ["size", 6]
    ] as const) {
      // Checks also apply on write.
      expect(errorOf(() => m.C.serialize({ ...good, [k]: v }))).toMatchObject({
        code: "CHECK",
        path: [k]
      });
      const bytes = m.C.serialize(good);
      const patched = new Uint8Array(bytes);
      if (k === "version") patched[2] = 4;
      if (k === "size") patched[patched.length - 4] = 6;
      if (k === "order") patched[0] = 0x58;
      if (k === "ver") continue;
      const r = m.C.safeParse(patched);
      expect(r.error.code).toBe("CHECK");
      expect(r.error.path).toEqual([k]);
    }
  });

  it("bools: nonzero is true, strict mode wants 0/1", async () => {
    const P = program({ structs: [S("B", [f("b", ir.bool)])], roots: ["B"] });
    const m = await build("bool", P);
    expect(m.B.parse(hex("02")).b).toBe(true);
    expect(m.B.safeParse(hex("02"), { strict: true }).error.code).toBe("CHECK");
    expect(toHex(m.B.serialize({ b: true }))).toBe("01");
    expect(() => m.B.serialize({ b: 1 })).toThrow(/boolean/);
  });

  it("integer ranges on write", async () => {
    const P = program({ structs: [S("R", [f("a", u8), f("b", u64), f("c", i8)])], roots: ["R"] });
    const m = await build("ranges", P);
    expect(toHex(m.R.serialize({ a: 255, b: 5, c: -128 }))).toBe("ff" + "0500000000000000" + "80");
    for (const bad of [
      { a: 256, b: 0n, c: 0 },
      { a: 0, b: -1n, c: 0 },
      { a: 0, b: 0n, c: 128 },
      { a: 1.5, b: 0n, c: 0 }
    ]) {
      expect(errorOf(() => m.R.serialize(bad)).code).toBe("RANGE");
    }
    expect(errorOf(() => m.R.serialize({ a: "x", b: 0n, c: 0 })).code).toBe("INPUT");
    const missing = errorOf(() => m.R.serialize({ a: 1, c: 0 }));
    expect(missing.code).toBe("INPUT");
    expect(missing.message).toMatch(/missing required field b/);
  });

  it("floats: special values in JSON", async () => {
    const P = program({
      structs: [S("F", [f("a", ir.f32), f("b", ir.f64), f("c", ir.f16)])],
      roots: ["F"]
    });
    const m = await build("floats", P);
    const v = { a: NaN, b: -0, c: Infinity };
    const out = m.F.serialize(v);
    const back = m.F.parse(out);
    expect(Number.isNaN(back.a)).toBe(true);
    expect(Object.is(back.b, -0)).toBe(true);
    expect(back.c).toBe(Infinity);
    expect(m.F.toJson(back)).toEqual({ a: "NaN", b: "-0", c: "Infinity" });
    const j = m.F.fromJson({ a: "-Infinity", b: 1.25, c: "-0" });
    expect(j.a).toBe(-Infinity);
    expect(Object.is(j.c, -0)).toBe(true);
  });

  it("constants of every kind", async () => {
    const P = program({
      structs: [
        S("K", [
          constant("tag", str(count(4), "ascii"), "ARCV"),
          constant("big", u64, 1n << 63n),
          constant("x", u8, 7)
        ])
      ],
      roots: ["K"]
    });
    const m = await build("constants", P);
    const out = m.K.serialize({});
    expect(toHex(out)).toBe("41524356" + "0000000000000080" + "07");
    expect(m.K.parse(out)).toEqual({ tag: "ARCV", big: 1n << 63n, x: 7 });
    expect(m.K.toJson(m.K.parse(out))).toEqual({ tag: "ARCV", big: "9223372036854775808", x: 7 });
    expect(m.K.safeParse(hex("41524356000000000000008008")).error.path).toEqual(["x"]);
  });
});
