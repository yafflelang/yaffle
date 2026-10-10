package org.yafflelang.runtime;

/** Padding fill: a byte value, or a function of the byte's index within the padding run. */
@FunctionalInterface
public interface Fill {
  /** The fill value for byte {@code i} of the padding run (only the low 8 bits are used). */
  long at(int i);

  Fill ZERO = i -> 0;

  static Fill of(int b) {
    if (b == 0) return ZERO;
    return i -> b;
  }

  /** The byte for index {@code i}. */
  default byte byteAt(int i) {
    return (byte) at(i);
  }
}
