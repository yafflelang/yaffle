/**
 * `$commit` / `$patches` for views.
 *
 * - **Fast path:** only same-size scalar edits that no derived value depends on: the in-place
 *   patches are the result. Nothing else is read or re-encoded.
 * - **Slow path:** structural edits (or edits inside codec regions, or under checksums). The root
 *   is re-serialized by the generated writer with the view as its input value: unchanged byte
 *   arrays are passed through (they keep their provenance), codec regions whose content did not
 *   change reuse their encoded bytes, and the layout is *sticky*: placeables keep their original
 *   positions where the grow policy allows (layout.ts). The result is diffed against the
 *   original bytes into patches.
 */
import { fail } from "./errors.ts";
import { Region, Writer, type LStruct } from "./writer.ts";
import type { StickyPolicy } from "./layout.ts";
import { nodeOf, StructNode, type CommitOptions, type Patch, type ViewRoot } from "./view.ts";

export interface CommitPlan {
  patches: Patch[];
  /** The full new bytes (computed on demand: the fast path does not read the whole source). */
  bytes: () => Uint8Array;
}

function fastPathOk(root: ViewRoot): boolean {
  if (root.structural) return false;
  for (const sp of root.regions.values()) if (sp.patches.length) return false;
  for (const st of root.streams.values()) if (st.space.patches.length) return false;
  for (const p of root.space.patches) {
    let n: StructNode | undefined = p.node?.ctx.parent;
    while (n) {
      if (!n.info.childSafe) return false;
      n = n.ctx.parent;
    }
  }
  return true;
}

/** Merges in-place patches into sorted, non-overlapping replacements. */
function inPlacePatches(root: ViewRoot): Patch[] {
  // Merge the touched ranges, then read the patched bytes of each.
  const ranges = root.space.patches
    .map(p => [p.at, p.at + p.data.length] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged.map(([a, b]) => ({
    at: a,
    remove: b - a,
    insert: root.space.store.get(a, b - a).slice()
  }));
}

/** Applies patches (sorted by `at`, non-overlapping, in original coordinates). */
export function applyPatches(orig: Uint8Array, patches: readonly Patch[]): Uint8Array {
  let size = orig.length;
  for (const p of patches) size += p.insert.length - p.remove;
  const out = new Uint8Array(size);
  let o = 0;
  let n = 0;
  for (const p of patches) {
    out.set(orig.subarray(o, p.at), n);
    n += p.at - o;
    out.set(p.insert, n);
    n += p.insert.length;
    o = p.at + p.remove;
  }
  out.set(orig.subarray(o), n);
  return out;
}

interface Anchor {
  n: number;
  o: number;
  len: number;
}

/**
 * Patches turning `orig` into `out`. `anchors` are ranges known to be copied unchanged from the
 * original (provenance); between them the bytes are compared.
 */
function diff(orig: Uint8Array, out: Uint8Array, anchors: readonly Anchor[]): Patch[] {
  const sorted = [...anchors].filter(a => a.len > 0).sort((a, b) => a.n - b.n);
  const chain: Anchor[] = [];
  let lastO = 0;
  let lastN = 0;
  for (const a of sorted) {
    if (a.o >= lastO && a.n >= lastN) {
      chain.push(a);
      lastO = a.o + a.len;
      lastN = a.n + a.len;
    }
  }
  const patches: Patch[] = [];
  let n = 0;
  let o = 0;
  const segment = (n0: number, n1: number, o0: number, o1: number): void => {
    const nl = n1 - n0;
    const ol = o1 - o0;
    if (nl === ol) {
      // Same length: emit the differing runs (gaps under 8 equal bytes are merged).
      let i = 0;
      while (i < nl) {
        if (out[n0 + i] === orig[o0 + i]) {
          i++;
          continue;
        }
        let j = i + 1;
        let same = 0;
        while (j < nl && same < 8) {
          if (out[n0 + j] === orig[o0 + j]) same++;
          else same = 0;
          j++;
        }
        const end = j - same;
        patches.push({ at: o0 + i, remove: end - i, insert: out.slice(n0 + i, n0 + end) });
        i = j;
      }
      return;
    }
    let p = 0;
    while (p < nl && p < ol && out[n0 + p] === orig[o0 + p]) p++;
    let s = 0;
    while (s < nl - p && s < ol - p && out[n1 - 1 - s] === orig[o1 - 1 - s]) s++;
    patches.push({ at: o0 + p, remove: ol - p - s, insert: out.slice(n0 + p, n1 - s) });
  };
  for (const a of chain) {
    segment(n, a.n, o, a.o);
    n = a.n + a.len;
    o = a.o + a.len;
  }
  segment(n, out.length, o, orig.length);
  return patches.filter(p => p.remove > 0 || p.insert.length > 0);
}

interface SlowPath {
  w: Writer;
  finish(l: LStruct | void): CommitPlan;
}

/** Sets up the slow path: a writer over the view with sticky layout and provenance. */
function slowPath(root: ViewRoot, opts: CommitOptions): SlowPath {
  const space = root.space;
  const grow: StickyPolicy["grow"] = opts.grow ?? "default";
  const rootNode = root.rootNode;
  rootNode.ensureScanned();
  const region = new Region();
  region.layout = root.spec.layout;
  region.sticky = {
    grow,
    origRootSize: rootNode.inlineEnd - rootNode.pos,
    origSize: space.base.size
  };
  const w = new Writer(region);
  w.origin = (value: unknown) => {
    const o = typeof value === "object" && value !== null ? root.origins.get(value) : undefined;
    if (o && o.space === space) return { pos: o.pos, size: o.size };
    const n = nodeOf(value);
    if (n instanceof StructNode && n.space === space) return { pos: n.pos, size: n.size };
    return undefined;
  };
  w.slotOrigin = (owner: unknown, field: string) => {
    const n = nodeOf(owner);
    if (!(n instanceof StructNode) || n.space !== space) return undefined;
    return n.originalTarget(field);
  };
  w.regionOrigin = (value: unknown) => {
    const n = nodeOf(value);
    if (!(n instanceof StructNode) || n.space !== space || n.materialized) return undefined;
    n.ensureScanned();
    return { base: n.pos, inline: n.inlineEnd - n.pos, size: n.size };
  };
  const whole = space.base.whole;
  if (whole)
    w.provenance = {
      buffer: whole.buffer,
      start: whole.byteOffset,
      length: whole.byteLength,
      space
    };
  return {
    w,
    finish(l: LStruct | void): CommitPlan {
      if (l) region.lroot = l;
      const bytes = region.finish();
      const orig = space.base.get(0, space.base.size);
      const anchors = region.provenance
        .filter(p => p.prov.space === space)
        .map(p => ({ n: p.at, o: p.prov.offset, len: p.len }));
      const patches = diff(orig, bytes, anchors);
      if (grow === "error" && bytes.length !== orig.length) {
        fail(
          "DERIVE",
          `the data changed size from ${orig.length} to ${bytes.length} bytes (grow: "error")`
        );
      }
      return { patches, bytes: () => bytes };
    }
  };
}

/** The fast path's plan (in-place patches only), or undefined if the slow path is needed. */
function fastPlan(root: ViewRoot, opts: CommitOptions): CommitPlan | undefined {
  if (opts.rewrite || !fastPathOk(root)) return undefined;
  const space = root.space;
  const patches = inPlacePatches(root);
  return {
    patches,
    bytes: () => applyPatches(space.base.get(0, space.base.size), patches)
  };
}

/** Computes the commit of a view. */
export function plan(root: ViewRoot, opts: CommitOptions = {}): CommitPlan {
  const fast = fastPlan(root, opts);
  if (fast) return fast;
  if (root.spec.writeAsync) {
    fail("INPUT", "this format has async codecs: commit through an async view (await $commit())");
  }
  const job = slowPath(root, opts);
  return job.finish(root.spec.write(job.w, root.view));
}

/**
 * The commit of a view of an async format (async codecs): the slow path runs the async root
 * writer. Reads through the view may throw `NeedBytes` / `NeedAsync`; the caller fetches and
 * retries (every attempt starts from a fresh writer).
 */
export async function planAsync(root: ViewRoot, opts: CommitOptions = {}): Promise<CommitPlan> {
  const fast = fastPlan(root, opts);
  if (fast) return fast;
  const job = slowPath(root, opts);
  const l = root.spec.writeAsync
    ? await root.spec.writeAsync(job.w, root.view)
    : root.spec.write(job.w, root.view);
  return job.finish(l);
}
