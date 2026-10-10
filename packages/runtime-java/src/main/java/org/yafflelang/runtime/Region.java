package org.yafflelang.runtime;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.LongSupplier;
import java.util.function.Supplier;

/** A base region: the base's own block at offset 0, plus everything placed in it. */
public final class Region {
  /** A value written in this region that a {@code @ref} pointer may point at. */
  record RefSite(String key, Block block, int start, int end, Object value) {}

  /**
   * A {@code @ref} pointer waiting for resolution: written at {@code markAt} of {@code markBlock},
   * relative to its base at {@code baseAt} of {@code baseBlock} (null: this region's start).
   * Object targets match by identity first ({@code value}), then by encoding ({@code encode},
   * computed lazily; scalars carry their {@code encoding}).
   */
  record RefUse(
      String key,
      List<Object> path,
      Object value,
      Supplier<byte[]> encode,
      byte[] encoding,
      LongSupplier origin,
      Block markBlock,
      int markAt,
      Block baseBlock,
      int baseAt,
      Prim kind,
      boolean le,
      boolean relative,
      Long nullValue) {
    /** The same pointer, now written into another region's block. */
    RefUse moved(Block markBlock, int markAt, Block baseBlock, int baseAt) {
      return new RefUse(
          key, path, value, encode, encoding, origin, markBlock, markAt, baseBlock, baseAt, kind, le,
          relative, nullValue);
    }
  }

  final Block root;
  final List<Block> blocks = new ArrayList<>();
  final List<Placeable> placeables = new ArrayList<>();
  final List<Fixup> fixups = new ArrayList<>();
  final IdentityHashMap<Object, Map<String, Placeable>> identity = new IdentityHashMap<>();
  final List<RefSite> refSites = new ArrayList<>();
  final List<RefUse> refUses = new ArrayList<>();
  /** {@code @ref} pointers a nested base could not resolve (handed to the enclosing base). */
  final List<RefUse> unresolved = new ArrayList<>();
  LStruct lroot;
  LayoutItem[] layout;
  /** The region's total size is padded to a multiple of this (a base's {@code @alignEnd}). */
  long alignEnd = 1;
  /**
   * A base's {@code @alignEnd} with an origin or offset: {to, file ? 1 : 0, offset}; the total
   * size is padded until {@code (start + size + offset) % to == 0}.
   */
  final List<long[]> alignEnds = new ArrayList<>();
  /** A nested {@code @base} region: unresolved {@code @ref}s are handed to the enclosing base. */
  boolean escalate;
  /**
   * Where this region's bytes go when it is a nested {@code @base} written inline: {@code
   * anchorAt} bytes into {@code anchorBlock} of the enclosing region. Null for a region that
   * starts its own byte space (the root, a codec's decoded side, a stream, a temporary encoding).
   */
  Block anchorBlock;
  int anchorAt;
  /** Commit mode (views): keep unchanged placeables where they were. */
  Layout.StickyPolicy sticky;
  /** After finish: the assembled bytes. */
  byte[] output;
  /** After finish: parts copied unchanged from a view's source ({at, length} and where from). */
  final List<int[]> provenanceRanges = new ArrayList<>();
  final List<Block.Provenance> provenance = new ArrayList<>();

  public Region() {
    root = new Block(this);
    root.pos = 0;
    blocks.add(root);
  }

  Block newBlock() {
    Block b = new Block(this);
    blocks.add(b);
    return b;
  }

  /**
   * The known part of block {@code b}'s start in its byte space ({@code @align(from: file)}).
   * Blocks whose position a later layout decides get {@code to} added to their alignment
   * requirement (their start then contributes a multiple of {@code to}) and count as 0.
   */
  static long fileStart(Block b, long to) {
    Region r = b.region;
    long start;
    if (b == r.root) start = 0;
    else if (b.fixedAt != null) start = b.fixedAt;
    else {
      b.align = Layout.lcm(b.align, to);
      start = 0;
    }
    if (r.anchorBlock != null) start += fileStart(r.anchorBlock, to) + r.anchorAt;
    return start;
  }

  /** Lays out, assembles and runs the fixups. Returns the region's bytes. */
  public byte[] finish() {
    Layout.layoutRegion(this);
    long size = paddedSize();
    if (size > Integer.MAX_VALUE - 8) {
      throw new YaffleException(ErrorCode.RANGE, "output of " + size + " bytes is too large");
    }
    byte[] out = new byte[(int) size];
    for (Block b : blocks) {
      if (b.pos < 0) continue;
      for (Block.Part p : b.allParts()) {
        System.arraycopy(p.data(), 0, out, b.pos + p.at(), p.len());
        if (p.prov() != null) {
          provenanceRanges.add(new int[] {b.pos + p.at(), p.len()});
          provenance.add(p.prov());
        }
      }
    }
    output = out;
    for (Fixup f : fixups) if (f.phase() == 0) run(f, out);
    resolveRefs(out);
    // Content-dependent values, innermost first (an outer checksum covers inner ones).
    List<Fixup> late = new ArrayList<>();
    for (Fixup f : fixups) if (f.phase() == 2) late.add(f);
    late.sort((a, b) -> Integer.compare(b.depth(), a.depth()));
    for (Fixup f : late) run(f, out);
    return out;
  }

  /** The end of the last block, padded by the region's {@code @alignEnd}s. */
  private long paddedSize() {
    long size = 0;
    for (Block b : blocks) if (b.pos >= 0) size = Math.max(size, (long) b.pos + b.size);
    size = Layout.alignUp(size, alignEnd);
    // Several alignments with offsets: pad until all hold (they may need several rounds).
    boolean changed = !alignEnds.isEmpty();
    for (int guard = 0; changed && guard < 64; guard++) {
      changed = false;
      for (long[] a : alignEnds) {
        long start = a[1] != 0 ? fileStart(root, a[0]) : 0;
        long pad = Math.floorMod(-(start + size + a[2]), a[0]);
        if (pad != 0) {
          size += pad;
          changed = true;
        }
      }
      if (alignEnd > 1 && size % alignEnd != 0) {
        size = Layout.alignUp(size, alignEnd);
        changed = true;
      }
    }
    return size;
  }

  private static void run(Fixup f, byte[] out) {
    try {
      f.run().run(out, f.block().pos + f.at());
    } catch (YaffleException e) {
      throw sealPath(e, f.path());
    }
  }

  /** Gives an error raised after layout the path of the field that caused it. */
  private static YaffleException sealPath(YaffleException e, List<Object> path) {
    if (!e.isSealed()) e.prefixAll(path).seal();
    return e;
  }

  /** A byte array with value semantics (map keys). */
  private record Content(byte[] b) {
    @Override
    public boolean equals(Object o) {
      return o instanceof Content x && Arrays.equals(b, x.b);
    }

    @Override
    public int hashCode() {
      return Arrays.hashCode(b);
    }

    @Override
    public String toString() {
      return Hex.encode(b);
    }
  }

  /** Key of an encoding for equal-value matching. */
  private record EncKey(String key, Content enc) {}

  /** The first (lowest) position of each placed value: by identity and type key. */
  private Map<Object, Map<String, Integer>> sitesByIdentity() {
    IdentityHashMap<Object, Map<String, Integer>> out = new IdentityHashMap<>();
    for (RefSite s : refSites) {
      if (s.block().pos < 0 || s.value() == null) continue;
      out.computeIfAbsent(s.value(), k -> new HashMap<>()).merge(s.key(), s.block().pos + s.start(), Math::min);
    }
    return out;
  }

  /** The first (lowest) position of each placed encoding. */
  private Map<EncKey, Integer> sitesByEncoding(byte[] out) {
    Map<EncKey, Integer> m = new HashMap<>();
    for (RefSite s : refSites) {
      if (s.block().pos < 0) continue;
      int abs = s.block().pos + s.start();
      byte[] enc = Arrays.copyOfRange(out, abs, s.block().pos + s.end());
      m.merge(new EncKey(s.key(), new Content(enc)), abs, Math::min);
    }
    return m;
  }

  private void resolveRefs(byte[] out) {
    if (refUses.isEmpty()) return;
    Map<Object, Map<String, Integer>> byIdentity = sitesByIdentity();
    Map<EncKey, Integer> byEncoding = null;
    for (RefUse u : refUses) {
      try {
        Integer target = null;
        if (u.value() != null) {
          Map<String, Integer> m = byIdentity.get(u.value());
          if (m != null) target = m.get(u.key());
        }
        if (target == null) {
          byte[] enc = u.encoding() != null ? u.encoding() : u.encode().get();
          if (byEncoding == null) byEncoding = sitesByEncoding(out);
          target = byEncoding.get(new EncKey(u.key(), new Content(enc)));
        }
        if (target == null) {
          if (escalate) {
            unresolved.add(u);
            continue;
          }
          throw new YaffleException(
              ErrorCode.REF, "no equal value is placed in this base for a @ref pointer");
        }
        int abs = u.markBlock().pos + u.markAt();
        int base = u.baseBlock() != null ? u.baseBlock().pos + u.baseAt() : 0;
        long value =
            (long) (u.relative() ? target - abs : target - base)
                - (u.origin() != null ? u.origin().getAsLong() : 0);
        Writer.writeOffset(out, abs, u.kind(), u.le(), value, u.nullValue());
      } catch (YaffleException e) {
        throw sealPath(e, u.path());
      }
    }
  }
}
