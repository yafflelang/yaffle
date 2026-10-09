/**
 * Canonical JSON helpers (docs/CONFORMANCE.md §3): bytes as lowercase hex, 56/64-bit integers as
 * decimal strings, non-finite floats and -0 as strings, shared targets as JSON-Pointer `$ref`s.
 */
import { YaffleError, fail, rethrowAt } from "./errors.ts";
import { describe } from "./prim.ts";

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

export function toHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += HEX[b[i]!];
  return s;
}

export function fromHex(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, "");
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    fail("INPUT", `invalid hex string ${describe(s)}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function floatToJson(x: number): number | string {
  if (Number.isNaN(x)) return "NaN";
  if (x === Infinity) return "Infinity";
  if (x === -Infinity) return "-Infinity";
  if (Object.is(x, -0)) return "-0";
  return x;
}

export function floatFromJson(j: unknown): number {
  if (typeof j === "number") return j;
  if (j === "NaN") return NaN;
  if (j === "Infinity") return Infinity;
  if (j === "-Infinity") return -Infinity;
  if (j === "-0") return -0;
  return fail("INPUT", `expected a number, got ${describe(j)}`);
}

/** Integers of up to 48 bits: JSON numbers (a non-integer is a RANGE error, other types INPUT). */
export function intFromJson(j: unknown): number {
  if (typeof j === "number") {
    if (Number.isInteger(j)) return j;
    return fail(Number.isFinite(j) ? "RANGE" : "INPUT", `${j} is not an integer`);
  }
  return fail("INPUT", `expected an integer, got ${describe(j)}`);
}

/** 56/64-bit integers: decimal strings. */
export function bigFromJson(j: unknown): bigint {
  if (typeof j === "string" && /^-?\d+$/.test(j)) return BigInt(j);
  return fail("INPUT", `expected a decimal integer string, got ${describe(j)}`);
}

export function boolFromJson(j: unknown): boolean {
  if (typeof j === "boolean") return j;
  return fail("INPUT", `expected a boolean, got ${describe(j)}`);
}

export function stringFromJson(j: unknown): string {
  if (typeof j === "string") return j;
  return fail("INPUT", `expected a string, got ${describe(j)}`);
}

function bytesFromJson(j: unknown): Uint8Array {
  if (typeof j === "string") return fromHex(j);
  return fail("INPUT", `expected a hex string, got ${describe(j)}`);
}

function arrayFromJson(j: unknown): unknown[] {
  if (Array.isArray(j)) return j;
  return fail("INPUT", `expected an array, got ${describe(j)}`);
}

export function objectFromJson(j: unknown): Record<string, unknown> {
  if (typeof j === "object" && j !== null && !Array.isArray(j)) return j as Record<string, unknown>;
  return fail("INPUT", `expected an object, got ${describe(j)}`);
}

/** Appends an RFC 6901 reference token. */
export function ptr(path: string, seg: string | number): string {
  return `${path}/${String(seg).replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

/** State for `toJson`: remembers where each object was first written, for `$ref`s. */
export class ToJsonCtx {
  readonly seen = new Map<object, string>();

  /** The `$ref` to use if `v` was already written; otherwise records `path` and returns undefined. */
  ref(v: unknown, path: string): { $ref: string } | undefined {
    // Only objects and non-empty, non-byte arrays are shared (bytes and empty arrays are values).
    if (typeof v !== "object" || v === null || v instanceof Uint8Array) return undefined;
    if (Array.isArray(v) && v.length === 0) return undefined;
    const prev = this.seen.get(v);
    if (prev !== undefined) return { $ref: prev };
    this.seen.set(v, path);
    return undefined;
  }
}

/** State for `fromJson`: values by JSON pointer, to restore identity from `$ref`s. */
export class FromJsonCtx {
  readonly byPath = new Map<string, unknown>();

  /** If `j` is a `{ "$ref": … }` object, returns `{ value }` for the referenced (earlier) value. */
  deref(j: unknown): { value: unknown } | undefined {
    if (typeof j !== "object" || j === null || Array.isArray(j)) return undefined;
    const keys = Object.keys(j);
    if (keys.length !== 1 || keys[0] !== "$ref") return undefined;
    const target = (j as { $ref: unknown }).$ref;
    if (typeof target !== "string") return undefined;
    if (!this.byPath.has(target))
      fail("INPUT", `$ref ${target} does not point at an earlier value`);
    return { value: this.byPath.get(target) };
  }

  register<T>(path: string, v: T): T {
    if (typeof v === "object" && v !== null) this.byPath.set(path, v);
    return v;
  }

  /** An array (or a `$ref` to one). Element errors get the index in their path. */
  arr<T>(j: unknown, path: string, f: (e: unknown, path: string) => T): T[] {
    const d = this.deref(j);
    if (d) return d.value as T[];
    const a = arrayFromJson(j);
    const out: T[] = [];
    this.register(path, out);
    for (let i = 0; i < a.length; i++) {
      try {
        out.push(f(a[i], ptr(path, i)));
      } catch (e) {
        rethrowAt(e, i);
      }
    }
    return out;
  }

  /** A struct (or a `$ref` to one); `f` registers the new object itself. */
  obj<T>(j: unknown, path: string, f: (j: unknown, path: string) => T): T {
    const d = this.deref(j);
    if (d) return d.value as T;
    return f(j, path);
  }

  /** Bytes from hex (or a `$ref`). */
  bytes(j: unknown, path: string): Uint8Array {
    const d = this.deref(j);
    if (d) return d.value as Uint8Array;
    return this.register(path, bytesFromJson(j));
  }
}

/** Enum member from JSON: a member name, or (open enums) a number / decimal string for 56/64-bit storage. */
export function enumFromJson(
  values: Readonly<Record<string, number | bigint>>,
  j: unknown,
  open: boolean
): string | number | bigint {
  if (typeof j === "string" && Object.hasOwn(values, j)) return j;
  if (open && typeof j === "number" && Number.isInteger(j)) return j;
  if (open && typeof j === "string" && /^-?\d+$/.test(j)) return BigInt(j);
  return fail("INPUT", `${describe(j)} is not a member of the enum`);
}

/** Open enum value to JSON: names stay, 56/64-bit numbers become decimal strings. */
export function enumToJson(v: unknown): unknown {
  return typeof v === "bigint" ? String(v) : v;
}

/** Union from JSON: `{ type, value }`. */
export function unionFromJson(
  j: unknown,
  variants: Record<string, (j: unknown, path: string) => unknown>,
  path: string
): { type: string; value: unknown } {
  const o = objectFromJson(j);
  const t = o.type;
  if (typeof t !== "string" || !Object.hasOwn(variants, t)) {
    return fail("INPUT", `unknown union variant ${describe(t)}`);
  }
  try {
    return { type: t, value: variants[t]!(o.value, ptr(path, "value")) };
  } catch (e) {
    return rethrowAt(e, "value");
  }
}

/** The first conversion that succeeds (fields whose type differs between branches). */
export function firstOf(fs: (() => unknown)[]): unknown {
  let last: unknown;
  for (const f of fs) {
    try {
      return f();
    } catch (e) {
      if (!(e instanceof YaffleError)) throw e;
      last = e;
    }
  }
  throw last;
}

/** `f()`, or `fallback` if it throws a YaffleError. */
export function tryOr<T, U>(f: () => T, fallback: U): T | U {
  try {
    return f();
  } catch (e) {
    if (e instanceof YaffleError) return fallback;
    throw e;
  }
}

// ── raw values of one-way transforms ──────────────────────────────────────────

const raws = new WeakMap<object, Map<string, { raw: unknown; value: unknown }>>();

/**
 * Remembers the raw (pre-transform) value of a one-way transform field (canonical JSON shows it,
 * and the writer writes it). Called right after the transformed value was stored in the field.
 */
export function setRaw(owner: object, field: string, raw: unknown): void {
  let m = raws.get(owner);
  if (!m) raws.set(owner, (m = new Map()));
  m.set(field, { raw, value: (owner as Record<string, unknown>)[field] });
}

/**
 * The raw value remembered by `setRaw`, if the object came from a parse (or is a view of one)
 * and the field still holds the value read then. A changed field holds a raw input value.
 */
export function getRaw(owner: object, field: string): unknown {
  const e = raws.get(owner)?.get(field);
  if (e) return Object.is(e.value, (owner as Record<string, unknown>)[field]) ? e.raw : undefined;
  return viewNode(owner)?.rawValue?.(field);
}

/** Writer input of a one-way transform field: the remembered raw value, else the value given. */
export function rawInput(owner: object, field: string, value: unknown): unknown {
  const r = getRaw(owner, field);
  return r !== undefined ? r : value;
}

const NODE = Symbol.for("yaffle.node");

/** View nodes answer these for their struct views (view.ts), without json.ts importing views. */
interface NodeLike {
  fieldValue?(field: string): unknown;
  rawValue?(field: string): unknown;
}

function viewNode(owner: object): NodeLike | undefined {
  return (owner as { [NODE]?: NodeLike })[NODE];
}

// ── hidden fields that are stream pieces ──────────────────────────────────────

const hiddenVals = new WeakMap<object, Map<string, unknown>>();

/** Keeps a @hidden field's value next to its struct (a `from arr[*].piece` stream reads it). */
export function setHidden(owner: object, field: string, value: unknown): void {
  let m = hiddenVals.get(owner);
  if (!m) hiddenVals.set(owner, (m = new Map()));
  m.set(field, value);
}

/** The value `setHidden` kept for a struct's @hidden field (undefined if none). */
export function hiddenValue(owner: object, field: string): unknown {
  return hiddenVals.get(owner)?.get(field);
}

/** A field of a struct value or view, hidden (kept by `setHidden`) or not. */
export function fieldValue(owner: object, field: string): unknown {
  const h = hiddenVals.get(owner)?.get(field);
  if (h !== undefined) return h;
  const n = viewNode(owner);
  if (n?.fieldValue) return n.fieldValue(field);
  return (owner as Record<string, unknown>)[field];
}

/** The pieces of a joined stream: each element's `field` (hidden or not). */
export function pieces(arr: ArrayLike<unknown>, field: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < arr.length; i++) {
    const v = fieldValue(arr[i] as object, field);
    if (!(v instanceof Uint8Array)) fail("INPUT", `stream piece ${i} has no bytes in ${field}`);
    out.push(v);
  }
  return out;
}
