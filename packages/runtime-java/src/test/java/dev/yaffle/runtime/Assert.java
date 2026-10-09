package dev.yaffle.runtime;

import java.util.Arrays;
import java.util.Objects;

/** Assertions for the runtime's unit tests. */
final class Assert {
  private Assert() {}

  static final class Failure extends RuntimeException {
    private static final long serialVersionUID = 1L;

    Failure(String m) {
      super(m);
    }
  }

  static void check(boolean ok, String what) {
    if (!ok) throw new Failure(what);
  }

  static void eq(Object expected, Object actual) {
    if (expected instanceof byte[] e && actual instanceof byte[] a) {
      if (!Arrays.equals(e, a)) throw new Failure("expected " + Hex.encode(e) + ", got " + Hex.encode(a));
      return;
    }
    if (!Objects.equals(expected, actual)) throw new Failure("expected " + expected + ", got " + actual);
  }

  static void eq(long expected, long actual) {
    if (expected != actual) throw new Failure("expected " + expected + ", got " + actual);
  }

  interface Body {
    void run();
  }

  static YaffleException fails(ErrorCode code, Body b) {
    try {
      b.run();
    } catch (YaffleException e) {
      if (e.code() != code) throw new Failure("expected " + code + ", got " + e.getMessage());
      return e;
    }
    throw new Failure("expected " + code + ", but nothing failed");
  }
}
