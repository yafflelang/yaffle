import { describe, expect, it } from "vitest";
import * as rt from "../src/index.ts";
import { code } from "./helpers.ts";

function bytes(n: number): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => i & 0xff);
}

describe("sources and stores", () => {
  it("ArrayStore is zero-copy", () => {
    const b = bytes(10);
    const s = new rt.ArrayStore(b);
    expect(s.get(2, 3).buffer).toBe(b.buffer);
    expect(s.whole).toBe(b);
  });

  it("SyncSourceStore caches blocks, spans blocks, bypasses the cache for large reads", () => {
    const b = bytes(0x30000);
    const src = rt.arraySource(b);
    const s = new rt.SyncSourceStore(src, { blockSize: 0x1000, maxBlocks: 4 });
    expect(Array.from(s.get(0x10, 4))).toEqual([0x10, 0x11, 0x12, 0x13]);
    expect(src.reads).toBe(1);
    s.get(0x20, 4);
    expect(src.reads).toBe(1);
    expect(Array.from(s.get(0xffe, 4))).toEqual([0xfe, 0xff, 0x00, 0x01]);
    expect(src.reads).toBe(2);
    const big = s.get(0x100, 0x10000);
    expect(big.length).toBe(0x10000);
    expect(big[0]).toBe(0);
    expect(code(() => s.get(0x2ffff, 2))).toBe("EOF");
    for (let i = 0; i < 10; i++) s.get(i * 0x1000, 1);
    expect(s.bytesRead).toBeGreaterThan(0);
  });

  it("AsyncSourceStore throws NeedBytes until fetched", async () => {
    const src = rt.asyncArraySource(bytes(0x5000));
    expect(rt.isAsyncSource(src)).toBe(true);
    expect(rt.isAsyncSource(rt.arraySource(bytes(4)))).toBe(false);
    expect(rt.isAsyncSource(new Uint8Array(1))).toBe(false);
    const s = new rt.AsyncSourceStore(src, { blockSize: 0x1000 });
    let need: rt.NeedBytes | undefined;
    try {
      s.get(0x1ffe, 4);
    } catch (e) {
      need = e as rt.NeedBytes;
    }
    expect(need).toBeInstanceOf(rt.NeedBytes);
    expect(rt.isControlSignal(need)).toBe(true);
    await s.fetch(need!);
    try {
      s.get(0x1ffe, 4);
    } catch (e) {
      await s.fetch(e as rt.NeedBytes);
    }
    expect(Array.from(s.get(0x1ffe, 4))).toEqual([0xfe, 0xff, 0x00, 0x01]);
    await s.fetch(new rt.NeedBytes(0, 0x5000));
    expect(s.get(0x4000, 4)[0]).toBe(0);
    s.release();
  });

  it("reads whole sources", async () => {
    expect((await rt.readAll(rt.asyncArraySource(bytes(5)))).length).toBe(5);
    expect(rt.readAllSync(rt.arraySource(bytes(3))).length).toBe(3);
  });
});

describe("Reader", () => {
  it("primitives, bytes and strings advance the position", () => {
    const b = new Uint8Array([
      1, 0x34, 0x12, 0x12, 0x34, 0x56, 0x78, 0x9a, 0x61, 0x62, 0, 0x63, 0, 0xff
    ]);
    const r = new rt.Reader(b);
    expect(r.u8()).toBe(1);
    expect(r.u16(true)).toBe(0x1234);
    expect(r.u32(false)).toBe(0x12345678);
    expect(r.uN(1, true)).toBe(0x9a);
    expect(r.strUntil(1, "utf8", true)).toBe("ab");
    expect(r.str(2, 1, "ascii", true)).toBe("c");
    expect(r.remaining).toBe(1);
    expect(code(() => r.u16(true))).toBe("EOF");
    expect(r.pos).toBe(13);
  });

  it("windows, padding, alignment and strict fill", () => {
    const b = new Uint8Array([7, 0, 0, 0, 1, 2, 0xcc, 0xcc, 9]);
    const r = new rt.Reader(b);
    r.u8();
    r.align(4, 0, true);
    expect(r.pos).toBe(4);
    const saved = r.window(4);
    expect(r.u16(true)).toBe(0x0201);
    expect(code(() => r.closeWindow(saved, true))).toBe("CHECK");
    r.pos = 6;
    r.end = 8;
    r.closeWindow(9, false);
    expect(r.pos).toBe(8);
    expect(r.end).toBe(9);
    const r2 = new rt.Reader(b);
    r2.pos = 6;
    r2.pad(2, 0xcc, true);
    r2.pos = 4;
    expect(code(() => r2.padUntil(4, 1, 0, false))).toBe("none");
    expect(code(() => r2.padUntil(0, 2, 0, false))).toBe("CHECK");
    expect(code(() => r2.window(100))).toBe("EOF");
    const fn: rt.Fill = i => i + 1;
    expect(rt.fillByte(fn, 3)).toBe(4);
    expect(rt.fillByte(0x1ff, 0)).toBe(0xff);
  });

  it("targets keep identity per address and type; cycles are errors", () => {
    const r = new rt.Reader(new Uint8Array([1, 2, 3, 4]));
    const a = r.target(2, "T", () => ({ v: r.u8() }));
    const b = r.target(2, "T", () => ({ v: r.u8() }));
    const c = r.target(2, "U", () => ({ v: r.u8() }));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(r.pos).toBe(0);
    expect(r.maxEnd).toBe(3);
    const cyc = (): unknown => r.target(1, "C", () => cyc());
    expect(code(cyc)).toBe("CHECK");
    expect(code(() => r.target(10, "X", () => 0))).toBe("EOF");
  });

  it("unions collect every variant's error", () => {
    const r = new rt.Reader(new Uint8Array([5]));
    try {
      r.union([
        ["A", () => r.fail("CHECK", "not A")],
        ["B", () => r.u32(true)]
      ]);
    } catch (e) {
      const ye = e as rt.YaffleError;
      expect(ye.code).toBe("UNION");
      expect(ye.causes!.map(x => x.code)).toEqual(["CHECK", "EOF"]);
      expect(ye.causes![0]!.path).toEqual(["A"]);
    }
    expect(r.pos).toBe(0);
    expect(r.union([["X", () => r.u8()]])).toEqual({ type: "X", value: 5 });
  });

  it("extern types grow the probe until size() answers", () => {
    const data = new Uint8Array(40).fill(0x80);
    data[30] = 0;
    const r = new rt.Reader(data);
    let calls = 0;
    const host = {
      size(b: Uint8Array) {
        calls++;
        const i = b.indexOf(0);
        return i < 0 ? undefined : i + 1;
      },
      read(b: Uint8Array) {
        return b.length;
      },
      write() {
        return new Uint8Array(0);
      }
    };
    expect(r.extern(host, [])).toBe(31);
    expect(calls).toBeGreaterThan(1);
    expect(code(() => new rt.Reader(new Uint8Array([0x80, 0x80])).extern(host, []))).toBe("EOF");
    expect(rt.uleb128.read(new Uint8Array([0xac, 0x02]))).toBe(300n);
    expect(Array.from(rt.uleb128.write(300n))).toEqual([0xac, 0x02]);
    expect(rt.sleb128.read(rt.sleb128.write(-129n))).toBe(-129n);
    expect(rt.sleb128.read(rt.sleb128.write(63n))).toBe(63n);
    expect(rt.sleb128.read(rt.sleb128.write(-64n))).toBe(-64n);
  });

  it("works over a windowed store (non-array sources)", () => {
    const b = new Uint8Array(0x30000);
    b[0x20000] = 0x61;
    b[0x20001] = 0x62;
    const store = new rt.SyncSourceStore(rt.arraySource(b), { blockSize: 0x1000 });
    const r = new rt.Reader(store);
    r.pos = 0x20000;
    expect(r.strUntil(1, "utf8", true)).toBe("ab");
    r.pos = 0x1fffe;
    expect(r.u32(true)).toBe(0x00006261 * 0x10000);
    const copy = r.bytes(4);
    expect(copy.buffer).not.toBe(b.buffer);
    expect(r.peekBytes(0x20000, 0x20002)[1]).toBe(0x62);
  });
});
