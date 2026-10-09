using System;
using System.Collections.Generic;
using System.Text.Json.Nodes;
using Xunit;

namespace Yaffle.Runtime.Tests;

public class ReaderTests
{
    private static Reader R(string hex, bool strict = false) => new(Convert.FromHexString(hex), strict);

    [Fact]
    public void PrimitivesInBothByteOrders()
    {
        var r = R("0102030405060708");
        Assert.Equal((ushort)0x0201, r.U16(true));
        Assert.Equal((ushort)0x0304, r.U16(false));
        Assert.Equal(0x08070605u, r.U32(true));
        r = R("fffffe");
        Assert.Equal(-2, r.I24(false));
        r = R("0000803f0000000000000040");
        Assert.Equal(1.0f, r.F32(true));
        Assert.Equal(2.0, r.F64(true));
    }

    [Fact]
    public void SignExtensionOfOddWidths()
    {
        Assert.Equal(-1L, R("ffffffffff").I40(true));
        Assert.Equal(0xffffffffffUL, R("ffffffffff").U40(true));
        Assert.Equal(-2L, R("feffffffffffff").I56(true));
        Assert.Equal(0x00ffffffffffffUL, R("ffffffffffff00").U56(true));
    }

    [Fact]
    public void EofCarriesTheOffset()
    {
        var r = R("0102");
        r.U8();
        var e = Assert.Throws<YaffleException>(() => r.U16(true));
        Assert.Equal(ErrorCode.EOF, e.Code);
        Assert.Equal(1, e.Offset);
    }

    [Fact]
    public void CountsAndBytes()
    {
        var r = R("616263006465");
        Assert.Equal(new byte[] { 0x61, 0x62, 0x63 }, r.BytesUntil(0));
        Assert.Equal(ErrorCode.RANGE, Assert.Throws<YaffleException>(() => r.Count(-1L)).Code);
        Assert.Equal(ErrorCode.EOF, Assert.Throws<YaffleException>(() => r.Count(long.MaxValue, 8)).Code);
        Assert.Equal(ErrorCode.EOF, Assert.Throws<YaffleException>(() => r.Bytes(3)).Code);
        Assert.Equal(ErrorCode.EOF, Assert.Throws<YaffleException>(() => r.BytesUntil(0)).Code);
    }

    [Fact]
    public void Strings()
    {
        Assert.Equal("ab", R("6162000000").Str(5, 1, TextEncoding.Utf8, true));
        Assert.Equal("hi", R("680069000000").StrUntil(2, TextEncoding.Utf16, true));
        var r = R("6100");
        Assert.Equal("a", r.StrRest(1, TextEncoding.Latin1, true));
        Assert.Equal(2, r.Pos);
    }

    [Fact]
    public void StrictPaddingAndAlignment()
    {
        var r = R("01cccc02", strict: true);
        r.U8();
        r.Pad(2, Fill.Of(0xcc), true);
        Assert.Equal((byte)2, r.U8());
        r = R("010000ff02", strict: true);
        r.U8();
        var e = Assert.Throws<YaffleException>(() => r.Align(4, Fill.Zero, true));
        Assert.Equal(ErrorCode.CHECK, e.Code);
        Assert.Equal(3, e.Offset);
        r = R("01000000");
        r.U8();
        r.Align(4, new Fill(i => i), false);
        Assert.Equal(4, r.Pos);
    }

    [Fact]
    public void WindowsAndPadUntil()
    {
        var r = R("0102000003");
        int saved = r.Window(4);
        Assert.Equal((ushort)0x0201, r.U16(true));
        r.CloseWindow(saved, true);
        Assert.Equal((byte)3, r.U8());
        r = R("010203");
        int start = r.Pos;
        r.U16(true);
        Assert.Equal(ErrorCode.CHECK, Assert.Throws<YaffleException>(() => r.PadUntil(start, 1, Fill.Zero, false)).Code);
    }

    private sealed class Node
    {
        public byte V;
        public Node? Next;
    }

    [Fact]
    public void TargetsShareIdentityAndAllowCycles()
    {
        // Two nodes pointing at each other: 0 → 2 → 0.
        var r = R("0102" + "0200");
        Node ReadNode()
        {
            var n = r.TakeInto<Node>() ?? new Node();
            n.V = r.U8();
            byte p = r.U8();
            n.Next = r.TargetStruct<Node>(p, "Node", ReadNode);
            return n;
        }
        var a = r.TargetStruct<Node>(0, "Node", ReadNode);
        Assert.Same(a, a.Next!.Next);
        Assert.Equal((byte)2, a.Next!.V);
        Assert.Equal(ErrorCode.EOF, Assert.Throws<YaffleException>(() => r.Target<byte>(100, "u8", () => r.U8())).Code);
    }

    [Fact]
    public void UnionsTryEachVariant()
    {
        var r = R("0203");
        var u = r.Union(("A", () => r.U8() == 1 ? (object?)1 : throw new YaffleException(ErrorCode.CHECK, "not 1")), ("B", () => (object?)r.U16(true)));
        Assert.Equal("B", u.Type);
        Assert.Equal((ushort)0x0302, u.Value);
        r = R("02");
        var e = Assert.Throws<YaffleException>(() => r.Union(("A", () => (object?)r.U16(true))));
        Assert.Equal(ErrorCode.UNION, e.Code);
        Assert.Equal("A", e.Causes![0].Path[0]);
    }

    [Fact]
    public void ExternTypesProbeForTheirSize()
    {
        var r = R("e58e2601");
        Assert.Equal(624485UL, r.Extern(Uleb128.Instance, Array.Empty<object>()));
        Assert.Equal((byte)1, r.U8());
        Assert.Equal(ErrorCode.EOF, Assert.Throws<YaffleException>(() => R("8080").Extern(Uleb128.Instance, Array.Empty<object>())).Code);
    }
}

public class WriterTests
{
    [Fact]
    public void PrimitivesAndChecks()
    {
        var b = Writer.EncodeWith(w =>
        {
            w.U16(0x0102, false);
            w.I24(-2, true);
            w.F32(float.NaN, true);
            w.F16(1.0, true);
        });
        Assert.Equal("0102feffff0000c07f003c", Convert.ToHexStringLower(b));
        Assert.Equal(ErrorCode.RANGE, Assert.Throws<YaffleException>(() => Writer.EncodeWith(w => w.U24(0x1000000, true))).Code);
        Assert.Equal(ErrorCode.DERIVE, Assert.Throws<YaffleException>(() => Writer.EncodeWith(w => w.BytesN(new byte[2], 3))).Code);
        Assert.Equal(ErrorCode.INPUT, Assert.Throws<YaffleException>(() => Writer.EncodeWith(w => w.BytesUntil(new byte[] { 0 }, 0))).Code);
        Assert.Equal(ErrorCode.INPUT, Assert.Throws<YaffleException>(() => Writer.EncodeWith(w => w.Str("abcd", 1, TextEncoding.Utf8, true, StrMode.Count, 3))).Code);
    }

    [Fact]
    public void PointersAreFixedUpAfterLayout()
    {
        // A u8 header, then a u32 pointer to a 2-byte target aligned to 4.
        var target = new object();
        var bytes = Writer.SerializeRoot(null, w =>
        {
            w.U8(0xaa);
            var p = w.Target(target, "T", "t", () =>
            {
                w.Align(4, Fill.Zero);
                w.U16(0xbeef, true);
                return null;
            });
            // Same object, same key: shared.
            Assert.Same(p, w.Target(target, "T", "t", () => null));
            w.Pointer(Prim.U32, true, p, false, null);
            w.Pointer(Prim.U32, true, null, false, 0);
            return null;
        });
        Assert.Equal("aa0c00000000000000000000efbe", Convert.ToHexStringLower(bytes));
    }

    [Fact]
    public void FixedPlacementsOverlap()
    {
        var e = Assert.Throws<YaffleException>(() => Writer.SerializeRoot(null, w =>
        {
            w.U32(0, true);
            w.Place("a", null, () =>
            {
                w.U16(1, true);
                return null;
            }, new PlaceOptions { Fixed = 2 });
            return null;
        }));
        Assert.Equal(ErrorCode.OVERLAP, e.Code);
    }

    [Fact]
    public void ConstraintsAndLayoutItems()
    {
        LEntry? Two(Writer w, string name, byte v, PlaceOptions? o = null)
        {
            return w.Place(name, null, () =>
            {
                w.U8(v);
                return null;
            }, o);
        }
        var bytes = Writer.SerializeRoot(new[] { new LayoutItem(new[] { "b" }), new LayoutItem(new[] { "a" }, LayoutLayer.Align(4)) }, w =>
        {
            w.U8(0xff);
            var s = new LStruct(new[] { new LayoutItem(new[] { "b" }), new LayoutItem(new[] { "a" }, LayoutLayer.Align(4)) });
            s.Set("a", Two(w, "a", 1));
            s.Set("b", Two(w, "b", 2, new PlaceOptions { Constraint = (2, 0) }));
            return s;
        });
        // b first (≡ 0 mod 2: offset 2), then a aligned to 4.
        Assert.Equal("ff00020001", Convert.ToHexStringLower(bytes));
    }

    [Fact]
    public void InstanceLayoutsReadFields()
    {
        // The root's layout is built by its instance (Layouts.Instance), here aligning `a` to 8.
        byte[] Write(long align) => Writer.SerializeRoot(Layouts.Instance, w =>
        {
            w.U8(0xff);
            var s = new LStruct();
            s.Set("a", w.Place("a", null, () =>
            {
                w.U8(1);
                return null;
            }));
            s.Layout = new[] { new LayoutItem(new[] { "a" }, LayoutLayer.Align(align)) };
            return s;
        });
        Assert.Equal("ff0000000000000001", Convert.ToHexStringLower(Write(8)));
        Assert.Equal("ff01", Convert.ToHexStringLower(Write(1)));
        // An alignment below 1 (and a negative padding) is RANGE.
        Assert.Equal(ErrorCode.RANGE, Assert.Throws<YaffleException>(() => Write(0)).Code);
        Assert.Equal(ErrorCode.RANGE, Assert.Throws<YaffleException>(() => LayoutLayer.AlignAt(-4, 0, false)).Code);
        Assert.Equal(ErrorCode.RANGE, Assert.Throws<YaffleException>(() => LayoutLayer.AlignEnd(0)).Code);
        Assert.Equal(ErrorCode.RANGE, Assert.Throws<YaffleException>(() => LayoutLayer.PadAfter(-1)).Code);
        Assert.Equal(ErrorCode.RANGE, Assert.Throws<YaffleException>(() => Writer.EncodeWith(w => w.RegionAlignEnd(0, false, 0))).Code);
    }

    [Fact]
    public void FixupsReportTheirPath()
    {
        var e = Assert.Throws<YaffleException>(() => Writer.SerializeRoot(null, w =>
        {
            string f = "size";
            w.Enter(() => new object[] { f });
            w.DeferInt(Prim.U8, true, () => 300);
            w.Leave();
            return null;
        }));
        Assert.Equal(ErrorCode.RANGE, e.Code);
        Assert.Equal(new object[] { "size" }, e.Path);
    }

    [Fact]
    public void RefPointersResolveToEqualEncodings()
    {
        var bytes = Writer.SerializeRoot(null, w =>
        {
            int s = w.Offset;
            w.Str("hi", 1, TextEncoding.Utf8, true, StrMode.Until);
            w.RefSite("str", s, "hi");
            w.RefPointer(Prim.U8, true, "str", "hi", () => new byte[] { 0x68, 0x69, 0 }, false, null);
            return null;
        });
        Assert.Equal("68690000", Convert.ToHexStringLower(bytes));
        var e = Assert.Throws<YaffleException>(() => Writer.SerializeRoot(null, w =>
        {
            w.RefPointer(Prim.U8, true, "str", "zz", () => new byte[] { 0x7a, 0x7a, 0 }, false, null);
            return null;
        }));
        Assert.Equal(ErrorCode.REF, e.Code);
    }
}

public class CodecTests
{
    [Fact]
    public void ReuseNeedsUnchangedContent()
    {
        var value = new byte[] { 1, 2, 3 };
        Codecs.Remember(value, "slot", new byte[] { 9, 9 }, new byte[] { 1, 2, 3 });
        Assert.Equal(new byte[] { 9, 9 }, Codecs.Reuse(value, "slot", new byte[] { 1, 2, 3 })!.Value.ToArray());
        Assert.Null(Codecs.Reuse(value, "slot", new byte[] { 1, 2, 4 }));
        Assert.Null(Codecs.Reuse(value, "other", new byte[] { 1, 2, 3 }));
        Assert.Null(Codecs.Reuse(new byte[] { 1, 2, 3 }, "slot", new byte[] { 1, 2, 3 }));
    }

    [Fact]
    public void StreamsJoinAndSplit()
    {
        var joined = Codecs.Join(new List<byte[]> { new byte[] { 1 }, new byte[] { 2, 3 } });
        Assert.Equal(new byte[] { 1, 2, 3 }, joined);
        Assert.Equal(2, Codecs.SplitBySizes(joined, new long[] { 1, 2 }).Count);
        Assert.Equal(ErrorCode.DERIVE, Assert.Throws<YaffleException>(() => Codecs.SplitBySizes(joined, new long[] { 1 })).Code);
        Assert.Equal(ErrorCode.EOF, Assert.Throws<YaffleException>(() => Codecs.Slice(joined, 2, 5)).Code);
    }

    private sealed class Piece
    {
        public byte[]? Data;
        public long? Size;
    }

    [Fact]
    public void FitSplitsWherePiecesFit()
    {
        var data = new byte[10];
        var pieces = StreamSplit.Split<Piece>(null, data, p => p.Data, (p, d) => p.Data = d, p => p.Size, p => p.Size = null,
            () => new Piece(), p => new Piece { Data = p.Data, Size = p.Size }, k => k * 4, p => p.Data!.Length + 1);
        Assert.Equal(new[] { 3, 3, 3, 1 }, pieces.ConvertAll(p => p.Data!.Length).ToArray());
        var given = new List<Piece> { new() { Size = 6 }, new() { Size = 4 } };
        var bySize = StreamSplit.Split(given, data, p => p.Data, (p, d) => p.Data = d, p => p.Size, null,
            () => new Piece(), p => new Piece { Data = p.Data, Size = p.Size }, null, null);
        Assert.Equal(6, bySize[0].Data!.Length);
    }

    private sealed class Failing : ICodec
    {
        public byte[] Decode(ReadOnlyMemory<byte> input, CodecContext ctx) => throw new InvalidOperationException("boom");
        public byte[] Encode(ReadOnlyMemory<byte> input, CodecContext ctx) => throw new InvalidOperationException("boom");
    }

    [Fact]
    public void HostFailuresAreCodecErrors()
    {
        var e = Assert.Throws<YaffleException>(() => Codecs.Decode(new Failing(), "f", new byte[1], new CodecContext(Array.Empty<object>()), false, 7));
        Assert.Equal(ErrorCode.CODEC, e.Code);
        Assert.Equal(7, e.Offset);
        Assert.Equal(ErrorCode.CODEC, Assert.Throws<YaffleException>(() => Check.Host<int>(() => throw new Exception("x"), "fn")).Code);
    }
}

public class JsonTests
{
    [Fact]
    public void Numbers()
    {
        Assert.Equal("\"NaN\"", Json.FloatJson(double.NaN).ToJsonString());
        Assert.Equal("\"-0\"", Json.FloatJson(-0.0).ToJsonString());
        Assert.Equal("\"-Infinity\"", Json.FloatJson(double.NegativeInfinity).ToJsonString());
        Assert.Equal(0.10000000149011612, Json.Float(JsonNode.Parse(Json.Stringify(Json.FloatJson(0.1f)))));
        Assert.Equal(-0.0, Json.Float(JsonValue.Create("-0")));
        Assert.Equal(ErrorCode.RANGE, Assert.Throws<YaffleException>(() => Json.Int(JsonNode.Parse("1.5"))).Code);
        Assert.Equal(ErrorCode.INPUT, Assert.Throws<YaffleException>(() => Json.Int(JsonNode.Parse("\"1\""))).Code);
        Assert.Equal((Int128)ulong.MaxValue, Json.Big(JsonNode.Parse("\"18446744073709551615\"")));
        Assert.Equal(ErrorCode.INPUT, Assert.Throws<YaffleException>(() => Json.Big(JsonNode.Parse("5"))).Code);
        Assert.Equal("\"18446744073709551615\"", Json.BigStr(ulong.MaxValue).ToJsonString());
    }

    [Fact]
    public void RefsPointAtTheFirstOccurrence()
    {
        var c = new ToJsonCtx();
        var shared = new object();
        Assert.Null(c.Ref(shared, JPath.Root.Field("a").Index(1)));
        Assert.Equal("{\"$ref\":\"/a/1\"}", c.Ref(shared, JPath.Root.Field("b"))!.ToJsonString());
        Assert.Null(c.Ref(new List<int>(), JPath.Root.Field("e")));
        Assert.Equal("/x~1y/~0", JPath.Root.Field("x/y").Field("~").ToString());
    }

    [Fact]
    public void DanglingRefsAreInput()
    {
        var doc = JsonNode.Parse("{\"a\":{\"$ref\":\"/nowhere\"}}");
        var c = new FromJsonCtx(doc);
        Assert.True(c.HasRefs);
        Assert.Equal(ErrorCode.INPUT, Assert.Throws<YaffleException>(() => c.Deref(doc!["a"], out _)).Code);
    }

    [Fact]
    public void WriterHandlesLargeStringsAndSurrogates()
    {
        var big = new string('a', 200_000_000);
        var s = Json.Stringify(new JsonObject { ["x"] = big, ["y"] = "\"\n\ud800" });
        Assert.Equal(200_000_000 + 25, s.Length);
        Assert.EndsWith("\"y\":\"\\\"\\n\\ud800\"}", s);
    }
}
