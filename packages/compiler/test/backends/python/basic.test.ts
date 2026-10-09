/**
 * Python backend: generated API end to end (compile real .yfl, generate Python, run it).
 */
import { describe, expect, it } from "vitest";
import { HAVE_PYTHON, PRELUDE, generate, program, py } from "./harness.ts";

const d = describe.skipIf(!HAVE_PYTHON);

const TABLE = `
enum Kind : u16 { Sys = 0, Gpu = 1 }
enum Flags : u8 @open { A = 1, B = 2 }
struct Entry {
  Kind kind
  u16  handler
  u64  offset
  f32  scale
  char name[8]
}
export struct Table {
  char tag[4] = "TABL"
  u32  count
  Entry entries[count]
  Flags flags
}
`;

d("Python backend: basic API", () => {
  it("parses into dataclasses with IntEnum members and serializes byte-exact", async () => {
    const gen = generate("basic_table", program(TABLE));
    const out = await py(
      gen,
      `${PRELUDE}
from ${gen.pkg}.schema import Table, Entry, Kind, Flags
import dataclasses
data = bytes.fromhex("5441424c" "02000000" "0100" "0700" "0800000000000000" "0000803f" "61626300000000ff"
                     "0000" "0900" "ffffffffffffffff" "00000040" "7a00000000000000" "05")
t = Table.parse(data)
assert dataclasses.is_dataclass(t)
assert t.entries[0].kind is Kind.Gpu and isinstance(t.entries[0].kind, int)
assert t.entries[1].kind == Kind.Sys
assert t.flags == 5 and not isinstance(t.flags, Flags)
print(json.dumps({
  "json": t.to_json(),
  "again": t.serialize().hex(),
  "fromjson": Table.from_json(t.to_json()).serialize().hex(),
  "count": t.count,
  "name": t.entries[0].name,
}))
`
    );
    expect(out).toMatchObject({
      count: 2,
      name: "abc",
      json: {
        tag: "TABL",
        count: 2,
        entries: [
          { kind: "Gpu", handler: 7, offset: "8", scale: 1, name: "abc" },
          { kind: "Sys", handler: 9, offset: "18446744073709551615", scale: 2, name: "z" }
        ],
        flags: 5
      }
    });
    const o = out as { again: string; fromjson: string };
    // "abc\0\0\0\0\xff" reads as "abc" and writes back zero-padded.
    expect(o.again).toBe(o.fromjson);
    expect(o.again).toContain("6162630000000000");
  });

  it("builds values with keyword arguments; derived fields are computed", async () => {
    const gen = generate("basic_build", program(TABLE));
    const out = await py(
      gen,
      `${PRELUDE}
from ${gen.pkg}.schema import Table, Entry, Kind, Flags
t = Table(entries=[Entry(kind=Kind.Gpu, handler=1, offset=2, scale=0.5, name="x")], flags=Flags.B)
b = t.serialize()
back = Table.parse(b)
print(json.dumps({"hex": b.hex(), "count": back.count, "eq": back.entries == t.entries}))
`
    );
    expect(out).toEqual({
      hex:
        "5441424c" +
        "01000000" +
        "0100" +
        "0100" +
        "0200000000000000" +
        "0000003f" +
        "7800000000000000" +
        "02",
      count: 1,
      eq: true
    });
  });

  it("reports errors with code, path and offset; safe_parse returns a result", async () => {
    const gen = generate("basic_errors", program(TABLE));
    const out = await py(
      gen,
      `${PRELUDE}
from ${gen.pkg}.schema import Table, Entry, Kind
r = Table.safe_parse(bytes.fromhex("5441424c" "01000000" "0500"))
e = r.error
bad = Table.safe_parse(b"XXXX")
ser = err(lambda: Table(entries=[Entry(kind=Kind.Sys, handler=70000, offset=0, scale=0.0, name="")], flags=1).serialize())
missing = err(lambda: Table.from_json({"entries": [{"kind": "Sys"}], "flags": 1}).serialize())
enum_name = err(lambda: Table.from_json({"entries": [], "flags": "C"}))
print(json.dumps({
  "ok": r.ok, "code": e.code, "path": e.path, "offset": e.offset,
  "bad": [bad.ok, bad.error.code, bad.error.path],
  "ser": ser, "missing": missing, "enum": enum_name,
}))
`
    );
    expect(out).toEqual({
      ok: false,
      code: "CHECK",
      path: ["entries", 0, "kind"],
      offset: 8,
      bad: [false, "CHECK", ["tag"]],
      ser: { code: "RANGE", path: ["entries", 0, "handler"] },
      missing: { code: "INPUT", path: ["entries", 0, "handler"] },
      enum: { code: "INPUT", path: ["flags"] }
    });
  });

  it("root parameters become keyword arguments (bound values without $)", async () => {
    const gen = generate(
      "basic_params",
      program(`
struct Inner { if ($version >= 2) { u16 extra } }
export struct Root(u8 n) {
  u32 $version
  u8 data[n]
  Inner inner
}
export struct Be { u16 a  u32 b }
`)
    );
    const out = await py(
      gen,
      `${PRELUDE}
from ${gen.pkg}.schema import Root, Be
r = Root.parse(bytes.fromhex("02000000aabb0700"), n=2)
r1 = Root.parse(bytes.fromhex("01000000aabb"), n=2)
be = Be.parse(bytes.fromhex("00010000000a"), endian="be")
print(json.dumps({
  "r": r.to_json(), "r1": r1.to_json(), "rt": r.serialize(n=2).hex(),
  "be": be.to_json(), "beout": be.serialize(endian="be").hex(),
  "opts": Root.options_from_json({"n": 3, "endian": "be"}),
}))
`
    );
    expect(out).toMatchObject({
      r: { version: 2, data: "aabb", inner: { extra: 7 } },
      r1: { version: 1, data: "aabb", inner: {} },
      rt: "02000000aabb0700",
      be: { a: 1, b: 10 },
      beout: "00010000000a",
      opts: { n: 3, endian: "be" }
    });
  });

  it("missing root options are a TypeError (keyword-only arguments)", async () => {
    const gen = generate("basic_req", program(`export struct R(u8 n) { u8 d[n] }`));
    const out = await py(
      gen,
      `
import json
from ${gen.pkg}.schema import R
try:
    R.parse(b"")
    print(json.dumps("no error"))
except TypeError as e:
    print(json.dumps("TypeError"))
`
    );
    expect(out).toBe("TypeError");
  });

  it("unions are Variants, switches are flat optional fields", async () => {
    const gen = generate(
      "basic_unions",
      program(`
struct A { u8 tag = 1  u8 x }
struct B { u8 tag = 2  u16 y }
union AB { A  B }
export struct U { AB v  u8 kind  switch (kind) { case 1: u8 small  case 2: u32 big  default: u8 other[2] } }
`)
    );
    const out = await py(
      gen,
      `${PRELUDE}
from ${gen.pkg}.schema import U, A, B
u = U.parse(bytes.fromhex("020300" "02" "04000000"))
v = U(v=rt.Variant("A", A(x=9)), kind=1, small=5)
print(json.dumps({"j": u.to_json(), "type": u.v.type, "y": u.v.value.y, "out": v.serialize().hex(),
                  "small": u.small}))
`
    );
    expect(out).toEqual({
      j: { v: { type: "B", value: { tag: 2, y: 3 } }, kind: 2, big: 4 },
      type: "B",
      y: 3,
      out: "0109" + "01" + "05",
      small: null
    });
  });

  it("pointers share targets (identity) and cycles round-trip through $ref", async () => {
    const gen = generate(
      "basic_ptr",
      program(`
struct Node { u32 value  Node *next : u32 @nullable }
export struct List { Node *head : u32  Node *alias : u32 }
`)
    );
    const out = await py(
      gen,
      `${PRELUDE}
from ${gen.pkg}.schema import List, Node
a = Node(value=1, next=None)
b = Node(value=2, next=a)
a.next = b
lst = List(head=a, alias=a)
data = lst.serialize()
back = List.parse(data)
print(json.dumps({"hex": data.hex(), "same": back.head is back.alias, "cycle": back.head.next.next is back.head,
                  "json": back.to_json(), "rt": List.from_json(back.to_json()).serialize().hex()}))
`
    );
    expect(out).toEqual({
      hex: "08000000" + "08000000" + "01000000" + "10000000" + "02000000" + "08000000",
      same: true,
      cycle: true,
      json: {
        head: { value: 1, next: { value: 2, next: { $ref: "/head" } } },
        alias: { $ref: "/head" }
      },
      rt: "08000000" + "08000000" + "01000000" + "10000000" + "02000000" + "08000000"
    });
  });
});
