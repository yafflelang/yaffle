package dev.yaffle.runtime;

import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;

/** State for {@code toJson}: remembers where each object was first written, for {@code $ref}s. */
public final class ToJsonCtx {
  private final IdentityHashMap<Object, String> seen = new IdentityHashMap<>();

  /**
   * The {@code {"$ref": …}} to use if {@code v} was already written; otherwise records {@code
   * path} and returns null. Only objects and non-empty arrays are shared (bytes, strings and empty
   * arrays are values).
   */
  public Map<String, Object> ref(Object v, String path) {
    if (v == null || v instanceof byte[] || v instanceof String || v instanceof Number) return null;
    if (v instanceof Boolean || v instanceof Enum<?> || v instanceof YEnum) return null;
    if (v instanceof List<?> l && l.isEmpty()) return null;
    String prev = seen.get(v);
    if (prev != null) return Map.of("$ref", prev);
    seen.put(v, path);
    return null;
  }

  /** A struct or union value: a {@code $ref} if already written, else {@code f(v, path)}. */
  public <T> Object obj(T v, String path, java.util.function.BiFunction<T, String, Object> f) {
    if (v == null) {
      throw new YaffleException(ErrorCode.INPUT, "expected an object, got null");
    }
    Map<String, Object> r = ref(v, path);
    return r != null ? r : f.apply(v, path);
  }

  /** An array of plain values (converted as they are). */
  public <T> Object list(List<T> v, String path) {
    Map<String, Object> r = ref(v, path);
    return r != null ? r : new java.util.ArrayList<Object>(v);
  }

  /** An array whose element conversion needs no path. */
  public <T> Object list(List<T> v, String path, java.util.function.Function<T, Object> f) {
    Map<String, Object> r = ref(v, path);
    if (r != null) return r;
    List<Object> out = new java.util.ArrayList<>(v.size());
    for (T e : v) out.add(f.apply(e));
    return out;
  }

  /** An array whose elements may be shared objects (each gets its JSON pointer). */
  public <T> Object list(
      List<T> v, String path, java.util.function.BiFunction<T, String, Object> f) {
    Map<String, Object> r = ref(v, path);
    if (r != null) return r;
    List<Object> out = new java.util.ArrayList<>(v.size());
    for (int i = 0; i < v.size(); i++) out.add(f.apply(v.get(i), ptr(path, i)));
    return out;
  }

  /** Appends an RFC 6901 reference token. */
  public static String ptr(String path, String seg) {
    return path + "/" + seg.replace("~", "~0").replace("/", "~1");
  }

  public static String ptr(String path, int index) {
    return path + "/" + index;
  }
}
