/** The host-side codec shapes the generated TypeScript calls (docs/IR.md §5). */
export interface CodecContext {
  /** The codec's arguments, in declaration order (u8 → number, u64 → bigint, u8[n] → Uint8Array). */
  args: unknown[];
  /** The decoded size, when an inner `@size` layer gives it. */
  outputSize?: number;
  /** For `@ranged` codecs: the slice's offset within the encoded region. */
  position?: number;
}

export interface Codec {
  decode(input: Uint8Array, ctx: CodecContext): Uint8Array;
  encode(input: Uint8Array, ctx: CodecContext): Uint8Array;
}

export interface AsyncCodec {
  decode(input: Uint8Array, ctx: CodecContext): Promise<Uint8Array>;
  encode(input: Uint8Array, ctx: CodecContext): Promise<Uint8Array>;
}

/** `@streaming`: decode gets the rest of the region and reports how much it consumed. */
export interface StreamingCodec {
  decode(input: Uint8Array, ctx: CodecContext): { output: Uint8Array; consumed: number };
  encode(input: Uint8Array, ctx: CodecContext): Uint8Array;
}

/** The codec's `u8` argument at `index`. */
export function keyArg(ctx: CodecContext, index = 0): number {
  const v = ctx.args[index];
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 255) {
    throw new Error(`codec key must be a u8, got ${String(v)}`);
  }
  return n;
}

/** Returns `out`, or fails when an inner `@size` layer gave a different decoded size. */
export function checkOutputSize(codec: string, out: Uint8Array, ctx: CodecContext): Uint8Array {
  if (ctx.outputSize !== undefined && ctx.outputSize !== out.length) {
    throw new Error(`${codec}: decoded ${out.length} bytes, expected ${ctx.outputSize}`);
  }
  return out;
}
