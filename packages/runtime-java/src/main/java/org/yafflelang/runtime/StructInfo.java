package org.yafflelang.runtime;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.BiConsumer;
import java.util.function.Function;
import java.util.function.UnaryOperator;

/**
 * View descriptor of a struct, emitted by the Java backend ({@code X.INFO}): how to scan it, read
 * it, copy and edit its plain values, and which fields can be patched in place.
 */
public final class StructInfo {
  /** Generated scan: reads the struct's scalars into a plain value, composite fields into the scan. */
  @FunctionalInterface
  public interface Scan {
    Object scan(Reader r, ViewScan vs, Object[] args);
  }

  /** Generated reader (the struct's normal {@code read}). */
  @FunctionalInterface
  public interface Read {
    Object read(Reader r, Object[] args);
  }

  /** Encodes a new value of one field ({@code values}: the struct's plain value with it applied). */
  @FunctionalInterface
  public interface Encoder {
    byte[] encode(Object value, Object values, Object[] args);
  }

  /** How a field is exposed by views. */
  public enum Kind {
    /** Read into the struct's plain value by the scan (scalars, strings, enums, unions, …). */
    PLAIN,
    /** A view value made by the scan (child struct, list, lazy bytes, target, region, stream). */
    VIEW
  }

  /**
   * One field.
   *
   * @param name the field
   * @param input "required", "optional" or "absent"
   * @param patch same-size values can be patched in place
   * @param structural later read-side expressions depend on it
   * @param kind how views expose it
   * @param encoder encodes a new value (null: not encodable on its own)
   * @param get reads the field of a plain value
   * @param set writes the field of a plain value
   */
  public record Field(
      String name,
      String input,
      boolean patch,
      boolean structural,
      Kind kind,
      Encoder encoder,
      Function<Object, Object> get,
      BiConsumer<Object, Object> set) {}

  final String name;
  final String key;
  final Scan scan;
  final Read read;
  final int staticSize;
  final boolean base;
  final boolean childSafe;
  final Map<String, Field> fields = new LinkedHashMap<>();
  final Function<ViewNode, StructView> view;
  final UnaryOperator<Object> copy;
  final java.util.function.Supplier<Object> make;

  public StructInfo(
      String name,
      String key,
      Scan scan,
      Read read,
      int staticSize,
      boolean base,
      boolean childSafe,
      Function<ViewNode, StructView> view,
      java.util.function.Supplier<Object> make,
      UnaryOperator<Object> copy,
      Field... fields) {
    this.name = name;
    this.key = key;
    this.scan = scan;
    this.read = read;
    this.staticSize = staticSize;
    this.base = base;
    this.childSafe = childSafe;
    this.view = view;
    this.make = make;
    this.copy = copy;
    for (Field f : fields) this.fields.put(f.name(), f);
  }

  public String name() {
    return name;
  }

  Field field(String name) {
    Field f = fields.get(name);
    if (f == null) throw new YaffleException(ErrorCode.INPUT, this.name + " has no field " + name);
    return f;
  }
}
