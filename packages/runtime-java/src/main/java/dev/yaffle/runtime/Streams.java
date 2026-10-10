package dev.yaffle.runtime;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.function.IntPredicate;
import java.util.function.IntUnaryOperator;
import java.util.function.ToIntFunction;

/**
 * Streams ({@code T x from …}): joining and slicing on read; on write, splitting an
 * encoded stream back into its pieces and assembling slice carriers.
 */
public final class Streams {
  private Streams() {}

  /** Access to the pieces of a joined stream ({@code T x from arr[*].piece}) in generated code. */
  public interface Pieces<E> {
    /** The element's piece bytes (hidden or not), or null. */
    byte[] piece(E e);

    /** The element's size field as given in the input (null if absent, or no size field). */
    Long size(E e);

    /** True if the element has a size field that measures the piece. */
    boolean hasSizeField();

    /** A shallow copy of {@code base} (null: a new element) with the piece set (and the size field cleared). */
    E with(E base, byte[] piece, boolean clearSize);
  }

  /**
   * {@code @split(fit)}: element k's encoded form must fit before element k+1's offset.
   *
   * @param offset element k's offset
   * @param size encoded size of an element
   */
  public record Fit<E>(IntUnaryOperator offset, ToIntFunction<E> size) {}

  public static byte[] join(List<byte[]> pieces) {
    if (pieces.size() == 1) return pieces.get(0);
    int n = 0;
    for (byte[] p : pieces) n += p.length;
    byte[] out = new byte[n];
    int at = 0;
    for (byte[] p : pieces) {
      System.arraycopy(p, 0, out, at, p.length);
      at += p.length;
    }
    return out;
  }

  /** {@code raw[a..b]} (end exclusive; {@code end < 0}: to the end). */
  public static byte[] slice(byte[] s, long start, long end) {
    long e = end < 0 ? s.length : end;
    if (start < 0 || e > s.length || start > e) {
      throw new YaffleException(
          ErrorCode.EOF,
          "stream slice [" + start + ", " + e + ") is outside the stream of " + s.length + " bytes");
    }
    return Arrays.copyOfRange(s, (int) start, (int) e);
  }

  /** Splits {@code data} into pieces of the given sizes, which must cover it exactly. */
  public static List<byte[]> splitBySizes(byte[] data, int[] sizes) {
    List<byte[]> out = new ArrayList<>(sizes.length);
    int at = 0;
    for (int n : sizes) {
      if (n < 0 || at + (long) n > data.length) {
        throw new YaffleException(
            ErrorCode.DERIVE, "piece sizes exceed the stream length " + data.length);
      }
      out.add(Arrays.copyOfRange(data, at, at + n));
      at += n;
    }
    if (at != data.length) {
      throw new YaffleException(
          ErrorCode.DERIVE, "piece sizes cover " + at + " of " + data.length + " stream bytes");
    }
    return out;
  }

  /**
   * Write side of {@code T x from arr[*].piece}: the encoded stream is split into the elements'
   * pieces. Piece sizes given in the input win; otherwise the {@code fit} policy picks, for element
   * k, the longest piece whose encoded element fits before element k+1's offset. A piece equal to
   * the element's original value keeps that array, so codec reuse still recognizes it.
   */
  public static <E> List<E> splitStream(List<E> els, byte[] data, Pieces<E> pieces, Fit<E> fit) {
    boolean sized = els != null && pieces.hasSizeField();
    if (sized && (fit == null || (!els.isEmpty() && allSized(els, pieces)))) {
      int[] sizes = new int[els.size()];
      for (int i = 0; i < sizes.length; i++) {
        Long v = pieces.size(Rt.nonNull(els.get(i), "an element"));
        if (v == null || v < 0 || v > Integer.MAX_VALUE) {
          throw new YaffleException(
              ErrorCode.INPUT, "split policy \"sizes\" needs every piece's size in the input");
        }
        sizes[i] = (int) (long) v;
      }
      List<byte[]> parts = splitBySizes(data, sizes);
      List<E> out = new ArrayList<>(els.size());
      for (int i = 0; i < sizes.length; i++) out.add(withPiece(els.get(i), parts.get(i), pieces, false));
      return out;
    }
    if (fit == null) {
      throw new YaffleException(
          ErrorCode.INPUT, "cannot split the stream: give every piece's size in the input");
    }
    List<E> out = new ArrayList<>();
    int pos = 0;
    for (int k = 0; pos < data.length; k++) {
      E base = els != null && k < els.size() ? els.get(k) : null;
      int cap = fit.offset().applyAsInt(k + 1) - fit.offset().applyAsInt(k);
      int at = pos;
      IntPredicate fits =
          n -> {
            try {
              E e = pieces.with(base, Arrays.copyOfRange(data, at, at + n), true);
              return fit.size().applyAsInt(e) <= cap;
            } catch (YaffleException e) {
              if (e.code() == ErrorCode.RANGE) return false;
              throw e;
            }
          };
      // The longest piece that fits: the whole rest, or else found by binary search.
      int left = data.length - pos;
      int n = left;
      if (!fits.test(left)) {
        int lo = 0;
        int hi = left;
        while (hi - lo > 1) {
          int mid = (lo + hi) >>> 1;
          if (fits.test(mid)) lo = mid;
          else hi = mid;
        }
        n = lo;
      }
      if (n == 0) {
        throw new YaffleException(
            ErrorCode.OVERLAP, "stream piece " + k + " does not fit its block of " + cap + " bytes");
      }
      out.add(withPiece(base, Arrays.copyOfRange(data, pos, pos + n), pieces, true));
      pos += n;
    }
    return out;
  }

  private static <E> boolean allSized(List<E> els, Pieces<E> pieces) {
    for (E e : els) if (e == null || pieces.size(e) == null) return false;
    return true;
  }

  /** {@code base} with {@code piece}, keeping the original array when the bytes are the same. */
  private static <E> E withPiece(E base, byte[] piece, Pieces<E> pieces, boolean clearSize) {
    byte[] orig = base != null ? pieces.piece(base) : null;
    boolean keep = orig != null && Arrays.equals(orig, piece);
    return pieces.with(base, keep ? orig : piece, clearSize);
  }

  /**
   * The bytes of a slice carrier: zero-filled, {@code length} bytes (or, when negative, up to the
   * largest slice end), with every slice's encoding written at its start. Encodings that don't fit
   * their slice, slices outside the field and overlapping slices that disagree are DERIVE errors.
   * {@code ends[i] < 0}: the slice runs to the end.
   */
  public static byte[] assembleSlices(long length, long[] starts, long[] ends, byte[][] parts) {
    long max = 0;
    for (int i = 0; i < parts.length; i++) {
      long s = starts[i];
      long e = ends[i] >= 0 ? ends[i] : length >= 0 ? length : s + parts[i].length;
      if (s < 0 || e < s) {
        throw new YaffleException(ErrorCode.RANGE, "invalid slice [" + s + ", " + e + ")");
      }
      if (parts[i].length > e - s) {
        throw new YaffleException(
            ErrorCode.DERIVE,
            "a slice's content of " + parts[i].length + " bytes does not fit [" + s + ", " + e + ")");
      }
      max = Math.max(max, e);
    }
    long n = length >= 0 ? length : max;
    if (max > n) {
      throw new YaffleException(
          ErrorCode.DERIVE, "a slice ends at " + max + ", after the field's " + n + " bytes");
    }
    if (n > Integer.MAX_VALUE - 8) throw Ints.range("slice carrier too large: " + n);
    byte[] out = new byte[(int) n];
    boolean[] set = new boolean[(int) n];
    for (int i = 0; i < parts.length; i++) {
      int s = (int) starts[i];
      byte[] p = parts[i];
      for (int k = 0; k < p.length; k++) {
        int at = s + k;
        if (set[at] && out[at] != p[k]) {
          throw new YaffleException(
              ErrorCode.DERIVE, "overlapping slices disagree at byte " + at + " of the field");
        }
        out[at] = p[k];
        set[at] = true;
      }
    }
    return out;
  }
}
