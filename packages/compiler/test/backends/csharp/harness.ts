/**
 * Test harness for the C# backend: compiles yaffle sources, generates C#, writes a console
 * project (outside the repository, under $YAFFLE_CSHARP_CACHE/tests) that references the runtime,
 * builds it with `dotnet build` (warnings as errors, at every warning level) and runs it.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { compile, compileSource } from "../../../src/index.ts";
import type { IrProgram } from "../../../src/ir/index.ts";
import type { GeneratedFile } from "../../../src/backends/backend.ts";
import { generateCSharp } from "../../../src/backends/csharp/index.ts";
import { cacheDir, dotnetEnv, findDotnet } from "../../../src/backends/csharp/conformance.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, "../../../../..");
const RUNTIME_PROJECT = join(
  REPO,
  "packages/runtime-csharp/src/Yaffle.Runtime/Yaffle.Runtime.csproj"
);
export const CONF_EXTERNS = join(REPO, "conformance/externs/csharp");

export const hasDotnet = (): boolean => findDotnet() !== null;

function programOf(r: ReturnType<typeof compile>): IrProgram {
  if (r.program) return r.program;
  const errs = r.diagnostics
    .filter(d => d.severity === "error")
    .map(d => `${d.code}: ${d.message}`);
  throw new Error(`schema does not compile:\n${errs.join("\n")}`);
}

/** Compiles one in-memory yaffle source (fails the test on errors). */
export function irOf(source: string, path = "/memory/main.yfl"): IrProgram {
  return programOf(compileSource(source, path));
}

/** Compiles yaffle files on disk. */
export function irOfFiles(files: string[]): IrProgram {
  return programOf(compile(files));
}

/** The C# externs of a yaffle.json (paths resolved against its directory); none without one. */
export function externsOf(yaffleJson: string): Record<string, string> {
  if (!existsSync(yaffleJson)) return {};
  const cfg = JSON.parse(readFileSync(yaffleJson, "utf8")) as {
    targets?: { csharp?: { externs?: Record<string, string> } };
  };
  const out: Record<string, string> = {};
  for (const [n, spec] of Object.entries(cfg.targets?.csharp?.externs ?? {}))
    out[n] = resolve(dirname(yaffleJson), spec);
  return out;
}

/** Generates C# for a program into a namespace; file paths are prefixed with `ns/`. */
export function gen(
  program: IrProgram,
  ns: string,
  externs: Record<string, string> = {},
  inlineRuntime = false
): GeneratedFile[] {
  return generateCSharp(program, { externs, targetOptions: { namespace: ns }, inlineRuntime }).map(
    f => ({ path: `${ns}/${f.path}`, contents: f.contents })
  );
}

export interface ProjectOptions {
  /** Absolute paths of extra C# files (extern implementations). */
  compile?: string[];
  /** NuGet packages: name → version. */
  packages?: Record<string, string>;
  /** Reference the runtime project (default true; false for inlined runtimes). */
  runtime?: boolean;
  /** The project's TargetFramework (default net10.0; the runtime also targets net8.0). */
  targetFramework?: string;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function exec(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise(res => {
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", code => res({ code: code ?? 1, stdout, stderr }));
    child.on("error", e => res({ code: 1, stdout, stderr: String(e) }));
  });
}

/** Writes and builds a console project; returns the path of its dll. */
export async function build(
  name: string,
  files: GeneratedFile[],
  opts: ProjectOptions = {}
): Promise<string> {
  const dotnet = findDotnet();
  if (!dotnet) throw new Error("dotnet is not available");
  const dir = join(cacheDir(), "tests", name);
  rmSync(join(dir, "src"), { recursive: true, force: true });
  for (const f of files) {
    const p = join(dir, "src", f.path);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.contents);
  }
  const items = [
    ...(opts.compile ?? []).map(p => `    <Compile Include="${p}" />`),
    ...(opts.runtime === false ? [] : [`    <ProjectReference Include="${RUNTIME_PROJECT}" />`]),
    ...Object.entries(opts.packages ?? {}).map(
      ([n, v]) => `    <PackageReference Include="${n}" Version="${v}" />`
    )
  ];
  writeFileSync(
    join(dir, `${name}.csproj`),
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>${opts.targetFramework ?? "net10.0"}</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>disable</ImplicitUsings>
    <LangVersion>13.0</LangVersion>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <WarningLevel>9999</WarningLevel>
    <AnalysisLevel>latest</AnalysisLevel>
    <InvariantGlobalization>true</InvariantGlobalization>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="src/**/*.cs" />
${items.join("\n")}
  </ItemGroup>
</Project>
`
  );
  const out = join(dir, "bin");
  const r = await exec(
    dotnet,
    [
      "build",
      join(dir, `${name}.csproj`),
      "-c",
      "Release",
      "-o",
      out,
      "-nologo",
      "-v",
      "q",
      "-clp:NoSummary"
    ],
    dotnetEnv({ YAFFLE_CSHARP_ARTIFACTS: join(dir, "artifacts") })
  );
  if (r.code !== 0) {
    const lines = (r.stdout + r.stderr).split("\n").filter(l => /error|warning/.test(l));
    throw new Error(`dotnet build failed:\n${[...new Set(lines)].slice(0, 40).join("\n")}`);
  }
  return join(out, `${name}.dll`);
}

/** Runs a built console project. */
export async function run(dll: string): Promise<RunResult> {
  return exec(findDotnet()!, [dll], dotnetEnv());
}

/** One check of a generated Program.cs: a name and a C# body that returns an object (compared as text). */
export interface CheckSpec {
  name: string;
  /** Statements ending in `return <value>;`: the value's text is compared with `expect`. */
  body: string;
  expect: string;
}

/** A Program.cs that runs every check and prints `name\tresult` lines (exceptions as `!Code path`). */
export function program(checks: CheckSpec[]): GeneratedFile {
  const lines = [
    "#nullable enable",
    ...[
      "System",
      "System.Collections.Generic",
      "System.Linq",
      "System.Text.Json.Nodes",
      "System.Threading.Tasks"
    ].map(u => `using ${u};`),
    "using Rt = global::Yaffle.Runtime;",
    "",
    "public static class Program",
    "{",
    "    private static string Show(object? v) => v switch",
    "    {",
    '        null => "null",',
    "        byte[] b => Convert.ToHexStringLower(b),",
    "        JsonNode n => Rt.Json.Stringify(n),",
    '        bool b => b ? "true" : "false",',
    '        _ => Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture) ?? ""',
    "    };",
    ""
  ];
  checks.forEach((c, i) => {
    lines.push(
      `    private static async Task<object?> Check${i}()`,
      "    {",
      "        await Task.CompletedTask;"
    );
    for (const l of c.body.trim().split("\n")) lines.push(`        ${l}`);
    lines.push("    }");
  });
  lines.push("    public static async Task<int> Main()", "    {");
  checks.forEach((c, i) => {
    const name = JSON.stringify(c.name);
    lines.push(
      "        try",
      "        {",
      `            Console.WriteLine(${name} + "\\t" + Show(await Check${i}()));`,
      "        }",
      "        catch (Rt.YaffleException e)",
      "        {",
      `            Console.WriteLine(${name} + "\\t!" + e.Code + " " + Rt.YaffleException.FormatPath(e.Path));`,
      "        }",
      "        catch (Exception e)",
      "        {",
      `            Console.WriteLine(${name} + "\\t!!" + e.GetType().Name + ": " + e.Message.Replace("\\n", " "));`,
      `            Console.Error.WriteLine(${name} + ": " + e);`,
      "        }"
    );
  });
  lines.push("        return 0;", "    }", "}");
  return { path: "Program.cs", contents: lines.join("\n") + "\n" };
}

/** Parses `name\tresult` lines. */
function results(stdout: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab > 0) m.set(line.slice(0, tab), line.slice(tab + 1));
  }
  return m;
}

export interface CheckSuite {
  /** Project name (its directory under the cache). */
  project: string;
  /** The generated code and helper sources (Program.cs is added). */
  files: () => GeneratedFile[];
  /** The checks, or checks by feature (one `describe` each). */
  checks: CheckSpec[] | Record<string, CheckSpec[]>;
  build?: ProjectOptions;
  /** Skip the suite (besides when dotnet is missing). */
  skip?: boolean;
  timeout?: number;
}

/**
 * Builds one project holding every check and asserts each check's printed result in its own
 * `it`. An expectation ending in a space matches an error result (`!CODE …`) by prefix.
 */
export function describeChecks(title: string, suite: CheckSuite): void {
  const all = Array.isArray(suite.checks) ? suite.checks : Object.values(suite.checks).flat();
  describe.skipIf(!hasDotnet() || suite.skip === true)(title, () => {
    let out = new Map<string, string>();
    beforeAll(async () => {
      const dll = await build(suite.project, [...suite.files(), program(all)], suite.build);
      const r = await run(dll);
      if (r.code !== 0) throw new Error(`the program failed:\n${r.stdout}\n${r.stderr}`);
      out = results(r.stdout);
    }, 900_000);
    const check = (c: CheckSpec): void => {
      it(c.name, { timeout: suite.timeout ?? 5_000 }, () => {
        const got = out.get(c.name);
        if (c.expect.endsWith(" ") && got?.startsWith("!"))
          expect(got.startsWith(c.expect.trimEnd())).toBe(true);
        else expect(got).toBe(c.expect);
      });
    };
    if (Array.isArray(suite.checks)) suite.checks.forEach(check);
    else
      for (const [feature, checks] of Object.entries(suite.checks))
        describe(feature, () => checks.forEach(check));
  });
}
