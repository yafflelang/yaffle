package org.yafflelang.runtime;

import java.util.LinkedHashMap;
import java.util.Map;

/** The placeables reachable from one struct instance, by field (declaration order). */
public final class LStruct implements LEntry {
  LayoutItem[] layout;
  final Map<String, LEntry> fields = new LinkedHashMap<>();

  public LStruct() {
    this(null);
  }

  public LStruct(LayoutItem[] layout) {
    this.layout = layout;
  }

  /** Sets the layout items computed while writing the struct (items that read its fields). */
  public void layout(LayoutItem[] items) {
    this.layout = items;
  }

  public void set(String name, LEntry e) {
    if (e != null) fields.put(name, e);
  }
}
