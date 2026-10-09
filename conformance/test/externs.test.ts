/** Tests of the conformance externs (conformance/externs). */
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { axor } from "../externs/ts/axor.ts";
import { Bcd16 } from "../externs/ts/bcd16.ts";
import { rle, rleDecode, rleEncode } from "../externs/ts/rle.ts";
import { rlez } from "../externs/ts/rlez.ts";
import { sum8 } from "../externs/ts/sum8.ts";
import { swap16 } from "../externs/ts/swap16.ts";
import { VarInt } from "../externs/ts/varint.ts";
import { xor } from "../externs/ts/xor.ts";
import { xorpos } from "../externs/ts/xorpos.ts";

const u8 = (...b: number[]) => Uint8Array.from(b);

describe("TS conformance externs", () => {
  it("xor", () => {
    expect(xor.encode(u8(1, 2, 3), { args: [0x5a] })).toEqual(u8(0x5b, 0x58, 0x59));
    expect(xor.decode(u8(0x5b, 0x58, 0x59), { args: [0x5a], outputSize: 3 })).toEqual(u8(1, 2, 3));
    expect(() => xor.decode(u8(0), { args: [1], outputSize: 2 })).toThrow();
    expect(() => xor.decode(u8(0), { args: [256] })).toThrow(/u8/);
  });
  it("xorpos uses the position", () => {
    expect(xorpos.encode(u8(0, 0, 0), { args: [0xfe] })).toEqual(u8(0xfe, 0xff, 0x00));
    expect(xorpos.decode(u8(0, 0), { args: [0xfe], position: 1 })).toEqual(u8(0xff, 0x00));
  });
  it("axor is async xor", async () => {
    await expect(axor.encode(u8(0xff), { args: [0x0f] })).resolves.toEqual(u8(0xf0));
    await expect(axor.decode(u8(0xf0), { args: [0x0f] })).resolves.toEqual(u8(0xff));
  });
  it("rle", () => {
    const long = new Uint8Array(257).fill(7);
    long[256] = 1;
    expect(rleEncode(long)).toEqual(u8(255, 7, 1, 7, 1, 1));
    expect(rleDecode(u8(255, 7, 1, 7, 1, 1))).toEqual(long);
    expect(rleEncode(u8())).toEqual(u8());
    expect(rle.decode(u8(2, 9, 1, 8), { args: [], outputSize: 3 })).toEqual(u8(9, 9, 8));
    expect(() => rle.decode(u8(0, 9), { args: [] })).toThrow(/zero/);
    expect(() => rle.decode(u8(1), { args: [] })).toThrow(/odd/);
    expect(() => rle.decode(u8(1, 1), { args: [], outputSize: 2 })).toThrow(/expected 2/);
  });
  it("rlez streams to its terminator", () => {
    expect(rlez.encode(u8(5, 5), { args: [] })).toEqual(u8(2, 5, 0));
    expect(rlez.decode(u8(2, 5, 0, 0xaa), { args: [] })).toEqual({ output: u8(5, 5), consumed: 3 });
    expect(rlez.decode(u8(0), { args: [] })).toEqual({ output: u8(), consumed: 1 });
    expect(() => rlez.decode(u8(2, 5), { args: [] })).toThrow(/terminator/);
  });
  it("sum8 and swap16", () => {
    expect(sum8(u8(0xff, 2))).toBe(1);
    expect(sum8(u8())).toBe(0);
    expect(swap16(0x1234)).toBe(0x3412);
  });
  it("VarInt", () => {
    expect(VarInt.write(300n, 10)).toEqual(u8(0xac, 0x02));
    expect(VarInt.read(u8(0xac, 0x02), 10)).toBe(300n);
    expect(VarInt.size(u8(0xac, 0x02, 0x99), 10)).toBe(2);
    expect(VarInt.size(u8(0xac), 10)).toBeUndefined();
    expect(() => VarInt.size(u8(0x80, 0x80), 2)).toThrow();
    expect(() => VarInt.write(1n << 14n, 2)).toThrow();
    const max = VarInt.write(0xffff_ffff_ffff_ffffn, 10);
    expect(max).toHaveLength(10);
    expect(VarInt.read(max, 10)).toBe(0xffff_ffff_ffff_ffffn);
    expect(VarInt.write(0n, 1)).toEqual(u8(0));
  });
  it("Bcd16", () => {
    expect(Bcd16.read(u8(0x12, 0x34))).toBe(1234);
    expect(Bcd16.write(907)).toEqual(u8(0x09, 0x07));
    expect(() => Bcd16.read(u8(0x1a, 0))).toThrow();
    expect(() => Bcd16.write(10000)).toThrow();
  });
});

const hasRustc = spawnSync("rustc", ["--version"]).status === 0;

describe("Rust conformance externs", () => {
  it.skipIf(!hasRustc)("pass their unit tests (needs rustc on PATH)", () => {
    const script = join(import.meta.dirname, "..", "scripts", "test-rust-externs.sh");
    const out = execFileSync(script, { encoding: "utf8" });
    expect(out).toMatch(/test result: ok/);
  });
});
