/**
 * Static analyses over IR structs shared by the emitters: which expressions read which fields'
 * extents, which structs read `$index`, value types of reads, which fields views can patch, …
 * They mirror the TS backend's helpers so both targets agree.
 */
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
import { Model, allMembers, literalInt, someExpr, unlayer, walkExpr } from "./model.ts";

const EXTENT_FNS = new Set(["sizeof", "offsetof", "encodedSize", "bytesof", "encode"]);

/** The builtin an expression calls, if any. */
function builtinCall(x: IrExpr): string | undefined {
  return x.kind === "call" && x.callee.kind === "builtin" ? x.callee.name : undefined;
}

/** The field (or "this") whose extent a `sizeof`/`offsetof`/… call reads. */
function extentTarget(x: IrExpr): string | undefined {
  const fn = builtinCall(x);
  if (!fn || !EXTENT_FNS.has(fn) || x.kind !== "call") return undefined;
  const a = x.args[0];
  return a?.kind === "field" ? a.name : a?.kind === "this" ? "this" : undefined;
}

/** Fields whose position or size read-side expressions use. */
export function readSideExtents(s: IrStruct): Set<string> {
  const out = new Set<string>();
  const scan = (e: IrExpr): void =>
    walkExpr(e, x => {
      const f = extentTarget(x);
      if (f) out.add(f);
    });
  forEachReadExpr(s, scan);
  forEachOrigin(s, scan);
  return out;
}

/**
 * Fields whose extents the writer records (any expression of the struct uses them) and those
 * whose stage sizes it records too (`encodedSize`).
 */
export function writeSideExtents(s: IrStruct): { extents: Set<string>; stages: Set<string> } {
  const extents = new Set<string>();
  const stages = new Set<string>();
  const scan = (e: IrExpr): void =>
    walkExpr(e, x => {
      const f = extentTarget(x);
      if (!f) return;
      extents.add(f);
      if (f !== "this" && builtinCall(x) === "encodedSize") stages.add(f);
    });
  forEachReadExpr(s, scan);
  forEachOrigin(s, scan);
  forEachDerive(s, scan);
  return { extents, stages };
}

/** Calls `f` for every derive expression of a struct (fields and bitfields). */
export function forEachDerive(s: IrStruct, f: (e: IrExpr) => void): void {
  for (const m of allMembers(s.members)) {
    if (m.kind === "field" && m.derive) f(m.derive);
    else if (m.kind === "bits") for (const b of m.fields) if (b.derive) f(b.derive);
  }
}

/** Calls `f` for every read-side expression of a struct (everything but derives). */
export function forEachReadExpr(s: IrStruct, f: (e: IrExpr) => void): void {
  for (const m of allMembers(s.members)) {
    if (m.kind === "field") {
      if (m.virtual) f(m.virtual.read);
      else forEachTypeExpr(m.type, f);
      if (m.placement) f(m.placement.offset);
      if (m.from) forEachStreamExpr(m.from.stream, f);
      for (const c of m.checks) f(c.expr);
    } else if (m.kind === "bits") {
      for (const b of m.fields) {
        for (const c of b.checks) f(c.expr);
        forEachTypeExpr(b.type, f);
      }
    } else if (m.kind === "block") {
      if (m.condition) f(m.condition);
      forEachLayerExpr(m.layers, f);
    } else f(m.discriminant);
  }
  forEachLayerExpr(s.layers, f);
}

/** Calls `f` for every expression inside a type (lengths, arguments, transforms, layers). */
export function forEachTypeExpr(t: IrType, f: (e: IrExpr) => void): void {
  switch (t.kind) {
    case "string":
    case "bytes":
    case "array":
      if (t.length.kind === "count") f(t.length.expr);
      if (t.length.kind === "until" || t.length.kind === "before") f(t.length.terminator);
      if (t.length.kind === "untilPredicate") f(t.length.predicate);
      if (t.kind === "array") {
        if (t.elementPlacement) f(t.elementPlacement);
        forEachTypeExpr(t.element, f);
      }
      break;
    case "struct":
    case "extern":
      t.args.forEach(f);
      break;
    case "pointer":
      forEachTypeExpr(t.target, f);
      break;
    case "union":
      for (const v of t.variants) forEachTypeExpr(v.type, f);
      break;
    case "transform":
      f(t.read);
      forEachTypeExpr(t.inner, f);
      break;
    case "layered":
      forEachLayerExpr(t.layers, f);
      forEachTypeExpr(t.inner, f);
      break;
  }
}

function forEachLayerExpr(layers: readonly IrLayer[], f: (e: IrExpr) => void): void {
  for (const l of layers) {
    if (l.kind === "size") f(l.size);
    else if (l.kind === "via") l.args.forEach(f);
    else if (l.kind === "align" || l.kind === "alignEnd") {
      f(l.to);
      if (l.offset) f(l.offset);
    } else if (l.kind === "padBefore" || l.kind === "padAfter") f(l.count);
    else if (l.kind === "padUntil") f(l.size);
    else if (l.kind === "endian") f(l.value);
    if ("fill" in l && l.fill.kind === "fn") f(l.fill.expr);
  }
}

function forEachStreamExpr(st: IrStreamExpr, f: (e: IrExpr) => void): void {
  if (st.kind !== "slice") return;
  f(st.start);
  if (st.end) f(st.end);
  forEachStreamExpr(st.stream, f);
}

/** Calls `f` for every pointer `@origin` expression of a struct. */
export function forEachOrigin(s: IrStruct, f: (e: IrExpr) => void): void {
  const visit = (t: IrType): void => {
    if (t.kind === "pointer") {
      if (t.origin) f(t.origin);
      visit(t.target);
    } else if (t.kind === "array") visit(t.element);
    else if (t.kind === "layered" || t.kind === "transform") visit(t.inner);
  };
  for (const m of allMembers(s.members)) if (m.kind === "field") visit(m.type);
}

const isIndex = (x: IrExpr): boolean => x.kind === "builtinValue" && x.name === "index";

/**
 * True if the struct reads `$index` (its own index in an array) outside element placements. With
 * `write`, layout item arguments count too (the writer evaluates them).
 */
export function usesIndex(s: IrStruct, write = false): boolean {
  let found = false;
  const scan = (e: IrExpr): void => {
    if (!found && someExpr(e, isIndex)) found = true;
  };
  if (write) layoutExprs(s.layout ?? []).forEach(scan);
  const arrayCounts = (t: IrType): void => {
    if (t.kind === "array") {
      if (t.length.kind === "count") scan(t.length.expr);
      arrayCounts(t.element);
    } else if (t.kind === "layered" || t.kind === "transform") arrayCounts(t.inner);
  };
  for (const m of allMembers(s.members)) {
    if (m.kind === "field") {
      if (m.placement) scan(m.placement.offset);
      m.checks.forEach(c => scan(c.expr));
      if (m.derive) scan(m.derive);
      if (m.type.kind === "array") arrayCounts(m.type);
      else forEachTypeExpr(m.type, scan);
    } else if (m.kind === "block") {
      if (m.condition) scan(m.condition);
    } else if (m.kind === "switch") scan(m.discriminant);
  }
  return found;
}

/** Every layer argument of a struct's layout items (groups included). */
export function layoutExprs(items: readonly IrLayoutItem[]): IrExpr[] {
  const out: IrExpr[] = [];
  for (const it of items) {
    for (const l of it.layers) {
      if (l.kind === "align" || l.kind === "alignEnd") {
        out.push(l.to);
        if (l.offset) out.push(l.offset);
      } else if (l.kind === "padBefore" || l.kind === "padAfter") out.push(l.count);
    }
    if (it.group) out.push(...layoutExprs(it.group.items));
  }
  return out;
}

/** True if reading (with `write`, writing) a value of this type reads `$index` (struct elements). */
export function elementUsesIndex(model: Model, t: IrType, write = false): boolean {
  switch (t.kind) {
    case "struct":
      return usesIndex(model.struct(t.struct), write);
    case "layered":
    case "transform":
      return elementUsesIndex(model, t.inner, write);
    case "pointer":
      return elementUsesIndex(model, t.target, write);
    case "union":
      return t.variants.some(v => elementUsesIndex(model, v.type, write));
    default:
      return false;
  }
}

/** True if reading `t` can reach an async codec. */
export function reachesAsync(model: Model, t: IrType): boolean {
  switch (t.kind) {
    case "struct":
      return model.struct(t.struct).async;
    case "array":
      return reachesAsync(model, t.element);
    case "pointer":
      return reachesAsync(model, t.target);
    case "union":
      return t.variants.some(v => reachesAsync(model, v.type));
    case "transform":
      return reachesAsync(model, t.inner);
    case "layered":
      return (
        t.layers.some(l => l.kind === "via" && model.codec(l.codec).async) ||
        reachesAsync(model, t.inner)
      );
    default:
      return false;
  }
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
      return isNullablePointer(t) ? { kind: "nullable", inner } : inner;
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

/** A pointer whose null value reads as `None` (not as an empty value). */
export function isNullablePointer(t: IrType): boolean {
  return t.kind === "pointer" && t.nullValue !== undefined && !t.emptyIsNull;
}

/** A field type that is a transform without an inverse (possibly under layers). */
export function isOneWay(t: IrType): boolean {
  const u = unlayer(t);
  return u.kind === "transform" && !u.write;
}

/** A struct (possibly under layers): read with a pre-registered object. */
export function structUnderLayers(t: IrType): string | undefined {
  const u = unlayer(t);
  return u.kind === "struct" ? u.struct : undefined;
}

/** The empty value of an array, bytes or string type (for `@nullable(empty)`). */
export function emptyValue(t: IrType): string {
  const u = unlayer(t);
  return u.kind === "bytes" ? 'b""' : u.kind === "string" ? '""' : "[]";
}

/** The size field a piece's bytes length comes from (`u8 data[] @size(exp)` → "exp"). */
export function innerSizeField(t: IrType): string | undefined {
  const fieldName = (e: IrExpr): string | undefined => {
    while (e.kind === "convert") e = e.operand;
    return e.kind === "field" ? e.name : undefined;
  };
  if (t.kind === "bytes" && t.length.kind === "count") return fieldName(t.length.expr);
  if (t.kind !== "layered") return undefined;
  for (const l of t.layers) {
    if (l.kind === "via") return undefined;
    if (l.kind === "size") return fieldName(l.size);
  }
  return undefined;
}

/** The `@alignEnd` layers of a list. */
export function alignEnds(layers: readonly IrLayer[]): Extract<IrLayer, { kind: "alignEnd" }>[] {
  return layers.filter(l => l.kind === "alignEnd");
}

/**
 * The layers applied around a struct where it is used: a base's `@alignEnd` pads its whole
 * region, so its reader and writer apply it instead.
 */
export function inlineLayers(s: IrStruct): readonly IrLayer[] {
  return s.base ? s.layers.filter(l => l.kind !== "alignEnd") : s.layers;
}

/** The `@size` layer just inside codec layer `idx` (the decoded size the codec is told). */
export function decodedSize(layers: readonly IrLayer[], idx: number): IrExpr | undefined {
  for (let k = idx - 1; k >= 0; k--) {
    const l = layers[k]!;
    if (l.kind === "via") return undefined;
    if (l.kind === "size") return l.size;
  }
  return undefined;
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

export function findBits(ms: readonly IrMember[], name: string): IrBits | undefined {
  for (const m of allMembers(ms)) {
    if (m.kind === "bits" && m.fields.some(b => b.name === name)) return m;
  }
  return undefined;
}

/** True if an expression mentions `it` (a formula applied to the field's own input). */
export function usesIt(e: IrExpr): boolean {
  return someExpr(e, x => x.kind === "it");
}

// ── views ───────────────────────────────────────────────────────────────────

/**
 * Fields whose values decide the structure in views: read-side expressions other than the
 * field's own checks reference them, or layout items read them (an in-place patch would leave
 * the targets where the old value put them). Editing one re-encodes on commit.
 */
export function structuralFields(s: IrStruct): Set<string> {
  const out = new Set<string>();
  const add = (e: IrExpr): void =>
    walkExpr(e, x => {
      if (x.kind === "field") out.add(x.name);
    });
  const own = new Map<string, Set<IrExpr>>();
  for (const m of allMembers(s.members)) {
    if (m.kind === "field") own.set(m.name, new Set(m.checks.map(c => c.expr)));
  }
  const allOwn = new Set<IrExpr>([...own.values()].flatMap(set => [...set]));
  forEachReadExpr(s, e => {
    if (!allOwn.has(e)) add(e);
  });
  // A field's checks that mention other fields make those structural.
  for (const [name, set] of own) {
    for (const e of set) {
      walkExpr(e, x => {
        if (x.kind === "field" && x.name !== name) out.add(x.name);
      });
    }
  }
  for (const e of layoutExprs(s.layout ?? [])) add(e);
  return out;
}

/** Fields that some derive expression references. */
export function derivedFrom(s: IrStruct): Set<string> {
  const out = new Set<string>();
  forEachDerive(s, e =>
    walkExpr(e, x => {
      if (x.kind === "field") out.add(x.name);
    })
  );
  return out;
}

const CONTENT_FNS = new Set(["bytesof", "encode", "crc32", "adler32"]);

/** No derive depends on the content of inline children (checksums, member access, externs). */
export function childSafe(s: IrStruct): boolean {
  let safe = true;
  forEachDerive(s, e => {
    if (
      someExpr(
        e,
        x =>
          x.kind === "member" ||
          x.kind === "index" ||
          x.kind === "map" ||
          (x.kind === "call" && (x.callee.kind === "extern" || CONTENT_FNS.has(x.callee.name)))
      )
    )
      safe = false;
  });
  return safe;
}
