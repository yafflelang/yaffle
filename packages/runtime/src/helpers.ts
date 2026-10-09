/** Small helpers called by generated code. */
import { YaffleError, fail, wrapHostError } from "./errors.ts";
import { describe } from "./prim.ts";
import type { Reader } from "./reader.ts";
import { encodeString, type StringEncoding } from "./strings.ts";
import { splitBySizes } from "./codec.ts";
import { equals } from "./int.ts";
import { fieldValue } from "./json.ts";
import type { Writer } from "./writer.ts";
import { serializeWith } from "./api.ts";

/** Enum member values by name. */
export type EnumValues = { readonly [name: string]: number | bigint };
/** Enum member names by value. */
export type EnumNames<T> = ReadonlyMap<number | bigint, T>;

export function enumNames<T>(entries: [number | bigint, T][]): EnumNames<T> {
  return new Map(entries);
}

/** Enum read: raw value → member name; unknown values fail unless the enum is open. */
export function enumRead<T>(
  names: ReadonlyMap<number | bigint, T>,
  raw: number | bigint,
  open: boolean,
  r: Reader,
  at: number
): T {
  const n = names.get(raw);
  if (n !== undefined) return n;
  if (open) return raw as unknown as T;
  return r.fail("CHECK", `${String(raw)} is not a member of the enum`, at);
}

/** Enum write: member name (or a raw number for open enums) → value. */
export function enumValue(
  values: Readonly<Record<string, number | bigint>>,
  v: unknown
): number | bigint {
  if (typeof v === "string") {
    const x = values[v];
    if (x !== undefined && Object.hasOwn(values, v)) return x;
    return fail("INPUT", `${JSON.stringify(v)} is not a member of the enum`);
  }
  if (typeof v === "number" || typeof v === "bigint") return v;
  return fail("INPUT", `expected an enum member name, got ${describe(v)}`);
}

/** Array/bytes index with a bounds check. */
export function at<T>(arr: ArrayLike<T>, i: number): T {
  if (i < 0 || i >= arr.length) fail("RANGE", `index ${i} is out of bounds (length ${arr.length})`);
  return arr[i]!;
}

const enc = new TextEncoder();
export function utf8(s: string): Uint8Array {
  return enc.encode(s);
}

/** Placeholder for an extern without a configured implementation (fails when used). */
export function missingExtern(name: string): unknown {
  const thrower = (): never =>
    fail(
      "INPUT",
      `extern ${name} has no implementation (configure targets.ts.externs in yaffle.json)`
    );
  return new Proxy(thrower, { get: () => thrower });
}

/** Checks that an input value is an object with the given required fields. */
export function need(v: unknown, fields: readonly string[]): void {
  if (typeof v !== "object" || v === null) fail("INPUT", `expected an object, got ${describe(v)}`);
  for (const f of fields) {
    if ((v as Record<string, unknown>)[f] === undefined) {
      // The path names the missing field.
      throw new YaffleError("INPUT", `missing required field ${f}`, -1, [f]);
    }
  }
}

/** A required field of an input value (INPUT error if missing). */
export function req<T>(v: T | undefined, name: string): T {
  if (v === undefined) fail("INPUT", `missing required field ${name}`);
  return v;
}

// ── write-side validation ──────────────────────────────────────────────────────

/** An input union value `{ type, value }`. */
export function unionValue(v: unknown): { type: string; value: unknown } {
  if (typeof v !== "object" || v === null || typeof (v as { type?: unknown }).type !== "string") {
    return fail("INPUT", `expected a union value { type, value }, got ${describe(v)}`);
  }
  return v as { type: string; value: unknown };
}

/** An input array (array views and other array-likes are accepted). */
export function arrayValue(v: unknown): ArrayLike<unknown> {
  if (Array.isArray(v)) return v;
  if (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { length?: unknown }).length === "number"
  ) {
    return v as ArrayLike<unknown>;
  }
  return fail("INPUT", `expected an array, got ${describe(v)}`);
}

/** `@nullable(empty)`: an empty (or null) array, bytes or string value is written as the null value. */
export function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.length === 0;
  return arrayValue(v).length === 0;
}

/** An array written with `actual` elements whose length expression says `expected`: DERIVE. */
export function checkLength(actual: number, expected: number): void {
  if (actual !== expected) {
    fail("DERIVE", `${actual} elements given, the length expression says ${expected}`);
  }
}

/** A placed field whose read-side offset expression disagrees with where it was placed: DERIVE. */
export function checkPlacement(
  offset: number,
  p: { block: { pos: number; size: number } },
  name: string
): void {
  // An empty target reads back the same wherever its offset points.
  if (p.block.size === 0) return;
  if (offset !== p.block.pos) {
    fail(
      "DERIVE",
      `${name} was placed at ${p.block.pos} but its offset expression gives ${offset}`
    );
  }
}

/** A virtual field: its read expression must give the input value back. */
export function checkVirtual(v: unknown, back: unknown, name: string): void {
  if (!equalsLoose(v, back) && !equals(v, back)) {
    fail(
      "DERIVE",
      `virtual field ${name} = ${describe(v)} reads back as ${describe(back)} from the fields it is made of`
    );
  }
}

/** `read(write(v))` must give `v` back. */
export function checkRoundTrip(v: unknown, back: unknown): void {
  if (!equalsLoose(v, back)) {
    fail(
      "INPUT",
      `value ${describe(v)} does not survive the transform (reads back as ${describe(back)})`
    );
  }
}

function equalsLoose(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    (typeof a === "number" || typeof a === "bigint") &&
    (typeof b === "number" || typeof b === "bigint")
  ) {
    return Number(a) === Number(b) && (typeof a !== "bigint" || typeof b !== "bigint" || a === b);
  }
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  return false;
}

/** Float transforms: the value must be within half a storage step of what reads back. */
export function checkFloatRoundTrip(v: unknown, back: number, next: number): void {
  if (typeof v !== "number") fail("INPUT", `expected a number, got ${describe(v)}`);
  if (Number.isNaN(v) && Number.isNaN(back)) return;
  const half = Math.abs(next - back) / 2;
  if (!(Math.abs(v - back) <= half * (1 + 1e-9))) {
    fail("INPUT", `value ${v} does not survive the transform (reads back as ${back})`);
  }
}

export function boolBit(v: unknown): number {
  if (typeof v !== "boolean") fail("INPUT", `expected a boolean, got ${describe(v)}`);
  return v ? 1 : 0;
}

/** A bitfield value as unsigned bits of `width` (≤ 48; signed values in two's complement). */
export function bitsOf(v: unknown, width: number, signed: boolean): number {
  return Number(bitsOfBig(v, width, signed));
}

/** Same as `bitsOf`, as a bigint (any width). */
export function bitsOfBig(v: unknown, width: number, signed: boolean): bigint {
  if (typeof v !== "number" && typeof v !== "bigint")
    fail("INPUT", `expected an integer, got ${describe(v)}`);
  if (typeof v === "number" && !Number.isInteger(v)) fail("RANGE", `${v} is not an integer`);
  const b = BigInt(v);
  const w = BigInt(width);
  const lo = signed ? -(1n << (w - 1n)) : 0n;
  const hi = signed ? (1n << (w - 1n)) - 1n : (1n << w) - 1n;
  if (b < lo || b > hi) fail("RANGE", `${b} does not fit in ${width} bits`);
  return b < 0n ? b + (1n << w) : b;
}

/** Encodes a string padded with NUL units to exactly `n` bytes. */
export function encodeFixedString(
  s: unknown,
  n: number,
  unit: number,
  enc: StringEncoding,
  le: boolean
): Uint8Array {
  const b = encodeString(s, enc, le);
  if (b.length > n)
    fail("INPUT", `string of ${b.length / unit} units exceeds the length ${n / unit}`);
  const out = new Uint8Array(n);
  out.set(b);
  return out;
}

/** Piece size for a split stream (`sizes` policy): the size field given in the input. */
function pieceSize(v: unknown): number {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return v;
  if (typeof v === "bigint" && v >= 0n) return Number(v);
  return fail("INPUT", `split policy "sizes" needs every piece's size in the input`);
}

function objectValue(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null) fail("INPUT", `expected an object, got ${describe(v)}`);
  return v as Record<string, unknown>;
}

/** The element's original bytes if they equal `piece` (so codec reuse recognizes them), else `piece`. */
function samePiece(orig: unknown, piece: Uint8Array): Uint8Array {
  const same =
    orig instanceof Uint8Array &&
    orig.length === piece.length &&
    orig.every((b, i) => b === piece[i]);
  return same ? orig : piece;
}

/**
 * Splits `data` into pieces of the given sizes and returns shallow copies of the elements with
 * their `field` replaced.
 */
function splitInto(
  elements: ArrayLike<unknown>,
  field: string,
  data: Uint8Array,
  sizes: readonly number[]
): Record<string, unknown>[] {
  if (sizes.length !== elements.length) fail("INPUT", "piece count does not match the elements");
  const pieces = splitBySizes(data, sizes);
  return Array.from(elements, (e, i) => {
    const o = objectValue(e);
    return { ...o, [field]: samePiece(fieldValue(o, field), pieces[i]!) };
  });
}

/**
 * Write side of `T x from arr[*].field`: the encoded stream is split into the elements' `field`.
 * Piece sizes given in the input (`sizeField` of every element) win; otherwise the `fit` policy
 * picks, for element k, the longest piece whose encoded element fits before element k+1's offset
 * (the pieces array may then be omitted from the input). Zero content gives zero pieces.
 */
export function splitStream(
  elements: unknown,
  field: string,
  data: Uint8Array,
  sizeField: string | undefined,
  fit: { offset: (k: number) => number; size: (el: unknown) => number } | undefined
): Record<string, unknown>[] {
  const els = elements === undefined || elements === null ? undefined : arrayValue(elements);
  if (els && els.length && sizeField) {
    const given = Array.from(els, e => objectValue(e)[sizeField]);
    if (given.every(v => v !== undefined)) return splitInto(els, field, data, given.map(pieceSize));
  }
  if (!fit) {
    if (els && sizeField) {
      const sizes = Array.from(els, e => pieceSize(objectValue(e)[sizeField]));
      return splitInto(els, field, data, sizes);
    }
    return fail("INPUT", "cannot split the stream: give every piece's size in the input");
  }
  const out: Record<string, unknown>[] = [];
  let pos = 0;
  for (let k = 0; pos < data.length; k++) {
    const base: Record<string, unknown> = els && k < els.length ? { ...objectValue(els[k]) } : {};
    if (sizeField) delete base[sizeField];
    const cap = fit.offset(k + 1) - fit.offset(k);
    const left = data.length - pos;
    // A piece too large for one of the element's fields (a RANGE error) does not fit either.
    const fits = (n: number): boolean => {
      try {
        return fit.size({ ...base, [field]: data.subarray(pos, pos + n) }) <= cap;
      } catch (e) {
        if (e instanceof YaffleError && e.code === "RANGE") return false;
        throw e;
      }
    };
    let n: number;
    if (fits(left)) n = left;
    else {
      let lo = 0;
      let hi = left;
      while (hi - lo > 1) {
        const mid = (lo + hi) >>> 1;
        if (fits(mid)) lo = mid;
        else hi = mid;
      }
      n = lo;
    }
    if (n === 0) fail("OVERLAP", `stream piece ${k} does not fit its block of ${cap} bytes`);
    const orig = els && k < els.length ? fieldValue(objectValue(els[k]), field) : undefined;
    out.push({ ...base, [field]: samePiece(orig, data.subarray(pos, pos + n)) });
    pos += n;
  }
  return out;
}

/** One `from raw[start..end]` field's encoding, for `assembleSlices`. */
export interface SlicePart {
  /** Field name (error messages). */
  name: string;
  start: number;
  /** Slice end (exclusive); undefined: to the end of the stream. */
  end: number | undefined;
  bytes: Uint8Array;
}

/**
 * Write side of stream slices: the sliced bytes are a zero-filled buffer
 * of `length` bytes (undefined: the largest slice end) with every slice field's encoding written
 * at its start. An encoding longer than its slice, or overlapping slices whose bytes differ, is a
 * DERIVE error.
 */
export function assembleSlices(
  length: number | undefined,
  parts: readonly SlicePart[]
): Uint8Array {
  let size = 0;
  for (const p of parts) {
    if (!Number.isSafeInteger(p.start) || p.start < 0)
      fail("RANGE", `slice start ${p.start} of ${p.name} is invalid`);
    if (p.end !== undefined) {
      if (!Number.isSafeInteger(p.end) || p.end < p.start)
        fail("RANGE", `slice [${p.start}, ${p.end}) of ${p.name} is invalid`);
      if (p.bytes.length > p.end - p.start) {
        fail(
          "DERIVE",
          `${p.name} encodes to ${p.bytes.length} bytes, its slice [${p.start}, ${p.end}) has ${p.end - p.start}`
        );
      }
    }
    size = Math.max(size, p.end ?? p.start + p.bytes.length, p.start + p.bytes.length);
  }
  if (length !== undefined) {
    if (size > length)
      fail("DERIVE", `the slices need ${size} bytes, the sliced field has ${length}`);
    size = length;
  }
  const out = new Uint8Array(size);
  const owner = new Int32Array(size).fill(-1);
  parts.forEach((p, k) => {
    for (let i = 0; i < p.bytes.length; i++) {
      const at = p.start + i;
      const prev = owner[at]!;
      if (prev >= 0 && out[at] !== p.bytes[i]) {
        fail(
          "DERIVE",
          `overlapping slices ${parts[prev]!.name} and ${p.name} disagree at byte 0x${at.toString(16)}`
        );
      }
      out[at] = p.bytes[i]!;
      owner[at] = k;
    }
  });
  return out;
}

/** Calls a host function (extern fn); host failures are CODEC errors. */
export function callHost<T>(fn: (...args: never[]) => T, name: string, ...args: unknown[]): T {
  try {
    return (fn as (...a: unknown[]) => T)(...args);
  } catch (e) {
    return wrapHostError(e, "CODEC", `extern ${name}`);
  }
}

/** Runs a writer callback in a fresh region and returns the bytes (view patch encoders). */
export function encodeWith(write: (w: Writer) => void): Uint8Array {
  return serializeWith(undefined, write);
}

/** Built-in extern type: unsigned LEB128 (value as bigint). */
export const uleb128 = {
  size(bytes: Uint8Array, maxBytes = 10): number | undefined {
    for (let i = 0; i < bytes.length && i < maxBytes; i++) if (!(bytes[i]! & 0x80)) return i + 1;
    if (bytes.length >= maxBytes) fail("CHECK", `LEB128 longer than ${maxBytes} bytes`);
    return undefined;
  },
  read(bytes: Uint8Array): bigint {
    let v = 0n;
    for (let i = bytes.length - 1; i >= 0; i--) v = (v << 7n) | BigInt(bytes[i]! & 0x7f);
    return v;
  },
  write(value: bigint | number): Uint8Array {
    let v = BigInt(value);
    if (v < 0n) fail("RANGE", "uleb128 cannot encode a negative value");
    const out: number[] = [];
    do {
      let b = Number(v & 0x7fn);
      v >>= 7n;
      if (v) b |= 0x80;
      out.push(b);
    } while (v);
    return Uint8Array.from(out);
  }
};

/** Built-in extern type: signed LEB128 (value as bigint). */
export const sleb128 = {
  size(bytes: Uint8Array, maxBytes = 10): number | undefined {
    return uleb128.size(bytes, maxBytes);
  },
  read(bytes: Uint8Array): bigint {
    const v = uleb128.read(bytes);
    const bits = BigInt(bytes.length * 7);
    return bytes.length && bytes[bytes.length - 1]! & 0x40 ? v - (1n << bits) : v;
  },
  write(value: bigint | number): Uint8Array {
    let v = BigInt(value);
    const out: number[] = [];
    for (;;) {
      const b = Number(v & 0x7fn);
      v >>= 7n;
      const done = (v === 0n && !(b & 0x40)) || (v === -1n && b & 0x40);
      out.push(done ? b : b | 0x80);
      if (done) break;
    }
    return Uint8Array.from(out);
  }
};
