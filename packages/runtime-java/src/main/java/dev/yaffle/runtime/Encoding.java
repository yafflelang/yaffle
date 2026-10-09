package dev.yaffle.runtime;

import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;

/**
 * Text encodings: utf8 / ascii / latin1 (1-byte units), utf16 (2-byte units), utf32 (4-byte
 * units). Lengths always count code units. Invalid input on read is a {@code CHECK} error; text
 * that cannot be encoded (or contains NUL, which would read back differently) is an {@code INPUT}
 * error on write.
 */
public enum Encoding {
  UTF8(1),
  ASCII(1),
  LATIN1(1),
  UTF16(2),
  UTF32(4);

  public final int unit;

  Encoding(int unit) {
    this.unit = unit;
  }

  private static final ThreadLocal<CharsetDecoder> UTF8_DECODER =
      ThreadLocal.withInitial(
          () ->
              StandardCharsets.UTF_8
                  .newDecoder()
                  .onMalformedInput(CodingErrorAction.REPORT)
                  .onUnmappableCharacter(CodingErrorAction.REPORT));

  /** Index (in units, relative to {@code start}) of the first NUL unit, or -1. */
  public static int findNul(byte[] b, int start, int nUnits, int unit) {
    if (unit == 1) {
      for (int i = 0; i < nUnits; i++) if (b[start + i] == 0) return i;
      return -1;
    }
    outer:
    for (int i = 0; i < nUnits; i++) {
      int p = start + i * unit;
      for (int k = 0; k < unit; k++) if (b[p + k] != 0) continue outer;
      return i;
    }
    return -1;
  }

  private static YaffleException check(String detail, long at) {
    return new YaffleException(ErrorCode.CHECK, detail, at);
  }

  /**
   * Decodes {@code nUnits} code units at {@code start} (the caller has already cut at the NUL
   * unit). {@code at} is the absolute offset reported in errors.
   */
  public String decode(byte[] b, int start, int nUnits, boolean le, long at) {
    switch (this) {
      case LATIN1:
        return new String(b, start, nUnits, StandardCharsets.ISO_8859_1);
      case ASCII:
        for (int i = 0; i < nUnits; i++) {
          if ((b[start + i] & 0x80) != 0) {
            throw check(
                "byte 0x" + Integer.toHexString(b[start + i] & 0xff) + " is not ASCII", at + i);
          }
        }
        return new String(b, start, nUnits, StandardCharsets.ISO_8859_1);
      case UTF8:
        {
          boolean ascii = true;
          for (int i = 0; i < nUnits; i++) {
            if (b[start + i] < 0) {
              ascii = false;
              break;
            }
          }
          if (ascii) return new String(b, start, nUnits, StandardCharsets.ISO_8859_1);
          try {
            CharsetDecoder d = UTF8_DECODER.get();
            d.reset();
            CharBuffer cb = d.decode(ByteBuffer.wrap(b, start, nUnits));
            return cb.toString();
          } catch (CharacterCodingException e) {
            throw check("invalid UTF-8", at);
          }
        }
      case UTF16:
        {
          StringBuilder sb = new StringBuilder(nUnits);
          for (int i = 0; i < nUnits; i++) {
            int p = start + i * 2;
            int u = Bytes.u16(b, p, le);
            if (u >= 0xd800 && u <= 0xdbff) {
              int next = i + 1 < nUnits ? Bytes.u16(b, p + 2, le) : -1;
              if (next < 0xdc00 || next > 0xdfff) {
                throw check("invalid UTF-16 (lone high surrogate)", at + i * 2L);
              }
              sb.append((char) u).append((char) next);
              i++;
            } else if (u >= 0xdc00 && u <= 0xdfff) {
              throw check("invalid UTF-16 (lone low surrogate)", at + i * 2L);
            } else {
              sb.append((char) u);
            }
          }
          return sb.toString();
        }
      case UTF32:
        {
          StringBuilder sb = new StringBuilder(nUnits);
          for (int i = 0; i < nUnits; i++) {
            long cp = Bytes.i32(b, start + i * 4, le) & 0xffffffffL;
            if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
              throw check("invalid UTF-32 code point 0x" + Long.toHexString(cp), at + i * 4L);
            }
            sb.appendCodePoint((int) cp);
          }
          return sb.toString();
        }
      default:
        throw new IllegalStateException();
    }
  }

  private static YaffleException input(String detail) {
    return new YaffleException(ErrorCode.INPUT, detail);
  }

  /** Encodes text without any terminator or padding. */
  public byte[] encode(String s, boolean le) {
    if (s == null) throw input("expected a string, got null");
    switch (this) {
      case UTF8:
        {
          if (s.indexOf('\0') >= 0) throw input("string contains NUL");
          if (!isWellFormed(s)) throw input("string is not well-formed UTF-16 (lone surrogate)");
          return s.getBytes(StandardCharsets.UTF_8);
        }
      case ASCII:
      case LATIN1:
        {
          int lim = this == ASCII ? 0x80 : 0x100;
          byte[] out = new byte[s.length()];
          for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == 0) throw input("string contains NUL");
            if (c >= lim) {
              throw input(
                  String.format("character U+%04x is not %s", (int) c, name().toLowerCase()));
            }
            out[i] = (byte) c;
          }
          return out;
        }
      case UTF16:
        {
          if (!isWellFormed(s)) throw input("string is not well-formed UTF-16 (lone surrogate)");
          byte[] out = new byte[s.length() * 2];
          for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == 0) throw input("string contains NUL");
            Bytes.put16(out, i * 2, c, le);
          }
          return out;
        }
      case UTF32:
        {
          if (!isWellFormed(s)) throw input("string is not well-formed UTF-16 (lone surrogate)");
          int[] cps = s.codePoints().toArray();
          byte[] out = new byte[cps.length * 4];
          for (int i = 0; i < cps.length; i++) {
            if (cps[i] == 0) throw input("string contains NUL");
            Bytes.put32(out, i * 4, cps[i], le);
          }
          return out;
        }
      default:
        throw new IllegalStateException();
    }
  }

  /** True if {@code s} has no lone surrogates. */
  public static boolean isWellFormed(String s) {
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (Character.isHighSurrogate(c)) {
        if (i + 1 >= s.length() || !Character.isLowSurrogate(s.charAt(i + 1))) return false;
        i++;
      } else if (Character.isLowSurrogate(c)) return false;
    }
    return true;
  }

  /** Code units {@code s} occupies in this encoding ({@code .length} of a string). */
  public long codeUnits(String s) {
    if (s == null) throw input("expected a string, got null");
    switch (this) {
      case UTF8:
        {
          long n = 0;
          for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c < 0x80) n += 1;
            else if (c < 0x800) n += 2;
            else if (Character.isHighSurrogate(c)
                && i + 1 < s.length()
                && Character.isLowSurrogate(s.charAt(i + 1))) {
              n += 4;
              i++;
            } else n += 3;
          }
          return n;
        }
      case UTF32:
        return s.codePointCount(0, s.length());
      default:
        return s.length();
    }
  }

  /** Bytes {@code s} occupies in this encoding (the IR builtin {@code encodedLength}). */
  public long encodedBytes(String s) {
    return codeUnits(s) * unit;
  }
}
