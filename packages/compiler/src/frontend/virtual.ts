/**
 * Inverting virtual fields: `virtual u40 size = (sizeHigh << 32) | sizeLow`.
 *
 * The read expression is flattened into a sum of terms `field · multiplier` plus a constant,
 * distributing `<<` and `*` by constants over `+`, `|` and `-`:
 *
 *   ((a << 8) | b) << 8 | c        →  a·65536 + b·256 + c
 *   a * 1000 + b * 10 + c          →  a·1000 + b·10 + c
 *   (n - 1) * 4                    →  n·4 - 4
 *
 * A single term inverts directly (`n = (size + 4) / 4`). Several terms are digits of a mixed
 * radix: sorted by multiplier, each multiplier divides the next, every lower term is non-negative
 * and the lower terms together stay below the next multiplier (so nothing carries). Then
 *
 *   part_i = (W % m_{i+1}) / m_i          top = W / m_top          (W = value - constant)
 *
 * or, when every multiplier is a power of two, `(W >> k_i) & mask` and `W >> k_top` (which also
 * handles a signed top part). `|` is only accepted with power-of-two multipliers and no constant,
 * where it is the same as `+`.
 */
import type { IrExpr, IrValueType } from "../ir/index.ts";
import { convertTo, intLit, literalInt } from "./expr.ts";
import { BIGINT, isIntType } from "./types.ts";

/** A field that can be a part: its static range. */
export interface PartRange {
  lo: bigint;
  hi: bigint;
  /** Display of its type ("u32", "u8 : 4"). */
  display: string;
}

export type VirtualInverse =
  | { ok: true; parts: { name: string; derive: IrExpr }[] }
  | {
      ok: false;
      message: string;
      /** For quick fixes: a lower part that doesn't fit below a shift. */
      overlap?: { field: string; shift: bigint; width: number };
      /** A field the expression reads that can't be a part. */
      badField?: string;
    };

interface Flat {
  terms: Map<string, bigint>;
  /** Constant terms: literal sum and other constant expressions (parameters) with multipliers. */
  constant: bigint;
  constExprs: { expr: IrExpr; mult: bigint }[];
  usesOr: boolean;
}

type Fail = { fail: string; badField?: string };

function opText(e: IrExpr): string {
  if (e.kind === "binary") return `\`${e.op}\``;
  if (e.kind === "unary") return `\`${e.op}\``;
  if (e.kind === "call") return `${e.callee.kind === "builtin" ? e.callee.name : "a function"}()`;
  if (e.kind === "cond") return "`?:`";
  return "this expression";
}

function noFields(e: IrExpr): boolean {
  switch (e.kind) {
    case "literal":
    case "param":
      return true;
    case "convert":
      return noFields(e.operand);
    case "unary":
      return noFields(e.operand);
    case "binary":
      return noFields(e.left) && noFields(e.right);
    default:
      return false;
  }
}

function flatten(e: IrExpr, m: bigint, parts: Map<string, PartRange>, out: Flat): Fail | undefined {
  if (m === 0n) return undefined;
  const lit = literalInt(e);
  if (lit !== undefined) {
    out.constant += lit * m;
    return undefined;
  }
  switch (e.kind) {
    case "field": {
      if (!parts.has(e.name))
        return {
          fail: `'${e.name}' can't be a part of a virtual field: parts are integer fields declared before it.`,
          badField: e.name
        };
      out.terms.set(e.name, (out.terms.get(e.name) ?? 0n) + m);
      return undefined;
    }
    case "param":
      if (!isIntType(e.type)) return { fail: "Only integer parameters can be constants here." };
      out.constExprs.push({ expr: e, mult: m });
      return undefined;
    case "convert":
      if (!isIntType(e.type) || !isIntType(e.operand.type))
        return { fail: "A virtual field is built from integers." };
      return flatten(e.operand, m, parts, out);
    case "unary":
      if (e.op !== "-") return { fail: `${opText(e)} can't be inverted.` };
      return flatten(e.operand, -m, parts, out);
    case "binary": {
      switch (e.op) {
        case "+":
        case "|": {
          if (e.op === "|") out.usesOr = true;
          return flatten(e.left, m, parts, out) ?? flatten(e.right, m, parts, out);
        }
        case "-":
          return flatten(e.left, m, parts, out) ?? flatten(e.right, -m, parts, out);
        case "*": {
          const l = literalInt(e.left);
          const r = literalInt(e.right);
          if (r !== undefined) return flatten(e.left, m * r, parts, out);
          if (l !== undefined) return flatten(e.right, m * l, parts, out);
          if (noFields(e.left) || noFields(e.right))
            return { fail: "Multiply parts by constants only (a literal or a `const`)." };
          return { fail: "Two parts multiplied together can't be inverted." };
        }
        case "<<": {
          const k = literalInt(e.right);
          if (k === undefined || k < 0n || k > 63n)
            return { fail: "Shift parts by a constant (0..63)." };
          // A temporary, not `flatten(e.left, m << k, parts, out)`: esbuild misreads `<< k, …, out` as
          // a type parameter list with an `out` variance modifier.
          const shifted = m << k;
          return flatten(e.left, shifted, parts, out);
        }
        default:
          return {
            fail: `${opText(e)} can't be inverted: build a virtual field from its parts with \`<<\`, \`*\`, \`+\`, \`|\` and \`-\` by constants.`
          };
      }
    }
    default:
      return {
        fail: `${opText(e)} can't be inverted: build a virtual field from its parts with \`<<\`, \`*\`, \`+\`, \`|\` and \`-\` by constants.`
      };
  }
}

function isPow2(n: bigint): boolean {
  return n > 0n && (n & (n - 1n)) === 0n;
}

function log2(n: bigint): bigint {
  let k = 0n;
  while (1n << (k + 1n) <= n) k++;
  return k;
}

function bitWidth(hi: bigint): number {
  let w = 0;
  while (1n << BigInt(w) <= hi) w++;
  return w;
}

function hex(n: bigint): string {
  return n < 0n ? `-0x${(-n).toString(16)}` : n < 16n ? n.toString() : `0x${n.toString(16)}`;
}

function bin(op: "+" | "-" | "*" | "/" | "%" | ">>" | "&", l: IrExpr, r: IrExpr): IrExpr {
  return {
    kind: "binary",
    op,
    left: convertTo(l, BIGINT),
    right: convertTo(r, BIGINT),
    type: BIGINT
  };
}

/**
 * Derives each part of `read` from the virtual field's value `value` (a field reference).
 * `parts`: the fields that may be parts, with their static ranges.
 */
export function invertVirtual(
  read: IrExpr,
  value: IrExpr,
  parts: Map<string, PartRange>
): VirtualInverse {
  const flat: Flat = { terms: new Map(), constant: 0n, constExprs: [], usesOr: false };
  const f = flatten(read, 1n, parts, flat);
  if (f) return { ok: false, message: f.fail, ...(f.badField ? { badField: f.badField } : {}) };
  const terms = [...flat.terms].filter(([, m]) => m !== 0n);
  if (!terms.length)
    return { ok: false, message: "A virtual field must be built from earlier fields." };
  // W = value - constant
  let w: IrExpr = convertTo(value, BIGINT);
  if (flat.constant !== 0n)
    w =
      flat.constant > 0n ? bin("-", w, intLit(flat.constant)) : bin("+", w, intLit(-flat.constant));
  for (const c of flat.constExprs) {
    const t = c.mult === 1n ? c.expr : bin("*", c.expr, intLit(c.mult));
    w = bin("-", w, t);
  }
  if (terms.length === 1) {
    const [name, m] = terms[0]!;
    let d = w;
    if (m === -1n) d = { kind: "unary", op: "-", operand: w, type: BIGINT };
    else if (m !== 1n) d = bin("/", w, intLit(m));
    return { ok: true, parts: [{ name, derive: d }] };
  }
  // several parts: digits of a mixed radix
  if (flat.usesOr && (flat.constant !== 0n || flat.constExprs.length))
    return {
      ok: false,
      message: "Constants combined with `|` can't be inverted reliably; write them with `+`."
    };
  const sorted = terms.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  for (const [name, m] of sorted)
    if (m <= 0n)
      return {
        ok: false,
        message: `'${name}' is subtracted: with several parts, every part must be added (or shifted in).`
      };
  const pow2 = sorted.every(([, m]) => isPow2(m));
  if (flat.usesOr && !pow2)
    return {
      ok: false,
      message: "`|` combines parts only when they are shifted by powers of two (`a << k | b`)."
    };
  let below = 0n;
  for (let i = 0; i < sorted.length - 1; i++) {
    const [name, m] = sorted[i]!;
    const [nextName, next] = sorted[i + 1]!;
    const r = parts.get(name)!;
    if (r.lo < 0n)
      return {
        ok: false,
        message: `'${name}' (${r.display}) can be negative, so it can't be a lower part.`
      };
    if (next % m !== 0n)
      return {
        ok: false,
        message: `The parts' factors ${hex(m)} ('${name}') and ${hex(next)} ('${nextName}') must divide each other.`
      };
    below += m * r.hi;
    if (below >= next) {
      const shift = log2(next);
      const width = bitWidth(below);
      const message = pow2
        ? `'${name}' (${r.display}, up to ${hex(r.hi)}) doesn't fit below '${nextName}' shifted by ${shift}: the parts would overlap. Shift '${nextName}' by at least ${width}.`
        : `'${name}' (${r.display}, up to ${hex(r.hi)}) times ${hex(m)} reaches ${hex(next)}, the factor of '${nextName}': the parts would overlap.`;
      return {
        ok: false,
        message,
        ...(pow2 && m === 1n ? { overlap: { field: name, shift, width } } : {})
      };
    }
  }
  const top = sorted[sorted.length - 1]!;
  if (!pow2 && parts.get(top[0])!.lo < 0n)
    return {
      ok: false,
      message: `'${top[0]}' can be negative; with factors that aren't powers of two, every part must be unsigned.`
    };
  const out: { name: string; derive: IrExpr }[] = [];
  sorted.forEach(([name, m], i) => {
    const next = sorted[i + 1]?.[1];
    let d: IrExpr;
    if (pow2) {
      d = m === 1n ? w : bin(">>", w, intLit(log2(m)));
      if (next !== undefined) d = bin("&", d, intLit(next / m - 1n));
    } else {
      d = next !== undefined ? bin("%", w, intLit(next)) : w;
      if (m !== 1n) d = bin("/", d, intLit(m));
    }
    out.push({ name, derive: d });
  });
  return { ok: true, parts: out };
}

/**
 * Static range of an integer field (bitfields by width), narrowed by an `in (…)` check with
 * constant items (`u8 digit in (0..9)`).
 */
export function partRange(
  value: IrValueType,
  bitWidthOf?: number,
  checks: { expr: IrExpr }[] = []
): PartRange | undefined {
  if (value.kind !== "int") return undefined;
  const bits = BigInt(bitWidthOf ?? value.bits);
  let lo = value.signed ? -(1n << (bits - 1n)) : 0n;
  let hi = value.signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
  let display = `${value.signed ? "i" : "u"}${value.bits}${bitWidthOf !== undefined ? ` : ${bitWidthOf}` : ""}`;
  for (const c of checks) {
    const e = c.expr;
    if (e.kind !== "in" || e.value.kind !== "it" || !e.items.length) continue;
    let min: bigint | undefined;
    let max: bigint | undefined;
    let ok = true;
    for (const it of e.items) {
      const a = literalInt(it.kind === "value" ? it.value : it.low);
      const b = literalInt(it.kind === "value" ? it.value : it.high);
      if (a === undefined || b === undefined) {
        ok = false;
        break;
      }
      min = min === undefined || a < min ? a : min;
      max = max === undefined || b > max ? b : max;
    }
    if (!ok || min === undefined || max === undefined) continue;
    if (min > lo) lo = min;
    if (max < hi) hi = max;
    display += ` in ${min}..${max}`;
  }
  return { lo, hi, display };
}
