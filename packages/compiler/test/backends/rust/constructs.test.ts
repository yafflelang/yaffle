/** Rust backend: the remaining IR constructs (hidden fields, block layers, nested switches, …). */
import { readFileSync } from "node:fs";
import { deflateRawSync, crc32 as zcrc32 } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import {
  L,
  S,
  block,
  check,
  codec,
  e,
  enumDecl,
  f,
  konst,
  len,
  lenOf,
  litv,
  program,
  sw,
  t,
  vt
} from "./ir-builder.ts";
import { build, hasRust, type Built } from "./rust-utils.ts";

const CODECS_RS = readFileSync(new URL("./codecs.rs", import.meta.url), "utf8");
const EXT = { xor: "crate::codecs::XOR", noisy: "crate::codecs::NOISY" };
const xorCodec = codec("xor", { params: [{ name: "key", type: vt.u8 }] });

const P = program(
  [
    S("Hidden", [
      f("magic", t.u32, {
        hidden: true,
        derive: e.int(0x11223344),
        checks: [check(e.eq(e.it(), e.int(0x11223344)), "magic")]
      }),
      f("n", t.u8, { hidden: true, derive: lenOf("data", vt.bytes) }),
      f("data", t.bytes(len.count(e.f("n", vt.u8))))
    ]),
    S("BlockLayers", [
      f("key", t.u8),
      block([f("a", t.u16), f("b", t.u16)], {
        layers: [L.via("xor", e.f("key", vt.u8)), L.size(e.int(4))]
      }),
      block([f("p", t.layered(t.u8, L.padAfter(1, L.fill(0xcc))))], { layers: [L.strict] }),
      block([f("c", t.u8)], { layers: [L.align(8)] }),
      f("n", t.u8),
      block([f("d", t.u8)], { layers: [L.size(e.f("n", vt.u8))] }),
      f("z", t.u8)
    ]),
    S("Nested", [
      f("a", t.u8),
      sw(
        e.f("a", vt.u8),
        [
          [
            [litv.int(1)],
            [
              f("b", t.u8),
              sw(e.f("b", vt.u8), [
                [[litv.int(1)], [f("x", t.u16)]],
                [[litv.int(2)], [f("y", t.u32)]]
              ])
            ]
          ],
          [[litv.int(2)], [f("z", t.u8)]]
        ],
        undefined,
        "a"
      ),
      f("tail", t.u8, { checks: [check(e.ne(e.f("a", vt.u8), e.int(9)), "a != 9")] })
    ]),
    S("ByEnum", [
      f("kind", t.enum("Kind")),
      sw(
        e.f("kind", vt.enum("Kind")),
        [
          [[litv.enumm("Kind", "Sys")], [f("s", t.u8)]],
          [[litv.enumm("Kind", "Gpu")], [f("v", t.u16)]]
        ],
        undefined,
        "kind"
      ),
      f("ok", t.bool, {
        checks: [
          check(
            e.lor(e.ne(e.f("kind", vt.enum("Kind")), e.enumLit("Kind", "Sys")), e.f("ok", vt.bool)),
            "sys needs ok"
          )
        ]
      })
    ]),
    S("Sig", [
      f("sig", t.bytes(len.n(4)), {
        checks: [check(e.eq(e.it(vt.bytes), e.bytes("89504e47")), 'sig == x"89504e47"')]
      }),
      f("data", t.bytes(len.count(e.sub(e.sub(e.end, e.offset), e.int(2))))),
      f("trailer", t.u16)
    ]),
    S("MinMax", [
      f("a", t.prim("i8")),
      f("b", t.prim("i8")),
      f("c", t.u8, {
        derive: e.call("max", [
          e.call("abs", [e.f("a", vt.int(8, true))]),
          e.call("abs", [e.f("b", vt.int(8, true))])
        ])
      }),
      f("d", t.prim("i8"), {
        derive: e.call("min", [e.f("a", vt.int(8, true)), e.f("b", vt.int(8, true))])
      })
    ]),
    S("Inner", [f("v", t.u32)]),
    S("Encode", [
      f("crc", t.u32, {
        derive: e.crc32(e.call("encode", [e.f("body", vt.struct("Inner"))], vt.bytes))
      }),
      f("n", t.u8, { derive: e.encodedSize("body", 1, vt.struct("Inner")) }),
      f("body", t.layered(t.s("Inner"), L.via("xor", e.int(0x5a)), L.size(e.f("n", vt.u8))))
    ]),
    S("Node", [f("v", t.u8)]),
    S("Back", [f("back", t.ptr(t.s("Node"), { storage: "i8", relative: true }))]),
    S("Ptrs2", [
      f("a", t.ptr(t.s("Node"), { storage: "u16", endian: "be" })),
      f("u", t.ptr(t.s("Back"), { storage: "u8" }))
    ]),
    S("Hdr", [
      f("ofs", t.u32, { derive: e.offsetof("blob") }),
      f("blob", t.bytes(len.n(2)), { placement: { offset: e.f("ofs") } })
    ]),
    S("Deep", [f("h", t.ptr(t.s("Hdr"), { storage: "u32" })), f("x", t.u8)]),
    S("PBytes", [
      f("n", t.u32, { derive: lenOf("data", vt.bytes) }),
      f("data", t.ptr(t.bytes(len.count(e.f("n"))), { storage: "u32" }))
    ]),
    S("RootV", [f("a", t.u16), f("b", t.str())], { layers: [L.via("noisy")] }),
    // encodedSize(p, 0) includes the struct-level @padUntil of Padded (IR layer indices count use-site layers).
    S("Padded", [f("a", t.u16)], { layers: [L.padUntil(8)] }),
    S("SizedPad", [
      f("n", t.u8, { derive: e.encodedSize("p", 0, vt.struct("Padded")) }),
      f("p", t.layered(t.s("Padded"), L.size(e.f("n", vt.u8)))),
      // offsetof of an aligned inline field points at the aligned content.
      f("ofs", t.u8, { derive: e.offsetof("data") }),
      f("sz", t.u8, { derive: e.sizeof("data") }),
      f("data", t.layered(t.bytes(len.n(2)), L.align(4)))
    ])
  ],
  [
    "SizedPad",
    "Hidden",
    "BlockLayers",
    "Nested",
    "ByEnum",
    "Sig",
    "MinMax",
    "Encode",
    "Ptrs2",
    "Deep",
    "PBytes",
    "RootV"
  ],
  {
    externs: [xorCodec, codec("noisy")],
    enums: [
      enumDecl("Kind", "u8", [
        ["Sys", 0],
        ["Gpu", 1]
      ])
    ]
  }
);

describe.skipIf(!hasRust)("rust backend: more constructs", () => {
  let b: Built;
  beforeAll(async () => {
    b = await build("yaffle_t_constructs", [{ name: "c", program: P, externs: EXT }], {
      sources: { codecs: CODECS_RS }
    });
  }, 600_000);

  const rt = async (root: string, bytes: string, json: unknown) => {
    expect(await b.value({ op: "parse", module: "c", root, bytes })).toEqual(json);
    expect(await b.value({ op: "serialize", module: "c", root, json })).toBe(bytes);
    expect(await b.value({ op: "rebuild", module: "c", root, bytes })).toBe(bytes);
  };

  it("counts struct-level layers in level 0 and excludes leading alignment from offsets", async () => {
    // n=8 | p: a=1 + pad to 8 | ofs | sz | pad to 12 | data at 12
    const bytes = "08" + "0100" + "000000000000" + "0c" + "02" + "00" + "abcd";
    await rt("SizedPad", bytes, { n: 8, p: { a: 1 }, ofs: 12, sz: 2, data: "abcd" });
  });

  it("compiles without warnings", () => {
    expect(b.warnings, b.log).toBe(0);
  });

  it("leaves hidden fields out of values but writes them", async () => {
    await rt("Hidden", "44332211" + "02" + "abcd", { data: "abcd" });
    expect(
      await b.error({ op: "parse", module: "c", root: "Hidden", bytes: "00000000" })
    ).toMatchObject({ code: "CHECK", path: ["magic"] });
  });

  it("applies codec, size, strict and align layers to blocks", async () => {
    const enc = Buffer.from([1, 0, 2, 0].map(x => x ^ 0x0f));
    const bytes = Buffer.concat([
      Buffer.from([0x0f]),
      enc,
      Buffer.from([7, 0xcc]),
      Buffer.from([0]),
      Buffer.from([9]),
      Buffer.from([2, 5, 0]),
      Buffer.from([0xee])
    ]).toString("hex");
    await rt("BlockLayers", bytes, { key: 15, a: 1, b: 2, p: 7, c: 9, n: 2, d: 5, z: 0xee });
    const badPad = bytes.slice(0, 12) + "00" + bytes.slice(14);
    expect(
      await b.error({ op: "parse", module: "c", root: "BlockLayers", bytes: badPad })
    ).toMatchObject({ code: "CHECK" });
  });

  it("nests switches", async () => {
    await rt("Nested", "01" + "01" + "3412" + "00", { a: 1, b: 1, x: 0x1234, tail: 0 });
    await rt("Nested", "01" + "02" + "78563412" + "00", { a: 1, b: 2, y: 0x12345678, tail: 0 });
    await rt("Nested", "02" + "05" + "00", { a: 2, z: 5, tail: 0 });
    expect(
      await b.error({ op: "parse", module: "c", root: "Nested", bytes: "010300" })
    ).toMatchObject({ code: "CHECK" });
  });

  it("switches on enums and compares enum literals", async () => {
    await rt("ByEnum", "00" + "05" + "01", { kind: "Sys", s: 5, ok: true });
    await rt("ByEnum", "01" + "0600" + "00", { kind: "Gpu", v: 6, ok: false });
    expect(
      await b.error({ op: "parse", module: "c", root: "ByEnum", bytes: "000500" })
    ).toMatchObject({ code: "CHECK", path: ["ok"] });
  });

  it("compares bytes literals and uses $end", async () => {
    await rt("Sig", "89504e47" + "010203" + "ffff", {
      sig: "89504e47",
      data: "010203",
      trailer: 0xffff
    });
    expect(
      await b.error({ op: "parse", module: "c", root: "Sig", bytes: "89504e48ffff" })
    ).toMatchObject({ code: "CHECK", path: ["sig"] });
  });

  it("computes min, max and abs", async () => {
    expect(
      await b.value({ op: "serialize", module: "c", root: "MinMax", json: { a: -7, b: 3 } })
    ).toBe("f9" + "03" + "07" + "f9");
  });

  it("checksums the plain encoding with encode()", async () => {
    const plain = Buffer.from([0x78, 0x56, 0x34, 0x12]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32LE(zcrc32(plain));
    const bytes = Buffer.concat([
      crc,
      Buffer.from([4]),
      Buffer.from(plain.map(x => x ^ 0x5a))
    ]).toString("hex");
    await rt("Encode", bytes, { crc: zcrc32(plain), n: 4, body: { v: 0x12345678 } });
  });

  it("handles big-endian storage and negative relative pointers to shared targets", async () => {
    // this: a(2, be) u(1) = 3 ; Node at 3 ; Back at 4: back = 3 - 4 = -1
    const bytes = "0003" + "04" + "77" + "ff";
    const json = await b.value({ op: "parse", module: "c", root: "Ptrs2", bytes });
    expect(json).toEqual({ a: { v: 0x77 }, u: { back: { $ref: "/a" } } });
    expect(await b.value({ op: "rebuild", module: "c", root: "Ptrs2", bytes })).toBe(bytes);
    expect(await b.value({ op: "serialize", module: "c", root: "Ptrs2", json })).toBe(bytes);
  });

  it("places `at` targets of pointer targets in the same base", async () => {
    // this: h(4) x(1) = 5 ; Hdr at 5 (4 bytes) ; blob at 9
    await rt("Deep", "05000000" + "aa" + "09000000" + "0102", {
      h: { ofs: 9, blob: "0102" },
      x: 0xaa
    });
  });

  it("points at byte arrays", async () => {
    await rt("PBytes", "03000000" + "08000000" + "010203", { n: 3, data: "010203" });
  });

  it("reuses the original encoding of a root-level codec", async () => {
    const plain = Buffer.concat([Buffer.from([1, 0]), Buffer.from("hello hello hello\0")]);
    const bytes = deflateRawSync(plain, { level: 9 }).toString("hex");
    const json = await b.value({ op: "parse", module: "c", root: "RootV", bytes });
    expect(json).toEqual({ a: 1, b: "hello hello hello" });
    expect(await b.value({ op: "rebuild", module: "c", root: "RootV", bytes })).toBe(bytes);
    const fresh = (await b.value({ op: "serialize", module: "c", root: "RootV", json })) as string;
    expect(fresh).not.toBe(bytes);
    expect(await b.value({ op: "parse", module: "c", root: "RootV", bytes: fresh })).toEqual(json);
  });
});

export { konst };
