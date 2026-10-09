using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Yaffle.Runtime;

/// <summary>The writer used by generated code.</summary>
public sealed class Writer
{
    /// <summary>Current block (inline bytes go here).</summary>
    public Block B;
    /// <summary>Current base region.</summary>
    public Region Region;
    public long Index = -1;
    /// <summary>One frame per struct being written: its current field and indices (for fixup error paths).</summary>
    private readonly List<Func<object[]>> frames = new();

    /// <summary>The region the writer started in (the root base).</summary>
    public Region RootRegion { get; }

    public Writer(Region? region = null)
    {
        Region = region ?? new Region();
        B = Region.Root;
        RootRegion = Region;
    }

    /// <summary>Enters a struct writer; <paramref name="get"/> returns its current field and indices.</summary>
    public void Enter(Func<object[]> get) => frames.Add(get);

    public void Leave() => frames.RemoveAt(frames.Count - 1);

    /// <summary>The current path from the root (snapshot).</summary>
    private IReadOnlyList<object> Path()
    {
        var segs = new List<object>();
        foreach (var g in frames) segs.AddRange(g());
        return YaffleException.Segments(segs);
    }

    // ── commit mode (views) ──────────────────────────────────────────────────

    /// <summary>Original absolute position/size of a value (pointer targets, <c>at</c> values) in the view's source.</summary>
    public Func<object?, (long Pos, long Size)?>? Origin;
    /// <summary>Original target of a field of a view struct (when the field got a new value).</summary>
    public Func<object?, string, (long Pos, long Size)?>? SlotOrigin;
    /// <summary>Original position of a nested base struct (its region keeps targets where they were).</summary>
    public Func<object?, (long Base, long Inline, long Size)?>? RegionOrigin;
    /// <summary>Byte arrays that are slices of this source are recorded as copied from the original (for patches).</summary>
    public Func<ReadOnlyMemory<byte>, Provenance?>? ProvenanceOf;
    private long originBase;

    private Provenance? ProvOf(ReadOnlyMemory<byte> v)
    {
        if (ProvenanceOf is null || Region != RootRegion) return null;
        return ProvenanceOf(v);
    }

    private void NoteOrigin(Placeable p, object? value, object? owner)
    {
        if (Origin is null || Region.Sticky is null || Region.Sticky.OrigRootSize is null) return;
        var o = Origin(value) ?? (owner is not null ? SlotOrigin?.Invoke(owner, p.Name) : null);
        if (o is var (pos, size) && pos >= originBase)
        {
            p.Orig = pos - originBase;
            p.OrigSize = size;
        }
    }

    /// <summary>Offset of the next byte within the current block.</summary>
    public int Offset => B.Size;

    /// <summary><c>$offset</c> on write: the base-relative position (exact in a region's own block).</summary>
    public long Position => (B.Pos >= 0 ? B.Pos : 0) + B.Size;

    public Mark Mark() => new(B, B.Size);

    public Extent Extent() => new(B, B.Size);

    public void Close(Extent e) => e.End = B.Size;

    // ── primitives ───────────────────────────────────────────────────────────

    public void U8(byte v) => B.U8(v);
    public void I8(sbyte v) => B.U8((byte)v);
    public void U16(ushort v, bool le) => B.Int(v, 2, le);
    public void I16(short v, bool le) => B.Int((ulong)v, 2, le);
    public void U24(uint v, bool le) => B.Int(Ck.U24((long)v), 3, le);
    public void I24(int v, bool le) => B.Int((ulong)Ck.I24((long)v), 3, le);
    public void U32(uint v, bool le) => B.Int(v, 4, le);
    public void I32(int v, bool le) => B.Int((ulong)v, 4, le);
    public void U40(ulong v, bool le) => B.Int(Ck.U40(checked((long)v)), 5, le);
    public void I40(long v, bool le) => B.Int((ulong)Ck.I40(v), 5, le);
    public void U48(ulong v, bool le) => B.Int(Ck.U48(checked((long)v)), 6, le);
    public void I48(long v, bool le) => B.Int((ulong)Ck.I48(v), 6, le);
    public void U56(ulong v, bool le) => B.Int(v <= 0xffffffffffffffUL ? v : throw new YaffleException(ErrorCode.RANGE, $"{v} is out of range for u56"), 7, le);
    public void I56(long v, bool le) => B.Int((ulong)Ck.I56(v), 7, le);
    public void U64(ulong v, bool le) => B.Int(v, 8, le);
    public void I64(long v, bool le) => B.Int((ulong)v, 8, le);
    public void F16(Half v, bool le) => B.Int(Half.IsNaN(v) ? 0x7e00UL : BitConverter.HalfToUInt16Bits(v), 2, le);
    public void F16(double v, bool le) => B.Int(HalfBits.FromDouble(v), 2, le);
    public void F32(float v, bool le) => B.F32(v, le);
    public void F64(double v, bool le) => B.F64(v, le);

    /// <summary>An integer primitive from a checked Int128 value.</summary>
    public void Int(Prim kind, Int128 v, bool le) => B.Int((ulong)Ck.Prim(v, kind), Prims.Size(kind), le);

    /// <summary>Raw bits of a storage unit (bitfields).</summary>
    public void Bits(Prim kind, ulong bits, bool le) => B.Int(bits, Prims.Size(kind), le);

    public void Bool(bool v) => B.U8(v ? (byte)1 : (byte)0);

    public void Bytes(byte[]? v) => Raw(Check.Bytes(v));

    /// <summary>Raw bytes known to be valid.</summary>
    public void Raw(ReadOnlyMemory<byte> v) => B.Bytes(v, ProvOf(v));

    /// <summary><c>u8 x[n]</c>: exactly <paramref name="n"/> bytes (other lengths would read back differently: DERIVE).</summary>
    public void BytesN(byte[]? v, long n)
    {
        if (Check.Bytes(v).Length != n) throw new YaffleException(ErrorCode.DERIVE, $"{v!.Length} bytes given, the length expression says {n}");
        Raw(v);
    }

    /// <summary>Bytes followed by a terminator byte (which must not occur inside).</summary>
    public void BytesUntil(byte[]? v, long term)
    {
        byte t = (byte)(term & 0xff);
        if (Array.IndexOf(Check.Bytes(v), t) >= 0) throw new YaffleException(ErrorCode.INPUT, $"the bytes contain the terminator 0x{t:x}");
        B.Bytes(v);
        B.U8(t);
    }

    /// <summary>Writes an extern type through its host <c>Write</c>.</summary>
    public void Extern<T>(IExternType<T> host, T value, object[] args, int fixedSize)
    {
        byte[]? out_;
        try
        {
            out_ = host.Write(value, args);
        }
        catch (Exception e) when (e is not YaffleException)
        {
            throw new YaffleException(ErrorCode.CODEC, $"extern type write() failed: {e.Message}");
        }
        if (out_ is null) throw new YaffleException(ErrorCode.INPUT, "extern type write() must return bytes");
        if (fixedSize >= 0 && out_.Length != fixedSize)
            throw new YaffleException(ErrorCode.DERIVE, $"extern type wrote {out_.Length} bytes, its fixed size is {fixedSize}");
        B.Bytes(out_);
    }

    /// <summary><c>this</c> of a base struct: its whole region.</summary>
    public Extent RegionExtent() => new RegionExtent(Region);

    /// <summary>An extent for a placed field, created before its content is written (stages go into it).</summary>
    public Extent PendingExtent() => new(B, B.Size);

    /// <summary>Binds a pending extent to the placeable that holds the field.</summary>
    public void BindExtent(Extent e, Placeable p, bool emptyIsNull = false)
    {
        e.Placeable = p;
        e.Block = p.Block;
        e.Start = 0;
        e.End = p.Block.Size;
        e.EmptyIsNull = emptyIsNull;
    }

    /// <summary>Text: Count pads with NUL units up to n (longer is INPUT), Until appends one NUL unit.</summary>
    public void Str(string? v, int unit, TextEncoding enc, bool le, StrMode mode, long n = 0)
    {
        var bytes = Strings.Encode(v, enc, le);
        if (mode == StrMode.Count)
        {
            if (bytes.Length > n * unit)
                throw new YaffleException(ErrorCode.INPUT, $"string of {bytes.Length / unit} units exceeds the length {n}");
            B.Bytes(bytes);
            B.Fill(n * unit - bytes.Length, Runtime.Fill.Zero);
        }
        else
        {
            B.Bytes(bytes);
            if (mode == StrMode.Until) B.Fill(unit, Runtime.Fill.Zero);
        }
    }

    // ── padding ──────────────────────────────────────────────────────────────

    public void Pad(long n, Fill fill)
    {
        if (n < 0) throw new YaffleException(ErrorCode.RANGE, $"invalid padding length {n}");
        B.Fill(n, fill);
    }

    /// <summary>Pads until the base-relative position is a multiple of <paramref name="to"/>.</summary>
    public void Align(long to, Fill fill) => AlignAt(to, fill, false, 0);

    /// <summary>
    /// <c>@align(to, from: …, offset: …)</c>: pads until <c>(position + offset) % to == 0</c>,
    /// the position counting from the nearest base, or from the start of the current byte space
    /// (<paramref name="file"/>: the root, a codec's decoded side or a virtual stream; nested
    /// <c>@base</c> regions count from where they are written). Block starts not known yet are
    /// required to be multiples of <paramref name="to"/>, and the padding comes from the known part.
    /// </summary>
    public void AlignAt(long to, Fill fill, bool file, long offset)
    {
        if (to <= 0) throw new YaffleException(ErrorCode.RANGE, $"invalid alignment {to}");
        long start;
        if (file) start = FileStart(B, to);
        else
        {
            long? known = B == Region.Root ? 0 : B.FixedAt;
            if (known is null) B.Align = Layouts.Lcm(B.Align, to);
            start = known ?? 0;
        }
        B.Fill(Layouts.Mod(-(start + B.Size + offset), to), fill);
    }

    /// <summary>A base's <c>@alignEnd</c> (pads its whole region, after its targets), optionally with an origin or offset.</summary>
    public void RegionAlignEnd(long to, bool file, long offset)
    {
        if (to <= 0) throw new YaffleException(ErrorCode.RANGE, $"invalid alignment {to}");
        if (!file && offset == 0) Region.AlignEnd = Layouts.Lcm(Region.AlignEnd, to);
        else Region.AlignEnds.Add((to, file, offset));
    }

    /// <summary>
    /// The known part of block <paramref name="b"/>'s start in its byte space (<c>from: file</c>).
    /// A block whose position a later layout decides gets <paramref name="to"/> added to its
    /// alignment (so its start contributes a multiple of it) and counts as 0.
    /// </summary>
    public static long FileStart(Block b, long to)
    {
        var r = b.Region;
        long start;
        if (b == r.Root) start = 0;
        else if (b.FixedAt is long f) start = f;
        else
        {
            b.Align = Layouts.Lcm(b.Align, to);
            start = 0;
        }
        if (r.Anchor is var (block, at)) start += FileStart(block, to) + at;
        return start;
    }

    public void PadUntil(int start, long size, Fill fill)
    {
        long used = B.Size - start;
        if (used > size) throw new YaffleException(ErrorCode.INPUT, $"content of {used} bytes exceeds padUntil({size})");
        B.Fill(size - used, fill);
    }

    /// <summary>Closes a size(n) window opened at <paramref name="start"/>: longer content is DERIVE, shorter is padded.</summary>
    public void SizeWindow(int start, long n)
    {
        if (n < 0) throw new YaffleException(ErrorCode.RANGE, $"invalid size {n}");
        long used = B.Size - start;
        if (used > n) throw new YaffleException(ErrorCode.DERIVE, $"content of {used} bytes does not fit size {n}");
        B.Fill(n - used, Runtime.Fill.Zero);
    }

    // ── fixups ───────────────────────────────────────────────────────────────

    private void AddFixup(Block block, int at, int phase, Action<byte[], int> run) =>
        Region.Fixups.Add(new Fixup { Block = block, At = at, Phase = phase, Depth = frames.Count, Path = Path(), Run = run });

    /// <summary>Reserves <paramref name="n"/> zero bytes here and writes them after layout.</summary>
    private void Reserve(long n, int phase, Action<byte[], int> run)
    {
        var block = B;
        int at = block.Size;
        block.Fill(n, Runtime.Fill.Zero);
        AddFixup(block, at, phase, run);
    }

    /// <summary>Reserves an integer primitive whose value is computed after layout.</summary>
    public void DeferInt(Prim kind, bool le, Func<Int128> compute, int phase = 0)
    {
        int size = Prims.Size(kind);
        Reserve(size, phase, (out_, abs) => WriteInt(out_, abs, (ulong)Ck.Prim(compute(), kind), size, le));
    }

    /// <summary>Reserves a float primitive whose value is computed after layout.</summary>
    public void DeferFloat(Prim kind, bool le, Func<double> compute, int phase = 0)
    {
        int size = Prims.Size(kind);
        Reserve(size, phase, (out_, abs) =>
        {
            double v = compute();
            ulong bits = kind switch
            {
                Prim.F16 => HalfBits.FromDouble(v),
                Prim.F32 => float.IsNaN((float)v) ? 0x7fc00000 : BitConverter.SingleToUInt32Bits((float)v),
                _ => double.IsNaN(v) ? 0x7ff8000000000000 : BitConverter.DoubleToUInt64Bits(v)
            };
            WriteInt(out_, abs, bits, size, le);
        });
    }

    /// <summary>Reserves <paramref name="n"/> bytes whose content is computed after layout.</summary>
    public void DeferBytes(long n, Func<byte[]> compute, int phase = 0) =>
        Reserve(n, phase, (out_, abs) =>
        {
            var v = compute();
            if (v.Length != n) throw new YaffleException(ErrorCode.DERIVE, $"derived bytes have length {v.Length}, expected {n}");
            v.CopyTo(out_, abs);
        });

    /// <summary>A check evaluated after layout (e.g. read-side placement offsets must match).</summary>
    public void DeferCheck(Action run) => AddFixup(B, 0, 0, (_, _) => run());

    internal static void WriteInt(byte[] out_, int abs, ulong bits, int size, bool le)
    {
        for (int i = 0; i < size; i++)
        {
            out_[le ? abs + i : abs + size - 1 - i] = (byte)bits;
            bits >>= 8;
        }
    }

    internal static void WriteOffset(byte[] out_, int abs, Prim kind, bool le, long value, Int128? nullValue)
    {
        if (nullValue is Int128 nv && value == nv)
            throw new YaffleException(ErrorCode.DERIVE, $"pointer offset {value} equals the null value");
        if (!Prims.Signed(kind) && value < 0) throw new YaffleException(ErrorCode.RANGE, $"negative offset {value} for {Prims.Name(kind)}");
        var v = Ck.Prim(value, kind, "pointer");
        WriteInt(out_, abs, (ulong)v, Prims.Size(kind), le);
    }

    // ── targets ──────────────────────────────────────────────────────────────

    /// <summary>
    /// Places a pointer target: identical objects (by reference) with the same type key share one
    /// placeable. <paramref name="write"/> encodes the target into the placeable's block.
    /// </summary>
    public Placeable Target(object? value, string key, string name, Func<LEntry?> write, PlaceOptions? opts = null, object? owner = null)
    {
        var p = TargetPlaceable(value, key, name, opts, out bool created);
        if (created) Place(p, write, value, owner);
        return p;
    }

    public async ValueTask<Placeable> TargetAsync(object? value, string key, string name, Func<ValueTask<LEntry?>> write, PlaceOptions? opts = null, object? owner = null)
    {
        var p = TargetPlaceable(value, key, name, opts, out bool created);
        if (created) await PlaceAsync(p, write, value, owner).ConfigureAwait(false);
        return p;
    }

    /// <summary>The placeable that already holds <paramref name="value"/> under <paramref name="key"/>, or a new one.</summary>
    private Placeable TargetPlaceable(object? value, string key, string name, PlaceOptions? opts, out bool created)
    {
        created = true;
        if (!Values.HasIdentity(value)) return new Placeable(Region.NewBlock(), name, opts);
        if (!Region.Identity.TryGetValue(value!, out var byKey)) Region.Identity[value!] = byKey = new Dictionary<string, Placeable>();
        if (byKey.TryGetValue(key, out var hit))
        {
            created = false;
            return hit;
        }
        return byKey[key] = new Placeable(Region.NewBlock(), name, opts);
    }

    /// <summary>Places an <c>at</c> field's value (no identity sharing). <paramref name="owner"/> is the struct holding the field.</summary>
    public Placeable Place(string name, object? value, Func<LEntry?> write, PlaceOptions? opts = null, object? owner = null)
    {
        var p = new Placeable(Region.NewBlock(), name, opts);
        Place(p, write, value, owner);
        return p;
    }

    public async ValueTask<Placeable> PlaceAsync(string name, object? value, Func<ValueTask<LEntry?>> write, PlaceOptions? opts = null, object? owner = null)
    {
        var p = new Placeable(Region.NewBlock(), name, opts);
        await PlaceAsync(p, write, value, owner).ConfigureAwait(false);
        return p;
    }

    private void Place(Placeable p, Func<LEntry?> write, object? value, object? owner)
    {
        var saved = EnterPlaceable(p, value, owner);
        try
        {
            p.Content = write();
        }
        finally
        {
            (B, Index) = saved;
        }
    }

    private async ValueTask PlaceAsync(Placeable p, Func<ValueTask<LEntry?>> write, object? value, object? owner)
    {
        var saved = EnterPlaceable(p, value, owner);
        try
        {
            p.Content = await write().ConfigureAwait(false);
        }
        finally
        {
            (B, Index) = saved;
        }
    }

    /// <summary>Registers <paramref name="p"/> and makes its block current; returns what to restore.</summary>
    private (Block, long) EnterPlaceable(Placeable p, object? value, object? owner)
    {
        NoteOrigin(p, value, owner);
        Region.Placeables.Add(p);
        var saved = (B, Index);
        B = p.Block;
        Index = -1;
        return saved;
    }

    /// <summary>Writes an owned pointer: the offset of <paramref name="p"/> (null → <paramref name="nullValue"/>).</summary>
    public void Pointer(Prim kind, bool le, Placeable? p, bool relative, Int128? nullValue, Func<long>? origin = null)
    {
        int size = Prims.Size(kind);
        if (p is null)
        {
            if (nullValue is not Int128 nv) throw new YaffleException(ErrorCode.INPUT, "null for a pointer that is not nullable");
            Reserve(size, 0, (out_, abs) => WriteInt(out_, abs, (ulong)Ck.Prim(nv, kind), size, le));
            return;
        }
        Reserve(size, 0, (out_, abs) =>
        {
            if (p.Block.Pos < 0) throw new YaffleException(ErrorCode.DERIVE, $"target {p.Name} was not placed");
            long o = origin?.Invoke() ?? 0;
            WriteOffset(out_, abs, kind, le, (relative ? p.Block.Pos - abs : p.Block.Pos) - o, nullValue);
        });
    }

    /// <summary>
    /// Writes a <c>@ref</c> pointer: resolved after layout to the first placed value in this base
    /// whose encoding (type <paramref name="key"/>) equals the value's.
    /// </summary>
    public void RefPointer(Prim kind, bool le, string key, object? value, Func<byte[]> encode, bool relative, Int128? nullValue, Func<long>? origin = null)
    {
        if (value is null)
        {
            Pointer(kind, le, null, relative, nullValue);
            return;
        }
        var mark = Mark();
        B.Fill(Prims.Size(kind), Runtime.Fill.Zero);
        // Objects resolve by identity first; the encoding is computed only when that fails.
        bool isObj = Values.HasIdentity(value);
        Region.RefUses.Add(new Region.RefUse
        {
            Key = key,
            Path = Path(),
            Value = isObj ? value : null,
            Encode = isObj ? encode : null,
            Encoding = isObj ? null : encode(),
            Origin = origin,
            Mark = mark,
            Base = null,
            Kind = kind,
            Le = le,
            Relative = relative,
            NullValue = nullValue
        });
    }

    /// <summary>Hands a finished nested base region's unresolved @ref pointers to this region.</summary>
    private void AdoptRefs(Region nested, Block block, int at)
    {
        foreach (var u in nested.Unresolved)
        {
            long inner = u.Base is Mark b ? b.Abs : 0;
            Region.RefUses.Add(u.With(new Mark(block, at + (int)u.Mark.Abs), new Mark(block, at + (int)inner)));
        }
    }

    /// <summary>Registers an encoded value as a possible @ref target.</summary>
    public void RefSite(string key, int start, object? value) =>
        Region.RefSites.Add(new Region.RefSite
        {
            Key = key,
            Block = B,
            Start = start,
            End = B.Size,
            Value = Values.HasIdentity(value) ? value : null
        });

    // ── regions ──────────────────────────────────────────────────────────────

    /// <summary>
    /// Makes a fresh region current; returns the action that restores the enclosing one. A
    /// <paramref name="nested"/> base is anchored where it is written (<c>from: file</c> origins)
    /// and hands the @ref pointers it can't resolve to the enclosing base.
    /// </summary>
    private Action EnterRegion(LayoutItem[]? layout, object? value, bool nested)
    {
        var region = new Region { Layout = layout, Escalate = nested };
        if (nested) region.Anchor = (B, B.Size);
        var o = value is not null && Region.Sticky is not null && RegionOrigin is not null ? RegionOrigin(value) : null;
        long saveBase = originBase;
        if (o is var (oBase, oInline, oSize) && Region.Sticky is not null)
        {
            region.Sticky = new StickyPolicy(Region.Sticky.Grow, oInline, oSize);
            originBase = oBase;
        }
        else if (Region.Sticky is not null)
        {
            region.Sticky = new StickyPolicy(Region.Sticky.Grow, null);
        }
        var saveB = B;
        var saveR = Region;
        long saveIndex = Index;
        Region = region;
        B = region.Root;
        return () =>
        {
            Region = saveR;
            B = saveB;
            Index = saveIndex;
            originBase = saveBase;
        };
    }

    /// <summary>Finishes a region whose root wrote <paramref name="l"/> (a non-struct entry gets a wrapper struct).</summary>
    private static byte[] Finish(Region region, LEntry? l)
    {
        if (l is LStruct s) region.LRoot = s;
        else if (l is not null)
        {
            var s2 = new LStruct();
            s2.Set("$", l);
            region.LRoot = s2;
        }
        return region.Finish();
    }

    /// <summary>
    /// Encodes a fresh region (a codec's plain side, a stream, a standalone encoding) and returns
    /// its finished bytes. Nothing inside escapes to the enclosing region.
    /// </summary>
    public byte[] SubRegion(Func<Writer, LEntry?> write)
    {
        var leave = EnterRegion(null, null, false);
        var region = Region;
        try
        {
            return Finish(region, write(this));
        }
        finally
        {
            leave();
        }
    }

    public async ValueTask<byte[]> SubRegionAsync(Func<Writer, ValueTask<LEntry?>> write)
    {
        var leave = EnterRegion(null, null, false);
        var region = Region;
        try
        {
            return Finish(region, await write(this).ConfigureAwait(false));
        }
        finally
        {
            leave();
        }
    }

    /// <summary>
    /// Writes a @base struct inline: its region (own block, targets, @alignEnd) is laid out and
    /// finished on its own, then appended here. @ref pointers it can't resolve search this base and
    /// the ones enclosing it.
    /// </summary>
    public void Base(LayoutItem[]? layout, Func<Writer, LEntry?> write, object? value = null)
    {
        var leave = EnterRegion(layout, value, true);
        var region = Region;
        byte[] bytes;
        try
        {
            bytes = Finish(region, write(this));
        }
        finally
        {
            leave();
        }
        AppendBase(region, bytes);
    }

    public async ValueTask BaseAsync(LayoutItem[]? layout, Func<Writer, ValueTask<LEntry?>> write, object? value = null)
    {
        var leave = EnterRegion(layout, value, true);
        var region = Region;
        byte[] bytes;
        try
        {
            bytes = Finish(region, await write(this).ConfigureAwait(false));
        }
        finally
        {
            leave();
        }
        AppendBase(region, bytes);
    }

    private void AppendBase(Region nested, byte[] bytes)
    {
        var block = B;
        int at = block.Size;
        Raw(bytes);
        AdoptRefs(nested, block, at);
    }

    /// <summary>Serializes a root: runs <paramref name="write"/> in a fresh root region and finishes it.</summary>
    public static byte[] SerializeRoot(LayoutItem[]? layout, Func<Writer, LEntry?> write)
    {
        var region = new Region { Layout = layout };
        var w = new Writer(region);
        var l = write(w);
        if (l is LStruct s) region.LRoot = s;
        return region.Finish();
    }

    public static async ValueTask<byte[]> SerializeRootAsync(LayoutItem[]? layout, Func<Writer, ValueTask<LEntry?>> write)
    {
        var region = new Region { Layout = layout };
        var w = new Writer(region);
        var l = await write(w).ConfigureAwait(false);
        if (l is LStruct s) region.LRoot = s;
        return region.Finish();
    }

    /// <summary>Runs a writer callback in a fresh region and returns the bytes (view patch encoders).</summary>
    public static byte[] EncodeWith(Action<Writer> write)
    {
        var region = new Region();
        var w = new Writer(region);
        write(w);
        return region.Finish();
    }
}
