/**
 * Rust backend: values, layers and expressions. Every fixture is compiled into one harness crate,
 * built once with cargo, and exercised through parse / serialize / rebuild operations.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  L,
  S,
  bits,
  block,
  check,
  e,
  enumDecl,
  externFn,
  f,
  konst,
  len,
  lenOf,
  litv,
  param,
  program,
  sw,
  t,
  vt
} from "./ir-builder.ts";
import { build, hasRust, hex, type Built } from "./rust-utils.ts";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const prims = program(
  [
    S("Prims", [
      f("a", t.prim("u8")),
      f("b", t.prim("i8")),
      f("c", t.prim("u16")),
      f("d", t.prim("i16")),
      f("e", t.prim("u24")),
      f("f", t.prim("i24")),
      f("g", t.prim("u32")),
      f("h", t.prim("i32")),
      f("i", t.prim("u40")),
      f("j", t.prim("i48")),
      f("k", t.prim("u56")),
      f("l", t.prim("u64")),
      f("m", t.prim("i64")),
      f("n", t.prim("f16")),
      f("o", t.prim("f32")),
      f("p", t.prim("f64")),
      f("q", t.prim("u32", "be")),
      f("r", t.prim("i16", "be")),
      f("s", t.prim("u24", "be")),
      f("t", t.prim("f64", "be")),
      f("u", t.bool)
    ])
  ],
  ["Prims"]
);

const endian = program(
  [
    S("Inner", [f("x", t.u16)]),
    S("Tiff", [
      f("order", t.str(len.n(2)), {
        checks: [check(e.in(e.it(vt.str), [e.str("II"), e.str("MM")]), 'order in ("II", "MM")')]
      }),
      block(
        [konst("magic", t.u16, e.int(42), vt.u16), f("firstIfd", t.u32), f("inner", t.s("Inner"))],
        {
          layers: [L.endian(e.cond(e.eq(e.f("order", vt.str), e.str("MM")), e.be, e.le, vt.endian))]
        }
      )
    ]),
    S("Plain", [f("x", t.u32), f("y", t.prim("u16", "le"))])
  ],
  ["Tiff", "Plain"]
);

const strings = program(
  [
    S("Strs", [
      f("fixed", t.str(len.n(8))),
      f("cstr", t.str()),
      f("wide", t.str(len.until(e.int(0)), "utf16", "le")),
      f("wider", t.str(len.until(e.int(0)), "utf32", "be")),
      f("lat", t.str(len.n(4), "latin1")),
      f("n", t.u8, { derive: e.encodedLength(e.f("title", vt.str), 1, "ascii") }),
      f("title", t.str(len.count(e.f("n", vt.u8)), "ascii")),
      f("w16n", t.u8, { derive: e.div(e.encodedLength(e.f("w16", vt.str), 2, "utf16"), e.int(2)) }),
      f("w16", t.str(len.count(e.f("w16n", vt.u8)), "utf16", "be")),
      f("rest", t.str(len.rest))
    ])
  ],
  ["Strs"]
);

const arrays = program(
  [
    S("Pair", [f("x", t.u8), f("y", t.u8)]),
    S("Arrs", [
      f("list", t.array(t.u16, len.until(e.int(0xffff)))),
      f("n", t.u32, { derive: lenOf("vals", vt.array(vt.u16)) }),
      f("vals", t.array(t.u16, len.count(e.f("n")))),
      f("pairs", t.array(t.s("Pair"), len.n(2))),
      f("names", t.array(t.str(), len.until(e.str("")))),
      f("raw", t.bytes(len.until(e.int(0xaa)))),
      f("tail", t.array(t.s("Pair"), len.rest))
    ]),
    // Shared counts: two arrays use the same count.
    S("Shared", [
      f("n", t.u8, { derive: lenOf("a", vt.array(vt.u8)) }),
      f("a", t.array(t.u8, len.count(e.f("n", vt.u8)))),
      f("b", t.array(t.u8, len.count(e.f("n", vt.u8))))
    ]),
    // Non-derivable length: stays an input and is checked.
    S("Bitmap", [
      f("n", t.u8),
      f("flags", t.bytes(len.count(e.div(e.add(e.f("n", vt.u8), e.int(7)), e.int(8)))))
    ])
  ],
  ["Arrs", "Shared", "Bitmap"]
);

const enums = program(
  [S("Enums", [f("kind", t.enum("Kind")), f("open", t.enum("Open")), f("big", t.enum("Big"))])],
  ["Enums"],
  {
    enums: [
      enumDecl("Kind", "u16", [
        ["Sys", 0],
        ["Gpu", 1]
      ]),
      enumDecl("Open", "u8", [["A", 1]], true),
      enumDecl("Big", "i64", [
        ["Neg", -1],
        ["Huge", "9007199254740993"]
      ])
    ]
  }
);

const bitsP = program(
  [
    S("Flags", [
      bits("u8", [
        { name: "compressed", shift: 0, width: 1, type: t.bool },
        { name: "kind", shift: 1, width: 3, type: t.enum("Kind3") },
        { name: null, shift: 4, width: 4 }
      ]),
      bits(
        "u16",
        [
          { name: "level", shift: 0, width: 4, type: t.u16 },
          { name: "delta", shift: 4, width: 12, type: t.prim("i16") }
        ],
        "be"
      )
    ])
  ],
  ["Flags"],
  {
    enums: [
      enumDecl("Kind3", "u8", [
        ["Zero", 0],
        ["One", 1],
        ["Seven", 7]
      ])
    ]
  }
);

const checks = program(
  [
    S("Checks", [
      f("version", t.u32, {
        checks: [
          check(e.in(e.it(), [e.int(1), e.int(2), [e.int(5), e.int(9)]]), "version in (1, 2, 5..9)")
        ]
      }),
      f("size", t.u32, {
        checks: [check(e.eq(e.mod(e.it(), e.int(4)), e.int(0)), "size % 4 == 0")]
      }),
      f("ver", t.str(), {
        checks: [check(e.regex(e.it(vt.str), "v\\d\\.\\d{1,2}"), "ver in /v\\d\\.\\d{1,2}/")]
      }),
      f("flag", t.bool),
      f("pad", t.u8, { checks: [check(e.eq(e.it(vt.u8), e.int(0)), "pad == 0", true)] })
    ])
  ],
  ["Checks"]
);

const cond = program(
  [
    S("Cond", [
      f("version", t.u8),
      block([f("extra", t.u32)], {
        condition: e.ge(e.f("version", vt.u8), e.int(3)),
        else: [f("legacy", t.u16)]
      }),
      block([f("opt", t.u8)], { condition: e.eq(e.f("version", vt.u8), e.int(5)) }),
      f("after", t.u8, {
        checks: [
          check(
            e.eq(
              e.it(vt.u8),
              e.cond(
                e.ge(e.f("version", vt.u8), e.int(3)),
                e.and(e.f("extra"), e.int(0xff)),
                e.int(0x77)
              )
            ),
            "after matches"
          )
        ]
      })
    ])
  ],
  ["Cond"]
);

const switches = program(
  [
    S("A", [f("a", t.u16)]),
    S("B", [f("b", t.u32), f("s", t.str())]),
    S("Tagged", [
      f("tag", t.str(len.n(4))),
      sw(
        e.f("tag", vt.str),
        [
          [[litv.str("AAAA")], [f("body", t.s("A"))]],
          [[litv.str("BBBB")], [f("body", t.s("B"))]]
        ],
        [f("body", t.bytes(len.rest))],
        "tag"
      )
    ]),
    S("Kinds", [
      f("kind", t.u8),
      sw(
        e.f("kind", vt.u8),
        [
          [[litv.int(1)], [f("a", t.u8), f("b", t.u16)]],
          [
            [litv.int(2), litv.int(3)],
            [
              f("c", t.u32),
              block([f("d", t.u8)], { condition: e.eq(e.f("kind", vt.u8), e.int(3)) })
            ]
          ],
          [[litv.int(4)], []]
        ],
        undefined,
        "kind"
      ),
      f("tail", t.u8)
    ])
  ],
  ["Tagged", "Kinds"]
);

const unions = program(
  [
    S("UA", [konst("m", t.u8, e.int(0x41), vt.u8), f("a", t.u16)]),
    S("UB", [konst("m", t.u8, e.int(0x42), vt.u8), f("b", t.u32)]),
    S("Holder", [
      f(
        "node",
        t.union([
          ["UA", t.s("UA")],
          ["UB", t.s("UB")]
        ])
      ),
      f(
        "nodes",
        t.array(
          t.union([
            ["UA", t.s("UA")],
            ["UB", t.s("UB")]
          ]),
          len.n(2)
        )
      )
    ])
  ],
  ["Holder"]
);

const transforms = program(
  [
    S("Tr", [
      f(
        "angle",
        t.transform(
          t.u16,
          e.fdiv(e.fmul(e.conv(e.it(vt.u16), vt.f64), e.float(360)), e.float(65536)),
          vt.f64,
          e.call("round", [e.fdiv(e.fmul(e.it(vt.f64), e.float(65536)), e.float(360))], vt.big)
        )
      ),
      f("names", t.array(t.str(), len.n(3))),
      f(
        "sel",
        t.transform(
          t.u8,
          e.idx(e.f("names", vt.array(vt.str)), e.it(vt.u8), vt.str),
          vt.str,
          e.call("indexOf", [e.f("names", vt.array(vt.str)), e.it(vt.str)])
        )
      ),
      f("hash", t.transform(t.u32, e.xor(e.it(), e.int(0xffff)), vt.u32)),
      f(
        "scaled",
        t.transform(t.u8, e.mul(e.it(vt.u8), e.int(2)), vt.u16, e.div(e.it(vt.u16), e.int(2)))
      )
    ])
  ],
  ["Tr"]
);

const layers = program(
  [
    S("Blob", [f("data", t.bytes(len.rest))]),
    S("Hdr", [f("tag", t.str(len.n(4))), f("count", t.u32)], { layers: [L.padUntil(0x10)] }),
    S(
      "Lay",
      [
        f("hdr", t.s("Hdr")),
        f("a", t.layered(t.u32, L.padBefore(2), L.padAfter(1, L.fill(0xcc)))),
        f("b", t.layered(t.u8, L.align(4, L.fill(0xaa)))),
        f("name", t.layered(t.str(), L.padUntil(8, L.fill(0xff)))),
        block([f("c", t.u8)], { layers: [L.padUntil(4)] }),
        f("n", t.u8),
        f("blob", t.layered(t.s("Blob"), L.size(e.f("n", vt.u8)))),
        f("m", t.u8, { derive: e.encodedSize("blob2", 0, vt.struct("Blob")) }),
        f("blob2", t.layered(t.s("Blob"), L.size(e.f("m", vt.u8)))),
        f("tail", t.layered(t.u8, L.alignEnd(4, L.fillFn("i", e.add(e.lam("i"), e.int(1))))))
      ],
      { layers: [L.alignEnd(8)] }
    ),
    S("Strict", [
      f("a", t.layered(t.u8, L.padAfter(2, L.fill(0xee)))),
      f("b", t.layered(t.bool, L.strict))
    ])
  ],
  ["Lay", "Strict"]
);

const params = program(
  [
    S("Blob", [f("data", t.bytes(len.count(e.p("n"))))], { params: [param("n", vt.u32)] }),
    S("Uses", [
      f("n", t.u8),
      f("a", t.s("Blob", e.conv(e.f("n", vt.u8), vt.u32))),
      f("b", t.s("Blob", e.int(2)))
    ]),
    S("Leaf", [block([f("extra", t.u8)], { condition: e.ge(e.p("version"), e.int(2)) })], {
      params: [param("version", vt.u32, "bound", "version")]
    }),
    S("Mid", [f("leaf", t.s("Leaf", e.p("version")))], {
      params: [param("version", vt.u32, "bound", "version")]
    }),
    S("Outer", [f("version", t.u32), f("mid", t.s("Mid", e.f("version")))]),
    S("Rooted", [f("data", t.bytes(len.count(e.p("size"))))], { params: [param("size", vt.u32)] }),
    S("Hdr2", [f("count", t.u8)]),
    S(
      "Body2",
      [
        f(
          "items",
          t.array(t.u8, len.count(e.member(e.p("hdr", vt.struct("Hdr2")), "count", vt.u8)))
        )
      ],
      {
        params: [param("hdr", vt.struct("Hdr2"))]
      }
    ),
    S("WithHdr", [f("hdr", t.s("Hdr2")), f("body", t.s("Body2", e.f("hdr", vt.struct("Hdr2"))))])
  ],
  ["Uses", "Outer", "Rooted", "WithHdr"]
);

const exprs = program(
  [
    S("Item", [
      f("idx", t.u8, { checks: [check(e.eq(e.it(vt.u8), e.index), "idx == $index")] }),
      f("w", t.u8)
    ]),
    S("Ex", [
      f("start", t.u8, { checks: [check(e.eq(e.offset, e.int(1)), "$offset == 1")] }),
      f("items", t.array(t.s("Item"), len.n(3))),
      f("total", t.u16, {
        checks: [
          check(
            e.eq(
              e.it(vt.u16),
              e.add(
                e.add(
                  e.member(
                    e.idx(e.f("items", vt.array(vt.struct("Item"))), e.int(0), vt.struct("Item")),
                    "w",
                    vt.u8
                  ),
                  e.member(
                    e.idx(e.f("items", vt.array(vt.struct("Item"))), e.int(1), vt.struct("Item")),
                    "w",
                    vt.u8
                  )
                ),
                e.member(
                  e.idx(e.f("items", vt.array(vt.struct("Item"))), e.int(2), vt.struct("Item")),
                  "w",
                  vt.u8
                )
              )
            ),
            "sum"
          )
        ]
      }),
      f("cnt", t.u8, {
        checks: [
          check(
            e.eq(
              e.it(vt.u8),
              e.len(e.map(e.f("items", vt.array(vt.struct("Item"))), "w", vt.array(vt.u8)))
            ),
            "cnt == len(items[*].w)"
          )
        ]
      }),
      f("big", t.u64),
      f("mixed", t.u32, {
        derive: e.or(
          e.shl(e.and(e.shr(e.f("big", vt.u64), e.int(32)), e.int(0xff)), e.int(8)),
          e.xor(e.mod(e.f("start", vt.u8), e.int(7)), e.bnot(e.int(-2)))
        )
      }),
      f("neg", t.i32, { derive: e.div(e.neg(e.int(7)), e.int(2)) }),
      f("rem", t.i32, { derive: e.mod(e.neg(e.int(7)), e.int(2)) }),
      f("pos", t.u8, { checks: [check(e.eq(e.offset, e.int(31)), "$offset == 31")] }),
      f("sz", t.u8, {
        checks: [
          check(
            e.eq(e.it(vt.u8), e.sizeof("items", vt.array(vt.struct("Item")))),
            "sz == sizeof(items)"
          )
        ]
      }),
      f("ofs", t.u8, {
        checks: [
          check(
            e.eq(e.it(vt.u8), e.offsetof("items", vt.array(vt.struct("Item")))),
            "ofs == offsetof(items)"
          )
        ]
      })
    ]),
    S("Div", [
      f("a", t.u8),
      f("b", t.u8),
      f("q", t.u8, { derive: e.div(e.f("a", vt.u8), e.f("b", vt.u8)) })
    ])
  ],
  ["Ex", "Div"]
);

const externs = program(
  [
    S("Hashed", [
      f("hash", t.u32, { derive: e.ext("pathHash", [e.f("path", vt.str)], vt.u32) }),
      f("path", t.str(len.n(8)))
    ])
  ],
  ["Hashed"],
  { externs: [externFn("pathHash", [{ name: "path", type: vt.str }], vt.u32)] }
);

const HASH_RS = `
/// A toy string hash: FNV-1a over UTF-8.
pub fn path_hash(path: &str) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for b in path.bytes() { h = (h ^ b as u32).wrapping_mul(0x01000193); }
    h
}
`;

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(s)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe.skipIf(!hasRust)("rust backend: values and layers", () => {
  let b: Built;
  beforeAll(async () => {
    b = await build(
      "yaffle_t_basic",
      [
        { name: "prims", program: prims },
        { name: "endian", program: endian },
        { name: "strings", program: strings },
        { name: "arrays", program: arrays },
        { name: "enums", program: enums },
        { name: "bitsp", program: bitsP },
        { name: "checks", program: checks },
        { name: "cond", program: cond },
        { name: "switches", program: switches },
        { name: "unions", program: unions },
        { name: "transforms", program: transforms },
        { name: "layers", program: layers },
        { name: "params", program: params },
        { name: "exprs", program: exprs },
        { name: "externs", program: externs, externs: { pathHash: "crate::hashing::path_hash" } }
      ],
      { sources: { hashing: HASH_RS } }
    );
  }, 600_000);

  it("compiles without warnings", () => {
    expect(b.warnings, b.log).toBe(0);
  });

  const roundtrip = async (
    module: string,
    root: string,
    bytes: string,
    json: unknown,
    args?: Record<string, unknown>
  ) => {
    const got = await b.value({ op: "parse", module, root, bytes, ...(args ? { args } : {}) });
    expect(got).toEqual(json);
    const out = await b.value({
      op: "serialize",
      module,
      root,
      json: got,
      ...(args ? { args } : {})
    });
    expect(out).toBe(bytes);
    const rebuilt = await b.value({
      op: "rebuild",
      module,
      root,
      bytes,
      ...(args ? { args } : {})
    });
    expect(rebuilt).toBe(bytes);
  };

  it("reads and writes every primitive", async () => {
    const buf = Buffer.alloc(100);
    let o = 0;
    buf.writeUInt8(0xfe, o++);
    buf.writeInt8(-2, o++);
    buf.writeUInt16LE(0xbeef, o);
    o += 2;
    buf.writeInt16LE(-300, o);
    o += 2;
    buf.writeUIntLE(0xabcdef, o, 3);
    o += 3;
    buf.writeIntLE(-5, o, 3);
    o += 3;
    buf.writeUInt32LE(0xdeadbeef, o);
    o += 4;
    buf.writeInt32LE(-123456, o);
    o += 4;
    buf.writeUIntLE(0xffffffffff, o, 5);
    o += 5;
    buf.writeIntLE(-(2 ** 40), o, 6);
    o += 6;
    buf.writeBigUInt64LE(0x00ffffffffffffffn, o); // u56: 7 bytes
    o += 7;
    buf.writeBigUInt64LE(18446744073709551615n, o);
    o += 8;
    buf.writeBigInt64LE(-9223372036854775808n, o);
    o += 8;
    buf.writeUInt16LE(0x3c00, o); // f16 1.0
    o += 2;
    buf.writeFloatLE(1.06, o);
    o += 4;
    buf.writeDoubleLE(-0.1, o);
    o += 8;
    buf.writeUInt32BE(0x01020304, o);
    o += 4;
    buf.writeInt16BE(-2, o);
    o += 2;
    buf.writeUIntBE(0x010203, o, 3);
    o += 3;
    buf.writeDoubleBE(1e300, o);
    o += 8;
    buf.writeUInt8(1, o++);
    const bytes = buf.subarray(0, o).toString("hex");
    await roundtrip("prims", "Prims", bytes, {
      a: 0xfe,
      b: -2,
      c: 0xbeef,
      d: -300,
      e: 0xabcdef,
      f: -5,
      g: 0xdeadbeef,
      h: -123456,
      i: 0xffffffffff,
      j: -(2 ** 40),
      k: "72057594037927935",
      l: "18446744073709551615",
      m: "-9223372036854775808",
      n: 1,
      o: Math.fround(1.06),
      p: -0.1,
      q: 0x01020304,
      r: -2,
      s: 0x010203,
      t: 1e300,
      u: true
    });
  });

  it("reports EOF and RANGE with paths", async () => {
    const err = await b.error({ op: "parse", module: "prims", root: "Prims", bytes: "fe" });
    expect(err.code).toBe("EOF");
    expect(err.path).toEqual(["b"]);
    expect(err.offset).toBe(1);
    const json = await b.value({
      op: "parse",
      module: "prims",
      root: "Prims",
      bytes: "00".repeat(86)
    });
    const bad = { ...(json as object), e: 0x1000000 };
    const werr = await b.error({ op: "serialize", module: "prims", root: "Prims", json: bad });
    expect(werr.code).toBe("RANGE");
    expect(werr.path).toEqual(["e"]);
    expect(werr.offset).toBe(-1);
  });

  it("encodes special floats as strings", async () => {
    const json = (await b.value({
      op: "parse",
      module: "prims",
      root: "Prims",
      bytes: "00".repeat(86)
    })) as Record<string, unknown>;
    for (const v of ["NaN", "Infinity", "-Infinity", "-0"]) {
      const out = (await b.value({
        op: "serialize",
        module: "prims",
        root: "Prims",
        json: { ...json, p: v, n: v }
      })) as string;
      const back = (await b.value({
        op: "parse",
        module: "prims",
        root: "Prims",
        bytes: out
      })) as Record<string, unknown>;
      expect(back["p"]).toBe(v);
      expect(back["n"]).toBe(v);
    }
  });

  it("switches endianness with blocks and root params", async () => {
    await roundtrip("endian", "Tiff", "4949" + "2a00" + "08000000" + "0100", {
      order: "II",
      magic: 42,
      firstIfd: 8,
      inner: { x: 1 }
    });
    await roundtrip("endian", "Tiff", "4d4d" + "002a" + "00000008" + "0001", {
      order: "MM",
      magic: 42,
      firstIfd: 8,
      inner: { x: 1 }
    });
    const err = await b.error({ op: "parse", module: "endian", root: "Tiff", bytes: "4d4d2a00" });
    expect(err).toMatchObject({ code: "CHECK", path: ["magic"], offset: 2 });
    const bad = await b.error({
      op: "parse",
      module: "endian",
      root: "Tiff",
      bytes: "585800000000000000000000"
    });
    expect(bad).toMatchObject({ code: "CHECK", path: ["order"] });
    await roundtrip(
      "endian",
      "Plain",
      "01020304" + "0100",
      { x: 0x01020304, y: 1 },
      { endian: "be" }
    );
    await roundtrip("endian", "Plain", "04030201" + "0100", { x: 0x01020304, y: 1 });
  });

  it("handles every string encoding and length rule", async () => {
    const parts = [
      Buffer.from("abc\0\0\0\0\0"),
      Buffer.from("hi\0"),
      Buffer.from("w\0é\0\0\0", "latin1"),
      Buffer.from([0, 0, 0, 0x41, 0, 1, 0xf6, 0x00, 0, 0, 0, 0]),
      Buffer.from([0xe9, 0x41, 0, 0]),
      Buffer.from([3]),
      Buffer.from("xyz"),
      Buffer.from([2]),
      Buffer.from([0, 0x41, 0xd8, 0x3d]),
      Buffer.from([0xde, 0x00]),
      Buffer.from("the rest")
    ];
    // utf16 pair: "A" + U+1F600 is 0041 D83D DE00 (BE) → but w16 counts 3 units.
    parts[7] = Buffer.from([3]);
    parts[8] = Buffer.from([0, 0x41, 0xd8, 0x3d, 0xde, 0x00]);
    parts[9] = Buffer.alloc(0);
    const bytes = Buffer.concat(parts).toString("hex");
    await roundtrip("strings", "Strs", bytes, {
      fixed: "abc",
      cstr: "hi",
      wide: "wé",
      wider: "A\u{1f600}",
      lat: "éA",
      n: 3,
      title: "xyz",
      w16n: 3,
      w16: "A😀",
      rest: "the rest"
    });
  });

  it("rejects invalid text and over-long values", async () => {
    const good = (await b.value({
      op: "parse",
      module: "strings",
      root: "Strs",
      bytes: Buffer.concat([
        Buffer.alloc(8),
        Buffer.from([0]),
        Buffer.from([0, 0]),
        Buffer.alloc(4),
        Buffer.alloc(4),
        Buffer.from([0]),
        Buffer.from([0])
      ]).toString("hex")
    })) as Record<string, unknown>;
    expect(good["fixed"]).toBe("");
    const long = await b.error({
      op: "serialize",
      module: "strings",
      root: "Strs",
      json: { ...good, fixed: "123456789" }
    });
    expect(long).toMatchObject({ code: "INPUT", path: ["fixed"] });
    const notAscii = await b.error({
      op: "serialize",
      module: "strings",
      root: "Strs",
      json: { ...good, title: "é" }
    });
    expect(notAscii).toMatchObject({ code: "INPUT", path: ["title"] });
    const badUtf8 = await b.error({
      op: "parse",
      module: "strings",
      root: "Strs",
      bytes: "ff" + "00".repeat(30)
    });
    expect(badUtf8).toMatchObject({ code: "CHECK", path: ["fixed"], offset: 0 });
    const missing = await b.error({
      op: "serialize",
      module: "strings",
      root: "Strs",
      json: { fixed: "a" }
    });
    expect(missing).toMatchObject({ code: "INPUT", path: ["cstr"] });
  });

  it("reads arrays by count, terminator and region end", async () => {
    const bytes =
      "01000200ffff" +
      "02000000" +
      "0500" +
      "0600" +
      "0102" +
      "0304" +
      "61620063640000" +
      "0102aa" +
      "0708" +
      "090a";
    await roundtrip("arrays", "Arrs", bytes, {
      list: [1, 2],
      n: 2,
      vals: [5, 6],
      pairs: [
        { x: 1, y: 2 },
        { x: 3, y: 4 }
      ],
      names: ["ab", "cd"],
      raw: "0102",
      tail: [
        { x: 7, y: 8 },
        { x: 9, y: 10 }
      ]
    });
    const term = await b.error({
      op: "serialize",
      module: "arrays",
      root: "Arrs",
      json: {
        list: [0xffff],
        vals: [],
        pairs: [
          { x: 1, y: 2 },
          { x: 3, y: 4 }
        ],
        names: [],
        raw: "",
        tail: []
      }
    });
    expect(term).toMatchObject({ code: "INPUT", path: ["list", 0] });
    const short = await b.error({
      op: "serialize",
      module: "arrays",
      root: "Arrs",
      json: { list: [], vals: [], pairs: [{ x: 1, y: 2 }], names: [], raw: "", tail: [] }
    });
    expect(short).toMatchObject({ code: "DERIVE", path: ["pairs"] });
    const eof = await b.error({ op: "parse", module: "arrays", root: "Arrs", bytes: "0100" });
    expect(eof).toMatchObject({ code: "EOF", path: ["list", 1] });
  });

  it("checks shared and non-derivable counts", async () => {
    await roundtrip("arrays", "Shared", "02010203" + "04", { n: 2, a: [1, 2], b: [3, 4] });
    const e1 = await b.error({
      op: "serialize",
      module: "arrays",
      root: "Shared",
      json: { a: [1, 2], b: [3] }
    });
    expect(e1).toMatchObject({ code: "DERIVE", path: ["b"] });
    await roundtrip("arrays", "Bitmap", "09" + "ff01", { n: 9, flags: "ff01" });
    const e2 = await b.error({
      op: "serialize",
      module: "arrays",
      root: "Bitmap",
      json: { n: 9, flags: "ff" }
    });
    expect(e2).toMatchObject({ code: "DERIVE", path: ["flags"] });
  });

  it("maps enums to member names, open enums keep unknown values", async () => {
    await roundtrip("enums", "Enums", "0100" + "01" + "ffffffffffffffff", {
      kind: "Gpu",
      open: "A",
      big: "Neg"
    });
    await roundtrip("enums", "Enums", "0000" + "07" + "0100000000002000", {
      kind: "Sys",
      open: 7,
      big: "Huge"
    });
    const bad = await b.error({
      op: "parse",
      module: "enums",
      root: "Enums",
      bytes: "0200" + "01" + "0000000000000000"
    });
    expect(bad).toMatchObject({ code: "CHECK", path: ["kind"], offset: 0 });
    const badJson = await b.error({
      op: "serialize",
      module: "enums",
      root: "Enums",
      json: { kind: "Nope", open: 1, big: "Neg" }
    });
    expect(badJson).toMatchObject({ code: "INPUT", path: ["kind"] });
  });

  it("packs bitfields", async () => {
    // compressed=1, kind=7 (bits 1..3), reserved 0 → 0x0f ; u16be: level=3, delta=-2 → (0xffe << 4) | 3 = 0xffe3
    await roundtrip("bitsp", "Flags", "0f" + "ffe3", {
      compressed: true,
      kind: "Seven",
      level: 3,
      delta: -2
    });
    const strictErr = await b.error({
      op: "parse",
      module: "bitsp",
      root: "Flags",
      bytes: "f1ffe3",
      strict: true
    });
    expect(strictErr.code).toBe("CHECK");
    const lax = await b.value({ op: "parse", module: "bitsp", root: "Flags", bytes: "f1ffe3" });
    expect(lax).toMatchObject({ compressed: true, kind: "Zero" });
    const range = await b.error({
      op: "serialize",
      module: "bitsp",
      root: "Flags",
      json: { compressed: true, kind: "One", level: 16, delta: 0 }
    });
    expect(range).toMatchObject({ code: "RANGE", path: ["level"] });
    const badKind = await b.error({ op: "parse", module: "bitsp", root: "Flags", bytes: "0a0000" });
    expect(badKind).toMatchObject({ code: "CHECK", path: ["kind"] });
  });

  it("runs in / where / regex / strict checks", async () => {
    const ok = "06000000" + "08000000" + Buffer.from("v1.23\0").toString("hex") + "01" + "05";
    await roundtrip("checks", "Checks", ok, {
      version: 6,
      size: 8,
      ver: "v1.23",
      flag: true,
      pad: 5
    });
    expect(
      await b.error({ op: "parse", module: "checks", root: "Checks", bytes: "03000000" })
    ).toMatchObject({ code: "CHECK", path: ["version"], offset: 0 });
    expect(
      await b.error({ op: "parse", module: "checks", root: "Checks", bytes: "0100000006000000" })
    ).toMatchObject({ code: "CHECK", path: ["size"], offset: 4 });
    expect(
      await b.error({
        op: "parse",
        module: "checks",
        root: "Checks",
        bytes: "0100000004000000" + Buffer.from("v1.234\0").toString("hex") + "0100"
      })
    ).toMatchObject({ code: "CHECK", path: ["ver"] });
    // bool 2 and pad 5: fine unless strict
    const lax = "01000000" + "04000000" + Buffer.from("v1.2\0").toString("hex") + "02" + "05";
    expect(
      await b.value({ op: "parse", module: "checks", root: "Checks", bytes: lax })
    ).toMatchObject({ flag: true, pad: 5 });
    expect(
      await b.error({ op: "parse", module: "checks", root: "Checks", bytes: lax, strict: true })
    ).toMatchObject({ code: "CHECK", path: ["flag"] });
    const inputErr = await b.error({
      op: "serialize",
      module: "checks",
      root: "Checks",
      json: { version: 3, size: 8, ver: "v1.2", flag: false, pad: 0 }
    });
    expect(inputErr).toMatchObject({ code: "CHECK", path: ["version"] });
  });

  it("makes conditional fields optional", async () => {
    await roundtrip("cond", "Cond", "03" + "44332211" + "44", {
      version: 3,
      extra: 0x11223344,
      after: 0x44
    });
    await roundtrip("cond", "Cond", "01" + "2211" + "77", {
      version: 1,
      legacy: 0x1122,
      after: 0x77
    });
    await roundtrip("cond", "Cond", "05" + "44332211" + "09" + "44", {
      version: 5,
      extra: 0x11223344,
      opt: 9,
      after: 0x44
    });
    const missing = await b.error({
      op: "serialize",
      module: "cond",
      root: "Cond",
      json: { version: 3, legacy: 1, after: 0x77 }
    });
    expect(missing).toMatchObject({ code: "INPUT", path: ["extra"] });
  });

  it("generates enums for switches", async () => {
    await roundtrip("switches", "Tagged", Buffer.from("AAAA").toString("hex") + "0100", {
      tag: "AAAA",
      body: { a: 1 }
    });
    await roundtrip(
      "switches",
      "Tagged",
      Buffer.from("BBBB").toString("hex") + "02000000" + "7800",
      { tag: "BBBB", body: { b: 2, s: "x" } }
    );
    await roundtrip("switches", "Tagged", Buffer.from("CCCC").toString("hex") + "0102", {
      tag: "CCCC",
      body: "0102"
    });
    await roundtrip("switches", "Kinds", "01" + "05" + "0600" + "ff", {
      kind: 1,
      a: 5,
      b: 6,
      tail: 255
    });
    await roundtrip("switches", "Kinds", "03" + "07000000" + "08" + "ff", {
      kind: 3,
      c: 7,
      d: 8,
      tail: 255
    });
    await roundtrip("switches", "Kinds", "02" + "07000000" + "ff", { kind: 2, c: 7, tail: 255 });
    await roundtrip("switches", "Kinds", "04" + "ff", { kind: 4, tail: 255 });
    expect(
      await b.error({ op: "parse", module: "switches", root: "Kinds", bytes: "09ff" })
    ).toMatchObject({ code: "CHECK", offset: 1 });
    const mismatch = await b.error({
      op: "serialize",
      module: "switches",
      root: "Kinds",
      json: { kind: 5, c: 1, tail: 0 }
    });
    expect(mismatch.code).toBe("CHECK");
  });

  it("tries union variants in order", async () => {
    await roundtrip("unions", "Holder", "41" + "0100" + "42" + "02000000" + "41" + "0300", {
      node: { type: "UA", value: { m: 0x41, a: 1 } },
      nodes: [
        { type: "UB", value: { m: 0x42, b: 2 } },
        { type: "UA", value: { m: 0x41, a: 3 } }
      ]
    });
    const err = await b.error({ op: "parse", module: "unions", root: "Holder", bytes: "43000000" });
    expect(err).toMatchObject({ code: "UNION", path: ["node"], offset: 0 });
  });

  it("applies value transforms", async () => {
    const bytes = "0040" + Buffer.from("a\0bb\0ccc\0").toString("hex") + "02" + "0000ffff" + "05";
    // `hash` is one-way: JSON keeps the raw value, so it stays lossless.
    expect(await b.value({ op: "parse", module: "transforms", root: "Tr", bytes })).toEqual({
      angle: 90,
      names: ["a", "bb", "ccc"],
      sel: "ccc",
      hash: 0xffff0000,
      scaled: 10
    });
    expect(await b.value({ op: "rebuild", module: "transforms", root: "Tr", bytes })).toBe(bytes);
    expect(
      await b.value({
        op: "serialize",
        module: "transforms",
        root: "Tr",
        json: { angle: 90, names: ["a", "bb", "ccc"], sel: "ccc", hash: 0xffff0000, scaled: 10 }
      })
    ).toBe(bytes);
    const out = await b.value({
      op: "serialize",
      module: "transforms",
      root: "Tr",
      json: { angle: 180, names: ["a", "bb", "ccc"], sel: "a", hash: 0, scaled: 4 }
    });
    expect(out).toBe(
      "0080" + Buffer.from("a\0bb\0ccc\0").toString("hex") + "00" + "00000000" + "02"
    );
    const notFound = await b.error({
      op: "serialize",
      module: "transforms",
      root: "Tr",
      json: { angle: 0, names: ["a", "bb", "ccc"], sel: "zz", hash: 0, scaled: 2 }
    });
    expect(notFound).toMatchObject({ code: "INPUT", path: ["sel"] });
    const odd = await b.error({
      op: "serialize",
      module: "transforms",
      root: "Tr",
      json: { angle: 0, names: ["a", "bb", "ccc"], sel: "a", hash: 0, scaled: 3 }
    });
    expect(odd).toMatchObject({ code: "INPUT", path: ["scaled"] });
  });

  it("pads, aligns and windows", async () => {
    const hdr = Buffer.concat([Buffer.from("HDR!"), Buffer.from([2, 0, 0, 0]), Buffer.alloc(8)]);
    const parts = [
      hdr, // 0x00..0x10
      Buffer.from([0, 0]), // padBefore(2)
      Buffer.from([1, 0, 0, 0]), // a
      Buffer.from([0xcc]), // padAfter
      Buffer.from([0xaa]), // align(4) from 0x17 → 0x18
      Buffer.from([9]), // b at 0x18
      Buffer.from("name\0"),
      Buffer.from([0xff, 0xff, 0xff]), // padUntil(8)
      Buffer.from([7, 0, 0, 0]), // c padUntil(4)
      Buffer.from([3]), // n
      Buffer.from([0xab, 0, 0]), // blob @size(3): data = ab 00 00
      Buffer.from([2]), // m (derived)
      Buffer.from([0xcd, 0xef]), // blob2
      Buffer.from([0x55]), // tail at 0x2d
      Buffer.from([1, 2, 3]) // alignEnd(4) fill i+1 → 0x30
    ];
    const body = Buffer.concat(parts);
    const bytes = Buffer.concat([body, Buffer.alloc((8 - (body.length % 8)) % 8)]).toString("hex");
    await roundtrip("layers", "Lay", bytes, {
      hdr: { tag: "HDR!", count: 2 },
      a: 1,
      b: 9,
      name: "name",
      c: 7,
      n: 3,
      blob: { data: "ab0000" },
      m: 2,
      blob2: { data: "cdef" },
      tail: 0x55
    });
    const big = await b.error({
      op: "serialize",
      module: "layers",
      root: "Lay",
      json: {
        hdr: { tag: "HDR!", count: 2 },
        a: 1,
        b: 9,
        name: "name",
        c: 7,
        n: 1,
        blob: { data: "ab00" },
        blob2: { data: "" },
        tail: 0
      }
    });
    expect(big).toMatchObject({ code: "DERIVE", path: ["blob"] });
    const longName = await b.error({
      op: "serialize",
      module: "layers",
      root: "Lay",
      json: {
        hdr: { tag: "HDR!", count: 2 },
        a: 1,
        b: 9,
        name: "too long!",
        c: 7,
        n: 0,
        blob: { data: "" },
        blob2: { data: "" },
        tail: 0
      }
    });
    expect(longName).toMatchObject({ code: "INPUT", path: ["name"] });
  });

  it("checks padding only in strict mode", async () => {
    await roundtrip("layers", "Strict", "01eeee01", { a: 1, b: true });
    expect(
      await b.value({ op: "parse", module: "layers", root: "Strict", bytes: "01000001" })
    ).toEqual({ a: 1, b: true });
    expect(
      await b.error({
        op: "parse",
        module: "layers",
        root: "Strict",
        bytes: "01000001",
        strict: true
      })
    ).toMatchObject({ code: "CHECK", offset: 1 });
    // @strict on a field turns strict mode on for it only
    expect(
      await b.error({ op: "parse", module: "layers", root: "Strict", bytes: "01eeee02" })
    ).toMatchObject({ code: "CHECK", path: ["b"] });
  });

  it("passes explicit, bound and struct parameters", async () => {
    await roundtrip("params", "Uses", "03" + "010203" + "0405", {
      n: 3,
      a: { data: "010203" },
      b: { data: "0405" }
    });
    await roundtrip("params", "Outer", "02000000" + "09", {
      version: 2,
      mid: { leaf: { extra: 9 } }
    });
    await roundtrip("params", "Outer", "01000000", { version: 1, mid: { leaf: {} } });
    await roundtrip("params", "Rooted", "aabbcc", { data: "aabbcc" }, { size: 3 });
    await roundtrip("params", "WithHdr", "02" + "0708", {
      hdr: { count: 2 },
      body: { items: [7, 8] }
    });
  });

  it("evaluates expressions exactly", async () => {
    const items = "0001" + "0102" + "0203";
    const big = Buffer.alloc(8);
    big.writeBigUInt64LE(0x0000_00ab_0000_0000n);
    // mixed = (((big >> 32) & 0xff) << 8) | ((start % 7) ^ ~(-2)) = (0xab << 8) | (0 ^ 1) = 0xab01
    const mixed = Buffer.alloc(4);
    mixed.writeUInt32LE(0xab01);
    const neg = Buffer.alloc(4);
    neg.writeInt32LE(-3);
    const rem = Buffer.alloc(4);
    rem.writeInt32LE(-1);
    const bytes =
      "00" +
      items +
      "0600" +
      "03" +
      big.toString("hex") +
      mixed.toString("hex") +
      neg.toString("hex") +
      rem.toString("hex") +
      "00" +
      "06" +
      "01";
    await roundtrip("exprs", "Ex", bytes, {
      start: 0,
      items: [
        { idx: 0, w: 1 },
        { idx: 1, w: 2 },
        { idx: 2, w: 3 }
      ],
      total: 6,
      cnt: 3,
      big: String(0x0000_00ab_0000_0000n),
      mixed: 0xab01,
      neg: -3,
      rem: -1,
      pos: 0,
      sz: 6,
      ofs: 1
    });
    const err = await b.error({ op: "parse", module: "exprs", root: "Ex", bytes: "00" + "0101" });
    expect(err).toMatchObject({ code: "CHECK", path: ["items", 0, "idx"], offset: 1 });
    const div0 = await b.error({
      op: "serialize",
      module: "exprs",
      root: "Div",
      json: { a: 1, b: 0 }
    });
    expect(div0).toMatchObject({ code: "RANGE", path: ["q"] });
    expect(
      await b.value({ op: "serialize", module: "exprs", root: "Div", json: { a: 7, b: 2 } })
    ).toBe("070203");
  });

  it("calls extern functions", async () => {
    const path = Buffer.alloc(8);
    path.write("abc");
    const h = Buffer.alloc(4);
    h.writeUInt32LE(fnv("abc"));
    const out = await b.value({
      op: "serialize",
      module: "externs",
      root: "Hashed",
      json: { path: "abc" }
    });
    expect(out).toBe(hex(Buffer.concat([h, path])));
    expect(
      await b.value({ op: "parse", module: "externs", root: "Hashed", bytes: out as string })
    ).toEqual({ hash: fnv("abc"), path: "abc" });
  });
});
