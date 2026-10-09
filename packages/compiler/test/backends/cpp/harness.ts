/**
 * Test harness for the C++ target: compiles yaffle sources with the frontend, generates C++ into
 * `$YAFFLE_CPP_CACHE/tests/<name>`, builds it together with a test `main.cpp` (cached by content)
 * and runs the executable.
 */
import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compileSource } from "yaffle";
import type { IrProgram } from "yaffle/ir";
import { generateCpp } from "../../../src/backends/cpp/index.ts";
import {
  buildExecutable,
  cacheDir,
  findToolchain,
  type Libraries
} from "../../../src/backends/cpp/toolchain.ts";

export const toolchain = await findToolchain();

export function program(source: string): IrProgram {
  const r = compileSource(source);
  const errors = r.diagnostics.filter(d => d.severity === "error");
  if (!r.program || errors.length)
    throw new Error(
      `schema does not compile:\n${errors.map(d => `${d.code}: ${d.message}`).join("\n")}`
    );
  return r.program;
}

export interface BuildOptions {
  externs?: Record<string, string>;
  /** Extra files written next to the generated code (extern headers). */
  files?: Record<string, string>;
  libs?: Libraries;
  inlineRuntime?: boolean;
}

export interface Built {
  dir: string;
  header: string;
  source: string;
  run(args?: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
}

/** Generates `source` (yaffle) plus `main` (C++) into a test directory and builds it. */
export async function build(
  name: string,
  source: string | IrProgram,
  main: string,
  opts: BuildOptions = {}
): Promise<Built> {
  if (!toolchain) throw new Error("no C++ compiler");
  const p = typeof source === "string" ? program(source) : source;
  const gen = generateCpp(p, {
    externs: opts.externs ?? {},
    inlineRuntime: opts.inlineRuntime ?? false,
    targetOptions: { namespace: "t", file: "gen" }
  });
  const dir = join(cacheDir(), "tests", name);
  rmSync(dir, { recursive: true, force: true });
  const write = (path: string, contents: string): void => {
    const f = join(dir, path);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, contents);
  };
  for (const f of gen.files) write(f.path, f.contents);
  for (const [path, contents] of Object.entries(opts.files ?? {})) write(path, contents);
  write("main.cpp", main);
  const exe = await buildExecutable({
    tc: toolchain,
    dir,
    sources: ["gen.cpp", "main.cpp"],
    deps: [],
    libs: opts.libs ?? { includeDirs: [], libDirs: [], libs: [] }
  });
  const header = gen.files.find(f => f.path === gen.header)!.contents;
  const src = gen.files.find(f => f.path === gen.source)!.contents;
  return {
    dir,
    header,
    source: src,
    run: (args = []) =>
      new Promise(res => {
        execFile(exe, args, { maxBuffer: 256 << 20, timeout: 600_000 }, (err, stdout, stderr) => {
          const code = err ? ((err as { code?: number }).code ?? 1) : 0;
          res({
            stdout: String(stdout),
            stderr: String(stderr),
            code: typeof code === "number" ? code : 1
          });
        });
      })
  };
}

/** C++ prelude for test mains: hex helpers and a CHECK that prints instead of aborting. */
export const PRELUDE = `#include <cstdio>
#include <iostream>
#include "gen.hpp"
using namespace t;
static int failures = 0;
#define CHECK(c) do { if (!(c)) { std::printf("FAIL line %d: %s\\n", __LINE__, #c); failures++; } } while (0)
[[maybe_unused]] static yaffle::Bytes hex(const char* s) { return yaffle::from_hex(s); }
[[maybe_unused]] static std::string err(const std::function<void()>& f) {
  try { f(); } catch (const yaffle::Error& e) {
    return std::string(yaffle::code_name(e.code)) + " " + yaffle::format_path(e.path);
  }
  return "ok";
}
`;
