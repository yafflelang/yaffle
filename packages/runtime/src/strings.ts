/**
 * Text encodings: utf8 / ascii / latin1 (1-byte units), utf16 (2-byte units), utf32 (4-byte
 * units). Lengths always count code units. Reading stops the value at the first NUL unit.
 * Invalid input on read is a CHECK error; text that cannot be encoded (or contains NUL, which
 * would read back differently) is an INPUT error on write.
 */
import { fail } from "./errors.ts";

export type StringEncoding = "utf8" | "ascii" | "latin1" | "utf16" | "utf32";
export type StringUnit = 1 | 2 | 4;

const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const utf8Encoder = new TextEncoder();

/** Returns the unit index (relative to `start`) of the first NUL unit in `[start, start + n*unit)`, or -1. */
export function findNulUnit(
  b: Uint8Array,
  start: number,
  nUnits: number,
  unit: StringUnit
): number {
  if (unit === 1) return b.subarray(start, start + nUnits).indexOf(0);
  for (let i = 0; i < nUnits; i++) {
    const p = start + i * unit;
    let zero = true;
    for (let k = 0; k < unit; k++) {
      if (b[p + k] !== 0) {
        zero = false;
        break;
      }
    }
    if (zero) return i;
  }
  return -1;
}

function bytesToBinaryString(b: Uint8Array, start: number, end: number): string {
  let s = "";
  for (let p = start; p < end; p += 0x2000) {
    s += String.fromCharCode.apply(
      null,
      b.subarray(p, Math.min(end, p + 0x2000)) as unknown as number[]
    );
  }
  return s;
}

/**
 * Decodes `nUnits` code units at `start` (the caller has already cut at the NUL unit).
 * `at` is the absolute offset reported in errors.
 */
export function decodeString(
  b: Uint8Array,
  start: number,
  nUnits: number,
  enc: StringEncoding,
  le: boolean,
  at = start
): string {
  switch (enc) {
    case "latin1":
      return bytesToBinaryString(b, start, start + nUnits);
    case "ascii": {
      for (let i = 0; i < nUnits; i++) {
        if (b[start + i]! >= 0x80)
          fail("CHECK", `byte 0x${b[start + i]!.toString(16)} is not ASCII`, at + i);
      }
      return bytesToBinaryString(b, start, start + nUnits);
    }
    case "utf8": {
      let ascii = true;
      for (let i = 0; i < nUnits; i++) {
        if (b[start + i]! >= 0x80) {
          ascii = false;
          break;
        }
      }
      if (ascii) return bytesToBinaryString(b, start, start + nUnits);
      try {
        return utf8Decoder.decode(b.subarray(start, start + nUnits));
      } catch {
        return fail("CHECK", "invalid UTF-8", at);
      }
    }
    case "utf16": {
      let s = "";
      for (let i = 0; i < nUnits; i++) {
        const p = start + i * 2;
        const u = le ? b[p]! | (b[p + 1]! << 8) : (b[p]! << 8) | b[p + 1]!;
        if (u >= 0xd800 && u <= 0xdbff) {
          const q = p + 2;
          const next =
            i + 1 < nUnits ? (le ? b[q]! | (b[q + 1]! << 8) : (b[q]! << 8) | b[q + 1]!) : -1;
          if (next < 0xdc00 || next > 0xdfff)
            fail("CHECK", "invalid UTF-16 (lone high surrogate)", at + i * 2);
          s += String.fromCharCode(u, next);
          i++;
        } else if (u >= 0xdc00 && u <= 0xdfff) {
          fail("CHECK", "invalid UTF-16 (lone low surrogate)", at + i * 2);
        } else {
          s += String.fromCharCode(u);
        }
      }
      return s;
    }
    case "utf32": {
      let s = "";
      for (let i = 0; i < nUnits; i++) {
        const p = start + i * 4;
        const cp = le
          ? (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24)) >>> 0
          : ((b[p]! << 24) | (b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!) >>> 0;
        if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
          fail("CHECK", `invalid UTF-32 code point 0x${cp.toString(16)}`, at + i * 4);
        }
        s += String.fromCodePoint(cp);
      }
      return s;
    }
  }
}

/** Encodes text without any terminator or padding. */
export function encodeString(s: unknown, enc: StringEncoding, le: boolean): Uint8Array {
  if (typeof s !== "string") return fail("INPUT", `expected a string, got ${typeof s}`);
  switch (enc) {
    case "utf8": {
      if (s.includes("\0")) fail("INPUT", "string contains NUL");
      if (!isWellFormed(s)) fail("INPUT", "string is not well-formed UTF-16 (lone surrogate)");
      return utf8Encoder.encode(s);
    }
    case "ascii":
    case "latin1": {
      const lim = enc === "ascii" ? 0x80 : 0x100;
      const out = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 0) fail("INPUT", "string contains NUL");
        if (c >= lim) fail("INPUT", `character U+${c.toString(16).padStart(4, "0")} is not ${enc}`);
        out[i] = c;
      }
      return out;
    }
    case "utf16": {
      if (!isWellFormed(s)) fail("INPUT", "string is not well-formed UTF-16 (lone surrogate)");
      const out = new Uint8Array(s.length * 2);
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 0) fail("INPUT", "string contains NUL");
        out[i * 2 + (le ? 0 : 1)] = c & 0xff;
        out[i * 2 + (le ? 1 : 0)] = c >> 8;
      }
      return out;
    }
    case "utf32": {
      if (!isWellFormed(s)) fail("INPUT", "string is not well-formed UTF-16 (lone surrogate)");
      const cps: number[] = [];
      for (const ch of s) cps.push(ch.codePointAt(0)!);
      const out = new Uint8Array(cps.length * 4);
      const dv = new DataView(out.buffer);
      cps.forEach((cp, i) => {
        if (cp === 0) fail("INPUT", "string contains NUL");
        dv.setUint32(i * 4, cp, le);
      });
      return out;
    }
  }
}

/** True if `s` has no lone surrogates. */
export function isWellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

/** Bytes `s` occupies in the given encoding (the IR builtin `encodedLength`). */
export function encodedBytes(s: unknown, enc: StringEncoding): number {
  if (typeof s !== "string") return fail("INPUT", `expected a string, got ${typeof s}`);
  return codeUnits(s, enc) * unitOf(enc);
}

/** Code units `s` occupies in the given encoding (`len()` / `.length` of a string). */
export function codeUnits(s: unknown, enc: StringEncoding): number {
  if (typeof s !== "string") return fail("INPUT", `expected a string, got ${typeof s}`);
  return encodedLength(s, enc);
}

/** Number of code units `s` occupies in the given encoding. */
export function encodedLength(s: string, enc: StringEncoding): number {
  switch (enc) {
    case "utf8":
      return utf8Encoder.encode(s).length;
    case "ascii":
    case "latin1":
    case "utf16":
      return s.length;
    case "utf32": {
      let n = 0;
      for (const _ of s) n++;
      return n;
    }
  }
}

/** Unit size implied by an encoding. */
export function unitOf(enc: StringEncoding): StringUnit {
  return enc === "utf16" ? 2 : enc === "utf32" ? 4 : 1;
}
