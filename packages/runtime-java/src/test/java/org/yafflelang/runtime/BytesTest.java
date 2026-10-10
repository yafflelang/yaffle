package org.yafflelang.runtime;

import static org.yafflelang.runtime.Assert.check;
import static org.yafflelang.runtime.Assert.eq;

/** Primitive encodings and IEEE half precision. */
public final class BytesTest {
  private BytesTest() {}

  public static void testUnsignedIntegersOfEveryWidthAndOrder() {
    byte[] b = {1, 2, 3, 4, 5, 6, 7, 8};
    eq(0x030201L, Bytes.readUInt(b, 0, 3, true));
    eq(0x010203L, Bytes.readUInt(b, 0, 3, false));
    eq(0x0504030201L, Bytes.readUInt(b, 0, 5, true));
    eq(0x0102030405060708L, Bytes.readUInt(b, 0, 8, false));
    byte[] out = new byte[7];
    Bytes.writeUInt(out, 0, 7, 0x01020304050607L, false);
    eq(Hex.decode("01020304050607"), out);
    Bytes.writeUInt(out, 0, 7, 0x01020304050607L, true);
    eq(Hex.decode("07060504030201"), out);
  }

  public static void testSignExtension() {
    eq(-1L, Bytes.signExtend(0xffffff, 24));
    eq(0x7fffffL, Bytes.signExtend(0x7fffff, 24));
    eq(-(1L << 55), Bytes.signExtend(1L << 55, 56));
  }

  public static void testHalfPrecisionRoundsToNearestEvenFromTheDouble() {
    eq(0x3c00, Bytes.doubleToHalf(1.0));
    eq(0xc000, Bytes.doubleToHalf(-2.0));
    eq(0x7e00, Bytes.doubleToHalf(Double.NaN));
    eq(0x7c00, Bytes.doubleToHalf(1e10));
    eq(0x8000, Bytes.doubleToHalf(-0.0));
    eq(0x0001, Bytes.doubleToHalf(0x1p-24));
    // 1 + 2^-11 is exactly between two halves: ties to even (1.0).
    eq(0x3c00, Bytes.doubleToHalf(1 + 0x1p-11));
    // slightly above the tie rounds up
    eq(0x3c01, Bytes.doubleToHalf(1 + 0x1p-11 + 0x1p-30));
    check(Bytes.halfToDouble(0x3555) == 0.333251953125, "1/3 in half");
    check(1 / Bytes.halfToDouble(0x8000) < 0, "-0");
    check(Double.isNaN(Bytes.halfToDouble(0x7e01)), "NaN");
    eq(65504.0, Bytes.halfToDouble(0x7bff));
  }
}
