/**
 * Conformance adapter for the Go target (docs/CONFORMANCE.md, conformance/src/adapter.ts).
 *
 * `run` generates the case directory's program as package `gen` of a module in `workDir`, writes a
 * harness (`main.go`) that dispatches on the root name, builds it with the Go toolchain (from PATH,
 * $YAFFLE_GO, or `nix shell nixpkgs#go`), runs every case in one process and returns the actual
 * JSON, bytes and errors; the runner re-checks them.
 *
 * Externs come from the run input (`externs`: name → absolute file path with an optional `#ITEM`,
 * or `importpath.Name`). Files become files of the generated package. Extra modules the externs
 * need are listed in the case directory's yaffle.json under `targets.go.dependencies`
 * (`{ "github.com/klauspost/compress": "v1.20.1" }`).
 */
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IrProgram } from "../../ir/index.ts";
import { harnessSource } from "./harness.ts";
import { DEFAULT_RUNTIME, generateGoWithInfo, runtimeDir } from "./index.ts";

// Structural copies of conformance/src/adapter.ts (the compiler package can't import it).
export interface Case {
  name: string;
  root: string;
  args?: Record<string, unknown>;
  bytes?: string | { file: string; offset?: number; length?: number };
  json?: unknown;
  input?: unknown;
  roundtrip?: boolean | "json" | "value";
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
  /** "view": read every case through the generated views (docs/CONFORMANCE.md §7). */
  mode?: "parse" | "view";
}

export interface ConformanceAdapter {
  target: string;
  capabilities?: { views?: boolean };
  available(): Promise<boolean>;
  run(input: AdapterRunInput): Promise<CaseResult[]>;
}

let goPath: string | null | undefined;

/** The `go` binary: $YAFFLE_GO, `go` on PATH, or the one `nix shell nixpkgs#go` provides. */
export function goBinary(): string | null {
  if (goPath !== undefined) return goPath;
  const candidates = [process.env.YAFFLE_GO, "go"].filter((x): x is string => !!x);
  for (const c of candidates) {
    const r = spawnSync(c, ["version"], { encoding: "utf8" });
    if (r.status === 0) return (goPath = c);
  }
  const nix = spawnSync("nix", ["shell", "nixpkgs#go", "--command", "sh", "-c", "command -v go"], {
    encoding: "utf8",
    timeout: 600_000
  });
  if (nix.status === 0 && nix.stdout.trim()) return (goPath = nix.stdout.trim());
  return (goPath = null);
}

/** Environment for go commands: module cache and build cache outside the repository. */
function goEnv(): NodeJS.ProcessEnv {
  const base = process.env.YAFFLE_GO_CACHE ?? join(tmpdir(), "yaffle-go-cache");
  return {
    ...process.env,
    GOPATH: process.env.GOPATH ?? join(base, "gopath"),
    GOCACHE: process.env.GOCACHE ?? join(base, "cache"),
    GOMODCACHE: process.env.GOMODCACHE ?? join(base, "mod"),
    GOTOOLCHAIN: "local",
    GOFLAGS: "-mod=mod",
    GOSUMDB: "off",
    GOWORK: "off",
    CGO_ENABLED: "0"
  };
}

/** Runs a program; resolves with its exit code (1 when it couldn't run) and its output. */
function exec(
  file: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeout: number }
): Promise<{ code: number; out: string }> {
  return new Promise(res => {
    execFile(file, args, { ...opts, maxBuffer: 1 << 28 }, (err, stdout, stderr) => {
      const code = err ? (err as { code?: unknown }).code : 0;
      res({ code: typeof code === "number" ? code : 1, out: `${stdout}${stderr}` });
    });
  });
}

export function runGo(
  args: string[],
  cwd: string,
  timeout = 900_000
): Promise<{ code: number; out: string }> {
  const go = goBinary();
  if (!go) return Promise.reject(new Error("go toolchain not available"));
  return exec(go, args, { cwd, env: goEnv(), timeout });
}

/** `targets.go.dependencies` of a case directory's yaffle.json. */
export function caseDependencies(caseDir: string): Record<string, string> {
  const cfg = join(caseDir, "yaffle.json");
  if (!existsSync(cfg)) return {};
  const json = JSON.parse(readFileSync(cfg, "utf8")) as {
    targets?: { go?: { dependencies?: Record<string, string> } };
  };
  return json.targets?.go?.dependencies ?? {};
}

/** A go.mod requiring the runtime (from this repository) and deps. */
export function goMod(module: string, deps: Record<string, string>): string {
  // Extern dependencies (klauspost/compress) need a newer language version than the runtime.
  const lines = [`module ${module}`, "", `go ${Object.keys(deps).length ? "1.25" : "1.22"}`, ""];
  lines.push("require (");
  lines.push(`\t${DEFAULT_RUNTIME} v0.0.0`);
  for (const [m, v] of Object.entries(deps)) lines.push(`\t${m} ${v}`);
  lines.push(")", "", `replace ${DEFAULT_RUNTIME} => ${runtimeDir()}`, "");
  return lines.join("\n");
}

interface RawResult {
  name: string;
  phase: "parse" | "serialize";
  jsonFile?: string;
  bytes?: string;
  outLen: number;
  equal?: boolean;
  diffAt: number;
  error?: CaseError & { offset: number };
  panic?: string;
  message?: string;
}

function notImplemented(msg: string): boolean {
  return /not implemented|not supported/i.test(msg);
}

/** Judges a raw harness result like the TS adapter does (the runner re-checks). */
function judge(c: Case, raw: RawResult): CaseResult {
  const result: CaseResult = { name: c.name, ok: false };
  if (raw.jsonFile) result.json = JSON.parse(readFileSync(raw.jsonFile, "utf8"));
  if (raw.bytes !== undefined) result.bytes = raw.bytes;
  if (raw.panic) return { ...result, message: `panic in generated code: ${raw.panic}` };
  if (raw.message) return { ...result, message: raw.message };
  if (raw.error) {
    const e = raw.error;
    if (e.code === "INTERNAL") return { ...result, message: `unexpected error: ${e.message}` };
    result.error = {
      phase: e.phase,
      code: e.code,
      path: e.path ?? [],
      offset: e.offset,
      message: e.message ?? ""
    };
    if (!c.error) {
      if (e.message && notImplemented(e.message)) return { ...result, skipped: e.message };
      return { ...result, message: `unexpected ${e.code} error in ${e.phase}: ${e.message ?? ""}` };
    }
    if (c.error.phase !== e.phase)
      return {
        ...result,
        message: `expected a ${c.error.phase} error, got ${e.code} in ${e.phase}: ${e.message ?? ""}`
      };
    if (c.error.code !== e.code)
      return { ...result, message: `expected ${c.error.code}, got ${e.code}: ${e.message ?? ""}` };
    if (c.error.path && JSON.stringify(c.error.path) !== JSON.stringify(e.path))
      return {
        ...result,
        message: `expected path ${JSON.stringify(c.error.path)}, got ${JSON.stringify(e.path)} (${e.message ?? ""})`
      };
    return { ...result, ok: true };
  }
  if (c.error)
    return { ...result, message: `expected ${c.error.code}, but ${raw.phase} succeeded` };
  if (raw.equal === false)
    return {
      ...result,
      message: `${c.input !== undefined ? "serialize" : "roundtrip"}: bytes differ at offset 0x${raw.diffAt.toString(16)} (got ${raw.outLen} bytes)`
    };
  return { ...result, ok: true };
}

export const adapter: ConformanceAdapter = {
  target: "go",
  capabilities: { views: true },
  async available() {
    return goBinary() !== null;
  },
  async run({ caseDir, program, cases, workDir, externs, mode }) {
    let gen;
    const view = mode === "view";
    try {
      gen = generateGoWithInfo(program, {
        externs: externs ?? {},
        targetOptions: { package: "gen", materialize: view }
      });
    } catch (e) {
      const msg = (e as Error).message;
      if (notImplemented(msg)) return cases.map(c => ({ name: c.name, ok: false, skipped: msg }));
      throw e;
    }
    const genDir = join(workDir, "gen");
    mkdirSync(genDir, { recursive: true });
    for (const f of gen.files) writeFileSync(join(genDir, f.path), f.contents);
    writeFileSync(join(workDir, "go.mod"), goMod("yafflecase", caseDependencies(caseDir)));
    writeFileSync(join(workDir, "main.go"), harnessSource(gen.roots, "yafflecase/gen"));
    const build = await runGo(["build", "-o", "harness", "."], workDir);
    if (build.code !== 0) throw new Error(`go build failed:\n${build.out.slice(0, 20000)}`);

    const input = cases.map(c => ({
      name: c.name,
      root: c.root,
      args: c.args ?? {},
      hex: typeof c.bytes === "string" ? c.bytes : undefined,
      file: typeof c.bytes === "object" ? c.bytes.file : undefined,
      json: c.json,
      input: c.input,
      roundtrip: c.roundtrip === false ? "false" : c.roundtrip === "value" ? "value" : "json",
      strict: c.strict ?? false,
      errorPhase: c.error?.phase ?? "",
      mode: view ? "view" : "parse"
    }));
    const outDir = join(workDir, "out");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(workDir, "cases.json"), JSON.stringify(input));
    const run = await exec(join(workDir, "harness"), [join(workDir, "cases.json"), outDir], {
      cwd: workDir,
      timeout: 1_800_000
    });
    if (run.code !== 0) throw new Error(`harness failed:\n${run.out.slice(0, 20000)}`);
    const lines = readFileSync(join(outDir, "results.jsonl"), "utf8").split("\n").filter(Boolean);
    const raws = new Map<string, RawResult>();
    for (const l of lines) {
      const r = JSON.parse(l) as RawResult;
      raws.set(r.name, r);
    }
    return cases.map(c => {
      const raw = raws.get(c.name);
      if (!raw) return { name: c.name, ok: false, message: "the harness returned no result" };
      return judge(c, raw);
    });
  }
};
