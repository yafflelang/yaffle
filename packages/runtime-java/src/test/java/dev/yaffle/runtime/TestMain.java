package dev.yaffle.runtime;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A minimal test runner (no dependencies): runs every {@code public static void test*()} method
 * of the test classes, prints one line per test and exits non-zero on failures. With an argument,
 * also writes the results as JSON to that file.
 */
public final class TestMain {
  private TestMain() {}

  static final List<Class<?>> CLASSES =
      List.of(
          IntsTest.class,
          BytesTest.class,
          EncodingTest.class,
          JsonTest.class,
          ReaderTest.class,
          WriterTest.class,
          CodecsTest.class,
          CommitTest.class);

  public static void main(String[] args) throws Exception {
    Map<String, Object> results = new LinkedHashMap<>();
    int failed = 0;
    int passed = 0;
    for (Class<?> c : CLASSES) {
      Method[] ms = c.getDeclaredMethods();
      Arrays.sort(ms, Comparator.comparing(Method::getName));
      for (Method m : ms) {
        if (!m.getName().startsWith("test") || !Modifier.isStatic(m.getModifiers())) continue;
        String name = c.getSimpleName() + "." + m.getName();
        try {
          m.invoke(null);
          passed++;
          results.put(name, Map.of("ok", true));
          System.out.println("ok   " + name);
        } catch (InvocationTargetException e) {
          failed++;
          Throwable t = e.getCause();
          results.put(name, Map.of("ok", false, "message", String.valueOf(t)));
          System.out.println("FAIL " + name + ": " + t);
          t.printStackTrace(System.out);
        }
      }
    }
    System.out.println(passed + " passed, " + failed + " failed");
    if (args.length > 0) {
      java.nio.file.Files.writeString(java.nio.file.Path.of(args[0]), Json.write(results));
    }
    if (failed > 0) System.exit(1);
  }
}
