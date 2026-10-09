/**
 * Python views: lazy reads, in-place patches, structural edits, commit policies and
 * patches. Ported from the TS target's views tests (same schema, same expected bytes).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { HAVE_PYTHON, PRELUDE, generate, program, py, type Generated } from "./harness.ts";

const PACKED = `
export struct Archive {
  @padUntil(0x80) {
    char tag[4] = "ARCV"
    u32  count
  }
  Entry entries[count]
}
struct Entry {
  u16 handler
  u16 kind
  u32 align
  u64 offset
  u32 size
  u32 reserved = 0
  u8  data[size] at offset @align(align)
}
`;

let gen: Generated;

/** Runs a script with the Archive module and a `sample()` file of four entries. */
async function run(body: string): Promise<unknown> {
  return py(
    gen,
    `${PRELUDE}
from ${gen.pkg}.schema import Archive, Entry
def sample():
    return Archive(entries=[
        Entry(handler=0, kind=0, align=0x100, data=bytes([1]) * 0x180),
        Entry(handler=0, kind=1, align=0x100, data=bytes([2]) * 0x40),
        Entry(handler=0, kind=1, align=0x100, data=bytes([3]) * 0x100),
        Entry(handler=0, kind=1, align=0x100, data=b""),
    ]).serialize()
def patches(ps):
    return [[p.at, p.remove, len(p.insert)] for p in ps]
${body}
`
  );
}

describe.skipIf(!HAVE_PYTHON)("Python views", () => {
  beforeAll(() => {
    gen = generate("views_packed", program(PACKED));
  });

  it("reads fields lazily and equals the parse result", async () => {
    const out = await run(`
data = sample()
v = Archive.view(data)
p = Archive.parse(data)
print(json.dumps({
  "count": v.count, "tag": v.tag, "n": len(v.entries), "size1": v.entries[1].size,
  "offset1": v.entries[1].offset, "byte": v.entries[2].data[0],
  "plain": v._plain()["entries"][2]["data"] == p.entries[2].data and v._plain()["count"] == 4,
  "json": Archive.to_json(v) == p.to_json(),
  "off0": v.entries[0]._offset, "sz1": v.entries[1]._size,
  "fields": v.entries[0]._fields(),
  "sizes": [e.size for e in v.entries],
}))
`);
    expect(out).toEqual({
      count: 4,
      tag: "ARCV",
      n: 4,
      size1: 0x40,
      offset1: 0x300,
      byte: 3,
      plain: true,
      json: true,
      off0: 0x80,
      sz1: 0x18,
      fields: ["handler", "kind", "align", "offset", "size", "reserved", "data"],
      sizes: [0x180, 0x40, 0x100, 0]
    });
  });

  it("errors carry the path of the field being read", async () => {
    const out = await run(`
bad = bytearray(sample())
bad[0x80 + 0x18 + 0x14] = 7   # reserved of entry 1
v = Archive.view(bytes(bad))
first = v.entries[0].size
print(json.dumps({"first": first, "err": err(lambda: v.entries[1].size)}))
`);
    expect(out).toEqual({ first: 0x180, err: { code: "CHECK", path: ["entries", 1, "reserved"] } });
  });

  it("same-size scalar edits are patched in place", async () => {
    const out = await run(`
data = sample()
v = Archive.view(data)
v.entries[2].handler = 0x200
v.entries[0].kind = 7
after = v.entries[2].handler
ps = patches(v._patches())
committed = v._commit()
p = Archive.parse(committed)
print(json.dumps({"after": after, "ps": ps, "same_len": len(committed) == len(data),
  "unchanged": data == sample(), "h": p.entries[2].handler, "k": p.entries[0].kind,
  "rebound": v.entries[2].handler, "none": patches(v._patches())}))
`);
    expect(out).toEqual({
      after: 0x200,
      ps: [
        [0x80 + 2, 2, 2],
        [0x80 + 2 * 0x18, 2, 2]
      ],
      same_len: true,
      unchanged: true,
      h: 0x200,
      k: 7,
      rebound: 0x200,
      none: []
    });
  });

  it("a structural scalar re-encodes but keeps data where it still fits", async () => {
    const out = await run(`
v = Archive.view(sample())
v.entries[2].align = 0x200
ps = patches(v._patches())
v.entries[1].align = 0x200
p = Archive.parse(v._commit())
print(json.dumps({"ps": ps, "o2": p.entries[2].offset, "o1": p.entries[1].offset}))
`);
    expect(out).toEqual({ ps: [[0x80 + 2 * 0x18 + 5, 1, 1]], o2: 0x400, o1: 0x600 });
  });

  it("rejects derived fields and bad values", async () => {
    const out = await run(`
v = Archive.view(sample())
def set_size(): v.entries[0].size = 5
def set_align(): v.entries[0].align = 2 ** 32
print(json.dumps({"derived": err(set_size), "range": err(set_align)}))
`);
    expect(out).toEqual({
      derived: { code: "INPUT", path: ["entries", 0, "size"] },
      range: { code: "RANGE", path: ["entries", 0, "align"] }
    });
  });

  it("append: the table grows into padding, existing data stays, new data is appended", async () => {
    const out = await run(`
data = sample()
v = Archive.view(data)
v.entries.append(Entry(handler=0, kind=1, align=0x100, data=bytes([9, 9, 9])))
n = len(v.entries)
committed = v._commit()
p = Archive.parse(committed)
print(json.dumps({"n": n, "count": p.count, "offsets": [e.offset for e in p.entries],
  "last": list(p.entries[4].data), "kept": committed[0x100:0x500] == data[0x100:0x500]}))
`);
    expect(out).toEqual({
      n: 5,
      count: 5,
      offsets: [0x100, 0x300, 0x400, 0x500, 0x500],
      last: [9, 9, 9],
      kept: true
    });
  });

  it("growing a target appends it by default; splice shifts what follows; error rejects", async () => {
    const out = await run(`
data = sample()
v = Archive.view(data)
v.entries[1].data = bytes([8]) * 0x50
out = rt.apply_patches(data, v._patches())
p = Archive.parse(out)
v2 = Archive.view(data)
v2.entries[1].data = bytes([8]) * 0x150
p2 = Archive.parse(v2._commit(grow="splice"))
v3 = Archive.view(data)
v3.entries[1].data = bytes(0x150)
print(json.dumps({"o1": p.entries[1].offset, "o2": p.entries[2].offset, "d": list(p.entries[1].data[:2]),
  "splice": [e.offset for e in p2.entries], "error": err(lambda: v3._commit(grow="error"))}))
`);
    expect(out).toEqual({
      o1: 0x500,
      o2: 0x400,
      d: [8, 8],
      splice: [0x100, 0x300, 0x500, 0x600],
      error: { code: "DERIVE", path: [] }
    });
  });

  it("removing elements, _set and replacing a whole element", async () => {
    const out = await run(`
v = Archive.view(sample())
del v.entries[1]
p = Archive.parse(v._commit())
w = Archive.view(sample())
w.entries[0]._set(handler=3, kind=4)
w.entries[3] = Entry(handler=1, kind=1, align=0x10, data=bytes([1, 2]))
q = Archive.parse(w._commit())
print(json.dumps({"count": p.count, "sizes": [e.size for e in p.entries],
  "e0": [q.entries[0].handler, q.entries[0].kind], "e3": [q.entries[3].handler, q.entries[3].align, q.entries[3].size]}))
`);
    expect(out).toEqual({
      count: 3,
      sizes: [0x180, 0x100, 0],
      e0: [3, 4],
      e3: [1, 0x10, 2]
    });
  });

  it("views over a writable file source write the commit back", async () => {
    const out = await run(`
import os, tempfile
class Src:
    def __init__(self, b): self.b = bytearray(b)
    @property
    def size(self): return len(self.b)
    def read(self, off, n): return bytes(self.b[off:off + n])
    def write(self, off, data):
        self.b[off:off + len(data)] = data
    def truncate(self, n): del self.b[n:]
src = Src(sample())
v = Archive.view(src)
v.entries[2].handler = 5
v._commit()
grown = Archive.view(src)
grown.entries[3].data = b"xyz"
grown._commit()
p = Archive.parse(bytes(src.b))
print(json.dumps({"h": p.entries[2].handler, "d": p.entries[3].data.hex(), "n": len(src.b)}))
`);
    expect(out).toEqual({ h: 5, d: "78797a", n: 0x503 });
  });
});
