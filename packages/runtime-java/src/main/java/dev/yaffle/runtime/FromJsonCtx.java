package dev.yaffle.runtime;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BiFunction;

/** State for {@code fromJson}: values by JSON pointer, to restore identity from {@code $ref}s. */
public final class FromJsonCtx {
  private final Map<String, Object> byPath = new HashMap<>();

  /** A placeholder meaning "not a $ref". */
  private static final Object NO_REF = new Object();

  /** The referenced (earlier) value if {@code j} is a {@code {"$ref": …}} object, else {@link #NO_REF}. */
  private Object deref(Object j) {
    if (!(j instanceof Map<?, ?> m) || m.size() != 1) return NO_REF;
    Object target = m.get("$ref");
    if (!(target instanceof String t)) return NO_REF;
    if (!byPath.containsKey(t)) {
      throw new YaffleException(ErrorCode.INPUT, "$ref " + t + " does not point at an earlier value");
    }
    return byPath.get(t);
  }

  public <T> T register(String path, T v) {
    if (v != null) byPath.put(path, v);
    return v;
  }

  /** An array (or a {@code $ref} to one). Element errors get the index in their path. */
  public <T> List<T> arr(Object j, String path, BiFunction<Object, String, T> f) {
    Object d = deref(j);
    if (d != NO_REF) return cast(d);
    if (!(j instanceof List<?> a)) {
      throw new YaffleException(ErrorCode.INPUT, "expected an array, got " + Json.describe(j));
    }
    List<T> out = new ArrayList<>(a.size());
    register(path, out);
    for (int i = 0; i < a.size(); i++) {
      try {
        out.add(f.apply(a.get(i), ToJsonCtx.ptr(path, i)));
      } catch (YaffleException e) {
        throw e.prefix(i);
      }
    }
    return out;
  }

  /** A struct or union (or a {@code $ref} to one); {@code f} registers the new object itself. */
  public <T> T obj(Object j, String path, Class<T> type, BiFunction<Object, String, T> f) {
    Object d = deref(j);
    if (d != NO_REF) {
      if (!type.isInstance(d)) {
        throw new YaffleException(ErrorCode.INPUT, "$ref points at a value of another type");
      }
      return type.cast(d);
    }
    return f.apply(j, path);
  }

  /** Bytes from hex (or a {@code $ref}). */
  public byte[] bytes(Object j, String path) {
    Object d = deref(j);
    if (d != NO_REF) {
      if (d instanceof byte[] b) return b;
      throw new YaffleException(ErrorCode.INPUT, "$ref does not point at bytes");
    }
    if (j instanceof String s) return register(path, Hex.decode(s));
    throw new YaffleException(ErrorCode.INPUT, "expected a hex string, got " + Json.describe(j));
  }

  @SuppressWarnings("unchecked")
  private static <T> T cast(Object o) {
    return (T) o;
  }
}
