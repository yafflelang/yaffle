package dev.yaffle.runtime;

import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The layout engine (docs/IR.md §4): assigns every placeable of a base region a position.
 *
 * <ul>
 *   <li>Default order: the base's own bytes first, then each placeable's unit in pre-order (a unit
 *       = the target's own bytes, then its own targets).
 *   <li>{@code layout { … }} items of a struct order that struct's own targets; items in an outer
 *       struct run first, so they pull groups out of inner layouts.
 *   <li>Item layers apply to every block an item places unless a nested item specifies its own.
 *       Placement constraints and alignment required by a block's content add to that.
 *   <li>Fixed placements go exactly where they say; overlaps are OVERLAP errors and sequential
 *       placement flows around them.
 *   <li>Sticky mode (view commits): placeables keep their original positions where possible.
 * </ul>
 */
public final class Layout {
  private Layout() {}

  /**
   * How a view commit treats size changes: "default" (targets that grow move to the end), "append"
   * (targets pushed by growth move to the end too), "splice" (every size change shifts what
   * follows), "error" (any size change is an error).
   */
  public enum Grow {
    DEFAULT,
    APPEND,
    SPLICE,
    ERROR
  }

  /**
   * Sticky layout policy for view commits.
   *
   * @param grow the grow policy
   * @param origRootSize size of the base's own bytes in the original, or -1 (no original)
   * @param origSize original size of the whole region, or -1
   */
  record StickyPolicy(Grow grow, int origRootSize, int origSize) {}

  static long alignUp(long x, long a) {
    return a <= 1 ? x : Math.ceilDiv(x, a) * a;
  }

  private static long gcd(long a, long b) {
    while (b != 0) {
      long t = a % b;
      a = b;
      b = t;
    }
    return a;
  }

  static long lcm(long a, long b) {
    if (a <= 0 || b <= 0) throw new YaffleException(ErrorCode.RANGE, "invalid alignment");
    return a / gcd(a, b) * b;
  }

  private record Range(long start, long end, String name) {}

  /** Hook used by the order-recording passes of sticky layout. */
  @FunctionalInterface
  private interface PlaceHook {
    void before(Placeable p, List<LayoutItem.Layer> layers);
  }

  private static final class Engine {
    long cursor;
    final List<Range> reserved = new ArrayList<>();
    final Region region;
    final Set<Placeable> claimed = Collections.newSetFromMap(new IdentityHashMap<>());
    final Set<Placeable> visiting = Collections.newSetFromMap(new IdentityHashMap<>());
    PlaceHook hook;

    Engine(Region region) {
      this.region = region;
      this.cursor = region.root.size;
      if (region.root.size > 0) reserved.add(new Range(0, region.root.size, "base"));
    }

    void placeFixed(Placeable p) {
      long start = p.fixed;
      if (start < 0 || start > Integer.MAX_VALUE) {
        throw new YaffleException(ErrorCode.RANGE, "invalid fixed offset " + start + " for " + p.name);
      }
      long end = start + p.block.size;
      if (end > start) {
        for (Range r : reserved) {
          if (start < r.end && r.start < end) {
            throw new YaffleException(
                ErrorCode.OVERLAP,
                p.name + " at [0x" + Long.toHexString(start) + ", 0x" + Long.toHexString(end)
                    + ") overlaps " + r.name + " at [0x" + Long.toHexString(r.start) + ", 0x"
                    + Long.toHexString(r.end) + ")");
          }
        }
        reserved.add(new Range(start, end, p.name));
      }
      p.block.pos = (int) start;
    }

    /** Smallest position ≥ from satisfying alignment and constraint, not overlapping fixed ranges. */
    long findPos(Placeable p, long align, long from) {
      int size = p.block.size;
      long pos = satisfy(p, align, from);
      for (int guard = 0; guard < 100000; guard++) {
        Range hit = null;
        if (size > 0) {
          for (Range r : reserved) {
            if (pos < r.end && r.start < pos + size) {
              hit = r;
              break;
            }
          }
        }
        if (hit == null) return pos;
        pos = satisfy(p, align, hit.end);
      }
      throw new YaffleException(ErrorCode.OVERLAP, "no room for " + p.name);
    }

    long satisfy(Placeable p, long align, long from) {
      long pos = alignUp(from, align);
      if (p.modulus > 1) {
        long m = p.modulus;
        long r = Math.floorMod(p.remainder, m);
        long guard = 0;
        while (Math.floorMod(pos, m) != r) {
          pos += align;
          if (++guard > m) {
            throw new YaffleException(
                ErrorCode.DERIVE,
                "placement constraint ≡ " + r + " (mod " + m + ") cannot be met with alignment "
                    + align);
          }
        }
      }
      return pos;
    }

    void placeBlock(Placeable p, List<LayoutItem.Layer> layers) {
      if (hook != null) hook.before(p, layers);
      if (p.placed()) {
        if (p.fixed != null) cursor = Math.max(cursor, (long) p.block.pos + p.block.size);
        return;
      }
      long align = p.block.align;
      long cur = cursor;
      for (LayoutItem.Layer l : layers) {
        if (l.kind() == LayoutItem.Kind.ALIGN && !l.residue()) align = lcm(align, l.n());
        else if (l.kind() == LayoutItem.Kind.PAD_BEFORE) cur += l.n();
      }
      long pos = findPos(p, align, residues(region, layers), cur);
      if (pos > Integer.MAX_VALUE) throw new YaffleException(ErrorCode.RANGE, "layout exceeds 2 GiB");
      p.block.pos = (int) pos;
      cur = pos + p.block.size;
      for (LayoutItem.Layer l : layers) {
        if (l.kind() == LayoutItem.Kind.PAD_AFTER) cur += l.n();
        else if (l.kind() == LayoutItem.Kind.ALIGN_END) cur = alignUp(cur, l.n());
      }
      cursor = Math.max(cursor, cur);
    }

    /**
     * {@code @align(n, offset: k)} / {@code from: file} item layers: residues {n, r} the
     * start must satisfy ({@code start % n == r}) instead of alignments.
     */
    static List<long[]> residues(Region region, List<LayoutItem.Layer> layers) {
      List<long[]> out = new ArrayList<>();
      for (LayoutItem.Layer l : layers) {
        if (!l.residue()) continue;
        long origin = l.file() ? Region.fileStart(region.root, l.n()) : 0;
        out.add(new long[] {l.n(), Math.floorMod(-(origin + l.offset()), l.n())});
      }
      return out;
    }

    /** {@link #findPos(Placeable, long, long)} that also satisfies {@code residues}. */
    long findPos(Placeable p, long align, List<long[]> residues, long from) {
      long pos = findPos(p, align, from);
      for (int guard = 0; !residuesHold(residues, pos); guard++) {
        if (guard > 1 << 20) {
          throw new YaffleException(
              ErrorCode.DERIVE, "no position satisfies the alignment of " + p.name);
        }
        pos = findPos(p, align, pos + 1);
      }
      return pos;
    }

    /** The default order: the root struct's layout, then every placeable not placed yet. */
    void placeAll() {
      if (region.lroot != null) processStruct(region.lroot, region.layout, null, List.of());
      for (Placeable p : region.placeables) if (!p.placed()) placeUnit(p, List.of());
    }

    void placeUnit(Placeable p, List<LayoutItem.Layer> layers) {
      if (visiting.contains(p)) {
        placeBlock(p, layers);
        return;
      }
      visiting.add(p);
      try {
        LEntry c = p.content;
        if (c instanceof LStruct s) processStruct(s, s.layout, p, layers);
        else {
          placeBlock(p, layers);
          if (c != null) placeRemaining(c, layers);
        }
      } finally {
        visiting.remove(p);
      }
    }

    void placeRemaining(LEntry e, List<LayoutItem.Layer> layers) {
      if (e instanceof Placeable p) {
        if (!claimed.contains(p)) placeUnit(p, layers);
      } else if (e instanceof LArray a) {
        for (LEntry it : a.items) if (it != null) placeRemaining(it, layers);
      } else if (e instanceof LStruct s) {
        processStruct(s, s.layout, null, layers);
      }
    }

    void processStruct(
        LStruct s, LayoutItem[] items, Placeable self, List<LayoutItem.Layer> inherited) {
      if (items != null && items.length > 0) {
        List<Placeable> mine = new ArrayList<>();
        Set<Placeable> mineSet = Collections.newSetFromMap(new IdentityHashMap<>());
        claimItems(s, items, mine, mineSet);
        boolean hasThis = false;
        for (LayoutItem item : items) if (item.isThis()) hasThis = true;
        if (self != null && !hasThis) placeBlock(self, inherited);
        placeItems(s, items, self, inherited, mineSet);
        for (Placeable p : mine) claimed.remove(p);
        if (self != null) placeBlock(self, inherited);
      } else if (self != null) placeBlock(self, inherited);
      for (LEntry e : s.fields.values()) placeRemaining(e, inherited);
    }

    /**
     * Claims every placeable the items name, so no other unit places it first; group items claim
     * what their items name in every element of their array.
     */
    void claimItems(LEntry s, LayoutItem[] items, List<Placeable> mine, Set<Placeable> mineSet) {
      for (LayoutItem item : items) {
        if (item.isThis()) continue;
        List<LEntry> reached = resolvePath(s, item.path());
        if (item.group() != null) {
          for (LEntry el : elementsOf(reached)) claimItems(el, item.group(), mine, mineSet);
          continue;
        }
        for (LEntry e : reached) {
          if (e instanceof Placeable p && !claimed.contains(p) && !p.placed()) {
            claimed.add(p);
            mine.add(p);
            mineSet.add(p);
          }
        }
      }
    }

    /** Places the items in order ({@code self} is what {@code this} names). */
    void placeItems(
        LEntry s,
        LayoutItem[] items,
        Placeable self,
        List<LayoutItem.Layer> inherited,
        Set<Placeable> mineSet) {
      for (LayoutItem item : items) {
        List<LayoutItem.Layer> layers =
            item.layers().length > 0 ? List.of(item.layers()) : inherited;
        if (item.isThis()) {
          if (self != null) placeBlock(self, layers);
          continue;
        }
        List<LEntry> reached = resolvePath(s, item.path());
        if (item.group() != null) {
          // For each element, its items in order. An element that is itself a target comes
          // first, like `this` in a unit, unless an item names it.
          boolean namesThis = false;
          for (LayoutItem g : item.group()) if (g.isThis()) namesThis = true;
          for (LEntry el : elementsOf(reached)) {
            Placeable elSelf = el instanceof Placeable p ? p : null;
            if (elSelf != null && !namesThis) placeBlock(elSelf, layers);
            placeItems(el, item.group(), elSelf, layers, mineSet);
          }
          continue;
        }
        for (LEntry e : reached) {
          if (e instanceof Placeable p) {
            if (mineSet.contains(p)) {
              claimed.remove(p);
              placeUnit(p, layers);
            } else if (!claimed.contains(p)) placeUnit(p, layers);
          } else placeRemaining(e, layers);
        }
      }
    }
  }

  /** The elements of the arrays a group's path reaches (through pointer targets). */
  static List<LEntry> elementsOf(List<LEntry> reached) {
    List<LEntry> out = new ArrayList<>();
    for (LEntry e0 : reached) {
      LEntry e = e0;
      if (e instanceof Placeable p) {
        if (p.content == null) continue;
        e = p.content;
      }
      if (e instanceof LArray a) {
        for (LEntry it : a.items) if (it != null) out.add(it);
      }
    }
    return out;
  }

  /** Entries a layout path reaches from struct {@code s} (descending through placeables' contents). */
  static List<LEntry> resolvePath(LEntry s, String[] path) {
    List<LEntry> cur = List.of(s);
    for (String seg : path) {
      List<LEntry> next = new ArrayList<>();
      for (LEntry e0 : cur) {
        LEntry e = e0;
        if (e instanceof Placeable p) {
          if (p.content == null) continue;
          e = p.content;
        }
        if (seg.equals("*")) {
          if (e instanceof LArray a) for (LEntry it : a.items) if (it != null) next.add(it);
        } else if (e instanceof LStruct st) {
          LEntry f = st.fields.get(seg);
          if (f != null) next.add(f);
        }
      }
      cur = next;
    }
    return cur;
  }

  /** Assigns positions to every block of the region. */
  static void layoutRegion(Region region) {
    if (region.sticky != null && region.sticky.origRootSize() >= 0) {
      stickyLayout(region, region.sticky);
      return;
    }
    for (Placeable p : region.placeables) p.block.pos = -1;
    Engine engine = new Engine(region);
    for (Placeable p : region.placeables) if (p.fixed != null) engine.placeFixed(p);
    engine.placeAll();
  }

  // ── sticky layout (view commits) ──────────────────────────────────────────────

  /** Runs the default engine on scratch positions, reporting every placement to {@code hook}. */
  private static void dryRun(Region region, PlaceHook hook) {
    int[] saved = new int[region.placeables.size()];
    for (int i = 0; i < saved.length; i++) saved[i] = region.placeables.get(i).block.pos;
    for (Placeable p : region.placeables) p.block.pos = p.fixed != null ? (int) (long) p.fixed : -1;
    Engine engine = new Engine(region);
    engine.hook = hook;
    engine.placeAll();
    for (int i = 0; i < saved.length; i++) region.placeables.get(i).block.pos = saved[i];
  }

  private static boolean residuesHold(List<long[]> residues, long pos) {
    for (long[] r : residues) if (Math.floorMod(pos, r[0]) != r[1]) return false;
    return true;
  }

  private static boolean fits(Placeable p, long align, List<long[]> residues, long pos) {
    if (!residuesHold(residues, pos)) return false;
    if (align > 1 && pos % align != 0) return false;
    if (p.modulus > 1 && Math.floorMod(pos, p.modulus) != Math.floorMod(p.remainder, p.modulus)) {
      return false;
    }
    return true;
  }

  private static void stickyLayout(Region region, StickyPolicy policy) {
    // Item alignments and residues of each placeable's default placement: a target keeps its
    // original position only where they still hold.
    Map<Placeable, Long> aligns = new IdentityHashMap<>();
    Map<Placeable, List<long[]>> residues = new IdentityHashMap<>();
    List<Placeable> order = new ArrayList<>();
    Set<Placeable> seen = Collections.newSetFromMap(new IdentityHashMap<>());
    dryRun(
        region,
        (p, layers) -> {
          if (!aligns.containsKey(p)) {
            long a = p.block.align;
            for (LayoutItem.Layer l : layers) {
              if (l.kind() == LayoutItem.Kind.ALIGN && !l.residue()) a = lcm(a, l.n());
            }
            aligns.put(p, a);
            residues.put(p, Engine.residues(region, layers));
          }
          if (seen.add(p)) order.add(p);
        });
    for (Placeable p : region.placeables) p.block.pos = -1;
    Engine engine = new Engine(region);
    for (Placeable p : region.placeables) if (p.fixed != null) engine.placeFixed(p);

    int origRoot = policy.origRootSize();
    if (policy.grow() == Grow.ERROR && region.root.size != origRoot) {
      throw new YaffleException(
          ErrorCode.DERIVE,
          "the base grew from " + origRoot + " to " + region.root.size + " bytes (grow: \"error\")");
    }
    List<Placeable> old = new ArrayList<>();
    for (Placeable p : region.placeables) if (p.orig >= 0 && p.fixed == null) old.add(p);
    old.sort((a, b) -> Integer.compare(a.orig, b.orig));
    Set<Placeable> toEnd = new LinkedHashSet<>();
    long origCursor = origRoot;
    long origEnd = policy.origSize() >= 0 ? policy.origSize() : origRoot;
    for (Placeable p : old) origEnd = Math.max(origEnd, (long) p.orig + Math.max(p.origSize, 0));

    for (Placeable p : old) {
      int size = p.block.size;
      int origSize = p.origSize >= 0 ? p.origSize : size;
      boolean grows = size > origSize;
      if (policy.grow() == Grow.ERROR && size != origSize) {
        throw new YaffleException(
            ErrorCode.DERIVE,
            p.name + " changed size from " + origSize + " to " + size + " (grow: \"error\")");
      }
      long align = aligns.getOrDefault(p, p.block.align);
      List<long[]> res = residues.getOrDefault(p, List.of());
      if (grows && (policy.grow() == Grow.DEFAULT || policy.grow() == Grow.APPEND)) {
        toEnd.add(p);
        origCursor = Math.max(origCursor, (long) p.orig + origSize);
        continue;
      }
      long extra = Math.max(0, p.orig - alignUp(origCursor, align));
      long pos;
      boolean keep = fits(p, align, res, p.orig);
      if (size == 0 && origSize == 0 && keep && policy.grow() != Grow.SPLICE) {
        // An empty target overlaps nothing: it keeps its offset, which may equal
        // the start of a target placed just before it (e.g. empty lists).
        p.block.pos = p.orig;
        continue;
      }
      if (policy.grow() == Grow.SPLICE) {
        pos =
            engine.cursor == origCursor && keep
                ? p.orig
                : engine.findPos(p, align, res, engine.cursor + extra);
      } else if (engine.cursor <= p.orig && keep) {
        pos = p.orig;
        boolean clash = false;
        for (Range r : engine.reserved) if (pos < r.end && r.start < pos + size) clash = true;
        if (clash) pos = engine.findPos(p, align, res, pos);
      } else if (policy.grow() == Grow.APPEND || !keep) {
        toEnd.add(p);
        origCursor = Math.max(origCursor, (long) p.orig + origSize);
        continue;
      } else {
        pos = engine.findPos(p, align, res, engine.cursor + extra);
      }
      p.block.pos = (int) pos;
      engine.cursor = Math.max(engine.cursor, pos + size);
      origCursor = Math.max(origCursor, (long) p.orig + origSize);
    }
    engine.cursor = Math.max(engine.cursor, policy.grow() == Grow.SPLICE ? engine.cursor : origEnd);
    Set<Placeable> rest = Collections.newSetFromMap(new IdentityHashMap<>());
    rest.addAll(toEnd);
    for (Placeable p : region.placeables) if (!p.placed()) rest.add(p);
    for (Placeable p : order) {
      if (!rest.contains(p) || p.placed()) continue;
      long align = aligns.getOrDefault(p, p.block.align);
      List<long[]> res = residues.getOrDefault(p, List.of());
      p.block.pos = (int) engine.findPos(p, align, res, engine.cursor);
      engine.cursor = (long) p.block.pos + p.block.size;
    }
    for (Placeable p : region.placeables) {
      if (!p.placed()) {
        p.block.pos = (int) engine.findPos(p, p.block.align, engine.cursor);
        engine.cursor = (long) p.block.pos + p.block.size;
      }
    }
  }
}
