/** IR queries the C++ emitters share: walks over members, expressions and types, and field sets. */
import type {
  IrBits,
  IrExpr,
  IrLayer,
  IrLayoutItem,
  IrMember,
  IrStreamExpr,
  IrStruct,
  IrType,
  IrValueType
} from "../../ir/index.ts";
import type { Model } from "./model.ts";

// ── walks ───────────────────────────────────────────────────────────────────

/** Calls `f` for every member in pre-order, descending into blocks and switch cases. */
export function forEachMember(ms: readonly IrMember[], f: (m: IrMember) => void): void {
  someMember(ms, m => {
    f(m);
    return false;
  });
}

/** True if `pred` holds for a member (pre-order, stopping at the first match). */
export function someMember(ms: readonly IrMember[], pred: (m: IrMember) => boolean): boolean {
  for (const m of ms) {
    if (pred(m)) return true;
    if (m.kind === "block") {
      if (someMember(m.members, pred) || (m.else !== undefined && someMember(m.else, pred)))
        return true;
    } else if (m.kind === "switch") {
      if (m.cases.some(c => someMember(c.members, pred))) return true;
      if (m.default && someMember(m.default, pred)) return true;
    }
  }
  return false;
}

/** Calls `f` for every derive expression of the members. */
function forEachDerive(ms: readonly IrMember[], f: (e: IrExpr) => void): void {
  forEachMember(ms, m => {
    if (m.kind === "field" && m.derive) f(m.derive);
    else if (m.kind === "bits") for (const b of m.fields) if (b.derive) f(b.derive);
  });
}

/** Calls `f` for every sub-expression. */
export function walkExpr(e: IrExpr, f: (e: IrExpr) => void): void {
  f(e);
  switch (e.kind) {
    case "member":
      walkExpr(e.object, f);
      break;
    case "index":
      walkExpr(e.object, f);
      walkExpr(e.index, f);
      break;
    case "map":
      walkExpr(e.array, f);
      break;
    case "unary":
      walkExpr(e.operand, f);
      break;
    case "binary":
      walkExpr(e.left, f);
      walkExpr(e.right, f);
      break;
    case "cond":
      walkExpr(e.test, f);
      walkExpr(e.then, f);
      walkExpr(e.else, f);
      break;
    case "call":
      for (const a of e.args) walkExpr(a, f);
      break;
    case "in":
      walkExpr(e.value, f);
      for (const it of e.items) {
        if (it.kind === "value") walkExpr(it.value, f);
        else {
          walkExpr(it.low, f);
          walkExpr(it.high, f);
        }
      }
      break;
    case "regex":
      walkExpr(e.value, f);
      break;
    case "convert":
      walkExpr(e.operand, f);
      break;
    case "lambda":
      walkExpr(e.body, f);
      break;
  }
}

/** True if some sub-expression satisfies `pred`. */
export function exprUses(e: IrExpr, pred: (e: IrExpr) => boolean): boolean {
  let found = false;
  walkExpr(e, x => {
    if (!found && pred(x)) found = true;
  });
  return found;
}

/** Field names an expression references. */
function addFieldRefs(e: IrExpr, out: Set<string>): void {
  walkExpr(e, x => {
    if (x.kind === "field") out.add(x.name);
  });
}

export function usesIt(e: IrExpr): boolean {
  return exprUses(e, x => x.kind === "it");
}

/** `$offset` or `$end` (positions; `$index` is not one). */
export function usesPosition(e: IrExpr): boolean {
  return exprUses(e, x => x.kind === "builtinValue" && x.name !== "index");
}

/** Calls `f` for every read-side expression of a type (lengths, arguments, transforms, layers). */
function forEachTypeReadExpr(t: IrType, f: (e: IrExpr) => void): void {
  switch (t.kind) {
    case "string":
    case "bytes":
    case "array":
      if (t.length.kind === "count") f(t.length.expr);
      if (t.length.kind === "until" || t.length.kind === "before") f(t.length.terminator);
      if (t.length.kind === "untilPredicate") f(t.length.predicate);
      if (t.kind === "array") {
        if (t.elementPlacement) f(t.elementPlacement);
        forEachTypeReadExpr(t.element, f);
      }
      break;
    case "struct":
    case "extern":
      t.args.forEach(a => f(a));
      break;
    case "pointer":
      forEachTypeReadExpr(t.target, f);
      break;
    case "union":
      t.variants.forEach(v => forEachTypeReadExpr(v.type, f));
      break;
    case "transform":
      f(t.read);
      forEachTypeReadExpr(t.inner, f);
      break;
    case "layered":
      forEachLayerExpr(t.layers, f);
      forEachTypeReadExpr(t.inner, f);
      break;
  }
}

function forEachLayerExpr(ls: readonly IrLayer[], f: (e: IrExpr) => void): void {
  for (const l of ls) {
    if (l.kind === "size") f(l.size);
    else if (l.kind === "via") l.args.forEach(a => f(a));
    else if (l.kind === "align" || l.kind === "alignEnd") {
      f(l.to);
      if (l.offset) f(l.offset);
    } else if (l.kind === "padBefore" || l.kind === "padAfter") f(l.count);
    else if (l.kind === "padUntil") f(l.size);
    else if (l.kind === "endian") f(l.value);
    if ("fill" in l && l.fill.kind === "fn") f(l.fill.expr);
  }
}

/** Calls `f` for every read-side expression of a struct (everything but derives). */
function forEachReadExpr(s: IrStruct, f: (e: IrExpr) => void): void {
  forEachMember(s.members, m => {
    if (m.kind === "field") {
      if (m.virtual) f(m.virtual.read);
      else forEachTypeReadExpr(m.type, f);
      if (m.placement) f(m.placement.offset);
      for (
        let st: IrStreamExpr | undefined = m.from?.stream;
        st?.kind === "slice";
        st = st.stream
      ) {
        f(st.start);
        if (st.end) f(st.end);
      }
      m.checks.forEach(c => f(c.expr));
    } else if (m.kind === "bits") {
      for (const b of m.fields) {
        b.checks.forEach(c => f(c.expr));
        forEachTypeReadExpr(b.type, f);
      }
    } else if (m.kind === "block") {
      if (m.condition) f(m.condition);
      forEachLayerExpr(m.layers, f);
    } else f(m.discriminant);
  });
  forEachLayerExpr(s.layers, f);
}

/** Calls `f` for every pointer `@origin` expression of a struct. */
function forEachOrigin(s: IrStruct, f: (e: IrExpr) => void): void {
  const visit = (t: IrType): void => {
    if (t.kind === "pointer") {
      if (t.origin) f(t.origin);
      visit(t.target);
    } else if (t.kind === "array") visit(t.element);
    else if (t.kind === "layered" || t.kind === "transform") visit(t.inner);
  };
  forEachMember(s.members, m => {
    if (m.kind === "field") visit(m.type);
  });
}

// ── types ───────────────────────────────────────────────────────────────────

/** The type under layers and transforms. */
export function strip(t: IrType): IrType {
  while (t.kind === "layered" || t.kind === "transform") t = t.inner;
  return t;
}

/** The type under layers. */
export function stripLayers(t: IrType): IrType {
  while (t.kind === "layered") t = t.inner;
  return t;
}

export function primSize(p: string): number {
  return Number(p.slice(1)) / 8;
}

export function literalInt(e: IrExpr): number | undefined {
  if (e.kind === "literal" && e.value.kind === "int") {
    const n = Number(e.value.value);
    return Number.isSafeInteger(n) ? n : undefined;
  }
  if (e.kind === "convert") return literalInt(e.operand);
  return undefined;
}

/** A field type that is a transform without an inverse (possibly under layers). */
export function isOneWay(t: IrType): boolean {
  const x = stripLayers(t);
  return x.kind === "transform" && !x.write;
}

/** True if a codec (`@via`) layer wraps the value (views stop there). */
export function hasVia(t: IrType): boolean {
  for (; t.kind === "layered" || t.kind === "transform"; t = t.inner)
    if (t.kind === "layered" && t.layers.some(l => l.kind === "via")) return true;
  return false;
}

/** True if the type has a pointer with `@origin` (followed after the members). */
export function hasOrigin(t: IrType): boolean {
  if (t.kind === "pointer") return t.origin !== undefined || hasOrigin(t.target);
  if (t.kind === "array") return hasOrigin(t.element);
  if (t.kind === "layered" || t.kind === "transform") return hasOrigin(t.inner);
  return false;
}

/** Types a view scan skips and reads on access (targets, codecs, struct contents, byte arrays). */
export function lazyType(t: IrType): boolean {
  switch (t.kind) {
    case "layered":
      return t.layers.some(l => l.kind === "via") || lazyType(t.inner);
    case "pointer":
    case "struct":
      return true;
    case "bytes":
      return t.length.kind !== "until";
    case "array":
      return lazyType(t.element);
    default:
      return false;
  }
}

/** Types whose encoding has a size independent of position and context (patchable in views). */
export function patchableType(t: IrType): boolean {
  switch (t.kind) {
    case "prim":
    case "bool":
    case "enum":
      return true;
    case "string":
    case "bytes":
      return t.length.kind === "count";
    case "transform":
      return t.write !== undefined && patchableType(t.inner);
    case "layered":
      return (
        t.layers.every(
          l =>
            l.kind === "endian" ||
            l.kind === "strict" ||
            (l.kind === "size" && literalInt(l.size) !== undefined) ||
            (l.kind === "padUntil" && literalInt(l.size) !== undefined)
        ) && patchableType(t.inner)
      );
    default:
      return false;
  }
}

/** The size field of a stream piece: the count of `u8 x[n]`, or the innermost `@size(n)`. */
export function innerSizeField(t: IrType): string | undefined {
  const fieldOf = (e: IrExpr): string | undefined => {
    while (e.kind === "convert") e = e.operand;
    return e.kind === "field" ? e.name : undefined;
  };
  if (t.kind === "bytes" && t.length.kind === "count") return fieldOf(t.length.expr);
  if (t.kind !== "layered") return undefined;
  for (const l of t.layers) {
    if (l.kind === "via") return undefined;
    if (l.kind === "size") return fieldOf(l.size);
  }
  return undefined;
}

/**
 * A struct field read through exactly one codec, with only `@size` layers around it: views give it
 * a child view in the decoded space. Returns the codec layer's index.
 */
export function viaKidLayer(model: Model, t: IrType): number | undefined {
  if (t.kind !== "layered" || t.inner.kind !== "struct") return undefined;
  if (model.struct(t.inner.struct).layers.length) return undefined;
  if (!t.layers.every(l => l.kind === "via" || l.kind === "size")) return undefined;
  const vias = t.layers.flatMap((l, i) => (l.kind === "via" ? [i] : []));
  if (vias.length !== 1 || vias[0]! > 1) return undefined;
  const via = t.layers[vias[0]!] as Extract<IrLayer, { kind: "via" }>;
  return model.codec(via.codec).streaming ? undefined : vias[0];
}

/** The value type a read of `t` produces (for `it` and comparisons). */
export function valueTypeOf(model: Model, t: IrType): IrValueType {
  switch (t.kind) {
    case "prim":
      if (t.prim[0] === "f")
        return { kind: "float", bits: Number(t.prim.slice(1)) as 16 | 32 | 64 };
      return {
        kind: "int",
        bits: Number(t.prim.slice(1)) as 8 | 16 | 24 | 32 | 40 | 48 | 56 | 64,
        signed: t.prim[0] === "i"
      };
    case "bool":
      return { kind: "bool" };
    case "string":
      return { kind: "string" };
    case "bytes":
      return { kind: "bytes" };
    case "array":
      return { kind: "array", element: valueTypeOf(model, t.element) };
    case "struct":
      return { kind: "struct", struct: t.struct };
    case "enum":
      return { kind: "enum", enum: t.enum };
    case "pointer": {
      const inner = valueTypeOf(model, t.target);
      return t.nullValue !== undefined && !t.emptyIsNull ? { kind: "nullable", inner } : inner;
    }
    case "extern": {
      const x = model.extern(t.extern);
      return x.kind === "type" ? x.valueType : { kind: "bytes" };
    }
    case "union":
      return {
        kind: "union",
        variants: t.variants.map(v => ({ name: v.name, type: valueTypeOf(model, v.type) }))
      };
    case "transform":
      return t.valueType;
    case "layered":
      return valueTypeOf(model, t.inner);
  }
}

// ── field sets ──────────────────────────────────────────────────────────────

/** True if the struct reads `$index` outside element placements (its own index in an array). */
function usesIndex(s: IrStruct): boolean {
  let found = false;
  const scan = (e: IrExpr): void => {
    if (!found) found = exprUses(e, x => x.kind === "builtinValue" && x.name === "index");
  };
  const arrayType = (t: IrType): void => {
    if (t.kind === "array") {
      if (t.length.kind === "count") scan(t.length.expr);
      arrayType(t.element);
    } else if (t.kind === "layered" || t.kind === "transform") arrayType(t.inner);
  };
  forEachMember(s.members, m => {
    if (m.kind === "field") {
      if (m.placement) scan(m.placement.offset);
      if (m.virtual) scan(m.virtual.read);
      m.checks.forEach(c => scan(c.expr));
      if (m.derive) scan(m.derive);
      if (m.type.kind === "array") arrayType(m.type);
      else forEachTypeReadExpr(m.type, scan);
    } else if (m.kind === "block") {
      if (m.condition) scan(m.condition);
    } else if (m.kind === "switch") scan(m.discriminant);
  });
  // Layout item arguments are evaluated in the struct's write context.
  if (s.layout) forEachLayoutArg(s.layout, scan);
  return found;
}

/** True if values of `t` contain a struct that reads its own `$index`. */
export function elementUsesIndex(model: Model, t: IrType): boolean {
  switch (t.kind) {
    case "struct":
      return usesIndex(model.struct(t.struct));
    case "layered":
    case "transform":
      return elementUsesIndex(model, t.inner);
    case "pointer":
      return elementUsesIndex(model, t.target);
    case "union":
      return t.variants.some(v => elementUsesIndex(model, v.type));
    default:
      return false;
  }
}

/**
 * Fields whose position or encoding `sizeof`/`offsetof`/`encodedSize`/`bytesof`/`encode` use, in
 * read-side expressions and `@origin`s (plus derives with `withDerives`). `this` names the struct.
 */
export function extentFields(s: IrStruct, withDerives: boolean): Set<string> {
  const out = new Set<string>();
  const scan = (e: IrExpr): void =>
    walkExpr(e, x => {
      if (x.kind !== "call" || x.callee.kind !== "builtin") return;
      if (!["sizeof", "offsetof", "encodedSize", "bytesof", "encode"].includes(x.callee.name))
        return;
      const a = x.args[0];
      if (a?.kind === "field") out.add(a.name);
      else if (a?.kind === "this") out.add("this");
    });
  forEachReadExpr(s, scan);
  forEachOrigin(s, scan);
  if (withDerives) forEachDerive(s.members, scan);
  return out;
}

/**
 * Fields a view scan must read in full: those that read-side expressions of other fields use
 * (lengths, conditions, arguments, offsets, checks of other fields), and fields `@origin`
 * expressions mention. Stream sources are not among them: views read streams through byte spaces
 * built from the sources' scans.
 */
export function neededFields(s: IrStruct): Set<string> {
  const out = new Set<string>();
  const own = new Map<string, IrExpr[]>();
  forEachMember(s.members, m => {
    if (m.kind === "field")
      own.set(
        m.name,
        m.checks.map(c => c.expr)
      );
    else if (m.kind === "bits")
      for (const b of m.fields)
        if (b.name)
          own.set(
            b.name,
            b.checks.map(c => c.expr)
          );
  });
  const ownChecks = new Set([...own.values()].flat());
  forEachReadExpr(s, e => {
    if (!ownChecks.has(e)) addFieldRefs(e, out);
  });
  forEachOrigin(s, e => addFieldRefs(e, out));
  for (const [name, checks] of own)
    for (const e of checks)
      walkExpr(e, x => {
        if (x.kind === "field" && x.name !== name) out.add(x.name);
      });
  return out;
}

/** Fields that some derive expression references (changing them changes derived values). */
export function derivedFrom(s: IrStruct): Set<string> {
  const out = new Set<string>();
  forEachDerive(s.members, e => addFieldRefs(e, out));
  return out;
}

/** Fields inside blocks with layers (their encoding context is not the struct's own). */
export function fieldsInLayeredBlocks(
  ms: readonly IrMember[],
  inside = false,
  out = new Set<string>()
): Set<string> {
  for (const m of ms) {
    if (m.kind === "field" && inside) out.add(m.name);
    else if (m.kind === "bits" && inside) m.fields.forEach(b => b.name && out.add(b.name));
    else if (m.kind === "block") {
      const layered = inside || m.layers.length > 0;
      fieldsInLayeredBlocks(m.members, layered, out);
      if (m.else) fieldsInLayeredBlocks(m.else, layered, out);
    } else if (m.kind === "switch") {
      m.cases.forEach(c => fieldsInLayeredBlocks(c.members, inside, out));
      if (m.default) fieldsInLayeredBlocks(m.default, inside, out);
    }
  }
  return out;
}

/** No derive depends on the content of inline children (checksums, member access, externs). */
export function isChildSafe(s: IrStruct): boolean {
  let safe = true;
  forEachDerive(s.members, e => {
    if (
      exprUses(
        e,
        x =>
          x.kind === "member" ||
          x.kind === "index" ||
          x.kind === "map" ||
          (x.kind === "call" &&
            (x.callee.kind === "extern" ||
              ["bytesof", "encode", "crc32", "adler32"].includes(x.callee.name)))
      )
    )
      safe = false;
  });
  return safe;
}

/** The bitfield group declaring a named bitfield. */
export function findBits(ms: readonly IrMember[], name: string): IrBits | undefined {
  let found: IrBits | undefined;
  someMember(ms, m => {
    if (m.kind === "bits" && m.fields.some(b => b.name === name)) found = m;
    return found !== undefined;
  });
  return found;
}

// ── layout items ────────────────────────────────────────────────────────────

/** What a layout item layer argument is: an alignment (≥ 1), a padding (≥ 0) or an offset. */
export type LayoutArg = "align" | "pad" | "offset";

/** Arguments of a layout item layer, by what they are. */
function layoutLayerArgs(l: IrLayer): [IrExpr, LayoutArg][] {
  switch (l.kind) {
    case "align":
      return l.offset
        ? [
            [l.to, "align"],
            [l.offset, "offset"]
          ]
        : [[l.to, "align"]];
    case "alignEnd":
      return [[l.to, "align"]];
    case "padBefore":
    case "padAfter":
      return [[l.count, "pad"]];
    default:
      return [];
  }
}

/** Every layer argument of layout items (groups included). */
function forEachLayoutArg(
  items: readonly IrLayoutItem[],
  f: (e: IrExpr, what: LayoutArg) => void
): void {
  for (const it of items) {
    for (const l of it.layers) for (const [e, what] of layoutLayerArgs(l)) f(e, what);
    if (it.group) forEachLayoutArg(it.group.items, f);
  }
}

/** A layout argument that is a constant in its range (else it is evaluated per instance). */
export function constLayoutArg(e: IrExpr, what: LayoutArg): number | undefined {
  const v = literalInt(e);
  if (v === undefined || (what === "align" && v < 1) || (what === "pad" && v < 0)) return undefined;
  return v;
}

/**
 * True if a layout item layer argument must be evaluated per instance: it is not a constant, or
 * it is a constant out of range (the RANGE error is raised on write).
 */
export function dynamicLayout(items: readonly IrLayoutItem[]): boolean {
  let dynamic = false;
  forEachLayoutArg(items, (e, what) => {
    if (constLayoutArg(e, what) === undefined) dynamic = true;
  });
  return dynamic;
}

/** Fields that the struct's layout item arguments read. */
export function layoutArgFields(s: IrStruct): Set<string> {
  const out = new Set<string>();
  if (s.layout) forEachLayoutArg(s.layout, e => addFieldRefs(e, out));
  return out;
}
