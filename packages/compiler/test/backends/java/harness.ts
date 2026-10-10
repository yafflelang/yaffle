/**
 * Test harness for the Java backend: compiles yaffle sources with the real frontend, generates
 * Java, compiles it (javac -Xlint:all -Werror) together with a generated test class whose methods
 * are the test bodies, runs it once, and reports each test's result.
 *
 * Output goes to `$TMPDIR/yaffle-java-tests/<name>` (override: YAFFLE_JAVA_TEST_DIR).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { generateJava } from "../../../src/backends/java/index.ts";
import {
  findJdk,
  javac,
  runtimeClasses,
  writeSources
} from "../../../src/backends/java/toolchain.ts";
import { compile, type CompilerHost } from "../../../src/index.ts";
import type { IrProgram } from "../../../src/ir/index.ts";

export interface JavaTestResult {
  ok: boolean;
  message?: string;
}

export interface BuildOptions {
  /** Extern implementations: name → absolute path (+ optional #ITEM). */
  externs?: Record<string, string>;
  /** Extra Java helper code placed in the test class (static methods, fields). */
  helpers?: string;
  /** Rewrites the compiled IR before generating (hand-written IR fixtures). */
  transform?: (p: IrProgram) => IrProgram;
  /** Environment for the JVM (e.g. paths of test data). */
  env?: Record<string, string>;
}

export const jdkAvailable = (): boolean => findJdk() !== undefined;

/** Where tests write their programs. */
export const testDir = (name: string): string =>
  join(process.env.YAFFLE_JAVA_TEST_DIR ?? join(tmpdir(), "yaffle-java-tests"), name);

/** An in-memory compiler host over `files` (paths relative to /virtual). */
function memoryHost(files: Record<string, string>): CompilerHost {
  const map = new Map(Object.entries(files).map(([k, v]) => [join("/virtual", k), v]));
  return {
    readFile: p => map.get(p),
    fileExists: p => map.has(p)
  };
}

/** Compiles yaffle sources (the first file is the entry) into a program. */
export function program(files: Record<string, string>): IrProgram {
  const entry = join("/virtual", Object.keys(files)[0]!);
  const r = compile([entry], memoryHost(files), { rootDir: "/virtual" });
  if (!r.program) {
    throw new Error(`yaffle compile failed:\n${JSON.stringify(r.diagnostics, null, 1)}`);
  }
  return r.program;
}

const TEST_SUPPORT = `
  static final class AssertionFailed extends RuntimeException {
    private static final long serialVersionUID = 1L;
    AssertionFailed(String m) { super(m); }
  }
  static void check(boolean ok, String what) {
    if (!ok) throw new AssertionFailed(what);
  }
  static void eq(Object expected, Object actual) {
    if (expected instanceof byte[] e && actual instanceof byte[] a) {
      if (!java.util.Arrays.equals(e, a)) throw new AssertionFailed("expected " + org.yafflelang.runtime.Hex.encode(e) + ", got " + org.yafflelang.runtime.Hex.encode(a));
      return;
    }
    if (expected instanceof Number e && actual instanceof Number a && !(e instanceof Double) && !(a instanceof Double)) {
      if (e.longValue() != a.longValue()) throw new AssertionFailed("expected " + e + ", got " + a);
      return;
    }
    if (!java.util.Objects.equals(expected, actual)) throw new AssertionFailed("expected " + expected + ", got " + actual);
  }
  static void json(String expected, Object actual) {
    Object e = org.yafflelang.runtime.Json.parse(expected);
    String a = org.yafflelang.runtime.Json.write(actual);
    if (!org.yafflelang.runtime.Json.write(e).equals(a)) throw new AssertionFailed("expected JSON " + org.yafflelang.runtime.Json.write(e) + ", got " + a);
  }
  static byte[] hex(String s) {
    return org.yafflelang.runtime.Hex.decode(s);
  }
  static String hex(byte[] b) {
    return org.yafflelang.runtime.Hex.encode(b);
  }
  interface Body { void run() throws Exception; }
  static org.yafflelang.runtime.YaffleException fails(String code, Body b) {
    try {
      b.run();
    } catch (org.yafflelang.runtime.YaffleException e) {
      if (!e.code().name().equals(code)) throw new AssertionFailed("expected " + code + ", got " + e.getMessage());
      return e;
    } catch (Exception e) {
      throw new AssertionFailed("expected " + code + ", got " + e);
    }
    throw new AssertionFailed("expected " + code + ", but nothing failed");
  }
  static void path(String expected, org.yafflelang.runtime.YaffleException e) {
    String a = org.yafflelang.runtime.Json.write(new java.util.ArrayList<Object>(e.path()));
    if (!a.equals(expected)) throw new AssertionFailed("expected path " + expected + ", got " + a + " (" + e.getMessage() + ")");
  }
`;

/** The test class: one method per test, and a main that runs them all and writes the results. */
function testClass(tests: Record<string, string>, helpers: string): string {
  const names = Object.keys(tests);
  const methods = names
    .map((t, i) => `  static void test${i}() throws Exception {\n${tests[t]}\n  }`)
    .join("\n\n");
  const dispatch = names
    .map((t, i) => `    run(out, ${JSON.stringify(t)}, Tests::test${i});`)
    .join("\n");
  return `package yaffle.gen;

@SuppressWarnings({"unused", "unchecked"})
public final class Tests {
  private Tests() {}
${TEST_SUPPORT}
${helpers}

${methods}

  static void run(java.util.Map<String, Object> out, String name, Body b) {
    java.util.Map<String, Object> r = new java.util.LinkedHashMap<>();
    try {
      b.run();
      r.put("ok", true);
    } catch (Throwable e) {
      r.put("ok", false);
      java.io.StringWriter sw = new java.io.StringWriter();
      e.printStackTrace(new java.io.PrintWriter(sw));
      r.put("message", e.toString() + "\\n" + sw.toString().lines().limit(12).reduce("", (x, y) -> x + "\\n" + y));
    }
    out.put(name, r);
  }

  public static void main(String[] args) throws Exception {
    java.util.Map<String, Object> out = new java.util.LinkedHashMap<>();
${dispatch}
    java.nio.file.Files.writeString(java.nio.file.Path.of(args[0]), org.yafflelang.runtime.Json.write(out));
  }
}
`;
}

/**
 * Builds and runs a Java test program. `tests` maps test names to Java statement blocks (they run
 * in the package of the generated code and may throw).
 */
export function runJava(
  name: string,
  sources: Record<string, string>,
  tests: Record<string, string>,
  opts: BuildOptions = {}
): Record<string, JavaTestResult> {
  const jdk = findJdk();
  if (!jdk) throw new Error("no JDK 21");
  const prog = opts.transform ? opts.transform(program(sources)) : program(sources);
  const files = generateJava(prog, { externs: opts.externs ?? {} });
  files.push({ path: "yaffle/gen/Tests.java", contents: testClass(tests, opts.helpers ?? "") });
  const dir = testDir(name);
  const cp = [runtimeClasses(jdk)];
  const classes = join(dir, "classes");
  const jc = javac(jdk, writeSources(join(dir, "src"), files), classes, cp);
  if (!jc.ok) throw new Error(`javac failed:\n${jc.output}`.slice(0, 8000));
  const resFile = join(dir, "results.json");
  const run = spawnSync(
    jdk.java,
    ["-Xss64m", "-cp", [classes, ...cp].join(":"), "yaffle.gen.Tests", resFile],
    { encoding: "utf8", maxBuffer: 64 << 20, env: { ...process.env, ...opts.env } }
  );
  if (!existsSync(resFile)) {
    throw new Error(
      `the test program failed (exit ${run.status}):\n${run.stdout}${run.stderr}`.slice(0, 8000)
    );
  }
  return JSON.parse(readFileSync(resFile, "utf8")) as Record<string, JavaTestResult>;
}

/**
 * A vitest suite running `tests` (Java statement blocks by name) in one program: one `it` per
 * test. Skipped without a JDK, or when `enabled` is false.
 */
export function describeJava(
  title: string,
  name: string,
  sources: Record<string, string>,
  tests: Record<string, string>,
  opts: BuildOptions & { enabled?: boolean; timeout?: number } = {}
): void {
  describe.skipIf(!(opts.enabled ?? true) || !jdkAvailable())(title, () => {
    let results: Record<string, JavaTestResult> = {};
    beforeAll(() => {
      results = runJava(name, sources, tests, opts);
    }, opts.timeout ?? 300_000);
    for (const t of Object.keys(tests)) {
      it(t, () => {
        const r = results[t];
        expect(r?.message ?? "", t).toBe("");
        expect(r?.ok).toBe(true);
      });
    }
  });
}
