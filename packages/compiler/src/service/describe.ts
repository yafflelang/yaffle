/**
 * Descriptions of symbols for hover and completion details: signatures, offsets, sizes,
 * endianness, attribute layering, derivations, bit diagrams.
 */
import type * as A from "../frontend/ast.ts";
import { ATTRIBUTES, attributeSignature } from "../frontend/attributes.ts";
import { formatFieldHead } from "../frontend/format.ts";
import { layerText } from "../frontend/irtext.ts";
import type { IrLayer, IrMember, IrType } from "../ir/index.ts";
import type { FieldResult, StructResult } from "../frontend/model.ts";
import { printArraySuffix, printExpr, printIrExpr, printTypeRef } from "../frontend/printer.ts";
import type {
  CodecSym,
  EnumSym,
  ExternFnSym,
  ExternTypeSym,
  FieldSym,
  ParamSym,
  StructSym,
  Sym
} from "../frontend/symbols.ts";
import { BUILTIN_FUNCTIONS } from "../frontend/expr.ts";
import { PRIMS, coreType, displayValueType, hex, lookupBuiltinType } from "../frontend/types.ts";
import type { Analysis } from "./analysis.ts";
import type { Node } from "./locate.ts";

const fence = (s: string) => "```yaffle\n" + s + "\n```";

export function paramDeclText(p: A.ParamDecl): string {
  return `${p.type ? printTypeRef(p.type) + " " : ""}${p.bound ? "$" : ""}${p.name.name}${p.arrays.map(printArraySuffix).join("")}${p.default ? ` = ${printExpr(p.default)}` : ""}`;
}

/** `@name(args)` with the argument values only. */
function attrText(a: A.Attribute): string {
  return a.args
    ? `@${a.name.name}(${a.args.map(x => printExpr(x.value)).join(", ")})`
    : `@${a.name.name}`;
}

function structSignature(s: StructSym): string {
  const d = s.decl;
  const tps = d.typeParams.length ? `<${d.typeParams.map(t => t.name).join(", ")}>` : "";
  const params = d.params ? `(${d.params.map(paramDeclText).join(", ")})` : "";
  const attrs = d.attrs.length ? " " + d.attrs.map(attrText).join(" ") : "";
  return `${s.exported ? "export " : ""}struct ${s.qualified}${tps}${params}${attrs}`;
}

export function signatureOf(sym: Sym, an: Analysis): string {
  switch (sym.kind) {
    case "struct":
      return structSignature(sym);
    case "enum": {
      const info = an.el.enumInfo(sym);
      const members = sym.members
        .map(m => `${m.name} = ${info.values.get(m.name) ?? "?"}`)
        .join(", ");
      return `enum ${sym.qualified} : ${info.storage}${info.endian === "inherit" ? "" : info.endian}${info.open ? " @open" : ""} { ${members} }`;
    }
    case "enumMember":
      return `${sym.owner.name}.${sym.name} = ${sym.value ?? "?"}`;
    case "union":
      return `union ${sym.qualified} { ${sym.decl.variants.map(printTypeRef).join("  ")} }`;
    case "alias": {
      const d = sym.decl;
      const params = d.params ? `(${d.params.map(paramDeclText).join(", ")})` : "";
      const tps = d.typeParams.length ? `<${d.typeParams.map(t => t.name).join(", ")}>` : "";
      const body = d.body ? ` = ${specText(d.body)}` : "";
      return `type ${sym.name}${tps}${params}${body}`;
    }
    case "externFn": {
      const d = sym.decl;
      return `extern fn ${sym.name}(${d.params.map(paramDeclText).join(", ")})${d.returns ? ` -> ${printTypeRef(d.returns)}${d.returnArrays.map(printArraySuffix).join("")}` : ""}`;
    }
    case "codec": {
      const d = sym.decl;
      return `extern ${d.async ? "async " : ""}codec ${sym.name}${d.params.length ? `(${d.params.map(paramDeclText).join(", ")})` : ""}${d.attrs.map(a => ` @${a.name.name}`).join("")}`;
    }
    case "externType": {
      const d = sym.decl;
      return `extern type ${sym.name}${d.params.length ? `(${d.params.map(paramDeclText).join(", ")})` : ""}${d.valueType ? ` : ${printTypeRef(d.valueType)}` : ""}${d.attrs.map(a => " " + attrText(a)).join("")}`;
    }
    case "const": {
      const d = sym.decl;
      const lit = an.el.constLiteral(sym);
      const v = lit
        ? printIrExpr({ kind: "literal", value: lit.value, type: lit.type })
        : d.value
          ? printExpr(d.value)
          : "?";
      return `${sym.exported ? "export " : ""}const ${d.type ? printTypeRef(d.type) + " " : ""}${sym.name}${d.arrays.map(printArraySuffix).join("")} = ${v}`;
    }
    case "field":
      return formatFieldHead(sym.decl);
    case "param":
      return paramDeclText(sym.decl);
    case "typeParam":
      return `${sym.name}  (type parameter of ${sym.owner.name})`;
    case "namespace":
      return `import * as ${sym.name} from ${JSON.stringify(sym.decl.source?.value ?? "")}`;
    case "builtinType":
      return sym.name;
    case "builtinFn":
      return BUILTIN_FUNCTIONS[sym.name]?.signature ?? sym.name;
    case "lambdaParam":
      return sym.detail
        ? `${sym.name}${sym.type ? ": " + displayValueType(sym.type, an.el.displayName) : ""}  (${sym.detail})`
        : `${sym.name}  (index of the padding byte)`;
  }
}

function specText(s: A.TypeSpec): string {
  let out = printTypeRef(s.type) + s.arrays.map(printArraySuffix).join("");
  if (s.clauses.asRead)
    out += ` as ${printExpr(s.clauses.asRead)}${s.clauses.asWrite ? ` = ${printExpr(s.clauses.asWrite)}` : ""}`;
  if (s.clauses.formula) out += ` = ${printExpr(s.clauses.formula)}`;
  for (const a of s.attrs) out += " " + attrText(a);
  return out;
}

export function builtinTypeDoc(name: string): string {
  const b = lookupBuiltinType(name);
  if (!b) return "";
  switch (b.kind) {
    case "prim": {
      const p = PRIMS[b.prim];
      const kind = p.float
        ? `IEEE ${p.bits}-bit float`
        : `${p.signed ? "signed" : "unsigned"} ${p.bits}-bit integer`;
      const end =
        p.bytes === 1
          ? ""
          : b.endian === "inherit"
            ? ", byte order from `$endian`"
            : b.endian === "le"
              ? ", little-endian"
              : ", big-endian";
      return `${kind} (${p.bytes} byte${p.bytes === 1 ? "" : "s"}${end})`;
    }
    case "bool":
      return "One byte: nonzero reads as true (strict: only 0 or 1), writes 0/1.";
    case "char":
      return b.unit === 1
        ? "UTF-8 code unit (`char name[n]` is a fixed-size string; `@encoding` changes the encoding)."
        : `UTF-${b.unit * 8} code unit (follows \`$endian\`).`;
    case "str":
      return b.unit === 1
        ? "NUL-terminated UTF-8 string (`char[until 0]`)."
        : `NUL-terminated UTF-${b.unit * 8} string (follows \`$endian\`).`;
    case "leb":
      return b.signed ? "Signed LEB128 varint (built in)." : "Unsigned LEB128 varint (built in).";
  }
}

// ── offsets and sizes ─────────────────────────────────────────────────────────

interface Off {
  n: number;
  terms: string[];
  note?: string;
}

function offText(o: Off): string {
  const parts = [...(o.n || !o.terms.length ? [hex(o.n)] : []), ...o.terms];
  return parts.join(" + ") + (o.note ? ` (${o.note})` : "");
}

/** Offsets of every field of a struct (static or symbolic), keyed by field name. */
function fieldOffsets(an: Analysis, r: StructResult): Map<string, string> {
  const out = new Map<string, string>();
  const el = an.el;
  const sizeTerm = (name: string, t: IrType): { n?: number; term?: string } => {
    const s = el.staticSize(t);
    if (s !== undefined) return { n: s };
    let core = t;
    while (core.kind === "transform") core = core.inner;
    if (core.kind === "array" && core.length.kind === "count" && !core.elementPlacement) {
      const es = el.staticSize(core.element);
      if (es !== undefined) return { term: `${printIrExpr(core.length.expr)} × ${hex(es)}` };
    }
    if (
      (core.kind === "bytes" || (core.kind === "string" && core.unit === 1)) &&
      core.length.kind === "count"
    )
      return { term: printIrExpr(core.length.expr) };
    if (core.kind === "string" && core.length.kind === "count")
      return { term: `${printIrExpr(core.length.expr)} × ${core.unit}` };
    return { term: `sizeof(${name})` };
  };
  const walk = (ms: IrMember[], off: Off): Off => {
    let cur: Off = { n: off.n, terms: [...off.terms], ...(off.note ? { note: off.note } : {}) };
    for (const m of ms) {
      switch (m.kind) {
        case "field": {
          if (m.placement) {
            out.set(m.name, `at ${printIrExpr(m.placement.offset)} (from the base)`);
            continue;
          }
          if (m.from) {
            out.set(m.name, "in a stream (takes no space here)");
            continue;
          }
          if (m.virtual) {
            out.set(m.name, "virtual (no bytes)");
            continue;
          }
          const layers = m.type.kind === "layered" ? m.type.layers : [];
          if (layers.some(l => l.kind === "align" || l.kind === "padBefore")) {
            const st = el.staticSize(m.type);
            const alignL = layers.find(l => l.kind === "align");
            const pre: Off =
              alignL && alignL.kind === "align"
                ? {
                    n: 0,
                    terms: [`align(${offText(cur)}, ${printIrExpr(alignL.to)})`],
                    ...(cur.note ? { note: cur.note } : {})
                  }
                : cur;
            out.set(m.name, offText(pre));
            cur =
              st !== undefined && !alignL
                ? { ...pre, n: pre.n + st }
                : { n: 0, terms: [`end of ${m.name}`], ...(cur.note ? { note: cur.note } : {}) };
            continue;
          }
          out.set(m.name, offText(cur));
          const s = sizeTerm(m.name, m.type);
          if (s.n !== undefined) cur = { ...cur, n: cur.n + s.n };
          else cur = { ...cur, terms: [...cur.terms, s.term!] };
          break;
        }
        case "bits":
          for (const f of m.fields) if (f.name) out.set(f.name, offText(cur));
          cur = { ...cur, n: cur.n + PRIMS[m.storage].bytes };
          break;
        case "block": {
          const note = m.condition ? `if ${printIrExpr(m.condition)}` : undefined;
          const inner = walk(m.members, { ...cur, ...(note ? { note } : {}) });
          if (m.else) walk(m.else, { ...cur, note: `else of ${printIrExpr(m.condition!)}` });
          const st = el.membersStaticSize([m]);
          if (st !== undefined) cur = { ...cur, n: cur.n + st };
          else if (!m.condition && !m.layers.length)
            cur = { ...inner, ...(cur.note ? { note: cur.note } : {}) };
          else cur = { n: 0, terms: [`end of the ${m.condition ? "if" : "block"}`] };
          break;
        }
        case "switch": {
          for (const c of m.cases)
            walk(c.members, {
              ...cur,
              note: `case ${c.values.map(v => printIrExpr({ kind: "literal", value: v, type: { kind: "bool" } })).join(", ")}`
            });
          if (m.default) walk(m.default, { ...cur, note: "default case" });
          const st = el.membersStaticSize([m]);
          cur =
            st !== undefined ? { ...cur, n: cur.n + st } : { n: 0, terms: ["end of the switch"] };
          break;
        }
      }
    }
    return cur;
  };
  walk(r.ir.members, { n: 0, terms: [] });
  return out;
}

function sizeText(an: Analysis, t: IrType): string {
  const s = an.el.staticSize(t);
  if (s !== undefined) return `${s < 10 ? s : hex(s)} byte${s === 1 ? "" : "s"}`;
  let core = t;
  while (core.kind === "transform" || core.kind === "layered") core = core.inner;
  if (core.kind === "array") {
    const es = an.el.staticSize(core.element);
    if (core.length.kind === "count")
      return es !== undefined
        ? `${printIrExpr(core.length.expr)} × ${hex(es)} bytes`
        : `${printIrExpr(core.length.expr)} elements of variable size`;
    if (core.length.kind === "until")
      return `elements until ${printIrExpr(core.length.terminator)} (terminator included)`;
    if (core.length.kind === "before")
      return `elements up to ${printIrExpr(core.length.terminator)} (the terminator is not consumed)`;
    if (core.length.kind === "untilPredicate")
      return `elements until one has ${printIrExpr(core.length.predicate)} (that one included)`;
    return "elements to the end of the region";
  }
  if (core.kind === "bytes") {
    if (core.length.kind === "count") return `${printIrExpr(core.length.expr)} bytes`;
    if (core.length.kind === "until") return `bytes until ${printIrExpr(core.length.terminator)}`;
    return "to the end of the region";
  }
  if (core.kind === "string") {
    if (core.length.kind === "count")
      return `${printIrExpr(core.length.expr)}${core.unit > 1 ? ` × ${core.unit}` : ""} bytes`;
    if (core.length.kind === "until") return "until the \\0 terminator";
    return "to the end of the region";
  }
  return "variable";
}

// ── fields ────────────────────────────────────────────────────────────────────

function primOf(t: IrType): { prim: string; endian: string; bytes: number } | undefined {
  const c = coreType(t);
  if (c.kind === "array") return primOf(c.element);
  if (c.kind === "prim") return { prim: c.prim, endian: c.endian, bytes: PRIMS[c.prim].bytes };
  if (c.kind === "pointer")
    return { prim: c.storage, endian: c.storageEndian, bytes: PRIMS[c.storage].bytes };
  if (c.kind === "string" && c.unit > 1)
    return { prim: `char${c.unit * 8}`, endian: c.endian, bytes: c.unit };
  if (c.kind === "enum") return { prim: "enum", endian: c.endian, bytes: 2 };
  return undefined;
}

/** How the field's byte order is decided. */
function endianText(f: FieldSym, fr: FieldResult, path: readonly Node[]): string | undefined {
  const p = primOf(fr.type);
  const bits = fr.bits;
  if (!p && !bits) return undefined;
  if (p && p.bytes === 1 && !bits) return undefined;
  if (bits && PRIMS[bits.storage as keyof typeof PRIMS].bytes === 1) return undefined;
  const endian = p?.endian ?? "inherit";
  if (endian === "le") return "little-endian (fixed)";
  if (endian === "be") return "big-endian (fixed)";
  // nearest endian layer: the field itself, enclosing blocks, the struct
  const own = f.decl.attrs.find(a => a.name.name === "endian");
  if (own) return `from its \`@endian(${own.args?.[0] ? printExpr(own.args[0].value) : ""})\``;
  for (let i = path.length - 1; i >= 0; i--) {
    const n = path[i]!;
    if (
      n.kind === "BlockMember" ||
      n.kind === "IfMember" ||
      n.kind === "SwitchMember" ||
      n.kind === "BitsMember"
    ) {
      const a = n.attrs.find(x => x.name.name === "endian");
      if (a)
        return `from \`@endian(${a.args?.[0] ? printExpr(a.args[0].value) : ""})\` on the enclosing block`;
    }
    if (n.kind === "StructDecl") {
      const a = n.attrs.find(x => x.name.name === "endian");
      if (a)
        return `from the struct's \`@endian(${a.args?.[0] ? printExpr(a.args[0].value) : ""})\``;
      break;
    }
  }
  return "inherits `$endian` from where the struct is used (little-endian at the root)";
}

function layersText(layers: IrLayer[]): string[] {
  const out: string[] = [];
  layers.forEach((l, i) => {
    let label: string;
    if (l.kind === "size") {
      const insideVia = layers.slice(i + 1).some(x => x.kind === "via");
      const outsideVia = layers.slice(0, i).some(x => x.kind === "via");
      label = insideVia ? "decoded size" : outsideVia ? "size on disk" : "size";
    } else if (l.kind === "via") label = "codec";
    else if (l.kind === "endian") label = "byte order";
    else label = "padding";
    out.push(`${i + 1}. \`${layerText(l)}\` — ${label}`);
  });
  return out;
}

function bitDiagram(fr: FieldResult, all: FieldResult[]): string {
  const b = fr.bits!;
  const cells: string[] = [];
  for (let bit = b.storageBits - 1; bit >= 0; bit--) {
    const owner = all.find(
      o =>
        o.bits &&
        o.bits.storage === b.storage &&
        sameUnit(o, fr) &&
        bit >= o.bits.shift &&
        bit < o.bits.shift + o.bits.width
    );
    cells.push(owner ? owner.sym.name.slice(0, 1) : "·");
  }
  const marks = [];
  for (let bit = b.storageBits - 1; bit >= 0; bit--)
    marks.push(bit >= b.shift && bit < b.shift + b.width ? "^" : " ");
  const header = [];
  for (let bit = b.storageBits - 1; bit >= 0; bit--) header.push(String(bit % 10));
  return (
    "```\n" + header.join("") + "\n" + cells.join("") + "\n" + marks.join("").trimEnd() + "\n```"
  );
}

function sameUnit(a: FieldResult, b: FieldResult): boolean {
  return !!a.bits && !!b.bits && a.bits.unit === b.bits.unit;
}

function fieldHover(an: Analysis, f: FieldSym, path: readonly Node[]): string {
  const r = an.structResult(f.owner);
  const fr = r?.fields.get(f);
  const lines: string[] = [fence(formatFieldHead(f.decl))];
  if (f.doc) lines.push(f.doc);
  if (!fr || !r) return lines.join("\n\n");
  const facts: string[] = [];
  facts.push(`**Type:** \`${displayValueType(fr.value, an.el.displayName)}\``);
  const offs = fieldOffsets(an, r);
  const off = offs.get(f.name);
  if (off) facts.push(`**Offset:** ${off}`);
  if (fr.bits)
    facts.push(
      `**Bits:** ${fr.bits.shift}–${fr.bits.shift + fr.bits.width - 1} of the ${fr.bits.storage} unit (mask ${hex(((1n << BigInt(fr.bits.width)) - 1n) << BigInt(fr.bits.shift))})`
    );
  else if ("virtual" in fr.ir && fr.ir.virtual) facts.push("**Size:** none (virtual)");
  else facts.push(`**Size:** ${sizeText(an, fr.type)}`);
  const end = endianText(f, fr, path);
  if (end) facts.push(`**Byte order:** ${end}`);
  lines.push(facts.join("  \n"));
  if (fr.bits) {
    const all = [...r.fields.values()].filter(
      x =>
        x.bits && x.bits.storage === fr.bits!.storage && x.bits.storageBits === fr.bits!.storageBits
    );
    lines.push(bitDiagram(fr, all));
  }
  const layers = fr.type.kind === "layered" ? fr.type.layers : [];
  if (layers.length) lines.push("**Layers** (innermost first):\n" + layersText(layers).join("\n"));
  let t = fr.type;
  while (t.kind === "layered") t = t.inner;
  if (t.kind === "transform") {
    lines.push(
      `**Transform:** reads \`${printIrExpr(t.read)}\`${t.write ? `, writes \`${printIrExpr(t.write)}\`${t.writeInferred ? " (inverse worked out by the compiler)" : ""}` : " (one-way: read-only in views)"}`
    );
  }
  const ir = fr.ir;
  if ("virtual" in ir && ir.virtual) {
    // the parts are derived from the value on write
    const parts = [...r.fields.values()].filter(
      p => p.deriveSource === `part of the virtual field ${f.name}` && p.ir.derive
    );
    lines.push(
      `**Virtual:** no bytes. Read as \`${printIrExpr(ir.virtual.read)}\`; on write ${
        parts.length
          ? "its parts are derived from it: " +
            parts.map(p => `\`${p.sym.name} = ${printIrExpr(p.ir.derive!)}\``).join(", ")
          : "its parts are derived from it"
      }.`
    );
  }
  if ("carrier" in ir && ir.carrier === "slices")
    lines.push(
      `**Assembled on write** from the fields read from its slices (${fr.deriveSource?.replace(/^assembled from its slices \(|\)$/g, "") ?? "its slices"}), zeros elsewhere. Not in the input type.`
    );
  if (ir.derive) {
    const how =
      ir.deriveKind === "auto"
        ? `derived from the ${fr.deriveSource ?? "read side"}`
        : ir.deriveKind === "constant"
          ? "a constant (checked on read)"
          : ir.input === "required"
            ? "normalized on write"
            : ir.input === "optional"
              ? "the default"
              : "a computed field";
    const input =
      ir.input === "absent"
        ? "Not in the input type: the writer computes it."
        : ir.input === "optional"
          ? "Optional in the input: used when given (byte-exact rebuilds), computed otherwise."
          : "Still in the input type.";
    lines.push(
      `**Written as:** \`${f.name} = ${printIrExpr(ir.derive, { itName: f.name })}\` — ${how}. ${input}`
    );
  }
  if (ir.checks.length)
    lines.push("**Checks:** " + ir.checks.map(c => `\`${c.message}\``).join(", "));
  if (f.bound)
    lines.push(`**Binds** \`$${f.name}\` for the fields after it and everything nested in them.`);
  if ("hidden" in ir && ir.hidden) lines.push("**@hidden:** not in the input or output types.");
  return lines.join("\n\n");
}

function structHover(an: Analysis, s: StructSym): string {
  const lines = [fence(structSignature(s))];
  if (s.doc) lines.push(s.doc);
  const r = an.structResult(s);
  const facts: string[] = [];
  if (r && !s.typeParams.length) {
    const size = an.el.staticSize({ kind: "struct", struct: r.id, args: [] });
    if (size !== undefined) facts.push(`**Size:** ${size < 10 ? size : hex(size)} bytes`);
    else facts.push("**Size:** variable");
  }
  const needs = an.el.model.needs.get(s);
  if (needs?.length)
    facts.push(
      `**Needs:** ${needs.map(n => `\`$${n.name}\` (${displayValueType(n.type, an.el.displayName)})`).join(", ")} from the structs that use it`
    );
  if (r?.ir.base) facts.push("**@base:** offsets inside count from its first byte");
  if (r?.ir.async) facts.push("**async:** reaches an async codec (parseAsync only)");
  if (s.exported)
    facts.push(
      s.typeParams.length
        ? ""
        : "**Export root:** gets parse / serialize / view / toJson / fromJson"
    );
  if (facts.filter(Boolean).length) lines.push(facts.filter(Boolean).join("  \n"));
  return lines.join("\n\n");
}

export function boundHover(an: Analysis, name: string, inStruct: StructSym | undefined): string {
  const builtin: Record<string, string> = {
    endian:
      "Byte order in effect here (`le` or `be`). Inherited from where the struct is used; little-endian at the root. Set with `@endian(…)`.",
    offset: "Current position, from the nearest `@base`.",
    end: "End of the enclosing region (from the nearest `@base`): the file, an `@size` window or a codec's decoded output.",
    index: "Index of the element being read in the enclosing array."
  };
  if (builtin[name]) return fence(`$${name}`) + "\n\n" + builtin[name];
  const sites = an.el.model.bindingSites.get(name) ?? [];
  const t = an.el.boundType(name);
  const lines = [fence(`$${name}${t ? ": " + displayValueType(t, an.el.displayName) : ""}`)];
  if (inStruct) {
    const local =
      inStruct.fields.find(f => f.bound && f.name === name) ??
      inStruct.params.find(p => p.bound && p.name === name);
    if (local)
      lines.push(
        `Bound in this struct by ${local.kind === "field" ? "field" : "parameter"} \`${name}\`.`
      );
    else if (sites.length)
      lines.push("Provided by the structs that use this one (nearest binding wins).");
  }
  if (sites.length) {
    lines.push(
      "**Bound by:**\n" +
        sites
          .map(
            s =>
              `- \`${ownerName(s)}.${s.name}\`${s.kind === "param" ? " (parameter)" : ""}${s.valueType ? ` — ${displayValueType(s.valueType, an.el.displayName)}` : ""}`
          )
          .join("\n")
    );
  } else lines.push("Nothing binds this value.");
  return lines.join("\n\n");
}

function ownerName(s: FieldSym | ParamSym): string {
  return s.owner.name;
}

const KEYWORD_DOCS: Record<string, [string, string]> = {
  struct: ["struct Name(params) @attrs { … }", "A record of fields read and written in order."],
  enum: ["enum Name : storage { A = 1, … }", "Named values of an integer storage type."],
  union: ["union Name { A  B }", "Tries each variant in order; the first that reads wins."],
  type: ["type Name(params) = T …", "A type alias, with optional parameters."],
  const: ["const T NAME = value", "A named compile-time value."],
  extern: [
    "extern fn / codec / type",
    "Implemented by the host: functions, codecs (`@via`) or custom primitives."
  ],
  codec: ["extern codec name(params)", "A codec used with `@via(name(…))`."],
  fn: ["extern fn name(params) -> T", "A host function callable in expressions."],
  import: ['import { A, B as C } from "./file.yfl"', "Brings declarations of another file in."],
  export: ["export …", "Visible to importers; exported structs become roots of the generated API."],
  from: ["T x from stream", 'Parses the field from a stream (in imports: `from "./file.yfl"`).'],
  at: ["T x at offset", "Places the field at an offset from the nearest `@base`."],
  as: ["T x as read = write", "A transform: `it` is the raw value, and `= write` is its inverse."],
  where: ["T x where condition", "A check on the value (`it`) after reading."],
  in: ["T x in (a, b, lo..hi) / in /regex/", "The value must be one of these."],
  until: [
    "T x[until value]",
    "Repeats until an element equals the value (consumed, not in the result) or a condition on `it` holds."
  ],
  before: ["T x[before value]", "Repeats until the next element would equal the value."],
  layout: [
    "layout { path @attrs, … }",
    "Where this struct's pointer targets go on write, and in which order."
  ],
  bits: ["bits storage { T name : width … }", "Bit fields packed into one storage integer."],
  if: ["if (condition) { … } else { … }", "Fields present only when the condition holds."],
  else: ["if (condition) { … } else { … }", "Fields present when the condition doesn't hold."],
  switch: ["switch (value) { case …: … }", "Fields chosen by a value."],
  case: ["case value, …: members", "The members read when the switch value matches."],
  default: ["default: members", "The members read when no case matches."],
  this: ["this", "In `layout`: the struct's own inline bytes. In arguments: the current struct."],
  virtual: [
    "virtual u40 size = (sizeHigh << 32) | sizeLow",
    "A field with no bytes: read as the formula over earlier fields. On write it is inverted: its value is an input and its parts are derived (invertible forms: bit concatenation `(a << k) | b`, `a * K + b`, linear forms)."
  ],
  null: [
    "x == null  /  x != null",
    "Compares a `@nullable` pointer with null, e.g. `indicesWhere(records, r => r.model != null)`."
  ]
};

/** Named arguments and words inside attributes. */
const ATTR_ARG_DOCS: Record<string, [string, string]> = {
  from: [
    "@align(n, from: file | base)",
    "Where the alignment is measured from: `base` (the nearest @base, the default) or `file` (the start of the file, of a codec's decoded region, or of a stream)."
  ],
  offset: [
    "@align(n, offset: k)",
    "Aligns the position k bytes ahead: pad until (position + k) % n == 0. `@align(4, offset: 0x19)` makes a 0x19-byte block end on a multiple of 4."
  ],
  strict: [
    "@padUntil(n, strict)",
    "Checks this padding's fill on read (a mismatch is a CHECK error), without `@strict` on the whole field or block."
  ],
  file: [
    "from: file",
    "Alignment measured from the start of the file (or decoded region, or stream)."
  ],
  base: ["from: base", "Alignment measured from the nearest @base (the default)."]
};

/** Hover for a named argument or word inside an attribute (`from:`, `offset:`, `strict`). */
export function attributeArgHover(attr: string, word: string): string | undefined {
  const spec = ATTRIBUTES[attr];
  if (!spec) return undefined;
  const isNamed = spec.named?.some(n => n.name === word || n.words?.includes(word));
  if ((word === "strict" && spec.strictWord) || isNamed) {
    const doc = ATTR_ARG_DOCS[word];
    if (doc) return fence(doc[0]) + "\n\n" + doc[1];
  }
  return undefined;
}

/** Hover for a keyword. */
export function keywordHover(word: string): string | undefined {
  const doc = KEYWORD_DOCS[word];
  return doc ? fence(doc[0]) + "\n\n" + doc[1] : undefined;
}

export function attributeHover(name: string): string | undefined {
  const spec = ATTRIBUTES[name];
  if (!spec) return undefined;
  return fence(attributeSignature(spec)) + "\n\n" + spec.doc;
}

export function symbolHover(an: Analysis, sym: Sym, path: readonly Node[]): string {
  switch (sym.kind) {
    case "field":
      return fieldHover(an, sym, path);
    case "struct":
      return structHover(an, sym);
    case "builtinType":
      return fence(sym.name) + "\n\n" + builtinTypeDoc(sym.name);
    case "builtinFn":
      return (
        fence(BUILTIN_FUNCTIONS[sym.name]?.signature ?? sym.name) +
        "\n\n" +
        (BUILTIN_FUNCTIONS[sym.name]?.doc ?? "")
      );
    case "param": {
      const lines = [
        fence(signatureOf(sym, an)),
        `Parameter of \`${sym.owner.name}\`${sym.valueType ? `: ${displayValueType(sym.valueType, an.el.displayName)}` : ""}.`
      ];
      if (sym.bound)
        lines.push(
          `Bound parameter: also available as \`$${sym.name}\` to everything nested. If a use site doesn't pass it, it comes from the enclosing binding.`
        );
      return lines.join("\n\n");
    }
    case "alias": {
      const lines = [fence(signatureOf(sym, an))];
      if (sym.doc) lines.push(sym.doc);
      return lines.join("\n\n");
    }
    case "enum":
    case "enumMember":
    case "union":
    case "externFn":
    case "externType":
    case "const":
    case "typeParam":
    case "namespace":
    case "lambdaParam": {
      const lines = [fence(signatureOf(sym, an))];
      if ("doc" in sym && sym.doc) lines.push(sym.doc);
      if (sym.kind === "externType") {
        const sig = an.el.externTypeSignature(sym as ExternTypeSym);
        lines.push(
          `Host-implemented primitive: \`{ size(bytes, …args), read(bytes, …args), write(value, …args) }\`${sig.fixedSize !== undefined ? `, fixed size ${sig.fixedSize}` : ""}.`
        );
      }
      if (sym.kind === "externFn")
        lines.push(
          `Implemented per target (yaffle.json \`targets.<lang>.externs.${(sym as ExternFnSym).name}\`).`
        );
      if (sym.kind === "enum") {
        const info = an.el.enumInfo(sym as EnumSym);
        lines.push(
          info.open
            ? "`@open`: unknown values pass through as numbers."
            : "Unknown values are a CHECK error (add `@open` to pass them through)."
        );
      }
      return lines.join("\n\n");
    }
    case "codec": {
      const c = sym as CodecSym;
      const lines = [fence(signatureOf(sym, an))];
      if (c.doc) lines.push(c.doc);
      const facts = [
        c.decl.async ? "**async:** the host returns a Promise; schemas using it are async" : "",
        c.decl.attrs.some(a => a.name.name === "ranged")
          ? "**@ranged:** lazy views decode only what they read"
          : "",
        c.decl.attrs.some(a => a.name.name === "streaming")
          ? "**@streaming:** finds its own end"
          : "Needs its on-disk size (`@size` after `@via`)"
      ].filter(Boolean);
      lines.push(facts.join("  \n"));
      return lines.join("\n\n");
    }
  }
}
