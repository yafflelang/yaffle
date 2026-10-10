/**
 * Lazily decoded byte stores used by views:
 *
 * - `PieceStore`: a stream joined from pieces (`T x from arr[*].data`). An offset maps to
 *   a piece through the pieces' decoded lengths, taken from the data where the schema states them
 *   (`@size(exp) @via(zstd)`: no decoding needed) and otherwise learned by decoding the pieces in
 *   order until the offset is reached. Only the pieces a read touches are decoded, and decoded
 *   pieces live in a bounded LRU cache.
 * - `RangedStore`: the decoded side of a `@ranged` codec region. Only the touched blocks are
 *   decoded (the codec gets each block's position in `ctx.position`), also through an LRU cache.
 */
import { fail } from "./errors.ts";
import { fromBlocks, pastEnd, type ByteStore } from "./source.ts";

/** A small LRU cache with an entry and a byte budget (the most recent entry always stays). */
class Lru<K, V> {
  private readonly map = new Map<K, { v: V; bytes: number }>();
  private bytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  constructor(maxEntries: number, maxBytes = Infinity) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }
  get(k: K): V | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    this.map.delete(k);
    this.map.set(k, e);
    return e.v;
  }
  set(k: K, v: V, bytes = 0): void {
    const old = this.map.get(k);
    if (old) {
      this.bytes -= old.bytes;
      this.map.delete(k);
    }
    this.map.set(k, { v, bytes });
    this.bytes += bytes;
    while (this.map.size > 1 && (this.map.size > this.maxEntries || this.bytes > this.maxBytes)) {
      const [first, e] = this.map.entries().next().value as [K, { v: V; bytes: number }];
      this.map.delete(first);
      this.bytes -= e.bytes;
    }
  }
}

/** The pieces of a stream. */
interface PieceSource {
  /** Number of pieces. */
  readonly count: number;
  /** Piece `i`'s decoded length, if it is known without decoding it (it may read a header). */
  length(i: number): number | undefined;
  /** Decodes piece `i` (the store caches the result). */
  bytes(i: number): Uint8Array;
}

/** A stream over pieces decoded on demand. Its size is lazy (see `ByteStore.lazySize`). */
export class PieceStore implements ByteStore {
  readonly lazySize = true;
  readonly chunk = 0x4000;
  private readonly src: PieceSource;
  /** `starts[k]` is the stream offset of piece k, known for k ≤ `known`. */
  private readonly starts: number[] = [0];
  /** Number of pieces whose length is known. */
  private known = 0;
  /** Decoded pieces: at most 16 and 64 MiB (the latest piece always stays). */
  private readonly cache = new Lru<number, Uint8Array>(16, 64 << 20);

  constructor(src: PieceSource) {
    this.src = src;
  }

  /** Learns the next piece's length; false when every length is known. */
  private learn(): boolean {
    const k = this.known;
    if (k >= this.src.count) return false;
    let n = this.src.length(k);
    if (n === undefined) n = this.decode(k).length;
    this.starts.push(this.starts[k]! + n);
    this.known = k + 1;
    return true;
  }

  get size(): number {
    while (this.learn());
    return this.starts[this.known]!;
  }

  covers(end: number): boolean {
    while (this.starts[this.known]! < end && this.learn());
    return end <= this.starts[this.known]!;
  }

  /** Index of the piece holding stream offset `offset` (which must be below a known start). */
  private index(offset: number): number {
    let lo = 0;
    let hi = this.known - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    // Skip empty pieces that start at the same offset.
    while (lo < this.known - 1 && this.starts[lo + 1]! <= offset) lo++;
    return lo;
  }

  private decode(k: number): Uint8Array {
    const hit = this.cache.get(k);
    if (hit) return hit;
    const b = this.src.bytes(k);
    if (k < this.known && b.length !== this.starts[k + 1]! - this.starts[k]!) {
      fail(
        "CODEC",
        `stream piece ${k} decoded to ${b.length} bytes, its size field says ${this.starts[k + 1]! - this.starts[k]!}`
      );
    }
    this.cache.set(k, b, b.length);
    return b;
  }

  /** Piece `k`'s decoded bytes (decoded on demand, cached). */
  private piece(k: number): Uint8Array {
    if (k >= this.known) {
      while (this.known <= k && this.learn());
      if (k >= this.known) fail("RANGE", `stream piece ${k} does not exist`);
    }
    return this.decode(k);
  }

  private eof(offset: number, length: number): never {
    return fail(
      "EOF",
      `read of ${length} bytes at 0x${offset.toString(16)} is past the end of the stream`,
      offset
    );
  }

  get(offset: number, length: number): Uint8Array {
    if (offset < 0 || length < 0 || !this.covers(offset + length)) this.eof(offset, length);
    if (length === 0) return new Uint8Array(0);
    return this.assemble(offset, length);
  }

  getSome(offset: number, min: number, max: number): Uint8Array {
    if (offset < 0 || min < 0 || !this.covers(offset + min)) this.eof(offset, min);
    if (min === 0 && !this.covers(offset + 1)) return new Uint8Array(0);
    const k = this.index(offset);
    const p = this.piece(k);
    const s0 = offset - this.starts[k]!;
    const avail = p.length - s0;
    if (avail >= min) return p.subarray(s0, s0 + Math.min(avail, max));
    // Spans pieces: take the pieces `min` needs, up to `max` within the last of them.
    let j = k;
    while (this.starts[j + 1]! < offset + min) j++;
    const total = this.starts[j + 1]! - offset;
    return this.assemble(offset, Math.min(Math.max(min, max), total));
  }

  private assemble(offset: number, length: number): Uint8Array {
    let k = this.index(offset);
    const first = this.piece(k);
    const s0 = offset - this.starts[k]!;
    if (s0 + length <= first.length) return first.subarray(s0, s0 + length);
    const out = new Uint8Array(length);
    let at = 0;
    let from = s0;
    while (at < length) {
      const p = this.piece(k);
      const n = Math.min(p.length - from, length - at);
      out.set(p.subarray(from, from + n), at);
      at += n;
      from = 0;
      k++;
    }
    return out;
  }
}

const RANGED_BLOCK = 0x1000;

/**
 * The decoded side of a `@ranged` codec region `[start, start + size)` of `parent`. Ranged codecs
 * map byte i of the input to byte i of the output, so the decoded size is the encoded size and
 * any block can be decoded alone, given its position from the region start.
 */
export class RangedStore implements ByteStore {
  readonly size: number;
  readonly chunk = RANGED_BLOCK;
  private readonly parent: ByteStore;
  private readonly start: number;
  private readonly decodeFn: (input: Uint8Array, position: number) => Uint8Array;
  private readonly cache = new Lru<number, Uint8Array>(256);

  constructor(
    parent: ByteStore,
    start: number,
    size: number,
    decode: (input: Uint8Array, position: number) => Uint8Array
  ) {
    this.parent = parent;
    this.start = start;
    this.size = size;
    this.decodeFn = decode;
  }

  covers(end: number): boolean {
    return end <= this.size;
  }

  private decodeRange(offset: number, length: number): Uint8Array {
    const out = this.decodeFn(this.parent.get(this.start + offset, length), offset);
    if (out.length !== length) {
      fail(
        "CODEC",
        `a ranged codec decoded ${length} bytes into ${out.length} (ranged codecs keep the length)`
      );
    }
    return out;
  }

  private block(i: number): Uint8Array {
    const hit = this.cache.get(i);
    if (hit) return hit;
    const off = i * RANGED_BLOCK;
    const b = this.decodeRange(off, Math.min(RANGED_BLOCK, this.size - off));
    this.cache.set(i, b);
    return b;
  }

  get(offset: number, length: number): Uint8Array {
    if (offset < 0 || length < 0 || offset + length > this.size) pastEnd(offset, length, this.size);
    if (length === 0) return new Uint8Array(0);
    // Large reads are decoded in one call, without going through the block cache.
    const blocks =
      Math.floor((offset + length - 1) / RANGED_BLOCK) - Math.floor(offset / RANGED_BLOCK);
    if (blocks >= 8) return this.decodeRange(offset, length);
    return fromBlocks(offset, length, RANGED_BLOCK, i => this.block(i));
  }
}
