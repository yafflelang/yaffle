package dev.yaffle.runtime;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.function.Supplier;

/**
 * The read context (docs/IR.md §2.1) used by generated readers: position, base, region end, array
 * index and strict flag over a byte array, plus primitive, string, padding and target readers.
 * Positions, {@code base} and {@code end} are absolute within the array.
 */
public final class Reader {
  /** Identity key of a target or inline struct: address and type key. */
  private record Key(int addr, String key) {}

  final byte[] buf;
  public int pos;
  public int base;
  public int end;
  public int index = -1;
  public boolean strict;
  /** Furthest position read inside the current base (a base struct consumes it all). */
  public int maxEnd;
  /** Set by a base struct's reader: the end of its inline bytes (before its targets). */
  public int inlineEnd = -1;
  /** End position of the last target read with {@code target()}. */
  public int lastTargetEnd;
  /** Offset reported for errors inside a decoded region (the encoded window), or -1. */
  final long outer;
  /** Object a struct reader fills instead of a new one (registered before reading: cycles). */
  private Object into;
  /** Loads the bytes of a lazy view space before they are read, or null (all bytes present). */
  final Store store;

  /** View commits: where each target was read ({pos, size}). */
  IdentityHashMap<Object, int[]> origins;
  /** View commits: base struct values read: {base, inline size, size}. */
  IdentityHashMap<Object, int[]> regions;
  /** View commits: large byte arrays copied from the source, by offset. */
  IdentityHashMap<byte[], Integer> provenance;

  private final HashMap<Key, Object> ident = new HashMap<>();
  private final HashMap<Key, Integer> identEnd = new HashMap<>();
  private final HashSet<Key> inProgress = new HashSet<>();

  public Reader(byte[] bytes) {
    this(bytes, false);
  }

  public Reader(byte[] bytes, boolean strict) {
    this(bytes, strict, -1, null);
  }

  Reader(byte[] bytes, boolean strict, long outer, Store store) {
    this.buf = bytes;
    this.end = bytes.length;
    this.strict = strict;
    this.outer = outer;
    this.store = store;
  }

  /** Records target positions, base regions and copied byte arrays (view commits). */
  void trackOrigins() {
    origins = new IdentityHashMap<>();
    regions = new IdentityHashMap<>();
    provenance = new IdentityHashMap<>();
  }

  /** Called by generated readers of base structs when origins are tracked. */
  public void noteRegion(Object value, int start, int inlineEnd) {
    if (regions != null) regions.put(value, new int[] {start, inlineEnd - start, pos - start});
  }

  /** True while view commits track origins. */
  public boolean tracking() {
    return regions != null;
  }

  /** A reader for a fresh region (virtual stream): base 0, end = length. */
  public Reader sub(byte[] bytes) {
    return decoded(bytes, pos);
  }

  /** A reader over a codec's decoded output, reporting errors at {@code at} of this region. */
  public Reader decoded(byte[] bytes, int at) {
    Reader r = new Reader(bytes, strict, outer >= 0 ? outer : at, null);
    r.into = into;
    into = null;
    return r;
  }

  /** Called first by every generated struct reader: the pre-registered object to fill, if any. */
  public Object takeInto() {
    Object o = into;
    into = null;
    return o;
  }

  /** Bytes {@code [start, end)} (absolute) without moving {@code pos}. */
  public byte[] peekBytes(int start, int end) {
    if (start < 0 || end > buf.length || start > end) {
      throw error(
          ErrorCode.EOF,
          "range [0x" + Integer.toHexString(start) + ", 0x" + Integer.toHexString(end)
              + ") is outside the data",
          start);
    }
    if (store != null) store.ensure(start, end - start);
    return Arrays.copyOfRange(buf, start, end);
  }

  // ── errors ──────────────────────────────────────────────────────────────────

  /** The offset errors at {@code offset} report (inside a decoded region: its encoded window). */
  public long at(long offset) {
    return outer >= 0 ? outer : offset;
  }

  public YaffleException error(ErrorCode code, String detail) {
    return new YaffleException(code, detail, at(pos));
  }

  public YaffleException error(ErrorCode code, String detail, long offset) {
    return new YaffleException(code, detail, at(offset));
  }

  public YaffleException checkFail(String message, long offset) {
    return error(ErrorCode.CHECK, "check failed: " + message, offset);
  }

  // ── bounds and windows ──────────────────────────────────────────────────────

  /** Ensures {@code n} bytes are readable at {@code pos} (EOF past the region end). */
  public void need(int n) {
    if (n < 0 || (long) pos + n > end) {
      throw error(
          ErrorCode.EOF,
          "need " + n + " bytes at 0x" + Integer.toHexString(pos) + ", region ends at 0x"
              + Integer.toHexString(end));
    }
    if (store != null) store.ensure(pos, n);
  }

  /** Narrows the region to {@code n} bytes from {@code pos}; returns the previous end. */
  public int window(long n) {
    int saved = end;
    if (n < 0) throw error(ErrorCode.RANGE, "invalid size " + n);
    if (pos + n > saved) {
      throw error(
          ErrorCode.EOF,
          "size " + n + " at 0x" + Integer.toHexString(pos) + " exceeds the region end 0x"
              + Integer.toHexString(saved));
    }
    end = pos + (int) n;
    return saved;
  }

  /** Skips the rest of the window (padding, strict: zero) and restores the outer end. */
  public void closeWindow(int saved, boolean strict) {
    int left = end - pos;
    if (left > 0) pad(left, Fill.ZERO, strict);
    end = saved;
  }

  // ── integers and floats ─────────────────────────────────────────────────────

  public int u8() {
    need(1);
    return buf[pos++] & 0xff;
  }

  public int i8() {
    need(1);
    return buf[pos++];
  }

  public int u16(boolean le) {
    need(2);
    int v = Bytes.u16(buf, pos, le);
    pos += 2;
    return v;
  }

  public int i16(boolean le) {
    return (short) u16(le);
  }

  public int u24(boolean le) {
    return (int) uN(3, le);
  }

  public int i24(boolean le) {
    return (int) Bytes.signExtend(u24(le), 24);
  }

  public long u32(boolean le) {
    return i32(le) & 0xffffffffL;
  }

  public int i32(boolean le) {
    need(4);
    int v = Bytes.i32(buf, pos, le);
    pos += 4;
    return v;
  }

  /** Unsigned N-byte integer (N = 3, 5, 6, 7). */
  public long uN(int size, boolean le) {
    need(size);
    long v = Bytes.readUInt(buf, pos, size, le);
    pos += size;
    return v;
  }

  /** Signed N-byte integer (N = 5, 6, 7). */
  public long iN(int size, boolean le) {
    return Bytes.signExtend(uN(size, le), size * 8);
  }

  /** u64 as its unsigned bit pattern. */
  public long u64(boolean le) {
    need(8);
    long v = Bytes.i64(buf, pos, le);
    pos += 8;
    return v;
  }

  public long i64(boolean le) {
    return u64(le);
  }

  public double f16(boolean le) {
    return Bytes.halfToDouble(u16(le));
  }

  public float f32(boolean le) {
    return Float.intBitsToFloat(i32(le));
  }

  public double f64(boolean le) {
    return Double.longBitsToDouble(u64(le));
  }

  /** Any integer primitive as a long (u64: bit pattern; signed values sign-extended). */
  public long prim(Prim p, boolean le) {
    long v = uN(p.size, le);
    return p.signed ? Bytes.signExtend(v, p.bits) : v;
  }

  public boolean bool(boolean strict) {
    int at = pos;
    int b = u8();
    if (strict && b > 1) {
      throw error(ErrorCode.CHECK, "bool byte 0x" + Integer.toHexString(b) + " is not 0 or 1", at);
    }
    return b != 0;
  }

  /** A count no region could hold: EOF (the data cannot have that many units). */
  private YaffleException tooLong(String v) {
    return error(
        ErrorCode.EOF, "length " + v + " needs more than the " + Math.max(0, end - pos) + " bytes left");
  }

  /**
   * A count read from the data (array/bytes/string length): negative is RANGE; a count no region
   * could hold is EOF. Smaller counts fail on the element that crosses the end.
   */
  public int count(long v, int unit) {
    if (v < 0) throw error(ErrorCode.RANGE, "length " + v + " is negative");
    if (v > Integer.MAX_VALUE || (unit > 0 && v * (long) unit > Integer.MAX_VALUE)) {
      throw tooLong(Long.toString(v));
    }
    return (int) v;
  }

  public int count(BigInteger v, int unit) {
    if (v.signum() < 0) throw error(ErrorCode.RANGE, "length " + v + " is negative");
    if (v.bitLength() > 62) throw tooLong(v.toString());
    return count(v.longValue(), unit);
  }

  /** A u64 count (unsigned bit pattern). */
  public int countU64(long raw, int unit) {
    if (raw < 0) throw tooLong(Long.toUnsignedString(raw));
    return count(raw, unit);
  }

  // ── bytes ───────────────────────────────────────────────────────────────────

  /** {@code n} bytes (a copy). */
  public byte[] bytes(int n) {
    need(n);
    byte[] out = Arrays.copyOfRange(buf, pos, pos + n);
    // Large arrays copied from a view's source are kept as unchanged anchors on commit.
    if (provenance != null && n >= 512) provenance.put(out, pos);
    pos += n;
    return out;
  }

  /** Bytes up to a terminator byte (consumed, not part of the value). */
  public byte[] bytesUntil(long term) {
    byte t = (byte) term;
    int i = pos;
    if (store == null) {
      while (i < end && buf[i] != t) i++;
    } else {
      // Lazy space: load as the scan goes.
      while (i < end) {
        int lim = store.ensureFrom(i, end);
        while (i < lim && buf[i] != t) i++;
        if (i < lim) break;
      }
    }
    if (i >= end) throw error(ErrorCode.EOF, "terminator not found before the region end");
    byte[] out = bytes(i - pos);
    pos += 1;
    return out;
  }

  /** Bytes to the end of the region. */
  public byte[] bytesRest() {
    return bytes(end - pos);
  }

  /** Units from {@code pos} up to the first NUL unit (EOF if there is none before the end). */
  private int findNulUnit(int unit) {
    int avail = (end - pos) / unit;
    if (store == null) {
      int i = Encoding.findNul(buf, pos, avail, unit);
      if (i < 0) throw error(ErrorCode.EOF, "terminator not found before the region end");
      return i;
    }
    // Lazy space: load as the scan goes (a unit may straddle two loads).
    int done = 0;
    while (done < avail) {
      int at = pos + done * unit;
      int lim = store.ensureFrom(at, end);
      int n = Math.min(avail - done, (lim - at) / unit);
      if (n <= 0) {
        store.ensure(at, unit);
        n = 1;
      }
      int k = Encoding.findNul(buf, at, n, unit);
      if (k >= 0) return done + k;
      done += n;
    }
    throw error(ErrorCode.EOF, "terminator not found before the region end");
  }

  // ── strings ─────────────────────────────────────────────────────────────────

  /** Fixed length: {@code nUnits} code units, the value stops at the first NUL unit. */
  public String str(int nUnits, int unit, Encoding enc, boolean le) {
    int n = nUnits * unit;
    need(n);
    int nul = Encoding.findNul(buf, pos, nUnits, unit);
    String s = enc.decode(buf, pos, nul < 0 ? nUnits : nul, le, at(pos));
    pos += n;
    return s;
  }

  /** NUL-terminated: units up to a NUL unit (consumed). */
  public String strUntil(int unit, Encoding enc, boolean le) {
    String s = str(findNulUnit(unit), unit, enc, le);
    pos += unit;
    return s;
  }

  /** To the end of the region (the value stops at the first NUL unit). */
  public String strRest(int unit, Encoding enc, boolean le) {
    return str((end - pos) / unit, unit, enc, le);
  }

  // ── padding ─────────────────────────────────────────────────────────────────

  /** Skips {@code n} padding bytes; in strict mode they must match the fill. */
  public void pad(long n, Fill fill, boolean strict) {
    if (n < 0 || n > Integer.MAX_VALUE) throw error(ErrorCode.RANGE, "invalid padding length " + n);
    int k = (int) n;
    need(k);
    if (strict) {
      for (int i = 0; i < k; i++) {
        byte want = fill.byteAt(i);
        if (buf[pos + i] != want) {
          throw error(
              ErrorCode.CHECK,
              "padding byte 0x" + Integer.toHexString(buf[pos + i] & 0xff) + " is not 0x"
                  + Integer.toHexString(want & 0xff),
              pos + i);
        }
      }
    }
    pos += k;
  }

  /** {@code align(to)}: pads until {@code (pos - base) % to == 0}. */
  public void align(long to, Fill fill, boolean strict) {
    alignAt(to, false, 0, fill, strict);
  }

  /**
   * {@code align(to, from: …, offset: k)}: pads until {@code (pos - origin + k) % to == 0}, where
   * the origin is the base or, with {@code file}, the start of this byte space (the source, a
   * codec's decoded region or a stream: position 0 of this reader).
   */
  public void alignAt(long to, boolean file, long offset, Fill fill, boolean strict) {
    if (to <= 0) throw error(ErrorCode.RANGE, "invalid alignment " + to);
    long rel = pos - (file ? 0 : base) + offset;
    pad(Math.floorMod(-rel, to), fill, strict);
  }

  /** {@code padUntil(size)} after content that started at {@code start}. */
  public void padUntil(int start, long size, Fill fill, boolean strict) {
    int used = pos - start;
    if (used > size) {
      throw error(
          ErrorCode.CHECK, "content of " + used + " bytes exceeds padUntil(" + size + ")", start);
    }
    pad(size - used, fill, strict);
  }

  // ── targets ─────────────────────────────────────────────────────────────────

  private int checkAddr(long addr) {
    if (addr < 0 || addr > buf.length) {
      throw error(ErrorCode.EOF, "target address 0x" + Long.toHexString(addr) + " is outside the data");
    }
    return (int) addr;
  }

  private static Key key(long addr, String key) {
    return new Key((int) Math.max(Math.min(addr, Integer.MAX_VALUE), Integer.MIN_VALUE), key);
  }

  /** A target already read: its value (and where it ended). */
  @SuppressWarnings("unchecked")
  private <T> T known(Key k) {
    lastTargetEnd = identEnd.getOrDefault(k, k.addr);
    return (T) ident.get(k);
  }

  /** Bookkeeping after a target at {@code a} was read: its end, the base's extent, its origin. */
  private void readTarget(Key k, int a, Object v) {
    identEnd.put(k, pos);
    lastTargetEnd = pos;
    if (pos > maxEnd) maxEnd = pos;
    if (origins != null && v != null) origins.put(v, new int[] {a, pos - a});
  }

  /**
   * Reads a pointer or {@code at} target at absolute {@code addr} without moving {@code pos}. The
   * same address and type key give the same value object within this region.
   */
  public <T> T target(long addr, String key, Supplier<T> read) {
    Key k = key(addr, key);
    if (ident.containsKey(k)) return known(k);
    int a = checkAddr(addr);
    if (inProgress.contains(k)) {
      throw error(ErrorCode.CHECK, "pointer cycle at 0x" + Integer.toHexString(a));
    }
    int savePos = pos;
    int saveIndex = index;
    inProgress.add(k);
    pos = a;
    index = -1;
    try {
      T v = read.get();
      ident.put(k, v);
      readTarget(k, a, v);
      return v;
    } finally {
      inProgress.remove(k);
      pos = savePos;
      index = saveIndex;
    }
  }

  /**
   * A struct target: the object made by {@code make} is registered under (address, type) before
   * its contents are read, so pointers back to it (cycles) get the same object.
   */
  public <T> T targetStruct(long addr, String key, Supplier<?> make, Supplier<T> read) {
    Key k = key(addr, key);
    if (ident.get(k) != null) return known(k);
    int a = checkAddr(addr);
    ident.put(k, make.get());
    identEnd.put(k, a);
    int savePos = pos;
    int saveIndex = index;
    pos = a;
    index = -1;
    into = ident.get(k);
    try {
      T v = read.get();
      readTarget(k, a, v);
      return v;
    } catch (RuntimeException e) {
      ident.remove(k);
      throw e;
    } finally {
      into = null;
      pos = savePos;
      index = saveIndex;
    }
  }

  /** An inline struct of a type pointers can target: one object per (address, type). */
  public <T> T inline(String key, Supplier<?> make, Supplier<T> read) {
    into = ident.computeIfAbsent(new Key(pos, key), k -> make.get());
    try {
      return read.get();
    } finally {
      into = null;
    }
  }

  /** Runs {@code read} at absolute {@code addr} and restores {@code pos} (no identity tracking). */
  public <T> T peekAt(long addr, Supplier<T> read) {
    int savePos = pos;
    pos = checkAddr(addr);
    try {
      T v = read.get();
      if (pos > maxEnd) maxEnd = pos;
      return v;
    } finally {
      pos = savePos;
    }
  }

  // ── unions ──────────────────────────────────────────────────────────────────

  /**
   * Tries each variant at {@code pos}; the first that reads without error wins. Failed variants
   * restore {@code pos}. No match is a UNION error listing every variant's error.
   */
  @SafeVarargs
  public final <T> T union(String[] names, Supplier<? extends T>... alts) {
    int start = pos;
    int saveEnd = end;
    List<YaffleException> errors = new ArrayList<>();
    for (int k = 0; k < alts.length; k++) {
      try {
        return alts[k].get();
      } catch (YaffleException e) {
        errors.add(e.prefix(names[k]));
        pos = start;
        end = saveEnd;
      }
    }
    StringBuilder sb = new StringBuilder("no variant matched (");
    for (int k = 0; k < errors.size(); k++) {
      if (k > 0) sb.append("; ");
      sb.append(errors.get(k).getMessage());
    }
    sb.append(')');
    throw new YaffleException(ErrorCode.UNION, sb.toString(), at(start), errors);
  }

  // ── extern types ────────────────────────────────────────────────────────────

  /** Reads an extern type: host {@code size()} (unless fixed), then {@code read()}. */
  public Object extern(ExternType<?> host, Object[] args, int fixedSize) {
    int start = pos;
    int size = fixedSize;
    // Probe with growing prefixes until the host can tell the size.
    for (int probe = Math.min(end - pos, 16); size < 0; probe = (int) Math.min(end - pos, probe * 2L)) {
      need(probe);
      byte[] view = Arrays.copyOfRange(buf, pos, pos + probe);
      try {
        size = host.size(view, args);
      } catch (YaffleException e) {
        throw e;
      } catch (RuntimeException e) {
        throw Rt.hostError(e, "extern type size()", at(start));
      }
      if (size < 0 && probe >= end - pos) {
        throw error(ErrorCode.EOF, "extern type needs more bytes than the region has");
      }
    }
    byte[] bytes = bytes(size);
    try {
      return host.read(bytes, args);
    } catch (YaffleException e) {
      throw e;
    } catch (RuntimeException e) {
      throw Rt.hostError(e, "extern type read()", at(start));
    }
  }
}
