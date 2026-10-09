/**
 * Layout items that read fields (docs/IR.md §4.4) end to end in C#: arguments are evaluated in the
 * owning struct's write context (fields, parameters, `$index`), through paths, groups and nested
 * bases, with an alignment below 1 a RANGE error, and in view commits.
 */
import { describeChecks, gen, irOf, type CheckSpec } from "./harness.ts";

const SCHEMA = `
  struct Entry {
    u8 align
    u8 size
    u8 offset
    u8 data[size] at offset
    layout { data @align(align) }
  }
  export struct Pack {
    u8    n
    Entry entries[n]
  }
  struct Blk @base {
    u8 a
    u8 o
    u8 d[2] at o
    layout { d @align(a) }
  }
  export struct Based { u8 pre  Blk blk }
  struct Leaf { u8 v }
  struct Piece { Leaf *p : u8 }
  struct Vol { Piece pieces[2]  Leaf *d : u8 }
  export struct Top {
    u8  al
    Vol vols[2]
    layout { vols[*] @align(al + 1) { d  pieces[*].p } }
  }
  struct Inner(u8 k) {
    u8 o
    u8 d[1] at o
    layout { d @align(k) }
  }
  export struct WithParam {
    u8       k
    Inner(k) inner
  }
  struct Ix {
    u8 o
    u8 d[1] at o
    layout { d @align(1 << $index) }
  }
  export struct Indexed { Ix xs[3] }
  export struct Offs {
    u8 n
    u8 o
    u8 d[1] at o
    layout { d @align(4, offset: n) }
  }
`;

const HELPERS = `
using System;
using System.Collections.Generic;
using System.Linq;
using Rt = global::Yaffle.Runtime;

public static class H
{
    public static string Hex(byte[] b) => Convert.ToHexStringLower(b);
    public static string Err(Action a)
    {
        try { a(); return "no error"; }
        catch (Rt.YaffleException e) { return e.Code + " " + Rt.YaffleException.FormatPath(e.Path); }
    }
    public static Lf.Entry E(byte align, params byte[] data) => new() { Align = align, Data = data };
    public static byte[] Pack() => Lf.Pack.Serialize(new Lf.Pack { Entries = new() { E(4, 0xaa), E(8, 0xbb, 0xcc) } });
    public static string Offsets(byte[] b) => string.Join(",", Lf.Pack.Parse(b).Entries.Select(e => e.Offset.ToString("x")));
}
`;

const checks: CheckSpec[] = [
  {
    name: "each instance is aligned by its own field",
    body: `var b = H.Pack();
var e = H.Err(() => Lf.Pack.Serialize(new Lf.Pack { Entries = new() { H.E(4, 1), H.E(0, 2) } }));
return $"{H.Hex(b)} {H.Hex(Lf.Pack.Serialize(Lf.Pack.Parse(b)))} [{e}]";`,
    expect:
      "02040108080210" +
      "00aa00000000000000bbcc" +
      " 02040108080210" +
      "00aa00000000000000bbcc" +
      " [RANGE entries[1]]"
  },
  {
    name: "a nested base's layout reads its own field",
    body: `Lf.Based B(byte a) => new() { Pre = 9, Blk = new Lf.Blk { A = a, D = new byte[] { 1, 2 } } };
var b4 = Lf.Based.Serialize(B(4));
var view = H.Hex(Lf.Based.View(b4).Commit(new Rt.CommitOptions { Rewrite = true }));
return $"{H.Hex(b4)} {H.Hex(Lf.Based.Serialize(B(1)))} {view} [{H.Err(() => Lf.Based.Serialize(B(0)))}]";`,
    expect: "09040400000102 0901020102 09040400000102 [RANGE blk]"
  },
  {
    name: "a group's layers are evaluated in the owning struct",
    body: `Lf.Leaf L(byte v) => new() { V = v };
Lf.Top T(byte al) => new() { Al = al, Vols = new() {
  new Lf.Vol { Pieces = new() { new Lf.Piece { P = L(1) }, new Lf.Piece { P = L(2) } }, D = L(3) },
  new Lf.Vol { Pieces = new() { new Lf.Piece { P = L(4) }, new Lf.Piece { P = L(5) } }, D = L(6) } } };
var a = Lf.Top.Serialize(T(1));
var p = Lf.Top.Parse(a);
return $"{H.Hex(a)} {H.Hex(Lf.Top.Serialize(T(0)))} {p.Vols[1].Pieces[0].P.V}{p.Vols[0].D.V}";`,
    expect:
      "010a0c0810120e" + "0003000100020006000400" + "05" + " 0008090" + "70b0c0a030102060405 43"
  },
  {
    name: "parameters and $index",
    body: `var w = Lf.WithParam.Serialize(new Lf.WithParam { K = 4, Inner = new Lf.Inner { D = new byte[] { 7 } } });
var e = H.Err(() => Lf.WithParam.Serialize(new Lf.WithParam { K = 0, Inner = new Lf.Inner { D = new byte[] { 7 } } }));
Lf.Ix X(byte d) => new() { D = new byte[] { d } };
var ix = Lf.Indexed.Serialize(new Lf.Indexed { Xs = new() { X(0xaa), X(0xbb), X(0xcc) } });
return $"{H.Hex(w)} [{e}] {H.Hex(ix)}";`,
    expect: "0404000007 [RANGE inner] 030408aabb000000cc"
  },
  {
    name: "an alignment offset read from a field",
    body: `Lf.Offs O(byte n) => new() { N = n, D = new byte[] { 0xdd } };
return $"{H.Hex(Lf.Offs.Serialize(O(1)))} {H.Hex(Lf.Offs.Serialize(O(3)))}";`,
    expect: "010300dd 0305000000dd"
  },
  {
    name: "views: editing a field a layout item reads realigns its target",
    body: `var b = H.Pack();
var rewrite = H.Hex(Lf.Pack.View(b).Commit(new Rt.CommitOptions { Rewrite = true })) == H.Hex(b);
var v = Lf.Pack.View(b);
v.Root.Entries[0].Align = 16;
var moved = H.Offsets(v.Commit());
var v2 = Lf.Pack.View(b);
v2.Root.Entries[0].Align = 16;
var spliced = H.Offsets(v2.Commit(new Rt.CommitOptions { Grow = Rt.Grow.Splice }));
var v3 = Lf.Pack.View(b);
v3.Root.Entries[1].Align = 2;
var kept = H.Offsets(v3.Commit());
var v4 = Lf.Pack.View(b);
v4.Root.Entries[0].Align = 0;
return $"{rewrite} {moved} {spliced} {kept} [{H.Err(() => v4.Commit())}]";`,
    expect: "True 20,10 10,18 8,10 [RANGE entries[0]]"
  }
];

describeChecks("C# layout items that read fields", {
  project: "layout-fields",
  files: () => [
    ...gen(irOf(SCHEMA, "/memory/Lf.yfl"), "Lf"),
    { path: "Helpers.cs", contents: HELPERS }
  ],
  checks
});
