package org.yafflelang.runtime;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.LongSupplier;
import java.util.function.Supplier;

/**
 * The relocation-style writer (docs/IR.md §3.2):
 *
 * <ol>
 *   <li>Generated writers encode bottom-up into blocks: inline bytes plus fixups (a position, a
 *       width and a closure computing the value once sizes and positions are final).
 *   <li>Pointer and {@code at} targets become placeables, each with its own block. Generated code
 *       also records the structure ({@link LStruct} / {@link LArray}) layout paths match against.
 *   <li>When a base region (the root, a {@code @base} struct, a codec's decoded side) is complete,
 *       the layout engine assigns every block a position, the blocks are assembled and the fixups
 *       run.
 * </ol>
 */
public final class Writer {
  /** Current block (inline bytes go here). */
  Block b;
  /** Current base region. */
  Region region;
  /** Struct nesting depth (orders content-dependent fixups). */
  int depth;
  /** {@code $index} of the element being written. */
  public int index = -1;
  private final List<Frame> frames = new ArrayList<>();

  // ── commit mode (views) ─────────────────────────────────────────────────────

  /** Where values were in a view's source (absolute positions), for sticky layout. */
  interface Origins {
    /** Original {pos, size} of a target value, or null. */
    int[] of(Object value);

    /** Original {pos, size} of the target of a field of a view struct, or null. */
    int[] ofSlot(Object owner, String field);

    /** Original {base, inline, size} of a nested base struct, or null. */
    int[] ofRegion(Object value);
  }

  Origins origins;
  /** Byte arrays copied from a view's source (by offset): recorded as unchanged (for patches). */
  IdentityHashMap<byte[], Integer> provenance;
  Object provenanceSpace;
  /** The absolute start of the current base in the view's source (origins are absolute). */
  private int originBase;
  private final Region rootRegion;

  public Writer() {
    this(new Region());
  }

  public Writer(Region region) {
    this.region = region;
    this.b = region.root;
    this.rootRegion = region;
  }

  /** Enters a struct writer: its frame gives fixups registered inside their error path. */
  public void enter(Frame f) {
    frames.add(f);
    depth++;
  }

  public void leave() {
    frames.remove(frames.size() - 1);
    depth--;
  }

  /** The current path from the root (snapshot). */
  List<Object> path() {
    List<Object> out = new ArrayList<>();
    for (Frame f : frames) f.appendTo(out);
    return out;
  }

  private void noteOrigin(Placeable p, Object value, Object owner) {
    if (origins == null || region.sticky == null || region.sticky.origRootSize() < 0) return;
    int[] o = origins.of(value);
    if (o == null && owner != null) o = origins.ofSlot(owner, p.name);
    if (o != null && o[0] >= originBase) {
      p.orig = o[0] - originBase;
      p.origSize = o[1];
    }
  }

  /** Offset of the next byte within the current block. */
  public int offset() {
    return b.size;
  }

  /** {@code $offset} on write: the base-relative position (exact in a region's own block). */
  public long position() {
    return (b.pos >= 0 ? b.pos : 0) + (long) b.size;
  }

  /** A position inside the current block. */
  public Mark mark() {
    return new Mark(b, b.size);
  }

  /**
   * A position inside a block (base-relative once laid out).
   *
   * @param block the block
   * @param at offset in the block
   */
  public record Mark(Block block, int at) {
    /** Base-relative position (after layout). */
    public long pos() {
      return (long) block.pos + at;
    }

    /** Size of the finished region the mark is in. */
    public long regionEnd() {
      byte[] out = block.region.output;
      if (out == null) throw new YaffleException(ErrorCode.DERIVE, "$end used before layout");
      return out.length;
    }
  }

  /** Starts an extent at the current position. */
  public void start(Extent e) {
    e.block = b;
    e.start = b.size;
    e.end = -1;
    e.placeable = null;
  }

  public void close(Extent e) {
    e.end = b.size;
  }

  // ── primitives (validated) ──────────────────────────────────────────────────

  public void prim(Prim p, long v, boolean le) {
    b.uint(p.size, Ints.check(v, p), le);
  }

  public void prim(Prim p, BigInteger v, boolean le) {
    b.uint(p.size, Ints.check(v, p), le);
  }

  /** A u64 bit pattern (any value is valid). */
  public void u64(long raw, boolean le) {
    b.uint(8, raw, le);
  }

  public void u8(long v) {
    b.u8((int) Ints.check(v, Prim.U8));
  }

  public void f16(double v, boolean le) {
    b.uint(2, Bytes.doubleToHalf(v), le);
  }

  public void f32(float v, boolean le) {
    b.uint(4, Float.floatToRawIntBits(v), le);
  }

  public void f64(double v, boolean le) {
    b.uint(8, Double.doubleToRawLongBits(v), le);
  }

  public void bool(boolean v) {
    b.u8(v ? 1 : 0);
  }

  /** The source position of an array copied from a view's source (only in the root region). */
  private Block.Provenance provOf(byte[] v) {
    if (provenance == null || region != rootRegion) return null;
    Integer at = provenance.get(v);
    return at == null ? null : new Block.Provenance(provenanceSpace, at);
  }

  public void bytes(byte[] v) {
    if (v == null) throw input("expected bytes, got null");
    b.bytes(v, provOf(v));
  }

  /** Raw bytes known to be valid. */
  public void raw(byte[] v) {
    b.bytes(v, provOf(v));
  }

  /** {@code u8 x[n]}: exactly {@code n} bytes (other lengths would read back differently: DERIVE). */
  public void bytesN(byte[] v, int n) {
    if (v == null) throw input("expected bytes, got null");
    if (v.length != n) {
      throw new YaffleException(
          ErrorCode.DERIVE, v.length + " bytes given, the length expression says " + n);
    }
    b.bytes(v, provOf(v));
  }

  /** Bytes followed by a terminator byte (which must not occur inside). */
  public void bytesUntil(byte[] v, long term) {
    if (v == null) throw input("expected bytes, got null");
    byte t = (byte) term;
    for (byte x : v) {
      if (x == t) throw input("the bytes contain the terminator 0x" + Integer.toHexString(t & 0xff));
    }
    b.bytes(v, null);
    b.u8(t);
  }

  /** Writes an extern type through its host {@code write}. */
  @SuppressWarnings("unchecked")
  public void extern(ExternType<?> host, Object value, Object[] args, int fixedSize) {
    byte[] out;
    try {
      out = ((ExternType<Object>) host).write(value, args);
    } catch (YaffleException e) {
      throw e;
    } catch (RuntimeException e) {
      throw Rt.hostError(e, "extern type write()", -1);
    }
    if (out == null) throw input("extern type write() returned null");
    if (fixedSize >= 0 && out.length != fixedSize) {
      throw new YaffleException(
          ErrorCode.DERIVE,
          "extern type wrote " + out.length + " bytes, its fixed size is " + fixedSize);
    }
    b.bytes(out, null);
  }

  /** {@code this} of a base struct: its whole region (size known once the region is finished). */
  public Extent regionExtent() {
    Extent e = new Extent();
    e.regionOf = region;
    return e;
  }

  /** Binds an extent to the placeable that holds the field. */
  public void bindExtent(Extent e, Placeable p, boolean emptyIsNull) {
    e.placeable = p;
    e.block = p.block;
    e.start = 0;
    e.end = p.block.size;
    e.emptyIsNull = emptyIsNull;
  }

  /** Text of fixed length: pads with NUL units up to {@code n} units (longer is INPUT). */
  public void strFixed(String v, int unit, Encoding enc, boolean le, int n) {
    byte[] bytes = enc.encode(v, le);
    if (bytes.length > (long) n * unit) {
      throw input("string of " + bytes.length / unit + " units exceeds the length " + n);
    }
    b.bytes(bytes, null);
    b.fill(n * unit - bytes.length, Fill.ZERO);
  }

  /** NUL-terminated text: the units, then one NUL unit. */
  public void strUntil(String v, int unit, Encoding enc, boolean le) {
    b.bytes(enc.encode(v, le), null);
    b.fill(unit, Fill.ZERO);
  }

  /** Text to the end of the region. */
  public void strRest(String v, int unit, Encoding enc, boolean le) {
    b.bytes(enc.encode(v, le), null);
  }

  // ── padding ─────────────────────────────────────────────────────────────────

  public void pad(long n, Fill fill) {
    if (n < 0 || n > Integer.MAX_VALUE) throw Ints.range("invalid padding length " + n);
    b.fill((int) n, fill);
  }

  /**
   * The base-relative start of the current block if known now (0 when unknown, after requiring
   * the block to start at a multiple of {@code to}).
   */
  private long knownStart(long to) {
    Integer known = b == region.root ? Integer.valueOf(0) : b.fixedAt;
    if (known != null) return known;
    b.align = Layout.lcm(b.align, to);
    return 0;
  }

  /** Pads until the base-relative position is a multiple of {@code to}. */
  public void align(long to, Fill fill) {
    if (to <= 0) throw Ints.range("invalid alignment " + to);
    b.fill((int) Math.floorMod(-(knownStart(to) + (long) b.size), to), fill);
  }

  /**
   * {@code align(to, from: …, offset: k)}: pads until {@code (position + k) % to == 0}, the
   * position counting from the nearest base or, with {@code file}, from the start of the byte
   * space (the output, a codec's decoded side, a stream; nested {@code @base} regions count from
   * where they are written). Block starts not known yet are required to be multiples of {@code
   * to}, and the padding is computed from the known part.
   */
  public void alignAt(long to, Fill fill, boolean file, long offset) {
    if (to <= 0) throw Ints.range("invalid alignment " + to);
    long start = file ? Region.fileStart(b, to) : knownStart(to);
    b.fill((int) Math.floorMod(-(start + (long) b.size + offset), to), fill);
  }

  public void padUntil(int start, long size, Fill fill) {
    int used = b.size - start;
    if (used > size) throw input("content of " + used + " bytes exceeds padUntil(" + size + ")");
    pad(size - used, fill);
  }

  /** Closes a {@code size(n)} window opened at {@code start}: longer content is DERIVE, shorter is padded. */
  public void sizeWindow(int start, long n) {
    if (n < 0 || n > Integer.MAX_VALUE) throw Ints.range("invalid size " + n);
    int used = b.size - start;
    if (used > n) {
      throw new YaffleException(ErrorCode.DERIVE, "content of " + used + " bytes does not fit size " + n);
    }
    b.fill((int) n - used, Fill.ZERO);
  }

  // ── fixups ──────────────────────────────────────────────────────────────────

  /** Bits to store for a primitive from a computed value (Integer, Long, BigInteger, floats). */
  static long primBits(Object v, Prim p) {
    if (p.isFloat) {
      if (!(v instanceof Number n)) throw input("expected a number, got " + Json.describe(v));
      double d = n.doubleValue();
      return switch (p) {
        case F16 -> Bytes.doubleToHalf(d);
        case F32 -> Float.floatToRawIntBits(v instanceof Float f ? f : (float) d);
        default -> Double.doubleToRawLongBits(d);
      };
    }
    if (v instanceof Integer i) return Ints.check(i, p);
    if (v instanceof Long l) return Ints.check(l, p);
    if (v instanceof BigInteger bi) return Ints.check(bi, p);
    if (v instanceof Boolean bo) return bo ? 1 : 0;
    throw input("expected an integer, got " + Json.describe(v));
  }

  /** Reserves {@code n} zero bytes and registers {@code run} to fill them after layout. */
  private void defer(int n, int phase, Fixup.Run run) {
    int at = b.size;
    b.fill(n, Fill.ZERO);
    region.fixups.add(new Fixup(b, at, phase, depth, path(), run));
  }

  /** Reserves a primitive whose value is computed after layout. */
  public void deferPrim(Prim kind, boolean le, Supplier<Object> compute, int phase) {
    defer(
        kind.size,
        phase,
        (out, abs) -> Bytes.writeUInt(out, abs, kind.size, primBits(compute.get(), kind), le));
  }

  /** Reserves {@code n} bytes whose content is computed after layout. */
  public void deferBytes(int n, Supplier<byte[]> compute, int phase) {
    defer(
        n,
        phase,
        (out, abs) -> {
          byte[] v = compute.get();
          if (v.length != n) {
            throw new YaffleException(
                ErrorCode.DERIVE, "derived bytes have length " + v.length + ", expected " + n);
          }
          System.arraycopy(v, 0, out, abs, n);
        });
  }

  /** A check evaluated after layout (e.g. read-side placement offsets must match). */
  public void deferCheck(Runnable run, int phase) {
    region.fixups.add(new Fixup(b, 0, phase, depth, path(), (out, abs) -> run.run()));
  }

  // ── targets ─────────────────────────────────────────────────────────────────

  /**
   * Places a pointer target: identical objects (by reference) with the same type key share one
   * placeable. {@code write} encodes the target into the placeable's block and returns its
   * structure.
   */
  public Placeable target(
      Object value,
      String key,
      String name,
      Supplier<LEntry> write,
      Placeable.PlaceOptions opts,
      Object owner) {
    if (!Codecs.trackable(value)) return place(name, value, write, opts, owner);
    Map<String, Placeable> byKey = region.identity.computeIfAbsent(value, v -> new HashMap<>());
    Placeable hit = byKey.get(key);
    if (hit != null) return hit;
    Placeable p = new Placeable(region.newBlock(), name, opts);
    byKey.put(key, p);
    fill(p, write, value, owner);
    return p;
  }

  /** Places an {@code at} field's value (no identity sharing). */
  public Placeable place(
      String name, Object value, Supplier<LEntry> write, Placeable.PlaceOptions opts, Object owner) {
    Placeable p = new Placeable(region.newBlock(), name, opts);
    fill(p, write, value, owner);
    return p;
  }

  /** Writes a placeable's content into its own block. */
  private void fill(Placeable p, Supplier<LEntry> write, Object value, Object owner) {
    noteOrigin(p, value, owner);
    region.placeables.add(p);
    Block saveB = b;
    int saveIndex = index;
    b = p.block;
    index = -1;
    try {
      p.content = write.get();
    } finally {
      b = saveB;
      index = saveIndex;
    }
  }

  static void writeOffset(byte[] out, int abs, Prim kind, boolean le, long value, Long nullValue) {
    if (nullValue != null && value == nullValue && (kind != Prim.U64 || value >= 0)) {
      throw new YaffleException(ErrorCode.DERIVE, "pointer offset " + value + " equals the null value");
    }
    if (!kind.signed && value < 0) {
      throw Ints.range("negative offset " + value + " for " + kind.irName());
    }
    Bytes.writeUInt(out, abs, kind.size, Ints.check(value, kind), le);
  }

  /** Writes an owned pointer: the offset of {@code p} (null → {@code nullValue}). */
  public void pointer(
      Prim kind, boolean le, Placeable p, boolean relative, Long nullValue, LongSupplier origin) {
    if (p == null) {
      if (nullValue == null) throw input("null for a pointer that is not nullable");
      long nv = nullValue;
      defer(kind.size, 0, (out, abs) -> Bytes.writeUInt(out, abs, kind.size, nv, le));
      return;
    }
    defer(
        kind.size,
        0,
        (out, abs) -> {
          if (p.block.pos < 0) {
            throw new YaffleException(ErrorCode.DERIVE, "target " + p.name + " was not placed");
          }
          long o = origin != null ? origin.getAsLong() : 0;
          long target = relative ? (long) p.block.pos - abs : p.block.pos;
          writeOffset(out, abs, kind, le, target - o, nullValue);
        });
  }

  /**
   * Writes a {@code @ref} pointer: resolved after layout to the first placed value in this base
   * (or an enclosing one) that is the same object or has the same encoding.
   */
  public void refPointer(
      Prim kind,
      boolean le,
      String key,
      Object value,
      Supplier<byte[]> encode,
      boolean relative,
      Long nullValue,
      LongSupplier origin) {
    if (value == null) {
      pointer(kind, le, null, relative, nullValue, null);
      return;
    }
    Block mark = b;
    int markAt = b.size;
    b.fill(kind.size, Fill.ZERO);
    boolean isObj = Codecs.trackable(value);
    region.refUses.add(
        new Region.RefUse(
            key,
            path(),
            isObj ? value : null,
            isObj ? encode : null,
            isObj ? null : encode.get(),
            origin,
            mark,
            markAt,
            null,
            0,
            kind,
            le,
            relative,
            nullValue));
  }

  /** Registers an encoded value as a possible {@code @ref} target. */
  public void refSite(String key, int start, Object value) {
    region.refSites.add(
        new Region.RefSite(key, b, start, b.size, Codecs.trackable(value) ? value : null));
  }

  // ── regions ─────────────────────────────────────────────────────────────────

  /** Writer state to restore after a nested region. */
  private record Saved(Block b, Region region, int index, int originBase) {}

  private Saved enterRegion(LayoutItem[] layout, Object value) {
    Saved saved = new Saved(b, region, index, originBase);
    Region nr = new Region();
    nr.layout = layout;
    int[] o = value != null && region.sticky != null && origins != null ? origins.ofRegion(value) : null;
    if (o != null) {
      nr.sticky = new Layout.StickyPolicy(region.sticky.grow(), o[1], o[2]);
      originBase = o[0];
    } else if (region.sticky != null) {
      nr.sticky = new Layout.StickyPolicy(region.sticky.grow(), -1, -1);
    }
    region = nr;
    b = nr.root;
    return saved;
  }

  private void restore(Saved s) {
    b = s.b();
    region = s.region();
    index = s.index();
    originBase = s.originBase();
  }

  /** Makes {@code l} the structure the region's layout matches against. */
  static void attach(Region region, LEntry l) {
    if (l instanceof LStruct s) region.lroot = s;
    else if (l != null) {
      LStruct s = new LStruct();
      s.set("$", l);
      region.lroot = s;
    }
    // The region's layout items were computed by its root struct's writer.
    if (region.layout == LayoutItem.OWN) region.layout = l instanceof LStruct s ? s.layout : null;
  }

  /**
   * Encodes a nested region (a codec's decoded side, a stream, a temporary encoding) and returns
   * its finished bytes. Nothing inside escapes to the enclosing region.
   */
  public byte[] subRegion(Supplier<LEntry> write) {
    Saved saved = enterRegion(null, null);
    Region nr = region;
    try {
      attach(nr, write.get());
      return nr.finish();
    } finally {
      restore(saved);
    }
  }

  /**
   * Writes a {@code @base} struct inline: its region (own block, targets, {@code @alignEnd}) is
   * laid out and finished on its own, then appended here. {@code @ref} pointers it can't resolve
   * search this base and the ones enclosing it.
   */
  public void base(LayoutItem[] layout, Supplier<LEntry> write, Object value) {
    Block anchor = b;
    int anchorAt = b.size;
    Saved saved = enterRegion(layout, value);
    Region nr = region;
    nr.escalate = true;
    // A nested base written inline lands where the enclosing block is now (`from: file`).
    nr.anchorBlock = anchor;
    nr.anchorAt = anchorAt;
    byte[] out;
    try {
      attach(nr, write.get());
      out = nr.finish();
    } finally {
      restore(saved);
    }
    Block block = b;
    int at = block.size;
    raw(out);
    // Its unresolved @refs now point from inside this block.
    for (Region.RefUse u : nr.unresolved) {
      int inner = u.baseBlock() != null ? u.baseBlock().pos + u.baseAt() : 0;
      region.refUses.add(u.moved(block, at + u.markBlock().pos + u.markAt(), block, at + inner));
    }
  }

  /** Pads the current base region's total size to a multiple of {@code to} ({@code @alignEnd}). */
  public void regionAlignEnd(long to) {
    region.alignEnd = Layout.lcm(region.alignEnd, to);
  }

  /**
   * A base's {@code @alignEnd(to, from: …, offset: k)}: pads the whole region until {@code (start
   * + size + k) % to == 0}, start being 0 or the region's start in its byte space.
   */
  public void regionAlignEnd(long to, boolean file, long offset) {
    if (to <= 0) throw Ints.range("invalid alignment " + to);
    if (!file && offset == 0) regionAlignEnd(to);
    else region.alignEnds.add(new long[] {to, file ? 1 : 0, offset});
  }

  /** Encodes a value standalone (its plain encoding as a fresh region). */
  public byte[] encodeAlone(Supplier<LEntry> write) {
    return subRegion(write);
  }

  static YaffleException input(String detail) {
    return new YaffleException(ErrorCode.INPUT, detail);
  }
}
