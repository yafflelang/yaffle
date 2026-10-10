/**
 * Test harness for the Python backend: compiles yaffle sources in memory, generates a Python
 * package into the cache directory (outside the repository) and runs Python snippets against it.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { compile, type CompilerHost } from "../../../src/index.ts";
import type { IrProgram } from "../../../src/ir/index.ts";
import { generatePython, runtimePackageRoot } from "../../../src/backends/python/index.ts";
import { cacheDir, findPython, runPython } from "../../../src/backends/python/python.ts";

export const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));

/** True if a Python 3.12+ interpreter is available (tests skip otherwise). */
export const HAVE_PYTHON = findPython() !== undefined;

function memoryHost(files: Record<string, string>): CompilerHost {
  return { readFile: p => files[p], fileExists: p => p in files };
}

/** Compiles one in-memory source (or several files) and returns the program. */
export function program(source: string | Record<string, string>): IrProgram {
  const files = typeof source === "string" ? { "/memory/schema.yfl": source } : source;
  const entry = Object.keys(files)[0]!;
  const r = compile([entry], memoryHost(files));
  const errors = r.diagnostics.filter(d => d.severity === "error");
  expect(errors.map(d => `${d.code}: ${d.message}`)).toEqual([]);
  return r.program!;
}

export interface Generated {
  /** Directory on PYTHONPATH (contains the package). */
  dir: string;
  /** Package name. */
  pkg: string;
}

/** Generates `prog` as package `pkg` under the test cache directory. */
export function generate(
  name: string,
  prog: IrProgram,
  opts: { externs?: Record<string, string>; inlineRuntime?: boolean } = {}
): Generated {
  const dir = join(cacheDir(), "tests", name);
  const pkg = `yfl_${name.replace(/\W/g, "_")}`;
  rmSync(dir, { recursive: true, force: true });
  const files = generatePython(prog, {
    externs: opts.externs ?? {},
    inlineRuntime: opts.inlineRuntime ?? false
  });
  for (const f of files) {
    const p = join(dir, pkg, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.contents);
  }
  return { dir, pkg };
}

/**
 * Runs a Python script with the generated package importable (and `yaffle` unless
 * `isolated`). The script prints JSON on its last line; the parsed value is returned.
 */
export async function py(
  gen: Generated | undefined,
  script: string,
  opts: { isolated?: boolean } = {}
): Promise<unknown> {
  const paths = [...(gen ? [gen.dir] : []), ...(opts.isolated ? [] : [runtimePackageRoot()])];
  const dir = join(cacheDir(), "tests", "_scripts");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `s${process.pid}_${Math.random().toString(36).slice(2)}.py`);
  // `-I` ignores PYTHONPATH: isolated scripts add the generated package's directory themselves.
  const header =
    opts.isolated && gen ? `import sys\nsys.path.insert(0, ${JSON.stringify(gen.dir)})\n` : "";
  writeFileSync(file, header + script);
  try {
    const r = await runPython(opts.isolated ? ["-I", file] : [file], {
      pythonPath: paths,
      cwd: gen?.dir ?? dir
    });
    if (r.code !== 0) throw new Error(`python failed (${r.code}):\n${r.stderr}\n${r.stdout}`);
    const lines = r.stdout.trim().split("\n");
    return JSON.parse(lines[lines.length - 1]!);
  } finally {
    rmSync(file, { force: true });
  }
}

/** Python prelude: JSON output helper and error capture. */
export const PRELUDE = `
import json, sys, asyncio
import yaffle as rt

def err(f):
    try:
        f()
    except rt.YaffleError as e:
        return {"code": e.code, "path": e.path}
    return None
`;
