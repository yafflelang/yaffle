package org.yafflelang.runtime;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The state behind a struct view: where the struct is, its scanned values (scalars in a plain
 * value, composite fields as view values with byte ranges), and its edits.
 *
 * <ul>
 *   <li>Setting a field of the same encoded size that nothing else depends on patches the source
 *       in place.
 *   <li>Any other edit is structural: the node keeps its values frozen and records the edit;
 *       {@code commit()} re-encodes the root with the generated writer.
 * </ul>
 */
public final class ViewNode {
  final ViewRoot root;
  final ViewSpace space;
  final StructInfo info;
  final int pos;
  final Object[] args;
  final int base;
  final int end;
  final int index;
  final boolean strict;
  final ViewNode parent;
  final List<Object> path;
  /** Detached nodes (views of plain values) have no position. */
  final Object detached;

  private Object shallow;
  private Map<String, Object> values;
  private Map<String, int[]> ranges;
  private int version = -1;
  int inlineEnd = -1;
  int extentEnd = -1;
  /** Values no longer follow the source (structural edits here or in a child list). */
  private boolean frozen;
  /** Plain value with structural scalar edits applied (a copy of the scanned value). */
  private Object edited;
  final Set<String> editedNames = new HashSet<>();
  /** Structural edits of composite fields: plain values or views. */
  final Map<String, Object> compEdits = new HashMap<>();
  /** Views made for plain composite values (eagerly read fields, detached nodes). */
  final Map<String, Object> wrapped = new HashMap<>();
  /** Original targets of pointer and {@code at} fields: {pos, size}, recorded when read. */
  final Map<String, int[]> targets = new HashMap<>();
  /** An edit happened in this node or below it. */
  boolean dirtyBelow;
  private StructView view;

  ViewNode(
      ViewRoot root,
      ViewSpace space,
      StructInfo info,
      int pos,
      Object[] args,
      int base,
      int end,
      int index,
      boolean strict,
      ViewNode parent,
      List<Object> path) {
    this.root = root;
    this.space = space;
    this.info = info;
    this.pos = pos;
    this.args = args;
    this.base = base;
    this.end = end;
    this.index = index;
    this.strict = strict;
    this.parent = parent;
    this.path = path;
    this.detached = null;
  }

  /** A detached node: a view of a plain value. */
  ViewNode(StructInfo info, Object value, ViewNode parent, ViewRoot root) {
    this.root = root;
    this.space = null;
    this.info = info;
    this.pos = -1;
    this.args = new Object[0];
    this.base = 0;
    this.end = 0;
    this.index = -1;
    this.strict = false;
    this.parent = parent;
    this.path = parent != null ? parent.path : List.of();
    this.detached = value;
  }

  /** A node for a plain value (a detached view, not backed by bytes). */
  public static ViewNode detached(StructInfo info, Object value) {
    if (value == null) throw new YaffleException(ErrorCode.INPUT, "expected an object, got null");
    return new ViewNode(info, value, null, null);
  }

  /** A plain value of this node, with its edits. */
  public Object toValue() {
    return new ViewConv(root).value(this);
  }

  /** Makes {@code v} this node's view (the root view after a commit). */
  void adopt(StructView v) {
    view = v;
  }

  /** The typed view of this node. */
  public StructView view() {
    if (view == null) view = info.view.apply(this);
    return view;
  }

  boolean isDetached() {
    return detached != null;
  }

  void ensureScanned() {
    if (detached != null) return;
    if (shallow != null && (frozen || version == space.version)) return;
    Reader r = space.reader(pos, base, end, strict);
    r.index = index;
    ViewScan vs = new ViewScan(root, space, this, path);
    Object s;
    try {
      s = info.scan.scan(r, vs, args);
    } catch (YaffleException e) {
      throw e.prefixAll(path).seal();
    }
    shallow = s;
    values = vs.values;
    ranges = vs.ranges;
    inlineEnd = info.base && r.inlineEnd >= 0 ? r.inlineEnd : r.pos;
    extentEnd = r.pos;
    version = space.version;
  }

  /** Size of the struct's bytes (a base struct includes its targets); -1 for detached nodes. */
  public int size() {
    if (detached != null) return -1;
    if (info.staticSize >= 0 && !info.base) return info.staticSize;
    ensureScanned();
    return extentEnd - pos;
  }

  /** The plain value with the scalars (edits applied). */
  public Object value() {
    if (edited != null) return edited;
    if (detached != null) return detached;
    ensureScanned();
    return shallow;
  }

  int[] range(String name) {
    ensureScanned();
    return ranges == null ? null : ranges.get(name);
  }

  /** The view value the scan made for a field (ignoring edits), or null. */
  Object scanned(String name) {
    if (detached != null) return null;
    ensureScanned();
    return values.get(name);
  }

  /** The raw view value of a field (child node, list, lazy, …), or null for plain fields. */
  Object rawValue(String name) {
    if (compEdits.containsKey(name)) return compEdits.get(name);
    if (detached == null) {
      ensureScanned();
      if (values.containsKey(name)) return values.get(name);
    }
    return null;
  }

  /**
   * A field's value as views expose it: a struct view, a list view, or a plain value. {@code
   * elem}: the StructInfo of the field's struct (or list elements, or target) for wrapping plain
   * values in views.
   */
  public Object view(String name, StructInfo elem) {
    try {
      return ViewScan.toView(Lazy.force(raw(name, elem)));
    } catch (YaffleException e) {
      throw fieldError(e, name);
    }
  }

  /** The field's view value (possibly lazy); plain composite values are wrapped in views. */
  Object raw(String name, StructInfo elem) {
    if (compEdits.containsKey(name)) {
      Object v = compEdits.get(name);
      Object w = wrap(v, elem);
      if (w != v) compEdits.put(name, w);
      return w;
    }
    if (detached == null) {
      ensureScanned();
      if (values.containsKey(name)) return values.get(name);
    }
    Object w = wrapped.get(name);
    if (w != null) return w;
    Object plain = info.field(name).get().apply(value());
    w = wrap(plain, elem);
    if (w != plain) wrapped.put(name, w);
    return w;
  }

  /**
   * An error raised while reading or setting field {@code name}: unless a deeper part of the view
   * already gave it its absolute path, the path is this node's path plus the field. The result is
   * sealed (nothing above adds to its path).
   */
  YaffleException fieldError(YaffleException e, String name) {
    if (e.isSealed()) return e;
    return e.prefixAll(prefixFor(name)).seal();
  }

  private List<Object> prefixFor(String name) {
    List<Object> p = new ArrayList<>(path);
    p.add(name);
    return p;
  }

  /** Wraps a plain struct (or list of structs) in a detached view. */
  Object wrap(Object plain, StructInfo elem) {
    if (plain == null || plain instanceof ViewNode || plain instanceof ListView<?>) return plain;
    if (plain instanceof List<?> l) return ListView.detached(root, this, l, elem);
    if (elem == null) return plain;
    return new ViewNode(elem, plain, this, root);
  }

  /** Sets a field: in place when possible, else as a structural edit. */
  public void set(String name, Object value) {
    try {
      StructInfo.Field f = info.field(name);
      if (f.input().equals("absent")) {
        throw new YaffleException(ErrorCode.INPUT, name + " is derived and cannot be set");
      }
      Object v = value instanceof StructView sv ? sv.node : value;
      if (f.encoder() != null && edited == null && detached == null && !frozen) {
        ensureScanned();
        Object values = info.copy.apply(shallow);
        f.set().accept(values, value);
        // Encoding validates the value (range, type, checks) right away, even for structural edits.
        byte[] bytes = f.encoder().encode(value, values, args);
        int[] r = ranges.get(name);
        if (space.source && f.patch() && !f.structural() && r != null && bytes.length == r[1] - r[0]) {
          space.patch(r[0], bytes, this);
          return;
        }
      }
      freeze();
      if (f.kind() == StructInfo.Kind.PLAIN && !(v instanceof ViewNode) && !(v instanceof ListView<?>)) {
        if (edited == null) edited = info.copy.apply(value());
        f.set().accept(edited, v);
        editedNames.add(name);
      } else {
        compEdits.put(name, v);
      }
      wrapped.remove(name);
      markDirty();
    } catch (YaffleException e) {
      throw fieldError(e, name);
    }
  }

  /** Stops following the source (values stay as scanned). */
  void freeze() {
    if (detached == null) ensureScanned();
    frozen = true;
  }

  void markDirty() {
    for (ViewNode n = this; n != null && !n.dirtyBelow; n = n.parent) {
      n.dirtyBelow = true;
      n.freeze();
    }
    if (root != null) root.markStructural();
  }

  /** Where the field's original target was (before any edit): {pos, size}, for sticky layout. */
  int[] originalTarget(String name) {
    if (detached == null) ensureScanned();
    return targets.get(name);
  }
}
