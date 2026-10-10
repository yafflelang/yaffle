/**
 * Rust backend: codecs, codec reuse for byte-exact rebuilds, streams,
 * checksums and extern types.
 */
import { readFileSync } from "node:fs";
import { deflateRawSync, crc32 as zcrc32 } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { L, S, codec, e, externType, f, len, lenOf, program, t, vt } from "./ir-builder.ts";
import { build, hasRust, type Built } from "./rust-utils.ts";

const CODECS_RS = readFileSync(new URL("./codecs.rs", import.meta.url), "utf8");

const body = S("Body", [
  f("count", t.u16, { derive: lenOf("items", vt.array(vt.u16)) }),
  f("items", t.array(t.u16, len.count(e.f("count", vt.u16)))),
  f("name", t.str())
]);

const codecsP = program(
  [
    body,
    S("Xored", [
      f("key", t.u8),
      f("n", t.u8, { derive: e.encodedSize("data", 1) }),
      f(
        "data",
        t.layered(t.bytes(len.rest), L.via("xor", e.f("key", vt.u8)), L.size(e.f("n", vt.u8)))
      ),
      f("tail", t.u8)
    ]),
    S("Packed", [
      f("expSize", t.u32, { derive: e.encodedSize("body", 0, vt.struct("Body")) }),
      f("compSize", t.u32, { derive: e.encodedSize("body", 2, vt.struct("Body")) }),
      f(
        "body",
        t.layered(t.s("Body"), L.size(e.f("expSize")), L.via("inflate"), L.size(e.f("compSize")))
      ),
      f("tail", t.u8)
    ]),
    S("Streamed", [f("body", t.layered(t.s("Body"), L.via("inflateS"))), f("tail", t.u8)]),
    S("Noisy", [
      f("n", t.u32, { derive: e.encodedSize("body", 1, vt.struct("Body")) }),
      f("body", t.layered(t.s("Body"), L.via("noisy"), L.size(e.f("n"))))
    ]),
    S("Broken", [f("data", t.layered(t.bytes(len.rest), L.via("broken")))]),
    // Per-element codec with a struct-level layer: each record is xored on its own.
    S("Rec", [f("a", t.u16), f("b", t.u16)], { layers: [L.via("xor"), L.size(e.int(4))] }),
    S("Recs", [
      f("n", t.u8, { derive: lenOf("recs", vt.array(vt.struct("Rec"))) }),
      f("recs", t.array(t.s("Rec"), len.count(e.f("n", vt.u8))))
    ])
  ],
  ["Xored", "Packed", "Streamed", "Noisy", "Broken", "Recs"],
  {
    externs: [
      codec("xor", { params: [{ name: "key", type: vt.u8 }] }),
      codec("inflate"),
      codec("inflateS", { streaming: true }),
      codec("noisy"),
      codec("broken")
    ]
  }
);

const streams = program(
  [
    S("Frag", [
      f("exp", t.u16, { derive: e.encodedSize("data", 0), input: "optional" }),
      f("comp", t.u16, { derive: e.encodedSize("data", 2) }),
      f(
        "data",
        t.layered(
          t.bytes(len.rest),
          L.size(e.f("exp", vt.u16)),
          L.via("xor"),
          L.size(e.f("comp", vt.u16))
        )
      )
    ]),
    S("Inner", [
      f("count", t.u16, { derive: lenOf("items", vt.array(vt.u16)) }),
      f("items", t.array(t.u16, len.count(e.f("count", vt.u16))))
    ]),
    S("Vs", [
      f("n", t.u8, { derive: lenOf("frags", vt.array(vt.struct("Frag"))) }),
      f("frags", t.array(t.s("Frag"), len.count(e.f("n", vt.u8)))),
      f("file", t.s("Inner"), {
        from: {
          stream: { kind: "each", array: "frags", field: "data" },
          split: { policy: "sizes" }
        }
      }),
      f("tail", t.u8)
    ]),
    S("Single", [
      f("n", t.u8, { derive: e.encodedSize("raw", 1) }),
      f("raw", t.layered(t.bytes(len.rest), L.via("xor"), L.size(e.f("n", vt.u8)))),
      f("inner", t.s("Inner"), { from: { stream: { kind: "field", field: "raw" } } })
    ])
  ],
  ["Vs", "Single"],
  { externs: [codec("xor", { params: [{ name: "key", type: vt.u8 }] })] }
);

const checks = program(
  [
    S("CBody", [f("ptr", t.ptr(t.u8, { storage: "u8" })), f("data", t.bytes(len.n(3)))]),
    S("Chk", [
      f("crc", t.u32, { derive: e.crc32(e.f("body", vt.struct("CBody"))) }),
      f("size", t.u8, { derive: e.sizeof("body", vt.struct("CBody")) }),
      f("body", t.s("CBody")),
      f("crc2", t.u32, { derive: e.crc32(e.f("raw", vt.bytes)) }),
      f("raw", t.bytes(len.n(2))),
      f("ad", t.u32, { derive: e.call("adler32", [e.bytesof("body", vt.struct("CBody"))]) })
    ])
  ],
  ["Chk"]
);

const externTypes = program(
  [
    S("Ext", [
      f("n", t.ext("VarInt"), { derive: lenOf("items", vt.array(vt.u16)) }),
      f("items", t.array(t.u16, len.count(e.f("n", vt.u64)))),
      f("fx", t.ext("Fixed8", [e.int(256)])),
      f("v", t.ext("VarInt"))
    ])
  ],
  ["Ext"],
  {
    externs: [
      externType("VarInt", vt.u64),
      externType("Fixed8", vt.f64, [{ name: "scale", type: vt.u8 }], 2)
    ]
  }
);

const EXT = {
  xor: "crate::codecs::XOR",
  inflate: "crate::codecs::INFLATE",
  inflateS: "crate::codecs::INFLATE",
  noisy: "crate::codecs::NOISY",
  broken: "crate::codecs::BROKEN",
  VarInt: "crate::codecs::VARINT",
  Fixed8: "crate::codecs::FIXED"
};

function bodyBytes(items: number[], name: string): Buffer {
  const b = Buffer.alloc(2 + items.length * 2 + name.length + 1);
  b.writeUInt16LE(items.length, 0);
  items.forEach((v, i) => b.writeUInt16LE(v, 2 + 2 * i));
  b.write(name, 2 + items.length * 2, "latin1");
  return b;
}

function adler32(buf: Buffer): number {
  let a = 1;
  let b = 0;
  for (const x of buf) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const u32 = (v: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
};
const u16 = (v: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
};

describe.skipIf(!hasRust)("rust backend: codecs and streams", () => {
  let b: Built;
  beforeAll(async () => {
    b = await build(
      "yaffle_t_codecs",
      [
        { name: "cod", program: codecsP, externs: EXT },
        { name: "streams", program: streams, externs: EXT },
        { name: "checks", program: checks },
        { name: "exts", program: externTypes, externs: EXT }
      ],
      { sources: { codecs: CODECS_RS } }
    );
  }, 600_000);

  it("compiles without warnings", () => {
    expect(b.warnings, b.log).toBe(0);
  });

  it("applies a codec with arguments inside a size window", async () => {
    const plain = Buffer.from([1, 2, 3]);
    const bytes = Buffer.concat([
      Buffer.from([0x0f, 3]),
      Buffer.from(plain.map(x => x ^ 0x0f)),
      Buffer.from([0xee])
    ]).toString("hex");
    const json = await b.value({ op: "parse", module: "cod", root: "Xored", bytes });
    expect(json).toEqual({ key: 15, n: 3, data: "010203", tail: 0xee });
    expect(await b.value({ op: "serialize", module: "cod", root: "Xored", json })).toBe(bytes);
  });

  it("derives decoded and encoded sizes, and reuses the original encoding", async () => {
    const items = Array.from({ length: 400 }, (_, i) => (i * 37) % 251);
    const plain = bodyBytes(items, "repeated repeated repeated");
    const comp = deflateRawSync(plain, { level: 9 });
    const bytes = Buffer.concat([
      u32(plain.length),
      u32(comp.length),
      comp,
      Buffer.from([0x77])
    ]).toString("hex");
    const json = (await b.value({ op: "parse", module: "cod", root: "Packed", bytes })) as Record<
      string,
      unknown
    >;
    expect(json).toEqual({
      expSize: plain.length,
      compSize: comp.length,
      body: { count: 400, items, name: "repeated repeated repeated" },
      tail: 0x77
    });
    // parse → serialize in one process keeps zlib's bytes (our encoder produces different ones).
    expect(await b.value({ op: "rebuild", module: "cod", root: "Packed", bytes })).toBe(bytes);
    // Through JSON there is no cache: re-encoded with our deflate, still valid.
    const viaJson = (await b.value({
      op: "serialize",
      module: "cod",
      root: "Packed",
      json
    })) as string;
    expect(viaJson).not.toBe(bytes);
    expect(
      await b.value({ op: "parse", module: "cod", root: "Packed", bytes: viaJson })
    ).toMatchObject({ body: json["body"], tail: 0x77 });
    // Changed content is re-encoded.
    const changed = { ...json, body: { items: [9], name: "x" } };
    const out = (await b.value({
      op: "serialize",
      module: "cod",
      root: "Packed",
      json: changed
    })) as string;
    expect(await b.value({ op: "parse", module: "cod", root: "Packed", bytes: out })).toMatchObject(
      { expSize: 6, body: { count: 1, items: [9], name: "x" } }
    );
  });

  it("lets streaming codecs find their own end", async () => {
    const plain = bodyBytes([5, 6], "abc");
    const bytes = Buffer.concat([deflateRawSync(plain), Buffer.from([0x42])]).toString("hex");
    const json = await b.value({ op: "parse", module: "cod", root: "Streamed", bytes });
    expect(json).toEqual({ body: { count: 2, items: [5, 6], name: "abc" }, tail: 0x42 });
    expect(await b.value({ op: "rebuild", module: "cod", root: "Streamed", bytes })).toBe(bytes);
  });

  it("keeps unstable encoders byte-exact on rebuilds", async () => {
    const plain = bodyBytes([7, 7, 7, 7], "noisy");
    const comp = deflateRawSync(plain);
    const bytes = Buffer.concat([u32(comp.length), comp]).toString("hex");
    expect(await b.value({ op: "rebuild", module: "cod", root: "Noisy", bytes })).toBe(bytes);
    const json = await b.value({ op: "parse", module: "cod", root: "Noisy", bytes });
    const fresh = (await b.value({
      op: "serialize",
      module: "cod",
      root: "Noisy",
      json
    })) as string;
    expect(fresh).not.toBe(bytes);
    expect(
      await b.value({ op: "parse", module: "cod", root: "Noisy", bytes: fresh })
    ).toMatchObject({ body: (json as Record<string, unknown>)["body"] });
  });

  it("reports codec failures", async () => {
    expect(
      await b.error({ op: "parse", module: "cod", root: "Broken", bytes: "0102" })
    ).toMatchObject({ code: "CODEC", path: ["data"], offset: 0 });
    expect(
      await b.error({ op: "serialize", module: "cod", root: "Broken", json: { data: "01" } })
    ).toMatchObject({ code: "CODEC", path: ["data"] });
    const bad = await b.error({
      op: "parse",
      module: "cod",
      root: "Packed",
      bytes: "0500000002000000ffff00"
    });
    expect(bad).toMatchObject({ code: "CODEC", path: ["body"] });
  });

  it("applies struct-level codecs per element", async () => {
    const rec = (a: number, bb: number) =>
      Buffer.from(Buffer.concat([u16(a), u16(bb)]).map(x => x ^ 0x5a));
    const bytes = Buffer.concat([Buffer.from([2]), rec(1, 2), rec(3, 4)]).toString("hex");
    const json = await b.value({ op: "parse", module: "cod", root: "Recs", bytes });
    expect(json).toEqual({
      n: 2,
      recs: [
        { a: 1, b: 2 },
        { a: 3, b: 4 }
      ]
    });
    expect(await b.value({ op: "serialize", module: "cod", root: "Recs", json })).toBe(bytes);
    expect(await b.value({ op: "rebuild", module: "cod", root: "Recs", bytes })).toBe(bytes);
  });

  it("parses streams joined from pieces and splits them back", async () => {
    const inner = Buffer.concat([u16(3), u16(10), u16(20), u16(30)]); // 8 bytes
    const p1 = inner.subarray(0, 3);
    const p2 = inner.subarray(3);
    const frag = (p: Buffer) =>
      Buffer.concat([u16(p.length), u16(p.length), Buffer.from(p.map(x => x ^ 0x5a))]);
    const bytes = Buffer.concat([
      Buffer.from([2]),
      frag(p1),
      frag(p2),
      Buffer.from([0x99])
    ]).toString("hex");
    const json = (await b.value({ op: "parse", module: "streams", root: "Vs", bytes })) as Record<
      string,
      unknown
    >;
    expect(json).toEqual({
      n: 2,
      frags: [
        { exp: 3, comp: 3, data: p1.toString("hex") },
        { exp: 5, comp: 5, data: p2.toString("hex") }
      ],
      file: { count: 3, items: [10, 20, 30] },
      tail: 0x99
    });
    expect(await b.value({ op: "serialize", module: "streams", root: "Vs", json })).toBe(bytes);
    expect(await b.value({ op: "rebuild", module: "streams", root: "Vs", bytes })).toBe(bytes);
    // The file is the source of truth: a changed file is split by the given sizes.
    const changed = { ...json, file: { items: [11, 21, 31] } };
    const out = (await b.value({
      op: "serialize",
      module: "streams",
      root: "Vs",
      json: changed
    })) as string;
    expect(await b.value({ op: "parse", module: "streams", root: "Vs", bytes: out })).toMatchObject(
      { file: { items: [11, 21, 31] } }
    );
    // Sizes that don't add up, and missing sizes.
    const wrong = { ...json, file: { items: [1] } };
    expect(
      (await b.error({ op: "serialize", module: "streams", root: "Vs", json: wrong })).code
    ).toBe("DERIVE");
    const frags = (json["frags"] as Record<string, unknown>[]).map(
      ({ exp: _exp, ...rest }) => rest
    );
    expect(
      (await b.error({ op: "serialize", module: "streams", root: "Vs", json: { ...json, frags } }))
        .code
    ).toBe("INPUT");
  });

  it("parses a struct from a single bytes field", async () => {
    const inner = Buffer.concat([u16(1), u16(0x1234)]);
    const bytes = Buffer.concat([Buffer.from([4]), Buffer.from(inner.map(x => x ^ 0x5a))]).toString(
      "hex"
    );
    const json = await b.value({ op: "parse", module: "streams", root: "Single", bytes });
    expect(json).toEqual({
      n: 4,
      raw: inner.toString("hex"),
      inner: { count: 1, items: [0x1234] }
    });
    expect(await b.value({ op: "serialize", module: "streams", root: "Single", json })).toBe(bytes);
  });

  it("computes checksums over final bytes, after pointer fixups", async () => {
    // this: crc(4) size(1) body[ptr(1) data(3)] crc2(4) raw(2) ad(4) = 19 ; ptr target (u8) at 19
    const bodyB = Buffer.from([19, 0xaa, 0xbb, 0xcc]);
    const raw = Buffer.from([1, 2]);
    const buf = Buffer.concat([
      u32(zcrc32(bodyB)),
      Buffer.from([4]),
      bodyB,
      u32(zcrc32(raw)),
      raw,
      u32(adler32(bodyB)),
      Buffer.from([0x5e])
    ]);
    const bytes = buf.toString("hex");
    const json = await b.value({ op: "parse", module: "checks", root: "Chk", bytes });
    expect(json).toEqual({
      crc: zcrc32(bodyB),
      size: 4,
      body: { ptr: 0x5e, data: "aabbcc" },
      crc2: zcrc32(raw),
      raw: "0102",
      ad: adler32(bodyB)
    });
    expect(await b.value({ op: "serialize", module: "checks", root: "Chk", json })).toBe(bytes);
  });

  it("calls extern types", async () => {
    const items = Array.from({ length: 300 }, (_, i) => i);
    const parts = [
      Buffer.from([0xac, 0x02]),
      ...items.map(u16),
      Buffer.from([0x80, 0xff]),
      Buffer.from([0x05])
    ];
    const bytes = Buffer.concat(parts).toString("hex");
    const json = (await b.value({ op: "parse", module: "exts", root: "Ext", bytes })) as Record<
      string,
      unknown
    >;
    expect(json["n"]).toBe("300");
    expect(json["fx"]).toBe(-0.5);
    expect(json["v"]).toBe("5");
    expect(await b.value({ op: "serialize", module: "exts", root: "Ext", json })).toBe(bytes);
    const eof = await b.error({ op: "parse", module: "exts", root: "Ext", bytes: "ff" });
    expect(eof).toMatchObject({ code: "EOF", path: ["n"] });
  });
});
