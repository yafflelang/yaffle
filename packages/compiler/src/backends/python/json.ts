/**
 * Canonical JSON emitter (docs/CONFORMANCE.md §3): `_to_json_X` / `_from_json_X` per struct.
 */
import type { IrStruct, IrType, IrValueType } from "../../ir/index.ts";
import { isNullablePointer, isOneWay } from "./analysis.ts";
import { pyBool, pyStr, type Code } from "./code.ts";
import { unlayer, type Model } from "./model.ts";
import type { ModuleCtx } from "./module.ts";
import type { Names } from "./names.ts";

/** Converts the value `v` (or JSON `j`) at JSON pointer `path` to code. */
type Conv = (v: string, path: string) => string;

export class JsonEmitter {
  readonly model: Model;
  readonly names: Names;
  readonly mod: ModuleCtx;
  /** Numbers the lambda parameters within one field's conversion. */
  private depth = 0;

  constructor(model: Model, names: Names, mod: ModuleCtx) {
    this.model = model;
    this.names = names;
    this.mod = mod;
  }

  /** Fresh lambda parameter names: an element and its JSON pointer. */
  private params(): [string, string] {
    const e = `_e${++this.depth}`;
    return [e, `_q${++this.depth}`];
  }

  /** `lambda _eN, _qM: conv(_eN, _qM)`. */
  private lambda(conv: Conv): string {
    const [e, q] = this.params();
    return `lambda ${e}, ${q}: ${conv(e, q)}`;
  }

  emitStruct(code: Code, s: IrStruct): void {
    const cls = this.names.structClass(s.id);
    const fields = this.model.fields(s).filter(f => (f.field ?? f.bit!).output);
    const typeOf = (f: (typeof fields)[number]): IrType => (f.field ?? f.bit!).type;
    code.block(
      `def _to_json_${cls}(_v: ${cls}, _c: _rt.ToJsonCtx, _q: str) -> dict[str, _t.Any]`,
      () => {
        code.line(`_o: dict[str, _t.Any] = {}`);
        const done = new Set<string>();
        for (const f of fields) {
          const t = typeOf(f);
          const attr = this.names.attr(s, f.name);
          const key = pyStr(f.name);
          this.depth = 0;
          const path = `_rt.ptr(_q, ${key})`;
          if (!f.conditional) {
            code.line(`_o[${key}] = ${this.fieldToJson(t, `_v.${attr}`, path, attr)}`);
            continue;
          }
          // Several branches may declare the field (with different types): convert with the
          // first one whose shape matches.
          if (done.has(f.name)) continue;
          done.add(f.name);
          const alts = fields.filter(g => g.name === f.name).map(typeOf);
          const x = code.fresh("x");
          code.line(`${x} = getattr(_v, ${pyStr(attr)}, None)`);
          const present = alts.some(a => isNullablePointer(unlayer(a)))
            ? `_rt.has_field(_v, ${pyStr(attr)})`
            : `${x} is not None`;
          const conv = alts.every(a => this.model.typeKey(a) === this.model.typeKey(alts[0]!))
            ? this.fieldToJson(t, x, path, attr)
            : `_rt.first_of([${alts.map(a => `lambda: ${this.toJson(a, x, path)}`).join(", ")}])`;
          code.line(`if ${present}: _o[${key}] = ${conv}`);
        }
        code.line("return _o");
      }
    );
    code.line("");
    code.block(`def _from_json_${cls}(_j: _t.Any, _c: _rt.FromJsonCtx, _q: str) -> ${cls}`, () => {
      code.line(`_s = _rt.object_from_json(_j)`);
      code.line(`_o = ${cls}.__new__(${cls})`);
      code.line(`_c.register(_q, _o)`);
      code.line(`_f = ""`);
      code.block("try", () => {
        // The distinct types each field is declared with.
        const byName = new Map<string, IrType[]>();
        for (const f of fields) {
          const list = byName.get(f.name) ?? [];
          const key = this.model.typeKey(typeOf(f));
          if (!list.some(x => this.model.typeKey(x) === key)) list.push(typeOf(f));
          byName.set(f.name, list);
        }
        for (const [fname, ts] of byName) {
          const key = pyStr(fname);
          const attr = this.names.attr(s, fname);
          const j = `_s[${key}]`;
          const path = `_rt.ptr(_q, ${key})`;
          code.line(`_f = ${key}`);
          this.depth = 0;
          const fr = this.model.field(s, fname)?.field;
          if (ts.length === 1 && fr && isOneWay(fr.type)) {
            // The JSON holds the raw value of a one-way transform: kept only if it converts.
            code.block(`if ${key} in _s`, () => {
              code.block("try", () =>
                code.line(`setattr(_o, ${pyStr(attr)}, ${this.fromJson(ts[0]!, j, path)})`)
              );
              code.block("except _rt.YaffleError", () => code.line("pass"));
            });
          } else if (ts.length === 1) {
            code.line(`if ${key} in _s: _o.${attr} = ${this.fromJson(ts[0]!, j, path)}`);
          } else {
            const alts = ts.map(t => `lambda: ${this.fromJson(t, j, path)}`);
            code.line(`if ${key} in _s: _o.${attr} = _rt.first_of([${alts.join(", ")}])`);
          }
        }
      });
      code.block("except _rt.YaffleError as _e", () => {
        code.line("_e.prefix(_f)");
        code.line("raise");
      });
      code.line("return _o");
    });
  }

  /** A field's JSON: a one-way transform shows its raw value when it is known. */
  private fieldToJson(t: IrType, v: string, path: string, attr: string): string {
    const conv = this.toJson(t, v, path);
    const tt = unlayer(t);
    if (!isOneWay(t) || tt.kind !== "transform") return conv;
    const raw = `_rt.get_raw(_v, ${pyStr(attr)})`;
    return `(${this.toJson(tt.inner, raw, path)} if ${raw} is not None else ${conv})`;
  }

  private structToJson(id: string, v: string, path: string): string {
    return `_c.obj(${v}, ${path}, ${this.mod.structFn(id, "to_json")})`;
  }

  private enumToJson(id: string, v: string): string {
    const big = Number(this.model.enum(id).storage.slice(1)) > 48;
    return `_rt.enum_to_json(${this.mod.enumRef(id, "names")}, ${v}, ${pyBool(big)})`;
  }

  private unionToJson(
    variants: { name: string }[],
    conv: (i: number) => Conv,
    v: string,
    path: string
  ): string {
    const alts = variants.map((vr, i) => `${pyStr(vr.name)}: ${this.lambda(conv(i))}`);
    return `_rt.union_to_json(${v}, {${alts.join(", ")}}, ${path})`;
  }

  private toJson(t: IrType, v: string, path: string): string {
    switch (t.kind) {
      case "prim":
        if (t.prim[0] === "f") return `_rt.float_to_json(${v})`;
        return Number(t.prim.slice(1)) > 48 ? `str(${v})` : v;
      case "bool":
      case "string":
        return v;
      case "bytes":
        return `_rt.to_hex(${v})`;
      case "array": {
        const [e, q] = this.params();
        const inner = this.toJson(t.element, e, q);
        // Elements that are JSON already are copied as they are.
        return inner === e
          ? `_c.arr_plain(${v}, ${path})`
          : `_c.arr(${v}, ${path}, lambda ${e}, ${q}: ${inner})`;
      }
      case "struct":
        return this.structToJson(t.struct, v, path);
      case "enum":
        return this.enumToJson(t.enum, v);
      case "pointer": {
        const inner = this.toJson(t.target, v, path);
        return isNullablePointer(t) ? `(None if ${v} is None else ${inner})` : inner;
      }
      case "extern": {
        const x = this.model.extern(t.extern);
        return x.kind === "type" ? this.valueToJson(x.valueType, v, path) : v;
      }
      case "union":
        return this.unionToJson(
          t.variants,
          i => (x, q) => this.toJson(t.variants[i]!.type, x, q),
          v,
          path
        );
      case "transform":
        return this.valueToJson(t.valueType, v, path);
      case "layered":
        return this.toJson(t.inner, v, path);
    }
  }

  private valueToJson(t: IrValueType, v: string, path: string): string {
    switch (t.kind) {
      case "int":
        return t.bits > 48 ? `str(${v})` : v;
      case "bigint":
        return `str(${v})`;
      case "float":
        return `_rt.float_to_json(${v})`;
      case "bytes":
        return `_rt.to_hex(${v})`;
      case "struct":
        return this.structToJson(t.struct, v, path);
      case "array": {
        const [e, q] = this.params();
        const inner = this.valueToJson(t.element, e, q);
        return inner === e ? `list(${v})` : `_c.map(${v}, ${path}, lambda ${e}, ${q}: ${inner})`;
      }
      case "nullable":
        return `(None if ${v} is None else ${this.valueToJson(t.inner, v, path)})`;
      case "extern":
        return this.valueToJson(t.valueType, v, path);
      case "enum":
        return this.enumToJson(t.enum, v);
      case "union":
        return this.unionToJson(
          t.variants,
          i => (x, q) => this.valueToJson(t.variants[i]!.type, x, q),
          v,
          path
        );
      default:
        return v;
    }
  }

  private structFromJson(id: string, j: string, path: string): string {
    return `_c.obj(${j}, ${path}, ${this.mod.structFn(id, "from_json")})`;
  }

  private enumFromJson(id: string, j: string): string {
    const open = pyBool(this.model.enum(id).open);
    return `_rt.enum_from_json(${this.mod.enumRef(id, "class")}, ${this.mod.enumRef(id, "values")}, ${j}, ${open})`;
  }

  private unionFromJson(
    variants: { name: string }[],
    conv: (i: number) => Conv,
    j: string,
    path: string
  ): string {
    const alts = variants.map((vr, i) => `${pyStr(vr.name)}: ${this.lambda(conv(i))}`);
    return `_rt.union_from_json(${j}, {${alts.join(", ")}}, ${path})`;
  }

  private fromJson(t: IrType, j: string, path: string): string {
    switch (t.kind) {
      case "prim":
        if (t.prim[0] === "f") return `_rt.float_from_json(${j})`;
        return Number(t.prim.slice(1)) > 48 ? `_rt.big_from_json(${j})` : `_rt.int_from_json(${j})`;
      case "bool":
        return `_rt.bool_from_json(${j})`;
      case "string":
        return `_rt.string_from_json(${j})`;
      case "bytes":
        return `_c.bytes(${j}, ${path})`;
      case "array":
        return `_c.arr(${j}, ${path}, ${this.lambda((x, q) => this.fromJson(t.element, x, q))})`;
      case "struct":
        return this.structFromJson(t.struct, j, path);
      case "enum":
        return this.enumFromJson(t.enum, j);
      case "pointer": {
        const inner = this.fromJson(t.target, j, path);
        return isNullablePointer(t) ? `(None if ${j} is None else ${inner})` : inner;
      }
      case "extern": {
        const x = this.model.extern(t.extern);
        return x.kind === "type" ? this.valueFromJson(x.valueType, j, path) : j;
      }
      case "union":
        return this.unionFromJson(
          t.variants,
          i => (x, q) => this.fromJson(t.variants[i]!.type, x, q),
          j,
          path
        );
      case "transform":
        return t.write ? this.valueFromJson(t.valueType, j, path) : this.fromJson(t.inner, j, path);
      case "layered":
        return this.fromJson(t.inner, j, path);
    }
  }

  valueFromJson(t: IrValueType, j: string, path: string): string {
    switch (t.kind) {
      case "int":
        return t.bits > 48 ? `_rt.big_from_json(${j})` : `_rt.int_from_json(${j})`;
      case "bigint":
        return `_rt.big_from_json(${j})`;
      case "float":
        return `_rt.float_from_json(${j})`;
      case "bool":
        return `_rt.bool_from_json(${j})`;
      case "string":
        return `_rt.string_from_json(${j})`;
      case "bytes":
        return `_c.bytes(${j}, ${path})`;
      case "struct":
        return this.structFromJson(t.struct, j, path);
      case "enum":
        return this.enumFromJson(t.enum, j);
      case "array":
        return `_c.arr(${j}, ${path}, ${this.lambda((x, q) => this.valueFromJson(t.element, x, q))})`;
      case "nullable":
        return `(None if ${j} is None else ${this.valueFromJson(t.inner, j, path)})`;
      case "extern":
        return this.valueFromJson(t.valueType, j, path);
      case "endian":
        return `_rt.endian_option(${j})`;
      case "union":
        return this.unionFromJson(
          t.variants,
          i => (x, q) => this.valueFromJson(t.variants[i]!.type, x, q),
          j,
          path
        );
    }
  }
}
