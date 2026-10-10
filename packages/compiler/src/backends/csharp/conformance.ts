/**
 * Conformance adapter for the C# target (docs/CONFORMANCE.md, conformance/src/adapter.ts).
 *
 * Builds are slow, so the adapter does not run `dotnet build` per case directory. Instead it
 * builds one long-running host once (packages/compiler/src/backends/csharp/harness: the runtime,
 * Roslyn and the case runner; cached by content hash under $YAFFLE_CSHARP_CACHE) and sends it
 * each case directory's generated code, externs and a small generated harness. The host compiles
 * them in memory, runs the cases and writes the actual JSON, bytes and errors, which the runner
 * re-checks.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IrProgram } from "../../ir/index.ts";
import { generateCSharp, runtimeSourceDir } from "./index.ts";
import { Model } from "./model.ts";

// Structural copies of conformance/src/adapter.ts (the compiler package cannot import it).
type RoundTrip = boolean | "json" | "value";

interface Case {
  name: string;
  root: string;
  args?: Record<string, unknown>;
  bytes?: string | { file: string; offset?: number; length?: number };
  json?: unknown;
  input?: unknown;
  roundtrip?: RoundTrip;
  strict?: boolean;
  error?: { phase: "parse" | "serialize"; code: string; path?: (string | number)[] };
  description?: string;
}

interface CaseError {
  phase: "parse" | "serialize";
  code: string;
  path?: (string | number)[];
  offset?: number;
  message?: string;
}

interface CaseResult {
  name: string;
  ok: boolean;
  message?: string;
  skipped?: string;
  json?: unknown;
  bytes?: string;
  error?: CaseError;
}

interface AdapterRunInput {
  caseDir: string;
  program: IrProgram;
  cases: Case[];
  workDir: string;
  externs?: Record<string, string>;
  /** "view": every parse case runs through the lazy view (docs/CONFORMANCE.md §7). */
  mode?: "parse" | "view";
}

interface ConformanceAdapter {
  target: string;
  capabilities?: { views?: boolean };
  available(): Promise<boolean>;
  run(input: AdapterRunInput): Promise<CaseResult[]>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = join(HERE, "harness");
const ROSLYN_VERSION = "5.9.0";
const ZSTD_VERSION = "0.8.8";
/** Namespace of the generated code in conformance runs. */
const NS = "Yaffle.Generated";

export function cacheDir(): string {
  const env = process.env.YAFFLE_CSHARP_CACHE;
  return env && env !== "" ? resolve(env) : join(tmpdir(), "yaffle-csharp-cache");
}

/** Environment for dotnet: caches outside the repository, no telemetry. */
export function dotnetEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const cache = cacheDir();
  return {
    ...process.env,
    DOTNET_CLI_HOME: process.env.DOTNET_CLI_HOME ?? join(cache, "home"),
    NUGET_PACKAGES: process.env.NUGET_PACKAGES ?? join(cache, "nuget"),
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_NOLOGO: "1",
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
    DOTNET_GENERATE_ASPNET_CERTIFICATE: "false",
    ...extra
  };
}

let dotnetPath: string | null | undefined;

/** The dotnet executable: $YAFFLE_DOTNET, `dotnet` on PATH, or the SDK from `nix shell nixpkgs#dotnet-sdk_10`. */
export function findDotnet(): string | null {
  if (dotnetPath !== undefined) return dotnetPath;
  const works = (p: string): boolean => {
    const r = spawnSync(p, ["--list-sdks"], {
      encoding: "utf8",
      env: dotnetEnv(),
      timeout: 60_000
    });
    return r.status === 0 && /^1\d\./m.test(r.stdout);
  };
  const candidates: string[] = [];
  if (process.env.YAFFLE_DOTNET) candidates.push(process.env.YAFFLE_DOTNET);
  const cached = join(cacheDir(), "dotnet-path");
  if (existsSync(cached)) candidates.push(readFileSync(cached, "utf8").trim());
  candidates.push("dotnet");
  for (const c of candidates) {
    if (c && works(c)) return (dotnetPath = c);
  }
  const nix = spawnSync(
    "nix",
    ["shell", "nixpkgs#dotnet-sdk_10", "--command", "sh", "-c", "command -v dotnet"],
    {
      encoding: "utf8",
      timeout: 600_000
    }
  );
  const p = nix.status === 0 ? nix.stdout.trim() : "";
  if (p && works(p)) {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(cached, p);
    return (dotnetPath = p);
  }
  return (dotnetPath = null);
}

function run(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ code: number; out: string }> {
  return new Promise(res => {
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", code => res({ code: code ?? 1, out }));
    child.on("error", e => res({ code: 1, out: String(e) }));
  });
}

function hostSources(): string[] {
  const rt = runtimeSourceDir();
  return [
    join(HARNESS_DIR, "Host.cs"),
    join(HARNESS_DIR, "HarnessCore.cs"),
    join(rt, "Yaffle.Runtime.csproj"),
    join(rt, "../../Directory.Build.props"),
    ...readdirSync(rt)
      .filter(f => f.endsWith(".cs"))
      .sort()
      .map(f => join(rt, f))
  ];
}

function hostProject(): string {
  const rt = runtimeSourceDir();
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>disable</ImplicitUsings>
    <LangVersion>13.0</LangVersion>
    <AssemblyName>YaffleHost</AssemblyName>
    <RootNamespace>Yaffle.Harness</RootNamespace>
    <InvariantGlobalization>true</InvariantGlobalization>
    <ConcurrentGarbageCollection>false</ConcurrentGarbageCollection>
    <TieredPGO>true</TieredPGO>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="${join(HARNESS_DIR, "Host.cs")}" />
    <Compile Include="${join(HARNESS_DIR, "HarnessCore.cs")}" />
    <ProjectReference Include="${join(rt, "Yaffle.Runtime.csproj")}" />
    <PackageReference Include="Microsoft.CodeAnalysis.CSharp" Version="${ROSLYN_VERSION}" />
    <PackageReference Include="ZstdSharp.Port" Version="${ZSTD_VERSION}" />
  </ItemGroup>
</Project>
`;
}

let hostBuild: Promise<string> | undefined;

/** Builds the harness host (once per content hash) and returns the path of YaffleHost.dll. */
function buildHost(): Promise<string> {
  hostBuild ??= (async () => {
    const dotnet = findDotnet();
    if (!dotnet) throw new Error("dotnet is not available");
    const h = createHash("sha256");
    h.update(hostProject());
    for (const f of hostSources()) h.update(f).update(readFileSync(f));
    const hash = h.digest("hex").slice(0, 16);
    const dir = join(cacheDir(), `host-${hash}`);
    const dll = join(dir, "bin", "YaffleHost.dll");
    if (existsSync(dll)) return dll;
    const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "YaffleHost.csproj"), hostProject());
    const r = await run(
      dotnet,
      [
        "build",
        join(tmp, "YaffleHost.csproj"),
        "-c",
        "Release",
        "-o",
        join(tmp, "bin"),
        "-nologo",
        "-v",
        "q"
      ],
      dotnetEnv({ YAFFLE_CSHARP_ARTIFACTS: join(tmp, "artifacts") })
    );
    if (r.code !== 0)
      throw new Error(`building the C# harness host failed:\n${r.out.slice(-4000)}`);
    try {
      renameSync(tmp, dir);
    } catch {
      // Another process built it first.
      rmSync(tmp, { recursive: true, force: true });
    }
    return dll;
  })();
  return hostBuild;
}

interface Pending {
  resolve(v: Record<string, unknown>): void;
  reject(e: Error): void;
}

/** The running host process (one per Node process), fed one request at a time. */
class HostProcess {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buf = "";
  private stderr = "";
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();

  private start(dll: string): ChildProcessWithoutNullStreams {
    const dotnet = findDotnet()!;
    const child = spawn(dotnet, [dll], {
      env: dotnetEnv({ DOTNET_TieredPGO: "1" }),
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      this.buf += d;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        const p = this.pending.get(msg.id as number);
        if (p) {
          this.pending.delete(msg.id as number);
          p.resolve(msg);
        }
      }
      this.idle();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      this.stderr = (this.stderr + d).slice(-8000);
    });
    child.on("exit", code => {
      const err = new Error(`the C# harness host exited (code ${code}):\n${this.stderr}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      if (this.child === child) this.child = undefined;
    });
    return child;
  }

  /** Lets Node exit while no request is pending. */
  private idle(): void {
    const c = this.child;
    if (!c) return;
    const busy = this.pending.size > 0;
    const streams = [c.stdout, c.stderr, c.stdin] as unknown as { ref?(): void; unref?(): void }[];
    if (busy) {
      c.ref();
      for (const s of streams) s.ref?.();
    } else {
      c.unref();
      for (const s of streams) s.unref?.();
    }
  }

  request(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const job = this.queue.then(async () => {
      const dll = await buildHost();
      if (!this.child) this.child = this.start(dll);
      const id = this.nextId++;
      const child = this.child;
      const p = new Promise<Record<string, unknown>>((resolveP, rejectP) => {
        this.pending.set(id, { resolve: resolveP, reject: rejectP });
      });
      this.idle();
      child.stdin.write(JSON.stringify({ ...req, id }) + "\n");
      try {
        return await p;
      } finally {
        this.idle();
      }
    });
    this.queue = job.catch(() => undefined);
    return job;
  }
}

let host: HostProcess | undefined;

function hostProcess(): HostProcess {
  host ??= new HostProcess();
  return host;
}

/** Deep equality of JSON values; returns a description of the first difference, or undefined. */
function jsonDiff(a: unknown, b: unknown, path = ""): string | undefined {
  if (a === b) return undefined;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") {
    return `${path || "/"}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path || "/"}: array vs object`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length)
      return `${path || "/"}: expected ${b.length} elements, got ${a.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = jsonDiff(a[i], b[i], `${path}/${i}`);
      if (d) return d;
    }
    return undefined;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ka = Object.keys(ao);
  const kb = Object.keys(bo);
  for (const k of new Set([...ka, ...kb])) {
    if (!(k in ao)) return `${path}/${k}: missing`;
    if (!(k in bo)) return `${path}/${k}: unexpected`;
    const d = jsonDiff(ao[k], bo[k], `${path}/${k}`);
    if (d) return d;
  }
  if (ka.join("\0") !== kb.join("\0"))
    return `${path || "/"}: keys out of order (${ka.join(", ")})`;
  return undefined;
}

function notImplemented(e: unknown): string | undefined {
  const msg = e instanceof Error ? e.message : String(e);
  return /not implemented|not supported/i.test(msg) ? msg : undefined;
}

/** The per-directory harness: the roots of the program as Yaffle.Harness.RootEntry delegates. */
function harnessSource(program: IrProgram): string {
  const model = new Model(program);
  const rt = "global::Yaffle.Runtime";
  const h = "global::Yaffle.Harness";
  const wait = (task: string): string => `${task}.AsTask().GetAwaiter().GetResult()`;
  const entries = program.roots.flatMap(r => {
    const cls = `global::${NS}.${model.className(r.struct)}`;
    const opts = `global::${NS}.${model.optionsNames.get(r.struct)!}`;
    // View mode: sync roots get a sync view (over a file source for file cases), async roots an
    // async view whose every access runs through GetAsync.
    const rewrite = `new ${rt}.CommitOptions { Rewrite = true }`;
    const view = model.rootIsAsync(r.struct)
      ? {
          open: "ViewAsync",
          source: `${rt}.IAsyncSource`,
          json: wait(`v.GetAsync(x => ${cls}.ToJson(x))`),
          commit: wait("v.CommitAsync()"),
          rewrite: wait(`v.PatchesAsync(${rewrite})`)
        }
      : {
          open: "View",
          source: `${rt}.ISource`,
          json: `${cls}.ToJson(v.Root)`,
          commit: "v.Commit()",
          rewrite: `v.Patches(${rewrite})`
        };
    const name = JSON.stringify(r.name);
    return [
      `roots[${name}] = new ${h}.RootEntry`,
      `{`,
      `    Options = j => ${opts}.FromJson(j),`,
      `    Parse = (b, o) => ${wait(`${cls}.ParseAsync(b, (${opts})o)`)},`,
      `    ToJson = v => ${cls}.ToJson((${cls})v),`,
      `    FromJson = j => ${cls}.FromJson(j),`,
      `    Serialize = (v, o) => ${wait(`${cls}.SerializeAsync((${cls})v, (${opts})o)`)},`,
      `    View = (b, f, o) =>`,
      `    {`,
      `        var src = f is null ? null : new ${rt}.FileSource(f);`,
      `        var v = src is null ? ${cls}.${view.open}(b, (${opts})o) : ${cls}.${view.open}((${view.source})src, (${opts})o);`,
      `        return new ${h}.ViewHandle`,
      `        {`,
      `            Json = () => ${view.json},`,
      `            Commit = () => ${view.commit},`,
      `            Rewrite = () => ${view.rewrite},`,
      `            Resource = src`,
      `        };`,
      `    }`,
      `};`,
      ...(r.struct !== r.name ? [`roots.TryAdd(${JSON.stringify(r.struct)}, roots[${name}]);`] : [])
    ];
  });
  return [
    "// Generated by the yaffle C# conformance adapter.",
    "#nullable enable",
    "using System.Collections.Generic;",
    "namespace YaffleCaseHarness;",
    "public static class Cases",
    "{",
    "    public static void Run(string casesFile, string resultsFile, string mode)",
    "    {",
    `        var roots = new Dictionary<string, ${h}.RootEntry>();`,
    ...entries.map(l => `        ${l}`),
    `        ${h}.Runner.Run(roots, casesFile, resultsFile, mode);`,
    "    }",
    "}",
    ""
  ].join("\n");
}

/** Extern file paths of an extern map (`path#Item` → path). */
function externFiles(externs: Record<string, string>): string[] {
  const out = new Set<string>();
  for (const spec of Object.values(externs)) {
    const hash = spec.indexOf("#");
    const path = hash >= 0 ? spec.slice(0, hash) : spec;
    if (path.endsWith(".cs") && existsSync(path)) out.add(path);
  }
  return [...out].sort();
}

/** Fallback for runners that pass no extern map: the case directory's yaffle.json. */
function externsFromConfig(caseDir: string): Record<string, string> {
  const cfg = join(caseDir, "yaffle.json");
  if (!existsSync(cfg)) return {};
  const json = JSON.parse(readFileSync(cfg, "utf8")) as {
    targets?: { csharp?: { externs?: Record<string, string> } };
  };
  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries(json.targets?.csharp?.externs ?? {})) {
    out[name] = /^\.\.?\//.test(spec) || spec.startsWith("/") ? resolve(dirname(cfg), spec) : spec;
  }
  return out;
}

export const adapter: ConformanceAdapter = {
  target: "csharp",
  capabilities: { views: true },
  async available() {
    return findDotnet() !== null;
  },
  async run({ caseDir, program, cases, workDir, externs, mode }) {
    const map = externs && Object.keys(externs).length ? externs : externsFromConfig(caseDir);
    let files;
    try {
      files = generateCSharp(program, { externs: map, targetOptions: { namespace: NS } });
    } catch (e) {
      const ni = notImplemented(e);
      if (ni) return cases.map(c => ({ name: c.name, ok: false, skipped: ni }));
      throw e;
    }
    const gen = join(workDir, "gen");
    const sources: string[] = [];
    for (const f of files) {
      const p = join(gen, f.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.contents);
      sources.push(p);
    }
    const harness = join(workDir, "Harness.cs");
    writeFileSync(harness, harnessSource(program));
    sources.push(harness, ...externFiles(map));
    const casesFile = join(workDir, "cases.json");
    const resultsDir = join(workDir, "results");
    writeFileSync(casesFile, JSON.stringify(cases));
    rmSync(resultsDir, { recursive: true, force: true });
    const resp = await hostProcess().request({
      sources,
      entry: "YaffleCaseHarness.Cases",
      cases: casesFile,
      results: resultsDir,
      mode: mode ?? "parse"
    });
    if (!resp.ok) {
      const msg = String(resp.error ?? "the C# harness failed");
      const ni = notImplemented(msg);
      if (ni) return cases.map(c => ({ name: c.name, ok: false, skipped: ni.slice(0, 500) }));
      return cases.map(c => ({ name: c.name, ok: false, message: msg.slice(0, 4000) }));
    }
    const results = cases.map(
      (_, k) => JSON.parse(readFileSync(join(resultsDir, `${k}.json`), "utf8")) as CaseResult
    );
    const byName = new Map(cases.map(c => [c.name, c]));
    for (const r of results) {
      const c = byName.get(r.name);
      if (!c || !r.ok || r.json === undefined || c.json === undefined) continue;
      const d = jsonDiff(r.json, c.json);
      if (d) {
        r.ok = false;
        r.message = `parse: ${d}`;
      }
    }
    return results;
  }
};
