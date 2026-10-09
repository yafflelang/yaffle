/** Test helpers: a scriptable fake backend adapter and temporary case directories. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { IrProgram } from "yaffle/ir";
import type { AdapterRunInput, Case, CaseResult, ConformanceAdapter } from "../src/adapter.ts";
import type { CompileFn } from "../src/runner.ts";

export const EMPTY_PROGRAM: IrProgram = {
  version: 1,
  modules: [],
  structs: [],
  enums: [],
  externs: [],
  consts: [],
  roots: []
};

export const okCompile: CompileFn = () => ({ program: EMPTY_PROGRAM, diagnostics: [] });

function inputHex(c: Case): string {
  if (typeof c.bytes === "string") return c.bytes;
  if (c.bytes === undefined) return "";
  return readFileSync(c.bytes.file).toString("hex");
}

/** The "perfect" answer for a case: what a correct backend would return. Tests then perturb it. */
export function perfectResult(c: Case): CaseResult {
  if (c.error !== undefined) {
    return {
      name: c.name,
      ok: true,
      error: {
        phase: c.error.phase,
        code: c.error.code,
        path: c.error.path ?? [],
        offset: 0,
        message: "boom"
      }
    };
  }
  if (c.input !== undefined) return { name: c.name, ok: true, bytes: inputHex(c) };
  const r: CaseResult = { name: c.name, ok: true, json: c.json ?? {} };
  if (c.roundtrip !== false) r.bytes = inputHex(c);
  return r;
}

export interface FakeAdapter extends ConformanceAdapter {
  calls: AdapterRunInput[];
}

export function fakeAdapter(
  target: string,
  respond: (c: Case, input: AdapterRunInput) => CaseResult | undefined = c => perfectResult(c),
  opts: { available?: () => Promise<boolean>; throws?: Error } = {}
): FakeAdapter {
  const calls: AdapterRunInput[] = [];
  return {
    target,
    calls,
    available: opts.available ?? (async () => true),
    async run(input) {
      calls.push(input);
      if (opts.throws) throw opts.throws;
      return input.cases.flatMap(c => respond(c, input) ?? []);
    }
  };
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "yaffle-conf-"));
}

/** Creates a temporary case root with the given directories: { name: { cases, files } }. */
export function makeCaseRoot(
  dirs: Record<
    string,
    { cases: unknown; files?: Record<string, string | Uint8Array>; schema?: string | null }
  >
): string {
  const root = tempDir();
  for (const [name, spec] of Object.entries(dirs)) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    if (spec.schema !== null)
      writeFileSync(join(dir, "schema.yfl"), spec.schema ?? "export struct A { u8 x }\n");
    writeFileSync(
      join(dir, "cases.json"),
      typeof spec.cases === "string" ? spec.cases : JSON.stringify({ cases: spec.cases }, null, 2)
    );
    for (const [f, content] of Object.entries(spec.files ?? {})) {
      const p = join(dir, f);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
  }
  return root;
}
