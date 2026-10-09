package dev.yaffle.conformance.externs;

import dev.yaffle.runtime.Codec;
import dev.yaffle.runtime.CodecCtx;
import dev.yaffle.runtime.Decoded;
import java.io.ByteArrayOutputStream;

/**
 * {@code extern codec rlez @streaming}: {@code rle} pairs followed by a single 0x00 terminator.
 * It finds its own end: {@link #decodeStreaming} reports how many bytes it consumed (terminator
 * included). A missing terminator is an error.
 */
public final class RleZ implements Codec {
  public static final RleZ RLEZ = new RleZ();

  private RleZ() {}

  private static byte[] pairs(byte[] input, int len) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    for (int i = 0; i < len; i += 2) {
      int n = input[i] & 0xff;
      if (n == 0) throw new IllegalArgumentException("rlez: zero run length at " + i);
      for (int k = 0; k < n; k++) out.write(input[i + 1]);
    }
    return out.toByteArray();
  }

  @Override
  public Decoded decodeStreaming(byte[] input, CodecCtx ctx) {
    int i = 0;
    while (i < input.length && input[i] != 0) i += 2;
    if (i >= input.length) throw new IllegalArgumentException("rlez: missing terminator");
    byte[] out = pairs(input, i);
    if (ctx.hasOutputSize() && ctx.outputSize() != out.length) {
      throw new IllegalArgumentException(
          "rlez: decoded " + out.length + " bytes, expected " + ctx.outputSize());
    }
    return new Decoded(out, i + 1);
  }

  @Override
  public byte[] decode(byte[] input, CodecCtx ctx) {
    return decodeStreaming(input, ctx).output();
  }

  @Override
  public byte[] encode(byte[] input, CodecCtx ctx) {
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
    out.write(0);
    return out.toByteArray();
  }
}
