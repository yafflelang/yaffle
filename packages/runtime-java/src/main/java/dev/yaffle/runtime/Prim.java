package dev.yaffle.runtime;

import java.math.BigInteger;

/**
 * Primitive kinds. Java representation: integers of up to 32 bits (except {@code u32}) are
 * {@code int}; {@code u32}, 40-, 48-, 56- and 64-bit integers are {@code long} ({@code u64} holds
 * the unsigned bit pattern); {@code f16} and {@code f64} are {@code double}, {@code f32} is
 * {@code float}.
 */
public enum Prim {
  U8(8, false, false),
  U16(16, false, false),
  U24(24, false, false),
  U32(32, false, false),
  U40(40, false, false),
  U48(48, false, false),
  U56(56, false, false),
  U64(64, false, false),
  I8(8, true, false),
  I16(16, true, false),
  I24(24, true, false),
  I32(32, true, false),
  I40(40, true, false),
  I48(48, true, false),
  I56(56, true, false),
  I64(64, true, false),
  F16(16, true, true),
  F32(32, true, true),
  F64(64, true, true);

  public final int bits;
  public final int size;
  public final boolean signed;
  public final boolean isFloat;
  /** Smallest value (integers; {@code u64}: 0). */
  public final long min;
  /** Largest value (integers; {@code u64}: {@link Long#MAX_VALUE}, see {@link #maxBig}). */
  public final long max;
  public final BigInteger minBig;
  public final BigInteger maxBig;

  Prim(int bits, boolean signed, boolean isFloat) {
    this.bits = bits;
    this.size = bits / 8;
    this.signed = signed;
    this.isFloat = isFloat;
    if (isFloat) {
      this.min = 0;
      this.max = 0;
      this.minBig = BigInteger.ZERO;
      this.maxBig = BigInteger.ZERO;
    } else if (signed) {
      this.min = bits == 64 ? Long.MIN_VALUE : -(1L << (bits - 1));
      this.max = bits == 64 ? Long.MAX_VALUE : (1L << (bits - 1)) - 1;
      this.minBig = BigInteger.valueOf(min);
      this.maxBig = BigInteger.valueOf(max);
    } else {
      this.min = 0;
      this.max = bits == 64 ? Long.MAX_VALUE : (1L << bits) - 1;
      this.minBig = BigInteger.ZERO;
      this.maxBig = BigInteger.ONE.shiftLeft(bits).subtract(BigInteger.ONE);
    }
  }

  /** IR name ({@code "u16"}). */
  public String irName() {
    return name().toLowerCase(java.util.Locale.ROOT);
  }
}
