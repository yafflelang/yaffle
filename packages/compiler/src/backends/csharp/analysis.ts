/** IR helpers and analyses shared by the C# emitters. */
import type {
  IrExpr,
  IrLayer,
  IrLayoutItem,
  IrLength,
  IrMember,
  IrStreamExpr,
  IrStruct,
  IrType,
  IrValueType
} from "../../ir/index.ts";
import { flatFields, visitExpr } from "../../ir/walk.ts";
import type { Model } from "./model.ts";

/** Calls `f` for every sub-expression of `e`. */
export function walkExpr(e: IrExpr, f: (e: IrExpr) => void): void {
  visitExpr(e, { expr: f });
}

/** True if some sub-expression of `e` satisfies `pred`. */
export function exprUses(e: IrExpr, pred: (e: IrExpr) => boolean): boolean {
  let found = false;
  walkExpr(e, x => {
    if (!found && pred(x)) found = true;
  });
  return found;
}

/** True if an expression mentions `it`. */
export function usesIt(e: IrExpr): boolean {
  return exprUses(e, x => x.kind === "it");
}

/** The type under any layers. */
export function stripLayers(t: IrType): IrType {
  while (t.kind === "layered") t = t.inner;
  return t;
}

/** The storage type under any layers and transforms. */
export function stripType(t: IrType): IrType {
  while (t.kind === "layered" || t.kind === "transform") t = t.inner;
  return t;
}

/** A struct (possibly under layers): read with a pre-registered object. */
export function isStructType(t: IrType): boolean {
  return stripLayers(t).kind === "struct";
}

/** The value of an integer literal (through conversions) when it is a safe JS integer. */
export function literalInt(e: IrExpr): number | undefined {
  if (e.kind === "literal" && e.value.kind === "int") {
    const n = Number(e.value.value);
    return Number.isSafeInteger(n) ? n : undefined;
  }
  if (e.kind === "convert") return literalInt(e.operand);
  return undefined;
}

export function primSize(p: string): number {
  return Number(p.slice(1)) / 8;
}

/** The IR value type of a primitive's raw value. */
export function primValueType(p: string): IrValueType {
  if (p[0] === "f") return { kind: "float", bits: Number(p.slice(1)) as 16 | 32 | 64 };
  return { kind: "int", bits: Number(p.slice(1)) as 8, signed: p[0] === "i" };
}

const EXTENT_FNS = new Set(["sizeof", "offsetof", "encodedSize", "bytesof", "encode"]);

/**
 * Fields (or "this") whose extent `sizeof`, `offsetof`, `encodedSize`, `bytesof` or `encode` ask
 * for in read-side expressions and pointer origins; with `derives`, in derive expressions too.
 */
export function extentFields(s: IrStruct, derives = false): Set<string> {
  const out = new Set<string>();
  const scan = (e: IrExpr): void =>
    walkExpr(e, x => {
      if (x.kind !== "call" || x.callee.kind !== "builtin" || !EXTENT_FNS.has(x.callee.name))
        return;
      const a = x.args[0];
      if (a?.kind === "field") out.add(a.name);
      else if (a?.kind === "this") out.add("this");
    });
  forEachReadExpr(s, scan);
  forEachOrigin(s, scan);
  if (derives) for (const f of flatFields(s.members)) if (f.derive) scan(f.derive);
  return out;
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
    else if (l.kind === "align" || l.kind === "alignEnd") {
      f(l.to);
      if (l.offset) f(l.offset);
    } else if (l.kind === "padBefore" || l.kind === "padAfter") f(l.count);
    else if (l.kind === "padUntil") f(l.size);
    else if (l.kind === "endian") f(l.value);
    if ("fill" in l && l.fill.kind === "fn") f(l.fill.expr);
  }
}

/** Calls `f` for every read-side expression of a type (lengths, arguments, layers, transforms). */
function forEachTypeReadExpr(t: IrType, f: (e: IrExpr) => void): void {
  switch (t.kind) {
    case "string":
    case "bytes":
      forEachLengthExpr(t.length, f);
      break;
    case "array":
      forEachLengthExpr(t.length, f);
      if (t.elementPlacement) f(t.elementPlacement);
      forEachTypeReadExpr(t.element, f);
      break;
    case "struct":
    case "extern":
      t.args.forEach(f);
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

/** Calls `f` for every read-side expression of a struct (everything but derives). */
export function forEachReadExpr(s: IrStruct, f: (e: IrExpr) => void): void {
  const stream = (st: IrStreamExpr): void => {
    if (st.kind !== "slice") return;
    f(st.start);
    if (st.end) f(st.end);
    stream(st.stream);
  };
  const members = (ms: readonly IrMember[]): void => {
    for (const m of ms) {
      if (m.kind === "field") {
        forEachTypeReadExpr(m.type, f);
        if (m.placement) f(m.placement.offset);
        if (m.virtual) f(m.virtual.read);
        if (m.from) stream(m.from.stream);
        m.checks.forEach(c => f(c.expr));
      } else if (m.kind === "bits") {
        for (const b of m.fields) {
          b.checks.forEach(c => f(c.expr));
          forEachTypeReadExpr(b.type, f);
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

/** Every layout item layer argument of a struct (they may read the struct's fields). */
export function forEachLayoutExpr(s: IrStruct, f: (e: IrExpr) => void): void {
  const visit = (items: readonly IrLayoutItem[]): void => {
    for (const it of items) {
      for (const l of it.layers) {
        if (l.kind === "align" || l.kind === "alignEnd") {
          f(l.to);
          if (l.offset) f(l.offset);
        } else if (l.kind === "padBefore" || l.kind === "padAfter") f(l.count);
      }
      if (it.group) visit(it.group.items);
    }
  };
  if (s.layout) visit(s.layout);
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
  for (const m of flatFields(s.members)) if (m.kind === "field") visit(m.type);
}

/** Calls `f` for every member, looking into blocks and switches. */
function forEachMember(ms: readonly IrMember[], f: (m: IrMember) => void): void {
  for (const m of ms) {
    f(m);
    if (m.kind === "block") {
      forEachMember(m.members, f);
      if (m.else) forEachMember(m.else, f);
    } else if (m.kind === "switch") {
      m.cases.forEach(c => forEachMember(c.members, f));
      if (m.default) forEachMember(m.default, f);
    }
  }
}

/**
 * True if the struct reads `$index` (its own index in an array) outside element placements, which
 * bind their own. `write`: also in layout item arguments, which only writers evaluate.
 */
export function usesIndex(s: IrStruct, write = false): boolean {
  let found = false;
  const scan = (e: IrExpr): void => {
    if (!found) found = exprUses(e, x => x.kind === "builtinValue" && x.name === "index");
  };
  const type = (t: IrType): void => {
    if (t.kind === "array") {
      if (t.length.kind === "count") scan(t.length.expr);
      type(t.element);
    } else if (t.kind === "layered" || t.kind === "transform") type(t.inner);
  };
  forEachMember(s.members, m => {
    if (m.kind === "field") {
      if (m.placement) scan(m.placement.offset);
      if (m.virtual) scan(m.virtual.read);
      m.checks.forEach(c => scan(c.expr));
      if (m.derive) scan(m.derive);
      if (m.type.kind === "array") type(m.type);
      else forEachTypeReadExpr(m.type, scan);
    } else if (m.kind === "block") {
      if (m.condition) scan(m.condition);
    } else if (m.kind === "switch") scan(m.discriminant);
  });
  if (write) forEachLayoutExpr(s, scan);
  return found;
}

/** True if any element (through layers, transforms, pointers, unions) is a struct using `$index`. */
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

/** The value type a read of `t` produces (for `it` and comparisons). */
export function valueTypeOf(model: Model, t: IrType): IrValueType {
  switch (t.kind) {
    case "prim":
      return primValueType(t.prim);
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
