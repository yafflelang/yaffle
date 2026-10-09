/** Canonical JSON emitter (docs/CONFORMANCE.md §3): `ToJson_X` / `FromJson_X` per struct. */
import type { IrStruct, IrType, IrValueType } from "../../ir/index.ts";
import { stripLayers, valueTypeOf } from "./analysis.ts";
import { Code, str } from "./code.ts";
import { ckName } from "./expr.ts";
import type { FieldRef, Model } from "./model.ts";
import type { ModuleCtx } from "./module.ts";
import type { Types } from "./types.ts";

const UNKNOWN_VARIANT = `throw new Rt.YaffleException(Rt.ErrorCode.INPUT, "unknown union variant")`;

export class JsonEmitter {
  readonly model: Model;
  readonly types: Types;
  readonly mod: ModuleCtx;
  private code!: Code;

  constructor(model: Model, types: Types, mod: ModuleCtx) {
    this.model = model;
    this.types = types;
    this.mod = mod;
  }

  private fresh(p: string): string {
    return this.code.fresh(p);
  }

  emitStruct(code: Code, s: IrStruct): void {
    this.code = code;
    const fields = this.model.uniqueFields(s).filter(f => (f.field ?? f.bit!).output);
    this.emitToJson(s, fields);
    this.emitFromJson(s, fields);
  }

  private emitToJson(s: IrStruct, fields: FieldRef[]): void {
    const code = this.code;
    const name = this.model.className(s.id);
    code.block(
      `internal static JsonObject ToJson_${name}(${name} __v, Rt.ToJsonCtx __c, Rt.JPath __p)`,
      () => {
        code.line(`var __o = new JsonObject();`);
        for (const f of fields) {
          const info = this.types.field(s, f);
          const t = (f.field ?? f.bit!).type;
          const key = str(f.name);
          const path = `__p.Field(${key})`;
          const value = `__v.${info.member}`;
          if (info.base === "object") {
            code.line(`if (${value} is not null) __o[${key}] = Rt.Json.Any(${value});`);
            continue;
          }
          const emit = (v: string): string => this.toJson(t, v, path);
          const oneWay = f.field ? this.types.oneWay(f.field) : undefined;
          if (oneWay) {
            // One-way transforms: the raw value, when the value came from a parse.
            const rv = this.fresh("rv");
            const rawCs = this.types.nonNull(this.types.type(oneWay.inner));
            code.line(
              `if (__v.${this.model.rawMember(s, f.name)} is ${rawCs} ${rv}) __o[${key}] = ${this.toJson(oneWay.inner, rv, path)};`
            );
            if (info.nullable) {
              const x = this.fresh("x");
              code.line(`else if (${value} is ${info.base} ${x}) __o[${key}] = ${emit(x)};`);
            } else code.line(`else __o[${key}] = ${emit(value)};`);
            continue;
          }
          if (!info.nullable) {
            code.line(`__o[${key}] = ${emit(value)};`);
            continue;
          }
          const x = this.fresh("x");
          code.line(`if (${value} is ${info.base} ${x}) __o[${key}] = ${emit(x)};`);
          // A null pointer (not a field of an untaken branch) is JSON null.
          const optional = f.field?.input === "optional";
          if (!f.conditional && !optional && isNullablePointer(t))
            code.line(`else __o[${key}] = null;`);
        }
        code.line("return __o;");
      }
    );
  }

  private emitFromJson(s: IrStruct, fields: FieldRef[]): void {
    const code = this.code;
    const name = this.model.className(s.id);
    // Fields a virtual stream writes (their content comes from the `from` field): not required.
    const streamSources = new Set<string>();
    for (const f of this.model.fields(s)) {
      let st = f.field?.from?.stream;
      while (st && st.kind === "slice") st = st.stream;
      if (st?.kind === "field") streamSources.add(st.field);
      else if (st?.kind === "each") streamSources.add(st.array);
    }
    code.block(
      `internal static ${name} FromJson_${name}(JsonNode? __j, Rt.FromJsonCtx __c, Rt.JPath __p)`,
      () => {
        code.line(`var __s = Rt.Json.Obj(__j);`);
        code.line(`var __o = new ${name}();`);
        code.line(`__c.Register(__p, __o);`);
        code.line(`string __f = "";`);
        code.chain([
          [
            "try",
            () => {
              const missing: string[] = [];
              for (const f of fields) {
                const info = this.types.field(s, f);
                const decl = f.field ?? f.bit!;
                const key = str(f.name);
                const path = `__p.Field(${key})`;
                const j = this.fresh("j");
                code.line(`__f = ${key};`);
                code.line(`if (__s.TryGetPropertyValue(${key}, out var ${j}))`);
                code.block("", () => {
                  const oneWay = f.field ? this.types.oneWay(f.field) : undefined;
                  if (info.base === "object") {
                    code.line(`__o.${info.member} = Rt.Json.Any(${j});`);
                  } else if (oneWay) {
                    // One-way transform: the JSON holds the raw value.
                    code.line(`try`);
                    code.block("", () =>
                      code.line(
                        `__o.${this.model.rawMember(s, f.name)} = ${this.fromJson(oneWay.inner, j, path)};`
                      )
                    );
                    code.line(`catch (Rt.YaffleException) { }`);
                  } else code.line(`__o.${info.member} = ${this.fromJson(decl.type, j, path)};`);
                });
                const hidden = f.field?.hidden ?? false;
                if (
                  !f.conditional &&
                  decl.input === "required" &&
                  !hidden &&
                  !f.field?.from &&
                  !streamSources.has(f.name)
                )
                  missing.push(f.name);
              }
              // Required inputs the JSON leaves out (checked after converting what is there).
              for (const m of missing) {
                code.line(
                  `if (!__s.ContainsKey(${str(m)})) { __f = ${str(m)}; throw new Rt.YaffleException(Rt.ErrorCode.INPUT, ${str(`missing required field ${m}`)}); }`
                );
              }
            }
          ],
          [`catch (Rt.YaffleException __e) when (__e.Prefix(__f))`, () => code.line("throw;")]
        ]);
        code.line(`return __o;`);
      }
    );
  }

  /** Canonical JSON of a value of IR type `t` (code of `v`). */
  private toJson(t: IrType, v: string, path: string): string {
    if (t.kind === "extern" && this.model.extern(t.extern).kind !== "type")
      return `Rt.Json.Any(${v})`;
    return this.valueToJson(valueTypeOf(this.model, t), v, path);
  }

  private valueToJson(t: IrValueType, v: string, path: string): string {
    switch (t.kind) {
      case "int":
        return t.bits > 48 ? `Rt.Json.BigStr(${v})` : `Rt.Json.Num(${v})`;
      case "bigint":
        return `Rt.Json.BigStr(${v})`;
      case "float":
        return `Rt.Json.FloatJson(${v})`;
      case "bool":
        return `Rt.Json.OfBool(${v})`;
      case "string":
        return `Rt.Json.OfStr(${v})`;
      case "bytes":
        return `Rt.Json.OfHex(${v})`;
      case "struct":
        return `__c.Struct(${v}, ${path}, ${this.mod.structFn(t.struct, "ToJson")})`;
      case "enum":
        return `${this.mod.enumFn(t.enum, "Json")}(${v})`;
      case "array": {
        const e = this.fresh("e");
        const p = this.fresh("q");
        return `__c.Arr<${this.types.valueType(t.element)}>(${v}, ${path}, (${e}, ${p}) => ${this.valueToJson(t.element, e, p)})`;
      }
      case "nullable": {
        const x = this.fresh("x");
        const cs = this.types.valueType(t.inner);
        return `(${v} is ${cs} ${x} ? ${this.valueToJson(t.inner, x, path)} : null)`;
      }
      case "extern":
        return this.valueToJson(t.valueType, v, path);
      case "endian":
        return `Rt.Json.OfStr(${v} == Rt.Endian.Le ? "le" : "be")`;
      case "union": {
        const u = this.fresh("u");
        const cases = t.variants.map(vr => {
          const cs = this.types.nonNull(this.types.valueType(vr.type));
          return `${str(vr.name)} => Rt.Json.Union(${str(vr.name)}, ${this.valueToJson(vr.type, `Rt.Check.Variant<${cs}>(${u})`, `${path}.Field("value")`)})`;
        });
        return `(${v} is Rt.UnionValue ${u} ? ${u}.Type switch { ${cases.join(", ")}, _ => ${UNKNOWN_VARIANT} } : null)`;
      }
    }
  }

  /**
   * A value of IR type `t` from JSON node `j`. One-way transforms (also nested in arrays, pointers
   * and unions) take their raw value.
   */
  private fromJson(t: IrType, j: string, path: string): string {
    switch (t.kind) {
      case "array": {
        const e = this.fresh("e");
        const p = this.fresh("q");
        const elemCs = this.types.type(t.element);
        return `__c.Arr<${elemCs}>(${j}, ${path}, (${e}, ${p}) => ${this.fromJson(t.element, e, p)})`;
      }
      case "pointer": {
        const inner = this.fromJson(t.target, j, path);
        if (t.nullValue === undefined || t.emptyIsNull) return inner;
        return `(${j} is null ? default(${this.types.nonNull(this.types.type(t.target))}?) : ${inner})`;
      }
      case "extern": {
        const x = this.model.extern(t.extern);
        return x.kind === "type" ? this.valueFromJson(x.valueType, j, path) : j;
      }
      case "union":
        return this.unionFromJson(t.variants, (vt, jj, pp) => this.fromJson(vt, jj, pp), j, path);
      case "transform":
        return t.write ? this.valueFromJson(t.valueType, j, path) : this.fromJson(t.inner, j, path);
      case "layered":
        return this.fromJson(t.inner, j, path);
      default:
        return this.valueFromJson(valueTypeOf(this.model, t), j, path);
    }
  }

  private unionFromJson<V>(
    variants: readonly { name: string; type: V }[],
    conv: (type: V, j: string, p: string) => string,
    j: string,
    path: string
  ): string {
    const ty = this.fresh("ty");
    const jj = this.fresh("jj");
    const pp = this.fresh("pp");
    const cases = variants.map(v => `${str(v.name)} => (object?)${conv(v.type, jj, pp)}`);
    return `Rt.Json.UnionFrom(${j}, ${path}, (${ty}, ${jj}, ${pp}) => ${ty} switch { ${cases.join(", ")}, _ => throw new Rt.YaffleException(Rt.ErrorCode.INPUT, $"unknown union variant {${ty}}") })`;
  }

  /** A value of value type `t` from JSON node `j` (also root parameters in options). */
  valueFromJson(t: IrValueType, j: string, path: string): string {
    switch (t.kind) {
      case "int":
        return `Rt.Ck.${ckName(t.bits, t.signed)}(${t.bits > 48 ? `Rt.Json.Big(${j})` : `Rt.Json.Int(${j})`})`;
      case "bigint":
        return `Rt.Json.Big(${j})`;
      case "float":
        return t.bits === 64
          ? `Rt.Json.Float(${j})`
          : t.bits === 32
            ? `(float)Rt.Json.Float(${j})`
            : `Rt.HalfBits.ToHalf(Rt.Json.Float(${j}))`;
      case "bool":
        return `Rt.Json.Bool(${j})`;
      case "string":
        return `Rt.Json.Str(${j})`;
      case "bytes":
        return `Rt.Json.Bytes(${j})`;
      case "struct": {
        const jj = this.fresh("jj");
        const pp = this.fresh("pp");
        const cls = this.model.className(t.struct);
        return `__c.Obj<${cls}>(${j}, ${path}, (${jj}, ${pp}) => ${this.mod.structFn(t.struct, "FromJson")}(${jj}, __c, ${pp}))`;
      }
      case "enum":
        return `${this.mod.enumFn(t.enum, "Parse")}(${j})`;
      case "array": {
        const e = this.fresh("e");
        const p = this.fresh("q");
        return `__c.Arr<${this.types.valueType(t.element)}>(${j}, ${path}, (${e}, ${p}) => ${this.valueFromJson(t.element, e, p)})`;
      }
      case "nullable": {
        const cs = this.types.valueType(t.inner);
        return `(${j} is null ? default(${cs}?) : ${this.valueFromJson(t.inner, j, path)})`;
      }
      case "extern":
        return this.valueFromJson(t.valueType, j, path);
      case "endian":
        return `Rt.Json.Endian(${j})`;
      case "union":
        return this.unionFromJson(
          t.variants,
          (vt, jj, pp) => this.valueFromJson(vt, jj, pp),
          j,
          path
        );
    }
  }
}

function isNullablePointer(t: IrType): boolean {
  const x = stripLayers(t);
  return x.kind === "pointer" && x.nullValue !== undefined && !x.emptyIsNull;
}
