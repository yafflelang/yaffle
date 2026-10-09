/** IR traversals and static analyses shared by the Java emitters. */
import type {
  IrExpr,
  IrLayer,
  IrLayoutItem,
  IrLength,
  IrMember,
  IrStreamExpr,
  IrStruct,
  IrType
} from "../../ir/index.ts";
import { visitExpr } from "../../ir/walk.ts";

/** The type under any layers. */
export function unlayer(t: IrType): IrType {
  while (t.kind === "layered") t = t.inner;
  return t;
}

/** The storage type under layers and transforms. */
export function storageType(t: IrType): IrType {
  while (t.kind === "layered" || t.kind === "transform") t = t.inner;
  return t;
}

/** The struct id of a struct type under layers. */
export function structUnder(t: IrType): string | undefined {
  const u = unlayer(t);
  return u.kind === "struct" ? u.struct : undefined;
}

/** A field type that is a transform without a reverse (possibly under layers). */
export function isOneWay(t: IrType): boolean {
  const u = unlayer(t);
  return u.kind === "transform" && !u.write;
}

export function primSize(p: string): number {
  return Number(p.slice(1)) / 8;
}

/** The value of an integer literal (through conversions), if it is a safe JS integer. */
export function literalInt(e: IrExpr): number | undefined {
  if (e.kind === "literal" && e.value.kind === "int") {
    const n = Number(e.value.value);
    return Number.isSafeInteger(n) ? n : undefined;
  }
  if (e.kind === "convert") return literalInt(e.operand);
  return undefined;
}

/** True if some node of `e` satisfies `pred`. */
export function exprHas(e: IrExpr, pred: (x: IrExpr) => boolean): boolean {
  let found = false;
  visitExpr(e, {
    expr: x => {
      if (!found && pred(x)) found = true;
    }
  });
  return found;
}

/** Adds the names of the fields `e` references to `out`. */
export function addFieldRefs(e: IrExpr, out: Set<string>): void {
  visitExpr(e, {
    expr: x => {
      if (x.kind === "field") out.add(x.name);
    }
  });
}

export const usesIt = (e: IrExpr): boolean => exprHas(e, x => x.kind === "it");

const usesIndexValue = (e: IrExpr): boolean =>
  exprHas(e, x => x.kind === "builtinValue" && x.name === "index");

/**
 * Calls `f` on every member, descending into blocks and switch cases. `conditional`: inside an
 * `if`, an `else` or a switch case.
 */
export function forEachMember(
  ms: readonly IrMember[],
  f: (m: IrMember, conditional: boolean) => void,
  conditional = false
): void {
  for (const m of ms) {
    f(m, conditional);
    if (m.kind === "block") {
      forEachMember(m.members, f, conditional || m.condition !== undefined);
      if (m.else) forEachMember(m.else, f, true);
    } else if (m.kind === "switch") {
      for (const c of m.cases) forEachMember(c.members, f, true);
      if (m.default) forEachMember(m.default, f, true);
    }
  }
}

/** Calls `f` with every field and bitfield `derive` of a struct. */
export function forEachDerive(s: IrStruct, f: (e: IrExpr) => void): void {
  forEachMember(s.members, m => {
    if (m.kind === "field" && m.derive) f(m.derive);
    else if (m.kind === "bits") for (const b of m.fields) if (b.derive) f(b.derive);
  });
}

function forEachLengthExpr(l: IrLength, f: (e: IrExpr) => void): void {
  if (l.kind === "count") f(l.expr);
  else if (l.kind === "until" || l.kind === "before") f(l.terminator);
  else if (l.kind === "untilPredicate") f(l.predicate);
}

function forEachLayerExpr(ls: readonly IrLayer[], f: (e: IrExpr) => void): void {
  for (const l of ls) {
    if (l.kind === "size") f(l.size);
    else if (l.kind === "via") l.args.forEach(f);
    else if (l.kind === "align" || l.kind === "alignEnd") f(l.to);
    else if (l.kind === "padBefore" || l.kind === "padAfter") f(l.count);
    else if (l.kind === "padUntil") f(l.size);
    else if (l.kind === "endian") f(l.value);
    if ("fill" in l && l.fill.kind === "fn") f(l.fill.expr);
  }
}

/** Calls `f` for every read-side expression of a type (lengths, arguments, transforms, layers). */
export function forEachTypeExpr(t: IrType, f: (e: IrExpr) => void): void {
  switch (t.kind) {
    case "string":
    case "bytes":
      forEachLengthExpr(t.length, f);
      break;
    case "array":
      forEachLengthExpr(t.length, f);
      if (t.elementPlacement) f(t.elementPlacement);
      forEachTypeExpr(t.element, f);
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

function forEachStreamExpr(st: IrStreamExpr, f: (e: IrExpr) => void): void {
  if (st.kind !== "slice") return;
  f(st.start);
  if (st.end) f(st.end);
  forEachStreamExpr(st.stream, f);
}

/** Calls `f` for every read-side expression of a struct (everything but derives and origins). */
export function forEachReadExpr(s: IrStruct, f: (e: IrExpr) => void): void {
  forEachMember(s.members, m => {
    if (m.kind === "field") {
      forEachTypeExpr(m.type, f);
      if (m.placement) f(m.placement.offset);
      if (m.virtual) f(m.virtual.read);
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
  });
  forEachLayerExpr(s.layers, f);
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
  forEachMember(s.members, m => {
    if (m.kind === "field") visit(m.type);
  });
}

/** Every layer argument of a layout, groups included (they may read the struct's fields). */
export function layoutExprs(items: readonly IrLayoutItem[] | undefined): IrExpr[] {
  const out: IrExpr[] = [];
  for (const it of items ?? []) {
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

/**
 * True if every layer argument is a valid int constant, so the layout can be hoisted; otherwise
 * the struct's writer computes it (an invalid constant then fails with RANGE when written).
 */
export function layoutConstant(items: readonly IrLayoutItem[]): boolean {
  const ok = (e: IrExpr, min: number): boolean => {
    const v = literalInt(e);
    return v !== undefined && v >= min && v <= 0x7fffffff;
  };
  return items.every(
    it =>
      it.layers.every(l => {
        if (l.kind === "align" || l.kind === "alignEnd") {
          return ok(l.to, 1) && (!l.offset || ok(l.offset, -0x7fffffff));
        }
        return (l.kind !== "padBefore" && l.kind !== "padAfter") || ok(l.count, 0);
      }) &&
      (!it.group || layoutConstant(it.group.items))
  );
}

/** True if the struct reads `$index` outside element placements (its own index in an array). */
export function usesIndex(s: IrStruct): boolean {
  let found = false;
  const scan = (e: IrExpr): void => {
    if (!found && usesIndexValue(e)) found = true;
  };
  // Array lengths only: element placements see the element's index, not the struct's.
  const arrayLengths = (t: IrType): void => {
    if (t.kind === "array") {
      if (t.length.kind === "count") scan(t.length.expr);
      arrayLengths(t.element);
    } else if (t.kind === "layered" || t.kind === "transform") arrayLengths(t.inner);
  };
  forEachMember(s.members, m => {
    if (m.kind === "field") {
      if (m.placement) scan(m.placement.offset);
      if (m.virtual) scan(m.virtual.read);
      m.checks.forEach(c => scan(c.expr));
      if (m.derive) scan(m.derive);
      if (m.type.kind === "array") arrayLengths(m.type);
      else forEachTypeExpr(m.type, scan);
    } else if (m.kind === "block") {
      if (m.condition) scan(m.condition);
    } else if (m.kind === "switch") scan(m.discriminant);
  });
  return found;
}

/** True if a struct's layout layers mention `$index`. */
export function layoutUsesIndex(s: IrStruct): boolean {
  return layoutExprs(s.layout).some(usesIndexValue);
}

const EXTENT_BUILTINS = new Set(["sizeof", "offsetof", "encodedSize", "bytesof", "encode"]);

/** Adds the fields (or "this") whose position, size or encoding `e` asks for. */
function addExtentFields(e: IrExpr, out: Set<string>): void {
  visitExpr(e, {
    expr: x => {
      if (x.kind !== "call" || x.callee.kind !== "builtin" || !EXTENT_BUILTINS.has(x.callee.name)) {
        return;
      }
      const a = x.args[0];
      if (a?.kind === "field") out.add(a.name);
      else if (a?.kind === "this") out.add("this");
    }
  });
}

/** Fields whose extents read-side expressions use (sizeof, offsetof, … on read). */
export function readExtentFields(s: IrStruct): Set<string> {
  const out = new Set<string>();
  const add = (e: IrExpr): void => addExtentFields(e, out);
  forEachReadExpr(s, add);
  forEachOrigin(s, add);
  return out;
}

/** Fields whose extents any expression of the struct uses (derives and layouts included). */
export function writeExtentFields(s: IrStruct): Set<string> {
  const out = readExtentFields(s);
  const add = (e: IrExpr): void => addExtentFields(e, out);
  layoutExprs(s.layout).forEach(add);
  forEachDerive(s, add);
  return out;
}

/** The array field and piece field of an `arr[*].field` stream (through slices), if it is one. */
export function eachStream(
  st: IrStreamExpr | undefined
): { array: string; field: string } | undefined {
  while (st && st.kind === "slice") st = st.stream;
  return st?.kind === "each" ? st : undefined;
}

/**
 * The decoded length of a stream piece's value when its type states it without decoding: a
 * counted bytes type, or bytes to the end of an innermost `@size(n)` window.
 */
export function pieceLength(t: IrType): IrExpr | undefined {
  if (t.kind === "bytes") return t.length.kind === "count" ? t.length.expr : undefined;
  if (t.kind !== "layered" || t.inner.kind !== "bytes") return undefined;
  const inner = t.inner;
  if (inner.length.kind === "count") return inner.length.expr;
  const l0 = t.layers[0];
  if (inner.length.kind === "rest" && l0?.kind === "size") return l0.size;
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
            ((l.kind === "size" || l.kind === "padUntil") && literalInt(l.size) !== undefined)
        ) && patchableType(t.inner)
      );
    default:
      return false;
  }
}
