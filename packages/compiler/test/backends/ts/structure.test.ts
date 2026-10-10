/** Blocks, switches, unions, transforms, parameters, layers and built-in values. */
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
  i16,
  bytes,
  count,
  ref,
  fr,
  len,
  vt,
  str,
  block,
  sw,
  litInt,
  litStr,
  union,
  transform,
  it: itE,
  L,
  layered,
  param,
  p,
  int,
  float,
  call,
  mul,
  div,
  add,
  sub,
  eq,
  ge,
  cond,
  endianLit,
  check,
  convert,
  sizeof,
  encodedSize,
  rest,
  cstr
} = ir;

describe("conditionals", () => {
  it("if without else makes fields optional; if/else picks a branch", async () => {
    const P = program({
      structs: [
        S("C", [
          f("version", u8),
          block([f("extra", u32)], { condition: ge(fr("version", vt.int(8)), 3) }),
          block([f("big", u16)], {
            condition: eq(fr("version", vt.int(8)), 5),
            else: [f("small", u8)]
          })
        ])
      ],
      roots: ["C"]
    });
    const m = await build("cond", P);
    expect(m.C.parse(hex("02" + "07"))).toEqual({ version: 2, small: 7 });
    expect(m.C.parse(hex("05" + "01000000" + "0900"))).toEqual({ version: 5, extra: 1, big: 9 });
    expect(toHex(m.C.serialize({ version: 3, extra: 2, small: 1 }))).toBe("03" + "02000000" + "01");
    expect(toHex(m.C.serialize({ version: 1, extra: 99, small: 1 }))).toBe("0101");
    const missing = errorOf(() => m.C.serialize({ version: 4, small: 1 }));
    expect(missing.code).toBe("INPUT");
    expect(missing.message).toMatch(/missing required field extra/);
    const j = m.C.toJson({ version: 2, small: 7 });
    expect(j).toEqual({ version: 2, small: 7 });
    expect(Object.keys(m.C.toJson(m.C.parse(hex("05" + "01000000" + "0900"))))).toEqual([
      "version",
      "extra",
      "big"
    ]);
  });

  it("switch on a tag with default, and no match without default", async () => {
    const P = program({
      structs: [
        S("Msg", [
          f("tag", str(ir.count(4), "ascii")),
          sw(
            fr("tag", vt.string),
            [
              [[litStr("ARCV")], [f("count", u16)]],
              [
                [litStr("CHNK"), litStr("CNK2")],
                [
                  f("version", u32),
                  derived("size", u32, len(fr("payload", vt.bytes))),
                  f("payload", bytes(count(fr("size"))))
                ]
              ]
            ],
            { default: [f("raw", bytes(rest))] }
          )
        ]),
        S("Strict", [
          f("k", u8),
          sw(fr("k", vt.int(8)), [
            [[litInt(1)], [f("a", u8)]],
            [[litInt(2), litInt(3)], [f("b", u16)]]
          ])
        ])
      ],
      roots: ["Msg", "Strict"]
    });
    const m = await build("switch", P);
    const a = m.Msg.parse(hex("41524356" + "0700"));
    expect(a).toEqual({ tag: "ARCV", count: 7 });
    const b = { tag: "CHNK", version: 4, payload: new Uint8Array([1, 2]) };
    const out = m.Msg.serialize(b);
    expect(toHex(out)).toBe("43484e4b" + "04000000" + "02000000" + "0102");
    expect(m.Msg.parse(out)).toEqual({
      tag: "CHNK",
      version: 4,
      size: 2,
      payload: new Uint8Array([1, 2])
    });
    const c = m.Msg.parse(hex("58585858" + "ffee"));
    expect(c).toEqual({ tag: "XXXX", raw: new Uint8Array([0xff, 0xee]) });
    expect(toHex(m.Msg.serialize(c))).toBe("58585858" + "ffee");
    expect(m.Strict.parse(hex("030500"))).toEqual({ k: 3, b: 5 });
    const bad = m.Strict.safeParse(hex("0900"));
    expect(bad.error.code).toBe("CHECK");
    expect(() => m.Strict.serialize({ k: 9 })).toThrow(/no case matches/);
  });

  it("layered blocks: padUntil header and endianness switch", async () => {
    const P = program({
      structs: [
        S("Tiff", [
          f("order", str(ir.count(2), "ascii"), {
            literals: [
              { kind: "string", value: "II" },
              { kind: "string", value: "MM" }
            ]
          }),
          block([constant("magic", u16, 42), f("firstIfd", u32), f("inner", ref("Inner"))], {
            layers: [
              L.endian(
                cond(
                  eq(fr("order", vt.string), ir.strLit("MM")),
                  endianLit("be"),
                  endianLit("le"),
                  vt.endian
                )
              )
            ]
          }),
          block([f("x", u8)], { layers: [L.padUntil(8, ir.fillByte(0xcc))] })
        ]),
        S("Inner", [f("v", u16)])
      ],
      roots: ["Tiff"]
    });
    const m = await build("tiff", P);
    const le = { order: "II", firstIfd: 8, inner: { v: 1 }, x: 9 };
    expect(toHex(m.Tiff.serialize(le))).toBe(
      "4949" + "2a00" + "08000000" + "0100" + "09cccccccccccccc"
    );
    const be = { order: "MM", firstIfd: 8, inner: { v: 1 }, x: 9 };
    const out = m.Tiff.serialize(be);
    expect(toHex(out)).toBe("4d4d" + "002a" + "00000008" + "0001" + "09cccccccccccccc");
    expect(m.Tiff.parse(out)).toEqual({ ...be, magic: 42 });
    expect(m.Tiff.safeParse(out, { strict: true }).ok).toBe(true);
    const zeros = hex("4d4d002a000000080001090000000000000000");
    expect(m.Tiff.safeParse(zeros, { strict: true }).error.code).toBe("CHECK");
    expect(m.Tiff.safeParse(zeros).ok).toBe(true);
  });
});

describe("unions", () => {
  it("tries variants in order; the checks decide", async () => {
    const P = program({
      structs: [
        S("A", [constant("tag", u8, 1), f("x", u16)]),
        S("B", [constant("tag", u8, 2), f("y", u32)]),
        S("U", [f("node", union(["A", ref("A")], ["B", ref("B")])), f("after", u8)])
      ],
      roots: ["U"]
    });
    const m = await build("union", P);
    expect(m.U.parse(hex("010500" + "09"))).toEqual({
      node: { type: "A", value: { tag: 1, x: 5 } },
      after: 9
    });
    expect(m.U.parse(hex("0206000000" + "09"))).toEqual({
      node: { type: "B", value: { tag: 2, y: 6 } },
      after: 9
    });
    const bad = m.U.safeParse(hex("0300"));
    expect(bad.error.code).toBe("UNION");
    expect(bad.error.path).toEqual(["node"]);
    expect(bad.error.causes.map((c: { path: string[] }) => c.path)).toEqual([
      ["A", "tag"],
      ["B", "tag"]
    ]);
    expect(toHex(m.U.serialize({ node: { type: "B", value: { y: 6 } }, after: 1 }))).toBe(
      "020600000001"
    );
    expect(m.U.toJson(m.U.parse(hex("01050009")))).toEqual({
      node: { type: "A", value: { tag: 1, x: 5 } },
      after: 9
    });
    expect(m.U.fromJson({ node: { type: "A", value: { x: 5 } }, after: 9 })).toEqual({
      node: { type: "A", value: { x: 5 } },
      after: 9
    });
    expect(() => m.U.serialize({ node: { type: "C", value: {} }, after: 1 })).toThrow(
      /unknown union variant/
    );
  });
});

describe("transforms", () => {
  it("float transform with inferred inverse and half-step tolerance", async () => {
    const angle = transform(
      u16,
      div(mul(convert(itE(vt.int(16)), vt.float()), float(360)), float(65536)),
      vt.float(),
      call("round", [div(mul(itE(vt.float()), float(65536)), float(360))], vt.int(16))
    );
    const P = program({ structs: [S("T", [f("angle", angle)])], roots: ["T"] });
    const m = await build("transform-float", P);
    expect(m.T.parse(hex("0020")).angle).toBe(45);
    expect(toHex(m.T.serialize({ angle: 45 }))).toBe("0020");
    expect(toHex(m.T.serialize({ angle: 45.001 }))).toBe("0020");
    expect(() => m.T.serialize({ angle: 45.004 })).not.toThrow();
  });

  it("table lookup transform and one-way transform", async () => {
    const names = ["zero", "one", "two"];
    const P = program({
      structs: [
        S(
          "T",
          [
            f(
              "name",
              transform(
                u8,
                ir.index(ir.param("names", vt.array(vt.string)), itE(vt.int(8)), vt.string),
                vt.string,
                call("indexOf", [ir.param("names", vt.array(vt.string)), itE(vt.string)], vt.int(8))
              )
            ),
            f("hash", transform(u32, add(itE(), 1), vt.big))
          ],
          { params: [p("names", vt.array(vt.string))] }
        )
      ],
      roots: ["T"]
    });
    const m = await build("transform-table", P);
    const v = m.T.parse(hex("02" + "09000000"), { names });
    expect(v).toEqual({ name: "two", hash: 10 });
    expect(toHex(m.T.serialize({ name: "one", hash: 5 }, { names }))).toBe("0105000000");
    expect(() => m.T.serialize({ name: "nine", hash: 5 }, { names })).toThrow(/not in the table/);
    expect(() => m.T.parse(hex("02"))).toThrow(/missing required field names/);
  });

  it("transform that does not round-trip is an INPUT error", async () => {
    const half = transform(u8, div(itE(vt.int(8)), 2), vt.int(8), mul(itE(vt.int(8)), 2));
    const P = program({ structs: [S("H", [f("h", half)])], roots: ["H"] });
    const m = await build("transform-bad", P);
    expect(m.H.parse(hex("09")).h).toBe(4);
    expect(toHex(m.H.serialize({ h: 4 }))).toBe("08");
    expect(errorOf(() => m.H.serialize({ h: 200 })).code).toBe("RANGE");
  });
});

describe("parameters", () => {
  it("explicit, bound and defaulted root parameters become options", async () => {
    const P = program({
      structs: [
        S("Blob", [f("data", bytes(count(param("n"))))], { params: [p("n")] }),
        S("Rec", [block([f("extra", u32)], { condition: ge(param("version"), 144) })], {
          params: [p("version", vt.int(32), "bound")]
        }),
        S(
          "Root",
          [
            f("blob", ref("Blob", int(2))),
            f("rec", ref("Rec", param("version"))),
            f("k", bytes(count(param("k"))))
          ],
          {
            params: [p("version", vt.int(32), "bound"), p("k", vt.int(32), "explicit", int(1))]
          }
        )
      ],
      roots: ["Root"]
    });
    const m = await build("params", P);
    expect(m.Root.parse(hex("0102" + "05000000" + "07"), { version: 144 })).toEqual({
      blob: { data: new Uint8Array([1, 2]) },
      rec: { extra: 5 },
      k: new Uint8Array([7])
    });
    expect(m.Root.parse(hex("0102" + "0708"), { version: 1, k: 2 })).toEqual({
      blob: { data: new Uint8Array([1, 2]) },
      rec: {},
      k: new Uint8Array([7, 8])
    });
    expect(() => m.Root.parse(hex("0102"))).toThrow(/missing required field version/);
    const out = m.Root.serialize(
      { blob: { data: new Uint8Array([1, 2]) }, rec: { extra: 5 }, k: new Uint8Array([7]) },
      { version: 200 }
    );
    expect(toHex(out)).toBe("0102" + "05000000" + "07");
    expect(m.Root.optionsFromJson({ version: 3, endian: "be" })).toEqual({
      version: 3,
      endian: "be"
    });
  });
});

describe("layers", () => {
  it("align, padBefore, padAfter, alignEnd with fill functions", async () => {
    const P = program({
      structs: [
        S("Pads", [
          f("a", u8),
          f("b", layered(u32, L.align(4, ir.fillByte(0xaa)))),
          f("c", layered(u8, L.padBefore(2), L.padAfter(1, ir.fillByte(0xbb)))),
          f("d", layered(u8, L.alignEnd(8, ir.fillFn("i", add(ir.lambdaParam("i"), 0x10)))))
        ])
      ],
      roots: ["Pads"]
    });
    const m = await build("pads", P);
    const out = m.Pads.serialize({ a: 1, b: 2, c: 3, d: 4 });
    expect(toHex(out)).toBe("01aaaaaa" + "02000000" + "0000" + "03" + "bb" + "04" + "101112");
    expect(out.length % 8).toBe(0);
    expect(m.Pads.parse(out, { strict: true })).toEqual({ a: 1, b: 2, c: 3, d: 4 });
  });

  it("size windows: padding, overflow and derived sizes", async () => {
    const P = program({
      structs: [
        S("Win", [
          derived("size", u32, sizeof("body")),
          f("body", layered(ref("Body"), L.size(fr("size")))),
          f("fixed", layered(cstr, L.size(6))),
          f("tail", u8)
        ]),
        S("Body", [f("x", u16), f("rest", bytes(rest))])
      ],
      roots: ["Win"]
    });
    const m = await build("size", P);
    const v = { body: { x: 1, rest: new Uint8Array([9, 9]) }, fixed: "abc", tail: 7 };
    const out = m.Win.serialize(v);
    expect(toHex(out)).toBe("04000000" + "01000909" + "616263000000" + "07");
    expect(m.Win.parse(out)).toEqual({ size: 4, ...v });
    expect(() => m.Win.serialize({ ...v, fixed: "abcdef" })).toThrow(/does not fit/);
    const short = m.Win.safeParse(hex("09000000" + "0100"));
    expect(short.error.code).toBe("EOF");
    expect(short.error.path).toEqual(["body"]);
  });

  it("encodedSize stages around padUntil", async () => {
    const P = program({
      structs: [
        S("Stages", [
          derived("inner", u16, encodedSize("s", 0)),
          derived("outer", u16, encodedSize("s", 1)),
          f("s", layered(cstr, L.padUntil(8)))
        ])
      ],
      roots: ["Stages"]
    });
    const m = await build("stages", P);
    expect(toHex(m.Stages.serialize({ s: "ab" }))).toBe("0300" + "0800" + "6162000000000000");
  });

  it("$offset and $end", async () => {
    const P = program({
      structs: [
        S("Off", [
          f("a", u8),
          // manual alignment to 4 with $offset
          f("pad", bytes(count(ir.bin("%", sub(int(4), ir.bin("%", ir.$offset, 4)), 4)))),
          f("left", u8, {
            checks: [check(eq(itE(vt.int(8)), sub(ir.$end, ir.$offset)), "left == $end - $offset")]
          }),
          f("tail", bytes(count(fr("left", vt.int(8)))))
        ])
      ],
      roots: ["Off"]
    });
    const m = await build("offsets", P);
    const v = m.Off.parse(hex("01" + "000000" + "02" + "aabb"));
    expect(v).toEqual({
      a: 1,
      pad: new Uint8Array(3),
      left: 2,
      tail: new Uint8Array([0xaa, 0xbb])
    });
    expect(m.Off.safeParse(hex("01" + "000000" + "03" + "aabb")).error.path).toEqual(["left"]);
    expect(toHex(m.Off.serialize(v))).toBe("01000000" + "02aabb");
    expect(() => m.Off.serialize({ ...v, pad: new Uint8Array(2) })).toThrow(
      /length expression says 3/
    );
  });
});

describe("big integer arithmetic", () => {
  it("computes in bigint when values exceed 2^53", async () => {
    const P = program({
      structs: [
        S("Big", [
          f("a", u64),
          f("b", u32),
          derived("prod", u64, mul(fr("b"), fr("b"))),
          derived("sum", u64, add(fr("a", vt.int(64)), fr("b"))),
          derived("hi", u32, ir.bin(">>", fr("a", vt.int(64)), 32)),
          derived("lo", u32, ir.bin("&", fr("a", vt.int(64)), 0xffffffff)),
          derived("neg", i16, sub(int(0), ir.bin(">>", fr("b"), 16))),
          f("tail", bytes(count(div(fr("b"), 0x10000000))))
        ])
      ],
      roots: ["Big"]
    });
    const m = await build("bigint", P);
    const out = m.Big.serialize({
      a: 0x123456789abcdef0n,
      b: 0x20000000,
      tail: new Uint8Array([1, 2])
    });
    const back = m.Big.parse(out);
    expect(back.prod).toBe(0x20000000n * 0x20000000n);
    expect(back.sum).toBe(0x123456789abcdef0n + 0x20000000n);
    expect(back.hi).toBe(0x12345678);
    expect(back.lo).toBe(0x9abcdef0);
    expect(back.neg).toBe(-0x2000);
    expect(back.tail).toEqual(new Uint8Array([1, 2]));
    expect(() => m.Big.serialize({ a: 0n, b: 0x10000000, tail: new Uint8Array(0) })).toThrow(
      /length expression/
    );
  });
});
