/**
 * Static analyses for views: which fields views read lazily (composite fields become view
 * values), which fields are structural (later read-side expressions depend on them), which
 * fields derives depend on, and whether in-place edits of inline children are safe.
 */
import type { IrExpr, IrField, IrStruct, IrType } from "../../ir/index.ts";
import {
  addFieldRefs,
  exprHas,
  forEachDerive,
  forEachMember,
  forEachOrigin,
  forEachReadExpr,
  layoutExprs,
  unlayer
} from "./analysis.ts";
import type { Model } from "./model.ts";

/**
 * Fields read-side expressions, origins or checks need as plain values. Stream sources are not
 * among them: a `from` stream reads its source's view value (lazy bytes, a codec region, the
 * element nodes of `arr[*].field`), so pieces are decoded only when the stream is read.
 */
export function neededFields(s: IrStruct): Set<string> {
  const out = new Set<string>();
  const add = (e: IrExpr): void => addFieldRefs(e, out);
  forEachReadExpr(s, add);
  forEachOrigin(s, add);
  forEachMember(s.members, m => {
    if (m.kind === "field" && m.checks.length) out.add(m.name);
  });
  return out;
}

/** True if a field's type is read lazily by views (when nothing needs it as a plain value). */
export function lazyType(t: IrType): boolean {
  switch (t.kind) {
    case "layered":
      return t.layers.some(l => l.kind === "via") || lazyType(t.inner);
    case "struct":
    case "pointer":
      return true;
    case "array":
      // Terminated elements need values to find their end: read eagerly. Placed struct
      // elements become child nodes at their offsets.
      if (t.length.kind !== "count" && t.length.kind !== "rest") return false;
      return !t.elementPlacement || unlayer(t.element).kind === "struct";
    case "bytes":
      return t.length.kind !== "until";
    default:
      return false;
  }
}

/**
 * Fields views expose as view values (lazy), by name. Stream sources and stream pieces are view
 * values even when hidden (streams read them lazily).
 */
export function viewFields(s: IrStruct, model: Model): Set<string> {
  const needed = neededFields(s);
  const streamy = new Set<string>();
  for (const k of model.streamPieces) {
    if (k.startsWith(`${s.id}.`)) streamy.add(k.slice(s.id.length + 1));
  }
  forEachMember(s.members, m => {
    if (m.kind !== "field") return;
    let st = m.from?.stream;
    while (st?.kind === "slice") st = st.stream;
    if (st?.kind === "field") streamy.add(st.field);
    if (st?.kind === "each") streamy.add(st.array);
  });
  const isView = (f: IrField): boolean => {
    if (needed.has(f.name)) return false;
    if (!f.output && !streamy.has(f.name)) return false;
    return !!f.placement || !!f.from || lazyType(f.type);
  };
  const out = new Set<string>();
  forEachMember(s.members, m => {
    if (m.kind === "field" && isView(m)) out.add(m.name);
  });
  return out;
}

/** Fields referenced by read-side expressions other than their own checks. */
export function structuralFields(s: IrStruct): Set<string> {
  const out = new Set<string>();
  const own = new Map<string, readonly IrExpr[]>();
  forEachMember(s.members, m => {
    if (m.kind === "field")
      own.set(
        m.name,
        m.checks.map(c => c.expr)
      );
  });
  const allOwn = new Set([...own.values()].flat());
  forEachReadExpr(s, e => {
    if (!allOwn.has(e)) addFieldRefs(e, out);
  });
  for (const [name, checks] of own) {
    for (const e of checks) {
      const refs = new Set<string>();
      addFieldRefs(e, refs);
      for (const r of refs) if (r !== name) out.add(r);
    }
  }
  return out;
}

/**
 * Fields a layout item layer reads: editing one can change the layout, so it is validated when
 * set but never patched in place (the commit re-lays out).
 */
export function layoutReads(s: IrStruct): Set<string> {
  const out = new Set<string>();
  for (const e of layoutExprs(s.layout)) addFieldRefs(e, out);
  return out;
}

/** Fields that some derive expression references. */
export function derivedFrom(s: IrStruct): Set<string> {
  const out = new Set<string>();
  forEachDerive(s, e => addFieldRefs(e, out));
  return out;
}

/** No derive depends on the content of inline children (checksums, member access, externs). */
export function childSafe(s: IrStruct): boolean {
  let safe = true;
  forEachDerive(s, e => {
    const unsafe = exprHas(
      e,
      x =>
        x.kind === "member" ||
        x.kind === "index" ||
        x.kind === "map" ||
        (x.kind === "call" &&
          (x.callee.kind === "extern" ||
            ["bytesof", "encode", "crc32", "adler32"].includes(x.callee.name)))
    );
    if (unsafe) safe = false;
  });
  return safe;
}

/** The struct a view getter wraps plain values with (struct fields, arrays of structs, targets). */
export function elemStruct(t: IrType): string | undefined {
  const u = unlayer(t);
  switch (u.kind) {
    case "struct":
      return u.struct;
    case "array": {
      let e = unlayer(u.element);
      if (e.kind === "pointer") e = unlayer(e.target);
      return e.kind === "struct" ? e.struct : undefined;
    }
    case "pointer":
      return elemStruct(u.target);
    default:
      return undefined;
  }
}
