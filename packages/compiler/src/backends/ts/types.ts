/**
 * TS types for structs and enums: the output type `X`, the input type `XInput`, and flat
 * internal types (`X$R`, `X$W`) used while building or reading values in generated code.
 */
import type {
  IrField,
  IrLiteral,
  IrMember,
  IrStruct,
  IrType,
  IrValueType
} from "../../ir/index.ts";
import { Code, propKey, str } from "./code.ts";
import type { Model } from "./model.ts";

type Side = "out" | "in";

interface Shape {
  /** Fields always present (or optional). */
  fields: { name: string; type: string; optional: boolean }[];
  /** Discriminated union groups: each a list of alternatives (field lists). */
  unions: { name: string; type: string; optional: boolean }[][][];
}

export class TypeEmitter {
  readonly model: Model;
  /** Imports a type defined by another generated module (set by the backend per module). */
  useType: ((module: string, name: string) => string) | undefined;
  constructor(model: Model) {
    this.model = model;
  }

  private structRef(id: string, side: Side): string {
    const name = this.model.structName(id) + (side === "in" ? "Input" : "");
    return this.useType ? this.useType(this.model.struct(id).module, name) : name;
  }

  private enumRef(id: string): string {
    const name = this.model.enumName(id);
    return this.useType ? this.useType(this.model.enum(id).module, name) : name;
  }

  literalType(l: IrLiteral): string {
    switch (l.kind) {
      case "int":
        return l.value;
      case "float":
        return "number";
      case "bool":
        return String(l.value);
      case "string":
        return str(l.value);
      case "bytes":
        return "Uint8Array";
      case "endian":
        return str(l.value);
      case "enum":
        return str(l.member);
    }
  }

  /** TS type of a value type. */
  valueType(t: IrValueType, side: Side): string {
    switch (t.kind) {
      case "int":
        return t.bits > 48 ? (side === "in" ? "bigint | number" : "bigint") : "number";
      case "bigint":
        return side === "in" ? "bigint | number" : "bigint";
      case "float":
        return "number";
      case "bool":
        return "boolean";
      case "string":
        return "string";
      case "bytes":
        return "Uint8Array";
      case "endian":
        return "$rt.Endian";
      case "struct":
        return this.structRef(t.struct, side);
      case "enum":
        return this.enumRef(t.enum);
      case "array":
        return `${arrayElem(this.valueType(t.element, side))}[]`;
      case "nullable":
        return `${this.valueType(t.inner, side)} | null`;
      case "union":
        return t.variants
          .map(v => `{ type: ${str(v.name)}; value: ${this.valueType(v.type, side)} }`)
          .join(" | ");
      case "extern":
        return this.valueType(t.valueType, side);
    }
  }

  /** TS type of a value read with IR type `t`. */
  type(t: IrType, side: Side): string {
    switch (t.kind) {
      case "prim":
        if (t.prim[0] === "f") return "number";
        return Number(t.prim.slice(1)) > 48
          ? side === "in"
            ? "bigint | number"
            : "bigint"
          : "number";
      case "bool":
        return "boolean";
      case "string":
        return "string";
      case "bytes":
        return "Uint8Array";
      case "array":
        return `${arrayElem(this.type(t.element, side))}[]`;
      case "struct":
        return this.structRef(t.struct, side);
      case "enum":
        return this.enumRef(t.enum);
      case "pointer": {
        const target = this.type(t.target, side);
        return t.nullValue !== undefined && !t.emptyIsNull ? `${target} | null` : target;
      }
      case "extern": {
        const x = this.model.extern(t.extern);
        return x.kind === "type" ? this.valueType(x.valueType, side) : "unknown";
      }
      case "union":
        return t.variants
          .map(v => `{ type: ${str(v.name)}; value: ${this.type(v.type, side)} }`)
          .join(" | ");
      case "transform":
        if (side === "in" && !t.write) return this.type(t.inner, side);
        return this.valueType(t.valueType, side);
      case "layered":
        return this.type(t.inner, side);
    }
  }

  /** The type of a field, with literal narrowing. */
  fieldType(f: IrField, side: Side): string {
    if (f.literals && f.literals.length) {
      const lits = f.literals.map(l => this.literalLike(l, f.type));
      return [...new Set(lits)].join(" | ");
    }
    if (side === "out" && f.deriveKind === "constant" && f.derive?.kind === "literal") {
      const l = f.derive.value;
      if (l.kind === "int" || l.kind === "string" || l.kind === "bool" || l.kind === "enum") {
        return this.literalLike(l, f.type);
      }
    }
    return this.type(f.type, side);
  }

  private literalLike(l: IrLiteral, t: IrType): string {
    if (l.kind === "int") {
      const big = this.type(t, "out") === "bigint";
      return big ? `${l.value}n` : l.value;
    }
    return this.literalType(l);
  }

  private shape(s: IrStruct, side: Side): Shape {
    const shape: Shape = { fields: [], unions: [] };
    const include = (f: IrField): boolean => f.output && (side === "out" || f.input !== "absent");
    const collect = (ms: readonly IrMember[], optional: boolean, into: Shape["fields"]): void => {
      for (const m of ms) {
        if (m.kind === "field") {
          if (include(m)) {
            into.push({
              name: m.name,
              type: this.fieldType(m, side),
              optional: optional || (side === "in" && m.input === "optional")
            });
          }
        } else if (m.kind === "bits") {
          for (const b of m.fields) {
            if (b.name === null || !b.output || (side === "in" && b.input === "absent")) continue;
            into.push({
              name: b.name,
              type: this.type(b.type, side),
              optional: optional || (side === "in" && b.input === "optional")
            });
          }
        } else if (m.kind === "block") {
          const cond = m.condition !== undefined;
          collect(m.members, optional || cond, into);
          if (m.else) collect(m.else, true, into);
        } else {
          if (m.discriminantField && into === shape.fields && !optional) {
            const alts: Shape["fields"][] = [];
            const disc = this.model.field(s, m.discriminantField)?.field;
            for (const c of m.cases) {
              const alt: Shape["fields"] = [];
              if (disc && disc.output && (side === "out" || disc.input !== "absent")) {
                alt.push({
                  name: disc.name,
                  type: c.values.map(v => this.literalLike(v, disc.type)).join(" | "),
                  optional: false
                });
              }
              collect(c.members, false, alt);
              alts.push(alt);
            }
            const def: Shape["fields"] = [];
            if (m.default) collect(m.default, false, def);
            if (m.default || alts.length) alts.push(def);
            shape.unions.push(alts);
          } else {
            for (const c of m.cases) collect(c.members, true, into);
            if (m.default) collect(m.default, true, into);
          }
        }
      }
    };
    collect(s.members, false, shape.fields);
    return shape;
  }

  private fieldsText(fields: Shape["fields"]): string {
    if (!fields.length) return "{}";
    return `{ ${fields.map(f => `${propKey(f.name)}${f.optional ? "?" : ""}: ${f.type}`).join("; ")} }`;
  }

  /** Emits `X`, `XInput` and the flat internal types. */
  emitStruct(code: Code, s: IrStruct): void {
    const name = this.model.structName(s.id);
    for (const side of ["out", "in"] as const) {
      const tname = side === "out" ? name : `${name}Input`;
      const shape = this.shape(s, side);
      if (s.doc && side === "out") code.line(`/** ${s.doc.replace(/\*\//g, "*\\/")} */`);
      if (!shape.unions.length) {
        if (!shape.fields.length) {
          code.line(`export type ${tname} = { [key: string]: never };`);
        } else {
          code.block(`export interface ${tname}`, () => {
            for (const f of shape.fields)
              code.line(`${propKey(f.name)}${f.optional ? "?" : ""}: ${f.type};`);
          });
        }
      } else {
        const parts: string[] = [];
        if (shape.fields.length) parts.push(this.fieldsText(shape.fields));
        for (const u of shape.unions) {
          parts.push(`(${u.map(alt => this.fieldsText(alt)).join(" | ")})`);
        }
        code.line(`export type ${tname} = ${parts.join(" & ")};`);
      }
    }
    // Flat internal types: every field present, types unioned across branches.
    code.line(`type ${name}$R = ${this.flat(s, "out")};`);
    code.line(`type ${name}$W = ${this.flat(s, "in")};`);
  }

  /** All fields (including hidden and derived, for internal use), non-optional. */
  flat(s: IrStruct, side: Side): string {
    const types = new Map<string, Set<string>>();
    const add = (n: string, t: string): void => {
      let set = types.get(n);
      if (!set) types.set(n, (set = new Set()));
      set.add(t);
    };
    for (const f of this.model.fields(s)) {
      if (f.field) {
        // Writers see @hidden fields too (stream pieces are handed to them as overrides).
        if (!f.field.output && side === "out") continue;
        add(f.name, this.type(f.field.type, side));
      } else if (f.bit) add(f.name, this.type(f.bit.type, side));
    }
    if (!types.size) return "{ [key: string]: never }";
    const parts = [...types].map(([n, ts]) => `${propKey(n)}: ${[...ts].join(" | ")}`);
    return `{ ${parts.join("; ")} }`;
  }

  emitEnum(code: Code, id: string): void {
    const e = this.model.enum(id);
    const name = this.model.enumName(id);
    const big = Number(e.storage.slice(1)) > 48;
    const members = e.members.map(m => str(m.name));
    code.line(
      `export type ${name} = ${[...members, ...(e.open ? ["number"] : [])].join(" | ") || "never"};`
    );
    code.block(
      `export const ${name} =`,
      () => {
        for (const m of e.members)
          code.line(`${propKey(m.name)}: ${big ? `${m.value}n` : m.value},`);
      },
      " as const;"
    );
    code.line(`export const $enum_${name}_values: $rt.EnumValues = ${name};`);
    code.line(
      `export const $enum_${name}_names = $rt.enumNames<${name}>([${e.members
        .map(m => `[${big ? `${m.value}n` : m.value}, ${str(m.name)}]`)
        .join(", ")}]);`
    );
  }
}

function arrayElem(t: string): string {
  return /[|&]/.test(t) ? `(${t})` : t;
}
