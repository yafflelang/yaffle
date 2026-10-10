package org.yafflelang.runtime;

import java.util.Arrays;

/**
 * What a codec gets besides its input: the codec's arguments in declaration order (as their Java
 * types, boxed: {@code u8} → Integer, {@code u64} → Long, {@code u8[n]} → byte[]), the decoded size
 * when an inner {@code @size} layer gives it, and for {@code @ranged} codecs the slice's offset
 * within the encoded region.
 *
 * @param args the codec's arguments
 * @param outputSize the decoded size, or -1 if unknown
 * @param position the slice's offset within the encoded region (0 for whole regions)
 */
public record CodecCtx(Object[] args, int outputSize, long position) {
  public CodecCtx {
    args = args.clone();
  }

  public static CodecCtx of(Object... args) {
    return new CodecCtx(args, -1, 0);
  }

  public CodecCtx withOutputSize(int n) {
    return new CodecCtx(args, n, position);
  }

  public boolean hasOutputSize() {
    return outputSize >= 0;
  }

  @Override
  public Object[] args() {
    return args.clone();
  }

  /** Argument {@code i}. */
  public Object arg(int i) {
    return args[i];
  }

  /** Argument {@code i} as a long (integers). */
  public long longArg(int i) {
    Object a = args[i];
    if (a instanceof Number n) return n.longValue();
    throw new IllegalArgumentException("argument " + i + " is not an integer: " + a);
  }

  /** Argument {@code i} as bytes. */
  public byte[] bytesArg(int i) {
    Object a = args[i];
    if (a instanceof byte[] b) return b;
    throw new IllegalArgumentException("argument " + i + " is not a byte array: " + a);
  }

  @Override
  public boolean equals(Object o) {
    return o instanceof CodecCtx c
        && Arrays.deepEquals(args, c.args)
        && outputSize == c.outputSize
        && position == c.position;
  }

  @Override
  public int hashCode() {
    return Arrays.deepHashCode(args) * 31 + outputSize * 17 + Long.hashCode(position);
  }

  @Override
  public String toString() {
    return "CodecCtx[args=" + Arrays.deepToString(args) + ", outputSize=" + outputSize
        + ", position=" + position + "]";
  }
}
