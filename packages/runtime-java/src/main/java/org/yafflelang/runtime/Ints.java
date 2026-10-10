package org.yafflelang.runtime;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.List;
import java.util.function.BinaryOperator;
import java.util.function.Function;

/**
 * Integer semantics used by generated expressions (docs/IR.md §6): exact arithmetic, truncating
 * division, {@code %} with the sign of the dividend, shift counts 0..63, 64-bit two's complement
 * bitwise operators, rounding half away from zero, and range checks where a value lands in a typed
 * location.
 *
 * <p>The code generator computes in {@code long} when interval analysis proves the result stays
 * within the signed 64-bit range and calls the {@code BigInteger} helpers otherwise. {@code u64}
 * values travel as their unsigned bit pattern in a {@code long}.
 */
public final class Ints {
  private Ints() {}

  private static final BigInteger U64_MAX = BigInteger.ONE.shiftLeft(64).subtract(BigInteger.ONE);

  public static YaffleException range(String detail) {
    return new YaffleException(ErrorCode.RANGE, detail);
  }

  // ── conversions ─────────────────────────────────────────────────────────────

  /** A {@code u64} bit pattern as its unsigned value. */
  public static BigInteger u64(long raw) {
    BigInteger b = BigInteger.valueOf(raw);
    return raw >= 0 ? b : b.add(BigInteger.ONE.shiftLeft(64));
  }

  /** A {@code u64} bit pattern as a signed long (RANGE if it is 2^63 or more). */
  public static long u64ToLong(long raw) {
    if (raw < 0) throw range("value " + Long.toUnsignedString(raw) + " is too large");
    return raw;
  }

  public static double u64ToDouble(long raw) {
    return raw >= 0 ? (double) raw : u64(raw).doubleValue();
  }

  /** A value known to be in [0, 2^64) as a u64 bit pattern. */
  public static long toU64(BigInteger v) {
    if (v.signum() < 0 || v.compareTo(U64_MAX) > 0) throw range(v + " is out of range for u64");
    return v.longValue();
  }

  /** A non-negative long as a u64 bit pattern. */
  public static long toU64(long v) {
    if (v < 0) throw range(v + " is out of range for u64");
    return v;
  }

  public static long toLong(BigInteger v) {
    if (v.bitLength() > 63) throw range(v + " is too large");
    return v.longValue();
  }

  /** Narrows to an int destination (RANGE outside the int range). */
  public static int toInt(long v) {
    if (v < Integer.MIN_VALUE || v > Integer.MAX_VALUE) throw range(v + " is out of range");
    return (int) v;
  }

  public static int toInt(BigInteger v) {
    if (v.bitLength() > 31) throw range(v + " is out of range");
    return v.intValue();
  }

  /** Checks that {@code v} fits the integer primitive {@code p} (u64: non-negative). */
  public static long check(long v, Prim p) {
    if (p == Prim.U64) return toU64(v);
    if (v < p.min || v > p.max) throw range(v + " is out of range for " + p.irName());
    return v;
  }

  /** Checks a BigInteger against the primitive's range; returns the long (u64: bit pattern). */
  public static long check(BigInteger v, Prim p) {
    if (v.compareTo(p.minBig) < 0 || v.compareTo(p.maxBig) > 0) {
      throw range(v + " is out of range for " + p.irName());
    }
    return v.longValue();
  }

  /** A length or count (non-negative int). */
  public static int len(long v) {
    if (v < 0) throw range("length " + v + " is negative");
    if (v > Integer.MAX_VALUE) throw range("length " + v + " is too large");
    return (int) v;
  }

  public static int len(BigInteger v) {
    if (v.signum() < 0) throw range("length " + v + " is negative");
    if (v.bitLength() > 31) throw range("length " + v + " is too large");
    return v.intValue();
  }

  /** An unsigned u64 count. */
  public static int lenU64(long raw) {
    if (raw < 0 || raw > Integer.MAX_VALUE) {
      throw range("length " + Long.toUnsignedString(raw) + " is too large");
    }
    return (int) raw;
  }

  // ── arithmetic ──────────────────────────────────────────────────────────────

  public static long div(long a, long b) {
    if (b == 0) throw range("division by zero");
    return a / b;
  }

  public static BigInteger div(BigInteger a, BigInteger b) {
    if (b.signum() == 0) throw range("division by zero");
    return a.divide(b);
  }

  public static long mod(long a, long b) {
    if (b == 0) throw range("division by zero");
    return a % b;
  }

  public static BigInteger mod(BigInteger a, BigInteger b) {
    if (b.signum() == 0) throw range("division by zero");
    return a.remainder(b);
  }

  private static int shiftCount(long n) {
    if (n < 0 || n > 63) throw range("shift count " + n + " is not in 0..63");
    return (int) n;
  }

  private static int shiftCount(BigInteger n) {
    if (n.signum() < 0 || n.compareTo(BigInteger.valueOf(63)) > 0) {
      throw range("shift count " + n + " is not in 0..63");
    }
    return n.intValue();
  }

  /** {@code a << n} where the result is known to fit a long. */
  public static long shl(long a, long n) {
    return a << shiftCount(n);
  }

  public static BigInteger shl(BigInteger a, long n) {
    return a.shiftLeft(shiftCount(n));
  }

  public static BigInteger shl(BigInteger a, BigInteger n) {
    return a.shiftLeft(shiftCount(n));
  }

  /** Arithmetic shift right (floor division by 2^n). */
  public static long shr(long a, long n) {
    return a >> shiftCount(n);
  }

  public static BigInteger shr(BigInteger a, long n) {
    return a.shiftRight(shiftCount(n));
  }

  public static BigInteger shr(BigInteger a, BigInteger n) {
    return a.shiftRight(shiftCount(n));
  }

  /** Rounds half away from zero to a long (RANGE for non-finite or huge values). */
  public static long round(double x) {
    if (!Double.isFinite(x) || Math.abs(x) >= 0x1p63) throw range("cannot round " + x);
    return x < 0 ? -Math.round(-x) : Math.round(x);
  }

  public static BigInteger roundBig(double x) {
    if (!Double.isFinite(x)) throw range("cannot round " + x);
    if (Math.abs(x) < 0x1p62) return BigInteger.valueOf(round(x));
    return new BigDecimal(x).toBigInteger();
  }

  /** Float to integer, truncating toward zero. */
  public static long trunc(double x) {
    if (!Double.isFinite(x) || Math.abs(x) >= 0x1p63) throw range(x + " is out of range");
    return (long) x;
  }

  public static BigInteger truncBig(double x) {
    if (!Double.isFinite(x)) throw range(x + " is out of range");
    return new BigDecimal(x).toBigInteger();
  }

  public static BigInteger min(BigInteger a, BigInteger b) {
    return a.compareTo(b) <= 0 ? a : b;
  }

  public static BigInteger max(BigInteger a, BigInteger b) {
    return a.compareTo(b) >= 0 ? a : b;
  }

  // ── aggregates ──────────────────────────────────────────────────────────────

  /** An array's elements (u8 arrays as their unsigned values). */
  private static List<?> items(Object arr) {
    if (arr instanceof List<?> l) return l;
    if (arr instanceof byte[] b) return Lists.of(b);
    throw new YaffleException(ErrorCode.INPUT, "expected an array, got " + Json.describe(arr));
  }

  /** The integer value of an element (Integer, Long, BigInteger, YEnum). */
  static BigInteger bigOf(Object o) {
    if (o instanceof Integer i) return BigInteger.valueOf(i);
    if (o instanceof Long l) return BigInteger.valueOf(l);
    if (o instanceof BigInteger b) return b;
    if (o instanceof YEnum e) return BigInteger.valueOf(e.value());
    throw new YaffleException(ErrorCode.INPUT, "expected an integer, got " + Json.describe(o));
  }

  private static double doubleOf(Object o) {
    if (o instanceof Number n) return n.doubleValue();
    throw new YaffleException(ErrorCode.INPUT, "expected a number, got " + Json.describe(o));
  }

  /** Sum of an array of integers (0 for an empty array). */
  public static BigInteger sum(Object arr) {
    BigInteger s = BigInteger.ZERO;
    for (Object o : items(arr)) s = s.add(bigOf(o));
    return s;
  }

  public static double sumDouble(Object arr) {
    double s = 0;
    for (Object o : items(arr)) s += doubleOf(o);
    return s;
  }

  /** The smallest (or largest) element: {@code pick} keeps one of two; empty arrays are RANGE. */
  private static <T> T extreme(Object arr, String what, Function<Object, T> conv, BinaryOperator<T> pick) {
    List<?> a = items(arr);
    if (a.isEmpty()) throw range(what + " of an empty array");
    T m = conv.apply(a.get(0));
    for (Object o : a) m = pick.apply(m, conv.apply(o));
    return m;
  }

  public static BigInteger minOf(Object arr) {
    return extreme(arr, "min", Ints::bigOf, Ints::min);
  }

  public static BigInteger maxOf(Object arr) {
    return extreme(arr, "max", Ints::bigOf, Ints::max);
  }

  public static double minOfDouble(Object arr) {
    return extreme(arr, "min", Ints::doubleOf, Math::min);
  }

  public static double maxOfDouble(Object arr) {
    return extreme(arr, "max", Ints::doubleOf, Math::max);
  }

  /** The length of each element of an array of arrays (null counts as empty). */
  public static List<Long> lengths(Object arr) {
    List<?> a = items(arr);
    List<Long> out = new ArrayList<>(a.size());
    for (Object x : a) {
      if (x == null) out.add(0L);
      else if (x instanceof byte[] b) out.add((long) b.length);
      else if (x instanceof String s) out.add((long) s.length());
      else out.add((long) items(x).size());
    }
    return out;
  }
}
