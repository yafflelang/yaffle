/**
 * `extern type VarInt(u8 maxBytes) : u64`: unsigned LEB128, at most `maxBytes` bytes.
 *
 * - size: the index after the first byte below 0x80; `undefined` if the bytes end first (need
 *   more); an error if no terminating byte is found within `maxBytes`.
 * - write: the shortest encoding; an error if it needs more than `maxBytes` bytes.
 */
const U64_MAX = 0xffff_ffff_ffff_ffffn;

export const VarInt = {
  size(bytes: Uint8Array, maxBytes: number): number | undefined {
    for (let i = 0; i < Math.min(bytes.length, maxBytes); i++) if (bytes[i]! < 0x80) return i + 1;
    if (bytes.length < maxBytes) return undefined;
    throw new Error(`VarInt: longer than ${maxBytes} bytes`);
  },
  read(bytes: Uint8Array, maxBytes: number): bigint {
    let v = 0n;
    for (let i = 0; i < bytes.length && i < maxBytes; i++) {
      v |= BigInt(bytes[i]! & 0x7f) << BigInt(7 * i);
      if (bytes[i]! < 0x80) {
        if (v > U64_MAX) throw new Error("VarInt: value exceeds u64");
        return v;
      }
    }
    throw new Error("VarInt: unterminated");
  },
  write(value: bigint, maxBytes: number): Uint8Array {
    if (value < 0n || value > U64_MAX) throw new Error(`VarInt: ${value} is not a u64`);
    const out: number[] = [];
    let v = value;
    do {
      const b = Number(v & 0x7fn);
      v >>= 7n;
      out.push(v === 0n ? b : b | 0x80);
    } while (v !== 0n);
    if (out.length > maxBytes) {
      throw new Error(`VarInt: ${value} needs ${out.length} bytes, more than ${maxBytes}`);
    }
    return Uint8Array.from(out);
  }
};
