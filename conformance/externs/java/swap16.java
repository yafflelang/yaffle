package org.yafflelang.conformance.externs;

/** {@code extern fn swap16(u16 v) -> u16}: swaps the two bytes. Its own inverse. */
public final class Swap16 {
  private Swap16() {}

  public static int swap16(int v) {
    return ((v & 0xff) << 8) | ((v >> 8) & 0xff);
  }
}
