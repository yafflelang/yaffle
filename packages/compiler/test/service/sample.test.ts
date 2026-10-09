/**
 * decodeSample and suggestLayout: decoding sample files through the TS backend and runtime, and
 * inferring layout rules from them. Samples are made with the generated serializer of a schema.
 */
import { afterAll, describe, expect, it } from "vitest";
import { compileSource } from "../../src/index.ts";
import type { LanguageService, SampleAnnotation, TextEdit } from "../../src/service/api.ts";
import { createLanguageService } from "../../src/service/index.ts";
import { GeneratedCode } from "../../src/service/sample.ts";
import { host } from "./util.ts";

const code = new GeneratedCode();
const services: LanguageService[] = [];
afterAll(() => {
  code.dispose();
  for (const s of services) s.dispose();
});

interface Root {
  parse(bytes: Uint8Array): unknown;
  serialize(value: unknown): Uint8Array;
}

/** The generated API of `root` in `source`. */
async function api(source: string, root: string): Promise<Root> {
  const r = compileSource(source, "/s/main.yfl");
  if (!r.program) throw new Error(r.diagnostics.map(d => d.message).join("\n"));
  const ns = await code.load(r.program, {}, "main.yfl");
  return ns[root] as Root;
}

function service(files: Record<string, string>): LanguageService {
  const ls = createLanguageService(host(files));
  for (const [p, t] of Object.entries(files)) if (p.endsWith(".yfl")) ls.updateFile(p, t);
  services.push(ls);
  return ls;
}

const lineOf = (text: string, needle: string) =>
  text.split("\n").findIndex(l => l.includes(needle));

function byLine(text: string, anns: SampleAnnotation[]): Map<string, string[]> {
  const lines = text.split("\n");
  const out = new Map<string, string[]>();
  for (const a of anns) {
    const key = lines[a.range.start.line]!.trim();
    const list = out.get(key) ?? [];
    list.push(a.value);
    out.set(key, list);
  }
  return out;
}

function applyEdits(text: string, edits: TextEdit[]): string {
  const lines = text.split("\n");
  const offset = (p: { line: number; character: number }) =>
    lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
  let out = text;
  for (const e of [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start)))
    out = out.slice(0, offset(e.range.start)) + e.newText + out.slice(offset(e.range.end));
  return out;
}

// ── decodeSample ───────────────────────────────────────────────────────────────

const PACK = `export struct Pack {
  char tag[4] = "PACK"
  u32  count
  u32  namesOfs
  Entry entries[count]
  Name *first : u32 @nullable
  str  names[count] at namesOfs
}

struct Entry {
  u16 id
  u16 size
  f32 scale
  Kind kind
  u8[size] *data : u32
}

enum Kind : u8 { Small = 1, Big = 2 }

struct Name { u8 len  char text[len] }
`;

describe("decodeSample", () => {
  it("annotates every field with its value, offset and size", async () => {
    const P = await api(PACK, "Pack");
    const value = {
      entries: [
        { id: 7, scale: 1.5, kind: "Small", data: new Uint8Array([1, 2, 3]) },
        { id: 8, scale: 0.1, kind: "Big", data: new Uint8Array(40) }
      ],
      first: { text: "first!" },
      names: ["alpha", "a rather long name that will be cut short somewhere"]
    };
    const bytes = P.serialize(value);
    const ls = service({ "/s/main.yfl": PACK });
    const anns = await ls.decodeSample("/s/main.yfl", "Pack", bytes);
    const v = byLine(PACK, anns);
    expect(v.get('char tag[4] = "PACK"')).toEqual(['"PACK"']);
    expect(v.get("u32  count")).toEqual(["2"]);
    expect(v.get("u32  namesOfs")![0]).toMatch(/^\d+ \(0x[0-9a-f]+\)$/);
    expect(v.get("Entry entries[count]")).toEqual(["[2 items]"]);
    expect(v.get("u16 id")).toEqual(["7", "8"]);
    expect(v.get("u16 size")).toEqual(["3", "40 (0x28)"]);
    expect(v.get("f32 scale")).toEqual(["1.5", "0.1"]);
    expect(v.get("Kind kind")).toEqual(["Small", "Big"]);
    expect(v.get("u8[size] *data : u32")![0]).toMatch(/^→ \[3 bytes\] 01 02 03 @0x[0-9a-f]+$/);
    expect(v.get("Name *first : u32 @nullable")![0]).toMatch(/^→ Name @0x[0-9a-f]+$/);
    expect(
      v.get("u8 len  char text[len]") ?? v.get("struct Name { u8 len  char text[len] }")
    ).toEqual(["6", '"first!"']);
    // a short list is shown inline (long strings cut), a long one by its length
    expect(v.get("str  names[count] at namesOfs")).toEqual([
      '["alpha", "a rather long name that will be cut shor…"]'
    ]);
    const few = await ls.decodeSample(
      "/s/main.yfl",
      "Pack",
      P.serialize({
        ...value,
        entries: Array.from({ length: 7 }, () => value.entries[0]!),
        names: ["a", "b", "c", "d", "e", "f", "g"]
      })
    );
    expect(byLine(PACK, few).get("str  names[count] at namesOfs")).toEqual(["[7 items]"]);
    // offsets and sizes are in the file
    const count = anns.find(a => a.range.start.line === lineOf(PACK, "u32  count"))!;
    expect([count.offset, count.size]).toEqual([4, 4]);
    const id = anns.filter(a => a.range.start.line === lineOf(PACK, "u16 id"));
    expect(id.map(a => [a.offset, a.size])).toEqual([
      [12, 2],
      [25, 2]
    ]);
    // the range is the field's declaration
    expect(count.range.start.character).toBe(2);
    expect(count.path).toBe("/s/main.yfl");
  });

  it("caps array elements and annotations, and stays lazy on huge byte arrays", async () => {
    const src = `export struct Big {
  u32 n
  Rec recs[n]
  u32 blobSize
  u8  blob[blobSize]
}
struct Rec { u32 a  u32 b }
`;
    const P = await api(src, "Big");
    const recs = Array.from({ length: 1000 }, (_, i) => ({ a: i, b: i * 2 }));
    const bytes = P.serialize({ recs, blob: new Uint8Array(8 << 20) });
    const ls = service({ "/s/main.yfl": src });
    const anns = await ls.decodeSample("/s/main.yfl", "Big", bytes);
    const v = byLine(src, anns);
    expect(v.get("Rec recs[n]")).toEqual(["[1000 items]"]);
    // 64 elements walked into
    expect(v.get("struct Rec { u32 a  u32 b }")).toHaveLength(128);
    expect(v.get("u8  blob[blobSize]")![0]).toMatch(/^\[8388608 bytes\] 00 00/);
  });

  it("only annotates structs of the file, also with an imported root", async () => {
    const common = `export struct Header { u32 magic  u32 size }\n`;
    const main = `import { Header } from "./common.yfl"
export struct File {
  Header hdr
  u8 body[hdr.size]
}
`;
    const files = { "/s/common.yfl": common, "/s/main.yfl": main };
    const r = compileSource(main, "/s/main.yfl", host(files));
    const ns = await code.load(r.program!, {}, "main.yfl");
    const bytes = (ns.File as Root).serialize({
      hdr: { magic: 1, size: 2 },
      body: new Uint8Array([5, 6])
    });
    const ls = service(files);
    const anns = await ls.decodeSample("/s/main.yfl", "File", bytes);
    expect(anns.every(a => a.path === "/s/main.yfl")).toBe(true);
    expect(byLine(main, anns).get("u8 body[hdr.size]")).toEqual(["[2 bytes] 05 06"]);
    // the imported struct as the root, annotating the importer's file: nothing of main.yfl inside
    const own = await ls.decodeSample("/s/common.yfl", "Header", bytes.subarray(0, 8));
    expect(own.map(a => a.value)).toEqual(["1", "2"]);
  });

  it("non-exported structs can be roots; decode errors become ⚠ values", async () => {
    const src = `struct Inner { u32 n  u8 data[n] }
export struct Outer { Inner i }
`;
    const ls = service({ "/s/main.yfl": src });
    const anns = await ls.decodeSample("/s/main.yfl", "Inner", new Uint8Array([2, 0, 0, 0, 9, 9]));
    expect(anns.map(a => a.value)).toEqual(["2", "[2 bytes] 09 09"]);
    const short = await ls.decodeSample("/s/main.yfl", "Inner", new Uint8Array([9, 0, 0, 0, 1]));
    expect(short.map(a => a.value)).toEqual([expect.stringMatching(/^⚠ EOF/)]);
  });

  it("rejects roots that can't be decoded on their own", async () => {
    const src = `export struct Root { u8 $v  Leaf l }
struct Leaf { u8 x[$v] }
`;
    const ls = service({ "/s/main.yfl": src });
    await expect(ls.decodeSample("/s/main.yfl", "Leaf", new Uint8Array(4))).rejects.toThrow(
      /Leaf can't be decoded on its own: \$v is read here, but nothing binds it/
    );
  });

  // root arguments (canonical JSON): explicit and bound parameters, bytes as hex, u64 as strings
  const KEYED = `export struct Keyed(u8 $key[2], u64 $nonce, u8 n = 2) {
  u8  data[n]
  u8  k[2] where it == $key
  u64 seen = $nonce
}
`;

  it("root parameters describe what to ask for", () => {
    const ls = service({ "/s/main.yfl": KEYED });
    expect(ls.getRootParameters("/s/main.yfl", "Keyed")).toEqual([
      { name: "key", label: "$key", type: "u8[2]", kind: "bytes", length: 2, optional: false },
      {
        name: "nonce",
        label: "$nonce",
        type: "u64",
        kind: "int",
        bits: 64,
        signed: false,
        optional: false
      },
      {
        name: "n",
        label: "n",
        type: "u8",
        kind: "int",
        bits: 8,
        signed: false,
        optional: true,
        defaultText: "2"
      }
    ]);
    expect(() => ls.getRootParameters("/s/main.yfl", "Nope")).toThrow(/No struct `Nope`/);
  });

  it("decodes with root arguments", async () => {
    const ls = service({ "/s/main.yfl": KEYED });
    const bytes = new Uint8Array([1, 2, 0xaa, 0xbb, 5, 0, 0, 0, 0, 0, 0, 0]);
    const anns = await ls.decodeSample("/s/main.yfl", "Keyed", bytes, {
      key: "aabb",
      nonce: "5"
    });
    expect(byLine(KEYED, anns).get("u8  data[n]")).toEqual(["[2 bytes] 01 02"]);
    expect(byLine(KEYED, anns).get("u8  k[2] where it == $key")).toEqual(["[2 bytes] aa bb"]);
    // an explicit n changes data's length; another key fails k's check
    const shorter = await ls.decodeSample("/s/main.yfl", "Keyed", bytes.subarray(1), {
      key: "aabb",
      nonce: "5",
      n: 1
    });
    expect(byLine(KEYED, shorter).get("u8  data[n]")).toEqual(["[1 bytes] 02"]);
    const other = await ls.decodeSample("/s/main.yfl", "Keyed", bytes, { key: "0000", nonce: "5" });
    expect(other.map(a => a.value)).toEqual([expect.stringMatching(/^⚠ CHECK/)]);
  });

  it("rejects unknown and invalid root arguments", async () => {
    const src = `export struct P(u8 n) { u8 data[n] }\n`;
    const ls = service({ "/s/main.yfl": src });
    const ok = await ls.decodeSample("/s/main.yfl", "P", new Uint8Array([7, 8, 9]), { n: 2 });
    expect(ok.map(a => a.value)).toEqual(["[2 bytes] 07 08"]);
    await expect(ls.decodeSample("/s/main.yfl", "P", new Uint8Array(3), { m: 1 })).rejects.toThrow(
      /P has no parameter `m`/
    );
    await expect(
      ls.decodeSample("/s/main.yfl", "P", new Uint8Array(3), { n: "x" })
    ).rejects.toThrow(/Invalid root arguments/);
  });
});

// ── suggestLayout ──────────────────────────────────────────────────────────────

const ITEMS = (fileLayout: string, itemLayout: string) => `export struct File {
  u32  count
  u32  itemsOfs
  Item items[count] at itemsOfs
  Blob *extra : u32
${fileLayout}}

struct Item {
  u16  id
  u16  size
  u8[size] *payload : u32
  Note *note : u32 @nullable
${itemLayout}}

struct Note { u8 len  char text[len] }

struct Blob { u32 n  u8 data[n] }
`;

const LAYOUT_A = `  layout {
    items[*].payload @align(16)
    extra
    items            @align(4)
  }
`;

const VALUE = {
  items: [
    { id: 1, payload: new Uint8Array([1, 2, 3]), note: { text: "one" } },
    { id: 2, payload: new Uint8Array([4, 5, 6, 7, 8]), note: null },
    { id: 3, payload: new Uint8Array(17).fill(9), note: { text: "three" } }
  ],
  extra: { data: new Uint8Array([0xee, 0xee]) }
};

describe("suggestLayout with layout groups", () => {
  const GROUPED = `struct Leaf { u8 v }
struct Node {
  Leaf *x : u8
  Leaf *y : u8
}
export struct G {
  u8    n
  Node  nodes[n]
  layout {
    nodes[*] { y  x }
  }
}
`;
  it("simulates groups: a sample written by the schema needs no rules", async () => {
    const g = await api(GROUPED, "G");
    const leaf = (v: number) => ({ v });
    const bytes = g.serialize({
      nodes: [
        { x: leaf(1), y: leaf(2) },
        { x: leaf(3), y: leaf(4) }
      ]
    });
    // per node: y then x (the default would be x then y)
    expect([...bytes.subarray(5)]).toEqual([2, 1, 4, 3]);
    const ls = service({ "/s/main.yfl": GROUPED });
    expect(await ls.suggestLayout("/s/main.yfl", "G", bytes)).toBeUndefined();
  });
});

describe("suggestLayout", () => {
  it("infers layout rules (pull-outs, inner order, alignment) that rebuild the sample", async () => {
    const withLayout = ITEMS(LAYOUT_A, "  layout { note, payload }\n");
    const sample = (await api(withLayout, "File")).serialize(VALUE);
    const plain = ITEMS("", "");
    const ls = service({ "/s/main.yfl": plain });
    const edit = await ls.suggestLayout("/s/main.yfl", "File", sample);
    expect(edit).toBeDefined();
    const suggested = applyEdits(plain, edit!.changes["/s/main.yfl"]!);
    expect(suggested).toContain("items[*].payload @align(0x10)");
    // the suggestion rebuilds the sample byte for byte
    const S = await api(suggested, "File");
    expect(Buffer.from(S.serialize(S.parse(sample))).equals(Buffer.from(sample))).toBe(true);
    // and the schema that made the sample needs nothing
    const same = service({ "/s/main.yfl": withLayout });
    expect(await same.suggestLayout("/s/main.yfl", "File", sample)).toBeUndefined();
  });

  it("removes a layout the sample doesn't follow", async () => {
    const plain = ITEMS("", "");
    const sample = (await api(plain, "File")).serialize(VALUE);
    const withLayout = ITEMS(LAYOUT_A, "");
    const ls = service({ "/s/main.yfl": withLayout });
    const edit = await ls.suggestLayout("/s/main.yfl", "File", sample);
    const fixed = applyEdits(withLayout, edit!.changes["/s/main.yfl"]!);
    expect(fixed).toBe(plain);
  });
});
