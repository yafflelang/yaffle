package dev.yaffle.runtime;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A small JSON reader and writer over plain Java values: {@link Map} (insertion ordered) for
 * objects, {@link List} for arrays, {@link String}, {@link Boolean}, {@code null}, and numbers as
 * {@link Long} (integers that fit), {@link BigInteger} (larger integers) or {@link Double}.
 */
public final class Json {
  private Json() {}

  // ── reading ─────────────────────────────────────────────────────────────────

  /** Parses JSON text. Syntax errors are {@code INPUT} errors. */
  public static Object parse(String text) {
    Parser p = new Parser(text);
    p.ws();
    Object v = p.value();
    p.ws();
    if (p.i != text.length()) throw p.err("trailing characters");
    return v;
  }

  private static final class Parser {
    final String s;
    int i;

    Parser(String s) {
      this.s = s;
    }

    YaffleException err(String what) {
      return new YaffleException(ErrorCode.INPUT, "invalid JSON at " + i + ": " + what);
    }

    void ws() {
      while (i < s.length()) {
        char c = s.charAt(i);
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r') i++;
        else break;
      }
    }

    Object value() {
      if (i >= s.length()) throw err("unexpected end");
      char c = s.charAt(i);
      switch (c) {
        case '{':
          return object();
        case '[':
          return array();
        case '"':
          return string();
        case 't':
          expect("true");
          return Boolean.TRUE;
        case 'f':
          expect("false");
          return Boolean.FALSE;
        case 'n':
          expect("null");
          return null;
        default:
          if (c == '-' || (c >= '0' && c <= '9')) return number();
          throw err("unexpected character '" + c + "'");
      }
    }

    void expect(String word) {
      if (!s.startsWith(word, i)) throw err("expected " + word);
      i += word.length();
    }

    Map<String, Object> object() {
      Map<String, Object> m = new LinkedHashMap<>();
      i++;
      ws();
      if (i < s.length() && s.charAt(i) == '}') {
        i++;
        return m;
      }
      for (; ; ) {
        ws();
        if (i >= s.length() || s.charAt(i) != '"') throw err("expected a key");
        String k = string();
        ws();
        if (i >= s.length() || s.charAt(i) != ':') throw err("expected ':'");
        i++;
        ws();
        m.put(k, value());
        ws();
        if (i >= s.length()) throw err("unexpected end");
        char c = s.charAt(i++);
        if (c == '}') return m;
        if (c != ',') throw err("expected ',' or '}'");
      }
    }

    List<Object> array() {
      List<Object> a = new ArrayList<>();
      i++;
      ws();
      if (i < s.length() && s.charAt(i) == ']') {
        i++;
        return a;
      }
      for (; ; ) {
        ws();
        a.add(value());
        ws();
        if (i >= s.length()) throw err("unexpected end");
        char c = s.charAt(i++);
        if (c == ']') return a;
        if (c != ',') throw err("expected ',' or ']'");
      }
    }

    String string() {
      i++;
      StringBuilder sb = null;
      int start = i;
      for (; ; ) {
        if (i >= s.length()) throw err("unterminated string");
        char c = s.charAt(i);
        if (c == '"') {
          String out = sb == null ? s.substring(start, i) : sb.append(s, start, i).toString();
          i++;
          return out;
        }
        if (c == '\\') {
          if (sb == null) sb = new StringBuilder();
          sb.append(s, start, i);
          i++;
          if (i >= s.length()) throw err("unterminated escape");
          char e = s.charAt(i++);
          switch (e) {
            case '"' -> sb.append('"');
            case '\\' -> sb.append('\\');
            case '/' -> sb.append('/');
            case 'b' -> sb.append('\b');
            case 'f' -> sb.append('\f');
            case 'n' -> sb.append('\n');
            case 'r' -> sb.append('\r');
            case 't' -> sb.append('\t');
            case 'u' -> {
              if (i + 4 > s.length()) throw err("bad \\u escape");
              try {
                sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
              } catch (NumberFormatException ex) {
                throw err("bad \\u escape");
              }
              i += 4;
            }
            default -> throw err("bad escape");
          }
          start = i;
        } else {
          if (c < 0x20) throw err("control character in string");
          i++;
        }
      }
    }

    Object number() {
      int start = i;
      if (s.charAt(i) == '-') i++;
      boolean integral = true;
      while (i < s.length()) {
        char c = s.charAt(i);
        if (c >= '0' && c <= '9') i++;
        else if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
          integral = false;
          i++;
        } else break;
      }
      String t = s.substring(start, i);
      try {
        if (integral) {
          if (t.length() <= 18) return Long.parseLong(t);
          BigInteger b = new BigInteger(t);
          return b.bitLength() <= 63 ? (Object) b.longValue() : b;
        }
        return Double.parseDouble(t);
      } catch (NumberFormatException e) {
        throw err("bad number " + t);
      }
    }
  }

  // ── writing ─────────────────────────────────────────────────────────────────

  /** Renders a JSON value compactly. */
  public static String write(Object v) {
    StringBuilder sb = new StringBuilder();
    write(v, sb);
    return sb.toString();
  }

  /** Renders a JSON value to an appendable (streams large values without one big string). */
  public static void write(Object v, Appendable out) {
    try {
      emit(v, out);
    } catch (IOException e) {
      throw new UncheckedIOException(e);
    }
  }

  private static void emit(Object v, Appendable out) throws IOException {
    if (v == null) out.append("null");
    else if (v instanceof String s) string(s, out);
    else if (v instanceof Boolean b) out.append(b ? "true" : "false");
    else if (v instanceof Integer || v instanceof Long || v instanceof BigInteger) {
      out.append(v.toString());
    } else if (v instanceof Double || v instanceof Float) {
      double d = ((Number) v).doubleValue();
      if (!Double.isFinite(d)) throw new IllegalArgumentException("non-finite number " + d);
      if (d == Math.rint(d) && Math.abs(d) < 1e15) {
        if (d == 0 && 1 / d < 0) out.append("-0");
        else out.append(Long.toString((long) d));
      } else out.append(Double.toString(d));
    } else if (v instanceof Map<?, ?> m) {
      out.append('{');
      boolean first = true;
      for (Map.Entry<?, ?> e : m.entrySet()) {
        if (!first) out.append(',');
        first = false;
        string(String.valueOf(e.getKey()), out);
        out.append(':');
        emit(e.getValue(), out);
      }
      out.append('}');
    } else if (v instanceof List<?> l) {
      out.append('[');
      boolean first = true;
      for (Object x : l) {
        if (!first) out.append(',');
        first = false;
        emit(x, out);
      }
      out.append(']');
    } else if (v instanceof byte[] b) {
      out.append('"');
      Hex.encodeTo(b, out);
      out.append('"');
    } else {
      throw new IllegalArgumentException("not a JSON value: " + v.getClass().getName());
    }
  }

  private static void string(String s, Appendable out) throws IOException {
    out.append('"');
    int start = 0;
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      String esc = null;
      if (c == '"') esc = "\\\"";
      else if (c == '\\') esc = "\\\\";
      else if (c < 0x20) {
        esc =
            switch (c) {
              case '\n' -> "\\n";
              case '\r' -> "\\r";
              case '\t' -> "\\t";
              case '\b' -> "\\b";
              case '\f' -> "\\f";
              default -> String.format("\\u%04x", (int) c);
            };
      } else if (Character.isSurrogate(c)) {
        boolean paired =
            Character.isHighSurrogate(c)
                ? i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1))
                : i > 0 && Character.isHighSurrogate(s.charAt(i - 1));
        if (!paired) esc = String.format("\\u%04x", (int) c);
      }
      if (esc != null) {
        out.append(s, start, i).append(esc);
        start = i + 1;
      }
    }
    out.append(s, start, s.length()).append('"');
  }

  /** Replaces byte arrays by hex strings. */
  public static Object normalize(Object v) {
    if (v instanceof byte[] b) return Hex.encode(b);
    if (v instanceof Map<?, ?> m) {
      Map<String, Object> out = new LinkedHashMap<>();
      for (Map.Entry<?, ?> e : m.entrySet()) out.put(String.valueOf(e.getKey()), normalize(e.getValue()));
      return out;
    }
    if (v instanceof List<?> l) {
      List<Object> out = new ArrayList<>(l.size());
      for (Object x : l) out.add(normalize(x));
      return out;
    }
    return v;
  }

  /** A short description of a value for error messages. */
  public static String describe(Object v) {
    if (v == null) return "null";
    if (v instanceof String s) {
      String t = s.length() > 40 ? s.substring(0, 40) + "…" : s;
      return write(t);
    }
    if (v instanceof byte[] b) return "bytes(" + b.length + ")";
    if (v instanceof List<?> l) return "array(" + l.size() + ")";
    if (v instanceof Map<?, ?>) return "object";
    if (v instanceof Number || v instanceof Boolean) return v.toString();
    return v.getClass().getSimpleName();
  }
}
