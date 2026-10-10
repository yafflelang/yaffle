package org.yafflelang.runtime;

import java.util.List;

/**
 * A value written after layout, at {@code at} of {@code block}. Phases: 0 = sizes, positions,
 * pointers; 2 = content-dependent values (checksums, bytesof), run innermost ({@code depth})
 * first. {@code path}: the field that registered it (for errors).
 */
record Fixup(Block block, int at, int phase, int depth, List<Object> path, Fixup.Run run) {
  /** Computes and writes the value into the assembled region bytes at {@code abs}. */
  @FunctionalInterface
  interface Run {
    void run(byte[] out, int abs);
  }
}
