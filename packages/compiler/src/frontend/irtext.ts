/**
 * A compact, readable text rendering of an IR program (`yaffle ir --text`, golden tests).
 * Lossy on purpose: source ranges are omitted.
 */
import type {
  IrExpr,
  IrFill,
  IrLayer,
  IrLayoutItem,
  IrLength,
  IrMember,
  IrProgram,
  IrStreamExpr,
  IrStruct,
  IrType,
  IrValueType
} from "../ir/index.ts";
import { printIrExpr } from "./printer.ts";
import { displayValueType } from "./types.ts";

export function irToText(p: IrProgram): string {
  const out: string[] = [];
  for (const m of p.modules) out.push(`module ${m.path} (${m.name})`);
  for (const c of p.consts)
    out.push(
      `const ${c.name}: ${vt(c.type)} = ${printIrExpr({ kind: "literal", value: c.value, type: c.type })}  [${c.module}]`
    );
  for (const e of p.enums) {
    out.push(
      `enum ${e.id} (${e.name}) : ${e.storage}${e.open ? " open" : ""} { ${e.members.map(m => `${m.name} = ${m.value}`).join(", ")} }`
    );
  }
  for (const x of p.externs) {
    const params = `(${x.params.map(q => `${vt(q.type)} ${q.name}`).join(", ")})`;
    if (x.kind === "fn") out.push(`extern fn ${x.id}${params} -> ${vt(x.returns)}`);
    else if (x.kind === "codec")
      out.push(
        `extern${x.async ? " async" : ""} codec ${x.id}${params}${x.ranged ? " ranged" : ""}${x.streaming ? " streaming" : ""}`
      );
    else
      out.push(
        `extern type ${x.id}${params} : ${vt(x.valueType)}${x.fixedSize !== undefined ? ` size ${x.fixedSize}` : ""}${x.builtin ? " builtin" : ""}`
      );
  }
  for (const r of p.roots) out.push(`root ${r.name} = ${r.struct}`);
  for (const s of p.structs) out.push(structText(s));
  return out.join("\n") + "\n";
}

function vt(t: IrValueType): string {
  return displayValueType(t);
}

function ex(e: IrExpr): string {
  return printIrExpr(e);
}

function len(l: IrLength): string {
  if (l.kind === "count") return `[${ex(l.expr)}]`;
  if (l.kind === "until") return `[until ${ex(l.terminator)}]`;
  if (l.kind === "before") return `[before ${ex(l.terminator)}]`;
  if (l.kind === "untilPredicate") return `[until ${ex(l.predicate)} (inclusive)]`;
  return "[]";
}

function fill(f: IrFill): string {
  return f.kind === "byte" ? (f.value ? `, ${f.value}` : "") : `, ${f.param} => ${ex(f.expr)}`;
}

/** `, strict`, `, from: file`, `, offset: n`. */
function extras(l: IrLayer): string {
  let out = "";
  if ((l.kind === "align" || l.kind === "alignEnd") && l.from) out += `, from: ${l.from}`;
  if ((l.kind === "align" || l.kind === "alignEnd") && l.offset) out += `, offset: ${ex(l.offset)}`;
  if ("strict" in l && l.strict) out += ", strict";
  return out;
}

export function layerText(l: IrLayer): string {
  switch (l.kind) {
    case "size":
      return `@size(${ex(l.size)})`;
    case "via":
      return `@via(${l.codec}${l.args.length ? `(${l.args.map(ex).join(", ")})` : ""})`;
    case "align":
      return `@align(${ex(l.to)}${fill(l.fill)}${extras(l)})`;
    case "padBefore":
      return `@padBefore(${ex(l.count)}${fill(l.fill)}${extras(l)})`;
    case "padAfter":
      return `@padAfter(${ex(l.count)}${fill(l.fill)}${extras(l)})`;
    case "padUntil":
      return `@padUntil(${ex(l.size)}${fill(l.fill)}${extras(l)})`;
    case "alignEnd":
      return `@alignEnd(${ex(l.to)}${fill(l.fill)}${extras(l)})`;
    case "endian":
      return `@endian(${ex(l.value)})`;
    case "strict":
      return "@strict";
  }
}

function typeText(t: IrType): string {
  switch (t.kind) {
    case "prim":
      return t.prim + (t.endian === "inherit" ? "" : t.endian);
    case "bool":
      return "bool";
    case "string":
      return `string<${t.encoding}${t.unit > 1 && t.endian !== "inherit" ? " " + t.endian : ""}>${len(t.length)}`;
    case "bytes":
      return `bytes${len(t.length)}`;
    case "array":
      return `${typeText(t.element)}${len(t.length)}${t.elementPlacement ? ` at(${ex(t.elementPlacement)})` : ""}`;
    case "struct":
      return `${t.struct}(${t.args.map(ex).join(", ")})`;
    case "enum":
      return `enum ${t.enum}${t.endian === "inherit" ? "" : " " + t.endian}`;
    case "pointer":
      return `*${typeText(t.target)} : ${t.storage}${t.storageEndian === "inherit" ? "" : t.storageEndian}${t.relative ? " relative" : ""}${t.nullValue !== undefined ? ` nullable(${t.nullValue})` : ""}${t.emptyIsNull ? " emptyIsNull" : ""}${t.ownership === "ref" ? " ref" : ""}${t.origin ? ` origin(${ex(t.origin)})` : ""}`;
    case "extern":
      return `extern ${t.extern}(${t.args.map(ex).join(", ")})`;
    case "union":
      return `union { ${t.variants.map(v => `${v.name}: ${typeText(v.type)}`).join(" | ")} }`;
    case "transform":
      return `(${typeText(t.inner)} as ${ex(t.read)}${t.write ? ` = ${ex(t.write)}${t.writeInferred ? " (inferred)" : ""}` : ""}: ${vt(t.valueType)})`;
    case "layered":
      return `${typeText(t.inner)} ${t.layers.map(layerText).join(" ")}`;
  }
}

function membersText(ms: IrMember[], indent: string, out: string[]): void {
  for (const m of ms) {
    switch (m.kind) {
      case "field": {
        const parts = [`${indent}${m.name}: ${typeText(m.type)}`];
        if (m.placement) {
          parts.push(
            `at ${ex(m.placement.offset)}${m.placement.fixed ? " fixed" : ""}${m.placement.emptyIsNull ? " emptyIsNull" : ""}${m.placement.constraint ? ` (≡ ${m.placement.constraint.remainder} mod ${m.placement.constraint.modulus})` : ""}`
          );
        }
        if (m.from)
          parts.push(
            `from ${streamText(m.from.stream)}${m.from.split ? ` split ${m.from.split.policy}` : ""}`
          );
        if (m.virtual) parts.push(`virtual ${ex(m.virtual.read)}`);
        if (m.derive) parts.push(`= ${ex(m.derive)} [${m.deriveKind}]`);
        if (m.input !== "required") parts.push(`input ${m.input}`);
        if (m.carrier) parts.push(`carrier ${m.carrier}`);
        if (m.hidden) parts.push("hidden");
        if (m.bind) parts.push(`bind $${m.bind}`);
        if (m.literals)
          parts.push(
            `literals ${m.literals.map(l => printIrExpr({ kind: "literal", value: l, type: { kind: "bool" } })).join(" | ")}`
          );
        out.push(parts.join("  "));
        for (const c of m.checks)
          out.push(
            `${indent}  check ${ex(c.expr)}  "${c.message}"${c.strictOnly ? " strict" : ""}`
          );
        break;
      }
      case "bits":
        out.push(
          `${indent}bits ${m.storage}${m.endian === "inherit" ? "" : m.endian} ${m.bitOrder} {`
        );
        for (const f of m.fields) {
          const parts = [`${indent}  ${f.name ?? "_"}: ${typeText(f.type)} @${f.shift}:${f.width}`];
          if (f.derive) parts.push(`= ${ex(f.derive)} [${f.deriveKind}]`);
          if (f.input !== "required") parts.push(`input ${f.input}`);
          out.push(parts.join("  "));
          for (const c of f.checks) out.push(`${indent}    check ${ex(c.expr)}  "${c.message}"`);
        }
        out.push(`${indent}}`);
        break;
      case "block":
        out.push(
          `${indent}${m.condition ? `if (${ex(m.condition)})` : "block"}${m.layers.length ? " " + m.layers.map(layerText).join(" ") : ""} {`
        );
        membersText(m.members, indent + "  ", out);
        if (m.else) {
          out.push(`${indent}} else {`);
          membersText(m.else, indent + "  ", out);
        }
        out.push(`${indent}}`);
        break;
      case "switch":
        out.push(
          `${indent}switch (${ex(m.discriminant)})${m.discriminantField ? ` on ${m.discriminantField}` : ""} {`
        );
        for (const c of m.cases) {
          out.push(
            `${indent}  case ${c.values.map(v => printIrExpr({ kind: "literal", value: v, type: { kind: "bool" } })).join(", ")}:`
          );
          membersText(c.members, indent + "    ", out);
        }
        if (m.default) {
          out.push(`${indent}  default:`);
          membersText(m.default, indent + "    ", out);
        }
        out.push(`${indent}}`);
        break;
    }
  }
}

function streamText(s: IrStreamExpr): string {
  if (s.kind === "field") return s.field;
  if (s.kind === "each") return `${s.array}[*].${s.field}`;
  return `${streamText(s.stream)}[${ex(s.start)}..${s.end ? ex(s.end) : ""}]`;
}

function structText(s: IrStruct): string {
  const out: string[] = [];
  const params = s.params
    .map(
      p =>
        `${p.origin === "explicit" ? "" : p.origin + " "}${p.name}: ${vt(p.type)}${p.boundName && p.boundName !== p.name ? ` ($${p.boundName})` : ""}${p.default ? ` = ${ex(p.default)}` : ""}`
    )
    .join(", ");
  const flags = [
    s.base && "base",
    s.strict && "strict",
    s.async && "async",
    s.usesEndian && "usesEndian"
  ]
    .filter(Boolean)
    .join(" ");
  out.push(
    `struct ${s.id} [${s.name}] (${params})${s.layers.length ? " " + s.layers.map(layerText).join(" ") : ""}${flags ? "  {" + flags + "}" : ""}`
  );
  membersText(s.members, "  ", out);
  if (s.layout) {
    out.push("  layout {");
    const items = (list: IrLayoutItem[], indent: string) => {
      for (const i of list) {
        const path =
          i.path === "this"
            ? "this"
            : i.path
                .map((seg, k) => (seg.kind === "each" ? "[*]" : (k ? "." : "") + seg.name))
                .join("");
        const head = `${indent}${path}${i.group ? "[*]" : ""}${i.layers.length ? " " + i.layers.map(layerText).join(" ") : ""}`;
        if (!i.group) {
          out.push(head);
          continue;
        }
        out.push(`${head} {`);
        items(i.group.items, indent + "  ");
        out.push(`${indent}}`);
      }
    };
    items(s.layout, "    ");
    out.push("  }");
  }
  return out.join("\n");
}
