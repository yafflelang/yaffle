using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Yaffle.Runtime;

// Lazy views and surgical writes.
//
// A view's root is an object of the regular generated class, filled by the generated `Scan_X`
// functions instead of `Read_X`: scalars are read right away (and their byte ranges and original
// values recorded in a ViewNode), while pointer and `at` targets, byte arrays, fixed-size-element
// arrays, codec regions and virtual streams are deferred in the field's Slot and read on first
// access. Inline structs are scanned (shallowly) as child nodes.
//
// Commit compares every scanned node with what was read: same-size edits of patchable scalars
// become in-place patches (fast path, nothing else is read). Anything else is structural: the
// root is re-serialized by the generated writer with a sticky layout (placeables keep their
// positions where the grow policy allows), unchanged byte arrays keep their provenance and codec
// regions reuse their bytes, and the result is diffed against the original into patches.

/// <summary>
/// The backing field of a property that a view can load lazily. Regular parses and user code just
/// set it; a view's scan defers a loader that runs on first access.
/// </summary>
public struct Slot<T>
{
    private T value;
    private Func<T>? loader;

    public T Get()
    {
        if (loader is { } l)
        {
            value = l();
            loader = null;
        }
        return value;
    }

    public void Set(T v)
    {
        value = v;
        loader = null;
    }

    public void Defer(Func<T> l)
    {
        value = default!;
        loader = l;
    }

    /// <summary>True unless a loader is pending.</summary>
    public readonly bool IsLoaded => loader is null;

}

/// <summary>How a view scan treats a field.</summary>
public enum ViewFieldKind
{
    /// <summary>Read during the scan (scalars, strings): compared with the original on commit.</summary>
    Eager,
    /// <summary>An inline struct, scanned as a child node: replacing it is structural.</summary>
    Child,
    /// <summary>Deferred in a Slot: replacing or mutating it is structural.</summary>
    Lazy,
    /// <summary>Read completely during the scan without tracking (unions): commits take the slow path.</summary>
    Opaque
}

/// <summary>View metadata of a field (emitted by the backend).</summary>
public sealed class ViewField
{
    public required string Name { get; init; }
    public required ViewFieldKind Kind { get; init; }
    /// <summary>Not derived: the field can be set.</summary>
    public required bool Input { get; init; }
    /// <summary>A later read-side expression depends on it: changing it changes the structure.</summary>
    public required bool Structural { get; init; }
    /// <summary>
    /// Encodes the field's current value for an in-place patch: (struct, struct arguments) → bytes.
    /// Null when the field cannot be patched (no fixed-size encoding, or a derived value depends on it).
    /// </summary>
    public Func<object, object[], byte[]>? Encode { get; init; }
}

/// <summary>View metadata of a struct (emitted by the backend).</summary>
public sealed class StructInfo
{
    /// <summary>The struct's type key (identity of scanned objects).</summary>
    public required string Key { get; init; }
    /// <summary>In-place edits inside inline children cannot change this struct's derived values.</summary>
    public required bool ChildSafe { get; init; }
    public required ViewField[] Fields { get; init; }
    /// <summary>The current value of field i: (struct, index, load) → value, or <see cref="Views.Pending"/>.</summary>
    public required Func<object, int, bool, object?> Get { get; init; }
}

/// <summary>A byte space: the view's source, a codec's decoded output, or a virtual stream.</summary>
public sealed class Space(ByteStore store)
{
    public ByteStore Store { get; } = store;

    public Reader ReaderAt(int pos, int @base, int end, bool strict) =>
        new(Store, strict) { Pos = pos, Base = @base, End = end, MaxEnd = pos };
}

/// <summary>The view bookkeeping of one scanned struct value.</summary>
public sealed class ViewNode
{
    public ViewRoot Root { get; }
    public Space Space { get; }
    public StructInfo Info { get; }
    public object Value { get; set; } = null!;
    public int Pos { get; }
    internal readonly bool Strict;
    public object[] Args { get; }
    public object[] Path { get; }
    public ViewNode? Parent { get; }
    /// <summary>End of the inline bytes (before a base struct's targets).</summary>
    public int InlineEnd { get; internal set; } = -1;
    /// <summary>End of everything the scan consumed.</summary>
    public int ExtentEnd { get; internal set; } = -1;
    internal readonly int[] RangeStart;
    internal readonly int[] RangeEnd;
    internal readonly object?[] Original;
    internal readonly bool[] Loaded;
    internal readonly object?[] LoadedValue;
    internal readonly object?[] Snapshot;
    internal readonly (int Pos, int Size)[] TargetOrigin;
    /// <summary>The deferred read of each lazy field (to find where an original target was after the field was replaced).</summary>
    internal readonly Func<object?>?[] OriginalLoad;
    /// <summary>Deferred bytes fields whose length is known without reading them (virtual stream pieces).</summary>
    internal readonly LazyBytes?[] LazyBytesOf;

    internal ViewNode(ViewRoot root, Space space, StructInfo info, int pos, bool strict, object[] args, object[] path, ViewNode? parent)
    {
        Root = root;
        Space = space;
        Info = info;
        Pos = pos;
        Strict = strict;
        Args = args;
        Path = path;
        Parent = parent;
        int n = info.Fields.Length;
        RangeStart = new int[n];
        RangeEnd = new int[n];
        Array.Fill(RangeStart, -1);
        Original = new object?[n];
        Loaded = new bool[n];
        LoadedValue = new object?[n];
        Snapshot = new object?[n];
        TargetOrigin = new (int, int)[n];
        OriginalLoad = new Func<object?>?[n];
        LazyBytesOf = new LazyBytes?[n];
        Array.Fill(TargetOrigin, (-1, -1));
    }

    /// <summary>
    /// Records how to read deferred bytes field <paramref name="i"/> without loading it: its length
    /// and a store over its bytes (so a virtual stream decodes only the pieces a read touches).
    /// </summary>
    public void Bytes(int i, long length, Func<ByteStore> open) => LazyBytesOf[i] = new LazyBytes(length, open);

    /// <summary>Size of the struct's bytes (inline extent; a base struct includes its targets).</summary>
    public int Size => ExtentEnd - Pos;

    /// <summary>Records an eagerly read field: its byte range and value.</summary>
    public void Field(int i, int start, int end, object? value)
    {
        RangeStart[i] = start;
        RangeEnd[i] = end;
        Original[i] = value switch
        {
            byte[] b => b.Clone(),
            _ => value
        };
    }

    /// <summary>Records the byte range of a field (lazy and child fields).</summary>
    public void Range(int i, int start, int end)
    {
        RangeStart[i] = start;
        RangeEnd[i] = end;
    }

    /// <summary>Records where a pointer or <c>at</c> field's target was.</summary>
    public void Target(int i, long addr) => TargetOrigin[i] = ((int)Math.Clamp(addr, -1, int.MaxValue), TargetOrigin[i].Size);

    /// <summary>A reader for deferred reads in this node's region.</summary>
    public Reader ReaderAt(int pos, int @base, int end) => Space.ReaderAt(pos, @base, end, Strict);

    internal object[] PathWith(params object[] more)
    {
        var p = new object[Path.Length + more.Length];
        Path.CopyTo(p, 0);
        more.CopyTo(p, Path.Length);
        return p;
    }
}

/// <summary>A change against the original bytes: remove <c>Remove</c> bytes at <c>At</c>, insert <c>Insert</c>.</summary>
public readonly record struct Patch(int At, int Remove, byte[] Insert);

/// <summary>Commit options of a view.</summary>
public sealed class CommitOptions
{
    /// <summary>How size changes are handled (default: growing targets move to the end).</summary>
    public Grow Grow { get; init; } = Grow.Default;

    /// <summary>
    /// Re-serialize the whole view (sticky layout, codec reuse) even when every edit could be
    /// patched in place. With no edits, the result is still the original bytes.
    /// </summary>
    public bool Rewrite { get; init; }
}

/// <summary>What a view needs to scan and re-serialize its root.</summary>
public sealed class ViewSpec
{
    public required StructInfo Info { get; init; }
    public required object[] Args { get; init; }
    public required bool Strict { get; init; }
    public required LayoutItem[]? Layout { get; init; }
    /// <summary>Creates the root object and scans it: (reader, node) → root value.</summary>
    public required Func<Reader, ViewNode, object> Scan { get; init; }
    public required Func<Writer, object, LEntry?> Write { get; init; }
    /// <summary>The root writer of a format with async codecs (structural commits of async views).</summary>
    public Func<Writer, object, ValueTask<LEntry?>>? WriteAsync { get; init; }
}

/// <summary>A deferred bytes field of a view: its length, known without reading it, and a store over its bytes.</summary>
internal sealed record LazyBytes(long Length, Func<ByteStore> Open);

/// <summary>A codec region a view decoded: its space, and its decoded bytes unless they are decoded lazily (@ranged).</summary>
internal sealed record DecodedRegion(Space Space, byte[]? Decoded);
