/**
 * Byte sources: a `Uint8Array`, a sync random-access source, or an async source whose `read`
 * returns a Promise. Views read through a `ByteStore`, which adds a block cache in front of
 * non-array sources. An async store throws `NeedBytes` for data it has not fetched yet; the
 * async layer catches it, fetches, and retries (see async.ts).
 */
import { CONTROL, fail } from "./errors.ts";

export interface SyncSource {
  readonly size: number;
  read(offset: number, length: number): Uint8Array;
  write?(offset: number, bytes: Uint8Array): void;
}

export interface AsyncSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  write?(offset: number, bytes: Uint8Array): void | Promise<void>;
}

export type Source = Uint8Array | SyncSource | AsyncSource;

/** Internal control signal: the bytes `[offset, offset + length)` must be fetched first. */
export class NeedBytes {
  readonly [CONTROL] = true;
  readonly offset: number;
  readonly length: number;
  constructor(offset: number, length: number) {
    this.offset = offset;
    this.length = length;
  }
}

/** Internal control signal: an async operation (codec) must complete first. */
export class NeedAsync {
  readonly [CONTROL] = true;
  readonly run: () => Promise<void>;
  readonly key: unknown;
  constructor(key: unknown, run: () => Promise<void>) {
    this.key = key;
    this.run = run;
  }
}

const asyncSources = new WeakSet<object>();

/** Marks a source as async without probing it. */
function markAsync<T extends object>(src: T): T {
  asyncSources.add(src);
  return src;
}

export function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    (typeof v === "object" || typeof v === "function") &&
    v !== null &&
    typeof (v as { then?: unknown }).then === "function"
  );
}

/** True if `src` is an async source (its `read` returns a Promise). Probes with a zero-length read. */
export function isAsyncSource(src: Source): src is AsyncSource {
  if (src instanceof Uint8Array) return false;
  if (asyncSources.has(src)) return true;
  if ((src as { async?: unknown }).async === true) return true;
  const probe = (src as SyncSource | AsyncSource).read(0, 0) as unknown;
  if (isThenable(probe)) {
    Promise.resolve(probe).catch(() => undefined);
    asyncSources.add(src);
    return true;
  }
  return false;
}

/** Reads a whole sync source into memory. */
export function readAllSync(src: Uint8Array | SyncSource): Uint8Array {
  if (src instanceof Uint8Array) return src;
  return src.read(0, src.size);
}

/** Reads a whole source into memory. */
export async function readAll(src: Source): Promise<Uint8Array> {
  if (src instanceof Uint8Array) return src;
  return await (src as AsyncSource).read(0, src.size);
}

/** A random-access byte store used by readers and views. */
export interface ByteStore {
  /** Total size. For a `lazySize` store, asking for it may decode or read a lot. */
  readonly size: number;
  /** Bytes `[offset, offset + length)`. May throw `NeedBytes` (async-backed stores). */
  get(offset: number, length: number): Uint8Array;
  /** If the whole store is one array, that array (fast path). */
  readonly whole?: Uint8Array | undefined;
  /**
   * True if `size` is expensive (a virtual stream whose pieces' sizes are discovered in order).
   * Readers over such a store keep their region end unresolved (`UNKNOWN_END`) until an
   * expression or a rest read needs it, and check bounds with `covers` instead.
   */
  readonly lazySize?: boolean;
  /** Whether bytes `[0, end)` exist (only discovers as much of a lazy store as needed). */
  covers?(end: number): boolean;
  /**
   * At least `min` and at most `max` bytes from `offset` (fewer than `max` when the store would
   * otherwise have to decode or read more than needed). EOF if fewer than `min` exist.
   */
  getSome?(offset: number, min: number, max: number): Uint8Array;
  /** Preferred refill size for readers (default 16 KiB). */
  readonly chunk?: number;
}

/**
 * The region end of a reader over a `lazySize` store before anyone needed it: larger than any
 * position, so bounds checks pass and the store itself reports reads past its end (EOF).
 */
export const UNKNOWN_END = Number.MAX_SAFE_INTEGER;

/** Whether `[0, end)` exists in a store, without resolving a lazy size when it can be avoided. */
export function storeCovers(store: ByteStore, end: number): boolean {
  if (store.covers) return store.covers(end);
  return end <= store.size;
}

/**
 * Bytes `[start, start + length)` of another store (`length` undefined: to its end, lazily for a
 * `lazySize` parent). Zero-copy views of fields and stream slices.
 */
export class SliceStore implements ByteStore {
  readonly parent: ByteStore;
  readonly start: number;
  private readonly length: number | undefined;
  constructor(parent: ByteStore, start: number, length?: number) {
    this.parent = parent;
    this.start = start;
    this.length = length;
  }
  get lazySize(): boolean {
    return this.length === undefined && this.parent.lazySize === true;
  }
  get chunk(): number {
    return this.parent.chunk ?? 0x4000;
  }
  get size(): number {
    return this.length ?? Math.max(0, this.parent.size - this.start);
  }
  get whole(): Uint8Array | undefined {
    const w = this.parent.whole;
    return w ? w.subarray(this.start, this.start + this.size) : undefined;
  }
  covers(end: number): boolean {
    if (this.length !== undefined) return end <= this.length;
    return storeCovers(this.parent, this.start + end);
  }
  get(offset: number, length: number): Uint8Array {
    if (offset < 0 || !this.covers(offset + length)) {
      fail("EOF", `read of ${length} bytes at 0x${offset.toString(16)} is past the end`, offset);
    }
    return this.parent.get(this.start + offset, length);
  }
  getSome(offset: number, min: number, max: number): Uint8Array {
    if (this.length !== undefined) max = Math.min(max, this.length - offset);
    if (offset < 0 || !this.covers(offset + min)) {
      fail("EOF", `read of ${min} bytes at 0x${offset.toString(16)} is past the end`, offset);
    }
    const p = this.parent;
    if (p.getSome) return p.getSome(this.start + offset, min, Math.max(min, max));
    return p.get(this.start + offset, Math.max(min, Math.min(max, p.size - this.start - offset)));
  }
}

const STORE = Symbol.for("yaffle.store");

/**
 * A sync source over a byte store, for nesting views: `Inner.view(storeSource(store))` reads
 * through the store itself (no second cache, lazy sizes and decoded pieces preserved).
 */
export function storeSource(store: ByteStore): SyncSource {
  return {
    [STORE]: store,
    get size() {
      return store.size;
    },
    read(offset: number, length: number): Uint8Array {
      return store.get(offset, length).slice();
    }
  } as SyncSource;
}

/** The store behind a `storeSource`, if `src` is one. */
export function sourceStore(src: unknown): ByteStore | undefined {
  return typeof src === "object" && src !== null
    ? (src as { [STORE]?: ByteStore })[STORE]
    : undefined;
}

export class ArrayStore implements ByteStore {
  readonly size: number;
  readonly whole: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.whole = bytes;
    this.size = bytes.length;
  }
  get(offset: number, length: number): Uint8Array {
    return this.whole.subarray(offset, offset + length);
  }
}

/** EOF for a read past the end of a store of `size` bytes. */
export function pastEnd(offset: number, length: number, size: number): never {
  return fail(
    "EOF",
    `read of ${length} bytes at 0x${offset.toString(16)} is past the end (0x${size.toString(16)})`,
    offset
  );
}

/**
 * Bytes `[offset, offset + length)` (length > 0) of data split into `blockSize` blocks: a view
 * into one block, or a copy across several.
 */
export function fromBlocks(
  offset: number,
  length: number,
  blockSize: number,
  block: (i: number) => Uint8Array
): Uint8Array {
  const first = Math.floor(offset / blockSize);
  const last = Math.floor((offset + length - 1) / blockSize);
  if (first === last) {
    const s = offset - first * blockSize;
    return block(first).subarray(s, s + length);
  }
  const out = new Uint8Array(length);
  for (let i = first; i <= last; i++) {
    const b = block(i);
    const bStart = i * blockSize;
    const from = Math.max(offset, bStart);
    const to = Math.min(offset + length, bStart + b.length);
    out.set(b.subarray(from - bStart, to - bStart), from - offset);
  }
  return out;
}

export interface CacheOptions {
  /** Block size in bytes (default 64 KiB). */
  blockSize?: number;
  /** Maximum number of cached blocks (default 256, i.e. 16 MiB with the default block size). */
  maxBlocks?: number;
}

/**
 * Block cache shared by sync and async stores. Reads larger than `largeRead` bytes bypass the
 * block cache and are kept in a small side cache keyed by range.
 */
abstract class BlockCacheStore implements ByteStore {
  readonly size: number;
  protected readonly blockSize: number;
  protected readonly maxBlocks: number;
  protected readonly blocks = new Map<number, Uint8Array>();
  protected readonly large = new Map<string, Uint8Array>();
  /** Blocks that eviction skips (fetched for an async operation still in progress). */
  protected readonly pinned = new Set<number>();
  /** Statistics: bytes requested from the underlying source. */
  bytesRead = 0;

  constructor(size: number, opts: CacheOptions = {}) {
    this.size = size;
    this.blockSize = opts.blockSize ?? 0x10000;
    this.maxBlocks = Math.max(4, opts.maxBlocks ?? 256);
  }

  protected get largeRead(): number {
    return this.blockSize * 8;
  }

  get(offset: number, length: number): Uint8Array {
    if (offset < 0 || offset + length > this.size) pastEnd(offset, length, this.size);
    if (length === 0) return new Uint8Array(0);
    // A large range fetched earlier may cover this read.
    for (const [k, data] of this.large) {
      const at = Number(k.slice(0, k.indexOf(":")));
      if (offset >= at && offset + length <= at + data.length)
        return data.subarray(offset - at, offset - at + length);
    }
    if (length > this.largeRead) return this.getLarge(offset, length);
    return fromBlocks(offset, length, this.blockSize, i => this.block(i));
  }

  protected block(i: number): Uint8Array {
    const hit = this.blocks.get(i);
    if (hit) {
      this.blocks.delete(i);
      this.blocks.set(i, hit);
      return hit;
    }
    const b = this.loadBlock(i);
    this.remember(i, b);
    return b;
  }

  protected remember(i: number, b: Uint8Array): void {
    this.blocks.set(i, b);
    this.evict();
  }

  /** Drops the least recently used unpinned blocks while over budget. */
  protected evict(): void {
    for (const k of this.blocks.keys()) {
      if (this.blocks.size <= this.maxBlocks) return;
      if (!this.pinned.has(k)) this.blocks.delete(k);
    }
  }

  protected blockRange(i: number): [number, number] {
    const start = i * this.blockSize;
    return [start, Math.min(this.size, start + this.blockSize) - start];
  }

  protected abstract loadBlock(i: number): Uint8Array;
  protected abstract getLarge(offset: number, length: number): Uint8Array;
}

export class SyncSourceStore extends BlockCacheStore {
  private readonly src: SyncSource;
  constructor(src: SyncSource, opts?: CacheOptions) {
    super(src.size, opts);
    this.src = src;
  }
  protected loadBlock(i: number): Uint8Array {
    const [start, len] = this.blockRange(i);
    this.bytesRead += len;
    return this.src.read(start, len);
  }
  protected getLarge(offset: number, length: number): Uint8Array {
    this.bytesRead += length;
    return this.src.read(offset, length);
  }
}

/**
 * Async-backed store: `get` throws `NeedBytes` for anything not fetched yet; `fetch` loads it.
 * Large reads are fetched exactly and kept until `release()`.
 */
export class AsyncSourceStore extends BlockCacheStore {
  readonly src: AsyncSource;
  constructor(src: AsyncSource, opts?: CacheOptions) {
    super(src.size, opts);
    this.src = src;
  }

  protected loadBlock(i: number): Uint8Array {
    const [start, len] = this.blockRange(i);
    throw new NeedBytes(start, len);
  }

  protected getLarge(offset: number, length: number): Uint8Array {
    const hit = this.large.get(`${offset}:${length}`);
    if (hit) return hit;
    throw new NeedBytes(offset, length);
  }

  /** Fetches what a `NeedBytes` asked for. Fetched blocks stay pinned until `release()`. */
  async fetch(need: NeedBytes): Promise<void> {
    if (need.length > this.largeRead) {
      const data = await this.src.read(need.offset, need.length);
      this.bytesRead += need.length;
      if (data.length !== need.length) fail("EOF", "short read from source", need.offset);
      this.large.set(`${need.offset}:${need.length}`, data);
      return;
    }
    const first = Math.floor(need.offset / this.blockSize);
    const last = Math.floor((need.offset + need.length - 1) / this.blockSize);
    const missing: number[] = [];
    for (let i = first; i <= last; i++) if (!this.blocks.has(i)) missing.push(i);
    if (!missing.length) return;
    const start = missing[0]! * this.blockSize;
    const end = Math.min(this.size, (missing[missing.length - 1]! + 1) * this.blockSize);
    const data = await this.src.read(start, end - start);
    this.bytesRead += end - start;
    if (data.length !== end - start) fail("EOF", "short read from source", start);
    for (const i of missing) {
      const s = i * this.blockSize - start;
      this.pinned.add(i);
      this.remember(i, data.subarray(s, Math.min(data.length, s + this.blockSize)));
    }
  }

  /** Unpins blocks fetched for a finished operation. */
  release(): void {
    this.pinned.clear();
    this.large.clear();
    this.evict();
  }
}

/** Creates the store for a sync source (Uint8Array or sync random-access source). */
export function storeOf(src: Uint8Array | SyncSource, opts?: CacheOptions): ByteStore {
  if (src instanceof Uint8Array) return new ArrayStore(src);
  return sourceStore(src) ?? new SyncSourceStore(src, opts);
}

/** Wraps a Uint8Array as a sync random-access source (handy for tests). */
export function arraySource(bytes: Uint8Array): SyncSource & { reads: number; bytesRead: number } {
  const s = {
    size: bytes.length,
    reads: 0,
    bytesRead: 0,
    read(offset: number, length: number): Uint8Array {
      s.reads++;
      s.bytesRead += length;
      return bytes.slice(offset, offset + length);
    },
    write(offset: number, data: Uint8Array): void {
      bytes.set(data, offset);
    }
  };
  return s;
}

/** Wraps a Uint8Array as an async source (handy for tests). */
export function asyncArraySource(
  bytes: Uint8Array,
  delayMs = 0
): AsyncSource & { reads: number; bytesRead: number; bytes: Uint8Array } {
  const s = {
    bytes,
    get size() {
      return s.bytes.length;
    },
    reads: 0,
    bytesRead: 0,
    async read(offset: number, length: number): Promise<Uint8Array> {
      s.reads++;
      s.bytesRead += length;
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      else await Promise.resolve();
      return s.bytes.slice(offset, offset + length);
    },
    async write(offset: number, data: Uint8Array): Promise<void> {
      await Promise.resolve();
      if (offset + data.length > s.bytes.length) {
        const grown = new Uint8Array(offset + data.length);
        grown.set(s.bytes);
        s.bytes = grown;
      }
      s.bytes.set(data, offset);
    }
  };
  return markAsync(s);
}
