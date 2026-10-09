using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace Yaffle.Runtime;

/// <summary>Padding fill: a byte value, or a function of the byte's index within the padding run.</summary>
public sealed class Fill
{
    private static readonly Fill[] Bytes = Enumerable.Range(0, 256).Select(i => new Fill((byte)i)).ToArray();

    private readonly byte value;
    private readonly Func<long, long>? fn;

    private Fill(byte value) => this.value = value;

    public Fill(Func<long, long> fn) => this.fn = fn;

    /// <summary>The zero fill.</summary>
    public static Fill Zero => Bytes[0];

    /// <summary>A constant fill byte (low 8 bits of <paramref name="b"/>).</summary>
    public static Fill Of(long b) => Bytes[(int)(b & 0xff)];

    public bool IsConstant => fn is null;

    public byte ByteAt(long i) => fn is null ? value : (byte)(fn(i) & 0xff);
}

/// <summary>
/// The read context (docs/IR.md §2.1) used by generated readers: position, base, region end,
/// array index and strict flag over a byte array (or a <see cref="ByteStore"/>, for views), plus
/// primitive, string and padding readers. Positions, base and end are absolute.
/// </summary>
public sealed class Reader
{
    // The bytes [bufStart, bufStart + bufLen) of the region are buf[bufOff..]. Without a store,
    // buf is the whole region.
    private readonly ByteStore? store;
    private byte[] buf;
    private int bufStart;
    private int bufOff;
    private int bufLen;

    /// <summary>Size of the region's data (the file, a decoded codec output or a virtual stream).</summary>
    public readonly int Size;
    public int Pos;
    public int Base;
    public int End;
    /// <summary>The index of the array element being read (-1 outside arrays).</summary>
    public long Index = -1;
    public bool Strict;
    /// <summary>Furthest position read inside the current base (inline and targets): a base struct consumes it all.</summary>
    public int MaxEnd;
    /// <summary>Set by a base struct's reader: the end of its inline bytes (before its targets).</summary>
    public int InlineEnd = -1;
    /// <summary>End position of the last target read with <see cref="Target{T}"/>.</summary>
    public int LastTargetEnd;
    /// <summary>Offset reported for errors inside a decoded region (the encoded window in the outer region).</summary>
    private readonly long? outer;

    /// <summary>The object the next struct reader fills (pre-registered for identity and cycles).</summary>
    private object? into;
    private readonly Dictionary<(int, string), object?> ident = new();
    private readonly Dictionary<(int, string), int> identEnd = new();
    private readonly HashSet<(int, string)> inProgress = new();

    public Reader(byte[] data, bool strict = false, long? outer = null)
    {
        buf = data;
        bufLen = data.Length;
        Size = data.Length;
        End = data.Length;
        Strict = strict;
        this.outer = outer;
    }

    /// <summary>A reader over a store (views): bytes are fetched in windows as they are read.</summary>
    public Reader(ByteStore store, bool strict = false)
    {
        if (store.Whole is byte[] whole) buf = whole;
        else
        {
            this.store = store;
            buf = Array.Empty<byte>();
        }
        bufLen = buf.Length;
        Size = store.Size;
        End = store.Size;
        Strict = strict;
    }

    /// <summary>The bytes <c>[pos, pos + n)</c> (the caller has checked the region bounds).</summary>
    private ReadOnlySpan<byte> Span(int pos, int n)
    {
        if (pos < bufStart || pos + n > bufStart + bufLen)
        {
            if (store is null) throw Error(ErrorCode.EOF, $"need {n} bytes at 0x{pos:x}, the data ends at 0x{Size:x}", pos);
            var seg = store.Get(pos, Math.Max(n, Math.Min(0x4000, Math.Min(Size - pos, store.Extent(pos)))));
            buf = seg.Array!;
            bufOff = seg.Offset;
            bufStart = pos;
            bufLen = seg.Count;
        }
        return new ReadOnlySpan<byte>(buf, bufOff + pos - bufStart, n);
    }

    /// <summary>A reader for a fresh region (virtual stream): base 0, end = length.</summary>
    public Reader Sub(byte[] bytes) => Decoded(bytes, Pos);

    /// <summary>A reader over a codec's decoded output (errors report the encoded window's offset).</summary>
    public Reader Decoded(byte[] bytes, int at)
    {
        var r = new Reader(bytes, Strict, outer ?? at) { into = into };
        into = null;
        return r;
    }

    /// <summary>Called first by every generated struct reader: the pre-registered object to fill, if any.</summary>
    public T? TakeInto<T>() where T : class
    {
        var o = into;
        into = null;
        return o as T;
    }

    private void CheckRange(long start, long end)
    {
        if (start < 0 || end > Size || start > end)
            throw Error(ErrorCode.EOF, $"range [0x{start:x}, 0x{end:x}) is outside the data", start);
    }

    /// <summary>Bytes <c>[start, end)</c> (absolute) without moving <see cref="Pos"/>.</summary>
    public ReadOnlyMemory<byte> Peek(int start, int end)
    {
        CheckRange(start, end);
        if (store is null) return new ReadOnlyMemory<byte>(buf, start, end - start);
        return store.Get(start, end - start);
    }

    /// <summary>A copy of the bytes <c>[start, end)</c> (bytesof / encode on read).</summary>
    public byte[] PeekBytes(long start, long end)
    {
        CheckRange(start, end);
        return Peek((int)start, (int)end).ToArray();
    }

    // ── errors ────────────────────────────────────────────────────────────────

    public long At(long offset) => outer ?? offset;

    public YaffleException Error(ErrorCode code, string detail, long offset) => new(code, detail, At(offset));

    public void CheckFail(string message, long offset) => throw Error(ErrorCode.CHECK, $"check failed: {message}", offset);

    // ── bounds and windows ────────────────────────────────────────────────────

    /// <summary>Ensures <paramref name="n"/> bytes are readable at <see cref="Pos"/> (EOF past the region end).</summary>
    public void Need(long n)
    {
        if (n < 0 || Pos + n > End)
            throw Error(ErrorCode.EOF, $"need {n} bytes at 0x{Pos:x}, region ends at 0x{End:x}", Pos);
    }

    /// <summary>Narrows the region to <paramref name="n"/> bytes from <see cref="Pos"/>; returns the previous end.</summary>
    public int Window(long n)
    {
        int saved = End;
        if (n < 0) throw Error(ErrorCode.RANGE, $"invalid size {n}", Pos);
        if (Pos + n > saved) throw Error(ErrorCode.EOF, $"size {n} at 0x{Pos:x} exceeds the region end 0x{saved:x}", Pos);
        End = Pos + (int)n;
        return saved;
    }

    /// <summary>Skips the rest of the window (padding, strict: zero) and restores the outer end.</summary>
    public void CloseWindow(int saved, bool strict)
    {
        int left = End - Pos;
        if (left > 0) Pad(left, Fill.Zero, strict);
        End = saved;
    }

    // ── integers and floats ───────────────────────────────────────────────────

    private ReadOnlySpan<byte> Take(int n)
    {
        Need(n);
        var s = Span(Pos, n);
        Pos += n;
        return s;
    }

    public byte U8() => Take(1)[0];
    public sbyte I8() => (sbyte)Take(1)[0];
    public ushort U16(bool le) => le ? BinaryPrimitives.ReadUInt16LittleEndian(Take(2)) : BinaryPrimitives.ReadUInt16BigEndian(Take(2));
    public short I16(bool le) => le ? BinaryPrimitives.ReadInt16LittleEndian(Take(2)) : BinaryPrimitives.ReadInt16BigEndian(Take(2));
    public uint U32(bool le) => le ? BinaryPrimitives.ReadUInt32LittleEndian(Take(4)) : BinaryPrimitives.ReadUInt32BigEndian(Take(4));
    public int I32(bool le) => le ? BinaryPrimitives.ReadInt32LittleEndian(Take(4)) : BinaryPrimitives.ReadInt32BigEndian(Take(4));
    public ulong U64(bool le) => le ? BinaryPrimitives.ReadUInt64LittleEndian(Take(8)) : BinaryPrimitives.ReadUInt64BigEndian(Take(8));
    public long I64(bool le) => le ? BinaryPrimitives.ReadInt64LittleEndian(Take(8)) : BinaryPrimitives.ReadInt64BigEndian(Take(8));
    public Half F16(bool le) => BitConverter.UInt16BitsToHalf(U16(le));
    public float F32(bool le) => le ? BinaryPrimitives.ReadSingleLittleEndian(Take(4)) : BinaryPrimitives.ReadSingleBigEndian(Take(4));
    public double F64(bool le) => le ? BinaryPrimitives.ReadDoubleLittleEndian(Take(8)) : BinaryPrimitives.ReadDoubleBigEndian(Take(8));

    /// <summary>An unsigned N-byte integer (N ≤ 8).</summary>
    private ulong UN(int size, bool le)
    {
        var s = Take(size);
        ulong v = 0;
        if (le) for (int i = size - 1; i >= 0; i--) v = (v << 8) | s[i];
        else for (int i = 0; i < size; i++) v = (v << 8) | s[i];
        return v;
    }

    /// <summary>A signed N-byte integer (N ≤ 8), sign-extended.</summary>
    private long IN(int size, bool le) => Check.SignExtend(UN(size, le), size * 8);

    public uint U24(bool le) => (uint)UN(3, le);
    public int I24(bool le) => (int)IN(3, le);
    public ulong U40(bool le) => UN(5, le);
    public long I40(bool le) => IN(5, le);
    public ulong U48(bool le) => UN(6, le);
    public long I48(bool le) => IN(6, le);
    public ulong U56(bool le) => UN(7, le);
    public long I56(bool le) => IN(7, le);

    /// <summary>Any integer primitive as unsigned bits (bitfield storage units).</summary>
    public ulong Bits(Prim kind, bool le) => UN(Prims.Size(kind), le);

    public bool Bool(bool strict)
    {
        int at = Pos;
        byte b = U8();
        if (strict && b > 1) throw Error(ErrorCode.CHECK, $"bool byte 0x{b:x} is not 0 or 1", at);
        return b != 0;
    }

    /// <summary>
    /// A count read from the data (array/bytes/string length): negative is RANGE, more units than
    /// any region could hold is EOF.
    /// </summary>
    public long Count(long v, int unit = 1, string what = "length")
    {
        if (v < 0) throw Error(ErrorCode.RANGE, $"{what} {v} is negative", Pos);
        if (unit > 0 && v > (long.MaxValue / 4) / unit) throw TooLong(v, what);
        return v;
    }

    public long Count(ulong v, int unit = 1, string what = "length") =>
        v > long.MaxValue / 4 ? throw TooLong(v, what) : Count((long)v, unit, what);

    public long Count(Int128 v, int unit = 1, string what = "length")
    {
        if (v < 0) throw Error(ErrorCode.RANGE, $"{what} {v} is negative", Pos);
        return v > long.MaxValue / 4 ? throw TooLong(v, what) : Count((long)v, unit, what);
    }

    private YaffleException TooLong(object v, string what) =>
        Error(ErrorCode.EOF, $"{what} {v} needs more than the {Math.Max(0, End - Pos)} bytes left", Pos);

    // ── bytes ─────────────────────────────────────────────────────────────────

    /// <summary><paramref name="n"/> bytes (a copy).</summary>
    public byte[] Bytes(long n)
    {
        Need(n);
        var out_ = Span(Pos, (int)n).ToArray();
        Pos += (int)n;
        return out_;
    }

    /// <summary>Bytes up to a terminator byte (consumed, not part of the value).</summary>
    public byte[] BytesUntil(long term)
    {
        int i = Find(1, (byte)(term & 0xff));
        var out_ = Bytes(i);
        Pos += 1;
        return out_;
    }

    /// <summary>Bytes to the end of the region.</summary>
    public byte[] BytesRest() => Bytes(End - Pos);

    /// <summary>
    /// Index (in units, from <see cref="Pos"/>) of the first unit equal to <paramref name="term"/>
    /// (unit 1) or all zero (wider units) before the region end; EOF if none.
    /// </summary>
    private int Find(int unit, byte term)
    {
        int avail = (End - Pos) / unit;
        int chunk = store is null ? avail : Math.Min(avail, 256);
        int i = 0;
        while (true)
        {
            var s = Span(Pos, chunk * unit);
            int k = unit == 1 ? s[i..].IndexOf(term) : Strings.FindNulUnit(s, i * unit, chunk - i, unit);
            if (k >= 0) return i + k;
            i = chunk;
            if (chunk >= avail) throw Error(ErrorCode.EOF, "terminator not found before the region end", Pos);
            chunk = (int)Math.Min(avail, (long)chunk * 4);
        }
    }

    // ── strings ───────────────────────────────────────────────────────────────

    /// <summary>Fixed length: <paramref name="nUnits"/> code units; the value stops at the first NUL unit.</summary>
    public string Str(long nUnits, int unit, TextEncoding enc, bool le)
    {
        long n = nUnits * unit;
        Need(n);
        var span = Span(Pos, (int)n);
        int nul = Strings.FindNulUnit(span, 0, (int)nUnits, unit);
        var s = Strings.Decode(span, 0, nul < 0 ? (int)nUnits : nul, enc, le, At(Pos));
        Pos += (int)n;
        return s;
    }

    /// <summary>NUL-terminated: units up to a NUL unit (consumed).</summary>
    public string StrUntil(int unit, TextEncoding enc, bool le)
    {
        int i = Find(unit, 0);
        var s = Str(i, unit, enc, le);
        Pos += unit;
        return s;
    }

    /// <summary>To the end of the region (the value stops at the first NUL unit).</summary>
    public string StrRest(int unit, TextEncoding enc, bool le) => Str((End - Pos) / unit, unit, enc, le);

    // ── padding ───────────────────────────────────────────────────────────────

    /// <summary>Skips <paramref name="n"/> padding bytes; in strict mode they must match the fill.</summary>
    public void Pad(long n, Fill fill, bool strict)
    {
        if (n < 0) throw Error(ErrorCode.RANGE, $"invalid padding length {n}", Pos);
        Need(n);
        if (strict)
        {
            var s = Span(Pos, (int)n);
            for (int i = 0; i < n; i++)
            {
                byte want = fill.ByteAt(i);
                if (s[i] != want)
                    throw Error(ErrorCode.CHECK, $"padding byte 0x{s[i]:x} is not 0x{want:x}", Pos + i);
            }
        }
        Pos += (int)n;
    }

    /// <summary><c>align(to)</c>: pads until <c>(pos - base) % to == 0</c>.</summary>
    public void Align(long to, Fill fill, bool strict) => AlignAt(to, fill, strict, false, 0);

    /// <summary>
    /// <c>@align(to, from: …, offset: …)</c>: pads until <c>(pos - origin + offset) % to == 0</c>.
    /// The origin is the base (<paramref name="file"/> false) or the start of the current byte
    /// space (the source, a decoded region, a stream).
    /// </summary>
    public void AlignAt(long to, Fill fill, bool strict, bool file, long offset)
    {
        if (to <= 0) throw Error(ErrorCode.RANGE, $"invalid alignment {to}", Pos);
        long rel = Pos - (file ? 0 : Base) + offset;
        Pad(((to - rel % to) % to + to) % to, fill, strict);
    }

    /// <summary><c>padUntil(size)</c> after content that started at <paramref name="start"/>.</summary>
    public void PadUntil(int start, long size, Fill fill, bool strict)
    {
        long used = Pos - start;
        if (used > size) throw Error(ErrorCode.CHECK, $"content of {used} bytes exceeds padUntil({size})", start);
        Pad(size - used, fill, strict);
    }

    // ── targets ───────────────────────────────────────────────────────────────

    /// <summary>A target read in progress: where to resume afterwards.</summary>
    private readonly record struct Jump((int, string) Key, int Pos, long Index);

    private int CheckAddr(long addr)
    {
        if (addr < 0 || addr > Size)
            throw Error(ErrorCode.EOF, $"target address 0x{addr:x} is outside the data", Pos);
        return (int)addr;
    }

    /// <summary>The value already read at (address, key); <paramref name="nonNull"/> ignores null entries.</summary>
    private bool Cached(long address, string key, bool nonNull, out object? hit)
    {
        hit = null;
        if (address < 0 || address > int.MaxValue) return false;
        var k = ((int)address, key);
        if (!ident.TryGetValue(k, out hit) || (nonNull && hit is null)) return false;
        LastTargetEnd = identEnd.TryGetValue(k, out var e) ? e : (int)address;
        return true;
    }

    private Jump JumpTo(int addr, string key)
    {
        var j = new Jump((addr, key), Pos, Index);
        Pos = addr;
        Index = -1;
        return j;
    }

    private Jump EnterTarget(long address, string key)
    {
        int addr = CheckAddr(address);
        if (inProgress.Contains((addr, key))) throw Error(ErrorCode.CHECK, $"pointer cycle at 0x{addr:x}", Pos);
        inProgress.Add((addr, key));
        return JumpTo(addr, key);
    }

    /// <summary>Records where the target read for <paramref name="key"/> ended.</summary>
    private void TargetRead((int, string) key)
    {
        identEnd[key] = Pos;
        LastTargetEnd = Pos;
        if (Pos > MaxEnd) MaxEnd = Pos;
    }

    private T Store<T>((int, string) key, T v)
    {
        ident[key] = v;
        TargetRead(key);
        return v;
    }

    private void Return(Jump j)
    {
        Pos = j.Pos;
        Index = j.Index;
    }

    /// <summary>
    /// Reads a pointer or <c>at</c> target at absolute <paramref name="address"/> without moving
    /// <see cref="Pos"/>. The same address and type key give the same value within this region.
    /// </summary>
    public T Target<T>(long address, string key, Func<T> read)
    {
        if (Cached(address, key, false, out var hit)) return (T)hit!;
        var j = EnterTarget(address, key);
        try
        {
            return Store(j.Key, read());
        }
        finally
        {
            inProgress.Remove(j.Key);
            Return(j);
        }
    }

    public async ValueTask<T> TargetAsync<T>(long address, string key, Func<ValueTask<T>> read)
    {
        if (Cached(address, key, false, out var hit)) return (T)hit!;
        var j = EnterTarget(address, key);
        try
        {
            return Store(j.Key, await read().ConfigureAwait(false));
        }
        finally
        {
            inProgress.Remove(j.Key);
            Return(j);
        }
    }

    /// <summary>A struct target's object is registered before its fields are read, so cycles reach the same object.</summary>
    private Jump EnterStruct<T>(long address, string key) where T : class, new()
    {
        int addr = CheckAddr(address);
        var obj = new T();
        ident[(addr, key)] = obj;
        identEnd[(addr, key)] = addr;
        var j = JumpTo(addr, key);
        into = obj;
        return j;
    }

    /// <summary>
    /// A struct target: the object is registered under (address, type) before its contents are
    /// read, so pointers back to it (cycles) get the same object.
    /// </summary>
    public T TargetStruct<T>(long address, string key, Func<T> read) where T : class, new()
    {
        if (Cached(address, key, true, out var hit)) return (T)hit!;
        var j = EnterStruct<T>(address, key);
        try
        {
            var v = read();
            TargetRead(j.Key);
            return v;
        }
        catch
        {
            ident.Remove(j.Key);
            throw;
        }
        finally
        {
            into = null;
            Return(j);
        }
    }

    public async ValueTask<T> TargetStructAsync<T>(long address, string key, Func<ValueTask<T>> read) where T : class, new()
    {
        if (Cached(address, key, true, out var hit)) return (T)hit!;
        var j = EnterStruct<T>(address, key);
        try
        {
            var v = await read().ConfigureAwait(false);
            TargetRead(j.Key);
            return v;
        }
        catch
        {
            ident.Remove(j.Key);
            throw;
        }
        finally
        {
            into = null;
            Return(j);
        }
    }

    /// <summary>Makes the next struct reader fill the object registered at (<see cref="Pos"/>, key).</summary>
    private void Into<T>(string key) where T : class, new()
    {
        var k = (Pos, key);
        if (!ident.TryGetValue(k, out var obj) || obj is null)
        {
            obj = new T();
            ident[k] = obj;
        }
        into = obj;
    }

    /// <summary>An inline struct of a type pointers can target: one object per (address, type).</summary>
    public T Inline<T>(string key, Func<T> read) where T : class, new()
    {
        Into<T>(key);
        try
        {
            return read();
        }
        finally
        {
            into = null;
        }
    }

    public async ValueTask<T> InlineAsync<T>(string key, Func<ValueTask<T>> read) where T : class, new()
    {
        Into<T>(key);
        try
        {
            return await read().ConfigureAwait(false);
        }
        finally
        {
            into = null;
        }
    }

    /// <summary>Runs <paramref name="read"/> at absolute <paramref name="address"/> and restores <see cref="Pos"/>.</summary>
    public T PeekAt<T>(long address, Func<T> read)
    {
        int savePos = Pos;
        Pos = CheckAddr(address);
        try
        {
            var v = read();
            if (Pos > MaxEnd) MaxEnd = Pos;
            return v;
        }
        finally
        {
            Pos = savePos;
        }
    }

    public async ValueTask<T> PeekAtAsync<T>(long address, Func<ValueTask<T>> read)
    {
        int savePos = Pos;
        Pos = CheckAddr(address);
        try
        {
            var v = await read().ConfigureAwait(false);
            if (Pos > MaxEnd) MaxEnd = Pos;
            return v;
        }
        finally
        {
            Pos = savePos;
        }
    }

    // ── unions ────────────────────────────────────────────────────────────────

    /// <summary>The variants tried so far: failed ones restore the position.</summary>
    private sealed class Attempts(Reader r)
    {
        private readonly int start = r.Pos;
        private readonly int end = r.End;
        private readonly List<YaffleException> errors = new();

        public void Failed(string name, YaffleException e)
        {
            e.Prefix(name);
            errors.Add(e);
            r.Pos = start;
            r.End = end;
        }

        public YaffleException NoMatch() =>
            new(ErrorCode.UNION, $"no variant matched ({string.Join("; ", errors.Select(e => e.Message))})", r.At(start), null, errors);
    }

    /// <summary>
    /// Union: tries each variant at <see cref="Pos"/>; the first that reads without error wins.
    /// No match is a UNION error listing every variant's error.
    /// </summary>
    public UnionValue Union(params (string Name, Func<object?> Read)[] variants)
    {
        var attempts = new Attempts(this);
        foreach (var (name, read) in variants)
        {
            try
            {
                return new UnionValue(name, read());
            }
            catch (YaffleException e)
            {
                attempts.Failed(name, e);
            }
        }
        throw attempts.NoMatch();
    }

    public async ValueTask<UnionValue> UnionAsync(params (string Name, Func<ValueTask<object?>> Read)[] variants)
    {
        var attempts = new Attempts(this);
        foreach (var (name, read) in variants)
        {
            try
            {
                return new UnionValue(name, await read().ConfigureAwait(false));
            }
            catch (YaffleException e)
            {
                attempts.Failed(name, e);
            }
        }
        throw attempts.NoMatch();
    }

    // ── extern types ──────────────────────────────────────────────────────────

    /// <summary>Reads an extern type: host <c>Size</c> (unless fixed), then <c>Read</c>.</summary>
    public T Extern<T>(IExternType<T> host, object[] args, int fixedSize = -1)
    {
        int start = Pos;
        int size = fixedSize;
        if (size < 0)
        {
            int probe = Math.Min(End - Pos, 16);
            while (true)
            {
                Need(probe);
                int? s;
                try
                {
                    s = host.Size(Span(Pos, probe), args);
                }
                catch (Exception e)
                {
                    throw Err.Host(e, "extern type size()", At(start));
                }
                if (s is int n)
                {
                    size = n;
                    break;
                }
                if (probe >= End - Pos) throw Error(ErrorCode.EOF, "extern type needs more bytes than the region has", Pos);
                probe = Math.Min(End - Pos, probe * 2);
            }
        }
        Need(size);
        var bytes = Span(Pos, size);
        T v;
        try
        {
            v = host.Read(bytes, args);
        }
        catch (Exception e)
        {
            throw Err.Host(e, "extern type read()", At(start));
        }
        Pos += size;
        return v;
    }
}

/// <summary>A union value: the variant's name and its value (<c>{ type, value }</c> in canonical JSON).</summary>
public sealed class UnionValue
{
    public string Type { get; set; }
    public object? Value { get; set; }

    public UnionValue(string type, object? value)
    {
        Type = type;
        Value = value;
    }
}
