/**
 * View descriptor emitter: `_view_X` per struct, the `StructInfo` the runtime's lazy views use
 * (scan function, static size, which fields can be patched in place, which are structural), plus
 * the per-field patch encoders.
 */
import type { IrStruct } from "../../ir/index.ts";
import { childSafe, derivedFrom, structuralFields } from "./analysis.ts";
import { pyBool, pyStr, type Code } from "./code.ts";
import type { Model } from "./model.ts";
import type { Names } from "./names.ts";
import type { WriteEmitter } from "./write.ts";

export function emitViewInfo(
  code: Code,
  s: IrStruct,
  model: Model,
  names: Names,
  writer: WriteEmitter
): void {
  const cls = names.structClass(s.id);
  const structural = structuralFields(s);
  const derived = derivedFrom(s);
  const size = s.base ? undefined : model.structStaticSize(s.id);
  const fields: string[] = [];
  const encoders: string[] = [];
  const seen = new Set<string>();
  for (const f of model.fields(s)) {
    const { output, input } = f.field ?? f.bit!;
    if (!output || seen.has(f.name)) continue;
    seen.add(f.name);
    const attr = names.attr(s, f.name);
    const enc =
      input === "absent" || derived.has(f.name) ? undefined : writer.encoderFor(code, s, f.name);
    fields.push(
      `${pyStr(attr)}: _rt.FieldInfo(${pyStr(f.name)}, ${pyStr(input)}, ${pyBool(structural.has(f.name))})`
    );
    if (enc) encoders.push(`${pyStr(attr)}: ${enc}`);
  }
  code.line(`_view_${cls} = _rt.StructInfo(`);
  code.indent(() => {
    code.line(`name=${pyStr(s.name)},`);
    code.line(`key=${pyStr(model.typeKey({ kind: "struct", struct: s.id, args: [] }))},`);
    code.line(`scan=_scan_${cls},`);
    code.line(`static_size=${size ?? "None"},`);
    code.line(`base=${pyBool(s.base)},`);
    code.line(`child_safe=${pyBool(childSafe(s))},`);
    code.line(`fields={${fields.join(", ")}},`);
    code.line(`encode={${encoders.join(", ")}},`);
  });
  code.line(")");
}
