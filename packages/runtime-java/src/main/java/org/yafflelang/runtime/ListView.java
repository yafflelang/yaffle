package org.yafflelang.runtime;

import java.util.AbstractList;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.RandomAccess;

/**
 * The view of an array: struct elements are struct views, other elements plain values. Arrays of
 * fixed-size elements read their elements on access; setting a scalar element of the same
 * encoded size patches the source in place. Any other change (add, remove, replacing a struct)
 * is a structural edit that {@code commit()} re-encodes.
 *
 * @param <E> the element type ({@code Integer}, {@code String}, a struct's {@code View}, …)
 */
public final class ListView<E> extends AbstractList<E> implements RandomAccess {
  final ViewRoot root;
  final ViewSpace space;
  final ViewNode owner;
  final List<Object> path;
  /** Lazy arrays: start, element count and size; -1 for lists of values. */
  final int start;
  private final int count;
  private final int size;
  private final ViewScan.Elem elem;
  private final ViewScan.ElemEncoder encoder;
  private final int base;
  private final int end;
  private final boolean strict;
  private final Map<Integer, Object> cache = new HashMap<>();
  private int cacheVersion;
  /** Raw element values (nodes or plain values) once materialized, or for lists of values. */
  List<Object> items;
  /** For lists of plain struct values: the elements' info (they are wrapped in detached views). */
  private final StructInfo elemInfo;
  /** The list itself changed (an element added, removed or replaced). */
  private boolean changed;

  ListView(
      ViewRoot root,
      ViewSpace space,
      ViewNode owner,
      List<Object> path,
      int start,
      int count,
      int size,
      ViewScan.Elem elem,
      ViewScan.ElemEncoder encoder,
      int base,
      int end,
      boolean strict) {
    this.root = root;
    this.space = space;
    this.owner = owner;
    this.path = path;
    this.start = start;
    this.count = count;
    this.size = size;
    this.elem = elem;
    this.encoder = encoder;
    this.base = base;
    this.end = end;
    this.strict = strict;
    this.items = null;
    this.elemInfo = null;
  }

  ListView(
      ViewRoot root, ViewSpace space, ViewNode owner, List<Object> path, List<Object> items, StructInfo elemInfo) {
    this.root = root;
    this.space = space;
    this.owner = owner;
    this.path = path;
    this.start = -1;
    this.count = 0;
    this.size = 0;
    this.elem = null;
    this.encoder = null;
    this.base = 0;
    this.end = 0;
    this.strict = false;
    this.items = new ArrayList<>(items);
    this.elemInfo = elemInfo;
  }

  /** A list view of a plain list (struct elements become detached views). */
  static ListView<Object> detached(ViewRoot root, ViewNode owner, List<?> plain, StructInfo elemInfo) {
    return new ListView<>(root, null, owner, owner != null ? owner.path : List.of(), new ArrayList<>(plain), elemInfo);
  }

  @Override
  public int size() {
    return items != null ? items.size() : count;
  }

  @Override
  @SuppressWarnings("unchecked")
  public E get(int i) {
    return (E) ViewScan.toView(rawGet(i));
  }

  /** The raw element value: a node, or a plain value. */
  Object rawGet(int i) {
    if (i < 0 || i >= size()) throw new IndexOutOfBoundsException(i);
    if (items != null) {
      Object v = Lazy.force(items.get(i));
      if (elemInfo != null && v != null && !(v instanceof ViewNode)) {
        ViewNode n = new ViewNode(elemInfo, v, owner, root);
        items.set(i, n);
        return n;
      }
      return v;
    }
    if (cacheVersion != space.version) {
      cache.clear();
      cacheVersion = space.version;
    }
    Object hit = cache.get(i);
    if (hit != null) return hit;
    Reader r = space.reader(start + i * size, base, end, strict);
    r.index = i;
    List<Object> p = new ArrayList<>(path);
    p.add(i);
    ViewScan vs = new ViewScan(root, space, owner, p);
    Object v;
    try {
      v = Lazy.force(elem.read(r, vs, i));
    } catch (YaffleException e) {
      throw e.prefixAll(p).seal();
    }
    cache.put(i, v);
    return v;
  }

  private static Object unwrap(Object e) {
    return e instanceof StructView v ? v.node : e;
  }

  @Override
  public E set(int i, E e) {
    E old = get(i);
    if (items == null && encoder != null && space.source && !(rawGet(i) instanceof ViewNode)) {
      byte[] bytes;
      try {
        bytes = encoder.encode(e);
      } catch (YaffleException x) {
        List<Object> p = new ArrayList<>(path);
        p.add(i);
        throw x.prefixAll(p).seal();
      }
      if (bytes.length == size) {
        space.patch(start + i * size, bytes, owner);
        return old;
      }
    }
    materialize().set(i, unwrap(e));
    dirty();
    return old;
  }

  @Override
  public void add(int i, E e) {
    materialize().add(i, unwrap(e));
    modCount++;
    dirty();
  }

  @Override
  public E remove(int i) {
    E old = get(i);
    materialize().remove(i);
    modCount++;
    dirty();
    return old;
  }

  List<Object> materialize() {
    if (items == null) {
      List<Object> out = new ArrayList<>(count);
      for (int i = 0; i < count; i++) out.add(rawGet(i));
      items = out;
    }
    return items;
  }

  private void dirty() {
    changed = true;
    if (owner != null) owner.markDirty();
    else if (root != null) root.markStructural();
  }

  /** True if an element changed or the list did. */
  boolean dirtyBelow() {
    if (changed) return true;
    if (items != null) {
      for (Object o : items) if (isDirty(o)) return true;
    }
    for (Object o : cache.values()) if (isDirty(o)) return true;
    return false;
  }

  static boolean isDirty(Object raw) {
    if (raw instanceof ViewNode n) return n.dirtyBelow;
    if (raw instanceof StructView v) return v.node.dirtyBelow;
    if (raw instanceof ListView<?> l) return l.dirtyBelow();
    if (raw instanceof Lazy l) return l.forced() && isDirty(l.peek());
    return false;
  }
}
