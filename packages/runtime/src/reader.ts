/**
 * The read context (docs/IR.md §2.1) used by generated readers: position, base, region end,
 * array index and strict flag over a byte store, plus primitive, string and padding readers.
 * Positions are absolute within the store; `base` and `end` are absolute too.
 */
import { YaffleError, wrapHostError, type ErrorCode } from "./errors.ts";
import { halfToFloat, readUintN, readUintNBig, signExtend } from "./prim.ts";
import { decodeString, findNulUnit, type StringEncoding, type StringUnit } from "./strings.ts";
import { ArrayStore, UNKNOWN_END, storeCovers, type ByteStore } from "./source.ts";

/** Padding fill: a byte value, or a function of the byte's index within the padding run. */
export type Fill = number | ((i: number) => number);

export function fillByte(fill: Fill, i: number): number {
  return typeof fill === "number" ? fill & 0xff : Number(BigInt.asUintN(8, BigInt(fill(i))));
}

export interface ReaderOptions {
  strict?: boolean;
  /** Offset reported for errors inside a decoded region (the encoded window in the outer region). */
  outer?: number;
}

export class Reader {
  readonly store: ByteStore;
  /** Current window into the store: bytes `[off0, off0 + buf.length)`. */
  buf: Uint8Array;
  dv: DataView;
  off0 = 0;
  bufEnd: number;
  pos = 0;
  base = 0;
  /** End of the current region; `UNKNOWN_END` until resolved over a lazy-size store. */
  private _end: number;
  index = -1;
  strict: boolean;
  /** Bytes values are copied instead of aliasing the store (decoded regions). */
  copy = false;
  /** Furthest position read inside the current base (inline and targets): a base struct consumes it all. */
  maxEnd = 0;
  /** Object a struct reader fills instead of a new one (identity registered before reading, so cycles work). */
  private into: object | undefined;
  /** Set by a base struct's scan: the end of its inline bytes (before its targets). */
  inlineEnd = -1;
  /** End position of the last target read with `target()`. */
  lastTargetEnd = 0;
  private readonly identEnd = new Map<string, number>();
  /** Target identity within this region: `${address}:${typeKey}` → value. */
  readonly ident = new Map<string, unknown>();
  private readonly inProgress = new Set<string>();
  readonly outer: number | undefined;

  constructor(src: Uint8Array | ByteStore, opts: ReaderOptions = {}) {
    this.store = src instanceof Uint8Array ? new ArrayStore(src) : src;
    this._end = this.store.lazySize ? UNKNOWN_END : this.store.size;
    this.strict = opts.strict ?? false;
    this.outer = opts.outer;
    const whole = this.store.whole;
    if (whole) {
      this.buf = whole;
      this.bufEnd = whole.length;
    } else {
      this.buf = new Uint8Array(0);
      this.bufEnd = 0;
    }
    this.dv = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
  }

  /** A reader for a fresh region (virtual stream): base 0, end = length. */
  sub(bytes: Uint8Array | ByteStore): Reader {
    return this.inner(bytes, this.pos, this.copy);
  }

  /** A reader over a codec's decoded output. Bytes values are copies (the output stays private). */
  decoded(bytes: Uint8Array, at: number): Reader {
    const plain = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return this.inner(plain, at, true);
  }

  /** A reader over another byte space; it fills the pre-registered object, if any. */
  private inner(bytes: Uint8Array | ByteStore, at: number, copy: boolean): Reader {
    const r = new Reader(bytes, { strict: this.strict, outer: this.outer ?? at });
    r.copy = copy;
    r.into = this.into;
    this.into = undefined;
    return r;
  }

  /** Called first by every generated struct reader: the pre-registered object to fill, if any. */
  takeInto(): object | undefined {
    const o = this.into;
    this.into = undefined;
    return o;
  }

  /** Bytes `[start, end)` (absolute) without moving `pos`. */
  peekBytes(start: number, end: number): Uint8Array {
    if (start < 0 || start > end || !storeCovers(this.store, end)) {
      this.fail(
        "EOF",
        `range [0x${start.toString(16)}, 0x${end.toString(16)}) is outside the data`,
        start
      );
    }
    if (this.store.whole) return this.store.whole.subarray(start, end);
    return this.store.get(start, end - start);
  }

  /**
   * Absolute end of the current region. Over a lazy-size store (a virtual stream whose pieces
   * are decoded on demand) reading it resolves the store's size, so code that only needs bounds
   * checks uses `covers` and `rawEnd` instead.
   */
  get end(): number {
    if (this._end === UNKNOWN_END) this._end = this.store.size;
    return this._end;
  }
  set end(v: number) {
    this._end = v;
  }

  /** The region end without resolving it (`UNKNOWN_END` = the end of a lazy-size store). */
  get rawEnd(): number {
    return this._end;
  }

  /** Whether the region holds bytes up to absolute position `x` (resolves as little as possible). */
  covers(x: number): boolean {
    if (this._end !== UNKNOWN_END) return x <= this._end;
    return storeCovers(this.store, x);
  }

  // ── errors ────────────────────────────────────────────────────────────────

  at(offset: number): number {
    return this.outer ?? offset;
  }

  error(code: ErrorCode, detail: string, offset = this.pos): YaffleError {
    return new YaffleError(code, detail, this.at(offset));
  }

  fail(code: ErrorCode, detail: string, offset = this.pos): never {
    throw this.error(code, detail, offset);
  }

  checkFail(message: string, offset: number): never {
    throw this.error("CHECK", `check failed: ${message}`, offset);
  }

  // ── bounds and windows ────────────────────────────────────────────────────

  /** Ensures `n` bytes are readable at `pos` (EOF past the region end). */
  need(n: number): void {
    const e = this.pos + n;
    if (e > this._end || n < 0) this.eof(n);
    if (e > this.bufEnd || this.pos < this.off0) this.refill(this.pos, n);
  }

  private eof(n: number): never {
    return this.fail(
      "EOF",
      `need ${n} bytes at 0x${this.pos.toString(16)}, region ends at 0x${this._end === UNKNOWN_END ? "?" : this._end.toString(16)}`
    );
  }

  private refill(pos: number, n: number): void {
    const st = this.store;
    // Up to the next chunk boundary, so refills line up with the store's blocks.
    const chunk = st.chunk ?? 0x4000;
    const want = Math.max(n, chunk - (pos % chunk));
    const w = st.getSome ? st.getSome(pos, n, want) : st.get(pos, Math.min(st.size - pos, want));
    if (w.length < n) this.eof(n);
    this.buf = w;
    this.off0 = pos;
    this.bufEnd = pos + w.length;
    this.dv = new DataView(w.buffer, w.byteOffset, w.byteLength);
  }

  /** Remaining bytes in the region. */
  get remaining(): number {
    return this.end - this.pos;
  }

  /** Narrows the region to `n` bytes from `pos`; returns the previous end for `closeWindow`. */
  window(n: number): number {
    const saved = this._end;
    if (!Number.isSafeInteger(n) || n < 0) this.fail("RANGE", `invalid size ${n}`);
    if (!this.covers(this.pos + n)) {
      this.fail(
        "EOF",
        `size ${n} at 0x${this.pos.toString(16)} exceeds the region end 0x${this.end.toString(16)}`
      );
    }
    this._end = this.pos + n;
    return saved;
  }

  /** Skips the rest of the window (padding, strict: zero) and restores the outer end. */
  closeWindow(saved: number, strict: boolean): void {
    const left = this._end - this.pos;
    if (left > 0) this.pad(left, 0, strict);
    this._end = saved;
  }

  // ── integers and floats ───────────────────────────────────────────────────

  /**
   * Consumes `n` bytes; returns their index in the window. Read `buf`/`dv` only after calling it:
   * it may move the window.
   */
  private take(n: number): number {
    this.need(n);
    const p = this.pos - this.off0;
    this.pos += n;
    return p;
  }

  u8(): number {
    const p = this.take(1);
    return this.buf[p]!;
  }
  i8(): number {
    const p = this.take(1);
    return this.dv.getInt8(p);
  }
  u16(le: boolean): number {
    const p = this.take(2);
    return this.dv.getUint16(p, le);
  }
  i16(le: boolean): number {
    const p = this.take(2);
    return this.dv.getInt16(p, le);
  }
  u32(le: boolean): number {
    const p = this.take(4);
    return this.dv.getUint32(p, le);
  }
  i32(le: boolean): number {
    const p = this.take(4);
    return this.dv.getInt32(p, le);
  }
  u64(le: boolean): bigint {
    const p = this.take(8);
    return this.dv.getBigUint64(p, le);
  }
  i64(le: boolean): bigint {
    const p = this.take(8);
    return this.dv.getBigInt64(p, le);
  }
  f16(le: boolean): number {
    return halfToFloat(this.u16(le));
  }
  f32(le: boolean): number {
    const p = this.take(4);
    return this.dv.getFloat32(p, le);
  }
  f64(le: boolean): number {
    const p = this.take(8);
    return this.dv.getFloat64(p, le);
  }
  /** Unsigned N-byte integer (N ≤ 6) as a number: u24, u40, u48. */
  uN(size: number, le: boolean): number {
    const p = this.take(size);
    return readUintN(this.buf, p, size, le);
  }
  /** Signed N-byte integer (N ≤ 6) as a number: i24, i40, i48. */
  iN(size: number, le: boolean): number {
    return signExtend(this.uN(size, le), size * 8);
  }
  /** u56 as a bigint. */
  u56(le: boolean): bigint {
    const p = this.take(7);
    return readUintNBig(this.buf, p, 7, le);
  }
  i56(le: boolean): bigint {
    return BigInt.asIntN(56, this.u56(le));
  }

  bool(strict: boolean): boolean {
    const at = this.pos;
    const b = this.u8();
    if (strict && b > 1) this.fail("CHECK", `bool byte 0x${b.toString(16)} is not 0 or 1`, at);
    return b !== 0;
  }

  /**
   * A count read from the data (array/bytes/string length): negative is RANGE, more units than
   * the region has left is EOF whatever the magnitude.
   */
  count(v: number | bigint, unit = 1, what = "length"): number {
    if (v < 0) this.fail("RANGE", `${what} ${v} is negative`);
    const n = Number(v);
    // A count no region could hold (beyond 2^53) runs out of bytes: EOF, not RANGE. Smaller
    // counts fail on the element that crosses the end (its path is more useful).
    if (!Number.isSafeInteger(n) || (unit > 0 && n * unit > Number.MAX_SAFE_INTEGER)) {
      this.fail(
        "EOF",
        `${what} ${v} needs more than the ${Math.max(0, this.end - this.pos)} bytes left`
      );
    }
    return n;
  }

  // ── bytes ─────────────────────────────────────────────────────────────────

  /** `n` bytes. Zero-copy (a subarray of the source) for in-memory sources. */
  bytes(n: number): Uint8Array {
    let out: Uint8Array;
    if (this.store.whole) {
      this.need(n);
      out = this.buf.subarray(this.pos - this.off0, this.pos - this.off0 + n);
      // new Uint8Array(x) always copies (Buffer#slice would not).
      if (this.copy) out = new Uint8Array(out);
    } else {
      if (n < 0 || !this.covers(this.pos + n)) this.eof(n);
      out = new Uint8Array(this.store.get(this.pos, n));
    }
    this.pos += n;
    return out;
  }

  /** Bytes up to a terminator byte (consumed, not part of the value). */
  bytesUntil(term: number): Uint8Array {
    const i = this.findUnit(1, u => u === (term & 0xff));
    const out = this.bytes(i);
    this.pos += 1;
    return out;
  }

  /** Bytes to the end of the region. */
  bytesRest(): Uint8Array {
    return this.bytes(this.end - this.pos);
  }

  /**
   * Index (in units, from `pos`) of the first unit satisfying `pred` before the region end.
   * EOF if there is none.
   */
  findUnit(unit: number, pred: (u: number) => boolean): number {
    // Over a lazy-size store, look ahead in growing chunks before resolving the region end.
    let i = 0;
    if (this._end === UNKNOWN_END) {
      for (let look = 256; this.covers(this.pos + look * unit); look *= 4) {
        const hit = this.scanUnits(unit, i, look, pred);
        if (hit >= 0) return hit;
        i = look;
      }
      i = 0;
    }
    const avail = Math.floor((this.end - this.pos) / unit);
    for (let chunk = Math.min(avail, 256); ; chunk = Math.min(avail, chunk * 4)) {
      const hit = this.scanUnits(unit, i, chunk, pred);
      if (hit >= 0) return hit;
      if (chunk >= avail) return this.fail("EOF", "terminator not found before the region end");
      i = chunk;
    }
  }

  /** The first unit index in `[from, to)` (from `pos`) satisfying `pred`, or -1. */
  private scanUnits(unit: number, from: number, to: number, pred: (u: number) => boolean): number {
    this.need(to * unit);
    const b = this.buf;
    const base = this.pos - this.off0;
    for (let i = from; i < to; i++) {
      const p = base + i * unit;
      let u = 0;
      if (unit === 1) u = b[p]!;
      else for (let k = 0; k < unit; k++) u = u * 256 + b[p + k]!;
      if (pred(u)) return i;
    }
    return -1;
  }

  // ── strings ───────────────────────────────────────────────────────────────

  /** Fixed length: `nUnits` code units, the value stops at the first NUL unit. */
  str(nUnits: number, unit: StringUnit, enc: StringEncoding, le: boolean): string {
    const n = nUnits * unit;
    this.need(n);
    const p = this.pos - this.off0;
    const nul = findNulUnit(this.buf, p, nUnits, unit);
    const s = decodeString(this.buf, p, nul < 0 ? nUnits : nul, enc, le, this.at(this.pos));
    this.pos += n;
    return s;
  }

  /** NUL-terminated: units up to a NUL unit (consumed). */
  strUntil(unit: StringUnit, enc: StringEncoding, le: boolean): string {
    const i = this.findUnit(unit, u => u === 0);
    const s = this.str(i, unit, enc, le);
    this.pos += unit;
    return s;
  }

  /** To the end of the region (the value stops at the first NUL unit). */
  strRest(unit: StringUnit, enc: StringEncoding, le: boolean): string {
    return this.str(Math.floor((this.end - this.pos) / unit), unit, enc, le);
  }

  // ── padding ───────────────────────────────────────────────────────────────

  /** Skips `n` padding bytes; in strict mode they must match the fill. */
  pad(n: number, fill: Fill, strict: boolean): void {
    if (!Number.isSafeInteger(n) || n < 0) this.fail("RANGE", `invalid padding length ${n}`);
    this.need(n);
    if (strict) {
      const p = this.pos - this.off0;
      for (let i = 0; i < n; i++) {
        const want = fillByte(fill, i);
        if (this.buf[p + i] !== want) {
          this.fail(
            "CHECK",
            `padding byte 0x${this.buf[p + i]!.toString(16)} is not 0x${want.toString(16)}`,
            this.pos + i
          );
        }
      }
    }
    this.pos += n;
  }

  /** `align(to)`: pads until `(pos - base) % to == 0`. */
  align(to: number, fill: Fill, strict: boolean): void {
    this.alignAt(to, fill, strict, this.base, 0);
  }

  /**
   * `align(to, from: …, offset: …)`: pads until `(pos - origin + offset) % to == 0`. `origin` is
   * the absolute position alignment counts from: `base` for the nearest `@base`, 0 for the start
   * of the current byte space (`from: file`).
   */
  alignAt(to: number, fill: Fill, strict: boolean, origin: number, offset: number): void {
    if (!Number.isSafeInteger(to) || to <= 0) this.fail("RANGE", `invalid alignment ${to}`);
    if (!Number.isSafeInteger(offset)) this.fail("RANGE", `invalid alignment offset ${offset}`);
    const rel = (((this.pos - origin + offset) % to) + to) % to;
    this.pad((to - rel) % to, fill, strict);
  }

  /** `padUntil(size)` after content that started at `start`. */
  padUntil(start: number, size: number, fill: Fill, strict: boolean): void {
    const used = this.pos - start;
    if (used > size)
      this.fail("CHECK", `content of ${used} bytes exceeds padUntil(${size})`, start);
    this.pad(size - used, fill, strict);
  }

  // ── targets ───────────────────────────────────────────────────────────────

  // The sync and async variants below share their bookkeeping; only the `read` call differs.

  /** The value read before at this address and type (`lastTargetEnd` set as if read again). */
  private known<T>(k: string, addr: number): T {
    this.lastTargetEnd = this.identEnd.get(k) ?? addr;
    return this.ident.get(k) as T;
  }

  /** Moves to a target at `addr`; returns what `leaveTarget` restores. */
  private enterTarget(addr: number): [pos: number, index: number] {
    if (!Number.isSafeInteger(addr) || addr < 0 || !storeCovers(this.store, addr)) {
      this.fail("EOF", `target address 0x${addr.toString(16)} is outside the data`);
    }
    const saved: [number, number] = [this.pos, this.index];
    this.pos = addr;
    this.index = -1;
    return saved;
  }

  private leaveTarget([pos, index]: [number, number]): void {
    this.pos = pos;
    this.index = index;
  }

  /** Records where the target under key `k` ended. */
  private targetRead(k: string): void {
    this.identEnd.set(k, this.pos);
    this.lastTargetEnd = this.pos;
    this.reached();
  }

  private reached(): void {
    if (this.pos > this.maxEnd) this.maxEnd = this.pos;
  }

  /**
   * Reads a pointer or `at` target at absolute `addr` without moving `pos`. The same address and
   * type key give the same value object within this region.
   */
  target<T>(addr: number, key: string, read: () => T): T {
    const k = `${addr}:${key}`;
    if (this.ident.has(k)) return this.known(k, addr);
    const saved = this.enterValueTarget(k, addr);
    try {
      const v = read();
      this.ident.set(k, v);
      this.targetRead(k);
      return v;
    } finally {
      this.inProgress.delete(k);
      this.leaveTarget(saved);
    }
  }

  async targetAsync<T>(addr: number, key: string, read: () => Promise<T>): Promise<T> {
    const k = `${addr}:${key}`;
    if (this.ident.has(k)) return this.known(k, addr);
    const saved = this.enterValueTarget(k, addr);
    try {
      const v = await read();
      this.ident.set(k, v);
      this.targetRead(k);
      return v;
    } finally {
      this.inProgress.delete(k);
      this.leaveTarget(saved);
    }
  }

  private enterValueTarget(k: string, addr: number): [number, number] {
    if (this.inProgress.has(k)) this.fail("CHECK", `pointer cycle at 0x${addr.toString(16)}`);
    const saved = this.enterTarget(addr);
    this.inProgress.add(k);
    return saved;
  }

  /**
   * A struct target: the object is registered under (address, type) before its contents are read,
   * so pointers back to it (cycles) get the same object.
   */
  targetStruct<T>(addr: number, key: string, read: () => T): T {
    const k = `${addr}:${key}`;
    if (this.ident.get(k) !== undefined) return this.known(k, addr);
    const saved = this.enterStructTarget(k, addr);
    try {
      const v = read();
      this.targetRead(k);
      return v;
    } catch (e) {
      this.ident.delete(k);
      throw e;
    } finally {
      this.into = undefined;
      this.leaveTarget(saved);
    }
  }

  async targetStructAsync<T>(addr: number, key: string, read: () => Promise<T>): Promise<T> {
    const k = `${addr}:${key}`;
    if (this.ident.get(k) !== undefined) return this.known(k, addr);
    const saved = this.enterStructTarget(k, addr);
    try {
      const v = await read();
      this.targetRead(k);
      return v;
    } catch (e) {
      this.ident.delete(k);
      throw e;
    } finally {
      this.into = undefined;
      this.leaveTarget(saved);
    }
  }

  private enterStructTarget(k: string, addr: number): [number, number] {
    const saved = this.enterTarget(addr);
    const obj = {};
    this.ident.set(k, obj);
    this.identEnd.set(k, addr);
    this.into = obj;
    return saved;
  }

  /** An inline struct of a type pointers can target: one object per (address, type). */
  inline<T>(key: string, read: () => T): T {
    this.into = this.inlineObject(key);
    try {
      return read();
    } finally {
      this.into = undefined;
    }
  }

  async inlineAsync<T>(key: string, read: () => Promise<T>): Promise<T> {
    this.into = this.inlineObject(key);
    try {
      return await read();
    } finally {
      this.into = undefined;
    }
  }

  private inlineObject(key: string): object {
    const k = `${this.pos}:${key}`;
    let obj = this.ident.get(k) as object | undefined;
    if (!obj) {
      obj = {};
      this.ident.set(k, obj);
    }
    return obj;
  }

  /** Runs `read` at absolute `addr` and restores `pos` (no identity tracking). */
  peekAt<T>(addr: number, read: () => T): T {
    const savePos = this.pos;
    this.pos = addr;
    try {
      const v = read();
      this.reached();
      return v;
    } finally {
      this.pos = savePos;
    }
  }

  async peekAtAsync<T>(addr: number, read: () => Promise<T>): Promise<T> {
    const savePos = this.pos;
    this.pos = addr;
    try {
      const v = await read();
      this.reached();
      return v;
    } finally {
      this.pos = savePos;
    }
  }

  /**
   * Union: tries each variant at `pos`; the first that reads without error wins. Failed variants
   * restore `pos`. No match is a UNION error listing every variant's error.
   */
  union<T>(variants: [string, () => T][]): { type: string; value: T } {
    const start = this.pos;
    const saveEnd = this._end;
    const errors: YaffleError[] = [];
    for (const [name, read] of variants) {
      try {
        return { type: name, value: read() };
      } catch (e) {
        this.variantFailed(e, name, errors, start, saveEnd);
      }
    }
    return this.unionFail(errors, start);
  }

  async unionAsync<T>(variants: [string, () => Promise<T>][]): Promise<{ type: string; value: T }> {
    const start = this.pos;
    const saveEnd = this._end;
    const errors: YaffleError[] = [];
    for (const [name, read] of variants) {
      try {
        return { type: name, value: await read() };
      } catch (e) {
        this.variantFailed(e, name, errors, start, saveEnd);
      }
    }
    return this.unionFail(errors, start);
  }

  private variantFailed(
    e: unknown,
    name: string,
    errors: YaffleError[],
    start: number,
    end: number
  ): void {
    if (!(e instanceof YaffleError)) throw e;
    e.prefix(name);
    errors.push(e);
    this.pos = start;
    this._end = end;
  }

  private unionFail(errors: YaffleError[], start: number): never {
    throw new YaffleError(
      "UNION",
      `no variant matched (${errors.map(e => e.message).join("; ")})`,
      this.at(start),
      [],
      errors
    );
  }

  // ── extern types ──────────────────────────────────────────────────────────

  /** Reads an extern type: host `size()` (unless fixed), then `read()`. */
  extern<T>(host: ExternTypeHost<T>, args: unknown[], fixedSize?: number): T {
    const start = this.pos;
    let size = fixedSize;
    if (size === undefined) {
      let probe = Math.min(this.end - this.pos, 16);
      for (;;) {
        this.need(probe);
        const view = this.buf.subarray(this.pos - this.off0, this.pos - this.off0 + probe);
        let s: number | undefined;
        try {
          s = host.size(view, ...args);
        } catch (e) {
          wrapHostError(e, "CODEC", "extern type size()", this.at(start));
        }
        if (s !== undefined) {
          size = s;
          break;
        }
        if (probe >= this.end - this.pos)
          this.fail("EOF", "extern type needs more bytes than the region has");
        probe = Math.min(this.end - this.pos, probe * 2);
      }
    }
    const bytes = this.bytes(size);
    try {
      return host.read(bytes, ...args);
    } catch (e) {
      return wrapHostError(e, "CODEC", "extern type read()", this.at(start));
    }
  }
}

export interface ExternTypeHost<T = unknown> {
  size(bytes: Uint8Array, ...args: unknown[]): number | undefined;
  read(bytes: Uint8Array, ...args: unknown[]): T;
  write(value: T, ...args: unknown[]): Uint8Array;
}
