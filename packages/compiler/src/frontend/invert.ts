/**
 * Derivation helpers over IR expressions:
 * - inverting `as` transforms (`it * 360.0 / 65536` ↔ `round(it * 65536 / 360.0)`, `names[it]` ↔
 *   `indexOf(names, it)`),
 * - linear analysis (`a·x + b`) for derived lengths, offsets and sizes,
 * - a small evaluator used to sample formulas against read-side expressions.
 */
import type { IrBinaryOp, IrExpr, IrValueType } from "../ir/index.ts";
import { containsIt, mapExpr, walkExpr } from "../ir/walk.ts";
import { convertTo, evalIntOp, foldBinary, intLit } from "./expr.ts";
import { BIGINT, F64, isIntType } from "./types.ts";

/** The operator undoing `x op k` (for `x` on the left). */
const INVERSE_OP: Partial<Record<IrBinaryOp, IrBinaryOp>> = {
  "+": "-",
  "-": "+",
  "*": "/",
  "/": "*",
  "<<": ">>",
  ">>": "<<",
  "^": "^"
};

function countIt(e: IrExpr): number {
  let n = 0;
  walkExpr(e, x => {
    if (x.kind === "it") n++;
  });
  return n;
}

function arith(op: IrBinaryOp, l: IrExpr, r: IrExpr): IrExpr {
  const t: IrValueType = l.type.kind === "float" || r.type.kind === "float" ? F64 : BIGINT;
  return foldBinary(undefined, undefined, op, convertTo(l, t), convertTo(r, t), t);
}

/**
 * Inverts a transform's read expression (which uses `it` exactly once). Returns the write
 * expression (in terms of `it` = the transformed value), or undefined if not invertible.
 */
export function invertTransform(
  read: IrExpr,
  innerValue: IrValueType,
  itType: IrValueType = read.type
): IrExpr | undefined {
  if (countIt(read) !== 1) return undefined;
  let v: IrExpr = { kind: "it", type: itType };
  let node = read;
  for (;;) {
    switch (node.kind) {
      case "it": {
        if (isIntType(innerValue) && v.type.kind === "float") {
          v = { kind: "call", callee: { kind: "builtin", name: "round" }, args: [v], type: BIGINT };
        }
        return v;
      }
      case "convert": {
        // int → float conversion on the read side: round on the way back
        if (node.type.kind === "float" && isIntType(node.operand.type)) {
          v = {
            kind: "call",
            callee: { kind: "builtin", name: "round" },
            args: [convertTo(v, F64)],
            type: BIGINT
          };
        }
        node = node.operand;
        continue;
      }
      case "unary": {
        if (node.op === "!") v = { kind: "unary", op: "!", operand: v, type: v.type };
        else if (node.op === "-")
          v =
            v.type.kind === "float"
              ? { kind: "unary", op: "-", operand: v, type: v.type }
              : { kind: "unary", op: "-", operand: convertTo(v, BIGINT), type: BIGINT };
        else v = { kind: "unary", op: "~", operand: convertTo(v, BIGINT), type: BIGINT };
        node = node.operand;
        continue;
      }
      case "binary": {
        const inLeft = containsIt(node.left);
        const other = inLeft ? node.right : node.left;
        const op = node.op;
        if (inLeft) {
          const inverse = INVERSE_OP[op];
          if (!inverse) return undefined;
          v = arith(inverse, v, other);
          node = node.left;
        } else {
          // k + x, k * x and k ^ x invert like x + k; k - x is the only asymmetric case
          if (op === "-") v = arith("-", other, v);
          else if (op === "+" || op === "*" || op === "^") v = arith(INVERSE_OP[op]!, v, other);
          else return undefined;
          node = node.right;
        }
        continue;
      }
      case "index": {
        if (containsIt(node.object) || !containsIt(node.index)) return undefined;
        v = {
          kind: "call",
          callee: { kind: "builtin", name: "indexOf" },
          args: [node.object, v],
          type: BIGINT
        };
        node = node.index;
        continue;
      }
      default:
        return undefined;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Linear analysis
// ─────────────────────────────────────────────────────────────────────────────

export interface Linear {
  /** Coefficient (non-zero when a variable is present). */
  a: bigint;
  b: bigint;
  /** The variable (a field expression), if any. */
  x?: IrExpr & { kind: "field" };
}

/**
 * Analyses `e` as `a·x + b` over a single field `x` with integer constants, using only
 * `+ − ×` and `<<` by constants. Returns undefined otherwise.
 */
export function linear(e: IrExpr): Linear | undefined {
  switch (e.kind) {
    case "literal":
      if (e.value.kind === "int") return { a: 0n, b: BigInt(e.value.value) };
      return undefined;
    case "field":
      if (!isIntType(e.type)) return undefined;
      return { a: 1n, b: 0n, x: e };
    case "convert":
      if (!isIntType(e.type) || !isIntType(e.operand.type)) return undefined;
      return linear(e.operand);
    case "unary": {
      if (e.op !== "-") return undefined;
      const o = linear(e.operand);
      return o && { ...o, a: -o.a, b: -o.b };
    }
    case "binary": {
      const l = linear(e.left);
      const r = linear(e.right);
      if (!l || !r) return undefined;
      const sameVar = (p: Linear, q: Linear) => !p.x || !q.x || p.x.name === q.x.name;
      switch (e.op) {
        case "+":
        case "-": {
          if (!sameVar(l, r)) return undefined;
          const s = e.op === "+" ? 1n : -1n;
          const x = l.x ?? r.x;
          const a = l.a + s * r.a;
          const res: Linear = { a, b: l.b + s * r.b };
          if (x && a !== 0n) res.x = x;
          return res;
        }
        case "*": {
          if (l.x && r.x) return undefined;
          const k = l.x ? r.b : l.b;
          const v = l.x ? l : r;
          if (!l.x && !r.x) return { a: 0n, b: l.b * r.b };
          if (k === 0n) return { a: 0n, b: 0n };
          return { ...v, a: v.a * k, b: v.b * k };
        }
        case "<<": {
          if (r.x || r.b < 0n || r.b > 63n) return undefined;
          const k = 1n << r.b;
          return { ...l, a: l.a * k, b: l.b * k };
        }
        default:
          return undefined;
      }
    }
    default:
      return undefined;
  }
}

/** Builds `(source - b) / a` for the inverse of a linear expression. */
export function invertLinear(lin: Linear, source: IrExpr): IrExpr {
  let v = source;
  if (lin.b !== 0n) {
    const op = lin.b > 0n ? "-" : "+";
    v = {
      kind: "binary",
      op,
      left: convertTo(v, BIGINT),
      right: intLit(lin.b > 0n ? lin.b : -lin.b),
      type: BIGINT
    };
  }
  if (lin.a === -1n) v = { kind: "unary", op: "-", operand: convertTo(v, BIGINT), type: BIGINT };
  else if (lin.a !== 1n)
    v = { kind: "binary", op: "/", left: convertTo(v, BIGINT), right: intLit(lin.a), type: BIGINT };
  return v;
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation (for sampling formulas against read-side expressions)
// ─────────────────────────────────────────────────────────────────────────────

export type EvalValue = bigint | number | boolean | undefined;

export interface EvalEnv {
  field?(name: string): EvalValue;
  call?(e: IrExpr & { kind: "call" }): EvalValue;
  it?: EvalValue;
}

export function evalIr(e: IrExpr, env: EvalEnv): EvalValue {
  switch (e.kind) {
    case "literal":
      if (e.value.kind === "int") return BigInt(e.value.value);
      if (e.value.kind === "float") return e.value.value;
      if (e.value.kind === "bool") return e.value.value;
      return undefined;
    case "field":
      return env.field?.(e.name);
    case "it":
      return env.it;
    case "convert": {
      const v = evalIr(e.operand, env);
      if (v === undefined) return undefined;
      if (e.type.kind === "float") return Number(v);
      if (typeof v === "number") return BigInt(Math.trunc(v));
      return v;
    }
    case "unary": {
      const v = evalIr(e.operand, env);
      if (v === undefined) return undefined;
      if (e.op === "!") return !v;
      if (typeof v === "number") return -v;
      if (typeof v === "bigint") return e.op === "-" ? -v : ~v;
      return undefined;
    }
    case "binary": {
      const l = evalIr(e.left, env);
      const r = evalIr(e.right, env);
      if (l === undefined || r === undefined) return undefined;
      if (typeof l === "bigint" && typeof r === "bigint") {
        const v = evalIntOp(e.op, l, r);
        return typeof v === "string" ? undefined : v;
      }
      if (typeof l === "boolean" && typeof r === "boolean") {
        if (e.op === "&&") return l && r;
        if (e.op === "||") return l || r;
        if (e.op === "==") return l === r;
        if (e.op === "!=") return l !== r;
        return undefined;
      }
      const a = Number(l);
      const b = Number(r);
      switch (e.op) {
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          return a / b;
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
          return undefined;
      }
    }
    case "cond": {
      const t = evalIr(e.test, env);
      if (t === undefined) return undefined;
      return evalIr(t ? e.then : e.else, env);
    }
    case "call": {
      if (e.callee.kind === "builtin") {
        const n = e.callee.name;
        if (n === "min" || n === "max") {
          const vs = e.args.map(a => evalIr(a, env));
          if (vs.some(v => v === undefined)) return undefined;
          return vs.reduce((m, v) =>
            (n === "min" ? Number(v) < Number(m) : Number(v) > Number(m)) ? v : m
          );
        }
        if (n === "round") {
          const v = evalIr(e.args[0]!, env);
          if (v === undefined) return undefined;
          const x = Number(v);
          return BigInt(x < 0 ? -Math.round(-x) : Math.round(x));
        }
        if (n === "abs") {
          const v = evalIr(e.args[0]!, env);
          if (typeof v === "bigint") return v < 0n ? -v : v;
          if (typeof v === "number") return Math.abs(v);
          return undefined;
        }
      }
      return env.call?.(e);
    }
    case "in": {
      const v = evalIr(e.value, env);
      if (v === undefined) return undefined;
      let unknown = false;
      for (const item of e.items) {
        if (item.kind === "value") {
          const x = evalIr(item.value, env);
          if (x === undefined) unknown = true;
          else if (x === v || (typeof x !== "boolean" && Number(x) === Number(v))) return true;
        } else {
          const lo = evalIr(item.low, env);
          const hi = evalIr(item.high, env);
          if (lo === undefined || hi === undefined) unknown = true;
          else if (Number(lo) <= Number(v) && Number(v) <= Number(hi)) return true;
        }
      }
      return unknown ? undefined : false;
    }
    default:
      return undefined;
  }
}

export function irEqual(a: IrExpr, b: IrExpr): boolean {
  return JSON.stringify(stripConverts(a)) === JSON.stringify(stripConverts(b));
}

function stripConverts(e: IrExpr): unknown {
  return JSON.parse(
    JSON.stringify(
      mapExpr(e, x =>
        x.kind === "convert" && isIntType(x.type) && isIntType(x.operand.type) ? x.operand : x
      ),
      (k, v) => (k === "type" ? undefined : v)
    )
  );
}
