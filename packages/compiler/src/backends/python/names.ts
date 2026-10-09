/**
 * Python names for everything in a program: module paths, classes, attributes, enum members and
 * parameters. Computed once per program so every emitter agrees.
 */
import type { IrEnum, IrParam, IrStruct } from "../../ir/index.ts";
import { PY_BUILTINS, PY_HARD_KEYWORDS, PY_KEYWORDS, pyIdent } from "./code.ts";
import type { Model } from "./model.ts";

/** Methods generated on root classes: fields with these names get a trailing underscore. */
const API_NAMES = [
  "parse",
  "parse_async",
  "safe_parse",
  "safe_parse_async",
  "serialize",
  "serialize_async",
  "to_json",
  "from_json",
  "options_from_json",
  "view",
  "view_async"
];

/** Builtin types that annotations in class bodies use: fields must not shadow them. */
const ANNOTATION_NAMES = [
  "bytes",
  "bool",
  "int",
  "float",
  "str",
  "list",
  "dict",
  "tuple",
  "object"
];

const ENUM_RESERVED = new Set(["name", "value", "mro"]);

/** Module-level names generated code uses unqualified besides builtins. */
const MODULE_NAMES = new Set(["annotations", "dataclass", "field", "Variant"]);

/** Keyword arguments of the root API besides the root's parameters. */
const API_OPTIONS = new Set(["strict", "endian", "source", "value"]);

export class Names {
  private readonly model: Model;
  private readonly classNames = new Map<string, string>();
  private readonly enumNames = new Map<string, string>();
  private readonly attrs = new Map<string, Map<string, string>>();
  private readonly members = new Map<string, Map<string, string>>();
  private readonly params = new Map<string, Map<string, string>>();
  readonly allClassNames = new Set<string>();

  constructor(model: Model) {
    this.model = model;
    const className = (name: string): string => {
      let s = name.replace(/[^A-Za-z0-9_]/g, "_");
      if (s === "" || /^[0-9_]/.test(s)) s = "Y" + s;
      while (
        PY_KEYWORDS.has(s) ||
        PY_BUILTINS.has(s) ||
        MODULE_NAMES.has(s) ||
        this.allClassNames.has(s)
      )
        s += "_";
      this.allClassNames.add(s);
      return s;
    };
    for (const s of model.program.structs) this.classNames.set(s.id, className(s.name));
    for (const e of model.program.enums) this.enumNames.set(e.id, className(e.name));
  }

  structClass(id: string): string {
    const n = this.classNames.get(id);
    if (!n) throw new Error(`unknown struct ${id}`);
    return n;
  }

  enumClass(id: string): string {
    const n = this.enumNames.get(id);
    if (!n) throw new Error(`unknown enum ${id}`);
    return n;
  }

  /**
   * Attribute name of a field (or bitfield). Attributes never start with "_": views use
   * `_commit`, `_offset`, … (as namedtuple does).
   */
  attr(s: IrStruct, field: string): string {
    let m = this.attrs.get(s.id);
    if (!m) {
      m = new Map();
      const isRoot = this.model.program.roots.some(r => r.struct === s.id);
      const taken = new Set<string>([...ANNOTATION_NAMES, ...(isRoot ? API_NAMES : [])]);
      for (const f of this.model.fields(s)) {
        if (m.has(f.name)) continue;
        let a = f.name.replace(/[^A-Za-z0-9_]/g, "_");
        if (a === "" || /^[0-9_]/.test(a)) a = "f" + a;
        while (PY_HARD_KEYWORDS.has(a) || taken.has(a)) a += "_";
        taken.add(a);
        m.set(f.name, a);
      }
      this.attrs.set(s.id, m);
    }
    const a = m.get(field);
    if (a === undefined) throw new Error(`unknown field ${field} of ${s.name}`);
    return a;
  }

  /** Attribute name of an enum member. */
  member(e: IrEnum, name: string): string {
    let m = this.members.get(e.id);
    if (!m) {
      m = new Map();
      const taken = new Set<string>();
      for (const mem of e.members) {
        let a = mem.name.replace(/[^A-Za-z0-9_]/g, "_");
        if (a === "" || /^[0-9_]/.test(a)) a = "M" + a;
        while (PY_HARD_KEYWORDS.has(a) || ENUM_RESERVED.has(a) || taken.has(a)) a += "_";
        taken.add(a);
        m.set(mem.name, a);
      }
      this.members.set(e.id, m);
    }
    return m.get(name) ?? name;
  }

  /** Local variable name of a struct parameter. */
  param(s: IrStruct, name: string): string {
    let m = this.params.get(s.id);
    if (!m) {
      m = new Map();
      const taken = new Set<string>(this.allClassNames);
      for (const p of s.params) {
        const local = p.origin === "endian" ? "endian" : pyIdent(p.name, taken);
        taken.add(local);
        m.set(p.name, local);
      }
      this.params.set(s.id, m);
    }
    return m.get(name) ?? pyIdent(name, this.allClassNames);
  }

  /** Keyword argument of a root parameter (bound parameters without `$`). */
  option(p: IrParam): string {
    return pyIdent(p.boundName ?? p.name, API_OPTIONS);
  }
}

/** Python module path segments of an IR module name ("formats/demo/archive" → [formats, demo, archive]). */
export function moduleSegments(name: string): string[] {
  return name
    .replace(/\.yfl$/, "")
    .split("/")
    .filter(s => s !== "" && s !== ".")
    .map(seg => {
      let s = seg.replace(/[^A-Za-z0-9_]/g, "_");
      if (s === "" || /^[0-9]/.test(s)) s = "m" + s;
      while (PY_KEYWORDS.has(s) || s === "__init__") s += "_";
      return s;
    });
}

/** Output file of a module. */
export function moduleFile(name: string): string {
  return `${moduleSegments(name).join("/")}.py`;
}
