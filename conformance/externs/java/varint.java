package dev.yaffle.conformance.externs;

import dev.yaffle.runtime.ExternType;
import java.io.ByteArrayOutputStream;

/**
 * {@code extern type VarInt(u8 maxBytes) : u64}: unsigned LEB128, at most {@code maxBytes} bytes.
 * Values are u64 bit patterns in a {@code long}.
 *
 * <ul>
 *   <li>size: the index after the first byte below 0x80; -1 if the bytes end first (need more);
 *       an error if no terminating byte is found within {@code maxBytes}.
 *   <li>write: the shortest encoding; an error if it needs more than {@code maxBytes} bytes.
 * </ul>
 */
public final class VarInt implements ExternType<Long> {
  public static final VarInt VARINT = new VarInt();

  private VarInt() {}

  private static int maxBytes(Object[] args) {
    return ((Number) args[0]).intValue();
  }

  @Override
  public int size(byte[] bytes, Object... args) {
    int max = maxBytes(args);
    for (int i = 0; i < Math.min(bytes.length, max); i++) if ((bytes[i] & 0x80) == 0) return i + 1;
    if (bytes.length < max) return -1;
    throw new IllegalArgumentException("VarInt: longer than " + max + " bytes");
  }

  @Override
  public Long read(byte[] bytes, Object... args) {
    int max = maxBytes(args);
    long v = 0;
    for (int i = 0; i < bytes.length && i < max; i++) {
      long part = bytes[i] & 0x7f;
      int shift = 7 * i;
      if ((shift >= 64 && part != 0) || (shift > 57 && shift < 64 && (part >>> (64 - shift)) != 0)) {
        throw new IllegalArgumentException("VarInt: value exceeds u64");
      }
      if (shift < 64) v |= part << shift;
      if ((bytes[i] & 0x80) == 0) return v;
    }
    throw new IllegalArgumentException("VarInt: unterminated");
  }

  @Override
  public byte[] write(Long value, Object... args) {
    int max = maxBytes(args);
    long v = value;
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    do {
      int b = (int) (v & 0x7f);
      v >>>= 7;
      out.write(v == 0 ? b : b | 0x80);
    } while (v != 0);
    if (out.size() > max) {
      throw new IllegalArgumentException(
          "VarInt: " + Long.toUnsignedString(value) + " needs " + out.size()
              + " bytes, more than " + max);
    }
    return out.toByteArray();
  }
}
