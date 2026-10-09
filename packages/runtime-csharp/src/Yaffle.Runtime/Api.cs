using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;

namespace Yaffle.Runtime;

/// <summary>Options every root accepts. Generated option classes add the root's parameters.</summary>
public class ParseOptions
{
    /// <summary><c>$endian</c> at the root (default little endian).</summary>
    public Endian Endian { get; set; } = Endian.Le;

    /// <summary>Strict mode: padding fill, reserved bits and bool bytes are checked.</summary>
    public bool Strict { get; set; }
}

/// <summary>A synchronous random-access byte source.</summary>
public interface ISource
{
    long Size { get; }
    byte[] Read(long offset, int length);
}

/// <summary>An asynchronous random-access byte source (files, network).</summary>
public interface IAsyncSource
{
    long Size { get; }
    ValueTask<byte[]> ReadAsync(long offset, int length);
}

/// <summary>A source that receives a view's committed bytes.</summary>
public interface ISink
{
    void Write(byte[] bytes, IReadOnlyList<Patch> patches);
}

/// <summary>An async source that receives an async view's committed bytes.</summary>
public interface IAsyncSink
{
    ValueTask WriteAsync(byte[] bytes, IReadOnlyList<Patch> patches);
}

/// <summary>Reading whole sources into memory.</summary>
public static class Sources
{
    /// <summary>Reads a whole sync source into memory.</summary>
    public static byte[] ReadAll(ISource src) => src.Read(0, CheckSize(src.Size));

    /// <summary>Reads a whole async source into memory.</summary>
    public static ValueTask<byte[]> ReadAllAsync(IAsyncSource src) => src.ReadAsync(0, CheckSize(src.Size));

    private static int CheckSize(long size) =>
        size <= int.MaxValue ? (int)size : throw new YaffleException(ErrorCode.RANGE, $"source of {size} bytes is too large");

    /// <summary>Reads a stream to its end.</summary>
    public static byte[] ReadAll(Stream s)
    {
        if (s is MemoryStream ms) return ms.ToArray();
        using var buf = new MemoryStream();
        s.CopyTo(buf);
        return buf.ToArray();
    }

    /// <summary>An async source over a byte array (handy for tests).</summary>
    public static AsyncArraySource OfAsync(byte[] bytes) => new(bytes);
}

/// <summary>A sync source over a byte array that counts reads.</summary>
public class ArraySource : ISource
{
    protected byte[] Data;
    public int Reads { get; private set; }
    public long BytesRead { get; private set; }

    public ArraySource(byte[] bytes) => Data = bytes;

    public long Size => Data.Length;

    public byte[] Read(long offset, int length)
    {
        Reads++;
        BytesRead += length;
        return Data.AsSpan((int)offset, length).ToArray();
    }
}

/// <summary>A sync source over a byte array that counts reads; view commits write back.</summary>
public sealed class ArraySink : ArraySource, ISink
{
    public ArraySink(byte[] bytes) : base(bytes) { }

    public byte[] Bytes => Data;

    public void Write(byte[] bytes, IReadOnlyList<Patch> patches) => Data = (byte[])bytes.Clone();
}

/// <summary>An async source over a byte array that counts reads (yields before every read); view commits write back.</summary>
public sealed class AsyncArraySource : IAsyncSource, IAsyncSink
{
    public byte[] Bytes { get; private set; }
    public int Reads { get; private set; }
    public long BytesRead { get; private set; }

    public AsyncArraySource(byte[] bytes) => Bytes = bytes;

    public long Size => Bytes.Length;

    public async ValueTask<byte[]> ReadAsync(long offset, int length)
    {
        await Task.Yield();
        Reads++;
        BytesRead += length;
        return Bytes.AsSpan((int)offset, length).ToArray();
    }

    public async ValueTask WriteAsync(byte[] bytes, IReadOnlyList<Patch> patches)
    {
        await Task.Yield();
        Bytes = (byte[])bytes.Clone();
    }
}

/// <summary>A sync and async source over a file.</summary>
public sealed class FileSource : ISource, IAsyncSource, IDisposable
{
    private readonly FileStream fs;

    public FileSource(string path) => fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, FileOptions.RandomAccess | FileOptions.Asynchronous);

    public long Size => fs.Length;

    public byte[] Read(long offset, int length)
    {
        var buf = new byte[length];
        for (int done = 0; done < length;)
        {
            int n = RandomAccess.Read(fs.SafeFileHandle, buf.AsSpan(done), offset + done);
            done += n > 0 ? n : throw ShortRead(offset + done);
        }
        return buf;
    }

    public async ValueTask<byte[]> ReadAsync(long offset, int length)
    {
        var buf = new byte[length];
        for (int done = 0; done < length;)
        {
            int n = await RandomAccess.ReadAsync(fs.SafeFileHandle, buf.AsMemory(done), offset + done).ConfigureAwait(false);
            done += n > 0 ? n : throw ShortRead(offset + done);
        }
        return buf;
    }

    private static YaffleException ShortRead(long at) => new(ErrorCode.EOF, "short read from file", at);

    public void Dispose() => fs.Dispose();
}
