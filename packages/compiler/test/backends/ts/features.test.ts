/**
 * Lengths with `before` / `until <predicate>`, `@nullable(empty)`, pointer `@origin`, `this`,
 * aggregates, cycles and identity of inline elements, normalizing `= it …` formulas,
 * position-dependent lengths, `@split(fit)`, base `@alignEnd` and `inlineRuntime`.
 */
import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import type { IrExpr, IrType } from "yaffle/ir";
import { build, errorOf, hex, RUNTIME, toHex } from "./harness.ts";
import * as ir from "./ir.ts";
import { withExterns } from "./fixtures/externs.ts";

const {
  S,
  f,
  derived,
  constant,
  program,
  u8,
  u16,
  u32,
  array,
  bytes,
  count,
  ref,
  fr,
  len,
  vt,
  cstr,
  ptr,
  placed,
  offsetof,
  call,
  int,
  strLit,
  L,
  layered,
  codecDecl,
  encodedSize,
  it: itE,
  bin,
  sub
} = ir;

const thisE = (id: string): IrExpr => ({ kind: "this", type: vt.struct(id) });
const sizeofThis = (id: string): IrExpr => call("sizeof", [thisE(id)]);
const offsetofThis = (id: string): IrExpr => call("offsetof", [thisE(id)]);

describe("lengths: before and until <predicate>", () => {
  it('str pool[before ""] leaves the terminator unread; until it.next == 0 includes the last', async () => {
    const before: IrType = {
      kind: "array",
      element: cstr,
      length: { kind: "before", terminator: strLit("") }
    };
    const bank = ref("Bank");
    const banks: IrType = {
      kind: "array",
      element: bank,
      length: {
        kind: "untilPredicate",
        predicate: bin("==", ir.member(itE(vt.struct("Bank")), "next", vt.int(8)), 0)
      }
    };
    const P = program({
      structs: [
        S("Bank", [f("next", u8), f("v", u8)]),
        S("P", [f("pool", before), f("zero", u8), f("banks", banks), f("tail", u8)])
      ],
      roots: ["P"]
    });
    const m = await build("f-lengths", P);
    const bytesIn = hex("610062620000" + "0101" + "0102" + "0003" + "ff");
    const v = m.P.parse(bytesIn);
    expect(v).toEqual({
      pool: ["a", "bb"],
      zero: 0,
      banks: [
        { next: 1, v: 1 },
        { next: 1, v: 2 },
        { next: 0, v: 3 }
      ],
      tail: 0xff
    });
    expect(toHex(m.P.serialize(v))).toBe(toHex(bytesIn));
    const stopsEarly = {
      ...v,
      banks: [
        { next: 0, v: 1 },
        { next: 0, v: 2 }
      ]
    };
    expect(errorOf(() => m.P.serialize(stopsEarly)).code).toBe("CHECK");
    expect(() => m.P.serialize({ ...v, banks: [] })).toThrow(/needs an element/);
    expect(() => m.P.serialize({ ...v, pool: ["a", ""] })).toThrow(/terminator/);
  });
});

describe("pointers: @nullable(empty) and @origin", () => {
  it("an empty array pointer is 0; 0 reads as empty", async () => {
    const list = ptr(array(u16, count(fr("n", vt.int(8)))), "u8", { nullable: true }) as IrType & {
      emptyIsNull?: true;
    };
    list.emptyIsNull = true;
    const P = program({
      structs: [S("E", [derived("n", u8, len(fr("list", vt.array(vt.int(16))))), f("list", list)])],
      roots: ["E"]
    });
    const m = await build("f-emptynull", P);
    expect(toHex(m.E.serialize({ list: [] }))).toBe("0000");
    expect(m.E.parse(hex("0000"))).toEqual({ n: 0, list: [] });
    expect(toHex(m.E.serialize({ list: [7] }))).toBe("01020700");
    expect(m.E.toJson(m.E.parse(hex("0000")))).toEqual({ n: 0, list: [] });
  });

  it("@nullable(empty) on an `at` array writes offset 0", async () => {
    const P = program({
      structs: [
        S("A", [
          derived("n", u8, len(fr("data", vt.bytes))),
          derived("ofs", u8, offsetof("data")),
          f("data", bytes(count(fr("n", vt.int(8)))), {
            placement: { ...placed(fr("ofs", vt.int(8)))!, emptyIsNull: true }
          })
        ])
      ],
      roots: ["A"]
    });
    const m = await build("f-at-emptynull", P);
    expect(toHex(m.A.serialize({ data: new Uint8Array(0) }))).toBe("0000");
    expect(m.A.parse(hex("0000"))).toEqual({ n: 0, ofs: 0, data: new Uint8Array(0) });
    expect(toHex(m.A.serialize({ data: new Uint8Array([9]) }))).toBe("010209");
  });

  it("@origin(offsetof(values)): offsets count from a later table", async () => {
    const name = ptr(cstr, "u8", { ref: true }) as IrType & { origin?: IrExpr };
    name.origin = offsetof("values");
    const P = program({
      structs: [S("T", [f("name", name), f("pad", u8), f("values", array(cstr, count(2)))])],
      roots: ["T"]
    });
    const m = await build("f-origin", P);
    // values at 2: "ab\0cd\0" → "cd" is at 5, stored relative to 2 → 3
    const out = m.T.serialize({ name: "cd", pad: 0, values: ["ab", "cd"] });
    expect(toHex(out)).toBe("03" + "00" + "616200636400");
    expect(m.T.parse(out)).toEqual({ name: "cd", pad: 0, values: ["ab", "cd"] });
  });

  it("@origin on the elements of an array of pointers (earlier table)", async () => {
    const name = ptr(cstr, "u8", { ref: true }) as IrType & { origin?: IrExpr };
    name.origin = offsetof("pool");
    const P = program({
      structs: [
        S("N", [f("pre", u8), f("pool", array(cstr, count(2))), f("names", array(name, count(2)))])
      ],
      roots: ["N"]
    });
    const m = await build("f-origin-els", P);
    const out = m.N.serialize({ pre: 9, pool: ["ab", "cd"], names: ["cd", "ab"] });
    expect(toHex(out)).toBe("09" + "616200636400" + "0300");
    expect(m.N.parse(out)).toEqual({ pre: 9, pool: ["ab", "cd"], names: ["cd", "ab"] });
  });
});

describe("this, aggregates, base @alignEnd", () => {
  it("sizeof(this) of a @base struct is its whole region including @alignEnd; offsetof(this)", async () => {
    const P = program({
      structs: [
        S(
          "Region",
          [derived("size", u32, sizeofThis("Region")), f("p", ptr(bytes(count(3)), "u8"))],
          {
            base: true,
            layers: [L.alignEnd(8)]
          }
        ),
        S("El", [derived("at", u8, offsetofThis("El")), f("v", u8)]),
        S("Root", [
          f("pre", u8),
          f("r", ref("Region")),
          f("els", array(ref("El"), count(2))),
          f("post", u8)
        ])
      ],
      roots: ["Root"]
    });
    const m = await build("f-this", P);
    const out: Uint8Array = m.Root.serialize({
      pre: 1,
      r: { p: new Uint8Array([7, 8, 9]) },
      els: [{ v: 1 }, { v: 2 }],
      post: 5
    });
    // Region: size(4) p(1) target(3) = 8 → aligned 8; els at 9 and 11
    expect(toHex(out)).toBe("01" + "08000000" + "05" + "070809" + "0901" + "0b02" + "05");
    expect(m.Root.parse(out)).toEqual({
      pre: 1,
      r: { size: 8, p: new Uint8Array([7, 8, 9]) },
      els: [
        { at: 9, v: 1 },
        { at: 11, v: 2 }
      ],
      post: 5
    });
  });

  it("sum, min, max over arrays and element-wise lengths", async () => {
    const lists: IrType = {
      kind: "array",
      element: ptr(
        array(u8, count(ir.index(fr("lens", vt.array(vt.int(8))), ir.$index, vt.int(8)))),
        "u8"
      ),
      length: count(2)
    };
    const P = program({
      structs: [
        S("Agg", [
          derived(
            "lens",
            array(u8, count(2)),
            call("lengths", [fr("lists", vt.array(vt.array(vt.int(8))))], vt.array(vt.int(8)))
          ),
          f("lists", lists),
          derived("total", u16, call("sum", [fr("nums", vt.array(vt.int(8)))], vt.big)),
          derived("lo", u8, call("min", [fr("nums", vt.array(vt.int(8)))], vt.big)),
          derived("hi", u8, call("max", [fr("nums", vt.array(vt.int(8)))], vt.big)),
          f("nums", array(u8, count(3)))
        ])
      ],
      roots: ["Agg"]
    });
    const m = await build("f-agg", P);
    const out = m.Agg.serialize({ lists: [[1, 2], [3]], nums: [5, 1, 9] });
    const v = m.Agg.parse(out);
    expect(v).toEqual({
      lens: [2, 1],
      lists: [[1, 2], [3]],
      total: 15,
      lo: 1,
      hi: 9,
      nums: [5, 1, 9]
    });
  });
});

describe("identity and cycles", () => {
  it("a self-referencing list reads as one object graph and writes back", async () => {
    const P = program({
      structs: [
        S("Node", [f("v", u8), f("next", ptr(ref("Node"), "u8", { nullable: true }))]),
        S("List", [f("first", ptr(ref("Node"), "u8"))])
      ],
      roots: ["List"]
    });
    const m = await build("f-cycle", P);
    // first → node at 1 (v=7, next → 3), node at 3 (v=8, next → 1): a cycle
    const bytesIn = hex("01" + "0703" + "0801");
    const v = m.List.parse(bytesIn);
    expect(v.first.next.next).toBe(v.first);
    expect(m.List.toJson(v)).toEqual({ first: { v: 7, next: { v: 8, next: { $ref: "/first" } } } });
    expect(toHex(m.List.serialize(v))).toBe(toHex(bytesIn));
    const back = m.List.fromJson(m.List.toJson(v));
    expect(toHex(m.List.serialize(back))).toBe(toHex(bytesIn));
  });

  it("@ref pointers into an inline array give $refs to the elements", async () => {
    const P = program({
      structs: [
        S("Rec", [f("v", u8)]),
        S("R", [
          f("recs", array(ref("Rec"), count(2))),
          f("pick", ptr(ref("Rec"), "u8", { ref: true }))
        ])
      ],
      roots: ["R"]
    });
    const m = await build("f-ref-inline", P);
    const v = m.R.parse(hex("0506" + "01"));
    expect(v.pick).toBe(v.recs[1]);
    expect(m.R.toJson(v)).toEqual({ recs: [{ v: 5 }, { v: 6 }], pick: { $ref: "/recs/1" } });
    expect(toHex(m.R.serialize(m.R.fromJson(m.R.toJson(v))))).toBe("050601");
  });
});

describe("computed fields", () => {
  it("`u8 flags = it | 0x80` normalizes the input on write", async () => {
    const P = program({
      structs: [
        S("N", [
          f("flags", u8, {
            derive: bin("|", itE(vt.int(8)), 0x80),
            deriveKind: "formula",
            input: "required"
          })
        ])
      ],
      roots: ["N"]
    });
    const m = await build("f-normalize", P);
    expect(toHex(m.N.serialize({ flags: 1 }))).toBe("81");
    expect(m.N.parse(hex("01")).flags).toBe(1);
  });

  it("a length that depends on a later position is checked after layout (a gap)", async () => {
    const P = program({
      structs: [
        S("K", [
          derived("tOfs", u8, offsetof("tail")),
          f("gap", bytes(count(sub(fr("tOfs"), ir.$offset)))),
          f("tail", u8)
        ])
      ],
      roots: ["K"]
    });
    const m = await build("f-gap", P);
    expect(toHex(m.K.serialize({ gap: new Uint8Array(2), tail: 9 }))).toBe("03" + "0000" + "09");
    expect(m.K.parse(hex("03000009"))).toEqual({ tOfs: 3, gap: new Uint8Array(2), tail: 9 });
  });
});

describe("streams: @split(fit)", () => {
  it("splits the content where each fragment fits its block; sizes in the input win", async () => {
    const P = program({
      structs: [
        S("Frag", [
          derived("exp", u8, encodedSize("data", 0), { input: "optional" }),
          derived("comp", u8, encodedSize("data", 2), { input: "optional" }),
          f(
            "data",
            layered(
              bytes(ir.rest),
              L.size(fr("exp", vt.int(8))),
              L.via("zstd"),
              L.size(fr("comp", vt.int(8)))
            ),
            { input: "absent" }
          )
        ]),
        S("Mini", [
          constant("version", u8, 1),
          f("frags", array(ref("Frag"), ir.rest, call("max", [ir.mul(ir.$index, 64), int(1)]))),
          f("content", bytes(ir.rest), {
            from: {
              stream: { kind: "each", array: "frags", field: "data" },
              split: { policy: "fit" }
            },
            input: "required"
          })
        ])
      ],
      externs: [codecDecl("zstd")],
      roots: ["Mini"]
    });
    const m = await build("f-fit", P, withExterns("zstd"));
    let seed = 1;
    const content = Uint8Array.from(
      { length: 300 },
      () => ((seed = (seed * 1103515245 + 12345) % 2147483648) >> 16) & 0xff
    );
    const out: Uint8Array = m.Mini.serialize({ content });
    const v = m.Mini.parse(out);
    expect(Array.from(v.content)).toEqual(Array.from(content));
    expect(v.frags.length).toBeGreaterThan(1);
    for (const [k, fr0] of v.frags.entries()) {
      const cap = Math.max((k + 1) * 64, 1) - Math.max(k * 64, 1);
      expect(2 + fr0.comp).toBeLessThanOrEqual(cap);
    }
    // given sizes win: a byte-exact rebuild
    expect(toHex(m.Mini.serialize(v))).toBe(toHex(out));
    expect(m.Mini.parse(m.Mini.serialize({ content: new Uint8Array(0) })).frags).toEqual([]);
  });
});

describe("inlineRuntime", () => {
  it("copies the runtime next to the generated module, which imports it relatively", async () => {
    const P = program({
      structs: [
        S("Hdr", [
          derived("n", u8, len(fr("items", vt.array(vt.int(16))))),
          f("items", array(u16, count(fr("n", vt.int(8)))))
        ])
      ],
      roots: ["Hdr"]
    });
    const m = await build("f-inline", P, { inlineRuntime: true });
    const main = m.$gen.files.find(x => x.path === "main.ts")!;
    expect(main.contents).toMatch(/from "\.\/yaffle-runtime\/index\.ts"/);
    const copied = m.$gen.files.filter(x => x.path.startsWith("yaffle-runtime/"));
    const sources = readdirSync(dirname(RUNTIME)).filter(
      x => x.endsWith(".ts") && !x.endsWith(".test.ts")
    );
    expect(copied.map(x => x.path.slice("yaffle-runtime/".length)).sort()).toEqual(sources.sort());
    const out: Uint8Array = m.Hdr.serialize({ items: [1, 2] });
    expect(toHex(out)).toBe("02" + "0100" + "0200");
    expect(m.Hdr.parse(out)).toEqual({ n: 2, items: [1, 2] });
  });
});
