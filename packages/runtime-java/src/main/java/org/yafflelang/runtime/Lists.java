package org.yafflelang.runtime;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.function.Function;
import java.util.function.Predicate;

/**
 * Derived arrays: {@code indicesWhere}, {@code sortedBy}, {@code unique}, {@code concat}
 * (generated code does {@code map} and {@code filter} with streams), key ordering, and
 * conversions of computed lists to a field's element type.
 */
public final class Lists {
  private Lists() {}

  /** Indices of the elements satisfying {@code p}, in order. */
  public static <T> List<Long> indicesWhere(List<T> a, Predicate<? super T> p) {
    List<Long> out = new ArrayList<>();
    for (int i = 0; i < a.size(); i++) if (p.test(a.get(i))) out.add((long) i);
    return out;
  }

  /** A stable sort by key (numbers by value, strings by code points, bytes lexicographically). */
  public static <T> List<T> sortedBy(List<T> a, Function<? super T, Object> key) {
    List<Object> keys = new ArrayList<>(a.size());
    for (T x : a) keys.add(key.apply(x));
    Integer[] order = new Integer[a.size()];
    for (int i = 0; i < order.length; i++) order[i] = i;
    Arrays.sort(order, Comparator.comparing((Integer i) -> keys.get(i), Lists::compareKeys));
    List<T> out = new ArrayList<>(a.size());
    for (Integer i : order) out.add(a.get(i));
    return out;
  }

  /** The array without later duplicates (value equality, first occurrence kept). */
  public static <T> List<T> unique(List<T> a) {
    List<T> out = new ArrayList<>();
    outer:
    for (T x : a) {
      for (T y : out) if (Rt.equals(x, y)) continue outer;
      out.add(x);
    }
    return out;
  }

  /** Arrays joined in order. */
  public static List<Object> concat(List<?>... ls) {
    List<Object> out = new ArrayList<>();
    for (List<?> l : ls) out.addAll(l);
    return out;
  }

  /** Orders sort keys: numbers by value, strings by code points, bytes unsigned lexicographically. */
  public static int compareKeys(Object a, Object b) {
    if (a == b) return 0;
    if (a == null) return -1;
    if (b == null) return 1;
    if (a instanceof YEnum x) a = x.value();
    if (b instanceof YEnum y) b = y.value();
    if (a instanceof Number x && b instanceof Number y) {
      if (x instanceof Double || x instanceof Float || y instanceof Double || y instanceof Float) {
        return Double.compare(x.doubleValue(), y.doubleValue());
      }
      return big(x).compareTo(big(y));
    }
    if (a instanceof String x && b instanceof String y) return compareCodePoints(x, y);
    if (a instanceof byte[] x && b instanceof byte[] y) return Arrays.compareUnsigned(x, y);
    if (a instanceof Boolean x && b instanceof Boolean y) return Boolean.compare(x, y);
    throw new YaffleException(
        ErrorCode.INPUT, "sort keys are not comparable: " + Json.describe(a) + ", " + Json.describe(b));
  }

  private static BigInteger big(Number n) {
    if (n instanceof BigInteger b) return b;
    return BigInteger.valueOf(n.longValue());
  }

  private static int compareCodePoints(String x, String y) {
    int i = 0;
    int j = 0;
    while (i < x.length() && j < y.length()) {
      int a = x.codePointAt(i);
      int b = y.codePointAt(j);
      if (a != b) return Integer.compare(a, b);
      i += Character.charCount(a);
      j += Character.charCount(b);
    }
    return Integer.compare(x.length() - i, y.length() - j);
  }

  /** A {@code u8} array's bytes as a list of their unsigned values. */
  public static List<Integer> of(byte[] b) {
    List<Integer> out = new ArrayList<>(b.length);
    for (byte x : b) out.add(x & 0xff);
    return out;
  }

  /** A computed integer list as {@code u8} array bytes (range checked). */
  public static byte[] bytes(List<?> l) {
    byte[] out = new byte[l.size()];
    for (int i = 0; i < out.length; i++) out[i] = (byte) Ints.check(Ints.bigOf(l.get(i)), Prim.U8);
    return out;
  }

  /** A computed integer list as {@code int} elements of {@code p} (range checked). */
  public static List<Integer> ints(List<?> l, Prim p) {
    List<Integer> out = new ArrayList<>(l.size());
    for (Object o : l) out.add((int) Ints.check(Ints.bigOf(o), p));
    return out;
  }

  /** A computed integer list as {@code long} elements of {@code p} (u64: bit patterns; checked). */
  public static List<Long> longs(List<?> l, Prim p) {
    List<Long> out = new ArrayList<>(l.size());
    for (Object o : l) out.add(Ints.check(Ints.bigOf(o), p));
    return out;
  }
}
