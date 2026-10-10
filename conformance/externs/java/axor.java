package org.yafflelang.conformance.externs;

import org.yafflelang.runtime.AsyncCodec;
import org.yafflelang.runtime.CodecCtx;
import java.util.concurrent.CompletableFuture;

/** {@code extern async codec axor(u8 key)}: the same transform as {@code xor}, through futures. */
public final class AsyncXor implements AsyncCodec {
  public static final AsyncXor AXOR = new AsyncXor();

  private AsyncXor() {}

  private static byte[] apply(byte[] input, CodecCtx ctx) {
    long key = ctx.longArg(0);
    if (key < 0 || key > 255) throw new IllegalArgumentException("codec key must be a u8, got " + key);
    byte[] out = new byte[input.length];
    for (int i = 0; i < input.length; i++) out[i] = (byte) (input[i] ^ key);
    return out;
  }

  @Override
  public CompletableFuture<byte[]> decode(byte[] input, CodecCtx ctx) {
    return CompletableFuture.supplyAsync(
        () -> {
          byte[] out = apply(input, ctx);
          if (ctx.hasOutputSize() && ctx.outputSize() != out.length) {
            throw new IllegalArgumentException(
                "axor: decoded " + out.length + " bytes, expected " + ctx.outputSize());
          }
          return out;
        });
  }

  @Override
  public CompletableFuture<byte[]> encode(byte[] input, CodecCtx ctx) {
    return CompletableFuture.supplyAsync(() -> apply(input, ctx));
  }
}
