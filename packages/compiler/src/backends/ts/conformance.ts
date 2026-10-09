/**
 * Conformance adapter for the TS target (docs/CONFORMANCE.md, conformance/src/adapter.ts):
 * generates the case directory's program into `workDir`, imports the generated modules and runs
 * every case through the generated API. Returns the actual JSON, bytes and error of every case;
 * the runner re-checks them.
 */
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { IrProgram } from "../../ir/index.ts";
import { typeName } from "./code.ts";
import { generateTs } from "./index.ts";
import { moduleFile } from "./module.ts";

// Structural copies of conformance/src/adapter.ts (the compiler package cannot import it).
export type RoundTrip = boolean | "json" | "value";

export interface Case {
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

export interface CaseError {
  phase: "parse" | "serialize";
  code: string;
  path?: (string | number)[];
  offset?: number;
  message?: string;
}

export interface CaseResult {
  name: string;
  ok: boolean;
  message?: string;
  skipped?: string;
  json?: unknown;
  bytes?: string;
  error?: CaseError;
}

export interface AdapterRunInput {
  caseDir: string;
  program: IrProgram;
  cases: Case[];
  workDir: string;
  externs?: Record<string, string>;
  /** "view": read every parse case through the lazy view (docs/CONFORMANCE.md §7). */
  mode?: "parse" | "view";
}

export interface ConformanceAdapter {
  target: string;
  capabilities?: { views?: boolean };
  available(): Promise<boolean>;
  run(input: AdapterRunInput): Promise<CaseResult[]>;
}

interface RootApi {
  view?(source: unknown, options?: object): unknown;
  viewAsync(source: unknown, options?: object): unknown;
  parse?(bytes: Uint8Array, options?: object): unknown;
  parseAsync(bytes: Uint8Array, options?: object): Promise<unknown>;
  serialize?(value: unknown, options?: object): Uint8Array;
  serializeAsync(value: unknown, options?: object): Promise<Uint8Array>;
  toJson(value: unknown): unknown;
  fromJson(json: unknown): unknown;
  optionsFromJson(json: unknown): object;
}

/** Byte outputs larger than this are left out of results (large sample files). */
const MAX_HEX_BYTES = 1 << 20;

const runtimeEntry = (): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../../runtime/src/index.ts");

function hex(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("hex");
}

function fromHex(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s.replace(/[\s_]+/g, ""), "hex"));
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.compare(a, b) === 0;
}

/** Deep equality of JSON values; returns a description of the first difference, or undefined. */
export function jsonDiff(a: unknown, b: unknown, path = ""): string | undefined {
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
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) {
    if (!(k in ao)) return `${path}/${k}: missing`;
    if (!(k in bo)) return `${path}/${k}: unexpected`;
    const d = jsonDiff(ao[k], bo[k], `${path}/${k}`);
    if (d) return d;
  }
  return undefined;
}

function canonical(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v));
}

/** Fallback for runners that pass no extern map: the case directory's yaffle.json. */
function externsFromConfig(caseDir: string): Record<string, string> {
  const cfg = join(caseDir, "yaffle.json");
  let text: string;
  try {
    text = readFileSync(cfg, "utf8");
  } catch {
    return {};
  }
  const json = JSON.parse(text) as { targets?: { ts?: { externs?: Record<string, string> } } };
  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries(json.targets?.ts?.externs ?? {})) {
    out[name] = /^\.\.?\//.test(spec) || spec.startsWith("/") ? resolve(dirname(cfg), spec) : spec;
  }
  return out;
}

function errorOf(e: unknown, phase: Phase): CaseError | undefined {
  const err = e as { code?: unknown; path?: unknown; offset?: unknown; message?: unknown };
  if (!err || typeof err.code !== "string") return undefined;
  const out: CaseError = { phase, code: err.code };
  if (Array.isArray(err.path)) out.path = err.path as (string | number)[];
  if (typeof err.offset === "number") out.offset = err.offset;
  if (typeof err.message === "string") out.message = err.message;
  return out;
}

function notImplemented(e: unknown): string | undefined {
  const msg = e instanceof Error ? e.message : String(e);
  return /not implemented|not supported/i.test(msg) ? msg : undefined;
}

type Phase = "parse" | "serialize";

function caseOptions(c: Case, api: RootApi): Record<string, unknown> {
  const options: Record<string, unknown> = { ...api.optionsFromJson(c.args ?? {}) };
  if (c.strict) options.strict = true;
  return options;
}

/** Undefined if `out` equals `expected`, else where they first differ. */
function bytesDiffer(what: string, out: Uint8Array, expected: Uint8Array): string | undefined {
  if (equalBytes(out, expected)) return undefined;
  let i = 0;
  while (i < out.length && i < expected.length && out[i] === expected[i]) i++;
  return `${what}: bytes differ at offset 0x${i.toString(16)} (expected ${expected.length} bytes, got ${out.length})`;
}

/**
 * The result of a case that threw `e` in `phase`: it passes if the case expects that error. In
 * view mode every error counts as a read error and the expected phase is not compared.
 */
function caughtResult(
  result: CaseResult,
  c: Case,
  e: unknown,
  phase: Phase,
  view: boolean
): CaseResult {
  const err = errorOf(e, phase);
  const ni = notImplemented(e);
  if (!err) {
    if (ni) return { ...result, skipped: ni };
    return {
      ...result,
      message: `unexpected exception: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`
    };
  }
  result.error = err;
  const detail = err.message ?? "";
  if (!c.error) {
    if (ni && !view) return { ...result, skipped: ni };
    return {
      ...result,
      message: `unexpected ${err.code} error in ${view ? "the view" : phase}: ${detail}`
    };
  }
  if (!view && c.error.phase !== phase) {
    return {
      ...result,
      message: `expected a ${c.error.phase} error, got ${err.code} in ${phase}: ${detail}`
    };
  }
  if (err.code !== c.error.code) {
    return { ...result, message: `expected ${c.error.code}, got ${err.code}: ${detail}` };
  }
  if (c.error.path && JSON.stringify(err.path) !== JSON.stringify(c.error.path)) {
    return {
      ...result,
      message: `expected path ${JSON.stringify(c.error.path)}, got ${JSON.stringify(err.path)} (${detail})`
    };
  }
  return { ...result, ok: true };
}

async function runCase(c: Case, api: RootApi, isAsync: boolean): Promise<CaseResult> {
  const result: CaseResult = { name: c.name, ok: false };
  const options = caseOptions(c, api);
  const bytes =
    c.bytes === undefined
      ? undefined
      : typeof c.bytes === "string"
        ? fromHex(c.bytes)
        : new Uint8Array(readFileSync(c.bytes.file));
  const parse = async (b: Uint8Array): Promise<unknown> =>
    isAsync || !api.parse ? api.parseAsync(b, options) : api.parse(b, options);
  const serialize = async (v: unknown): Promise<Uint8Array> =>
    isAsync || !api.serialize ? api.serializeAsync(v, options) : api.serialize(v, options);
  const setBytes = (out: Uint8Array): void => {
    if (out.length <= MAX_HEX_BYTES) result.bytes = hex(out);
  };
  let phase: Phase = c.input !== undefined ? "serialize" : "parse";

  try {
    if (c.input !== undefined) {
      phase = "serialize";
      const out = await serialize(api.fromJson(c.input));
      setBytes(out);
      if (c.error)
        return { ...result, message: `expected ${c.error.code}, but serialize succeeded` };
      if (!bytes) return { ...result, message: "serialize case without bytes" };
      if (!equalBytes(out, bytes)) {
        return {
          ...result,
          message: `serialize: expected ${hex(bytes)}, got ${result.bytes ?? "(large)"}`
        };
      }
      return { ...result, ok: true };
    }
    if (!bytes) return { ...result, message: "parse case without bytes" };
    phase = "parse";
    const value = await parse(bytes);
    result.json = canonical(api.toJson(value));
    if (c.error?.phase === "parse")
      return { ...result, message: `expected ${c.error.code}, but parse succeeded` };
    if (c.json !== undefined) {
      const d = jsonDiff(result.json, c.json);
      if (d) return { ...result, message: `parse: ${d}` };
    }
    const rt = c.error?.phase === "serialize" ? "json" : (c.roundtrip ?? true);
    if (rt !== false) {
      phase = "serialize";
      const input = rt === "value" ? value : api.fromJson(c.json ?? result.json);
      const out = await serialize(input);
      setBytes(out);
      if (c.error?.phase === "serialize") {
        return { ...result, message: `expected ${c.error.code}, but serialize succeeded` };
      }
      const d = bytesDiffer("roundtrip", out, bytes);
      if (d) return { ...result, message: d };
    }
    return { ...result, ok: true };
  } catch (e) {
    return caughtResult(result, c, e, phase, false);
  }
}

/** A random-access source over a file (positional reads), for view mode. */
function fileSource(path: string): {
  size: number;
  read(o: number, n: number): Uint8Array;
  close(): void;
} {
  const fd = openSync(path, "r");
  const size = fstatSync(fd).size;
  return {
    size,
    read(offset: number, length: number): Uint8Array {
      const out = new Uint8Array(length);
      let done = 0;
      while (done < length) {
        const n = readSync(fd, out, done, length - done, offset + done);
        if (n === 0) throw new Error(`short read at ${offset + done}`);
        done += n;
      }
      return out;
    },
    close() {
      closeSync(fd);
    }
  };
}

interface ViewLike {
  $commit(opts?: { rewrite?: boolean }): Uint8Array;
}
interface AsyncViewLike {
  $read<T>(f: (v: unknown) => T): Promise<T>;
  $patches(opts?: {
    rewrite?: boolean;
  }): Promise<{ at: number; remove: number; insert: Uint8Array }[]>;
}

/**
 * `YAFFLE_TS_VIEW_REWRITE=1`: commit with `{ rewrite: true }`, so the view is re-encoded through
 * the writer (the structural-edit path) instead of only applying its (empty) in-place patches.
 */
const COMMIT_OPTIONS = process.env.YAFFLE_TS_VIEW_REWRITE === "1" ? { rewrite: true } : undefined;

/**
 * View mode (docs/CONFORMANCE.md §7): the case's bytes (or a positional-read source over its file)
 * are opened as a lazy view; the JSON is the canonical JSON read through the view, and the bytes
 * are the commit of the view with no edits.
 */
async function runViewCase(
  c: Case,
  api: RootApi,
  isAsync: boolean,
  rt: { applyPatches(orig: Uint8Array, p: readonly unknown[]): Uint8Array }
): Promise<CaseResult> {
  const result: CaseResult = { name: c.name, ok: false };
  const options = caseOptions(c, api);
  if (c.bytes === undefined) return { ...result, message: "view case without bytes" };
  const file = typeof c.bytes === "string" ? undefined : fileSource(c.bytes.file);
  const bytes = typeof c.bytes === "string" ? fromHex(c.bytes) : undefined;
  const source = bytes ?? file!;
  const original = (): Uint8Array =>
    bytes ?? new Uint8Array(readFileSync((c.bytes as { file: string }).file));
  try {
    let out: Uint8Array;
    if (isAsync || !api.view) {
      const av = api.viewAsync(source, options) as AsyncViewLike;
      result.json = canonical(await av.$read(v => api.toJson(v)));
      if (c.error?.phase === "parse")
        return { ...result, message: `expected ${c.error.code}, but reading the view succeeded` };
      const patches = c.roundtrip === false ? [] : await av.$patches(COMMIT_OPTIONS);
      out = patches.length ? rt.applyPatches(original(), patches) : original();
    } else {
      const v = api.view(source, options) as ViewLike;
      result.json = canonical(api.toJson(v));
      if (c.error?.phase === "parse")
        return { ...result, message: `expected ${c.error.code}, but reading the view succeeded` };
      out = c.roundtrip === false ? original() : v.$commit(COMMIT_OPTIONS);
    }
    if (c.json !== undefined) {
      const d = jsonDiff(result.json, c.json);
      if (d) return { ...result, message: `view: ${d}` };
    }
    if (c.roundtrip !== false) {
      if (out.length <= MAX_HEX_BYTES) result.bytes = hex(out);
      const d = bytesDiffer("commit", out, original());
      if (d) return { ...result, message: d };
    }
    return { ...result, ok: true };
  } catch (e) {
    return caughtResult(result, c, e, "parse", true);
  } finally {
    file?.close();
  }
}

export const adapter: ConformanceAdapter = {
  target: "ts",
  capabilities: { views: true },
  async available() {
    return true;
  },
  async run({ caseDir, program, cases, workDir, externs, mode }) {
    const view = mode === "view";
    const rt = view
      ? ((await import(pathToFileURL(runtimeEntry()).href)) as {
          applyPatches(orig: Uint8Array, p: readonly unknown[]): Uint8Array;
        })
      : undefined;
    let files;
    try {
      files = generateTs(program, {
        externs: externs ?? externsFromConfig(caseDir),
        targetOptions: { runtimeModule: runtimeEntry() }
      });
    } catch (e) {
      const ni = notImplemented(e);
      if (ni) return cases.map(c => ({ name: c.name, ok: false, skipped: ni }));
      throw e;
    }
    for (const f of files) {
      const p = join(workDir, f.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.contents);
    }
    const modules = new Map<string, Record<string, unknown>>();
    const results: CaseResult[] = [];
    for (const c of cases) {
      const root =
        program.roots.find(r => r.name === c.root) ?? program.roots.find(r => r.struct === c.root);
      if (!root) {
        results.push({ name: c.name, ok: false, message: `unknown root ${c.root}` });
        continue;
      }
      const s = program.structs.find(x => x.id === root.struct);
      const modPath = s?.module ?? root.module;
      const mod = program.modules.find(m => m.path === modPath || m.name === modPath);
      const file = join(workDir, moduleFile(mod ? mod.name : modPath.replace(/\.yfl$/, "")));
      let ns = modules.get(file);
      if (!ns) {
        try {
          ns = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
        } catch (e) {
          results.push({
            name: c.name,
            ok: false,
            message: `cannot import generated code: ${(e as Error).message}`
          });
          continue;
        }
        modules.set(file, ns);
      }
      const api = ns[typeName(root.name)] as RootApi | undefined;
      if (!api) {
        results.push({ name: c.name, ok: false, message: `generated module has no ${root.name}` });
        continue;
      }
      results.push(
        view
          ? await runViewCase(c, api, s?.async ?? false, rt!)
          : await runCase(c, api, s?.async ?? false)
      );
    }
    return results;
  }
};
