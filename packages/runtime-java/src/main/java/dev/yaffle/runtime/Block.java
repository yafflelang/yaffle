package dev.yaffle.runtime;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * A contiguous run of encoded bytes: a region's own inline bytes, or one placeable's. Large byte
 * arrays are referenced rather than copied.
 */
public final class Block {
  /** {@code data[0, len)} at offset {@code at} of the block; {@code prov}: copied unchanged from a source. */
  record Part(int at, byte[] data, int len, Provenance prov) {}

  /** Identifies an original byte space (a view's source) and an offset in it. */
  public record Provenance(Object space, int offset) {}

  /** Byte arrays at least this long are referenced instead of copied. */
  private static final int SHARE = 512;

  private final List<Part> parts = new ArrayList<>();
  private byte[] cur = new byte[64];
  private int curLen;
  private int curAt;
  int size;
  /** Required start alignment (from {@code align} layers inside, relative to the block start). */
  long align = 1;
  /** The base-relative start when known before layout (fixed placements), or null. */
  Integer fixedAt;
  /** Base-relative position, assigned by layout (-1 until then). The region root is at 0. */
  int pos = -1;
  final Region region;

  Block(Region region) {
    this.region = region;
  }

  private void ensure(int n) {
    if (curLen + n <= cur.length) return;
    int cap = cur.length * 2;
    while (cap < curLen + n) cap *= 2;
    cur = Arrays.copyOf(cur, cap);
  }

  private void seal() {
    if (curLen > 0) {
      parts.add(new Part(curAt, cur, curLen, null));
      cur = new byte[64];
      curLen = 0;
    }
    curAt = size;
  }

  void u8(int v) {
    ensure(1);
    cur[curLen++] = (byte) v;
    size++;
  }

  /** Writes the low {@code n} bytes of {@code v}. */
  void uint(int n, long v, boolean le) {
    ensure(n);
    Bytes.writeUInt(cur, curLen, n, v, le);
    curLen += n;
    size += n;
  }

  /** Appends bytes. Large arrays are referenced, not copied (the caller must not modify them). */
  void bytes(byte[] b, Provenance prov) {
    if (b.length >= SHARE || prov != null) {
      seal();
      if (b.length > 0) parts.add(new Part(size, b, b.length, prov));
      size += b.length;
      curAt = size;
      return;
    }
    ensure(b.length);
    System.arraycopy(b, 0, cur, curLen, b.length);
    curLen += b.length;
    size += b.length;
  }

  void fill(int n, Fill fill) {
    if (fill == Fill.ZERO && n >= SHARE) {
      bytes(new byte[n], null);
      return;
    }
    ensure(n);
    for (int i = 0; i < n; i++) cur[curLen + i] = fill.byteAt(i);
    curLen += n;
    size += n;
  }

  /** All parts in order (the current buffer included). */
  List<Part> allParts() {
    if (curLen == 0) return parts;
    List<Part> all = new ArrayList<>(parts);
    all.add(new Part(curAt, cur, curLen, null));
    return all;
  }
}
