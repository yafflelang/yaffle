/** Opening views over sources, and the view types the generated API returns. */
import { fail } from "./errors.ts";
import {
  AsyncSourceStore,
  isAsyncSource,
  sourceStore,
  storeOf,
  type AsyncSource,
  type CacheOptions,
  type Source,
  type SyncSource
} from "./source.ts";
import { asyncView } from "./async.ts";
import { ViewRoot, type CommitOptions, type Patch, type ViewSpec } from "./view.ts";
import type { CommitPlan } from "./commit.ts";

/** Methods every struct view has (field names never start with `$`). */
export interface ViewMethods {
  /** Absolute offset of the struct in the source. */
  readonly $offset: number;
  /** Bytes the struct occupies. */
  readonly $size: number;
  /** The struct's current bytes (in-place edits applied). */
  $raw(): Uint8Array;
  /** Sets several fields. */
  $set(values: object): void;
  /** The edits as patches against the original bytes. */
  $patches(options?: CommitOptions): Patch[];
  /** Applies the edits: returns the new bytes and rebinds the view to them. */
  $commit(options?: CommitOptions): Uint8Array;
  /** A plain snapshot of the value. */
  $plain(): unknown;
  /**
   * A random-access source over a bytes field (or a field read from a stream), without reading
   * it: `Inner.view(outer.$source("file"))` nests a view over decoded or joined bytes.
   */
  $source(field: string): SyncSource;
}

/** A lazy, editable view of a value of type T. */
export type View<T> = T extends Uint8Array
  ? Uint8Array
  : T extends readonly (infer E)[]
    ? View<E>[]
    : T extends object
      ? { -readonly [K in keyof T]: View<T[K]> } & ViewMethods
      : T;

export interface AsyncViewMethods {
  /** Sets several fields of the struct at this path. */
  $set(values: object): Promise<void>;
  $patches(options?: CommitOptions): Promise<Patch[]>;
  /** Applies the edits (written back to the source when it has `write`); resolves to the patches. */
  $commit(options?: CommitOptions): Promise<Patch[]>;
  $plain(): Promise<unknown>;
  /**
   * Runs `f` against the sync view at this path, fetching data (and running async codecs) as it
   * needs them. `f` may run more than once, so it must not have side effects.
   */
  $read<R>(f: (view: unknown) => R): Promise<R>;
}

/** An async view: every property chain is awaitable (`await v.a.b[3].c`). */
export type AsyncView<T> = PromiseLike<T> &
  AsyncViewMethods &
  (T extends Uint8Array
    ? unknown
    : T extends readonly (infer E)[]
      ? { readonly [i: number]: AsyncView<E>; readonly length: PromiseLike<number> }
      : T extends object
        ? { readonly [K in keyof T]-?: AsyncView<T[K]> }
        : unknown);

/**
 * The writes that turn a source into the committed bytes: the patches before the first size
 * change as they are, then everything from that change on in one write, and the new size if the
 * data shrank.
 */
function writeBack(
  patches: readonly Patch[],
  size: number,
  bytes: () => Uint8Array
): { writes: [number, Uint8Array][]; truncate: number | undefined } {
  const shift = patches.find(p => p.remove !== p.insert.length);
  const writes: [number, Uint8Array][] = [];
  for (const p of patches) {
    if (shift && p.at >= shift.at) break;
    writes.push([p.at, p.insert]);
  }
  if (!shift) return { writes, truncate: undefined };
  const all = bytes();
  writes.push([shift.at, all.subarray(shift.at)]);
  return { writes, truncate: all.length < size ? all.length : undefined };
}

function truncator(src: SyncSource | AsyncSource): (n: number) => unknown {
  const t = (src as { truncate?: (n: number) => unknown }).truncate;
  if (!t) return fail("INPUT", "the source cannot shrink (no truncate)");
  return n => t.call(src, n);
}

function writeBackSync(src: SyncSource, bytes: Uint8Array, patches: readonly Patch[]): void {
  const { writes, truncate } = writeBack(patches, src.size, () => bytes);
  for (const [at, data] of writes) src.write!(at, data);
  if (truncate !== undefined) truncator(src)(truncate);
}

async function writeBackAsync(src: AsyncSource, plan: CommitPlan): Promise<void> {
  const { writes, truncate } = writeBack(plan.patches, src.size, plan.bytes);
  for (const [at, data] of writes) await src.write!(at, data);
  if (truncate !== undefined) await truncator(src)(truncate);
}

/** Opens a view: sync for Uint8Arrays and sync sources, async for async sources. */
export function openView(source: Source, spec: ViewSpec, cache?: CacheOptions): unknown {
  // A store handed out by another view (`$source`) is read through directly.
  if (!(source instanceof Uint8Array) && !sourceStore(source) && isAsyncSource(source)) {
    const store = new AsyncSourceStore(source, cache);
    return asyncView({
      root: new ViewRoot(store, spec),
      store,
      source,
      sink: source.write ? p => writeBackAsync(source, p) : undefined
    });
  }
  const sync = source as Uint8Array | SyncSource;
  const sink =
    !(sync instanceof Uint8Array) && sync.write
      ? (bytes: Uint8Array, patches: Patch[]) => writeBackSync(sync, bytes, patches)
      : undefined;
  return new ViewRoot(storeOf(sync, cache), spec, sink).view;
}

/** Opens an async view over any source (async roots, or async access to in-memory data). */
export function openAsyncView(source: Source, spec: ViewSpec, cache?: CacheOptions): unknown {
  if (source instanceof Uint8Array || !isAsyncSource(source)) {
    const root = new ViewRoot(storeOf(source, cache), spec);
    return asyncView({ root, store: undefined, source: undefined, sink: undefined });
  }
  return openView(source, spec, cache);
}
