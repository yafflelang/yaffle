/**
 * Writes conformance/cases/<area>/cases.json from the generators in conformance/scripts/areas/.
 *
 *   node conformance/scripts/gen-cases.ts            write every area
 *   node conformance/scripts/gen-cases.ts --check    exit 1 if a cases.json is out of date
 *   node conformance/scripts/gen-cases.ts <area>…    write only these areas
 *
 * The schema.yfl files are hand-written; only cases.json is generated.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { jsonEqual } from "../src/canonical.ts";
import { areas } from "./areas/index.ts";
import { stringify, type Area } from "./lib.ts";

const CONFORMANCE_DIR = fileURLToPath(new URL("../", import.meta.url));

function caseFile(a: Area): string {
  return join(CONFORMANCE_DIR, "cases", a.dir, "cases.json");
}

function caseFileContent(a: Area) {
  return {
    description: a.description,
    generatedBy: `conformance/scripts/areas/${a.dir}.ts`,
    cases: a.cases
  };
}

/** Areas whose cases.json is missing or differs (compared as JSON, so reformatting is fine). */
export function outdatedAreas(): string[] {
  return areas
    .filter(a => {
      const file = caseFile(a);
      if (!existsSync(file)) return true;
      const expected: unknown = JSON.parse(JSON.stringify(caseFileContent(a)));
      return !jsonEqual(expected, JSON.parse(readFileSync(file, "utf8")));
    })
    .map(a => a.dir);
}

/** Writes an area's cases.json, formatted like the rest of the repository by prettier. */
async function write(a: Area): Promise<void> {
  const prettier = await import("prettier");
  const file = caseFile(a);
  const options = (await prettier.resolveConfig(file)) ?? {};
  const text = stringify(caseFileContent(a)) + "\n";
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, await prettier.format(text, { ...options, filepath: file, parser: "json" }));
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("--check")) {
    const bad = outdatedAreas();
    if (bad.length > 0) {
      console.error(`out of date: ${bad.join(", ")} (run node conformance/scripts/gen-cases.ts)`);
      return 1;
    }
    console.log(`${areas.length} areas up to date`);
    return 0;
  }
  const only = argv.filter(a => !a.startsWith("-"));
  let n = 0;
  for (const a of areas) {
    if (only.length > 0 && !only.includes(a.dir)) continue;
    await write(a);
    console.log(`${a.dir}: ${a.cases.length} cases`);
    n += a.cases.length;
  }
  console.log(`${n} cases written`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(code => process.exit(code));
}
