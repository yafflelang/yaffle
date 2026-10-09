/** Finding and running cargo: from PATH, or through `nix shell nixpkgs#cargo nixpkgs#rustc`. */
import { execFile, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CargoResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[]): Promise<CargoResult> {
  return new Promise(resolve => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

let cachedPath: Promise<string | undefined> | undefined;

/** A PATH under which `cargo` and `rustc` run, or undefined if there is none (cached). */
export function rustPath(): Promise<string | undefined> {
  cachedPath ??= (async () => {
    const direct = await run("cargo", ["--version"]);
    if (direct.code === 0) return process.env["PATH"] ?? "";
    const nix = await run("nix", [
      "shell",
      "nixpkgs#cargo",
      "nixpkgs#rustc",
      "--command",
      "sh",
      "-c",
      'cargo --version >/dev/null && printf %s "$PATH"'
    ]);
    if (nix.code === 0 && nix.stdout.trim()) return nix.stdout.trim();
    return undefined;
  })();
  return cachedPath;
}

/** The shared cargo target directory (kept outside repositories so builds are reused). */
export function cargoTargetDir(): string {
  const dir = process.env["CARGO_TARGET_DIR"] ?? join(tmpdir(), "yaffle-cargo-target");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Runs cargo in a crate directory. */
export async function cargo(cwd: string, args: string[]): Promise<CargoResult> {
  const path = await rustPath();
  if (path === undefined)
    throw new Error("cargo is not available (neither on PATH nor through nix)");
  const env = {
    ...process.env,
    PATH: path,
    CARGO_TARGET_DIR: cargoTargetDir(),
    CARGO_TERM_COLOR: "never"
  };
  return new Promise((resolve, reject) => {
    const child = spawn("cargo", args, { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    child.on("error", reject);
    child.on("close", code => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end();
  });
}

/**
 * Runs an executable with `input` on stdin and splits its stdout into lines (collected as
 * buffers, so huge outputs work).
 */
export function runBinaryLines(
  bin: string,
  input: string
): Promise<{ code: number; lines: string[]; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, []);
    const lines: string[] = [];
    let pending: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      let start = 0;
      for (let i = d.indexOf(10); i >= 0; i = d.indexOf(10, start)) {
        pending.push(d.subarray(start, i));
        lines.push(Buffer.concat(pending).toString("utf8"));
        pending = [];
        start = i + 1;
      }
      if (start < d.length) pending.push(d.subarray(start));
    });
    child.stderr.on("data", d => (stderr += d));
    child.on("error", reject);
    child.on("close", code => {
      if (pending.length > 0) lines.push(Buffer.concat(pending).toString("utf8"));
      resolve({ code: code ?? 1, lines, stderr });
    });
    child.stdin.end(input);
  });
}
