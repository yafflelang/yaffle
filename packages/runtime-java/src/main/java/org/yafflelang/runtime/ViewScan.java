package org.yafflelang.runtime;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.function.Supplier;
import java.util.function.ToLongFunction;

/**
 * Collects what a generated {@code scan} method finds besides scalars: byte ranges of fields and
 * view values of composite fields (child struct nodes, lists, lazy bytes, lazy targets, codec
 * regions, streams). Scans are how views read a struct without reading its targets or large data.
 */
public final class ViewScan {
  /** Reads one element of a lazy array (struct elements: child nodes via {@link #child}). */
  @FunctionalInterface
  public interface Elem {
    Object read(Reader r, ViewScan vs, int index);
  }

  /** Reads a target, region or stream value (structs: child nodes via {@link #child}). */
  @FunctionalInterface
  public interface Target {
    Object read(Reader r, ViewScan vs);
  }

  /** Encodes one element of a lazy scalar array (in-place patches). */
  @FunctionalInterface
  public interface ElemEncoder {
    byte[] encode(Object value);
  }

  final ViewRoot root;
  final ViewSpace space;
  final ViewNode node;
  final List<Object> path;
  final Map<String, Object> values = new HashMap<>();
  final Map<String, int[]> ranges = new HashMap<>();

  ViewScan(ViewRoot root, ViewSpace space, ViewNode node, List<Object> path) {
    this.root = root;
    this.space = space;
    this.node = node;
    this.path = path;
  }

  /** Records the byte range of a field. */
  public void range(String field, int start, int end) {
    ranges.put(field, new int[] {start, end});
  }

  /** Records the view value of a composite field. */
  public void put(String field, Object value) {
    values.put(field, value);
  }

  /** The view value recorded for a field (stream sources read it back). */
  public Object got(String field) {
    return values.get(field);
  }

  /** The absolute path of a value: this scan's path plus the frame's field and indices. */
  private List<Object> pathOf(Frame fr) {
    if (fr == null) return path;
    List<Object> p = new ArrayList<>(path);
    fr.appendTo(p);
    return p;
  }

  /** An inline struct: a child node (scanned now only if its size is not static). */
  public Object child(Reader r, StructInfo info, Object[] args, Frame fr) {
    ViewNode n =
        root.node(space, r.pos, info, args, r.base, r.end, r.index, r.strict, node, pathOf(fr));
    if (info.staticSize >= 0 && !info.base) {
      if ((long) r.pos + info.staticSize > r.end) {
        // Too short: scanning it now raises the error parsing would (at the field that crosses).
        n.ensureScanned();
        throw r.error(ErrorCode.EOF, "need " + info.staticSize + " bytes for " + info.name);
      }
      r.pos += info.staticSize;
    } else {
      n.ensureScanned();
      r.pos = n.extentEnd;
      if (r.pos > r.maxEnd) r.maxEnd = r.pos;
    }
    return n;
  }

  /** A fixed-size-element array: elements are read on access. */
  public Object lazyArray(
      Reader r, int count, int size, Elem elem, ElemEncoder encoder, Frame fr) {
    int start = r.pos;
    long total = (long) count * size;
    ListView<Object> list =
        new ListView<>(
            root, space, node, pathOf(fr), start, count, size, elem, encoder, r.base, r.end,
            r.strict);
    if (start + total > r.end) {
      // Too short: read the elements up to the one that crosses the end, in order, so the error
      // is the one parsing raises (an earlier element's check, or EOF inside that element).
      long whole = Math.max(0, (r.end - start) / size);
      for (int i = 0; i <= whole && i < count; i++) list.rawGet(i);
      throw r.error(ErrorCode.EOF, "need " + total + " bytes for " + count + " elements");
    }
    r.pos += (int) total;
    return list;
  }

  /** An array whose elements were read already (variable-size elements). */
  public Object arrayOf(List<Object> items, Frame fr) {
    return new ListView<>(root, space, node, pathOf(fr), items, null);
  }

  /** Bytes read on access. */
  public Object lazyBytes(Reader r, int n) {
    int start = r.pos;
    if (n < 0) throw r.error(ErrorCode.RANGE, "invalid length " + n);
    if ((long) start + n > r.end) {
      throw r.error(ErrorCode.EOF, "need " + n + " bytes at 0x" + Integer.toHexString(start));
    }
    r.pos += n;
    int base = r.base;
    int end = r.end;
    boolean strict = r.strict;
    return new Lazy(() -> space.reader(start, base, end, strict).bytes(n), space);
  }

  /** A pointer or {@code at} target, read on access. */
  public Object lazyTarget(Reader r, long addr, String key, Target read, Frame fr) {
    int base = r.base;
    int end = r.end;
    boolean strict = r.strict;
    List<Object> p = pathOf(fr);
    String field = fr != null ? fr.f : "";
    ViewNode owner = node;
    // The original target (sticky layout): its size is known once it is read.
    boolean tracked = owner != null && !field.isEmpty();
    if (tracked && addr >= 0 && addr <= Integer.MAX_VALUE) {
      owner.targets.put(field, new int[] {(int) addr, -1});
    }
    String cacheKey = space.id + ":" + addr + ":" + key;
    return new Lazy(
        () -> {
          if (addr < 0 || addr > space.length()) {
            throw new YaffleException(
                    ErrorCode.EOF,
                    "target address 0x" + Long.toHexString(addr) + " is outside the data",
                    space.outer >= 0 ? space.outer : addr)
                .prefixAll(p)
                .seal();
          }
          // List views of shared targets are one object, so edits through either are the same.
          Object cached = root.lists.get(cacheKey);
          if (cached != null) return cached;
          Reader r2 = space.reader((int) addr, base, end, strict);
          Object v;
          try {
            v = Lazy.force(read.read(r2, new ViewScan(root, space, owner, p)));
          } catch (YaffleException e) {
            throw e.prefixAll(p).seal();
          }
          if (tracked) owner.targets.put(field, new int[] {(int) addr, r2.pos - (int) addr});
          if (v instanceof ListView<?>) root.lists.put(cacheKey, v);
          return v;
        },
        space);
  }

  /**
   * A value read on access from the byte space {@code make} gives (a codec's decoded side, a
   * stream). Errors get the value's path.
   */
  private Object inSpace(boolean strict, List<Object> p, Supplier<ViewSpace> make, Target read) {
    ViewNode owner = node;
    return new Lazy(
        () -> {
          try {
            ViewSpace sp = make.get();
            Reader r2 = sp.reader(0, 0, sp.length(), strict);
            return Lazy.force(read.read(r2, new ViewScan(root, sp, owner, p)));
          } catch (YaffleException e) {
            throw e.prefixAll(p).seal();
          }
        },
        space);
  }

  /**
   * A codec region: decoded on access. Streaming codecs are decoded right away (their encoded
   * length is only known after decoding). {@code @ranged} codecs decode only the blocks a read
   * touches (each slice with its position in the region).
   */
  public Object lazyRegion(
      Reader r,
      Codec codec,
      String name,
      CodecCtx ctx,
      boolean streaming,
      boolean ranged,
      String slot,
      Frame fr,
      Target read) {
    int start = r.pos;
    long at = r.at(start);
    int end = r.end;
    byte[] early = null;
    if (streaming) {
      byte[] input = space.reader(start, r.base, r.end, r.strict).peekBytes(start, r.end);
      Decoded d = Codecs.decode(codec, name, input, ctx, true, at);
      early = d.output();
      end = start + d.consumed();
    }
    r.pos = end;
    byte[] decoded = early;
    int stop = end;
    // Decoded once per view, however often the region is read.
    String key = space.id + ":" + start + ":" + slot;
    Supplier<ViewSpace> make =
        () ->
            root.regions.computeIfAbsent(
                key,
                k -> {
                  if (ranged && !streaming) {
                    Store.RangedDecoder rd =
                        (in, position) ->
                            Codecs.decode(codec, name, in, new CodecCtx(ctx.args(), -1, position), false, at)
                                .output();
                    return new ViewSpace(root, new Store.Ranged(space, start, stop - start, rd, at), false, at);
                  }
                  byte[] out = decoded;
                  if (out == null) out = Codecs.decode(codec, name, space.bytes(start, stop), ctx, false, at).output();
                  return new ViewSpace(root, out, false, at);
                });
    return inSpace(r.strict, pathOf(fr), make, read);
  }

  /** A field read from a stream (its bytes computed on access). */
  public Object lazyStream(Reader r, Supplier<byte[]> stream, Frame fr, Target read) {
    long at = r.at(r.pos);
    return inSpace(r.strict, pathOf(fr), () -> new ViewSpace(root, stream.get(), false, at), read);
  }

  /**
   * A field read from {@code arr[*].field}: when every piece's decoded length is known from its
   * element's scalars ({@code len}, -1 or null: unknown), the stream is a lazy space that decodes
   * a piece only when a read touches it; otherwise every piece is decoded on first access.
   *
   * @param arr the array's view value (a list view of element nodes) or plain list
   * @param field the piece field
   * @param piece the piece of a plain element value
   * @param len the piece's decoded length from a plain element value, or null if not known
   */
  public Object lazyPieces(
      Reader r,
      Object arr,
      String field,
      Function<Object, Object> piece,
      ToLongFunction<Object> len,
      Frame fr,
      Target read) {
    long at = r.at(r.pos);
    return inSpace(r.strict, pathOf(fr), () -> pieceSpace(arr, field, piece, len, at), read);
  }

  private static List<Object> elements(Object arr) {
    if (arr instanceof ListView<?> lv) {
      List<Object> out = new ArrayList<>(lv.size());
      for (int i = 0; i < lv.size(); i++) out.add(lv.rawGet(i));
      return out;
    }
    if (arr == null) throw new YaffleException(ErrorCode.INPUT, "stream source is missing");
    return new ArrayList<>((List<?>) arr);
  }

  private static byte[] pieceOf(Object e, String field, Function<Object, Object> piece) {
    Object v;
    if (e instanceof ViewNode n) {
      Object raw = n.rawValue(field);
      v = raw != null ? Lazy.force(raw) : piece.apply(n.value());
    } else v = piece.apply(Lazy.force(e));
    if (!(v instanceof byte[] b)) {
      throw new YaffleException(ErrorCode.INPUT, "stream piece " + field + " is missing");
    }
    return b;
  }

  private static byte[] joined(List<Object> items, String field, Function<Object, Object> piece) {
    List<byte[]> all = new ArrayList<>(items.size());
    for (Object e : items) all.add(pieceOf(e, field, piece));
    return Streams.join(all);
  }

  private ViewSpace pieceSpace(
      Object arr, String field, Function<Object, Object> piece, ToLongFunction<Object> len, long at) {
    List<Object> items = elements(arr);
    int n = items.size();
    int[] starts = new int[n + 1];
    boolean known = len != null;
    for (int k = 0; k < n && known; k++) {
      Object e = items.get(k);
      long l = len.applyAsLong(e instanceof ViewNode vn ? vn.value() : Lazy.force(e));
      if (l < 0 || starts[k] + l > Integer.MAX_VALUE - 8) known = false;
      else starts[k + 1] = (int) (starts[k] + l);
    }
    if (!known) return new ViewSpace(root, joined(items, field, piece), false, at);
    return new ViewSpace(
        root, new Store.Pieces(starts, k -> pieceOf(items.get(k), field, piece)), false, at);
  }

  /** {@code arr[*].field} joined (every piece decoded): streams that slice joined pieces. */
  public static byte[] joinPieces(Object arr, String field, Function<Object, Object> piece) {
    return joined(elements(arr), field, piece);
  }

  /** A bytes field's value from its view value (forcing lazy bytes or regions). */
  public static byte[] bytesOf(Object v) {
    if (Lazy.force(v) instanceof byte[] b) return b;
    throw new YaffleException(ErrorCode.INPUT, "stream source is not bytes");
  }

  /** The view of a view value: struct nodes become their typed views. */
  static Object toView(Object v) {
    return v instanceof ViewNode n ? n.view() : v;
  }
}
