/**
 * Layout items that read fields, in the Python target (docs/IR.md §4.4): layout item layer
 * arguments are evaluated in the write context of the struct that owns the layout (inputs,
 * derived fields, parameters, `$index`), through paths and groups, in bases, and in view commits.
 * An alignment below 1 is RANGE. Expected bytes are worked out by hand from the IR semantics.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { HAVE_PYTHON, PRELUDE, generate, program, py, type Generated } from "./harness.ts";

const SCHEMA = `
export struct ByField {
  u8 align
  u8 size
  u8 offset
  u8 data[size] at offset
  layout { data @align(align) }
}

export struct Offsets {
  i8 k
  u8 o1
  u8 o2
  u8 a at o1
  u8 b at o2
  layout { a @align(4, offset: k)  b @align(k + 1, from: file) }
}

export struct WithParam(u8 k) {
  u8 o
  u8 d at o
  layout { d @align(k * 4) }
}

struct Pt { u8 x }
struct Vol {
  u8 n
  Pt *pts[n] : u8
}
export struct Groups {
  u8  shift
  u8  count
  Vol vols[count]
  layout { vols[*] { pts[*] @align(1 << shift) } }
}

struct Elem {
  u8 o
  u8 d at o
  layout { d @align(($index + 1) * 2) }
}
export struct Indexed {
  u8   count
  Elem elems[count]
}

struct Blk @base {
  u8 al
  u8 o
  u8 d[2] at o
  layout { d @align(al) }
}
export struct InBase {
  u8  x
  Blk blk
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

describe.skipIf(!HAVE_PYTHON)("Python layout items that read fields", () => {
  beforeAll(() => {
    gen = generate("layout_fields", program(SCHEMA));
  });

  it("evaluates layer arguments over inputs, params and derived offsets; RANGE below 1", async () => {
    const out = await run(`
a8 = ByField(align=8, data=b"\\xcc").serialize()
a1 = ByField(align=1, data=b"\\xdd\\xee").serialize()
offs = Offsets(k=2, a=0xaa, b=0xbb).serialize()
wp = WithParam(d=7).serialize(k=2)
print(json.dumps({"a8": a8.hex(), "a1": a1.hex(), "rt": rt_ok(ByField, a8),
  "zero": err(lambda: ByField(align=0, data=b"\\xaa").serialize()),
  "offs": offs.hex(), "offs_rt": rt_ok(Offsets, offs),
  "offs_neg": err(lambda: Offsets(k=-1, a=1, b=2).serialize()),
  "wp": wp.hex(), "wp_rt": rt_ok(WithParam, wp, k=2),
  "wp_zero": err(lambda: WithParam(d=7).serialize(k=0))}))
`);
    expect(out).toEqual({
      a8: "080108" + "0000000000" + "cc",
      a1: "010203ddee",
      rt: true,
      zero: { code: "RANGE", path: [] },
      // a: (pos + 2) % 4 == 0 after the 3-byte header → 6; b: aligned to 3 → 9.
      offs: "020609" + "000000" + "aa" + "0000" + "bb",
      offs_rt: true,
      // k = -1: b's alignment is 0.
      offs_neg: { code: "RANGE", path: [] },
      wp: "08" + "00000000000000" + "07",
      wp_rt: true,
      wp_zero: { code: "RANGE", path: [] }
    });
  });

  it("applies through groups, $index of the owner, and bases", async () => {
    const out = await run(`
g = Groups(shift=2, vols=[Vol(pts=[Pt(x=1), Pt(x=2)]), Vol(pts=[Pt(x=3)])]).serialize()
ix = Indexed(elems=[Elem(d=0xaa), Elem(d=0xbb), Elem(d=0xcc)]).serialize()
b = InBase(x=9, blk=Blk(al=4, d=b"\\x11\\x22")).serialize()
print(json.dumps({"g": g.hex(), "g_rt": rt_ok(Groups, g), "ix": ix.hex(), "ix_rt": rt_ok(Indexed, ix),
  "b": b.hex(), "b_rt": rt_ok(InBase, b)}))
`);
    expect(out).toEqual({
      // header 2 + vol 0 (1 + 2) + vol 1 (1 + 1) = 7 bytes; points at 8, 12, 16 (align 4).
      g: "0202" + "02080c" + "0110" + "00" + "01000000" + "02000000" + "03",
      g_rt: true,
      // count + 3 offsets = 4 bytes; d0 align 2 → 4, d1 align 4 → 8, d2 align 6 → 12.
      ix: "0304080c" + "aa000000" + "bb000000" + "cc",
      ix_rt: true,
      // Blk is a base at 1: its header is 2 bytes, d aligned to 4 within the base.
      b: "09" + "0404" + "0000" + "1122",
      b_rt: true
    });
  });

  it("view commits evaluate the layout from the view; editing a field it reads re-lays out", async () => {
    const out = await run(`
data = ByField(align=4, data=b"\\xaa\\xbb").serialize()
v = ByField.view(data)
v.data = b"\\xaa\\xbb\\xcc\\xdd\\xee"
grown = v._commit()
v2 = ByField.view(data)
v2.align = 8
realigned = v2._commit()
g = Groups(shift=1, vols=[Vol(pts=[Pt(x=1)])]).serialize()
gv = Groups.view(g)
gv.vols[0].pts.append(Pt(x=2))
appended = gv._commit()
print(json.dumps({"data": data.hex(), "grown": grown.hex(), "realigned": realigned.hex(),
  "realigned_json": ByField.parse(realigned).to_json(),
  "g": g.hex(), "appended": appended.hex(), "appended_json": Groups.parse(appended).to_json()}))
`);
    expect(out).toEqual({
      data: "04020400aabb",
      // Grown data moves to the end, still aligned to 4.
      grown: "04050800" + "00000000" + "aabbccddee",
      // align 8 no longer fits offset 4: the data moves to 8.
      realigned: "080208" + "0000000000" + "aabb",
      realigned_json: { align: 8, size: 2, offset: 8, data: "aabb" },
      g: "0101" + "0104" + "01",
      // The vol grew to 3 bytes (header 5), so the old point moves to 6 and the new one follows
      // at 8, both still aligned to 1 << shift.
      appended: "0101" + "020608" + "00" + "01" + "00" + "02",
      appended_json: { shift: 1, count: 1, vols: [{ n: 2, pts: [{ x: 1 }, { x: 2 }] }] }
    });
  });
});
