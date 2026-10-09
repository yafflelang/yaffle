/**
 * Interval analysis of integer expressions: the static range of an expression from its operands'
 * types, and the smallest standard integer type holding it. Used for the value type of integer
 * `as` transforms and of untyped constants. Unbounded or beyond 64 bits → i64/u64.
 */
import type { IrExpr, IrValueType } from "../ir/index.ts";
import { intRange } from "./types.ts";

type Interval = [bigint, bigint];

const U64_MAX = (1n << 64n) - 1n;

function typeRange(t: IrValueType): Interval | undefined {
  if (t.kind === "int") return intRange(t);
  if (t.kind === "bool") return [0n, 1n];
  return undefined;
}

const minmax = (xs: bigint[]): Interval => [
  xs.reduce((a, b) => (b < a ? b : a)),
  xs.reduce((a, b) => (b > a ? b : a))
];

/** The static range of an integer expression, if bounded. */
export function rangeOf(e: IrExpr): Interval | undefined {
  switch (e.kind) {
    case "literal":
      if (e.value.kind === "int") {
        const v = BigInt(e.value.value);
        return [v, v];
      }
      if (e.value.kind === "bool") return e.value.value ? [1n, 1n] : [0n, 0n];
      return undefined;
    case "field":
    case "param":
    case "it":
    case "member":
    case "index":
    case "lambdaParam":
      return typeRange(e.type);
    case "builtinValue":
      return [0n, U64_MAX];
    case "convert":
      return e.type.kind === "float" ? undefined : (rangeOf(e.operand) ?? typeRange(e.type));
    case "unary": {
      const r = rangeOf(e.operand);
      if (!r) return undefined;
      if (e.op === "-") return [-r[1], -r[0]];
      if (e.op === "~") return [-r[1] - 1n, -r[0] - 1n];
      return undefined;
    }
    case "cond": {
      const a = rangeOf(e.then);
      const b = rangeOf(e.else);
      return a && b ? [a[0] < b[0] ? a[0] : b[0], a[1] > b[1] ? a[1] : b[1]] : undefined;
    }
    case "call": {
      if (e.callee.kind === "extern") return typeRange(e.type);
      const n = e.callee.name;
      if (["len", "sizeof", "offsetof", "encodedSize", "encodedLength", "indexOf"].includes(n))
        return [0n, U64_MAX];
      if (n === "crc32" || n === "adler32") return [0n, 0xffffffffn];
      if (n === "min" || n === "max") {
        if (e.args.length === 1) {
          const t = e.args[0]!.type;
          return t.kind === "array"
            ? typeRange(t.element)
            : t.kind === "bytes"
              ? [0n, 255n]
              : undefined;
        }
        const rs = e.args.map(rangeOf);
        if (rs.some(r => !r)) return undefined;
        const lo = rs.map(r => r![0]);
        const hi = rs.map(r => r![1]);
        return n === "min" ? [minmax(lo)[0], minmax(hi)[0]] : [minmax(lo)[1], minmax(hi)[1]];
      }
      if (n === "abs") {
        const r = e.args[0] && rangeOf(e.args[0]);
        if (!r) return undefined;
        const [lo, hi] = minmax([r[0] < 0n ? -r[0] : r[0], r[1] < 0n ? -r[1] : r[1]]);
        return [r[0] <= 0n && r[1] >= 0n ? 0n : lo, hi];
      }
      return undefined;
    }
    case "binary": {
      const a = rangeOf(e.left);
      const b = rangeOf(e.right);
      if (!a || !b) return undefined;
      switch (e.op) {
        case "+":
          return [a[0] + b[0], a[1] + b[1]];
        case "-":
          return [a[0] - b[1], a[1] - b[0]];
        case "*":
          return minmax([a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]]);
        case "/": {
          if (b[0] <= 0n && b[1] >= 0n) {
            // divisor may be 0 (an error) or ±1: the dividend's magnitude bounds the result
            const m = minmax([a[0] < 0n ? -a[0] : a[0], a[1] < 0n ? -a[1] : a[1]])[1];
            return [-m, m];
          }
          return minmax([a[0] / b[0], a[0] / b[1], a[1] / b[0], a[1] / b[1]]);
        }
        case "%": {
          const m = minmax([b[0] < 0n ? -b[0] : b[0], b[1] < 0n ? -b[1] : b[1]])[1] - 1n;
          if (m < 0n) return [0n, 0n];
          return [a[0] < 0n ? -m : 0n, a[1] > 0n ? m : 0n];
        }
        case "<<":
          if (b[0] < 0n || b[1] > 63n) return undefined;
          return minmax([a[0] << b[0], a[0] << b[1], a[1] << b[0], a[1] << b[1]]);
        case ">>":
          if (b[0] < 0n || b[1] > 63n) return undefined;
          return minmax([a[0] >> b[0], a[0] >> b[1], a[1] >> b[0], a[1] >> b[1]]);
        case "&":
          if (a[0] >= 0n && b[0] >= 0n) return [0n, a[1] < b[1] ? a[1] : b[1]];
          if (a[0] >= 0n) return [0n, a[1]];
          if (b[0] >= 0n) return [0n, b[1]];
          return undefined;
        case "|":
        case "^": {
          if (a[0] < 0n || b[0] < 0n) return undefined;
          const m = a[1] > b[1] ? a[1] : b[1];
          return [0n, (1n << BigInt(m.toString(2).length)) - 1n];
        }
        default:
          return [0n, 1n];
      }
    }
    default:
      return undefined;
  }
}

/** The smallest standard integer type (u8/u16/u32/u64, i8/i16/i32/i64) holding `r`. */
function smallestIntType(r: Interval | undefined): IrValueType {
  if (!r) return { kind: "int", bits: 64, signed: true };
  const [lo, hi] = r;
  if (lo >= 0n) {
    for (const bits of [8, 16, 32, 64] as const)
      if (hi <= (1n << BigInt(bits)) - 1n) return { kind: "int", bits, signed: false };
    return { kind: "int", bits: 64, signed: false };
  }
  for (const bits of [8, 16, 32, 64] as const) {
    const max = (1n << BigInt(bits - 1)) - 1n;
    if (lo >= -max - 1n && hi <= max) return { kind: "int", bits, signed: true };
  }
  return { kind: "int", bits: 64, signed: true };
}

/** A concrete type for an integer expression typed `bigint`. */
export function concreteIntType(e: IrExpr): IrValueType {
  return smallestIntType(rangeOf(e));
}
