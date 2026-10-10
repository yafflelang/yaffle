package org.yafflelang.runtime;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Every failure the runtime or generated code reports: a stable {@link ErrorCode}, the path from
 * the root (field names and array indices, filled in while the error propagates) and an absolute
 * byte offset ({@code -1} on write).
 *
 * <p>Stack traces are off by default (unions try variants by catching these), set the system
 * property {@code yaffle.stacktraces=true} to get them.
 */
public final class YaffleException extends RuntimeException {
  private static final long serialVersionUID = 1L;
  private static final boolean TRACES = Boolean.getBoolean("yaffle.stacktraces");

  private final ErrorCode code;
  private final transient ArrayList<Object> path = new ArrayList<>();
  private final long offset;
  private final String detail;
  private final transient List<YaffleException> causes;
  /** The path is complete (errors raised after layout know their full path). */
  private boolean sealed;

  public YaffleException(ErrorCode code, String detail) {
    this(code, detail, -1, null);
  }

  public YaffleException(ErrorCode code, String detail, long offset) {
    this(code, detail, offset, null);
  }

  public YaffleException(
      ErrorCode code, String detail, long offset, List<YaffleException> causes) {
    super(detail, null, false, TRACES);
    this.code = code;
    this.detail = detail;
    this.offset = offset;
    this.causes = causes == null ? List.of() : List.copyOf(causes);
  }

  public ErrorCode code() {
    return code;
  }

  /** Field names ({@link String}) and array indices ({@link Integer}) from the root. */
  public List<Object> path() {
    return Collections.unmodifiableList(path);
  }

  /** Absolute byte offset for read errors, -1 for write errors. */
  public long offset() {
    return offset;
  }

  /** The message without path and offset decoration. */
  public String detail() {
    return detail;
  }

  /** For {@code UNION} errors: the error of every variant, in order. */
  public List<YaffleException> causes() {
    return causes;
  }

  public boolean isSealed() {
    return sealed;
  }

  /** Marks the path as complete: outer frames add no further segments. */
  public YaffleException seal() {
    sealed = true;
    return this;
  }

  @Override
  public String getMessage() {
    StringBuilder sb = new StringBuilder(code.name());
    if (!path.isEmpty()) sb.append(" at ").append(formatPath(path));
    if (offset >= 0) sb.append(" (offset 0x").append(Long.toHexString(offset)).append(')');
    return sb.append(": ").append(detail).toString();
  }

  /**
   * Adds outer path segments (used while unwinding through generated code). Empty strings and
   * negative indices are skipped.
   */
  public YaffleException prefix(Object... segments) {
    if (sealed) return this;
    List<Object> keep = new ArrayList<>(segments.length);
    for (Object s : segments) if (isSegment(s)) keep.add(s);
    path.addAll(0, keep);
    return this;
  }

  /** Same as {@link #prefix(Object...)} with a list. */
  public YaffleException prefixAll(List<?> segments) {
    if (sealed) return this;
    List<Object> keep = new ArrayList<>(segments.size());
    for (Object s : segments) if (isSegment(s)) keep.add(s);
    path.addAll(0, keep);
    return this;
  }

  static boolean isSegment(Object s) {
    if (s instanceof String str) return !str.isEmpty();
    if (s instanceof Integer i) return i >= 0;
    return false;
  }

  public static String formatPath(List<?> path) {
    StringBuilder sb = new StringBuilder();
    for (Object seg : path) {
      if (seg instanceof Integer) sb.append('[').append(seg).append(']');
      else {
        if (sb.length() > 0) sb.append('.');
        sb.append(seg);
      }
    }
    return sb.toString();
  }
}
