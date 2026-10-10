package org.yafflelang.conformance.externs;

import org.yafflelang.runtime.ExternType;

/**
 * {@code extern type Bcd16 : u16 @size(2)}: four BCD digits, most significant first ({@code 12 34}
 * → 1234). Fixed size, so generated code never calls {@code size}. A nibble above 9 is an error
 * on read; a value above 9999 is an error on write.
 */
public final class Bcd16 implements ExternType<Integer> {
  public static final Bcd16 BCD16 = new Bcd16();

  private Bcd16() {}

  @Override
  public int size(byte[] bytes, Object... args) {
    return 2;
  }

  @Override
  public Integer read(byte[] bytes, Object... args) {
    int v = 0;
    for (int i = 0; i < 2; i++) {
      int hi = (bytes[i] >> 4) & 0x0f;
      int lo = bytes[i] & 0x0f;
      if (hi > 9 || lo > 9) {
        throw new IllegalArgumentException(
            "Bcd16: invalid digit in 0x" + Integer.toHexString(bytes[i] & 0xff));
      }
      v = v * 100 + hi * 10 + lo;
    }
    return v;
  }

  @Override
  public byte[] write(Integer value, Object... args) {
    int v = value;
    if (v < 0 || v > 9999) throw new IllegalArgumentException("Bcd16: " + v + " out of range");
    int[] d = {v / 1000 % 10, v / 100 % 10, v / 10 % 10, v % 10};
    return new byte[] {(byte) ((d[0] << 4) | d[1]), (byte) ((d[2] << 4) | d[3])};
  }
}
