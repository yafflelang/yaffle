/**
 * Language features end to end in C#: per-element layout groups (docs/IR.md §4.3), alignment
 * origins and offsets, virtual fields, strict padding, derived arrays and composite equality, and
 * writable stream slices, on parse, serialize and views.
 */
import { describeChecks, gen, irOf, type CheckSpec } from "./harness.ts";

const schemas: Record<string, string> = {
  Al: `
    export struct Ao { u8 a  u8 b @align(4, offset: 1) }
    struct Ia @base { u8 x  u8 y @align(4, from: file) }
    struct Ib @base { u8 x  u8 y @align(4) }
    export struct Ob { u16 p  Ia inner  u8 q }
    export struct Obb { u16 p  Ib inner }
    struct T { u8 x  u8 y @align(8, from: file) }
    export struct R { T *t : u8  u8 z }
    struct B @base @alignEnd(4, offset: 1) { u8 x }
    export struct W { B b  u8 z }
    struct Leaf { u8 v }
    export struct L2 {
      Leaf *a : u8
      layout { a @align(4, offset: 2) }
    }
    extern codec xor(u8 key) @ranged
    struct Dec { u8 x  u8 y @align(4, from: file) }
    export struct Coded { u8 n  Dec d @via(xor(0)) @size(n) }
  `,
  St: `
    export struct P {
      u8  a @padAfter(3, strict)
      u16 b @padUntil(4, strict)
      u8  c @padAfter(1)
    }
  `,
  Vf: `
    export struct V {
      u8  hi
      u32 lo
      virtual u40 size = (hi << 32) | lo
      u8  after
    }
    export struct Mr {
      u8 high
      u8 low in (0..9)
      virtual u16 n = high * 10 + low
    }
  `,
  Da: `
    struct Rec { u8 id  char name[2] }
    export struct D {
      u8  n
      u8  vals[n]
      u8  m
      u8  idx[m] = indicesWhere(vals, v => v > 5)
      u16 twice = sum(map(vals, v => v * 2))
      u8  big = filter(vals, v => v > 5).length
      u8  uniq = unique(concat(vals, vals)).length
    }
    export struct K { u16 keys[3] where it == sortedBy(it, k => k) }
    export struct Names {
      Rec recs[3] where it == sortedBy(it, r => r.name)
      u8  ids = sum(map(recs, r => r.id))
    }
    struct Model { u8 v }
    struct Slot { Model *model : u8 @nullable }
    export struct Idx {
      u8   n
      Slot slots[n]
      u8   s
      u8   used[s] = indicesWhere(slots, r => r.model != null)
    }
  `,
  Sl: `
    struct Hdr { u16 x  u16 y }
    export struct Ov {
      u8  raw[8] @hidden
      Hdr hdr  from raw[0..4]
      u8  tail[] from raw[4..8]
    }
    export struct Two {
      u8  raw[] @hidden
      u32 a from raw[0..4]
      u16 b from raw[2..4]
      u8  c from raw[6..]
    }
  `,
  Gr: `
    struct Leaf { u8 v }
    struct Vol { Leaf *a : u8  Leaf *b : u8 }
    export struct Plain { u8 n  Vol vols[n] }
    export struct Flat {
      u8  n
      Vol vols[n]
      layout { vols[*].b  vols[*].a }
    }
    export struct Grouped {
      u8  n
      Vol vols[n]
      layout { vols[*] { b  a } }
    }
    struct Piece { Leaf *p : u8 }
    struct Vol2 {
      Piece pieces[2]
      Leaf *c : u8
      Leaf *d : u8
    }
    export struct Top {
      Vol2 vols[2]
      layout { vols[*] @align(2) { d  pieces[*].p } }
    }
  `
};

const HELPERS = `
using System;
using System.Collections.Generic;
using System.Linq;
using Rt = global::Yaffle.Runtime;

public static class H
{
    public static byte[] X(string hex) => Convert.FromHexString(hex.Replace(" ", ""));
    public static string Hex(byte[] b) => Convert.ToHexStringLower(b);
    public static string Err(Action a)
    {
        try { a(); return "no error"; }
        catch (Rt.YaffleException e) { return e.Code + " " + Rt.YaffleException.FormatPath(e.Path); }
    }
}
`;

const checks: Record<string, CheckSpec[]> = {
  "alignment origins and offsets": [
    {
      name: "align offset",
      body: `var a = Al.Ao.Parse(H.X("01 0000 07"));
return $"{a.A} {a.B} {H.Hex(Al.Ao.Serialize(new Al.Ao { A = 1, B = 7 }))}";`,
      expect: "1 7 01000007"
    },
    {
      name: "align from file inside a nested base",
      body: `var o = Al.Ob.Parse(H.X("0100 05 00 09 0c"));
var b = Al.Obb.Parse(H.X("0100 05 000000 09"));
var w = H.Hex(Al.Ob.Serialize(new Al.Ob { P = 1, Inner = new Al.Ia { X = 5, Y = 9 }, Q = 12 }));
return $"{o.Inner.X} {o.Inner.Y} {o.Q} {b.Inner.Y} {w}";`,
      expect: "5 9 12 9 01000500090c"
    },
    {
      name: "a target block is aligned so the file alignment holds",
      body: `var r = Al.R.Serialize(new Al.R { T = new Al.T { X = 1, Y = 2 }, Z = 3 });
var p = Al.R.Parse(r);
return $"{H.Hex(r)} {p.T.X} {p.T.Y} {p.Z}";`,
      expect: "0803000000000000010000000000000002 1 2 3"
    },
    {
      name: "a base's alignEnd with an offset; layout items with an offset",
      body: `var w = Al.W.Parse(H.X("07 0000 09"));
var out_ = Al.L2.Serialize(new Al.L2 { A = new Al.Leaf { V = 5 } });
return $"{w.B.X} {w.Z} {H.Hex(Al.W.Serialize(new Al.W { B = new Al.B { X = 7 }, Z = 9 }))} {H.Hex(out_)} {Al.L2.Parse(out_).A.V}";`,
      expect: "7 9 07000009 020005 5"
    },
    {
      name: "from: file inside a decoded region counts from the decoded start",
      body: `var bytes = Al.Coded.Serialize(new Al.Coded { D = new Al.Dec { X = 1, Y = 2 } });
var p = Al.Coded.Parse(bytes);
return $"{H.Hex(bytes)} {p.D.Y}";`,
      expect: "050100000002 2"
    },
    {
      name: "views read aligned fields",
      body: `var v = Al.Ob.View(H.X("0100 05 00 09 0c"));
return $"{v.Root.Inner.Y} {v.Root.Q} {H.Hex(v.Commit(new Rt.CommitOptions { Rewrite = true }))}";`,
      expect: "9 12 01000500090c"
    }
  ],
  "strict padding": [
    {
      name: "strict padding is checked outside strict mode",
      body: `var ok = St.P.Parse(H.X("01 000000 0200 0000 03 55"));
var e1 = H.Err(() => St.P.Parse(H.X("01 000100 0200 0000 03 00")));
var e2 = H.Err(() => St.P.Parse(H.X("01 000000 0200 0100 03 00")));
var w = H.Hex(St.P.Serialize(new St.P { A = 1, B = 2, C = 3 }));
var e3 = H.Err(() => { var x = St.P.View(H.X("01 000100 0200 0000 03 00")).Root.A; });
return $"{ok.A} {ok.B} {ok.C} [{e1}] [{e2}] {w} [{e3}]";`,
      expect: "1 2 3 [CHECK a] [CHECK b] 01000000020000000300 [CHECK a]"
    }
  ],
  "virtual fields": [
    {
      name: "virtual fields read, write their parts and round-trip",
      body: `var v = Vf.V.Parse(H.X("01 02000000 09"));
var json = Rt.Json.Stringify(Vf.V.ToJson(v));
var back = H.Hex(Vf.V.Serialize(Vf.V.FromJson(Vf.V.ToJson(v))));
var w = H.Hex(Vf.V.Serialize(new Vf.V { Size = 0x123456789a, After = 0 }));
var big = H.Err(() => Vf.V.Serialize(new Vf.V { Size = 1UL << 41 }));
var missing = H.Err(() => Vf.V.FromJson(System.Text.Json.Nodes.JsonNode.Parse("{\\"after\\": 0}")));
return $"{v.Size} {json} {back} {w} [{big}] [{missing}]";`,
      expect:
        '4294967298 {"hi":1,"lo":2,"size":4294967298,"after":9} 010200000009 129a78563400 [RANGE size] [INPUT size]'
    },
    {
      name: "virtual fields with a mixed-radix reverse",
      body: `var w = H.Hex(Vf.Mr.Serialize(new Vf.Mr { N = 47 }));
var p = Vf.Mr.Parse(H.X("0407"));
return $"{w} {p.N}";`,
      expect: "0407 47"
    },
    {
      name: "views read and edit virtual fields",
      body: `var view = Vf.V.View(H.X("01 02000000 09"));
var s = view.Root.Size;
view.Root.Size = 7;
var out_ = H.Hex(view.Commit());
var v2 = Vf.V.View(H.X("01 02000000 09"));
v2.Root.Hi = 2;
return $"{s} {out_} [{H.Err(() => v2.Commit())}]";`,
      expect: "4294967298 000700000009 [INPUT hi]"
    }
  ],
  "derived arrays": [
    {
      name: "indicesWhere/map/filter/unique/concat in formulas",
      body: `var out_ = Da.D.Serialize(new Da.D { Vals = new byte[] { 1, 7, 3, 9, 9 } });
var v = Da.D.Parse(out_);
var view = Da.D.View(out_);
return $"{H.Hex(out_)} {H.Hex(v.Idx)} {v.Twice} {H.Hex(view.Root.Idx)}";`,
      expect: "05010703090903010304" + "3a00" + "03" + "04" + " 010304 58 010304"
    },
    {
      name: "sortedBy checks over numbers and structs",
      body: `var k = Da.K.Parse(H.X("0100 0200 0300"));
var e1 = H.Err(() => Da.K.Parse(H.X("0200 0100 0300")));
var e2 = H.Err(() => Da.K.Serialize(new Da.K { Keys = new() { 3, 1, 2 } }));
Da.Rec R(byte id, string n) => new Da.Rec { Id = id, Name = n };
var out_ = Da.Names.Serialize(new Da.Names { Recs = new() { R(1, "ab"), R(2, "ac"), R(3, "b") } });
var e3 = H.Err(() => Da.Names.Serialize(new Da.Names { Recs = new() { R(2, "ac"), R(1, "ab"), R(3, "b") } }));
var e4 = H.Err(() => { var x = Da.K.View(H.X("0200 0100 0300")).Root.Keys; });
return $"{string.Join(",", k.Keys)} [{e1}] [{e2}] {Da.Names.Parse(out_).Ids} [{e3}] [{e4}]";`,
      expect: "1,2,3 [CHECK keys] [CHECK keys] 6 [CHECK recs] [CHECK keys]"
    },
    {
      name: "indicesWhere over nullable pointers",
      body: `var m = new Da.Model { V = 7 };
var x = new Da.Idx { Slots = new() { new Da.Slot { Model = null }, new Da.Slot { Model = m }, new Da.Slot { Model = null }, new Da.Slot { Model = m } } };
var out_ = Da.Idx.Serialize(x);
var p = Da.Idx.Parse(out_);
return $"{H.Hex(p.Used)} {p.S}";`,
      expect: "0103 2"
    }
  ],
  "stream slices": [
    {
      name: "the sliced field is assembled from its slices",
      body: `var b0 = H.X("0100 0200 0a0b0c0d");
var v = Sl.Ov.Parse(b0);
var same = H.Hex(Sl.Ov.Serialize(v));
var shortTail = H.Hex(Sl.Ov.Serialize(new Sl.Ov { Hdr = new Sl.Hdr { X = 1, Y = 2 }, Tail = new byte[] { 0x0a } }));
var json = H.Hex(Sl.Ov.Serialize(Sl.Ov.FromJson(Sl.Ov.ToJson(v))));
return $"{v.Hdr.X} {v.Hdr.Y} {H.Hex(v.Tail)} {same} {shortTail} {json}";`,
      expect: "1 2 0a0b0c0d 010002000a0b0c0d 010002000a000000 010002000a0b0c0d"
    },
    {
      name: "overlapping slices must agree; a rest field ends at the largest slice end",
      body: `var out_ = Sl.Two.Serialize(new Sl.Two { A = 0x11223344, B = 0x1122, C = 9 });
var p = Sl.Two.Parse(out_);
var bad = H.Err(() => Sl.Two.Serialize(new Sl.Two { A = 0x11223344, B = 0x9999, C = 9 }));
return $"{H.Hex(out_)} {p.A:x} {p.B:x} {p.C} [{bad}]";`,
      expect: "44332211000009 11223344 1122 9 [DERIVE ]"
    },
    {
      name: "views write slices",
      body: `var view = Sl.Ov.View(H.X("0100 0200 0a0b0c0d"));
view.Root.Hdr.Y = 7;
var a = H.Hex(view.Commit());
view.Root.Tail = new byte[] { 1, 2 };
return a + " " + H.Hex(view.Commit());`,
      expect: "010007000a0b0c0d 0100070001020000"
    }
  ],
  "layout groups": [
    {
      name: "layout groups place each element's items in order",
      body: `List<Gr.Vol> Vols() => new() { new Gr.Vol { A = new Gr.Leaf { V = 1 }, B = new Gr.Leaf { V = 2 } }, new Gr.Vol { A = new Gr.Leaf { V = 3 }, B = new Gr.Leaf { V = 4 } } };
var plain = H.Hex(Gr.Plain.Serialize(new Gr.Plain { Vols = Vols() }));
var flat = H.Hex(Gr.Flat.Serialize(new Gr.Flat { Vols = Vols() }));
var g = Gr.Grouped.Serialize(new Gr.Grouped { Vols = Vols() });
var p = Gr.Grouped.Parse(g);
return $"{plain} {flat} {H.Hex(g)} {p.Vols[1].A.V}{p.Vols[1].B.V}";`,
      expect: "020506070801020304 020705080602040103 020605080702010403 34"
    },
    {
      name: "layout groups apply their layers; nested paths and leftovers",
      body: `Gr.Leaf L(byte v) => new() { V = v };
var val = new Gr.Top { Vols = new() {
  new Gr.Vol2 { Pieces = new() { new Gr.Piece { P = L(1) }, new Gr.Piece { P = L(2) } }, C = L(3), D = L(4) },
  new Gr.Vol2 { Pieces = new() { new Gr.Piece { P = L(5) }, new Gr.Piece { P = L(6) } }, C = L(7), D = L(8) } } };
var out_ = Gr.Top.Serialize(val);
var p = Gr.Top.Parse(out_);
var view = Gr.Top.View(out_);
var rewrite = H.Hex(view.Commit(new Rt.CommitOptions { Rewrite = true })) == H.Hex(out_);
return $"{H.Hex(out_.AsSpan(8).ToArray())} {p.Vols[1].Pieces[1].P.V}{p.Vols[1].C.V} {rewrite}";`,
      expect: "0400010002000800050006" + "0307" + " 67 True"
    }
  ]
};

const XOR0 = `public sealed class Xor0 : global::Yaffle.Runtime.ICodec
{
    public byte[] Decode(System.ReadOnlyMemory<byte> input, global::Yaffle.Runtime.CodecContext ctx) => input.ToArray();
    public byte[] Encode(System.ReadOnlyMemory<byte> input, global::Yaffle.Runtime.CodecContext ctx) => input.ToArray();
}
`;

describeChecks("C# language features", {
  project: "features",
  files: () => [
    ...Object.entries(schemas).flatMap(([ns, src]) =>
      gen(irOf(src, `/memory/${ns}.yfl`), ns, { xor: "Xor0" })
    ),
    { path: "Helpers.cs", contents: HELPERS },
    { path: "Xor0.cs", contents: XOR0 }
  ],
  checks
});
