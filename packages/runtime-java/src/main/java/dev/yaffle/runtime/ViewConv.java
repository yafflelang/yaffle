package dev.yaffle.runtime;

import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;

/**
 * Turns a view (with its edits) into a plain value for the writer. Unchanged nodes are read
 * from the source with one reader per byte space, so shared targets stay one object; nodes with
 * edits below them are read the same way and then get their edited fields. The reader of the
 * source records where every target was (sticky layout) and which byte arrays were copied from
 * it (patch anchors).
 */
final class ViewConv implements Writer.Origins {
  private final ViewRoot root;
  private final Map<ViewSpace, Reader> readers = new IdentityHashMap<>();
  private final Reader source;
  private final IdentityHashMap<Object, ViewNode> nodeOf = new IdentityHashMap<>();

  ViewConv(ViewRoot root) {
    this.root = root;
    if (root == null) {
      this.source = null;
      return;
    }
    this.source = root.space.reader(0, 0, root.space.length(), root.spec.strict());
    source.trackOrigins();
    readers.put(root.space, source);
  }

  IdentityHashMap<byte[], Integer> provenance() {
    return source.provenance;
  }

  private Reader reader(ViewSpace sp) {
    return readers.computeIfAbsent(sp, s -> s.reader(0, 0, s.length(), root != null && root.spec.strict()));
  }

  /** The plain value of a node. */
  Object value(ViewNode n) {
    if (n.isDetached()) return detachedValue(n);
    Object obj = readNode(reader(n.space), n);
    nodeOf.put(obj, n);
    if (!n.dirtyBelow) return obj;
    applyEdits(n, obj);
    return obj;
  }

  private Object detachedValue(ViewNode n) {
    if (!n.dirtyBelow) return n.detached;
    Object obj = n.info.copy.apply(n.detached);
    applyEdits(n, obj);
    return obj;
  }

  private void applyEdits(ViewNode n, Object obj) {
    for (StructInfo.Field f : n.info.fields.values()) {
      String name = f.name();
      if (n.editedNames.contains(name)) {
        f.set().accept(obj, f.get().apply(n.value()));
        continue;
      }
      Object raw;
      boolean edited = n.compEdits.containsKey(name);
      if (edited) raw = n.compEdits.get(name);
      else if (n.wrapped.containsKey(name)) raw = n.wrapped.get(name);
      else if (f.kind() == StructInfo.Kind.VIEW && !n.isDetached()) raw = n.rawValue(name);
      else continue;
      if (raw == null) {
        if (edited) f.set().accept(obj, null);
        continue;
      }
      if (edited || ListView.isDirty(raw)) f.set().accept(obj, convert(raw));
    }
  }

  /** The plain value of a view value. */
  Object convert(Object raw) {
    if (raw instanceof Lazy l) return convert(l.get());
    if (raw instanceof ViewNode n) return value(n);
    if (raw instanceof StructView v) return value(v.node);
    if (raw instanceof ListView<?> l) {
      List<Object> out = new ArrayList<>(l.size());
      for (int i = 0; i < l.size(); i++) out.add(convert(l.rawGet(i)));
      return out;
    }
    if (raw instanceof List<?> l) {
      List<Object> out = new ArrayList<>(l.size());
      for (Object o : l) out.add(convert(o));
      return out;
    }
    return raw;
  }

  private static String key(ViewNode n) {
    StringBuilder sb = new StringBuilder(n.info.key).append('(');
    for (int i = 0; i < n.args.length; i++) {
      if (i > 0) sb.append(',');
      sb.append(n.args[i]);
    }
    return sb.append(')').toString();
  }

  /** Reads a node from its byte space (one object per position and type). */
  private Object readNode(Reader r, ViewNode n) {
    int pos = r.pos;
    int base = r.base;
    int end = r.end;
    int index = r.index;
    boolean strict = r.strict;
    r.pos = n.pos;
    r.base = n.base;
    r.end = n.end;
    r.index = n.index;
    r.strict = n.strict;
    try {
      return r.inline(key(n), n.info.make, () -> n.info.read.read(r, n.args));
    } catch (YaffleException e) {
      throw e.prefixAll(n.path);
    } finally {
      r.pos = pos;
      r.base = base;
      r.end = end;
      r.index = index;
      r.strict = strict;
    }
  }

  // ── origins (sticky layout) ─────────────────────────────────────────────────

  @Override
  public int[] of(Object value) {
    return source.origins.get(value);
  }

  @Override
  public int[] ofSlot(Object owner, String field) {
    ViewNode n = nodeOf.get(owner);
    if (n == null || n.space != root.space) return null;
    int[] t = n.originalTarget(field);
    if (t != null && t[1] < 0) {
      Object raw = n.scanned(field);
      if (raw != null) Lazy.force(raw);
      t = n.originalTarget(field);
    }
    return t != null && t[1] >= 0 ? t : null;
  }

  @Override
  public int[] ofRegion(Object value) {
    return source.regions.get(value);
  }
}
