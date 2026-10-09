package dev.yaffle.runtime;

import java.lang.invoke.MethodHandles;
import java.lang.invoke.VarHandle;
import java.nio.ByteOrder;

/** Low-level primitive encodings over byte arrays (both byte orders), IEEE half precision. */
public final class Bytes {
  private Bytes() {}

  private static final VarHandle I16_LE =
      MethodHandles.byteArrayViewVarHandle(short[].class, ByteOrder.LITTLE_ENDIAN);
  private static final VarHandle I16_BE =
      MethodHandles.byteArrayViewVarHandle(short[].class, ByteOrder.BIG_ENDIAN);
  private static final VarHandle I32_LE =
      MethodHandles.byteArrayViewVarHandle(int[].class, ByteOrder.LITTLE_ENDIAN);
  private static final VarHandle I32_BE =
      MethodHandles.byteArrayViewVarHandle(int[].class, ByteOrder.BIG_ENDIAN);
  private static final VarHandle I64_LE =
      MethodHandles.byteArrayViewVarHandle(long[].class, ByteOrder.LITTLE_ENDIAN);
  private static final VarHandle I64_BE =
      MethodHandles.byteArrayViewVarHandle(long[].class, ByteOrder.BIG_ENDIAN);

  public static int u16(byte[] b, int off, boolean le) {
    return (le ? (short) I16_LE.get(b, off) : (short) I16_BE.get(b, off)) & 0xffff;
  }

  public static int i32(byte[] b, int off, boolean le) {
    return le ? (int) I32_LE.get(b, off) : (int) I32_BE.get(b, off);
  }

  public static long i64(byte[] b, int off, boolean le) {
    return le ? (long) I64_LE.get(b, off) : (long) I64_BE.get(b, off);
  }

  public static void put16(byte[] b, int off, int v, boolean le) {
    if (le) I16_LE.set(b, off, (short) v);
    else I16_BE.set(b, off, (short) v);
  }

  public static void put32(byte[] b, int off, int v, boolean le) {
    if (le) I32_LE.set(b, off, v);
    else I32_BE.set(b, off, v);
  }

  public static void put64(byte[] b, int off, long v, boolean le) {
    if (le) I64_LE.set(b, off, v);
    else I64_BE.set(b, off, v);
  }

  /** Unsigned integer of {@code size} bytes (1..8); 8 bytes give the raw bit pattern. */
  public static long readUInt(byte[] b, int off, int size, boolean le) {
    switch (size) {
      case 1:
        return b[off] & 0xff;
      case 2:
        return u16(b, off, le);
      case 4:
        return i32(b, off, le) & 0xffffffffL;
      case 8:
        return i64(b, off, le);
      default:
        long v = 0;
        if (le) for (int i = size - 1; i >= 0; i--) v = (v << 8) | (b[off + i] & 0xff);
        else for (int i = 0; i < size; i++) v = (v << 8) | (b[off + i] & 0xff);
        return v;
    }
  }

  /** Writes the low {@code size} bytes of {@code v}. */
  public static void writeUInt(byte[] b, int off, int size, long v, boolean le) {
    switch (size) {
      case 1:
        b[off] = (byte) v;
        return;
      case 2:
        put16(b, off, (int) v, le);
        return;
      case 4:
        put32(b, off, (int) v, le);
        return;
      case 8:
        put64(b, off, v, le);
        return;
      default:
        for (int i = 0; i < size; i++) {
          b[le ? off + i : off + size - 1 - i] = (byte) v;
          v >>>= 8;
        }
    }
  }

  /** Sign-extends the low {@code bits} bits. */
  public static long signExtend(long v, int bits) {
    if (bits >= 64) return v;
    int s = 64 - bits;
    return (v << s) >> s;
  }

  // ── half precision ──────────────────────────────────────────────────────────

  /** IEEE 754 binary16 bits to a double (exact). */
  public static double halfToDouble(int h) {
    double sign = (h & 0x8000) != 0 ? -1.0 : 1.0;
    int exp = (h >> 10) & 0x1f;
    int frac = h & 0x3ff;
    if (exp == 0) return sign * frac * 0x1p-24;
    if (exp == 0x1f) return frac != 0 ? Double.NaN : sign * Double.POSITIVE_INFINITY;
    return sign * (1 + frac / 1024.0) * Math.scalb(1.0, exp - 15);
  }

  /** A double to IEEE 754 binary16 bits, rounding to nearest even directly from the double. */
  public static int doubleToHalf(double v) {
    if (Double.isNaN(v)) return 0x7e00;
    int sign = (v < 0 || (v == 0 && 1 / v < 0)) ? 0x8000 : 0;
    double a = Math.abs(v);
    if (a == 0) return sign;
    if (Double.isInfinite(a)) return sign | 0x7c00;
    int e = Math.getExponent(a);
    if (e < -14) return sign | (int) Math.rint(a * 0x1p24);
    long q = (long) Math.rint(Math.scalb(a, 10 - e));
    if (q == 2048) {
      q = 1024;
      e++;
    }
    if (e > 15) return sign | 0x7c00;
    return sign | ((e + 15) << 10) | (int) (q - 1024);
  }
}
