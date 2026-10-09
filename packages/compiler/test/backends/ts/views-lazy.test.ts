/**
 * Lazy virtual streams and ranged codecs in views: a view decodes only the pieces and codec blocks
 * a read touches. Schemas are compiled from yaffle source with the frontend; codec calls are
 * counted by the externs.
 */
import { zstdCompressSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildSource,
  dv,
  errorOf,
  externsFile,
  load,
  type BuildOptions,
  type Mod
} from "./harness.ts";

/** Counting codecs, written next to the generated code. */
const EXTERNS = `
import zlib from "node:zlib";
import { createCipheriv } from "node:crypto";

/** RFC 7539 ChaCha20 (12-byte nonce: \`nonce\` LE + 4 zero bytes), keystream from \`position\`. */
function chacha20Xor(key: Uint8Array, nonce: bigint, position: number, input: Uint8Array): Uint8Array {
  const iv = Buffer.alloc(16);
  iv.writeUInt32LE(Math.floor(position / 64) >>> 0, 0);
  iv.writeBigUInt64LE(BigInt.asUintN(64, nonce), 4);
  const c = createCipheriv("chacha20", key, iv);
  if (position % 64) c.update(new Uint8Array(position % 64));
  const out = new Uint8Array(c.update(input));
  c.final();
  return out;
}

export const stats = { zstd: 0, xorpos: 0, xorposBytes: 0, chacha: 0, chachaBytes: 0, reset() {
  stats.zstd = 0; stats.xorpos = 0; stats.xorposBytes = 0; stats.chacha = 0; stats.chachaBytes = 0;
} };
const u8 = (b: Uint8Array): Uint8Array => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

export const zstd = {
  decode(input: Uint8Array, ctx: { outputSize?: number }): Uint8Array {
    stats.zstd++;
    const out = u8(zlib.zstdDecompressSync(input));
    if (ctx.outputSize !== undefined && out.length !== ctx.outputSize) throw new Error("bad size");
    return out;
  },
  encode(input: Uint8Array): Uint8Array {
    return u8(zlib.zstdCompressSync(input));
  }
};

function xp(input: Uint8Array, ctx: { args: unknown[]; position?: number }): Uint8Array {
  stats.xorpos++;
  stats.xorposBytes += input.length;
  const key = Number(ctx.args[0]);
  const pos = ctx.position ?? 0;
  const out = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i]! ^ ((key + pos + i) & 0xff);
  return out;
}
export const xorpos = { decode: xp, encode: xp };

function cc(input: Uint8Array, ctx: { args: unknown[]; position?: number }): Uint8Array {
  stats.chacha++;
  stats.chachaBytes += input.length;
  const [key, nonce] = ctx.args as [Uint8Array, bigint];
  return chacha20Xor(key, BigInt(nonce), ctx.position ?? 0, input);
}
export const chacha20 = { decode: cc, encode: cc };
`;

interface Stats {
  zstd: number;
  xorpos: number;
  xorposBytes: number;
  chacha: number;
  chachaBytes: number;
  reset(): void;
}

/** Compiles and builds `src` with the counting codecs bound to `externs`. */
async function buildCounting(
  name: string,
  src: string,
  externs: string[],
  opts: BuildOptions & { path?: string } = {}
): Promise<[Mod, Stats]> {
  const m = await buildSource(name, src, { ...externsFile(EXTERNS, ...externs), ...opts });
  return [m, (await load<{ stats: Stats }>(m.$gen, "externs.ts")).stats];
}

// ── virtual streams ────────────────────────────────────────────────────────────

const BODY = `
export struct Body { u32 count  Item items[count] }
struct Item { u32 a  u32 b }
`;

/** The bytes of a Body of `n` items (a = i, b = i * 3). */
function bodyBytes(n: number): Uint8Array {
  const out = new Uint8Array(4 + n * 8);
  const d = dv(out);
  d.setUint32(0, n, true);
  for (let i = 0; i < n; i++) {
    d.setUint32(4 + i * 8, i, true);
    d.setUint32(8 + i * 8, i * 3, true);
  }
  return out;
}

function split(b: Uint8Array, piece: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < b.length; at += piece) out.push(b.subarray(at, at + piece));
  return out;
}

/** `u32 n, then n × (u32 exp, u32 comp, comp bytes of zstd)`; without `withExp`, no exp field. */
function framed(pieces: Uint8Array[], withExp: boolean): Uint8Array {
  const parts: Uint8Array[] = [];
  const head = new Uint8Array(4);
  dv(head).setUint32(0, pieces.length, true);
  parts.push(head);
  for (const p of pieces) {
    const z = new Uint8Array(zstdCompressSync(p));
    const h = new Uint8Array(withExp ? 8 : 4);
    const d = dv(h);
    if (withExp) {
      d.setUint32(0, p.length, true);
      d.setUint32(4, z.length, true);
    } else d.setUint32(0, z.length, true);
    parts.push(h, z);
  }
  return Buffer.concat(parts);
}

describe("views: lazy piecewise streams", () => {
  const N = 4000; // 32 KiB of items
  const PIECE = 1000;
  let known: Mod;
  let unknown: Mod;
  let stats: Stats;
  let stats2: Stats;
  let knownBytes: Uint8Array;
  let unknownBytes: Uint8Array;

  beforeAll(async () => {
    [known, stats] = await buildCounting(
      "lazy-stream-known",
      `extern codec zstd
       export struct Frags {
         u32 n
         Frag frags[n]
         Body file from frags[*].data
       }
       struct Frag { u32 exp  u32 comp  u8 data[] @size(exp) @via(zstd) @size(comp) }
       ${BODY}`,
      ["zstd"]
    );
    [unknown, stats2] = await buildCounting(
      "lazy-stream-unknown",
      `extern codec zstd
       export struct Frags2 {
         u32 n
         Frag2 frags[n]
         Body file from frags[*].data
       }
       struct Frag2 { u32 comp  u8 data[] @via(zstd) @size(comp) }
       ${BODY}`,
      ["zstd"]
    );
    const pieces = split(bodyBytes(N), PIECE);
    knownBytes = framed(pieces, true);
    unknownBytes = framed(pieces, false);
  });

  it("known piece sizes: reading one item decodes only the pieces it touches", () => {
    stats.reset();
    const v = known.Frags.view(knownBytes);
    // item 3000 is at stream offset 4 + 3000 * 8 = 24004: piece 24
    expect(v.file.items[3000].b).toBe(9000);
    // piece 0 (count, and the array's bounds check needs no decoding), then piece 24
    expect(stats.zstd).toBeLessThanOrEqual(2);
    expect(v.file.count).toBe(N);
    expect(v.file.items.length).toBe(N);
    expect(stats.zstd).toBeLessThanOrEqual(2);
  });

  it("unknown piece sizes: pieces are decoded in order up to the offset, then cached", () => {
    stats2.reset();
    const v = unknown.Frags2.view(unknownBytes);
    expect(v.file.items[10].a).toBe(10);
    expect(stats2.zstd).toBe(1); // only piece 0: the stream's end stays unknown
    expect(v.file.items[3000].a).toBe(3000);
    expect(stats2.zstd).toBe(25); // pieces 1..24 learned in order
    const before = stats2.zstd;
    expect(v.file.items[2990].b).toBe(8970);
    expect(stats2.zstd).toBe(before); // cached
  });

  it("the whole stream through the view equals parse", () => {
    const p = known.Frags.parse(knownBytes);
    const v = known.Frags.view(knownBytes);
    expect(known.Frags.toJson(v)).toEqual(known.Frags.toJson(p));
    const p2 = unknown.Frags2.parse(unknownBytes);
    const v2 = unknown.Frags2.view(unknownBytes);
    expect(unknown.Frags2.toJson(v2)).toEqual(unknown.Frags2.toJson(p2));
  });

  it("memory stays bounded: the piece cache is an LRU", () => {
    stats.reset();
    const v = known.Frags.view(knownBytes);
    let sum = 0;
    for (let i = 0; i < N; i++) sum += v.file.items[i].a;
    expect(sum).toBe((N * (N - 1)) / 2);
    expect(stats.zstd).toBe(33); // each piece once, in order
    stats.reset();
    // Piece 0 was evicted (the LRU keeps 16 pieces): reading it again decodes it once.
    void v.file.items[0].a;
    expect(stats.zstd).toBeLessThanOrEqual(1);
  });

  it("an in-place edit inside the stream commits: only that piece is re-encoded", () => {
    const v = known.Frags.view(knownBytes);
    v.file.items[3000].b = 1234;
    const out: Uint8Array = v.$commit();
    const p = known.Frags.parse(out);
    expect(p.file.items[3000].b).toBe(1234);
    expect(p.file.items[2999].b).toBe(8997);
    const orig = known.Frags.parse(knownBytes);
    expect(p.frags.length).toBe(orig.frags.length);
    // Every other fragment keeps its encoded bytes (codec reuse).
    for (let k = 0; k < orig.frags.length; k++) {
      if (k === 24) continue;
      expect(p.frags[k].comp).toBe(orig.frags[k].comp);
    }
  });

  it("$source nests a view over the joined stream", () => {
    stats.reset();
    const v = known.Frags.view(knownBytes);
    const inner = known.Body.view(v.$source("file"));
    expect(inner.items[1500].a).toBe(1500);
    expect(stats.zstd).toBeLessThanOrEqual(2);
  });

  it("a piece that fails to decode is reported at the piece, as parse does", () => {
    const bad = new Uint8Array(knownBytes);
    // corrupt piece 0's zstd frame magic (after n, exp, comp)
    bad[12]! ^= 0xff;
    const parseErr = errorOf(() => known.Frags.parse(bad));
    const viewErr = errorOf(() => known.Frags.toJson(known.Frags.view(bad)));
    expect(viewErr.code).toBe(parseErr.code);
    expect(viewErr.path).toEqual(parseErr.path);
  });
});

// ── placed arrays ──────────────────────────────────────────────────────────────

describe("views: elements at their own offsets", () => {
  it("counts `T x[] at f($index)` from the offsets and reads elements on access", async () => {
    const m = await buildSource(
      "lazy-placed",
      `export struct Blocks {
         u32 tag
         Blk blocks[] at max($index * 0x100, 0x10)
       }
       struct Blk { u32 n  u8 data[n] }`
    );
    const bytes = new Uint8Array(0x100 * 50);
    for (let k = 0; k < 50; k++) {
      const at = Math.max(k * 0x100, 0x10);
      dv(bytes).setUint32(at, 4, true);
      dv(bytes).setUint32(at + 4, k, true);
    }
    const src = {
      size: bytes.length,
      read: (o: number, n: number): Uint8Array => bytes.slice(o, o + n)
    };
    const v = m.Blocks.view(src);
    expect(v.blocks.length).toBe(50);
    expect(Array.from(v.blocks[37].data)).toEqual([37, 0, 0, 0]);
    expect(m.Blocks.toJson(v)).toEqual(m.Blocks.toJson(m.Blocks.parse(bytes)));
  });
});

describe("views: @base structs followed by inline data", () => {
  it("measure the base's whole region (targets included), as parse does", async () => {
    const m = await buildSource(
      "lazy-base-extent",
      `struct B @base { u8 off  u8 d at off }
       export struct T { B b  u8 after  B more[2]  u8 last }`
    );
    // b: off=2, d at 2 (region 0..3); after at 3; more[0] at 4 (d at 5); more[1] at 6 (d at 7)
    const bytes = Uint8Array.from([2, 0xaa, 0xbb, 0x77, 1, 0x11, 1, 0x22, 0x99]);
    const p = m.T.parse(bytes);
    expect(p.after).toBe(0x77);
    expect(p.last).toBe(0x99);
    const v = m.T.view(bytes);
    expect(v.after).toBe(0x77);
    expect(v.more[1].d).toBe(0x22);
    expect(v.last).toBe(0x99);
    expect(v.b.$size).toBe(3);
    expect(m.T.toJson(m.T.view(bytes))).toEqual(m.T.toJson(p));
  });
});

// ── ranged codecs ──────────────────────────────────────────────────────────────

describe("views: @ranged codecs decode only the touched blocks", () => {
  const N = 20000; // 160 KiB of items
  it("xorpos", async () => {
    const [m, stats] = await buildCounting(
      "lazy-ranged-xorpos",
      `extern codec xorpos(u8 key) @ranged
       export struct Enc { u32 size  Body body @via(xorpos(7)) @size(size) }
       ${BODY}`,
      ["xorpos"]
    );
    const value = {
      body: { items: Array.from({ length: N }, (_, i) => ({ a: i, b: i * 3 })) }
    };
    const bytes: Uint8Array = m.Enc.serialize(value);
    stats.reset();
    const v = m.Enc.view(bytes);
    expect(v.body.items[15000].b).toBe(45000);
    expect(stats.xorpos).toBeLessThanOrEqual(2);
    expect(stats.xorposBytes).toBeLessThanOrEqual(2 * 0x1000);
    // The whole value through the view equals parse.
    expect(m.Enc.toJson(m.Enc.view(bytes))).toEqual(m.Enc.toJson(m.Enc.parse(bytes)));
    // An in-place edit inside the region re-encodes it.
    const e = m.Enc.view(bytes);
    e.body.items[15000].a = 7;
    const out: Uint8Array = e.$commit();
    const p = m.Enc.parse(out);
    expect(p.body.items[15000].a).toBe(7);
    expect(p.body.items[14999].a).toBe(14999);
    expect(out.length).toBe(bytes.length);
  });

  it("ChaCha20 (Node crypto, test key) on synthetic data", async () => {
    const [m, stats] = await buildCounting(
      "lazy-ranged-chacha",
      `extern codec chacha20(u8 key[32], u64 nonce) @ranged
       export struct Sealed(u8 $key[32], u64 $nonce) {
         u32 size
         Body body @via(chacha20($key, $nonce)) @size(size)
       }
       ${BODY}`,
      ["chacha20"]
    );
    const key = Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 1);
    const opts = { key, nonce: 0x1234_5678_9abcn };
    const value = {
      body: { items: Array.from({ length: N }, (_, i) => ({ a: i, b: i ^ 0x5a5a })) }
    };
    const bytes: Uint8Array = m.Sealed.serialize(value, opts);
    // Really encrypted: the plaintext count does not appear.
    expect(dv(bytes).getUint32(4, true)).not.toBe(N);
    stats.reset();
    const v = m.Sealed.view(bytes, opts);
    expect(v.body.items[17777].b).toBe(17777 ^ 0x5a5a);
    expect(v.body.count).toBe(N);
    expect(stats.chacha).toBeLessThanOrEqual(3);
    expect(stats.chachaBytes).toBeLessThanOrEqual(3 * 0x1000);
    expect(m.Sealed.toJson(m.Sealed.view(bytes, opts))).toEqual(
      m.Sealed.toJson(m.Sealed.parse(bytes, opts))
    );
  });
});
