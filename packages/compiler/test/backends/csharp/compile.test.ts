/**
 * Every conformance schema generates C# that builds with `dotnet build`, warnings as
 * errors at every warning level, for net10.0 and net8.0; an inlined runtime builds without the
 * runtime project.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import type { GeneratedFile } from "../../../src/backends/backend.ts";
import {
  REPO,
  build,
  describeChecks,
  externsOf,
  gen,
  hasDotnet,
  irOf,
  irOfFiles
} from "./harness.ts";

const MAIN: GeneratedFile = {
  path: "Program.cs",
  contents: "public static class Program { public static void Main() { } }\n"
};

describe.skipIf(!hasDotnet())("C# output builds warning-free", () => {
  it("every conformance schema", { timeout: 900_000 }, async () => {
    const files: GeneratedFile[] = [];
    const externFiles = new Set<string>();
    const add = (sources: string[], dir: string, ns: string): void => {
      const externs = externsOf(join(dir, "yaffle.json"));
      for (const p of Object.values(externs)) externFiles.add(p);
      files.push(...gen(irOfFiles(sources), ns, externs));
    };
    for (const root of ["conformance/cases"]) {
      for (const d of readdirSync(join(REPO, root)).sort()) {
        const dir = join(REPO, root, d);
        add([join(dir, "schema.yfl")], dir, `Gen.${`${root}/${d}`.replace(/[^A-Za-z0-9]+/g, "_")}`);
      }
    }
    files.push(MAIN);
    await build("all-schemas", files, { compile: [...externFiles] });
    await build("all-schemas-net8", files, {
      compile: [...externFiles],
      targetFramework: "net8.0"
    });
  });

  it("an inlined runtime, for net8.0", { timeout: 900_000 }, async () => {
    const files = gen(
      irOf("export struct Table { u32 count  u16 items[count] }"),
      "Inline",
      {},
      true
    );
    await build("inline-runtime-net8", [...files, MAIN], {
      runtime: false,
      targetFramework: "net8.0"
    });
  });
});

describeChecks("C# output with an inlined runtime", {
  project: "inline-runtime",
  build: { runtime: false },
  files: () =>
    gen(
      irOf(`
        export struct Table {
          u32   count
          Entry entries[count]
        }
        struct Entry { u16 a  u16 b }
      `),
      "Inline",
      {},
      true
    ),
  checks: [
    {
      name: "needs no runtime project",
      body: `var t = Inline.Table.Parse(Convert.FromHexString("0100000001000200"));\nreturn Convert.ToHexStringLower(Inline.Table.Serialize(t)) + " " + t.Entries[0].B;`,
      expect: "0100000001000200 2"
    }
  ]
});
