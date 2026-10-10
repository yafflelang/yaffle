/**
 * Per-output-file bookkeeping: hoisted package-level variables, imports, extern references.
 * Every IR module becomes one .go file of the same package.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { IrExtern } from "../../ir/index.ts";
import { goStr } from "./code.ts";
import type { Model } from "./model.ts";

/** How an extern is reached from generated code. */
export interface ExternRef {
  /** Go expression naming the implementation. */
  expr: string;
  /** Import needed (path → alias). */
  importPath?: string;
  alias?: string;
  /** A file to copy into the generated package. */
  file?: string;
  /** No implementation: a placeholder is generated. */
  missing?: boolean;
}

/** Resolves an extern spec. File paths become files of the generated package. */
export function resolveExtern(
  x: IrExtern,
  spec: string | undefined,
  aliasOf: (path: string) => string
): ExternRef {
  if (spec === undefined) {
    if (x.kind === "type" && x.builtin)
      return { expr: x.name === "sleb128" ? "yaffle.Sleb128" : "yaffle.Uleb128" };
    return { expr: `missing_${x.name.replace(/[^A-Za-z0-9_]/g, "_")}`, missing: true };
  }
  const hash = spec.lastIndexOf("#");
  const file = hash >= 0 ? spec.slice(0, hash) : spec;
  const item = hash >= 0 ? spec.slice(hash + 1) : x.name;
  const isFile =
    file.endsWith(".go") || isAbsolute(file) || file.startsWith("./") || file.startsWith("../");
  if (isFile) return { expr: item, file };
  // importpath.Name
  const slash = spec.lastIndexOf("/");
  const dot = spec.lastIndexOf(".");
  if (dot > slash && dot > 0) {
    return {
      expr: `${aliasOf(spec.slice(0, dot))}.${spec.slice(dot + 1)}`,
      importPath: spec.slice(0, dot),
      alias: aliasOf(spec.slice(0, dot))
    };
  }
  return { expr: spec };
}

/** Reads an extern file to copy into the generated package, rewriting its package clause. */
export function externFileContents(file: string, pkg: string): string | undefined {
  const path = isAbsolute(file) ? file : resolve(file);
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  return text.replace(/^package\s+\w+/m, `package ${pkg}`);
}

/** One generated file: its imports and hoisted package-level variables. */
export class ModuleCtx {
  readonly model: Model;
  /** Import path of the runtime package. */
  readonly runtime: string;
  private readonly imports = new Map<string, string | undefined>();
  private readonly hoisted = new Map<string, string>();
  readonly hoistedLines: string[] = [];
  private readonly externs: Map<string, ExternRef>;

  constructor(model: Model, runtime: string, externs: Map<string, ExternRef>) {
    this.model = model;
    this.runtime = runtime;
    this.externs = externs;
  }

  use(pkg: string, alias?: string): void {
    this.imports.set(pkg, alias);
  }

  hoist(code: string, hint: string): string {
    const hit = this.hoisted.get(code);
    if (hit) return hit;
    const name = `${hint}${++this.model.hoistCounter.n}`;
    this.hoisted.set(code, name);
    this.hoistedLines.push(`var ${name} = ${code}`);
    return name;
  }

  /** Go expression of an extern's implementation. */
  extern(id: string): string {
    const r = this.externs.get(id);
    if (!r) throw new Error(`unknown extern ${id}`);
    if (r.importPath) this.use(r.importPath, r.alias);
    return r.expr;
  }

  importBlock(): string[] {
    // The runtime's package is named `yaffle`; name it explicitly when the import path ends
    // differently (yafflelang.org/runtime).
    this.use(this.runtime, this.runtime.split("/").pop() === "yaffle" ? undefined : "yaffle");
    const std: string[] = [];
    const other: string[] = [];
    for (const [p, alias] of [...this.imports].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
    )) {
      const line = `${alias ? `${alias} ` : ""}${goStr(p)}`;
      if (p.includes(".") && p.split("/")[0]!.includes(".")) other.push(line);
      else std.push(line);
    }
    const lines = ["import ("];
    for (const l of std) lines.push(`\t${l}`);
    if (std.length && other.length) lines.push("");
    for (const l of other) lines.push(`\t${l}`);
    lines.push(")");
    return lines;
  }
}
