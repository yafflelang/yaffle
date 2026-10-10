package org.yafflelang.conformance.externs;

import org.yafflelang.runtime.Codec;
import org.yafflelang.runtime.CodecCtx;
import java.io.ByteArrayOutputStream;

/**
 * {@code extern codec rle}: run-length encoding as (count, byte) pairs with count 1..255.
 *
 * <ul>
 *   <li>decode: an odd input length or a zero count is an error; so is a decoded length that
 *       differs from {@code outputSize} when one is given.
 *   <li>encode: greedy, runs of at most 255 (deterministic, so conformance cases can predict it).
 * </ul>
 */
public final class Rle implements Codec {
  public static final Rle RLE = new Rle();

  private Rle() {}

  public static byte[] rleDecode(byte[] input, int len) {
    if (len % 2 != 0) throw new IllegalArgumentException("rle: odd input length " + len);
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    for (int i = 0; i < len; i += 2) {
      int n = input[i] & 0xff;
      if (n == 0) throw new IllegalArgumentException("rle: zero run length at " + i);
      for (int k = 0; k < n; k++) out.write(input[i + 1]);
    }
    return out.toByteArray();
  }

  public static byte[] rleEncode(byte[] input) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    int i = 0;
    while (i < input.length) {
      byte b = input[i];
      int n = 1;
      while (i + n < input.length && input[i + n] == b && n < 255) n++;
      out.write(n);
      out.write(b);
      i += n;
    }
    return out.toByteArray();
  }

  @Override
  public byte[] decode(byte[] input, CodecCtx ctx) {
    byte[] out = rleDecode(input, input.length);
    if (ctx.hasOutputSize() && ctx.outputSize() != out.length) {
      throw new IllegalArgumentException(
          "rle: decoded " + out.length + " bytes, expected " + ctx.outputSize());
    }
    return out;
  }

  @Override
  public byte[] encode(byte[] input, CodecCtx ctx) {
    return rleEncode(input);
  }
}
