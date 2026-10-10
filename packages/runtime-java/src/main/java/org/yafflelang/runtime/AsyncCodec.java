package org.yafflelang.runtime;

import java.util.concurrent.CompletableFuture;

/**
 * Host implementation of an {@code extern async codec}. Schemas containing one only get {@code
 * parseAsync}/{@code serializeAsync}; generated code waits for the future on a virtual thread.
 */
public interface AsyncCodec {
  CompletableFuture<byte[]> decode(byte[] input, CodecCtx ctx);

  CompletableFuture<byte[]> encode(byte[] input, CodecCtx ctx);

  /** {@code @streaming}: decode from the start of {@code input} and report the bytes consumed. */
  default CompletableFuture<Decoded> decodeStreaming(byte[] input, CodecCtx ctx) {
    return decode(input, ctx).thenApply(out -> new Decoded(out, input.length));
  }
}
