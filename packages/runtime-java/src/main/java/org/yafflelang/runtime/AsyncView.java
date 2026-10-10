package org.yafflelang.runtime;

import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Consumer;
import java.util.function.Function;

/**
 * A view over an {@link AsyncSource} (or a format with async codecs) whose accesses complete as
 * futures:
 *
 * <pre>{@code
 * AsyncView<Archive.View> av = Archive.viewAsync(AsyncSource.of(channel));
 * CompletableFuture<Long> size = av.get(v -> v.getEntries().get(3).getSize());
 * av.set(v -> v.getEntries().get(2).setHandler(5)).join();
 * byte[] out = av.commit().join();
 * }</pre>
 *
 * <p>Each access runs the ordinary (synchronous) view code on a virtual thread; a block the source
 * hasn't delivered yet, or an async codec's result, is awaited there, which parks the virtual
 * thread instead of blocking an OS thread. Accesses of one view run one at a time, in the order
 * they were made. The typed view itself ({@link #view()}) may also be used directly: its reads
 * then wait on the calling thread.
 *
 * @param <V> the root's view type
 */
public final class AsyncView<V extends StructView> {
  private final V view;
  private final ReentrantLock lock = new ReentrantLock(true);
  /** The last access; the next one starts after it (accesses are ordered). */
  private CompletableFuture<?> last = CompletableFuture.completedFuture(null);

  AsyncView(V view) {
    this.view = view;
  }

  /** The typed view (reads on it wait for the source on the calling thread). */
  public V view() {
    return view;
  }

  /** Runs {@code access} on the view (on a virtual thread); completes with its result. */
  public <T> CompletableFuture<T> get(Function<? super V, ? extends T> access) {
    synchronized (this) {
      CompletableFuture<T> f =
          last.handle((x, e) -> null)
              .thenComposeAsync(
                  ignored -> Api.async(() -> locked(() -> access.apply(view))), Runnable::run);
      last = f;
      return f;
    }
  }

  /** Runs an edit on the view; completes when it is done. */
  public CompletableFuture<Void> set(Consumer<? super V> edit) {
    return get(
        v -> {
          edit.accept(v);
          return null;
        });
  }

  /** The edits as patches (reads what the commit plan needs). */
  public CompletableFuture<List<Patch>> patches() {
    return get(StructView::patches);
  }

  public CompletableFuture<List<Patch>> patches(Layout.Grow grow) {
    return get(v -> v.patches(grow));
  }

  /** Commits the edits; completes with the new bytes (the view is rebound to them). */
  public CompletableFuture<byte[]> commit() {
    return get(StructView::commit);
  }

  public CompletableFuture<byte[]> commit(Layout.Grow grow) {
    return get(v -> v.commit(grow));
  }

  /** Reads the whole view into a plain value through the view (see {@link ViewRead}). */
  public CompletableFuture<Object> materialize() {
    return get(ViewRead::materialize);
  }

  private <T> T locked(java.util.function.Supplier<T> f) {
    lock.lock();
    try {
      return f.get();
    } finally {
      lock.unlock();
    }
  }
}
