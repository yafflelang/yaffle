/**
 * Generated code quality: every conformance schema generates Java that
 * compiles with `javac -Xlint:all -Werror`, views included; `inlineRuntime` output compiles on its
 * own; the backend handles names that clash with Java and runtime names.
 */
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { GeneratedFile } from "../../../src/backends/backend.ts";
import { javaConfig } from "../../../src/backends/java/conformance.ts";
import { generateJava } from "../../../src/backends/java/index.ts";
import {
  dependencyJars,
  findJdk,
  javac,
  runtimeClasses,
  writeSources
} from "../../../src/backends/java/toolchain.ts";
import { compile } from "../../../src/index.ts";
import { program, testDir } from "./harness.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../../../..");
const jdk = findJdk();

function caseDirs(): string[] {
  const out: string[] = [];
  for (const base of ["conformance/cases"]) {
    for (const d of readdirSync(join(repo, base)).sort()) out.push(join(repo, base, d));
  }
  return out;
}

/** Writes and compiles `files`; expects no output from javac. */
function compiles(name: string, files: readonly GeneratedFile[], classpath: string[]): void {
  const dir = join(testDir("generated"), name);
  const r = javac(jdk!, writeSources(join(dir, "src"), files), join(dir, "classes"), classpath);
  expect(r.output).toBe("");
  expect(r.ok).toBe(true);
}

describe.skipIf(!jdk)("java generated code", () => {
  it("every conformance schema compiles with -Xlint:all -Werror (one package per schema)", async () => {
    // Extern sources shared by several schemas are written once.
    const files = new Map<string, GeneratedFile>();
    const deps: Record<string, string> = {};
    for (const dir of caseDirs()) {
      const r = compile([join(dir, "schema.yfl")]);
      expect(r.program, `${dir}: ${JSON.stringify(r.diagnostics)}`).toBeDefined();
      const cfg = javaConfig(dir);
      Object.assign(deps, cfg.dependencies);
      const pkg = `gen.${dir
        .split("/")
        .slice(-2)
        .join("_")
        .replace(/[^A-Za-z0-9_]/g, "_")}`;
      for (const f of generateJava(r.program!, {
        externs: cfg.externs,
        targetOptions: { package: pkg }
      })) {
        if (!files.has(f.path)) files.set(f.path, f);
      }
    }
    compiles("all", [...files.values()], [runtimeClasses(jdk!), ...(await dependencyJars(deps))]);
  }, 600_000);

  it("inlineRuntime output compiles without the runtime on the classpath", () => {
    const files = generateJava(
      program({ "a.yfl": "export struct A { u8 n  u16 xs[n]  str name }" }),
      { externs: {}, inlineRuntime: true }
    );
    expect(files.some(f => f.path === "org/yafflelang/runtime/Reader.java")).toBe(true);
    compiles("inline", files, []);
  }, 300_000);

  it("names clashing with Java keywords, java.lang and runtime classes", () => {
    const src = `
      struct String { u8 class  u8 int }
      struct Reader { u8 default }
      enum Long : u8 { new = 1, value = 2, class = 3 }
      enum Options : u8 @open { value = 1, member = 2 }
      export struct Record {
        String s
        Reader r
        Long l
        Options o
        u8 List
      }
    `;
    const files = generateJava(program({ "names.yfl": src }), { externs: {} });
    compiles("names", files, [runtimeClasses(jdk!)]);
    const record = files.find(f => f.path.endsWith("/Record.java"))!.contents;
    expect(record).toContain("public String s;");
    expect(record).toContain("Map<java.lang.String, Object>");
    expect(record).toContain("org.yafflelang.runtime.Reader $r");
  }, 300_000);
});
