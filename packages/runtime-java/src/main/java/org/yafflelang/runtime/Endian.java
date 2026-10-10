package org.yafflelang.runtime;

/** Byte order: the value of {@code $endian}. */
public enum Endian {
  LE,
  BE;

  public boolean le() {
    return this == LE;
  }

  /** Canonical JSON form ({@code "le"} / {@code "be"}). */
  public String json() {
    return this == LE ? "le" : "be";
  }

  public static Endian fromJson(Object j) {
    if ("le".equals(j)) return LE;
    if ("be".equals(j)) return BE;
    throw new YaffleException(ErrorCode.INPUT, "expected \"le\" or \"be\", got " + Json.describe(j));
  }
}
