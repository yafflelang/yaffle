/**
 * Generic traversal of IR expressions, types and members. Used by the frontend (renaming implicit
 * parameters, computing flags, analyses) and by the IR validator.
 */
import type {
  IrBitField,
  IrExpr,
  IrField,
  IrLayer,
  IrLayoutItem,
  IrLength,
  IrMember,
  IrStreamExpr,
  IrStruct,
  IrType
} from "./ir.ts";

/** Calls `fn` on each direct sub-expression of `e`, left to right. */
function forEachSubExpr(e: IrExpr, fn: (x: IrExpr) => void): void {
  switch (e.kind) {
    case "member":
      fn(e.object);
      break;
    case "index":
      fn(e.object);
      fn(e.index);
      break;
    case "map":
      fn(e.array);
      break;
    case "unary":
    case "convert":
      fn(e.operand);
      break;
    case "binary":
      fn(e.left);
      fn(e.right);
      break;
    case "cond":
      fn(e.test);
      fn(e.then);
      fn(e.else);
      break;
    case "call":
      e.args.forEach(a => fn(a));
      break;
    case "in":
      fn(e.value);
      for (const it of e.items) {
        if (it.kind === "value") fn(it.value);
        else {
          fn(it.low);
          fn(it.high);
        }
      }
      break;
    case "regex":
      fn(e.value);
      break;
    case "lambda":
      fn(e.body);
      break;
    default:
      break;
  }
}

/** Calls `fn` on `e` and every sub-expression, parents first. */
export function walkExpr(e: IrExpr, fn: (x: IrExpr) => void): void {
  fn(e);
  forEachSubExpr(e, x => walkExpr(x, fn));
}

/** Rewrites every expression node bottom-up (children first). */
export function mapExpr(e: IrExpr, fn: (e: IrExpr) => IrExpr): IrExpr {
  let r: IrExpr;
  switch (e.kind) {
    case "member":
      r = { ...e, object: mapExpr(e.object, fn) };
      break;
    case "index":
      r = { ...e, object: mapExpr(e.object, fn), index: mapExpr(e.index, fn) };
      break;
    case "map":
      r = { ...e, array: mapExpr(e.array, fn) };
      break;
    case "unary":
      r = { ...e, operand: mapExpr(e.operand, fn) };
      break;
    case "binary":
      r = { ...e, left: mapExpr(e.left, fn), right: mapExpr(e.right, fn) };
      break;
    case "cond":
      r = { ...e, test: mapExpr(e.test, fn), then: mapExpr(e.then, fn), else: mapExpr(e.else, fn) };
      break;
    case "call":
      r = { ...e, args: e.args.map(a => mapExpr(a, fn)) };
      break;
    case "in":
      r = {
        ...e,
        value: mapExpr(e.value, fn),
        items: e.items.map(it =>
          it.kind === "value"
            ? { kind: "value" as const, value: mapExpr(it.value, fn) }
            : { kind: "range" as const, low: mapExpr(it.low, fn), high: mapExpr(it.high, fn) }
        )
      };
      break;
    case "regex":
      r = { ...e, value: mapExpr(e.value, fn) };
      break;
    case "convert":
      r = { ...e, operand: mapExpr(e.operand, fn) };
      break;
    case "lambda":
      r = { ...e, body: mapExpr(e.body, fn) };
      break;
    default:
      r = e;
  }
  return fn(r);
}

/** Does `e` use `it` anywhere (including lambda bodies)? */
export function containsIt(e: IrExpr): boolean {
  let found = false;
  walkExpr(e, x => {
    if (x.kind === "it") found = true;
  });
  return found;
}

/** Names of the fields `e` reads. */
export function fieldRefs(e: IrExpr): Set<string> {
  const out = new Set<string>();
  walkExpr(e, x => {
    if (x.kind === "field") out.add(x.name);
  });
  return out;
}

// ── visitors ─────────────────────────────────────────────────────────────────

/** Callbacks for `visit*`: `expr` sees children before parents, `type` sees parents first. */
export interface Visitor {
  expr?(e: IrExpr): void;
  type?(t: IrType): void;
  member?(m: IrMember): void;
}

export function visitExpr(e: IrExpr, v: Visitor): void {
  forEachSubExpr(e, x => visitExpr(x, v));
  v.expr?.(e);
}

export function visitType(t: IrType, v: Visitor): void {
  v.type?.(t);
  switch (t.kind) {
    case "string":
    case "bytes":
      visitLength(t.length, v);
      break;
    case "array":
      visitType(t.element, v);
      visitLength(t.length, v);
      if (t.elementPlacement) visitExpr(t.elementPlacement, v);
      break;
    case "struct":
    case "extern":
      for (const a of t.args) visitExpr(a, v);
      break;
    case "pointer":
      visitType(t.target, v);
      if (t.origin) visitExpr(t.origin, v);
      break;
    case "union":
      for (const x of t.variants) visitType(x.type, v);
      break;
    case "transform":
      visitType(t.inner, v);
      visitExpr(t.read, v);
      if (t.write) visitExpr(t.write, v);
      break;
    case "layered":
      visitType(t.inner, v);
      for (const l of t.layers) visitLayer(l, v);
      break;
    default:
      break;
  }
}

function visitLength(l: IrLength, v: Visitor): void {
  if (l.kind === "count") visitExpr(l.expr, v);
  else if (l.kind === "until" || l.kind === "before") visitExpr(l.terminator, v);
  else if (l.kind === "untilPredicate") visitExpr(l.predicate, v);
}

export function visitLayer(l: IrLayer, v: Visitor): void {
  switch (l.kind) {
    case "size":
      visitExpr(l.size, v);
      return;
    case "via":
      for (const a of l.args) visitExpr(a, v);
      return;
    case "align":
    case "alignEnd":
      visitExpr(l.to, v);
      if (l.fill.kind === "fn") visitExpr(l.fill.expr, v);
      if (l.offset) visitExpr(l.offset, v);
      return;
    case "padBefore":
    case "padAfter":
      visitExpr(l.count, v);
      if (l.fill.kind === "fn") visitExpr(l.fill.expr, v);
      return;
    case "padUntil":
      visitExpr(l.size, v);
      if (l.fill.kind === "fn") visitExpr(l.fill.expr, v);
      return;
    case "endian":
      visitExpr(l.value, v);
      return;
    case "strict":
      return;
  }
}

export function visitMembers(members: IrMember[], v: Visitor): void {
  for (const m of members) {
    v.member?.(m);
    switch (m.kind) {
      case "field":
        visitType(m.type, v);
        for (const c of m.checks) visitExpr(c.expr, v);
        if (m.placement) visitExpr(m.placement.offset, v);
        if (m.derive) visitExpr(m.derive, v);
        if (m.virtual) visitExpr(m.virtual.read, v);
        if (m.from) {
          let s: IrStreamExpr | undefined = m.from.stream;
          while (s && s.kind === "slice") {
            visitExpr(s.start, v);
            if (s.end) visitExpr(s.end, v);
            s = s.stream;
          }
        }
        break;
      case "bits":
        for (const f of m.fields) {
          visitType(f.type, v);
          for (const c of f.checks) visitExpr(c.expr, v);
          if (f.derive) visitExpr(f.derive, v);
        }
        break;
      case "block":
        if (m.condition) visitExpr(m.condition, v);
        for (const l of m.layers) visitLayer(l, v);
        visitMembers(m.members, v);
        if (m.else) visitMembers(m.else, v);
        break;
      case "switch":
        visitExpr(m.discriminant, v);
        for (const c of m.cases) visitMembers(c.members, v);
        if (m.default) visitMembers(m.default, v);
        break;
    }
  }
}

export function visitStruct(s: IrStruct, v: Visitor): void {
  for (const p of s.params) if (p.default) visitExpr(p.default, v);
  for (const l of s.layers) visitLayer(l, v);
  visitMembers(s.members, v);
  const items = (list: IrLayoutItem[]) => {
    for (const i of list) {
      for (const l of i.layers) visitLayer(l, v);
      if (i.group) items(i.group.items);
    }
  };
  items(s.layout ?? []);
}

/** All named fields of a member list (flattened through blocks, switches and bits). */
export function flatFields(members: IrMember[]): (IrField | (IrBitField & { kind?: undefined }))[] {
  const out: (IrField | IrBitField)[] = [];
  const visit = (ms: IrMember[]) => {
    for (const m of ms) {
      if (m.kind === "field") out.push(m);
      else if (m.kind === "bits") out.push(...m.fields.filter(f => f.name !== null));
      else if (m.kind === "block") {
        visit(m.members);
        if (m.else) visit(m.else);
      } else {
        for (const c of m.cases) visit(c.members);
        if (m.default) visit(m.default);
      }
    }
  };
  visit(members);
  return out as (IrField | (IrBitField & { kind?: undefined }))[];
}
