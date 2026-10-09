/**
 * `extern codec xorpos(u8 key) @ranged`: byte i of the encoded region is XORed with
 * `(key + i) & 0xff`, where i counts from the start of the whole region. A slice decodes on its
 * own only when it is given its position (`ctx.position`).
 */
import { keyArg, type Codec, type CodecContext } from "./types.ts";

function apply(input: Uint8Array, ctx: CodecContext): Uint8Array {
  const key = keyArg(ctx);
  const pos = ctx.position ?? 0;
  const out = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i]! ^ ((key + pos + i) & 0xff);
  return out;
}

export const xorpos: Codec = { decode: apply, encode: apply };
