/**
 * An archive as a hand-written IR (the `arcv` fixture): a 0x80-byte header, a table of 0x18-byte
 * entries, and each entry's data at the next multiple of its own alignment.
 *
 *   export struct Archive {
 *     @padUntil(0x80) { char tag[4] = "ARCV"  u32 count }
 *     Entry entries[count]
 *   }
 *   struct Entry {
 *     u16 handler  u16 kind  u32 align
 *     u64 offset              // = offsetof(data)
 *     u32 size                // = data.length
 *     u32 reserved
 *     u8  data[size] at offset @align(align)
 *   }
 */
import { beforeAll, describe, expect, it } from "vitest";
import { arcv } from "./fixtures.ts";
import { build, hasRust, type Built } from "./rust-utils.ts";

describe.skipIf(!hasRust)("rust backend: archive", () => {
  let b: Built;
  beforeAll(async () => {
    b = await build("yaffle_t_archive", [{ name: "arcv", program: arcv }], { release: true });
  }, 600_000);

  it("round-trips a synthetic archive through JSON", async () => {
    const hdr = Buffer.alloc(0x80);
    hdr.write("ARCV", 0, "latin1");
    hdr.writeUInt32LE(3, 4);
    const ents = Buffer.alloc(3 * 0x18);
    const datas = [Buffer.from([1, 2, 3]), Buffer.from([4]), Buffer.alloc(0)];
    const aligns = [0x100, 0x10, 0x100];
    let pos = 0x80 + ents.length;
    const placed: number[] = [];
    for (const [i, d] of datas.entries()) {
      pos = Math.ceil(pos / aligns[i]!) * aligns[i]!;
      placed.push(pos);
      ents.writeUInt16LE(0, i * 0x18);
      ents.writeUInt16LE(i === 0 ? 0 : 1, i * 0x18 + 2);
      ents.writeUInt32LE(aligns[i]!, i * 0x18 + 4);
      ents.writeBigUInt64LE(BigInt(pos), i * 0x18 + 8);
      ents.writeUInt32LE(d.length, i * 0x18 + 16);
      pos += d.length;
    }
    const file = Buffer.alloc(pos);
    hdr.copy(file, 0);
    ents.copy(file, 0x80);
    datas.forEach((d, i) => d.copy(file, placed[i]!));
    const hex = file.toString("hex");
    const json = (await b.value({
      op: "parse",
      module: "arcv",
      root: "Archive",
      bytes: hex
    })) as Record<string, unknown>;
    const entries = json["entries"] as Record<string, unknown>[];
    expect(json["count"]).toBe(3);
    expect(entries[0]).toEqual({
      handler: 0,
      kind: 0,
      align: 0x100,
      offset: "256",
      size: 3,
      reserved: 0,
      data: "010203"
    });
    expect(entries[2]).toMatchObject({ offset: String(pos), size: 0, data: "" });
    expect(await b.value({ op: "serialize", module: "arcv", root: "Archive", json })).toBe(hex);
    // Bigger data moves the following entries.
    entries[0]!["data"] = "ff".repeat(0x120);
    const grown = (await b.value({
      op: "serialize",
      module: "arcv",
      root: "Archive",
      json
    })) as string;
    const back = (await b.value({
      op: "parse",
      module: "arcv",
      root: "Archive",
      bytes: grown
    })) as Record<string, unknown>;
    const be = back["entries"] as Record<string, unknown>[];
    expect(be[0]!["size"]).toBe(0x120);
    expect(be[1]!["offset"]).toBe(String(0x100 + 0x120));
    expect(be[2]!["offset"]).toBe(String(0x300));
  });

  it("rejects other tags", async () => {
    const err = await b.error({
      op: "parse",
      module: "arcv",
      root: "Archive",
      bytes: Buffer.from("DICT").toString("hex") + "00".repeat(0x7c)
    });
    expect(err).toMatchObject({ code: "CHECK", path: ["tag"], offset: 0 });
  });
});
