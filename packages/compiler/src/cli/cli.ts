/**
 * The yaffle command line: check, build, ir, fmt. `runCli` is pure enough to test: it takes the
 * arguments, an output sink and a working directory, and returns the exit code.
 */
import { existsSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  build,
  compile,
  findProjectConfig,
  loadProjectConfig,
  nodeHost,
  projectSources,
  type CompilerHost
} from "../index.ts";
import type { Backend } from "../backends/index.ts";
import { irToText } from "../frontend/irtext.ts";
import { formatSource } from "../frontend/format.ts";
import type { Diagnostic, ProjectConfig } from "../service/api.ts";

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  cwd: string;
  color: boolean;
  host?: CompilerHost;
  backends?: Record<string, Backend>;
}

const VERSION = "0.1.0";

const HELP = `yaffle ${VERSION}: Yet Another File-Format Language & Engine

Usage:
  yaffle check [files…] [--project yaffle.json]     check sources (default: the project's)
  yaffle build [--project yaffle.json] [--target ts] [--out dir]
                                                    compile and generate code
  yaffle ir <file> [--pretty | --text]              print the IR (JSON, indented JSON, or text)
  yaffle fmt [files…] [--check] [--stdout]          format sources in place (--check: only report)

Options:
  --project <path>   yaffle.json to use (default: found from the current directory upwards)
  --no-color         plain output
  -h, --help         this help
  --version          print the version

Exit codes: 0 ok, 1 errors in the sources (or files to format with --check), 2 usage errors.
`;

interface Parsed {
  command?: string;
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(args: string[]): Parsed {
  const out: Parsed = { positional: [], flags: new Map() };
  const withValue = new Set(["--project", "--target", "--out", "-p", "-t", "-o"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("-")) {
      const eq = a.indexOf("=");
      if (eq > 0) out.flags.set(a.slice(0, eq), a.slice(eq + 1));
      else if (withValue.has(a)) out.flags.set(a, args[++i] ?? "");
      else out.flags.set(a, true);
    } else if (!out.command) out.command = a;
    else out.positional.push(a);
  }
  return out;
}

function flag(p: Parsed, ...names: string[]): string | true | undefined {
  for (const n of names) {
    const v = p.flags.get(n);
    if (v !== undefined) return v;
  }
  return undefined;
}

export function runCli(args: string[], io: CliIo): number {
  const p = parseArgs(args);
  if (p.flags.has("--no-color")) io = { ...io, color: false };
  if (p.flags.has("--version")) {
    io.stdout(`yaffle ${VERSION}\n`);
    return 0;
  }
  if (!p.command || p.flags.has("-h") || p.flags.has("--help") || p.command === "help") {
    io.stdout(HELP);
    return p.command || p.flags.has("-h") || p.flags.has("--help") ? 0 : 2;
  }
  try {
    switch (p.command) {
      case "check":
        return cmdCheck(p, io);
      case "build":
        return cmdBuild(p, io);
      case "ir":
        return cmdIr(p, io);
      case "fmt":
      case "format":
        return cmdFmt(p, io);
      default:
        io.stderr(`yaffle: unknown command '${p.command}'. Run 'yaffle --help'.\n`);
        return 2;
    }
  } catch (e) {
    io.stderr(`yaffle: internal error: ${(e as Error).stack ?? String(e)}\n`);
    return 70;
  }
}

function host(io: CliIo): CompilerHost {
  return io.host ?? nodeHost;
}

function abs(io: CliIo, path: string): string {
  return isAbsolute(path) ? path : resolve(io.cwd, path);
}

/** Loads the project from --project or by searching upwards from the cwd. */
function project(
  p: Parsed,
  io: CliIo,
  required: boolean
): { config: ProjectConfig; rootDir: string; path: string } | undefined | "error" {
  const given = flag(p, "--project", "-p");
  const path = typeof given === "string" ? abs(io, given) : findProjectConfig(io.cwd);
  if (!path) {
    if (required) {
      io.stderr("yaffle: no yaffle.json found (pass --project or files).\n");
      return "error";
    }
    return undefined;
  }
  const projectPath =
    existsSync(path) && statSync(path).isDirectory() ? resolve(path, "yaffle.json") : path;
  const { config, diagnostics } = loadProjectConfig(projectPath, host(io));
  if (!config) {
    printDiagnostics(diagnostics, io);
    return "error";
  }
  return { config, rootDir: dirname(projectPath), path: projectPath };
}

function cmdCheck(p: Parsed, io: CliIo): number {
  let files = p.positional.map(f => abs(io, f));
  let rootDir: string | undefined;
  let targets: ProjectConfig["targets"] | undefined;
  if (!files.length || flag(p, "--project", "-p")) {
    const proj = project(p, io, !files.length);
    if (proj === "error") return files.length ? 1 : 2;
    if (proj) {
      rootDir = proj.rootDir;
      targets = proj.config.targets;
      if (!files.length) files = projectSources(proj.config, proj.rootDir);
    }
  }
  if (!files.length) {
    io.stderr("yaffle: no .yfl files to check.\n");
    return 2;
  }
  const r = compile(files, host(io), {
    ...(rootDir ? { rootDir } : {}),
    ...(targets ? { targets } : {})
  });
  printDiagnostics(r.diagnostics, io);
  const errors = r.diagnostics.filter(d => d.severity === "error").length;
  const warnings = r.diagnostics.filter(d => d.severity === "warning").length;
  const summary = `${plural(files.length, "file")} checked: ${plural(errors, "error")}, ${plural(warnings, "warning")}`;
  (errors ? io.stderr : io.stdout)(paint(io, errors ? "red" : "green", summary) + "\n");
  return errors ? 1 : 0;
}

function cmdBuild(p: Parsed, io: CliIo): number {
  const proj = project(p, io, false);
  if (proj === "error") return 2;
  const target = flag(p, "--target", "-t");
  const out = flag(p, "--out", "-o");
  const files = p.positional.map(f => abs(io, f));
  let config = proj?.config;
  let rootDir = proj?.rootDir;
  if (!config) {
    if (!files.length || typeof target !== "string" || typeof out !== "string") {
      io.stderr("yaffle: build needs a yaffle.json, or files with --target and --out.\n");
      return 2;
    }
    config = { sources: [], targets: {} };
    rootDir = io.cwd;
  }
  if (typeof target === "string" && !config.targets[target] && typeof out !== "string") {
    io.stderr(`yaffle: target '${target}' isn't configured in yaffle.json; pass --out.\n`);
    return 2;
  }
  const r = build(
    { config, rootDir: rootDir! },
    typeof target === "string" ? target : undefined,
    typeof out === "string" ? abs(io, out) : undefined,
    {
      host: host(io),
      ...(io.backends ? { backends: io.backends } : {}),
      ...(files.length ? { entries: files } : {})
    }
  );
  printDiagnostics(r.diagnostics, io);
  for (const o of r.outputs) {
    io.stdout(
      `${paint(io, "green", "wrote")} ${plural(o.files.length, "file")} for ${o.target} to ${relative(io.cwd, o.outDir) || "."}\n`
    );
  }
  const errors = r.diagnostics.some(d => d.severity === "error");
  return errors ? 1 : 0;
}

function cmdIr(p: Parsed, io: CliIo): number {
  const file = p.positional[0];
  if (!file) {
    io.stderr("yaffle: ir needs a file.\n");
    return 2;
  }
  const r = compile([abs(io, file)], host(io));
  const errors = r.diagnostics.filter(d => d.severity === "error");
  printDiagnostics(
    r.diagnostics.filter(d => d.severity === "error" || d.severity === "warning"),
    io
  );
  if (!r.program || errors.length) return 1;
  if (p.flags.has("--text")) io.stdout(irToText(r.program));
  else io.stdout(JSON.stringify(r.program, null, p.flags.has("--pretty") ? 2 : undefined) + "\n");
  return 0;
}

function cmdFmt(p: Parsed, io: CliIo): number {
  let files = p.positional.map(f => abs(io, f));
  if (!files.length) {
    const proj = project(p, io, true);
    if (proj === "error" || !proj) return 2;
    files = projectSources(proj.config, proj.rootDir);
  }
  const check = p.flags.has("--check");
  const toStdout = p.flags.has("--stdout");
  let changed = 0;
  let failed = 0;
  for (const f of files) {
    const text = host(io).readFile(f);
    if (text === undefined) {
      io.stderr(`yaffle: can't read ${f}\n`);
      failed++;
      continue;
    }
    const r = formatSource(text, f);
    if (!r.formatted) {
      io.stderr(`${paint(io, "yellow", "skipped")} ${relative(io.cwd, f)} (syntax errors)\n`);
      failed++;
      continue;
    }
    if (toStdout) {
      io.stdout(r.text);
      continue;
    }
    if (r.text === text) continue;
    changed++;
    if (check) io.stdout(`${relative(io.cwd, f)}\n`);
    else {
      writeFileSync(f, r.text);
      io.stdout(`${paint(io, "green", "formatted")} ${relative(io.cwd, f)}\n`);
    }
  }
  if (check && changed) io.stderr(`${plural(changed, "file")} would be reformatted\n`);
  return failed || (check && changed) ? 1 : 0;
}

// ── pretty diagnostics ────────────────────────────────────────────────────────

type Color = "red" | "yellow" | "blue" | "cyan" | "green" | "bold" | "dim";
const CODES: Record<Color, [number, number]> = {
  red: [31, 39],
  yellow: [33, 39],
  blue: [34, 39],
  cyan: [36, 39],
  green: [32, 39],
  bold: [1, 22],
  dim: [2, 22]
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function paint(io: Pick<CliIo, "color">, color: Color, s: string): string {
  if (!io.color) return s;
  const [a, b] = CODES[color];
  return `\u001b[${a}m${s}\u001b[${b}m`;
}

function formatDiagnostic(
  d: Diagnostic,
  io: Pick<CliIo, "color" | "cwd">,
  readFile: (p: string) => string | undefined
): string {
  const sevColor: Color =
    d.severity === "error"
      ? "red"
      : d.severity === "warning"
        ? "yellow"
        : d.severity === "info"
          ? "blue"
          : "cyan";
  const rel = displayPath(io.cwd, d.path);
  const loc = `${rel}:${d.range.start.line + 1}:${d.range.start.character + 1}`;
  const lines: string[] = [];
  lines.push(
    `${paint(io, "bold", loc)}: ${paint(io, sevColor, d.severity)} ${paint(io, "dim", `[${d.code}]`)} ${d.message}`
  );
  const text = readFile(d.path);
  if (text !== undefined) {
    const src = text.split(/\r?\n/);
    const l = d.range.start.line;
    const lineText = src[l];
    if (lineText !== undefined) {
      const num = String(l + 1);
      const pad = " ".repeat(num.length);
      const expanded = lineText.replace(/\t/g, "  ");
      const col = lineText.slice(0, d.range.start.character).replace(/\t/g, "  ").length;
      const endCol =
        d.range.end.line === l
          ? lineText.slice(0, d.range.end.character).replace(/\t/g, "  ").length
          : expanded.length;
      const width = Math.max(1, endCol - col);
      lines.push(`${pad} ${paint(io, "blue", "|")}`);
      lines.push(`${paint(io, "blue", num)} ${paint(io, "blue", "|")} ${expanded}`);
      lines.push(
        `${pad} ${paint(io, "blue", "|")} ${" ".repeat(col)}${paint(io, sevColor, "^".repeat(width))}`
      );
    }
  }
  for (const r of d.related ?? []) {
    const rr = displayPath(io.cwd, r.location.path);
    lines.push(
      `  ${paint(io, "blue", "=")} ${r.message} (${rr}:${r.location.range.start.line + 1}:${r.location.range.start.character + 1})`
    );
  }
  for (const f of d.fixes ?? []) lines.push(`  ${paint(io, "green", "fix:")} ${f.title}`);
  return lines.join("\n");
}

/** Relative to the cwd when inside it, absolute otherwise. */
function displayPath(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  return !rel || rel.startsWith("..") || isAbsolute(rel) ? path : rel;
}

function printDiagnostics(diags: Diagnostic[], io: CliIo): void {
  const read = (p: string) => host(io).readFile(p);
  for (const d of diags) io.stderr(formatDiagnostic(d, io, read) + "\n\n");
}

export function defaultIo(): CliIo {
  return {
    stdout: s => process.stdout.write(s),
    stderr: s => process.stderr.write(s),
    cwd: process.cwd(),
    color: !!process.stderr.isTTY && !process.env.NO_COLOR
  };
}
