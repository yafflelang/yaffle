/**
 * Property test for views and surgical writes: random edits on a view, then `$commit`, then
 * re-parse, compared with the same edits applied to a plain object and serialized from scratch.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { build, type Mod } from "./harness.ts";
import * as ir from "./ir.ts";

const {
  S,
  f,
  derived,
  constant,
  program,
  u8,
  u16,
  u32,
  array,
  bytes,
  count,
  ref,
  fr,
  len,
  vt,
  cstr,
  ptr,
  layered,
  L
} = ir;

function docIr() {
  return program({
    structs: [
      S("Item", [
        f("id", u16),
        derived("n", u8, len(fr("tags", vt.array(vt.int(8))))),
        f("tags", array(u8, count(fr("n", vt.int(8))))),
        f("name", cstr)
      ]),
      S("Doc", [
        constant("magic", u32, 0xd0c),
        f("version", u16),
        derived("count", u8, len(fr("items", vt.array(vt.struct("Item"))))),
        f("items", array(ref("Item"), count(fr("count", vt.int(8))))),
        derived("nblob", u32, len(fr("blob", vt.bytes))),
        f("blob", bytes(count(fr("nblob")))),
        f("extra", ptr(ref("Item"), "u32", { nullable: true })),
        f("note", ptr(layered(cstr, L.align(4)), "u16")),
        f("tail", array(u16, count(3)))
      ])
    ],
    roots: ["Doc"]
  });
}

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let m: Mod;

beforeAll(async () => {
  m = await build("views-fuzz", docIr());
});

type Item = { id: number; tags: number[]; name: string };
type Doc = {
  version: number;
  items: Item[];
  blob: Uint8Array;
  extra: Item | null;
  note: string;
  tail: number[];
};

function randomItem(r: () => number): Item {
  const n = Math.floor(r() * 4);
  return {
    id: Math.floor(r() * 65536),
    tags: Array.from({ length: n }, () => Math.floor(r() * 256)),
    name: "n" + "x".repeat(Math.floor(r() * 6))
  };
}

function randomDoc(r: () => number): Doc {
  return {
    version: Math.floor(r() * 65536),
    items: Array.from({ length: 1 + Math.floor(r() * 4) }, () => randomItem(r)),
    blob: Uint8Array.from({ length: Math.floor(r() * 20) }, () => Math.floor(r() * 256)),
    extra: r() < 0.5 ? null : randomItem(r),
    note: "note" + "!".repeat(Math.floor(r() * 5)),
    tail: [1, 2, 3]
  };
}

/** One random edit, applied to both the view and the plain object. */
function edit(r: () => number, v: Mod, p: Doc): string {
  const k = Math.floor(r() * 11);
  const i = Math.floor(r() * p.items.length);
  switch (k) {
    case 0: {
      const x = Math.floor(r() * 65536);
      v.version = x;
      p.version = x;
      return `version=${x}`;
    }
    case 1: {
      if (!p.items.length) return "noop";
      const x = Math.floor(r() * 65536);
      v.items[i].id = x;
      p.items[i]!.id = x;
      return `items[${i}].id=${x}`;
    }
    case 2: {
      const it = randomItem(r);
      v.items.push(structuredClone(it));
      p.items.push(it);
      return "push";
    }
    case 3: {
      if (p.items.length <= 1) return "noop";
      v.items.splice(i, 1);
      p.items.splice(i, 1);
      return `splice(${i})`;
    }
    case 4: {
      if (!p.items.length) return "noop";
      const name = "renamed" + "y".repeat(Math.floor(r() * 4));
      v.items[i].name = name;
      p.items[i]!.name = name;
      return `items[${i}].name`;
    }
    case 5: {
      if (!p.items.length) return "noop";
      const tags = Array.from({ length: Math.floor(r() * 5) }, () => Math.floor(r() * 256));
      v.items[i].tags = [...tags];
      p.items[i]!.tags = tags;
      return `items[${i}].tags`;
    }
    case 6: {
      const b = Uint8Array.from({ length: Math.floor(r() * 30) }, () => Math.floor(r() * 256));
      v.blob = b.slice();
      p.blob = b;
      return `blob(${b.length})`;
    }
    case 7: {
      const it = r() < 0.3 ? null : randomItem(r);
      v.extra = it && structuredClone(it);
      p.extra = it;
      return `extra=${it ? "item" : "null"}`;
    }
    case 8: {
      const j = Math.floor(r() * 3);
      const x = Math.floor(r() * 65536);
      v.tail[j] = x;
      p.tail[j] = x;
      return `tail[${j}]=${x}`;
    }
    case 9: {
      const note = "n" + "z".repeat(Math.floor(r() * 9));
      v.note = note;
      p.note = note;
      return `note`;
    }
    default: {
      if (!p.items.length) return "noop";
      const x = Math.floor(r() * 256);
      if (!p.items[i]!.tags.length) return "noop";
      v.items[i].tags[0] = x;
      p.items[i]!.tags[0] = x;
      return `items[${i}].tags[0]=${x}`;
    }
  }
}

describe("views: random edits match plain objects", () => {
  const policies = [undefined, "append", "splice"] as const;
  for (let seed = 1; seed <= 200; seed++) {
    it(`seed ${seed}`, () => {
      const r = rng(seed);
      const plainDoc = randomDoc(r);
      let bytes: Uint8Array = m.Doc.serialize(plainDoc);
      const v = m.Doc.view(bytes);
      const log: string[] = [];
      for (let round = 0; round < 3; round++) {
        const edits = 1 + Math.floor(r() * 5);
        for (let e = 0; e < edits; e++) log.push(edit(r, v, plainDoc));
        const policy = policies[Math.floor(r() * policies.length)];
        const patches = v.$patches(policy ? { grow: policy } : undefined);
        const committed: Uint8Array = v.$commit(policy ? { grow: policy } : undefined);
        // Patches applied to the previous bytes give the committed bytes.
        const viaPatches = applyPatches(bytes, patches);
        expect(Buffer.compare(viaPatches, committed), log.join(", ")).toBe(0);
        const got = m.Doc.toJson(m.Doc.parse(committed));
        const want = m.Doc.toJson(m.Doc.parse(m.Doc.serialize(plainDoc)));
        expect(got, `${log.join(", ")} (policy ${policy})`).toEqual(want);
        expect(m.Doc.toJson(v.$plain()), log.join(", ")).toEqual(want);
        bytes = committed;
      }
    });
  }
});

function applyPatches(
  orig: Uint8Array,
  patches: { at: number; remove: number; insert: Uint8Array }[]
): Uint8Array {
  const parts: Uint8Array[] = [];
  let o = 0;
  for (const p of patches) {
    parts.push(orig.subarray(o, p.at), p.insert);
    o = p.at + p.remove;
  }
  parts.push(orig.subarray(o));
  return Buffer.concat(parts);
}
