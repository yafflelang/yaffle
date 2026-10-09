package dev.yaffle.runtime;

import static dev.yaffle.runtime.Assert.eq;
import static dev.yaffle.runtime.Assert.fails;

/** The relocation writer and the layout engine. */
public final class WriterTest {
  private WriterTest() {}

  /** A target holding one byte. */
  private static Placeable target(Writer w, Object value, int b, Placeable.PlaceOptions opts) {
    return w.place(
        "t",
        value,
        () -> {
          w.u8(b);
          return null;
        },
        opts,
        null);
  }

  public static void testTargetsGoAfterTheInlineBytesAndPointersAreFixedUp() {
    Region region = new Region();
    Writer w = new Writer(region);
    Placeable a = target(w, new Object(), 0xaa, null);
    w.pointer(Prim.U8, true, a, false, null, null);
    Placeable b = target(w, new Object(), 0xbb, null);
    w.pointer(Prim.U8, true, b, false, null, null);
    eq(Hex.decode("0203aabb"), region.finish());
  }

  public static void testIdenticalObjectsShareOneTarget() {
    Region region = new Region();
    Writer w = new Writer(region);
    Object shared = new Object();
    for (int i = 0; i < 2; i++) {
      Placeable p =
          w.target(
              shared,
              "S",
              "p",
              () -> {
                w.u8(7);
                return null;
              },
              null,
              null);
      w.pointer(Prim.U8, true, p, false, null, null);
    }
    eq(Hex.decode("020207"), region.finish());
  }

  public static void testConstraintsAndAlignment() {
    Region region = new Region();
    Writer w = new Writer(region);
    w.u8(1);
    Placeable p = target(w, null, 0xcc, Placeable.PlaceOptions.constraint(4, 3));
    w.pointer(Prim.U8, true, p, false, null, null);
    // the target goes to the first position ≡ 3 (mod 4) after the inline bytes
    eq(Hex.decode("010300cc"), region.finish());
  }

  public static void testFixedPlacementsOverlapIsAnError() {
    Region region = new Region();
    Writer w = new Writer(region);
    w.u8(0);
    w.u8(0);
    target(w, null, 1, Placeable.PlaceOptions.fixedAt(1));
    fails(ErrorCode.OVERLAP, region::finish);
  }

  public static void testRefPointersResolveToAnEqualPlacedValue() {
    Region region = new Region();
    Writer w = new Writer(region);
    w.refPointer(Prim.U8, true, "str", "hi", () -> Hex.decode("686900"), false, null, null);
    int start = w.offset();
    w.strUntil("hi", 1, Encoding.UTF8, true);
    w.refSite("str", start, "hi");
    byte[] out = region.finish();
    eq(Hex.decode("01686900"), out);
    Region r2 = new Region();
    Writer w2 = new Writer(r2);
    w2.refPointer(Prim.U8, true, "str", "x", () -> Encoding.UTF8.encode("x", true), false, null, null);
    fails(ErrorCode.REF, r2::finish);
  }

  public static void testLayoutItemsOrderTargets() {
    Region region = new Region();
    region.layout =
        new LayoutItem[] {LayoutItem.of(new String[] {"b"}), LayoutItem.of(new String[] {"a"}, LayoutItem.align(4))};
    Writer w = new Writer(region);
    LStruct l = new LStruct(region.layout);
    Placeable a = target(w, null, 0xaa, null);
    w.pointer(Prim.U8, true, a, false, null, null);
    l.set("a", a);
    Placeable b = target(w, null, 0xbb, null);
    w.pointer(Prim.U8, true, b, false, null, null);
    l.set("b", b);
    Writer.attach(region, l);
    // b right after the inline bytes, a aligned to 4
    eq(Hex.decode("0402bb00aa"), region.finish());
  }

  public static void testComputedLayoutItemsComeFromTheRootStruct() {
    // The region takes the items its root struct's writer computed (LayoutItem.OWN).
    Region region = new Region();
    region.layout = LayoutItem.OWN;
    Writer w = new Writer(region);
    LStruct l = new LStruct();
    Placeable a = target(w, null, 0xaa, null);
    w.pointer(Prim.U8, true, a, false, null, null);
    l.set("a", a);
    l.layout(new LayoutItem[] {LayoutItem.of(new String[] {"a"}, LayoutItem.align(8))});
    Writer.attach(region, l);
    eq(Hex.decode("0800000000000000aa"), region.finish());
    fails(ErrorCode.RANGE, () -> LayoutItem.align(0));
    fails(ErrorCode.RANGE, () -> LayoutItem.alignAt(-4, 1, false));
    fails(ErrorCode.RANGE, () -> LayoutItem.alignEnd(0));
    fails(ErrorCode.RANGE, () -> LayoutItem.padBefore(-1));
  }

  public static void testDeferredValuesAndChecks() {
    Region region = new Region();
    Writer w = new Writer(region);
    Extent e = new Extent();
    w.deferPrim(Prim.U16, true, e::size, 0);
    w.start(e);
    w.u8(1);
    w.u8(2);
    w.u8(3);
    w.close(e);
    eq(Hex.decode("0300010203"), region.finish());
    Region r2 = new Region();
    Writer w2 = new Writer(r2);
    w2.deferPrim(Prim.U8, true, () -> 300L, 0);
    fails(ErrorCode.RANGE, r2::finish);
  }

  public static void testSizeWindowsAndPadUntil() {
    Writer w = new Writer();
    w.u8(1);
    w.sizeWindow(0, 4);
    eq(4, w.offset());
    fails(ErrorCode.DERIVE, () -> w.sizeWindow(0, 2));
    fails(ErrorCode.INPUT, () -> w.padUntil(0, 2, Fill.ZERO));
  }
}
