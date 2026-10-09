/**
 * Async views. An async view wraps a sync view over an async store: every property
 * chain (`av.entries[3].data`) is a thenable proxy that records its path. Awaiting it walks the
 * sync view; when the walk needs bytes that are not fetched yet (`NeedBytes`) or an async codec
 * (`NeedAsync`), the walk is abandoned, the data is fetched, and the walk is retried. Scans and
 * decoded regions are cached, so retries only redo the cheap part.
 */
import { fail, YaffleError } from "./errors.ts";
import { ArrayStore, AsyncSourceStore, NeedAsync, NeedBytes, type AsyncSource } from "./source.ts";
import { planAsync, type CommitPlan } from "./commit.ts";
import { nodeOf, plain, type CommitOptions, type Patch, type ViewRoot } from "./view.ts";

/**
 * Runs `f` until it completes: missing bytes are fetched with `fetch` (without it, `NeedBytes`
 * propagates) and async codecs are run, then `f` starts over.
 */
async function retrying<T>(
  f: () => T | Promise<T>,
  fetch: ((need: NeedBytes) => Promise<void>) | undefined
): Promise<T> {
  for (;;) {
    try {
      return await f();
    } catch (e) {
      if (e instanceof NeedBytes && fetch) await fetch(e);
      else if (e instanceof NeedAsync) await e.run();
      else throw e;
    }
  }
}

/** Runs `f` against the sync view, fetching whatever it asks for, until it completes. */
async function settle<T>(store: AsyncSourceStore | undefined, f: () => T): Promise<T> {
  try {
    return await retrying(f, store && (need => store.fetch(need)));
  } finally {
    store?.release();
  }
}

type Seg = string | number;

function walk(root: ViewRoot, path: readonly Seg[]): unknown {
  let v: unknown = root.view;
  for (const seg of path) {
    if (v === null || v === undefined) fail("INPUT", `cannot read ${String(seg)} of ${String(v)}`);
    v = (v as Record<string, unknown>)[seg as string];
  }
  return v;
}

/** The value an awaited chain resolves to: plain data (views are snapshotted). */
function resolved(v: unknown): unknown {
  return nodeOf(v) ? plain(v) : v;
}

export interface AsyncViewState {
  root: ViewRoot;
  store: AsyncSourceStore | undefined;
  source: AsyncSource | undefined;
  /** Writes committed patches back to the source. */
  sink: ((plan: CommitPlan) => Promise<void>) | undefined;
}

function chain(state: AsyncViewState, path: Seg[]): unknown {
  const target = function () {};
  return new Proxy(target, {
    get(_t, key) {
      if (typeof key === "symbol") return undefined;
      switch (key) {
        case "then":
          return (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
            settle(state.store, () => resolved(walk(state.root, path))).then(ok, ko);
        case "catch":
        case "finally":
          return undefined;
        case "$set":
          return (values: Record<string, unknown>) =>
            settle(state.store, () => {
              const v = walk(state.root, path) as { $set?: (x: Record<string, unknown>) => void };
              if (!nodeOf(v) || typeof v.$set !== "function") fail("INPUT", "$set needs a struct");
              v.$set(values);
            });
        case "$patches":
          return (opts?: CommitOptions) => commitAsync(state, opts, true);
        case "$commit":
          return (opts?: CommitOptions) => commitAsync(state, opts, false);
        case "$plain":
          return () => settle(state.store, () => plain(walk(state.root, path)));
        case "$read":
          // Runs a sync function against the sync view at this path, fetching what it needs
          // (it may run several times, so it must not have side effects).
          return <T>(f: (v: unknown) => T) => settle(state.store, () => f(walk(state.root, path)));
        case "$offset":
          return settle(state.store, () => (walk(state.root, path) as { $offset: number }).$offset);
        default:
          return chain(state, [...path, key]);
      }
    },
    set() {
      throw new YaffleError("INPUT", "async views are changed with `await view.path.$set({ … })`");
    },
    apply() {
      throw new YaffleError("INPUT", "not a function");
    }
  });
}

async function commitAsync(
  state: AsyncViewState,
  opts: CommitOptions | undefined,
  dry: boolean
): Promise<Patch[]> {
  const root = state.root;
  const store = state.store;
  // The fast path needs only the patched ranges; the slow path re-encodes everything, so the
  // first miss fetches the whole source (one read) instead of retrying block by block.
  let fetchedAll = false;
  const fetch =
    store &&
    (async (need: NeedBytes) => {
      await store.fetch(fetchedAll ? need : new NeedBytes(0, store.size));
      fetchedAll = true;
    });
  let p: CommitPlan;
  try {
    // Every attempt starts from a fresh writer.
    p = await retrying(() => planAsync(root, opts), fetch);
  } finally {
    store?.release();
  }
  if (dry) return p.patches;
  if (state.sink && state.source) {
    await state.sink(p);
    // The source now holds the result: read it afresh.
    const fresh = new AsyncSourceStore(state.source);
    root.rebind(fresh);
    state.store = fresh;
  } else {
    const bytes = store ? await settle(store, () => p.bytes()) : p.bytes();
    root.rebind(new ArrayStore(bytes));
    state.store = undefined;
  }
  return p.patches;
}

/** Wraps a view root as an async view (thenable property chains). */
export function asyncView(state: AsyncViewState): unknown {
  return chain(state, []);
}
