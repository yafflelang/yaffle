package org.yafflelang.runtime;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.ByteBuffer;
import java.nio.channels.AsynchronousFileChannel;
import java.nio.channels.CompletionHandler;
import java.util.concurrent.CompletableFuture;

/**
 * An asynchronous random-access source: {@code X.viewAsync(source)} gives an {@link AsyncView}
 * whose accesses complete as futures, and {@code X.parseAsync(source)} reads it whole.
 *
 * <p>Generated readers stay synchronous. Accesses of an async view run on a virtual thread, where
 * a missing block's future is awaited; a waiting virtual thread parks instead of holding an OS
 * thread, so no reader needs an async twin and no access is redone.
 */
public interface AsyncSource {
  /** Total size in bytes (at most 2 GiB - 1). */
  long size();

  /** {@code length} bytes at {@code offset}. */
  CompletableFuture<byte[]> read(long offset, int length);

  /** An async source over a byte array (completed futures). */
  static AsyncSource of(byte[] bytes) {
    return new AsyncSource() {
      @Override
      public long size() {
        return bytes.length;
      }

      @Override
      public CompletableFuture<byte[]> read(long offset, int length) {
        return CompletableFuture.completedFuture(
            java.util.Arrays.copyOfRange(bytes, (int) offset, (int) offset + length));
      }
    };
  }

  /** An async source over an open asynchronous file channel. */
  static AsyncSource of(AsynchronousFileChannel channel) {
    return new AsyncSource() {
      @Override
      public long size() {
        try {
          return channel.size();
        } catch (IOException e) {
          throw new UncheckedIOException(e);
        }
      }

      @Override
      public CompletableFuture<byte[]> read(long offset, int length) {
        CompletableFuture<byte[]> f = new CompletableFuture<>();
        ByteBuffer b = ByteBuffer.allocate(length);
        CompletionHandler<Integer, Long> h =
            new CompletionHandler<>() {
              @Override
              public void completed(Integer n, Long at) {
                if (n < 0 || !b.hasRemaining()) {
                  if (b.hasRemaining()) {
                    f.completeExceptionally(
                        new YaffleException(
                            ErrorCode.EOF, "the file ended at 0x" + Long.toHexString(at), at));
                  } else f.complete(b.array());
                  return;
                }
                channel.read(b, at + n, at + n, this);
              }

              @Override
              public void failed(Throwable e, Long at) {
                f.completeExceptionally(e);
              }
            };
        channel.read(b, offset, offset, h);
        return f;
      }
    };
  }

  /** Reads the whole source (for {@code parseAsync}). */
  default CompletableFuture<byte[]> readAll() {
    long n = size();
    if (n > Integer.MAX_VALUE - 8) {
      return CompletableFuture.failedFuture(
          new YaffleException(ErrorCode.RANGE, "sources over 2 GiB are not supported"));
    }
    return n == 0 ? CompletableFuture.completedFuture(new byte[0]) : read(0, (int) n);
  }
}
