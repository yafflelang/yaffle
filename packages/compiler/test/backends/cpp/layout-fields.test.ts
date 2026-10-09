/**
 * C++ backend, layout items that read fields (docs/IR.md §4.4): item arguments
 * are evaluated in the write context of the struct owning the layout (fields, parameters,
 * `$index`), through paths, groups and nested bases, in serialize and in view commits. An
 * alignment below 1 is a RANGE error.
 */
import { describe, expect, it } from "vitest";
import { PRELUDE, build, toolchain } from "./harness.ts";

const SCHEMA = `
export struct AlignByField {
  u8 align
  u8 size
  u8 offset
  u8 data[size] at offset
  layout { data @align(align) }
}

export struct Shifted {
  u8 shift
  u8 n
  u8 o
  u8 b[n] at o
  layout { b @align(1 << shift) }
}

struct Leaf { u8 v }

// A pulled-out path aligned by the container's field.
struct Rec { Leaf *body : u8 }
export struct Records {
  u8  align
  u8  count
  Rec recs[count]
  layout { recs[*].body @align(align * 2) }
}

// A per-element group item aligned by the container's field.
struct Vol { Leaf *a : u8  Leaf *b : u8 }
export struct Groups {
  u8  align
  u8  n
  Vol vols[n]
  layout { vols[*] { b @align(align)  a } }
}

// Nested and root bases.
struct Inner @base {
  u8 align
  Leaf *p : u8
  layout { p @align(align) }
}
export struct Outer { u8 tag  Inner inner }
export struct RootBase @base {
  u8 align
  Leaf *p : u8
  layout { p @align(align) }
}

// A parameter and \`$index\`.
struct Item(u8 a) {
  Leaf *p : u8
  layout { p @align(a << $index) }
}
export struct Items { u8 a  u8 n  Item(a) items[n] }

// A constant alignment of 0 is out of range too.
export struct Zero { Leaf *p : u8  layout { p @align(0) } }
`;

const MAIN = `${PRELUDE}
template <class X>
static std::string js(const X& v) { return X::to_json(v).dump(); }
template <class X>
static std::string ser(const char* json) { return yaffle::to_hex(X::serialize(X::from_json(yaffle::Json::parse(json)))); }
template <class X>
static std::string ser_err(const char* json) { return err([&] { ser<X>(json); }); }

int main(int argc, char** argv) {
  std::string what = argc > 1 ? argv[1] : "";
  if (what == "fields") {
    std::printf("%s\\n", ser<AlignByField>(R"({"align":8,"data":"cc"})").c_str());
    std::printf("%s\\n", ser<AlignByField>(R"({"align":1,"data":"ddeeff"})").c_str());
    std::printf("%s\\n", js(AlignByField::parse(hex("04 02 03 aabb"))).c_str());
    std::printf("%s\\n", ser_err<AlignByField>(R"({"align":0,"data":"aa"})").c_str());
    std::printf("%s\\n", ser<Shifted>(R"({"shift":2,"b":"2233"})").c_str());
    std::printf("%s\\n", ser_err<Shifted>(R"({"shift":70,"b":"22"})").c_str());
    std::printf("%s\\n", ser_err<Zero>(R"({"p":{"v":1}})").c_str());
  } else if (what == "paths") {
    std::string r = ser<Records>(R"({"align":2,"recs":[{"body":{"v":1}},{"body":{"v":2}}]})");
    std::printf("%s %s\\n", r.c_str(), js(Records::parse(hex(r.c_str()))).c_str());
    std::string g = ser<Groups>(R"({"align":4,"vols":[{"a":{"v":1},"b":{"v":2}},{"a":{"v":3},"b":{"v":4}}]})");
    std::printf("%s %s\\n", g.c_str(), js(Groups::parse(hex(g.c_str()))).c_str());
    std::printf("%s\\n", ser_err<Records>(R"({"align":0,"recs":[{"body":{"v":1}}]})").c_str());
  } else if (what == "bases") {
    std::printf("%s\\n", ser<Outer>(R"({"tag":1,"inner":{"align":4,"p":{"v":9}}})").c_str());
    std::printf("%s\\n", ser<RootBase>(R"({"align":8,"p":{"v":5}})").c_str());
    std::printf("%s\\n", ser<Items>(R"({"a":2,"items":[{"p":{"v":1}},{"p":{"v":2}}]})").c_str());
    std::printf("%s\\n", ser_err<Outer>(R"({"tag":1,"inner":{"align":0,"p":{"v":9}}})").c_str());
  } else if (what == "views") {
    // Setting a field a layout item reads is structural: the commit re-lays out the target.
    auto v = AlignByField::view(hex("04 02 04 00 aabb"));
    v.set_align(8);
    std::printf("%s\\n", yaffle::to_hex(v.commit()).c_str());
    auto s = AlignByField::view(hex("04 02 04 00 aabb"));
    s.set_align(2);
    std::printf("%s\\n", yaffle::to_hex(s.commit(yaffle::Grow::Splice)).c_str());
    auto z = AlignByField::view(hex("04 02 04 00 aabb"));
    z.set_align(0);
    std::printf("%s\\n", err([&] { z.commit(); }).c_str());
    auto rv = Records::view(hex("02 02 04 08 01 000000 02"));
    rv.set_align(4);
    std::printf("%s\\n", yaffle::to_hex(rv.commit()).c_str());
  }
  return failures ? 1 : 0;
}
`;

describe.skipIf(!toolchain)("C++ layout items that read fields", () => {
  let built: Awaited<ReturnType<typeof build>> | undefined;
  const run = async (what: string): Promise<string[]> => {
    built ??= await build("layout-fields", SCHEMA, MAIN);
    const r = await built.run([what]);
    if (r.code !== 0) throw new Error(`exit ${r.code}\n${r.stdout}\n${r.stderr}`);
    // Errors at the root have an empty path ("RANGE ").
    return r.stdout
      .trim()
      .split("\n")
      .map(l => l.trimEnd());
  };

  it("evaluates item arguments over the owning struct's fields", { timeout: 600_000 }, async () => {
    expect(await run("fields")).toEqual([
      "08" + "01" + "08" + "0000000000" + "cc",
      "01" + "03" + "03" + "ddeeff",
      // Reads follow the stored offset, whatever the field says.
      '{"align":4,"size":2,"offset":3,"data":"aabb"}',
      "RANGE",
      // 1 << 2: b at 4.
      "02" + "02" + "04" + "00" + "2233",
      // 1 << 70 does not fit.
      "RANGE",
      "RANGE"
    ]);
  });

  it("applies through paths and groups", { timeout: 600_000 }, async () => {
    expect(await run("paths")).toEqual([
      // align * 2 = 4: body 0 at 4, body 1 at 8.
      "02" +
        "02" +
        "0408" +
        "01" +
        "000000" +
        "02" +
        ' {"align":2,"count":2,"recs":[{"body":{"v":1}},{"body":{"v":2}}]}',
      // Per volume: b aligned to 4, then a: vol 0 b @8 a @9, vol 1 b @12 a @13.
      "04" +
        "02" +
        "0908" +
        "0d0c" +
        "0000" +
        "02" +
        "01" +
        "0000" +
        "04" +
        "03" +
        ' {"align":4,"n":2,"vols":[{"a":{"v":1},"b":{"v":2}},{"a":{"v":3},"b":{"v":4}}]}',
      "RANGE"
    ]);
  });

  it(
    "applies in nested and root bases, with parameters and $index",
    { timeout: 600_000 },
    async () => {
      expect(await run("bases")).toEqual([
        // The inner base's target at 4 from the inner base.
        "01" + "04" + "04" + "0000" + "09",
        "08" + "08" + "000000000000" + "05",
        // Item 0 aligned to 2 << 0, item 1 to 2 << 1.
        "02" + "02" + "0408" + "01" + "000000" + "02",
        "RANGE inner"
      ]);
    }
  );

  it("re-lays out in view commits", { timeout: 600_000 }, async () => {
    expect(await run("views")).toEqual([
      // 4 is not a multiple of 8: the data moves to the end (default grow).
      "08" + "02" + "08" + "0000000000" + "aabb",
      // 4 is a multiple of 2: the data stays.
      "02" + "02" + "04" + "00" + "aabb",
      "RANGE",
      // align 8: body 1 stays at 8, body 0 moves to 16.
      "04" + "02" + "1008" + "00000000" + "02" + "00000000000000" + "01"
    ]);
  });
});
