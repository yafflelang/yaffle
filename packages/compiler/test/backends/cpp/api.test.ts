/**
 * The generated C++ API: typed structs, enum class, std::optional for conditional fields,
 * std::variant for unions, std::shared_ptr for pointer targets, parse/serialize/to_json/from_json,
 * root options, errors with code and path. Everything is checked from a C++ main.
 */
import { describe, expect, it } from "vitest";
import { PRELUDE, build, toolchain } from "./harness.ts";

const SCHEMA = `
enum Kind : u8 { A = 1, B = 2 }

export struct Table {
  char tag[4] = "TABL"
  u16 count
  Entry entries[count]
  Kind kind
  switch (kind) {
    case Kind.A: u32 extra
    case Kind.B: str name
  }
}

struct Entry {
  u8 id
  u16be value
}

export struct Ptrs {
  Pt *a : u8
  Pt *b : u8 @nullable
  Pt *c : u8 @nullable
}

struct Pt { u8 x  u8 y }

union Shape { Big  Small }
struct Big { u8 tag = 1  u32 size }
struct Small { u8 tag = 2  u8 size }
export struct Choice { Shape v }

export struct Versioned(u32 $version) {
  u8 n
  u8 data[n] @padUntil(4)
  if ($version >= 2) { u16 extra }
}
`;

const MAIN = `${PRELUDE}
int main() {
  // ── Table: arrays, constants, derived counts, enum class, switch fields ──────────
  Table t = Table::parse(hex("5441424c 0200 0a 0102 0b 0304 02 6869 00"));
  CHECK(t.tag == "TABL");
  CHECK(t.count == 2);
  CHECK(t.entries.size() == 2 && t.entries[1].id == 0x0b && t.entries[1].value == 0x0304);
  CHECK(t.kind == Kind::B);
  CHECK(!t.extra.has_value());
  CHECK(t.name.has_value() && *t.name == "hi");
  std::printf("json=%s\\n", Table::to_json(t).dump().c_str());
  // Edit like any C++ value: the count is derived on write.
  t.entries.push_back(Entry{0x0c, 0x0506});
  t.kind = Kind::A;
  t.name.reset();
  t.extra = 0x01020304;
  std::printf("edited=%s\\n", yaffle::to_hex(Table::serialize(t)).c_str());
  Table u = Table::from_json(yaffle::Json::parse(R"({"count": 99, "entries": [{"id": 1, "value": 2}], "kind": "A", "extra": 7})"));
  std::printf("fromjson=%s\\n", yaffle::to_hex(Table::serialize(u)).c_str());
  std::printf("bad-tag=%s\\n", err([] { Table::parse(hex("54414242 0000 01 00000000")); }).c_str());
  std::printf("eof=%s\\n", err([] { Table::parse(hex("5441424c 0200 0a01")); }).c_str());
  std::printf("missing=%s\\n", err([] { Table::from_json(yaffle::Json::parse(R"({"kind": "A"})")); }).c_str());
  std::printf("enum=%s\\n", err([] { Table::from_json(yaffle::Json::parse(R"({"entries": [], "kind": "C"})")); }).c_str());
  std::printf("range=%s\\n", err([] { Table::from_json(yaffle::Json::parse(R"({"entries": [{"id": 256, "value": 0}], "kind": "A", "extra": 0})")); }).c_str());

  // ── Ptrs: shared targets keep their identity, null pointers ───────────────────
  Ptrs p = Ptrs::parse(hex("03 03 00 0102"));
  CHECK(p.a && p.b && p.a.get() == p.b.get());
  CHECK(!p.c);
  std::printf("ptrs=%s\\n", Ptrs::to_json(p).dump().c_str());
  Ptrs q;
  q.a = std::make_shared<Pt>(Pt{5, 6});
  q.b = q.a;  // the same object: written once
  q.c = std::make_shared<Pt>(Pt{5, 6});  // an equal value: written again
  std::printf("ptrs-out=%s\\n", yaffle::to_hex(Ptrs::serialize(q)).c_str());

  // ── Choice: std::variant ────────────────────────────────────────────────────
  Choice c = Choice::parse(hex("02 09"));
  CHECK(c.v.index() == 1 && std::get<1>(c.v).size == 9);
  c.v = Big{1, 0x10203};
  std::printf("choice=%s %s\\n", yaffle::to_hex(Choice::serialize(c)).c_str(), Choice::to_json(c).dump().c_str());
  std::printf("union-none=%s\\n", err([] { Choice::parse(hex("03 00")); }).c_str());

  // ── Versioned: root options (bound value, endian, strict) ─────────────────────
  Versioned::Options o;
  o.version = 2;
  o.endian = yaffle::Endian::be;
  Versioned v = Versioned::parse(hex("02 aabb 0000 0102"), o);
  CHECK(v.extra.has_value() && *v.extra == 0x0102);
  std::printf("versioned=%s\\n", yaffle::to_hex(Versioned::serialize(v, o)).c_str());
  std::printf("no-version=%s\\n", err([] { Versioned::parse(hex("00 000000")); }).c_str());
  o.strict = true;
  std::printf("strict=%s\\n", err([&] { Versioned::parse(hex("02 aabb ff00 0102"), o); }).c_str());
  std::printf("failures=%d\\n", failures);
  return failures ? 1 : 0;
}
`;

function lines(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of stdout.split("\n")) {
    const i = l.indexOf("=");
    if (i > 0) out[l.slice(0, i)] = l.slice(i + 1);
  }
  return out;
}

describe.skipIf(!toolchain)("C++ API", () => {
  it("generates idiomatic types and a working root API", { timeout: 300_000 }, async () => {
    const b = await build("api", SCHEMA, MAIN);
    expect(b.header).toContain("enum class Kind : std::uint8_t");
    expect(b.header).toContain("std::vector<Entry> entries;");
    expect(b.header).toContain("std::optional<std::uint32_t> extra;");
    expect(b.header).toContain("std::shared_ptr<Pt> a;");
    expect(b.header).toContain("using Union1 = std::variant<Big, Small>;");
    expect(b.header).toContain(
      "static Value parse(yaffle::BytesView data, const Options& options);"
    );
    const r = await b.run();
    expect(r.stderr).toBe("");
    const out = lines(r.stdout);
    expect(out.failures).toBe("0");
    expect(JSON.parse(out.json!)).toEqual({
      tag: "TABL",
      count: 2,
      entries: [
        { id: 10, value: 0x0102 },
        { id: 11, value: 0x0304 }
      ],
      kind: "B",
      name: "hi"
    });
    expect(out.edited).toBe("5441424c03000a01020b03040c05060104030201");
    expect(out.fromjson).toBe("5441424c0100010002" + "01" + "07000000");
    expect(out["bad-tag"]).toBe("CHECK tag");
    expect(out.eof).toBe("EOF entries[0].value");
    expect(out.missing).toBe("INPUT entries");
    expect(out.enum).toBe("INPUT kind");
    expect(out.range).toBe("RANGE entries[0].id");
    expect(JSON.parse(out.ptrs!)).toEqual({ a: { x: 1, y: 2 }, b: { $ref: "/a" }, c: null });
    expect(out["ptrs-out"]).toBe("03030505060506");
    expect(out.choice).toBe(
      "0103020100 " + JSON.stringify({ v: { type: "Big", value: { tag: 1, size: 0x10203 } } })
    );
    expect(out["union-none"]).toBe("UNION v");
    expect(out.versioned).toBe("02aabb00000102");
    expect(out["no-version"]).toBe("INPUT ");
    expect(out.strict).toBe("CHECK data");
  });
});
