package dev.yaffle.runtime;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * A byte space of a view: the view's source, a codec's decoded output, or a stream.
 *
 * <p>A space is either fully present (an array) or lazy: a {@link Store} loads its bytes on
 * demand (blocks of a random-access source, blocks of a {@code @ranged} codec region, the pieces
 * of a stream a read touches). In-place patches of the source go into a working copy, so the
 * original bytes stay unchanged until {@code commit()}; bytes a lazy store loads later are
 * mirrored into that copy.
 */
final class ViewSpace {
  private static final AtomicInteger IDS = new AtomicInteger();

  /** An in-place patch of {@code length} bytes at {@code at}, made by setting a field of {@code node}. */
  record InPlace(int at, int length, ViewNode node) {}

  final int id = IDS.incrementAndGet();
  final ViewRoot root;
  /** The original bytes (in a lazy space: valid where loaded). */
  final byte[] orig;
  /** The current bytes (the original until the first patch). */
  byte[] cur;
  /** Loads the bytes of a lazy space, or null. */
  final Store store;
  /** Offset errors inside this space report (the encoded window of a region), or -1. */
  final long outer;
  final List<InPlace> patches = new ArrayList<>();
  /** Bumped by every patch: cached scans and lazy values re-read. */
  int version;
  /** True for the view's source; decoded regions and streams are edited structurally. */
  final boolean source;

  ViewSpace(ViewRoot root, byte[] bytes, boolean source) {
    this(root, bytes, source, -1);
  }

  ViewSpace(ViewRoot root, byte[] bytes, boolean source, long outer) {
    this.root = root;
    this.orig = bytes;
    this.cur = bytes;
    this.store = null;
    this.outer = outer;
    this.source = source;
  }

  /** A lazy space. */
  ViewSpace(ViewRoot root, Store store, boolean source, long outer) {
    this.root = root;
    this.orig = store.buf;
    this.cur = store.buf;
    this.store = store;
    this.outer = outer;
    this.source = source;
    store.listener =
        (start, len) -> {
          if (cur != orig) System.arraycopy(orig, start, cur, start, len);
        };
  }

  int length() {
    return orig.length;
  }

  /** Makes {@code [start, start + len)} present (lazy spaces). */
  void ensure(int start, int len) {
    if (store != null) store.ensure(start, len);
  }

  /** Current bytes {@code [start, end)} (a copy). */
  byte[] bytes(int start, int end) {
    if (start < 0 || end > cur.length || start > end) {
      throw new YaffleException(
          ErrorCode.EOF,
          "range [0x" + Integer.toHexString(start) + ", 0x" + Integer.toHexString(end)
              + ") is outside the data",
          outer >= 0 ? outer : start);
    }
    ensure(start, end - start);
    return Arrays.copyOfRange(cur, start, end);
  }

  /** The original bytes, all of them (loads a lazy space completely). */
  byte[] origAll() {
    if (store != null) store.ensureAll();
    return orig;
  }

  void patch(int at, byte[] data, ViewNode node) {
    if (at < 0 || at + data.length > orig.length) {
      throw new YaffleException(ErrorCode.RANGE, "patch outside the data");
    }
    ensure(at, data.length);
    if (cur == orig) cur = orig.clone();
    System.arraycopy(data, 0, cur, at, data.length);
    patches.add(new InPlace(at, data.length, node));
    version++;
  }

  /** A reader over the current bytes. */
  Reader reader(int pos, int base, int end, boolean strict) {
    Reader r = new Reader(cur, strict, outer, store);
    r.pos = pos;
    r.base = base;
    r.end = end;
    r.maxEnd = pos;
    return r;
  }
}
