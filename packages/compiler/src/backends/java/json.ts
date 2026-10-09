/**
 * Canonical JSON emitter (docs/CONFORMANCE.md §3): `toJson` / `fromJson` per struct and union.
 * JSON values are plain Java objects: Map (insertion ordered), List, String, Boolean, Long,
 * Double and null.
 */
import type { IrStruct, IrType, IrValueType } from "../../ir/index.ts";
import { unlayer } from "./analysis.ts";
import { Code, str } from "./code.ts";
import type { ClassCtx } from "./ctx.ts";
import { isPrimitive, refInput, refType, type FieldRef, type Model } from "./model.ts";

export class JsonEmitter {
  readonly model: Model;
  readonly cls: ClassCtx;
  /** Lambda parameter counter (reset per field). */
  private lambdas = 0;
  /** Qualify user type names (inside union interfaces, whose records may shadow them). */
  private readonly qualify: boolean;

  constructor(model: Model, cls: ClassCtx, qualify = false) {
    this.model = model;
    this.cls = cls;
    this.qualify = qualify;
  }

  private tn(name: string): string {
    return this.qualify ? this.model.fq(name) : name;
  }

  private use(n: string): string {
    return this.cls.use(n);
  }

  private fresh(p: string): string {
    return `${p}${++this.lambdas}`;
  }

  /**
   * The JSON form of a field: its type and Java field. One-way transforms show their raw value,
   * and a field with different Java types in different branches lists them (`alts`).
   */
  private jsonField(
    s: IrStruct,
    f: FieldRef
  ): { t: IrType; java: string; javaType: string; alts: { t: IrType; java: string }[] } {
    const fi = this.model.fieldInfo(s, f.name);
    const t = unlayer(refType(f));
    if (f.field && t.kind === "transform" && !t.write && fi.raw) {
      return { t: t.inner, java: fi.raw.java, javaType: fi.raw.type, alts: [] };
    }
    return {
      t: refType(f),
      java: fi.java,
      javaType: fi.type,
      alts: fi.raw ? [] : this.branchTypes(s, f.name)
    };
  }

  emitStruct(code: Code, s: IrStruct): void {
    const name = this.model.className(s.id);
    const M = this.use("Map");
    const S = this.model.lang("String");
    const fields = this.model.outputFields(s);
    code.block(
      `static ${M}<${S}, Object> toJson(${name} $v, ${this.use("ToJsonCtx")} $c, ${S} $p)`,
      () => {
        code.line(`final ${M}<${S}, Object> $o = new ${this.use("LinkedHashMap")}<>();`);
        for (const f of fields) {
          const { t, java, alts } = this.jsonField(s, f);
          const present = this.model.fieldInfo(s, f.name).present;
          const v = `$v.${java}`;
          const path = `${this.use("ToJsonCtx")}.ptr($p, ${str(f.name)})`;
          this.lambdas = 0;
          // Different Java types in different branches: convert by the value's class.
          const conv =
            alts.length > 1
              ? alts.reduceRight((rest, a) => {
                  const x = this.fresh("$bt");
                  const cls = a.java.replace(/<.*>$/, "");
                  return `${v} instanceof ${cls} ${x} ? ${this.toJson(a.t, x, path)} : ${rest}`;
                }, v)
              : this.toJson(t, v, path);
          const put = `$o.put(${str(f.name)}, ${conv});`;
          if (!this.model.isConditional(s, f.name)) code.line(put);
          else if (present) code.line(`if (${v} != null || $v.${present}) ${put}`);
          else code.line(`if (${v} != null) ${put}`);
        }
        code.line("return $o;");
      }
    );
    code.line("");
    code.block(`static ${name} fromJson(Object $j, ${this.use("FromJsonCtx")} $c, ${S} $p)`, () => {
      code.line(`final ${M}<${S}, Object> $s = ${this.use("Canon")}.objectFromJson($j);`);
      code.line(`final ${name} $o = new ${name}();`);
      code.line(`$c.register($p, $o);`);
      if (fields.length) {
        const F = this.use("Frame");
        code.line(`final ${F} $fr = new ${F}();`);
        code.chain([
          ["try", () => fields.forEach(f => this.fieldFromJson(code, s, f))],
          [`catch (${this.use("YaffleException")} $e)`, () => code.line("throw $fr.rethrow($e);")]
        ]);
      }
      code.line("return $o;");
    });
  }

  private fieldFromJson(code: Code, s: IrStruct, f: FieldRef): void {
    const { t, java, javaType, alts } = this.jsonField(s, f);
    const present = this.model.fieldInfo(s, f.name).present;
    const key = str(f.name);
    const j = `$s.get(${key})`;
    const path = `${this.use("ToJsonCtx")}.ptr($p, ${key})`;
    this.lambdas = 0;
    // Different Java types in different branches: the first type the JSON converts to.
    const conv =
      alts.length > 1
        ? `${this.use("Rt")}.firstOf(${alts.map(a => `() -> ${this.fromJson(a.t, j, path, true)}`).join(", ")})`
        : this.fromJson(t, j, path, !isPrimitive(javaType));
    const required =
      !this.model.isConditional(s, f.name) && refInput(f) === "required" && !f.field?.hidden;
    code.line(`$fr.f = ${key};`);
    if (required && isPrimitive(javaType)) {
      // Primitives cannot be missing: a missing required one is an error here.
      code.chain([
        [`if ($s.containsKey(${key}))`, () => code.line(`$o.${java} = ${conv};`)],
        [
          "else",
          () =>
            code.line(
              `throw new ${this.use("YaffleException")}(${this.use("ErrorCode")}.INPUT, ${str(`missing required field ${f.name}`)});`
            )
        ]
      ]);
    } else if (present) {
      code.block(`if ($s.containsKey(${key}))`, () => {
        code.line(`$o.${java} = ${conv};`);
        code.line(`$o.${present} = true;`);
      });
    } else {
      code.line(`if ($s.containsKey(${key})) $o.${java} = ${conv};`);
    }
  }

  /**
   * The distinct Java types a field has in different branches (one entry when they agree), in
   * declaration order.
   */
  private branchTypes(s: IrStruct, name: string): { t: IrType; java: string }[] {
    const out: { t: IrType; java: string }[] = [];
    for (const f of this.model.fields(s)) {
      if (f.name !== name) continue;
      const t = refType(f);
      const java = this.model.javaType(t, true);
      if (!out.some(o => o.java === java)) out.push({ t, java });
    }
    return out;
  }

  // ── to JSON ─────────────────────────────────────────────────────────────────

  toJson(t: IrType, v: string, path: string): string {
    switch (t.kind) {
      case "prim":
        return this.valueToJson(this.model.valueTypeOf(t), v, path);
      case "bool":
      case "string":
        return v;
      case "bytes":
        return `${this.use("Hex")}.encode(${v})`;
      case "array":
        return this.listToJson(v, path, (e, p) => this.toJson(t.element, e, p));
      case "struct":
        return this.structToJson(t.struct, v, path);
      case "enum":
        return this.enumToJson(t.enum, v);
      case "pointer": {
        const inner = this.toJson(t.target, v, path);
        return t.nullValue !== undefined && !t.emptyIsNull
          ? `${v} == null ? null : ${inner}`
          : inner;
      }
      case "extern": {
        const x = this.model.extern(t.extern);
        return x.kind === "type" ? this.valueToJson(x.valueType, v, path) : v;
      }
      case "union":
        return `${this.tn(this.model.unionOfT(t).name)}.toJson(${v}, $c, ${path})`;
      case "transform":
        return this.valueToJson(t.valueType, v, path);
      case "layered":
        return this.toJson(t.inner, v, path);
    }
  }

  private structToJson(id: string, v: string, path: string): string {
    const name = this.tn(this.model.className(id));
    const x = this.fresh("$x");
    const pp = this.fresh("$pp");
    return `$c.obj(${v}, ${path}, (${x}, ${pp}) -> ${name}.toJson(${x}, $c, ${pp}))`;
  }

  private enumToJson(id: string, v: string): string {
    const en = this.model.enum(id);
    if (!en.open) return `${v}.member()`;
    return `${this.use("Canon")}.enumToJson(${v}, ${this.use("Prim")}.${en.storage.toUpperCase()})`;
  }

  /** An array: a `$ref` if already written, else the elements converted. */
  private listToJson(v: string, path: string, conv: (e: string, path: string) => string): string {
    const e = this.fresh("$e");
    const pp = this.fresh("$q");
    const inner = conv(e, pp);
    if (inner.includes(pp)) return `$c.list(${v}, ${path}, (${e}, ${pp}) -> ${inner})`;
    if (inner === e) return `$c.list(${v}, ${path})`;
    return `$c.list(${v}, ${path}, ${e} -> ${inner})`;
  }

  valueToJson(t: IrValueType, v: string, path: string): string {
    const C = this.use("Canon");
    switch (t.kind) {
      case "int":
        if (t.bits <= 48) return v;
        return t.signed || t.bits < 64 ? `${C}.bigToJson(${v})` : `${C}.u64ToJson(${v})`;
      case "bigint":
        return `${C}.bigToJson(${v})`;
      case "float":
        return `${C}.floatToJson(${v})`;
      case "bytes":
        return `${this.use("Hex")}.encode(${v})`;
      case "struct":
        return this.structToJson(t.struct, v, path);
      case "array":
        return this.listToJson(v, path, (e, p) => this.valueToJson(t.element, e, p));
      case "nullable":
        return `${v} == null ? null : ${this.valueToJson(t.inner, v, path)}`;
      case "extern":
        return this.valueToJson(t.valueType, v, path);
      case "union":
        return `${this.tn(this.model.unionOfV(t).name)}.toJson(${v}, $c, ${path})`;
      case "enum":
        return this.enumToJson(t.enum, v);
      case "endian":
        return `${v}.json()`;
      default:
        return v;
    }
  }

  // ── from JSON ───────────────────────────────────────────────────────────────

  /** JSON → the Java type of `t` (`boxed`: the destination is a reference type). */
  fromJson(t: IrType, j: string, path: string, boxed = false): string {
    switch (t.kind) {
      case "prim":
      case "bool":
      case "string":
      case "bytes":
      case "struct":
      case "enum":
        return this.valueFromJson(this.model.valueTypeOf(t), j, path);
      case "array": {
        const e = this.fresh("$e");
        const p = this.fresh("$q");
        return `$c.arr(${j}, ${path}, (${e}, ${p}) -> ${this.fromJson(t.element, e, p, true)})`;
      }
      case "pointer": {
        const inner = this.fromJson(t.target, j, path, boxed);
        if (t.nullValue === undefined || t.emptyIsNull) return inner;
        return `${j} == null ? null : ${this.boxValue(this.model.valueTypeOf(t.target), inner)}`;
      }
      case "extern": {
        const x = this.model.extern(t.extern);
        return x.kind === "type" ? this.valueFromJson(x.valueType, j, path) : j;
      }
      case "union":
        return `${this.tn(this.model.unionOfT(t).name)}.fromJson(${j}, $c, ${path})`;
      case "transform":
        if (!t.write) return this.fromJson(t.inner, j, path, boxed);
        return this.valueFromJson(t.valueType, j, path);
      case "layered":
        return this.fromJson(t.inner, j, path, boxed);
    }
  }

  /** `code` of a primitive Java type boxed (`Integer.valueOf(…)`); reference types as they are. */
  private boxValue(t: IrValueType, code: string): string {
    const b = this.model.javaValueType(t, true);
    return this.model.javaValueType(t, false) !== b ? `${b}.valueOf(${code})` : code;
  }

  valueFromJson(t: IrValueType, j: string, path: string): string {
    const C = this.use("Canon");
    switch (t.kind) {
      case "int": {
        if (t.bits === 64 && !t.signed) return `${C}.u64FromJson(${j})`;
        if (t.bits > 48) return `${C}.i64FromJson(${j})`;
        const k = (t.signed && t.bits <= 32) || (!t.signed && t.bits <= 24);
        return k ? `${C}.int32FromJson(${j})` : `${C}.intFromJson(${j})`;
      }
      case "bigint":
        return `${C}.bigFromJson(${j})`;
      case "float":
        return t.bits === 32 ? `${C}.f32FromJson(${j})` : `${C}.floatFromJson(${j})`;
      case "bool":
        return `${C}.boolFromJson(${j})`;
      case "string":
        return `${C}.stringFromJson(${j})`;
      case "bytes":
        return `$c.bytes(${j}, ${path})`;
      case "struct": {
        const name = this.tn(this.model.className(t.struct));
        const jj = this.fresh("$jj");
        const pp = this.fresh("$pp");
        return `$c.obj(${j}, ${path}, ${name}.class, (${jj}, ${pp}) -> ${name}.fromJson(${jj}, $c, ${pp}))`;
      }
      case "enum":
        return `${this.tn(this.model.enumName(t.enum))}.fromJson(${j})`;
      case "array": {
        const e = this.fresh("$e");
        const p = this.fresh("$q");
        return `$c.arr(${j}, ${path}, (${e}, ${p}) -> ${this.valueFromJson(t.element, e, p)})`;
      }
      case "nullable":
        return `${j} == null ? null : ${this.boxValue(t.inner, this.valueFromJson(t.inner, j, path))}`;
      case "extern":
        return this.valueFromJson(t.valueType, j, path);
      case "endian":
        return `${this.use("Endian")}.fromJson(${j})`;
      case "union":
        return `${this.tn(this.model.unionOfV(t).name)}.fromJson(${j}, $c, ${path})`;
    }
  }
}
