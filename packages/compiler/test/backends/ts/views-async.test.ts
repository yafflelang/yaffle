/** Async views (async sources, async codecs) and views over codec regions. */
import { beforeAll, describe, expect, it } from "vitest";
import * as rt from "@yafflelang/runtime";
import { build, dv, load, toHex, type Mod } from "./harness.ts";
import { archiveIr } from "./fixtures/archive.ts";
import { bodyStruct, withExterns } from "./fixtures/externs.ts";
import * as ir from "./ir.ts";

const { S, f, derived, program, u8, u32, ref, fr, L, layered, encodedSize, codecDecl } = ir;

let pf: Mod;

beforeAll(async () => {
  pf = await build("views-async-pf", archiveIr());
});

function sample(): Uint8Array {
  return pf.Archive.serialize({
    entries: [
      { handler: 0, kind: 0, align: 0x100, data: new Uint8Array(0x180).fill(1) },
      { handler: 0, kind: 1, align: 0x100, data: new Uint8Array(0x40).fill(2) },
      { handler: 0, kind: 1, align: 0x100, data: new Uint8Array(0x100).fill(3) }
    ]
  });
}

describe("async views over async sources", () => {
  it("every property chain is awaitable", async () => {
    const bytes = sample();
    const src = rt.asyncArraySource(bytes.slice());
    const av = pf.Archive.view(src);
    expect(await av.count).toBe(3);
    expect(await av.entries[1].size).toBe(0x40);
    expect(await av.entries.length).toBe(3);
    const data: Uint8Array = await av.entries[2].data;
    expect(data.length).toBe(0x100);
    expect(data[0]).toBe(3);
    expect(await av.entries[1]).toEqual(pf.Archive.parse(bytes).entries[1]);
    expect(await av.$plain()).toEqual(pf.Archive.parse(bytes));
    expect(await av.entries[1].$offset).toBe(0x80 + 0x18);
  });

  it("$set + $commit writes patches back to the source", async () => {
    const bytes = sample();
    const src = rt.asyncArraySource(bytes.slice());
    const av = pf.Archive.view(src);
    await av.entries[0].$set({ handler: 0x1234, kind: 5 });
    const dry = await av.$patches();
    // adjacent in-place edits merge into one patch
    expect(dry.map((p: rt.Patch) => [p.at, p.remove])).toEqual([[0x80, 4]]);
    const patches = await av.$commit();
    expect(patches).toHaveLength(1);
    const p = pf.Archive.parse(src.bytes);
    expect(p.entries[0]).toMatchObject({ handler: 0x1234, kind: 5 });
    expect(await av.entries[0].handler).toBe(0x1234);
  });

  it("structural edits on an async view grow the source", async () => {
    const bytes = sample();
    const src = rt.asyncArraySource(bytes.slice());
    const av = pf.Archive.view(src);
    const v = await av.entries;
    expect(v).toHaveLength(3);
    // replace an entry's data with a bigger one: appended at the end, offset updated
    await av.entries[1].$set({ data: new Uint8Array(0x80).fill(7) });
    await av.$commit();
    const p = pf.Archive.parse(src.bytes);
    expect(p.entries[1].size).toBe(0x80);
    expect(p.entries[1].offset).toBe(0x500n);
    expect(src.bytes.length).toBe(0x580);
  });

  it("assignments through the async proxy are rejected", () => {
    const av = pf.Archive.view(rt.asyncArraySource(sample()));
    expect(() => {
      av.entries[0].handler = 1;
    }).toThrow(/\$set/);
  });

  it("viewAsync over in-memory bytes", async () => {
    const av = pf.Archive.viewAsync(sample());
    expect(await av.entries[2].size).toBe(0x100);
  });
});

describe("views over codec regions", () => {
  it("decodes on access; edits inside re-encode; untouched regions reuse their bytes", async () => {
    const P = program({
      structs: [
        bodyStruct(),
        S("Two", [
          derived("c1", u32, encodedSize("a", 1)),
          f("a", layered(ref("Body"), L.via("zstd"), L.size(fr("c1")))),
          derived("c2", u32, encodedSize("b", 1)),
          f("b", layered(ref("Body"), L.via("zstd"), L.size(fr("c2")))),
          f("tail", u8)
        ])
      ],
      externs: [codecDecl("zstd")],
      roots: ["Two"]
    });
    const m = await build("views-codec", P, withExterns("zstd"));
    const x = await load(m.$gen, "externs.ts");
    const bytes: Uint8Array = m.Two.serialize({
      a: { items: Array.from({ length: 100 }, (_, i) => i), name: "first" },
      b: { items: [1, 2, 3], name: "second" },
      tail: 9
    });
    const v = m.Two.view(bytes);
    const decodes = x.counts.zstdDecode;
    expect(v.tail).toBe(9);
    expect(x.counts.zstdDecode).toBe(decodes);
    expect(v.b.name).toBe("second");
    expect(x.counts.zstdDecode).toBe(decodes + 1);
    expect(v.b.items[2]).toBe(3);
    // in-place patch on the outer struct: fast path
    v.tail = 10;
    expect(v.$patches()).toHaveLength(1);
    // edit inside region b: b is re-encoded, a reuses its compressed bytes
    v.b.items[0] = 42;
    const encodes = x.counts.zstdEncode;
    const out: Uint8Array = v.$commit();
    expect(x.counts.zstdEncode).toBe(encodes + 1);
    const p = m.Two.parse(out);
    expect(p.b.items).toEqual([42, 2, 3]);
    expect(p.a.items[99]).toBe(99);
    expect(p.tail).toBe(10);
    // the prefix (c1 + region a) is unchanged
    const c1 = dv(bytes).getUint32(0, true);
    expect(toHex(out.subarray(0, 4 + c1))).toBe(toHex(bytes.subarray(0, 4 + c1)));
  });

  it("async codecs: views of async formats are async", async () => {
    const P = program({
      structs: [
        bodyStruct(),
        S(
          "A",
          [
            derived("c", u32, encodedSize("body", 1)),
            f("body", layered(ref("Body"), L.via("azstd"), L.size(fr("c")))),
            f("tail", u8)
          ],
          { async: true }
        )
      ],
      externs: [codecDecl("azstd", { async: true })],
      roots: ["A"]
    });
    const m = await build("views-async-codec", P, withExterns("azstd"));
    const bytes: Uint8Array = await m.A.serializeAsync({
      body: { items: [5, 6, 7], name: "async" },
      tail: 3
    });
    const av = m.A.view(bytes);
    expect(await av.body.name).toBe("async");
    expect(await av.body.items[1]).toBe(6);
    await av.$set({ tail: 4 });
    const patches = await av.$patches();
    expect(patches).toHaveLength(1);

    // Structural edits re-encode through the async writer; unchanged regions keep their bytes.
    const sv = m.A.view(bytes);
    await sv.body.$set({ name: "a longer async name" });
    await sv.$set({ tail: 9 });
    await sv.$commit();
    const out = await sv.$read((v: { $raw(): Uint8Array }) => v.$raw());
    const p = await m.A.parseAsync(out);
    expect(p.body.name).toBe("a longer async name");
    expect(p.body.items).toEqual([5, 6, 7]);
    expect(p.tail).toBe(9);
    expect(await sv.body.name).toBe("a longer async name");

    // The forced rewrite of an unedited view reproduces the input.
    const rv = m.A.view(bytes);
    const same = await rv.$patches({ rewrite: true });
    expect(same).toEqual([]);
  });
});
