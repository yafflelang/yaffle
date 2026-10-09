/**
 * The JDK for the Java target's tests and conformance adapter: finding javac 21+, compiling the
 * runtime once per source hash, downloading Maven jars, writing and compiling generated sources.
 * Everything is cached in `$YAFFLE_JAVA_CACHE` (default `$TMPDIR/yaffle-java-cache`).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GeneratedFile } from "../backend.ts";
import { runtimeSourceDir } from "./index.ts";

export interface Jdk {
  javac: string;
  java: string;
}

let jdkCache: Jdk | null | undefined;

/** Cache of the compiled runtime, downloaded jars and the JDK's location. */
export function cacheDir(): string {
  return process.env.YAFFLE_JAVA_CACHE ?? join(tmpdir(), "yaffle-java-cache");
}

/** The JDK whose binaries are in `dir`, if its javac is version 21 or later. */
function jdkIn(dir: string): Jdk | undefined {
  const javac = join(dir, "javac");
  if (!existsSync(javac)) return undefined;
  const r = spawnSync(javac, ["-version"], { encoding: "utf8" });
  const m = /javac (\d+)/.exec(`${r.stdout}${r.stderr}`);
  return r.status === 0 && m && Number(m[1]) >= 21 ? { javac, java: join(dir, "java") } : undefined;
}

/** Finds a JDK 21+: JAVA_HOME, PATH, the cached location, or `nix shell nixpkgs#jdk21`. */
export function findJdk(): Jdk | undefined {
  if (jdkCache !== undefined) return jdkCache ?? undefined;
  const dirs: string[] = [];
  if (process.env.JAVA_HOME) dirs.push(join(process.env.JAVA_HOME, "bin"));
  dirs.push(...(process.env.PATH ?? "").split(":").filter(Boolean));
  const cacheFile = join(cacheDir(), "jdk-path");
  if (existsSync(cacheFile)) dirs.push(readFileSync(cacheFile, "utf8").trim());
  for (const dir of dirs) {
    const jdk = jdkIn(dir);
    if (jdk) return (jdkCache = jdk);
  }
  const r = spawnSync(
    "nix",
    ["shell", "nixpkgs#jdk21", "--command", "sh", "-c", "command -v javac"],
    { encoding: "utf8", timeout: 600_000 }
  );
  const javac = r.status === 0 ? r.stdout.trim() : "";
  if (javac && existsSync(javac)) {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(cacheFile, dirname(javac));
    return (jdkCache = { javac, java: join(dirname(javac), "java") });
  }
  jdkCache = null;
  return undefined;
}

/** Writes generated files under `dir` (cleared first); returns their paths. */
export function writeSources(dir: string, files: readonly GeneratedFile[]): string[] {
  rmSync(dir, { recursive: true, force: true });
  return files.map(f => {
    const p = join(dir, f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.contents);
    return p;
  });
}

/**
 * Compiles `sources` into `classes` with `-Xlint:all -Werror` (warnings fail). The source list
 * goes through an argument file, so large schemas don't hit the command line limit.
 */
export function javac(
  jdk: Jdk,
  sources: readonly string[],
  classes: string,
  classpath: readonly string[] = []
): { ok: boolean; output: string } {
  rmSync(classes, { recursive: true, force: true });
  mkdirSync(classes, { recursive: true });
  const list = `${classes}-sources.txt`;
  writeFileSync(list, sources.join("\n") + "\n");
  const cp = classpath.length ? ["-cp", classpath.join(":")] : [];
  const r = spawnSync(jdk.javac, ["-Xlint:all", "-Werror", ...cp, "-d", classes, `@${list}`], {
    encoding: "utf8",
    maxBuffer: 64 << 20
  });
  return { ok: r.status === 0, output: `${r.stdout}${r.stderr}`.trim() };
}

/** Compiles the runtime once (keyed by a hash of its sources); returns its classes directory. */
export function runtimeClasses(jdk: Jdk): string {
  const src = runtimeSourceDir();
  const files = readdirSync(src)
    .filter(f => f.endsWith(".java"))
    .sort()
    .map(f => join(src, f));
  const h = createHash("sha256");
  for (const f of files) h.update(f).update(readFileSync(f));
  const dir = join(cacheDir(), `runtime-${h.digest("hex").slice(0, 16)}`);
  if (existsSync(join(dir, "ok"))) return dir;
  // Compiled aside and renamed, so concurrent runs never see a partial directory.
  const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
  const r = javac(jdk, files, join(tmp, "classes"));
  if (!r.ok) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`compiling the Java runtime failed:\n${r.output}`);
  }
  writeFileSync(join(tmp, "classes", "ok"), "");
  try {
    renameSync(join(tmp, "classes"), dir);
  } catch {
    // Another run finished first.
  }
  rmSync(tmp, { recursive: true, force: true });
  return dir;
}

/** Downloads Maven jars (`group:artifact` → version) into the cache; returns their paths. */
export async function dependencyJars(deps: Record<string, string>): Promise<string[]> {
  const out: string[] = [];
  for (const [coord, version] of Object.entries(deps)) {
    const [group, artifact] = coord.split(":");
    if (!group || !artifact) throw new Error(`bad Java dependency ${coord}`);
    const file = join(cacheDir(), "jars", `${group}.${artifact}-${version}.jar`);
    if (!existsSync(file)) {
      const url = `https://repo1.maven.org/maven2/${group.replace(/\./g, "/")}/${artifact}/${version}/${artifact}-${version}.jar`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`downloading ${url} failed: ${res.status}`);
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, new Uint8Array(await res.arrayBuffer()));
      renameSync(tmp, file);
    }
    out.push(file);
  }
  return out;
}
