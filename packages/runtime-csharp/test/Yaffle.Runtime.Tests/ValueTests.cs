using System;
using System.Collections.Generic;
using System.Numerics;
using System.Text;
using Xunit;

namespace Yaffle.Runtime.Tests;

public class NumTests
{
    [Theory]
    [InlineData(7, 2, 3, 1)]
    [InlineData(-7, 2, -3, -1)]
    [InlineData(7, -2, -3, 1)]
    [InlineData(-7, -2, 3, -1)]
    public void DivisionTruncatesAndModTakesTheDividendsSign(long a, long b, long q, long r)
    {
        Assert.Equal(q, Num.Div(a, b));
        Assert.Equal(r, Num.Mod(a, b));
        Assert.Equal((Int128)q, Num.Div((Int128)a, b));
        Assert.Equal((BigInteger)r, Num.Mod((BigInteger)a, b));
    }

    [Fact]
    public void DivisionByZeroIsRange()
    {
        Assert.Equal(ErrorCode.RANGE, Assert.Throws<YaffleException>(() => Num.Div(1, 0)).Code);
        Assert.Equal(ErrorCode.RANGE, Assert.Throws<YaffleException>(() => Num.Mod((Int128)1, 0)).Code);
        Assert.Equal(long.MinValue, Num.Div(long.MinValue, 1));
    }

    [Fact]
    public void ShiftCountsAreChecked()
    {
        Assert.Equal(1L << 63, Num.Shl(1L, 63));
        Assert.Equal(-1L, Num.Shr(-8L, 3));
        Assert.Equal(ErrorCode.RANGE, Assert.Throws<YaffleException>(() => Num.Shl(1L, 64)).Code);
        Assert.Equal(ErrorCode.RANGE, Assert.Throws<YaffleException>(() => Num.Shr(1L, -1)).Code);
    }

    [Theory]
    [InlineData(2.5, 3)]
    [InlineData(-2.5, -3)]
    [InlineData(2.4999, 2)]
    [InlineData(-0.5, -1)]
    public void RoundsHalfAwayFromZero(double x, long r) => Assert.Equal(r, Num.Round(x));

    [Fact]
    public void RoundingNaNIsRange() =>
        Assert.Equal(ErrorCode.RANGE, Assert.Throws<YaffleException>(() => Num.Round(double.NaN)).Code);

    [Fact]
    public void CheckedConversions()
    {
        Assert.Equal((byte)255, Ck.U8(255L));
        Assert.Equal(ErrorCode.RANGE, Assert.Throws<YaffleException>(() => Ck.U8(256L)).Code);
        Assert.Equal(ErrorCode.RANGE, Assert.Throws<YaffleException>(() => Ck.I8(-129L)).Code);
        Assert.Equal(0xffffffUL, Ck.U24(0xffffffL));
        Assert.Equal(ErrorCode.RANGE, Assert.Throws<YaffleException>(() => Ck.U24(0x1000000L)).Code);
        Assert.Equal(ulong.MaxValue, Ck.U64((Int128)ulong.MaxValue));
        Assert.Equal(ErrorCode.RANGE, Assert.Throws<YaffleException>(() => Ck.U64((Int128)ulong.MaxValue + 1)).Code);
        Assert.Equal(-1L, Ck.I64((BigInteger)(-1)));
        Assert.Equal(ErrorCode.RANGE, Assert.Throws<YaffleException>(() => Ck.Len(-1L)).Code);
        Assert.Equal(0x7fUL, Ck.Bits(127, 7, false));
        Assert.Equal(ErrorCode.RANGE, Assert.Throws<YaffleException>(() => Ck.Bits(-1, 7, false)).Code);
        Assert.Equal(0x7fUL, Ck.Bits(-1, 7, true));
        Assert.Equal(ErrorCode.RANGE, Assert.Throws<YaffleException>(() => Ck.Bits(64, 7, true)).Code);
    }

    [Theory]
    [InlineData(1.0, 0x3c00)]
    [InlineData(-2.0, 0xc000)]
    [InlineData(65504.0, 0x7bff)]
    [InlineData(65520.0, 0x7c00)]
    [InlineData(5.960464477539063e-8, 0x0001)]
    [InlineData(0.0, 0x0000)]
    [InlineData(-0.0, 0x8000)]
    [InlineData(1.0009765625, 0x3c01)]
    [InlineData(1.00048828125, 0x3c00)]
    [InlineData(1.00146484375, 0x3c02)]
    public void HalfConversionsRoundToNearestEven(double v, int bits)
    {
        Assert.Equal((ushort)bits, HalfBits.FromDouble(v));
        if (bits != 0x7c00 && v != 1.00048828125 && v != 1.00146484375)
            Assert.Equal(BitConverter.DoubleToInt64Bits(v), BitConverter.DoubleToInt64Bits(HalfBits.ToDouble((ushort)bits)));
    }

    [Fact]
    public void HalfNaNIsCanonical()
    {
        Assert.Equal((ushort)0x7e00, HalfBits.FromDouble(double.NaN));
        Assert.True(double.IsNaN(HalfBits.ToDouble(0x7e01)));
        Assert.True(double.IsNegative(HalfBits.ToDouble(0x8000)));
    }

    [Fact]
    public void Aggregates()
    {
        Assert.Equal((Int128)6, Values.Sum(new List<byte> { 1, 2, 3 }));
        Assert.Equal((Int128)ulong.MaxValue * 2, Values.Sum(new List<ulong> { ulong.MaxValue, ulong.MaxValue }));
        Assert.Equal(3u, Values.MaxOf(new List<uint> { 1, 3, 2 }));
        Assert.Equal(ErrorCode.RANGE, Assert.Throws<YaffleException>(() => Values.MinOf(new List<uint>())).Code);
        Assert.Equal(new List<long> { 2, 0, 1 }, Values.Lengths(new List<List<int>?> { new() { 1, 2 }, null, new() { 3 } }));
        Assert.Equal(1L, Values.IndexOf(new List<string> { "a", "b" }, "b"));
        Assert.Equal(ErrorCode.INPUT, Assert.Throws<YaffleException>(() => Values.IndexOf(new List<string> { "a" }, "z")).Code);
        Assert.Equal(ErrorCode.RANGE, Assert.Throws<YaffleException>(() => Values.At(new List<int> { 1 }, 1)).Code);
    }

    [Fact]
    public void StructuralEquality()
    {
        Assert.True(Values.Eq((byte)5, 5L));
        Assert.True(Values.Eq(new byte[] { 1, 2 }, new byte[] { 1, 2 }));
        Assert.True(Values.Eq(new List<int> { 1 }, new List<long> { 1 }));
        Assert.False(Values.Eq("a", "b"));
        Assert.False(Values.Eq(1, null));
    }
}

public class StringTests
{
    [Fact]
    public void Utf8IsStrict()
    {
        var bad = new byte[] { 0xc3, 0x28 };
        var e = Assert.Throws<YaffleException>(() => Strings.Decode(bad, 0, 2, TextEncoding.Utf8, true, 10));
        Assert.Equal(ErrorCode.CHECK, e.Code);
        Assert.Equal(10, e.Offset);
        Assert.Equal("日本", Strings.Decode(Encoding.UTF8.GetBytes("日本"), 0, 6, TextEncoding.Utf8, true, 0));
    }

    [Fact]
    public void Utf16SurrogatesAndEndianness()
    {
        var s = "a\U0001F600";
        var le = Strings.Encode(s, TextEncoding.Utf16, true);
        var be = Strings.Encode(s, TextEncoding.Utf16, false);
        Assert.Equal(new byte[] { 0x61, 0, 0x3d, 0xd8, 0x00, 0xde }, le);
        Assert.Equal(s, Strings.Decode(be, 0, 3, TextEncoding.Utf16, false, 0));
        Assert.Equal(ErrorCode.CHECK, Assert.Throws<YaffleException>(() => Strings.Decode(new byte[] { 0x3d, 0xd8 }, 0, 1, TextEncoding.Utf16, true, 0)).Code);
        Assert.Equal(ErrorCode.INPUT, Assert.Throws<YaffleException>(() => Strings.Encode("\ud800", TextEncoding.Utf16, true)).Code);
        Assert.Equal(3L, Strings.CodeUnits(s, TextEncoding.Utf16));
        Assert.Equal(2L, Strings.CodeUnits(s, TextEncoding.Utf32));
        Assert.Equal(8L, Strings.EncodedBytes(s, TextEncoding.Utf32));
        Assert.Equal(5L, Strings.CodeUnits(s, TextEncoding.Utf8));
    }

    [Fact]
    public void Latin1AsciiAndNul()
    {
        Assert.Equal(new byte[] { 0xe9 }, Strings.Encode("é", TextEncoding.Latin1, true));
        Assert.Equal(ErrorCode.INPUT, Assert.Throws<YaffleException>(() => Strings.Encode("é", TextEncoding.Ascii, true)).Code);
        Assert.Equal(ErrorCode.INPUT, Assert.Throws<YaffleException>(() => Strings.Encode("a\0b", TextEncoding.Utf8, true)).Code);
        Assert.Equal(ErrorCode.CHECK, Assert.Throws<YaffleException>(() => Strings.Decode(new byte[] { 0x80 }, 0, 1, TextEncoding.Ascii, true, 0)).Code);
        Assert.Equal(ErrorCode.CHECK, Assert.Throws<YaffleException>(() => Strings.Decode(new byte[] { 0, 0xd8, 0, 0 }, 0, 1, TextEncoding.Utf32, true, 0)).Code);
        Assert.Equal(new byte[] { 0x61, 0, 0 }, Strings.EncodeFixed("a", 3, 1, TextEncoding.Utf8, true));
        Assert.Equal(ErrorCode.INPUT, Assert.Throws<YaffleException>(() => Strings.EncodeFixed("abcd", 3, 1, TextEncoding.Utf8, true)).Code);
    }
}

public class ChecksumTests
{
    [Fact]
    public void KnownVectors()
    {
        Assert.Equal(0xcbf43926u, Checksum.Crc32(Encoding.ASCII.GetBytes("123456789")));
        Assert.Equal(0x11e60398u, Checksum.Adler32(Encoding.ASCII.GetBytes("Wikipedia")));
        Assert.Equal(0u, Checksum.Crc32(Array.Empty<byte>()));
        Assert.Equal(1u, Checksum.Adler32(Array.Empty<byte>()));
        var big = new byte[100_000];
        for (int i = 0; i < big.Length; i++) big[i] = 0xff;
        Assert.Equal(Checksum.Adler32(big), Checksum.Adler32(big.AsSpan(50_000), Checksum.Adler32(big.AsSpan(0, 50_000))));
    }

    [Fact]
    public void Hex()
    {
        Assert.Equal("00ff10", Runtime.Hex.Encode(new byte[] { 0, 255, 16 }));
        Assert.Equal(new byte[] { 0xab, 0xcd }, Runtime.Hex.Decode("ab CD"));
        Assert.Equal(ErrorCode.INPUT, Assert.Throws<YaffleException>(() => Runtime.Hex.Decode("abc")).Code);
        Assert.Equal(ErrorCode.INPUT, Assert.Throws<YaffleException>(() => Runtime.Hex.Decode("zz")).Code);
    }
}

public class Leb128Tests
{
    [Theory]
    [InlineData(0UL, "00")]
    [InlineData(127UL, "7f")]
    [InlineData(128UL, "8001")]
    [InlineData(624485UL, "e58e26")]
    [InlineData(ulong.MaxValue, "ffffffffffffffffff01")]
    public void Unsigned(ulong v, string hex)
    {
        var b = Uleb128.Instance.Write(v, Array.Empty<object>());
        Assert.Equal(hex, Runtime.Hex.Encode(b));
        Assert.Equal(b.Length, Uleb128.Instance.Size(b, Array.Empty<object>()));
        Assert.Equal(v, Uleb128.Instance.Read(b, Array.Empty<object>()));
    }

    [Theory]
    [InlineData(0L, "00")]
    [InlineData(-1L, "7f")]
    [InlineData(63L, "3f")]
    [InlineData(64L, "c000")]
    [InlineData(-123456L, "c0bb78")]
    [InlineData(long.MinValue, "8080808080808080807f")]
    public void Signed(long v, string hex)
    {
        var b = Sleb128.Instance.Write(v, Array.Empty<object>());
        Assert.Equal(hex, Runtime.Hex.Encode(b));
        Assert.Equal(v, Sleb128.Instance.Read(b, Array.Empty<object>()));
    }

    [Fact]
    public void NeedsMoreBytes() => Assert.Null(Uleb128.Instance.Size(new byte[] { 0x80, 0x80 }, Array.Empty<object>()));
}
