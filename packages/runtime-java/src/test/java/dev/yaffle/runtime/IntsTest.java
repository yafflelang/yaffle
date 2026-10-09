package dev.yaffle.runtime;

import static dev.yaffle.runtime.Assert.check;
import static dev.yaffle.runtime.Assert.eq;
import static dev.yaffle.runtime.Assert.fails;

import java.math.BigInteger;
import java.util.List;

/** Integer semantics (docs/IR.md §6). */
public final class IntsTest {
  private IntsTest() {}

  public static void testDivisionTruncatesAndModTakesTheDividendSign() {
    eq(-2L, Ints.div(-7, 3));
    eq(-1L, Ints.mod(-7, 3));
    eq(1L, Ints.mod(7, -3));
    eq(BigInteger.valueOf(-2), Ints.div(BigInteger.valueOf(-7), BigInteger.valueOf(3)));
    eq(BigInteger.valueOf(-1), Ints.mod(BigInteger.valueOf(-7), BigInteger.valueOf(3)));
    fails(ErrorCode.RANGE, () -> Ints.div(1, 0));
    fails(ErrorCode.RANGE, () -> Ints.mod(BigInteger.ONE, BigInteger.ZERO));
  }

  public static void testShiftCountsAreChecked() {
    eq(8L, Ints.shl(1, 3));
    eq(-4L, Ints.shr(-7, 1));
    fails(ErrorCode.RANGE, () -> Ints.shl(1, 64));
    fails(ErrorCode.RANGE, () -> Ints.shr(1, -1));
    eq(BigInteger.ONE.shiftLeft(63), Ints.shl(BigInteger.ONE, 63));
  }

  public static void testRoundingIsHalfAwayFromZero() {
    eq(3L, Ints.round(2.5));
    eq(-3L, Ints.round(-2.5));
    eq(0L, Ints.round(0.49999999999999994));
    eq(-2L, Ints.round(-1.5));
    fails(ErrorCode.RANGE, () -> Ints.round(Double.NaN));
    eq(-2L, Ints.trunc(-2.9));
  }

  public static void testU64BitPatterns() {
    eq(new BigInteger("18446744073709551615"), Ints.u64(-1L));
    eq(-1L, Ints.toU64(new BigInteger("18446744073709551615")));
    fails(ErrorCode.RANGE, () -> Ints.toU64(BigInteger.ONE.shiftLeft(64)));
    fails(ErrorCode.RANGE, () -> Ints.toU64(-1L));
    fails(ErrorCode.RANGE, () -> Ints.u64ToLong(-1L));
    eq(18446744073709551615.0, Ints.u64ToDouble(-1L));
  }

  public static void testRangeChecksPerPrimitive() {
    eq(255L, Ints.check(255, Prim.U8));
    fails(ErrorCode.RANGE, () -> Ints.check(256, Prim.U8));
    fails(ErrorCode.RANGE, () -> Ints.check(-129, Prim.I8));
    eq((1L << 47) - 1, Ints.check((1L << 47) - 1, Prim.I48));
    fails(ErrorCode.RANGE, () -> Ints.check(1L << 47, Prim.I48));
    fails(ErrorCode.RANGE, () -> Ints.check(BigInteger.ONE.shiftLeft(64), Prim.U64));
    eq(-1L, Ints.check(new BigInteger("18446744073709551615"), Prim.U64));
  }

  public static void testLengthsAndCounts() {
    eq(5, Ints.len(5));
    fails(ErrorCode.RANGE, () -> Ints.len(-1));
    fails(ErrorCode.RANGE, () -> Ints.lenU64(-1L));
    Reader r = new Reader(new byte[4]);
    fails(ErrorCode.RANGE, () -> r.count(-1, 1));
    fails(ErrorCode.EOF, () -> r.count(1L << 40, 1));
    eq(3, r.count(3, 1));
  }

  public static void testAggregates() {
    List<Integer> xs = List.of(3, 1, 4, 1, 5);
    eq(BigInteger.valueOf(14), Ints.sum(xs));
    eq(BigInteger.ONE, Ints.minOf(xs));
    eq(BigInteger.valueOf(5), Ints.maxOf(xs));
    eq(BigInteger.ZERO, Ints.sum(List.of()));
    fails(ErrorCode.RANGE, () -> Ints.maxOf(List.of()));
    eq(List.of(2L, 0L, 1L), Ints.lengths(java.util.Arrays.asList(List.of(1, 2), null, List.of(3))));
    check(Ints.sumDouble(List.of(0.5, 0.25)) == 0.75, "sum of floats");
  }
}
