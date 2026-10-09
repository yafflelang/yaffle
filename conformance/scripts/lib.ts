/**
 * Building blocks for the case generators (conformance/scripts/areas).
 *
 * Expected bytes and JSON are computed here **independently of every backend**: plain byte
 * writers, IEEE conversions done by hand (f16) or by the platform's DataView (f32/f64), and the
 * canonical-JSON rules of docs/CONFORMANCE.md §3 written out directly.
 */
import type { Case } from "../src/adapter.ts";

export type { Case };
export type Endian = "le" | "be";

// ─────────────────────────────────────────────────────────────────────────────
// Floats
// ─────────────────────────────────────────────────────────────────────────────

function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** IEEE 754 binary16 bits of a double, rounding to nearest, ties to even. NaN → 0x7e00. */
export function f16Bits(v: number): number {
  if (Number.isNaN(v)) return 0x7e00;
  const sign = v < 0 || Object.is(v, -0) ? 0x8000 : 0;
  const a = Math.abs(v);
  if (a === Infinity) return sign | 0x7c00;
  if (a === 0) return sign;
  // Subnormal range: below 2^-14, in units of 2^-24.
  if (a < 2 ** -14) {
    const m = roundHalfEven(a / 2 ** -24);
    return sign | m; // m == 1024 gives the smallest normal, which is the right encoding
  }
  let e = Math.floor(Math.log2(a));
  while (2 ** e > a) e--;
  while (2 ** (e + 1) <= a) e++;
  let m = roundHalfEven((a / 2 ** e - 1) * 1024);
  if (m === 1024) {
    m = 0;
    e++;
  }
  if (e > 15) return sign | 0x7c00;
  return sign | ((e + 15) << 10) | m;
}

/** The value of binary16 bits. */
export function f16Value(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const e = (bits >> 10) & 0x1f;
  const m = bits & 0x3ff;
  if (e === 0) return sign * m * 2 ** -24;
  if (e === 31) return m === 0 ? sign * Infinity : NaN;
  return sign * (1 + m / 1024) * 2 ** (e - 15);
}

/** Canonical JSON of a float value: a number, or "NaN", "Infinity", "-Infinity", "-0". */
export function fl(v: number): number | string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Infinity) return "Infinity";
  if (v === -Infinity) return "-Infinity";
  if (Object.is(v, -0)) return "-0";
  return v;
}

/** Canonical JSON of the f32 nearest to v. */
export function f32j(v: number): number | string {
  return fl(Math.fround(v));
}

/** Canonical JSON of a 56/64-bit integer: a decimal string. */
export function big(v: bigint | number): string {
  return BigInt(v).toString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Byte writer
// ─────────────────────────────────────────────────────────────────────────────

export class W {
  readonly out: number[] = [];

  get length(): number {
    return this.out.length;
  }

  /** Unsigned (or two's complement, if negative) integer of `bits` bits. */
  int(bits: number, v: number | bigint, e: Endian = "le"): this {
    const n = bits / 8;
    let x = BigInt(v);
    const mod = 1n << BigInt(bits);
    if (x < -(mod >> 1n) || x >= mod) throw new Error(`${v} does not fit in ${bits} bits`);
    if (x < 0n) x += mod;
    const bytes: number[] = [];
    for (let i = 0; i < n; i++) {
      bytes.push(Number(x & 0xffn));
      x >>= 8n;
    }
    if (e === "be") bytes.reverse();
    this.out.push(...bytes);
    return this;
  }
  u8(v: number | bigint): this {
    return this.int(8, v);
  }
  i8(v: number | bigint): this {
    return this.int(8, v);
  }
  u16(v: number | bigint, e: Endian = "le"): this {
    return this.int(16, v, e);
  }
  u24(v: number | bigint, e: Endian = "le"): this {
    return this.int(24, v, e);
  }
  u32(v: number | bigint, e: Endian = "le"): this {
    return this.int(32, v, e);
  }
  u48(v: number | bigint, e: Endian = "le"): this {
    return this.int(48, v, e);
  }
  u64(v: number | bigint, e: Endian = "le"): this {
    return this.int(64, v, e);
  }
  f16bits(bits: number, e: Endian = "le"): this {
    return this.int(16, bits, e);
  }
  f16(v: number, e: Endian = "le"): this {
    return this.f16bits(f16Bits(v), e);
  }
  f32(v: number, e: Endian = "le"): this {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, v, e === "le");
    this.out.push(...new Uint8Array(dv.buffer));
    return this;
  }
  f64(v: number, e: Endian = "le"): this {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, v, e === "le");
    this.out.push(...new Uint8Array(dv.buffer));
    return this;
  }
  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }
  /** Raw bytes: hex text (spaces allowed), an array, or another writer. */
  raw(b: string | number[] | Uint8Array | W): this {
    if (typeof b === "string") {
      const h = b.replace(/[\s_]/g, "");
      if (h.length % 2) throw new Error(`odd hex ${b}`);
      for (let i = 0; i < h.length; i += 2) this.out.push(parseInt(h.slice(i, i + 2), 16));
    } else if (b instanceof W) this.out.push(...b.out);
    else this.out.push(...b);
    return this;
  }
  /** UTF-8 text, no terminator. */
  text(s: string): this {
    this.out.push(...new TextEncoder().encode(s));
    return this;
  }
  /** Latin-1 text (code points must be < 256). */
  latin1(s: string): this {
    for (const ch of s) {
      const c = ch.codePointAt(0)!;
      if (c > 255) throw new Error(`not latin1: ${ch}`);
      this.out.push(c);
    }
    return this;
  }
  /** UTF-8 text plus a NUL. */
  cstr(s: string): this {
    return this.text(s).u8(0);
  }
  utf16(s: string, e: Endian = "le"): this {
    for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i), e);
    return this;
  }
  utf32(s: string, e: Endian = "le"): this {
    for (const ch of s) this.u32(ch.codePointAt(0)!, e);
    return this;
  }
  fill(n: number, byte = 0): this {
    for (let i = 0; i < n; i++) this.out.push(byte & 0xff);
    return this;
  }
  zeros(n: number): this {
    return this.fill(n, 0);
  }
  /** Pads with `byte` until the total length is `len`. */
  padTo(len: number, byte = 0): this {
    if (this.length > len) throw new Error(`already ${this.length} bytes, past ${len}`);
    return this.fill(len - this.length, byte);
  }
  /** Pads with zeros until the length is a multiple of `to`. */
  align(to: number): this {
    return this.zeros((to - (this.length % to)) % to);
  }
  /** Overwrites bytes at `at` (for back-patching offsets). */
  patch(at: number, b: W): this {
    b.out.forEach((x, i) => (this.out[at + i] = x));
    return this;
  }
  hex(): string {
    return toHex(this.out);
  }
}

export function w(): W {
  return new W();
}

export function toHex(b: Uint8Array | number[]): string {
  return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

export function utf8Hex(s: string): string {
  return toHex(new TextEncoder().encode(s));
}

// ─────────────────────────────────────────────────────────────────────────────
// Checksums and codecs (reference implementations for expected values)
// ─────────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE 802.3 / zlib), the `crc32` built-in. */
export function crc32(b: Uint8Array | number[]): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Adler-32, the `adler32` built-in. */
export function adler32(b: Uint8Array | number[]): number {
  let a = 1;
  let s = 0;
  for (const x of b) {
    a = (a + x) % 65521;
    s = (s + a) % 65521;
  }
  return ((s << 16) | a) >>> 0;
}

/** The conformance `rle` codec's encoder (greedy, runs ≤ 255). */
export function rleEncode(b: number[] | Uint8Array): number[] {
  const out: number[] = [];
  const a = [...b];
  let i = 0;
  while (i < a.length) {
    let n = 1;
    while (i + n < a.length && a[i + n] === a[i] && n < 255) n++;
    out.push(n, a[i]!);
    i += n;
  }
  return out;
}

export function xorBytes(b: number[] | Uint8Array, key: number): number[] {
  return [...b].map(x => x ^ key);
}

export function sum8(b: number[] | Uint8Array): number {
  return [...b].reduce((s, x) => (s + x) & 0xff, 0);
}

/** Unsigned LEB128. */
export function leb128(v: bigint | number): number[] {
  let x = BigInt(v);
  const out: number[] = [];
  do {
    const b = Number(x & 0x7fn);
    x >>= 7n;
    out.push(x === 0n ? b : b | 0x80);
  } while (x !== 0n);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Case constructors
// ─────────────────────────────────────────────────────────────────────────────

type Extra = Partial<Pick<Case, "args" | "strict" | "roundtrip" | "description">>;
type Path = (string | number)[];

const hexOf = (bytes: string | W): string => (typeof bytes === "string" ? bytes : bytes.hex());

function error(
  phase: "parse" | "serialize",
  code: string,
  path?: Path
): NonNullable<Case["error"]> {
  return path ? { phase, code, path } : { phase, code };
}

/** A parse case (with a JSON round trip unless `extra.roundtrip` says otherwise). */
export function parse(
  name: string,
  root: string,
  bytes: string | W,
  json: unknown,
  extra: Extra = {}
): Case {
  return {
    name,
    root,
    ...pick(extra),
    bytes: hexOf(bytes),
    json
  };
}

/** A parse case without a round trip (non-canonical input). */
export function parseOnly(
  name: string,
  root: string,
  bytes: string | W,
  json: unknown,
  extra: Extra = {}
): Case {
  return parse(name, root, bytes, json, { ...extra, roundtrip: false });
}

/** A serialize case: serialize(fromJson(input)) must equal bytes. */
export function ser(
  name: string,
  root: string,
  input: unknown,
  bytes: string | W,
  extra: Omit<Extra, "roundtrip"> = {}
): Case {
  return {
    name,
    root,
    ...pick(extra),
    input,
    bytes: hexOf(bytes)
  };
}

/** A parse error case. */
export function perr(
  name: string,
  root: string,
  bytes: string | W,
  code: string,
  path?: Path,
  extra: Omit<Extra, "roundtrip"> = {}
): Case {
  return {
    name,
    root,
    ...pick(extra),
    bytes: hexOf(bytes),
    error: error("parse", code, path)
  };
}

/** A serialize error case. */
export function serr(
  name: string,
  root: string,
  input: unknown,
  code: string,
  path?: Path,
  extra: Omit<Extra, "roundtrip"> = {}
): Case {
  return { name, root, ...pick(extra), input, error: error("serialize", code, path) };
}

function pick(extra: Extra): Extra {
  const out: Extra = {};
  if (extra.description !== undefined) out.description = extra.description;
  if (extra.args !== undefined) out.args = extra.args;
  if (extra.strict !== undefined) out.strict = extra.strict;
  if (extra.roundtrip !== undefined) out.roundtrip = extra.roundtrip;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Case files
// ─────────────────────────────────────────────────────────────────────────────

export interface Area {
  /** Directory under conformance/cases/. */
  dir: string;
  description: string;
  cases: Case[];
}

/** Checks a list of cases for duplicate names before it's written. */
export function area(dir: string, description: string, cases: Case[]): Area {
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.name)) throw new Error(`${dir}: duplicate case name ${c.name}`);
    seen.add(c.name);
  }
  return { dir, description, cases };
}

/** JSON text with short arrays/objects on one line (stable, readable diffs). */
export function stringify(value: unknown, indent = ""): string {
  const flat = JSON.stringify(value);
  if (flat === undefined) throw new Error("cannot stringify undefined");
  if (flat.length + indent.length <= 96 || value === null || typeof value !== "object") return flat;
  const inner = indent + "  ";
  if (Array.isArray(value)) {
    return `[\n${value.map(v => inner + stringify(v, inner)).join(",\n")}\n${indent}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => v !== undefined
  );
  return `{\n${entries.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${stringify(v, inner)}`).join(",\n")}\n${indent}}`;
}
