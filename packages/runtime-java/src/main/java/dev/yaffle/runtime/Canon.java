package dev.yaffle.runtime;

import java.math.BigInteger;
import java.util.Map;

/**
 * Canonical JSON conversions (docs/CONFORMANCE.md §3): bytes as lowercase hex, 56/64-bit integers
 * as decimal strings, non-finite floats and -0 as strings. Wrong JSON types are {@code INPUT}
 * errors; numbers that are not integers are {@code RANGE} errors.
 */
public final class Canon {
  private Canon() {}

  private static YaffleException input(String what, Object j) {
    return new YaffleException(ErrorCode.INPUT, "expected " + what + ", got " + Json.describe(j));
  }

  // ── to JSON ─────────────────────────────────────────────────────────────────

  public static Object floatToJson(double x) {
    if (Double.isNaN(x)) return "NaN";
    if (x == Double.POSITIVE_INFINITY) return "Infinity";
    if (x == Double.NEGATIVE_INFINITY) return "-Infinity";
    if (x == 0 && 1 / x < 0) return "-0";
    return x;
  }

  /** A 56/64-bit signed value as a decimal string. */
  public static String bigToJson(long v) {
    return Long.toString(v);
  }

  /** A u64 bit pattern as a decimal string. */
  public static String u64ToJson(long raw) {
    return Long.toUnsignedString(raw);
  }

  public static String bigToJson(BigInteger v) {
    return v.toString();
  }

  /** An enum value: its member name, or (open enums) its number. */
  public static Object enumToJson(YEnum e, Prim storage) {
    if (e.member() != null) return e.member();
    if (storage.bits > 48) {
      return storage == Prim.U64 ? Long.toUnsignedString(e.value()) : Long.toString(e.value());
    }
    return e.value();
  }

  /** A union value: {@code {"type": …, "value": …}}. */
  public static Map<String, Object> union(String type, Object value) {
    Map<String, Object> m = new java.util.LinkedHashMap<>();
    m.put("type", type);
    m.put("value", value);
    return m;
  }

  // ── from JSON ───────────────────────────────────────────────────────────────

  /** Integers of up to 48 bits: JSON numbers (a non-integer is RANGE, other types INPUT). */
  public static long intFromJson(Object j) {
    if (j instanceof Long l) return l;
    if (j instanceof Integer i) return i;
    if (j instanceof BigInteger b) {
      if (b.bitLength() <= 63) return b.longValue();
      throw Ints.range(b + " is out of range");
    }
    if (j instanceof Double d) {
      if (!Double.isFinite(d)) throw input("an integer", j);
      if (d != Math.rint(d)) throw Ints.range(d + " is not an integer");
      if (Math.abs(d) >= 0x1p63) throw Ints.range(d + " is out of range");
      return (long) (double) d;
    }
    throw input("an integer", j);
  }

  /** An int field (up to 32 bits signed / 24 bits unsigned): RANGE beyond the int range. */
  public static int int32FromJson(Object j) {
    long v = intFromJson(j);
    if (v < Integer.MIN_VALUE || v > Integer.MAX_VALUE) throw Ints.range(v + " is out of range");
    return (int) v;
  }

  /** 56/64-bit integers: decimal strings, as a BigInteger. */
  public static BigInteger bigFromJson(Object j) {
    if (j instanceof String s && s.matches("-?\\d+")) return new BigInteger(s);
    throw input("a decimal integer string", j);
  }

  /** A 56/64-bit signed integer (decimal string); RANGE beyond the long range. */
  public static long i64FromJson(Object j) {
    BigInteger b = bigFromJson(j);
    if (b.bitLength() > 63) throw Ints.range(b + " is out of range");
    return b.longValue();
  }

  /** A u64 (decimal string) as its bit pattern; RANGE outside [0, 2^64). */
  public static long u64FromJson(Object j) {
    return Ints.check(bigFromJson(j), Prim.U64);
  }

  public static double floatFromJson(Object j) {
    if (j instanceof Number n && !(j instanceof BigInteger)) return n.doubleValue();
    if (j instanceof BigInteger b) return b.doubleValue();
    if ("NaN".equals(j)) return Double.NaN;
    if ("Infinity".equals(j)) return Double.POSITIVE_INFINITY;
    if ("-Infinity".equals(j)) return Double.NEGATIVE_INFINITY;
    if ("-0".equals(j)) return -0.0;
    throw input("a number", j);
  }

  /** An f32: the JSON number rounded to nearest float (ties to even). */
  public static float f32FromJson(Object j) {
    return (float) floatFromJson(j);
  }

  public static boolean boolFromJson(Object j) {
    if (j instanceof Boolean b) return b;
    throw input("a boolean", j);
  }

  public static String stringFromJson(Object j) {
    if (j instanceof String s) return s;
    throw input("a string", j);
  }

  @SuppressWarnings("unchecked")
  public static Map<String, Object> objectFromJson(Object j) {
    if (j instanceof Map<?, ?> m) return (Map<String, Object>) m;
    throw input("an object", j);
  }

  /** A union {@code {type, value}}: the type name (INPUT if missing). */
  public static String unionType(Map<String, Object> o) {
    if (o.get("type") instanceof String t) return t;
    throw new YaffleException(ErrorCode.INPUT, "unknown union variant " + Json.describe(o.get("type")));
  }

  public static YaffleException unknownVariant(Object t) {
    return new YaffleException(ErrorCode.INPUT, "unknown union variant " + Json.describe(t));
  }

  /** An enum member name, or (open enums) a number / decimal string; returns the raw value or null. */
  public static Long openEnumValue(Object j, Prim storage) {
    if (j instanceof Long || j instanceof Integer) return ((Number) j).longValue();
    if (j instanceof Double d && d == Math.rint(d) && Math.abs(d) < 0x1p63) return (long) (double) d;
    if (j instanceof String s && s.matches("-?\\d+")) {
      BigInteger b = new BigInteger(s);
      return storage == Prim.U64 ? Ints.check(b, Prim.U64) : Ints.toLong(b);
    }
    return null;
  }

  public static YaffleException notAMember(Object j) {
    return new YaffleException(ErrorCode.INPUT, Json.describe(j) + " is not a member of the enum");
  }
}
