package org.yafflelang.runtime;

import static org.yafflelang.runtime.Assert.eq;

import java.util.List;

/** Patch diffs and application (view commits). */
public final class CommitTest {
  private CommitTest() {}

  public static void testSameLengthDiffMergesNearbyRuns() {
    byte[] a = new byte[20];
    byte[] b = new byte[20];
    b[0] = 1;
    b[2] = 1;
    b[19] = 1;
    List<Patch> ps = Commit.diff(a, b, List.of());
    // differences less than 8 equal bytes apart are one patch
    eq(2, ps.size());
    eq(0, ps.get(0).at());
    eq(3, ps.get(0).remove());
    eq(19, ps.get(1).at());
    eq(b, Patch.apply(a, ps));
  }

  public static void testGrowthUsesCommonPrefixAndSuffix() {
    byte[] a = Hex.decode("aabbccdd");
    byte[] b = Hex.decode("aabb0102ccdd");
    List<Patch> ps = Commit.diff(a, b, List.of());
    eq(1, ps.size());
    eq(2, ps.get(0).at());
    eq(0, ps.get(0).remove());
    eq(Hex.decode("0102"), ps.get(0).insert());
    eq(b, Patch.apply(a, ps));
  }

  public static void testAnchorsKeepMovedRangesOutOfThePatches() {
    byte[] a = Hex.decode("11223344" + "55667788");
    byte[] b = Hex.decode("1122" + "ffff" + "3344" + "55667788");
    // the tail moved by two bytes, unchanged
    List<Patch> ps = Commit.diff(a, b, List.of(new int[] {4, 2, 6}));
    eq(b, Patch.apply(a, ps));
    eq(1, ps.size());
    eq(2, ps.get(0).at());
  }
}
