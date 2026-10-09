/**
 * `extern codec rle`: run-length encoding as (count, byte) pairs with count 1..255.
 *
 * - decode: an odd input length or a zero count is an error; so is a decoded length that differs
 *   from `outputSize` when one is given.
 * - encode: greedy, runs of at most 255 (deterministic, so conformance cases can predict it).
 */
import { checkOutputSize, type Codec } from "./types.ts";

export function rleDecode(input: Uint8Array): Uint8Array {
  if (input.length % 2 !== 0) throw new Error(`rle: odd input length ${input.length}`);
  const out: number[] = [];
  for (let i = 0; i < input.length; i += 2) {
    const n = input[i]!;
    if (n === 0) throw new Error(`rle: zero run length at ${i}`);
    for (let k = 0; k < n; k++) out.push(input[i + 1]!);
  }
  return Uint8Array.from(out);
}

export function rleEncode(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < input.length) {
    const b = input[i]!;
    let n = 1;
    while (i + n < input.length && input[i + n] === b && n < 255) n++;
    out.push(n, b);
    i += n;
  }
  return Uint8Array.from(out);
}

export const rle: Codec = {
  decode: (input, ctx) => checkOutputSize("rle", rleDecode(input), ctx),
  encode: rleEncode
};
