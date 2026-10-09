package dev.yaffle.runtime;

import java.util.Arrays;

/**
 * An edit of a view's source: at {@code at} (original coordinates), {@code remove} bytes are
 * replaced by {@code insert}.
 *
 * @param at offset in the original bytes
 * @param remove bytes removed there
 * @param insert bytes inserted there
 */
public record Patch(int at, int remove, byte[] insert) {
  public Patch {
    insert = insert.clone();
  }

  @Override
  public byte[] insert() {
    return insert.clone();
  }

  @Override
  public boolean equals(Object o) {
    return o instanceof Patch p && at == p.at && remove == p.remove && Arrays.equals(insert, p.insert);
  }

  @Override
  public int hashCode() {
    return (at * 31 + remove) * 31 + Arrays.hashCode(insert);
  }

  @Override
  public String toString() {
    return "Patch[at=" + at + ", remove=" + remove + ", insert=" + insert.length + " bytes]";
  }

  /** Applies patches (sorted by {@code at}, non-overlapping, in original coordinates). */
  public static byte[] apply(byte[] orig, java.util.List<Patch> patches) {
    long size = orig.length;
    for (Patch p : patches) size += p.insert.length - p.remove;
    byte[] out = new byte[(int) size];
    int o = 0;
    int n = 0;
    for (Patch p : patches) {
      System.arraycopy(orig, o, out, n, p.at - o);
      n += p.at - o;
      System.arraycopy(p.insert, 0, out, n, p.insert.length);
      n += p.insert.length;
      o = p.at + p.remove;
    }
    System.arraycopy(orig, o, out, n, orig.length - o);
    return out;
  }
}
