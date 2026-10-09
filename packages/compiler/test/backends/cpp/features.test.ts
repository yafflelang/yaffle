/**
 * C++ backend: alignment origins and offsets, strict padding, virtual fields, derived arrays and
 * composite equality, per-element layout groups, writable stream slices (docs/IR.md §2.4, §3.7, §4.3, §6).
 */
import { describe, expect, it } from "vitest";
import { PRELUDE, build, toolchain } from "./harness.ts";

const SCHEMA = `
// alignment origin and offset
export struct A { u8 a  u8 b @align(4, offset: 1) }
struct In @base { u8 x  u8 y @align(4, from: file) }
export struct Out { u16 p  In inner  u8 q }
struct InB @base { u8 x  u8 y @align(4) }
export struct OutB { u16 p  InB inner }
struct T { u8 x  u8 y @align(8, from: file) }
export struct R { T *t : u8  u8 z }
struct B @base @alignEnd(4, offset: 1) { u8 x }
export struct W { B b  u8 z }
struct Leaf { u8 v }
export struct L2 {
  Leaf *a : u8
  layout { a @align(4, offset: 2) }
}

// strict padding
export struct P {
  u8  a @padAfter(3, strict)
  u16 b @padUntil(4, strict)
  u8  c @padAfter(1)
}

// virtual fields
export struct V {
  u8  hi
  u32 lo
  virtual u40 size = (hi << 32) | lo
  u8  after
}

// derived arrays and composite equality
export struct D {
  u8 n
  u8 vals[n]
  u8 m
  u8 idx[m] = indicesWhere(vals, v => v > 5)
  u16 twice = sum(map(vals, v => v * 2))
  u8 uniq = unique(concat(vals, vals)).length
  u8 big = filter(vals, v => v > 5).length
}
struct Key { u8 k  u8 val }
export struct Sorted {
  u8 n
  Key keys[n] where it == sortedBy(it, x => x.k)
}

// per-element layout groups
struct Vol { Leaf *a : u8  Leaf *b : u8 }
export struct Top {
  u8 n
  Vol *vols[n] : u8
  layout { vols[*] { b  a } }
}
struct Vol2 { u8 np  Leaf *pieces[np] : u8  Leaf *portal : u8 }
export struct Cop {
  u8 n
  Vol2 vols[n]
  layout { vols[*] { pieces[*]  portal } }
}

// writable stream slices
struct Hdr { u8 a  u8 b }
struct Ftr { u16 c }
export struct Over {
  u8  raw[4] @hidden
  Hdr hdr  from raw[0..2]
  Ftr foot from raw[2..4]
}
`;

const MAIN = `${PRELUDE}
template <class X>
static std::string js(const X& v) { return X::to_json(v).dump(); }
template <class X>
static std::string ser(const char* json) { return yaffle::to_hex(X::serialize(X::from_json(yaffle::Json::parse(json)))); }
static std::shared_ptr<Leaf> leaf(std::uint8_t v) { auto l = std::make_shared<Leaf>(); l->v = v; return l; }

int main(int argc, char** argv) {
  std::string what = argc > 1 ? argv[1] : "";
  if (what == "align") {
    std::printf("%s\\n", js(A::parse(hex("01 0000 07"))).c_str());
    std::printf("%s\\n", ser<A>(R"({"a":1,"b":7})").c_str());
    std::printf("%s\\n", js(Out::parse(hex("0100 05 00 09 0c"))).c_str());
    std::printf("%s\\n", ser<Out>(R"({"p":1,"inner":{"x":5,"y":9},"q":12})").c_str());
    std::printf("%s\\n", js(OutB::parse(hex("0100 05 000000 09"))).c_str());
    std::string r = ser<R>(R"({"t":{"x":1,"y":2},"z":3})");
    std::printf("%s %s\\n", r.c_str(), js(R::parse(hex(r.c_str()))).c_str());
    std::printf("%s\\n", js(W::parse(hex("07 0000 09"))).c_str());
    std::printf("%s\\n", ser<W>(R"({"b":{"x":7},"z":9})").c_str());
    std::printf("%s\\n", ser<L2>(R"({"a":{"v":5}})").c_str());
    auto v = Out::view(hex("0100 05 00 09 0c"));
    std::printf("%u %u\\n", v.inner_view().y(), v.q());
  } else if (what == "strict") {
    std::printf("%s\\n", js(P::parse(hex("01 000000 0200 0000 03 55"))).c_str());
    std::printf("%s\\n", err([] { P::parse(hex("01 000100 0200 0000 03 00")); }).c_str());
    std::printf("%s\\n", err([] { P::parse(hex("01 000000 0200 0001 03 00")); }).c_str());
    std::printf("%s\\n", ser<P>(R"({"a":1,"b":2,"c":3})").c_str());
    auto v = P::view(hex("01 000100 0200 0000 03 00"));
    std::printf("%s\\n", err([&] { v.a(); }).c_str());
  } else if (what == "virtual") {
    V v = V::parse(hex("01 02000000 09"));
    std::printf("%llu %u %s\\n", (unsigned long long)v.size, v.after, js(v).c_str());
    std::printf("%s\\n", yaffle::to_hex(V::serialize(V::from_json(V::to_json(v)))).c_str());
    std::printf("%s\\n", ser<V>(R"({"size":78187493530,"after":0})").c_str());
    std::printf("%s\\n", err([] { ser<V>(R"({"after":0})"); }).c_str());
    std::printf("%s\\n", err([] { ser<V>(R"({"size":2199023255552,"after":0})"); }).c_str());
    auto view = V::view(hex("01 02000000 09"));
    std::printf("%llu\\n", (unsigned long long)view.size());
    view.set_size(7);
    std::printf("%s\\n", yaffle::to_hex(view.commit()).c_str());
  } else if (what == "arrays") {
    std::string d = ser<D>(R"({"vals":"0109020a0109"})");
    std::printf("%s\\n", d.c_str());
    std::printf("%s\\n", js(D::parse(hex(d.c_str()))).c_str());
    std::printf("%s\\n", ser<Sorted>(R"({"keys":[{"k":1,"val":9},{"k":1,"val":2},{"k":3,"val":0}]})").c_str());
    std::printf("%s\\n", err([] { ser<Sorted>(R"({"keys":[{"k":3,"val":9},{"k":1,"val":2}]})"); }).c_str());
    std::printf("%s\\n", err([] { Sorted::parse(hex("02 0309 0102")); }).c_str());
    std::printf("%s\\n", js(Sorted::parse(hex("02 0109 0302"))).c_str());
  } else if (what == "groups") {
    Top t;
    auto v0 = std::make_shared<Vol>();
    v0->a = leaf(1);
    v0->b = leaf(2);
    auto v1 = std::make_shared<Vol>();
    v1->a = leaf(3);
    v1->b = leaf(4);
    t.vols = {v0, v1};
    t.n = 2;  // derived on write; set so the parsed value compares equal
    yaffle::Bytes out = Top::serialize(t);
    std::printf("%s %d\\n", yaffle::to_hex(out).c_str(), js(Top::parse(out)) == js(t));
    std::string c = ser<Cop>(R"({"vols":[{"pieces":[{"v":1},{"v":2}],"portal":{"v":3}},{"pieces":[{"v":4}],"portal":{"v":5}}]})");
    std::printf("%s\\n", c.c_str());
    std::printf("%s\\n", js(Cop::parse(hex(c.c_str()))).c_str());
  } else if (what == "slices") {
    std::printf("%s\\n", js(Over::parse(hex("0102 0304"))).c_str());
    std::printf("%s\\n", ser<Over>(R"({"hdr":{"a":1,"b":2},"foot":{"c":1027}})").c_str());
    auto v = Over::view(hex("0102 0304"));
    std::printf("%s %s\\n", js(v.materialize()).c_str(), yaffle::to_hex(v.commit()).c_str());
  }
  return failures ? 1 : 0;
}
`;

describe.skipIf(!toolchain)("C++ layout, padding, virtual fields, derived arrays, slices", () => {
  let built: Awaited<ReturnType<typeof build>> | undefined;
  const run = async (what: string): Promise<string[]> => {
    built ??= await build("features", SCHEMA, MAIN);
    const r = await built.run([what]);
    if (r.code !== 0) throw new Error(`exit ${r.code}\n${r.stdout}\n${r.stderr}`);
    return r.stdout.trim().split("\n");
  };

  it("aligns with origins and offsets", { timeout: 600_000 }, async () => {
    expect(await run("align")).toEqual([
      '{"a":1,"b":7}',
      "01000007",
      '{"p":1,"inner":{"x":5,"y":9},"q":12}',
      "01000500090c",
      '{"p":1,"inner":{"x":5,"y":9}}',
      // A target whose start layout decides: the block is aligned so the file alignment holds.
      "0803" + "000000000000" + "01" + "00000000000000" + "02" + ' {"t":{"x":1,"y":2},"z":3}',
      '{"b":{"x":7},"z":9}',
      "07000009",
      "020005",
      "9 12"
    ]);
  });

  it("checks strict padding layers", { timeout: 600_000 }, async () => {
    expect(await run("strict")).toEqual([
      '{"a":1,"b":2,"c":3}',
      "CHECK a",
      "CHECK b",
      "0100000002000000" + "0300",
      "CHECK a"
    ]);
  });

  it("reads and writes virtual fields", { timeout: 600_000 }, async () => {
    expect(await run("virtual")).toEqual([
      '4294967298 9 {"hi":1,"lo":2,"size":4294967298,"after":9}',
      "010200000009",
      "129a78563400",
      "INPUT size",
      "RANGE size",
      "4294967298",
      "000700000009"
    ]);
  });

  it("computes derived arrays and composite equality", { timeout: 600_000 }, async () => {
    expect(await run("arrays")).toEqual([
      // n=6 vals, m=3 indices (1, 3, 5), twice = 2 * 32, uniq = 4, big = 3
      "06" + "0109020a0109" + "03" + "010305" + "4000" + "04" + "03",
      '{"n":6,"vals":"0109020a0109","m":3,"idx":"010305","twice":64,"uniq":4,"big":3}',
      "03" + "0109" + "0102" + "0300",
      "CHECK keys",
      "CHECK keys",
      '{"n":2,"keys":[{"k":1,"val":9},{"k":3,"val":2}]}'
    ]);
  });

  it("places per-element layout groups", { timeout: 600_000 }, async () => {
    const lines = await run("groups");
    // vol0 @3, its b @5 and a @6; vol1 @7, its b @9 and a @10.
    expect(lines[0]).toBe("02" + "0307" + "0605" + "02" + "01" + "0a09" + "04" + "03" + " 1");
    // Each volume's pieces, then its portal: vol0 pieces 1,2 portal 3; vol1 piece 4 portal 5.
    expect(lines[1]).toBe(
      "02" + "02" + "0809" + "0a" + "01" + "0b" + "0c" + "01" + "02" + "03" + "04" + "05"
    );
    expect(lines[2]).toBe(
      '{"n":2,"vols":[{"np":2,"pieces":[{"v":1},{"v":2}],"portal":{"v":3}},{"np":1,"pieces":[{"v":4}],"portal":{"v":5}}]}'
    );
  });

  it("writes stream slices", { timeout: 600_000 }, async () => {
    expect(await run("slices")).toEqual([
      '{"hdr":{"a":1,"b":2},"foot":{"c":1027}}',
      "01020304",
      '{"hdr":{"a":1,"b":2},"foot":{"c":1027}} 01020304'
    ]);
  });
});
