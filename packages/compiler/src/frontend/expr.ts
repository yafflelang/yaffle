/**
 * Expression checking and lowering. Every AST expression becomes a typed IR expression; type
 * errors are reported (in check mode) and produce an expression of ERROR_TYPE so they don't
 * cascade. Integer semantics follow docs/IR.md §6: arithmetic on integers is exact (`bigint`),
 * mixed int/float arithmetic converts to f64, and the checker inserts `convert` nodes.
 */
import type * as A from "./ast.ts";
import { unparen } from "./ast.ts";
import { OUTER_PREFIX, type Ctx } from "./ctx.ts";
import { replaceFix, type DiagOptions } from "./diagnostics.ts";
import type { Elaborator } from "./elaborate.ts";
import type {
  IrBinaryOp,
  IrBuiltinFn,
  IrEndianSpec,
  IrExpr,
  IrLiteral,
  IrType,
  IrValueType
} from "../ir/index.ts";
import { printExpr } from "./printer.ts";
import type { Span } from "./source.ts";
import type { FieldSym, LambdaParamSym } from "./symbols.ts";
import {
  BIGINT,
  BOOL,
  BYTES,
  ENDIAN,
  ERROR_TYPE,
  F64,
  STRING,
  U32,
  U8,
  coreType,
  displayValueType,
  fitsInt,
  isErrorType,
  isIntType,
  isNumericType,
  isTypeParamType,
  sameValueType
} from "./types.ts";

export const BUILTIN_FUNCTIONS: Record<
  string,
  { signature: string; doc: string; params: string[] }
> = {
  sizeof: {
    signature: "sizeof(field | Type) -> int",
    params: ["x"],
    doc: "Size on disk of a field (all layers), or the static size of a type."
  },
  offsetof: {
    signature: "offsetof(field) -> int",
    params: ["field"],
    doc: "Offset of a field's first byte from the nearest `@base`."
  },
  bytesof: {
    signature: "bytesof(field) -> bytes",
    params: ["field"],
    doc: "The field's bytes on disk (after codecs)."
  },
  encode: {
    signature: "encode(field) -> bytes",
    params: ["field"],
    doc: "The field's plain encoding (before codecs)."
  },
  crc32: {
    signature: "crc32(bytes) -> u32",
    params: ["data"],
    doc: "CRC-32 (IEEE) of bytes, or of a field's bytes on disk."
  },
  adler32: {
    signature: "adler32(bytes) -> u32",
    params: ["data"],
    doc: "Adler-32 of bytes, or of a field's bytes on disk."
  },
  min: {
    signature: "min(a, b, …)",
    params: ["a", "b"],
    doc: "The smallest argument, or the smallest element of one array (`min(items[*].size)`)."
  },
  max: {
    signature: "max(a, b, …)",
    params: ["a", "b"],
    doc: "The largest argument, or the largest element of one array (`max(probes[*].total)`)."
  },
  abs: { signature: "abs(x)", params: ["x"], doc: "Absolute value." },
  round: {
    signature: "round(x) -> int",
    params: ["x"],
    doc: "Rounds a float to an integer, half away from zero."
  },
  sum: {
    signature: "sum(array) -> int",
    params: ["array"],
    doc: "The sum of an array of numbers, e.g. `sum(entries[*].size)` (0 for an empty array)."
  },
  map: {
    signature: "map(array, x => expr) -> array",
    params: ["array", "x => expr"],
    doc: "The array of `expr` for each element `x`, e.g. `map(records, r => r.id)`."
  },
  filter: {
    signature: "filter(array, x => bool) -> array",
    params: ["array", "x => bool"],
    doc: "The elements for which the condition holds, in order."
  },
  indicesWhere: {
    signature: "indicesWhere(array, x => bool) -> int[]",
    params: ["array", "x => bool"],
    doc: "The indices of the elements for which the condition holds, e.g. `u8 index[s] = indicesWhere(records, r => r.model != null)`."
  },
  sortedBy: {
    signature: "sortedBy(array, x => key) -> array",
    params: ["array", "x => key"],
    doc: "A stable sort by `key`: numbers by value, strings by code points, bytes lexicographically. In a check: `where it == sortedBy(it, k => k.name)`."
  },
  unique: {
    signature: "unique(array) -> array",
    params: ["array"],
    doc: "The array without later duplicates (the first occurrence is kept; values compare by value)."
  },
  concat: {
    signature: "concat(a, b, …) -> array",
    params: ["a", "b"],
    doc: "The arrays joined in order."
  }
};

/** Builtins whose second argument is a lambda. */
export const LAMBDA_BUILTINS = new Set(["map", "filter", "indicesWhere", "sortedBy"]);

export interface ExprHint {
  /** Endianness for four-character codes compared with / assigned to integers. */
  endian?: IrEndianSpec;
}

export function errorExpr(): IrExpr {
  return { kind: "literal", value: { kind: "int", value: "0" }, type: ERROR_TYPE };
}

export function isError(e: IrExpr): boolean {
  return isErrorType(e.type);
}

export function lit(value: IrLiteral, type: IrValueType): IrExpr {
  return { kind: "literal", value, type };
}

export function intLit(v: bigint | number, type: IrValueType = BIGINT): IrExpr {
  return { kind: "literal", value: { kind: "int", value: BigInt(v).toString() }, type };
}

export function boolLit(v: boolean): IrExpr {
  return { kind: "literal", value: { kind: "bool", value: v }, type: BOOL };
}

export function literalInt(e: IrExpr): bigint | undefined {
  if (e.kind === "literal" && e.value.kind === "int") return BigInt(e.value.value);
  if (
    e.kind === "convert" &&
    e.operand.kind === "literal" &&
    e.operand.value.kind === "int" &&
    e.type.kind !== "float"
  ) {
    return BigInt(e.operand.value.value);
  }
  return undefined;
}

function literalNumber(e: IrExpr): number | undefined {
  if (e.kind === "literal" && e.value.kind === "float") return e.value.value;
  if (e.kind === "literal" && e.value.kind === "int") return Number(e.value.value);
  if (e.kind === "convert") return literalNumber(e.operand);
  return undefined;
}

/** Converts `e` to `type` (int → bigint, int → float, float width). No check of assignability. */
export function convertTo(e: IrExpr, type: IrValueType): IrExpr {
  if (sameValueType(e.type, type) || isErrorType(e.type) || isErrorType(type)) return e;
  if (e.kind === "literal" && e.value.kind === "int" && type.kind === "int") return { ...e, type };
  if (e.kind === "literal" && e.value.kind === "int" && type.kind === "bigint")
    return { ...e, type };
  if (e.kind === "literal" && e.value.kind === "int" && type.kind === "float") {
    return { kind: "literal", value: { kind: "float", value: Number(e.value.value) }, type };
  }
  if (e.kind === "literal" && e.value.kind === "float" && type.kind === "float")
    return { ...e, type };
  if (e.kind === "convert") return convertTo(e.operand, type);
  return { kind: "convert", operand: e, type };
}

/** Is a value of type `from` assignable to `to`? (int widths are range-checked at runtime) */
function assignable(from: IrValueType, to: IrValueType): boolean {
  if (isErrorType(from) || isErrorType(to)) return true;
  if (isIntType(from) && isIntType(to)) return true;
  if (isIntType(from) && to.kind === "float") return true;
  if (from.kind === "float" && to.kind === "float") return true;
  if (to.kind === "nullable")
    return from.kind === "nullable" ? assignable(from.inner, to.inner) : assignable(from, to.inner);
  if (from.kind === "array" && to.kind === "array") return assignable(from.element, to.element);
  if (from.kind === "array" && to.kind === "bytes") return isIntType(from.element);
  if (from.kind === "extern" && to.kind !== "extern") return assignable(from.valueType, to);
  if (to.kind === "extern" && from.kind !== "extern") return assignable(from, to.valueType);
  if (isTypeParamType(from) || isTypeParamType(to)) return sameValueType(from, to);
  return (
    sameValueType(from, to) ||
    (from.kind === to.kind &&
      (from.kind === "string" ||
        from.kind === "bytes" ||
        from.kind === "bool" ||
        from.kind === "endian"))
  );
}

/**
 * Checks that `e` can be stored in a location of type `to` and converts it. Reports a mismatch
 * (with a `round()` quick fix for float → int).
 */
export function coerce(
  el: Elaborator,
  ctx: Ctx,
  e: IrExpr,
  to: IrValueType,
  node: A.Expr | undefined,
  what: string
): IrExpr {
  if (isError(e) || isErrorType(to)) return e;
  if (!assignable(e.type, to)) {
    const span = node?.span ?? { start: 0, end: 0 };
    const opts: DiagOptions = {};
    if (e.type.kind === "float" && isIntType(to) && node)
      opts.fixes = [
        replaceFix(ctx.module.file, node.span, `round(${printExpr(node)})`, "Wrap in round()")
      ];
    el.report(
      ctx,
      span,
      "type-mismatch",
      `${what} must be ${displayValueType(to, el.displayName)}, but this is ${displayValueType(e.type, el.displayName)}.`,
      opts
    );
    return errorExpr();
  }
  if (to.kind === "int") {
    const v = literalInt(e);
    if (v !== undefined && !fitsInt(v, to)) {
      el.report(
        ctx,
        node?.span ?? { start: 0, end: 0 },
        "value-out-of-range",
        `${v} doesn't fit in ${displayValueType(to)}.`
      );
      return errorExpr();
    }
    if (v !== undefined) return intLit(v, to);
    return e;
  }
  if (
    to.kind === "float" &&
    (isIntType(e.type) || (e.type.kind === "float" && e.type.bits !== to.bits))
  )
    return convertTo(e, to.bits === 64 || e.type.kind === "float" ? to : F64);
  return e;
}

/** Lowers an expression that must be a compile-time constant. */
export function lowerConstExpr(
  el: Elaborator,
  ctx: Ctx,
  e: A.Expr,
  expected?: IrValueType
): IrExpr {
  const c: Ctx = { ...ctx, side: "const" };
  const r = lowerExpr(el, c, e, expected);
  if (!isError(r) && !isConstant(r)) {
    el.report(ctx, e.span, "not-constant", "This must be a compile-time constant.");
    return errorExpr();
  }
  return r;
}

function isConstant(e: IrExpr): boolean {
  switch (e.kind) {
    case "literal":
      return true;
    case "convert":
    case "unary":
      return isConstant(e.operand);
    case "binary":
      return isConstant(e.left) && isConstant(e.right);
    case "cond":
      return isConstant(e.test) && isConstant(e.then) && isConstant(e.else);
    default:
      return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export function lowerExpr(
  el: Elaborator,
  ctx: Ctx,
  e: A.Expr,
  expected?: IrValueType,
  hint: ExprHint = {}
): IrExpr {
  const r = lowerExprInner(el, ctx, e, expected, hint);
  if (ctx.record) el.model.exprTypes.set(e, r.type);
  return r;
}

function lowerExprInner(
  el: Elaborator,
  ctx: Ctx,
  e: A.Expr,
  expected: IrValueType | undefined,
  hint: ExprHint
): IrExpr {
  switch (e.kind) {
    case "Int": {
      if (expected && expected.kind === "int" && fitsInt(e.value, expected))
        return intLit(e.value, expected);
      if (expected && expected.kind === "float")
        return lit({ kind: "float", value: Number(e.value) }, expected);
      return intLit(e.value);
    }
    case "Float":
      return lit(
        { kind: "float", value: e.value },
        expected && expected.kind === "float" ? expected : F64
      );
    case "String":
      return lit({ kind: "string", value: e.value }, STRING);
    case "Bytes":
      return lit({ kind: "bytes", hex: e.hex }, BYTES);
    case "FourCC":
      return lowerFourCC(el, ctx, e, expected, hint);
    case "Bool":
      return boolLit(e.value);
    case "Endian":
      return lit({ kind: "endian", value: e.value }, ENDIAN);
    case "Name":
      return lowerName(el, ctx, e, expected);
    case "Dollar":
      return lowerDollar(el, ctx, e);
    case "It":
      if (!ctx.it) {
        el.report(
          ctx,
          e.span,
          "unknown-name",
          "`it` is only available in `as`, `=` with a transform, `where`, and `in`."
        );
        return errorExpr();
      }
      return { kind: "it", type: ctx.it };
    case "Paren":
      return lowerExpr(el, ctx, e.expr, expected, hint);
    case "Member":
      return lowerMember(el, ctx, e);
    case "Index": {
      const obj = lowerExpr(el, ctx, e.object);
      const idx = lowerExpr(el, ctx, e.index);
      if (isError(obj) || isError(idx)) return errorExpr();
      if (!isIntType(idx.type)) {
        el.report(
          ctx,
          e.index.span,
          "type-mismatch",
          `An index must be an integer, but this is ${displayValueType(idx.type, el.displayName)}.`
        );
        return errorExpr();
      }
      const t = obj.type.kind === "nullable" ? obj.type.inner : obj.type;
      if (t.kind === "array") return { kind: "index", object: obj, index: idx, type: t.element };
      if (t.kind === "bytes") return { kind: "index", object: obj, index: idx, type: U8 };
      el.report(
        ctx,
        e.object.span,
        "type-mismatch",
        `Only arrays and bytes can be indexed, but this is ${displayValueType(obj.type, el.displayName)}.`
      );
      return errorExpr();
    }
    case "Each":
      el.report(
        ctx,
        e.span,
        "type-mismatch",
        "`[*]` must be followed by `.field` in an expression."
      );
      return errorExpr();
    case "Slice":
      el.report(ctx, e.span, "type-mismatch", "Slices are only allowed in `from` streams.");
      return errorExpr();
    case "Call":
      return lowerCall(el, ctx, e, expected);
    case "Unary":
      return lowerUnary(el, ctx, e, expected);
    case "Binary":
      return lowerBinary(el, ctx, e, expected);
    case "Cond": {
      const test = lowerExpr(el, ctx, e.test, BOOL);
      if (!isError(test) && test.type.kind !== "bool") {
        el.report(
          ctx,
          e.test.span,
          "type-mismatch",
          `A condition must be bool, but this is ${displayValueType(test.type, el.displayName)}.`
        );
      }
      const guardCtx: Ctx = { ...ctx, guards: [...ctx.guards, { expr: e.test, positive: true }] };
      const elseCtx: Ctx = { ...ctx, guards: [...ctx.guards, { expr: e.test, positive: false }] };
      let then = lowerExpr(el, guardCtx, e.then, expected, hint);
      let els = lowerExpr(el, elseCtx, e.else, expected ?? then.type, hint);
      if (isError(test) || isError(then) || isError(els)) return errorExpr();
      const t = unify(then.type, els.type);
      if (!t) {
        el.report(
          ctx,
          e.span,
          "type-mismatch",
          `The branches have different types: ${displayValueType(then.type, el.displayName)} and ${displayValueType(els.type, el.displayName)}.`
        );
        return errorExpr();
      }
      then = convertTo(then, t);
      els = convertTo(els, t);
      if (test.kind === "literal" && test.value.kind === "bool")
        return test.value.value ? then : els;
      return { kind: "cond", test, then, else: els, type: t };
    }
    case "In": {
      const value = lowerExpr(el, ctx, e.value);
      return lowerInItems(el, ctx, value, e.items);
    }
    case "RegexMatch": {
      const value = lowerExpr(el, ctx, e.value);
      return lowerRegex(el, ctx, value, e.regex, e.value);
    }
    case "Lambda":
      el.report(
        ctx,
        e.span,
        "invalid-lambda",
        "A lambda (`x => …`) is only allowed as the second argument of map, filter, indicesWhere or sortedBy, or as a padding fill."
      );
      return errorExpr();
    case "Error":
      return errorExpr();
  }
}

function unify(a: IrValueType, b: IrValueType): IrValueType | undefined {
  if (isErrorType(a)) return b;
  if (isErrorType(b)) return a;
  if (sameValueType(a, b)) return a;
  if (isIntType(a) && isIntType(b)) return BIGINT;
  if (isNumericType(a) && isNumericType(b)) return F64;
  if (a.kind === "nullable" && assignable(b, a.inner)) return a;
  if (b.kind === "nullable" && assignable(a, b.inner)) return b;
  if (
    a.kind === b.kind &&
    (a.kind === "string" || a.kind === "bytes" || a.kind === "bool" || a.kind === "endian")
  )
    return a;
  return undefined;
}

// ── names ────────────────────────────────────────────────────────────────────

function lowerName(el: Elaborator, ctx: Ctx, e: A.NameExpr, expected?: IrValueType): IrExpr {
  const res = el.lookupValue(ctx, e.name, e.span);
  if (
    expected &&
    expected.kind === "enum" &&
    (res.kind === "none" || (res.kind === "decl" && res.sym.kind !== "const"))
  ) {
    const m = el.enumMemberById(expected.enum, e.name);
    if (m) {
      el.recordRef(ctx, e.span, m);
      return lit({ kind: "enum", enum: expected.enum, member: m.name }, expected);
    }
  }
  switch (res.kind) {
    case "lambda": {
      const sym = ctx.lambdaSyms?.get(e.name);
      if (sym) el.recordRef(ctx, e.span, sym);
      return { kind: "lambdaParam", name: e.name, type: res.type };
    }
    case "paramArg":
      return structuredClone(res.expr);
    case "field":
      return lowerFieldRef(el, ctx, res.syms, e.span, e.name);
    case "param": {
      if (ctx.side === "const") {
        el.report(ctx, e.span, "not-constant", `'${e.name}' is a parameter, not a constant.`);
        return errorExpr();
      }
      const t = el.paramValueType(ctx, res.sym);
      return { kind: "param", name: res.sym.name, type: t };
    }
    case "outerField":
    case "outerParam": {
      if (ctx.side === "const") {
        el.report(ctx, e.span, "not-constant", `'${e.name}' isn't a constant.`);
        return errorExpr();
      }
      const sym = res.kind === "outerField" ? res.syms[0]! : res.sym;
      const type =
        res.kind === "outerField"
          ? el.outerFieldValueType(res.syms[0]!)
          : el.paramValueType(ctx, res.sym);
      const expr = {
        kind: "param" as const,
        name: `${OUTER_PREFIX}${el.idOf(res.owner)}.${e.name}`,
        type
      };
      ctx.out.outerReads.push({
        owner: res.owner,
        member: e.name,
        memberKind: res.kind === "outerField" ? "field" : "param",
        sym,
        file: ctx.module.file,
        span: e.span,
        expr
      });
      return expr;
    }
    case "decl": {
      const s = res.sym;
      if (s.kind === "const") return el.constValue(s, ctx, e.span);
      el.report(
        ctx,
        e.span,
        "not-a-value",
        `'${e.name}' is a ${s.kind === "alias" ? "type" : s.kind === "externFn" ? "function" : s.kind}, not a value.`
      );
      return errorExpr();
    }
    case "namespace":
      el.report(ctx, e.span, "not-a-value", `'${e.name}' is a namespace, not a value.`);
      return errorExpr();
    case "builtinFn":
      el.report(ctx, e.span, "not-a-value", `'${e.name}' is a function; call it with (…).`);
      return errorExpr();
    case "enumMember":
      return lit(
        { kind: "enum", enum: el.idOf(res.sym.owner), member: res.sym.name },
        { kind: "enum", enum: el.idOf(res.sym.owner) }
      );
    case "none": {
      // a bare enum member where an enum is expected (`MemKind kind = Sys`)
      if (expected && expected.kind === "enum") {
        const m = el.enumMemberById(expected.enum, e.name);
        if (m) {
          el.recordRef(ctx, e.span, m);
          return lit({ kind: "enum", enum: expected.enum, member: m.name }, expected);
        }
      }
      if (e.name === "null") {
        el.report(
          ctx,
          e.span,
          "type-mismatch",
          "`null` can only be compared with a @nullable pointer: `x == null` or `x != null`."
        );
        return errorExpr();
      }
      const suggestion = el.suggestName(ctx, e.name);
      const opts: DiagOptions = suggestion
        ? { fixes: [replaceFix(ctx.module.file, e.span, suggestion)] }
        : {};
      const bound = el.isBoundName(e.name);
      el.report(
        ctx,
        e.span,
        "unknown-name",
        `Unknown name '${e.name}'.${suggestion ? ` Did you mean '${suggestion}'?` : bound ? ` Bound values are written $${e.name}.` : ""}`,
        opts
      );
      return errorExpr();
    }
  }
}

export function lowerFieldRef(
  el: Elaborator,
  ctx: Ctx,
  syms: FieldSym[],
  span: Span,
  name: string
): IrExpr {
  if (ctx.side === "const") {
    el.report(ctx, span, "not-constant", `'${name}' is a field, not a constant.`);
    return errorExpr();
  }
  let candidates = syms;
  if (ctx.self && candidates.includes(ctx.self)) {
    if (ctx.selfIsIt && ctx.it) return { kind: "it", type: ctx.it };
    if (candidates.length === 1) {
      el.report(ctx, span, "self-reference", `'${name}' can't refer to itself here.`);
      return errorExpr();
    }
    candidates = candidates.filter(c => c !== ctx.self);
  }
  if (ctx.side === "read") {
    const visible = candidates.filter(c => c.order < ctx.position);
    if (!visible.length) {
      const later = candidates[0]!;
      el.report(
        ctx,
        span,
        "forward-reference",
        `'${name}' is declared later; read-side expressions can only use earlier fields.`,
        {
          related: [
            { file: later.module.file, span: later.nameSpan, message: `'${name}' is declared here` }
          ]
        }
      );
      return errorExpr();
    }
    candidates = visible;
  }
  const types = candidates
    .map(c => ctx.fieldTypes.get(c)?.value ?? c.valueType)
    .filter((t): t is IrValueType => !!t);
  if (!types.length) {
    // type not computed yet (cycle through member access): give up quietly
    return errorExpr();
  }
  const t0 = types[0]!;
  if (types.some(t => !sameValueType(t, t0) && !isErrorType(t))) {
    el.report(ctx, span, "type-mismatch", `'${name}' has different types in different branches.`);
    return errorExpr();
  }
  if (!el.fieldPresent(ctx, candidates)) {
    const f = candidates[0]!;
    el.report(
      ctx,
      span,
      "possibly-absent",
      `'${name}' is declared in a conditional branch that may not have been taken here. Guard the use with the same condition.`,
      {
        related: [{ file: f.module.file, span: f.nameSpan, message: `'${name}' is declared here` }]
      }
    );
    return errorExpr();
  }
  for (const c of candidates) el.recordRef(ctx, span, c);
  return { kind: "field", name, type: t0 };
}

function lowerDollar(el: Elaborator, ctx: Ctx, e: A.DollarExpr): IrExpr {
  switch (e.name) {
    case "endian":
      if (ctx.side === "const") break;
      return { kind: "param", name: "endian", type: ENDIAN };
    case "offset":
    case "end":
      if (ctx.side === "const") break;
      return { kind: "builtinValue", name: e.name, type: BIGINT };
    case "index":
      if (ctx.side === "const") break;
      if (!ctx.insideArray) ctx.out.indexReads.push({ file: ctx.module.file, span: e.span });
      return { kind: "builtinValue", name: "index", type: BIGINT };
    default:
      break;
  }
  if (ctx.side === "const") {
    el.report(ctx, e.span, "not-constant", `$${e.name} isn't a constant.`);
    return errorExpr();
  }
  if (e.name === "") return errorExpr();
  return el.lowerBoundRef(ctx, e.name, e.span);
}

// ── member access ────────────────────────────────────────────────────────────

function lowerMember(el: Elaborator, ctx: Ctx, e: A.MemberExpr): IrExpr {
  const obj0 = unparen(e.object);
  // Enum.Member, ns.Name, ns.Enum.Member
  if (obj0.kind === "Name" || obj0.kind === "Member") {
    const target = el.resolveStaticPath(ctx, obj0);
    if (target) {
      if (target.kind === "enum") {
        const m = target.members.find(x => x.name === e.name.name);
        if (!m) {
          el.report(
            ctx,
            e.name.span,
            "unknown-member",
            `Enum '${target.name}' has no member '${e.name.name}'.`
          );
          return errorExpr();
        }
        el.recordRef(ctx, e.name.span, m);
        const id = el.idOf(target);
        return lit({ kind: "enum", enum: id, member: m.name }, { kind: "enum", enum: id });
      }
      if (target.kind === "namespace") {
        const decl = target.target?.decls.get(e.name.name);
        if (!decl) {
          el.report(
            ctx,
            e.name.span,
            "unknown-member",
            `Module '${target.name}' has no declaration '${e.name.name}'.`
          );
          return errorExpr();
        }
        el.recordRef(ctx, e.name.span, decl);
        if (decl.kind === "const") return el.constValue(decl, ctx, e.name.span);
        el.report(ctx, e.span, "not-a-value", `'${e.name.name}' is a ${decl.kind}, not a value.`);
        return errorExpr();
      }
      if (target.kind === "struct" || target.kind === "union" || target.kind === "alias") {
        el.report(ctx, e.span, "not-a-value", `'${printExpr(e)}' names a type, not a value.`);
        return errorExpr();
      }
    }
  }
  // arr[*].field
  if (obj0.kind === "Each") {
    const arr = lowerExpr(el, ctx, obj0.object);
    if (isError(arr)) return errorExpr();
    const at = arr.type.kind === "nullable" ? arr.type.inner : arr.type;
    if (at.kind !== "array") {
      el.report(
        ctx,
        obj0.object.span,
        "type-mismatch",
        `\`[*]\` needs an array, but this is ${displayValueType(arr.type, el.displayName)}.`
      );
      return errorExpr();
    }
    const ft = memberType(el, ctx, at.element, e.name);
    if (!ft) return errorExpr();
    return { kind: "map", array: arr, field: e.name.name, type: { kind: "array", element: ft } };
  }
  const obj = lowerExpr(el, ctx, e.object);
  if (isError(obj)) return errorExpr();
  const t = obj.type.kind === "nullable" ? obj.type.inner : obj.type;
  if (
    e.name.name === "length" &&
    (t.kind === "array" || t.kind === "bytes" || t.kind === "string")
  ) {
    if (t.kind === "string") return el.stringLength(ctx, obj);
    return { kind: "call", callee: { kind: "builtin", name: "len" }, args: [obj], type: BIGINT };
  }
  const ft = memberType(el, ctx, t, e.name);
  if (!ft) return errorExpr();
  return { kind: "member", object: obj, name: e.name.name, type: ft };
}

function memberType(
  el: Elaborator,
  ctx: Ctx,
  t: IrValueType,
  name: A.Ident
): IrValueType | undefined {
  if (t.kind === "nullable") t = t.inner;
  if (isTypeParamType(t)) {
    el.report(
      ctx,
      name.span,
      "unknown-member",
      `Can't access members of type parameter ${displayValueType(t)}.`
    );
    return undefined;
  }
  if (t.kind !== "struct") {
    el.report(
      ctx,
      name.span,
      "unknown-member",
      `${displayValueType(t, el.displayName)} has no member '${name.name}'.`
    );
    return undefined;
  }
  const r = el.structMember(ctx, t.struct, name.name, name.span);
  if (!r) {
    el.report(
      ctx,
      name.span,
      "unknown-member",
      `'${el.displayName(t.struct)}' has no field '${name.name}'.`
    );
    return undefined;
  }
  return r;
}

// ── calls ────────────────────────────────────────────────────────────────────

function lowerCall(el: Elaborator, ctx: Ctx, e: A.CallExpr, expected?: IrValueType): IrExpr {
  const callee = unparen(e.callee);
  let fnSym: ReturnType<Elaborator["resolveStaticPath"]> | undefined;
  let builtin: string | undefined;
  if (callee.kind === "Name") {
    const res = el.lookupValue(ctx, callee.name, callee.span);
    if (res.kind === "builtinFn") {
      builtin = callee.name;
      el.recordRef(ctx, callee.span, { kind: "builtinFn", name: callee.name });
    } else if (res.kind === "decl") fnSym = res.sym;
    else if (res.kind === "none") {
      const suggestion = el.suggestFunction(callee.name);
      el.report(
        ctx,
        callee.span,
        "unknown-function",
        `Unknown function '${callee.name}'.${suggestion ? ` Did you mean '${suggestion}'?` : " Declare it with `extern fn`."}`,
        suggestion ? { fixes: [replaceFix(ctx.module.file, callee.span, suggestion)] } : {}
      );
      for (const a of e.args) lowerExpr(el, ctx, a.value);
      return errorExpr();
    } else {
      el.report(ctx, callee.span, "unknown-function", `'${callee.name}' is not a function.`);
      return errorExpr();
    }
  } else if (callee.kind === "Member") {
    fnSym = el.resolveStaticPath(ctx, callee);
  }
  if (builtin) return lowerBuiltinCall(el, ctx, builtin, e, expected);
  if (!fnSym || fnSym.kind !== "externFn") {
    if (fnSym && fnSym.kind === "codec") {
      el.report(
        ctx,
        callee.span,
        "unknown-function",
        `'${fnSym.name}' is a codec; use it with @via(…).`
      );
    } else {
      el.report(ctx, callee.span, "unknown-function", `'${printExpr(callee)}' is not a function.`);
    }
    return errorExpr();
  }
  if (ctx.side === "const") {
    el.report(ctx, e.span, "not-constant", "Extern functions can't be called in constants.");
    return errorExpr();
  }
  const sig = el.externFnSignature(fnSym);
  const args = matchArgs(
    el,
    ctx,
    e.args,
    sig.params.map(p => ({ name: p.name, type: p.type, optional: false })),
    e.argsSpan,
    `'${fnSym.name}'`
  );
  if (!args) return errorExpr();
  return {
    kind: "call",
    callee: { kind: "extern", extern: el.idOf(fnSym) },
    args,
    type: sig.returns
  };
}

/** Matches positional and named arguments to parameters; returns lowered args in parameter order. */
export function matchArgs(
  el: Elaborator,
  ctx: Ctx,
  args: A.Arg[],
  params: { name: string; type: IrValueType; optional: boolean; defaultValue?: () => IrExpr }[],
  span: Span,
  what: string
): IrExpr[] | undefined {
  const out: (IrExpr | undefined)[] = params.map(() => undefined);
  let ok = true;
  let positional = 0;
  for (const a of args) {
    let idx: number;
    if (a.name) {
      idx = params.findIndex(p => p.name === a.name!.name);
      if (idx < 0) {
        el.report(
          ctx,
          a.name.span,
          "unknown-argument",
          `${what} has no parameter '${a.name.name}'.`
        );
        lowerExpr(el, ctx, a.value);
        ok = false;
        continue;
      }
    } else {
      idx = positional++;
      if (idx >= params.length) {
        el.report(
          ctx,
          a.span,
          "wrong-argument-count",
          `${what} takes ${params.length} argument${params.length === 1 ? "" : "s"}, but more were given.`
        );
        lowerExpr(el, ctx, a.value);
        ok = false;
        continue;
      }
    }
    if (out[idx]) {
      el.report(
        ctx,
        a.span,
        "duplicate-argument",
        `Parameter '${params[idx]!.name}' is given twice.`
      );
      ok = false;
      continue;
    }
    const p = params[idx]!;
    const v = lowerExpr(el, ctx, a.value, p.type);
    out[idx] = coerce(el, ctx, v, p.type, a.value, `Argument '${p.name}'`);
    if (isError(out[idx]!)) ok = false;
  }
  for (let i = 0; i < params.length; i++) {
    if (out[i]) continue;
    const p = params[i]!;
    if (p.defaultValue) out[i] = p.defaultValue();
    else if (!p.optional) {
      el.report(ctx, span, "wrong-argument-count", `${what} is missing argument '${p.name}'.`);
      ok = false;
    }
  }
  if (!ok) return undefined;
  return out.filter((x): x is IrExpr => !!x);
}

function fieldArg(
  el: Elaborator,
  ctx: Ctx,
  e: A.CallExpr,
  fn: string
): { expr: IrExpr; sym?: FieldSym } | undefined {
  if (e.args.length !== 1) {
    el.report(ctx, e.argsSpan, "wrong-argument-count", `${fn}() takes exactly one field.`);
    return undefined;
  }
  const a = unparen(e.args[0]!.value);
  if (a.kind !== "Name") {
    el.report(ctx, a.span, "type-mismatch", `${fn}() takes a field name of the current struct.`);
    return undefined;
  }
  // `this`: the current struct
  if (a.name === "this" && ctx.struct && !ctx.struct.fieldsByName.has("this")) {
    if (fn === "sizeof" && ctx.side === "read") {
      el.report(
        ctx,
        a.span,
        "self-reference",
        "sizeof(this) is only known when writing; it can't be used while reading the struct."
      );
      return undefined;
    }
    return { expr: { kind: "this", type: { kind: "struct", struct: el.currentStructId(ctx) } } };
  }
  if (a.name === "this") {
    el.report(ctx, a.span, "unknown-name", "`this` is only available inside a struct.");
    return undefined;
  }
  const res = el.lookupValue(ctx, a.name, a.span);
  if (res.kind !== "field") {
    if (res.kind === "none") el.report(ctx, a.span, "unknown-name", `Unknown field '${a.name}'.`);
    else el.report(ctx, a.span, "type-mismatch", `${fn}() takes a field of the current struct.`);
    return undefined;
  }
  const expr = lowerFieldRef(el, ctx, res.syms, a.span, a.name);
  if (isError(expr)) return undefined;
  if (ctx.record) el.model.exprTypes.set(a, expr.type);
  return { expr, sym: res.syms[0]! };
}

function lowerBuiltinCall(
  el: Elaborator,
  ctx: Ctx,
  name: string,
  e: A.CallExpr,
  expected?: IrValueType
): IrExpr {
  const call = builtinCall;
  /** The only argument, lowered (undefined after reporting a wrong count or a type error). */
  const single = (): { expr: IrExpr; node: A.Expr } | undefined => {
    if (e.args.length !== 1) {
      el.report(ctx, e.argsSpan, "wrong-argument-count", `${name}() takes one argument.`);
      return undefined;
    }
    const node = e.args[0]!.value;
    const expr = lowerExpr(el, ctx, node);
    return isError(expr) ? undefined : { expr, node };
  };
  switch (name) {
    case "sizeof":
      return lowerSizeof(el, ctx, e);
    case "offsetof":
    case "bytesof":
    case "encode": {
      if (ctx.side === "const") {
        el.report(ctx, e.span, "not-constant", `${name}() isn't a constant.`);
        return errorExpr();
      }
      const f = fieldArg(el, ctx, e, name);
      if (!f) return errorExpr();
      return call(name, [f.expr], name === "offsetof" ? BIGINT : BYTES);
    }
    case "crc32":
    case "adler32": {
      const arg = single();
      if (!arg) return errorExpr();
      const a = arg.expr;
      if (a.type.kind === "bytes") return call(name, [a], U32);
      if (a.kind === "field") return call(name, [call("bytesof", [a], BYTES)], U32);
      el.report(
        ctx,
        arg.node.span,
        "type-mismatch",
        a.type.kind === "string"
          ? `${name}() needs bytes; pass the string field itself to checksum its encoding.`
          : `${name}() needs bytes or a field, but this is ${displayValueType(a.type, el.displayName)}.`
      );
      return errorExpr();
    }
    case "sum":
    case "min":
    case "max":
      return lowerAggregate(el, ctx, name, e, expected);
    case "map":
    case "filter":
    case "indicesWhere":
    case "sortedBy":
    case "unique":
    case "concat":
      return lowerDerivedArray(el, ctx, name, e);
    case "abs": {
      const arg = single();
      if (!arg) return errorExpr();
      const a = arg.expr;
      if (!isNumericType(a.type)) {
        el.report(
          ctx,
          arg.node.span,
          "type-mismatch",
          `abs() takes a number, but this is ${displayValueType(a.type, el.displayName)}.`
        );
        return errorExpr();
      }
      const rt = a.type.kind === "float" ? a.type : BIGINT;
      const v = literalInt(a);
      if (v !== undefined) return intLit(v < 0n ? -v : v);
      return call("abs", [convertTo(a, rt)], rt);
    }
    case "round": {
      const arg = single();
      if (!arg) return errorExpr();
      const a = arg.expr;
      if (isIntType(a.type)) return a;
      if (a.type.kind !== "float") {
        el.report(
          ctx,
          arg.node.span,
          "type-mismatch",
          `round() takes a number, but this is ${displayValueType(a.type, el.displayName)}.`
        );
        return errorExpr();
      }
      const n = literalNumber(a);
      if (n !== undefined && a.kind === "literal") return intLit(BigInt(roundHalfAway(n)));
      return call("round", [a], BIGINT);
    }
  }
  return errorExpr();
}

/** `sizeof(Type)` (a constant when the size is static) or `sizeof(field)`. */
function lowerSizeof(el: Elaborator, ctx: Ctx, e: A.CallExpr): IrExpr {
  if (e.args.length === 1) {
    const a = unparen(e.args[0]!.value);
    if (a.kind === "Name") {
      const res = el.lookupValue(ctx, a.name, a.span);
      if (res.kind !== "field") {
        const size = el.staticSizeOfNamedType(ctx, a);
        if (size !== undefined) return intLit(size);
        if (res.kind === "none" && el.isTypeName(ctx, a.name)) {
          el.report(ctx, a.span, "not-constant", `'${a.name}' has no static size.`);
          return errorExpr();
        }
      }
    }
  }
  if (ctx.side === "const") {
    el.report(ctx, e.span, "not-constant", "sizeof(field) isn't a constant.");
    return errorExpr();
  }
  const f = fieldArg(el, ctx, e, "sizeof");
  return f ? builtinCall("sizeof", [f.expr], BIGINT) : errorExpr();
}

/** `sum`, `min` and `max` of one array, or `min`/`max` of several numbers. */
function lowerAggregate(
  el: Elaborator,
  ctx: Ctx,
  name: "sum" | "min" | "max",
  e: A.CallExpr,
  expected: IrValueType | undefined
): IrExpr {
  // aggregate form over an array (`max(probes[*].total)`)
  if (e.args.length === 1 || name === "sum") {
    if (e.args.length !== 1) {
      el.report(
        ctx,
        e.argsSpan,
        "wrong-argument-count",
        `${name}() takes one array (e.g. ${name}(items[*].size)).`
      );
      return errorExpr();
    }
    const arr = lowerExpr(el, ctx, e.args[0]!.value);
    if (isError(arr)) return errorExpr();
    const at = arr.type.kind === "nullable" ? arr.type.inner : arr.type;
    const elem = at.kind === "array" ? at.element : at.kind === "bytes" ? U8 : undefined;
    if (!elem || !isNumericType(elem)) {
      el.report(
        ctx,
        e.args[0]!.value.span,
        "type-mismatch",
        `${name}() of one argument takes an array of numbers, but this is ${displayValueType(arr.type, el.displayName)}.`
      );
      return errorExpr();
    }
    const rt = name === "sum" ? (elem.kind === "float" ? F64 : BIGINT) : elem;
    return builtinCall(name, [arr], rt);
  }
  let args = e.args.map(a => lowerExpr(el, ctx, a.value, expected));
  if (args.some(isError)) return errorExpr();
  let t: IrValueType | undefined = args[0]!.type;
  for (const [i, a] of args.entries()) {
    if (!isNumericType(a.type)) {
      el.report(
        ctx,
        e.args[i]!.value.span,
        "type-mismatch",
        `${name}() takes numbers, but this is ${displayValueType(a.type, el.displayName)}.`
      );
      return errorExpr();
    }
    t = t && unify(t, a.type);
  }
  const rt = t ?? BIGINT;
  args = args.map(a => convertTo(a, rt));
  const lits = args.map(literalInt);
  if (lits.every(v => v !== undefined) && rt.kind !== "float") {
    const vs = lits as bigint[];
    return intLit(
      vs.reduce((m, v) => (name === "min" ? (v < m ? v : m) : v > m ? v : m)),
      rt
    );
  }
  return builtinCall(name, args, rt);
}

function builtinCall(fn: IrBuiltinFn, args: IrExpr[], type: IrValueType): IrExpr {
  return { kind: "call", callee: { kind: "builtin", name: fn }, args, type };
}

function roundHalfAway(n: number): number {
  return n < 0 ? -Math.round(-n) : Math.round(n);
}

// ── derived arrays ───────────────────────────────────────────────────────────

/** Element type of an array-like value: arrays, bytes (u8) and nullable arrays. */
function elementTypeOf(t: IrValueType): IrValueType | undefined {
  if (t.kind === "nullable") t = t.inner;
  if (t.kind === "array") return t.element;
  if (t.kind === "bytes") return U8;
  return undefined;
}

/** The array type itself (nullable unwrapped), if array-like. */
function arrayTypeOf(t: IrValueType): IrValueType | undefined {
  if (t.kind === "nullable") t = t.inner;
  return t.kind === "array" || t.kind === "bytes" ? t : undefined;
}

/** Can a sort key of this type be compared (numbers, strings by code points, bytes)? */
function sortableKey(t: IrValueType): boolean {
  if (t.kind === "extern") return sortableKey(t.valueType);
  return isNumericType(t) || t.kind === "string" || t.kind === "bytes" || isErrorType(t);
}

/**
 * `map(arr, x => e)`, `filter(arr, x => b)`, `indicesWhere(arr, x => b)`, `sortedBy(arr, x => k)`,
 * `unique(arr)` and `concat(a, b, …)`. Lambdas are typed with the array's element type.
 */
function lowerDerivedArray(el: Elaborator, ctx: Ctx, name: string, e: A.CallExpr): IrExpr {
  const call = (args: IrExpr[], type: IrValueType): IrExpr => ({
    kind: "call",
    callee: { kind: "builtin", name: name as IrBuiltinFn },
    args,
    type
  });
  for (const a of e.args) {
    if (a.name) {
      el.report(ctx, a.name.span, "unknown-argument", `${name}() takes positional arguments only.`);
      return errorExpr();
    }
  }
  const lowerArray = (
    a: A.Arg
  ): { expr: IrExpr; array: IrValueType; elem: IrValueType } | undefined => {
    const x = lowerExpr(el, ctx, a.value);
    if (isError(x)) return undefined;
    const array = arrayTypeOf(x.type);
    const elem = elementTypeOf(x.type);
    if (!array || !elem) {
      el.report(
        ctx,
        a.value.span,
        "type-mismatch",
        `${name}() needs an array, but this is ${displayValueType(x.type, el.displayName)}.`
      );
      return undefined;
    }
    return { expr: x, array, elem };
  };
  if (name === "unique") {
    if (e.args.length !== 1) {
      el.report(ctx, e.argsSpan, "wrong-argument-count", "unique() takes one array.");
      for (const a of e.args) lowerExpr(el, ctx, a.value);
      return errorExpr();
    }
    const a = lowerArray(e.args[0]!);
    return a ? call([a.expr], a.array) : errorExpr();
  }
  if (name === "concat") {
    if (e.args.length === 0) {
      el.report(ctx, e.argsSpan, "wrong-argument-count", "concat() takes one or more arrays.");
      return errorExpr();
    }
    const parts = e.args.map(lowerArray);
    if (parts.some(p => !p)) return errorExpr();
    const ps = parts as { expr: IrExpr; array: IrValueType; elem: IrValueType }[];
    if (ps.every(p => p.array.kind === "bytes"))
      return call(
        ps.map(p => p.expr),
        BYTES
      );
    let elem: IrValueType | undefined = ps[0]!.elem;
    for (const [i, p] of ps.entries()) {
      const u: IrValueType | undefined = elem && unify(elem, p.elem);
      if (!u || (u.kind === "struct" && !sameValueType(u, p.elem))) {
        el.report(
          ctx,
          e.args[i]!.value.span,
          "type-mismatch",
          `concat() joins arrays of one element type: ${displayValueType(ps[0]!.elem, el.displayName)} and ${displayValueType(p.elem, el.displayName)} differ.`
        );
        return errorExpr();
      }
      elem = u;
    }
    return call(
      ps.map(p => p.expr),
      { kind: "array", element: elem! }
    );
  }
  // map / filter / indicesWhere / sortedBy: (array, x => body)
  if (e.args.length !== 2) {
    el.report(
      ctx,
      e.argsSpan,
      "wrong-argument-count",
      `${name}() takes an array and a lambda: ${BUILTIN_FUNCTIONS[name]!.signature.replace(/ ->.*/, "")}.`
    );
    for (const a of e.args) if (unparen(a.value).kind !== "Lambda") lowerExpr(el, ctx, a.value);
    return errorExpr();
  }
  const arr = lowerArray(e.args[0]!);
  const fnNode = unparen(e.args[1]!.value);
  if (fnNode.kind !== "Lambda") {
    el.report(
      ctx,
      e.args[1]!.value.span,
      "invalid-lambda",
      `The second argument of ${name}() is a lambda, e.g. \`${name}(${printExpr(e.args[0]!.value)}, x => ${name === "map" ? "x.value" : name === "sortedBy" ? "x.name" : "x.size > 0"})\`.`
    );
    lowerExpr(el, { ...ctx, report: false }, e.args[1]!.value);
    return errorExpr();
  }
  const elem = arr?.elem ?? ERROR_TYPE;
  const pname = fnNode.param.name;
  const sym: LambdaParamSym = {
    kind: "lambdaParam",
    name: pname,
    nameSpan: fnNode.param.span,
    module: ctx.module,
    detail: `element of ${printExpr(e.args[0]!.value)}`,
    type: elem
  };
  // (the parameter may shadow a field: `indicesWhere(records, r => …)` next to a count `r`)
  el.recordRef(ctx, fnNode.param.span, sym, true);
  const lctx: Ctx = {
    ...ctx,
    lambdas: new Map([...ctx.lambdas, [pname, elem]]),
    lambdaSyms: new Map([...(ctx.lambdaSyms ?? []), [pname, sym]])
  };
  const wantBool = name === "filter" || name === "indicesWhere";
  const body = lowerExpr(el, lctx, fnNode.body, wantBool ? BOOL : undefined);
  if (ctx.record) el.model.exprTypes.set(fnNode, elem);
  if (!arr || isError(body)) return errorExpr();
  if (wantBool && body.type.kind !== "bool") {
    el.report(
      ctx,
      fnNode.body.span,
      "type-mismatch",
      `The condition of ${name}() must be bool, but this is ${displayValueType(body.type, el.displayName)}.`
    );
    return errorExpr();
  }
  if (name === "sortedBy" && !sortableKey(body.type)) {
    el.report(
      ctx,
      fnNode.body.span,
      "type-mismatch",
      `sortedBy() keys are numbers, strings or bytes, but this is ${displayValueType(body.type, el.displayName)}.`
    );
    return errorExpr();
  }
  const lambda: IrExpr = { kind: "lambda", param: pname, body, type: elem };
  switch (name) {
    case "map":
      return call([arr.expr, lambda], { kind: "array", element: body.type });
    case "indicesWhere":
      return call([arr.expr, lambda], { kind: "array", element: BIGINT });
    default:
      return call([arr.expr, lambda], arr.array);
  }
}

// ── operators ────────────────────────────────────────────────────────────────

function lowerUnary(el: Elaborator, ctx: Ctx, e: A.UnaryExpr, expected?: IrValueType): IrExpr {
  const operand = lowerExpr(
    el,
    ctx,
    e.operand,
    e.op === "!" ? BOOL : expected?.kind === "float" ? expected : undefined
  );
  if (isError(operand)) return errorExpr();
  if (e.op === "!") {
    if (operand.type.kind !== "bool") {
      el.report(
        ctx,
        e.operand.span,
        "type-mismatch",
        `'!' needs a bool, but this is ${displayValueType(operand.type, el.displayName)}.`
      );
      return errorExpr();
    }
    if (operand.kind === "literal" && operand.value.kind === "bool")
      return boolLit(!operand.value.value);
    return { kind: "unary", op: "!", operand, type: BOOL };
  }
  if (!isNumericType(operand.type)) {
    el.report(
      ctx,
      e.operand.span,
      "type-mismatch",
      `'${e.op}' needs a number, but this is ${displayValueType(operand.type, el.displayName)}.`
    );
    return errorExpr();
  }
  if (e.op === "+") return operand;
  if (e.op === "~" && operand.type.kind === "float") {
    el.report(ctx, e.operand.span, "type-mismatch", "'~' needs an integer.");
    return errorExpr();
  }
  if (operand.type.kind === "float") {
    const n = literalNumber(operand);
    if (n !== undefined && operand.kind === "literal")
      return lit({ kind: "float", value: -n }, operand.type);
    return { kind: "unary", op: "-", operand, type: operand.type };
  }
  const v = literalInt(operand);
  if (v !== undefined) return intLit(e.op === "-" ? -v : ~v);
  return { kind: "unary", op: e.op, operand: convertTo(operand, BIGINT), type: BIGINT };
}

const COMPARE = new Set(["==", "!=", "<", "<=", ">", ">="]);

function isLiteralish(e: A.Expr): boolean {
  const u = unparen(e);
  return (
    u.kind === "Int" ||
    u.kind === "Float" ||
    u.kind === "FourCC" ||
    (u.kind === "Unary" &&
      (unparen(u.operand).kind === "Int" || unparen(u.operand).kind === "Float")) ||
    u.kind === "Name"
  );
}

function lowerBinary(el: Elaborator, ctx: Ctx, e: A.BinaryExpr, expected?: IrValueType): IrExpr {
  const op = e.op;
  if (op === "&&" || op === "||") {
    const l = lowerExpr(el, ctx, e.left, BOOL);
    const rctx: Ctx =
      op === "&&" ? { ...ctx, guards: [...ctx.guards, { expr: e.left, positive: true }] } : ctx;
    const r = lowerExpr(el, rctx, e.right, BOOL);
    if (isError(l) || isError(r)) return errorExpr();
    for (const [x, node] of [
      [l, e.left],
      [r, e.right]
    ] as const) {
      if (x.type.kind !== "bool") {
        el.report(
          ctx,
          node.span,
          "type-mismatch",
          `'${op}' needs bool operands, but this is ${displayValueType(x.type, el.displayName)}.`
        );
        return errorExpr();
      }
    }
    if (l.kind === "literal" && l.value.kind === "bool") {
      if (op === "&&") return l.value.value ? r : l;
      return l.value.value ? l : r;
    }
    return { kind: "binary", op, left: l, right: r, type: BOOL };
  }
  if (COMPARE.has(op)) return lowerComparison(el, ctx, e);
  const wantFloat = expected?.kind === "float";
  const l = lowerExpr(el, ctx, e.left, wantFloat ? expected : undefined);
  const r = lowerExpr(el, ctx, e.right, wantFloat ? expected : undefined);
  if (isError(l) || isError(r)) return errorExpr();
  for (const [x, node] of [
    [l, e.left],
    [r, e.right]
  ] as const) {
    if (!isNumericType(x.type)) {
      el.report(
        ctx,
        node.span,
        "type-mismatch",
        `'${op}' needs numbers, but this is ${displayValueType(x.type, el.displayName)}.`
      );
      return errorExpr();
    }
  }
  const isFloat = l.type.kind === "float" || r.type.kind === "float";
  if (isFloat && ["<<", ">>", "&", "|", "^", "%"].includes(op)) {
    el.report(ctx, e.opSpan, "type-mismatch", `'${op}' needs integers.`);
    return errorExpr();
  }
  const t = isFloat ? F64 : BIGINT;
  const left = convertTo(l, t);
  const right = convertTo(r, t);
  return foldBinary(el, ctx, op, left, right, t, e);
}

export function foldBinary(
  el: Elaborator | undefined,
  ctx: Ctx | undefined,
  op: IrBinaryOp,
  left: IrExpr,
  right: IrExpr,
  t: IrValueType,
  node?: A.BinaryExpr
): IrExpr {
  if (t.kind === "bigint") {
    const a = literalInt(left);
    const b = literalInt(right);
    if (a !== undefined && b !== undefined) {
      const v = evalIntOp(op, a, b);
      if (v === "div0") {
        if (el && ctx && node) el.report(ctx, node.span, "division-by-zero", "Division by zero.");
        return errorExpr();
      }
      if (v === "shift") {
        if (el && ctx && node)
          el.report(ctx, node.span, "value-out-of-range", "Shift count must be 0..63.");
        return errorExpr();
      }
      if (typeof v === "bigint") return intLit(v);
    }
  } else if (t.kind === "float") {
    const a = left.kind === "literal" ? literalNumber(left) : undefined;
    const b = right.kind === "literal" ? literalNumber(right) : undefined;
    if (a !== undefined && b !== undefined) {
      const v =
        op === "+"
          ? a + b
          : op === "-"
            ? a - b
            : op === "*"
              ? a * b
              : op === "/"
                ? a / b
                : undefined;
      if (v !== undefined) return lit({ kind: "float", value: v }, t);
    }
  }
  return { kind: "binary", op, left, right, type: t };
}

export function evalIntOp(
  op: IrBinaryOp,
  a: bigint,
  b: bigint
): bigint | boolean | "div0" | "shift" {
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return b === 0n ? "div0" : a / b;
    case "%":
      return b === 0n ? "div0" : a % b;
    case "<<":
      return b < 0n || b > 63n ? "shift" : a << b;
    case ">>":
      return b < 0n || b > 63n ? "shift" : a >> b;
    case "&":
      return BigInt.asIntN(64, a) & BigInt.asIntN(64, b);
    case "|":
      return BigInt.asIntN(64, a) | BigInt.asIntN(64, b);
    case "^":
      return BigInt.asIntN(64, a) ^ BigInt.asIntN(64, b);
    case "==":
      return a === b;
    case "!=":
      return a !== b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    default:
      return false;
  }
}

/** Endianness of an expression that reads a primitive field directly. */
function exprEndian(ctx: Ctx, e: IrExpr): IrEndianSpec | undefined {
  let f: FieldSym | undefined;
  if (e.kind === "field") f = ctx.struct?.fieldsByName.get(e.name)?.[0];
  else if (e.kind === "it") f = ctx.self;
  const t = f && ctx.fieldTypes.get(f)?.ir;
  return t && primEndian(t);
}

function primEndian(t: IrType): IrEndianSpec | undefined {
  const core = coreType(t);
  return core.kind === "prim" || core.kind === "enum" ? core.endian : undefined;
}

/** `null` written as a value (no field, parameter or declaration has that name). */
function isNullWord(el: Elaborator, ctx: Ctx, e: A.Expr): boolean {
  const u = unparen(e);
  return (
    u.kind === "Name" && u.name === "null" && el.lookupValue(ctx, "null", u.span).kind === "none"
  );
}

/** `x == null` → `isNull(x)`, `x != null` → `!isNull(x)`. */
function lowerNullComparison(el: Elaborator, ctx: Ctx, e: A.BinaryExpr): IrExpr {
  const leftNull = isNullWord(el, ctx, e.left);
  const other = leftNull ? e.right : e.left;
  if (e.op !== "==" && e.op !== "!=") {
    el.report(ctx, e.opSpan, "type-mismatch", `'${e.op}' can't compare with null; use == or !=.`);
    return errorExpr();
  }
  if (isNullWord(el, ctx, other)) return boolLit(e.op === "==");
  const x = lowerExpr(el, ctx, other);
  if (isError(x)) return errorExpr();
  if (x.type.kind !== "nullable") {
    el.report(
      ctx,
      other.span,
      "type-mismatch",
      `This is ${displayValueType(x.type, el.displayName)}, which is never null: only @nullable pointers can be.`
    );
    return errorExpr();
  }
  const test: IrExpr = {
    kind: "call",
    callee: { kind: "builtin", name: "isNull" },
    args: [x],
    type: BOOL
  };
  return e.op === "==" ? test : { kind: "unary", op: "!", operand: test, type: BOOL };
}

/** Values compared element-wise / structurally by `==` and `!=`. */
function equalityComparable(a: IrValueType, b: IrValueType): boolean {
  if (isErrorType(a) || isErrorType(b)) return true;
  if (a.kind === "extern") return equalityComparable(a.valueType, b);
  if (b.kind === "extern") return equalityComparable(a, b.valueType);
  if (isNumericType(a) && isNumericType(b)) return true;
  if (a.kind === "nullable" && b.kind === "nullable") return equalityComparable(a.inner, b.inner);
  const ea = a.kind === "bytes" ? U8 : a.kind === "array" ? a.element : undefined;
  const eb = b.kind === "bytes" ? U8 : b.kind === "array" ? b.element : undefined;
  if (ea && eb) return equalityComparable(ea, eb);
  if (a.kind === "struct" && b.kind === "struct") return a.struct === b.struct;
  if (a.kind === "union" && b.kind === "union") return sameValueType(a, b);
  if (a.kind === "enum" && b.kind === "enum") return a.enum === b.enum;
  return a.kind === b.kind && ["string", "bool", "endian"].includes(a.kind);
}

function lowerComparison(el: Elaborator, ctx: Ctx, e: A.BinaryExpr): IrExpr {
  const op = e.op;
  if (isNullWord(el, ctx, e.left) || isNullWord(el, ctx, e.right))
    return lowerNullComparison(el, ctx, e);
  let l: IrExpr;
  let r: IrExpr;
  // Lower the non-literal side first so literals get its type (and enum context for bare members).
  if (isLiteralish(e.left) && !isLiteralish(e.right)) {
    r = lowerExpr(el, ctx, e.right);
    l = lowerOperandIn(el, ctx, e.left, r);
  } else {
    l = lowerExpr(el, ctx, e.left);
    r = lowerOperandIn(el, ctx, e.right, l);
  }
  if (isError(l) || isError(r)) return errorExpr();
  const ordered = op !== "==" && op !== "!=";
  if (isNumericType(l.type) && isNumericType(r.type)) {
    if (l.type.kind === "float" || r.type.kind === "float") {
      l = convertTo(l, F64);
      r = convertTo(r, F64);
    } else if (!sameValueType(l.type, r.type)) {
      // compare mathematical values: literals adopt the other side's type when they fit
      const lv = literalInt(l);
      const rv = literalInt(r);
      if (rv !== undefined && l.type.kind === "int" && fitsInt(rv, l.type)) r = intLit(rv, l.type);
      else if (lv !== undefined && r.type.kind === "int" && fitsInt(lv, r.type))
        l = intLit(lv, r.type);
      else {
        l = convertTo(l, BIGINT);
        r = convertTo(r, BIGINT);
      }
    }
    const a = literalInt(l);
    const b = literalInt(r);
    if (a !== undefined && b !== undefined) return boolLit(evalIntOp(op, a, b) as boolean);
    return { kind: "binary", op, left: l, right: r, type: BOOL };
  }
  const lt = l.type.kind === "extern" ? l.type.valueType : l.type;
  const rt = r.type.kind === "extern" ? r.type.valueType : r.type;
  const scalarSame =
    (lt.kind === rt.kind && ["string", "bytes", "bool", "endian"].includes(lt.kind)) ||
    (lt.kind === "enum" && rt.kind === "enum" && lt.enum === rt.enum);
  // arrays, bytes vs integer arrays, structs: by value
  const composite = !scalarSame && !ordered && equalityComparable(lt, rt);
  const same = scalarSame || composite;
  if (!same) {
    el.report(
      ctx,
      e.span,
      "type-mismatch",
      `Can't compare ${displayValueType(l.type, el.displayName)} with ${displayValueType(r.type, el.displayName)}.`
    );
    return errorExpr();
  }
  if (ordered && lt.kind !== "string") {
    el.report(ctx, e.opSpan, "type-mismatch", `'${op}' needs numbers or strings.`);
    return errorExpr();
  }
  if (l.kind === "literal" && r.kind === "literal" && (op === "==" || op === "!=")) {
    const eq = JSON.stringify(l.value) === JSON.stringify(r.value);
    return boolLit(op === "==" ? eq : !eq);
  }
  return { kind: "binary", op, left: l, right: r, type: BOOL };
}

/** Lowers an operand compared with `other`: literals and bare enum members take its type. */
export function lowerOperandIn(el: Elaborator, ctx: Ctx, e: A.Expr, other: IrExpr): IrExpr {
  const u = unparen(e);
  if (u.kind === "Name" && other.type.kind === "enum") {
    const res = el.lookupValue(ctx, u.name, u.span);
    if (res.kind === "none" || (res.kind === "decl" && res.sym.kind !== "const")) {
      const m = el.enumMemberById(other.type.enum, u.name);
      if (m) {
        el.recordRef(ctx, u.span, m);
        return lit({ kind: "enum", enum: other.type.enum, member: m.name }, other.type);
      }
    }
  }
  if (u.kind === "Int" && other.type.kind === "enum") {
    el.report(
      ctx,
      u.span,
      "type-mismatch",
      `Compare enums with members (e.g. ${el.displayName(other.type.enum)}.${el.enumMemberNames(other.type.enum)[0] ?? "Name"}), not numbers.`
    );
    return errorExpr();
  }
  const hint: ExprHint = {};
  const end = exprEndian(ctx, other);
  if (end) hint.endian = end;
  return lowerExpr(
    el,
    ctx,
    e,
    other.type.kind === "int" || other.type.kind === "float" || other.type.kind === "enum"
      ? other.type
      : other.type.kind === "string" || other.type.kind === "bytes"
        ? other.type
        : undefined,
    hint
  );
}

function lowerFourCC(
  el: Elaborator,
  ctx: Ctx,
  e: A.FourCCLit,
  expected: IrValueType | undefined,
  hint: ExprHint
): IrExpr {
  const bytes = [...e.value].map(c => c.charCodeAt(0) & 0xff);
  if (expected && expected.kind === "int") {
    const n = expected.bits / 8;
    if (bytes.length !== n) {
      el.report(
        ctx,
        e.span,
        "fourcc-size",
        `'${e.value}' has ${bytes.length} characters but is compared with a ${n}-byte integer.`
      );
      return errorExpr();
    }
    let le = 0n;
    let be = 0n;
    bytes.forEach((b, i) => {
      le |= BigInt(b) << BigInt(8 * i);
      be = (be << 8n) | BigInt(b);
    });
    if (expected.signed) {
      le = BigInt.asIntN(expected.bits, le);
      be = BigInt.asIntN(expected.bits, be);
    }
    const endian = hint.endian ?? "inherit";
    if (endian === "le") return intLit(le, expected);
    if (endian === "be") return intLit(be, expected);
    if (le === be) return intLit(le, expected);
    return {
      kind: "cond",
      test: {
        kind: "binary",
        op: "==",
        left: { kind: "param", name: "endian", type: ENDIAN },
        right: lit({ kind: "endian", value: "be" }, ENDIAN),
        type: BOOL
      },
      then: intLit(be, expected),
      else: intLit(le, expected),
      type: expected
    };
  }
  if (expected && expected.kind === "bytes")
    return lit({ kind: "bytes", hex: Buffer.from(bytes).toString("hex") }, BYTES);
  return lit({ kind: "string", value: e.value }, STRING);
}

export function lowerInItems(el: Elaborator, ctx: Ctx, value: IrExpr, items: A.InItem[]): IrExpr {
  if (isError(value)) {
    for (const it of items) {
      if (it.kind === "InValue") lowerExpr(el, ctx, it.value);
    }
    return errorExpr();
  }
  const out: ({ kind: "value"; value: IrExpr } | { kind: "range"; low: IrExpr; high: IrExpr })[] =
    [];
  let ok = true;
  for (const it of items) {
    if (it.kind === "InValue") {
      const v = lowerOperandIn(el, ctx, it.value, value);
      if (isError(v)) {
        ok = false;
        continue;
      }
      if (!comparable(value.type, v.type)) {
        el.report(
          ctx,
          it.value.span,
          "type-mismatch",
          `This ${displayValueType(v.type, el.displayName)} can never equal a ${displayValueType(value.type, el.displayName)}.`
        );
        ok = false;
        continue;
      }
      out.push({ kind: "value", value: matchNumeric(v, value.type) });
    } else {
      if (!isNumericType(value.type)) {
        el.report(ctx, it.span, "type-mismatch", "Ranges need a numeric value.");
        ok = false;
        continue;
      }
      const lo = lowerOperandIn(el, ctx, it.low, value);
      const hi = lowerOperandIn(el, ctx, it.high, value);
      if (isError(lo) || isError(hi)) {
        ok = false;
        continue;
      }
      out.push({
        kind: "range",
        low: matchNumeric(lo, value.type),
        high: matchNumeric(hi, value.type)
      });
    }
  }
  if (!ok) return errorExpr();
  let v = value;
  if (
    isNumericType(value.type) &&
    out.some(o =>
      o.kind === "value"
        ? !sameValueType(o.value.type, value.type)
        : !sameValueType(o.low.type, value.type) || !sameValueType(o.high.type, value.type)
    )
  ) {
    const t =
      value.type.kind === "float" ||
      out.some(o =>
        o.kind === "value" ? o.value.type.kind === "float" : o.low.type.kind === "float"
      )
        ? F64
        : BIGINT;
    v = convertTo(value, t);
    for (const o of out) {
      if (o.kind === "value") o.value = convertTo(o.value, t);
      else {
        o.low = convertTo(o.low, t);
        o.high = convertTo(o.high, t);
      }
    }
  }
  return { kind: "in", value: v, items: out, type: { kind: "bool" } };
}

function matchNumeric(v: IrExpr, t: IrValueType): IrExpr {
  const n = literalInt(v);
  if (n !== undefined && t.kind === "int" && fitsInt(n, t)) return intLit(n, t);
  return v;
}

function comparable(a: IrValueType, b: IrValueType): boolean {
  if (isErrorType(a) || isErrorType(b)) return true;
  if (isNumericType(a) && isNumericType(b)) return true;
  if (a.kind === "extern") return comparable(a.valueType, b);
  if (a.kind === "enum" && b.kind === "enum") return a.enum === b.enum;
  return a.kind === b.kind;
}

export function lowerRegex(
  el: Elaborator,
  ctx: Ctx,
  value: IrExpr,
  regex: A.RegexLit,
  valueNode: A.Expr | undefined
): IrExpr {
  if (isError(value)) return errorExpr();
  if (value.type.kind !== "string") {
    el.report(
      ctx,
      valueNode?.span ?? regex.span,
      "type-mismatch",
      `Regex matching needs a string, but this is ${displayValueType(value.type, el.displayName)}.`
    );
    return errorExpr();
  }
  const problem = validateRegex(regex.pattern);
  if (problem) {
    el.report(ctx, regex.span, "invalid-regex", problem);
    return errorExpr();
  }
  return { kind: "regex", value, pattern: regex.pattern, type: { kind: "bool" } };
}

/** Checks the portable RE2-style subset: no backreferences, no lookaround, valid syntax. */
function validateRegex(pattern: string): string | undefined {
  if (/\\[1-9]/.test(pattern.replace(/\\\\/g, "")))
    return "Backreferences aren't portable (RE2 subset).";
  if (/\\k</.test(pattern)) return "Named backreferences aren't portable (RE2 subset).";
  if (/\(\?[=!]|\(\?<[=!]/.test(pattern)) return "Lookaround isn't portable (RE2 subset).";
  if (/[*+?}]\+/.test(pattern.replace(/\\./g, "")))
    return "Possessive quantifiers aren't portable (RE2 subset).";
  try {
    new RegExp(pattern, "u");
  } catch (err) {
    return `Invalid regex: ${(err as Error).message.replace(/^Invalid regular expression: /, "")}`;
  }
  return undefined;
}
