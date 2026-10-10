using System;
using System.Collections.Generic;

namespace Yaffle.Runtime;

// Lazy byte stores for views: the decoded side of a @ranged codec region (decoded block by block
// as it is read), windows of other stores, and streams joined from pieces whose lengths
// are known without decoding them (IR.md §2.8).

/// <summary>Bytes <c>[start, start + length)</c> of another store.</summary>
public sealed class SliceStore : ByteStore
{
    private readonly ByteStore inner;
    private readonly int start;
    private readonly int length;

    public SliceStore(ByteStore inner, int start, int length)
    {
        if (start < 0 || length < 0 || (long)start + length > inner.Size)
            throw new YaffleException(ErrorCode.EOF, $"window [0x{start:x}, +{length}) is outside the data (0x{inner.Size:x})", start);
        this.inner = inner;
        this.start = start;
        this.length = length;
    }

    public override int Size => length;

    public override byte[]? Whole => start == 0 && length == inner.Size ? inner.Whole : null;

    public override ArraySegment<byte> Get(int offset, int length)
    {
        CheckRange(offset, length);
        return inner.Get(start + offset, length);
    }

    public override int Extent(int offset) => Math.Min(length - offset, inner.Extent(start + offset));

    /// <summary>A window of a store (the store itself when it is the whole of it).</summary>
    public static ByteStore Of(ByteStore inner, long start, long length)
    {
        if (start == 0 && length == inner.Size) return inner;
        if (start < 0 || length < 0 || start + length > inner.Size)
            throw new YaffleException(ErrorCode.EOF, $"window [{start}, {start + length}) is outside the data of {inner.Size} bytes");
        return new SliceStore(inner, (int)start, (int)length);
    }
}

/// <summary>
/// The decoded side of a <c>@ranged</c> codec region: the encoded window <c>[start, end)</c> of
/// the outer store decodes block by block (each block told its position within the
/// region), so a view reads only the blocks it touches. Ranged codecs keep lengths: decoded
/// offset = encoded offset.
/// </summary>
public sealed class RangedCodecStore : ByteStore
{
    /// <summary>Decoded block size (a multiple of 64, so block ciphers stay block-aligned).</summary>
    public const int BlockSize = 0x4000;

    private readonly ByteStore outer;
    private readonly int start;
    private readonly int size;
    private readonly ICodec codec;
    private readonly string name;
    private readonly CodecContext ctx;
    private readonly Dictionary<int, byte[]> blocks = new();

    public RangedCodecStore(ByteStore outer, int start, int end, ICodec codec, string name, CodecContext ctx)
    {
        this.outer = outer;
        this.start = start;
        size = end - start;
        this.codec = codec;
        this.name = name;
        this.ctx = ctx;
    }

    public override int Size => size;

    public override int Extent(int offset) => Math.Min(size, (offset / BlockSize + 1) * BlockSize) - offset;

    public override ArraySegment<byte> Get(int offset, int length)
    {
        CheckRange(offset, length);
        return Assemble(offset, length, BlockSize, Block);
    }

    private byte[] Block(int i)
    {
        if (blocks.TryGetValue(i, out var hit)) return hit;
        int at = i * BlockSize;
        int len = Math.Min(BlockSize, size - at);
        var input = outer.Get(start + at, len);
        var c = new CodecContext(ctx.Args, null, at);
        var d = Codecs.Decode(codec, name, input, c, false, start + at).Output;
        if (d.Length != len)
            throw new YaffleException(ErrorCode.CODEC, $"ranged codec {name} decoded {len} bytes at +0x{at:x} into {d.Length}", start + at);
        blocks[i] = d;
        return d;
    }
}

/// <summary>
/// A stream joined from pieces (<c>from arr[*].field</c>): each piece's length is known
/// up front, and its bytes are opened only when a read touches it.
/// </summary>
public sealed class PieceStore : ByteStore
{
    private readonly long[] starts;
    private readonly Func<ByteStore>[] open;
    private readonly ByteStore?[] opened;
    private readonly int size;

    public PieceStore(IReadOnlyList<(long Length, Func<ByteStore> Open)> pieces)
    {
        starts = new long[pieces.Count + 1];
        open = new Func<ByteStore>[pieces.Count];
        opened = new ByteStore?[pieces.Count];
        long at = 0;
        for (int i = 0; i < pieces.Count; i++)
        {
            starts[i] = at;
            if (pieces[i].Length < 0) throw new YaffleException(ErrorCode.RANGE, $"piece {i} has a negative length");
            at += pieces[i].Length;
            open[i] = pieces[i].Open;
        }
        starts[pieces.Count] = at;
        if (at > int.MaxValue) throw new YaffleException(ErrorCode.RANGE, $"stream of {at} bytes is too large");
        size = (int)at;
    }

    public override int Size => size;

    private ByteStore Piece(int i)
    {
        if (opened[i] is { } s) return s;
        var st = open[i]();
        long len = starts[i + 1] - starts[i];
        if (st.Size != len)
            throw new YaffleException(ErrorCode.EOF, $"stream piece {i} has {st.Size} bytes, its size field says {len}");
        return opened[i] = st;
    }

    /// <summary>The index of the piece holding stream offset <paramref name="offset"/>.</summary>
    private int Find(long offset)
    {
        int lo = 0, hi = open.Length - 1;
        while (lo < hi)
        {
            int mid = (lo + hi + 1) / 2;
            if (starts[mid] <= offset) lo = mid;
            else hi = mid - 1;
        }
        // Skip empty pieces.
        while (lo < open.Length - 1 && starts[lo + 1] <= offset) lo++;
        return lo;
    }

    public override int Extent(int offset)
    {
        if (open.Length == 0 || offset >= size) return Size - offset;
        int i = Find(offset);
        return (int)(starts[i + 1] - offset);
    }

    public override ArraySegment<byte> Get(int offset, int length)
    {
        CheckRange(offset, length);
        if (length == 0) return ArraySegment<byte>.Empty;
        int first = Find(offset), last = Find(offset + length - 1);
        if (first == last) return Piece(first).Get((int)(offset - starts[first]), length);
        var out_ = new byte[length];
        for (int i = first; i <= last; i++)
        {
            long ps = starts[i], pe = starts[i + 1];
            long from = Math.Max(offset, ps), to = Math.Min(offset + length, pe);
            if (from >= to) continue;
            var seg = Piece(i).Get((int)(from - ps), (int)(to - from));
            seg.AsSpan().CopyTo(out_.AsSpan((int)(from - offset)));
        }
        return new ArraySegment<byte>(out_);
    }
}

/// <summary>One <c>from raw[start..end]</c> field's encoding, for <see cref="Slices.Assemble"/>.</summary>
public readonly record struct SlicePart(string Name, long Start, long? End, byte[] Bytes);

/// <summary>Write side of stream slices (<c>from raw[a..b]</c>).</summary>
public static class Slices
{
    /// <summary>
    /// The sliced bytes: a zero-filled buffer of <paramref name="length"/> bytes (null: the largest
    /// slice end) with every slice field's encoding written at its start. An encoding longer than its
    /// slice, slices past the length, or overlapping slices whose bytes differ are DERIVE errors.
    /// </summary>
    public static byte[] Assemble(long? length, SlicePart[] parts)
    {
        long size = 0;
        foreach (var p in parts)
        {
            if (p.Start < 0) throw new YaffleException(ErrorCode.RANGE, $"slice start {p.Start} of {p.Name} is invalid");
            if (p.End is long e)
            {
                if (e < p.Start) throw new YaffleException(ErrorCode.RANGE, $"slice [{p.Start}, {e}) of {p.Name} is invalid");
                if (p.Bytes.Length > e - p.Start)
                    throw new YaffleException(ErrorCode.DERIVE, $"{p.Name} encodes to {p.Bytes.Length} bytes, its slice [{p.Start}, {e}) has {e - p.Start}");
            }
            size = Math.Max(size, Math.Max(p.End ?? p.Start + p.Bytes.Length, p.Start + p.Bytes.Length));
        }
        if (length is long n)
        {
            if (size > n) throw new YaffleException(ErrorCode.DERIVE, $"the slices need {size} bytes, the sliced field has {n}");
            size = n;
        }
        if (size > int.MaxValue) throw new YaffleException(ErrorCode.RANGE, $"sliced field of {size} bytes is too large");
        var out_ = new byte[size];
        var owner = new int[size];
        Array.Fill(owner, -1);
        for (int k = 0; k < parts.Length; k++)
        {
            var p = parts[k];
            for (int i = 0; i < p.Bytes.Length; i++)
            {
                long at = p.Start + i;
                int prev = owner[at];
                if (prev >= 0 && out_[at] != p.Bytes[i])
                    throw new YaffleException(ErrorCode.DERIVE, $"overlapping slices {parts[prev].Name} and {p.Name} disagree at byte 0x{at:x}");
                out_[at] = p.Bytes[i];
                owner[at] = k;
            }
        }
        return out_;
    }
}
