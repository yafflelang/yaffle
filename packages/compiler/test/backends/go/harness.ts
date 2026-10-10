/**
 * Test harness for the Go backend: compiles yaffle source with the frontend, generates Go into a
 * scratch module (package `gen` plus a `main` package written by the test), and runs it with the
 * Go toolchain. Tests skip when no Go toolchain is available.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compileSource } from "../../../src/index.ts";
import { generateGoWithInfo } from "../../../src/backends/go/index.ts";
import { goBinary, goMod, runGo } from "../../../src/backends/go/conformance.ts";
import type { IrProgram } from "../../../src/ir/index.ts";

export const ROOT = join(process.env.YAFFLE_GO_TEST_DIR ?? tmpdir(), "yaffle-go-tests");

export const hasGo = goBinary() !== null;

export function compileOk(source: string, path = "/memory/main.yfl"): IrProgram {
  const r = compileSource(source, path);
  if (!r.program) {
    throw new Error(
      `does not compile:\n${r.diagnostics.map(d => `${d.code}: ${d.message}`).join("\n")}`
    );
  }
  return r.program;
}

export interface GoModule {
  dir: string;
  files: Map<string, string>;
}

/** Generates a module: package gen from the program, extra files (path → contents) as given. */
export function makeModule(
  name: string,
  program: IrProgram,
  opts: {
    externs?: Record<string, string>;
    files?: Record<string, string>;
    deps?: Record<string, string>;
    targetOptions?: Record<string, unknown>;
  } = {}
): GoModule {
  const gen = generateGoWithInfo(program, {
    externs: opts.externs ?? {},
    targetOptions: { package: "gen", ...opts.targetOptions }
  });
  const dir = join(ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "gen"), { recursive: true });
  const files = new Map<string, string>();
  for (const f of gen.files) {
    writeFileSync(join(dir, "gen", f.path), f.contents);
    files.set(`gen/${f.path}`, f.contents);
  }
  writeFileSync(join(dir, "go.mod"), goMod("yafflecase", opts.deps ?? {}));
  for (const [p, contents] of Object.entries(opts.files ?? {})) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), contents);
  }
  return { dir, files };
}

/** Builds and runs the module's main package; returns stdout (throws with the output on failure). */
export async function run(mod: GoModule): Promise<string> {
  const r = await runGo(["run", "."], mod.dir);
  if (r.code !== 0) throw new Error(`go run failed:\n${r.out}`);
  return r.out;
}

/** Runs `go vet ./...` in the module; returns the output ("" when clean). */
export async function vet(mod: GoModule): Promise<string> {
  const r = await runGo(["vet", "./..."], mod.dir);
  return r.code === 0 ? "" : r.out;
}

/** `gofmt -l` over the module; returns the files gofmt would change. */
export async function gofmtList(dir: string): Promise<string> {
  const root = (await runGo(["env", "GOROOT"], dir)).out.trim();
  const { execFileSync } = await import("node:child_process");
  try {
    return execFileSync(join(root, "bin", "gofmt"), ["-l", "."], { cwd: dir, encoding: "utf8" });
  } catch (e) {
    return String((e as { stdout?: string }).stdout ?? e);
  }
}

/** A main.go importing the generated package. */
export function mainGo(body: string, imports: string[] = []): string {
  const imps = ["fmt", "yafflecase/gen", ...imports];
  return `package main

import (
${imps.map(i => `\t${JSON.stringify(i)}`).join("\n")}
\tyaffle "yafflelang.org/runtime"
)

var _ = yaffle.LE
var _ = fmt.Sprint

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

func main() {
${body}
}
`;
}
