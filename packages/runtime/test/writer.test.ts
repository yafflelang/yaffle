/**
 * The relocation-style writer, used directly: blocks, pointer fixups, identity, `@ref`
 * resolution (also through enclosing bases), alignment, fixed placements, stream splitting and
 * codec reuse.
 */
import { describe, expect, it } from "vitest";
import * as rt from "../src/index.ts";
import { err } from "./helpers.ts";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("pointers and targets", () => {
  it("places targets after the root in creation order and fixes up offsets", () => {
    const out = rt.serializeWith(undefined, w => {
      w.u8(1);
      const a = w.target({}, "A", "a", () => w.bytes(new Uint8Array([0xaa, 0xaa])));
      w.pointer("u8", true, a, false, undefined);
      const b = w.target({}, "B", "b", () => w.u8(0xbb));
      w.pointer("u16", true, b, false, undefined);
    });
    expect(hex(out)).toBe("01" + "04" + "0600" + "aaaa" + "bb");
  });

  it("shares one placeable per (object, type key)", () => {
    const shared = { v: 1 };
    const out = rt.serializeWith(undefined, w => {
      for (let i = 0; i < 2; i++) {
        const p = w.target(shared, "S", "s", () => w.u8(9));
        w.pointer("u8", true, p, false, undefined);
      }
      // another type key at the same object is a separate target
      const q = w.target(shared, "T", "t", () => w.u8(8));
      w.pointer("u8", true, q, false, undefined);
    });
    expect(hex(out)).toBe("030304" + "09" + "08");
  });

  it("relative pointers count from the pointer; origins shift the stored value", () => {
    const out = rt.serializeWith(undefined, w => {
      w.u8(0);
      const t = w.target({}, "T", "t", () => w.u8(5));
      w.pointer("u8", true, t, true, undefined);
      w.pointer("u8", true, t, false, undefined, () => 2);
    });
    // t at 3: relative from 1 → 2; absolute 3 minus origin 2 → 1
    expect(hex(out)).toBe("00" + "02" + "01" + "05");
  });

  it("null pointers write the null value; a non-nullable null is INPUT", () => {
    expect(
      hex(rt.serializeWith(undefined, w => w.pointer("u16", false, null, false, 0xffffn)))
    ).toBe("ffff");
    expect(
      err(() => rt.serializeWith(undefined, w => w.pointer("u8", true, null, false, undefined)))
        .code
    ).toBe("INPUT");
  });

  it("an offset equal to the null value is DERIVE; a negative offset for an unsigned kind is RANGE", () => {
    const e = err(() =>
      rt.serializeWith(undefined, w => {
        const t = w.target({}, "T", "t", () => w.u8(1));
        w.pointer("u8", true, t, false, 1n);
      })
    );
    expect(e.code).toBe("DERIVE");
    const r = err(() =>
      rt.serializeWith(undefined, w => {
        const t = w.target({}, "T", "t", () => w.u8(1));
        w.pointer("u8", true, t, false, undefined, () => 10);
      })
    );
    expect(r.code).toBe("RANGE");
  });
});

describe("@ref pointers", () => {
  it("resolve to the first placed equal encoding", () => {
    const out = rt.serializeWith(undefined, w => {
      w.refPointer("u8", true, "str", "ab", () => enc("ab\0"), false, undefined);
      for (const s of ["xy", "ab", "ab"]) {
        const start = w.b.size;
        w.bytes(enc(s + "\0"));
        w.refSite("str", start);
      }
    });
    expect(out[0]).toBe(4);
  });

  it("objects resolve by identity before encoding", () => {
    const a = { n: 1 };
    const b = { n: 1 };
    const out = rt.serializeWith(undefined, w => {
      w.refPointer("u8", true, "S", b, () => new Uint8Array([1]), false, undefined);
      for (const o of [a, b]) {
        const start = w.b.size;
        w.u8(o.n);
        w.refSite("S", start, o);
      }
    });
    expect(out[0]).toBe(2);
  });

  it("search the enclosing bases; the offset stays relative to the pointer's own base", () => {
    const out = rt.serializeWith(undefined, w => {
      w.u8(0);
      const start = w.b.size;
      w.bytes(enc("ab\0"));
      w.refSite("str", start);
      w.base(undefined, () => {
        w.u8(7);
        w.base(undefined, () => {
          w.refPointer("i8", true, "str", "ab", () => enc("ab\0"), false, undefined);
        });
      });
    });
    // "ab" at 1; the inner base starts at 5 → 1 - 5 = -4
    expect(hex(out)).toBe("00" + "616200" + "07" + "fc");
  });

  it("report REF with the full path exactly once", () => {
    const e = err(() =>
      rt.serializeWith(undefined, w => {
        w.enter(() => ["outer"]);
        try {
          w.base(undefined, () => {
            w.enter(() => ["name"]);
            try {
              w.refPointer("u8", true, "str", "zz", () => enc("zz\0"), false, undefined);
            } finally {
              w.leave();
            }
          });
        } catch (x) {
          rt.rethrowAt(x, "outer");
        } finally {
          w.leave();
        }
      })
    );
    expect(e.code).toBe("REF");
    expect(e.path).toEqual(["outer", "name"]);
  });
});

describe("alignment and placement", () => {
  it("a region's alignEnd pads after its targets", () => {
    const out = rt.serializeWith(undefined, w => {
      w.region.alignEnd = 8;
      w.u8(1);
      const t = w.target({}, "T", "t", () => w.u8(2));
      w.pointer("u8", true, t, false, undefined);
    });
    expect(hex(out)).toBe("010202" + "0000000000");
  });

  it("a target with inner alignment starts aligned", () => {
    const out = rt.serializeWith(undefined, w => {
      w.u8(1);
      const t = w.target({}, "T", "t", () => {
        w.u8(2);
        w.align(4, 0);
        w.u8(3);
      });
      w.pointer("u8", true, t, false, undefined);
    });
    expect(hex(out)).toBe("0104" + "0000" + "02000000" + "03");
  });

  it("inner alignment of a fixed placement counts from its known position", () => {
    const out = rt.serializeWith(undefined, w => {
      w.u8(0);
      w.place(
        "f",
        undefined,
        () => {
          w.u8(1);
          w.align(4, 0);
          w.u8(2);
        },
        { fixed: 3 }
      );
    });
    expect(hex(out)).toBe("000000" + "01" + "02");
  });

  it("overlapping fixed placements are OVERLAP", () => {
    const e = err(() =>
      rt.serializeWith(undefined, w => {
        w.u8(0);
        w.place("a", undefined, () => w.bytes(new Uint8Array(4)), { fixed: 2 });
        w.place("b", undefined, () => w.bytes(new Uint8Array(4)), { fixed: 4 });
      })
    );
    expect(e.code).toBe("OVERLAP");
  });

  it("constraints pick the next position with the right remainder", () => {
    const out = rt.serializeWith(undefined, w => {
      w.u8(9);
      const t = w.target({}, "T", "t", () => w.u8(7), { constraint: { modulus: 4, remainder: 3 } });
      w.pointer("u8", true, t, false, undefined);
    });
    expect(out[1]).toBe(3);
    expect(out[3]).toBe(7);
  });

  it("a root struct's own layout (set per instance) wins over the region's", () => {
    const write = (to: number) =>
      rt.serializeWith([{ path: ["t"], layers: [{ kind: "align", to: 2 }] }], w => {
        const l = new rt.LStruct();
        w.u8(1);
        const t = w.target({}, "T", "t", () => w.u8(7));
        w.pointer("u8", true, t, false, undefined);
        l.set("t", t);
        l.layout = [{ path: ["t"], layers: [{ kind: "align", to }] }];
        return l;
      });
    expect(hex(write(8))).toBe("0108" + "000000000000" + "07");
    expect(hex(write(1))).toBe("0102" + "07");
    expect(err(() => write(0)).code).toBe("RANGE");
  });

  it("computed layout alignments and padding counts are checked", () => {
    expect(rt.layoutAlign(4)).toBe(4);
    expect(rt.layoutAlign(16n)).toBe(16);
    expect(err(() => rt.layoutAlign(0)).code).toBe("RANGE");
    expect(err(() => rt.layoutAlign(-8n)).code).toBe("RANGE");
    expect(err(() => rt.layoutAlign(1n << 60n)).code).toBe("RANGE");
    expect(rt.len(0, "padding")).toBe(0);
    expect(err(() => rt.len(-1, "padding")).code).toBe("RANGE");
  });
});

describe("streams and codecs", () => {
  it("splitStream: the elements' sizes win, else each piece fits its block", () => {
    const data = Uint8Array.from({ length: 10 }, (_, i) => i);
    const bySize = rt.splitStream([{ n: 4 }, { n: 6 }], "d", data, "n", undefined);
    expect(bySize.map(e => (e.d as Uint8Array).length)).toEqual([4, 6]);
    const fit = rt.splitStream(undefined, "d", data, "n", {
      offset: k => k * 5,
      size: e => 1 + (e as { d: Uint8Array }).d.length
    });
    expect(fit.map(e => (e.d as Uint8Array).length)).toEqual([4, 4, 2]);
    // a field overflowing its range does not fit either
    const ranged = rt.splitStream(undefined, "d", data, "n", {
      offset: k => k * 100,
      size: e => {
        const n = (e as { d: Uint8Array }).d.length;
        if (n > 3) rt.fail("RANGE", "too long");
        return n;
      }
    });
    expect(ranged.map(e => (e.d as Uint8Array).length)).toEqual([3, 3, 3, 1]);
    expect(err(() => rt.splitStream(undefined, "d", data, undefined, undefined)).code).toBe(
      "INPUT"
    );
  });

  it("splitStream keeps the original piece objects when unchanged (codec reuse)", () => {
    const a = new Uint8Array([1, 2]);
    const owner = { n: 2 };
    rt.setHidden(owner, "d", a);
    const out = rt.splitStream([owner], "d", new Uint8Array([1, 2]), "n", undefined);
    expect(out[0]!.d).toBe(a);
  });

  it("reuseCodec returns the original encoding only for unchanged content", () => {
    const v = new Uint8Array([1, 2, 3]);
    rt.rememberCodec(v, "S.f#1", new Uint8Array([0xee]), new Uint8Array([1, 2, 3]));
    expect(rt.reuseCodec(v, "S.f#1", new Uint8Array([1, 2, 3]))).toEqual(new Uint8Array([0xee]));
    expect(rt.reuseCodec(v, "S.f#1", new Uint8Array([1, 2, 4]))).toBeUndefined();
    expect(rt.reuseCodec(v, "S.f#2", new Uint8Array([1, 2, 3]))).toBeUndefined();
  });

  it("isEmpty covers arrays, bytes, strings and null", () => {
    expect(rt.isEmpty([])).toBe(true);
    expect(rt.isEmpty(new Uint8Array(0))).toBe(true);
    expect(rt.isEmpty("")).toBe(true);
    expect(rt.isEmpty(null)).toBe(true);
    expect(rt.isEmpty([1])).toBe(false);
    expect(rt.isEmpty("a")).toBe(false);
  });
});
