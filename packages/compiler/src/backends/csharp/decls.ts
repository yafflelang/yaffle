/**
 * Declarations: struct classes (with the root API on root structs), enums, options classes and
 * the per-enum helpers in `YaffleImpl`.
 */
import type { IrParam, IrStruct } from "../../ir/index.ts";
import { Code, ident, pascal, str } from "./code.ts";
import { intRange, type ExprCompiler, type ExprCtx } from "./expr.ts";
import type { JsonEmitter } from "./json.ts";
import type { Model } from "./model.ts";
import { IMPL, type ModuleCtx } from "./module.ts";
import type { ReadEmitter } from "./read.ts";
import type { Types } from "./types.ts";
import { deferOf } from "./views.ts";
import type { WriteEmitter } from "./write.ts";

function xmlDoc(code: Code, doc: string | undefined): void {
  if (!doc) return;
  code.line("/// <summary>");
  for (const l of doc.split("\n"))
    code.line(`/// ${l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}`);
  code.line("/// </summary>");
}

/** A one-line XML doc comment. */
function summary(text: string): string {
  return `/// <summary>${text}</summary>`;
}

export class DeclEmitter {
  readonly model: Model;
  readonly types: Types;
  readonly x: ExprCompiler;

  constructor(model: Model, types: Types, x: ExprCompiler) {
    this.model = model;
    this.types = types;
    this.x = x;
  }

  emitEnum(code: Code, id: string): void {
    const e = this.model.enum(id);
    const name = this.model.enumName(id);
    const cs = this.types.primType(e.storage);
    code.line(
      summary(
        `Enum ${e.name} (${e.storage}${e.open ? ", open: unknown values pass through" : ""}).`
      )
    );
    code.block(`public enum ${name} : ${cs}`, () => {
      for (const m of e.members) code.line(`${this.model.enumMember(id, m.name)} = ${m.value},`);
    });
  }

  /** Enum helpers: read (membership check), value (write check), JSON name and parse. */
  emitEnumHelpers(code: Code, id: string): void {
    const e = this.model.enum(id);
    const name = this.model.enumName(id);
    const cs = this.types.primType(e.storage);
    const bits = Number(e.storage.slice(1));
    // Value → name: the last member with a value wins (like a Map built from the members).
    const byValue = new Map<string, string>();
    for (const m of e.members) byValue.set(BigInt(m.value).toString(), m.name);
    const member = (n: string): string => `${name}.${this.model.enumMember(id, n)}`;
    const switchOn = (subject: string, arms: string[]): void => {
      code.line(`return ${subject} switch`);
      code.line("{");
      code.indent(() => arms.forEach(a => code.line(a)));
      code.line("};");
    };
    code.block(`internal static ${name} EnumRead_${name}(${cs} raw, Rt.Reader r, int at)`, () =>
      switchOn("raw", [
        ...[...byValue].map(([v, n]) => `${this.x.intLit(BigInt(v), cs)} => ${member(n)},`),
        e.open
          ? `_ => (${name})raw`
          : `_ => throw r.Error(Rt.ErrorCode.CHECK, $"{raw} is not a member of the enum", at)`
      ])
    );
    code.block(`internal static ${cs} EnumValue_${name}(${name} v)`, () => {
      if (e.open) code.line(`return (${cs})v;`);
      else if (byValue.size === 0)
        code.line(
          `throw new Rt.YaffleException(Rt.ErrorCode.CHECK, $"{v} is not a member of the enum");`
        );
      else
        switchOn("v", [
          `${[...byValue.values()].map(member).join(" or ")} => (${cs})v,`,
          `_ => throw new Rt.YaffleException(Rt.ErrorCode.CHECK, $"{(${cs})v} is not a member of the enum")`
        ]);
    });
    code.block(`internal static JsonNode EnumJson_${name}(${name} v)`, () =>
      switchOn("v", [
        ...[...byValue.values()].map(n => `${member(n)} => Rt.Json.OfStr(${str(n)}),`),
        `_ => ${bits > 48 ? `Rt.Json.BigStr((${cs})v)` : `Rt.Json.Num((${cs})v)`}`
      ])
    );
    code.block(`internal static ${name} EnumParse_${name}(JsonNode? j)`, () => {
      code.line(`switch (Rt.Json.EnumName(j))`);
      code.block("", () => {
        for (const m of e.members) {
          code.line(`case ${str(m.name)}:`);
          code.line(`    return ${member(m.name)};`);
        }
      });
      if (e.open) {
        const [lo, hi] = intRange(bits, e.storage[0] === "i");
        code.block(`if (Rt.Json.TryOpenEnumValue(j, out var n))`, () => {
          code.line(
            `if (n >= ${this.x.intLit(lo, "Int128")} && n <= ${this.x.intLit(hi, "Int128")}) return (${name})(${cs})n;`
          );
          code.line(
            `throw new Rt.YaffleException(Rt.ErrorCode.RANGE, $"{n} is out of range for ${e.storage}");`
          );
        });
      }
      code.line(
        `throw new Rt.YaffleException(Rt.ErrorCode.INPUT, $"{Rt.Json.Describe(j)} is not a member of the enum");`
      );
    });
  }

  /** The class of a struct (fields as properties; root structs also get the root API). */
  emitStruct(code: Code, s: IrStruct, api: ApiEmitter | undefined): void {
    const name = this.model.className(s.id);
    xmlDoc(code, s.doc);
    code.block(`public sealed partial class ${name} : Rt.IStructValue`, () => {
      for (const f of this.model.uniqueFields(s)) {
        const info = this.types.field(s, f);
        const decl = f.field ?? f.bit!;
        const hidden = !decl.output;
        if (f.field?.doc) xmlDoc(code, f.field.doc);
        else if (!hidden && decl.input === "absent")
          code.line(
            decl.deriveKind === "constant"
              ? summary("Constant: Serialize always writes it (checked by Parse).")
              : decl.deriveKind === "formula"
                ? summary(
                    "Computed: Serialize evaluates its formula (the value set here is ignored)."
                  )
                : summary("Derived: Serialize recomputes it (the value set here is ignored).")
          );
        else if (!hidden && decl.input === "optional")
          code.line(summary("Optional on write: null lets Serialize compute it."));
        const access = hidden ? "internal" : "public";
        if (f.field && deferOf(this.model, s, f.field)) {
          // Views load this field on first access (Rt.Slot); parses and user code just set it.
          code.line(`private Rt.Slot<${info.type}> _slot_${info.member};`);
          code.line(
            `${access} ${info.type} ${info.member} { get => _slot_${info.member}.Get(); set => _slot_${info.member}.Set(value); }`
          );
          code.line(
            `internal ref Rt.Slot<${info.type}> __S_${info.member} => ref _slot_${info.member};`
          );
        } else {
          const init = !info.nullable && !info.valueType ? " = null!;" : "";
          code.line(`${access} ${info.type} ${info.member} { get; set; }${init}`);
        }
        const oneWay = f.field && f.field.output ? this.types.oneWay(f.field) : undefined;
        if (oneWay) {
          const rawCs = this.types.nonNull(this.types.type(oneWay.inner));
          code.line(
            summary(`The raw value of ${f.name} (written by Serialize; ${f.name} is read-only).`)
          );
          code.line(`public ${rawCs}? ${this.model.rawMember(s, f.name)} { get; set; }`);
        }
      }
      code.line("");
      code.line(`internal ${name} __Clone() => (${name})MemberwiseClone();`);
      // `==` on struct values in expressions: canonical JSON equality.
      code.line(
        `bool Rt.IStructValue.StructuralEquals(Rt.IStructValue other) => other is ${name} __o && JsonNode.DeepEquals(${IMPL}.ToJson_${name}(this, new Rt.ToJsonCtx(), Rt.JPath.Root), ${IMPL}.ToJson_${name}(__o, new Rt.ToJsonCtx(), Rt.JPath.Root));`
      );
      if (api) {
        code.line("");
        api.emitRootApi(code, s);
      }
    });
  }
}

export class ApiEmitter {
  readonly model: Model;
  readonly types: Types;
  readonly mod: ModuleCtx;
  readonly reader: ReadEmitter;
  readonly writer: WriteEmitter;
  readonly json: JsonEmitter;

  constructor(
    model: Model,
    types: Types,
    mod: ModuleCtx,
    reader: ReadEmitter,
    writer: WriteEmitter,
    json: JsonEmitter
  ) {
    this.model = model;
    this.types = types;
    this.mod = mod;
    this.reader = reader;
    this.writer = writer;
    this.json = json;
  }

  /** Root parameters the options class holds (not `$endian` and not outer-struct parameters). */
  private optionParams(s: IrStruct): IrParam[] {
    return s.params.filter(p => p.origin !== "endian" && p.origin !== "outer");
  }

  private optionMember(p: IrParam): string {
    const n = pascal(p.boundName ?? p.name);
    return n === "Endian" || n === "Strict" || n === "FromJson" ? `${n}_` : n;
  }

  /** The options class of a root: its parameters. */
  emitOptions(code: Code, s: IrStruct): void {
    const opts = this.model.optionsNames.get(s.id)!;
    const params = this.optionParams(s);
    code.line(
      summary(`Parse and serialize options of ${this.model.className(s.id)}: its root parameters.`)
    );
    code.block(`public sealed class ${opts} : Rt.ParseOptions`, () => {
      for (const p of params) {
        code.line(
          `public ${this.types.nonNull(this.types.valueType(p.type))}? ${this.optionMember(p)} { get; set; }`
        );
      }
      code.line("");
      code.line(summary(`Options from canonical JSON (<c>{ "endian": "be", "version": 3 }</c>).`));
      code.block(`public static ${opts} FromJson(JsonNode? json)`, () => {
        code.line(`var __o = new ${opts}();`);
        code.line(`if (json is null) return __o;`);
        code.line(`var __s = Rt.Json.Obj(json);`);
        code.line(
          `if (__s.TryGetPropertyValue("endian", out var __e) && __e is not null) __o.Endian = Rt.Json.Endian(__e);`
        );
        code.line(
          `if (__s.TryGetPropertyValue("strict", out var __st) && __st is not null) __o.Strict = Rt.Json.Bool(__st);`
        );
        code.line(`var __c = new Rt.FromJsonCtx(json);`);
        params.forEach((p, i) => {
          const key = p.boundName ?? p.name;
          code.line(
            `if (__s.TryGetPropertyValue(${str(key)}, out var __j${i}) && __j${i} is not null) __o.${this.optionMember(p)} = ${this.json.valueFromJson(p.type, `__j${i}`, `Rt.JPath.Root.Field(${str(key)})`)};`
          );
        });
        code.line("return __o;");
      });
    });
  }

  /** Root reader/writer, view scanner and view spec in YaffleImpl (root parameters from the options). */
  emitRootImpl(code: Code, s: IrStruct): void {
    const name = this.model.className(s.id);
    const opts = this.model.optionsNames.get(s.id)!;
    const async = this.model.rootIsAsync(s.id);
    const prelude = (): void => {
      code.line(`var endian = __o.Endian;`);
      code.line(`bool __le = endian == Rt.Endian.Le;`);
      for (const p of this.optionParams(s)) {
        const key = p.boundName ?? p.name;
        const cs = this.types.nonNull(this.types.valueType(p.type));
        const member = `__o.${this.optionMember(p)}`;
        let v: string;
        if (p.default) {
          const d = this.reader.x.compile(p.default, this.constCtx());
          v = `(${member} ?? ${this.reader.x.to(d, p.type)})`;
        } else {
          v = this.types.isValueType(cs)
            ? `Rt.Check.ReqV(${member}, ${str(key)})`
            : `Rt.Check.Req(${member}, ${str(key)})`;
        }
        code.line(`${cs} ${ident(p.name)} = ${v};`);
      }
    };
    const suffix = async ? "Async" : "";
    code.block(
      `internal static ${async ? `async ValueTask<${name}>` : name} ReadRoot${suffix}_${name}(Rt.Reader __r, ${opts} __o)`,
      () => {
        prelude();
        code.line(`return ${this.reader.rootRead(code, s, async)};`);
      }
    );
    code.block(
      `internal static ${async ? "async ValueTask<Rt.LEntry?>" : "Rt.LEntry?"} WriteRoot${suffix}_${name}(Rt.Writer __w, ${name} __value, ${opts} __o)`,
      () => {
        prelude();
        const l = this.writer.rootWrite(code, s, "__value", async);
        code.line(`return ${l ?? "null"};`);
      }
    );
    // Views: the root's scan (inside its struct-level layers) and the view spec.
    code.block(
      `internal static ${name} ScanRoot_${name}(Rt.Reader __r, Rt.ViewNode __n, ${opts} __o)`,
      () => {
        prelude();
        this.reader.rootScan(code, s);
      }
    );
    const layout = s.base ? "null" : this.writer.layoutConst(s);
    code.block(`internal static Rt.ViewSpec ViewSpec_${name}(${opts} __o)`, () => {
      prelude();
      code.line("return new Rt.ViewSpec");
      code.line("{");
      code.indent(() => {
        code.line(`Info = Info_${name},`);
        code.line(
          `Args = new object[] { ${s.params.map(p => (p.origin === "endian" ? "endian" : ident(p.name))).join(", ")} },`
        );
        code.line(`Strict = __o.Strict,`);
        code.line(`Layout = ${layout},`);
        code.line(`Scan = (__rr, __nn) => ScanRoot_${name}(__rr, __nn, __o),`);
        if (async) {
          // Formats with async codecs commit structural edits through async views only.
          code.line(
            `Write = (__ww, __vv) => throw new Rt.YaffleException(Rt.ErrorCode.INPUT, "a view of a format with async codecs commits through CommitAsync"),`
          );
          code.line(
            `WriteAsync = (__ww, __vv) => WriteRootAsync_${name}(__ww, (${name})__vv, __o)`
          );
        } else code.line(`Write = (__ww, __vv) => WriteRoot_${name}(__ww, (${name})__vv, __o)`);
      });
      code.line("};");
    });
  }

  /** Static entry points on the root's class. */
  emitRootApi(code: Code, s: IrStruct): void {
    const name = this.model.className(s.id);
    const opts = this.model.optionsNames.get(s.id)!;
    const async = this.model.rootIsAsync(s.id);
    const layout = s.base ? "null" : this.writer.layoutConst(s);
    const readRoot = `${IMPL}.ReadRoot${async ? "Async" : ""}_${name}`;
    const writeRoot = `${IMPL}.WriteRoot${async ? "Async" : ""}_${name}`;
    const options = `${opts}? options = null`;
    const viewSpec = `${IMPL}.ViewSpec_${name}(options ?? new ${opts}())`;
    const method = (doc: string, head: string, body: string[]): void => {
      code.line(summary(doc));
      code.block(head, () => body.forEach(l => code.line(l)));
    };
    const line = (doc: string, decl: string): void => {
      code.line(summary(doc));
      code.line(decl);
    };
    const failure = `catch (Rt.YaffleException e) { return Rt.SafeResult<${name}>.Failure(e); }`;
    if (!async) {
      method(
        `Parses a ${name} from bytes.`,
        `public static ${name} Parse(byte[] data, ${options})`,
        [
          `var __o = options ?? new ${opts}();`,
          `return ${readRoot}(new Rt.Reader(data, __o.Strict), __o);`
        ]
      );
      line(
        `Parses a ${name} from a sync source.`,
        `public static ${name} Parse(Rt.ISource source, ${options}) => Parse(Rt.Sources.ReadAll(source), options);`
      );
      line(
        `Parses a ${name} from a stream (read to its end).`,
        `public static ${name} Parse(System.IO.Stream stream, ${options}) => Parse(Rt.Sources.ReadAll(stream), options);`
      );
      method(
        "Parses, returning the error instead of throwing it.",
        `public static Rt.SafeResult<${name}> SafeParse(byte[] data, ${options})`,
        [`try { return Rt.SafeResult<${name}>.Success(Parse(data, options)); }`, failure]
      );
    }
    method(
      `Parses a ${name} from bytes${async ? " (async codecs)" : ""}.`,
      `public static ${async ? "async " : ""}ValueTask<${name}> ParseAsync(byte[] data, ${options})`,
      [
        `var __o = options ?? new ${opts}();`,
        async
          ? `return await ${readRoot}(new Rt.Reader(data, __o.Strict), __o);`
          : `return new ValueTask<${name}>(${readRoot}(new Rt.Reader(data, __o.Strict), __o));`
      ]
    );
    method(
      `Parses a ${name} from an async source.`,
      `public static async ValueTask<${name}> ParseAsync(Rt.IAsyncSource source, ${options})`,
      [
        `var __o = options ?? new ${opts}();`,
        `var __data = await Rt.Sources.ReadAllAsync(source);`,
        `return ${async ? "await " : ""}${readRoot}(new Rt.Reader(__data, __o.Strict), __o);`
      ]
    );
    method(
      "Parses, returning the error instead of throwing it.",
      `public static async ValueTask<Rt.SafeResult<${name}>> SafeParseAsync(byte[] data, ${options})`,
      [`try { return Rt.SafeResult<${name}>.Success(await ParseAsync(data, options)); }`, failure]
    );
    const serialize = `Rt.Writer.SerializeRoot(${layout}, __w => ${writeRoot}(__w, value, __o))`;
    if (!async) {
      method(
        `Serializes a ${name}. Derived and computed fields are recomputed; byte-identical if nothing changed.`,
        `public static byte[] Serialize(${name} value, ${options})`,
        [`var __o = options ?? new ${opts}();`, `return ${serialize};`]
      );
    }
    method(
      `Serializes a ${name}${async ? " (async codecs)" : ""}.`,
      `public static ValueTask<byte[]> SerializeAsync(${name} value, ${options})`,
      [
        `var __o = options ?? new ${opts}();`,
        async
          ? `return Rt.Writer.SerializeRootAsync(${layout}, __w => ${writeRoot}(__w, value, __o));`
          : `return new ValueTask<byte[]>(${serialize});`
      ]
    );
    if (!async) {
      line(
        "A lazy view: reads only what you touch; edit its values, then Patches() or Commit().",
        `public static Rt.View<${name}> View(byte[] data, ${options}) => new(new Rt.ArrayStore(data), ${viewSpec});`
      );
      line(
        "A lazy view over a sync source (block-cached; an Rt.ISink source gets commits written back).",
        `public static Rt.View<${name}> View(Rt.ISource source, ${options}) => new(new Rt.SyncSourceStore(source), ${viewSpec}, source as Rt.ISink);`
      );
    }
    line(
      "A lazy view over an async source: access through GetAsync/SetAsync, then CommitAsync.",
      `public static Rt.AsyncView<${name}> ViewAsync(Rt.IAsyncSource source, ${options}) => new(source, ${viewSpec});`
    );
    line(
      "An async view over bytes (formats with async codecs).",
      `public static Rt.AsyncView<${name}> ViewAsync(byte[] data, ${options}) => new(data, ${viewSpec});`
    );
    line(
      `Canonical JSON of a ${name} (docs/CONFORMANCE.md §3).`,
      `public static JsonNode ToJson(${name} value) => ${IMPL}.ToJson_${name}(value, new Rt.ToJsonCtx(), Rt.JPath.Root);`
    );
    line(
      `A ${name} from canonical JSON (<c>$ref</c>s restore shared objects).`,
      `public static ${name} FromJson(JsonNode? json) => ${IMPL}.FromJson_${name}(json, new Rt.FromJsonCtx(json), Rt.JPath.Root);`
    );
  }

  /** Context for constant expressions (parameter defaults). */
  private constCtx(): ExprCtx {
    const none = (): { code: string; kind: "other"; cs: string } => ({
      code: "default!",
      kind: "other",
      cs: "object"
    });
    return {
      field: none,
      param: none,
      it: none,
      lambda: n => n,
      builtin: () => "0L",
      sizeof: () => "0L",
      offsetof: () => "0L",
      encodedSize: () => "0L",
      bytesof: () => "System.Array.Empty<byte>()",
      encode: () => "System.Array.Empty<byte>()",
      externFn: id => this.mod.externFn(id),
      hoist: (c, t, h) => this.mod.hoist(c, t, h),
      fieldType: () => undefined,
      fresh: p => `__${p}0`
    };
  }
}
