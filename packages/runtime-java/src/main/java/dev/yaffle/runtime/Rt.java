package dev.yaffle.runtime;

import java.math.BigInteger;
import java.util.Arrays;
import java.util.List;
import java.util.Objects;
import java.util.function.BooleanSupplier;
import java.util.function.DoubleSupplier;
import java.util.function.IntSupplier;
import java.util.function.LongSupplier;
import java.util.function.Supplier;

/** Small helpers called by generated code. */
public final class Rt {
  private Rt() {}

  // ── host calls ──────────────────────────────────────────────────────────────

  /** A host failure (codec, extern) as a CODEC error. */
  public static YaffleException hostError(Throwable e, String what, long offset) {
    if (e instanceof YaffleException y) return y;
    String msg = e.getMessage() != null ? e.getMessage() : e.toString();
    return new YaffleException(ErrorCode.CODEC, what + ": " + msg, offset);
  }

  /** Calls a host function (extern fn); host failures are CODEC errors. */
  public static <T> T call(Supplier<T> f, String name) {
    try {
      return f.get();
    } catch (YaffleException e) {
      throw e;
    } catch (RuntimeException e) {
      throw hostError(e, "extern " + name, -1);
    }
  }

  public static int callInt(IntSupplier f, String name) {
    return call(f::getAsInt, name);
  }

  public static long callLong(LongSupplier f, String name) {
    return call(f::getAsLong, name);
  }

  public static double callDouble(DoubleSupplier f, String name) {
    return call(f::getAsDouble, name);
  }

  public static float callFloat(DoubleSupplier f, String name) {
    return (float) callDouble(f, name);
  }

  public static boolean callBool(BooleanSupplier f, String name) {
    return call(f::getAsBoolean, name);
  }

  private static YaffleException missing(String name) {
    return new YaffleException(
        ErrorCode.INPUT,
        "extern " + name + " has no implementation (configure targets.java.externs in yaffle.json)");
  }

  /** Placeholder for an extern fn without a configured implementation (fails when called). */
  public static <T> T missingFn(String name) {
    throw missing(name);
  }

  public static Codec missingCodec(String name) {
    return new Codec() {
      @Override
      public byte[] decode(byte[] input, CodecCtx ctx) {
        throw missing(name);
      }

      @Override
      public byte[] encode(byte[] input, CodecCtx ctx) {
        throw missing(name);
      }
    };
  }

  public static ExternType<Object> missingType(String name) {
    return new ExternType<>() {
      @Override
      public int size(byte[] bytes, Object... args) {
        throw missing(name);
      }

      @Override
      public Object read(byte[] bytes, Object... args) {
        throw missing(name);
      }

      @Override
      public byte[] write(Object value, Object... args) {
        throw missing(name);
      }
    };
  }

  /** An unchecked cast (generic values from untyped containers). */
  @SuppressWarnings("unchecked")
  public static <T> T cast(Object o) {
    return (T) o;
  }

  /** A host value of an integer type as a long (u64 values: bit pattern). */
  public static long hostLong(Object v) {
    if (v instanceof Long l) return l;
    if (v instanceof Integer i) return i;
    if (v instanceof Short s) return s;
    if (v instanceof Byte b) return b;
    if (v instanceof BigInteger b) return b.longValue();
    throw new YaffleException(ErrorCode.CODEC, "extern returned " + Json.describe(v) + ", not an integer");
  }

  public static double hostDouble(Object v) {
    if (v instanceof Number n) return n.doubleValue();
    throw new YaffleException(ErrorCode.CODEC, "extern returned " + Json.describe(v) + ", not a number");
  }

  public static <T> T hostValue(Object v, Class<T> type) {
    if (type.isInstance(v)) return type.cast(v);
    throw new YaffleException(
        ErrorCode.CODEC, "extern returned " + Json.describe(v) + ", not a " + type.getSimpleName());
  }

  // ── input validation ────────────────────────────────────────────────────────

  /** A struct input value: INPUT when it is null. */
  public static void need(Object v) {
    if (v == null) throw new YaffleException(ErrorCode.INPUT, "expected an object, got null");
  }

  /** {@code $end} in a write-side expression that is not checked after layout. */
  public static long endUnavailable() {
    throw new YaffleException(ErrorCode.DERIVE, "$end is not available on write");
  }

  /** A required input value: INPUT (path = the field) when it is missing. */
  public static <T> T req(T v, String field) {
    if (v == null) {
      throw new YaffleException(ErrorCode.INPUT, "missing required field " + field).prefix(field);
    }
    return v;
  }

  /** A non-null input value (array elements, union values). */
  public static <T> T nonNull(T v, String what) {
    if (v == null) throw new YaffleException(ErrorCode.INPUT, "expected " + what + ", got null");
    return v;
  }

  /** An array written with {@code actual} elements whose length expression says {@code expected}. */
  public static void checkLength(long actual, long expected) {
    if (actual != expected) {
      throw new YaffleException(
          ErrorCode.DERIVE, actual + " elements given, the length expression says " + expected);
    }
  }

  /** A placed field whose read-side offset expression disagrees with where it was placed. */
  public static void checkPlacement(long offset, Placeable p, String name) {
    if (p.block.size != 0 && offset != p.block.pos) {
      throw new YaffleException(
          ErrorCode.DERIVE,
          name + " was placed at " + p.block.pos + " but its offset expression gives " + offset);
    }
  }

  private static YaffleException noRoundTrip(Object v, Object back) {
    return new YaffleException(
        ErrorCode.INPUT,
        "value " + Json.describe(v) + " does not survive the transform (reads back as "
            + Json.describe(back) + ")");
  }

  /** {@code read(write(v))} must give {@code v} back. */
  public static void checkRoundTrip(long v, long back) {
    if (v != back) throw noRoundTrip(v, back);
  }

  public static void checkRoundTrip(BigInteger v, BigInteger back) {
    if (!v.equals(back)) throw noRoundTrip(v, back);
  }

  public static void checkRoundTrip(double v, double back) {
    if (v != back && !(Double.isNaN(v) && Double.isNaN(back))) throw noRoundTrip(v, back);
  }

  public static void checkRoundTrip(boolean v, boolean back) {
    if (v != back) throw noRoundTrip(v, back);
  }

  public static void checkRoundTrip(Object v, Object back) {
    if (!equals(v, back)) throw noRoundTrip(v, back);
  }

  /** Float transforms: the value must be within half a storage step of what reads back. */
  public static void checkFloatRoundTrip(double v, double back, double next) {
    if (Double.isNaN(v) && Double.isNaN(back)) return;
    double half = Math.abs(next - back) / 2;
    if (!(Math.abs(v - back) <= half * (1 + 1e-9))) throw noRoundTrip(v, back);
  }

  /**
   * A field with different types in different branches, from JSON: the first type the JSON
   * converts to (the writer then converts it to its branch's type).
   */
  public static Object firstOf(Supplier<?>... alts) {
    YaffleException first = null;
    for (Supplier<?> a : alts) {
      try {
        return a.get();
      } catch (YaffleException e) {
        if (first == null) first = e;
      }
    }
    if (first != null) throw first;
    throw new YaffleException(ErrorCode.INPUT, "no value");
  }

  /** A virtual field must read back as its value from the fields derived from it. */
  public static void checkVirtual(Object value, Object back, String name) {
    if (!equals(value, back)) {
      throw new YaffleException(
          ErrorCode.DERIVE,
          "virtual field " + name + " = " + Json.describe(value) + " reads back as "
              + Json.describe(back));
    }
  }

  /** Value equality for comparisons, round trips and lookups. */
  public static boolean equals(Object a, Object b) {
    if (a == b) return true;
    if (a == null || b == null) return false;
    if (a instanceof byte[] x && b instanceof byte[] y) return Arrays.equals(x, y);
    // u8 arrays (byte[]) against computed lists of their values.
    if (a instanceof byte[] x && b instanceof List<?>) return equals(Lists.of(x), b);
    if (a instanceof List<?> && b instanceof byte[] y) return equals(a, Lists.of(y));
    if (a instanceof Number x && b instanceof Number y) {
      if (x instanceof Double || x instanceof Float || y instanceof Double || y instanceof Float) {
        double dx = x.doubleValue();
        double dy = y.doubleValue();
        return dx == dy || (Double.isNaN(dx) && Double.isNaN(dy));
      }
      return Ints.bigOf(a).equals(Ints.bigOf(b));
    }
    if (a instanceof List<?> x && b instanceof List<?> y) {
      if (x.size() != y.size()) return false;
      for (int i = 0; i < x.size(); i++) if (!equals(x.get(i), y.get(i))) return false;
      return true;
    }
    // Structs and unions compare their canonical JSON.
    if (a instanceof YValue x && b instanceof YValue y) {
      return Json.write(x.toJsonValue()).equals(Json.write(y.toJsonValue()));
    }
    return Objects.equals(a, b);
  }

  /** {@code indexOf(array, value)} inverse lookup: a missing value is an INPUT error. */
  public static long indexOf(List<?> arr, Object v) {
    for (int i = 0; i < arr.size(); i++) if (equals(arr.get(i), v)) return i;
    throw new YaffleException(ErrorCode.INPUT, "value " + Json.describe(v) + " is not in the table");
  }

  /** Array element with a bounds check. */
  public static <T> T at(List<T> arr, long i) {
    if (i < 0 || i >= arr.size()) {
      throw Ints.range("index " + i + " is out of bounds (length " + arr.size() + ")");
    }
    return arr.get((int) i);
  }

  public static int at(byte[] arr, long i) {
    if (i < 0 || i >= arr.length) {
      throw Ints.range("index " + i + " is out of bounds (length " + arr.length + ")");
    }
    return arr[(int) i] & 0xff;
  }

  /** {@code @nullable(empty)}: an empty (or null) array, bytes or string value. */
  public static boolean isEmpty(Object v) {
    if (v == null) return true;
    if (v instanceof String s) return s.isEmpty();
    if (v instanceof byte[] b) return b.length == 0;
    if (v instanceof List<?> l) return l.isEmpty();
    return false;
  }

  // ── bits ────────────────────────────────────────────────────────────────────

  /** A bitfield value as unsigned bits of {@code width} (signed values in two's complement). */
  public static long bitsOf(long v, int width, boolean signed) {
    if (width >= 64) return v;
    long lo = signed ? -(1L << (width - 1)) : 0;
    long hi = signed ? (1L << (width - 1)) - 1 : (1L << width) - 1;
    if (v < lo || v > hi) throw Ints.range(v + " does not fit in " + width + " bits");
    return v & ((1L << width) - 1);
  }

  public static long bitsOf(BigInteger v, int width, boolean signed) {
    BigInteger lo = signed ? BigInteger.ONE.shiftLeft(width - 1).negate() : BigInteger.ZERO;
    BigInteger hi =
        signed
            ? BigInteger.ONE.shiftLeft(width - 1).subtract(BigInteger.ONE)
            : BigInteger.ONE.shiftLeft(width).subtract(BigInteger.ONE);
    if (v.compareTo(lo) < 0 || v.compareTo(hi) > 0) {
      throw Ints.range(v + " does not fit in " + width + " bits");
    }
    return v.longValue() & (width >= 64 ? -1L : (1L << width) - 1);
  }

  /** The bits of a u64 bitfield value (an unsigned bit pattern). */
  public static long bitsOfU64(long raw, int width) {
    if (width < 64 && Long.compareUnsigned(raw, (1L << width) - 1) > 0) {
      throw Ints.range(Long.toUnsignedString(raw) + " does not fit in " + width + " bits");
    }
    return raw;
  }

  // ── strings ─────────────────────────────────────────────────────────────────

  /** Encodes a string padded with NUL units to exactly {@code n} bytes. */
  public static byte[] encodeFixedString(String s, int n, int unit, Encoding enc, boolean le) {
    byte[] b = enc.encode(s, le);
    if (b.length > n) {
      throw new YaffleException(
          ErrorCode.INPUT, "string of " + b.length / unit + " units exceeds the length " + n / unit);
    }
    return Arrays.copyOf(b, n);
  }
}
