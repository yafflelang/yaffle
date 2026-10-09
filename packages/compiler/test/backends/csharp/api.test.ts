/**
 * The generated C# API end to end: real .yfl compiled by the frontend, C# generated, built with
 * dotnet (warnings as errors) and run. One project holds every schema (one namespace each) and a
 * Program that runs the checks; each `it` asserts one check's printed result.
 */
import { join } from "node:path";
import { CONF_EXTERNS, describeChecks, gen, irOf, type CheckSpec } from "./harness.ts";

const schemas: Record<string, string> = {
  Basic: `
    export struct Table {
      u32   magic = 0x4c424154
      u16   count
      Entry entries[count]
      str   name
    }
    struct Entry { u8 a  i16be b }
  `,
  Opts: `
    export struct Hdr(u8 n) {
      char order[2] in ("II", "MM")
      @endian(order == "MM" ? be : le) { u16 v }
      u8 data[n]
    }
  `,
  Ptr: `
    export struct P {
      Node *a : u32 @nullable
      Node *b : u32 @nullable
    }
    struct Node { u8 v }
  `,
  Reuse: `
    extern codec cnt
    export struct C {
      u8 n
      u8 data[] @via(cnt) @size(n)
    }
  `,
  Async: `
    extern async codec axor(u8 key)
    export struct A {
      u8 n
      u8 d[] @via(axor(1)) @size(n)
    }
  `,
  Xform: `
    export struct O { u8 v as it % 10  u16 angle as it * 360.0 / 65536 }
  `,
  Enums: `
    enum Kind : u8 { Sys = 0, Gpu = 1 }
    enum Open : u8 @open { A = 1 }
    export struct E { Kind k  Open o }
  `,
  Unions: `
    struct Small { u8 tag = 1  u8 v }
    struct Big { u8 tag = 2  u16 v }
    union U { Small  Big }
    export struct H { U u }
  `,
  Strict: `
    export struct S { u8 a @padAfter(2) }
  `,
  Multi: `
    export struct M { u8 v  if (v == 1) { u8 x } else { u16 x } }
  `,
  Cond: `
    export struct V {
      u8 version
      if (version >= 3) { u32 extra } else { u16 legacy }
      switch (version) { case 1: u8 one  default: u8 other }
    }
  `
};

const checks: CheckSpec[] = [
  {
    name: "parse fields",
    body: `var t = Basic.Table.Parse(Convert.FromHexString("5441424c0200" + "01ff00" + "020001" + "686900"));
return $"{t.Count} {t.Entries[0].A} {t.Entries[0].B} {t.Entries[1].B} {t.Name}";`,
    expect: "2 1 -256 1 hi"
  },
  {
    name: "canonical json",
    body: `var t = Basic.Table.Parse(Convert.FromHexString("5441424c0100" + "010002" + "00"));
return Basic.Table.ToJson(t);`,
    expect: '{"magic":1279410516,"count":1,"entries":[{"a":1,"b":2}],"name":""}'
  },
  {
    name: "serialize derives the count",
    body: `var t = new Basic.Table { Entries = new() { new Basic.Entry { A = 1, B = 2 }, new Basic.Entry { A = 3, B = -1 } }, Name = "x" };
return Basic.Table.Serialize(t);`,
    expect: "5441424c0200010002" + "03ffff" + "7800"
  },
  {
    name: "fromJson round trip",
    body: `var t = Basic.Table.FromJson(JsonNode.Parse("{\\"entries\\":[{\\"a\\":9,\\"b\\":-2}],\\"name\\":\\"ok\\"}"));
return Basic.Table.Serialize(t);`,
    expect: "5441424c010009fffe6f6b00"
  },
  {
    name: "EOF path",
    body: `return Basic.Table.Parse(Convert.FromHexString("5441424c0200010002" + "03ff"));`,
    expect: "!EOF entries[1].b"
  },
  {
    name: "CHECK on a constant",
    body: `return Basic.Table.Parse(Convert.FromHexString("00000000000000"));`,
    expect: "!CHECK magic"
  },
  {
    name: "SafeParse",
    body: `var r = Basic.Table.SafeParse(new byte[] { 1 });
return $"{r.Ok} {r.Error!.Code} {r.Error.Offset}";`,
    expect: "False EOF 0"
  },
  {
    name: "missing input field",
    body: `return Basic.Table.Serialize(new Basic.Table { Name = "x" });`,
    expect: "!INPUT entries"
  },
  {
    name: "root parameters and endianness",
    body: `var h = Opts.Hdr.Parse(Convert.FromHexString("4d4d0102aabb"), new Opts.HdrOptions { N = 2 });
return $"{h.Order} {h.V:x} {Convert.ToHexStringLower(h.Data)} {Convert.ToHexStringLower(Opts.Hdr.Serialize(h, new Opts.HdrOptions { N = 2 }))}";`,
    expect: "MM 102 aabb 4d4d0102aabb"
  },
  {
    name: "missing root parameter",
    body: `return Opts.Hdr.Parse(Convert.FromHexString("49490000"));`,
    expect: "!INPUT n"
  },
  {
    name: "in check",
    body: `return Opts.Hdr.Parse(Convert.FromHexString("58580000"), new Opts.HdrOptions { N = 0 });`,
    expect: "!CHECK order"
  },
  {
    name: "shared targets are one object",
    body: `var p = Ptr.P.Parse(Convert.FromHexString("080000000800000005"));
return $"{ReferenceEquals(p.A, p.B)} {Rt.Json.Stringify(Ptr.P.ToJson(p))} {Convert.ToHexStringLower(Ptr.P.Serialize(p))}";`,
    expect: 'True {"a":{"v":5},"b":{"$ref":"/a"}} 080000000800000005'
  },
  {
    name: "null pointers",
    body: `var p = Ptr.P.Parse(Convert.FromHexString("0000000000000000"));
return $"{p.A is null} {Rt.Json.Stringify(Ptr.P.ToJson(p))}";`,
    expect: 'True {"a":null,"b":null}'
  },
  {
    name: "$ref restores identity",
    body: `var p = Ptr.P.FromJson(JsonNode.Parse("{\\"a\\":{\\"v\\":7},\\"b\\":{\\"$ref\\":\\"/a\\"}}"));
return $"{ReferenceEquals(p.A, p.B)} {Convert.ToHexStringLower(Ptr.P.Serialize(p))}";`,
    expect: "True 080000000800000007"
  },
  {
    name: "codec reuse when unchanged",
    body: `var c = Reuse.C.Parse(Convert.FromHexString("03fefdfc"));
Cnt.Encodes = 0;
var same = Convert.ToHexStringLower(Reuse.C.Serialize(c));
int n0 = Cnt.Encodes;
c.Data[0] = 9;
var changed = Convert.ToHexStringLower(Reuse.C.Serialize(c));
return $"{Convert.ToHexStringLower(c.Data)} {same} {n0} {changed} {Cnt.Encodes}";`,
    expect: "090203 03fefdfc 0 03f6fdfc 1"
  },
  {
    name: "async codecs: async API only",
    body: `var a = await Async.A.ParseAsync(Convert.FromHexString("03030201"));
var back = await Async.A.SerializeAsync(a);
return $"{Convert.ToHexStringLower(a.D)} {Convert.ToHexStringLower(back)} {typeof(Async.A).GetMethod("Parse") is null}";`,
    expect: "020300 03030201 True"
  },
  {
    name: "async sources",
    body: `var src = Rt.Sources.OfAsync(Convert.FromHexString("5441424c00000000"));
var t = await Basic.Table.ParseAsync(src);
return $"{t.Count} {src.Reads}";`,
    expect: "0 1"
  },
  {
    name: "one-way transforms keep the raw value",
    body: `var o = Xform.O.Parse(Convert.FromHexString("2a0040"));
var j = Xform.O.ToJson(o);
return $"{o.V} {o.VRaw} {o.Angle} {Rt.Json.Stringify(j)} {Convert.ToHexStringLower(Xform.O.Serialize(Xform.O.FromJson(j)))}";`,
    expect: '2 42 90 {"v":42,"angle":90} 2a0040'
  },
  {
    name: "float transform round trip check",
    body: `return Xform.O.Serialize(new Xform.O { VRaw = 1, Angle = 0.001 });`,
    expect: "0100" + "00"
  },
  {
    name: "closed enum on write",
    body: `return Enums.E.Serialize(new Enums.E { K = (Enums.Kind)7, O = Enums.Open.A });`,
    expect: "!CHECK k"
  },
  {
    name: "open enum passes unknown values",
    body: `var e = Enums.E.Parse(Convert.FromHexString("0109"));
return $"{e.K} {(byte)e.O} {Rt.Json.Stringify(Enums.E.ToJson(e))}";`,
    expect: 'Gpu 9 {"k":"Gpu","o":9}'
  },
  {
    name: "unknown enum is CHECK",
    body: `return Enums.E.Parse(Convert.FromHexString("0501"));`,
    expect: "!CHECK k"
  },
  {
    name: "unions pick the first matching variant",
    body: `var h = Unions.H.Parse(Convert.FromHexString("020100"));
return $"{h.U.Type} {Rt.Json.Stringify(Unions.H.ToJson(h))} {Convert.ToHexStringLower(Unions.H.Serialize(h))}";`,
    expect: 'Big {"u":{"type":"Big","value":{"tag":2,"v":1}}} 020100'
  },
  {
    name: "no union variant",
    body: `return Unions.H.Parse(Convert.FromHexString("0300"));`,
    expect: "!UNION u"
  },
  {
    name: "strict padding",
    body: `var lax = Unions.H.Parse(Convert.FromHexString("0105")).U.Type;
var s = Strict.S.Parse(Convert.FromHexString("01ffff"));
return lax + " " + s.A + " " + Strict.S.SafeParse(Convert.FromHexString("01ffff"), new Strict.SOptions { Strict = true }).Error!.Code;`,
    expect: "Small 1 CHECK"
  },
  {
    name: "conditional fields are nullable",
    body: `var a = Cond.V.Parse(Convert.FromHexString("030100000007"));
var b = Cond.V.Parse(Convert.FromHexString("01020001"));
return $"{a.Extra} {a.Legacy is null} {a.Other} {b.Legacy} {b.One} {Rt.Json.Stringify(Cond.V.ToJson(b))}";`,
    expect: '1 True 7 2 1 {"version":1,"legacy":2,"one":1}'
  },
  {
    name: "a field with a different type in each branch",
    body: `var a = Multi.M.Parse(Convert.FromHexString("0105"));
var b = Multi.M.Parse(Convert.FromHexString("020500"));
var c = Multi.M.FromJson(JsonNode.Parse("{\\"v\\":2,\\"x\\":300}"));
return $"{a.X!.GetType().Name} {Rt.Json.Stringify(Multi.M.ToJson(a))} {Rt.Json.Stringify(Multi.M.ToJson(b))} {Convert.ToHexStringLower(Multi.M.Serialize(c))} {Convert.ToHexStringLower(Multi.M.Serialize(new Multi.M { V = 1, X = 7 }))}";`,
    expect: 'Byte {"v":1,"x":5} {"v":2,"x":5} 022c01 0107'
  },
  {
    name: "missing field of the taken branch",
    body: `return Cond.V.Serialize(new Cond.V { Version = 4, Other = 1 });`,
    expect: "!INPUT extra"
  }
];

const COUNTING_CODEC = `
using System;
using Yaffle.Runtime;

/// A codec that XORs with 0xff and counts encodes (codec reuse tests).
public sealed class Cnt : ICodec
{
    public static int Encodes;
    private static byte[] X(ReadOnlySpan<byte> s) { var o = s.ToArray(); for (int i = 0; i < o.Length; i++) o[i] ^= 0xff; return o; }
    public byte[] Decode(ReadOnlyMemory<byte> input, CodecContext ctx) => X(input.Span);
    public byte[] Encode(ReadOnlyMemory<byte> input, CodecContext ctx) { Encodes++; return X(input.Span); }
}
`;

describeChecks("generated C# API", {
  project: "api",
  files: () => [
    ...Object.entries(schemas).flatMap(([ns, src]) =>
      gen(irOf(src, `/memory/${ns}.yfl`), ns, {
        cnt: "cnt.cs",
        axor: join(CONF_EXTERNS, "axor.cs")
      })
    ),
    { path: "Cnt.cs", contents: COUNTING_CODEC }
  ],
  build: { compile: [join(CONF_EXTERNS, "axor.cs")] },
  checks
});
