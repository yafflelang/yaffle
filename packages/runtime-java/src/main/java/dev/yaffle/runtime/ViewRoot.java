package dev.yaffle.runtime;

import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BiFunction;
import java.util.function.Function;

/** The state shared by all views of one source: nodes by position, regions, edits, commit. */
public final class ViewRoot {
  /**
   * What the generated root API passes: the root struct's descriptor, its arguments, strict mode,
   * the root layout and the root writer (for commits).
   *
   * @param info the root struct
   * @param args root arguments
   * @param strict strict mode
   * @param layout the root's layout items ({@link LayoutItem#OWN}: computed by the root writer)
   * @param write writes a plain root value
   */
  public record Spec(
      StructInfo info,
      Object[] args,
      boolean strict,
      LayoutItem[] layout,
      BiFunction<Writer, Object, LEntry> write) {}

  ViewSpace space;
  final Spec spec;
  final Map<String, ViewNode> nodes = new HashMap<>();
  /** Decoded codec regions, by source position and slot. */
  final Map<String, ViewSpace> regions = new HashMap<>();
  /** List views of targets, by address and type (shared targets are one list). */
  final Map<String, Object> lists = new HashMap<>();
  /** A structural edit happened: commits re-encode. */
  boolean structural;
  ViewNode rootNode;
  private final StructView rootView;

  private ViewRoot(Spec spec, Function<ViewRoot, ViewSpace> space) {
    this.spec = spec;
    this.space = space.apply(this);
    this.rootNode = makeRoot();
    this.rootView = rootNode.view();
  }

  /** Opens a view of {@code bytes}; returns the root's typed view. */
  public static StructView open(byte[] bytes, Spec spec) {
    if (bytes == null) throw new YaffleException(ErrorCode.INPUT, "expected bytes, got null");
    return new ViewRoot(spec, r -> new ViewSpace(r, bytes, true)).rootView;
  }

  /** Opens a view of a random-access source: blocks are read when the view needs them. */
  public static StructView open(Source source, Spec spec) {
    if (source == null) throw new YaffleException(ErrorCode.INPUT, "expected a source, got null");
    return lazy(new Store.FromSource(source, checkedSize(source.size())), spec).rootView;
  }

  /**
   * Opens an async view of an async source: accesses run on virtual threads that await the
   * blocks they need (see {@link AsyncView}).
   */
  public static <V extends StructView> AsyncView<V> openAsync(AsyncSource source, Spec spec, Class<V> type) {
    if (source == null) throw new YaffleException(ErrorCode.INPUT, "expected a source, got null");
    ViewRoot root = lazy(new Store.FromSource(source, checkedSize(source.size())), spec);
    return new AsyncView<>(type.cast(root.rootView));
  }

  /** An async view of bytes already in memory (formats with async codecs). */
  public static <V extends StructView> AsyncView<V> openAsync(byte[] bytes, Spec spec, Class<V> type) {
    return new AsyncView<>(type.cast(open(bytes, spec)));
  }

  private static ViewRoot lazy(Store store, Spec spec) {
    return new ViewRoot(spec, r -> new ViewSpace(r, store, true, -1));
  }

  /** Checks a source's size fits a view (int positions). */
  private static int checkedSize(long size) {
    if (size < 0 || size > Integer.MAX_VALUE - 8) {
      throw new YaffleException(ErrorCode.RANGE, "sources over 2 GiB are not supported (" + size + " bytes)");
    }
    return (int) size;
  }

  private ViewNode makeRoot() {
    return new ViewNode(
        this, space, spec.info(), 0, spec.args(), 0, space.length(), -1, spec.strict(), null, List.of());
  }

  /** The node of a struct at {@code pos} of a space (one per position, type and arguments). */
  ViewNode node(
      ViewSpace sp,
      int pos,
      StructInfo info,
      Object[] args,
      int base,
      int end,
      int index,
      boolean strict,
      ViewNode parent,
      List<Object> path) {
    String k = sp.id + ":" + pos + ":" + info.key + Arrays.toString(args);
    return nodes.computeIfAbsent(
        k, x -> new ViewNode(this, sp, info, pos, args, base, end, index, strict, parent, path));
  }

  void markStructural() {
    structural = true;
  }

  List<Patch> patches(Layout.Grow grow) {
    return Commit.plan(this, grow).patches();
  }

  byte[] commit(Layout.Grow grow) {
    byte[] bytes = Commit.plan(this, grow).bytes().get();
    rebind(bytes);
    return bytes;
  }

  /** Makes the committed bytes the new source; the root view follows. */
  private void rebind(byte[] bytes) {
    space = new ViewSpace(this, bytes, true);
    nodes.clear();
    regions.clear();
    lists.clear();
    structural = false;
    rootNode = makeRoot();
    rootView.node = rootNode;
    rootNode.adopt(rootView);
  }
}
