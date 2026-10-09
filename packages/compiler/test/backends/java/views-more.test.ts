/** Java views over pointers, codec regions, bitfields, nested bases and conditionals. */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeJava } from "./harness.ts";

const here = dirname(fileURLToPath(import.meta.url));
const xor = resolve(here, "../../../../../conformance/externs/java/xor.java") + "#XOR";

const schema = `
extern codec xor(u8 key) @ranged

struct Pt { u16 x  u16 y }

struct Sub @base {
  u8  a
  Pt *p : u8
}

struct Inner { u8 n  u8 data[n] }

export struct Doc {
  Pt  *first  : u32
  Pt  *second : u32
  Pt  *maybe  : u32 @nullable
  bits u8 {
    bool    flag : 1
    u8      level : 3
    u8            : 4
  }
  u8   hasTail
  if (hasTail != 0) { u16 tail }
  u32  plen
  Inner packed @via(xor(0x5a)) @size(plen)
  Sub  sub
}
`;

const helpers = `
  static Pt pt(int x, int y) {
    Pt p = new Pt();
    p.x = x;
    p.y = y;
    return p;
  }
  static Doc doc() {
    Doc d = new Doc();
    Pt shared = pt(1, 2);
    d.first = shared;
    d.second = shared;
    d.maybe = null;
    d.flag = true;
    d.level = 5;
    d.hasTail = 1;
    d.tail = 0x1234;
    Inner in = new Inner();
    in.data = new byte[] {9, 8, 7};
    d.packed = in;
    Sub s = new Sub();
    s.a = 3;
    s.p = pt(7, 8);
    d.sub = s;
    return d;
  }
  static String json(Doc d) {
    return dev.yaffle.runtime.Json.write(Doc.toJson(d));
  }
`;

const tests: Record<string, string> = {
  "pointer targets are lazy views; shared targets are one view": `
    byte[] b = Doc.serialize(doc());
    Doc.View v = Doc.view(b);
    eq(1, v.getFirst().getX());
    check(v.getFirst().node() == v.getSecond().node(), "one node per target");
    check(v.getMaybe() == null, "null pointer");
    eq(json(Doc.parse(b)), json(v.toValue()));
  `,
  "an in-place edit of a shared target shows through both pointers": `
    byte[] b = Doc.serialize(doc());
    Doc.View v = Doc.view(b);
    v.getFirst().setY(99);
    eq(99, v.getSecond().getY());
    eq(1, v.patches().size());
    Doc p = Doc.parse(v.commit());
    eq(99, p.second.y);
    check(p.first == p.second, "still shared");
  `,
  "a structural edit of a shared target keeps it shared": `
    byte[] b = Doc.serialize(doc());
    Doc.View v = Doc.view(b);
    v.setMaybe(pt(5, 6));
    v.getFirst().setX(42);
    Doc p = Doc.parse(v.commit());
    eq(42, p.first.x);
    check(p.first == p.second, "shared target written once");
    eq(5, p.maybe.x);
  `,
  "bitfields are patched in place": `
    byte[] b = Doc.serialize(doc());
    Doc.View v = Doc.view(b);
    check(v.getFlag(), "flag");
    eq(5, v.getLevel());
    v.setLevel(2);
    eq(2, v.getLevel());
    check(v.getFlag(), "the other bits are kept");
    eq(1, v.patches().size());
    Doc p = Doc.parse(v.commit());
    eq(2, p.level);
    check(p.flag, "flag");
  `,
  "conditional fields": `
    byte[] b = Doc.serialize(doc());
    Doc.View v = Doc.view(b);
    eq(0x1234, v.getTail());
    v.setHasTail(0);
    Doc p = Doc.parse(v.commit());
    check(p.tail == null, "the branch is gone");
    eq(b.length - 2, Doc.serialize(p).length);
  `,
  "codec regions decode on access and re-encode when edited": `
    byte[] b = Doc.serialize(doc());
    Doc.View v = Doc.view(b);
    eq(3, v.getPacked().getData().length);
    eq(9, v.getPacked().getData()[0]);
    v.getPacked().setData(new byte[] {1, 2, 3, 4});
    Doc p = Doc.parse(v.commit());
    eq(hex(new byte[] {1, 2, 3, 4}), hex(p.packed.data));
    eq(5L, p.plen);
  `,
  "nested base structs keep their own offsets": `
    byte[] b = Doc.serialize(doc());
    Doc.View v = Doc.view(b);
    eq(7, v.getSub().getP().getX());
    v.getSub().getP().setX(70);
    v.getSub().setA(4);
    Doc p = Doc.parse(v.commit());
    eq(70, p.sub.p.x);
    eq(4, p.sub.a);
    v.getSub().setP(pt(100, 200));
    Doc p2 = Doc.parse(v.commit());
    eq(100, p2.sub.p.x);
    eq(json(p2), json(Doc.parse(Doc.serialize(p2))));
  `
};

describeJava(
  "java views: pointers, regions, bits, bases",
  "views-more",
  { "doc.yfl": schema },
  tests,
  {
    helpers,
    externs: { xor }
  }
);
