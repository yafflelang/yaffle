/** Fixtures for the codec and extern tests. */
import type { IrStruct } from "yaffle/ir";
import { externsFile, type GenOptions } from "../harness.ts";
import * as ir from "../ir.ts";

/** Build options that bind the named externs to `EXTERNS_TS`. */
export function withExterns(...names: string[]): GenOptions {
  return externsFile(EXTERNS_TS, ...names);
}

/** `struct Body { u32 n = items.length  u16 items[n]  str name }`, to put under codec layers. */
export function bodyStruct(): IrStruct {
  const { S, f, derived, u16, u32, array, count, fr, len, vt, cstr } = ir;
  return S("Body", [
    derived("n", u32, len(fr("items", vt.array(vt.int(16))))),
    f("items", array(u16, count(fr("n")))),
    f("name", cstr)
  ]);
}

/** Extern implementations, written next to the generated code. */
export const EXTERNS_TS = `
import zlib from "node:zlib";
import { promisify } from "node:util";

const u8 = (b: Uint8Array): Uint8Array => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

export const counts = { zstdEncode: 0, zstdDecode: 0, asyncEncode: 0, asyncDecode: 0 };

/** zstd (Node's built-in). Checks outputSize when given. */
export const zstd = {
  decode(input: Uint8Array, ctx: { args: unknown[]; outputSize?: number }): Uint8Array {
    counts.zstdDecode++;
    const out = u8(zlib.zstdDecompressSync(input));
    if (ctx.outputSize !== undefined && out.length !== ctx.outputSize) {
      throw new Error(\`decoded \${out.length} bytes, expected \${ctx.outputSize}\`);
    }
    return out;
  },
  encode(input: Uint8Array): Uint8Array {
    counts.zstdEncode++;
    return u8(zlib.zstdCompressSync(input));
  }
};

/** raw deflate as a streaming codec: finds its own end. */
export const inflate = {
  decode(input: Uint8Array): { output: Uint8Array; consumed: number } {
    const r = zlib.inflateRawSync(input, { info: true }) as unknown as { buffer: Uint8Array; engine: { bytesWritten: number } };
    return { output: u8(r.buffer), consumed: r.engine.bytesWritten };
  },
  encode(input: Uint8Array): Uint8Array {
    return u8(zlib.deflateRawSync(input));
  }
};

/** zstd behind Promises (an async codec). */
export const azstd = {
  async decode(input: Uint8Array): Promise<Uint8Array> {
    counts.asyncDecode++;
    return u8(await promisify(zlib.zstdDecompress)(input));
  },
  async encode(input: Uint8Array): Promise<Uint8Array> {
    counts.asyncEncode++;
    return u8(await promisify(zlib.zstdCompress)(input));
  }
};

/** A position-dependent XOR "cipher" with a key argument (ranged). */
export const xor = {
  decode(input: Uint8Array, ctx: { args: unknown[]; position?: number }): Uint8Array {
    const key = Number(ctx.args[0]);
    const pos = ctx.position ?? 0;
    return input.map((b, i) => b ^ ((key + pos + i) & 0xff));
  },
  encode(input: Uint8Array, ctx: { args: unknown[]; position?: number }): Uint8Array {
    return xor.decode(input, ctx);
  }
};

/** A codec that always fails. */
export const broken = {
  decode(): Uint8Array {
    throw new Error("corrupt stream");
  },
  encode(): Uint8Array {
    throw new Error("cannot encode");
  }
};

/** LEB128 with a maximum length (extern type). */
export const VarInt = {
  size(bytes: Uint8Array, maxBytes: number): number | undefined {
    for (let i = 0; i < bytes.length && i < maxBytes; i++) if (!(bytes[i]! & 0x80)) return i + 1;
    if (bytes.length >= maxBytes) throw new Error("varint too long");
    return undefined;
  },
  read(bytes: Uint8Array): bigint {
    let v = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) v = (v << 7n) | BigInt(bytes[i]! & 0x7f);
    return v;
  },
  write(value: bigint): Uint8Array {
    const out: number[] = [];
    let v = value;
    do {
      let b = Number(v & 0x7fn);
      v >>= 7n;
      if (v) b |= 0x80;
      out.push(b);
    } while (v);
    return Uint8Array.from(out);
  }
};

/** A fixed-size extern type: a 16-bit fixed-point number. */
export const Fixed8 = {
  size(): number {
    return 2;
  },
  read(bytes: Uint8Array): number {
    return ((bytes[0]! | (bytes[1]! << 8)) << 16 >> 16) / 256;
  },
  write(v: number): Uint8Array {
    const n = Math.round(v * 256) & 0xffff;
    return Uint8Array.of(n & 0xff, n >> 8);
  }
};

/** FNV-1a over UTF-8 (extern fn). */
export function pathHash(path: string): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(path)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
`;
