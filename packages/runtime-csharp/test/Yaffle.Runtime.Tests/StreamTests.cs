using System;
using System.Collections.Generic;
using Xunit;

namespace Yaffle.Runtime.Tests;

/// <summary>Lazy stores of views: ranged codec regions, windows, pieces joined into streams.</summary>
public class StreamTests
{
    private static byte[] Data(int n)
    {
        var b = new byte[n];
        for (int i = 0; i < n; i++) b[i] = (byte)(i * 13 + i / 256);
        return b;
    }

    /// <summary>XOR with the low byte of the position (a ranged codec); counts decoded bytes.</summary>
    private sealed class PosXor : ICodec
    {
        public long Decoded;

        private static byte[] X(ReadOnlySpan<byte> s, long pos)
        {
            var o = s.ToArray();
            for (int i = 0; i < o.Length; i++) o[i] ^= (byte)(pos + i);
            return o;
        }

        public byte[] Decode(ReadOnlyMemory<byte> input, CodecContext ctx)
        {
            Decoded += input.Length;
            return X(input.Span, ctx.Position ?? 0);
        }

        public byte[] Encode(ReadOnlyMemory<byte> input, CodecContext ctx) => X(input.Span, ctx.Position ?? 0);
    }

    [Fact]
    public void RangedRegionsDecodeOnlyTheBlocksRead()
    {
        var plain = Data(0x11000);
        var codec = new PosXor();
        var file = new byte[0x20 + plain.Length];
        codec.Encode(plain, new CodecContext(Array.Empty<object>())).CopyTo(file, 0x20);
        var store = new RangedCodecStore(new ArrayStore(file), 0x20, file.Length, codec, "posxor", new CodecContext(Array.Empty<object>()));
        Assert.Equal(plain.Length, store.Size);
        Assert.Equal(plain.AsSpan(0x10, 8).ToArray(), store.Get(0x10, 8).ToArray());
        Assert.Equal(RangedCodecStore.BlockSize, codec.Decoded);
        Assert.Equal(plain.AsSpan(0x10ff0, 0x10).ToArray(), store.Get(0x10ff0, 0x10).ToArray());
        Assert.Equal(RangedCodecStore.BlockSize + 0x1000, codec.Decoded);
        // Across blocks.
        Assert.Equal(plain.AsSpan(0x3ff8, 0x10).ToArray(), store.Get(0x3ff8, 0x10).ToArray());
        Assert.Equal(2, store.Extent(RangedCodecStore.BlockSize - 2));
        Assert.Equal(ErrorCode.EOF, Assert.Throws<YaffleException>(() => store.Get(plain.Length - 4, 8)).Code);
    }

    [Fact]
    public void PiecesOpenOnlyWhenReached()
    {
        var a = Data(10);
        var b = Data(0x30);
        var opened = new List<int>();
        var store = new PieceStore(new List<(long, Func<ByteStore>)>
        {
            (a.Length, () => { opened.Add(0); return new ArrayStore(a); }),
            (0, () => { opened.Add(1); return new ArrayStore(Array.Empty<byte>()); }),
            (b.Length, () => { opened.Add(2); return new ArrayStore(b); })
        });
        Assert.Equal(a.Length + b.Length, store.Size);
        Assert.Equal(a.AsSpan(2, 4).ToArray(), store.Get(2, 4).ToArray());
        Assert.Equal(new[] { 0 }, opened);
        Assert.Equal(8, store.Extent(2));
        Assert.Equal(b.AsSpan(0, 4).ToArray(), store.Get(10, 4).ToArray());
        Assert.Equal(new[] { 0, 2 }, opened);
        var across = store.Get(8, 4).ToArray();
        Assert.Equal(new[] { a[8], a[9], b[0], b[1] }, across);
        Assert.Equal(new[] { 0, 2 }, opened);
    }

    [Fact]
    public void PiecesWithTheWrongLengthAreErrors()
    {
        var store = new PieceStore(new List<(long, Func<ByteStore>)> { (4, () => new ArrayStore(new byte[3])) });
        Assert.Equal(ErrorCode.EOF, Assert.Throws<YaffleException>(() => store.Get(0, 1)).Code);
    }

    [Fact]
    public void SlicesAreWindows()
    {
        var data = Data(0x100);
        var s = SliceStore.Of(new ArrayStore(data), 0x10, 0x20);
        Assert.Equal(0x20, s.Size);
        Assert.Equal(data.AsSpan(0x18, 4).ToArray(), s.Get(8, 4).ToArray());
        Assert.Equal(ErrorCode.EOF, Assert.Throws<YaffleException>(() => s.Get(0x1e, 4)).Code);
        Assert.Equal(ErrorCode.EOF, Assert.Throws<YaffleException>(() => SliceStore.Of(new ArrayStore(data), 0xf0, 0x20)).Code);
        var whole = new ArrayStore(data);
        Assert.Same(whole, SliceStore.Of(whole, 0, data.Length));
    }

    [Fact]
    public void ReadersStopTheirWindowAtPieceEnds()
    {
        var opened = 0;
        var store = new PieceStore(new List<(long, Func<ByteStore>)>
        {
            (4, () => { opened++; return new ArrayStore(new byte[] { 1, 0, 0, 0 }); }),
            (4, () => { opened++; return new ArrayStore(new byte[] { 2, 0, 0, 0 }); })
        });
        var r = new Reader(store);
        Assert.Equal(1u, r.U32(true));
        Assert.Equal(1, opened);
        Assert.Equal(2u, r.U32(true));
        Assert.Equal(2, opened);
    }

    [Fact]
    public void LazyCodecOriginsReuseWithoutDecodingEagerly()
    {
        var value = new object();
        int decodes = 0;
        Codecs.RememberLazy(value, "s#0", () => new byte[] { 9, 9 }, () => { decodes++; return new byte[] { 1, 2 }; }, 2);
        Assert.Equal(0, decodes);
        Assert.Null(Codecs.Reuse(value, "s#0", new byte[] { 1, 2, 3 }));
        Assert.Equal(0, decodes);
        Assert.Equal(new byte[] { 9, 9 }, Codecs.Reuse(value, "s#0", new byte[] { 1, 2 })!.Value.ToArray());
        Assert.Equal(1, decodes);
    }
}
