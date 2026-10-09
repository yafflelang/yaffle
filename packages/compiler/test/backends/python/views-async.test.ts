/**
 * Python views over sources read on demand: sync sources without a memory map (block cache),
 * async sources and async codecs (async views: awaitable chains, `_set`, `_commit`), and
 * copy-on-write patches of memory-mapped files.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { HAVE_PYTHON, PRELUDE, REPO, generate, program, py, type Generated } from "./harness.ts";
import { cacheDir } from "../../../src/backends/python/python.ts";

const PACKED = `
extern async codec axor(u8 key)
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
struct Inner { u8 a  u16 b  u8 tail[] }
export struct Sealed {
  u32   n
  Inner body @via(axor(0x5a)) @size(n)
  u8    after
}
`;

let gen: Generated;

/** Python helpers: counting sync and async sources over a bytearray. */
const SOURCES = `
class SyncSrc:
    def __init__(self, b): self.b = bytearray(b); self.reads = []
    @property
    def size(self): return len(self.b)
    def read(self, off, n):
        self.reads.append((off, n)); return bytes(self.b[off:off + n])
    def write(self, off, data):
        if off + len(data) > len(self.b): self.b.extend(bytes(off + len(data) - len(self.b)))
        self.b[off:off + len(data)] = data
    def truncate(self, n): del self.b[n:]
class AsyncSrc(SyncSrc):
    async def read(self, off, n):
        await asyncio.sleep(0)
        self.reads.append((off, n)); return bytes(self.b[off:off + n])
    async def write(self, off, data):
        await asyncio.sleep(0)
        SyncSrc.write(self, off, data)
def big():
    # 4 entries of 1 MiB each: a 4 MiB file.
    return Archive(entries=[
        Entry(handler=i, kind=1, align=0x100, data=bytes([i + 1]) * 0x100000) for i in range(4)
    ]).serialize()
def total(src): return sum(n for _, n in src.reads)
`;

async function run(body: string): Promise<unknown> {
  return py(
    gen,
    `${PRELUDE}
from ${gen.pkg}.schema import Archive, Entry, Sealed, Inner
${SOURCES}
${body}
`
  );
}

describe.skipIf(!HAVE_PYTHON)("Python views over on-demand sources", () => {
  beforeAll(() => {
    gen = generate("views_async", program(PACKED), {
      externs: { axor: join(REPO, "conformance/externs/python/axor.py") }
    });
  });

  it("a sync source without a memory map is read in blocks, never as a whole", async () => {
    const out = await run(`
data = big()
src = SyncSrc(data)
v = Archive.view(src)
first = [v.count, v.entries[3].handler, v.entries[3].size]
read_small = total(src)
b = v.entries[2].data[0x80000]
read_one = total(src)
v.entries[1].handler = 9          # in place: patched in the block cache
same = v.entries[1].handler
out = v._commit()                 # written back to the source (it has write)
p = Archive.parse(bytes(src.b))
print(json.dumps({"first": first, "small": read_small <= 0x10000, "one": read_one - read_small <= 0x100000,  # just that field
  "b": b, "same": same, "h": p.entries[1].handler, "len": len(out) == len(data),
  "untouched": p.entries[2].data == bytes([3]) * 0x100000}))
`);
    expect(out).toEqual({
      first: [4, 3, 0x100000],
      small: true,
      one: true,
      b: 3,
      same: 9,
      h: 9,
      len: true,
      untouched: true
    });
  });

  it("the block cache drops least recently used blocks", async () => {
    const out = await run(`
data = big()
src = SyncSrc(data)
v = Archive.view(src, )
store = rt.view.node_of(v).space.store
store.max_units = 4
sums = [v.entries[i].data[k * 0x10000] for i in range(4) for k in range(0, 16, 4)]
again = v.entries[0].data[0]
print(json.dumps({"loaded": len(store.lru) <= 5, "sums": sums[:4], "again": again}))
`);
    expect(out).toEqual({ loaded: true, sums: [1, 1, 1, 1], again: 1 });
  });

  it("async sources give async views: awaitable chains, _set and _commit write back", async () => {
    const out = await run(`
async def main():
    data = big()
    src = AsyncSrc(data)
    av = Archive.view(src)
    n = await av.count
    h = await av.entries[3].handler
    e = await av.entries[2]
    small = total(src)
    ln = await av.entries._len()
    off = await av.entries[1]._offset()
    await av.entries[1]._set(handler=0x55, kind=7)
    patches = await av._commit()
    after = await av.entries[1].handler
    p = Archive.parse(bytes(src.b))
    # structural: the data grows, so it is appended
    await av.entries[0]._set(data=bytes([0xee]) * 0x100010)
    await av._commit()
    q = Archive.parse(bytes(src.b))
    return {"n": n, "h": h, "e": [e["handler"], e["size"], len(e["data"])], "small": small <= 0x30000,
            "ln": ln, "off": off, "patches": [[x.at, x.remove, len(x.insert)] for x in patches],
            "after": after, "p": [p.entries[1].handler, p.entries[1].kind],
            "q": [q.entries[0].size, q.entries[0].data[:1].hex(), q.entries[1].handler]}
print(json.dumps(asyncio.run(main())))
`);
    expect(out).toEqual({
      n: 4,
      h: 3,
      e: [2, 0x100000, 0x100000],
      small: false,
      ln: 4,
      off: 0x80 + 0x18,
      patches: [[0x80 + 0x18, 4, 4]],
      after: 0x55,
      p: [0x55, 7],
      q: [0x100010, "ee", 0x55]
    });
  });

  it("async views read only what a chain touches", async () => {
    const out = await run(`
async def main():
    src = AsyncSrc(big())
    av = Archive.view(src)
    h = await av.entries[3].handler
    s = await av.entries[3].size
    return {"h": h, "s": s, "read": total(src)}
print(json.dumps(asyncio.run(main())))
`);
    expect(out).toEqual({ h: 3, s: 0x100000, read: 0x10000 });
  });

  it("async codecs: async roots get async views over any source", async () => {
    const out = await run(`
async def main():
    data = Sealed(body=Inner(a=1, b=0x203, tail=b"xyz"), after=9)
    raw = await data.serialize_async()
    av = Sealed.view(raw)
    a = await av.body.a
    j = await av._to_json()
    await av.body._set(b=0x405)        # inside a codec region: re-encoded on commit
    patches = await av._commit()
    out = await av._bytes()
    back = await Sealed.parse_async(out)
    src = AsyncSrc(raw)
    av2 = Sealed.view_async(src)
    t = await av2.body.tail
    has_sync = hasattr(Sealed, "parse")
    return {"a": a, "j": j, "b": back.body.b, "after": back.after, "n": len(patches) > 0,
            "t": t.hex(), "sync": has_sync}
print(json.dumps(asyncio.run(main())))
`);
    expect(out).toEqual({
      a: 1,
      j: { n: 6, body: { a: 1, b: 0x203, tail: "78797a" }, after: 9 },
      b: 0x405,
      after: 9,
      n: true,
      t: "78797a",
      sync: false
    });
  });

  it("file sources: in-place patches copy only the pages they touch", async () => {
    const file = join(cacheDir(), "tests", "views_async", "big.bin");
    const out = await run(`
data = big()
open(${JSON.stringify(file)}, "wb").write(data)
src = rt.file_source(${JSON.stringify(file)})
v = Archive.view(src)
v.entries[3].handler = 0x77
space = rt.view.node_of(v).space
cow = type(space.data).__name__
out = v._commit()
p = Archive.parse(out)
unchanged = open(${JSON.stringify(file)}, "rb").read() == data
src.close()
print(json.dumps({"cow": cow, "h": p.entries[3].handler, "unchanged": unchanged}))
`);
    expect(out).toEqual({ cow: "mmap", h: 0x77, unchanged: true });
  });

  it("errors raised through async views carry the path", async () => {
    const out = await run(`
async def main():
    bad = bytearray(big())
    bad[0x80 + 0x18 * 2 + 0x14] = 1     # reserved of entry 2
    av = Archive.view(AsyncSrc(bytes(bad)))
    try:
        await av.entries[2].reserved
    except rt.YaffleError as e:
        return {"code": e.code, "path": e.path}
print(json.dumps(asyncio.run(main())))
`);
    expect(out).toEqual({ code: "CHECK", path: ["entries", 2, "reserved"] });
  });
});
