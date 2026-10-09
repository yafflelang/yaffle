/** Static analyses for views: what a shallow scan reads, skips and defers. */
import type { IrExpr, IrStruct, IrType } from "../../ir/index.ts";
import {
  derivedFrom,
  forEachDerive,
  forEachLayoutExpr,
  forEachReadExpr,
  leafMembers,
  readSideExtents
} from "./irutil.ts";
import { walkExpr } from "../../ir/walk.ts";
import type { Model } from "./model.ts";

/** What a view's shallow scan does with a struct's fields. */
export interface ScanFacts {
  /** Fields that later read-side expressions depend on (setting them changes the structure). */
  structural: Set<string>;
  /** Fields whose codec regions a shallow scan skips (decoded when a getter reads them). */
  lazyVia: Set<string>;
  /** Stream pieces a shallow scan leaves undecoded (the stream decodes them on demand). */
  lazyPieces: Set<string>;
  /** `from` fields a shallow scan doesn't read (getters read the stream on demand). */
  deferFrom: Set<string>;
}

const factsMemo = new WeakMap<Model, Map<string, ScanFacts>>();

export function scanFacts(model: Model, s: IrStruct): ScanFacts {
  let byStruct = factsMemo.get(model);
  if (!byStruct) factsMemo.set(model, (byStruct = new Map()));
  let facts = byStruct.get(s.id);
  if (!facts) {
    const structural = structuralFields(s);
    facts = {
      structural,
      lazyVia: lazyViaFields(model, s, structural),
      lazyPieces: lazyPieceFields(model, s, structural),
      deferFrom: deferredFromFields(model, s, structural)
    };
    byStruct.set(s.id, facts);
  }
  return facts;
}

/** A field a shallow scan defers: a `from` stream, or a lazy codec region. */
export function isDeferred(model: Model, s: IrStruct, name: string): boolean {
  const f = scanFacts(model, s);
  return f.deferFrom.has(name) || f.lazyVia.has(name);
}

/**
 * True if a value of type t is complete after a view's shallow scan: pointer and `at` targets are
 * not followed there, and codec regions of lazy fields are skipped. Nested `@base` structs,
 * decoded regions and virtual streams are read completely.
 */
function shallowComplete(model: Model, t: IrType, seen = new Set<string>()): boolean {
  switch (t.kind) {
    case "pointer":
      return false;
    case "array":
      return shallowComplete(model, t.element, seen);
    case "struct": {
      if (seen.has(t.struct)) return true;
      seen.add(t.struct);
      const s = model.struct(t.struct);
      if (s.base || s.layers.some(l => l.kind === "via")) return true;
      const facts = scanFacts(model, s);
      for (const f of model.fields(s)) {
        const fld = f.field;
        if (!fld || fld.virtual) continue;
        if (facts.deferFrom.has(f.name)) return false;
        if (fld.from) continue;
        if (fld.placement || facts.lazyVia.has(f.name)) return false;
        if (!shallowComplete(model, fld.type, seen)) return false;
      }
      return true;
    }
    case "union":
      return t.variants.every(v => shallowComplete(model, v.type, seen));
    case "transform":
      return shallowComplete(model, t.inner, seen);
    case "layered":
      return t.layers.some(l => l.kind === "via") || shallowComplete(model, t.inner, seen);
    default:
      return true;
  }
}

/**
 * True if a getter can return a value of type t from the scan. Stricter than shallowComplete:
 * nested `@base` and codec structs, `from` fields and lazy pieces need a full read.
 */
export function gettableFromScan(model: Model, t: IrType, seen = new Set<string>()): boolean {
  switch (t.kind) {
    case "pointer":
      return false;
    case "array":
      return gettableFromScan(model, t.element, seen);
    case "struct": {
      if (seen.has(t.struct)) return true;
      seen.add(t.struct);
      const s = model.struct(t.struct);
      if (s.base || s.layers.some(l => l.kind === "via")) return false;
      const facts = scanFacts(model, s);
      for (const f of model.fields(s)) {
        if (!f.field) continue;
        if (f.field.placement || f.field.from) return false;
        if (facts.lazyVia.has(f.name) || facts.lazyPieces.has(f.name)) return false;
        if (!gettableFromScan(model, f.field.type, seen)) return false;
      }
      return true;
    }
    case "union":
      return t.variants.every(v => gettableFromScan(model, v.type, seen));
    case "transform":
      return gettableFromScan(model, t.inner, seen);
    case "layered":
      return t.layers.some(l => l.kind === "via") || gettableFromScan(model, t.inner, seen);
    default:
      return true;
  }
}

/**
 * True if reading the struct needs values a shallow scan leaves incomplete: a read-side
 * expression (check, length, condition, argument, …) reads a field holding pointer or `at`
 * targets, or a check runs on such a field. Views then scan the struct completely.
 */
export function needsDeepScan(model: Model, s: IrStruct): boolean {
  const facts = scanFacts(model, s);
  const incomplete = new Set<string>();
  for (const f of model.fields(s)) {
    const fld = f.field;
    if (!fld || fld.virtual) continue;
    if (facts.deferFrom.has(f.name)) incomplete.add(f.name);
    if (fld.from) continue;
    if (fld.placement || facts.lazyVia.has(f.name) || !shallowComplete(model, fld.type))
      incomplete.add(f.name);
  }
  if (!incomplete.size) return false;
  let deep = false;
  for (const f of model.fields(s)) {
    if (!f.field || !incomplete.has(f.name)) continue;
    if (f.field.checks.length) deep = true;
    let t: IrType = f.field.type;
    while (t.kind === "layered" || t.kind === "transform") t = t.inner;
    if (t.kind === "array" && t.length.kind === "untilPredicate") deep = true;
  }
  forEachReadExpr(s, e => {
    const positions = new Set<IrExpr>();
    walkExpr(e, x => {
      if (x.kind === "call" && x.callee.kind === "builtin" && x.callee.name === "offsetof")
        x.args.forEach(a => positions.add(a));
    });
    walkExpr(e, x => {
      if (x.kind === "field" && incomplete.has(x.name) && !positions.has(x)) deep = true;
    });
  });
  return deep;
}

function structuralFields(s: IrStruct): Set<string> {
  const out = new Set<string>();
  // A field's own checks don't make it structural.
  const own = new Map<string, Set<IrExpr>>();
  for (const m of leafMembers(s.members))
    if (m.kind === "field") own.set(m.name, new Set(m.checks.map(c => c.expr)));
  const allOwn = new Set<IrExpr>();
  for (const set of own.values()) for (const e of set) allOwn.add(e);
  forEachReadExpr(s, e => {
    if (allOwn.has(e)) return;
    walkExpr(e, x => {
      if (x.kind === "field") out.add(x.name);
    });
  });
  for (const [name, set] of own) {
    for (const e of set) {
      walkExpr(e, x => {
        if (x.kind === "field" && x.name !== name) out.add(x.name);
      });
    }
  }
  return out;
}

/**
 * Fields whose codec regions a view's shallow scan may skip: a `@via` on the field (or on its
 * struct), no checks, and nothing else of the struct reads its value while reading.
 */
function lazyViaFields(model: Model, s: IrStruct, structural: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const f of model.fields(s)) {
    const fld = f.field;
    if (!fld || fld.placement || fld.from || fld.checks.length) continue;
    if (structural.has(f.name) || model.streamSources.has(`${s.id}.${f.name}`)) continue;
    if (model.streamPieces.has(`${s.id}.${f.name}`)) continue;
    let t: IrType = fld.type;
    let via = false;
    while (t.kind === "layered") {
      if (t.layers.some(l => l.kind === "via")) via = true;
      t = t.inner;
    }
    if (t.kind === "struct" && model.struct(t.struct).layers.some(l => l.kind === "via"))
      via = true;
    if (via) out.add(f.name);
  }
  return out;
}

/**
 * Stream pieces (`arr[*].data` of a `from`) read through a codec that a view's shallow scan
 * leaves lazy: the stream decodes them on demand (yaffle.JoinPieces).
 */
function lazyPieceFields(model: Model, s: IrStruct, structural: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const f of model.fields(s)) {
    const fld = f.field;
    if (!fld || fld.placement || fld.from || fld.virtual || fld.checks.length) continue;
    if (!model.streamPieces.has(`${s.id}.${f.name}`) || structural.has(f.name)) continue;
    if (fld.type.kind === "layered" && fld.type.layers.some(l => l.kind === "via")) out.add(f.name);
  }
  return out;
}

/**
 * `from` fields a view's shallow scan doesn't read (getters and views of them read the stream
 * on demand): nothing else of the struct reads them while reading.
 */
function deferredFromFields(model: Model, s: IrStruct, structural: Set<string>): Set<string> {
  const out = new Set<string>();
  const extents = readSideExtents(s);
  for (const f of model.fields(s)) {
    const fld = f.field;
    if (!fld?.from || fld.checks.length || fld.bind) continue;
    if (structural.has(f.name) || extents.has(f.name)) continue;
    if (model.streamSources.has(`${s.id}.${f.name}`)) continue;
    out.add(f.name);
  }
  return out;
}

/** Fields a view setter can't patch in place: something reads, derives from or lays out by them. */
export function unpatchableFields(model: Model, s: IrStruct): Set<string> {
  const out = new Set([...scanFacts(model, s).structural, ...derivedFrom(s)]);
  forEachLayoutExpr(s, e =>
    walkExpr(e, x => {
      if (x.kind === "field") out.add(x.name);
    })
  );
  return out;
}

/**
 * No derive or layout item argument depends on the content of inline children (checksums,
 * member access, externs): in-place edits inside children can't change the struct.
 */
export function childSafe(s: IrStruct): boolean {
  let safe = true;
  const scan = (e: IrExpr): void =>
    walkExpr(e, x => {
      if (x.kind === "member" || x.kind === "index" || x.kind === "map") safe = false;
      if (x.kind === "call") {
        if (x.callee.kind === "extern") safe = false;
        else if (["bytesof", "encode", "crc32", "adler32"].includes(x.callee.name)) safe = false;
      }
    });
  forEachDerive(s, scan);
  forEachLayoutExpr(s, scan);
  return safe;
}
