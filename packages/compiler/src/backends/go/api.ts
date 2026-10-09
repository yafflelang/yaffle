/**
 * Root API emitter: for each exported struct X, `ParseX`, `ParseXContext`, `SerializeX`,
 * `SerializeXContext`, `ViewX`, `XToJSON`, `XFromJSON`, the options type `XOptions` (root
 * parameters, endian, strict) and `XOptionsFromJSON`.
 */
import type { IrParam, IrRoot, IrStruct } from "../../ir/index.ts";
import { Code, NameSet, alignRows, exported, fixUnused, goStr, local } from "./code.ts";
import type { CExpr, ExprCtx } from "./expr.ts";
import type { JsonEmitter } from "./json.ts";
import type { Model } from "./model.ts";
import type { ModuleCtx } from "./module.ts";
import type { ReadEmitter } from "./read.ts";
import type { WriteEmitter } from "./write.ts";

export interface RootNames {
  parse: string;
  parseCtx: string;
  serialize: string;
  serializeCtx: string;
  toJSON: string;
  fromJSON: string;
  options: string;
  optionsFromJSON: string;
  view: string;
  materialize: string;
}

export function rootNames(model: Model, root: IrRoot): RootNames {
  const n = exported(root.name);
  const take = (s: string): string => model.names.take(s);
  return {
    parse: take(`Parse${n}`),
    parseCtx: take(`Parse${n}Context`),
    serialize: take(`Serialize${n}`),
    serializeCtx: take(`Serialize${n}Context`),
    toJSON: take(`${n}ToJSON`),
    fromJSON: take(`${n}FromJSON`),
    options: take(`${n}Options`),
    optionsFromJSON: take(`${n}OptionsFromJSON`),
    view: take(`View${n}`),
    materialize: take(`Materialize${n}View`)
  };
}

/** "a Table", "an Entry". */
function an(word: string): string {
  return `${/^[AEIOUaeiou]/.test(word) ? "an" : "a"} ${word}`;
}

/** The root being emitted. */
interface Root {
  s: IrStruct;
  /** Go name of the root struct. */
  T: string;
  /** "a Table" (doc comments). */
  what: string;
  names: RootNames;
  /** Root parameters that are options, and their option field names. */
  params: IrParam[];
  fieldOf: Map<string, string>;
}

export class ApiEmitter {
  readonly model: Model;
  readonly mod: ModuleCtx;
  readonly reader: ReadEmitter;
  readonly writer: WriteEmitter;
  readonly json: JsonEmitter;
  /** Generate `ViewX`. */
  views = true;

  constructor(
    model: Model,
    mod: ModuleCtx,
    reader: ReadEmitter,
    writer: WriteEmitter,
    json: JsonEmitter
  ) {
    this.model = model;
    this.mod = mod;
    this.reader = reader;
    this.writer = writer;
    this.json = json;
  }

  emitRoot(code: Code, root: IrRoot, names: RootNames): void {
    const s = this.model.struct(root.struct);
    const params = s.params.filter(p => p.origin !== "endian" && p.origin !== "outer");
    const optNames = new NameSet(["Endian", "Strict"]);
    const fieldOf = new Map<string, string>();
    for (const p of params) fieldOf.set(p.name, optNames.take(exported(p.boundName ?? p.name)));
    const r: Root = {
      s,
      T: this.model.structName(s.id),
      what: an(root.name),
      names,
      params,
      fieldOf
    };
    this.mod.use("context");
    this.emitOptions(code, r);
    this.emitParse(code, r);
    this.emitSerialize(code, r);
    if (this.views) this.emitView(code, r);
    this.emitJSON(code, r);
  }

  /** True if an option field is a pointer (nil: the parameter's default). */
  private optionPtr(p: IrParam): boolean {
    const t = this.model.goValueType(p.type);
    return p.default !== undefined && !t.startsWith("*") && !t.startsWith("[]");
  }

  /** The root struct's layout variable. */
  private layout(s: IrStruct): string {
    return s.base ? "nil" : this.writer.layoutVar(s);
  }

  private emitOptions(code: Code, r: Root): void {
    const { names } = r;
    code.line(
      `// ${names.options} configures ${names.parse} and ${names.serialize}. Root parameters with a`
    );
    code.line(`// default are pointers (nil: the default).`);
    code.block(`type ${names.options} struct`, () => {
      const rows: string[][] = [
        ["Endian", "yaffle.Endian"],
        ["Strict", "bool"]
      ];
      for (const p of r.params) {
        const t = this.model.goValueType(p.type);
        rows.push([r.fieldOf.get(p.name)!, this.optionPtr(p) ? `*${t}` : t]);
      }
      for (const l of alignRows(rows)) code.line(l);
    });
    code.line("");
  }

  /** Locals for the root arguments: `endian` and one per option parameter (defaults applied). */
  private prelude(c: Code, r: Root): void {
    c.line(`endian := opts.Endian`);
    for (const p of r.params) {
      const f = r.fieldOf.get(p.name)!;
      if (this.optionPtr(p) && p.default) {
        const t = this.model.goValueType(p.type);
        const x = this.reader.x;
        const d = x.to(x.compile(p.default, this.constCtx()), p.type, this.constCtx());
        c.line(`${local(p.name)} := yaffle.Or(opts.${f}, func() ${t} { return ${d} })`);
      } else c.line(`${local(p.name)} := opts.${f}`);
    }
  }

  /**
   * `name(arg…, opts)` calling `ctxName(context.Background(), arg…, opts)`, then ctxName, whose
   * body is `return run(…)` with the callback emitted by body.
   */
  private emitEntry(
    code: Code,
    r: Root,
    e: { name: string; ctxName: string; doc: string; params: string; args: string; result: string },
    run: string,
    body: (fn: Code) => void
  ): void {
    const opts = r.names.options;
    code.line(`// ${e.name} ${e.doc}.`);
    code.block(`func ${e.name}(${e.params}, opts *${opts}) (${e.result}, error)`, () => {
      code.line(`return ${e.ctxName}(context.Background(), ${e.args}, opts)`);
    });
    code.line("");
    code.line(`// ${e.ctxName} is ${e.name} with a context for blocking codecs.`);
    const fn = new Code();
    fn.block(
      `func ${e.ctxName}(ctx context.Context, ${e.params}, opts *${opts}) (${e.result}, error)`,
      () => {
        fn.block("if opts == nil", () => fn.line(`opts = &${opts}{}`));
        fn.line(`return ${run} {`);
        fn.indent(() => body(fn));
        fn.line("})");
      }
    );
    code.line(fixUnused(fn.toString()));
    code.line("");
  }

  private emitParse(code: Code, r: Root): void {
    const { names, T } = r;
    const e = {
      name: names.parse,
      ctxName: names.parseCtx,
      doc: `parses ${r.what}`,
      params: "data []byte",
      args: "data",
      result: `*${T}`
    };
    this.emitEntry(
      code,
      r,
      e,
      `yaffle.ParseWith(ctx, data, opts.Strict, func(r *yaffle.Reader) *${T}`,
      fn => {
        const body = fn.child();
        const v = this.reader.rootRead(body, r.s);
        this.prelude(fn, r);
        fn.declareLe(body.toString());
        fn.append(body);
        fn.line(`return ${v}`);
      }
    );
  }

  private emitSerialize(code: Code, r: Root): void {
    const { names, T } = r;
    const e = {
      name: names.serialize,
      ctxName: names.serializeCtx,
      doc: `writes ${r.what}`,
      params: `v *${T}`,
      args: "v",
      result: "[]byte"
    };
    // Computed before the function: the layout variable is hoisted here.
    const layout = this.layout(r.s);
    this.emitEntry(
      code,
      r,
      e,
      `yaffle.SerializeWith(ctx, ${layout}, func(w *yaffle.Writer) yaffle.LEntry`,
      fn => {
        const body = fn.child();
        const l = this.writer.rootWrite(body, r.s, "v");
        this.prelude(fn, r);
        fn.declareLe(body.toString());
        fn.append(body);
        fn.line(l ? `return ${l}` : "return nil");
      }
    );
  }

  private emitView(code: Code, r: Root): void {
    const { names, s, T } = r;
    const vn = this.model.viewName(s.id);
    const fn = new Code();
    fn.line(`// ${names.view} opens a lazy view of ${r.what}: fields are read on demand,`);
    fn.line(
      `// same-size edits are patched in place, and Commit or Patches write every edit back.`
    );
    fn.block(`func ${names.view}(data []byte, opts *${names.options}) (*${vn}, error)`, () => {
      fn.block("if opts == nil", () => fn.line(`opts = &${names.options}{}`));
      this.prelude(fn, r);
      const rbody = fn.child();
      const rv = this.reader.rootRead(rbody, s);
      const wbody = fn.child();
      const wl = this.writer.rootWrite(wbody, s, "x");
      const args = s.params.map(p => (p.origin === "endian" ? "endian" : local(p.name)));
      fn.line("n, err := yaffle.OpenView(data, yaffle.RootSpec{");
      fn.indent(() => {
        fn.line("Strict: opts.Strict,");
        fn.line(`Args:   []any{${args.join(", ")}},`);
        fn.line(`Layout: ${this.layout(s)},`);
        fn.line("Read: func(r *yaffle.Reader) any {");
        fn.indent(() => {
          fn.declareLe(rbody.toString() + rv);
          fn.append(rbody);
          fn.line(`return ${rv}`);
        });
        fn.line("},");
        fn.line("Write: func(w *yaffle.Writer, v any) yaffle.LEntry {");
        fn.indent(() => {
          fn.line(`x := v.(*${T})`);
          fn.declareLe(wbody.toString());
          fn.append(wbody);
          fn.line(wl ? `return ${wl}` : "return nil");
        });
        fn.line("},");
      });
      fn.line("})");
      fn.block("if err != nil", () => fn.line("return nil, err"));
      fn.line(`return &${vn}{n}, nil`);
    });
    code.line(fixUnused(fn.toString()));
    code.line("");
  }

  private emitJSON(code: Code, r: Root): void {
    const { names, s, T } = r;
    code.line(`// ${names.toJSON} renders ${r.what} as canonical JSON (shared objects as $refs).`);
    code.block(`func ${names.toJSON}(v *${T}) ([]byte, error)`, () => {
      code.line(`return yaffle.ToJSONWith(func(j *yaffle.JSONWriter) {`);
      code.indent(() => {
        if (this.model.identityStructs.has(s.id)) code.line(`j.Ref(v, "")`);
        code.line(`toJSON${T}(j, v, "")`);
      });
      code.line("})");
    });
    code.line("");
    code.line(`// ${names.fromJSON} reads ${r.what} from canonical JSON.`);
    code.block(`func ${names.fromJSON}(data []byte) (*${T}, error)`, () => {
      code.line(`return yaffle.FromJSONWith(data, func(c *yaffle.FromJSON, j any) *${T} {`);
      code.indent(() => code.line(`return yaffle.Obj(c, j, "", fromJSON${T})`));
      code.line("})");
    });
    code.line("");
    code.line(
      `// ${names.optionsFromJSON} reads options from JSON: {"endian": "le"|"be", "strict": bool, root parameters by name}.`
    );
    code.block(`func ${names.optionsFromJSON}(data []byte) (*${names.options}, error)`, () => {
      code.line(
        `return yaffle.FromJSONWith(data, func(c *yaffle.FromJSON, j any) *${names.options} {`
      );
      code.indent(() => {
        code.line(`o := &${names.options}{}`);
        code.block("if j == nil", () => code.line("return o"));
        code.line("m := yaffle.JObject(j)");
        code.block(`if x, ok := m["endian"]; ok`, () => code.line("o.Endian = yaffle.JEndian(x)"));
        code.block(`if x, ok := m["strict"]; ok`, () => code.line("o.Strict = yaffle.JBool(x)"));
        for (const p of r.params) {
          const key = p.boundName ?? p.name;
          const f = r.fieldOf.get(p.name)!;
          const conv = this.json.valueFromJSON(p.type, "x", goStr(`/${key}`));
          code.block(`if x, ok := m[${goStr(key)}]; ok`, () =>
            code.line(this.optionPtr(p) ? `o.${f} = yaffle.Ptr(${conv})` : `o.${f} = ${conv}`)
          );
        }
        code.line("return o");
      });
      code.line("})");
    });
  }

  /** Context for constant expressions (parameter defaults). */
  private constCtx(): ExprCtx {
    const none = (): CExpr => ({ code: "nil", gt: "untyped", kind: "other" });
    return {
      mode: "read",
      field: none,
      param: none,
      it: none,
      lambda: n => n,
      builtin: () => "0",
      sizeof: () => "0",
      offsetof: () => "0",
      encodedSize: () => "0",
      bytesof: () => "nil",
      encode: () => "nil",
      externFn: id => this.mod.extern(id),
      hoist: (c, h) => this.mod.hoist(c, h),
      use: pkg => this.mod.use(pkg),
      fieldType: () => undefined
    };
  }
}
