package org.yafflelang.conformance.externs;

/** {@code extern fn sum8(u8 data[]) -> u8}: the sum of the bytes, modulo 256. */
public final class Sum8 {
  private Sum8() {}

  public static int sum8(byte[] data) {
    int s = 0;
    for (byte b : data) s = (s + (b & 0xff)) & 0xff;
    return s;
  }
}
