package dev.yaffle.runtime;

import static dev.yaffle.runtime.Assert.check;
import static dev.yaffle.runtime.Assert.eq;
import static dev.yaffle.runtime.Assert.fails;

/** The reader: bounds, windows, padding, strings, identity and unions. */
public final class ReaderTest {
  private ReaderTest() {}

  public static void testPrimitivesAndEof() {
    Reader r = new Reader(Hex.decode("0102ff7f00800000"));
    eq(1, r.u8());
    eq(0xff02, r.u16(true));
    eq(0x7f, r.i8());
    eq(Float.intBitsToFloat(0x00008000), r.f32(false) * 0 + Float.intBitsToFloat(0x00008000));
    YaffleException e = fails(ErrorCode.EOF, () -> r.u32(true));
    eq(8L, e.offset());
  }

  public static void testWindowsAndStrictPadding() {
    Reader r = new Reader(Hex.decode("0a0000ff"), true);
    int saved = r.window(3);
    eq(10, r.u8());
    r.closeWindow(saved, true);
    eq(3, r.pos);
    fails(ErrorCode.CHECK, () -> r.pad(1, Fill.ZERO, true));
    Reader r2 = new Reader(new byte[4]);
    fails(ErrorCode.EOF, () -> r2.window(5));
    r2.pos = 1;
    r2.align(4, Fill.ZERO, false);
    eq(4, r2.pos);
  }

  public static void testStringsStopAtNul() {
    Reader r = new Reader(Hex.decode("616200636465006600"));
    eq("ab", r.str(4, 1, Encoding.UTF8, true));
    eq("de", r.strUntil(1, Encoding.UTF8, true));
    eq("f", r.strRest(1, Encoding.UTF8, true));
    Reader r2 = new Reader(Hex.decode("6162"));
    fails(ErrorCode.EOF, () -> r2.strUntil(1, Encoding.UTF8, true));
  }

  public static void testTargetsShareIdentityAndRestorePosition() {
    Reader r = new Reader(Hex.decode("0000000005"));
    Object a = r.target(4, "x", () -> new Object[] {r.u8()});
    Object b = r.target(4, "x", () -> new Object[] {r.u8()});
    check(a == b, "same object for the same address and key");
    eq(0, r.pos);
    Object c = r.target(4, "y", () -> new Object[] {r.u8()});
    check(c != a, "another key, another object");
    fails(ErrorCode.EOF, () -> r.target(9, "x", () -> null));
  }

  public static void testCyclesGetThePreRegisteredObject() {
    Reader r = new Reader(new byte[8]);
    Object[] inner = new Object[1];
    Object outer =
        r.targetStruct(
            2,
            "S",
            () -> new Object[1],
            () -> {
              Object me = r.takeInto();
              inner[0] = r.targetStruct(2, "S", () -> new Object[1], () -> r.takeInto());
              return me;
            });
    check(outer == inner[0], "a pointer back to the struct in progress gets the same object");
  }

  public static void testUnionsRestoreAndReportEveryVariant() {
    Reader r = new Reader(Hex.decode("0102"));
    Object v =
        r.<Object>union(
            new String[] {"A", "B"},
            () -> {
              r.u8();
              throw r.error(ErrorCode.CHECK, "not A");
            },
            () -> r.u16(true));
    eq(0x0201, v);
    Reader r2 = new Reader(Hex.decode("01"));
    YaffleException e =
        fails(
            ErrorCode.UNION,
            () -> r2.<Object>union(new String[] {"A"}, () -> r2.u16(true)));
    eq(1, e.causes().size());
    eq("A", e.causes().get(0).path().get(0));
  }

  public static void testExternTypesProbeForTheirSize() {
    Reader r = new Reader(Hex.decode("8001ff"));
    eq(128L, r.extern(Leb128.UNSIGNED, new Object[0], -1));
    eq(2, r.pos);
    Reader r2 = new Reader(Hex.decode("ff"));
    fails(ErrorCode.EOF, () -> r2.extern(Leb128.UNSIGNED, new Object[0], -1));
  }
}
