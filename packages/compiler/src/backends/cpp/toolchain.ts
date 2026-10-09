/**
 * C++ toolchain helpers for tests and the conformance adapter: compiler lookup, a cached build of
 * the runtime (static archive), library lookup through nix, and cached builds of generated code.
 *
 * Everything is built under `$YAFFLE_CPP_CACHE` (default `<tmpdir>/yaffle-cpp-cache`), keyed by
 * content hashes, so unchanged sources are never recompiled.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimeDir } from "./index.ts";

export interface Toolchain {
  cxx: string;
  version: string;
}

export interface Libraries {
  includeDirs: string[];
  libDirs: string[];
  libs: string[];
}

export const CXX_FLAGS = ["-std=c++20", "-Wall", "-Wextra", "-Werror"];

export function cacheDir(): string {
  const dir = process.env.YAFFLE_CPP_CACHE ?? join(tmpdir(), "yaffle-cpp-cache");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeout ?? 600_000, maxBuffer: 64 << 20 },
      (err, stdout, stderr) => {
        if (err)
          reject(new Error(`${cmd} ${args.join(" ")} failed:\n${stderr || stdout || err.message}`));
        else resolve({ stdout, stderr });
      }
    );
  });
}

let toolchainPromise: Promise<Toolchain | undefined> | undefined;

/** The C++ compiler ($CXX or g++), if it works. */
export function findToolchain(): Promise<Toolchain | undefined> {
  toolchainPromise ??= (async () => {
    const cxx = process.env.CXX ?? "g++";
    try {
      const { stdout } = await runCommand(cxx, ["--version"], { timeout: 30_000 });
      return { cxx, version: stdout.split("\n")[0] ?? "" };
    } catch {
      return undefined;
    }
  })();
  return toolchainPromise;
}

function sha(parts: (string | Buffer)[]): string {
  const h = createHash("sha256");
  for (const p of parts) {
    h.update(p);
    h.update("\0");
  }
  return h.digest("hex").slice(0, 20);
}

/** Atomically writes a file (concurrent builders never see partial outputs). */
function writeAtomic(path: string, data: string | Buffer): void {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function runtimeSources(): { includeDir: string; sources: string[]; hash: string } {
  const root = runtimeDir();
  const includeDir = join(root, "include");
  const hdrs = readdirSync(join(includeDir, "yaffle"))
    .filter(f => f.endsWith(".hpp"))
    .sort();
  const srcs = readdirSync(join(root, "src"))
    .filter(f => f.endsWith(".cpp"))
    .sort();
  const parts: string[] = [];
  for (const f of hdrs) parts.push(f, readFileSync(join(includeDir, "yaffle", f), "utf8"));
  for (const f of srcs) parts.push(f, readFileSync(join(root, "src", f), "utf8"));
  return { includeDir, sources: srcs.map(f => join(root, "src", f)), hash: sha(parts) };
}

const archives = new Map<string, Promise<string>>();

/** Builds (once per content hash) the runtime as a static archive; returns its path. */
export function runtimeArchive(tc: Toolchain, opt: string): Promise<string> {
  const rt = runtimeSources();
  const key = sha([tc.version, opt, ...CXX_FLAGS, rt.hash]);
  let p = archives.get(key);
  if (!p) {
    p = (async () => {
      const dir = join(cacheDir(), `runtime-${key}`);
      const lib = join(dir, "libyaffle.a");
      if (existsSync(lib)) return lib;
      mkdirSync(dir, { recursive: true });
      const objs = await Promise.all(
        rt.sources.map(async src => {
          const base = src
            .split("/")
            .pop()!
            .replace(/\.cpp$/, "");
          const obj = join(dir, `${base}.${process.pid}.o`);
          await runCommand(tc.cxx, [...CXX_FLAGS, opt, "-I", rt.includeDir, "-c", src, "-o", obj]);
          return obj;
        })
      );
      const tmp = join(dir, `libyaffle.${process.pid}.a`);
      await runCommand("ar", ["rcs", tmp, ...objs]);
      renameSync(tmp, lib);
      return lib;
    })();
    archives.set(key, p);
    p.catch(() => archives.delete(key));
  }
  return p;
}

const nixCache = new Map<string, Promise<Libraries>>();

/**
 * Header and library directories of nix packages (`nix-build '<nixpkgs>' -A pkg.dev -A pkg.out`),
 * cached in the build cache. Without nix, the system's default paths are used.
 */
export function nixPackages(pkgs: string[]): Promise<Libraries> {
  const key = [...pkgs].sort().join(",");
  let p = nixCache.get(key);
  if (!p) {
    p = (async () => {
      const out: Libraries = { includeDirs: [], libDirs: [], libs: [] };
      if (!pkgs.length) return out;
      const file = join(cacheDir(), `nix-${sha([key])}.json`);
      if (existsSync(file)) {
        const cached = JSON.parse(readFileSync(file, "utf8")) as Libraries;
        if (cached.includeDirs.every(d => existsSync(d))) return cached;
      }
      for (const pkg of pkgs) {
        // Packages with split outputs first; without nix (or the package) the system paths apply.
        let paths: string[] = [];
        for (const attrs of [[`${pkg}.dev`, `${pkg}.out`], [pkg]]) {
          try {
            const args = ["<nixpkgs>", "--no-out-link", ...attrs.flatMap(a => ["-A", a])];
            const { stdout } = await runCommand("nix-build", args, { timeout: 600_000 });
            paths = stdout.split("\n").filter(Boolean);
            break;
          } catch {
            // try the next form
          }
        }
        for (const p of paths) {
          if (existsSync(join(p, "include"))) out.includeDirs.push(join(p, "include"));
          if (existsSync(join(p, "lib"))) out.libDirs.push(join(p, "lib"));
        }
      }
      writeAtomic(file, JSON.stringify(out));
      return out;
    })();
    nixCache.set(key, p);
  }
  return p;
}

export interface BuildInput {
  tc: Toolchain;
  /** Directory holding the sources (and `-I` for generated headers). */
  dir: string;
  /** Source files (relative to `dir`) to compile and link. */
  sources: string[];
  /** Extra files whose contents affect the build (included headers outside `dir`). */
  deps: string[];
  libs: Libraries;
  opt?: string;
}

/** Compiles and links sources into an executable (cached by content); returns its path. */
export async function buildExecutable(input: BuildInput): Promise<string> {
  const opt = input.opt ?? "-O1";
  const archive = await runtimeArchive(input.tc, opt);
  const parts: (string | Buffer)[] = [
    input.tc.version,
    opt,
    ...CXX_FLAGS,
    archive,
    JSON.stringify(input.libs)
  ];
  for (const s of input.sources) parts.push(s, readFileSync(join(input.dir, s)));
  for (const h of readdirSync(input.dir)
    .filter(f => /\.(hpp|h)$/.test(f))
    .sort())
    parts.push(h, readFileSync(join(input.dir, h)));
  for (const d of input.deps) parts.push(d, existsSync(d) ? readFileSync(d) : "");
  const key = sha(parts);
  const binDir = join(cacheDir(), "bin");
  mkdirSync(binDir, { recursive: true });
  const exe = join(binDir, `prog-${key}`);
  if (existsSync(exe)) return exe;
  const objDir = join(cacheDir(), "obj", key);
  mkdirSync(objDir, { recursive: true });
  const inc = [
    "-I",
    join(runtimeDir(), "include"),
    "-I",
    input.dir,
    ...input.libs.includeDirs.flatMap(d => ["-isystem", d])
  ];
  const objs = await Promise.all(
    input.sources.map(async s => {
      const obj = join(objDir, `${s.replace(/[^A-Za-z0-9_.-]/g, "_")}.o`);
      await runCommand(
        input.tc.cxx,
        [...CXX_FLAGS, opt, ...inc, "-c", join(input.dir, s), "-o", obj],
        {
          timeout: 1_200_000
        }
      );
      return obj;
    })
  );
  const tmp = `${exe}.${process.pid}.tmp`;
  const libArgs = [
    ...input.libs.libDirs.flatMap(d => ["-L", d, `-Wl,-rpath,${d}`]),
    ...input.libs.libs.map(l => `-l${l}`)
  ];
  await runCommand(input.tc.cxx, [...objs, archive, ...libArgs, "-o", tmp]);
  renameSync(tmp, exe);
  return exe;
}
