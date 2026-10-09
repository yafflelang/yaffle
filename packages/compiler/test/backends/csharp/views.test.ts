/**
 * Lazy views end to end: lazy reads, in-place patches, structural edits with sticky
 * layout and grow policies, async views over async sources, views over codec regions, async codecs.
 */
import { join } from "node:path";
import { CONF_EXTERNS, describeChecks, gen, irOf, type CheckSpec } from "./harness.ts";

const schemas: Record<string, string> = {
  Pf: `
    export struct Archive {
      @padUntil(0x80) {
        char tag[4] = "ARCV"
        u32  count
      }
      Entry entries[count]
    }
    struct Entry {
      u16 handler
      u16 kind
      u32 align
      u64 offset
      u32 size
      u32 reserved = 0
      u8  data[size] at offset @align(align)
    }
  `,
  Reg: `
    extern codec cnt
    struct Blob { u16 a  u16 b }
    export struct R {
      u8   n1
      Blob one @via(cnt) @size(n1)
      u8   n2
      Blob two @via(cnt) @size(n2)
    }
  `,
  Av: `
    extern async codec axor(u8 key)
    export struct A {
      u8 n
      u8 d[] @via(axor(1)) @size(n)
    }
  `,
  Pcs: `
    extern codec cnt
    struct Frag {
      u16 exp
      u16 comp
      u8  data[] @size(exp) @via(cnt) @size(comp) @hidden
    }
    struct Body {
      u32 x
      u8  mid[0x100]
      u32 y
      u8  rest[]
    }
    export struct F {
      u8   n
      Frag frags[n]
      Body body from frags[*].data
    }
  `,
  Rng: `
    extern codec xr @ranged
    struct Big {
      u32 a
      u8  mid[0x20000]
      u32 z
    }
    struct Hdr { u32 p  u32 q  u8 rest[] }
    export struct G {
      u32 n
      Big big @via(xr) @size(n)
      u8  raw[0x30000] @via(xr)
      Hdr hdr from raw
    }
  `,
  Lst: `
    export struct L {
      u8  n
      u16 items[n]
      str name
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
    public static Pf.Entry E(ushort handler, ushort kind, uint align, byte[] data) =>
        new() { Handler = handler, Kind = kind, Align = align, Data = data };

    public static byte[] Fill(int n, byte b) => Enumerable.Repeat(b, n).ToArray();

    public static byte[] Sample() => Pf.Archive.Serialize(new Pf.Archive
    {
        Entries = new()
        {
            E(0, 0, 0x100, Fill(0x180, 1)),
            E(0, 1, 0x100, Fill(0x40, 2)),
            E(0, 1, 0x100, Fill(0x100, 3)),
            E(0, 1, 0x100, Array.Empty<byte>())
        }
    });

    public static string Patches(IReadOnlyList<Rt.Patch> ps) => string.Join(" ", ps.Select(p => $"{p.At:x}:{p.Remove}:{p.Insert.Length}"));

    public static string Offsets(byte[] file) => string.Join(",", Pf.Archive.Parse(file).Entries.Select(e => e.Offset.ToString("x")));
}
`;

const checks: CheckSpec[] = [
  {
    name: "reads lazily and equals the parse result",
    body: `var bytes = H.Sample();
var v = Pf.Archive.View(bytes);
var r = v.Root;
var same = Rt.Json.Stringify(Pf.Archive.ToJson(r)) == Rt.Json.Stringify(Pf.Archive.ToJson(Pf.Archive.Parse(bytes)));
return $"{r.Count} {r.Tag} {r.Entries.Count} {r.Entries[1].Size:x} {r.Entries[1].Offset:x} {r.Entries[2].Data[0]} {same} {v.OffsetOf(r.Entries[0]):x} {v.SizeOf(r.Entries[1]):x}";`,
    expect: "4 ARCV 4 40 300 3 True 80 18"
  },
  {
    name: "only touches the bytes it needs",
    body: `var big = Pf.Archive.Serialize(new Pf.Archive { Entries = new() { H.E(0, 0, 0x100, H.Fill(0x80000, 5)), H.E(0, 1, 0x100, H.Fill(0x80000, 6)) } });
var src = new Rt.ArraySink(big);
var v = Pf.Archive.View(src);
var size = v.Root.Entries[1].Size;
var before = src.BytesRead;
var b = v.Root.Entries[1].Data[7];
return $"{size:x} {before <= 0x10000} {b} {src.BytesRead >= 0x80000}";`,
    expect: "80000 True 6 True"
  },
  {
    name: "errors carry the path of the field being read",
    body: `var bad = H.Sample();
bad[0x80 + 0x18 + 0x14] = 7;
var v = Pf.Archive.View(bad);
return v.Root.Entries[0].Size;`,
    expect: "!CHECK entries[1].reserved"
  },
  {
    name: "same-size scalar edits are patched in place",
    body: `var bytes = H.Sample();
var orig = (byte[])bytes.Clone();
var v = Pf.Archive.View(bytes);
v.Root.Entries[2].Handler = 0x200;
v.Root.Entries[0].Kind = 7;
var patches = H.Patches(v.Patches());
var out_ = v.Commit();
var p = Pf.Archive.Parse(out_);
return $"{patches} {orig.AsSpan().SequenceEqual(bytes)} {p.Entries[2].Handler:x} {p.Entries[0].Kind} {out_.Length == bytes.Length} {v.Root.Entries[2].Handler:x} [{H.Patches(v.Patches())}]";`,
    expect: "82:2:2 b0:2:2 True 200 7 True 200 []"
  },
  {
    name: "a structural scalar re-encodes but keeps data where it still fits",
    body: `var v = Pf.Archive.View(H.Sample());
v.Root.Entries[2].Align = 0x200;
var patches = H.Patches(v.Patches());
v.Root.Entries[1].Align = 0x200;
var out_ = v.Commit();
return patches + " " + H.Offsets(out_);`,
    expect: "b5:1:1 100,600,400,500"
  },
  {
    name: "derived fields cannot be set",
    body: `var v = Pf.Archive.View(H.Sample());
v.Root.Entries[0].Size = 5;
return v.Commit();`,
    expect: "!INPUT entries[0].size"
  },
  {
    name: "push: the table grows into padding, existing data stays",
    body: `var bytes = H.Sample();
var v = Pf.Archive.View(bytes);
v.Root.Entries.Add(H.E(0, 1, 0x100, new byte[] { 9, 9, 9 }));
var out_ = v.Commit();
var p = Pf.Archive.Parse(out_);
return $"{p.Count} {H.Offsets(out_)} {Convert.ToHexStringLower(p.Entries[4].Data)} {out_.AsSpan(0x100, 0x400).SequenceEqual(bytes.AsSpan(0x100, 0x400))}";`,
    expect: "5 100,300,400,500,500 090909 True"
  },
  {
    name: "a growing target moves to the end; splice shifts; error rejects",
    body: `var bytes = H.Sample();
var v = Pf.Archive.View(bytes);
v.Root.Entries[1].Data = H.Fill(0x50, 8);
var a = H.Offsets(Rt.Views.Apply(bytes, v.Patches()));
var v2 = Pf.Archive.View(bytes);
v2.Root.Entries[1].Data = H.Fill(0x150, 8);
var b = H.Offsets(v2.Commit(new Rt.CommitOptions { Grow = Rt.Grow.Splice }));
var v3 = Pf.Archive.View(bytes);
v3.Root.Entries[1].Data = new byte[0x150];
string c;
try { v3.Commit(new Rt.CommitOptions { Grow = Rt.Grow.Error }); c = "no error"; }
catch (Rt.YaffleException e) { c = e.Code.ToString(); }
return $"{a} {b} {c}";`,
    expect: "100,500,400,500 100,300,500,600 DERIVE"
  },
  {
    name: "remove elements",
    body: `var v = Pf.Archive.View(H.Sample());
v.Root.Entries.RemoveAt(1);
var p = Pf.Archive.Parse(v.Commit());
return $"{p.Count} {string.Join(",", p.Entries.Select(e => e.Size.ToString("x")))}";`,
    expect: "3 180,100,0"
  },
  {
    name: "set fields and replace a whole element",
    body: `var v = Pf.Archive.View(H.Sample());
v.Root.Entries[0].Handler = 3;
v.Root.Entries[0].Kind = 4;
v.Root.Entries[3] = H.E(1, 1, 0x10, new byte[] { 1, 2 });
var p = Pf.Archive.Parse(v.Commit());
return $"{p.Entries[0].Handler} {p.Entries[0].Kind} {p.Entries[3].Handler} {p.Entries[3].Align:x} {p.Entries[3].Size}";`,
    expect: "3 4 1 10 2"
  },
  {
    name: "commits write back to sink sources",
    body: `var src = new Rt.ArraySink(H.Sample());
var v = Pf.Archive.View(src);
v.Root.Entries[1].Kind = 9;
v.Commit();
return Pf.Archive.Parse(src.Bytes).Entries[1].Kind;`,
    expect: "9"
  },
  {
    name: "scalar lists: edits and growth",
    body: `var bytes = Lst.L.Serialize(new Lst.L { Items = new() { 1, 2, 3 }, Name = "ab" });
var v = Lst.L.View(bytes);
v.Root.Items[1] = 7;
var a = Convert.ToHexStringLower(v.Commit());
v.Root.Items.Add(5);
v.Root.Name = "xyz";
var b = Convert.ToHexStringLower(v.Commit());
return a + " " + b;`,
    expect: "03010007000300616200 04010007000300050078797a00"
  },
  {
    name: "async views: every access is awaited",
    body: `var src = Rt.Sources.OfAsync(H.Sample());
var av = Pf.Archive.ViewAsync(src);
var size = await av.GetAsync(r => r.Entries[1].Size);
var b = await av.GetAsync(r => r.Entries[2].Data[0]);
return $"{size:x} {b} {src.Reads > 0}";`,
    expect: "40 3 True"
  },
  {
    name: "async views: SetAsync and CommitAsync write back",
    body: `var src = Rt.Sources.OfAsync(H.Sample());
var av = Pf.Archive.ViewAsync(src);
await av.SetAsync(r => r.Entries[2].Handler = 0x55);
await av.CommitAsync();
var grow = Pf.Archive.ViewAsync(src);
await grow.SetAsync(r => r.Entries.Add(H.E(0, 1, 0x100, new byte[] { 4 })));
await grow.CommitAsync();
var p = Pf.Archive.Parse(src.Bytes);
return $"{p.Entries[2].Handler:x} {p.Count} {p.Entries[4].Data[0]}";`,
    expect: "55 5 4"
  },
  {
    name: "codec regions decode on access and reuse untouched bytes",
    body: `Cnt.Encodes = 0; Cnt.Decodes = 0;
var bytes = Reg.R.Serialize(new Reg.R { One = new Reg.Blob { A = 1, B = 2 }, Two = new Reg.Blob { A = 3, B = 4 } });
int enc0 = Cnt.Encodes;
var v = Reg.R.View(bytes);
var a = v.Root.One.A;
int d1 = Cnt.Decodes;
v.Root.Two.B = 7;
Cnt.Encodes = 0;
var out_ = v.Commit();
var p = Reg.R.Parse(out_);
return $"{enc0} {a} {d1} {Cnt.Encodes} {p.One.B} {p.Two.B} {out_.AsSpan(0, 5).SequenceEqual(bytes.AsSpan(0, 5))}";`,
    expect: "2 1 1 1 2 7 True"
  },
  {
    name: "streams decode only the pieces a read reaches",
    body: `var body = new Pcs.Body { X = 1, Mid = new byte[0x100], Y = 2, Rest = H.Fill(0x40, 9) };
var frags = new List<Pcs.Frag> { new() { Exp = 4 }, new() { Exp = 0x104 }, new() { Exp = 0x40 } };
var bytes = Pcs.F.Serialize(new Pcs.F { Frags = frags, Body = body });
Cnt.Decodes = 0;
var v = Pcs.F.View(bytes);
var x = v.Root.Body.X;
int d1 = Cnt.Decodes;
var y = v.Root.Body.Y;
int d2 = Cnt.Decodes;
var r = v.Root.Body.Rest[5];
int d3 = Cnt.Decodes;
var same = v.Commit().AsSpan().SequenceEqual(bytes);
return $"{x} {d1} {y} {d2} {r} {d3} {same}";`,
    expect: "1 2 2 2 9 3 True"
  },
  {
    name: "ranged codecs decode only the blocks a read reaches",
    body: `var g = new Rng.G { Big = new Rng.Big { A = 5, Mid = H.Fill(0x20000, 1), Z = 6 }, Hdr = new Rng.Hdr { P = 7, Q = 8, Rest = H.Fill(0x30000 - 8, 2) } };
var bytes = Rng.G.Serialize(g);
Xr.Bytes = 0;
var v = Rng.G.View(bytes);
var a = v.Root.Big.A;
long b1 = Xr.Bytes;
var z = v.Root.Big.Z;
long b2 = Xr.Bytes;
var p = v.Root.Hdr.P;
long b3 = Xr.Bytes;
var json = Rt.Json.Stringify(Rng.G.ToJson(v.Root)) == Rt.Json.Stringify(Rng.G.ToJson(Rng.G.Parse(bytes)));
var same = v.Commit().AsSpan().SequenceEqual(bytes);
return $"{a} {b1} {z} {b2} {p:x} {b3 - b2} {json} {same}";`,
    expect: "5 16392 6 16392 7 16384 True True"
  },
  {
    name: "async codecs: async views",
    body: `var bytes = await Av.A.SerializeAsync(new Av.A { D = new byte[] { 1, 2, 3 } });
var av = Av.A.ViewAsync(bytes);
var d = await av.GetAsync(r => Convert.ToHexStringLower(r.D));
return d + " " + Convert.ToHexStringLower(bytes);`,
    expect: "010203 03000302"
  }
];

const COUNTING_CODEC = `
using System;
using Yaffle.Runtime;

/// A codec that XORs with 0xff and counts encodes and decodes.
public sealed class Cnt : ICodec
{
    public static int Encodes;
    public static int Decodes;
    private static byte[] X(ReadOnlySpan<byte> s) { var o = s.ToArray(); for (int i = 0; i < o.Length; i++) o[i] ^= 0xff; return o; }
    public byte[] Decode(ReadOnlyMemory<byte> input, CodecContext ctx) { Decodes++; return X(input.Span); }
    public byte[] Encode(ReadOnlyMemory<byte> input, CodecContext ctx) { Encodes++; return X(input.Span); }
}

/// A ranged codec (XOR with the low byte of the position) that counts the bytes it decodes.
public sealed class Xr : ICodec
{
    public static long Bytes;
    private static byte[] X(ReadOnlySpan<byte> s, long pos) { var o = s.ToArray(); for (int i = 0; i < o.Length; i++) o[i] ^= (byte)(pos + i); return o; }
    public byte[] Decode(ReadOnlyMemory<byte> input, CodecContext ctx) { Bytes += input.Length; return X(input.Span, ctx.Position ?? 0); }
    public byte[] Encode(ReadOnlyMemory<byte> input, CodecContext ctx) => X(input.Span, ctx.Position ?? 0);
}
`;

describeChecks("C# views", {
  project: "views",
  files: () => [
    ...Object.entries(schemas).flatMap(([ns, src]) =>
      gen(irOf(src, `/memory/${ns}.yfl`), ns, {
        cnt: "cnt.cs",
        xr: "cnt.cs#Xr",
        axor: join(CONF_EXTERNS, "axor.cs")
      })
    ),
    { path: "Helpers.cs", contents: HELPERS },
    { path: "Cnt.cs", contents: COUNTING_CODEC }
  ],
  build: { compile: [join(CONF_EXTERNS, "axor.cs")] },
  checks
});
