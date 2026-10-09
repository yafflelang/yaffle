/**
 * `extern type Bcd16 : u16 @size(2)`: four BCD digits, most significant first (`12 34` → 1234).
 * Fixed size, so generated code never needs `size`. A nibble above 9 is an error on read; a value
 * above 9999 is an error on write.
 */
export const Bcd16 = {
  size(): number {
    return 2;
  },
  read(bytes: Uint8Array): number {
    let v = 0;
    for (let i = 0; i < 2; i++) {
      const hi = bytes[i]! >> 4;
      const lo = bytes[i]! & 0x0f;
      if (hi > 9 || lo > 9) throw new Error(`Bcd16: invalid digit in 0x${bytes[i]!.toString(16)}`);
      v = v * 100 + hi * 10 + lo;
    }
    return v;
  },
  write(value: number): Uint8Array {
    if (!Number.isInteger(value) || value < 0 || value > 9999) {
      throw new Error(`Bcd16: ${value} out of range`);
    }
    const d = [
      Math.floor(value / 1000) % 10,
      Math.floor(value / 100) % 10,
      Math.floor(value / 10) % 10,
      value % 10
    ];
    return Uint8Array.from([(d[0]! << 4) | d[1]!, (d[2]! << 4) | d[3]!]);
  }
};
