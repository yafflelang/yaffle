using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Yaffle.Runtime;

/// <summary>
/// A random-access byte store read by views: an array, a block-cached sync source, an async
/// source (whose missing blocks raise <see cref="NeedBytes"/>), or a store with in-place patches.
/// </summary>
public abstract class ByteStore
{
    public abstract int Size { get; }

    /// <summary>The whole store as one array, when it is one (fast path).</summary>
    public virtual byte[]? Whole => null;

    /// <summary>Bytes <c>[offset, offset + length)</c>. May throw <see cref="NeedBytes"/>.</summary>
    public abstract ArraySegment<byte> Get(int offset, int length);

    /// <summary>
    /// How many bytes from <paramref name="offset"/> on can be fetched together without extra work
    /// (the rest of a stream piece or a decoded block). Readers don't read ahead past it.
    /// </summary>
    public virtual int Extent(int offset) => Size - offset;

    protected void CheckRange(int offset, int length)
    {
        if (offset < 0 || length < 0 || (long)offset + length > Size)
            throw new YaffleException(ErrorCode.EOF, $"read of {length} bytes at 0x{offset:x} is past the end (0x{Size:x})", offset);
    }

    /// <summary>A copy of the whole store.</summary>
    public byte[] ToArray() => Whole is byte[] w ? (byte[])w.Clone() : Get(0, Size).ToArray();

    /// <summary>Bytes <c>[offset, offset + length)</c> of a store made of fixed-size blocks.</summary>
    protected static ArraySegment<byte> Assemble(int offset, int length, int blockSize, Func<int, byte[]> block)
    {
        if (length == 0) return ArraySegment<byte>.Empty;
        int first = offset / blockSize, last = (offset + length - 1) / blockSize;
        if (first == last) return new ArraySegment<byte>(block(first), offset - first * blockSize, length);
        var out_ = new byte[length];
        for (int i = first; i <= last; i++)
        {
            var b = block(i);
            int bStart = i * blockSize;
            int from = Math.Max(offset, bStart), to = Math.Min(offset + length, bStart + b.Length);
            Array.Copy(b, from - bStart, out_, from - offset, to - from);
        }
        return new ArraySegment<byte>(out_);
    }
}

/// <summary>A store over a byte array.</summary>
public sealed class ArrayStore : ByteStore
{
    private readonly byte[] data;

    public ArrayStore(byte[] data) => this.data = data;

    public override int Size => data.Length;

    public override byte[]? Whole => data;

    public override ArraySegment<byte> Get(int offset, int length)
    {
        CheckRange(offset, length);
        return new ArraySegment<byte>(data, offset, length);
    }
}

/// <summary>Internal control signal: the bytes <c>[Offset, Offset + Length)</c> must be fetched first.</summary>
public sealed class NeedBytes : ControlSignal
{
    public int Offset { get; }
    public int Length { get; }

    public NeedBytes(int offset, int length) : base($"need bytes [0x{offset:x}, +{length})")
    {
        Offset = offset;
        Length = length;
    }
}

/// <summary>Internal control signal: an async operation (an async codec) must complete first.</summary>
public sealed class NeedAsync : ControlSignal
{
    public object Key { get; }
    public Func<ValueTask> Run { get; }

    public NeedAsync(object key, Func<ValueTask> run) : base("an async operation must complete first")
    {
        Key = key;
        Run = run;
    }
}

/// <summary>Block cache shared by sync and async source stores.</summary>
public abstract class BlockCacheStore : ByteStore
{
    private readonly int size;
    protected readonly int BlockSize;
    protected readonly int MaxBlocks;
    protected readonly Dictionary<int, byte[]> Blocks = new();
    private readonly LinkedList<int> lru = new();
    protected readonly List<(int At, byte[] Data)> Large = new();

    /// <summary>Statistics: bytes requested from the underlying source.</summary>
    public long BytesRead { get; protected set; }

    protected BlockCacheStore(long size, int blockSize, int maxBlocks)
    {
        if (size > int.MaxValue) throw new YaffleException(ErrorCode.RANGE, $"source of {size} bytes is too large");
        this.size = (int)size;
        BlockSize = blockSize;
        MaxBlocks = Math.Max(4, maxBlocks);
    }

    public override int Size => size;

    protected int LargeRead => BlockSize * 8;

    public override int Extent(int offset) => Math.Min(Size, (offset / BlockSize + 1) * BlockSize) - offset;

    public override ArraySegment<byte> Get(int offset, int length)
    {
        CheckRange(offset, length);
        if (length == 0) return ArraySegment<byte>.Empty;
        foreach (var (at, data) in Large)
            if (offset >= at && offset + length <= at + data.Length) return new ArraySegment<byte>(data, offset - at, length);
        if (length > LargeRead) return GetLarge(offset, length);
        return Assemble(offset, length, BlockSize, Block);
    }

    private byte[] Block(int i)
    {
        if (Blocks.TryGetValue(i, out var hit))
        {
            lru.Remove(i);
            lru.AddLast(i);
            return hit;
        }
        var b = LoadBlock(i);
        Remember(i, b);
        return b;
    }

    protected virtual bool Evictable(int i) => true;

    protected void Remember(int i, byte[] b)
    {
        Blocks[i] = b;
        lru.Remove(i);
        lru.AddLast(i);
        var node = lru.First;
        while (Blocks.Count > MaxBlocks && node is not null)
        {
            var next = node.Next;
            if (Evictable(node.Value))
            {
                Blocks.Remove(node.Value);
                lru.Remove(node);
            }
            node = next;
        }
    }

    protected (int Start, int Length) BlockRange(int i)
    {
        int start = i * BlockSize;
        return (start, Math.Min(Size, start + BlockSize) - start);
    }

    protected abstract byte[] LoadBlock(int i);
    protected abstract ArraySegment<byte> GetLarge(int offset, int length);
}

/// <summary>A block-cached store over a sync source.</summary>
public sealed class SyncSourceStore : BlockCacheStore
{
    private readonly ISource src;

    public SyncSourceStore(ISource src, int blockSize = 0x10000, int maxBlocks = 256) : base(src.Size, blockSize, maxBlocks) => this.src = src;

    protected override byte[] LoadBlock(int i)
    {
        var (start, len) = BlockRange(i);
        BytesRead += len;
        return src.Read(start, len);
    }

    protected override ArraySegment<byte> GetLarge(int offset, int length)
    {
        BytesRead += length;
        var data = src.Read(offset, length);
        Large.Add((offset, data));
        if (Large.Count > 8) Large.RemoveAt(0);
        return new ArraySegment<byte>(data);
    }
}

/// <summary>
/// An async-backed store: <see cref="ByteStore.Get"/> throws <see cref="NeedBytes"/> for anything
/// not fetched yet; <see cref="FetchAsync"/> loads it (pinned until <see cref="Release"/>).
/// </summary>
public sealed class AsyncSourceStore : BlockCacheStore
{
    public IAsyncSource Source { get; }
    private readonly HashSet<int> pinned = new();

    public AsyncSourceStore(IAsyncSource src, int blockSize = 0x10000, int maxBlocks = 256) : base(src.Size, blockSize, maxBlocks) => Source = src;

    protected override bool Evictable(int i) => !pinned.Contains(i);

    protected override byte[] LoadBlock(int i)
    {
        var (start, len) = BlockRange(i);
        throw new NeedBytes(start, len);
    }

    protected override ArraySegment<byte> GetLarge(int offset, int length) => throw new NeedBytes(offset, length);

    public async ValueTask FetchAsync(NeedBytes need)
    {
        if (need.Length > LargeRead)
        {
            var data = await Source.ReadAsync(need.Offset, need.Length).ConfigureAwait(false);
            BytesRead += need.Length;
            if (data.Length != need.Length) throw new YaffleException(ErrorCode.EOF, "short read from source", need.Offset);
            Large.Add((need.Offset, data));
            return;
        }
        int first = need.Offset / BlockSize, last = (need.Offset + Math.Max(need.Length, 1) - 1) / BlockSize;
        var missing = new List<int>();
        for (int i = first; i <= last; i++) if (!Blocks.ContainsKey(i)) missing.Add(i);
        if (missing.Count == 0) return;
        int start = missing[0] * BlockSize;
        int end = Math.Min(Size, (missing[^1] + 1) * BlockSize);
        var bytes = await Source.ReadAsync(start, end - start).ConfigureAwait(false);
        BytesRead += end - start;
        if (bytes.Length != end - start) throw new YaffleException(ErrorCode.EOF, "short read from source", start);
        foreach (int i in missing)
        {
            int s = i * BlockSize - start;
            pinned.Add(i);
            Remember(i, bytes.AsSpan(s, Math.Min(bytes.Length, s + BlockSize) - s).ToArray());
        }
    }

    /// <summary>Unpins blocks fetched for a finished operation (large reads stay cached).</summary>
    public void Release()
    {
        pinned.Clear();
        if (Large.Count > 4) Large.RemoveRange(0, Large.Count - 4);
    }
}
