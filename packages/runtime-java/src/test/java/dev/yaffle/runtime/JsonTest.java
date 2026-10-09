package dev.yaffle.runtime;

import static dev.yaffle.runtime.Assert.check;
import static dev.yaffle.runtime.Assert.eq;
import static dev.yaffle.runtime.Assert.fails;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** The JSON reader/writer and canonical conversions. */
public final class JsonTest {
  private JsonTest() {}

  public static void testParseAndWriteRoundTrip() {
    String text = "{\"a\":[1,-2.5,\"x\\n\\u00e9\",true,null],\"b\":{\"c\":18446744073709551615}}";
    Object v = Json.parse(text);
    eq(text.replace("\\u00e9", "é"), Json.write(v));
    Map<?, ?> m = (Map<?, ?>) v;
    eq(new BigInteger("18446744073709551615"), ((Map<?, ?>) m.get("b")).get("c"));
    eq(1L, ((List<?>) m.get("a")).get(0));
    fails(ErrorCode.INPUT, () -> Json.parse("{\"a\":}"));
    fails(ErrorCode.INPUT, () -> Json.parse("[1] x"));
  }

  public static void testWriterEscapesControlsAndLoneSurrogates() {
    eq("\"\\u0001\\ud800\"", Json.write("\u0001\ud800"));
    eq("\"😀\"", Json.write("😀"));
    eq("2", Json.write(2.0));
    eq("0.1", Json.write(0.1));
  }

  public static void testCanonicalNumbers() {
    eq("NaN", Canon.floatToJson(Double.NaN));
    eq("-0", Canon.floatToJson(-0.0));
    eq("-Infinity", Canon.floatToJson(Double.NEGATIVE_INFINITY));
    eq("18446744073709551615", Canon.u64ToJson(-1L));
    eq(-1L, Canon.u64FromJson("18446744073709551615"));
    fails(ErrorCode.RANGE, () -> Canon.u64FromJson("18446744073709551616"));
    fails(ErrorCode.INPUT, () -> Canon.u64FromJson(5L));
    fails(ErrorCode.RANGE, () -> Canon.intFromJson(1.5));
    fails(ErrorCode.INPUT, () -> Canon.intFromJson("1"));
    eq(3L, Canon.intFromJson(3.0));
    check(Double.isNaN(Canon.floatFromJson("NaN")), "NaN");
    check(1 / Canon.floatFromJson("-0") < 0, "-0");
    // rounds to nearest float
    eq(0.1f, Canon.f32FromJson(0.1));
  }

  public static void testRefsShareObjectsAndArrays() {
    ToJsonCtx c = new ToJsonCtx();
    List<Integer> list = new ArrayList<>(List.of(1));
    eq(null, c.ref(list, "/a"));
    eq(Map.of("$ref", "/a"), c.ref(list, "/b"));
    eq(null, c.ref(new ArrayList<Integer>(), "/c"));
    eq(null, c.ref(new byte[2], "/d"));
    FromJsonCtx f = new FromJsonCtx();
    Object o = new Object();
    f.register("/x", o);
    eq(o, f.obj(Map.of("$ref", "/x"), "/y", Object.class, (j, p) -> null));
    fails(ErrorCode.INPUT, () -> f.obj(Map.of("$ref", "/nope"), "/y", Object.class, (j, p) -> null));
  }

  public static void testHex() {
    eq("00ff10", Hex.encode(new byte[] {0, -1, 16}));
    eq(new byte[] {0, -1}, Hex.decode("00 FF"));
    fails(ErrorCode.INPUT, () -> Hex.decode("0"));
    fails(ErrorCode.INPUT, () -> Hex.decode("zz"));
  }
}
