/**
 * Layout groups, alignment origins, virtual fields, strict padding, derived arrays and slices
 * through the frontend syntax: one schema, serialized, parsed, viewed and committed.
 */
import { describeJava } from "./harness.ts";

const schema = `
struct M { u8 x }
struct R {
  M  *model : u64 @nullable
  u16 flags
}
struct Piece { u8 n }
struct Volume {
  u8     nPieces
  Piece *pieces[nPieces] : u64
}
struct Hdr { u16 a  u16 b }
export struct S {
  u8  s
  u8  r
  R   records[r]
  u8  index[s] = indicesWhere(records, rec => rec.model != null)
  u8  sizeHigh
  u32 sizeLow
  virtual u40 size = (sizeHigh << 32) | sizeLow
  u8  a @align(4, offset: 0x19)
  u8  b @align(16, from: file) @padUntil(0x20, strict)
  u8  raw[4] @hidden
  Hdr hdr from raw[0..4]
  u8  nv
  Volume vols[nv]
  layout {
    vols[*] { pieces[*] }
  }
}

struct Key { u8 len  char name[len] }
export struct Sorted {
  u8  n
  Key keys[n] where it == sortedBy(it, k => k.name)
  u8  m
  u8  doubled[m] = map(filter(keys, k => k.name != "a"), k => k.name.length * 2)
}
`;

const input = `{"records":[{"model":{"x":1},"flags":2},{"model":null,"flags":3}],"size":4294967298,"a":7,"b":8,"hdr":{"a":1,"b":2},"vols":[{"pieces":[{"n":5},{"n":6}]},{"pieces":[{"n":9}]}]}`;

const tests: Record<string, string> = {
  "every feature round trips": `
    S v = S.fromJson(dev.yaffle.runtime.Json.parse(${JSON.stringify(input)}));
    byte[] b = S.serialize(v);
    S p = S.parse(b);
    eq(hex(new byte[] {0}), hex(p.index));
    eq(1, p.sizeHigh);
    eq(2L, p.sizeLow);
    eq(4294967298L, p.size);
    eq(1, p.hdr.a);
    eq(2, p.hdr.b);
    eq(9, p.vols.get(1).pieces.get(0).n);
    eq(hex(b), hex(S.serialize(S.fromJson(S.toJson(p)))));
    S.View w = S.view(b);
    eq(dev.yaffle.runtime.Json.write(S.toJson(p)), dev.yaffle.runtime.Json.write(S.toJson((S) dev.yaffle.runtime.ViewRead.materialize(w))));
    eq(hex(b), hex(w.commit()));
  `,
  "layout groups put each volume's pieces after it": `
    byte[] b = S.serialize(S.fromJson(dev.yaffle.runtime.Json.parse(${JSON.stringify(input)})));
    S p = S.parse(b);
    // targets: model, then volume 0's pieces, then volume 1's
    check(p.vols.get(0).pieces.get(1) != null, "pieces");
    eq(hex(b), hex(S.serialize(p)));
  `,
  "derived arrays and rules": `
    byte[] b = Sorted.serialize(Sorted.fromJson(dev.yaffle.runtime.Json.parse("{\\"keys\\":[{\\"name\\":\\"a\\"},{\\"name\\":\\"bc\\"},{\\"name\\":\\"de\\"}]}")));
    Sorted p = Sorted.parse(b);
    eq("0404", hex(p.doubled));
    fails("CHECK", () -> Sorted.serialize(Sorted.fromJson(dev.yaffle.runtime.Json.parse("{\\"keys\\":[{\\"name\\":\\"b\\"},{\\"name\\":\\"a\\"}]}"))));
  `
};

describeJava("java features through the syntax", "syntax-features", { "doc.yfl": schema }, tests);
