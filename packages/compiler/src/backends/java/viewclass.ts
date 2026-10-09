/**
 * View code per struct: the `INFO` descriptor the runtime's views use (scan, read, copy, field
 * access and in-place encoders) and the typed `View` class with lazy getters and setters.
 */
import type { IrStruct, IrType } from "../../ir/index.ts";
import { isOneWay, unlayer } from "./analysis.ts";
import { Code, str } from "./code.ts";
import type { ClassCtx } from "./ctx.ts";
import { refInput, refType, type Model } from "./model.ts";
import {
  childSafe,
  derivedFrom,
  elemStruct,
  layoutReads,
  neededFields,
  structuralFields,
  viewFields
} from "./views.ts";
import type { WriteEmitter } from "./write.ts";

/** Bean-style accessor suffix of a Java field name. */
function cap(java: string): string {
  return java.charAt(0).toUpperCase() + java.slice(1);
}

export class ViewClassEmitter {
  readonly model: Model;
  readonly cls: ClassCtx;
  readonly writer: WriteEmitter;

  constructor(model: Model, cls: ClassCtx, writer: WriteEmitter) {
    this.model = model;
    this.cls = cls;
    this.writer = writer;
  }

  private use(n: string): string {
    return this.cls.use(n);
  }

  /** The view type of a value of IR type `t` (struct views, list views, boxed values). */
  private viewType(t: IrType): string {
    const u = unlayer(t);
    switch (u.kind) {
      case "struct":
        return `${this.model.className(u.struct)}.View`;
      case "array":
        return `${this.use("ListView")}<${this.viewElem(u.element)}>`;
      case "pointer":
        return this.viewType(u.target);
      default:
        return this.model.javaType(u, true);
    }
  }

  private viewElem(t: IrType): string {
    let x = unlayer(t);
    if (x.kind === "pointer") x = unlayer(x.target);
    if (x.kind === "struct") return `${this.model.className(x.struct)}.View`;
    return this.model.javaType(t, true);
  }

  /** Emits `static final StructInfo INFO`. */
  emitInfo(out: Code, s: IrStruct): void {
    const model = this.model;
    const name = model.className(s.id);
    const SI = this.use("StructInfo");
    const views = viewFields(s, model);
    const structural = structuralFields(s);
    const derived = derivedFrom(s);
    const relayout = layoutReads(s);
    const size = s.base ? undefined : model.structStaticSize(s.id);
    const args = s.params.map((p, i) =>
      this.cls.castFromObject(model.javaValueType(p.type), `$a[${i}]`)
    );
    const fields: string[] = [];
    for (const f of model.outputFields(s)) {
      const fi = model.fieldInfo(s, f.name);
      const input = refInput(f);
      const enc = input === "absent" ? undefined : this.writer.encoderFor(s, f.name);
      // Fields a layout reads keep their encoder, which validates set values, but every edit of
      // one is structural so the commit re-lays out.
      const validate = enc !== undefined && !derived.has(f.name);
      const patch = validate && !relayout.has(f.name);
      const kind = views.has(f.name) ? "VIEW" : "PLAIN";
      // One-way transforms are edited through their raw value.
      const target = fi.raw ?? fi;
      const setV = this.cls.castFromObject(target.type, "$x");
      fields.push(
        `new ${SI}.Field(${str(f.name)}, ${str(input)}, ${patch}, ${structural.has(f.name)}, ${SI}.Kind.${kind}, ${enc && validate ? enc.replace(/\n/g, "\n    ") : "null"}, $o -> ((${name}) $o).${target.java}, ($o, $x) -> ((${name}) $o).${target.java} = ${setV})`
      );
    }
    const lines = [
      str(s.name),
      str(model.typeKey({ kind: "struct", struct: s.id, args: [] })),
      `($r, $vs, $a) -> scan(${["$r", "$vs", ...args].join(", ")})`,
      `($r, $a) -> read(${["$r", ...args].join(", ")})`,
      String(size ?? -1),
      String(s.base),
      String(childSafe(s)),
      `View::new`,
      `${name}::new`,
      `$o -> ((${name}) $o).copy()`,
      ...fields
    ];
    out.line(`/** View descriptor of {@code ${s.name}} (lazy views, in-place patches). */`);
    out.line(`static final ${SI} INFO =`);
    out.indent(() => {
      out.line(`new ${SI}(`);
      out.indent(() => {
        lines.forEach((l, i) => out.line(`${l}${i < lines.length - 1 ? "," : ");"}`));
      });
    });
  }

  /** Emits the nested `View` class. */
  emitView(out: Code, s: IrStruct): void {
    const model = this.model;
    const name = model.className(s.id);
    const views = viewFields(s, model);
    const needed = neededFields(s);
    const SV = this.use("StructView");
    const VN = this.use("ViewNode");
    out.line(
      `/** A lazy view of {@code ${s.name}}: fields are read on access; see {@link ${SV}}. */`
    );
    out.block(`public static final class View extends ${SV}`, () => {
      out.block(`View(${VN} node)`, () => out.line("super(node);"));
      out.line("");
      out.line(`/** A detached view of a plain value (for example to add to a list view). */`);
      out.block(`public static View of(${name} value)`, () =>
        out.line(`return (View) ${VN}.detached(INFO, value).view();`)
      );
      out.line("");
      out.line(`/** A plain value of this view, with its edits. */`);
      out.block(`public ${name} toValue()`, () => out.line(`return (${name}) node().toValue();`));
      const used = new Set<string>(["getClass"]);
      const unique = (n: string): string => {
        let m = n;
        while (used.has(m)) m += "_";
        used.add(m);
        return m;
      };
      const setter = (setterName: string, type: string, field: string): void => {
        out.line("");
        out.block(`public View ${setterName}(${type} value)`, () => {
          out.line(`node().set(${str(field)}, value);`);
          out.line("return this;");
        });
      };
      for (const f of model.outputFields(s)) {
        const fi = model.fieldInfo(s, f.name);
        const t = refType(f);
        const N = unique(`get${cap(fi.java)}`).slice(3);
        const es = elemStruct(t);
        const composite =
          views.has(f.name) || (needed.has(f.name) && es !== undefined && !isOneWay(t));
        out.line("");
        if (composite) {
          const vt = this.viewType(t);
          const info = es ? `${model.className(es)}.INFO` : "null";
          if (vt.includes("<")) out.line(`@SuppressWarnings("unchecked")`);
          out.block(`public ${vt} get${N}()`, () =>
            out.line(`return (${vt}) node().view(${str(f.name)}, ${info});`)
          );
        } else {
          out.block(`public ${fi.type} get${N}()`, () =>
            out.line(`return ((${name}) node().value()).${fi.java};`)
          );
        }
        if (fi.raw) {
          const raw = fi.raw;
          out.line("");
          out.block(`public ${raw.type} ${unique(`get${cap(raw.java)}`)}()`, () =>
            out.line(`return ((${name}) node().value()).${raw.java};`)
          );
        }
        if (refInput(f) === "absent") continue;
        const setterName = fi.raw ? `set${cap(fi.raw.java)}` : `set${N}`;
        setter(setterName, fi.raw ? fi.raw.type : fi.type, f.name);
        let st = unlayer(t);
        if (st.kind === "pointer") st = unlayer(st.target);
        if (composite && st.kind === "struct") {
          setter(setterName, `${model.className(st.struct)}.View`, f.name);
        }
      }
    });
  }
}
