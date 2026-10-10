using System;
using System.Buffers.Binary;
using System.Collections.Generic;

namespace Yaffle.Runtime;

// The relocation-style writer (docs/IR.md §3.2):
//
// 1. Generated writers encode bottom-up into blocks: inline bytes plus fixups (a position, a width
//    and a closure computing the value once sizes and positions are final).
// 2. Pointer and `at` targets become placeables, each with its own block. Generated code also
//    records the structure (LStruct / LArray) the layout engine matches `layout` paths against.
// 3. When a base region (the root, a @base struct, a codec's decoded side) is complete, the layout
//    engine assigns every block a position, the blocks are assembled, and the fixups run.

/// <summary>An entry of the layout structure: a struct, an array or a placeable.</summary>
public abstract class LEntry
{
}

/// <summary>The placeables reachable from one struct instance, by field (declaration order).</summary>
public sealed class LStruct : LEntry
{
    /// <summary>The struct's layout items; set per instance when their arguments read fields.</summary>
    public LayoutItem[]? Layout;
    public readonly OrderedDictionary<string, LEntry> Fields = new();

    public LStruct(LayoutItem[]? layout = null) => Layout = layout;

    public void Set(string name, LEntry? e)
    {
        if (e is not null) Fields[name] = e;
    }
}

public sealed class LArray : LEntry
{
    public readonly List<LEntry?> Items = new();

    public void Push(LEntry? e) => Items.Add(e);
}

/// <summary>Options of a placed target.</summary>
public sealed class PlaceOptions
{
    /// <summary><c>at</c> constraint from a derived linear offset: position ≡ remainder (mod modulus).</summary>
    public (long Modulus, long Remainder)? Constraint { get; init; }

    /// <summary>Fixed placement: exactly this base-relative offset.</summary>
    public long? Fixed { get; init; }
}

/// <summary>A pointer or <c>at</c> target: its block plus the structure of its content.</summary>
public sealed class Placeable : LEntry
{
    public readonly Block Block;
    public LEntry? Content;
    public (long Modulus, long Remainder)? Constraint;
    public long? Fixed;
    /// <summary>Commit mode: original position and size (from a view).</summary>
    public long? Orig;
    public long? OrigSize;
    public readonly string Name;

    public Placeable(Block block, string name, PlaceOptions? opts = null)
    {
        Block = block;
        Name = name;
        Constraint = opts?.Constraint;
        Fixed = opts?.Fixed;
        // A fixed placement's position is known before its content is written: inner alignment is
        // computed from it instead of constraining the block's start.
        if (opts?.Fixed is long f) block.FixedAt = f;
    }

    public bool Placed => Block.Pos >= 0;
}

/// <summary>Provenance of a part copied unchanged from a source (views and codec reuse).</summary>
public readonly record struct Provenance(object Space, long Offset);

/// <summary>A run of bytes: the inline bytes of a struct and everything written after it.</summary>
public sealed class Block
{
    internal readonly List<(int At, ReadOnlyMemory<byte> Data, Provenance? Prov)> Parts = new();
    private byte[] cur = new byte[64];
    private int curLen;
    private int curAt;
    public int Size;
    /// <summary>Required start alignment (from align layers inside, relative to the block start).</summary>
    public long Align = 1;
    /// <summary>The base-relative start when known before layout (fixed placements).</summary>
    public long? FixedAt;
    /// <summary>Base-relative position, assigned by layout (-1 until then). The region root is at 0.</summary>
    public long Pos = -1;
    public readonly Region Region;

    public Block(Region region) => Region = region;

    private void Ensure(int n)
    {
        if (curLen + n <= cur.Length) return;
        int cap = cur.Length * 2;
        while (cap < curLen + n) cap *= 2;
        Array.Resize(ref cur, cap);
    }

    private void Seal()
    {
        if (curLen > 0)
        {
            Parts.Add((curAt, new ReadOnlyMemory<byte>(cur, 0, curLen), null));
            cur = new byte[64];
            curLen = 0;
        }
        curAt = Size;
    }

    private Span<byte> Grow(int n)
    {
        Ensure(n);
        var s = cur.AsSpan(curLen, n);
        curLen += n;
        Size += n;
        return s;
    }

    public void U8(byte v) => Grow(1)[0] = v;

    /// <summary>Writes the low bytes of an integer (two's complement) in the given byte order.</summary>
    public void Int(ulong bits, int size, bool le)
    {
        var s = Grow(size);
        for (int i = 0; i < size; i++)
        {
            s[le ? i : size - 1 - i] = (byte)bits;
            bits >>= 8;
        }
    }

    public void F32(float v, bool le)
    {
        if (float.IsNaN(v)) Int(0x7fc00000, 4, le);
        else if (le) BinaryPrimitives.WriteSingleLittleEndian(Grow(4), v);
        else BinaryPrimitives.WriteSingleBigEndian(Grow(4), v);
    }

    public void F64(double v, bool le)
    {
        if (double.IsNaN(v)) Int(0x7ff8000000000000, 8, le);
        else if (le) BinaryPrimitives.WriteDoubleLittleEndian(Grow(8), v);
        else BinaryPrimitives.WriteDoubleBigEndian(Grow(8), v);
    }

    /// <summary>Appends bytes. Large arrays are referenced, not copied.</summary>
    public void Bytes(ReadOnlyMemory<byte> b, Provenance? prov = null)
    {
        if (b.Length >= 512 || prov is not null)
        {
            Seal();
            if (b.Length > 0) Parts.Add((Size, b, prov));
            Size += b.Length;
            curAt = Size;
            return;
        }
        b.Span.CopyTo(Grow(b.Length));
    }

    public void Fill(long n, Fill fill)
    {
        if (fill.IsConstant && n >= 512)
        {
            var z = new byte[n];
            if (fill.ByteAt(0) != 0) z.AsSpan().Fill(fill.ByteAt(0));
            Bytes(z);
            return;
        }
        var s = Grow((int)n);
        for (int i = 0; i < n; i++) s[i] = fill.ByteAt(i);
    }

    /// <summary>All parts in order (the current buffer included).</summary>
    internal IEnumerable<(int At, ReadOnlyMemory<byte> Data, Provenance? Prov)> AllParts()
    {
        foreach (var p in Parts) yield return p;
        if (curLen > 0) yield return (curAt, new ReadOnlyMemory<byte>(cur, 0, curLen), null);
    }

    /// <summary>The block's bytes (fixups not applied).</summary>
    public byte[] ToBytes()
    {
        var out_ = new byte[Size];
        foreach (var p in AllParts()) p.Data.Span.CopyTo(out_.AsSpan(p.At));
        return out_;
    }
}

/// <summary>A value computed after layout and written into the assembled region.</summary>
public sealed class Fixup
{
    public required Block Block;
    public required int At;
    /// <summary>0 = sizes, positions, pointers; 1 = @ref pointers; 2 = content-dependent values (checksums), innermost first.</summary>
    public required int Phase;
    public required int Depth;
    /// <summary>Path of the field that registered it (for errors).</summary>
    public required IReadOnlyList<object> Path;
    /// <summary>Computes and writes the value into the assembled bytes at the absolute position.</summary>
    public required Action<byte[], int> Run;
}

/// <summary>A position inside a block (absolute = block.Pos + At once laid out).</summary>
public readonly record struct Mark(Block Block, int At)
{
    public long Abs => Block.Pos + At;
}

/// <summary>Start/end of a field's encoding, for sizeof/offsetof/bytesof.</summary>
public class Extent
{
    public Block Block;
    public int Start;
    public int End = -1;
    /// <summary>Byte length after each layer stage (<c>encodedSize(field, k)</c>); -1 = not recorded.</summary>
    public readonly List<long> Stages = new();
    /// <summary>Set for placed fields: the placeable that holds the field.</summary>
    public Placeable? Placeable;
    /// <summary>An empty placed array whose offset is written as 0 (<c>@nullable(empty)</c>).</summary>
    public bool EmptyIsNull;
    /// <summary>The plain encoding (before any codec), if a via layer recorded it.</summary>
    public byte[]? Plain;

    public Extent(Block block, int start)
    {
        Block = block;
        Start = start;
    }

    public virtual long Size
    {
        get
        {
            if (Placeable is not null) return Placeable.Block.Size;
            // While the field is still being written (its own size layer asks), the bytes so far.
            if (End < 0) return Block.Size - Start;
            return End - Start;
        }
    }

    /// <summary>Base-relative position (valid after layout).</summary>
    public long Pos
    {
        get
        {
            if (Placeable is not null)
                return EmptyIsNull && Placeable.Block.Size == 0 ? 0 : Placeable.Block.Pos;
            if (Block.Pos < 0) throw new YaffleException(ErrorCode.DERIVE, "position used before layout");
            return Block.Pos + Start;
        }
    }

    public void SetStage(int k, long size)
    {
        while (Stages.Count <= k) Stages.Add(-1);
        Stages[k] = size;
    }

    /// <summary>Encoded size after <paramref name="k"/> layer stages (0 = plain encoding).</summary>
    public long Stage(int k)
    {
        if (k < Stages.Count && Stages[k] >= 0) return Stages[k];
        if (k >= Stages.Count && End >= 0) return Size;
        throw new YaffleException(ErrorCode.DERIVE, $"encoded size at layer {k} is not available yet");
    }

    /// <summary>The field's bytes in the finished region (content-dependent fixups only).</summary>
    public byte[] Bytes()
    {
        var b = Placeable is not null ? Placeable.Block : Block;
        var out_ = b.Region.Output ?? throw new YaffleException(ErrorCode.DERIVE, "bytes of a field used before its region was assembled");
        long pos = Pos;
        return out_.AsSpan((int)pos, (int)Size).ToArray();
    }

    /// <summary>The field's plain encoding (before layers).</summary>
    public byte[] PlainBytes()
    {
        if (Plain is not null) return Plain;
        var all = Bytes();
        return Stages.Count > 0 && Stages[0] >= 0 ? all.AsSpan(0, (int)Stages[0]).ToArray() : all;
    }
}

/// <summary><c>this</c> of a base struct: its whole region (size known once the region is finished).</summary>
internal sealed class RegionExtent : Extent
{
    private readonly Region region;

    public RegionExtent(Region region) : base(region.Root, 0) => this.region = region;

    public override long Size => region.Output is not null ? region.Output.Length : region.Root.Size;
}

/// <summary>A base region: the base's own block at offset 0, plus everything placed in it.</summary>
public sealed class Region
{
    internal sealed class RefSite
    {
        public required string Key;
        public required Block Block;
        public required int Start;
        public required int End;
        public object? Value;
    }

    internal sealed class RefUse
    {
        public required string Key;
        public required IReadOnlyList<object> Path;
        public object? Value;
        public Func<byte[]>? Encode;
        public byte[]? Encoding;
        public Func<long>? Origin;
        public required Mark Mark;
        public Mark? Base;
        public required Prim Kind;
        public required bool Le;
        public required bool Relative;
        public Int128? NullValue;

        public RefUse With(Mark mark, Mark? @base) => new()
        {
            Key = Key, Path = Path, Value = Value, Encode = Encode, Encoding = Encoding, Origin = Origin,
            Mark = mark, Base = @base, Kind = Kind, Le = Le, Relative = Relative, NullValue = NullValue
        };
    }

    public readonly Block Root;
    public readonly List<Block> Blocks = new();
    public readonly List<Placeable> Placeables = new();
    public readonly List<Fixup> Fixups = new();
    internal readonly Dictionary<object, Dictionary<string, Placeable>> Identity = new(ReferenceEqualityComparer.Instance);
    internal readonly List<RefSite> RefSites = new();
    internal readonly List<RefUse> RefUses = new();
    public LStruct? LRoot;
    public LayoutItem[]? Layout;
    /// <summary>The region's total size is padded to a multiple of this (a base's <c>@alignEnd</c>).</summary>
    public long AlignEnd = 1;
    /// <summary>
    /// A base's <c>@alignEnd</c> with an origin or offset: the total size is padded
    /// until <c>(start + size + offset) % to == 0</c>, start being 0 (from the base) or the region's
    /// start in its byte space (<c>from: file</c>).
    /// </summary>
    internal readonly List<(long To, bool File, long Offset)> AlignEnds = new();
    /// <summary>
    /// Where this region's bytes go in the enclosing region, when it is a nested <c>@base</c> written
    /// inline: <c>At</c> bytes into <c>Block</c>. Null for a region that starts its own byte space
    /// (the root, a codec's decoded side, a stream, a temporary encoding).
    /// </summary>
    public (Block Block, int At)? Anchor;
    /// <summary>A nested @base struct's region: unresolved @ref pointers go to the enclosing base.</summary>
    public bool Escalate;
    internal readonly List<RefUse> Unresolved = new();
    /// <summary>Commit mode (views): keep unchanged placeables where they were.</summary>
    public StickyPolicy? Sticky;
    /// <summary>After finish: the assembled bytes.</summary>
    public byte[]? Output;
    public readonly List<(long At, int Len, Provenance Prov)> ProvenanceParts = new();

    public Region()
    {
        Root = new Block(this) { Pos = 0 };
        Blocks.Add(Root);
    }

    public Block NewBlock()
    {
        var b = new Block(this);
        Blocks.Add(b);
        return b;
    }

    /// <summary>Lays out, assembles and runs the fixups. Returns the region's bytes.</summary>
    public byte[] Finish()
    {
        LayoutEngine.LayoutRegion(this);
        long size = 0;
        foreach (var b in Blocks)
        {
            if (b.Pos < 0) continue;
            size = Math.Max(size, b.Pos + b.Size);
        }
        size = Layouts.AlignUp(size, AlignEnd);
        for (bool changed = AlignEnds.Count > 0; changed;)
        {
            changed = false;
            foreach (var (to, file, offset) in AlignEnds)
            {
                long start = file ? Writer.FileStart(Root, to) : 0;
                long pad = Layouts.Mod(-(start + size + offset), to);
                if (pad != 0)
                {
                    size += pad;
                    changed = true;
                }
            }
            if (AlignEnd > 1 && size % AlignEnd != 0)
            {
                size = Layouts.AlignUp(size, AlignEnd);
                changed = true;
            }
        }
        if (size > int.MaxValue) throw new YaffleException(ErrorCode.RANGE, $"output of {size} bytes is too large");
        var out_ = new byte[size];
        foreach (var b in Blocks)
        {
            if (b.Pos < 0) continue;
            foreach (var p in b.AllParts())
            {
                p.Data.Span.CopyTo(out_.AsSpan((int)(b.Pos + p.At)));
                if (p.Prov is Provenance pv) ProvenanceParts.Add((b.Pos + p.At, p.Data.Length, pv));
            }
        }
        Output = out_;
        foreach (var f in Fixups) if (f.Phase == 0) Run(f, out_);
        ResolveRefs(out_);
        var content = Fixups.FindAll(x => x.Phase == 2);
        content.Sort((a, b) => b.Depth.CompareTo(a.Depth));
        foreach (var f in content) Run(f, out_);
        return out_;
    }

    private static void Run(Fixup f, byte[] out_)
    {
        try
        {
            f.Run(out_, (int)(f.Block.Pos + f.At));
        }
        catch (YaffleException e)
        {
            e.SealWith(f.Path);
            throw;
        }
    }

    private void ResolveRefs(byte[] out_)
    {
        if (RefUses.Count == 0) return;
        Dictionary<string, long>? byEncoding = null;
        var byIdentity = new Dictionary<object, Dictionary<string, long>>(ReferenceEqualityComparer.Instance);
        foreach (var s in RefSites)
        {
            if (s.Block.Pos < 0 || s.Value is null) continue;
            long abs = s.Block.Pos + s.Start;
            if (!byIdentity.TryGetValue(s.Value, out var m)) byIdentity[s.Value] = m = new Dictionary<string, long>();
            if (!m.TryGetValue(s.Key, out var prev) || abs < prev) m[s.Key] = abs;
        }
        Dictionary<string, long> EncodingIndex()
        {
            if (byEncoding is not null) return byEncoding;
            byEncoding = new Dictionary<string, long>();
            foreach (var s in RefSites)
            {
                if (s.Block.Pos < 0) continue;
                long abs = s.Block.Pos + s.Start;
                var key = s.Key + "|" + Hex.Encode(out_.AsSpan((int)abs, (int)(s.Block.Pos + s.End - abs)));
                if (!byEncoding.TryGetValue(key, out var prev) || abs < prev) byEncoding[key] = abs;
            }
            return byEncoding;
        }
        foreach (var u in RefUses)
        {
            try
            {
                long? target = null;
                if (u.Value is not null && byIdentity.TryGetValue(u.Value, out var m) && m.TryGetValue(u.Key, out var t)) target = t;
                if (target is null)
                {
                    var enc = u.Encoding ?? u.Encode!();
                    if (EncodingIndex().TryGetValue(u.Key + "|" + Hex.Encode(enc), out var t2)) target = t2;
                }
                if (target is null)
                {
                    if (Escalate)
                    {
                        Unresolved.Add(u);
                        continue;
                    }
                    throw new YaffleException(ErrorCode.REF, "no equal value is placed in this base for a @ref pointer");
                }
                long abs = u.Mark.Abs;
                long @base = u.Base is Mark bm ? bm.Abs : 0;
                long value = (u.Relative ? target.Value - abs : target.Value - @base) - (u.Origin?.Invoke() ?? 0);
                Writer.WriteOffset(out_, (int)abs, u.Kind, u.Le, value, u.NullValue);
            }
            catch (YaffleException e)
            {
                e.SealWith(u.Path);
                throw;
            }
        }
    }
}
