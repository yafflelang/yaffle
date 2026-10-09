/**
 * Efficient Python views: `from arr[*].field` streams decode only the pieces a read touches
 * (offsets map to pieces through the pieces' size fields), `@ranged` codec regions decode only
 * the touched blocks, and in-place edits inside streams are committed.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { HAVE_PYTHON, PRELUDE, REPO, generate, program, py, type Generated } from "./harness.ts";

const SCHEMA = `
extern codec xor(u8 key) @ranged
extern codec rle

struct Body { u32 a  u8 mid[600]  u32 z }
struct Frag { u16 exp  u16 comp  u8 data[] @size(exp) @via(rle) @size(comp) }
export struct Frags {
  u8   count
  Frag frags[count]
  Body body from frags[*].data
}

struct Plain { u16 n  u8 data[n] }
export struct Plains {
  u8    count
  Plain parts[count]
  Body  body from parts[*].data
}

struct Big { u32 a  u8 pad[20000]  u32 z }
export struct Sealed {
  u32 n
  Big body @via(xor(0x20)) @size(n)
}
export struct SealedRaw {
  u32 n
  u8  raw[n] @via(xor(0x20))
  Big big from raw
}
`;

let gen: Generated;

async function run(body: string): Promise<unknown> {
  return py(
    gen,
    `${PRELUDE}
from ${gen.pkg}.schema import *
from yaffle_runtime.view import node_of
def store_of(v): return node_of(v).space.store
def frags(cls, frag, arr, sizes, size="exp"):
    body = Body(a=1, mid=bytes(range(200)) * 3, z=0x77)
    return cls(**{arr: [frag(**{size: n, "data": b""}) for n in sizes], "body": body}).serialize()
${body}
`
  );
}

describe.skipIf(!HAVE_PYTHON)("Python lazy views", () => {
  beforeAll(() => {
    gen = generate("views_lazy", program(SCHEMA), {
      externs: {
        xor: join(REPO, "conformance/externs/python/xor.py"),
        rle: join(REPO, "conformance/externs/python/rle.py")
      }
    });
  });

  it("a joined stream decodes only the pieces a read touches", async () => {
    const out = await run(`
data = frags(Frags, Frag, "frags", [100, 100, 100, 100, 100, 108])
v = Frags.view(data)
a = v.body.a
st = store_of(v.body)
first = st.decodes
z = v.body.z
last = st.decodes
mid = v.body.mid[250]
p = Frags.parse(data)
print(json.dumps({"a": a, "first": first, "z": z, "last": last, "mid": mid,
  "json": Frags.to_json(v) == p.to_json(), "size": st.size}))
`);
    // Scanning Body reads its scalars a (piece 0) and z (piece 5); mid stays lazy.
    expect(out).toEqual({
      a: 1,
      first: 2,
      z: 0x77,
      last: 2,
      mid: 250 % 200,
      json: true,
      size: 608
    });
  });

  it("piece lengths from plain counts", async () => {
    const out = await run(`
data = frags(Plains, Plain, "parts", [150, 150, 150, 158], "n")
v = Plains.view(data)
z = v.body.z
print(json.dumps({"z": z, "decodes": store_of(v.body).decodes}))
`);
    expect(out).toEqual({ z: 0x77, decodes: 2 }); // pieces 0 and 3 (a and z), not 1 and 2
  });

  it("in-place edits inside streams are committed", async () => {
    const out = await run(`
data = frags(Frags, Frag, "frags", [300, 308])
v = Frags.view(data)
v.body.z = 0x99
v.body.a = 5
committed = v._commit()
p = Frags.parse(committed)
print(json.dumps({"z": p.body.z, "a": p.body.a, "exps": [f.exp for f in p.frags]}))
`);
    expect(out).toEqual({ z: 0x99, a: 5, exps: [300, 308] });
  });

  it("ranged codec regions decode only the touched blocks", async () => {
    const out = await run(`
data = Sealed(body=Big(a=1, pad=bytes(20000), z=0x1234)).serialize()
v = Sealed.view(data)
z = v.body.z
st = store_of(v.body)
decoded = st.bytes_decoded
v.body.z = 0x4321
p = Sealed.parse(v._commit())
raw = SealedRaw(raw=b"", big=Big(a=2, pad=bytes(20000), z=0x55)).serialize()
w = SealedRaw.view(raw)
wz = w.big.z
print(json.dumps({"z": z, "decoded": decoded, "after": p.body.z,
  "wz": wz, "wdecoded": node_of(w.big).space.store.parent.store.bytes_decoded}))
`);
    // Big is 20008 bytes (5 blocks of 4 KiB); its scan reads a (block 0) and z (block 4).
    const two = 0x1000 + (20008 - 4 * 0x1000);
    expect(out).toEqual({ z: 0x1234, decoded: two, after: 0x4321, wz: 0x55, wdecoded: two });
  });

  it("errors inside stream pieces have the piece's path, as in parse mode", async () => {
    const out = await run(`
data = bytearray(frags(Frags, Frag, "frags", [300, 308]))
# piece 1 claims more decoded bytes than its rle data holds
at = 1 + 4 + int.from_bytes(data[3:5], "little")
data[at] = (data[at] + 1) & 0xff
def view_read(): Frags.to_json(Frags.view(bytes(data)))
print(json.dumps({"parse": err(lambda: Frags.parse(bytes(data))), "view": err(view_read)}))
`);
    expect(out).toEqual({
      parse: { code: "CODEC", path: ["frags", 1, "data"] },
      view: { code: "CODEC", path: ["frags", 1, "data"] }
    });
  });
});
