/** Lazy views: reads, in-place patches, structural edits, commit policies, patches. */
import { beforeAll, describe, expect, it } from "vitest";
import * as rt from "@yafflelang/runtime";
import { build, dv, errorOf, toHex, type Mod } from "./harness.ts";
import { archiveIr } from "./fixtures/archive.ts";

let m: Mod;

beforeAll(async () => {
  m = await build("views-archive", archiveIr());
});

function sample(): Uint8Array {
  return m.Archive.serialize({
    entries: [
      { handler: 0, kind: 0, align: 0x100, data: new Uint8Array(0x180).fill(1) },
      { handler: 0, kind: 1, align: 0x100, data: new Uint8Array(0x40).fill(2) },
      { handler: 0, kind: 1, align: 0x100, data: new Uint8Array(0x100).fill(3) },
      { handler: 0, kind: 1, align: 0x100, data: new Uint8Array(0) }
    ]
  });
}

describe("views: reading", () => {
  it("reads fields lazily and equals the parse result", () => {
    const bytes = sample();
    const v = m.Archive.view(bytes);
    expect(v.count).toBe(4);
    expect(v.tag).toBe("ARCV");
    expect(v.entries.length).toBe(4);
    expect(v.entries[1].size).toBe(0x40);
    expect(v.entries[1].offset).toBe(0x300n);
    expect(v.entries[2].data[0]).toBe(3);
    expect(v.$plain()).toEqual(m.Archive.parse(bytes));
    expect(v.entries[0].$offset).toBe(0x80);
    expect(v.entries[1].$size).toBe(0x18);
    expect(Object.keys(v.entries[0])).toEqual([
      "handler",
      "kind",
      "align",
      "offset",
      "size",
      "reserved",
      "data"
    ]);
    expect(v.entries.map((e: { size: number }) => e.size)).toEqual([0x180, 0x40, 0x100, 0]);
  });

  it("only touches the bytes it needs (counting source)", () => {
    const bytes = new Uint8Array(0x100000 + 0x200);
    bytes.set(m.Archive.serialize({ entries: [] }));
    const big = m.Archive.serialize({
      entries: [
        { handler: 0, kind: 0, align: 0x100, data: new Uint8Array(0x80000).fill(5) },
        { handler: 0, kind: 1, align: 0x100, data: new Uint8Array(0x80000).fill(6) }
      ]
    });
    const src = rt.arraySource(big);
    const v = m.Archive.view(src);
    expect(v.entries[1].size).toBe(0x80000);
    expect(src.bytesRead).toBeLessThanOrEqual(0x10000);
    expect(v.entries[1].data[7]).toBe(6);
    expect(src.bytesRead).toBeGreaterThanOrEqual(0x80000);
  });

  it("errors carry the path of the field being read", () => {
    const bytes = sample();
    const bad = new Uint8Array(bytes);
    dv(bad).setUint32(0x80 + 0x18 + 0x14, 7, true); // reserved of entry 1
    const v = m.Archive.view(bad);
    expect(v.entries[0].size).toBe(0x180);
    expect(errorOf(() => v.entries[1].size)).toMatchObject({
      code: "CHECK",
      path: ["entries", 1, "reserved"]
    });
  });
});

describe("views: in-place edits", () => {
  it("same-size scalar edits are patched in place", () => {
    const bytes = sample();
    const v = m.Archive.view(bytes);
    v.entries[2].handler = 0x200;
    v.entries[0].kind = 7;
    expect(v.entries[2].handler).toBe(0x200);
    const patches: rt.Patch[] = v.$patches();
    expect(patches.map(p => [p.at, p.remove, p.insert.length])).toEqual([
      [0x80 + 2, 2, 2],
      [0x80 + 2 * 0x18, 2, 2]
    ]);
    const out: Uint8Array = v.$commit();
    expect(out).not.toBe(bytes);
    expect(toHex(bytes)).toBe(toHex(sample()));
    const p = m.Archive.parse(out);
    expect(p.entries[2].handler).toBe(0x200);
    expect(p.entries[0].kind).toBe(7);
    expect(out.length).toBe(bytes.length);
    // the view is rebound to the committed bytes
    expect(v.entries[2].handler).toBe(0x200);
    expect(v.$patches()).toEqual([]);
  });

  it("a structural scalar (used by a later layer) re-encodes but keeps data where it still fits", () => {
    const bytes = sample();
    const v = m.Archive.view(bytes);
    v.entries[2].align = 0x200; // entry 2 is at 0x400: still aligned
    const patches: rt.Patch[] = v.$patches();
    expect(patches.map(p => [p.at, p.remove, p.insert.length])).toEqual([
      [0x80 + 2 * 0x18 + 5, 1, 1]
    ]);
    v.entries[1].align = 0x200; // entry 1 is at 0x300: must move (appended at the end)
    const out: Uint8Array = v.$commit();
    const p = m.Archive.parse(out);
    expect(p.entries[2].offset).toBe(0x400n);
    expect(Number(p.entries[1].offset) % 0x200).toBe(0);
    expect(p.entries[1].offset).toBe(0x600n);
  });

  it("rejects derived fields and bad values", () => {
    const v = m.Archive.view(sample());
    expect(() => {
      v.entries[0].size = 5;
    }).toThrow(/derived/);
    expect(errorOf(() => (v.entries[0].align = 2 ** 32))).toMatchObject({
      code: "RANGE",
      path: ["entries", 0, "align"]
    });
  });
});

describe("views: structural edits", () => {
  it("push: the table grows into padding, existing data stays, new data is appended", () => {
    const bytes = sample();
    const v = m.Archive.view(bytes);
    v.entries.push({ handler: 0, kind: 1, align: 0x100, data: new Uint8Array([9, 9, 9]) });
    expect(v.entries.length).toBe(5);
    const out: Uint8Array = v.$commit();
    const p = m.Archive.parse(out);
    expect(p.count).toBe(5);
    expect(p.entries.map((e: { offset: bigint }) => e.offset)).toEqual([
      0x100n,
      0x300n,
      0x400n,
      0x500n,
      0x500n
    ]);
    expect(Array.from(p.entries[4].data)).toEqual([9, 9, 9]);
    // Old entries' data did not move: only the header/table changed and data was appended.
    expect(toHex(out.subarray(0x100, 0x500))).toBe(toHex(bytes.subarray(0x100, 0x500)));
  });

  it("growing a target appends it by default; splice shifts what follows", () => {
    const bytes = sample();
    const v = m.Archive.view(bytes);
    v.entries[1].data = new Uint8Array(0x50).fill(8);
    const patches: rt.Patch[] = v.$patches();
    const out = rt.applyPatches(bytes, patches);
    const p = m.Archive.parse(out);
    expect(p.entries[1].offset).toBe(0x500n);
    expect(p.entries[2].offset).toBe(0x400n);
    expect(Array.from(p.entries[1].data.subarray(0, 2))).toEqual([8, 8]);

    const v2 = m.Archive.view(bytes);
    v2.entries[1].data = new Uint8Array(0x150).fill(8);
    const out2: Uint8Array = v2.$commit({ grow: "splice" });
    const p2 = m.Archive.parse(out2);
    expect(p2.entries.map((e: { offset: bigint }) => e.offset)).toEqual([
      0x100n,
      0x300n,
      0x500n,
      0x600n
    ]);

    const v3 = m.Archive.view(bytes);
    v3.entries[1].data = new Uint8Array(0x150);
    expect(errorOf(() => v3.$commit({ grow: "error" })).code).toBe("DERIVE");
  });

  it("splice and remove elements", () => {
    const bytes = sample();
    const v = m.Archive.view(bytes);
    v.entries.splice(1, 1);
    const p = m.Archive.parse(v.$commit());
    expect(p.count).toBe(3);
    expect(p.entries.map((e: { size: number }) => e.size)).toEqual([0x180, 0x100, 0]);
  });

  it("$set on a struct view and replacing a whole element", () => {
    const v = m.Archive.view(sample());
    v.entries[0].$set({ handler: 3, kind: 4 });
    v.entries[3] = { handler: 1, kind: 1, align: 0x10, data: new Uint8Array([1, 2]) };
    const p = m.Archive.parse(v.$commit());
    expect(p.entries[0]).toMatchObject({ handler: 3, kind: 4 });
    expect(p.entries[3]).toMatchObject({ handler: 1, align: 0x10, size: 2 });
  });
});
