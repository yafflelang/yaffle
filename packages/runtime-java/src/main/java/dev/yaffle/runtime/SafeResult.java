package dev.yaffle.runtime;

import java.util.function.Supplier;

/**
 * The result of {@code safeParse}: the value, or the {@link YaffleException} that stopped it.
 *
 * @param <T> the value type
 */
public sealed interface SafeResult<T> {
  /**
   * Success.
   *
   * @param value the parsed value
   * @param <T> the value type
   */
  record Ok<T>(T value) implements SafeResult<T> {}

  /**
   * Failure.
   *
   * @param error the error
   * @param <T> the value type
   */
  record Err<T>(YaffleException error) implements SafeResult<T> {}

  default boolean ok() {
    return this instanceof Ok<T>;
  }

  /** Runs {@code f}, turning a thrown {@link YaffleException} into {@link Err}. */
  static <T> SafeResult<T> of(Supplier<T> f) {
    try {
      return new Ok<>(f.get());
    } catch (YaffleException e) {
      return new Err<>(e);
    }
  }
}
