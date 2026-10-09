package dev.yaffle.runtime;

import java.lang.ref.ReferenceQueue;
import java.lang.ref.WeakReference;
import java.util.HashMap;
import java.util.Map;

/**
 * A map keyed by object identity whose keys are held weakly (the JDK has WeakHashMap, which uses
 * {@code equals}, and IdentityHashMap, which holds keys strongly). Used for side information
 * attached to parsed values: codec origins and raw values. Thread-safe.
 */
final class WeakIdentityMap<K, V> {
  private static final class Ref<K> extends WeakReference<K> {
    final int hash;

    Ref(K key, ReferenceQueue<? super K> q) {
      super(key, q);
      this.hash = System.identityHashCode(key);
    }

    @Override
    public boolean equals(Object o) {
      if (this == o) return true;
      if (!(o instanceof Ref<?> r)) return false;
      Object a = get();
      return a != null && a == r.get();
    }

    @Override
    public int hashCode() {
      return hash;
    }
  }

  /** Lookup key (strong, never stored). */
  private static final class Probe {
    final Object key;

    Probe(Object key) {
      this.key = key;
    }

    @Override
    public boolean equals(Object o) {
      return o instanceof Ref<?> r && r.get() == key;
    }

    @Override
    public int hashCode() {
      return System.identityHashCode(key);
    }
  }

  private final Map<Object, V> map = new HashMap<>();
  private final ReferenceQueue<K> queue = new ReferenceQueue<>();

  private void expunge() {
    Object r;
    while ((r = queue.poll()) != null) map.remove(r);
  }

  public synchronized V get(K key) {
    expunge();
    return lookup(key);
  }

  private V lookup(K key) {
    // HashMap compares probe.equals(entryKey): a Probe matches the Ref to the same object.
    return map.get(new Probe(key));
  }

  public synchronized void put(K key, V value) {
    expunge();
    map.put(new Ref<>(key, queue), value);
  }

  public synchronized V computeIfAbsent(K key, java.util.function.Supplier<V> make) {
    expunge();
    V v = lookup(key);
    if (v == null) {
      v = make.get();
      map.put(new Ref<>(key, queue), v);
    }
    return v;
  }

  public synchronized boolean containsKey(K key) {
    expunge();
    return lookup(key) != null;
  }
}
