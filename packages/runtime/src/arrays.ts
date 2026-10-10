/**
 * Derived arrays: the built-ins `map`, `filter`, `indicesWhere`, `sortedBy`, `unique` and
 * `concat` used in computed fields and checks. Inputs are any array-like (plain arrays, array
 * views, byte arrays); results are plain arrays.
 */
import { fail } from "./errors.ts";
import { describe } from "./prim.ts";
import { equals } from "./int.ts";

function items<T>(a: ArrayLike<T> | null | undefined): ArrayLike<T> {
  if (a === null || a === undefined || typeof (a as { length?: unknown }).length !== "number") {
    return fail("INPUT", `expected an array, got ${describe(a)}`);
  }
  return a;
}

/** `map(arr, x => expr)`. */
export function mapArr<T, U>(arr: ArrayLike<T>, f: (x: T) => U): U[] {
  const a = items(arr);
  const out: U[] = [];
  for (let i = 0; i < a.length; i++) out.push(f(a[i]!));
  return out;
}

/** `filter(arr, x => bool)`. */
export function filterArr<T>(arr: ArrayLike<T>, f: (x: T) => boolean): T[] {
  const a = items(arr);
  const out: T[] = [];
  for (let i = 0; i < a.length; i++) if (f(a[i]!)) out.push(a[i]!);
  return out;
}

/** `indicesWhere(arr, x => bool)`: the indices of the matching elements (bigints for 64-bit). */
export function indicesWhere<T>(arr: ArrayLike<T>, f: (x: T) => boolean): number[];
export function indicesWhere<T>(arr: ArrayLike<T>, f: (x: T) => boolean, big: true): bigint[];
export function indicesWhere<T>(
  arr: ArrayLike<T>,
  f: (x: T) => boolean,
  big = false
): (number | bigint)[] {
  const a = items(arr);
  const out: (number | bigint)[] = [];
  for (let i = 0; i < a.length; i++) if (f(a[i]!)) out.push(big ? BigInt(i) : i);
  return out;
}

/** Order of sort keys: numbers (and bigints) numerically, strings by code point, bytes lexicographically. */
export function compareKeys(a: unknown, b: unknown): number {
  if (
    (typeof a === "number" || typeof a === "bigint") &&
    (typeof b === "number" || typeof b === "bigint")
  ) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === "string" && typeof b === "string") {
    // Code points, not UTF-16 code units (astral characters sort after U+FFFF).
    const ia = a[Symbol.iterator]();
    const ib = b[Symbol.iterator]();
    for (;;) {
      const x = ia.next();
      const y = ib.next();
      if (x.done || y.done) return x.done && y.done ? 0 : x.done ? -1 : 1;
      const cx = x.value.codePointAt(0)!;
      const cy = y.value.codePointAt(0)!;
      if (cx !== cy) return cx < cy ? -1 : 1;
    }
  }
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return a.length - b.length;
  }
  return fail("INPUT", `cannot compare sort keys ${describe(a)} and ${describe(b)}`);
}

/** `sortedBy(arr, x => key)`: a stable sort by key. */
export function sortedBy<T>(arr: ArrayLike<T>, key: (x: T) => unknown): T[] {
  const a = items(arr);
  const keyed: { k: unknown; i: number; v: T }[] = [];
  for (let i = 0; i < a.length; i++) keyed.push({ k: key(a[i]!), i, v: a[i]! });
  keyed.sort((x, y) => compareKeys(x.k, y.k) || x.i - y.i);
  return keyed.map(x => x.v);
}

/** `unique(arr)`: without later duplicates (value equality; the first occurrence is kept). */
export function unique<T>(arr: ArrayLike<T>): T[] {
  const a = items(arr);
  const out: T[] = [];
  const prims = new Set<unknown>();
  for (let i = 0; i < a.length; i++) {
    const v = a[i]!;
    if (typeof v === "string" || typeof v === "boolean") {
      if (prims.has(v)) continue;
      prims.add(v);
      out.push(v);
    } else if (!out.some(x => equals(x, v))) out.push(v);
  }
  return out;
}

/** `concat(a, b, …)`. */
export function concat<T>(...arrs: ArrayLike<T>[]): T[] {
  const out: T[] = [];
  for (const arr of arrs) {
    const a = items(arr);
    for (let i = 0; i < a.length; i++) out.push(a[i]!);
  }
  return out;
}

/** A derived array of byte values written to a `u8[]` field. */
export function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  const a = items(v as ArrayLike<unknown>);
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const n = typeof x === "bigint" ? Number(x) : x;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 255) {
      fail("RANGE", `${describe(x)} is not a byte (element ${i})`);
    }
    out[i] = n;
  }
  return out;
}
