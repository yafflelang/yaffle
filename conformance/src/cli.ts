#!/usr/bin/env node
/**
 * Conformance CLI: prints the pass/fail matrix of every case directory on every backend.
 *
 *   node --conditions=development conformance/src/cli.ts [options]
 *
 *   --filter <patterns>   like YAFFLE_CONFORMANCE_FILTER (comma-separated, globs, !exclude)
 *   --targets <list>      like YAFFLE_CONFORMANCE_TARGETS (e.g. ts,rust)
 *   --compiler <module>   use this module's `compile` instead of the `yaffle` package's
 *   --adapter <module>    use this adapter module instead of discovering them (repeatable)
 *   --verbose, -v         list every case
 *   --list                list case directories and case counts, without running anything
 *   --validate            only validate cases.json files (exit 1 if any is invalid)
 *   --json                print the report as JSON
 *
 * `--compiler` and `--adapter` run the suite against other implementations, e.g. another
 * worktree's frontend or backend (paths are resolved from the current directory).
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadAdapter, type DiscoveredAdapter } from "./discover.ts";
import { loadCaseRoots } from "./load.ts";
import { formatReport } from "./report.ts";
import {
  DEFAULT_REPO_ROOT,
  defaultCaseRoots,
  runConformance,
  type CompileFn,
  type RunnerOptions
} from "./runner.ts";

interface CliOptions {
  verbose: boolean;
  list: boolean;
  validate: boolean;
  json: boolean;
  compiler?: string;
  adapters: string[];
  env: Record<string, string | undefined>;
}

const USAGE =
  "usage: node --conditions=development conformance/src/cli.ts [--filter <patterns>] [--targets <list>]\n" +
  "       [--compiler <module>] [--adapter <module>]... [-v] [--list] [--validate] [--json]\n";

/** Options that take a value, as `--name value` or `--name=value`. */
const VALUE_OPTIONS: Record<string, (opts: CliOptions, value: string) => void> = {
  "--filter": (o, v) => (o.env.YAFFLE_CONFORMANCE_FILTER = v),
  "--targets": (o, v) => (o.env.YAFFLE_CONFORMANCE_TARGETS = v),
  "--compiler": (o, v) => (o.compiler = v),
  "--adapter": (o, v) => o.adapters.push(v)
};

export function parseArgs(argv: string[], env: Record<string, string | undefined>): CliOptions {
  const opts: CliOptions = {
    verbose: false,
    list: false,
    validate: false,
    json: false,
    adapters: [],
    env: { ...env }
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const name = eq < 0 ? arg : arg.slice(0, eq);
    if (Object.hasOwn(VALUE_OPTIONS, name)) {
      const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) throw new Error(`${name} needs a value`);
      VALUE_OPTIONS[name]!(opts, value);
    } else if (arg === "--verbose" || arg === "-v") opts.verbose = true;
    else if (arg === "--list") opts.list = true;
    else if (arg === "--validate") opts.validate = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") throw new Error("help");
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

/** Loads `compile` from a module path (an alternative frontend). */
export async function loadCompiler(module: string): Promise<CompileFn> {
  const mod = (await import(pathToFileURL(resolve(module)).href)) as { compile?: unknown };
  if (typeof mod.compile !== "function") throw new Error(`${module} does not export compile()`);
  return mod.compile as CompileFn;
}

/** Loads adapters from module paths; the target name comes from the adapter itself. */
export async function loadAdapters(modules: string[]): Promise<DiscoveredAdapter[]> {
  const out: DiscoveredAdapter[] = [];
  for (const m of modules) {
    const d = await loadAdapter("?", resolve(m));
    out.push({ ...d, target: d.adapter?.target ?? m });
  }
  return out;
}

/** --list and --validate: report the case directories without running anything. */
function listCases(list: boolean, write: (s: string) => void): number {
  const dirs = loadCaseRoots(defaultCaseRoots(DEFAULT_REPO_ROOT));
  let bad = 0;
  for (const d of dirs) {
    const invalid = d.problems.length > 0;
    if (list) {
      const n = d.cases.length;
      write(`${d.id}: ${n} case${n === 1 ? "" : "s"}${invalid ? " (INVALID)" : ""}\n`);
    }
    if (invalid) {
      bad++;
      write(d.problems.map(p => `  ${d.id}: ${p}`).join("\n") + "\n");
    }
  }
  const total = dirs.reduce((n, d) => n + d.cases.length, 0);
  write(`${dirs.length} case directories, ${total} cases${bad ? `, ${bad} invalid` : ""}\n`);
  return bad > 0 ? 1 : 0;
}

export async function main(
  argv: string[],
  env: Record<string, string | undefined>,
  write: (s: string) => void
): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv, env);
  } catch (e) {
    const msg = (e as Error).message;
    write((msg === "help" ? "" : `${msg}\n\n`) + USAGE);
    return msg === "help" ? 0 : 2;
  }
  if (opts.list || opts.validate) return listCases(opts.list, write);
  const runnerOpts: RunnerOptions = { env: opts.env };
  if (opts.compiler !== undefined) runnerOpts.compile = await loadCompiler(opts.compiler);
  if (opts.adapters.length > 0) runnerOpts.adapters = await loadAdapters(opts.adapters);
  const report = await runConformance(runnerOpts, d => {
    if (!opts.json && opts.verbose) write(`… ${d.target} ${d.dir} (${d.durationMs} ms)\n`);
  });
  const text = opts.json
    ? JSON.stringify(report, null, 2)
    : formatReport(report, { verbose: opts.verbose });
  write(text + "\n");
  return report.dirs.some(d => d.cases.some(c => c.status === "fail")) ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env, s => process.stdout.write(s)).then(
    code => process.exit(code),
    e => {
      console.error(e);
      process.exit(2);
    }
  );
}
