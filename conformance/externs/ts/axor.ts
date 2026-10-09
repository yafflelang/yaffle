/** `extern async codec axor(u8 key)`: the same transform as `xor`, but the host returns Promises. */
import type { AsyncCodec } from "./types.ts";
import { xor } from "./xor.ts";

export const axor: AsyncCodec = {
  async decode(input, ctx) {
    await Promise.resolve();
    return xor.decode(input, ctx);
  },
  async encode(input, ctx) {
    await Promise.resolve();
    return xor.encode(input, ctx);
  }
};
