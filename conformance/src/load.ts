/** Loading and validating case directories (docs/CONFORMANCE.md §1, §2). */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { ERROR_CODES, type Case } from "./adapter.ts";
import { normalizeHex } from "./hex.ts";

export interface CaseDir {
  /** Absolute path. */
  path: string;
  /** Display id, relative to its case root with forward slashes, e.g. "primitives" or "extra/arrays". */
  id: string;
  /** Absolute path of the entry schema (schema.yfl). */
  schema: string;
  cases: Case[];
  /** Per target: extern name → absolute module path (from yaffle.json). */
  externs: Record<string, Record<string, string>>;
  /** Problems found while loading. A directory with problems fails every case. */
  problems: string[];
}

export interface CaseRoot {
  /** Absolute directory containing case directories (searched recursively). */
  path: string;
  /** Prefix for ids, e.g. "" for conformance/cases. */
  prefix: string;
}

/** Finds every directory below `root` that contains a cases.json. */
export function findCaseDirs(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const visit = (dir: string) => {
    if (existsSync(join(dir, "cases.json"))) out.push(dir);
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) visit(p);
    }
  };
  visit(root);
  return out;
}

export function loadCaseRoots(roots: CaseRoot[]): CaseDir[] {
  return roots.flatMap(root =>
    findCaseDirs(root.path).map(dir => {
      const rel = relative(root.path, dir).split(sep).join("/");
      const id = [root.prefix, rel].filter(s => s !== "").join("/") || "(root)";
      return loadCaseDir(dir, id);
    })
  );
}

export function loadCaseDir(dir: string, id: string): CaseDir {
  const problems: string[] = [];
  const schema = join(dir, "schema.yfl");
  if (!existsSync(schema)) problems.push("missing schema.yfl");
  let cases: Case[] = [];
  try {
    const v = validateCaseFile(JSON.parse(readFileSync(join(dir, "cases.json"), "utf8")));
    cases = v.cases;
    problems.push(...v.problems);
  } catch (e) {
    problems.push(`cases.json: ${(e as Error).message}`);
  }
  for (const c of cases) {
    const file = typeof c.bytes === "object" ? c.bytes.file : undefined;
    if (file === undefined) continue;
    if (!existsSync(resolve(dir, file)))
      problems.push(`case "${c.name}": bytes file ${file} does not exist`);
  }
  const externs = loadExterns(dir, problems);
  return { path: dir, id, schema, cases, externs, problems };
}

// ── cases.json validation ─────────────────────────────────────────────────────────────────────

type Report = (problem: string) => void;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FILE_KEYS = new Set(["cases", "description", "generatedBy"]);
const CASE_KEYS = new Set([
  "name",
  "root",
  "args",
  "bytes",
  "json",
  "input",
  "roundtrip",
  "strict",
  "error",
  "expect",
  "description"
]);
const BYTES_KEYS = ["file", "offset", "length"];
const EXPECT_CHECKS = ["equals", "length", "byteLength", "startsWith"];

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

/** Validates a parsed cases.json. Returns the cases and a list of problems (empty if valid). */
export function validateCaseFile(doc: unknown): { cases: Case[]; problems: string[] } {
  if (!isPlainObject(doc))
    return { cases: [], problems: ["cases.json must be an object with a `cases` array"] };
  const problems = Object.keys(doc)
    .filter(k => !FILE_KEYS.has(k))
    .map(k => `unknown top-level key "${k}"`);
  if (!Array.isArray(doc.cases))
    return { cases: [], problems: [...problems, "`cases` must be an array"] };
  const cases: Case[] = [];
  const names = new Set<string>();
  doc.cases.forEach((raw: unknown, i) => {
    if (!isPlainObject(raw)) {
      problems.push(`case #${i}: must be an object`);
      return;
    }
    const label = typeof raw.name === "string" ? `case "${raw.name}"` : `case #${i}`;
    validateCase(raw, names, msg => problems.push(`${label}: ${msg}`));
    cases.push(raw as unknown as Case);
  });
  return { cases, problems };
}

function validateCase(c: Record<string, unknown>, names: Set<string>, p: Report): void {
  for (const k of Object.keys(c)) if (!CASE_KEYS.has(k)) p(`unknown key "${k}"`);
  if (typeof c.name !== "string" || c.name === "") p("`name` must be a non-empty string");
  else if (names.has(c.name)) p("duplicate name");
  else names.add(c.name);
  if (typeof c.root !== "string" || !IDENT.test(c.root)) p("`root` must be an identifier");
  if (c.args !== undefined && !isPlainObject(c.args)) p("`args` must be an object");
  if (c.bytes !== undefined) validateBytes(c.bytes, p);
  if (c.roundtrip !== undefined && ![true, false, "json", "value"].includes(c.roundtrip as never))
    p('`roundtrip` must be true, false, "json" or "value"');
  if (c.strict !== undefined && typeof c.strict !== "boolean") p("`strict` must be a boolean");
  if (c.expect !== undefined) validateExpect(c.expect, p);
  validateKind(c, p);
}

function validateBytes(bytes: unknown, p: Report): void {
  if (typeof bytes === "string") {
    try {
      normalizeHex(bytes);
    } catch (e) {
      p(`bytes: ${(e as Error).message}`);
    }
  } else if (isPlainObject(bytes)) {
    if (typeof bytes.file !== "string" || bytes.file === "")
      p("bytes.file must be a non-empty string");
    for (const k of ["offset", "length"]) {
      const v = bytes[k];
      if (v !== undefined && !(Number.isInteger(v) && (v as number) >= 0))
        p(`bytes.${k} must be a non-negative integer`);
    }
    for (const k of Object.keys(bytes)) if (!BYTES_KEYS.includes(k)) p(`bytes: unknown key "${k}"`);
  } else {
    p("`bytes` must be a hex string or { file }");
  }
}

function validateExpect(expect: unknown, p: Report): void {
  if (!Array.isArray(expect)) {
    p("`expect` must be an array");
    return;
  }
  expect.forEach((x: unknown, j) => {
    if (x === null || typeof x !== "object") {
      p(`expect[${j}] must be an object`);
      return;
    }
    const e = x as Record<string, unknown>;
    if (typeof e.pointer !== "string" || (e.pointer !== "" && !e.pointer.startsWith("/")))
      p(`expect[${j}].pointer must be a JSON Pointer`);
    if (!EXPECT_CHECKS.some(k => k in e))
      p(`expect[${j}] has no check (${EXPECT_CHECKS.join(", ")})`);
    for (const k of Object.keys(e))
      if (k !== "pointer" && !EXPECT_CHECKS.includes(k)) p(`expect[${j}]: unknown key "${k}"`);
  });
}

/** Checks the fields that make a case a parse, serialize or error case. */
function validateKind(c: Record<string, unknown>, p: Report): void {
  if (c.error !== undefined) {
    const e = c.error as Record<string, unknown> | null;
    if (e === null || typeof e !== "object") {
      p("`error` must be an object");
      return;
    }
    if (e.phase !== "parse" && e.phase !== "serialize")
      p('error.phase must be "parse" or "serialize"');
    if (typeof e.code !== "string" || !(ERROR_CODES as readonly string[]).includes(e.code))
      p(`error.code must be one of ${ERROR_CODES.join(", ")}`);
    if (
      e.path !== undefined &&
      (!Array.isArray(e.path) || e.path.some(s => typeof s !== "string" && typeof s !== "number"))
    )
      p("error.path must be an array of strings and numbers");
    if (e.phase === "parse" && c.bytes === undefined) p("a parse error case needs `bytes`");
    if (e.phase === "serialize" && c.input === undefined) p("a serialize error case needs `input`");
    if (e.phase === "parse" && c.input !== undefined) p("a parse error case must not have `input`");
    if (c.json !== undefined) p("an error case must not have `json`");
  } else if (c.input !== undefined) {
    if (c.bytes === undefined) p("a serialize case needs the expected `bytes`");
    if (c.json !== undefined)
      p("a case has either `json` (parse) or `input` (serialize), not both");
    if (c.roundtrip !== undefined) p("`roundtrip` only applies to parse cases");
    if (c.expect !== undefined) p("`expect` only applies to parse cases");
  } else {
    if (c.bytes === undefined) p("a parse case needs `bytes`");
    if (c.json === undefined && c.expect === undefined && c.roundtrip === false)
      p("a parse case needs `json`, `expect` or a round trip");
  }
}

// ── yaffle.json externs ───────────────────────────────────────────────────────────────────────

/**
 * Resolves one extern spec from yaffle.json. A file path (starting with `./`, `../` or `/`) is made
 * absolute, keeping an optional `#ITEM` suffix (`./xor.rs#XOR`: the item in that file); anything
 * else (`crate::hash::fnv1a`, a package name) is passed through unchanged.
 */
export function resolveExternSpec(
  dir: string,
  spec: string,
  problems: string[],
  where: string
): string {
  if (!/^(\.{1,2}\/|\/)/.test(spec)) return spec;
  const hash = spec.indexOf("#");
  const path = hash < 0 ? spec : spec.slice(0, hash);
  const item = hash < 0 ? "" : spec.slice(hash);
  const abs = resolve(dir, path);
  if (!existsSync(abs)) problems.push(`yaffle.json: ${where}: ${path} does not exist`);
  return abs + item;
}

/** Reads yaffle.json `targets.<t>.externs` and resolves paths relative to the yaffle.json. */
export function loadExterns(
  dir: string,
  problems: string[]
): Record<string, Record<string, string>> {
  const file = join(dir, "yaffle.json");
  const out: Record<string, Record<string, string>> = {};
  if (!existsSync(file)) return out;
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    problems.push(`yaffle.json: ${(e as Error).message}`);
    return out;
  }
  const targets = (doc as { targets?: unknown }).targets;
  if (targets === null || typeof targets !== "object") {
    problems.push("yaffle.json: `targets` must be an object");
    return out;
  }
  for (const [target, cfg] of Object.entries(targets as Record<string, unknown>)) {
    const externs = (cfg as { externs?: unknown } | null)?.externs;
    if (externs === undefined) continue;
    if (externs === null || typeof externs !== "object") {
      problems.push(`yaffle.json: targets.${target}.externs must be an object`);
      continue;
    }
    const map: Record<string, string> = {};
    for (const [name, spec] of Object.entries(externs as Record<string, unknown>)) {
      const where = `targets.${target}.externs.${name}`;
      if (typeof spec === "string") map[name] = resolveExternSpec(dir, spec, problems, where);
      else problems.push(`yaffle.json: ${where} must be a string`);
    }
    out[target] = map;
  }
  return out;
}
