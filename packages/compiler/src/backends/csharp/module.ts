/**
 * Per-output-file bookkeeping shared by the emitters: hoisted static fields, names of generated
 * functions (all in the partial class `YaffleImpl`) and extern implementations (`YaffleExterns`).
 */
import type { IrExtern } from "../../ir/index.ts";
import { ident, pascal } from "./code.ts";
import type { Model } from "./model.ts";
import type { Types } from "./types.ts";

export const IMPL = "YaffleImpl";
export const EXTERNS = "YaffleExterns";

/** Program-wide extern bookkeeping (one `YaffleExterns` class for every output file). */
export class ExternTable {
  private readonly model: Model;
  private readonly types: Types;
  private readonly specs: Record<string, string>;
  /** Extern id → its field in `YaffleExterns`, in the order the emitters asked for them. */
  private readonly fields = new Map<string, string>();
  private readonly used = new Set<string>();

  constructor(model: Model, types: Types, specs: Record<string, string>) {
    this.model = model;
    this.types = types;
    this.specs = specs;
  }

  /**
   * The C# item an extern spec names, fully qualified (`path.cs#Ns.Item` → `global::Ns.Item`; a
   * plain name passes through). Without `#Item`, codecs and extern types are a class named after
   * the extern in PascalCase, and extern fns the method `Externs.<PascalName>`.
   */
  private item(x: IrExtern): string | undefined {
    const spec = this.specs[x.name] ?? this.specs[x.id];
    if (spec === undefined) return undefined;
    let item = spec;
    if (/^(\.{1,2}\/|\/)/.test(spec) || /\.cs(#|$)/.test(spec)) {
      const hash = spec.lastIndexOf("#");
      if (hash >= 0) item = spec.slice(hash + 1);
      else item = x.kind === "fn" ? `Externs.${pascal(x.name)}` : pascal(x.name);
    }
    return item.startsWith("global::") ? item : `global::${item}`;
  }

  /** Field of `YaffleExterns` holding a codec or extern type implementation. */
  field(id: string): string {
    let name = this.fields.get(id);
    if (!name) {
      const base = `__ext_${ident(this.model.extern(id).name).replace(/^@/, "")}`;
      name = base;
      for (let i = 2; this.used.has(name); i++) name = `${base}${i}`;
      this.used.add(name);
      this.fields.set(id, name);
    }
    return `${EXTERNS}.${name}`;
  }

  /** The method to call for an extern fn (a stub field when it has no implementation). */
  fn(id: string): string {
    return this.item(this.model.extern(id)) ?? this.field(id);
  }

  /** The source of `YaffleExterns` (field declarations and stubs for missing implementations). */
  declarations(): string[] {
    return [...this.fields].map(([id, name]) => {
      const x = this.model.extern(id);
      const item = this.item(x);
      if (x.kind === "codec") {
        const init =
          item !== undefined
            ? `new ${item}()`
            : `Rt.MissingExtern.Codec(${JSON.stringify(x.name)})`;
        return `internal static readonly Rt.ICodec ${name} = ${init};`;
      }
      if (x.kind === "type") {
        const vt = this.types.valueType(x.valueType);
        let init: string;
        if (x.builtin && item === undefined)
          init = x.name === "sleb128" ? "Rt.Sleb128.Instance" : "Rt.Uleb128.Instance";
        else if (item !== undefined) init = `new ${item}()`;
        else init = `Rt.MissingExtern.Type<${vt}>(${JSON.stringify(x.name)})`;
        return `internal static readonly Rt.IExternType<${vt}> ${name} = ${init};`;
      }
      const params = x.params.map((p, i) => `${this.types.valueType(p.type)} a${i}`).join(", ");
      const ret = this.types.valueType(x.returns);
      const message = `extern ${x.name} has no implementation (configure targets.csharp.externs in yaffle.json)`;
      return `internal static ${ret} ${name}(${params}) => throw new Rt.YaffleException(Rt.ErrorCode.INPUT, ${JSON.stringify(message)});`;
    });
  }
}

/** One output file's emitter state. */
export class ModuleCtx {
  private readonly model: Model;
  private readonly externs: ExternTable;
  private readonly hoisted = new Map<string, string>();
  /** Static readonly fields of `YaffleImpl` (constants, regexes, layouts). */
  readonly hoistedLines: string[] = [];
  private readonly prefix: string;

  constructor(model: Model, externs: ExternTable, index: number) {
    this.model = model;
    this.externs = externs;
    this.prefix = `__h${index}_`;
  }

  /** A static readonly field of `YaffleImpl` initialized to `code` (one per distinct value). */
  hoist(code: string, type: string, hint: string): string {
    const key = `${type} ${code}`;
    let name = this.hoisted.get(key);
    if (!name) {
      name = `${this.prefix}${hint}${this.hoistedLines.length + 1}`;
      this.hoisted.set(key, name);
      this.hoistedLines.push(`internal static readonly ${type} ${name} = ${code};`);
    }
    return `${IMPL}.${name}`;
  }

  /** A generated function of a struct (`Read_X`, `Write_X`, `ToJson_X`, …). */
  structFn(id: string, kind: string): string {
    return `${IMPL}.${kind}_${this.model.className(id)}`;
  }

  /** A generated enum helper (`EnumRead_E`, `EnumValue_E`, `EnumJson_E`, `EnumParse_E`). */
  enumFn(id: string, kind: string): string {
    return `${IMPL}.Enum${kind}_${this.model.enumName(id)}`;
  }

  /** The implementation of a codec or extern type. */
  extern(id: string): string {
    return this.externs.field(id);
  }

  externFn(id: string): string {
    return this.externs.fn(id);
  }
}
