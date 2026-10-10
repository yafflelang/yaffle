package org.yafflelang.runtime;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.function.Supplier;

/**
 * {@code commit()} / {@code patches()} of views.
 *
 * <ul>
 *   <li><b>Fast path:</b> only same-size scalar edits that no derived value depends on: the
 *       in-place patches are the result. Nothing else is read or re-encoded.
 *   <li><b>Slow path:</b> structural edits. The view is turned into a plain value (unchanged
 *       parts are read from the source; edited nodes get their edits), which the generated writer
 *       re-encodes: byte arrays copied from the source keep their provenance, unchanged codec
 *       regions reuse their encoded bytes, and the layout is <i>sticky</i> (placeables keep their
 *       original positions where the grow policy allows). The result is diffed into patches.
 * </ul>
 */
public final class Commit {
  private Commit() {}

  /**
   * A computed commit.
   *
   * @param patches the edits against the original bytes
   * @param bytes the full new bytes (computed on demand on the fast path)
   */
  public record Plan(List<Patch> patches, Supplier<byte[]> bytes) {}

  private static boolean fastPathOk(ViewRoot root) {
    if (root.structural) return false;
    for (ViewSpace.InPlace ip : root.space.patches) {
      for (ViewNode p = ip.node() != null ? ip.node().parent : null; p != null; p = p.parent) {
        if (!p.info.childSafe) return false;
      }
    }
    return true;
  }

  /** Merges in-place patches into sorted, non-overlapping replacements. */
  private static List<Patch> inPlacePatches(ViewSpace space) {
    List<int[]> ranges = new ArrayList<>();
    for (ViewSpace.InPlace p : space.patches) ranges.add(new int[] {p.at(), p.at() + p.length()});
    ranges.sort(Comparator.comparingInt(r -> r[0]));
    List<int[]> merged = new ArrayList<>();
    for (int[] r : ranges) {
      int[] last = merged.isEmpty() ? null : merged.get(merged.size() - 1);
      if (last != null && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.add(new int[] {r[0], r[1]});
    }
    List<Patch> out = new ArrayList<>();
    for (int[] r : merged) {
      out.add(new Patch(r[0], r[1] - r[0], Arrays.copyOfRange(space.cur, r[0], r[1])));
    }
    return out;
  }

  static Plan plan(ViewRoot root, Layout.Grow grow) {
    ViewSpace space = root.space;
    if (fastPathOk(root)) {
      List<Patch> patches = inPlacePatches(space);
      return new Plan(patches, () -> Patch.apply(space.origAll(), patches));
    }
    ViewNode rootNode = root.rootNode;
    rootNode.ensureScanned();
    ViewConv conv = new ViewConv(root);
    Object value = conv.value(rootNode);
    Region region = new Region();
    region.layout = root.spec.layout();
    region.sticky = new Layout.StickyPolicy(grow, rootNode.inlineEnd - rootNode.pos, space.length());
    Writer w = new Writer(region);
    w.origins = conv;
    w.provenance = conv.provenance();
    w.provenanceSpace = space;
    Writer.attach(region, root.spec.write().apply(w, value));
    byte[] bytes = region.finish();
    List<int[]> anchors = new ArrayList<>();
    for (int i = 0; i < region.provenance.size(); i++) {
      Block.Provenance p = region.provenance.get(i);
      if (p.space() != space) continue;
      int[] at = region.provenanceRanges.get(i);
      anchors.add(new int[] {at[0], p.offset(), at[1]});
    }
    List<Patch> patches = diff(space.origAll(), bytes, anchors);
    if (grow == Layout.Grow.ERROR && bytes.length != space.length()) {
      throw new YaffleException(
          ErrorCode.DERIVE,
          "the data changed size from " + space.length() + " to " + bytes.length
              + " bytes (grow: \"error\")");
    }
    return new Plan(patches, () -> bytes);
  }

  /**
   * Patches turning {@code orig} into {@code out}. {@code anchors} ({new, orig, length}) are
   * ranges known to be copied unchanged from the original; between them the bytes are compared.
   */
  public static List<Patch> diff(byte[] orig, byte[] out, List<int[]> anchors) {
    List<int[]> sorted = new ArrayList<>();
    for (int[] a : anchors) if (a[2] > 0) sorted.add(a);
    sorted.sort(Comparator.comparingInt(a -> a[0]));
    List<int[]> chain = new ArrayList<>();
    int lastO = 0;
    int lastN = 0;
    for (int[] a : sorted) {
      if (a[1] >= lastO && a[0] >= lastN) {
        chain.add(a);
        lastO = a[1] + a[2];
        lastN = a[0] + a[2];
      }
    }
    List<Patch> patches = new ArrayList<>();
    int n = 0;
    int o = 0;
    for (int[] a : chain) {
      segment(orig, out, n, a[0], o, a[1], patches);
      n = a[0] + a[2];
      o = a[1] + a[2];
    }
    segment(orig, out, n, out.length, o, orig.length, patches);
    patches.removeIf(p -> p.remove() == 0 && p.insert().length == 0);
    return patches;
  }

  private static void segment(byte[] orig, byte[] out, int n0, int n1, int o0, int o1, List<Patch> patches) {
    int nl = n1 - n0;
    int ol = o1 - o0;
    if (nl == ol) {
      // Same length: the differing runs (gaps under 8 equal bytes are merged).
      int i = 0;
      while (i < nl) {
        if (out[n0 + i] == orig[o0 + i]) {
          i++;
          continue;
        }
        int j = i + 1;
        int same = 0;
        while (j < nl && same < 8) {
          if (out[n0 + j] == orig[o0 + j]) same++;
          else same = 0;
          j++;
        }
        int end = j - same;
        patches.add(new Patch(o0 + i, end - i, Arrays.copyOfRange(out, n0 + i, n0 + end)));
        i = j;
      }
      return;
    }
    int p = 0;
    while (p < nl && p < ol && out[n0 + p] == orig[o0 + p]) p++;
    int s = 0;
    while (s < nl - p && s < ol - p && out[n1 - 1 - s] == orig[o1 - 1 - s]) s++;
    patches.add(new Patch(o0 + p, ol - p - s, Arrays.copyOfRange(out, n0 + p, n1 - s)));
  }
}
