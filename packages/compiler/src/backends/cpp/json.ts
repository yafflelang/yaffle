/**
 * Canonical JSON emitter (docs/CONFORMANCE.md §3): `to_json_X` / `from_json_X` per struct, and
 * `yaffle_struct_equal` (value equality of structs is equality of their canonical JSON).
 */
import type { IrStruct, IrType, IrValueType } from "../../ir/index.ts";
import { isOneWay, stripLayers, valueTypeOf } from "./analysis.ts";
import { Code, str } from "./code.ts";
import type { FieldRef, Model } from "./model.ts";
import type { Names } from "./names.ts";
import { intCppType, type TypeMapper } from "./types.ts";

type Transform = Extract<IrType, { kind: "transform" }>;

export class JsonEmitter {
  readonly model: Model;
  readonly types: TypeMapper;
  readonly names: Names;
  private code!: Code;

  constructor(model: Model, types: TypeMapper, names: Names) {
    this.model = model;
    this.types = types;
    this.names = names;
  }

  prototypes(s: IrStruct): string[] {
    const n = this.model.structName(s.id);
    return [
      `${this.toPrototype(n)};`,
      `${this.fromPrototype(n)};`,
      `static bool yaffle_struct_equal(const ${n}& a, const ${n}& b);`
    ];
  }

  private toPrototype(n: string): string {
    return `static yaffle::Json to_json_${n}(const ${n}& v, [[maybe_unused]] yaffle::ToJsonCtx& c, [[maybe_unused]] const std::string& p)`;
  }

  private fromPrototype(n: string): string {
    return `static void from_json_${n}(const yaffle::Json& j, [[maybe_unused]] yaffle::FromJsonCtx& c, [[maybe_unused]] const std::string& p, ${n}& o)`;
  }

  /** `to_json_X`, `from_json_X` and `yaffle_struct_equal`. */
  emitStruct(out: Code, s: IrStruct): void {
    const n = this.model.structName(s.id);
    const fields = this.model
      .uniqueFields(s)
      .filter(f => (f.field ? f.field.output : f.bit!.output));
    this.code = out;
    out.block(this.toPrototype(n), () => {
      out.line(`yaffle::Json o = yaffle::Json::object();`);
      for (const f of fields) this.fieldToJson(s, f);
      out.line("return o;");
    });
    out.line("");
    out.block(this.fromPrototype(n), () => {
      out.line(`const yaffle::Json& s_ = yaffle::object_from_json(j);`);
      out.line(`yaffle::Frame fr;`);
      out.rethrow(() => {
        for (const f of fields) this.fieldFromJson(s, f);
      }, "e.prefix(fr);");
    });
    out.line("");
    out.block(`static bool yaffle_struct_equal(const ${n}& a, const ${n}& b)`, () => {
      out.line(`yaffle::ToJsonCtx ca, cb;`);
      out.line(`return to_json_${n}(a, ca, "") == to_json_${n}(b, cb, "");`);
    });
  }

  private fieldToJson(s: IrStruct, f: FieldRef): void {
    const c = this.code;
    const t = f.field ? f.field.type : f.bit!.type;
    const m = `v.${this.model.member(f.name)}`;
    const path = `yaffle::ptr(p, ${str(f.name)})`;
    const set = (type: IrType, value: string): void => {
      c.line(`o.set(${str(f.name)}, ${this.toJson(type, value, path)});`);
    };
    const emit = (value: string): void => {
      if (!(f.field && isOneWay(f.field.type))) {
        set(t, value);
        return;
      }
      // A one-way transform shows its raw value when the value came from a parse.
      const raw = `v.${this.names.rawMember(s, f.name)}`;
      const tt = stripLayers(f.field.type) as Transform;
      c.chain([
        [`if (${raw})`, () => set(tt.inner, `(*${raw})`)],
        ["else", () => set(tt, value)]
      ]);
    };
    if (this.model.isOptionalMember(s, f.name)) c.block(`if (${m})`, () => emit(`(*${m})`));
    else emit(m);
  }

  private fieldFromJson(s: IrStruct, f: FieldRef): void {
    const c = this.code;
    const t = f.field ? f.field.type : f.bit!.type;
    const input = f.field ? f.field.input : f.bit!.input;
    const m = `o.${this.model.member(f.name)}`;
    const opt = this.model.isOptionalMember(s, f.name);
    const jf = c.fresh("jf");
    const path = `yaffle::ptr(p, ${str(f.name)})`;
    c.line(`fr.field = ${str(f.name)};`);
    const lenient = input === "absent";
    const assign = (): void => {
      if (f.field && isOneWay(f.field.type) && !lenient) {
        // A one-way transform: the JSON holds the raw value.
        const raw = `o.${this.names.rawMember(s, f.name)}`;
        c.line(`${raw}.emplace();`);
        this.fromJson(
          (stripLayers(f.field.type) as Transform).inner,
          `(*${jf})`,
          `(*${raw})`,
          path,
          false,
          0
        );
        return;
      }
      let dst = m;
      if (opt) {
        c.line(`${m}.emplace();`);
        dst = `(*${m})`;
      }
      this.fromJson(t, `(*${jf})`, dst, path, lenient, 0);
    };
    // Arrays carrying stream pieces may be left out (the @split policy creates them).
    const required =
      input === "required" &&
      !opt &&
      !(f.field?.hidden ?? false) &&
      !this.model.streamArrays.has(`${s.id}.${f.name}`);
    const parts: [string, () => void][] = [
      [`if (const yaffle::Json* ${jf} = s_.find(${str(f.name)}))`, assign]
    ];
    if (required)
      parts.push([
        "else",
        () =>
          c.line(
            `yaffle::fail(yaffle::ErrorCode::Input, ${str(`missing required field ${f.name}`)});`
          )
      ]);
    c.chain(parts);
  }

  // ── to JSON ───────────────────────────────────────────────────────────────

  /** Emits statements as needed and returns an expression of the JSON of `v` (type `t`). */
  private toJson(t: IrType, v: string, path: string): string {
    switch (t.kind) {
      case "prim":
      case "bool":
      case "string":
      case "bytes":
      case "struct":
      case "enum":
        return this.valueToJson(valueTypeOf(this.model, t), v, path);
      case "array":
        return this.arrayToJson(v, path, (e, p) => this.toJson(t.element, e, p));
      case "pointer":
        return this.pointerToJson(t, v, path);
      case "extern": {
        const xd = this.model.extern(t.extern);
        return xd.kind === "type"
          ? this.valueToJson(xd.valueType, v, path)
          : `yaffle::Json(yaffle::to_hex(${v}))`;
      }
      case "union":
        return this.unionToJson(t.variants, v, (vt, e) =>
          this.toJson(vt, e, `yaffle::ptr(${path}, "value")`)
        );
      case "transform":
        return this.valueToJson(t.valueType, v, path);
      case "layered":
        return this.toJson(t.inner, v, path);
    }
  }

  private pointerToJson(t: Extract<IrType, { kind: "pointer" }>, v: string, path: string): string {
    const c = this.code;
    const x = stripLayers(t.target);
    const j = c.fresh("jp");
    c.line(`yaffle::Json ${j};`);
    if (this.types.sharedTarget(t.target)) {
      const nullJson = t.emptyIsNull ? "yaffle::Json::array()" : "yaffle::Json()";
      c.chain([
        [`if (!${v})`, () => c.line(`${j} = ${nullJson};`)],
        [
          "else",
          () => {
            if (x.kind === "struct") {
              c.line(`${j} = ${this.toJson(t.target, v, path)};`);
              return;
            }
            // Shared array or union targets: a `$ref` after the first occurrence.
            const r = c.fresh("r");
            c.chain([
              [
                `if (auto ${r} = c.ref(${v}.get(), ${path}))`,
                () => c.line(`${j} = std::move(*${r});`)
              ],
              ["else", () => c.line(`${j} = ${this.toJson(t.target, `(*${v})`, path)};`)]
            ]);
          }
        ]
      ]);
    } else if (t.nullValue !== undefined && !t.emptyIsNull) {
      c.chain([
        [`if (!${v})`, () => c.line(`${j} = yaffle::Json();`)],
        ["else", () => c.line(`${j} = ${this.toJson(t.target, `(*${v})`, path)};`)]
      ]);
    } else c.line(`${j} = ${this.toJson(t.target, v, path)};`);
    return j;
  }

  private arrayToJson(v: string, path: string, elem: (e: string, p: string) => string): string {
    const c = this.code;
    const j = c.fresh("ja");
    const i = c.fresh("i");
    c.line(`yaffle::Json ${j} = yaffle::Json::array();`);
    c.line(`${j}.as_array().reserve(${v}.size());`);
    c.block(`for (std::size_t ${i} = 0; ${i} < ${v}.size(); ${i}++)`, () => {
      const e = elem(`${v}[${i}]`, `yaffle::ptr(${path}, static_cast<std::int64_t>(${i}))`);
      c.line(`${j}.push(${e});`);
    });
    return j;
  }

  private structToJson(id: string, v: string, path: string): string {
    const n = this.model.structName(id);
    if (!this.model.isShared(id)) return `to_json_${n}(${v}, c, ${path})`;
    const c = this.code;
    const j = c.fresh("js");
    const r = c.fresh("r");
    c.line(`yaffle::Json ${j};`);
    c.chain([
      [`if (!${v})`, () => c.line(`${j} = yaffle::Json();`)],
      [
        `else if (auto ${r} = c.ref(${v}.get(), ${path}))`,
        () => c.line(`${j} = std::move(*${r});`)
      ],
      ["else", () => c.line(`${j} = to_json_${n}(*${v}, c, ${path});`)]
    ]);
    return j;
  }

  /** `{"type": variant, "value": …}`. */
  private unionToJson<T>(
    variants: readonly { name: string; type: T }[],
    v: string,
    value: (t: T, e: string) => string
  ): string {
    const c = this.code;
    const j = c.fresh("ju");
    c.line(`yaffle::Json ${j} = yaffle::Json::object();`);
    c.block(`switch (${v}.index())`, () => {
      variants.forEach((vr, i) => {
        c.line(`case ${i}: {`);
        c.indent(() => {
          c.line(`${j}.set("type", ${str(vr.name)});`);
          c.line(`${j}.set("value", ${value(vr.type, `std::get<${i}>(${v})`)});`);
          c.line("break;");
        });
        c.line("}");
      });
      c.line("default: break;");
    });
    return j;
  }

  private valueToJson(t: IrValueType, v: string, path: string): string {
    const c = this.code;
    switch (t.kind) {
      case "int":
        return intToJson(t.bits, v);
      case "bigint":
        return intToJson(128, v);
      case "float":
        return `yaffle::float_to_json(static_cast<double>(${v}))`;
      case "bool":
        return `yaffle::Json(static_cast<bool>(${v}))`;
      case "string":
        return `yaffle::Json(${v})`;
      case "bytes":
        return `yaffle::Json(yaffle::to_hex(${v}))`;
      case "endian":
        return `yaffle::Json(${v} == yaffle::Endian::le ? "le" : "be")`;
      case "struct":
        return this.structToJson(t.struct, v, path);
      case "enum":
        return `enum_to_json_${this.model.enumName(t.enum)}(${v})`;
      case "array":
        return this.arrayToJson(v, path, (e, p) => this.valueToJson(t.element, e, p));
      case "nullable": {
        const j = c.fresh("jn");
        c.line(`yaffle::Json ${j};`);
        const shared = this.types.valueType(t.inner).startsWith("std::shared_ptr<");
        c.block(`if (${v})`, () =>
          c.line(`${j} = ${this.valueToJson(t.inner, shared ? v : `(*${v})`, path)};`)
        );
        return j;
      }
      case "union":
        return this.unionToJson(t.variants, v, (vt, e) => this.valueToJson(vt, e, path));
      case "extern":
        return this.valueToJson(t.valueType, v, path);
    }
  }

  // ── from JSON ─────────────────────────────────────────────────────────────

  /** Converts JSON `j` of a value type into `dst`, emitting into `code` (root options). */
  valueFromJsonInto(code: Code, t: IrValueType, j: string, dst: string): void {
    this.code = code;
    this.valueFromJson(t, j, dst, '""', false, 0);
  }

  /** Emits statements converting JSON `j` into the lvalue `dst` (type `t`). */
  private fromJson(
    t: IrType,
    j: string,
    dst: string,
    path: string,
    lenient: boolean,
    depth: number
  ): void {
    const c = this.code;
    switch (t.kind) {
      case "prim":
      case "bool":
      case "string":
      case "bytes":
      case "struct":
      case "enum":
        this.valueFromJson(valueTypeOf(this.model, t), j, dst, path, lenient, depth);
        return;
      case "array":
        this.arrayFromJson(this.types.type(t.element), j, dst, path, depth, (e, d, p) =>
          this.fromJson(t.element, e, d, p, lenient, depth + 1)
        );
        return;
      case "pointer":
        this.pointerFromJson(t, j, dst, path, lenient, depth);
        return;
      case "extern": {
        const xd = this.model.extern(t.extern);
        if (xd.kind === "type") this.valueFromJson(xd.valueType, j, dst, path, lenient, depth);
        else c.line(`${dst} = yaffle::bytes_from_json(${j});`);
        return;
      }
      case "union":
        this.unionFromJson(this.types.type(t), t.variants, j, dst, (vt, uj, udst) =>
          c.rethrow(
            () => this.fromJson(vt, uj, udst, `yaffle::ptr(${path}, "value")`, lenient, depth),
            `e.prefix("value");`
          )
        );
        return;
      case "transform":
        // The JSON holds the transformed value (one-way transforms below the field level too).
        this.valueFromJson(t.valueType, j, dst, path, lenient, depth);
        return;
      case "layered":
        this.fromJson(t.inner, j, dst, path, lenient, depth);
        return;
    }
  }

  private pointerFromJson(
    t: Extract<IrType, { kind: "pointer" }>,
    j: string,
    dst: string,
    path: string,
    lenient: boolean,
    depth: number
  ): void {
    const c = this.code;
    const shared = this.types.sharedTarget(t.target);
    const x = stripLayers(t.target);
    const body = (): void => {
      if (!shared) {
        if (t.nullValue !== undefined && !t.emptyIsNull) {
          c.line(`${dst}.emplace();`);
          this.fromJson(t.target, j, `(*${dst})`, path, lenient, depth);
        } else this.fromJson(t.target, j, dst, path, lenient, depth);
        return;
      }
      if (x.kind === "struct") {
        this.fromJson(t.target, j, dst, path, lenient, depth);
        return;
      }
      // Shared array or union target: identity through `$ref`.
      this.sharedFromJson(this.types.type(x), j, dst, path, obj =>
        this.fromJson(t.target, j, `(*${obj})`, path, lenient, depth)
      );
    };
    if (t.nullValue === undefined) {
      body();
      return;
    }
    const nullValue = t.emptyIsNull
      ? shared
        ? `std::make_shared<${this.types.type(x)}>()`
        : "{}"
      : shared
        ? "nullptr"
        : "std::nullopt";
    c.chain([
      [`if (${j}.is_null())`, () => c.line(`${dst} = ${nullValue};`)],
      ["else", body]
    ]);
  }

  /**
   * A shared object of type `T` from JSON: the earlier object a `$ref` names, or a new one
   * registered under `path` while `fill` converts its contents.
   */
  private sharedFromJson(
    T: string,
    j: string,
    dst: string,
    path: string,
    fill: (obj: string) => void
  ): void {
    const c = this.code;
    const rp = c.fresh("rp");
    c.chain([
      [
        `if (const std::string* ${rp} = yaffle::FromJsonCtx::ref_path(${j}))`,
        () => c.line(`${dst} = c.deref<${T}>(*${rp});`)
      ],
      [
        "else",
        () => {
          const obj = c.fresh("obj");
          c.line(`auto ${obj} = std::make_shared<${T}>();`);
          c.line(`c.enter(${path}, ${obj});`);
          fill(obj);
          c.line(`c.leave(${path});`);
          c.line(`${dst} = ${obj};`);
        }
      ]
    ]);
  }

  private arrayFromJson(
    elemT: string,
    j: string,
    dst: string,
    path: string,
    depth: number,
    elem: (j: string, dst: string, path: string) => void
  ): void {
    const c = this.code;
    if (depth >= 16) throw new Error("arrays nested deeper than 16 levels are not supported");
    const ja = c.fresh("ja");
    const a = c.fresh("a");
    const i = c.fresh("i");
    c.line(`const yaffle::Json::Array& ${ja} = yaffle::array_from_json(${j});`);
    c.line(`std::vector<${elemT}> ${a};`);
    c.line(`${a}.reserve(${ja}.size());`);
    c.block(`for (std::size_t ${i} = 0; ${i} < ${ja}.size(); ${i}++)`, () => {
      c.line(`fr.idx[${depth}] = static_cast<std::int64_t>(${i});`);
      c.line(`${a}.emplace_back();`);
      elem(`${ja}[${i}]`, `${a}.back()`, `yaffle::ptr(${path}, static_cast<std::int64_t>(${i}))`);
    });
    c.line(`fr.idx[${depth}] = -1;`);
    c.line(`${dst} = std::move(${a});`);
  }

  private structFromJson(id: string, j: string, dst: string, path: string): void {
    const c = this.code;
    const n = this.model.structName(id);
    if (this.model.isShared(id)) {
      this.sharedFromJson(n, j, dst, path, obj =>
        c.line(`from_json_${n}(${j}, c, ${path}, *${obj});`)
      );
      return;
    }
    c.line(
      `if (yaffle::FromJsonCtx::ref_path(${j})) yaffle::fail(yaffle::ErrorCode::Input, "not implemented: $ref to a value that is not shared");`
    );
    c.line(`from_json_${n}(${j}, c, ${path}, ${dst});`);
  }

  /** `{"type": variant, "value": …}` into `dst` (a `std::variant` of type `T`). */
  private unionFromJson<V>(
    T: string,
    variants: readonly { name: string; type: V }[],
    j: string,
    dst: string,
    value: (t: V, j: string, dst: string) => void
  ): void {
    const c = this.code;
    const uo = c.fresh("uo");
    const ut = c.fresh("ut");
    const uv = c.fresh("uv");
    const unknown = `yaffle::fail(yaffle::ErrorCode::Input, "unknown union variant");`;
    c.line(`const yaffle::Json& ${uo} = yaffle::object_from_json(${j});`);
    c.line(`const yaffle::Json* ${ut} = ${uo}.find("type");`);
    c.line(`static const yaffle::Json null_json_;`);
    c.line(`const yaffle::Json* ${uv} = ${uo}.find("value");`);
    c.line(`if (!${uv}) ${uv} = &null_json_;`);
    c.line(`if (!${ut} || !${ut}->is_string()) ${unknown}`);
    const parts: [string, () => void][] = variants.map((vr, i) => [
      `${i ? "else if" : "if"} (${ut}->as_string() == ${str(vr.name)})`,
      () => {
        const tmp = c.fresh("u");
        c.line(`${T} ${tmp}(std::in_place_index<${i}>);`);
        value(vr.type, `(*${uv})`, `std::get<${i}>(${tmp})`);
        c.line(`${dst} = std::move(${tmp});`);
      }
    ]);
    parts.push(["else", () => c.line(unknown)]);
    c.chain(parts);
  }

  private valueFromJson(
    t: IrValueType,
    j: string,
    dst: string,
    path: string,
    lenient: boolean,
    depth: number
  ): void {
    const c = this.code;
    switch (t.kind) {
      case "int":
        c.line(`${dst} = ${intFromJson(t.bits, t.signed, j, lenient)};`);
        return;
      case "bigint":
        c.line(`${dst} = yaffle::big_from_json(${j});`);
        return;
      case "float":
        c.line(
          `${dst} = static_cast<${t.bits === 64 ? "double" : "float"}>(yaffle::float_from_json(${j}));`
        );
        return;
      case "bool":
        c.line(`${dst} = yaffle::bool_from_json(${j});`);
        return;
      case "string":
        c.line(`${dst} = yaffle::string_from_json(${j});`);
        return;
      case "bytes":
        c.line(`${dst} = yaffle::bytes_from_json(${j});`);
        return;
      case "endian":
        c.line(`${dst} = yaffle::endian_from_json(${j});`);
        return;
      case "struct":
        this.structFromJson(t.struct, j, dst, path);
        return;
      case "enum":
        c.line(`${dst} = enum_from_json_${this.model.enumName(t.enum)}(${j});`);
        return;
      case "array":
        this.arrayFromJson(this.types.valueType(t.element), j, dst, path, depth, (e, d, p) =>
          this.valueFromJson(t.element, e, d, p, lenient, depth + 1)
        );
        return;
      case "nullable": {
        const shared = this.types.valueType(t.inner).startsWith("std::shared_ptr<");
        c.chain([
          [`if (${j}.is_null())`, () => c.line(`${dst} = ${shared ? "nullptr" : "std::nullopt"};`)],
          [
            "else",
            () => {
              if (shared) this.valueFromJson(t.inner, j, dst, path, lenient, depth);
              else {
                c.line(`${dst}.emplace();`);
                this.valueFromJson(t.inner, j, `(*${dst})`, path, lenient, depth);
              }
            }
          ]
        ]);
        return;
      }
      case "union":
        this.unionFromJson(this.types.valueType(t), t.variants, j, dst, (vt, uj, udst) =>
          this.valueFromJson(vt, uj, udst, path, lenient, depth)
        );
        return;
      case "extern":
        this.valueFromJson(t.valueType, j, dst, path, lenient, depth);
        return;
    }
  }
}

/** Integers up to 48 bits are JSON numbers, wider ones decimal strings. */
function intToJson(bits: number, v: string): string {
  return bits > 48
    ? `yaffle::Json(yaffle::to_string(static_cast<yaffle::i128>(${v})))`
    : `yaffle::Json(static_cast<double>(${v}))`;
}

function intFromJson(bits: number, signed: boolean, j: string, lenient: boolean): string {
  const ct = intCppType(bits, signed);
  if (lenient)
    return `static_cast<${ct}>(${bits > 48 ? `yaffle::big_from_json(${j})` : `yaffle::int_from_json(${j})`})`;
  return `yaffle::int_from_json_as<${ct}>(${j}, ${bits}, ${signed})`;
}
