package dev.yaffle.runtime;

import java.util.ArrayList;
import java.util.List;

/** The layout entries of an array's elements (null for elements without placeables). */
public final class LArray implements LEntry {
  final List<LEntry> items = new ArrayList<>();

  public void push(LEntry e) {
    items.add(e);
  }
}
