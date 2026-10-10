using System;
using System.Collections.Generic;
using System.Globalization;
using System.Numerics;
using System.Runtime.CompilerServices;
using System.Threading.Tasks;

namespace Yaffle.Runtime;

/// <summary>What a codec is told about the region it transforms (docs/IR.md §5).</summary>
public sealed class CodecContext
{
    /// <summary>The codec's arguments in declaration order (u8 → byte, u64 → ulong, u8[n] → byte[], …).</summary>
    public IReadOnlyList<object> Args { get; }

    /// <summary>The decoded size, when an inner <c>@size</c> layer gives it.</summary>
    public int? OutputSize { get; }

    /// <summary>For <c>@ranged</c> codecs: the slice's offset within the encoded region.</summary>
    public long? Position { get; }

    public CodecContext(IReadOnlyList<object> args, int? outputSize = null, long? position = null)
    {
        Args = args;
        OutputSize = outputSize;
        Position = position;
    }

    /// <summary>An argument converted to <typeparamref name="T"/> (numeric conversions are checked).</summary>
    public T Arg<T>(int index)
    {
        if (index >= Args.Count) throw new ArgumentException($"codec argument {index} is missing");
        var v = Args[index];
        if (v is T t) return t;
        if (v is IConvertible && typeof(IConvertible).IsAssignableFrom(typeof(T)))
            return (T)Convert.ChangeType(v, typeof(T), CultureInfo.InvariantCulture);
        throw new ArgumentException($"codec argument {index} is a {v.GetType().Name}, not a {typeof(T).Name}");
    }
}

/// <summary>
/// A codec (<c>extern codec</c>). Async codecs (<c>extern async codec</c>) override the
/// async methods; generated code calls those for them.
/// </summary>
public interface ICodec
{
    byte[] Decode(ReadOnlyMemory<byte> input, CodecContext ctx);
    byte[] Encode(ReadOnlyMemory<byte> input, CodecContext ctx);

    ValueTask<byte[]> DecodeAsync(ReadOnlyMemory<byte> input, CodecContext ctx) => new(Decode(input, ctx));
    ValueTask<byte[]> EncodeAsync(ReadOnlyMemory<byte> input, CodecContext ctx) => new(Encode(input, ctx));
}

/// <summary>Output of a decode: the decoded bytes and how many input bytes were consumed.</summary>
public readonly record struct CodecResult(byte[] Output, int Consumed);

/// <summary>A <c>@streaming</c> codec: decode gets the rest of the region and reports what it consumed.</summary>
public interface IStreamingCodec : ICodec
{
    CodecResult DecodeStreaming(ReadOnlyMemory<byte> input, CodecContext ctx);

    ValueTask<CodecResult> DecodeStreamingAsync(ReadOnlyMemory<byte> input, CodecContext ctx) => new(DecodeStreaming(input, ctx));

    byte[] ICodec.Decode(ReadOnlyMemory<byte> input, CodecContext ctx) => DecodeStreaming(input, ctx).Output;
}

/// <summary>
/// A host-implemented primitive (<c>extern type X(args) : T</c>). <see cref="Size"/> returns null
/// for "need more bytes".
/// </summary>
public interface IExternType<T>
{
    int? Size(ReadOnlySpan<byte> bytes, object[] args);
    T Read(ReadOnlySpan<byte> bytes, object[] args);
    byte[] Write(T value, object[] args);
}

/// <summary>Calling codecs, codec reuse (docs/IR.md §3.6), streams.</summary>
public static class Codecs
{
    private static YaffleException Fail(string name, string op, Exception e, long offset) =>
        e as YaffleException ?? new YaffleException(ErrorCode.CODEC, $"codec {name} failed to {op}: {e.Message}", offset);

    private static IStreamingCodec Streaming(ICodec codec, string name, long offset) =>
        codec as IStreamingCodec ?? throw new YaffleException(ErrorCode.CODEC, $"streaming codec {name} must implement IStreamingCodec", offset);

    public static CodecResult Decode(ICodec codec, string name, ReadOnlyMemory<byte> input, CodecContext ctx, bool streaming, long offset)
    {
        try
        {
            var r = streaming ? Streaming(codec, name, offset).DecodeStreaming(input, ctx) : new(codec.Decode(input, ctx), input.Length);
            return Checked(name, r, input.Length, offset);
        }
        catch (Exception e) when (e is not ControlSignal)
        {
            throw Fail(name, "decode", e, offset);
        }
    }

    public static async ValueTask<CodecResult> DecodeAsync(ICodec codec, string name, ReadOnlyMemory<byte> input, CodecContext ctx, bool streaming, long offset)
    {
        try
        {
            var r = streaming
                ? await Streaming(codec, name, offset).DecodeStreamingAsync(input, ctx).ConfigureAwait(false)
                : new(await codec.DecodeAsync(input, ctx).ConfigureAwait(false), input.Length);
            return Checked(name, r, input.Length, offset);
        }
        catch (Exception e) when (e is not ControlSignal)
        {
            throw Fail(name, "decode", e, offset);
        }
    }

    private static CodecResult Checked(string name, CodecResult r, int length, long offset)
    {
        if (r.Output is null) throw new YaffleException(ErrorCode.CODEC, $"codec {name} decode returned null", offset);
        if (r.Consumed < 0 || r.Consumed > length)
            throw new YaffleException(ErrorCode.CODEC, $"streaming codec {name} consumed {r.Consumed} of {length} bytes", offset);
        return r;
    }

    public static byte[] Encode(ICodec codec, string name, byte[] input, CodecContext ctx)
    {
        byte[]? o;
        try
        {
            o = codec.Encode(input, ctx);
        }
        catch (Exception e) when (e is not ControlSignal)
        {
            throw Fail(name, "encode", e, -1);
        }
        return o ?? throw EncodedNull(name);
    }

    public static async ValueTask<byte[]> EncodeAsync(ICodec codec, string name, byte[] input, CodecContext ctx)
    {
        byte[]? o;
        try
        {
            o = await codec.EncodeAsync(input, ctx).ConfigureAwait(false);
        }
        catch (Exception e) when (e is not ControlSignal)
        {
            throw Fail(name, "encode", e, -1);
        }
        return o ?? throw EncodedNull(name);
    }

    private static YaffleException EncodedNull(string name) => new(ErrorCode.CODEC, $"codec {name} encode returned null");

    // ── reuse ─────────────────────────────────────────────────────────────────

    private sealed class Origin
    {
        public required Lazy<ReadOnlyMemory<byte>> Encoded;
        public required Lazy<byte[]> Decoded;
        /// <summary>The decoded length when known without decoding (-1 otherwise).</summary>
        public required long DecodedLength;
    }

    private static readonly ConditionalWeakTable<object, Dictionary<string, Origin>> Origins = new();

    private static void Store(object? value, string slot, Origin origin)
    {
        if (!Values.HasIdentity(value)) return;
        var m = Origins.GetValue(value!, _ => new Dictionary<string, Origin>());
        lock (m) m[slot] = origin;
    }

    /// <summary>
    /// Remembers that <paramref name="value"/> (the content inside a <c>via</c> layer) was decoded
    /// from <paramref name="encoded"/>. <paramref name="slot"/> distinguishes nested layers.
    /// </summary>
    public static void Remember(object? value, string slot, ReadOnlyMemory<byte> encoded, byte[] decoded) =>
        Store(value, slot, new Origin { Encoded = new(encoded), Decoded = new(decoded), DecodedLength = decoded.Length });

    /// <summary>
    /// <see cref="Remember"/> for regions a view decodes lazily (<c>@ranged</c> codecs): the encoded
    /// and decoded bytes are read only if a writer checks for reuse.
    /// </summary>
    public static void RememberLazy(object? value, string slot, Func<ReadOnlyMemory<byte>> encoded, Func<byte[]> decoded, long decodedLength) =>
        Store(value, slot, new Origin { Encoded = new(encoded), Decoded = new(decoded), DecodedLength = decodedLength });

    /// <summary>The original encoded bytes if <paramref name="value"/> came from a parse and its plain encoding is unchanged.</summary>
    public static ReadOnlyMemory<byte>? Reuse(object? value, string slot, byte[] plain)
    {
        if (!Values.HasIdentity(value) || !Origins.TryGetValue(value!, out var m)) return null;
        Origin? o;
        lock (m)
        {
            if (!m.TryGetValue(slot, out o)) return null;
        }
        if (o.DecodedLength >= 0 && o.DecodedLength != plain.Length) return null;
        if (!o.Decoded.Value.AsSpan().SequenceEqual(plain)) return null;
        return o.Encoded.Value;
    }

    // ── streams ───────────────────────────────────────────────────────────────

    /// <summary>Joins pieces into one stream.</summary>
    public static byte[] Join(IReadOnlyList<byte[]> pieces)
    {
        if (pieces.Count == 1) return pieces[0];
        long n = 0;
        foreach (var p in pieces) n += p.Length;
        var out_ = new byte[n];
        int at = 0;
        foreach (var p in pieces)
        {
            p.CopyTo(out_, at);
            at += p.Length;
        }
        return out_;
    }

    /// <summary><c>raw[a..b]</c> (end exclusive; null = to the end).</summary>
    public static byte[] Slice(byte[] s, long start, long? end)
    {
        long e = end ?? s.Length;
        if (start < 0 || e > s.Length || start > e)
            throw new YaffleException(ErrorCode.EOF, $"stream slice [{start}, {e}) is outside the stream of {s.Length} bytes");
        return s.AsSpan((int)start, (int)(e - start)).ToArray();
    }

    /// <summary>Splits <paramref name="data"/> into pieces of the given sizes (they must cover it exactly).</summary>
    public static List<byte[]> SplitBySizes(byte[] data, IReadOnlyList<long> sizes)
    {
        var out_ = new List<byte[]>(sizes.Count);
        long at = 0;
        foreach (var n in sizes)
        {
            if (at + n > data.Length) throw new YaffleException(ErrorCode.DERIVE, $"piece sizes exceed the stream length {data.Length}");
            out_.Add(data.AsSpan((int)at, (int)n).ToArray());
            at += n;
        }
        if (at != data.Length) throw new YaffleException(ErrorCode.DERIVE, $"piece sizes cover {at} of {data.Length} stream bytes");
        return out_;
    }
}

/// <summary>Placeholders for externs without a configured implementation (they fail when used).</summary>
public static class MissingExtern
{
    private static YaffleException Error(string name) =>
        new(ErrorCode.INPUT, $"extern {name} has no implementation (configure targets.csharp.externs in yaffle.json)");

    private sealed class MissingCodec(string name) : ICodec
    {
        public byte[] Decode(ReadOnlyMemory<byte> input, CodecContext ctx) => throw Error(name);
        public byte[] Encode(ReadOnlyMemory<byte> input, CodecContext ctx) => throw Error(name);
    }

    private sealed class MissingType<T>(string name) : IExternType<T>
    {
        public int? Size(ReadOnlySpan<byte> bytes, object[] args) => throw Error(name);
        public T Read(ReadOnlySpan<byte> bytes, object[] args) => throw Error(name);
        public byte[] Write(T value, object[] args) => throw Error(name);
    }

    public static ICodec Codec(string name) => new MissingCodec(name);

    public static IExternType<T> Type<T>(string name) => new MissingType<T>(name);
}

/// <summary>Built-in extern type: unsigned LEB128 (value u64).</summary>
public sealed class Uleb128 : IExternType<ulong>
{
    public static readonly Uleb128 Instance = new();

    public int? Size(ReadOnlySpan<byte> bytes, object[] args)
    {
        int max = args.Length > 0 ? Convert.ToInt32(args[0], CultureInfo.InvariantCulture) : 10;
        for (int i = 0; i < bytes.Length && i < max; i++) if ((bytes[i] & 0x80) == 0) return i + 1;
        if (bytes.Length >= max) throw new YaffleException(ErrorCode.CHECK, $"LEB128 longer than {max} bytes");
        return null;
    }

    public ulong Read(ReadOnlySpan<byte> bytes, object[] args)
    {
        var v = Leb128(bytes);
        if (v > ulong.MaxValue) throw new YaffleException(ErrorCode.RANGE, "uleb128 value exceeds u64");
        return (ulong)v;
    }

    /// <summary>The unsigned value of LEB128 bytes.</summary>
    internal static BigInteger Leb128(ReadOnlySpan<byte> bytes)
    {
        BigInteger v = 0;
        for (int i = bytes.Length - 1; i >= 0; i--) v = (v << 7) | (bytes[i] & 0x7f);
        return v;
    }

    public byte[] Write(ulong value, object[] args)
    {
        var out_ = new List<byte>();
        do
        {
            byte b = (byte)(value & 0x7f);
            value >>= 7;
            if (value != 0) b |= 0x80;
            out_.Add(b);
        } while (value != 0);
        return out_.ToArray();
    }
}

/// <summary>Built-in extern type: signed LEB128 (value i64).</summary>
public sealed class Sleb128 : IExternType<long>
{
    public static readonly Sleb128 Instance = new();

    public int? Size(ReadOnlySpan<byte> bytes, object[] args) => Uleb128.Instance.Size(bytes, args);

    public long Read(ReadOnlySpan<byte> bytes, object[] args)
    {
        var v = Uleb128.Leb128(bytes);
        if (bytes.Length > 0 && (bytes[^1] & 0x40) != 0) v -= BigInteger.One << (bytes.Length * 7);
        if (v < long.MinValue || v > long.MaxValue) throw new YaffleException(ErrorCode.RANGE, "sleb128 value exceeds i64");
        return (long)v;
    }

    public byte[] Write(long value, object[] args)
    {
        var out_ = new List<byte>();
        while (true)
        {
            byte b = (byte)(value & 0x7f);
            value >>= 7;
            bool done = (value == 0 && (b & 0x40) == 0) || (value == -1 && (b & 0x40) != 0);
            out_.Add(done ? b : (byte)(b | 0x80));
            if (done) break;
        }
        return out_.ToArray();
    }
}
