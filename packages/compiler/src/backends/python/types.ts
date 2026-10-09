/**
 * Python types: an `enum.IntEnum` per enum, a dataclass per struct, and type hints.
 *
 * Dataclass fields follow declaration order (fields of blocks, switches and bits inline). Fields
 * the caller must supply on serialize have no default; derived fields, constants, optional inputs
 * and fields of conditional branches have defaults, so `Struct(...)` only needs the inputs.
 */
import type { IrLiteral, IrStruct, IrType, IrValueType } from "../../ir/index.ts";
import { isNullablePointer } from "./analysis.ts";
import { pyBool, pyBytes, pyFloat, pyInt, pyStr, type Code } from "./code.ts";
import type { FieldRef, Model } from "./model.ts";
import type { ModuleCtx } from "./module.ts";
import type { Names } from "./names.ts";

/** Defaults of the scalar hints (derived fields only matter as inputs: any value will do). */
const ZERO: Record<string, string> = {
  int: "0",
  float: "0.0",
  bool: "False",
  str: '""',
  bytes: 'b""'
};

/** A constant's value as the default of a field with this hint, if the types agree. */
function literalDefault(v: IrLiteral, hint: string): string | undefined {
  switch (v.kind) {
    case "int":
      return hint === "int" ? pyInt(BigInt(v.value)) : undefined;
    case "float":
      return hint === "float" ? pyFloat(v.value) : undefined;
    case "bool":
      return hint === "bool" ? pyBool(v.value) : undefined;
    case "string":
      return hint === "str" ? pyStr(v.value) : undefined;
    case "bytes":
      return hint === "bytes" ? pyBytes(v.hex) : undefined;
    default:
      return undefined;
  }
}

export class TypeEmitter {
  readonly model: Model;
  readonly names: Names;
  readonly mod: ModuleCtx;
  constructor(model: Model, names: Names, mod: ModuleCtx) {
    this.model = model;
    this.names = names;
    this.mod = mod;
  }

  /** Type hint of a value type. */
  valueType(t: IrValueType): string {
    switch (t.kind) {
      case "int":
      case "bigint":
        return "int";
      case "float":
        return "float";
      case "bool":
        return "bool";
      case "string":
      case "endian":
        return "str";
      case "bytes":
        return "bytes";
      case "struct":
        return this.mod.structClass(t.struct);
      case "enum":
        return this.enumHint(t.enum);
      case "array":
        return `list[${this.valueType(t.element)}]`;
      case "nullable":
        return `${this.valueType(t.inner)} | None`;
      case "union":
        return "_rt.Variant";
      case "extern":
        return this.valueType(t.valueType);
    }
  }

  private enumHint(id: string): string {
    const cls = this.mod.enumRef(id, "class");
    return this.model.enum(id).open ? `${cls} | int` : cls;
  }

  /** Type hint of a value read with IR type `t`. */
  type(t: IrType): string {
    switch (t.kind) {
      case "prim":
        return t.prim[0] === "f" ? "float" : "int";
      case "bool":
        return "bool";
      case "string":
        return "str";
      case "bytes":
        return "bytes";
      case "array":
        return `list[${this.type(t.element)}]`;
      case "struct":
        return this.mod.structClass(t.struct);
      case "enum":
        return this.enumHint(t.enum);
      case "pointer": {
        const target = this.type(t.target);
        return isNullablePointer(t) ? `${target} | None` : target;
      }
      case "extern": {
        const x = this.model.extern(t.extern);
        return x.kind === "type" ? this.valueType(x.valueType) : "_t.Any";
      }
      case "union":
        return "_rt.Variant";
      case "transform":
        return this.valueType(t.valueType);
      case "layered":
        return this.type(t.inner);
    }
  }

  /** `name: hint` of each struct parameter (reader and writer signatures). */
  params(s: IrStruct): string[] {
    return s.params.map(p => `${this.names.param(s, p.name)}: ${this.valueType(p.type)}`);
  }

  /** The hint of a field and its default (undefined: required). */
  private fieldDefault(fr: FieldRef): { hint: string; dflt: string | undefined } {
    const { input, type, derive } = fr.field ?? fr.bit!;
    const hint = this.type(type);
    const optional = { hint: hint.endsWith("| None") ? hint : `${hint} | None`, dflt: "None" };
    if (fr.conditional || input === "optional") return optional;
    if (input === "required") return { hint, dflt: undefined };
    // Derived or constant: computed on write; the default only matters for constructing inputs.
    const lit = derive?.kind === "literal" ? literalDefault(derive.value, hint) : undefined;
    if (lit !== undefined) return { hint, dflt: lit };
    const zero = ZERO[hint];
    if (zero !== undefined) return { hint, dflt: zero };
    if (hint.startsWith("list[")) return { hint, dflt: "_field(default_factory=list)" };
    return optional;
  }

  /** Emits the dataclass of a struct; `body` adds methods (the root API). */
  emitStruct(code: Code, s: IrStruct, body?: (c: Code) => void): void {
    const name = this.names.structClass(s.id);
    code.line("@_dataclass(kw_only=True)");
    code.block(`class ${name}`, () => {
      const doc = (s.doc ?? `${s.name} (${s.module}).`)
        .replace(/\\/g, "\\\\")
        .replace(/"""/g, '\\"\\"\\"');
      code.line(`"""${doc}"""`);
      code.line("");
      // A field declared in several branches gets the union of its types.
      const seen = new Map<string, { hints: Set<string>; dflt: string | undefined }>();
      for (const fr of this.model.fields(s)) {
        if (!(fr.field ?? fr.bit!).output) continue;
        const { hint, dflt } = this.fieldDefault(fr);
        const prev = seen.get(fr.name);
        if (!prev) seen.set(fr.name, { hints: new Set([hint]), dflt });
        else {
          prev.hints.add(hint.replace(/ \| None$/, ""));
          if (dflt !== undefined || prev.dflt !== undefined) prev.dflt = "None";
        }
      }
      for (const [fname, info] of seen) {
        let hint = [...info.hints].join(" | ");
        if (info.dflt === "None" && !/\| None$/.test(hint)) hint += " | None";
        const attr = this.names.attr(s, fname);
        code.line(info.dflt === undefined ? `${attr}: ${hint}` : `${attr}: ${hint} = ${info.dflt}`);
      }
      if (body) {
        code.line("");
        body(code);
      }
    });
  }

  emitEnum(code: Code, id: string): void {
    const e = this.model.enum(id);
    const name = this.names.enumClass(id);
    const member = (m: string): string => `${name}.${this.names.member(e, m)}`;
    code.block(`class ${name}(_enum.IntEnum)`, () => {
      code.line(`"""${e.name} (${e.storage}${e.open ? ", open" : ""})."""`);
      if (e.members.length) code.line("");
      for (const m of e.members)
        code.line(`${this.names.member(e, m.name)} = ${pyInt(BigInt(m.value))}`);
    });
    code.line("");
    const table = (entries: string[]): string => `{${entries.join(", ")}}`;
    const value = (v: string): string => pyInt(BigInt(v));
    code.line(
      `_E_${name}_members: dict[int, ${name}] = ${table(e.members.map(m => `${value(m.value)}: ${member(m.name)}`))}`
    );
    code.line(
      `_E_${name}_values: dict[str, int] = ${table(e.members.map(m => `${pyStr(m.name)}: ${value(m.value)}`))}`
    );
    code.line(
      `_E_${name}_names: dict[int, str] = ${table(e.members.map(m => `${value(m.value)}: ${pyStr(m.name)}`))}`
    );
  }
}
