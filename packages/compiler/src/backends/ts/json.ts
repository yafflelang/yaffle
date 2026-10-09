/**
 * Canonical JSON emitter (docs/CONFORMANCE.md §3): `toJson_X` / `fromJson_X` per struct.
 */
import type { IrStruct, IrType, IrValueType } from "../../ir/index.ts";
import { Code, prop, propKey, str } from "./code.ts";
import { isOneWay, stripLayers, type Model } from "./model.ts";
import type { ModuleCtx } from "./module.ts";
import type { TypeEmitter } from "./types.ts";

export class JsonEmitter {
  readonly model: Model;
  readonly types: TypeEmitter;
  readonly mod: ModuleCtx;
  private depth = 0;

  constructor(model: Model, types: TypeEmitter, mod: ModuleCtx) {
    this.model = model;
    this.types = types;
    this.mod = mod;
  }

  emitStruct(code: Code, s: IrStruct): void {
    const name = this.model.structName(s.id);
    const fields = this.model.fields(s).filter(f => (f.field ? f.field.output : f.bit!.output));
    code.block(
      `export function toJson_${name}($v: ${name}, $c: $rt.ToJsonCtx, $p: string): { [key: string]: unknown }`,
      () => {
        code.line(`const $x = $v as unknown as ${name}$R;`);
        code.line(`const $o: { [key: string]: unknown } = {};`);
        for (const f of fields) {
          const t = f.field ? f.field.type : f.bit!.type;
          const v = prop("$x", f.name);
          this.depth = 0;
          let conv = this.toJson(t, v, `$rt.ptr($p, ${str(f.name)})`);
          const tt = f.field && stripLayers(f.field.type);
          if (tt?.kind === "transform" && !tt.write) {
            // One-way transforms: the raw value, when the value came from a parse.
            const rawT = this.types.type(tt.inner, "out");
            const raw = this.toJson(
              tt.inner,
              `($rt.getRaw($v, ${str(f.name)}) as ${rawT})`,
              `$rt.ptr($p, ${str(f.name)})`
            );
            conv = `($rt.getRaw($v, ${str(f.name)}) !== undefined ? ${raw} : ${conv})`;
          }
          const assign = `${prop("$o", f.name)} = ${conv};`;
          if (f.conditional) code.line(`if (${v} !== undefined) ${assign}`);
          else code.line(assign);
        }
        code.line("return $o;");
      }
    );
    code.block(
      `export function fromJson_${name}($j: unknown, $c: $rt.FromJsonCtx, $p: string): ${name}Input`,
      () => {
        code.line(`const $s = $rt.objectFromJson($j);`);
        code.line(`const $o = {} as ${name}$W;`);
        code.line(`$c.register($p, $o);`);
        code.line(`let $f = "";`);
        code.chain([
          [
            "try",
            () => {
              // A field may appear in several branches with different types: try each conversion.
              const byName = new Map<string, IrType[]>();
              for (const f of fields) {
                const t = f.field ? f.field.type : f.bit!.type;
                const list = byName.get(f.name) ?? [];
                if (!list.some(x => this.model.typeKey(x) === this.model.typeKey(t))) list.push(t);
                byName.set(f.name, list);
              }
              for (const [fname, ts] of byName) {
                const j = prop("$s", fname);
                const path = `$rt.ptr($p, ${str(fname)})`;
                code.line(`$f = ${str(fname)};`);
                this.depth = 0;
                const fr = this.model.field(s, fname)?.field;
                if (ts.length === 1 && fr && isOneWay(fr.type)) {
                  // One-way transform: the JSON holds the transformed value; accept the raw value if given.
                  code.line(
                    `if (${j} !== undefined) ${prop("$o", fname)} = $rt.tryOr(() => ${this.fromJson(ts[0]!, j, path)}, undefined) as never;`
                  );
                } else if (ts.length === 1) {
                  code.line(
                    `if (${j} !== undefined) ${prop("$o", fname)} = ${this.fromJson(ts[0]!, j, path)};`
                  );
                } else {
                  const alts = ts.map(t => `() => ${this.fromJson(t, j, path)}`);
                  code.line(
                    `if (${j} !== undefined) ${prop("$o", fname)} = $rt.firstOf([${alts.join(", ")}]) as never;`
                  );
                }
              }
            }
          ],
          ["catch ($e)", () => code.line("$rt.rethrowAt($e, $f);")]
        ]);
        code.line(`return $o as unknown as ${name}Input;`);
      }
    );
  }

  private v(): string {
    return `$e${++this.depth}`;
  }

  toJson(t: IrType, v: string, path: string): string {
    switch (t.kind) {
      case "prim":
        if (t.prim[0] === "f") return `$rt.floatToJson(${v})`;
        return Number(t.prim.slice(1)) > 48 ? `String(${v})` : v;
      case "bool":
      case "string":
        return v;
      case "bytes":
        return `$rt.toHex(${v})`;
      case "array": {
        const e = this.v();
        const i = `$i${this.depth}`;
        const inner = this.toJson(t.element, e, `$rt.ptr(${path}, ${i})`);
        if (t.element.kind === "prim" && inner === e) return `($c.ref(${v}, ${path}) ?? [...${v}])`;
        return `($c.ref(${v}, ${path}) ?? ${v}.map((${e}, ${i}) => ${inner}))`;
      }
      case "struct": {
        const fn = this.mod.structFn(t.struct, "toJson");
        return `($c.ref(${v}, ${path}) ?? ${fn}(${v}, $c, ${path}))`;
      }
      case "enum":
        return this.model.enum(t.enum).open ? `$rt.enumToJson(${v})` : v;
      case "pointer": {
        const inner = this.toJson(t.target, v, path);
        return t.nullValue !== undefined && !t.emptyIsNull
          ? `(${v} === null ? null : ${inner})`
          : inner;
      }
      case "extern": {
        const x = this.model.extern(t.extern);
        return x.kind === "type" ? this.valueToJson(x.valueType, v, path) : v;
      }
      case "union": {
        const u = this.v();
        const cases = t.variants.map(
          vr =>
            `case ${str(vr.name)}: return { type: ${str(vr.name)}, value: ${this.toJson(vr.type, `(${u}.value as ${this.types.type(vr.type, "out")})`, `$rt.ptr(${path}, "value")`)} };`
        );
        return `((${u}: { type: string; value: unknown }) => { switch (${u}.type) { ${cases.join(" ")} default: return $rt.fail("INPUT", "unknown union variant"); } })(${v})`;
      }
      case "transform":
        return this.valueToJson(t.valueType, v, path);
      case "layered":
        return this.toJson(t.inner, v, path);
    }
  }

  valueToJson(t: IrValueType, v: string, path: string): string {
    switch (t.kind) {
      case "int":
        return t.bits > 48 ? `String(${v})` : v;
      case "bigint":
        return `String(${v})`;
      case "float":
        return `$rt.floatToJson(${v})`;
      case "bytes":
        return `$rt.toHex(${v})`;
      case "struct":
        return `($c.ref(${v}, ${path}) ?? ${this.mod.structFn(t.struct, "toJson")}(${v}, $c, ${path}))`;
      case "array": {
        const e = this.v();
        const i = `$i${this.depth}`;
        return `${v}.map((${e}, ${i}) => ${this.valueToJson(t.element, e, `$rt.ptr(${path}, ${i})`)})`;
      }
      case "nullable":
        return `(${v} === null ? null : ${this.valueToJson(t.inner, v, path)})`;
      case "extern":
        return this.valueToJson(t.valueType, v, path);
      case "union": {
        const u = this.v();
        const cases = t.variants.map(
          vr =>
            `case ${str(vr.name)}: return { type: ${str(vr.name)}, value: ${this.valueToJson(vr.type, `(${u}.value as ${this.types.valueType(vr.type, "out")})`, path)} };`
        );
        return `((${u}: { type: string; value: unknown }) => { switch (${u}.type) { ${cases.join(" ")} default: return $rt.fail("INPUT", "unknown union variant"); } })(${v})`;
      }
      default:
        return v;
    }
  }

  fromJson(t: IrType, j: string, path: string): string {
    switch (t.kind) {
      case "prim":
        if (t.prim[0] === "f") return `$rt.floatFromJson(${j})`;
        return Number(t.prim.slice(1)) > 48 ? `$rt.bigFromJson(${j})` : `$rt.intFromJson(${j})`;
      case "bool":
        return `$rt.boolFromJson(${j})`;
      case "string":
        return `$rt.stringFromJson(${j})`;
      case "bytes":
        return `$c.bytes(${j}, ${path})`;
      case "array": {
        const e = this.v();
        const p = `$q${this.depth}`;
        const elemT = this.types.type(t.element, "in");
        return `$c.arr<${elemT}>(${j}, ${path}, (${e}, ${p}) => ${this.fromJson(t.element, e, p)})`;
      }
      case "struct":
        return `$c.obj(${j}, ${path}, ($jj, $pp) => ${this.mod.structFn(t.struct, "fromJson")}($jj, $c, $pp))`;
      case "enum": {
        const en = this.model.enum(t.enum);
        return `$rt.enumFromJson(${this.mod.enumRef(t.enum, "values")}, ${j}, ${en.open}) as ${this.model.enumName(t.enum)}`;
      }
      case "pointer": {
        const inner = this.fromJson(t.target, j, path);
        return t.nullValue !== undefined && !t.emptyIsNull
          ? `(${j} === null ? null : ${inner})`
          : inner;
      }
      case "extern": {
        const x = this.model.extern(t.extern);
        return x.kind === "type" ? this.valueFromJson(x.valueType, j, path) : j;
      }
      case "union": {
        const alts = t.variants.map(
          vr =>
            `${propKey(vr.name)}: ($jj: unknown, $pp: string) => ${this.fromJson(vr.type, "$jj", "$pp")}`
        );
        return `$rt.unionFromJson(${j}, { ${alts.join(", ")} }, ${path}) as ${this.types.type(t, "in")}`;
      }
      case "transform":
        if (!t.write) return this.fromJson(t.inner, j, path);
        return this.valueFromJson(t.valueType, j, path);
      case "layered":
        return this.fromJson(t.inner, j, path);
    }
  }

  valueFromJson(t: IrValueType, j: string, path: string): string {
    switch (t.kind) {
      case "int":
        return t.bits > 48 ? `$rt.bigFromJson(${j})` : `$rt.intFromJson(${j})`;
      case "bigint":
        return `$rt.bigFromJson(${j})`;
      case "float":
        return `$rt.floatFromJson(${j})`;
      case "bool":
        return `$rt.boolFromJson(${j})`;
      case "string":
        return `$rt.stringFromJson(${j})`;
      case "bytes":
        return `$c.bytes(${j}, ${path})`;
      case "struct":
        return `$c.obj(${j}, ${path}, ($jj, $pp) => ${this.mod.structFn(t.struct, "fromJson")}($jj, $c, $pp))`;
      case "enum": {
        const en = this.model.enum(t.enum);
        return `$rt.enumFromJson(${this.mod.enumRef(t.enum, "values")}, ${j}, ${en.open}) as ${this.model.enumName(t.enum)}`;
      }
      case "array": {
        const e = this.v();
        const p = `$q${this.depth}`;
        return `$c.arr(${j}, ${path}, (${e}, ${p}) => ${this.valueFromJson(t.element, e, p)})`;
      }
      case "nullable":
        return `(${j} === null ? null : ${this.valueFromJson(t.inner, j, path)})`;
      case "extern":
        return this.valueFromJson(t.valueType, j, path);
      case "endian":
        return `$rt.stringFromJson(${j}) as $rt.Endian`;
      case "union": {
        const alts = t.variants.map(
          vr =>
            `${propKey(vr.name)}: ($jj: unknown, $pp: string) => ${this.valueFromJson(vr.type, "$jj", "$pp")}`
        );
        return `$rt.unionFromJson(${j}, { ${alts.join(", ")} }, ${path}) as ${this.types.valueType(t, "in")}`;
      }
    }
  }
}
