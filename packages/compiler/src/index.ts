/**
 * Public API of the yaffle compiler: the contract used by the CLI, the language server and the
 * conformance runner.
 */
import { existsSync, globSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname as pathDirname, isAbsolute, join, resolve } from "node:path";
import type { IrProgram } from "./ir/index.ts";
import type { Diagnostic, ProjectConfig } from "./service/api.ts";
import { backends as defaultBackends } from "./backends/index.ts";
import type { Backend, GeneratedFile } from "./backends/index.ts";
import { makeDiag, sortDiagnostics, toApiDiagnostic } from "./frontend/diagnostics.ts";
import { runFrontend, type FrontendOptions } from "./frontend/program.ts";
import { SourceFile } from "./frontend/source.ts";
import { normalizePath } from "./frontend/util.ts";

export type * from "./ir/index.ts";
export type { Diagnostic, ProjectConfig } from "./service/api.ts";
export { backends } from "./backends/index.ts";
export type { Backend, BackendOptions, GeneratedFile } from "./backends/index.ts";
export { createLanguageService } from "./service/index.ts";
export { validateIr } from "./ir/validate.ts";

export interface CompilerHost {
  readFile(path: string): string | undefined;
  fileExists(path: string): boolean;
}

export interface CompileResult {
  /** Present when there are no error diagnostics. */
  program?: IrProgram;
  diagnostics: Diagnostic[];
}

export interface CompileOptions {
  /** Directory that IR module paths are relative to (default: the project root or the entries' common directory). */
  rootDir?: string;
  /** yaffle.json targets: enables extern-implementation checks. */
  targets?: ProjectConfig["targets"];
}

/** The real filesystem. */
export const nodeHost: CompilerHost = {
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  fileExists(path) {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  }
};

/** Compile entry files (absolute paths) and everything they import. Defaults to the real filesystem. */
export function compile(
  entryFiles: string[],
  host: CompilerHost = nodeHost,
  options: CompileOptions = {}
): CompileResult {
  const fo: FrontendOptions = {};
  if (options.rootDir) fo.rootDir = options.rootDir;
  if (options.targets) fo.targets = options.targets;
  const r = runFrontend(
    entryFiles.map(p => normalizePath(isAbsolute(p) ? p : resolve(p))),
    host,
    fo
  );
  const diagnostics = sortDiagnostics(r.diagnostics.map(toApiDiagnostic));
  const out: CompileResult = { diagnostics };
  if (r.program && !r.hasErrors) out.program = r.program;
  return out;
}

/** Convenience for tests: compile one in-memory source. Imports are resolved relative to `path` through `host`. */
export function compileSource(
  source: string,
  path = "/memory/main.yfl",
  host?: CompilerHost,
  options: CompileOptions = {}
): CompileResult {
  const p = normalizePath(path);
  const overlay: CompilerHost = {
    readFile: f => (f === p ? source : host?.readFile(f)),
    fileExists: f => f === p || (host?.fileExists(f) ?? false)
  };
  return compile([p], overlay, options);
}

/** Read and validate a yaffle.json. */
export function loadProjectConfig(
  path: string,
  host: CompilerHost = nodeHost
): { config?: ProjectConfig; diagnostics: Diagnostic[] } {
  const text = host.readFile(path);
  const file = new SourceFile(path, text ?? "");
  const diags: Diagnostic[] = [];
  const err = (message: string, at?: number) => {
    const span = at === undefined ? { start: 0, end: 0 } : { start: at, end: at };
    diags.push(toApiDiagnostic(makeDiag(file, span, "config-error", message)));
  };
  if (text === undefined) {
    err(`Can't read ${path}.`);
    return { diagnostics: diags };
  }
  let json: unknown;
  try {
    json = JSON.parse(stripJsonComments(text));
  } catch (e) {
    const m = /position (\d+)/.exec((e as Error).message);
    err(`Invalid JSON: ${(e as Error).message}`, m ? Number(m[1]) : undefined);
    return { diagnostics: diags };
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    err("yaffle.json must contain an object.");
    return { diagnostics: diags };
  }
  const o = json as Record<string, unknown>;
  const config: ProjectConfig = { sources: [], targets: {} };
  if (o.sources === undefined) config.sources = ["**/*.yfl"];
  else if (!Array.isArray(o.sources) || !o.sources.every(s => typeof s === "string"))
    err('"sources" must be an array of glob strings.', text.indexOf('"sources"'));
  else config.sources = o.sources as string[];
  if (o.targets !== undefined) {
    if (!o.targets || typeof o.targets !== "object" || Array.isArray(o.targets))
      err('"targets" must be an object.', text.indexOf('"targets"'));
    else {
      for (const [name, t] of Object.entries(o.targets as Record<string, unknown>)) {
        if (!t || typeof t !== "object" || Array.isArray(t)) {
          err(`targets.${name} must be an object.`, text.indexOf(`"${name}"`));
          continue;
        }
        const tt = t as Record<string, unknown>;
        if (typeof tt.out !== "string")
          err(
            `targets.${name}.out must be a string (the output directory).`,
            text.indexOf(`"${name}"`)
          );
        if (
          tt.externs !== undefined &&
          (!tt.externs ||
            typeof tt.externs !== "object" ||
            Array.isArray(tt.externs) ||
            !Object.values(tt.externs).every(v => typeof v === "string"))
        ) {
          err(
            `targets.${name}.externs must map extern names to module paths.`,
            text.indexOf('"externs"')
          );
        }
        config.targets[name] = {
          ...(tt as object),
          out: typeof tt.out === "string" ? tt.out : ""
        } as ProjectConfig["targets"][string];
      }
    }
  }
  for (const k of Object.keys(o)) {
    if (k !== "sources" && k !== "targets" && k !== "$schema")
      err(`Unknown key "${k}" in yaffle.json.`, text.indexOf(`"${k}"`));
  }
  if (diags.length) return { diagnostics: diags };
  return { config, diagnostics: diags };
}

function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (; i < stop; i++) out += text[i] === "\n" ? "\n" : " ";
      continue;
    }
    out += c;
    i++;
  }
  // trailing commas
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** The source files of a project: its `sources` globs, relative to the directory of yaffle.json. */
export function projectSources(config: ProjectConfig, rootDir: string): string[] {
  const out = new Set<string>();
  for (const pattern of config.sources) {
    for (const f of globSync(pattern, { cwd: rootDir })) {
      const abs = normalizePath(join(rootDir, f));
      if (abs.endsWith(".yfl")) out.add(abs);
    }
  }
  return [...out].sort();
}

export interface Project {
  config: ProjectConfig;
  /** Directory of yaffle.json. */
  rootDir: string;
}

export interface BuildResult {
  diagnostics: Diagnostic[];
  program?: IrProgram;
  /** Files written per target (paths relative to the target's output directory). */
  outputs: { target: string; outDir: string; files: GeneratedFile[] }[];
}

export interface BuildOptions {
  host?: CompilerHost;
  /** Backends to use (default: the registry in backends/index.ts). */
  backends?: Record<string, Backend>;
  /** Don't write files, just return them. */
  dryRun?: boolean;
  /** Source files to compile instead of the project's globs. */
  entries?: string[];
}

/**
 * Compiles a project and runs its backends. `target` restricts to one target (which must exist in
 * the registry; it doesn't need to be in yaffle.json if `outDir` is given). `outDir` overrides the
 * target's output directory.
 */
export function build(
  project: Project,
  target?: string,
  outDir?: string,
  options: BuildOptions = {}
): BuildResult {
  const host = options.host ?? nodeHost;
  const registry = options.backends ?? defaultBackends;
  const entries = options.entries ?? projectSources(project.config, project.rootDir);
  const diagnostics: Diagnostic[] = [];
  const configError = (message: string) =>
    diagnostics.push(
      toApiDiagnostic(
        makeDiag(
          new SourceFile(join(project.rootDir, "yaffle.json"), ""),
          { start: 0, end: 0 },
          "config-error",
          message
        )
      )
    );
  const targets = target ? [target] : Object.keys(project.config.targets);
  const configTargets: CompileOptions["targets"] = {};
  for (const t of targets) {
    const cfg = project.config.targets[t];
    configTargets[t] = cfg ?? { out: outDir ?? "" };
  }
  const result = compile(entries, host, { rootDir: project.rootDir, targets: configTargets });
  diagnostics.push(...result.diagnostics);
  const out: BuildResult = { diagnostics, outputs: [] };
  if (!result.program) return out;
  out.program = result.program;
  for (const t of targets) {
    const backend = registry[t];
    const cfg = project.config.targets[t];
    if (!backend) {
      configError(
        `Unknown target '${t}'. Available: ${Object.keys(registry).join(", ") || "none"}.`
      );
      continue;
    }
    const dir = outDir ?? (cfg?.out ? resolve(project.rootDir, cfg.out) : undefined);
    if (!dir) {
      configError(`Target '${t}' has no output directory: set targets.${t}.out or pass --out.`);
      continue;
    }
    const externs: Record<string, string> = {};
    for (const [name, mod] of Object.entries(cfg?.externs ?? {})) {
      // module paths in yaffle.json are relative to the project; backends get them relative to the output directory
      externs[name] = mod.startsWith(".")
        ? relativeModule(dir, resolve(project.rootDir, mod))
        : mod;
    }
    const { out: _out, externs: _externs, ...targetOptions } = cfg ?? { out: "" };
    let files: GeneratedFile[];
    try {
      files = backend.generate(result.program, { externs, targetOptions });
    } catch (e) {
      configError(`Backend '${t}' failed: ${(e as Error).message}`);
      continue;
    }
    if (!options.dryRun) {
      for (const f of files) {
        const p = join(dir, f.path);
        mkdirSync(pathDirname(p), { recursive: true });
        writeFileSync(p, f.contents);
      }
    }
    out.outputs.push({ target: t, outDir: dir, files });
  }
  return out;
}

/** A module specifier for `to` relative to `fromDir` (always starting with `.`). */
function relativeModule(fromDir: string, to: string): string {
  const a = normalizePath(fromDir).split("/").filter(Boolean);
  const b = normalizePath(to).split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const rel = [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
  return rel.startsWith(".") ? rel : "./" + rel;
}

/** Finds yaffle.json in `dir` or its ancestors. */
export function findProjectConfig(dir: string): string | undefined {
  let d = resolve(dir);
  for (;;) {
    const p = join(d, "yaffle.json");
    if (existsSync(p)) return p;
    const parent = pathDirname(d);
    if (parent === d) return undefined;
    d = parent;
  }
}
