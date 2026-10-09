/**
 * The program's declarations and public API: constants, enum helpers, struct declarations with
 * their options structs, and the root API (`parse`, `serialize`, `to_json`, `from_json`,
 * `options_from_json`, `view`, `view_file`).
 */
import type { IrConst, IrStruct, IrType } from "../../ir/index.ts";
import { isOneWay, stripLayers } from "./analysis.ts";
import { Code, floatLit, ident, intLit, localName, memberName, str } from "./code.ts";
import type { ExprCompiler, ExprCtx } from "./expr.ts";
import type { JsonEmitter } from "./json.ts";
import type { Model } from "./model.ts";
import type { Names } from "./names.ts";
import type { ReadEmitter } from "./read.ts";
import { enumMember, primCppType, type TypeMapper } from "./types.ts";
import type { WriteEmitter } from "./write.ts";

export interface ApiDeps {
  model: Model;
  types: TypeMapper;
  names: Names;
  x: ExprCompiler;
  reader: ReadEmitter;
  writer: WriteEmitter;
  json: JsonEmitter;
  views: boolean;
}

/** `inline constexpr T name = value;` for a program constant. */
export function constLine(c: IrConst, types: TypeMapper, model: Model): string {
  const v = c.value;
  const name = ident(c.name);
  switch (v.kind) {
    case "int": {
      const t =
        c.type.kind === "bigint" ? ({ kind: "int", bits: 64, signed: true } as const) : c.type;
      return `inline constexpr ${types.valueType(t)} ${name} = ${intLit(BigInt(v.value))};`;
    }
    case "float":
      return `inline constexpr double ${name} = ${floatLit(v.value)};`;
    case "bool":
      return `inline constexpr bool ${name} = ${v.value};`;
    case "string":
      return `inline const std::string ${name} = ${str(v.value)};`;
    case "bytes":
      return `inline const yaffle::Bytes ${name} = yaffle::from_hex(${str(v.hex)});`;
    case "endian":
      return `inline constexpr yaffle::Endian ${name} = yaffle::Endian::${v.value};`;
    case "enum":
      return `inline constexpr ${model.enumName(v.enum)} ${name} = ${model.enumName(v.enum)}::${enumMember(v.member)};`;
  }
}

/** `valid_E`, `enum_to_json_E` and `enum_from_json_E` for an enum. */
export function emitEnumHelpers(code: Code, model: Model, id: string): void {
  const e = model.enum(id);
  const name = model.enumName(id);
  const ct = primCppType(e.storage);
  const bits = Number(e.storage.slice(1));
  code.block(`[[maybe_unused]] static bool valid_${name}(${name} v)`, () => {
    code.block("switch (v)", () => {
      for (const m of e.members) code.line(`case ${name}::${enumMember(m.name)}:`);
      if (e.members.length) code.indent(() => code.line("return true;"));
      code.line("default:");
      code.indent(() => code.line("return false;"));
    });
  });
  code.block(`[[maybe_unused]] static yaffle::Json enum_to_json_${name}(${name} v)`, () => {
    code.block("switch (v)", () => {
      for (const m of e.members)
        code.line(`case ${name}::${enumMember(m.name)}: return yaffle::Json(${str(m.name)});`);
      code.line("default: break;");
    });
    code.line(`return yaffle::int_json(static_cast<${ct}>(v), ${bits});`);
  });
  code.block(
    `[[maybe_unused]] static ${name} enum_from_json_${name}(const yaffle::Json& j)`,
    () => {
      code.block("if (j.is_string())", () => {
        for (const m of e.members)
          code.line(`if (j.as_string() == ${str(m.name)}) return ${name}::${enumMember(m.name)};`);
        if (e.open && bits > 48) {
          code.line(`if (auto n = yaffle::parse_i128(j.as_string()))`);
          code.indent(() => code.line(`return static_cast<${name}>(yaffle::to<${ct}>(*n));`));
        }
      });
      if (e.open && bits <= 48)
        code.line(
          `if (j.is_number()) return static_cast<${name}>(yaffle::int_from_json_as<${ct}>(j, ${bits}, ${e.storage[0] === "i"}));`
        );
      code.line(
        `yaffle::fail(yaffle::ErrorCode::Input, yaffle::describe(j) + " is not a member of the enum");`
      );
    }
  );
  code.line("");
}

/** Root parameters that options set (not the endianness, not outer parameters). */
function optionParams(s: IrStruct): IrStruct["params"] {
  return s.params.filter(p => p.origin !== "endian" && p.origin !== "outer");
}

/** An expression context for constants (parameter defaults). */
function constCtx(): ExprCtx {
  const no = (): never => {
    throw new Error("not a constant expression");
  };
  return {
    field: no,
    param: no,
    it: no,
    lambda: no,
    builtin: no,
    sizeof: no,
    offsetof: no,
    encodedSize: no,
    bytesof: no,
    encode: no,
    externFn: no,
    fieldType: () => undefined
  };
}

export class ApiEmitter {
  private readonly d: ApiDeps;

  constructor(deps: ApiDeps) {
    this.d = deps;
  }

  /** A struct declaration (plus its options struct and root API declarations for roots). */
  declareStruct(code: Code, s: IrStruct, root: boolean): void {
    const { model, types, names } = this.d;
    const name = model.structName(s.id);
    if (root) {
      code.block(
        `struct ${name}Options`,
        () => {
          code.line(`yaffle::Endian endian = yaffle::Endian::le;`);
          code.line(`bool strict = false;`);
          for (const p of optionParams(s))
            code.line(
              `std::optional<${types.valueType(p.type)}> ${memberName(p.boundName ?? p.name)};`
            );
        },
        ";"
      );
      code.line("");
    }
    if (s.doc) code.line(`/** ${s.doc.replace(/\*\//g, "* /")} */`);
    code.block(
      `struct ${name}`,
      () => {
        const seen = new Map<string, string>();
        for (const f of model.fields(s)) {
          const ct = types.type(f.field ? f.field.type : f.bit!.type);
          const prev = seen.get(f.name);
          if (prev !== undefined && prev !== ct)
            throw new Error(
              `not implemented: field ${f.name} of ${s.name} has different types in different branches`
            );
          seen.set(f.name, ct);
        }
        for (const f of model.uniqueFields(s)) {
          const t = f.field ? f.field.type : f.bit!.type;
          const init = model.isOptionalMember(s, f.name) ? "" : types.defaultInit(t);
          code.line(`${types.memberType(s, f.name, t)} ${model.member(f.name)}${init};`);
          if (f.field && isOneWay(f.field.type)) {
            const tt = stripLayers(f.field.type) as Extract<IrType, { kind: "transform" }>;
            code.line(
              `std::optional<${types.type(tt.inner)}> ${names.rawMember(s, f.name)};  // raw value (canonical JSON)`
            );
          }
        }
        if (model.usesMeta(s))
          code.line(`yaffle::Meta yaffle_meta_;  // codec origins (byte-exact rebuilds)`);
        if (root) this.declareRootApi(code, s);
      },
      ";"
    );
  }

  private declareRootApi(code: Code, s: IrStruct): void {
    const name = this.d.model.structName(s.id);
    code.line("");
    code.line(`using Value = ${this.d.types.structRef(s.id)};`);
    code.line(`using Options = ${name}Options;`);
    code.line(`static Value parse(yaffle::BytesView data);`);
    code.line(`static Value parse(yaffle::BytesView data, const Options& options);`);
    code.line(`static yaffle::Bytes serialize(const Value& value);`);
    code.line(`static yaffle::Bytes serialize(const Value& value, const Options& options);`);
    code.line(`static yaffle::Json to_json(const Value& value);`);
    code.line(`static Value from_json(const yaffle::Json& json);`);
    code.line(`static Options options_from_json(const yaffle::Json& args);`);
    if (!this.d.views) return;
    code.line(`using View = ${name}View;`);
    code.line(`/** A lazy view of the bytes: reads on access, patches on commit. */`);
    code.line(`static View view(yaffle::Bytes data);`);
    code.line(`static View view(yaffle::Bytes data, const Options& options);`);
    code.line(
      `/** A view over a byte store (e.g. yaffle::FileStore): reads only what it touches. */`
    );
    code.line(`static View view(yaffle::StorePtr source, const Options& options = {});`);
    code.line(`/** A view over a file, read with positional reads through a block cache. */`);
    code.line(`static View view_file(const std::string& path, const Options& options = {});`);
  }

  /** `endian`, `le` and the root parameters as locals, from the options `o`. */
  private prelude(c: Code, s: IrStruct): void {
    const { types, x } = this.d;
    c.line(`[[maybe_unused]] const yaffle::Endian endian = o.endian;`);
    c.line(`[[maybe_unused]] const bool le = endian == yaffle::Endian::le;`);
    for (const p of optionParams(s)) {
      const key = memberName(p.boundName ?? p.name);
      const t = types.valueType(p.type);
      const fallback = p.default
        ? x.to(x.compile(p.default, constCtx()), p.type)
        : `yaffle::missing_option<${t}>(${str(p.boundName ?? p.name)})`;
      c.line(
        `[[maybe_unused]] const ${t} ${localName(p.name)} = o.${key} ? *o.${key} : ${fallback};`
      );
    }
  }

  /** The definitions of a root struct's API. */
  defineRootApi(code: Code, s: IrStruct): void {
    const { model, reader, writer } = this.d;
    const name = model.structName(s.id);
    code.line(`// ── ${name} (root) ${"─".repeat(Math.max(4, 80 - name.length))}`);
    code.line("");
    code.block(
      `[[maybe_unused]] static void root_read_${name}(yaffle::Reader& r, const ${name}::Options& o, ${name}::Value& v)`,
      () => {
        this.prelude(code, s);
        code.line(`yaffle::Frame fr;`);
        reader.rootRead(code, s, "v");
      }
    );
    code.line("");
    code.block(
      `[[maybe_unused]] static yaffle::Bytes root_write_${name}(const ${name}::Value& value, const ${name}::Options& o, const yaffle::Sticky* sticky)`,
      () => {
        this.prelude(code, s);
        const layout = s.base ? "nullptr" : writer.layoutRef(s);
        code.line(
          `return yaffle::serialize_root(${layout}, 1, [&](yaffle::Writer& w) -> yaffle::LEntry {`
        );
        code.indent(() => {
          code.line(`yaffle::Frame fr;`);
          const e = writer.rootWrite(code, s, "value");
          code.line(e ? `return yaffle::lentry(${e});` : "return yaffle::LEntry();");
        });
        code.line(`}, sticky);`);
      }
    );
    code.line("");
    code.line(
      `${name}::Value ${name}::parse(yaffle::BytesView data) { return parse(data, Options{}); }`
    );
    code.line("");
    code.block(`${name}::Value ${name}::parse(yaffle::BytesView data, const Options& o)`, () => {
      code.line(`yaffle::Reader r(data, o.strict);`);
      code.line(`Value v{};`);
      code.line(`root_read_${name}(r, o, v);`);
      code.line(`return v;`);
    });
    code.line("");
    code.line(
      `yaffle::Bytes ${name}::serialize(const Value& value) { return serialize(value, Options{}); }`
    );
    code.line("");
    code.block(`yaffle::Bytes ${name}::serialize(const Value& value, const Options& o)`, () => {
      code.line(`return root_write_${name}(value, o, nullptr);`);
    });
    code.line("");
    if (this.d.views) this.defineRootViews(code, s);
    this.defineRootJson(code, s);
  }

  /** `view(…)` and `view_file(…)`: a document whose materialization and commit use the root API. */
  private defineRootViews(code: Code, s: IrStruct): void {
    const { model, reader } = this.d;
    const name = model.structName(s.id);
    const shared = model.isShared(s.id);
    const view = `${name}View`;
    code.line(
      `${view} ${name}::view(yaffle::Bytes data) { return view(std::move(data), Options{}); }`
    );
    code.line("");
    code.line(
      `${view} ${name}::view(yaffle::Bytes data, const Options& o) { return view(std::make_shared<yaffle::MemStore>(std::move(data)), o); }`
    );
    code.line("");
    code.line(
      `${view} ${name}::view_file(const std::string& path, const Options& o) { return view(std::make_shared<yaffle::FileStore>(path), o); }`
    );
    code.line("");
    code.block(`${view} ${name}::view(yaffle::StorePtr source, const Options& o)`, () => {
      this.prelude(code, s);
      code.line(`auto doc = std::make_shared<yaffle::Doc>(std::move(source));`);
      const args = s.params.map(p => (p.origin === "endian" ? "endian" : localName(p.name)));
      code.line(
        `doc->root.args = std::make_shared<const ${name}_Args>(${name}_Args{${args.join(", ")}});`
      );
      code.line(`doc->root.loc.strict = o.strict;`);
      code.line(`doc->root.key = ${reader.rootKey(s)};`);
      code.line(`doc->materialize_fn = [o](yaffle::Doc& d) {`);
      code.indent(() => {
        code.line(`yaffle::Reader r = d.full_reader(o.strict);`);
        code.line(`r.origins = &d.origins;`);
        if (shared) {
          code.line(`Value v{};`);
          code.line(`root_read_${name}(r, o, v);`);
        } else {
          code.line(`auto v = std::make_shared<${name}>();`);
          code.line(`root_read_${name}(r, o, *v);`);
        }
        code.line(`d.value = v;`);
        code.line(s.base ? `d.root_inline = d.original_size();` : `d.root_inline = r.pos;`);
      });
      code.line(`};`);
      code.line(`doc->serialize_fn = [o](yaffle::Doc& d, yaffle::Grow g) {`);
      code.indent(() => {
        code.line(`yaffle::Sticky st{g, d.root_inline, d.original_size(), &d.origins};`);
        code.line(
          shared
            ? `return root_write_${name}(std::static_pointer_cast<${name}>(d.value), o, &st);`
            : `return root_write_${name}(*std::static_pointer_cast<${name}>(d.value), o, &st);`
        );
      });
      code.line(`};`);
      code.line(`return ${view}(doc, {}, true);`);
    });
    code.line("");
  }

  private defineRootJson(code: Code, s: IrStruct): void {
    const { model, json } = this.d;
    const name = model.structName(s.id);
    const shared = model.isShared(s.id);
    code.block(`yaffle::Json ${name}::to_json(const Value& value)`, () => {
      code.line(`yaffle::ToJsonCtx c;`);
      if (shared) code.line(`c.ref(value.get(), "");`);
      code.line(`return to_json_${name}(yaffle::obj(value), c, "");`);
    });
    code.line("");
    code.block(`${name}::Value ${name}::from_json(const yaffle::Json& json)`, () => {
      code.line(`yaffle::FromJsonCtx c;`);
      if (shared) {
        code.line(`auto v = std::make_shared<${name}>();`);
        code.line(`c.enter("", v);`);
        code.line(`from_json_${name}(json, c, "", *v);`);
        code.line(`c.leave("");`);
      } else {
        code.line(`${name} v;`);
        code.line(`from_json_${name}(json, c, "", v);`);
      }
      code.line(`return v;`);
    });
    code.line("");
    code.block(`${name}::Options ${name}::options_from_json(const yaffle::Json& args)`, () => {
      code.line(`Options o;`);
      code.line(`if (args.is_null()) return o;`);
      code.line(`const yaffle::Json& a = yaffle::object_from_json(args);`);
      code.line(
        `if (const yaffle::Json* e = a.find("endian")) o.endian = yaffle::endian_from_json(*e);`
      );
      code.line(
        `if (const yaffle::Json* e = a.find("strict")) o.strict = yaffle::bool_from_json(*e);`
      );
      for (const p of optionParams(s)) {
        const key = p.boundName ?? p.name;
        code.block(`if (const yaffle::Json* e = a.find(${str(key)}))`, () => {
          code.line(`yaffle::Frame fr;`);
          code.line(`yaffle::FromJsonCtx c;`);
          code.line(`o.${memberName(key)}.emplace();`);
          json.valueFromJsonInto(code, p.type, "(*e)", `(*o.${memberName(key)})`);
        });
      }
      code.line(`return o;`);
    });
    code.line("");
  }
}
