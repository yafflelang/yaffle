package dev.yaffle.runtime;

import java.util.ArrayList;
import java.util.BitSet;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;
import java.util.function.IntFunction;

/**
 * The bytes of a lazy byte space of a view, loaded on demand: a random-access source read in
 * blocks, a {@code @ranged} codec region decoded in blocks, or a virtual stream whose pieces are
 * decoded when touched.
 *
 * <p>{@link #buf} has the space's full length and is filled as readers {@link #ensure} ranges.
 * Readers keep reading the array directly, so a store costs one null check per primitive read
 * when there is none. Loads are reported to the owning space (it mirrors them into its patched
 * copy, see {@link ViewSpace}).
 */
abstract class Store {
  /** Block size of block-loaded stores. */
  static final int BLOCK = 1 << 16;

  /** The space's bytes: valid where loaded. */
  final byte[] buf;
  /** Called after a range was loaded: {@code (start, length)}. */
  Loaded listener;

  @FunctionalInterface
  interface Loaded {
    void loaded(int start, int len);
  }

  Store(int length) {
    this.buf = new byte[length];
  }

  /** Makes {@code buf[start, start + len)} valid. */
  abstract void ensure(int start, int len);

  /**
   * Makes at least the byte at {@code i} valid (when {@code i < limit}) and returns the end of the
   * valid run starting there, at most {@code limit}. Lets scans for terminators load piecewise.
   */
  abstract int ensureFrom(int i, int limit);

  final void ensureAll() {
    ensure(0, buf.length);
  }

  final void notifyLoaded(int start, int len) {
    if (listener != null && len > 0) listener.loaded(start, len);
  }

  // ── fixed-size blocks ──────────────────────────────────────────────────────────

  /** A store loaded in blocks of {@link #BLOCK} bytes; subclasses fill runs of missing blocks. */
  abstract static class Blocks extends Store {
    private final BitSet loaded = new BitSet();

    Blocks(int length) {
      super(length);
    }

    /**
     * Fills the given runs ({@code {start, length}}, block-aligned except at the end) into {@link
     * #buf}. Runs are passed together so sources can fetch them concurrently.
     */
    abstract void fill(List<int[]> runs);

    @Override
    final void ensure(int start, int len) {
      if (len <= 0) return;
      int s = Math.max(0, start);
      int e = (int) Math.min((long) start + len, buf.length);
      if (s >= e) return;
      int b0 = s / BLOCK;
      int b1 = (e - 1) / BLOCK;
      int first = loaded.nextClearBit(b0);
      if (first > b1) return;
      List<int[]> runs = new ArrayList<>();
      int b = first;
      while (b <= b1) {
        int stop = loaded.nextSetBit(b);
        if (stop < 0 || stop > b1 + 1) stop = b1 + 1;
        int rs = b * BLOCK;
        int re = (int) Math.min((long) stop * BLOCK, buf.length);
        runs.add(new int[] {rs, re - rs});
        b = loaded.nextClearBit(stop);
      }
      fill(runs);
      for (int[] r : runs) {
        loaded.set(r[0] / BLOCK, (r[0] + r[1] - 1) / BLOCK + 1);
        notifyLoaded(r[0], r[1]);
      }
    }

    @Override
    final int ensureFrom(int i, int limit) {
      int lim = Math.min(limit, buf.length);
      if (i >= lim) return lim;
      int b = i / BLOCK;
      if (!loaded.get(b)) ensure(b * BLOCK, BLOCK);
      int stop = loaded.nextClearBit(b);
      return (int) Math.min((long) stop * BLOCK, lim);
    }
  }

  // ── random-access sources ──────────────────────────────────────────────────────

  /** A random-access source ({@link Source}) or an async one (awaited on the calling thread). */
  static final class FromSource extends Blocks {
    private final Source sync;
    private final AsyncSource async;

    FromSource(Source s, int length) {
      super(length);
      this.sync = s;
      this.async = null;
    }

    FromSource(AsyncSource s, int length) {
      super(length);
      this.sync = null;
      this.async = s;
    }

    @Override
    void fill(List<int[]> runs) {
      if (sync != null) {
        for (int[] r : runs) copy(r, sync.read(r[0], r[1]));
        return;
      }
      // Every missing run is requested at once; the futures are awaited together (on a virtual
      // thread, waiting parks it).
      List<CompletableFuture<byte[]>> fs = new ArrayList<>(runs.size());
      for (int[] r : runs) fs.add(async.read(r[0], r[1]));
      for (int k = 0; k < runs.size(); k++) copy(runs.get(k), await(fs.get(k)));
    }

    private void copy(int[] r, byte[] data) {
      if (data == null || data.length < r[1]) {
        throw new YaffleException(
            ErrorCode.EOF,
            "the source returned " + (data == null ? "nothing" : data.length + " bytes")
                + " for " + r[1] + " bytes at 0x" + Integer.toHexString(r[0]),
            r[0]);
      }
      System.arraycopy(data, 0, buf, r[0], r[1]);
    }

    /** Waits for {@code f}; rethrows the cause of a failure. */
    private static <T> T await(CompletableFuture<T> f) {
      try {
        return f.get();
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        throw new CompletionException(e);
      } catch (ExecutionException e) {
        Throwable c = e.getCause();
        if (c instanceof RuntimeException r) throw r;
        if (c instanceof Error err) throw err;
        throw new CompletionException(c);
      }
    }
  }

  // ── @ranged codec regions ──────────────────────────────────────────────────────

  /** Decodes {@code (input, position)} with a ranged codec. */
  @FunctionalInterface
  interface RangedDecoder {
    byte[] decode(byte[] input, long position);
  }

  /**
   * The decoded side of a {@code @ranged} codec over the encoded window {@code [start, start +
   * length)} of another space: blocks are decoded as they are read (the codec gets each slice with
   * its position in the region).
   */
  static final class Ranged extends Blocks {
    private final ViewSpace parent;
    private final int start;
    private final RangedDecoder dec;
    private final long at;

    Ranged(ViewSpace parent, int start, int length, RangedDecoder dec, long at) {
      super(length);
      this.parent = parent;
      this.start = start;
      this.dec = dec;
      this.at = at;
    }

    @Override
    void fill(List<int[]> runs) {
      for (int[] r : runs) {
        byte[] in = parent.bytes(start + r[0], start + r[0] + r[1]);
        byte[] out = dec.decode(in, r[0]);
        if (out == null || out.length != r[1]) {
          throw new YaffleException(
              ErrorCode.CODEC,
              "ranged codec returned " + (out == null ? "null" : out.length + " bytes") + " for "
                  + r[1] + " input bytes",
              at);
        }
        System.arraycopy(out, 0, buf, r[0], r[1]);
      }
    }
  }

  // ── virtual streams of pieces ───────────────────────────────────────────────────

  /**
   * A virtual stream joining pieces whose decoded lengths are known up front (from size fields):
   * a piece is decoded only when a read touches it.
   */
  static final class Pieces extends Store {
    /** Start offset of piece k (k = 0..n), {@code starts[n]} = total length. */
    private final int[] starts;
    private final IntFunction<byte[]> piece;
    private final BitSet loaded = new BitSet();

    Pieces(int[] starts, IntFunction<byte[]> piece) {
      super(starts[starts.length - 1]);
      this.starts = starts.clone();
      this.piece = piece;
    }

    /** The piece holding offset {@code i} (the last piece ending after it). */
    private int pieceAt(int i) {
      int lo = 0;
      int hi = starts.length - 2;
      while (lo < hi) {
        int mid = (lo + hi + 1) >>> 1;
        if (starts[mid] <= i) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    }

    private void load(int k) {
      if (loaded.get(k)) return;
      int len = starts[k + 1] - starts[k];
      byte[] b = piece.apply(k);
      if (b == null || b.length != len) {
        throw new YaffleException(
            ErrorCode.DERIVE,
            "stream piece " + k + " has " + (b == null ? "no" : String.valueOf(b.length))
                + " bytes, its size field says " + len);
      }
      System.arraycopy(b, 0, buf, starts[k], len);
      loaded.set(k);
      notifyLoaded(starts[k], len);
    }

    @Override
    void ensure(int start, int len) {
      if (len <= 0 || starts.length < 2) return;
      int s = Math.max(0, start);
      int e = (int) Math.min((long) start + len, buf.length);
      if (s >= e) return;
      int k1 = pieceAt(e - 1);
      for (int k = pieceAt(s); k <= k1; k++) {
        if (starts[k + 1] > starts[k]) load(k);
      }
    }

    @Override
    int ensureFrom(int i, int limit) {
      int lim = Math.min(limit, buf.length);
      if (i >= lim) return lim;
      int k = pieceAt(i);
      load(k);
      int stop = k + 1;
      while (stop < starts.length - 1 && loaded.get(stop)) stop++;
      return Math.min(starts[stop], lim);
    }
  }
}
