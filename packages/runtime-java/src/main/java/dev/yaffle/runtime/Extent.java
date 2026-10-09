package dev.yaffle.runtime;

import java.util.Arrays;

/**
 * Start and end of a field's encoding, for {@code sizeof}/{@code offsetof}/{@code bytesof}/{@code
 * encodedSize} on write. Generated writers create one per field that needs it before writing
 * anything, and bind it when the field is written; fixups read it after layout.
 */
public final class Extent {
  Block block;
  int start = -1;
  int end = -1;
  /** Byte length after each layer stage ({@code encodedSize(field, k)}); -1 = unknown. */
  private int[] stages = new int[0];
  /** Set for placed fields: the placeable that holds the field. */
  Placeable placeable;
  /** An empty placed array whose offset is written as 0 ({@code @nullable(empty)}). */
  boolean emptyIsNull;
  /** The plain encoding (before any codec), if a {@code via} layer recorded it. */
  byte[] plain;
  /** {@code this} of a base struct: the whole region. */
  Region regionOf;

  public int size() {
    if (regionOf != null) return regionOf.output != null ? regionOf.output.length : regionOf.root.size;
    if (placeable != null) return placeable.block.size;
    if (block == null) throw new YaffleException(ErrorCode.DERIVE, "size of a field that was not written");
    // While the field is still being written (its own size layer asks), the bytes so far.
    if (end < 0) return block.size - start;
    return end - start;
  }

  /** Base-relative position (valid after layout). */
  public int pos() {
    if (regionOf != null) return 0;
    if (placeable != null) {
      return emptyIsNull && placeable.block.size == 0 ? 0 : placeable.block.pos;
    }
    if (block == null || block.pos < 0) {
      throw new YaffleException(ErrorCode.DERIVE, "position used before layout");
    }
    return block.pos + start;
  }

  /** Records the byte length after layer stage {@code k}. */
  public void stage(int k, int size) {
    if (k >= stages.length) {
      int old = stages.length;
      stages = Arrays.copyOf(stages, k + 1);
      Arrays.fill(stages, old, k + 1, -1);
    }
    stages[k] = size;
  }

  /** Encoded size after {@code k} layer stages (0 = plain encoding). */
  public int stage(int k) {
    int v = k < stages.length ? stages[k] : -1;
    if (v < 0) {
      if (k >= stages.length && (end >= 0 || placeable != null)) return size();
      throw new YaffleException(ErrorCode.DERIVE, "encoded size at layer " + k + " is not available yet");
    }
    return v;
  }

  public void plain(byte[] p) {
    if (plain == null) plain = p;
  }

  /** The field's bytes in the finished region (content-dependent fixups only). */
  public byte[] bytes() {
    Region region = regionOf != null ? regionOf : (placeable != null ? placeable.block : block).region;
    byte[] out = region.output;
    if (out == null) {
      throw new YaffleException(
          ErrorCode.DERIVE, "bytes of a field used before its region was assembled");
    }
    int p = pos();
    return Arrays.copyOfRange(out, p, p + size());
  }

  /** The field's plain encoding (before layers). */
  public byte[] plainBytes() {
    if (plain != null) return plain;
    byte[] all = bytes();
    if (stages.length > 0 && stages[0] >= 0) return Arrays.copyOf(all, stages[0]);
    return all;
  }
}
