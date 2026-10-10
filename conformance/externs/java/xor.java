package org.yafflelang.conformance.externs;

import org.yafflelang.runtime.Codec;
import org.yafflelang.runtime.CodecCtx;

/**
 * {@code extern codec xor(u8 key) @ranged}: every byte XOR {@code key}. Its own inverse, and
 * position independent, so any slice decodes on its own.
 */
public final class Xor implements Codec {
  public static final Xor XOR = new Xor();

  private Xor() {}

  static int key(CodecCtx ctx) {
    long k = ctx.longArg(0);
    if (k < 0 || k > 255) throw new IllegalArgumentException("codec key must be a u8, got " + k);
    return (int) k;
  }

  static byte[] apply(byte[] input, CodecCtx ctx) {
    int key = key(ctx);
    byte[] out = new byte[input.length];
    for (int i = 0; i < input.length; i++) out[i] = (byte) (input[i] ^ key);
    return out;
  }

  @Override
  public byte[] decode(byte[] input, CodecCtx ctx) {
    byte[] out = apply(input, ctx);
    if (ctx.hasOutputSize() && ctx.outputSize() != out.length) {
      throw new IllegalArgumentException(
          "xor: decoded " + out.length + " bytes, expected " + ctx.outputSize());
    }
    return out;
  }

  @Override
  public byte[] encode(byte[] input, CodecCtx ctx) {
    return apply(input, ctx);
  }
}
