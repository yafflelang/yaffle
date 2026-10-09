package dev.yaffle.runtime;

import java.util.Arrays;
import java.util.List;

/**
 * The position of a generated struct reader or writer inside its struct: the field being read or
 * written and the indices of the arrays it is in. Errors unwinding through the struct get these
 * as path segments; the writer snapshots every open frame for errors raised after layout.
 *
 * <p>A frame is a mutable object so lambdas in generated code can update it.
 */
public final class Frame {
  private static final int[] NONE = new int[0];

  /** Current field name ("" between fields). */
  public String f = "";
  /** Current index per array nesting depth (-1: not inside that array). */
  public final int[] i;

  public Frame() {
    this.i = NONE;
  }

  public Frame(int depth) {
    this.i = depth == 0 ? NONE : new int[depth];
    Arrays.fill(this.i, -1);
  }

  /** Prefixes the frame's position to the error's path and returns the error (for {@code throw}). */
  public YaffleException rethrow(YaffleException e) {
    if (e.isSealed()) return e;
    if (i.length == 0) return e.prefix(f);
    Object[] segs = new Object[i.length + 1];
    segs[0] = f;
    for (int k = 0; k < i.length; k++) segs[k + 1] = i[k];
    return e.prefix(segs);
  }

  void appendTo(List<Object> out) {
    if (!f.isEmpty()) out.add(f);
    for (int k : i) if (k >= 0) out.add(k);
  }
}
