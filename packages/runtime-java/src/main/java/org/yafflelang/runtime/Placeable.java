package org.yafflelang.runtime;

/** A pointer or {@code at} target: its block plus the structure of its content. */
public final class Placeable implements LEntry {
  final Block block;
  LEntry content;
  /** {@code at} constraint from a derived linear offset: position ≡ remainder (mod modulus); modulus 0: none. */
  long modulus;
  long remainder;
  /** Fixed placement offset, or null. */
  Long fixed;
  /** Commit mode: original position and size (from a view), or -1. */
  int orig = -1;
  int origSize = -1;
  /** The field it belongs to (errors). */
  final String name;

  Placeable(Block block, String name, PlaceOptions opts) {
    this.block = block;
    this.name = name;
    if (opts == null) return;
    this.modulus = opts.modulus();
    this.remainder = opts.remainder();
    this.fixed = opts.fixed();
    if (fixed != null) {
      if (fixed < 0 || fixed > Integer.MAX_VALUE) {
        throw new YaffleException(ErrorCode.RANGE, "invalid fixed offset " + fixed + " for " + name);
      }
      block.fixedAt = (int) (long) fixed;
    }
  }

  boolean placed() {
    return block.pos >= 0;
  }

  /**
   * Placement options.
   *
   * @param modulus {@code at} constraint modulus (0: none)
   * @param remainder {@code at} constraint remainder
   * @param fixed fixed base-relative offset, or null
   */
  public record PlaceOptions(long modulus, long remainder, Long fixed) {
    public static PlaceOptions fixedAt(long offset) {
      return new PlaceOptions(0, 0, offset);
    }

    public static PlaceOptions constraint(long modulus, long remainder) {
      return new PlaceOptions(modulus, remainder, null);
    }
  }
}
