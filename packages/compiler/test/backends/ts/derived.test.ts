/**
 * Values tied to other fields: virtual fields, derived arrays (lambdas, composite equality) and
 * hidden byte fields assembled from their stream slices. Each feature is tested on hand-written IR
 * and through the frontend (parse, serialize, canonical JSON, views, edits and rewrites).
 */
import { describe, expect, it, vi } from "vitest";
import type { IrExpr } from "yaffle/ir";
import { build, buildSource, errorOf, expectRoundTrip, hex, toHex } from "./harness.ts";
import * as ir from "./ir.ts";

// Each test generates and typechecks several programs.
vi.setConfig({ testTimeout: 120_000 });

const {
  S,
  f,
  derived,
  virtual,
  program,
  u8,
  u16,
  u32,
  u40,
  array,
  bytes,
  count,
  rest,
  ref,
  fr,
  len,
  vt,
  int,
  bin,
  call,
  check,
  eq,
  member,
  lambda,
  lambdaParam,
  fieldStream,
  sliceOf,
  it: itE
} = ir;

describe("virtual fields", () => {
  const P = program({
    structs: [
      S("V", [
        derived("hi", u8, bin(">>", fr("size", vt.int(40)), 32)),
        derived("lo", u32, bin("&", fr("size", vt.int(40)), int(0xffffffff))),
        virtual("size", u40, bin("|", bin("<<", fr("hi", vt.int(8)), 32), fr("lo", vt.int(32)))),
        f("after", u8)
      ]),
      S("Lossy", [
        derived("half", u8, bin("/", fr("v", vt.int(8)), 2)),
        virtual("v", u8, bin("*", fr("half", vt.int(8)), 2))
      ]),
      S("Chk", [
        derived("raw", u8, fr("v", vt.int(8))),
        virtual("v", u8, fr("raw", vt.int(8)), {
          checks: [check(bin("<", itE(vt.int(8)), 100), "v < 100")]
        })
      ])
    ],
    roots: ["V", "Lossy", "Chk"]
  });

  it("reads the value, writes its parts and round-trips through JSON", async () => {
    const m = await build("virtual", P);
    const bytes = hex("01 02000000 09");
    const v = m.V.parse(bytes);
    expect(v.size).toBe(2 ** 32 + 2);
    expect(v.after).toBe(9);
    const json = m.V.toJson(v);
    expect(json).toEqual({ hi: 1, lo: 2, size: 2 ** 32 + 2, after: 9 });
    expect(toHex(m.V.serialize(m.V.fromJson(json)))).toBe("010200000009");
    expect(toHex(m.V.serialize({ size: 0x12_3456_789a, after: 0 }))).toBe("12" + "9a785634" + "00");
    expect(errorOf(() => m.V.serialize({ after: 0 })).code).toBe("INPUT");
    expect(errorOf(() => m.V.serialize({ size: 2 ** 41, after: 0 })).code).toBe("RANGE");
    // Lossy parts: the read expression must give the value back.
    expect(toHex(m.Lossy.serialize({ v: 6 }))).toBe("03");
    expect(errorOf(() => m.Lossy.serialize({ v: 7 })).code).toBe("DERIVE");
    // Checks apply to the value on read and write.
    expect(m.Chk.parse(hex("05"))).toEqual({ raw: 5, v: 5 });
    expect(errorOf(() => m.Chk.parse(hex("70"))).code).toBe("CHECK");
    expect(errorOf(() => m.Chk.serialize({ v: 120 })).code).toBe("CHECK");
  });

  it("views read and edit virtual fields", async () => {
    const m = await build("virtual-view", P);
    const view = m.V.view(hex("01 02000000 09"));
    expect(view.size).toBe(2 ** 32 + 2);
    view.size = 7;
    expect(toHex(view.$commit())).toBe("00" + "07000000" + "09");
    // The parts are derived from the virtual value: they can't be set themselves.
    const v2 = m.V.view(hex("01 02000000 09"));
    expect(errorOf(() => (v2.hi = 2)).code).toBe("INPUT");
  });

  it("from source: derives the parts on write, edits through views", async () => {
    const m = await buildSource(
      "virtual-src",
      `export struct V {
         u8  sizeHigh
         u32 sizeLow
         virtual u40 size = (sizeHigh << 32) | sizeLow
         u8  tail
       }`
    );
    const bytes = hex("12 78563412 09");
    expect(expectRoundTrip(m.V, bytes)).toEqual({
      sizeHigh: 0x12,
      sizeLow: 0x12345678,
      size: 0x1212345678,
      tail: 9
    });
    expect(toHex(m.V.serialize({ size: 0x0102030405, tail: 1 }))).toBe("010504030201");
    expect(() => m.V.serialize({ size: 2 ** 41, tail: 1 })).toThrow();
    const v = m.V.view(bytes);
    expect(v.size).toBe(0x1212345678);
    v.size = 0x0a_aabb_ccdd;
    expect(toHex(v.$commit())).toBe("0addccbbaa09");
  });
});

describe("derived arrays and composite equality", () => {
  const arrU8 = vt.array(vt.int(8));
  const indicesOver5 = (): IrExpr =>
    call(
      "indicesWhere",
      [fr("vals", arrU8), lambda("v", bin(">", lambdaParam("v", vt.int(8)), 5))],
      arrU8
    );
  const recT = vt.struct("Rec");
  const P = program({
    structs: [
      S("D", [
        derived("n", u8, len(fr("vals", arrU8))),
        f("vals", bytes(count(fr("n", vt.int(8))))),
        derived("m", u8, len(fr("idx", vt.bytes))),
        derived("idx", bytes(count(fr("m", vt.int(8)))), indicesOver5(), {
          deriveKind: "formula",
          checks: [
            check(eq(itE(vt.bytes), indicesOver5()), "idx == indicesWhere(vals, v => v > 5)")
          ]
        }),
        derived(
          "twice",
          u16,
          call(
            "sum",
            [
              call(
                "map",
                [fr("vals", arrU8), lambda("v", bin("*", lambdaParam("v", vt.int(8)), 2))],
                arrU8
              )
            ],
            vt.int(16)
          ),
          { deriveKind: "formula" }
        ),
        derived(
          "big",
          u8,
          len(
            call(
              "filter",
              [fr("vals", arrU8), lambda("v", bin(">", lambdaParam("v", vt.int(8)), 5))],
              arrU8
            )
          ),
          { deriveKind: "formula" }
        ),
        derived(
          "uniq",
          u8,
          len(
            call("unique", [call("concat", [fr("vals", arrU8), fr("vals", arrU8)], arrU8)], arrU8)
          ),
          { deriveKind: "formula" }
        )
      ]),
      S("K", [
        f("keys", array(u16, count(3)), {
          checks: [
            check(
              eq(
                itE(vt.array(vt.int(16))),
                call(
                  "sortedBy",
                  [
                    itE(vt.array(vt.int(16))),
                    lambda("k", lambdaParam("k", vt.int(16)), vt.int(16))
                  ],
                  vt.array(vt.int(16))
                )
              ),
              "keys == sortedBy(keys, k => k)"
            )
          ]
        })
      ]),
      S("Rec", [f("id", u8), f("name", ir.str(count(2), "ascii"))]),
      S("Names", [
        f("recs", array(ref("Rec"), count(3)), {
          checks: [
            check(
              eq(
                itE(vt.array(recT)),
                call(
                  "sortedBy",
                  [
                    itE(vt.array(recT)),
                    lambda("r", member(lambdaParam("r", recT), "name", vt.string), recT)
                  ],
                  vt.array(recT)
                )
              ),
              "recs sorted by name"
            )
          ]
        }),
        derived(
          "firstIds",
          u8,
          call(
            "sum",
            [
              call(
                "map",
                [
                  fr("recs", vt.array(recT)),
                  lambda("r", member(lambdaParam("r", recT), "id", vt.int(8)), recT)
                ],
                arrU8
              )
            ],
            vt.int(8)
          ),
          { deriveKind: "formula" }
        )
      ])
    ],
    roots: ["D", "K", "Names"]
  });

  it("indicesWhere/map/filter/unique/concat in formulas and checks", async () => {
    const m = await build("derived-arrays", P);
    const out = m.D.serialize({ vals: new Uint8Array([1, 7, 3, 9, 9]) });
    // n=5, vals, m=3, idx=[1,3,4], twice=58, big=3, uniq=4
    expect(toHex(out)).toBe("05" + "0107030909" + "03" + "010304" + "3a00" + "03" + "04");
    const v = m.D.parse(out);
    expect(Array.from(v.idx)).toEqual([1, 3, 4]);
    expect(v.twice).toBe(58);
    // The check states the rule on read, in parse and in views.
    const bad = hex("05" + "0107030909" + "03" + "010305" + "3a00" + "03" + "04");
    expect(errorOf(() => m.D.parse(bad)).code).toBe("CHECK");
    const view = m.D.view(out);
    expect(Array.from(view.idx as Uint8Array)).toEqual([1, 3, 4]);
    expect(errorOf(() => m.D.view(bad).idx).code).toBe("CHECK");
  });

  it("sortedBy checks over numbers and structs (strings by code point)", async () => {
    const m = await build("sorted-by", P);
    expect(m.K.parse(hex("0100 0200 0300")).keys).toEqual([1, 2, 3]);
    expect(errorOf(() => m.K.parse(hex("0200 0100 0300"))).code).toBe("CHECK");
    expect(errorOf(() => m.K.serialize({ keys: [3, 1, 2] })).code).toBe("CHECK");
    const recs = [
      { id: 1, name: "ab" },
      { id: 2, name: "ac" },
      { id: 3, name: "b" }
    ];
    const out = m.Names.serialize({ recs });
    expect(m.Names.parse(out).firstIds).toBe(6);
    expect(errorOf(() => m.Names.serialize({ recs: [recs[1], recs[0], recs[2]] })).code).toBe(
      "CHECK"
    );
  });

  it("from source: indicesWhere over nullable pointers, and a sortedBy check", async () => {
    const m = await buildSource(
      "derived-arrays-src",
      `struct M { u8 x }
       struct R { M *model : u8 @nullable  u8 flags }
       export struct D {
         u8 s
         u8 r
         R  records[r]
         u8 index[s] = indicesWhere(records, rec => rec.model != null)
       }
       struct Key { u8 id  u8 v }
       export struct K {
         u8  n
         Key keys[n] where it == sortedBy(it, k => k.id)
       }`
    );
    const value = {
      records: [
        { model: { x: 7 }, flags: 1 },
        { model: null, flags: 2 },
        { model: { x: 9 }, flags: 3 }
      ]
    };
    const bytes: Uint8Array = m.D.serialize(value);
    const p = m.D.parse(bytes);
    expect(p.s).toBe(2);
    expect(Array.from(p.index)).toEqual([0, 2]);
    expectRoundTrip(m.D, bytes);
    const v = m.D.view(bytes);
    v.records[1].model = { x: 5 };
    const out = m.D.parse(v.$commit());
    expect(Array.from(out.index)).toEqual([0, 1, 2]);

    expectRoundTrip(m.K, hex("02 0105 0206"));
    expect(() => m.K.parse(hex("02 0206 0105"))).toThrow(/CHECK/);
    const unsorted = [
      { id: 2, v: 0 },
      { id: 1, v: 0 }
    ];
    expect(() => m.K.serialize({ keys: unsorted })).toThrow();
  });
});

describe("fields assembled from their slices", () => {
  const P = program({
    structs: [
      S("Hdr", [f("x", u16), f("y", u16)]),
      S("Ov", [
        { ...f("raw", bytes(count(8)), { hidden: true }), carrier: "slices" },
        f("hdr", ref("Hdr"), { from: { stream: sliceOf(fieldStream("raw"), 0, 4) } }),
        f("tail", bytes(rest), { from: { stream: sliceOf(fieldStream("raw"), 4, 8) } })
      ]),
      S("Two", [
        { ...f("raw", bytes(rest), { hidden: true }), carrier: "slices" },
        f("a", u32, { from: { stream: sliceOf(fieldStream("raw"), 0, 4) } }),
        f("b", u16, { from: { stream: sliceOf(fieldStream("raw"), 2, 4) } }),
        f("c", u8, { from: { stream: sliceOf(fieldStream("raw"), 6) } })
      ]),
      S("Long", [
        { ...f("raw", bytes(count(4)), { hidden: true }), carrier: "slices" },
        f("a", u32, { from: { stream: sliceOf(fieldStream("raw"), 0, 2) } })
      ])
    ],
    roots: ["Ov", "Two", "Long"]
  });

  it("assembles the sliced field from its slices", async () => {
    const m = await build("slices", P);
    const bytes0 = hex("0100 0200 0a0b0c0d");
    const v = m.Ov.parse(bytes0);
    expect(v).toEqual({ hdr: { x: 1, y: 2 }, tail: hex("0a0b0c0d") });
    expect(toHex(m.Ov.serialize(v))).toBe("010002000a0b0c0d");
    // Short slices are zero-filled to the field's length.
    expect(toHex(m.Ov.serialize({ hdr: { x: 1, y: 2 }, tail: hex("0a") }))).toBe(
      "010002000a000000"
    );
    expect(toHex(m.Ov.serialize(m.Ov.fromJson(m.Ov.toJson(v))))).toBe("010002000a0b0c0d");
    // Views read slices of a hidden field.
    const view = m.Ov.view(bytes0);
    expect(view.hdr.y).toBe(2);
    expect(toHex(view.tail as Uint8Array)).toBe("0a0b0c0d");
  });

  it("overlapping slices must agree; a rest field ends at the largest slice end", async () => {
    const m = await build("slices-two", P);
    const out = m.Two.serialize({ a: 0x11223344, b: 0x1122, c: 9 });
    expect(toHex(out)).toBe("44332211" + "0000" + "09");
    expect(m.Two.parse(out)).toEqual({ a: 0x11223344, b: 0x1122, c: 9 });
    expect(errorOf(() => m.Two.serialize({ a: 0x11223344, b: 0x9999, c: 9 })).code).toBe("DERIVE");
    expect(errorOf(() => m.Long.serialize({ a: 1 })).code).toBe("DERIVE");
  });

  it("from source: views edit through slices", async () => {
    const m = await buildSource(
      "slices-src",
      `struct Hdr { u16 a  u16 b }
       export struct Sl {
         u8  raw[8] @hidden
         Hdr h from raw[0..4]
         Hdr t from raw[4..8]
         u8  tail
       }`
    );
    const bytes = hex("01000200 03000400 05");
    expect(expectRoundTrip(m.Sl, bytes)).toEqual({
      h: { a: 1, b: 2 },
      t: { a: 3, b: 4 },
      tail: 5
    });
    expect(toHex(m.Sl.serialize({ h: { a: 9, b: 8 }, t: { a: 7, b: 6 }, tail: 0 }))).toBe(
      "090008000700060000"
    );
    const v = m.Sl.view(bytes);
    v.t.b = 0x44;
    expect(toHex(v.$commit())).toBe("010002000300440005");
  });
});
