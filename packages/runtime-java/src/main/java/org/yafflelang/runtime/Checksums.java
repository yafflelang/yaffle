package org.yafflelang.runtime;

import java.nio.charset.StandardCharsets;
import java.util.zip.Adler32;
import java.util.zip.CRC32;

/** Built-in checksums (docs/IR.md §5): crc32 (IEEE 802.3, reflected) and adler32. */
public final class Checksums {
  private Checksums() {}

  public static long crc32(byte[] data) {
    CRC32 c = new CRC32();
    c.update(data, 0, data.length);
    return c.getValue();
  }

  public static long crc32(String s) {
    return crc32(s.getBytes(StandardCharsets.UTF_8));
  }

  public static long adler32(byte[] data) {
    Adler32 a = new Adler32();
    a.update(data, 0, data.length);
    return a.getValue();
  }

  public static long adler32(String s) {
    return adler32(s.getBytes(StandardCharsets.UTF_8));
  }
}
