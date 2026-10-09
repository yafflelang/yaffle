/**
 * Layout items that read fields (IR.md §4.4): layer arguments are evaluated in the owning
 * struct's write context (fields, parameters, `$index`), through paths, groups and nested bases,
 * in serialize and in view commits (sticky layout). Alignments below 1 are RANGE errors.
 */
import { describe, expect, it } from "vitest";
import { generateJava } from "../../../src/backends/java/index.ts";
import { describeJava, program } from "./harness.ts";

const schema = `
export struct AlignByField {
  u8 align
  u8 size
  u8 offset
  u8 data[size] at offset
  layout { data @align(align) }
}

struct E(u8 a) {
  u8 n
  u8 ofs
  u8 body[n] at ofs
  layout { body @align(a * ($index + 1)) }
}
export struct Params {
  u8   a
  u8   c
  E(a) es[c]
}

struct Leaf { u8 v }
struct Item {
  Leaf *a : u8
  Leaf *b : u8
}
export struct GroupByField {
  u8   al
  u8   n
  Item items[n]
  layout { items[*] @align(al) { b  a @align(al * 2) } }
}

struct Sub @base {
  u8 al
  u8 n
  u8 ofs
  u8 data[n] at ofs
  layout { data @align(al) }
}
export struct WithBase {
  u8  tag
  Sub sub
}

export struct ZeroConst {
  u8 n
  u8 ofs
  u8 data[n] at ofs
  layout { data @align(0) }
}

export struct Residue {
  u8 n
  u8 ofs
  u8 m
  u8 ofs2
  u8 data[n] at ofs
  u8 more[m] at ofs2
  layout { data @align(4, offset: 1) }
}
`;

const J = "dev.yaffle.runtime.Json";
const json = (s: string): string => `${J}.parse(${JSON.stringify(s)})`;

const tests: Record<string, string> = {
  "a field of the struct aligns its target": `
    eq("0802080000000000aabb", hex(AlignByField.serialize(AlignByField.fromJson(${json('{"align":8,"data":"aabb"}')}))));
    eq("010303ddeeff", hex(AlignByField.serialize(AlignByField.fromJson(${json('{"align":1,"data":"ddeeff"}')}))));
  `,
  "an alignment below 1 is a RANGE error": `
    fails("RANGE", () -> AlignByField.serialize(AlignByField.fromJson(${json('{"align":0,"data":"aa"}')})));
    fails("RANGE", () -> ZeroConst.serialize(ZeroConst.fromJson(${json('{"data":"aa"}')})));
  `,
  "parameters and $index of an element struct": `
    byte[] b = Params.serialize(Params.fromJson(${json('{"a":2,"es":[{"body":"aa"},{"body":"bbcc"}]}')}));
    // body 0 aligned to 2 * 1, body 1 to 2 * 2
    eq("020201060208aa00bbcc", hex(b));
    eq(hex(b), hex(Params.serialize(Params.parse(b))));
  `,
  "group layers read the container's fields": `
    byte[] b = GroupByField.serialize(GroupByField.fromJson(${json('{"al":2,"items":[{"a":{"v":1},"b":{"v":2}},{"a":{"v":3},"b":{"v":4}}]}')}));
    // per item: b aligned to 2, then a aligned to 4
    eq("020208060c0a02000100040003", hex(b));
  `,
  "a nested base computes its own layout": `
    byte[] b = WithBase.serialize(WithBase.fromJson(${json('{"tag":119,"sub":{"al":4,"data":"aabb"}}')}));
    eq("7704020400aabb", hex(b));
    WithBase.View v = WithBase.view(b);
    eq(hex(b), hex(v.commit()));
  `,
  "views: editing a field a layout reads re-lays out on commit": `
    AlignByField.View v = AlignByField.view(dev.yaffle.runtime.Hex.decode("04020400aabb"));
    v.setAlign(8);
    eq("0802080000000000aabb", hex(v.commit()));
  `,
  "views: sticky layout keeps or moves targets by the computed alignment": `
    AlignByField.View v = AlignByField.view(dev.yaffle.runtime.Hex.decode("04020400aabb"));
    v.setData(new byte[] {(byte) 0xaa, (byte) 0xbb, (byte) 0xcc});
    // grows: moves to the end, still aligned to the field
    eq("0403080000000000aabbcc", hex(v.commit()));
    AlignByField.View v2 = AlignByField.view(dev.yaffle.runtime.Hex.decode("04020400aabb"));
    v2.setData(new byte[] {(byte) 0xaa, (byte) 0xbb, (byte) 0xcc});
    eq("04030400aabbcc", hex(v2.commit(dev.yaffle.runtime.Layout.Grow.SPLICE)));
  `,
  "views: element structs re-evaluate their layout on commit": `
    byte[] b = Params.serialize(Params.fromJson(${json('{"a":2,"es":[{"body":"aa"},{"body":"bbcc"}]}')}));
    Params.View v = Params.view(b);
    eq(hex(b), hex(v.commit()));
    v.getEs().get(0).setBody(new byte[] {1, 2, 3});
    // body 0 grows: moves to the end, aligned to 2
    eq("0202030a02080000bbcc010203", hex(v.commit()));
  `,
  "views: sticky layout checks layout-item residues": `
    // data must start at 3 mod 4; the original has it at 4
    Residue.View v = Residue.view(dev.yaffle.runtime.Hex.decode("01040105aabb"));
    v.setMore(new byte[] {(byte) 0xbb, (byte) 0xcc});
    eq("01070208000000aabbcc", hex(v.commit()));
  `
};

describe("java layout items that read fields: generation", () => {
  it("rejects layout arguments that depend on positions (circular)", () => {
    const p = program({
      "doc.yfl": `
        export struct Circular {
          u8 size
          u8 offset
          u8 data[size] at offset
          layout { data @align(offset + 1) }
        }`
    });
    expect(() => generateJava(p, { externs: {} })).toThrow(/positions or encoded content/);
  });
});

describeJava("java layout items that read fields", "layout-fields", { "doc.yfl": schema }, tests);
