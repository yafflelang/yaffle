/**
 * Conformance adapter for the Python target (docs/CONFORMANCE.md, conformance/src/adapter.ts).
 *
 * Generates the case directory's program as the package `yfl_gen` in `workDir`, writes the cases
 * to a spec file and runs one Python process per case directory (`yaffle_runtime._harness`),
 * which writes one result file per case: a crash loses one case, and huge JSON doesn't go
 * through a pipe. Results carry the actual JSON, bytes and error; the runner re-checks them.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IrProgram } from "../../ir/index.ts";
import { generatePython, runtimePackageRoot } from "./index.ts";
import { Model } from "./model.ts";
import { Names, moduleSegments } from "./names.ts";
import { findPython, runPython } from "./python.ts";

// Structural copies of conformance/src/adapter.ts (the compiler package cannot import it).
type RoundTrip = boolean | "json" | "value";

interface Case {
  name: string;
  root: string;
  args?: Record<string, unknown>;
  bytes?: string | { file: string };
  json?: unknown;
  input?: unknown;
  roundtrip?: RoundTrip;
  strict?: boolean;
  error?: { phase: "parse" | "serialize"; code: string; path?: (string | number)[] };
}

interface CaseResult {
  name: string;
  ok: boolean;
  message?: string;
  skipped?: string;
  json?: unknown;
  bytes?: string;
  error?: {
    phase: "parse" | "serialize";
    code: string;
    path?: (string | number)[];
    offset?: number;
    message?: string;
  };
}

interface AdapterRunInput {
  caseDir: string;
  program: IrProgram;
  cases: Case[];
  workDir: string;
  externs: Record<string, string>;
  mode?: "parse" | "view";
}

/** Byte outputs larger than this are left out of results (large sample files). */
const MAX_HEX_BYTES = 1 << 20;
const PACKAGE = "yfl_gen";

export const adapter = {
  target: "python",
  capabilities: { views: true },
  async available(): Promise<boolean> {
    return findPython() !== undefined;
  },
  async run({ program, cases, workDir, externs, mode }: AdapterRunInput): Promise<CaseResult[]> {
    const pkg = join(workDir, PACKAGE);
    rmSync(pkg, { recursive: true, force: true });
    for (const f of generatePython(program, { externs })) {
      const p = join(pkg, f.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.contents);
    }
    const model = new Model(program);
    const names = new Names(model);
    const results: CaseResult[] = [];
    const specCases: unknown[] = [];
    /** Index in `cases` of each spec case. */
    const index: number[] = [];
    cases.forEach((c, i) => {
      const root =
        program.roots.find(r => r.name === c.root) ?? program.roots.find(r => r.struct === c.root);
      if (!root) {
        results[i] = { name: c.name, ok: false, message: `unknown root ${c.root}` };
        return;
      }
      const s = model.struct(root.struct);
      const mod = program.modules.find(m => m.path === s.module || m.name === s.module);
      index.push(i);
      specCases.push({
        name: c.name,
        module: [PACKAGE, ...moduleSegments(mod ? mod.name : s.module)].join("."),
        cls: names.structClass(s.id),
        async: s.async,
        args: c.args ?? {},
        bytes: c.bytes,
        json: c.json,
        input: c.input,
        roundtrip: c.roundtrip,
        strict: c.strict,
        error: c.error
      });
    });
    const specPath = join(workDir, "spec.json");
    const outDir = join(workDir, "results");
    rmSync(outDir, { recursive: true, force: true });
    writeFileSync(
      specPath,
      JSON.stringify({ maxHexBytes: MAX_HEX_BYTES, mode: mode ?? "parse", cases: specCases })
    );
    const run = await runPython(["-m", "yaffle_runtime._harness", specPath, outDir], {
      pythonPath: [runtimePackageRoot(), workDir],
      cwd: workDir
    });
    index.forEach((caseIndex, k) => {
      const file = join(outDir, `${k}.json`);
      results[caseIndex] = existsSync(file)
        ? (JSON.parse(readFileSync(file, "utf8")) as CaseResult)
        : {
            name: cases[caseIndex]!.name,
            ok: false,
            message: `the Python harness produced no result (exit ${run.code}):\n${run.stderr.slice(-4000)}`
          };
    });
    return results;
  }
};
