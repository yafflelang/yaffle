/**
 * View emitter: per struct X a `XView` type over yaffle.Node with lazy getters, view getters for
 * nested structs and pointer targets, and setters that patch in place when they can.
 */
import type { IrField, IrStruct, IrType } from "../../ir/index.ts";
import { Code, NameSet, goStr, local, mentions } from "./code.ts";
import { stripType } from "./irutil.ts";
import type { GoField, Model } from "./model.ts";
import { gettableFromScan, isDeferred, scanFacts, unpatchableFields } from "./viewinfo.ts";
import type { WriteEmitter } from "./write.ts";

/** Strips layers other than codec layers. */
function strip(t: IrType): IrType {
  while (t.kind === "layered" && !t.layers.some(l => l.kind === "via")) t = t.inner;
  return t;
}

/** The view type of one struct, being emitted. */
interface StructView {
  code: Code;
  s: IrStruct;
  /** Go names of the struct and of its view type. */
  name: string;
  vn: string;
  /** Method names taken on the view type. */
  names: NameSet;
}

/** A view getter of a struct-valued field (the materializer descends through it). */
interface ViewGetter {
  /** one: a struct view; many: views of separate structs; shared: views of an array target. */
  kind: "one" | "many" | "shared";
  getter: string;
  sid: string;
}

interface MatField {
  go: string;
  getter: string;
  view?: ViewGetter | undefined;
  raw?: { go: string; getter: string } | undefined;
}

export class ViewEmitter {
  readonly model: Model;
  readonly writer: WriteEmitter;
  /** Generate `matX` (and per root `Materialize…View`): reading every field through the view. */
  materialize = false;

  constructor(model: Model, writer: WriteEmitter) {
    this.model = model;
    this.writer = writer;
  }

  emitStruct(code: Code, s: IrStruct): void {
    const name = this.model.structName(s.id);
    const vn = this.model.viewName(s.id);
    const v: StructView = { code, s, name, vn, names: new NameSet(["Node", "Value"]) };
    // Setting one of these is structural (a field a layout item reads can move targets: the
    // commit lays them out again).
    const unpatchable = unpatchableFields(this.model, s);
    const mat: MatField[] = [];
    code.line(`// ${vn} is a lazy view of ${name}: fields are read on demand, same-size edits`);
    code.line(`// are patched in place, and Commit writes every edit back.`);
    code.block(`type ${vn} struct`, () => code.line("*yaffle.Node"));
    code.line("");
    code.line(`// Value reads the whole ${name}.`);
    code.block(`func (x *${vn}) Value() (*${name}, error)`, () =>
      code.line(`return yaffle.Full[${name}](x.Node)`)
    );
    for (const g of this.model.goFieldsOf(s)) {
      if (g.hidden) continue;
      const f = g.ref.field;
      const getter = v.names.take(g.go);
      code.line("");
      this.emitGetter(v, getter, g);
      const entry: MatField = { go: g.go, getter };
      if (g.raw) {
        const rawGetter = v.names.take(g.raw.go);
        code.line("");
        code.line(`// ${rawGetter} reads the raw (stored) value of ${g.name}.`);
        const mode = this.fromScan(s, f, this.typeOf(g)) ? "Shallow" : "Full";
        this.valueGetter(v, rawGetter, g.raw.type, mode, g.raw.go);
        entry.raw = { go: g.raw.go, getter: rawGetter };
      }
      mat.push(entry);
      const input = f ? f.input : g.ref.bit!.input;
      if (input !== "absent" && !g.raw && !f?.from) {
        code.line("");
        const patch = unpatchable.has(g.name) ? undefined : this.writer.encoderBody(s, g.name);
        this.emitSetter(v, v.names.take(`Set${g.go}`), g, patch);
      }
      if (f) entry.view = this.emitViewGetter(v, g, f);
    }
    if (this.materialize) this.emitMaterializer(code, name, vn, mat);
  }

  /** Per root: `MaterializeXView(x)`, reading every field of the view through its getters. */
  emitRootMaterializer(code: Code, sid: string, fnName: string): void {
    const name = this.model.structName(sid);
    const vn = this.model.viewName(sid);
    code.line(
      `// ${fnName} reads every field of the view through its getters (child views for structs,`
    );
    code.line(`// targets read on demand) and returns the value, shared targets kept shared.`);
    code.block(`func ${fnName}(x *${vn}) (*${name}, error)`, () =>
      code.line(`return mat${name}(yaffle.NewMat(), x)`)
    );
  }

  private typeOf(g: GoField): IrType {
    return g.ref.field ? g.ref.field.type : g.ref.bit!.type;
  }

  /** True if a getter of field f (of type t) can return the scan's value. */
  private fromScan(s: IrStruct, f: IrField | undefined, t: IrType): boolean {
    return (
      !f ||
      (!f.placement &&
        !f.from &&
        !scanFacts(this.model, s).lazyVia.has(f.name) &&
        gettableFromScan(this.model, t))
    );
  }

  /** A getter returning a field of the node's value: scanned (Shallow) or read completely (Full). */
  private valueGetter(
    v: StructView,
    getter: string,
    type: string,
    mode: "Shallow" | "Full",
    goField: string
  ): void {
    v.code.block(`func (x *${v.vn}) ${getter}() (v ${type}, err error)`, () => {
      v.code.line(`o, err := yaffle.${mode}[${v.name}](x.Node)`);
      v.code.block("if err == nil", () => v.code.line(`v = o.${goField}`));
      v.code.line("return");
    });
  }

  private emitGetter(v: StructView, getter: string, g: GoField): void {
    const { code, s, name, vn } = v;
    const f = g.ref.field;
    const t = this.typeOf(g);
    const fname = f ? f.name : g.go;
    code.line(`// ${getter} reads ${fname}.`);
    if (f && isDeferred(this.model, s, f.name)) {
      // A deferred field (a `from` stream, a lazy codec region): read alone on demand, or
      // from the scan when it was read in place.
      const valueGo = this.model.goType(t);
      code.block(`func (x *${vn}) ${getter}() (v ${g.type}, err error)`, () => {
        code.line(`val, ok, err := yaffle.ReadTarget[${valueGo}](x.Node, ${goStr(fname)}, 0)`);
        code.block("if err != nil", () => code.line("return"));
        code.block("if ok", () =>
          code.line(g.type === valueGo ? "return val, nil" : "return &val, nil")
        );
        code.line(`o, err := yaffle.Shallow[${name}](x.Node)`);
        code.block("if err == nil", () => code.line(`v = o.${g.go}`));
        code.line("return");
      });
      return;
    }
    if (f && scanFacts(this.model, s).lazyPieces.has(f.name) && g.type === "[]byte") {
      // A stream piece the scan left undecoded: decoded on demand.
      code.block(`func (x *${vn}) ${getter}() (v ${g.type}, err error)`, () => {
        code.line(`o, err := yaffle.Shallow[${name}](x.Node)`);
        code.block("if err != nil", () => code.line("return"));
        code.line(`return yaffle.PieceValue(o.${g.go}, &o.yfl, ${goStr(fname)})`);
      });
      return;
    }
    if (!f || this.fromScan(s, f, t)) {
      this.valueGetter(v, getter, g.type, "Shallow", g.go);
      return;
    }
    // A pointer or `at` target: the scan recorded where it is; read it alone.
    const st = strip(t);
    const target = f.placement ? t : st.kind === "pointer" ? st.target : undefined;
    if (target) {
      const targetGo = this.model.goType(target);
      const wrap = g.type !== targetGo && g.type === `*${targetGo}`;
      if (wrap || g.type === targetGo) {
        code.block(`func (x *${vn}) ${getter}() (out ${g.type}, err error)`, () => {
          code.line(`val, ok, err := yaffle.ReadTarget[${targetGo}](x.Node, ${goStr(fname)}, 0)`);
          if (wrap) code.block("if ok", () => code.line("out = &val"));
          else if (st.kind === "pointer" && st.emptyIsNull) {
            code.chain([
              ["if ok", () => code.line("out = val")],
              ["else if err == nil", () => code.line(`out = ${g.type}{}`)]
            ]);
          } else code.block("if ok", () => code.line("out = val"));
          code.line("return");
        });
        return;
      }
    }
    this.valueGetter(v, getter, g.type, "Full", g.go);
  }

  private emitSetter(v: StructView, setter: string, g: GoField, patch: string | undefined): void {
    const { code, s, name, vn } = v;
    const store = g.ptr ? `yaffle.Ptr(val)` : "val";
    let enc = "nil";
    if (patch !== undefined) {
      const e = new Code();
      e.line("func(o any) []byte {");
      e.indent(() => {
        e.line(`c := *o.(*${name})`);
        e.line(`c.${g.go} = ${store}`);
        e.line("v := &c");
        e.line("return yaffle.EncodeWith(func(w *yaffle.Writer) {");
        e.indent(() => {
          e.declareLe(patch);
          e.line("fr := w.Enter()");
          e.line(patch);
          e.line("w.Leave(fr)");
        });
        e.line("})");
      });
      e.line("}");
      enc = e.toString();
    }
    code.line(
      `// ${setter} sets ${g.name}: in place when the encoding keeps its size and nothing else depends`
    );
    code.line(`// on it, otherwise when the view is committed.`);
    code.block(`func (x *${vn}) ${setter}(val ${g.valueType}) error`, () => {
      // The encoder runs in the struct's context: its arguments and $index.
      s.params.forEach((p, i) => {
        const pn = p.origin === "endian" ? "endian" : local(p.name);
        if (mentions(enc, pn))
          code.line(`${pn} := x.Node.Arg(${i}).(${this.model.goValueType(p.type)})`);
      });
      if (mentions(enc, "index")) code.line("index := x.Node.Index()");
      code.line(
        `return x.Node.Set(${goStr(g.name)}, ${enc}, func(o any) { o.(*${name}).${g.go} = ${store} })`
      );
    });
  }

  private emitViewGetter(v: StructView, g: GoField, f: IrField): ViewGetter | undefined {
    const { code, s, name, vn, names } = v;
    const fname = g.name;
    if (isDeferred(this.model, s, f.name)) {
      // A view of a deferred field's struct: its scan reads the stream or the decoded region.
      const st = stripType(f.type)!;
      if (st.kind !== "struct") return undefined;
      const cv = this.model.viewName(st.struct);
      const getter = names.take(`${g.go}View`);
      code.line("");
      code.line(
        `// ${getter} is a view of ${fname}, read on demand (nil when the scan read it in place).`
      );
      code.block(`func (x *${vn}) ${getter}() (*${cv}, error)`, () => {
        code.line(`n, ok, err := x.Node.TargetView(${goStr(fname)}, 0)`);
        code.block("if err != nil || !ok", () => code.line("return nil, err"));
        code.line(`return &${cv}{n}, nil`);
      });
      return { kind: "one", getter, sid: st.struct };
    }
    if (f.from) return undefined;
    const t = strip(f.type);
    // Structs read through a codec of their own live in decoded bytes: no views of them.
    const viewable = (sid: string): boolean =>
      !this.model.struct(sid).layers.some(l => l.kind === "via");
    // Inline struct or array of inline structs.
    if (!f.placement && t.kind === "struct") {
      if (!viewable(t.struct)) return undefined;
      const cv = this.model.viewName(t.struct);
      const getter = names.take(`${g.go}View`);
      code.line("");
      code.line(`// ${getter} is a view of ${fname}.`);
      code.block(`func (x *${vn}) ${getter}() (*${cv}, error)`, () => {
        code.line(`o, err := yaffle.Shallow[${name}](x.Node)`);
        code.block(`if err != nil || o.${g.go} == nil`, () => code.line("return nil, err"));
        code.line(`n, err := x.Node.Child(o.${g.go}, ${goStr(fname)})`);
        code.block("if err != nil", () => code.line("return nil, err"));
        code.line(`return &${cv}{n}, nil`);
      });
      return { kind: "one", getter, sid: t.struct };
    }
    if (!f.placement && t.kind === "array") {
      const et = strip(t.element);
      if (et.kind === "struct") {
        if (!viewable(et.struct)) return undefined;
        const cv = this.model.viewName(et.struct);
        const getter = names.take(`${g.go}Views`);
        code.line("");
        code.line(
          `// ${getter} returns views of the elements of ${fname} (nil when it is absent).`
        );
        code.block(`func (x *${vn}) ${getter}() ([]*${cv}, error)`, () => {
          code.line(`o, err := yaffle.Shallow[${name}](x.Node)`);
          code.block(`if err != nil || o.${g.go} == nil`, () => code.line("return nil, err"));
          code.line(`out := make([]*${cv}, len(o.${g.go}))`);
          code.block(`for i, e := range o.${g.go}`, () => {
            code.line(`n, err := x.Node.Child(e, ${goStr(fname)}, i)`);
            code.block("if err != nil", () => code.line("return nil, err"));
            code.line(`out[i] = &${cv}{n}`);
          });
          code.line("return out, nil");
        });
        return { kind: "many", getter, sid: et.struct };
      }
      if (et.kind === "pointer") {
        const tt = strip(et.target);
        if (tt.kind !== "struct" || !viewable(tt.struct)) return undefined;
        return { kind: "many", getter: this.targetViews(v, g, tt.struct), sid: tt.struct };
      }
      return undefined;
    }
    // Pointer target or `at` field.
    const target = f.placement ? f.type : t.kind === "pointer" ? t.target : undefined;
    if (!target) return undefined;
    const tt = strip(target);
    if (tt.kind === "struct") {
      if (!viewable(tt.struct)) return undefined;
      return { kind: "one", getter: this.targetView(v, g, tt.struct, false), sid: tt.struct };
    }
    if (tt.kind === "array") {
      const et = strip(tt.element);
      if (et.kind === "pointer") {
        // A placed array of pointers: views of the targets of its elements.
        const pt = strip(et.target);
        if (pt.kind !== "struct" || !viewable(pt.struct)) return undefined;
        return { kind: "many", getter: this.elementTargetViews(v, g, pt.struct), sid: pt.struct };
      }
      if (et.kind === "struct" && viewable(et.struct))
        return { kind: "shared", getter: this.targetView(v, g, et.struct, true), sid: et.struct };
    }
    return undefined;
  }

  /** A view of a pointer or `at` field's struct target (or of each element of an array target). */
  private targetView(v: StructView, g: GoField, sid: string, array: boolean): string {
    const { code, vn, names } = v;
    const cv = this.model.viewName(sid);
    const cn = this.model.structName(sid);
    const getter = names.take(array ? `${g.go}Views` : `${g.go}View`);
    code.line("");
    code.line(
      array
        ? `// ${getter} returns views of the elements of ${g.name} (read on demand).`
        : `// ${getter} is a view of the target of ${g.name} (read on demand; nil for a null pointer).`
    );
    code.block(`func (x *${vn}) ${getter}() (${array ? `[]*${cv}` : `*${cv}`}, error)`, () => {
      code.line(`n, ok, err := x.Node.TargetView(${goStr(g.name)}, 0)`);
      code.block("if err != nil || !ok", () => code.line("return nil, err"));
      if (!array) {
        code.line(`return &${cv}{n}, nil`);
        return;
      }
      code.line("o, err := n.Object()");
      code.block("if err != nil", () => code.line("return nil, err"));
      code.line(`arr, _ := o.([]*${cn})`);
      code.line(`out := make([]*${cv}, len(arr))`);
      code.block("for i, e := range arr", () => {
        code.line("c, err := n.Child(e, i)");
        code.block("if err != nil", () => code.line("return nil, err"));
        code.line(`out[i] = &${cv}{c}`);
      });
      code.line("return out, nil");
    });
    return getter;
  }

  /** Views of the targets of a placed (or pointed-to) array of pointers. */
  private elementTargetViews(v: StructView, g: GoField, sid: string): string {
    const { code, vn, names } = v;
    const cv = this.model.viewName(sid);
    const getter = names.take(`${g.go}Views`);
    code.line("");
    code.line(
      `// ${getter} returns views of the targets of the elements of ${g.name} (nil for null elements).`
    );
    code.block(`func (x *${vn}) ${getter}() ([]*${cv}, error)`, () => {
      code.line(`n, ok, err := x.Node.TargetView(${goStr(g.name)}, 0)`);
      code.block("if err != nil || !ok", () => code.line("return nil, err"));
      code.line("count, err := n.TargetCount(yaffle.ElemField)");
      code.block("if err != nil", () => code.line("return nil, err"));
      code.line(`out := make([]*${cv}, count)`);
      code.block("for i := range out", () => {
        code.line("c, ok, err := n.TargetView(yaffle.ElemField, i, i)");
        code.block("if err != nil", () => code.line("return nil, err"));
        code.block("if ok", () => code.line(`out[i] = &${cv}{c}`));
      });
      code.line("return out, nil");
    });
    return getter;
  }

  /** Views of the targets of an array of pointers. */
  private targetViews(v: StructView, g: GoField, sid: string): string {
    const { code, name, vn, names } = v;
    const cv = this.model.viewName(sid);
    const getter = names.take(`${g.go}Views`);
    code.line("");
    code.line(`// ${getter} returns views of the targets of ${g.name} (read on demand).`);
    code.block(`func (x *${vn}) ${getter}() ([]*${cv}, error)`, () => {
      if (g.nilAbsent) {
        code.line(`v, err := yaffle.Shallow[${name}](x.Node)`);
        code.block(`if err != nil || v.${g.go} == nil`, () => code.line("return nil, err"));
      }
      code.line(`count, err := x.Node.TargetCount(${goStr(g.name)})`);
      code.block("if err != nil", () => code.line("return nil, err"));
      code.line(`out := make([]*${cv}, count)`);
      code.block("for i := range out", () => {
        code.line(`n, ok, err := x.Node.TargetView(${goStr(g.name)}, i, i)`);
        code.block("if err != nil", () => code.line("return nil, err"));
        code.block("if ok", () => code.line(`out[i] = &${cv}{n}`));
      });
      code.line("return out, nil");
    });
    return getter;
  }

  /**
   * `matX(m, x)`: builds the struct's value from its view, field by field: child views for
   * structs (so their own getters run), getters for everything else.
   */
  private emitMaterializer(code: Code, name: string, vn: string, fields: MatField[]): void {
    const fn = code;
    fn.line("");
    fn.line(`// mat${name} reads every field of the view through its getters.`);
    fn.block(`func mat${name}(m *yaffle.Mat, x *${vn}) (*${name}, error)`, () => {
      fn.block(`if v, ok := yaffle.MatGet[${name}](m, x.Node); ok`, () => fn.line("return v, nil"));
      fn.line(`v := &${name}{}`);
      fn.line("yaffle.MatPut(m, x.Node, v)");
      fn.line("var err error");
      const fail = (): void => {
        fn.line("return nil, err");
      };
      for (const f of fields) {
        const vg = f.view;
        if (!vg) {
          fn.block(`if v.${f.go}, err = x.${f.getter}(); err != nil`, fail);
        } else if (vg.kind === "one") {
          const cn = this.model.structName(vg.sid);
          fn.line(`if c, err := x.${vg.getter}(); err != nil {`);
          fn.indent(fail);
          fn.line(`} else if c != nil {`);
          fn.indent(() =>
            fn.block(`if v.${f.go}, err = mat${cn}(m, c); err != nil`, () =>
              fn.line("return nil, err")
            )
          );
          // No view (null, absent, or read in place by a deep scan): the getter has the value.
          fn.line(`} else if v.${f.go}, err = x.${f.getter}(); err != nil {`);
          fn.indent(fail);
          fn.line("}");
        } else if (vg.kind === "many") {
          const cn = this.model.structName(vg.sid);
          fn.line(`if cs, err := x.${vg.getter}(); err != nil {`);
          fn.indent(fail);
          fn.line(`} else if cs != nil {`);
          fn.indent(() => {
            fn.line(`v.${f.go} = make([]*${cn}, len(cs))`);
            fn.block("for i, c := range cs", () => {
              fn.block("if c == nil", () => fn.line("continue"));
              fn.block(`if v.${f.go}[i], err = mat${cn}(m, c); err != nil`, () =>
                fn.line("return nil, err")
              );
            });
          });
          fn.line("}");
        } else {
          // Elements of a shared array target: built once, so sharing survives.
          const cn = this.model.structName(vg.sid);
          fn.line(`if cs, err := x.${vg.getter}(); err != nil {`);
          fn.indent(fail);
          fn.line(`} else if cs != nil {`);
          fn.indent(() => {
            fn.line("var first *yaffle.Node");
            fn.block("if len(cs) > 0", () => fn.line("first = cs[0].Node"));
            fn.line(
              `if v.${f.go}, err = yaffle.MatSlice(m, first, len(cs), func() ([]*${cn}, error) {`
            );
            fn.indent(() => {
              fn.line(`out := make([]*${cn}, len(cs))`);
              fn.block("for i, c := range cs", () => {
                fn.line("var err error");
                fn.block(`if out[i], err = mat${cn}(m, c); err != nil`, () =>
                  fn.line("return nil, err")
                );
              });
              fn.line("return out, nil");
            });
            fn.line("}); err != nil {");
            fn.indent(() => fn.line("return nil, err"));
            fn.line("}");
          });
          fn.line("}");
        }
        if (f.raw) fn.block(`if v.${f.raw.go}, err = x.${f.raw.getter}(); err != nil`, fail);
      }
      fn.line("return v, err");
    });
  }
}
