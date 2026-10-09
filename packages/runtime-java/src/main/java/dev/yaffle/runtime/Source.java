package dev.yaffle.runtime;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

/**
 * A synchronous random-access source for views: {@code X.view(source)} reads the bytes it needs
 * in blocks instead of the whole input. Sources are read only while a view is open; commits work
 * on the bytes they produce.
 */
public interface Source {
  /** Total size in bytes (at most 2 GiB - 1). */
  long size();

  /** {@code length} bytes at {@code offset} (exactly that many; the range is within the size). */
  byte[] read(long offset, int length);

  /** A source over a byte array. */
  static Source of(byte[] bytes) {
    return new Source() {
      @Override
      public long size() {
        return bytes.length;
      }

      @Override
      public byte[] read(long offset, int length) {
        return java.util.Arrays.copyOfRange(bytes, (int) offset, (int) offset + length);
      }
    };
  }

  /** A source over an open file channel (positional reads; the channel stays open). */
  static Source of(FileChannel channel) {
    return new Source() {
      @Override
      public long size() {
        try {
          return channel.size();
        } catch (IOException e) {
          throw new UncheckedIOException(e);
        }
      }

      @Override
      public byte[] read(long offset, int length) {
        ByteBuffer b = ByteBuffer.allocate(length);
        try {
          long at = offset;
          while (b.hasRemaining()) {
            int n = channel.read(b, at);
            if (n < 0) break;
            at += n;
          }
        } catch (IOException e) {
          throw new UncheckedIOException(e);
        }
        if (b.hasRemaining()) {
          throw new YaffleException(ErrorCode.EOF, "the file ended at 0x" + Long.toHexString(offset + b.position()), offset);
        }
        return b.array();
      }
    };
  }

  /** Opens a file as a source (the channel is closed when the JVM collects it; prefer {@link #of(FileChannel)}). */
  static Source of(Path file) {
    try {
      return of(FileChannel.open(file, StandardOpenOption.READ));
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }
}
