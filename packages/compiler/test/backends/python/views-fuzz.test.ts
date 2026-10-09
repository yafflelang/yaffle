/**
 * Property test for Python views and surgical writes: random edits on a view, then `_commit`,
 * then re-parse, compared with the same edits applied to plain dataclasses and serialized from
 * scratch (a port of the TS target's views-fuzz test).
 */
import { describe, expect, it } from "vitest";
import { HAVE_PYTHON, PRELUDE, generate, program, py } from "./harness.ts";

const DOC = `
type ACstr = str @align(4)
struct Item {
  u16 id
  u8  n
  u16 tags[n]
  str name
}
export struct Doc {
  u32   magic = 0xd0c
  u16   version
  u8    count
  Item  items[count]
  u32   nblob
  u8    blob[nblob]
  Item  *extra : u32 @nullable
  ACstr *note : u16
  u16   tail[3]
}
`;

const SCRIPT = `
import copy, random
from {pkg}.schema import Doc, Item

def random_item(r):
    return Item(id=r.randrange(65536), tags=[r.randrange(65536) for _ in range(r.randrange(4))],
                name="n" + "x" * r.randrange(6))

def random_doc(r):
    return Doc(version=r.randrange(65536), items=[random_item(r) for _ in range(1 + r.randrange(4))],
               blob=bytes(r.randrange(256) for _ in range(r.randrange(20))),
               extra=None if r.random() < 0.5 else random_item(r),
               note="note" + "!" * r.randrange(5), tail=[1, 2, 3])

def edit(r, v, p):
    k = r.randrange(11)
    i = r.randrange(len(p.items)) if p.items else 0
    if k == 0:
        x = r.randrange(65536); v.version = x; p.version = x; return f"version={x}"
    if k == 1:
        if not p.items: return "noop"
        x = r.randrange(65536); v.items[i].id = x; p.items[i].id = x; return f"items[{i}].id={x}"
    if k == 2:
        it = random_item(r); v.items.append(copy.deepcopy(it)); p.items.append(it); return "append"
    if k == 3:
        if len(p.items) <= 1: return "noop"
        del v.items[i]; del p.items[i]; return f"del {i}"
    if k == 4:
        if not p.items: return "noop"
        name = "renamed" + "y" * r.randrange(4); v.items[i].name = name; p.items[i].name = name
        return f"items[{i}].name"
    if k == 5:
        if not p.items: return "noop"
        tags = [r.randrange(65536) for _ in range(r.randrange(5))]
        v.items[i].tags = list(tags); p.items[i].tags = tags; return f"items[{i}].tags"
    if k == 6:
        b = bytes(r.randrange(256) for _ in range(r.randrange(30))); v.blob = b; p.blob = b
        return f"blob({len(b)})"
    if k == 7:
        it = None if r.random() < 0.3 else random_item(r)
        v.extra = copy.deepcopy(it); p.extra = it; return f"extra={'item' if it else 'None'}"
    if k == 8:
        j = r.randrange(3); x = r.randrange(65536); v.tail[j] = x; p.tail[j] = x
        return f"tail[{j}]={x}"
    if k == 9:
        note = "n" + "z" * r.randrange(9); v.note = note; p.note = note; return "note"
    if not p.items or not p.items[i].tags: return "noop"
    x = r.randrange(65536); v.items[i].tags[0] = x; p.items[i].tags[0] = x
    return f"items[{i}].tags[0]={x}"

failures = []
policies = ["default", "append", "splice"]
for seed in range(1, 201):
    r = random.Random(seed)
    plain_doc = random_doc(r)
    data = plain_doc.serialize()
    v = Doc.view(data)
    log = []
    try:
        for rnd in range(3):
            for _ in range(1 + r.randrange(5)):
                log.append(edit(r, v, plain_doc))
            policy = r.choice(policies)
            patches = v._patches(grow=policy)
            committed = v._commit(grow=policy)
            if rt.apply_patches(data, patches) != committed:
                failures.append([seed, "patches", log]); break
            got = Doc.parse(committed).to_json()
            want = Doc.parse(plain_doc.serialize()).to_json()
            if got != want:
                failures.append([seed, policy, log, got, want]); break
            if Doc.to_json(v) != want:
                failures.append([seed, "view json", log]); break
            data = committed
    except Exception as e:
        failures.append([seed, "exception", log, repr(e)])
print(json.dumps(failures[:5]))
`;

describe.skipIf(!HAVE_PYTHON)("Python views: random edits match plain objects", () => {
  it("200 seeds × 3 rounds of edits and commits", async () => {
    const gen = generate("views_fuzz", program(DOC));
    const out = await py(gen, PRELUDE + SCRIPT.replace("{pkg}", gen.pkg));
    expect(out).toEqual([]);
  }, 300_000);
});
