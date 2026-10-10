/** Codecs (sync, async, streaming, ranged), codec reuse, externs and streams. */
import { describe, expect, it } from "vitest";
import { build, dv, errorOf, load, toHex } from "./harness.ts";
import * as ir from "./ir.ts";
import { bodyStruct, withExterns } from "./fixtures/externs.ts";

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
  L,
  layered,
  encodedSize,
  codecDecl,
  externTypeDecl,
  externFnDecl,
  externT,
  callExtern,
  str,
  rest,
  int
} = ir;

const sampleBody = { items: Array.from({ length: 200 }, (_, i) => i % 7), name: "hello codec" };

describe("codecs", () => {
  it("@size(exp) @via(zstd) @size(comp): sizes derived, codec reused when unchanged", async () => {
    const P = program({
      structs: [
        bodyStruct(),
        S("Packed", [
          derived("expSize", u32, encodedSize("body", 0)),
          derived("compSize", u32, encodedSize("body", 2)),
          f(
            "body",
            layered(ref("Body"), L.size(fr("expSize")), L.via("zstd"), L.size(fr("compSize")))
          ),
          f("after", u8)
        ])
      ],
      externs: [codecDecl("zstd")],
      roots: ["Packed"]
    });
    const m = await build("codec-zstd", P, withExterns("zstd"));
    const x = await load(m.$gen, "externs.ts");
    const out: Uint8Array = m.Packed.serialize({ body: sampleBody, after: 0x5a });
    const expSize = dv(out).getUint32(0, true);
    const compSize = dv(out).getUint32(4, true);
    expect(expSize).toBe(4 + 400 + 12);
    expect(out.length).toBe(8 + compSize + 1);
    expect(out[out.length - 1]).toBe(0x5a);
    const v = m.Packed.parse(out);
    expect(v.body).toEqual({ n: 200, ...sampleBody });
    // unchanged content: the original encoded bytes are reused (no encode call)
    const before = x.counts.zstdEncode;
    expect(toHex(m.Packed.serialize(v))).toBe(toHex(out));
    expect(x.counts.zstdEncode).toBe(before);
    // changed content: re-encoded
    v.body.items[0] = 99;
    const changed = m.Packed.serialize(v);
    expect(x.counts.zstdEncode).toBe(before + 1);
    expect(m.Packed.parse(changed).body.items[0]).toBe(99);
    // JSON round trip: no identity, zstd is deterministic → same bytes
    const j = JSON.parse(JSON.stringify(m.Packed.toJson(m.Packed.parse(out))));
    expect(toHex(m.Packed.serialize(m.Packed.fromJson(j)))).toBe(toHex(out));
    // outputSize is passed: a wrong expSize is a CODEC error at body
    const bad = new Uint8Array(out);
    dv(bad).setUint32(0, expSize + 1, true);
    const r = m.Packed.safeParse(bad);
    expect(r.error.code).toBe("CODEC");
    expect(r.error.path).toEqual(["body"]);
  });

  it("streaming codec finds its own end", async () => {
    const P = program({
      structs: [
        bodyStruct(),
        S("Deflated", [f("body", layered(ref("Body"), L.via("inflate"))), f("after", u16)])
      ],
      externs: [codecDecl("inflate", { streaming: true })],
      roots: ["Deflated"]
    });
    const m = await build("codec-streaming", P, withExterns("inflate"));
    const out: Uint8Array = m.Deflated.serialize({ body: sampleBody, after: 0xbeef });
    const v = m.Deflated.parse(out);
    expect(v.body.name).toBe("hello codec");
    expect(v.after).toBe(0xbeef);
    expect(toHex(m.Deflated.serialize(v))).toBe(toHex(out));
  });

  it("ranged codec with arguments", async () => {
    const P = program({
      structs: [
        bodyStruct(),
        S("Enc", [
          f("key", u8),
          f("body", layered(ref("Body"), L.via("xor", fr("key", vt.int(8)))))
        ])
      ],
      externs: [codecDecl("xor", { ranged: true, params: [{ name: "key", type: vt.int(8) }] })],
      roots: ["Enc"]
    });
    const m = await build("codec-ranged", P, withExterns("xor"));
    const value = { key: 0x33, body: { items: [1, 2, 3], name: "x" } };
    const out: Uint8Array = m.Enc.serialize(value);
    expect(out[1]).toBe(3 ^ 0x33);
    expect(m.Enc.parse(out)).toEqual({ key: 0x33, body: { n: 3, ...value.body } });
  });

  it("codec failures are CODEC errors with a path", async () => {
    const P = program({
      structs: [S("B", [f("x", u8), f("data", layered(bytes(rest), L.via("broken")))])],
      externs: [codecDecl("broken")],
      roots: ["B"]
    });
    const m = await build("codec-broken", P, withExterns("broken"));
    const r = m.B.safeParse(new Uint8Array([1, 2, 3]));
    expect(r.error.code).toBe("CODEC");
    expect(r.error.path).toEqual(["data"]);
    expect(r.error.message).toMatch(/corrupt stream/);
    expect(errorOf(() => m.B.serialize({ x: 1, data: new Uint8Array(2) }))).toMatchObject({
      code: "CODEC",
      path: ["data"]
    });
  });

  it("async codecs: parseAsync/serializeAsync only", async () => {
    const P = program({
      structs: [
        bodyStruct(),
        S(
          "Async",
          [
            derived("comp", u32, encodedSize("body", 1)),
            f("body", layered(ref("Body"), L.via("azstd"), L.size(fr("comp")))),
            f("list", array(layered(u16, L.via("azstd")), count(0)))
          ],
          { async: true }
        )
      ],
      externs: [codecDecl("azstd", { async: true })],
      roots: ["Async"]
    });
    const m = await build("codec-async", P, withExterns("azstd"));
    expect(m.Async.parse).toBeUndefined();
    expect(m.Async.serialize).toBeUndefined();
    const out: Uint8Array = await m.Async.serializeAsync({ body: sampleBody, list: [] });
    const v = await m.Async.parseAsync(out);
    expect(v.body).toEqual({ n: 200, ...sampleBody });
    expect(toHex(await m.Async.serializeAsync(v))).toBe(toHex(out));
    const r = await m.Async.safeParseAsync(out.subarray(0, 10));
    expect(r.ok).toBe(false);
  });
});

describe("externs", () => {
  it("extern types (variable and fixed size) and extern functions", async () => {
    const P = program({
      structs: [
        S("X", [
          f("v", externT("VarInt", int(5, vt.int(8)))),
          f("fx", externT("Fixed8")),
          derived("hash", u32, callExtern("pathHash", [fr("path", vt.string)], vt.int(32))),
          f("path", str(count(8))),
          f("w", externT("uleb128"))
        ])
      ],
      externs: [
        externTypeDecl("VarInt", vt.int(64), [{ name: "maxBytes", type: vt.int(8) }]),
        externTypeDecl("Fixed8", vt.float(), [], 2),
        externTypeDecl("uleb128", vt.int(64)),
        externFnDecl("pathHash", [{ name: "path", type: vt.string }], vt.int(32))
      ],
      roots: ["X"]
    });
    const m = await build("externs", P, withExterns("VarInt", "Fixed8", "pathHash"));
    const value = { v: 300n, fx: -1.5, path: "a/b", w: 129n };
    const out: Uint8Array = m.X.serialize(value);
    expect(toHex(out.subarray(0, 4))).toBe("ac02" + "80fe");
    const v = m.X.parse(out);
    expect(v.v).toBe(300n);
    expect(v.fx).toBe(-1.5);
    expect(v.w).toBe(129n);
    const x = await load(m.$gen, "externs.ts");
    expect(v.hash).toBe(x.pathHash("a/b"));
    expect(m.X.toJson(v)).toMatchObject({ v: "300", fx: -1.5, w: "129" });
    // VarInt longer than maxBytes
    const bad = m.X.safeParse(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0]));
    expect(bad.error.path).toEqual(["v"]);
  });
});

describe("streams", () => {
  it("`from` a bytes field", async () => {
    const P = program({
      structs: [
        S("Inner", [f("a", u16), f("b", u16)]),
        S("Outer", [
          derived("size", u32, len(fr("raw", vt.bytes))),
          f("raw", bytes(count(fr("size"))), { input: "optional" }),
          f("inner", ref("Inner"), { from: { stream: { kind: "field", field: "raw" } } })
        ])
      ],
      roots: ["Outer"]
    });
    const m = await build("stream-field", P);
    const out: Uint8Array = m.Outer.serialize({ inner: { a: 1, b: 2 } });
    expect(toHex(out)).toBe("04000000" + "01000200");
    expect(m.Outer.parse(out)).toEqual({
      size: 4,
      raw: new Uint8Array([1, 0, 2, 0]),
      inner: { a: 1, b: 2 }
    });
  });

  it("fragmented: a struct joined from compressed fragments, split by the input's sizes", async () => {
    const P = program({
      structs: [
        bodyStruct(),
        S("Frag", [
          constant("magic", u32, 0x46524147),
          derived("exp", u32, encodedSize("data", 0), { input: "optional" }),
          derived("comp", u32, encodedSize("data", 2)),
          f("data", layered(bytes(rest), L.size(fr("exp")), L.via("zstd"), L.size(fr("comp"))))
        ]),
        S("Fragmented", [
          derived("n", u32, len(fr("frags", vt.array(vt.struct("Frag"))))),
          f("frags", array(ref("Frag"), count(fr("n")))),
          f("file", ref("Body"), {
            from: {
              stream: { kind: "each", array: "frags", field: "data" },
              split: { policy: "sizes" }
            }
          })
        ])
      ],
      externs: [codecDecl("zstd")],
      roots: ["Fragmented"]
    });
    const m = await build("stream-each", P, withExterns("zstd"));
    const x = await load(m.$gen, "externs.ts");
    // 4 + 400 + 12 = 416 bytes of plain file, split 100 / 200 / rest
    const out: Uint8Array = m.Fragmented.serialize({
      frags: [{ exp: 100 }, { exp: 200 }, { exp: 116 }],
      file: sampleBody
    });
    const v = m.Fragmented.parse(out);
    expect(v.n).toBe(3);
    expect(v.frags.map((fr: { exp: number }) => fr.exp)).toEqual([100, 200, 116]);
    expect(v.file).toEqual({ n: 200, ...sampleBody });
    // unchanged → every piece reuses its compressed bytes
    const before = x.counts.zstdEncode;
    expect(toHex(m.Fragmented.serialize(v))).toBe(toHex(out));
    expect(x.counts.zstdEncode).toBe(before);
    // change the file: only the pieces whose content changed are re-encoded
    v.file.name = "hello codex";
    const changed: Uint8Array = m.Fragmented.serialize(v);
    expect(x.counts.zstdEncode).toBe(before + 1);
    expect(m.Fragmented.parse(changed).file.name).toBe("hello codex");
  });
});
