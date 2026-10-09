/** Pure IR analyses shared by the Go emitters. */
import type {
  IrBits,
  IrExpr,
  IrField,
  IrLayer,
  IrLayoutItem,
  IrMember,
  IrStreamExpr,
  IrStruct,
  IrType
} from "../../ir/index.ts";
import { fieldRefs, walkExpr } from "../../ir/walk.ts";

export function literalInt(e: IrExpr): number | undefined {
  if (e.kind === "literal" && e.value.kind === "int") {
    const n = Number(e.value.value);
    return Number.isSafeInteger(n) ? n : undefined;
  }
  if (e.kind === "convert") return literalInt(e.operand);
  return undefined;
}

/** Removes transforms/layers to find the underlying storage type. */
export function stripType(t: IrType | undefined): IrType | undefined {
  while (t && (t.kind === "layered" || t.kind === "transform")) t = t.inner;
  return t;
}

/** Removes layers. */
export function stripLayers(t: IrType): IrType {
  while (t.kind === "layered") t = t.inner;
  return t;
}

/** A field type that is a transform without a reverse (possibly under layers). */
export function isOneWay(t: IrType): boolean {
  const x = stripLayers(t);
  return x.kind === "transform" && !x.write;
}

/** Every field and bits member of a member list, through blocks, else branches and switch cases. */
export function leafMembers(ms: readonly IrMember[]): (IrField | IrBits)[] {
  const out: (IrField | IrBits)[] = [];
  const walk = (list: readonly IrMember[]): void => {
    for (const m of list) {
      if (m.kind === "field" || m.kind === "bits") out.push(m);
      else if (m.kind === "block") {
        walk(m.members);
        if (m.else) walk(m.else);
      } else {
        for (const c of m.cases) walk(c.members);
        if (m.default) walk(m.default);
      }
    }
  };
  walk(ms);
  return out;
}

/** Calls f for every derive expression of a struct (fields and bitfields). */
export function forEachDerive(s: IrStruct, f: (e: IrExpr) => void): void {
  for (const m of leafMembers(s.members)) {
    if (m.kind === "field") {
      if (m.derive) f(m.derive);
    } else for (const b of m.fields) if (b.derive) f(b.derive);
  }
}

/** Fields that some derive expression references. */
export function derivedFrom(s: IrStruct): Set<string> {
  const out = new Set<string>();
  forEachDerive(s, e => fieldRefs(e).forEach(n => out.add(n)));
  return out;
}

// ── read-side expressions ────────────────────────────────────────────────────

/** Calls f for every expression of a type: lengths, arguments, placements, transforms, layers. */
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
      t.variants.forEach(v => forEachTypeExpr(v.type, f));
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

function forEachLayerExpr(ls: readonly IrLayer[], f: (e: IrExpr) => void): void {
  for (const l of ls) {
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

/** Calls f for every read-side expression of a struct (everything but derives). */
export function forEachReadExpr(s: IrStruct, f: (e: IrExpr) => void): void {
  const stream = (st: IrStreamExpr): void => {
    if (st.kind === "slice") {
      f(st.start);
      if (st.end) f(st.end);
      stream(st.stream);
    }
  };
  const members = (ms: readonly IrMember[]): void => {
    for (const m of ms) {
      if (m.kind === "field") {
        forEachTypeExpr(m.type, f);
        if (m.placement) f(m.placement.offset);
        if (m.from) stream(m.from.stream);
        if (m.virtual) f(m.virtual.read);
        m.checks.forEach(c => f(c.expr));
      } else if (m.kind === "bits") {
        for (const b of m.fields) {
          b.checks.forEach(c => f(c.expr));
          forEachTypeExpr(b.type, f);
        }
      } else if (m.kind === "block") {
        if (m.condition) f(m.condition);
        forEachLayerExpr(m.layers, f);
        members(m.members);
        if (m.else) members(m.else);
      } else {
        f(m.discriminant);
        m.cases.forEach(c => members(c.members));
        if (m.default) members(m.default);
      }
    }
  };
  members(s.members);
  forEachLayerExpr(s.layers, f);
}

/** Calls f for every pointer `@origin` expression of a struct. */
export function forEachOrigin(s: IrStruct, f: (e: IrExpr) => void): void {
  const visit = (t: IrType): void => {
    if (t.kind === "pointer") {
      if (t.origin) f(t.origin);
      visit(t.target);
    } else if (t.kind === "array") visit(t.element);
    else if (t.kind === "layered" || t.kind === "transform") visit(t.inner);
  };
  for (const m of leafMembers(s.members)) if (m.kind === "field") visit(m.type);
}

// ── extents ─────────────────────────────────────────────────────────────────

const EXTENT_BUILTINS = new Set(["sizeof", "offsetof", "encodedSize", "bytesof", "encode"]);

/** Calls f with the field (or "this") of every sizeof/offsetof/encodedSize/bytesof/encode in e. */
function forEachExtentUse(e: IrExpr, f: (field: string, builtin: string) => void): void {
  walkExpr(e, x => {
    if (x.kind !== "call" || x.callee.kind !== "builtin" || !EXTENT_BUILTINS.has(x.callee.name))
      return;
    const a = x.args[0];
    if (a?.kind === "field") f(a.name, x.callee.name);
    else if (a?.kind === "this") f("this", x.callee.name);
  });
}

/** Fields whose position/size read-side expressions use (sizeof/offsetof on read). */
export function readSideExtents(s: IrStruct): Set<string> {
  const out = new Set<string>();
  const scan = (e: IrExpr): void => forEachExtentUse(e, name => out.add(name));
  forEachReadExpr(s, scan);
  forEachOrigin(s, scan);
  return out;
}

/** Fields that need extents (sizeof/offsetof/… anywhere in the struct). */
export function writeSideExtents(s: IrStruct): Set<string> {
  const out = readSideExtents(s);
  forEachDerive(s, e => forEachExtentUse(e, name => out.add(name)));
  return out;
}

/** The size field of a stream piece (`u8 data[n]` → n; `@size(exp) @via(…)` → exp). */
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

// ── $index and layouts ───────────────────────────────────────────────────────

/**
 * True if the struct reads `$index` outside element placements (its own index in an array);
 * with layout, also in layout item arguments (write side only).
 */
export function usesIndex(s: IrStruct, layout = false): boolean {
  let found = false;
  const scan = (e: IrExpr): void => {
    walkExpr(e, x => {
      if (x.kind === "builtinValue" && x.name === "index") found = true;
    });
  };
  // In an array field only the counts matter (element placements give each element its own).
  const arrayType = (t: IrType): void => {
    if (t.kind === "array") {
      if (t.length.kind === "count") scan(t.length.expr);
      arrayType(t.element);
    } else if (t.kind === "layered" || t.kind === "transform") arrayType(t.inner);
  };
  const members = (ms: readonly IrMember[]): void => {
    for (const m of ms) {
      if (m.kind === "field") {
        if (m.placement) scan(m.placement.offset);
        if (m.virtual) scan(m.virtual.read);
        m.checks.forEach(c => scan(c.expr));
        if (m.derive) scan(m.derive);
        if (m.type.kind === "array") arrayType(m.type);
        else forEachTypeExpr(m.type, scan);
      } else if (m.kind === "block") {
        if (m.condition) scan(m.condition);
        members(m.members);
        if (m.else) members(m.else);
      } else if (m.kind === "switch") {
        scan(m.discriminant);
        m.cases.forEach(c => members(c.members));
        if (m.default) members(m.default);
      } else {
        for (const b of m.fields) {
          b.checks.forEach(c => scan(c.expr));
          if (b.derive) scan(b.derive);
        }
      }
    }
  };
  members(s.members);
  if (layout) forEachLayoutExpr(s, scan);
  return found;
}

/**
 * Calls f for every argument of the struct's layout item layers, per-element groups included:
 * write-side expressions over the struct's own fields.
 */
export function forEachLayoutExpr(s: IrStruct, f: (e: IrExpr) => void): void {
  const items = (list: readonly IrLayoutItem[]): void => {
    for (const it of list) {
      for (const l of it.layers) {
        if (l.kind === "align" || l.kind === "alignEnd") {
          f(l.to);
          if (l.offset) f(l.offset);
        } else if (l.kind === "padBefore" || l.kind === "padAfter") f(l.count);
      }
      if (it.group) items(it.group.items);
    }
  };
  items(s.layout ?? []);
}

/** True if a layout item layer argument is not a constant. */
export function dynamicLayout(items: readonly IrLayoutItem[]): boolean {
  return items.some(
    it =>
      it.layers.some(l => {
        const args =
          l.kind === "align" || l.kind === "alignEnd"
            ? [l.to, l.offset]
            : l.kind === "padBefore" || l.kind === "padAfter"
              ? [l.count]
              : [];
        return args.some(e => e !== undefined && literalInt(e) === undefined);
      }) ||
      (it.group !== undefined && dynamicLayout(it.group.items))
  );
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
