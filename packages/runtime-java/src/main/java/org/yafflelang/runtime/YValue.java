package org.yafflelang.runtime;

/**
 * Implemented by generated struct classes and union interfaces: their canonical JSON, which is
 * what {@code ==} on composite values compares (docs/IR.md §6).
 */
public interface YValue {
  /** The value's canonical JSON (docs/CONFORMANCE.md §3). */
  Object toJsonValue();
}
