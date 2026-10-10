package org.yafflelang.runtime;

/** Lowercase hex (the canonical JSON form of bytes). */
public final class Hex {
  private Hex() {}

  private static final char[] DIGITS = "0123456789abcdef".toCharArray();

  public static String encode(byte[] b) {
    char[] out = new char[b.length * 2];
    for (int i = 0; i < b.length; i++) {
      out[i * 2] = DIGITS[(b[i] >> 4) & 0xf];
      out[i * 2 + 1] = DIGITS[b[i] & 0xf];
    }
    return new String(out);
  }

  /** Writes hex to an appendable without building one big string. */
  public static void encodeTo(byte[] b, Appendable out) throws java.io.IOException {
    char[] chunk = new char[8192];
    int n = 0;
    for (byte x : b) {
      chunk[n++] = DIGITS[(x >> 4) & 0xf];
      chunk[n++] = DIGITS[x & 0xf];
      if (n == chunk.length) {
        out.append(java.nio.CharBuffer.wrap(chunk, 0, n));
        n = 0;
      }
    }
    if (n > 0) out.append(java.nio.CharBuffer.wrap(chunk, 0, n));
  }

  private static int digit(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  }

  /** Parses hex (whitespace is ignored); invalid hex is an INPUT error. */
  public static byte[] decode(String s) {
    int n = 0;
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (Character.isWhitespace(c)) continue;
      if (digit(c) < 0) throw invalid(s);
      n++;
    }
    if (n % 2 != 0) throw invalid(s);
    byte[] out = new byte[n / 2];
    int k = 0;
    int hi = -1;
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (Character.isWhitespace(c)) continue;
      int d = digit(c);
      if (hi < 0) hi = d;
      else {
        out[k++] = (byte) ((hi << 4) | d);
        hi = -1;
      }
    }
    return out;
  }

  private static YaffleException invalid(String s) {
    return new YaffleException(ErrorCode.INPUT, "invalid hex string " + Json.describe(s));
  }
}
