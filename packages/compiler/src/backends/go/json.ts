/** Canonical JSON emitter (docs/CONFORMANCE.md §3): `toJSONX` / `fromJSONX` per struct. */
import type { IrStruct, IrType, IrValueType } from "../../ir/index.ts";
import { Code, fixUnused, goStr } from "./code.ts";
import { formatInt } from "./expr.ts";
import { stripLayers } from "./irutil.ts";
import { BackendError, isNilable, primGo, type GoField, type Model } from "./model.ts";

export class JsonEmitter {
  readonly model: Model;
  private counter = 0;
  private readonly pathMemo = new Map<string, boolean>();

  constructor(model: Model) {
    this.model = model;
  }

  private v(prefix: string): string {
    return `${prefix}${++this.counter}`;
  }

  /** True if values of this type can contain shared objects (so their JSON paths matter). */
  needsPath(t: IrType): boolean {
    switch (t.kind) {
      case "struct":
        return this.structNeedsPath(t.struct);
      case "array":
        return true;
      case "pointer":
        return this.needsPath(t.target) || t.target.kind === "array";
      case "union":
        return true;
      case "transform":
      case "layered":
        return this.needsPath(t.inner);
      default:
        return false;
    }
  }

  structNeedsPath(id: string): boolean {
    const hit = this.pathMemo.get(id);
    if (hit !== undefined) return hit;
    this.pathMemo.set(id, true);
    const s = this.model.struct(id);
    let v = this.model.identityStructs.has(id);
    if (!v) {
      for (const f of this.model.fields(s)) {
        if (f.field && f.field.output && this.needsPath(f.field.type)) {
          v = true;
          break;
        }
      }
    }
    this.pathMemo.set(id, v);
    return v;
  }

  emitStruct(code: Code, s: IrStruct): void {
    const name = this.model.structName(s.id);
    const fields = this.model.goFieldsOf(s).filter(g => !g.hidden);
    // toJSON
    const tj = new Code();
    tj.block(`func toJSON${name}(j *yaffle.JSONWriter, v *${name}, p string)`, () => {
      tj.line("j.BeginObject()");
      for (const g of fields) {
        const { go, type } = jsonValue(g);
        const emit = (): void => {
          tj.line(`j.Key(${goStr(g.name)})`);
          this.toJSON(
            tj,
            type,
            g.ptr ? `(*v.${go})` : `v.${go}`,
            `yaffle.JPtr(p, ${goStr(g.name)})`
          );
        };
        if (g.nilAbsent) tj.block(`if v.${g.go} != nil`, emit);
        else emit();
      }
      tj.line("j.EndObject()");
    });
    code.line(fixUnused(tj.toString()));
    code.line("");
    // fromJSON
    const fj = new Code();
    fj.block(`func fromJSON${name}(c *yaffle.FromJSON, j any, p string) *${name}`, () => {
      fj.line("o := yaffle.JObject(j)");
      fj.line(`v := &${name}{}`);
      fj.line("c.Register(p, v)");
      fj.line("fr := c.PS.Enter()");
      for (const g of fields) {
        const f = g.ref;
        const input = f.field ? f.field.input : f.bit!.input;
        const required =
          input === "required" &&
          !f.conditional &&
          !f.field?.from &&
          !this.model.streamSources.has(`${s.id}.${g.name}`);
        fj.line(`c.PS.Field(fr, ${goStr(g.name)})`);
        const x = this.v("x");
        const { go, type } = jsonValue(g);
        const conv = this.fromJSON(type, x, `yaffle.JPtr(p, ${goStr(g.name)})`);
        const assign = g.ptr ? `v.${go} = yaffle.Ptr(${conv})` : `v.${go} = ${conv}`;
        if (required) {
          fj.chain([
            [`if ${x}, ok := o[${goStr(g.name)}]; ok`, () => fj.line(assign)],
            [
              "else",
              () =>
                fj.line(
                  `yaffle.FailMsg(yaffle.INPUT, ${goStr(`missing required field ${g.name}`)})`
                )
            ]
          ]);
        } else {
          fj.block(`if ${x}, ok := o[${goStr(g.name)}]; ok`, () => fj.line(assign));
        }
      }
      fj.line("c.PS.Leave(fr)");
      fj.line("return v");
    });
    code.line(fixUnused(fj.toString()));
  }

  /** Emits statements writing value v of IR type t. */
  toJSON(c: Code, t: IrType, v: string, path: string): void {
    switch (t.kind) {
      case "prim":
        c.line(this.primToJSON(t.prim, v));
        return;
      case "bool":
        c.line(`j.Bool(${v})`);
        return;
      case "string":
        c.line(`j.Str(${v})`);
        return;
      case "bytes":
        c.line(`j.Hex(${v})`);
        return;
      case "array": {
        const e = this.v("e");
        const i = this.v("i");
        const pp = this.needsPath(t.element) ? this.v("q") : undefined;
        const body = (): void => {
          c.line("j.BeginArray()");
          c.block(`for ${pp ? i : "_"}, ${e} := range ${v}`, () => {
            if (pp) c.line(`${pp} := yaffle.JPtrI(${path}, ${i})`);
            this.toJSON(c, t.element, e, pp ?? `""`);
          });
          c.line("j.EndArray()");
        };
        c.block(`if !j.Ref(yaffle.SliceID(${v}), ${path})`, body);
        return;
      }
      case "struct": {
        const fn = `toJSON${this.model.structName(t.struct)}`;
        const share = this.model.identityStructs.has(t.struct);
        const pathArg = this.structNeedsPath(t.struct) ? path : `""`;
        c.chain([
          [`if ${v} == nil`, () => c.line("j.Null()")],
          ...(share
            ? ([[`else if !j.Ref(${v}, ${path})`, () => c.line(`${fn}(j, ${v}, ${pathArg})`)]] as [
                string,
                () => void
              ][])
            : ([["else", () => c.line(`${fn}(j, ${v}, ${pathArg})`)]] as [string, () => void][]))
        ]);
        return;
      }
      case "enum":
        c.line(`toJSON${this.model.enumName(t.enum)}(j, ${v})`);
        return;
      case "pointer": {
        const goT = this.model.goType(t);
        const targetGo = this.model.goType(t.target);
        if (t.nullValue !== undefined && !t.emptyIsNull) {
          const inner = goT !== targetGo ? `(*${v})` : v;
          if (isNilable(targetGo) && targetGo.startsWith("*")) {
            this.toJSON(c, t.target, inner, path);
            return;
          }
          c.chain([
            [`if ${v} == nil`, () => c.line("j.Null()")],
            ["else", () => this.toJSON(c, t.target, inner, path)]
          ]);
          return;
        }
        this.toJSON(c, t.target, v, path);
        return;
      }
      case "extern": {
        const x = this.model.extern(t.extern);
        if (x.kind !== "type") throw new BackendError("extern value of a non-type");
        this.valueToJSON(c, x.valueType, v, path);
        return;
      }
      case "union": {
        const info = this.model.unionOf(t);
        c.chain([
          [`if ${v} == nil`, () => c.line("j.Null()")],
          [
            "else",
            () => {
              c.line("j.BeginObject()");
              c.line(`j.Key("type")`);
              c.line(`j.Str(${v}.Type)`);
              c.line(`j.Key("value")`);
              c.line(`switch ${v}.Type {`);
              t.variants.forEach((vr, i) => {
                c.line(`case ${goStr(vr.name)}:`);
                c.indent(() =>
                  this.toJSON(
                    c,
                    vr.type,
                    `${v}.${info.variants[i]!.go}`,
                    `yaffle.JPtr(${path}, "value")`
                  )
                );
              });
              c.line("default:");
              c.indent(() => c.line("j.Null()"));
              c.line("}");
              c.line("j.EndObject()");
            }
          ]
        ]);
        return;
      }
      case "transform":
        this.valueToJSON(c, t.valueType, v, path);
        return;
      case "layered":
        this.toJSON(c, t.inner, v, path);
        return;
    }
  }

  primToJSON(p: string, v: string): string {
    if (p[0] === "f") return p === "f64" ? `j.Float(${v})` : `j.Float(float64(${v}))`;
    const bits = Number(p.slice(1));
    const signed = p[0] === "i";
    if (bits > 48)
      return signed
        ? `j.IntStr(${primGo(p) === "int64" ? v : `int64(${v})`})`
        : `j.UintStr(${primGo(p) === "uint64" ? v : `uint64(${v})`})`;
    return signed ? `j.Int(int64(${v}))` : `j.Uint(uint64(${v}))`;
  }

  valueToJSON(c: Code, t: IrValueType, v: string, path: string): void {
    switch (t.kind) {
      case "int":
        c.line(this.primToJSON(`${t.signed ? "i" : "u"}${t.bits}`, v));
        return;
      case "bigint":
        c.line(`j.IntStr(${v})`);
        return;
      case "float":
        c.line(t.bits === 64 ? `j.Float(${v})` : `j.Float(float64(${v}))`);
        return;
      case "bool":
        c.line(`j.Bool(${v})`);
        return;
      case "string":
        c.line(`j.Str(${v})`);
        return;
      case "bytes":
        c.line(`j.Hex(${v})`);
        return;
      case "endian":
        c.line(`j.Str(${v}.String())`);
        return;
      case "enum":
        c.line(`toJSON${this.model.enumName(t.enum)}(j, ${v})`);
        return;
      case "struct":
        this.toJSON(c, { kind: "struct", struct: t.struct, args: [] }, v, path);
        return;
      case "array": {
        const e = this.v("e");
        c.line("j.BeginArray()");
        c.block(`for _, ${e} := range ${v}`, () => this.valueToJSON(c, t.element, e, `""`));
        c.line("j.EndArray()");
        return;
      }
      case "nullable": {
        const inner = this.model.goValueType(t.inner);
        const deref = isNilable(inner) ? v : `(*${v})`;
        c.chain([
          [`if ${v} == nil`, () => c.line("j.Null()")],
          ["else", () => this.valueToJSON(c, t.inner, deref, path)]
        ]);
        return;
      }
      case "extern":
        this.valueToJSON(c, t.valueType, v, path);
        return;
      case "union":
        throw new BackendError("not implemented: union-valued transforms");
    }
  }

  /** A Go expression converting JSON value j (any) of IR type t. */
  fromJSON(t: IrType, j: string, path: string): string {
    switch (t.kind) {
      case "prim":
        return this.primFromJSON(t.prim, j);
      case "bool":
        return `yaffle.JBool(${j})`;
      case "string":
        return `yaffle.JString(${j})`;
      case "bytes":
        return `yaffle.JBytes(${j})`;
      case "array": {
        const e = this.v("e");
        const q = this.v("q");
        const elemGo = this.model.goType(t.element);
        return `yaffle.Arr(c, ${j}, ${path}, func(${e} any, ${q} string) ${elemGo} { return ${this.fromJSON(t.element, e, q)} })`;
      }
      case "struct":
        return `yaffle.Obj(c, ${j}, ${path}, fromJSON${this.model.structName(t.struct)})`;
      case "enum":
        return `fromJSON${this.model.enumName(t.enum)}(${j})`;
      case "pointer": {
        const inner = this.fromJSON(t.target, "jj", path);
        if (t.nullValue !== undefined && !t.emptyIsNull) {
          const goT = this.model.goType(t);
          const targetGo = this.model.goType(t.target);
          if (goT !== targetGo)
            return `yaffle.JNullablePtr(${j}, func(jj any) ${targetGo} { return ${inner} })`;
          return `yaffle.JNullable(${j}, func(jj any) ${targetGo} { return ${inner} })`;
        }
        return this.fromJSON(t.target, j, path);
      }
      case "extern": {
        const x = this.model.extern(t.extern);
        if (x.kind !== "type") throw new BackendError("extern value of a non-type");
        return this.valueFromJSON(x.valueType, j, path);
      }
      case "union": {
        const info = this.model.unionOf(t);
        if (!this.model.unionFromJSON.has(info.go)) this.model.unionFromJSON.set(info.go, t);
        return `fromJSON${info.go}(c, ${j}, ${path})`;
      }
      case "transform":
        if (!t.write) return this.fromJSON(t.inner, j, path);
        return this.valueFromJSON(t.valueType, j, path);
      case "layered":
        return this.fromJSON(t.inner, j, path);
    }
  }

  primFromJSON(p: string, j: string): string {
    const go = primGo(p);
    if (p === "f64") return `yaffle.JFloat(${j})`;
    if (p === "f32") return `float32(yaffle.JFloat(${j}))`;
    if (p === "f16") return `yaffle.RoundToHalf(yaffle.JFloat(${j}))`;
    const bits = Number(p.slice(1));
    const str = bits > 48 ? "true" : "false";
    if (p[0] === "i") {
      const lo = -(1n << BigInt(bits - 1));
      const hi = (1n << BigInt(bits - 1)) - 1n;
      const call = `yaffle.JInt(${j}, ${lo}, ${formatInt(hi)}, ${str}, ${goStr(p)})`;
      return go === "int64" ? call : `${go}(${call})`;
    }
    const hi = (1n << BigInt(bits)) - 1n;
    const call = `yaffle.JUint(${j}, ${formatInt(hi)}, ${str}, ${goStr(p)})`;
    return go === "uint64" ? call : `${go}(${call})`;
  }

  valueFromJSON(t: IrValueType, j: string, path: string): string {
    switch (t.kind) {
      case "int":
        return this.primFromJSON(`${t.signed ? "i" : "u"}${t.bits}`, j);
      case "bigint":
        return `yaffle.JInt(${j}, -9223372036854775808, 9223372036854775807, true, "i64")`;
      case "float":
        return t.bits === 64
          ? `yaffle.JFloat(${j})`
          : t.bits === 16
            ? `yaffle.RoundToHalf(yaffle.JFloat(${j}))`
            : `float32(yaffle.JFloat(${j}))`;
      case "bool":
        return `yaffle.JBool(${j})`;
      case "string":
        return `yaffle.JString(${j})`;
      case "bytes":
        return `yaffle.JBytes(${j})`;
      case "endian":
        return `yaffle.JEndian(${j})`;
      case "enum":
        return `fromJSON${this.model.enumName(t.enum)}(${j})`;
      case "struct":
        return `yaffle.Obj(c, ${j}, ${path}, fromJSON${this.model.structName(t.struct)})`;
      case "array": {
        const e = this.v("e");
        const q = this.v("q");
        const elemGo = this.model.goValueType(t.element);
        return `yaffle.Arr(c, ${j}, ${path}, func(${e} any, ${q} string) ${elemGo} { return ${this.valueFromJSON(t.element, e, q)} })`;
      }
      case "nullable": {
        const inner = this.model.goValueType(t.inner);
        const conv = this.valueFromJSON(t.inner, "jj", path);
        if (isNilable(inner))
          return `yaffle.JNullable(${j}, func(jj any) ${inner} { return ${conv} })`;
        return `yaffle.JNullablePtr(${j}, func(jj any) ${inner} { return ${conv} })`;
      }
      case "extern":
        return this.valueFromJSON(t.valueType, j, path);
      case "union":
        throw new BackendError("not implemented: union-valued transforms");
    }
  }

  /** Helpers of a union type (toJSON is inline; fromJSON is a function). */
  emitUnionFromJSON(code: Code, go: string, t: Extract<IrType, { kind: "union" }>): void {
    const info = this.model.unionOf(t);
    code.block(`func fromJSON${go}(c *yaffle.FromJSON, j any, p string) *${go}`, () => {
      code.line(`t, x := yaffle.JUnion(j${t.variants.map(v => `, ${goStr(v.name)}`).join("")})`);
      code.line(`u := &${go}{Type: t}`);
      code.line("fr := c.PS.Enter()");
      code.line(`c.PS.Field(fr, "value")`);
      code.line("switch t {");
      t.variants.forEach((vr, i) => {
        code.line(`case ${goStr(vr.name)}:`);
        code.indent(() =>
          code.line(
            `u.${info.variants[i]!.go} = ${this.fromJSON(vr.type, "x", `yaffle.JPtr(p, "value")`)}`
          )
        );
      });
      code.line("}");
      code.line("c.PS.Leave(fr)");
      code.line("return u");
    });
  }
}

/** The Go field and IR type a field's JSON shows: the raw value of a one-way transform. */
function jsonValue(g: GoField): { go: string; type: IrType } {
  const t = g.ref.field ? g.ref.field.type : g.ref.bit!.type;
  if (!g.raw) return { go: g.go, type: t };
  const tt = stripLayers(t);
  return { go: g.raw.go, type: tt.kind === "transform" ? tt.inner : tt };
}
