/**
 * Conformance adapter for the Rust target (docs/CONFORMANCE.md, conformance/src/adapter.ts).
 *
 * `run` generates a harness crate in `workDir` (the case's program as module `m`, plus a binary
 * that reads operations as JSON on stdin), builds it with cargo (from PATH or through nix), runs
 * every case and returns the actual JSON, bytes and errors; the runner re-checks them.
 *
 * Externs come from the run input (`externs`: name → absolute file path with an optional `#ITEM`,
 * or a Rust path used verbatim). Each file becomes a module of the harness crate; the item is the
 * extern's name or the `#ITEM`. Extra crates a case directory's externs need are listed in its
 * yaffle.json under `targets.rust.dependencies` (`{ "zstd": "0.13" }`).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { IrProgram } from "../../ir/index.ts";
import { buildHarness, runOps, type Op, type OpResult } from "./harness.ts";
import { dependencyLines, externModules } from "./index.ts";
import { BackendError } from "./model.ts";
import { rustPath } from "./toolchain.ts";

/** One entry of cases.json, as the runner normalizes it (structurally `Case` of conformance/src/adapter.ts). */
export interface Case {
  name: string;
  root: string;
  args?: Record<string, unknown>;
  bytes?: string | { file: string };
  json?: unknown;
  input?: unknown;
  roundtrip?: boolean | "json" | "value";
  strict?: boolean;
  error?: { phase: "parse" | "serialize"; code: string; path?: (string | number)[] };
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
  externs: Record<string, string>;
  /** "view": read every case through the lazy view and commit it unedited (CONFORMANCE.md §7). */
  mode?: "parse" | "view";
}

export interface ConformanceAdapter {
  target: string;
  capabilities?: { views?: boolean };
  available(): Promise<boolean>;
  run(input: AdapterRunInput): Promise<CaseResult[]>;
}

/** Canonical-JSON equality: numbers by value, object keys in order-insensitive comparison. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number")
    return a === b || (Number.isNaN(a) && Number.isNaN(b));
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every(
      k =>
        Object.prototype.hasOwnProperty.call(b, k) &&
        jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    );
  }
  return false;
}

/**
 * Extern map of the run input → Rust paths and harness modules. File paths (absolute, or
 * relative to `relativeTo`) become modules `ext_<stem>`; the item is `#ITEM` or the extern name.
 */
export function resolveExterns(
  externs: Record<string, string>,
  relativeTo?: string
): { externs: Record<string, string>; sources: Record<string, string> } {
  const { paths, files } = externModules(externs, "crate", file =>
    isAbsolute(file) ? file : resolve(relativeTo ?? ".", file)
  );
  const sources: Record<string, string> = {};
  for (const [path, mod] of files) sources[mod] = readFileSync(path, "utf8");
  return { externs: paths, sources };
}

/** `targets.rust.dependencies` of a case directory's yaffle.json, as Cargo.toml lines. */
export function caseDependencies(caseDir: string): string[] {
  const cfg = join(caseDir, "yaffle.json");
  if (!existsSync(cfg)) return [];
  const json = JSON.parse(readFileSync(cfg, "utf8")) as {
    targets?: { rust?: { dependencies?: unknown } };
  };
  return dependencyLines(json.targets?.rust?.dependencies);
}

/** The value of a parse operation (`case:*`, `view:*`): the JSON and the round trip. */
interface CaseValue {
  json: unknown;
  rt:
    | null
    | { hex: string }
    | { equal: boolean; firstDiff: number | null; inLen: number; outLen: number }
    | { error: { code: string; path: (string | number)[]; offset: number; message: string } };
}

/** The result of a failed operation, checked against the case's expected error. */
function errorResult(c: Case, r: Extract<OpResult, { ok: false }>, phase: CaseError["phase"]) {
  const error: CaseError = { phase, ...r.error };
  const ok =
    c.error !== undefined &&
    c.error.phase === phase &&
    c.error.code === error.code &&
    (!c.error.path || jsonEqual(c.error.path, error.path));
  const message = `${error.code} at ${JSON.stringify(error.path)}: ${error.message}`;
  return { name: c.name, ok, error, ...(ok ? {} : { message }) };
}

function serializeResult(c: Case, r: OpResult): CaseResult {
  if (!r.ok) return errorResult(c, r, "serialize");
  const bytes = String(r.value);
  const want = typeof c.bytes === "string" ? c.bytes : undefined;
  const ok = c.error === undefined && (want === undefined || want === bytes);
  const message = c.error ? `expected ${c.error.code}, but serialize succeeded` : "bytes differ";
  return { name: c.name, ok, bytes, ...(ok ? {} : { message }) };
}

function parseResult(c: Case, r: OpResult): CaseResult {
  if (!r.ok) return errorResult(c, r, "parse");
  const v = r.value as CaseValue;
  const res: CaseResult = { name: c.name, ok: true, json: v.json };
  const problems: string[] = [];
  if (c.error)
    problems.push(`expected ${c.error.phase} error ${c.error.code}, but parse succeeded`);
  if (c.json !== undefined && !jsonEqual(v.json, c.json)) problems.push("JSON differs");
  if (v.rt && "error" in v.rt) {
    const e = v.rt.error;
    res.error = { phase: "serialize", ...e };
    problems.push(`round trip failed: ${e.code} at ${JSON.stringify(e.path)}: ${e.message}`);
  } else if (v.rt && "hex" in v.rt) {
    res.bytes = v.rt.hex;
    if (typeof c.bytes === "string" && v.rt.hex !== c.bytes)
      problems.push("round trip bytes differ");
  } else if (v.rt && "equal" in v.rt && !v.rt.equal) {
    problems.push(
      `round trip differs at ${v.rt.firstDiff} (input ${v.rt.inLen} bytes, output ${v.rt.outLen})`
    );
  }
  if (problems.length > 0) {
    res.ok = false;
    res.message = problems.join("; ");
  }
  return res;
}

export const adapter: ConformanceAdapter = {
  target: "rust",
  capabilities: { views: true },

  async available() {
    try {
      return (await rustPath()) !== undefined;
    } catch {
      return false;
    }
  },

  async run({ caseDir, program, cases, workDir, externs, mode }) {
    const views = mode === "view";
    const { externs: ext, sources } = resolveExterns(externs, caseDir);
    const crateName =
      "yaffle_conf_" +
      createHash("sha1").update(resolve(caseDir)).digest("hex").slice(0, 12) +
      (views ? "_v" : "");
    let built;
    try {
      built = await buildHarness({
        dir: join(workDir, "rust-harness"),
        crateName,
        modules: [{ name: "m", program, externs: ext, views }],
        sources,
        extraDeps: caseDependencies(caseDir)
      });
    } catch (e) {
      // Constructs the Rust backend doesn't support: skip the directory.
      if (e instanceof BackendError)
        throw new Error(`not implemented in the Rust backend: ${e.message}`, { cause: e });
      throw e;
    }
    if (!built.ok) throw new Error(`cargo build failed:\n${built.log.slice(0, 6000)}`);

    const ops = cases.map((c): Op => {
      const base = {
        module: "m",
        root: c.root,
        ...(c.args ? { args: c.args } : {}),
        ...(c.strict ? { strict: true } : {})
      };
      if (isSerialize(c)) return { op: "serialize", ...base, json: c.input ?? c.json };
      const rt =
        c.error || c.roundtrip === false ? "none" : c.roundtrip === "value" ? "value" : "json";
      const op = views ? (rt === "none" ? "view:none" : "view:rt") : (`case:${rt}` as const);
      return { op, ...base, ...(c.bytes !== undefined ? { bytes: c.bytes } : {}) };
    });
    const results = await runOps(built.bin, ops);
    return cases.map((c, i): CaseResult => {
      const r = results[i];
      if (!r) return { name: c.name, ok: false, message: "no result from the harness" };
      return isSerialize(c) ? serializeResult(c, r) : parseResult(c, r);
    });
  }
};

/** A case that serializes its input (or expects a serialize error). */
function isSerialize(c: Case): boolean {
  return c.error?.phase === "serialize" || (c.error === undefined && c.input !== undefined);
}
