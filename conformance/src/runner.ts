/**
 * The conformance runner: compiles each case directory's schema with the frontend, runs its cases
 * on every available backend adapter, and judges the results against the expected canonical JSON,
 * bytes and errors (docs/CONFORMANCE.md).
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IrProgram } from "yaffle/ir";
import type { Case, CaseResult, ConformanceAdapter, JsonExpectation } from "./adapter.ts";
import { diffJson, formatDifferences, getPointer } from "./canonical.ts";
import { discoverAdapters, type DiscoveredAdapter } from "./discover.ts";
import { caseSelected, parseFilter, parseTargets, type CaseFilter } from "./filter.ts";
import { diffHex, isCanonicalHex } from "./hex.ts";
import { loadCaseRoots, type CaseDir, type CaseRoot } from "./load.ts";
import { normalizeCase, type NormalizedCase } from "./normalize.ts";

export type Status = "pass" | "fail" | "skip";

export interface Verdict {
  status: Status;
  /** Failure details or skip reason. */
  message?: string;
}

export interface CaseOutcome extends Verdict {
  target: string;
  dir: string;
  name: string;
}

export interface DirOutcome {
  target: string;
  dir: string;
  cases: CaseOutcome[];
  durationMs: number;
}

export interface TargetInfo {
  target: string;
  /** Why the target's cases are skipped, if they are. */
  unavailable?: string;
}

export interface ConformanceReport {
  targets: TargetInfo[];
  dirs: DirOutcome[];
}

/** Minimal shape of the frontend's compile result (yaffle's CompileResult). */
export interface CompileOutcome {
  program?: IrProgram;
  diagnostics: {
    severity: string;
    code: string;
    message: string;
    path?: string;
    range?: { start: { line: number; character: number } };
  }[];
}
export type CompileFn = (entryFiles: string[]) => CompileOutcome;

export interface RunnerOptions {
  /** Repository root (defaults to the checkout containing this file). */
  repoRoot?: string;
  /** Where case directories live. Default: conformance/cases. */
  caseRoots?: CaseRoot[];
  /** Adapters to use. Default: discovered under packages/compiler/src/backends. */
  adapters?: DiscoveredAdapter[];
  /** The frontend's compile(). Default: imported from the `yaffle` package. */
  compile?: CompileFn;
  /** Environment (filters, targets). Default: process.env. */
  env?: Record<string, string | undefined>;
  /** Scratch root. Default: conformance/.out (gitignored). */
  workRoot?: string;
}

export interface ConformancePlan {
  dirs: CaseDir[];
  adapters: DiscoveredAdapter[];
  filter: CaseFilter;
  workRoot: string;
  compile: CompileFn;
  /** Compile results by case directory path, shared by every target. */
  compiled: Map<string, Compiled>;
  /** Keep every case directory's scratch output (YAFFLE_CONFORMANCE_KEEP=1), not just failing ones. */
  keepOutput: boolean;
}

/** A compiled schema, or the verdict (skip or fail) for every case of its directory. */
type Compiled = { program: IrProgram } | Verdict;

export const DEFAULT_REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function defaultCaseRoots(repoRoot: string): CaseRoot[] {
  return [{ path: join(repoRoot, "conformance", "cases"), prefix: "" }];
}

const VIEW_SUFFIX = ":view";

/** "ts:view" → "ts". */
function baseTarget(target: string): string {
  return target.endsWith(VIEW_SUFFIX) ? target.slice(0, -VIEW_SUFFIX.length) : target;
}

/** Adds a "<target>:view" entry after every available adapter whose capabilities include views. */
function withViewTargets(adapters: DiscoveredAdapter[]): DiscoveredAdapter[] {
  return adapters.flatMap(a =>
    a.adapter?.capabilities?.views === true && a.unavailable === undefined
      ? [a, { ...a, target: a.target + VIEW_SUFFIX }]
      : [a]
  );
}

export function isNotImplemented(message: string): boolean {
  return /not (yet )?implemented|unimplemented|not supported yet/i.test(message);
}

/** Loads case directories and adapters, and applies the environment's filters. */
export async function planConformance(opts: RunnerOptions = {}): Promise<ConformancePlan> {
  const repoRoot = opts.repoRoot ?? DEFAULT_REPO_ROOT;
  const env = opts.env ?? process.env;
  const targets = parseTargets(env.YAFFLE_CONFORMANCE_TARGETS);
  let adapters =
    opts.adapters ??
    (await discoverAdapters(
      join(repoRoot, "packages", "compiler", "src", "backends"),
      targets?.map(baseTarget)
    ));
  if (env.YAFFLE_CONFORMANCE_VIEWS !== "0") adapters = withViewTargets(adapters);
  // "ts" selects both ts and ts:view; "ts:view" selects only the view target.
  if (targets !== undefined)
    adapters = adapters.filter(
      a => targets.includes(a.target) || targets.includes(baseTarget(a.target))
    );
  return {
    dirs: loadCaseRoots(opts.caseRoots ?? defaultCaseRoots(repoRoot)),
    adapters,
    filter: parseFilter(env.YAFFLE_CONFORMANCE_FILTER),
    workRoot: opts.workRoot ?? join(repoRoot, "conformance", ".out"),
    compile: opts.compile ?? ((await import("yaffle")) as { compile: CompileFn }).compile,
    compiled: new Map(),
    keepOutput: env.YAFFLE_CONFORMANCE_KEEP === "1"
  };
}

/** The cases of a directory selected by the plan's filter. */
export function selectedCases(plan: ConformancePlan, dir: CaseDir): Case[] {
  return dir.cases.filter(c => caseSelected(plan.filter, dir.id, c.name));
}

function formatDiagnostics(errors: CompileOutcome["diagnostics"]): string {
  return errors
    .slice(0, 10)
    .map(d => {
      const at = d.range ? `:${d.range.start.line + 1}:${d.range.start.character + 1}` : "";
      return `${d.path ?? "schema.yfl"}${at}: ${d.code}: ${d.message}`;
    })
    .join("\n");
}

function compileSchema(compile: CompileFn, schema: string): Compiled {
  let out: CompileOutcome;
  try {
    out = compile([schema]);
  } catch (e) {
    const msg = (e as Error).message;
    return isNotImplemented(msg)
      ? { status: "skip", message: `compiler: ${msg}` }
      : { status: "fail", message: `compile() threw: ${(e as Error).stack ?? msg}` };
  }
  if (out.program !== undefined) return { program: out.program };
  const errors = out.diagnostics.filter(d => d.severity === "error");
  const text = formatDiagnostics(errors);
  const unsupported = (d: (typeof errors)[number]) =>
    isNotImplemented(d.message) || /not-implemented|unsupported/.test(d.code);
  if (errors.length > 0 && errors.every(unsupported))
    return { status: "skip", message: `compiler: ${text}` };
  return {
    status: "fail",
    message: `schema does not compile:\n${text || "(no program and no error diagnostics)"}`
  };
}

function compileDir(plan: ConformancePlan, dir: CaseDir): Compiled {
  let compiled = plan.compiled.get(dir.path);
  if (compiled === undefined) {
    compiled = compileSchema(plan.compile, dir.schema);
    plan.compiled.set(dir.path, compiled);
  }
  return compiled;
}

/** Runs one case directory on one adapter. Never throws. */
export async function runDir(
  plan: ConformancePlan,
  dir: CaseDir,
  target: DiscoveredAdapter
): Promise<DirOutcome> {
  const started = Date.now();
  const cases = selectedCases(plan, dir);
  const outcome = (name: string, v: Verdict): CaseOutcome => ({
    target: target.target,
    dir: dir.id,
    name,
    ...v
  });
  const done = (outcomes: CaseOutcome[]): DirOutcome => ({
    target: target.target,
    dir: dir.id,
    cases: outcomes,
    durationMs: Date.now() - started
  });
  const all = (v: Verdict) => done(cases.map(c => outcome(c.name, v)));

  if (dir.problems.length > 0) {
    const v: Verdict = {
      status: "fail",
      message: `invalid case directory:\n${dir.problems.join("\n")}`
    };
    return cases.length > 0 ? all(v) : done([outcome("(case directory)", v)]);
  }
  if (cases.length === 0) return done([]);
  if (target.unavailable !== undefined || target.adapter === undefined)
    return all({ status: "skip", message: target.unavailable ?? "adapter not loaded" });
  const compiled = compileDir(plan, dir);
  if (!("program" in compiled)) return all(compiled);

  const view = target.target.endsWith(VIEW_SUFFIX);
  const workDir = join(
    plan.workRoot,
    target.target.replace(":", "_"),
    dir.id.replace(/[^A-Za-z0-9_.-]+/g, "_")
  );
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  const verdicts = new Map<string, Verdict>();
  const runnable: { original: Case; norm: NormalizedCase }[] = [];
  cases.forEach((c, i) => {
    let norm: NormalizedCase;
    try {
      norm = normalizeCase(c, dir.path, workDir, i);
    } catch (e) {
      verdicts.set(c.name, { status: "fail", message: (e as Error).message });
      return;
    }
    if (view && c.input !== undefined)
      verdicts.set(c.name, {
        status: "skip",
        message: "serialize-only case (not applicable in view mode)"
      });
    else runnable.push({ original: c, norm });
  });

  if (runnable.length > 0) {
    const run = await runAdapter(target.adapter, {
      caseDir: dir.path,
      program: compiled.program,
      cases: runnable.map(r => r.norm.case),
      workDir,
      externs: dir.externs[baseTarget(target.target)] ?? {},
      mode: view ? "view" : "parse"
    });
    if (!("results" in run)) for (const r of runnable) verdicts.set(r.original.name, run);
    else {
      const byName = new Map(run.results.map(r => [r.name, r]));
      for (const { original, norm } of runnable) {
        const res = byName.get(original.name);
        verdicts.set(
          original.name,
          res !== undefined
            ? judgeCase(original, norm, res)
            : { status: "fail", message: "the adapter returned no result for this case" }
        );
      }
    }
  }
  const outcomes = cases.map(c => outcome(c.name, verdicts.get(c.name)!));
  // Scratch output can be large (generated code and build artifacts per target), so a directory's
  // work dir is deleted once all its cases pass. Failures keep theirs for debugging.
  if (!plan.keepOutput && outcomes.every(o => o.status !== "fail"))
    rmSync(workDir, { recursive: true, force: true });
  return done(outcomes);
}

async function runAdapter(
  adapter: ConformanceAdapter,
  input: Parameters<ConformanceAdapter["run"]>[0]
): Promise<{ results: CaseResult[] } | Verdict> {
  try {
    const results = await adapter.run(input);
    if (!Array.isArray(results))
      return { status: "fail", message: "adapter.run did not return an array" };
    return { results };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (isNotImplemented(msg)) return { status: "skip", message: `${adapter.target}: ${msg}` };
    return { status: "fail", message: `adapter.run threw: ${(e as Error).stack ?? msg}` };
  }
}

function describeError(e: NonNullable<CaseResult["error"]>): string {
  const path = e.path && e.path.length > 0 ? ` at ${e.path.join(".")}` : "";
  const off = e.offset !== undefined && e.offset >= 0 ? ` (offset ${e.offset})` : "";
  return `${e.phase} error ${e.code}${path}${off}${e.message ? `: ${e.message}` : ""}`;
}

function samePath(a: (string | number)[], b: (string | number)[]): boolean {
  return a.length === b.length && a.every((x, i) => String(x) === String(b[i]));
}

/** Applies `expect` checks to an actual JSON value. Returns failure messages. */
export function checkExpectations(json: unknown, expect: JsonExpectation[]): string[] {
  const out: string[] = [];
  for (const x of expect) {
    const at = x.pointer === "" ? "(root)" : x.pointer;
    const got = getPointer(json, x.pointer);
    if (!got.found) {
      out.push(`${at}: not found`);
      continue;
    }
    const v = got.value;
    if ("equals" in x) {
      const d = diffJson(x.equals, v);
      if (d.length > 0)
        out.push(formatDifferences(d.map(e => ({ ...e, pointer: x.pointer + e.pointer }))));
    }
    if (x.length !== undefined) {
      const len = Array.isArray(v) || typeof v === "string" ? v.length : undefined;
      if (len !== x.length)
        out.push(`${at}: expected length ${x.length}, got ${len ?? `a ${typeof v}`}`);
    }
    if (x.byteLength !== undefined) {
      if (typeof v !== "string" || !isCanonicalHex(v)) out.push(`${at}: expected a hex string`);
      else if (v.length / 2 !== x.byteLength)
        out.push(`${at}: expected ${x.byteLength} bytes, got ${v.length / 2}`);
    }
    if (x.startsWith !== undefined && (typeof v !== "string" || !v.startsWith(x.startsWith))) {
      out.push(
        `${at}: expected a string starting with ${JSON.stringify(x.startsWith)}, got ${JSON.stringify(typeof v === "string" ? v.slice(0, 40) : v)}`
      );
    }
  }
  return out;
}

/** Problems of an error case: the expected error must be the one raised. */
function errorProblems(expected: NonNullable<Case["error"]>, res: CaseResult): string[] {
  const e = res.error;
  // Without error details, an adapter that says ok checked the error itself: trust it.
  if (e === undefined)
    return !res.ok && (res.json !== undefined || res.bytes !== undefined)
      ? [`expected ${expected.phase} error ${expected.code}, but it succeeded`]
      : [];
  if (e.phase !== expected.phase || e.code !== expected.code)
    return [`expected ${expected.phase} error ${expected.code}, got ${describeError(e)}`];
  if (expected.path !== undefined && !samePath(expected.path, e.path ?? []))
    return [
      `expected the error at [${expected.path.join(", ")}], got [${(e.path ?? []).join(", ")}] (${describeError(e)})`
    ];
  return [];
}

/** Problems of a parse or serialize case that must succeed. */
function successProblems(c: Case, norm: NormalizedCase, res: CaseResult): string[] {
  const problems: string[] = [];
  const bytes = (label: string) => {
    if (res.bytes === undefined || norm.inputHex === undefined) return;
    const d = diffHex(norm.inputHex, res.bytes.toLowerCase());
    if (d) problems.push(`${label}: ${d}`);
  };
  if (res.error !== undefined) problems.push(`unexpected ${describeError(res.error)}`);
  if (c.input !== undefined) {
    bytes("serialize");
    return problems;
  }
  if (c.json !== undefined && res.json !== undefined) {
    const d = diffJson(c.json, res.json);
    if (d.length > 0)
      problems.push(`parse result differs from the expected JSON:\n${formatDifferences(d)}`);
  }
  if (c.expect !== undefined) {
    if (res.json === undefined)
      problems.push("the adapter returned no JSON, so `expect` can't be checked");
    else problems.push(...checkExpectations(res.json, c.expect));
  }
  const rt = c.roundtrip ?? true;
  if (rt !== false && res.error === undefined)
    bytes(
      `round trip (${rt === "value" ? "serialize(parse(bytes))" : "serialize(fromJson(json))"})`
    );
  return problems;
}

/** Judges one adapter result against the case's expectations. */
export function judgeCase(c: Case, norm: NormalizedCase, res: CaseResult): Verdict {
  if (res.skipped !== undefined) return { status: "skip", message: res.skipped };
  const problems =
    c.error !== undefined ? errorProblems(c.error, res) : successProblems(c, norm, res);
  if (!res.ok && problems.length === 0)
    problems.push(res.message ?? "the adapter reported a failure");
  else if (!res.ok && res.message) problems.push(`adapter: ${res.message}`);
  return problems.length === 0
    ? { status: "pass" }
    : { status: "fail", message: problems.join("\n") };
}

/** Runs every selected case directory on every adapter. */
export async function runConformance(
  opts: RunnerOptions = {},
  onDir?: (d: DirOutcome) => void
): Promise<ConformanceReport> {
  return runPlan(await planConformance(opts), onDir);
}

export async function runPlan(
  plan: ConformancePlan,
  onDir?: (d: DirOutcome) => void
): Promise<ConformanceReport> {
  const dirs: DirOutcome[] = [];
  for (const target of plan.adapters) {
    for (const dir of plan.dirs) {
      const out = await runDir(plan, dir, target);
      if (out.cases.length === 0) continue;
      dirs.push(out);
      onDir?.(out);
    }
  }
  return {
    targets: plan.adapters.map(({ target, unavailable }) =>
      unavailable !== undefined ? { target, unavailable } : { target }
    ),
    dirs
  };
}
