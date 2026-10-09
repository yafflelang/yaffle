/**
 * C++ backend views: lazy reads, in-place patches, structural edits and commit policies,
 * checked from a C++ main (the same expectations as the Go and TS view tests).
 */
import { describe, expect, it } from "vitest";
import { PRELUDE, build, toolchain } from "./harness.ts";

const PACKED = `
export struct Archive {
  @padUntil(0x10) {
    char tag[4] = "ARCV"
    u32  count
  }
  Entry entries[count]
}

export struct Entry {
  u16 handler
  u16 kind
  u32 align where it % 4 == 0
  u32 offset
  u32 size
  u8  data[size] at offset
  layout { data @align(0x10) }
}

struct Body { u8 a  u8 b }
export struct Crc { u32 crc = crc32(body)  Body body }

struct Node {
  u8    v
  Node *next : u8 @nullable
}
export struct List { u8 n  Node *first : u8 }
`;

const MAIN = `${PRELUDE}
static Entry entry(std::uint16_t kind, std::uint32_t align, yaffle::Bytes data) {
  Entry e;
  e.kind = kind;
  e.align = align;
  e.data = std::move(data);
  return e;
}
static yaffle::Bytes sample() {
  Archive pf;
  pf.entries.push_back(entry(0, 4, yaffle::Bytes(20, 1)));
  pf.entries.push_back(entry(1, 8, yaffle::Bytes(4, 2)));
  pf.entries.push_back(entry(1, 16, yaffle::Bytes(8, 3)));
  return Archive::serialize(pf);
}
static std::string js(const Archive& v) { return Archive::to_json(v).dump(); }

int main(int argc, char** argv) {
  std::string what = argc > 1 ? argv[1] : "";
  const yaffle::Bytes s = sample();
  if (what == "read") {
    auto v = Archive::view(s);
    std::printf("%u %s\\n", v.count(), v.tag().c_str());
    auto es = v.entries_views();
    std::printf("%zu %u %u %lld\\n", es.size(), es[1].size(), es[1].offset_(), (long long)es[1].offset());
    std::printf("%s\\n", yaffle::to_hex(es[2].data()).c_str());
    std::printf("%d\\n", js(v.materialize()) == js(Archive::parse(s)));
    // A broken target only fails when it is read.
    yaffle::Bytes bad = s;
    bad[0x28] = 0xf0;  // entries[1].offset
    std::printf("%s\\n", err([&] { Archive::parse(bad); }).c_str());
    auto bv = Archive::view(bad);
    auto be = bv.entries_views();
    std::printf("%u %u\\n", be[1].size(), be[0].data()[0]);
    std::printf("%s\\n", err([&] { be[1].data(); }).c_str());
    std::printf("%s\\n", err([&] { bv.materialize(); }).c_str());
  } else if (what == "inplace") {
    auto v = Archive::view(s);
    auto es = v.entries_views();
    es[1].set_align(0x200);
    std::printf("%u %d\\n", es[1].align(), v.materialized());
    for (const auto& p : v.patches())
      std::printf("%lld %lld %s\\n", (long long)p.at, (long long)p.remove, yaffle::to_hex(p.insert).c_str());
    std::printf("%s\\n", err([&] { es[1].set_align(3); }).c_str());
    yaffle::Bytes out = v.commit();
    Archive p = Archive::parse(out);
    std::printf("%d %u %u\\n", out.size() == s.size(), p.entries[1].align, p.entries[0].align);
    // After a commit the views read the new bytes.
    std::printf("%u\\n", v.entries_views()[1].align());
  } else if (what == "structural") {
    std::printf("%zu\\n", s.size());
    for (auto [name, g] : {std::pair{"default", yaffle::Grow::Default}, std::pair{"splice", yaffle::Grow::Splice},
                           std::pair{"append", yaffle::Grow::Append}, std::pair{"error", yaffle::Grow::Error}}) {
      auto v = Archive::view(s);
      v.entries_views()[1].set_data(yaffle::Bytes(12, 9));
      try {
        yaffle::Bytes out = v.commit(g);
        Archive p = Archive::parse(out);
        std::printf("%s %zu %u %u %u %u %u\\n", name, out.size(), p.entries[0].offset, p.entries[1].offset,
                    p.entries[2].offset, p.entries[1].data[0], p.entries[2].data[0]);
      } catch (const yaffle::Error& e) {
        std::printf("%s %s\\n", name, yaffle::code_name(e.code));
      }
    }
    // Replacing a whole array through its setter.
    auto v = Archive::view(s);
    std::vector<Entry> es = v.entries();
    es.push_back(entry(2, 4, yaffle::Bytes{7}));
    v.set_entries(es);
    yaffle::Bytes out = v.commit();
    Archive p = Archive::parse(out);
    std::printf("%u %s %u\\n", p.count, yaffle::to_hex(p.entries[3].data).c_str(), p.entries[0].offset);
    // A shrinking edit with splice: what follows moves back.
    auto w = Archive::view(s);
    w.entries_views()[0].set_data(yaffle::Bytes(4, 1));
    out = w.commit(yaffle::Grow::Splice);
    p = Archive::parse(out);
    std::printf("shrink %zu %u %u %u\\n", out.size(), p.entries[0].offset, p.entries[1].offset, p.entries[2].offset);
    std::printf("%d\\n", yaffle::apply_patches(s, Archive::view(s).patches()) == s);
  } else if (what == "crc") {
    Crc c;
    c.body = Body{1, 2};
    yaffle::Bytes data = Crc::serialize(c);
    auto v = Crc::view(data);
    v.body_view().set_a(5);
    yaffle::Bytes out = v.commit();
    c.body.a = 5;
    std::printf("%s %d\\n", yaffle::to_hex(out).c_str(), out == Crc::serialize(c));
  } else if (what == "pointers") {
    yaffle::Bytes data = hex("07 02 01 04 02 00");
    auto l = List::view(data);
    auto first = l.first_view();
    auto second = first.next_view();
    std::printf("%u %u %d\\n", first.v(), second->v(), !second->next_view().has_value());
    second->set_v(9);
    std::printf("%s\\n", yaffle::to_hex(l.commit()).c_str());
  }
  return failures ? 1 : 0;
}
`;

describe.skipIf(!toolchain)("C++ views", () => {
  let built: Awaited<ReturnType<typeof build>> | undefined;
  const run = async (what: string): Promise<string[]> => {
    built ??= await build("views", PACKED, MAIN);
    const r = await built.run([what]);
    if (r.code !== 0) throw new Error(`exit ${r.code}\n${r.stdout}\n${r.stderr}`);
    return r.stdout.trim().split("\n");
  };

  it("reads fields lazily and agrees with parse", { timeout: 600_000 }, async () => {
    expect(await run("read")).toEqual([
      "3 ARCV",
      "3 4 96 32",
      "0303030303030303",
      "1",
      "EOF entries[1].data",
      "4 1",
      "EOF entries[1].data",
      "EOF entries[1].data"
    ]);
  });

  it("patches same-size scalars in place", { timeout: 600_000 }, async () => {
    expect(await run("inplace")).toEqual([
      "512 0",
      "36 4 00020000",
      "CHECK entries[1].align",
      "1 512 4",
      "512"
    ]);
  });

  it("commits structural edits with a sticky layout", { timeout: 600_000 }, async () => {
    const lines = await run("structural");
    // header 0x10 + 3 * 16 = 0x40 inline; data at 0x40 (20 bytes), 0x60 (4), 0x70 (8): 0x78 total.
    expect(lines[0]).toBe("120");
    expect(lines[1]).toBe("default 140 64 128 112 9 3"); // the grown target moves to the end
    expect(lines[2]).toBe("splice 120 64 96 112 9 3"); // what follows shifts (here: into the gap)
    expect(lines[3]).toBe("append 140 64 128 112 9 3");
    expect(lines[4]).toBe("error DERIVE");
    // The new array holds copies, so every target is placed as new (after the original end).
    expect(lines[5]).toBe("4 07 128");
    expect(lines[6]).toBe("shrink 104 64 80 96");
    expect(lines[7]).toBe("1");
  });

  it("recomputes checksums over edited children", { timeout: 600_000 }, async () => {
    expect(await run("crc")).toEqual([expect.stringMatching(/^[0-9a-f]{8}0502 1$/)]);
  });

  it("opens views of pointer targets", { timeout: 600_000 }, async () => {
    expect(await run("pointers")).toEqual(["1 2 1", "070201040900"]);
  });
});
