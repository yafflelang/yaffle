/** The generated Java API: types, parse/serialize, JSON, errors, identity, options, async. */
import { describeJava } from "./harness.ts";

const schema = `
enum Kind : u8 { A = 1, B = 2 }
enum Open : u16 @open { X = 1 }

struct P { u16 x  u16 y }

struct Tagged { u8 tag = 1  u8 v }
struct Other  { u8 tag = 2  u16 w }
union TaggedOrOther { Tagged  Other }

export struct Doc(u32 version) {
  u32  magic = 0xd0c
  u64  big
  i64  neg
  f32  f
  f16  h
  Kind k
  Open o
  u8   flag
  if (flag != 0) { u32 opt }
  P   *p : u32 @nullable
  P   *q : u32 @nullable
  u8   v as it % 10
  TaggedOrOther t
  if (version >= 2) { u8 extra }
  u8   n
  u16  list[n]
  str  name
}

export struct Be {
  u16 a
  u32be b
  bool c
}
`;

const helpers = `
  static Doc doc() {
    Doc d = new Doc();
    d.big = -1L; // u64 max as a bit pattern
    d.neg = -5;
    d.f = 1.5f;
    d.h = 0.5;
    d.k = Kind.B;
    d.o = Open.of(7);
    d.flag = 1;
    d.opt = 99L;
    P shared = new P();
    shared.x = 3;
    shared.y = 4;
    d.p = shared;
    d.q = shared;
    d.vRaw = 42;
    Tagged t = new Tagged();
    t.v = 9;
    d.t = new TaggedOrOther.Tagged(t);
    d.extra = 7;
    d.list = new java.util.ArrayList<>(java.util.List.of(1, 2, 65535));
    d.name = "hi";
    return d;
  }
  static Doc.Options v2() {
    return new Doc.Options().version(2);
  }
`;

const tests: Record<string, string> = {
  "parse and serialize round trip with typed fields": `
    byte[] b = Doc.serialize(doc(), v2());
    Doc d = Doc.parse(b, v2());
    eq(-1L, d.big);
    eq(-5L, d.neg);
    eq(1.5f, d.f);
    eq(0.5, d.h);
    check(d.k == Kind.B, "closed enum");
    eq(7L, d.o.value());
    check(d.o.member() == null, "unknown open value");
    eq(99L, d.opt);
    eq(2, d.v); // 42 % 10
    eq(42, d.vRaw);
    check(d.t instanceof TaggedOrOther.Tagged, "union variant");
    eq(java.util.List.of(1, 2, 65535), d.list);
    eq("hi", d.name);
    eq(hex(b), hex(Doc.serialize(d, v2())));
  `,
  "shared targets are one object, written once, and $ref in JSON": `
    byte[] b = Doc.serialize(doc(), v2());
    Doc d = Doc.parse(b, v2());
    check(d.p == d.q, "same object for the same target");
    String j = org.yafflelang.runtime.Json.write(Doc.toJson(d));
    check(j.contains("\\"q\\":{\\"$ref\\":\\"/p\\"}"), j);
    Doc back = Doc.fromJson(org.yafflelang.runtime.Json.parse(j));
    check(back.p == back.q, "$ref restores identity");
    eq(hex(b), hex(Doc.serialize(back, v2())));
  `,
  "canonical JSON": `
    Doc d = Doc.parse(Doc.serialize(doc(), v2()), v2());
    String j = org.yafflelang.runtime.Json.write(Doc.toJson(d));
    check(j.contains("\\"big\\":\\"18446744073709551615\\""), j);
    check(j.contains("\\"neg\\":\\"-5\\""), j);
    check(j.contains("\\"k\\":\\"B\\""), j);
    check(j.contains("\\"o\\":7"), j);
    check(j.contains("\\"v\\":42"), "one-way transforms show the raw value: " + j);
    check(j.contains("\\"t\\":{\\"type\\":\\"Tagged\\",\\"value\\":{\\"tag\\":1,\\"v\\":9}}"), j);
    check(j.contains("\\"list\\":[1,2,65535]"), j);
    Doc v1 = Doc.parse(Doc.serialize(doc(), new Doc.Options().version(1)), new Doc.Options().version(1));
    check(!org.yafflelang.runtime.Json.write(Doc.toJson(v1)).contains("extra"), "untaken branch omitted");
    check(v1.extra == null, "absent conditional field is null");
  `,
  "errors carry code, path and offset": `
    byte[] b = Doc.serialize(doc(), v2());
    b[0] = 0;
    org.yafflelang.runtime.YaffleException e = fails("CHECK", () -> Doc.parse(b, v2()));
    path("[\\"magic\\"]", e);
    eq(0L, e.offset());
    Doc d = doc();
    d.list.set(1, 70000);
    org.yafflelang.runtime.YaffleException e2 = fails("RANGE", () -> Doc.serialize(d, v2()));
    path("[\\"list\\",1]", e2);
    eq(-1L, e2.offset());
    Doc d3 = doc();
    d3.name = null;
    path("[\\"name\\"]", fails("INPUT", () -> Doc.serialize(d3, v2())));
    fails("INPUT", () -> Doc.parse(b, null)); // missing root parameter
    fails("EOF", () -> Doc.parse(java.util.Arrays.copyOf(Doc.serialize(doc(), v2()), 10), v2()));
  `,
  "safeParse and async": `
    byte[] b = Doc.serialize(doc(), v2());
    check(Doc.safeParse(b, v2()) instanceof org.yafflelang.runtime.SafeResult.Ok<Doc>, "ok");
    org.yafflelang.runtime.SafeResult<Doc> bad = Doc.safeParse(new byte[3], v2());
    check(bad instanceof org.yafflelang.runtime.SafeResult.Err<Doc> err && err.error().code() == org.yafflelang.runtime.ErrorCode.EOF, "err");
    Doc d = Doc.parseAsync(b, v2()).get();
    eq(hex(b), hex(Doc.serializeAsync(d, v2()).get()));
  `,
  "endianness option and strict mode": `
    Be x = new Be();
    x.a = 0x0102;
    x.b = 0x03040506L;
    x.c = true;
    eq("0102" + "03040506" + "01", hex(Be.serialize(x, new Be.Options().endian(org.yafflelang.runtime.Endian.BE))));
    eq("0201" + "03040506" + "01", hex(Be.serialize(x)));
    check(Be.parse(hex("0201030405060" + "2")).c, "nonzero bool is true");
    fails("CHECK", () -> Be.parse(hex("02010304050602"), new Be.Options().strict(true)));
  `,
  "options from canonical JSON": `
    Doc.Options o = Doc.Options.fromJson(org.yafflelang.runtime.Json.parse("{\\"version\\":2,\\"endian\\":\\"be\\"}"));
    eq(2L, o.version);
    check(o.endian == org.yafflelang.runtime.Endian.BE, "endian");
  `
};

describeJava("java API", "api", { "doc.yfl": schema }, tests, { helpers });
