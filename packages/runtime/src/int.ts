/**
 * Integer semantics used by generated expressions (docs/IR.md §6): exact arithmetic, truncating
 * division, `%` with the sign of the dividend, shift counts 0..63, 64-bit two's complement
 * bitwise operators, rounding half away from zero, and range checks where a value lands in a
 * typed location. The code generator computes in `number` when it can prove the range stays
 * within ±2^53 and calls the `…Big` helpers otherwise.
 */
import { fail } from "./errors.ts";

export type Int = number | bigint;

const MAX = Number.MAX_SAFE_INTEGER;

// ── aggregates (min/max/sum over an array, lengths of nested arrays) ──────────

function items(arr: unknown): ArrayLike<unknown> {
  if (
    typeof arr === "object" &&
    arr !== null &&
    typeof (arr as ArrayLike<unknown>).length === "number"
  ) {
    return arr as ArrayLike<unknown>;
  }
  return fail("INPUT", "expected an array");
}

/** Sum of an array of numbers (0 for an empty array). */
export function sum(arr: unknown): number {
  const a = items(arr);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Number(a[i]);
  if (Number.isInteger(s) && !Number.isSafeInteger(s)) fail("RANGE", `sum ${s} is too large`);
  return s;
}

/** Sum as a bigint (64-bit element types). */
export function sumBig(arr: unknown): bigint {
  const a = items(arr);
  let s = 0n;
  for (let i = 0; i < a.length; i++) s += BigInt(a[i] as Int);
  return s;
}

/** Smallest element (an empty array is a RANGE error). */
export function minOf<T extends Int>(arr: unknown): T {
  const a = items(arr);
  if (!a.length) fail("RANGE", "min of an empty array");
  let m = a[0] as T;
  for (let i = 1; i < a.length; i++) if ((a[i] as T) < m) m = a[i] as T;
  return m;
}

/** Largest element (an empty array is a RANGE error). */
export function maxOf<T extends Int>(arr: unknown): T {
  const a = items(arr);
  if (!a.length) fail("RANGE", "max of an empty array");
  let m = a[0] as T;
  for (let i = 1; i < a.length; i++) if ((a[i] as T) > m) m = a[i] as T;
  return m;
}

/** The length of each element of an array of arrays (`lengths(lists)`; null counts as empty). */
export function lengths(arr: unknown): number[] {
  const a = items(arr);
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    out.push(x === null || x === undefined ? 0 : items(x).length);
  }
  return out;
}

/** Converts an integer to a number, failing with RANGE if it is not exactly representable. */
export function num(v: Int, what = "value"): number {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) fail("RANGE", `${what} ${v} is not a safe integer`);
    return v;
  }
  if (v > BigInt(MAX) || v < -BigInt(MAX)) fail("RANGE", `${what} ${v} is too large`);
  return Number(v);
}

/** Converts to bigint (numbers must be integers). */
export function big(v: Int): bigint {
  if (typeof v === "bigint") return v;
  if (!Number.isInteger(v)) fail("RANGE", `${v} is not an integer`);
  return BigInt(v);
}

/** A length or count: a non-negative safe integer. */
export function len(v: Int, what = "length"): number {
  const n = num(v, what);
  if (n < 0) fail("RANGE", `${what} ${n} is negative`);
  return n;
}

export function div(a: number, b: number): number {
  if (b === 0) fail("RANGE", "division by zero");
  const q = Math.trunc(a / b);
  return q === 0 ? 0 : q; // no -0
}

export function divBig(a: bigint, b: bigint): bigint {
  if (b === 0n) fail("RANGE", "division by zero");
  return a / b;
}

export function mod(a: number, b: number): number {
  if (b === 0) fail("RANGE", "division by zero");
  const r = a % b;
  return r === 0 ? 0 : r;
}

export function modBig(a: bigint, b: bigint): bigint {
  if (b === 0n) fail("RANGE", "division by zero");
  return a % b;
}

function shiftCount(n: Int): number {
  const c = Number(n);
  if (!Number.isInteger(c) || c < 0 || c > 63) fail("RANGE", `shift count ${n} is not in 0..63`);
  return c;
}

export function shl(a: number, n: Int): number {
  return a * 2 ** shiftCount(n);
}

export function shlBig(a: bigint, n: Int): bigint {
  return a << BigInt(shiftCount(n));
}

export function shr(a: number, n: Int): number {
  const r = Math.floor(a / 2 ** shiftCount(n));
  return r === 0 ? 0 : r;
}

export function shrBig(a: bigint, n: Int): bigint {
  return a >> BigInt(shiftCount(n));
}

/** Rounds half away from zero. */
export function round(x: number): number {
  if (!Number.isFinite(x)) fail("RANGE", `cannot round ${x} to an integer`);
  const r = x < 0 ? -Math.round(-x) : Math.round(x);
  return r === 0 ? 0 : r;
}

export function absBig(x: bigint): bigint {
  return x < 0n ? -x : x;
}

export function min<T extends Int>(a: T, b: T): T {
  return a < b ? a : b;
}

export function max<T extends Int>(a: T, b: T): T {
  return a > b ? a : b;
}

/** Checks that an integer value fits a destination range; returns it unchanged. */
export function inRange<T extends Int>(v: T, lo: Int, hi: Int, what: string): T {
  if (v < lo || v > hi) fail("RANGE", `${what} ${v} is out of range ${lo}..${hi}`);
  return v;
}

/** `indexOf(array, value)` reverse lookup: missing values are an INPUT error on write. */
export function indexOf(arr: readonly unknown[], v: unknown): number {
  for (let i = 0; i < arr.length; i++) if (equals(arr[i], v)) return i;
  return fail("INPUT", `value ${String(v)} is not in the table`);
}

/** Structural equality used for literal comparisons (`until` terminators, switch cases, `in`). */
export function equals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "bigint" || typeof b === "bigint") {
    if (
      (typeof a === "number" || typeof a === "bigint") &&
      (typeof b === "number" || typeof b === "bigint")
    ) {
      return Number.isInteger(Number(a)) && Number.isInteger(Number(b)) && big(a) === big(b);
    }
    return false;
  }
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  // Arrays element-wise; bytes equal an array of the same numbers.
  if (isList(a) && isList(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!equals(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!equals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
        return false;
    }
    return true;
  }
  return false;
}

function isList(v: unknown): v is ArrayLike<unknown> {
  return v instanceof Uint8Array || Array.isArray(v);
}
