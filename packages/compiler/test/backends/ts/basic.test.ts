import { describe, expect, it } from "vitest";
import { build, hex, toHex } from "./harness.ts";
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
  i16,
  f32,
  array,
  count,
  ref,
  fr,
  len,
  vt
} = ir;

describe("basic structs", () => {
  it("reads and writes a flat struct with every integer width", async () => {
    const P = program({
      structs: [
        S("Prims", [
          f("a", u8),
          f("b", u16),
          f("c", ir.u24),
          f("d", u32),
          f("e", ir.u40),
          f("g", ir.u48),
          f("h", ir.u56),
          f("i", u64),
          f("j", ir.i8),
          f("k", i16),
          f("l", ir.i24),
          f("m", ir.i32),
          f("n", ir.i40),
          f("o", ir.i48),
          f("p", ir.i56),
          f("q", ir.i64),
          f("r", ir.f16),
          f("s", f32),
          f("t", ir.f64)
        ])
      ],
      roots: ["Prims"]
    });
    const m = await build("prims", P);
    const bytes = hex(
      "01" +
        "0201" +
        "030201" +
        "04030201" +
        "0504030201" +
        "060504030201" +
        "07060504030201" +
        "0807060504030201" +
        "ff" +
        "feff" +
        "fdffff" +
        "fcffffff" +
        "fbffffffff" +
        "faffffffffff" +
        "f9ffffffffffff" +
        "f8ffffffffffffff" +
        "003c" +
        "0000c03f" +
        "000000000000f83f"
    );
    const v = m.Prims.parse(bytes);
    expect(v).toEqual({
      a: 1,
      b: 0x0102,
      c: 0x010203,
      d: 0x01020304,
      e: 0x0102030405,
      g: 0x010203040506,
      h: 0x01020304050607n,
      i: 0x0102030405060708n,
      j: -1,
      k: -2,
      l: -3,
      m: -4,
      n: -5,
      o: -6,
      p: -7n,
      q: -8n,
      r: 1,
      s: 1.5,
      t: 1.5
    });
    expect(toHex(m.Prims.serialize(v))).toBe(toHex(bytes));
    const be = m.Prims.parse(bytes, { endian: "be" });
    expect(be.b).toBe(0x0201);
    expect(toHex(m.Prims.serialize(be, { endian: "be" }))).toBe(toHex(bytes));
    expect(m.Prims.toJson(v)).toMatchObject({
      h: "283686952306183",
      i: "72623859790382856",
      p: "-7",
      s: 1.5
    });
    expect(m.Prims.fromJson(m.Prims.toJson(v))).toEqual(v);
  });

  it("derives counts and checks constants", async () => {
    const P = program({
      structs: [
        S("Entry", [f("x", u16), f("y", u16)]),
        S("Table", [
          constant("magic", u32, 0x56435241),
          derived("count", u32, len(fr("entries", vt.array(vt.struct("Entry"))))),
          f("entries", array(ref("Entry"), count(fr("count"))))
        ])
      ],
      roots: ["Table"]
    });
    const m = await build("table", P);
    const value = {
      entries: [
        { x: 1, y: 2 },
        { x: 3, y: 4 }
      ]
    };
    const out = m.Table.serialize(value);
    expect(toHex(out)).toBe("41524356" + "02000000" + "01000200" + "03000400");
    const back = m.Table.parse(out);
    expect(back).toEqual({ magic: 0x56435241, count: 2, ...value });
    const bad = m.Table.safeParse(hex("5041434d00000000"));
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe("CHECK");
    expect(bad.error.path).toEqual(["magic"]);
    const eof = m.Table.safeParse(hex("415243560200000001000200"));
    expect(eof.error.code).toBe("EOF");
    expect(eof.error.path).toEqual(["entries", 1, "x"]);
  });
});
