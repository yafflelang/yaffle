package dev.yaffle.runtime;

import java.util.function.Supplier;

/** A view value computed on first access (re-computed after in-place patches of its space). */
final class Lazy {
  private final Supplier<Object> f;
  private final ViewSpace space;
  private Object value;
  private int version = -1;

  Lazy(Supplier<Object> f, ViewSpace space) {
    this.f = f;
    this.space = space;
  }

  Object get() {
    int v = space != null ? space.version : 0;
    if (version != v) {
      value = f.get();
      version = v;
    }
    return value;
  }

  /** True once computed (for the current version). */
  boolean forced() {
    return version == (space != null ? space.version : 0);
  }

  /** The computed value without computing it (null if not forced). */
  Object peek() {
    return forced() ? value : null;
  }

  static Object force(Object v) {
    return v instanceof Lazy l ? l.get() : v;
  }
}
