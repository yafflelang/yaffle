using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Xunit;

namespace Yaffle.Runtime.Tests;

public class StoreTests
{
    private static byte[] Data(int n)
    {
        var b = new byte[n];
        for (int i = 0; i < n; i++) b[i] = (byte)(i * 7 + i / 256);
        return b;
    }

    [Fact]
    public void SyncStoresReadBlocksOnDemand()
    {
        var data = Data(0x50000);
        var src = new ArraySource(data);
        var store = new SyncSourceStore(src, blockSize: 0x1000, maxBlocks: 8);
        Assert.Equal(data.AsSpan(0x1ff0, 0x20).ToArray(), store.Get(0x1ff0, 0x20).ToArray());
        Assert.Equal(0x2000, store.BytesRead);
        store.Get(0x1ff8, 4);
        Assert.Equal(0x2000, store.BytesRead);
        Assert.Equal(data.AsSpan(0x10000, 0x20000).ToArray(), store.Get(0x10000, 0x20000).ToArray());
        Assert.Equal(ErrorCode.EOF, Assert.Throws<YaffleException>(() => store.Get(0x4fff0, 0x20)).Code);
    }

    [Fact]
    public void ReadersRefillTheirWindow()
    {
        var data = Data(0x20000);
        data[0x18000] = 0;
        var r = new Reader(new SyncSourceStore(new ArraySource(data), blockSize: 0x1000));
        r.Pos = 0x3ffe;
        Assert.Equal(data[0x3ffe] | data[0x3fff] << 8 | data[0x4000] << 16 | data[0x4001] << 24, (int)r.U32(true));
        r.Pos = 0x17000;
        var bytes = r.BytesUntil(0);
        Assert.True(bytes.Length <= 0x1000);
        Assert.DoesNotContain((byte)0, bytes);
    }

    [Fact]
    public async Task AsyncStoresSignalMissingBytes()
    {
        var data = Data(0x30000);
        var store = new AsyncSourceStore(new AsyncArraySource(data), blockSize: 0x1000);
        var need = Assert.Throws<NeedBytes>(() => store.Get(0x2100, 0x10));
        Assert.Equal(0x2000, need.Offset);
        await store.FetchAsync(need);
        Assert.Equal(data.AsSpan(0x2100, 0x10).ToArray(), store.Get(0x2100, 0x10).ToArray());
        await store.FetchAsync(new NeedBytes(0, data.Length));
        Assert.Equal(data, store.Get(0, data.Length).ToArray());
    }
}

public class DiffTests
{
    [Fact]
    public void PatchesRebuildTheOutput()
    {
        var rnd = new Random(42);
        for (int round = 0; round < 200; round++)
        {
            var orig = new byte[rnd.Next(0, 200)];
            rnd.NextBytes(orig);
            var list = new List<byte>(orig);
            for (int e = rnd.Next(0, 5); e > 0; e--)
            {
                int at = rnd.Next(0, list.Count + 1);
                switch (rnd.Next(3))
                {
                    case 0:
                        list.Insert(at, (byte)rnd.Next(256));
                        break;
                    case 1:
                        if (at < list.Count) list.RemoveAt(at);
                        break;
                    default:
                        if (at < list.Count) list[at] ^= 0x5a;
                        break;
                }
            }
            var out_ = list.ToArray();
            var patches = Views.Diff(orig, out_, new List<(int, int, int)>());
            Assert.Equal(out_, Views.Apply(orig, patches));
            int last = -1;
            foreach (var p in patches)
            {
                Assert.True(p.At >= last);
                last = p.At + p.Remove;
            }
        }
    }

    [Fact]
    public void AnchorsSkipComparisons()
    {
        var orig = new byte[] { 1, 2, 3, 4, 5, 6 };
        var out_ = new byte[] { 9, 1, 2, 3, 4, 5, 6 };
        var patches = Views.Diff(orig, out_, new List<(int, int, int)> { (1, 0, 6) });
        Assert.Single(patches);
        Assert.Equal(new Patch(0, 0, new byte[] { 9 }).At, patches[0].At);
        Assert.Equal(out_, Views.Apply(orig, patches));
    }
}

public class SlotTests
{
    [Fact]
    public void SlotsLoadOnce()
    {
        int loads = 0;
        var s = new Slot<string>();
        s.Defer(() =>
        {
            loads++;
            return "x";
        });
        Assert.False(s.IsLoaded);
        Assert.Equal("x", s.Get());
        Assert.Equal("x", s.Get());
        Assert.Equal(1, loads);
        s.Set("y");
        Assert.Equal("y", s.Get());
        Assert.True(s.IsLoaded);
    }
}
