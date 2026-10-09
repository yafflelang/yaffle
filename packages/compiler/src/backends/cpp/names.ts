/**
 * Program-wide names for the C++ backend: extern host implementations (and the headers that
 * declare them) and hidden members of generated structs.
 */
import type { IrStruct } from "../../ir/index.ts";
import { ident } from "./code.ts";
import type { Model } from "./model.ts";

export interface ExternSpec {
  /** Header to include (as given: absolute or relative to the output directory), if any. */
  header?: string;
  /** Qualified C++ name of the implementation. */
  item: string;
}

/**
 * Resolves an extern mapping (yaffle.json `targets.cpp.externs[name]`): `path/to/file.hpp` (item
 * = the extern's name, with a trailing `_` if it is a C++ keyword), `path/to/file.hpp#ns::item`,
 * or a bare qualified name (`ns::item`, no header).
 */
export function resolveExtern(name: string, spec: string | undefined): ExternSpec {
  const fallback = ident(name);
  if (spec === undefined) return { item: fallback };
  const hash = spec.lastIndexOf("#");
  const file = hash >= 0 ? spec.slice(0, hash) : spec;
  const item = hash >= 0 ? spec.slice(hash + 1) : undefined;
  const isPath = /[/\\]/.test(file) || /\.(h|hh|hpp|hxx|h\+\+)$/.test(file);
  if (!isPath) return { item: spec };
  return { header: file, item: item ?? fallback };
}

export class Names {
  readonly model: Model;
  readonly externs: Record<string, string>;
  private readonly raw = new Map<string, string>();

  constructor(model: Model, externs: Record<string, string>) {
    this.model = model;
    this.externs = externs;
  }

  /** C++ expression naming an extern's host implementation. */
  extern(id: string): string {
    const x = this.model.extern(id);
    if (x.kind === "type" && x.builtin) return `yaffle::${x.name}`;
    return resolveExtern(x.name, this.externs[x.name] ?? this.externs[id]).item;
  }

  /** Headers declaring the externs this program uses. */
  headers(): string[] {
    const out: string[] = [];
    for (const x of this.model.program.externs) {
      if (x.kind === "type" && x.builtin) continue;
      const spec = resolveExtern(x.name, this.externs[x.name] ?? this.externs[x.id]);
      if (spec.header && !out.includes(spec.header)) out.push(spec.header);
    }
    return out;
  }

  /** Hidden member holding the raw value of a one-way transform field (canonical JSON shows it). */
  rawMember(s: IrStruct, field: string): string {
    const key = `${s.id}.${field}`;
    const hit = this.raw.get(key);
    if (hit) return hit;
    const taken = new Set(this.model.fields(s).map(f => this.model.member(f.name)));
    let n = `${this.model.member(field)}_raw`;
    while (taken.has(n)) n += "_";
    this.raw.set(key, n);
    return n;
  }
}
