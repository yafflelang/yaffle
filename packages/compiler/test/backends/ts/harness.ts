/**
 * Test harness: generates TS from an IR program (hand-written or compiled from yaffle source) into
 * `.out/<name>/`, optionally typechecks it with the TypeScript compiler API (strict + the repo's
 * extra checks), and imports the modules.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { expect } from "vitest";
import type { YaffleError } from "@yafflelang/runtime";
import type { IrProgram } from "yaffle/ir";
import { compileSource, nodeHost } from "../../../src/index.ts";
import { generateTs } from "../../../src/backends/ts/index.ts";
import type { GeneratedFile } from "../../../src/backends/backend.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const OUT = join(here, ".out");
export const REPO = resolve(here, "../../../../..");
export const RUNTIME = join(REPO, "packages/runtime/src/index.ts");

/** A generated module or root API, typed loosely. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generated modules are dynamic
export type Mod = Record<string, any>;

export interface GenOptions {
  externs?: Record<string, string>;
  inlineRuntime?: boolean;
  /** Extra files written into the output directory (e.g. extern implementations). */
  files?: Record<string, string>;
}

/** Options that write `contents` next to the generated code as `externs.ts` and bind `names` to it. */
export function externsFile(contents: string, ...names: string[]): GenOptions {
  return {
    files: { "externs.ts": contents },
    externs: Object.fromEntries(names.map(n => [n, "./externs.ts"]))
  };
}

interface Generated {
  dir: string;
  files: GeneratedFile[];
  paths: string[];
}

/** Generates code for a program into `.out/<name>`. */
function generate(name: string, program: IrProgram, opts: GenOptions = {}): Generated {
  const files = generateTs(program, {
    externs: opts.externs ?? {},
    inlineRuntime: opts.inlineRuntime ?? false,
    targetOptions: opts.inlineRuntime ? {} : { runtimeModule: RUNTIME }
  });
  const dir = join(OUT, name);
  rmSync(dir, { recursive: true, force: true });
  const paths: string[] = [];
  const all = [
    ...files,
    ...Object.entries(opts.files ?? {}).map(([path, contents]) => ({ path, contents }))
  ];
  for (const f of all) {
    const p = join(dir, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.contents);
    paths.push(p);
  }
  return { dir, files, paths };
}

const compilerOptions: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2023,
  lib: ["lib.es2023.d.ts"],
  types: ["node"],
  strict: true,
  noEmit: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  verbatimModuleSyntax: true,
  isolatedModules: true,
  allowImportingTsExtensions: true,
  erasableSyntaxOnly: true,
  skipLibCheck: true,
  noUnusedLocals: false,
  typeRoots: [resolve(here, "../../../../../node_modules/@types")]
};

/** Typechecks generated files (plus extra files, e.g. tests using the generated API). Returns diagnostics text. */
function typecheck(paths: string[]): string {
  const program = ts.createProgram(paths, compilerOptions);
  const diags = ts.getPreEmitDiagnostics(program);
  return diags
    .map(d => {
      const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
      if (!d.file) return msg;
      const { line, character } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
      return `${d.file.fileName}:${line + 1}:${character + 1}: ${msg}`;
    })
    .join("\n");
}

/** Imports a generated module (by output-relative path, default "main.ts"). */
export async function load<T = Mod>(gen: Generated, file = "main.ts"): Promise<T> {
  const url = pathToFileURL(join(gen.dir, file)).href;
  return (await import(url)) as T;
}

export interface BuildOptions extends GenOptions {
  /** Typecheck the generated code first (default true). */
  check?: boolean;
  /** The module to import (default "main.ts"). */
  file?: string;
}

/** Generate + typecheck + import in one go (throws on type errors). */
export async function build<T = Mod>(
  name: string,
  program: IrProgram,
  opts: BuildOptions = {}
): Promise<T & { $gen: Generated }> {
  const gen = generate(name, program, opts);
  if (opts.check ?? true) {
    const errors = typecheck(gen.paths);
    if (errors) {
      throw new Error(`generated code for ${name} does not typecheck:\n${errors}\n`);
    }
  }
  const mod = await load<T>(gen, opts.file);
  return Object.assign(Object.create(null), mod, { $gen: gen }) as T & { $gen: Generated };
}

/**
 * Compiles yaffle source with the frontend (imports resolve on disk), then `build`s it. `path` is
 * the source's path (it names the generated module).
 */
export async function buildSource(
  name: string,
  src: string,
  opts: BuildOptions & { path?: string } = {}
): Promise<Mod & { $gen: Generated }> {
  const r = compileSource(src, opts.path, nodeHost);
  if (!r.program) throw new Error(r.diagnostics.map(d => `${d.code}: ${d.message}`).join("\n"));
  return build(name, r.program, opts);
}

/** The error `f` throws; fails the test when it returns normally. */
export function errorOf(f: () => unknown): YaffleError {
  try {
    f();
  } catch (e) {
    return e as YaffleError;
  }
  throw new Error("expected an error");
}

/**
 * parse → JSON → fromJson → serialize gives `bytes` back, and so does serializing the parsed
 * value; a view reads the same JSON and a forced rewrite reproduces the bytes. Returns the JSON.
 */
export function expectRoundTrip(api: Mod, bytes: Uint8Array): unknown {
  const v = api.parse(bytes);
  const json = JSON.parse(JSON.stringify(api.toJson(v)));
  expect(toHex(api.serialize(api.fromJson(json)))).toBe(toHex(bytes));
  expect(toHex(api.serialize(v))).toBe(toHex(bytes));
  expect(JSON.parse(JSON.stringify(api.toJson(api.view(bytes))))).toEqual(json);
  expect(toHex(api.view(bytes).$commit({ rewrite: true }))).toBe(toHex(bytes));
  return json;
}

export function dv(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

export function hex(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
}
