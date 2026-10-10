/**
 * Language features in the Python target: per-element layout groups (docs/IR.md §4.3), alignment
 * origin and offset and strict padding (§2.4), virtual fields (§2.2, §3.1), derived arrays and
 * composite equality (§6), and writable slice carriers (§3.7). Expected bytes are worked out by
 * hand from the IR semantics.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { HAVE_PYTHON, PRELUDE, generate, program, py, type Generated } from "./harness.ts";

const SCHEMA = `
struct Pt { u8 x }
struct Vol {
  u8 n
  u8 m
  Pt *pieces[n] : u8
  Pt *points[m] : u8
}
export struct Groups {
  u8 count
  Vol vols[count]
  layout {
    vols[*] { points[*]  pieces[*] }
  }
}

struct Inner @base {
  u8 a
  u8 b @align(4, from: file)
  u8 c @align(4)
}
export struct FileAlign {
  u8    x
  Inner inner
}
export struct TargetAlign {
  u8     x
  Inner *p : u8
}
export struct Offset {
  u8 a
  u8 b @align(4, offset: 1)
}
export struct StrictPad {
  u8 a @padAfter(3, strict)
  u8 b @padAfter(3)
}

export struct Virt {
  u8  sizeHigh
  u32 sizeLow
  virtual u40 size = (sizeHigh << 32) | sizeLow
}

struct Key { char name[4]  u8 v }
export struct Sorted {
  u8  n
  Key keys[n] where it == sortedBy(it, k => k.name)
}
struct Rec { u8 kind  u8 *model : u8 @nullable }
export struct Indexed {
  u8  n
  Rec records[n]
  u8  m
  u8  index[m] = indicesWhere(records, r => r.model != null)
}
export struct Uniq {
  u8 n
  u8 xs[n]
  u8 m
  u8 ys[m] = unique(xs)
  u8 k
  u8 zs[k] = concat(filter(xs, x => x > 1), ys)
  u8 j
  u16 ws[j] = map(ys, y => y * 100)
}

struct Header { u16 a  u16 b }
struct Footer { u32 c }
export struct Overlay {
  u8     raw[8] @hidden
  Header hdr  from raw[0..4]
  Footer foot from raw[4..8]
}
export struct Overlap {
  u8     raw[6] @hidden
  Header hdr  from raw[0..4]
  Header tl   from raw[2..6]
}
`;

let gen: Generated;

async function run(body: string): Promise<unknown> {
  return py(
    gen,
    `${PRELUDE}
from ${gen.pkg}.schema import *
def rt_ok(cls, data, **kw):
    v = cls.parse(data, **kw)
    return v.serialize(**kw) == data and cls.from_json(v.to_json()).serialize(**kw) == data
${body}
`
  );
}

describe.skipIf(!HAVE_PYTHON)("Python language features", () => {
  beforeAll(() => {
    gen = generate("language", program(SCHEMA));
  });

  it("per-element layout groups place each element's items in order", async () => {
    const out = await run(`
g = Groups(vols=[Vol(pieces=[Pt(x=1), Pt(x=2)], points=[Pt(x=3)]),
                 Vol(pieces=[Pt(x=4)], points=[Pt(x=5), Pt(x=6)])])
data = g.serialize()
print(json.dumps({"hex": data.hex(), "rt": rt_ok(Groups, data)}))
`);
    // Targets from 0x0b: vol 0's points (3), its pieces (1, 2), vol 1's points (5, 6), its piece (4).
    expect(out).toEqual({ hex: "02" + "02010c0d0b" + "0102100e0f" + "030102050604", rt: true });
  });

  it("alignment from the file start and with an offset", async () => {
    const out = await run(`
fa = FileAlign(x=1, inner=Inner(a=2, b=3, c=4)).serialize()
ta = TargetAlign(x=1, p=Inner(a=2, b=3, c=4)).serialize()
tp = TargetAlign.parse(ta)
off = Offset(a=1, b=2).serialize()
print(json.dumps({"fa": fa.hex(), "fa_rt": rt_ok(FileAlign, fa), "fa_view": FileAlign.to_json(FileAlign.view(fa)),
  "ta_rt": rt_ok(TargetAlign, ta), "ta_p": tp.p is not None and [tp.p.a, tp.p.b, tp.p.c],
  "off": off.hex(), "off_rt": rt_ok(Offset, off)}))
`);
    expect(out).toEqual({
      // Inner is a base at 1: b aligns to file offset 4, c to base offset 4 (file 5).
      fa: "010200000304",
      fa_rt: true,
      fa_view: { x: 1, inner: { a: 2, b: 3, c: 4 } },
      ta_rt: true,
      ta_p: [2, 3, 4],
      off: "01000002",
      off_rt: true
    });
  });

  it("strict padding is checked outside strict mode", async () => {
    const out = await run(`
ok = StrictPad(a=1, b=2).serialize()
bad_a = bytearray(ok); bad_a[1] = 9
bad_b = bytearray(ok); bad_b[5] = 9
print(json.dumps({"ok": ok.hex(), "a": err(lambda: StrictPad.parse(bytes(bad_a))),
  "b": StrictPad.parse(bytes(bad_b)).to_json(),
  "view": err(lambda: StrictPad.to_json(StrictPad.view(bytes(bad_a))))}))
`);
    expect(out).toEqual({
      ok: "0100000002000000",
      a: { code: "CHECK", path: ["a"] },
      b: { a: 1, b: 2 },
      view: { code: "CHECK", path: ["a"] }
    });
  });

  it("virtual fields are evaluated on read and derive their parts on write", async () => {
    const out = await run(`
data = Virt(size=0x1234567890).serialize()
p = Virt.parse(data)
v = Virt.view(data)
v.size = 0x0100000005
edited = Virt.parse(v._commit())
print(json.dumps({"hex": data.hex(), "json": p.to_json(), "rt": rt_ok(Virt, data),
  "big": err(lambda: Virt(size=1 << 41).serialize()),
  "neg": err(lambda: Virt(size=-1).serialize()),
  "edited": [edited.sizeHigh, edited.sizeLow, edited.size],
  "derived": err(lambda: setattr(Virt.view(data), "sizeLow", 1))}))
`);
    expect(out).toEqual({
      hex: "1290785634",
      json: { sizeHigh: 0x12, sizeLow: 0x34567890, size: 0x1234567890 },
      rt: true,
      big: { code: "RANGE", path: ["size"] },
      neg: { code: "RANGE", path: ["size"] },
      edited: [1, 5, 0x0100000005],
      derived: { code: "INPUT", path: ["sizeLow"] }
    });
  });

  it("sortedBy checks over structs (composite equality)", async () => {
    const out = await run(`
good = Sorted(keys=[Key(name="abc", v=1), Key(name="abd", v=0), Key(name="b", v=2)]).serialize()
bad = Sorted(keys=[Key(name="b", v=2), Key(name="abc", v=1)])
swapped = bytearray(good); swapped[1:6], swapped[6:11] = good[6:11], good[1:6]
print(json.dumps({"good": rt_ok(Sorted, good), "write": err(lambda: bad.serialize()),
  "read": err(lambda: Sorted.parse(bytes(swapped))),
  "view": err(lambda: Sorted.to_json(Sorted.view(bytes(swapped))))}))
`);
    expect(out).toEqual({
      good: true,
      write: { code: "CHECK", path: ["keys"] },
      read: { code: "CHECK", path: ["keys"] },
      view: { code: "CHECK", path: ["keys"] }
    });
  });

  it("derived arrays (indicesWhere over nullable pointers, unique, filter, concat, map)", async () => {
    const out = await run(`
d = Indexed(records=[Rec(kind=1, model=None), Rec(kind=2, model=7), Rec(kind=3, model=9)]).serialize()
u = Uniq(xs=bytes([3, 1, 3, 2, 1])).serialize()
up = Uniq.parse(u)
print(json.dumps({"index": Indexed.parse(d).to_json()["index"], "d_rt": rt_ok(Indexed, d),
  "u": up.to_json(), "u_rt": rt_ok(Uniq, u)}))
`);
    expect(out).toEqual({
      index: "0102",
      d_rt: true,
      u: {
        n: 5,
        xs: "0301030201",
        m: 3,
        ys: "030102",
        k: 6,
        zs: "030302030102",
        j: 3,
        ws: [300, 100, 200]
      },
      u_rt: true
    });
  });

  it("slice carriers are assembled from their slices; overlaps must agree", async () => {
    const out = await run(`
o = Overlay(hdr=Header(a=1, b=2), foot=Footer(c=3)).serialize()
ov = Overlay.view(o)
ov.foot.c = 0x0a0b0c0d
edited = ov._commit()
same = Overlap(hdr=Header(a=1, b=2), tl=Header(a=2, b=5)).serialize()
print(json.dumps({"o": o.hex(), "rt": rt_ok(Overlay, o), "edited": edited.hex(),
  "same": same.hex(), "clash": err(lambda: Overlap(hdr=Header(a=1, b=2), tl=Header(a=3, b=5)).serialize())}))
`);
    expect(out).toEqual({
      o: "0100020003000000",
      rt: true,
      edited: "010002000d0c0b0a",
      same: "010002000500",
      clash: { code: "DERIVE", path: ["raw"] }
    });
  });
});
