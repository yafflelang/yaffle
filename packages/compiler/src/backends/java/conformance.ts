/**
 * Conformance adapter for the Java target (docs/CONFORMANCE.md, conformance/src/adapter.ts):
 * generates the case directory's program into `workDir`, compiles it with a generated harness,
 * runs every case in one JVM and judges what the harness observed. The runner re-checks JSON,
 * bytes and errors.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { IrProgram } from "../../ir/index.ts";
import { HARNESS_CLASS, harnessSource, type HarnessRoot } from "./harness.ts";
import { DEFAULT_PACKAGE, generateJava } from "./index.ts";
import { Model } from "./model.ts";
import { dependencyJars, findJdk, javac, runtimeClasses, writeSources } from "./toolchain.ts";

// Structural copies of conformance/src/adapter.ts (the compiler package cannot import it).
export type RoundTrip = boolean | "json" | "value";

export interface Case {
  name: string;
  root: string;
  args?: Record<string, unknown>;
  bytes?: string | { file: string; offset?: number; length?: number };
  json?: unknown;
  input?: unknown;
  roundtrip?: RoundTrip;
  strict?: boolean;
  error?: { phase: "parse" | "serialize"; code: string; path?: (string | number)[] };
  description?: string;
}

export interface CaseError {
  phase: "parse" | "serialize";
  code: string;
  path?: (string | number)[];
  offset?: number;
  message?: string;
}

export interface CaseResult {
  name: string;
  ok: boolean;
  message?: string;
  skipped?: string;
  json?: unknown;
  bytes?: string;
  error?: CaseError;
}

export interface AdapterRunInput {
  caseDir: string;
  program: IrProgram;
  cases: Case[];
  workDir: string;
  externs?: Record<string, string>;
  /** "view": run parse cases through views (docs/CONFORMANCE.md §7). */
  mode?: "parse" | "view";
}

export interface ConformanceAdapter {
  target: string;
  capabilities?: { views?: boolean };
  available(): Promise<boolean>;
  run(input: AdapterRunInput): Promise<CaseResult[]>;
}

/** What the harness observed for one case. */
interface Observed {
  json?: unknown;
  out?: string;
  outLen?: number;
  outEqual?: boolean;
  diffAt?: number;
  error?: CaseError;
  exception?: string;
}

/**
 * The Java target options of a case directory's yaffle.json, extern paths made absolute (a
 * classpath class name stays as it is).
 */
export function javaConfig(caseDir: string): {
  externs: Record<string, string>;
  dependencies: Record<string, string>;
} {
  const cfg = join(caseDir, "yaffle.json");
  if (!existsSync(cfg)) return { externs: {}, dependencies: {} };
  const json = JSON.parse(readFileSync(cfg, "utf8")) as {
    targets?: {
      java?: { externs?: Record<string, string>; dependencies?: Record<string, string> };
    };
  };
  const externs: Record<string, string> = {};
  for (const [name, spec] of Object.entries(json.targets?.java?.externs ?? {})) {
    const hash = spec.indexOf("#");
    const path = hash > 0 ? spec.slice(0, hash) : spec;
    const item = hash > 0 ? spec.slice(hash) : "";
    externs[name] =
      /^\.\.?\//.test(path) || path.startsWith("/") ? resolve(dirname(cfg), path) + item : spec;
  }
  return { externs, dependencies: json.targets?.java?.dependencies ?? {} };
}

// ── judging ─────────────────────────────────────────────────────────────────────

/** Deep equality of JSON values; returns a description of the first difference, or undefined. */
export function jsonDiff(a: unknown, b: unknown, path = ""): string | undefined {
  if (a === b) return undefined;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") {
    return `${path || "/"}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path || "/"}: array vs object`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length)
      return `${path || "/"}: expected ${b.length} elements, got ${a.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = jsonDiff(a[i], b[i], `${path}/${i}`);
      if (d) return d;
    }
    return undefined;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) {
    if (!(k in ao)) return `${path}/${k}: missing`;
    if (!(k in bo)) return `${path}/${k}: unexpected`;
    const d = jsonDiff(ao[k], bo[k], `${path}/${k}`);
    if (d) return d;
  }
  return undefined;
}

function notImplemented(msg: string): boolean {
  return /not implemented|not supported/i.test(msg);
}

/** Judges one case from the harness's observations. */
export function judge(c: Case, o: Observed): CaseResult {
  const result: CaseResult = { name: c.name, ok: false };
  if (o.json !== undefined) result.json = o.json;
  if (o.out !== undefined) result.bytes = o.out;
  if (o.exception !== undefined) {
    if (notImplemented(o.exception)) return { ...result, skipped: o.exception.split("\n")[0]! };
    return { ...result, message: `unexpected exception: ${o.exception}` };
  }
  const bytesDiffer = (what: string): CaseResult => ({
    ...result,
    message: `${what}: bytes differ at offset 0x${(o.diffAt ?? 0).toString(16)} (got ${o.outLen ?? "?"} bytes)`
  });
  if (o.error) {
    const err = o.error;
    result.error = err;
    const msg = err.message ?? "";
    if (!c.error) {
      if (notImplemented(msg)) return { ...result, skipped: msg };
      return { ...result, message: `unexpected ${err.code} error in ${err.phase}: ${msg}` };
    }
    if (c.json !== undefined && o.json !== undefined && err.phase === "serialize") {
      const d = jsonDiff(o.json, c.json);
      if (d) return { ...result, message: `parse: ${d}` };
    }
    if (c.error.phase !== err.phase) {
      return {
        ...result,
        message: `expected a ${c.error.phase} error, got ${err.code} in ${err.phase}: ${msg}`
      };
    }
    if (err.code !== c.error.code) {
      return { ...result, message: `expected ${c.error.code}, got ${err.code}: ${msg}` };
    }
    if (c.error.path && JSON.stringify(err.path) !== JSON.stringify(c.error.path)) {
      return {
        ...result,
        message: `expected path ${JSON.stringify(c.error.path)}, got ${JSON.stringify(err.path)} (${msg})`
      };
    }
    return { ...result, ok: true };
  }
  if (c.input !== undefined) {
    if (c.error) return { ...result, message: `expected ${c.error.code}, but serialize succeeded` };
    return o.outEqual === true ? { ...result, ok: true } : bytesDiffer("serialize");
  }
  if (c.error?.phase === "parse") {
    return { ...result, message: `expected ${c.error.code}, but parse succeeded` };
  }
  if (c.json !== undefined) {
    const d = jsonDiff(o.json, c.json);
    if (d) return { ...result, message: `parse: ${d}` };
  }
  const rt = c.error?.phase === "serialize" ? "json" : (c.roundtrip ?? true);
  if (rt !== false) {
    if (c.error?.phase === "serialize") {
      return { ...result, message: `expected ${c.error.code}, but serialize succeeded` };
    }
    if (o.outEqual !== true) return bytesDiffer("roundtrip");
  }
  return { ...result, ok: true };
}

// ── adapter ─────────────────────────────────────────────────────────────────────

export const adapter: ConformanceAdapter = {
  target: "java",
  capabilities: { views: true },
  async available() {
    return findJdk() !== undefined;
  },
  async run({ caseDir, program, cases, workDir, externs, mode }) {
    const jdk = findJdk();
    if (!jdk) throw new Error("no JDK 21 found (not supported here)");
    const cfg = javaConfig(caseDir);
    const ext = externs && Object.keys(externs).length ? externs : cfg.externs;
    let files;
    try {
      files = generateJava(program, { externs: ext, targetOptions: { package: DEFAULT_PACKAGE } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (notImplemented(msg)) return cases.map(c => ({ name: c.name, ok: false, skipped: msg }));
      throw e;
    }
    // Root name → class; a struct exported under several names gets one harness entry.
    const model = new Model(program, DEFAULT_PACKAGE);
    const roots = new Map<string, HarnessRoot>();
    const byClass = new Map<string, HarnessRoot>();
    for (const r of program.roots) {
      const s = program.structs.find(x => x.id === r.struct);
      if (!s) continue;
      const cls = model.className(s.id);
      const root = byClass.get(cls) ?? { cls, async: s.async };
      byClass.set(cls, root);
      roots.set(r.name, root);
    }
    const harness = {
      path: `${HARNESS_CLASS.replace(/\./g, "/")}.java`,
      contents: harnessSource(DEFAULT_PACKAGE, [...byClass.values()], model.optionsName)
    };
    const sources = writeSources(join(workDir, "src"), [...files, harness]);
    const cp = [runtimeClasses(jdk), ...(await dependencyJars(cfg.dependencies))];
    const classes = join(workDir, "classes");
    const jc = javac(jdk, sources, classes, cp);
    if (!jc.ok) {
      const msg = `javac failed:\n${jc.output.slice(0, 4000)}`;
      return cases.map(c => ({ name: c.name, ok: false, message: msg }));
    }

    const results: CaseResult[] = [];
    const runnable: { c: Case; index: number }[] = [];
    const input: unknown[] = [];
    for (const c of cases) {
      const root = roots.get(c.root) ?? byClass.get(c.root);
      if (!root) {
        results.push({ name: c.name, ok: false, message: `unknown root ${c.root}` });
        continue;
      }
      runnable.push({ c, index: input.length });
      input.push({
        name: c.name,
        cls: root.cls,
        args: c.args ?? null,
        bytes: c.bytes ?? null,
        json: c.json ?? null,
        input: c.input ?? null,
        ...(c.roundtrip !== undefined ? { roundtrip: c.roundtrip } : {}),
        strict: c.strict ?? false,
        errorPhase: c.error?.phase ?? null,
        view: mode === "view"
      });
    }
    const casesFile = join(workDir, "cases.json");
    writeFileSync(casesFile, JSON.stringify(input));
    const outDir = join(workDir, "results");
    rmSync(outDir, { recursive: true, force: true });
    const run = spawnSync(
      jdk.java,
      ["-Xmx8g", "-Xss64m", "-cp", [classes, ...cp].join(":"), HARNESS_CLASS, casesFile, outDir],
      { encoding: "utf8", maxBuffer: 256 << 20 }
    );
    for (const { c, index } of runnable) {
      const file = join(outDir, `${index}.json`);
      if (!existsSync(file)) {
        results.push({
          name: c.name,
          ok: false,
          message: `the harness produced no result (exit ${run.status}):\n${`${run.stdout}${run.stderr}`.slice(0, 4000)}`
        });
        continue;
      }
      results.push(judge(c, JSON.parse(readFileSync(file, "utf8")) as Observed));
    }
    return results;
  }
};
