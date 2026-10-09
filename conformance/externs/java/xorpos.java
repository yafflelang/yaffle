package dev.yaffle.conformance.externs;

import dev.yaffle.runtime.Codec;
import dev.yaffle.runtime.CodecCtx;

/**
 * {@code extern codec xorpos(u8 key) @ranged}: byte i of the encoded region is XORed with {@code
 * (key + i) & 0xff}, where i counts from the start of the whole region. A slice decodes on its
 * own only when it is given its position ({@link CodecCtx#position()}).
 */
public final class XorPos implements Codec {
  public static final XorPos XORPOS = new XorPos();

  private XorPos() {}

  private static byte[] apply(byte[] input, CodecCtx ctx) {
    long key = ctx.longArg(0);
    if (key < 0 || key > 255) throw new IllegalArgumentException("codec key must be a u8, got " + key);
    long pos = ctx.position();
    byte[] out = new byte[input.length];
    for (int i = 0; i < input.length; i++) out[i] = (byte) (input[i] ^ ((key + pos + i) & 0xff));
    return out;
  }

  @Override
  public byte[] decode(byte[] input, CodecCtx ctx) {
    return apply(input, ctx);
  }

  @Override
  public byte[] encode(byte[] input, CodecCtx ctx) {
    return apply(input, ctx);
  }
}
