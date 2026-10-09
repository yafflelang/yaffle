/**
 * `extern codec rlez @streaming`: `rle` pairs followed by a single 0x00 terminator. It finds its
 * own end, so it needs no outer `@size`: decode reports how many bytes it consumed (terminator
 * included). A missing terminator is an error.
 */
import { checkOutputSize, type StreamingCodec } from "./types.ts";
import { rleDecode, rleEncode } from "./rle.ts";

export const rlez: StreamingCodec = {
  decode(input, ctx) {
    let i = 0;
    while (i < input.length && input[i] !== 0) i += 2;
    if (i >= input.length) throw new Error("rlez: missing terminator");
    const output = checkOutputSize("rlez", rleDecode(input.subarray(0, i)), ctx);
    return { output, consumed: i + 1 };
  },
  encode(input) {
    const body = rleEncode(input);
    const out = new Uint8Array(body.length + 1);
    out.set(body);
    return out;
  }
};
