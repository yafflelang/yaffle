/**
 * A test harness crate: generated modules plus a `main.rs` that reads operations as JSON on
 * stdin and prints results as JSON. Used by the conformance adapter and the backend tests.
 *
 * Operations (`{ "ops": [ … ] }`):
 * - `{ "op": "parse", module, root, bytes: hex | { file }, args?, strict? }` → canonical JSON
 * - `{ "op": "serialize", module, root, json, args? }` → hex
 * - `{ "op": "rebuild", module, root, bytes, args?, strict? }` → hex of serialize(parse(bytes))
 * - `{ "op": "check", module, root, bytes, args? }` → `{ equal, inLen, outLen, firstDiff }` of
 *   serialize(parse(bytes)) against the input (for large files)
 * - `{ "op": "jsonRebuild", module, root, bytes, args? }` → hex of serialize(fromJson(toJson(parse(bytes))))
 * - `case:json` / `case:value` / `case:none` (conformance parse cases) → `{ json, rt }`: the JSON
 *   and the round trip through JSON text, through the value, or none (`rt` is `{ hex }`, a
 *   comparison for file inputs, `{ error }`, or null)
 * - `view:rt` / `view:none`: the same through a view (materialized, then committed unedited)
 *
 * Results: `{ "ok": true, "value": … }` or `{ "ok": false, "error": { code, path, offset, message } }`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IrProgram } from "../../ir/index.ts";
import { cargoToml, generateModule, runtimeCrateDir } from "./index.ts";
import { Model } from "./model.ts";
import { strLit } from "./names.ts";
import { cargo, cargoTargetDir, runBinaryLines } from "./toolchain.ts";

export interface HarnessModule {
  /** Rust module name. */
  name: string;
  program: IrProgram;
  /** Extern name → Rust path (e.g. `crate::codecs::Xor`). */
  externs?: Record<string, string>;
  /** Also generate views. */
  views?: boolean;
}

export interface HarnessSpec {
  dir: string;
  /** Crate (and binary) name; must be unique per harness sharing a target directory. */
  crateName: string;
  modules: HarnessModule[];
  /** Extra source files: module name → Rust source (declared as `mod <name>;`). */
  sources?: Record<string, string>;
  /** Extra `[dependencies]` lines. */
  extraDeps?: string[];
  /** Rust code appended to main.rs (e.g. `#[cfg(test)] mod tests { … }`). */
  tests?: string;
}

export interface Op {
  op:
    | "parse"
    | "serialize"
    | "rebuild"
    | "check"
    | "jsonRebuild"
    | "case:json"
    | "case:value"
    | "case:none"
    | "view:rt"
    | "view:none";
  module: string;
  root: string;
  bytes?: string | { file: string };
  json?: unknown;
  args?: Record<string, unknown>;
  strict?: boolean;
}

export type OpResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      error: { code: string; path: (string | number)[]; offset: number; message: string };
    };

function writeIfChanged(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && readFileSync(path, "utf8") === contents) return;
  writeFileSync(path, contents);
}

/** The `dispatch` arms of one root: every operation on it. */
function rootArms(mod: HarnessModule, rootName: string, t: string, params: string): string[] {
  const parse = (b: string) => `${t}::parse_with(&${b}, &yr::ParseOptions { strict }, &p)?`;
  const fromJson = (j: string) => `${t}::from_json(${j})?`;
  const arms = [
    `"parse" => Ok(${parse("bytes_of(input)?")}.to_json()),`,
    `"serialize" => Ok(hex(&${fromJson("input")}.serialize_with(&p)?)),`,
    `"rebuild" => Ok(hex(&${parse("bytes_of(input)?")}.serialize_with(&p)?)),`,
    `"jsonRebuild" => Ok(hex(&${fromJson(`&reparse(&${parse("bytes_of(input)?")}.to_json())?`)}.serialize_with(&p)?)),`,
    `"check" => { let b = bytes_of(input)?; let out = ${parse("b")}.serialize_with(&p)?; Ok(compare(&b, &out)) }`,
    `"case:json" | "case:value" | "case:none" => {`,
    `    let b = bytes_of(input)?;`,
    `    let v = ${parse("b")};`,
    `    let j = v.to_json();`,
    `    let out = match op {`,
    `        "case:json" => Some(reparse(&j).and_then(|back| ${t}::from_json(&back)).and_then(|v2| v2.serialize_with(&p))),`,
    `        "case:value" => Some(v.serialize_with(&p)),`,
    `        _ => None,`,
    `    };`,
    `    Ok(case_result(j, out, &b, input))`,
    `}`
  ];
  if (mod.views)
    // View mode (CONFORMANCE.md §7): every field read through the view, committed unedited.
    arms.push(
      `"view:rt" | "view:none" => {`,
      `    let opts = yr::ParseOptions { strict };`,
      `    let v = match input.get("file").and_then(|f| f.as_str()) {`,
      `        Some(path) => ${t}::view_source(Box::new(yr::FileSource::open(path).map_err(|e| yr::YaffleError::input(format!("{path}: {e}")))?), &opts, &p)?,`,
      `        None => ${t}::view_with(bytes_of(input)?, &opts, &p)?,`,
      `    };`,
      `    let j = v.materialize()?.to_json();`,
      `    let out = if op == "view:rt" { Some(v.commit()) } else { None };`,
      `    let b = if out.is_some() { bytes_of(input)? } else { Vec::new() };`,
      `    Ok(case_result(j, out, &b, input))`,
      `}`
    );
  arms.push(`_ => Err(yr::YaffleError::input(format!("unknown op {op}"))),`);
  return [
    `(${strLit(mod.name)}, ${strLit(rootName)}) => {`,
    `    let p = ${params}::from_json(args)?;`,
    "    match op {",
    ...arms.map(a => "        " + a),
    "    }",
    "}"
  ];
}

function mainRs(spec: HarnessSpec): string {
  const arms: string[] = [];
  for (const mod of spec.modules) {
    const m = new Model(mod.program, mod.externs ?? {});
    for (const r of mod.program.roots) {
      const t = `${mod.name}::${m.struct(r.struct).name}`;
      arms.push(...rootArms(mod, r.name, t, `${mod.name}::${m.paramsNames.get(r.struct)!}`));
    }
  }
  const mods = [...spec.modules.map(m => m.name), ...Object.keys(spec.sources ?? {})];
  return `// Generated test harness. Do not edit.
#![allow(dead_code, unused_imports, unused_variables)]
use yaffle as yr;
${mods.map(m => `mod ${m};`).join("\n")}

fn bytes_of(v: &yr::Value) -> yr::Result<Vec<u8>> {
    match v {
        yr::Value::Str(s) => yr::json::unhex(s).map_err(yr::YaffleError::input),
        _ => match v.get("file").and_then(|f| f.as_str()) {
            Some(path) => std::fs::read(path).map_err(|e| yr::YaffleError::input(format!("{path}: {e}"))),
            None => Err(yr::YaffleError::input("bytes must be hex or { file }")),
        },
    }
}

fn hex(b: &[u8]) -> yr::Value {
    yr::Value::Str(yr::json::hex(b))
}

/// JSON printed as text and parsed again.
fn reparse(j: &yr::Value) -> yr::Result<yr::Value> {
    yr::json::parse(&j.to_string()).map_err(yr::YaffleError::input)
}

/// A parse case's JSON and round trip: hex for hex inputs, a comparison for files (huge data).
fn case_result(j: yr::Value, out: Option<yr::Result<Vec<u8>>>, input: &[u8], given: &yr::Value) -> yr::Value {
    let rt = match out {
        None => yr::Value::Null,
        Some(Err(e)) => yr::json::obj(vec![("error", error_json(&e))]),
        Some(Ok(bytes)) => {
            if given.get("file").is_some() { compare(input, &bytes) } else { yr::json::obj(vec![("hex", hex(&bytes))]) }
        }
    };
    yr::json::obj(vec![("json", j), ("rt", rt)])
}

fn compare(a: &[u8], b: &[u8]) -> yr::Value {
    let first = a.iter().zip(b.iter()).position(|(x, y)| x != y).or(if a.len() != b.len() { Some(a.len().min(b.len())) } else { None });
    yr::json::obj(vec![
        ("equal", yr::Value::Bool(a == b)),
        ("inLen", yr::Value::Int(a.len() as i128)),
        ("outLen", yr::Value::Int(b.len() as i128)),
        ("firstDiff", match first { Some(i) => yr::Value::Int(i as i128), None => yr::Value::Null }),
    ])
}

fn dispatch(module: &str, root: &str, op: &str, input: &yr::Value, args: &yr::Value, strict: bool) -> yr::Result<yr::Value> {
    match (module, root) {
${arms.map(a => "        " + a).join("\n")}
        _ => Err(yr::YaffleError::input(format!("unknown root {module}::{root}"))),
    }
}

fn error_json(e: &yr::YaffleError) -> yr::Value {
    let path = e.path.iter().map(|p| match p {
        yr::PathSeg::Field(f) => yr::Value::Str(f.clone()),
        yr::PathSeg::Index(i) => yr::Value::Int(*i as i128),
    }).collect();
    yr::json::obj(vec![
        ("code", yr::Value::Str(e.code.as_str().to_string())),
        ("path", yr::Value::Array(path)),
        ("offset", yr::Value::Int(e.offset_i64() as i128)),
        ("message", yr::Value::Str(e.to_string())),
    ])
}

fn main() {
    use std::io::{Read, Write};
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text).expect("stdin");
    let req = yr::json::parse(&text).expect("request JSON");
    let ops = req.get("ops").and_then(|o| o.as_array()).cloned().unwrap_or_default();
    std::panic::set_hook(Box::new(|_| {}));
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    for op in &ops {
        let s = |k: &str| op.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let (module, root, kind) = (s("module"), s("root"), s("op"));
        let input = op.get(if kind == "serialize" { "json" } else { "bytes" }).cloned().unwrap_or(yr::Value::Null);
        let args = op.get("args").cloned().unwrap_or(yr::Value::Object(vec![]));
        let strict = op.get("strict").and_then(|v| v.as_bool()).unwrap_or(false);
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| dispatch(&module, &root, &kind, &input, &args, strict)));
        let line = match r {
            Ok(Ok(v)) => yr::json::obj(vec![("ok", yr::Value::Bool(true)), ("value", v)]),
            Ok(Err(e)) => yr::json::obj(vec![("ok", yr::Value::Bool(false)), ("error", error_json(&e))]),
            Err(p) => {
                let msg = p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
                yr::json::obj(vec![("ok", yr::Value::Bool(false)), ("error", yr::json::obj(vec![
                    ("code", yr::Value::Str("PANIC".into())), ("path", yr::Value::Array(vec![])),
                    ("offset", yr::Value::Int(-1)), ("message", yr::Value::Str(msg)),
                ]))])
            }
        };
        // One result per line: results can be huge (real files), and are parsed one by one.
        writeln!(out, "{line}").expect("stdout");
    }
    out.flush().expect("stdout");
}
${spec.tests ?? ""}
`;
}

/** Writes the harness crate (only files whose contents changed, to keep builds incremental). */
export function writeHarness(spec: HarnessSpec): void {
  writeIfChanged(
    join(spec.dir, "Cargo.toml"),
    cargoToml(spec.crateName, runtimeCrateDir(), spec.extraDeps ?? [])
  );
  writeIfChanged(join(spec.dir, "src/main.rs"), mainRs(spec));
  for (const mod of spec.modules) {
    writeIfChanged(
      join(spec.dir, `src/${mod.name}.rs`),
      generateModule(mod.program, mod.externs ?? {}, "::yaffle", [], {
        views: mod.views === true
      })
    );
  }
  for (const [name, src] of Object.entries(spec.sources ?? {}))
    writeIfChanged(join(spec.dir, `src/${name}.rs`), src);
}

export interface BuildResult {
  ok: boolean;
  bin: string;
  /** Compiler output (errors and warnings). */
  log: string;
  warnings: number;
}

/** Builds the harness binary. */
export async function buildHarness(spec: HarnessSpec, release = false): Promise<BuildResult> {
  writeHarness(spec);
  const args = ["build", "--quiet", "--message-format", "short"];
  if (release) args.push("--release");
  const r = await cargo(spec.dir, args);
  const bin = join(cargoTargetDir(), release ? "release" : "debug", spec.crateName);
  const warnings = (r.stderr.match(/warning:/g) ?? []).length;
  return { ok: r.code === 0, bin, log: r.stderr, warnings };
}

/** Runs the harness crate's Rust tests (`tests` in the spec). */
export async function testHarness(
  spec: HarnessSpec
): Promise<{ ok: boolean; output: string; passed: number; failed: number }> {
  writeHarness(spec);
  const r = await cargo(spec.dir, ["test", "--quiet", "--message-format", "short"]);
  const out = r.stdout + r.stderr;
  const m = /test result: \w+\. (\d+) passed; (\d+) failed/.exec(out);
  return {
    ok: r.code === 0,
    output: out,
    passed: m ? Number(m[1]) : 0,
    failed: m ? Number(m[2]) : 0
  };
}

/** Runs operations on a built harness. */
export async function runOps(bin: string, ops: Op[]): Promise<OpResult[]> {
  const r = await runBinaryLines(bin, JSON.stringify({ ops }));
  if (r.code !== 0) throw new Error(`harness failed (${r.code}): ${r.stderr}`);
  return r.lines.map(l => JSON.parse(l) as OpResult);
}
