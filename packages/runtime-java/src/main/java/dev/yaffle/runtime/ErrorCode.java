package dev.yaffle.runtime;

/** Stable error codes (docs/CONFORMANCE.md §4). */
public enum ErrorCode {
  /** Not enough bytes. */
  EOF,
  /** A check failed (constant, {@code in}, {@code where}, strict padding, enum, encoding, switch). */
  CHECK,
  /** An integer out of range for its destination, division by zero, a negative length. */
  RANGE,
  /** No union variant matched. */
  UNION,
  /** A codec, extern type or extern function failed. */
  CODEC,
  /** An invalid input value on write. */
  INPUT,
  /** A derived value contradicts the data. */
  DERIVE,
  /** A {@code @ref} pointer has no equal placed value. */
  REF,
  /** Fixed placements overlap. */
  OVERLAP
}
