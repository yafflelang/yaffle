/** Runs the Java runtime's unit tests (packages/runtime-java/src/test, a self-contained runner). */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { findJdk, javac } from "../../../src/backends/java/toolchain.ts";
import { testDir } from "./harness.ts";

const here = dirname(fileURLToPath(import.meta.url));
const runtime = join(here, "../../../../runtime-java");

function javaFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return javaFiles(p);
    return e.name.endsWith(".java") ? [p] : [];
  });
}

/** Test names, read from the sources (so each gets an `it` even before the run). */
function testNames(): string[] {
  const dir = join(runtime, "src/test/java/dev/yaffle/runtime");
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith("Test.java")) continue;
    const src = readFileSync(join(dir, f), "utf8");
    for (const m of src.matchAll(/public static void (test\w+)\(\)/g)) {
      out.push(`${f.replace(/\.java$/, "")}.${m[1]}`);
    }
  }
  return out.sort();
}

const jdk = findJdk();

describe.skipIf(!jdk)("java runtime unit tests", () => {
  let results: Record<string, { ok: boolean; message?: string }> = {};
  beforeAll(() => {
    const out = testDir("runtime-unit");
    const sources = [
      ...javaFiles(join(runtime, "src/main/java")),
      ...javaFiles(join(runtime, "src/test/java"))
    ];
    const classes = join(out, "classes");
    const jc = javac(jdk!, sources, classes);
    if (!jc.ok) throw new Error(`javac failed:\n${jc.output}`);
    const report = join(out, "results.json");
    rmSync(report, { force: true });
    spawnSync(jdk!.java, ["-cp", classes, "dev.yaffle.runtime.TestMain", report], {
      encoding: "utf8"
    });
    results = JSON.parse(readFileSync(report, "utf8"));
  }, 300_000);
  for (const name of testNames()) {
    it(name, () => {
      const r = results[name];
      expect(r?.message ?? "", name).toBe("");
      expect(r?.ok).toBe(true);
    });
  }
});
