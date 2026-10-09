/**
 * Per-output-module bookkeeping: hoisted constants, imports of other generated modules, extern
 * imports. Shared by every emitter.
 */
import type { IrModule } from "../../ir/index.ts";
import { ident, relImport, str, typeName } from "./code.ts";
import type { Model } from "./model.ts";

export interface EmitOptions {
  /** Module specifier of the runtime as seen from the output root ("@yaffle/runtime" by default). */
  runtime: string;
  /** True if `runtime` is a path relative to the output root (needs re-relativizing per file). */
  runtimeRelative: boolean;
  /** extern name → module specifier (relative paths are relative to the output root). */
  externs: Record<string, string>;
}

export function moduleFile(m: IrModule | string): string {
  const name = typeof m === "string" ? m : m.name;
  return `${name.replace(/^\/+/, "")}.ts`;
}

export class ModuleCtx {
  readonly model: Model;
  readonly module: string;
  readonly file: string;
  readonly opts: EmitOptions;
  private readonly hoisted = new Map<string, string>();
  readonly hoistedLines: string[] = [];
  /** file → names imported from that generated module. */
  private readonly imports = new Map<string, Set<string>>();
  private readonly typeImports = new Map<string, Set<string>>();
  private readonly externLocals = new Map<string, string>();
  private hoistCount = 0;

  constructor(model: Model, module: string, opts: EmitOptions) {
    this.model = model;
    this.module = module;
    this.file = moduleFile(this.moduleName(module));
    this.opts = opts;
  }

  private moduleName(path: string): string {
    const m = this.model.program.modules.find(x => x.path === path || x.name === path);
    return m ? m.name : path.replace(/\.yfl$/, "");
  }

  hoist(code: string, hint: string): string {
    const hit = this.hoisted.get(code);
    if (hit) return hit;
    const name = `$${hint}${++this.hoistCount}`;
    this.hoisted.set(code, name);
    this.hoistedLines.push(`const ${name} = ${code};`);
    return name;
  }

  /** A function or value defined by the generated module of `module` (imported if needed). */
  use(module: string, name: string): string {
    if (module === this.module) return name;
    const file = moduleFile(this.moduleName(module));
    let set = this.imports.get(file);
    if (!set) this.imports.set(file, (set = new Set()));
    set.add(name);
    return name;
  }

  /** A type defined by another generated module. */
  useType(module: string, name: string): string {
    if (module === this.module) return name;
    const file = moduleFile(this.moduleName(module));
    let set = this.typeImports.get(file);
    if (!set) this.typeImports.set(file, (set = new Set()));
    set.add(name);
    return name;
  }

  structFn(id: string, kind: string): string {
    const s = this.model.struct(id);
    return this.use(s.module, `${kind}_${typeName(s.name)}`);
  }

  enumRef(id: string, what: "names" | "values"): string {
    const e = this.model.enum(id);
    return this.use(e.module, `$enum_${typeName(e.name)}_${what}`);
  }

  /** Local name of an extern's host implementation. */
  extern(id: string): string {
    const hit = this.externLocals.get(id);
    if (hit) return hit;
    const x = this.model.extern(id);
    const local = `$ext_${ident(x.name)}`;
    this.externLocals.set(id, local);
    return local;
  }

  /** Import lines for the top of the module. */
  importLines(): string[] {
    const lines: string[] = [];
    const rt = this.opts.runtimeRelative
      ? relImport(this.file, this.opts.runtime)
      : this.opts.runtime;
    lines.push(`import * as $rt from ${str(rt)};`);
    for (const [id, local] of this.externLocals) {
      const x = this.model.extern(id);
      const spec = this.opts.externs[x.name] ?? this.opts.externs[id];
      if (spec === undefined) {
        if (x.kind === "type" && (x.name === "uleb128" || x.name === "sleb128")) {
          lines.push(`const ${local} = $rt.${x.name};`);
        } else {
          lines.push(`const ${local} = $rt.missingExtern(${str(x.name)}) as never;`);
        }
        continue;
      }
      // "path#Item" names the export explicitly; otherwise it is the extern's name.
      const hash = spec.lastIndexOf("#");
      const file = hash > 0 ? spec.slice(0, hash) : spec;
      const item = hash > 0 ? spec.slice(hash + 1) : x.name;
      const path = /^\.\.?\//.test(file) ? relImport(this.file, normalizeRel(file)) : file;
      lines.push(`import { ${ident(item)} as ${local} } from ${str(path)};`);
    }
    const files = new Set([...this.imports.keys(), ...this.typeImports.keys()]);
    for (const file of [...files].sort()) {
      const names = [...(this.imports.get(file) ?? [])].sort();
      const types = [...(this.typeImports.get(file) ?? [])].filter(t => !names.includes(t)).sort();
      const all = [...names, ...types.map(t => `type ${t}`)];
      lines.push(`import { ${all.join(", ")} } from ${str(relImport(this.file, file))};`);
    }
    return lines;
  }
}

function normalizeRel(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === ".." && parts.length && parts[parts.length - 1] !== "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}
