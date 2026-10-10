package org.yafflelang.runtime;

/**
 * One item of a struct's {@code layout { … }}: a path ({@code null} for {@code this}; field names
 * with {@code "*"} for {@code [*]}) and the layers applied to everything it places. A group item
 * ({@code volumes[*] { pieces[*]  portals[*].points }}) names an array and places its {@link
 * #group} items, relative to each element, element by element.
 *
 * @param path field names and {@code "*"}, or null for {@code this}
 * @param layers item layers ({@code align}, {@code padBefore}, {@code padAfter}, {@code alignEnd})
 * @param group per-element items, or null
 */
public record LayoutItem(String[] path, Layer[] layers, LayoutItem[] group) {
  public enum Kind {
    ALIGN,
    PAD_BEFORE,
    PAD_AFTER,
    ALIGN_END
  }

  /**
   * A layer of a layout item.
   *
   * @param kind which layer
   * @param n its argument
   * @param offset {@code align} with an offset: the start satisfies {@code (start -
   *     origin + offset) % n == 0}
   * @param file {@code align(from: file)}: the origin is the start of the byte space
   */
  public record Layer(Kind kind, long n, long offset, boolean file) {
    public Layer(Kind kind, long n) {
      this(kind, n, 0, false);
    }

    /** True for an alignment with an origin or offset (a residue rather than a plain alignment). */
    public boolean residue() {
      return kind == Kind.ALIGN && (offset != 0 || file);
    }
  }

  /**
   * Passed as a region's layout when the writer of the region's root struct computes the items
   * (layers that read fields); the region then takes that struct's items.
   */
  public static final LayoutItem[] OWN = new LayoutItem[0];

  public boolean isThis() {
    return path == null;
  }

  public static LayoutItem of(String[] path, Layer... layers) {
    return new LayoutItem(path, layers, null);
  }

  /** A per-element group: for each element of the array at {@code path}, {@code items} in order. */
  public static LayoutItem group(String[] path, LayoutItem[] items, Layer... layers) {
    return new LayoutItem(path, layers, items);
  }

  /** {@code @align(n)}; an alignment below 1, constant or computed, is a RANGE error. */
  public static Layer align(long n) {
    return new Layer(Kind.ALIGN, alignment(n));
  }

  /** {@code @align(n, offset: k)} / {@code @align(n, from: file)} on a layout item. */
  public static Layer alignAt(long n, long offset, boolean file) {
    return new Layer(Kind.ALIGN, alignment(n), offset, file);
  }

  public static Layer padBefore(long n) {
    return new Layer(Kind.PAD_BEFORE, count(n));
  }

  public static Layer padAfter(long n) {
    return new Layer(Kind.PAD_AFTER, count(n));
  }

  public static Layer alignEnd(long n) {
    return new Layer(Kind.ALIGN_END, alignment(n));
  }

  private static long alignment(long n) {
    if (n < 1) throw Ints.range("invalid alignment " + n);
    return n;
  }

  private static long count(long n) {
    if (n < 0) throw Ints.range("invalid padding " + n);
    return n;
  }
}
