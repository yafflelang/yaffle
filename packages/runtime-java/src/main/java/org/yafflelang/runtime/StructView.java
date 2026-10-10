package org.yafflelang.runtime;

import java.util.List;

/**
 * Base class of generated struct views ({@code X.View}): lazy typed getters, setters that patch
 * in place or record structural edits, and (on the root view) {@link #patches} and {@link
 * #commit}.
 */
public abstract class StructView {
  /** The node behind the view (the root view follows the root across commits). */
  ViewNode node;

  protected StructView(ViewNode node) {
    this.node = node;
  }

  /** The node behind this view. */
  public final ViewNode node() {
    return node;
  }

  /** Absolute offset of the struct in its byte space (-1 for detached views). */
  public final int offset() {
    return node.pos;
  }

  /** Size of the struct's bytes (a base struct includes its targets; -1 for detached views). */
  public final int size() {
    return node.size();
  }

  /** The struct's current bytes. */
  public final byte[] raw() {
    if (node.isDetached()) throw new YaffleException(ErrorCode.INPUT, "a detached view has no bytes");
    return node.space.bytes(node.pos, node.pos + node.size());
  }

  /** True for views of plain values (not backed by bytes). */
  public final boolean detached() {
    return node.isDetached();
  }

  /** Field names and indices from the root view. */
  public final List<Object> path() {
    return node.path;
  }

  /** The edits as patches against the original bytes (no side effects). */
  public final List<Patch> patches() {
    return patches(Layout.Grow.DEFAULT);
  }

  public final List<Patch> patches(Layout.Grow grow) {
    return root().patches(grow);
  }

  /** Applies every edit; returns the new bytes and rebinds the root view to them. */
  public final byte[] commit() {
    return commit(Layout.Grow.DEFAULT);
  }

  public final byte[] commit(Layout.Grow grow) {
    return root().commit(grow);
  }

  private ViewRoot root() {
    if (node.root == null) throw new YaffleException(ErrorCode.INPUT, "a detached view has no source");
    return node.root;
  }

  @Override
  public String toString() {
    return node.info.name() + ".View@" + node.pos;
  }
}
