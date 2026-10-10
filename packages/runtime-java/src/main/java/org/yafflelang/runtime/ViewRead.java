package org.yafflelang.runtime;

import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.List;

/**
 * Reads a whole view into a plain value through the view itself: every output field is fetched
 * the way the generated getters fetch it (scanned scalars, child nodes, lazy lists, targets,
 * codec regions and streams), so the result exercises the view's own code paths rather than the
 * generated reader. Shared targets stay shared (one plain object per node or list view).
 */
public final class ViewRead {
  private final IdentityHashMap<Object, Object> memo = new IdentityHashMap<>();

  private ViewRead() {}

  /** The plain value of a view, read field by field through it. */
  public static Object materialize(StructView view) {
    return new ViewRead().node(view.node);
  }

  private Object node(ViewNode n) {
    if (n.isDetached() && !n.dirtyBelow) return n.detached;
    Object hit = memo.get(n);
    if (hit != null) return hit;
    Object plain = n.value();
    // A copy of the scanned value keeps what isn't a field (presence flags of conditional nullable
    // fields); every field is then set from the view.
    Object obj = plain != null ? n.info.copy.apply(plain) : n.info.make.get();
    memo.put(n, obj);
    for (StructInfo.Field f : n.info.fields.values()) {
      Object v;
      if (f.kind() == StructInfo.Kind.VIEW || n.compEdits.containsKey(f.name())) {
        try {
          v = convert(Lazy.force(n.raw(f.name(), null)));
        } catch (YaffleException e) {
          throw n.fieldError(e, f.name());
        }
      } else {
        v = f.get().apply(plain);
      }
      f.set().accept(obj, v);
    }
    return obj;
  }

  private Object convert(Object raw) {
    if (raw instanceof Lazy l) return convert(l.get());
    if (raw instanceof ViewNode n) return node(n);
    if (raw instanceof StructView v) return node(v.node);
    if (raw instanceof ListView<?> l) {
      Object hit = memo.get(l);
      if (hit != null) return hit;
      List<Object> out = new ArrayList<>(l.size());
      memo.put(l, out);
      for (int i = 0; i < l.size(); i++) out.add(convert(l.rawGet(i)));
      return out;
    }
    return raw;
  }
}
