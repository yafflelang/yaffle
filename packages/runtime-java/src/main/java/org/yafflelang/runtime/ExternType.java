package org.yafflelang.runtime;

/**
 * Host implementation of an {@code extern type X(args) : T} (docs/IR.md §5). Arguments arrive as
 * their Java types (boxed). Any exception it throws is a {@code CODEC} error.
 *
 * @param <T> the declared value type, boxed ({@code u64} → Long holding the unsigned bit pattern)
 */
public interface ExternType<T> {
  /**
   * The size of the value at the start of {@code bytes}, or -1 if more bytes are needed to tell.
   * Not called for types with a fixed size.
   */
  int size(byte[] bytes, Object... args);

  T read(byte[] bytes, Object... args);

  byte[] write(T value, Object... args);
}
