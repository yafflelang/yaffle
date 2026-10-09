/**
 * Per-output-module bookkeeping: hoisted constants, imports of other generated modules (as module
 * objects, so import cycles between modules work), extern loading and stdlib imports.
 */
import { pyStr } from "./code.ts";
import type { ExprCtx } from "./expr.ts";
import type { Model } from "./model.ts";
import { moduleSegments, type Names } from "./names.ts";

export interface EmitOptions {
  /** extern name → module path (relative to the output root) or module name, optional `#Item`. */
  externs: Record<string, string>;
  /** Python module the runtime is imported from. */
  runtime: string;
  /** True when `runtime` is a relative import (the inlined runtime). */
  runtimeRelative: boolean;
}

export class ModuleCtx {
  readonly model: Model;
  readonly names: Names;
  private readonly segments: string[];
  private readonly opts: EmitOptions;
  private readonly hoisted = new Map<string, string>();
  readonly hoistedLines: string[] = [];
  private readonly imports = new Map<string, string>();
  private readonly externLocals = new Map<string, string>();
  private readonly stdlib = new Set<string>();
  /** IR module path or name → output module name. */
  private readonly moduleNames: Map<string, string>;
  private readonly moduleName: string;

  constructor(
    model: Model,
    names: Names,
    module: string,
    moduleNames: Map<string, string>,
    opts: EmitOptions
  ) {
    this.model = model;
    this.names = names;
    this.moduleNames = moduleNames;
    this.moduleName = moduleNames.get(module) ?? module;
    this.segments = moduleSegments(this.moduleName);
    this.opts = opts;
  }

  /** Hoists a module-level constant and returns its name. */
  hoist(code: string, hint: string): string {
    const hit = this.hoisted.get(code);
    if (hit) return hit;
    const name = `_K_${hint}${this.hoisted.size + 1}`;
    this.hoisted.set(code, name);
    this.hoistedLines.push(`${name} = ${code}`);
    return name;
  }

  /** Requests a stdlib import (only `re` is imported on demand). */
  need(mod: string): void {
    this.stdlib.add(mod);
  }

  /** A name defined by the generated module of IR module `module` (qualified if needed). */
  use(module: string, name: string): string {
    const key = this.moduleNames.get(module) ?? module;
    if (key === this.moduleName) return name;
    let alias = this.imports.get(key);
    if (!alias) {
      const base = `_m_${moduleSegments(key).join("_")}`;
      const taken = new Set(this.imports.values());
      alias = base;
      for (let k = 2; taken.has(alias); k++) alias = `${base}${k}`;
      this.imports.set(key, alias);
    }
    return `${alias}.${name}`;
  }

  structClass(id: string): string {
    return this.use(this.model.struct(id).module, this.names.structClass(id));
  }

  /** A per-struct function (`_read_X`, `_write_X`, `_to_json_X`, `_view_X`, …). */
  structFn(id: string, kind: string): string {
    return this.use(this.model.struct(id).module, `_${kind}_${this.names.structClass(id)}`);
  }

  enumRef(id: string, what: "class" | "members" | "values" | "names"): string {
    const cls = this.names.enumClass(id);
    return this.use(this.model.enum(id).module, what === "class" ? cls : `_E_${cls}_${what}`);
  }

  enumMember(id: string, member: string): string {
    return `${this.enumRef(id, "class")}.${this.names.member(this.model.enum(id), member)}`;
  }

  /** Local name of an extern's host implementation. */
  extern(id: string): string {
    const hit = this.externLocals.get(id);
    if (hit) return hit;
    const local = `_ext_${this.model.extern(id).name.replace(/\W/g, "_")}`;
    this.externLocals.set(id, local);
    return local;
  }

  /** The parts of an expression context every struct of this module shares. */
  exprBase(): Pick<
    ExprCtx,
    "externFn" | "hoist" | "enumRef" | "enumMember" | "attr" | "need" | "toJson"
  > {
    return {
      externFn: id => this.extern(id),
      hoist: (code, hint) => this.hoist(code, hint),
      enumRef: (id, what) => this.enumRef(id, what),
      enumMember: (id, m) => this.enumMember(id, m),
      attr: (sid, name) => this.names.attr(this.model.struct(sid), name),
      need: m => this.need(m),
      toJson: id => this.structFn(id, "to_json")
    };
  }

  /** Import lines for the top of the module. */
  importLines(): string[] {
    const lines = [
      "from __future__ import annotations",
      "",
      "import enum as _enum",
      ...(this.stdlib.has("re") ? ["import re as _re"] : []),
      "import typing as _t",
      "from dataclasses import dataclass as _dataclass, field as _field",
      "",
      this.opts.runtimeRelative
        ? `from ${".".repeat(this.segments.length)} import ${this.opts.runtime} as _rt`
        : `import ${this.opts.runtime} as _rt`
    ];
    for (const [key, alias] of [...this.imports].sort((a, b) => a[1].localeCompare(b[1]))) {
      lines.push(this.relativeImport(moduleSegments(key), alias));
    }
    return lines;
  }

  /** `from ..pkg import mod as alias` from this module to `target`. */
  private relativeImport(target: string[], alias: string): string {
    const fromPkg = this.segments.slice(0, -1);
    const toPkg = target.slice(0, -1);
    let i = 0;
    while (i < fromPkg.length && i < toPkg.length && fromPkg[i] === toPkg[i]) i++;
    const dots = ".".repeat(1 + fromPkg.length - i);
    const rest = toPkg.slice(i).join(".");
    return `from ${dots}${rest} import ${target[target.length - 1]} as ${alias}`;
  }

  /** Extern loading lines (after the imports). */
  externLines(): string[] {
    const lines: string[] = [];
    const depth = this.segments.length - 1;
    for (const [id, local] of this.externLocals) {
      const x = this.model.extern(id);
      const spec = this.opts.externs[x.name] ?? this.opts.externs[id];
      if (spec === undefined) {
        const impl =
          x.kind === "type" && x.builtin ? `_rt.${x.name}` : `_rt.missing_extern(${pyStr(x.name)})`;
        lines.push(`${local}: _t.Any = ${impl}`);
        continue;
      }
      const hash = spec.lastIndexOf("#");
      let file = hash > 0 ? spec.slice(0, hash) : spec;
      const item = hash > 0 ? spec.slice(hash + 1) : x.name;
      // Relative paths are relative to the output root; make them relative to this module.
      if (/^\.\.?\//.test(file)) file = "../".repeat(depth) + file;
      lines.push(`${local}: _t.Any = _rt.load_extern(__file__, ${pyStr(file)}, ${pyStr(item)})`);
    }
    return lines;
  }
}
