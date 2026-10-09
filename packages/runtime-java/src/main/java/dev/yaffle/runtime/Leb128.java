package dev.yaffle.runtime;

import java.io.ByteArrayOutputStream;
import java.math.BigInteger;

/**
 * The built-in extern types {@code uleb128} and {@code sleb128}. The optional argument is the
 * maximum encoded length in bytes (default 10).
 */
public final class Leb128 {
  private Leb128() {}

  /** Unsigned LEB128 (value: u64 bit pattern). */
  public static final ExternType<Long> UNSIGNED =
      new ExternType<>() {
        @Override
        public int size(byte[] bytes, Object... args) {
          return Leb128.size(bytes, args);
        }

        @Override
        public Long read(byte[] bytes, Object... args) {
          return Ints.check(magnitude(bytes), Prim.U64);
        }

        @Override
        public byte[] write(Long value, Object... args) {
          long v = value;
          ByteArrayOutputStream out = new ByteArrayOutputStream();
          do {
            int b = (int) (v & 0x7f);
            v >>>= 7;
            out.write(v != 0 ? b | 0x80 : b);
          } while (v != 0);
          return out.toByteArray();
        }
      };

  /** Signed LEB128 (value: i64). */
  public static final ExternType<Long> SIGNED =
      new ExternType<>() {
        @Override
        public int size(byte[] bytes, Object... args) {
          return Leb128.size(bytes, args);
        }

        @Override
        public Long read(byte[] bytes, Object... args) {
          BigInteger v = magnitude(bytes);
          if (bytes.length > 0 && (bytes[bytes.length - 1] & 0x40) != 0) {
            v = v.subtract(BigInteger.ONE.shiftLeft(bytes.length * 7));
          }
          return Ints.check(v, Prim.I64);
        }

        @Override
        public byte[] write(Long value, Object... args) {
          long v = value;
          ByteArrayOutputStream out = new ByteArrayOutputStream();
          for (; ; ) {
            int b = (int) (v & 0x7f);
            v >>= 7;
            boolean done = (v == 0 && (b & 0x40) == 0) || (v == -1 && (b & 0x40) != 0);
            out.write(done ? b : b | 0x80);
            if (done) return out.toByteArray();
          }
        }
      };

  /** The encoded length: up to the first byte without the continuation bit (-1: need more). */
  private static int size(byte[] bytes, Object[] args) {
    int max = args.length > 0 && args[0] instanceof Number n ? n.intValue() : 10;
    for (int i = 0; i < bytes.length && i < max; i++) if ((bytes[i] & 0x80) == 0) return i + 1;
    if (bytes.length >= max) {
      throw new YaffleException(ErrorCode.CHECK, "LEB128 longer than " + max + " bytes");
    }
    return -1;
  }

  /** The 7-bit groups as an unsigned number. */
  private static BigInteger magnitude(byte[] bytes) {
    BigInteger v = BigInteger.ZERO;
    for (int i = bytes.length - 1; i >= 0; i--) {
      v = v.shiftLeft(7).or(BigInteger.valueOf(bytes[i] & 0x7f));
    }
    return v;
  }
}
