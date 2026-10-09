/**
 * `extern codec xor(u8 key) @ranged`: every byte XOR `key`. Its own inverse, and position
 * independent, so any slice decodes on its own.
 */
import { checkOutputSize, keyArg, type Codec, type CodecContext } from "./types.ts";

function apply(input: Uint8Array, ctx: CodecContext): Uint8Array {
  const key = keyArg(ctx);
  const out = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i]! ^ key;
  return out;
}

export const xor: Codec = {
  decode: (input, ctx) => checkOutputSize("xor", apply(input, ctx), ctx),
  encode: apply
};
