/**
 * View emitter: per struct an `XView` class (lazy getters, setters that patch in place when
 * possible, child views), the view scan `scan_X` (the reader in scan mode), argument structs,
 * navigation helpers and in-place patch encoders. See yaffle/view.hpp.
 */
import type { IrStruct, IrType } from "../../ir/index.ts";
import {
  derivedFrom,
  fieldsInLayeredBlocks,
  hasVia,
  isChildSafe,
  isOneWay,
  layoutArgFields,
  neededFields,
  stripLayers,
  viaKidLayer
} from "./analysis.ts";
import { Code, localName, str } from "./code.ts";
import type { FieldRef, Model } from "./model.ts";
import type { ReadEmitter } from "./read.ts";
import type { TypeMapper } from "./types.ts";
import type { WriteEmitter } from "./write.ts";

interface ViewKind {
  many: boolean;
  target: string;
  optional: boolean;
}

const RESERVED = new Set([
  "plain",
  "replace",
  "offset",
  "patches",
  "commit",
  "doc",
  "materialized",
  "kid",
  "resolve",
  "child",
  "location",
  "is_null",
  "prefix_path",
  "materialize",
  "materialize_into"
]);

export class ViewEmitter {
  readonly model: Model;
  readonly types: TypeMapper;
  readonly reader: ReadEmitter;
  readonly writer: WriteEmitter;

  constructor(model: Model, types: TypeMapper, reader: ReadEmitter, writer: WriteEmitter) {
    this.model = model;
    this.types = types;
    this.reader = reader;
    this.writer = writer;
  }

  viewName(id: string): string {
    return `${this.model.structName(id)}View`;
  }

  /** Accessor name of a field in a view class. */
  method(name: string): string {
    const m = this.model.member(name);
    return RESERVED.has(m) ? `${m}_` : m;
  }

  outputFields(s: IrStruct): FieldRef[] {
    return this.model.uniqueFields(s).filter(f => (f.field ? f.field.output : f.bit!.output));
  }

  /** Whether (and how) a field has struct views: one child, or a sequence. */
  viewKind(s: IrStruct, fr: FieldRef): ViewKind | undefined {
    const vk = this.viewKindOf(s, fr);
    // A struct with its own codec layers lives in a decoded region: no child views.
    if (vk && this.model.struct(vk.target).layers.some(l => l.kind === "via")) return undefined;
    return vk;
  }

  private viewKindOf(s: IrStruct, fr: FieldRef): ViewKind | undefined {
    const f = fr.field;
    if (!f) return undefined;
    const optional = this.model.isOptionalMember(s, fr.name);
    // A struct read from a stream, or through one codec: a child view in that byte space.
    if (f.from) {
      const t = f.type;
      if (t.kind === "struct" && this.model.struct(t.struct).layers.length === 0)
        return { many: false, target: t.struct, optional };
      return undefined;
    }
    if (viaKidLayer(this.model, f.type) !== undefined && !f.placement) {
      const x = stripLayers(f.type) as Extract<IrType, { kind: "struct" }>;
      return { many: false, target: x.struct, optional };
    }
    if (hasVia(f.type)) return undefined;
    const t = stripLayers(f.type);
    if (t.kind === "struct") return { many: false, target: t.struct, optional };
    if (t.kind === "pointer") {
      if (hasVia(t.target)) return undefined;
      const x = stripLayers(t.target);
      if (x.kind === "struct")
        return {
          many: false,
          target: x.struct,
          optional: optional || (t.nullValue !== undefined && !t.emptyIsNull)
        };
      if (x.kind === "array") {
        const el = stripLayers(x.element);
        if (el.kind === "struct" && !hasVia(x.element))
          return { many: true, target: el.struct, optional: false };
      }
      return undefined;
    }
    if (t.kind === "array" && !hasVia(t.element)) {
      const el = stripLayers(t.element);
      if (el.kind === "struct") return { many: true, target: el.struct, optional: false };
      if (el.kind === "pointer" && !hasVia(el.target)) {
        const x = stripLayers(el.target);
        if (x.kind === "struct") return { many: true, target: x.struct, optional: false };
      }
    }
    return undefined;
  }

  // ── source: helpers ─────────────────────────────────────────────────────────

  /** Prototypes of the scan functions (`scan_X`, `scan_entry_X`). */
  prototypes(s: IrStruct): string[] {
    const name = this.model.structName(s.id);
    return [
      `${this.reader.scanPrototype(s)};`,
      `static void scan_entry_${name}(yaffle::Reader& r, yaffle::ScanCtx& sc, yaffle::NodeScan<${name}>& ns, const void* a_);`
    ];
  }

  /** The scan, entry points, navigation and patch encoders (`bodies`) and the view class (`defs`). */
  emitFunctions(bodies: Code, defs: Code, s: IrStruct): void {
    this.reader.emitStruct(bodies, s, true);
    bodies.line("");
    this.emitEntries(bodies, s);
    this.emitNav(bodies, s);
    const encoders = this.patchable(s);
    for (const enc of encoders.values()) bodies.line(enc);
    bodies.line("");
    this.defineClass(defs, s, encoders);
    defs.line("");
  }

  /** `X_Args`: the arguments of a struct's type (kids of scans carry them). */
  emitArgs(code: Code, s: IrStruct): void {
    const name = this.model.structName(s.id);
    code.block(
      `struct ${name}_Args`,
      () => {
        for (const p of s.params) {
          if (p.origin === "endian") code.line(`yaffle::Endian endian = yaffle::Endian::le;`);
          else code.line(`${this.types.valueType(p.type)} ${localName(p.name)}{};`);
        }
      },
      ";"
    );
  }

  private argList(s: IrStruct): string {
    return s.params
      .map(p => `, a.${p.origin === "endian" ? "endian" : localName(p.name)}`)
      .join("");
  }

  private emitEntries(code: Code, s: IrStruct): void {
    const name = this.model.structName(s.id);
    code.block(
      `[[maybe_unused]] static void scan_entry_${name}(yaffle::Reader& r, yaffle::ScanCtx& sc, yaffle::NodeScan<${name}>& ns, const void* a_)`,
      () => {
        code.line(`const auto& a = *static_cast<const ${name}_Args*>(a_);`);
        code.line(`scan_${name}(r, sc, ns${this.argList(s)});`);
      }
    );
    code.block(
      `[[maybe_unused]] static void read_entry_${name}(yaffle::Reader& r, ${name}& v, const void* a_)`,
      () => {
        code.line(`const auto& a = *static_cast<const ${name}_Args*>(a_);`);
        code.line(`read_${name}(r, v${this.argList(s)});`);
      }
    );
  }

  /** Navigation (materialized values) and location (scans) of every viewable field. */
  private emitNav(code: Code, s: IrStruct): void {
    const name = this.model.structName(s.id);
    for (const fr of this.outputFields(s)) {
      const vk = this.viewKind(s, fr);
      if (!vk) continue;
      const m = this.model.member(fr.name);
      const fi = this.reader.fieldIndex(s, fr.name);
      code.line(
        `[[maybe_unused]] static void* nav_${name}_${m}(void* p, [[maybe_unused]] std::int64_t i) { return yaffle::${vk.many ? `nav_elem(static_cast<${name}*>(p)->${m}, i)` : `nav_ptr(static_cast<${name}*>(p)->${m})`}; }`
      );
      code.line(
        `[[maybe_unused]] static yaffle::Kid loc_${name}_${m}(yaffle::Doc& d, const yaffle::Kid& k, std::int64_t i) { return yaffle::kid_of(d.scan<${name}>(k, ${str(s.id)}, scan_entry_${name}), ${fi}, i); }`
      );
    }
  }

  /**
   * Fields that patch in place: an encoder exists and nothing else depends on their value (layout
   * item arguments included: setting `align` in `layout { data @align(align) }` re-lays out).
   */
  private patchable(s: IrStruct): Map<string, string> {
    const out = new Map<string, string>();
    const derived = derivedFrom(s);
    const needed = neededFields(s);
    const layered = fieldsInLayeredBlocks(s.members);
    const layout = layoutArgFields(s);
    for (const fr of this.outputFields(s)) {
      const input = fr.field ? fr.field.input : fr.bit!.input;
      if (input === "absent" || fr.field?.hidden) continue;
      if (derived.has(fr.name) || needed.has(fr.name) || layered.has(fr.name)) continue;
      if (layout.has(fr.name)) continue;
      const enc = this.writer.encoderFor(s, fr.name);
      if (enc) out.set(fr.name, enc);
    }
    return out;
  }

  /** `doc_->scan<X>(…)`: this view's scan. */
  private scanOf(s: IrStruct): string {
    const name = this.model.structName(s.id);
    return `doc_->scan<${name}>(kid(), ${str(s.id)}, scan_entry_${name})`;
  }

  /** This view's value in the materialized document. */
  private objOf(s: IrStruct): string {
    return `static_cast<const ${this.model.structName(s.id)}*>(resolve())`;
  }

  /**
   * `materialize_into`: every output field through this view (getters, child views for struct
   * values), so the result exercises the view's own read paths; `materialize`: the same into a
   * fresh value.
   */
  private defineMaterialize(code: Code, s: IrStruct): void {
    const name = this.model.structName(s.id);
    const view = this.viewName(s.id);
    code.block(
      `void ${view}::materialize_into(${name}& out_, [[maybe_unused]] yaffle::MatCtx& mc_) const`,
      () => {
        code.block(`if (doc_->materialized())`, () => {
          code.line(`out_ = *${this.objOf(s)};`);
          code.line(`return;`);
        });
        code.rethrow(() => {
          code.line(`[[maybe_unused]] auto& ns_ = ${this.scanOf(s)};`);
          for (const fr of this.outputFields(s)) this.materializeField(code, s, fr);
        }, "prefix_path(e);");
      }
    );
    code.block(`${this.types.structRef(s.id)} ${view}::materialize() const`, () => {
      code.line(`yaffle::MatCtx m;`);
      if (this.model.isShared(s.id))
        code.line(`return m.shared<${name}>(kid(), [&](${name}& o) { materialize_into(o, m); });`);
      else {
        code.line(`${name} out;`);
        code.line(`materialize_into(out, m);`);
        code.line(`return out;`);
      }
    });
  }

  private materializeField(code: Code, s: IrStruct, fr: FieldRef): void {
    const m = this.model.member(fr.name);
    const meth = this.method(fr.name);
    const vk = this.viewKind(s, fr);
    const assign = (target: string): void => {
      if (vk?.many) code.line(`yaffle::mat_array(${target}, ${meth}_views(), mc_);`);
      else if (vk?.optional) {
        code.chain([
          [
            `if (auto cv_ = ${meth}_view())`,
            () => code.line(`yaffle::mat_assign(${target}, *cv_, mc_);`)
          ],
          ["else", () => code.line(`${target} = {};`)]
        ]);
      } else code.line(`yaffle::mat_assign(${target}, ${meth}_view(), mc_);`);
    };
    if (vk && this.model.isOptionalMember(s, fr.name)) {
      code.block(`if (ns_.v.${m})`, () => {
        code.line(`out_.${m}.emplace();`);
        assign(`(*out_.${m})`);
      });
    } else if (vk) assign(`out_.${m}`);
    else code.line(`out_.${m} = ${meth}();`);
    if (fr.field && isOneWay(fr.field.type)) {
      const raw = this.reader.names.rawMember(s, fr.name);
      code.line(`out_.${raw} = ns_.v.${raw};`);
    }
  }

  /** Fields with a setter: inputs that are not one-way transforms. */
  private settable(fr: FieldRef): boolean {
    const input = fr.field ? fr.field.input : fr.bit!.input;
    return input !== "absent" && !(fr.field && isOneWay(fr.field.type));
  }

  // ── header: class declarations ──────────────────────────────────────────────

  declareClass(h: Code, s: IrStruct): void {
    const name = this.model.structName(s.id);
    const view = this.viewName(s.id);
    h.line(
      `/** Lazy view of ${s.name}: getters read on access, setters patch in place when they can. */`
    );
    h.block(
      `class ${view} : public yaffle::ViewBase`,
      () => {
        h.line(" public:");
        h.line(`using yaffle::ViewBase::ViewBase;`);
        for (const fr of this.outputFields(s)) {
          const t = fr.field ? fr.field.type : fr.bit!.type;
          const mt = this.types.memberType(s, fr.name, t);
          const meth = this.method(fr.name);
          h.line(`${mt} ${meth}() const;`);
          if (this.settable(fr)) h.line(`void set_${meth}(const ${mt}& value);`);
          const vk = this.viewKind(s, fr);
          if (vk) {
            const cv = this.viewName(vk.target);
            if (vk.many) h.line(`yaffle::ArrayView<${cv}> ${meth}_views() const;`);
            else h.line(`${vk.optional ? `std::optional<${cv}>` : cv} ${meth}_view() const;`);
          }
        }
        h.line(`/** The whole value (a full read of the struct and everything it points to). */`);
        h.line(`${name} plain() const;`);
        h.line(
          `/** The whole value, read field by field through this view and its child views. */`
        );
        h.line(`${this.types.structRef(s.id)} materialize() const;`);
        h.line(`void materialize_into(${name}& out, yaffle::MatCtx& m) const;`);
        h.line(`/** Replaces the whole value (a structural edit). */`);
        h.line(`void replace(const ${name}& value);`);
      },
      ";"
    );
  }

  // ── source: class definitions ───────────────────────────────────────────────

  private defineClass(code: Code, s: IrStruct, encoders: Map<string, string>): void {
    const name = this.model.structName(s.id);
    const view = this.viewName(s.id);
    const obj = this.objOf(s);
    for (const fr of this.outputFields(s)) {
      this.defineGetter(code, s, fr);
      if (this.settable(fr)) this.defineSetter(code, s, fr, encoders.has(fr.name));
      const vk = this.viewKind(s, fr);
      if (vk) this.defineChildViews(code, s, fr, vk);
    }
    this.defineMaterialize(code, s);
    code.block(`${name} ${view}::plain() const`, () => {
      code.line(`if (doc_->materialized()) return *${obj};`);
      code.line(`return doc_->read<${name}>(kid(), read_entry_${name});`);
    });
    code.block(`void ${view}::replace(const ${name}& value)`, () => {
      code.line(`doc_->materialize();`);
      code.line(`*static_cast<${name}*>(resolve()) = value;`);
      code.line(`doc_->mark_structural();`);
    });
  }

  /** A getter: the materialized value, or the field from the scan (loading a lazy field). */
  private defineGetter(code: Code, s: IrStruct, fr: FieldRef): void {
    const t = fr.field ? fr.field.type : fr.bit!.type;
    const mt = this.types.memberType(s, fr.name, t);
    const m = this.model.member(fr.name);
    const fi = this.reader.fieldIndex(s, fr.name);
    code.block(`${mt} ${this.viewName(s.id)}::${this.method(fr.name)}() const`, () => {
      code.line(`if (doc_->materialized()) return ${this.objOf(s)}->${m};`);
      code.rethrow(() => {
        code.line(`auto& ns = ${this.scanOf(s)};`);
        if (this.model.isOptionalMember(s, fr.name))
          code.line(`if (ns.v.${m}) ns.load(${fi}, *ns.v.${m});`);
        else code.line(`ns.load(${fi}, ns.v.${m});`);
        code.line(`return ns.v.${m};`);
      }, "prefix_path(e);");
    });
  }

  /**
   * A setter: an in-place patch when the field has an encoder and the new encoding has the old
   * size, else a structural edit of the materialized document.
   */
  private defineSetter(code: Code, s: IrStruct, fr: FieldRef, patchable: boolean): void {
    const name = this.model.structName(s.id);
    const t = fr.field ? fr.field.type : fr.bit!.type;
    const mt = this.types.memberType(s, fr.name, t);
    const m = this.model.member(fr.name);
    const fi = this.reader.fieldIndex(s, fr.name);
    const optional = this.model.isOptionalMember(s, fr.name);
    code.block(
      `void ${this.viewName(s.id)}::set_${this.method(fr.name)}(const ${mt}& value)`,
      () => {
        if (patchable) {
          const val = optional ? "*value" : "value";
          code.block(
            `if (in_place_ && !doc_->materialized() && kid().loc.space == 0${optional ? " && value" : ""})`,
            () => {
              code.line(`auto& ns = ${this.scanOf(s)};`);
              code.line(`const yaffle::FieldScan& fs = ns.fields[${fi}];`);
              code.block(`if (fs.start >= 0${optional ? ` && ns.v.${m}` : ""})`, () => {
                code.line(`yaffle::Bytes b;`);
                code.rethrow(
                  () =>
                    code.line(
                      `b = enc_${name}_${m}(${val}, ns.v, *static_cast<const ${name}_Args*>(kid().args.get()), kid().loc.index);`
                    ),
                  `e.prefix(${str(fr.name)});`,
                  "prefix_path(e);"
                );
                code.block(`if (static_cast<std::int64_t>(b.size()) == fs.end - fs.start)`, () => {
                  code.line(`doc_->patch(fs.start, b);`);
                  code.line(`return;`);
                });
              });
            }
          );
        }
        code.line(`doc_->materialize();`);
        code.line(`static_cast<${name}*>(resolve())->${m} = value;`);
        code.line(`doc_->mark_structural();`);
      }
    );
  }

  /** `f_view()` / `f_views()`: child views of the field's struct values. */
  private defineChildViews(code: Code, s: IrStruct, fr: FieldRef, vk: ViewKind): void {
    const name = this.model.structName(s.id);
    const view = this.viewName(s.id);
    const m = this.model.member(fr.name);
    const meth = this.method(fr.name);
    const fi = this.reader.fieldIndex(s, fr.name);
    const obj = this.objOf(s);
    const scan = this.scanOf(s);
    const cv = this.viewName(vk.target);
    const nav = `nav_${name}_${m}`;
    const loc = `loc_${name}_${m}`;
    // A child may patch in place only if no derive reads the content of inline children.
    const inPlace = isChildSafe(s) ? "in_place_" : "false";
    if (vk.many) {
      code.block(`yaffle::ArrayView<${cv}> ${view}::${meth}_views() const`, () => {
        code.line(`std::size_t n;`);
        code.line(
          `if (doc_->materialized()) n = static_cast<std::size_t>(yaffle::size_of(${obj}->${m}));`
        );
        code.line(`else n = ${scan}.fields[${fi}].kids.size();`);
        code.line(
          `return yaffle::ArrayView<${cv}>(doc_, path_, ${fi}, ${str(fr.name)}, n, ${nav}, ${loc}, ${inPlace});`
        );
      });
      return;
    }
    code.block(`${vk.optional ? `std::optional<${cv}>` : cv} ${view}::${meth}_view() const`, () => {
      if (vk.optional) {
        code.chain([
          [
            `if (doc_->materialized())`,
            () => code.line(`if (!yaffle::present(${obj}->${m})) return std::nullopt;`)
          ],
          [
            "else",
            () => {
              code.line(`const auto& kids = ${scan}.fields[${fi}].kids;`);
              code.line(`if (kids.empty() || kids[0].loc.pos < 0) return std::nullopt;`);
            }
          ]
        ]);
      }
      code.line(
        `return ${cv}(doc_, child(${fi}, 0, ${str(fr.name)}, false, ${nav}, ${loc}), ${inPlace});`
      );
    });
  }
}
