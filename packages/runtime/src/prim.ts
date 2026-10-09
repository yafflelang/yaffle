/**
 * Primitive encodings: N-byte integers (both endiannesses, 1..8 bytes), IEEE half/single/double.
 *
 * Representation in TS (docs/IR.md §6): integers of up to 48 bits are `number`, 56- and 64-bit
 * integers are `bigint`. Floats are `number`.
 */
import { fail } from "./errors.ts";

const PRIM_KINDS = [
  "u8",
  "u16",
  "u24",
  "u32",
  "u40",
  "u48",
  "u56",
  "u64",
  "i8",
  "i16",
  "i24",
  "i32",
  "i40",
  "i48",
  "i56",
  "i64",
  "f16",
  "f32",
  "f64"
] as const;

export type PrimKind = (typeof PRIM_KINDS)[number];

export type Endian = "le" | "be";

export interface PrimInfo {
  size: number;
  signed: boolean;
  float: boolean;
  /** Represented as bigint in TS. */
  big: boolean;
  bits: number;
}

function info(kind: PrimKind): PrimInfo {
  const float = kind[0] === "f";
  const bits = Number(kind.slice(1));
  return { size: bits / 8, signed: kind[0] === "i", float, big: !float && bits > 48, bits };
}

export const PRIMS = Object.fromEntries(PRIM_KINDS.map(k => [k, info(k)])) as Record<
  PrimKind,
  PrimInfo
>;

// ── half precision ────────────────────────────────────────────────────────────

/** IEEE 754 binary16 bits → number. */
export function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * frac * 2 ** -24;
  if (exp === 0x1f) return frac ? NaN : sign * Infinity;
  return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}

/** number → IEEE 754 binary16 bits, rounding to nearest even (directly from the double). */
export function floatToHalf(v: number): number {
  if (Number.isNaN(v)) return 0x7e00;
  const sign = v < 0 || Object.is(v, -0) ? 0x8000 : 0;
  const a = Math.abs(v);
  if (a === 0) return sign;
  if (a === Infinity) return sign | 0x7c00;
  let e = Math.floor(Math.log2(a));
  if (2 ** e > a) e--;
  else if (2 ** (e + 1) <= a) e++;
  if (e < -14) return sign | roundHalfEven(a * 2 ** 24); // subnormal (1024 = smallest normal)
  let q = roundHalfEven(a / 2 ** (e - 10)); // 1024..2048
  if (q === 2048) {
    q = 1024;
    e++;
  }
  if (e > 15) return sign | 0x7c00;
  return sign | ((e + 15) << 10) | (q - 1024);
}

function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

// ── generic integer access ────────────────────────────────────────────────────

/** Sign-extends the low `width` bits of a non-negative number. */
export function signExtend(v: number, width: number): number {
  const lim = 2 ** width;
  return v >= lim / 2 ? v - lim : v;
}

/** Reads an unsigned integer of `size` bytes (≤ 6) as a number. */
export function readUintN(b: Uint8Array, off: number, size: number, le: boolean): number {
  let v = 0;
  if (le) for (let i = size - 1; i >= 0; i--) v = v * 256 + b[off + i]!;
  else for (let i = 0; i < size; i++) v = v * 256 + b[off + i]!;
  return v;
}

/** Reads an unsigned integer of `size` bytes (any) as a bigint. */
export function readUintNBig(b: Uint8Array, off: number, size: number, le: boolean): bigint {
  if (size <= 6) return BigInt(readUintN(b, off, size, le));
  const lo = le ? readUintN(b, off, 4, true) : readUintN(b, off + size - 4, 4, false);
  const hi = le ? readUintN(b, off + 4, size - 4, true) : readUintN(b, off, size - 4, false);
  return (BigInt(hi) << 32n) | BigInt(lo);
}

/** Writes an unsigned integer (number, ≤ 6 bytes, already range checked and non-negative). */
export function writeUintN(b: Uint8Array, off: number, size: number, v: number, le: boolean): void {
  for (let i = 0; i < size; i++) {
    const byte = v % 256;
    b[le ? off + i : off + size - 1 - i] = byte;
    v = (v - byte) / 256;
  }
}

export function writeUintNBig(
  b: Uint8Array,
  off: number,
  size: number,
  v: bigint,
  le: boolean
): void {
  for (let i = 0; i < size; i++) {
    b[le ? off + i : off + size - 1 - i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

/** Reads any primitive. Integers > 48 bits come back as bigint. */
export function readPrim(
  b: Uint8Array,
  dv: DataView,
  off: number,
  kind: PrimKind,
  le: boolean
): number | bigint {
  switch (kind) {
    case "u8":
      return b[off]!;
    case "i8":
      return dv.getInt8(off);
    case "u16":
      return dv.getUint16(off, le);
    case "i16":
      return dv.getInt16(off, le);
    case "u32":
      return dv.getUint32(off, le);
    case "i32":
      return dv.getInt32(off, le);
    case "u64":
      return dv.getBigUint64(off, le);
    case "i64":
      return dv.getBigInt64(off, le);
    case "f16":
      return halfToFloat(dv.getUint16(off, le));
    case "f32":
      return dv.getFloat32(off, le);
    case "f64":
      return dv.getFloat64(off, le);
    case "u24":
    case "u40":
    case "u48":
      return readUintN(b, off, PRIMS[kind].size, le);
    case "i24":
    case "i40":
    case "i48":
      return signExtend(readUintN(b, off, PRIMS[kind].size, le), PRIMS[kind].bits);
    case "u56":
      return readUintNBig(b, off, 7, le);
    case "i56":
      return BigInt.asIntN(56, readUintNBig(b, off, 7, le));
  }
}

/** Writes any primitive. The value must already be in range (see `checkPrim`). */
export function writePrim(
  b: Uint8Array,
  dv: DataView,
  off: number,
  kind: PrimKind,
  v: number | bigint,
  le: boolean
): void {
  switch (kind) {
    case "u8":
    case "i8":
      b[off] = Number(v) & 0xff;
      return;
    case "u16":
    case "i16":
      dv.setUint16(off, Number(v) & 0xffff, le);
      return;
    case "u32":
    case "i32":
      dv.setUint32(off, Number(v) >>> 0, le);
      return;
    case "u64":
      dv.setBigUint64(off, BigInt.asUintN(64, BigInt(v)), le);
      return;
    case "i64":
      dv.setBigInt64(off, BigInt.asIntN(64, BigInt(v)), le);
      return;
    case "f16":
      dv.setUint16(off, floatToHalf(Number(v)), le);
      return;
    case "f32":
      dv.setFloat32(off, Number(v), le);
      return;
    case "f64":
      dv.setFloat64(off, Number(v), le);
      return;
    case "u24":
    case "u40":
    case "u48":
    case "i24":
    case "i40":
    case "i48": {
      const size = PRIMS[kind].size;
      let n = Number(v);
      if (n < 0) n += 2 ** (size * 8);
      writeUintN(b, off, size, n, le);
      return;
    }
    case "u56":
    case "i56":
      writeUintNBig(b, off, 7, BigInt.asUintN(56, BigInt(v)), le);
      return;
  }
}

// ── range checks ──────────────────────────────────────────────────────────────

export function primMin(kind: PrimKind): bigint {
  const p = PRIMS[kind];
  return p.signed ? -(1n << BigInt(p.bits - 1)) : 0n;
}

export function primMax(kind: PrimKind): bigint {
  const p = PRIMS[kind];
  return p.signed ? (1n << BigInt(p.bits - 1)) - 1n : (1n << BigInt(p.bits)) - 1n;
}

const NUM_RANGES: Partial<Record<PrimKind, [number, number]>> = {};
for (const k of PRIM_KINDS) {
  const p = PRIMS[k];
  if (!p.float && !p.big) NUM_RANGES[k] = [Number(primMin(k)), Number(primMax(k))];
}

/**
 * Validates a value destined for an integer or float primitive and returns it in the TS
 * representation of that primitive (number or bigint). Wrong type → INPUT, out of range → RANGE.
 */
export function checkPrim(v: unknown, kind: PrimKind, what: string = kind): number | bigint {
  const p = PRIMS[kind];
  if (p.float) {
    if (typeof v === "number") return v;
    if (typeof v === "bigint") return Number(v);
    return fail("INPUT", `expected a number for ${what}, got ${describe(v)}`);
  }
  if (p.big) {
    let b: bigint;
    if (typeof v === "bigint") b = v;
    else if (typeof v === "number" && Number.isInteger(v)) b = BigInt(v);
    else return fail("INPUT", `expected an integer for ${what}, got ${describe(v)}`);
    if (b < primMin(kind) || b > primMax(kind))
      return fail("RANGE", `${b} is out of range for ${kind}`);
    return b;
  }
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "bigint") n = Number(v);
  else return fail("INPUT", `expected an integer for ${what}, got ${describe(v)}`);
  const r = NUM_RANGES[kind]!;
  if (!Number.isInteger(n)) {
    return fail(Number.isFinite(n) ? "RANGE" : "INPUT", `${n} is not an integer (${kind})`);
  }
  if (n < r[0] || n > r[1] || (typeof v === "bigint" && BigInt(n) !== v)) {
    return fail("RANGE", `${typeof v === "bigint" ? v : n} is out of range for ${kind}`);
  }
  return n;
}

export function describe(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") return JSON.stringify(v.length > 40 ? v.slice(0, 40) + "…" : v);
  if (typeof v === "bigint") return `${v}n`;
  if (v instanceof Uint8Array) return `Uint8Array(${v.length})`;
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === "object") return "object";
  return String(v);
}
