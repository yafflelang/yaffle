/**
 * Finding a Python interpreter (3.12+) for the conformance adapter and tests: `$YAFFLE_PYTHON`,
 * a cached path, `python3` on PATH, or `nix shell nixpkgs#python3` (resolved once and cached).
 * Caches live outside the repository: `$YAFFLE_PYTHON_CACHE`, default `<tmpdir>/yaffle-python-cache`.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function cacheDir(): string {
  const dir = process.env.YAFFLE_PYTHON_CACHE ?? join(tmpdir(), "yaffle-python-cache");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const PROBE = "import sys; print(sys.executable); print(1 if sys.version_info >= (3, 12) else 0)";

/** The interpreter path `cmd args… -c PROBE` reports, if it is Python 3.12+. */
function probe(cmd: string, args: string[]): string | undefined {
  try {
    const out = execFileSync(cmd, [...args, "-c", PROBE], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 600_000
    });
    const [exe, ok] = out.trim().split(/\r?\n/);
    return ok === "1" && exe ? exe : undefined;
  } catch {
    return undefined;
  }
}

let resolved: string | null | undefined;

/** Absolute path of a Python 3.12+ interpreter, or undefined if none can be found. */
export function findPython(): string | undefined {
  if (resolved === undefined) resolved = resolvePython() ?? null;
  return resolved ?? undefined;
}

function resolvePython(): string | undefined {
  const env = process.env.YAFFLE_PYTHON;
  if (env) return probe(env, []);
  const cacheFile = join(cacheDir(), "python-path");
  if (existsSync(cacheFile)) {
    const p = readFileSync(cacheFile, "utf8").trim();
    if (p && existsSync(p)) return p;
  }
  const exe =
    probe("python3", []) ?? probe("nix", ["shell", "nixpkgs#python3", "--command", "python3"]);
  if (exe) writeFileSync(cacheFile, exe + "\n");
  return exe;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs Python with the given arguments and extra PYTHONPATH entries (bytecode cached outside). */
export function runPython(
  args: string[],
  opts: { pythonPath: string[]; cwd?: string }
): Promise<RunResult> {
  const python = findPython();
  if (!python) return Promise.reject(new Error("python 3.12+ not available"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONPATH: [...opts.pythonPath, process.env.PYTHONPATH ?? ""].filter(Boolean).join(":"),
    PYTHONPYCACHEPREFIX: join(cacheDir(), "pycache"),
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1"
  };
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    // Output beyond 1 MiB is dropped (results go through files).
    child.stdout.on("data", d => {
      if (stdout.length < 1 << 20) stdout += String(d);
    });
    child.stderr.on("data", d => {
      if (stderr.length < 1 << 20) stderr += String(d);
    });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}
