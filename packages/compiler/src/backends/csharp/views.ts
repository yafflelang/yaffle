/**
 * Views: which fields a view scan defers, how commits track each field, and the per-struct view
 * metadata (`Info_X`: field kinds, encoders, field getters).
 */
import type { IrExpr, IrField, IrStruct } from "../../ir/index.ts";
import { flatFields } from "../../ir/walk.ts";
import { exprUses, forEachLayoutExpr, forEachReadExpr, stripLayers, walkExpr } from "./analysis.ts";
import { Code, ident, str } from "./code.ts";
import type { FieldRef, Model } from "./model.ts";
import type { Types } from "./types.ts";
import type { WriteEmitter } from "./write.ts";

/** How a view scan reads a field's value. */
export type Defer =
  | { kind: "target" }
  | { kind: "pointer" }
  | { kind: "bytes" }
  | { kind: "array"; elementSize: number }
  | { kind: "region"; via: number }
  | { kind: "stream" };

/** The field's deferral in a view scan, if it is deferred (backed by an `Rt.Slot<T>`). */
export function deferOf(model: Model, s: IrStruct, f: IrField): Defer | undefined {
  if (model.readExtents(s).has(f.name)) return undefined;
  // Checks (constants, `in`, `where`) run during the scan, like a parse: the field is read eagerly.
  if (f.checks.length > 0) return undefined;
  if (f.placement) return { kind: "target" };
  if (f.from) return { kind: "stream" };
  const t = f.type;
  switch (t.kind) {
    case "pointer":
      return t.origin ? undefined : { kind: "pointer" };
    case "bytes":
      return t.length.kind === "count" || t.length.kind === "rest" ? { kind: "bytes" } : undefined;
    case "array": {
      if (t.elementPlacement || t.length.kind !== "count") return undefined;
      const es = model.staticSize(t.element);
      return es !== undefined && es > 0 ? { kind: "array", elementSize: es } : undefined;
    }
    case "layered": {
      // `@size(n) @via(c) @size(m)` or `@via(c)`: the encoded window is known without decoding
      // (the outer sizes, or the rest of the region).
      let k = t.layers.length - 1;
      while (k >= 0 && t.layers[k]!.kind === "size") k--;
      const l = t.layers[k];
      if (!l || l.kind !== "via" || model.codec(l.codec).streaming) return undefined;
      return { kind: "region", via: k };
    }
    default:
      return undefined;
  }
}

export type ViewKind = "Eager" | "Child" | "Lazy" | "Opaque";

/** How commits track a field. */
export function viewKind(model: Model, s: IrStruct, f: FieldRef): ViewKind {
  if (!f.field) return "Eager";
  if (deferOf(model, s, f.field) || f.field.placement || f.field.from) return "Lazy";
  const t = stripLayers(f.field.type);
  switch (t.kind) {
    case "struct":
      return "Child";
    case "array":
    case "pointer":
      return "Lazy";
    case "union":
      return "Opaque";
    case "transform": {
      const inner = stripLayers(t.inner).kind;
      return inner === "struct" || inner === "array" || inner === "union" || inner === "pointer"
        ? "Opaque"
        : "Eager";
    }
    default:
      return f.field.type.kind === "layered" && f.field.type.layers.some(l => l.kind === "via")
        ? "Lazy"
        : "Eager";
  }
}

/**
 * Fields referenced by read-side expressions other than their own checks, and by layout item
 * arguments (changing one moves targets).
 */
function structuralFields(s: IrStruct): Set<string> {
  const out = new Set<string>();
  const add = (e: IrExpr, except?: string): void =>
    walkExpr(e, x => {
      if (x.kind === "field" && x.name !== except) out.add(x.name);
    });
  // A field's own checks by name (of a field in several branches: the last one's).
  const own = new Map<string, IrExpr[]>();
  for (const f of flatFields(s.members))
    if (f.kind === "field")
      own.set(
        f.name,
        f.checks.map(c => c.expr)
      );
  const ownExprs = new Set([...own.values()].flat());
  forEachReadExpr(s, e => {
    if (!ownExprs.has(e)) add(e);
  });
  forEachLayoutExpr(s, e => add(e));
  for (const [name, exprs] of own) for (const e of exprs) add(e, name);
  return out;
}

/** Fields that some derive expression references. */
function derivedFrom(s: IrStruct): Set<string> {
  const out = new Set<string>();
  for (const f of flatFields(s.members)) {
    if (f.derive)
      walkExpr(f.derive, x => {
        if (x.kind === "field") out.add(x.name);
      });
  }
  return out;
}

/** No derive depends on the content of inline children (checksums, member access, externs). */
function childSafe(s: IrStruct): boolean {
  const unsafe = (x: IrExpr): boolean =>
    x.kind === "member" ||
    x.kind === "index" ||
    x.kind === "map" ||
    (x.kind === "call" &&
      (x.callee.kind === "extern" ||
        ["bytesof", "encode", "crc32", "adler32"].includes(x.callee.name)));
  return !flatFields(s.members).some(f => f.derive && exprUses(f.derive, unsafe));
}

/** Emits `Info_X`, the field getter `Get_X` and the in-place encoders of a struct. */
export class ViewEmitter {
  readonly model: Model;
  readonly types: Types;
  readonly writer: WriteEmitter;

  constructor(model: Model, types: Types, writer: WriteEmitter) {
    this.model = model;
    this.types = types;
    this.writer = writer;
  }

  emitStruct(code: Code, s: IrStruct): void {
    const name = this.model.className(s.id);
    const fields = this.model.uniqueFields(s);
    const structural = structuralFields(s);
    const derived = derivedFrom(s);
    const entries = fields.map((f, i) => {
      const decl = f.field ?? f.bit!;
      const input = decl.input !== "absent" && decl.output;
      const kind = viewKind(this.model, s, f);
      const props = [
        `Name = ${str(f.name)}`,
        `Kind = Rt.ViewFieldKind.${kind}`,
        `Input = ${input}`,
        `Structural = ${structural.has(f.name)}`
      ];
      if (kind === "Eager" && input && !derived.has(f.name) && this.emitEncoder(code, s, f, i))
        props.push(`Encode = (o, a) => Encode_${name}_${i}((${name})o, a)`);
      return `new Rt.ViewField { ${props.join(", ")} }`;
    });
    code.block(`internal static object? Get_${name}(${name} __v, int __i, bool __load)`, () => {
      code.line("switch (__i)");
      code.line("{");
      code.indent(() => {
        fields.forEach((f, i) => {
          const member = this.model.member(s, f.name);
          if (f.field && deferOf(this.model, s, f.field)) {
            code.line(
              `case ${i}: return __load || __v.__S_${member}.IsLoaded ? __v.${member} : Rt.Views.Pending;`
            );
          } else code.line(`case ${i}: return __v.${member};`);
        });
        code.line("default: return null;");
      });
      code.line("}");
    });
    code.line(`internal static readonly Rt.StructInfo Info_${name} = new Rt.StructInfo`);
    code.line("{");
    code.indent(() => {
      code.line(`Key = ${str(this.model.typeKey({ kind: "struct", struct: s.id, args: [] }))},`);
      code.line(`ChildSafe = ${childSafe(s)},`);
      code.line(`Get = (o, i, load) => Get_${name}((${name})o, i, load),`);
      code.line(`Fields = new Rt.ViewField[]`);
      code.line("{");
      code.indent(() => {
        for (const e of entries) code.line(`${e},`);
      });
      code.line("}");
    });
    code.line("};");
  }

  /** Emits `Encode_X_i`, the in-place encoder of field `i`, if it has one. */
  private emitEncoder(code: Code, s: IrStruct, f: FieldRef, i: number): boolean {
    const body = this.writer.encoderFor(s, f.name);
    if (body === undefined) return false;
    const name = this.model.className(s.id);
    code.block(`internal static byte[] Encode_${name}_${i}(${name} __v, object[] __a)`, () => {
      s.params.forEach((p, k) => {
        const cs = this.types.valueType(p.type);
        code.line(`var ${p.origin === "endian" ? "endian" : ident(p.name)} = (${cs})__a[${k}];`);
      });
      code.line(`bool __le = endian == Rt.Endian.Le;`);
      code.line(`return Rt.Writer.EncodeWith(__w =>`);
      code.line("{");
      code.indent(() => code.append(body));
      code.line("});");
    });
    return true;
  }
}
