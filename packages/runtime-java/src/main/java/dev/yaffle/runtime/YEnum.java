package dev.yaffle.runtime;

/**
 * Implemented by generated enums. Closed enums are Java {@code enum}s; open enums ({@code @open})
 * are records whose unknown values have no member name.
 */
public interface YEnum {
  /** The stored value ({@code u64} storage: the unsigned bit pattern). */
  long value();

  /** The member name as declared in yaffle, or null for an unknown value of an open enum. */
  String member();
}
