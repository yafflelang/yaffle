package org.yafflelang.runtime;

import static org.yafflelang.runtime.Assert.eq;
import static org.yafflelang.runtime.Assert.fails;

/** Text encodings. */
public final class EncodingTest {
  private EncodingTest() {}

  public static void testUtf8IsStrict() {
    byte[] b = Hex.decode("68c3a9");
    eq("hé", Encoding.UTF8.decode(b, 0, 3, true, 0));
    fails(ErrorCode.CHECK, () -> Encoding.UTF8.decode(Hex.decode("c0af"), 0, 2, true, 0));
    fails(ErrorCode.CHECK, () -> Encoding.UTF8.decode(Hex.decode("eda080"), 0, 3, true, 0));
    eq(Hex.decode("68c3a9"), Encoding.UTF8.encode("hé", true));
    fails(ErrorCode.INPUT, () -> Encoding.UTF8.encode("a\0b", true));
    fails(ErrorCode.INPUT, () -> Encoding.UTF8.encode("\ud800", true));
  }

  public static void testAsciiAndLatin1() {
    fails(ErrorCode.CHECK, () -> Encoding.ASCII.decode(new byte[] {(byte) 0x80}, 0, 1, true, 0));
    eq("ÿ", Encoding.LATIN1.decode(new byte[] {(byte) 0xff}, 0, 1, true, 0));
    fails(ErrorCode.INPUT, () -> Encoding.LATIN1.encode("Ā", true));
    fails(ErrorCode.INPUT, () -> Encoding.ASCII.encode("é", true));
  }

  public static void testUtf16AndUtf32BothOrders() {
    eq("A😀", Encoding.UTF16.decode(Hex.decode("41003dd800de"), 0, 3, true, 0));
    eq("A", Encoding.UTF16.decode(Hex.decode("0041"), 0, 1, false, 0));
    fails(ErrorCode.CHECK, () -> Encoding.UTF16.decode(Hex.decode("00dc"), 0, 1, true, 0));
    eq(Hex.decode("0001f600"), Encoding.UTF32.encode("😀", false));
    eq("😀", Encoding.UTF32.decode(Hex.decode("00f60100"), 0, 1, true, 0));
    fails(ErrorCode.CHECK, () -> Encoding.UTF32.decode(Hex.decode("00110000"), 0, 1, false, 0));
  }

  public static void testLengthsCountCodeUnits() {
    eq(5L, Encoding.UTF8.codeUnits("h😀"));
    eq(3L, Encoding.UTF16.codeUnits("h😀"));
    eq(6L, Encoding.UTF16.encodedBytes("h😀"));
    eq(2L, Encoding.UTF32.codeUnits("h😀"));
    eq(8L, Encoding.UTF32.encodedBytes("h😀"));
  }
}
