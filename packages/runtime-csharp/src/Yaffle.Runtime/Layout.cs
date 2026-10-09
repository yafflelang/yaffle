using System;
using System.Collections.Generic;
using System.Linq;

namespace Yaffle.Runtime;

/// <summary>
/// A layer of a layout item (<c>layout { x @align(8) }</c>). An align layer with an offset or a
/// file origin asks for <c>(start - origin + offset) % to == 0</c>. Arguments may be computed from
/// the owning struct's fields; an alignment below 1 or a negative padding is <c>RANGE</c>.
/// </summary>
public readonly record struct LayoutLayer(LayoutLayerKind Kind, long Value, long Offset = 0, bool File = false)
{
    public static LayoutLayer Align(long to) => new(LayoutLayerKind.Align, Alignment(to));
    public static LayoutLayer AlignAt(long to, long offset, bool file) => new(LayoutLayerKind.Align, Alignment(to), offset, file);
    public static LayoutLayer PadBefore(long n) => new(LayoutLayerKind.PadBefore, Padding(n));
    public static LayoutLayer PadAfter(long n) => new(LayoutLayerKind.PadAfter, Padding(n));
    public static LayoutLayer AlignEnd(long to) => new(LayoutLayerKind.AlignEnd, Alignment(to));

    /// <summary>An align layer that is a residue condition rather than a plain alignment.</summary>
    internal bool Residue => Kind == LayoutLayerKind.Align && (Offset != 0 || File);

    private static long Alignment(long to) =>
        to >= 1 ? to : throw new YaffleException(ErrorCode.RANGE, $"invalid alignment {to}");

    private static long Padding(long n) =>
        n >= 0 ? n : throw new YaffleException(ErrorCode.RANGE, $"invalid padding length {n}");
}

public enum LayoutLayerKind
{
    Align,
    PadBefore,
    PadAfter,
    AlignEnd
}

/// <summary>One item of a struct's <c>layout { … }</c>: "this", or field names with "*" for <c>[*]</c>.</summary>
public sealed class LayoutItem
{
    /// <summary>Null for <c>this</c>.</summary>
    public readonly string[]? Path;
    public readonly LayoutLayer[] Layers;

    /// <summary>
    /// A per-element group: <see cref="Path"/> names an array; for each element in order, these
    /// items (paths relative to the element; "this" = the element when it is a target) are placed
    /// in order. Everything they name is claimed by the group.
    /// </summary>
    public LayoutItem[]? Group { get; init; }

    public LayoutItem(string[]? path, params LayoutLayer[] layers)
    {
        Path = path;
        Layers = layers;
    }

    public bool IsThis => Path is null;
}

/// <summary>
/// How a view commit treats size changes: Default (targets that grow move to the end), Append
/// (pushed targets move to the end too), Splice (every size change shifts what follows), Error.
/// </summary>
public enum Grow
{
    Default,
    Append,
    Splice,
    Error
}

/// <summary>Sticky layout of a view commit: keep unchanged placeables where they were.</summary>
public sealed record StickyPolicy(Grow Grow, long? OrigRootSize, long? OrigSize = null);

public static class Layouts
{
    public static long Gcd(long a, long b)
    {
        while (b != 0) (a, b) = (b, a % b);
        return a;
    }

    public static long Lcm(long a, long b) => a / Gcd(a, b) * b;

    public static long AlignUp(long x, long a) => a <= 1 ? x : (x + a - 1) / a * a;

    /// <summary>The non-negative remainder of <paramref name="a"/> modulo <paramref name="m"/>.</summary>
    public static long Mod(long a, long m) => ((a % m) + m) % m;

    /// <summary>
    /// A region layout meaning "the layout of the region's root struct instance": layouts whose item
    /// arguments read fields are built per instance (<see cref="LStruct.Layout"/>).
    /// </summary>
    public static readonly LayoutItem[] Instance = new LayoutItem[0];

    /// <summary>The items that order the root struct of <paramref name="region"/>.</summary>
    internal static LayoutItem[]? RootItems(Region region) =>
        ReferenceEquals(region.Layout, Instance) ? region.LRoot?.Layout : region.Layout;
}

/// <summary>
/// The layout engine (docs/IR.md §4): assigns every placeable of a base region a position.
/// Default order: the base's own bytes first, then each placeable's unit in pre-order. Layout
/// items order a struct's own targets; items in an outer struct run first, so they pull groups
/// out of inner layouts. Fixed placements go exactly where they say; overlaps are OVERLAP errors
/// and sequential placement flows around them.
/// </summary>
public static class LayoutEngine
{
    private sealed record Range(long Start, long End, string Name);

    /// <summary>Residue conditions of a placement: start ≡ Rem (mod To).</summary>
    private sealed class Residues : List<(long To, long Rem)>
    {
        public bool Hold(long pos) => TrueForAll(r => Layouts.Mod(pos, r.To) == r.Rem);
    }

    private sealed class Engine
    {
        public long Cursor;
        public readonly List<Range> Reserved = new();
        private readonly Region region;
        /// <summary>Placeables claimed by a layout item of an enclosing container.</summary>
        private readonly HashSet<Placeable> claimed = new(ReferenceEqualityComparer.Instance);
        private readonly HashSet<Placeable> visiting = new(ReferenceEqualityComparer.Instance);
        /// <summary>Called for every block placement (sticky mode bookkeeping).</summary>
        public Action<Placeable, LayoutLayer[]>? OnPlace;

        public Engine(Region region)
        {
            this.region = region;
            Cursor = region.Root.Size;
            if (region.Root.Size > 0) Reserved.Add(new Range(0, region.Root.Size, "base"));
        }

        /// <summary>The default layout of everything not placed yet: the root struct's items, then every unit.</summary>
        public void PlaceAll()
        {
            if (region.LRoot is not null) ProcessStruct(region.LRoot, Layouts.RootItems(region), null, None);
            foreach (var p in region.Placeables) if (!p.Placed) PlaceUnit(p, None);
        }

        public void PlaceFixed(Placeable p)
        {
            long start = p.Fixed!.Value;
            if (start < 0) throw new YaffleException(ErrorCode.RANGE, $"invalid fixed offset {start} for {p.Name}");
            long end = start + p.Block.Size;
            if (end > start)
            {
                foreach (var r in Reserved)
                {
                    if (start < r.End && r.Start < end)
                        throw new YaffleException(ErrorCode.OVERLAP,
                            $"{p.Name} at [0x{start:x}, 0x{end:x}) overlaps {r.Name} at [0x{r.Start:x}, 0x{r.End:x})");
                }
                Reserved.Add(new Range(start, end, p.Name));
            }
            p.Block.Pos = start;
        }

        public bool Overlaps(long pos, long size) => Reserved.Any(r => pos < r.End && r.Start < pos + size);

        /// <summary>Smallest position ≥ <paramref name="from"/> satisfying alignment and constraint, not overlapping fixed ranges.</summary>
        public long FindPos(Placeable p, long align, long from)
        {
            long size = p.Block.Size;
            long pos = Satisfy(p, align, from);
            for (int guard = 0; guard < 100000; guard++)
            {
                var hit = size > 0 ? Reserved.Find(r => pos < r.End && r.Start < pos + size) : null;
                if (hit is null) return pos;
                pos = Satisfy(p, align, hit.End);
            }
            throw new YaffleException(ErrorCode.OVERLAP, $"no room for {p.Name}");
        }

        /// <summary>The residue conditions of a layer list.</summary>
        public Residues? ResiduesOf(LayoutLayer[] layers)
        {
            Residues? out_ = null;
            foreach (var l in layers)
            {
                if (!l.Residue) continue;
                long origin = l.File ? Writer.FileStart(region.Root, l.Value) : 0;
                (out_ ??= new()).Add((l.Value, Layouts.Mod(-(origin + l.Offset), l.Value)));
            }
            return out_;
        }

        /// <summary>The smallest such position that also satisfies the residues.</summary>
        public long FindPos(Placeable p, long align, Residues? residues, long from)
        {
            long pos = FindPos(p, align, from);
            if (residues is null) return pos;
            for (int guard = 0; !residues.Hold(pos); guard++)
            {
                if (guard > 1 << 20) throw new YaffleException(ErrorCode.DERIVE, $"no position satisfies the alignment of {p.Name}");
                pos = FindPos(p, align, pos + 1);
            }
            return pos;
        }

        private static long Satisfy(Placeable p, long align, long from)
        {
            long pos = Layouts.AlignUp(from, align);
            if (p.Constraint is var (m, rem) && m > 1)
            {
                long r = Layouts.Mod(rem, m);
                long guard = 0;
                while (Layouts.Mod(pos, m) != r)
                {
                    pos += align;
                    if (++guard > m)
                        throw new YaffleException(ErrorCode.DERIVE, $"placement constraint ≡ {r} (mod {m}) cannot be met with alignment {align}");
                }
            }
            return pos;
        }

        public void PlaceBlock(Placeable p, LayoutLayer[] layers)
        {
            OnPlace?.Invoke(p, layers);
            if (p.Placed)
            {
                // Reaching a fixed placement moves the running position past it.
                if (p.Fixed is not null) Cursor = Math.Max(Cursor, p.Block.Pos + p.Block.Size);
                return;
            }
            long cursor = Cursor;
            foreach (var l in layers) if (l.Kind == LayoutLayerKind.PadBefore) cursor += l.Value;
            long pos = FindPos(p, ItemAlign(p, layers), ResiduesOf(layers), cursor);
            p.Block.Pos = pos;
            cursor = pos + p.Block.Size;
            foreach (var l in layers)
            {
                if (l.Kind == LayoutLayerKind.PadAfter) cursor += l.Value;
                else if (l.Kind == LayoutLayerKind.AlignEnd) cursor = Layouts.AlignUp(cursor, l.Value);
            }
            Cursor = Math.Max(Cursor, cursor);
        }

        private void PlaceUnit(Placeable p, LayoutLayer[] layers)
        {
            if (visiting.Contains(p))
            {
                PlaceBlock(p, layers);
                return;
            }
            visiting.Add(p);
            try
            {
                var c = p.Content;
                if (c is LStruct s) ProcessStruct(s, s.Layout, p, layers);
                else
                {
                    PlaceBlock(p, layers);
                    if (c is not null) PlaceRemaining(c, layers);
                }
            }
            finally
            {
                visiting.Remove(p);
            }
        }

        private void PlaceRemaining(LEntry e, LayoutLayer[] layers)
        {
            switch (e)
            {
                case Placeable p:
                    // A placeable claimed by a container's item is placed by that item only.
                    if (!claimed.Contains(p)) PlaceUnit(p, layers);
                    break;
                case LArray a:
                    foreach (var it in a.Items) if (it is not null) PlaceRemaining(it, layers);
                    break;
                case LStruct s:
                    ProcessStruct(s, s.Layout, null, layers);
                    break;
            }
        }

        private void ProcessStruct(LStruct s, LayoutItem[]? items, Placeable? self, LayoutLayer[] inherited)
        {
            if (items is { Length: > 0 })
            {
                // Claim every placeable an item names, so no other unit places it first.
                var mine = new HashSet<Placeable>(ReferenceEqualityComparer.Instance);
                ClaimItems(s, items, mine);
                if (self is not null && !items.Any(i => i.IsThis)) PlaceBlock(self, inherited);
                PlaceItems(s, items, self, inherited, mine);
                foreach (var p in mine) claimed.Remove(p);
            }
            if (self is not null) PlaceBlock(self, inherited);
            foreach (var e in s.Fields.Values) PlaceRemaining(e, inherited);
        }

        /// <summary>Claims every placeable the items name (group items: for every element of their array).</summary>
        private void ClaimItems(LEntry s, LayoutItem[] items, HashSet<Placeable> mine)
        {
            foreach (var item in items)
            {
                if (item.IsThis) continue;
                var reached = ResolvePath(s, item.Path!);
                if (item.Group is { } group)
                {
                    foreach (var el in ElementsOf(reached)) ClaimItems(el, group, mine);
                    continue;
                }
                foreach (var e in reached)
                {
                    if (e is Placeable p && !claimed.Contains(p) && !p.Placed)
                    {
                        claimed.Add(p);
                        mine.Add(p);
                    }
                }
            }
        }

        /// <summary>Places the items in order (<paramref name="self"/> is what <c>this</c> names).</summary>
        private void PlaceItems(LEntry s, LayoutItem[] items, Placeable? self, LayoutLayer[] inherited, HashSet<Placeable> mine)
        {
            foreach (var item in items)
            {
                var layers = item.Layers.Length > 0 ? item.Layers : inherited;
                if (item.IsThis)
                {
                    if (self is not null) PlaceBlock(self, layers);
                    continue;
                }
                var reached = ResolvePath(s, item.Path!);
                if (item.Group is { } group)
                {
                    // An element that is itself a target comes first, like `this` in a unit,
                    // unless the group names `this`.
                    bool namesThis = group.Any(g => g.IsThis);
                    foreach (var el in ElementsOf(reached))
                    {
                        var elSelf = el as Placeable;
                        if (elSelf is not null && !namesThis) PlaceBlock(elSelf, layers);
                        PlaceItems(el, group, elSelf, layers, mine);
                    }
                    continue;
                }
                foreach (var e in reached)
                {
                    if (e is not Placeable p) PlaceRemaining(e, layers);
                    else if (mine.Contains(p))
                    {
                        claimed.Remove(p);
                        PlaceUnit(p, layers);
                    }
                    else if (!claimed.Contains(p)) PlaceUnit(p, layers);
                }
            }
        }
    }

    /// <summary>The alignment a placement needs: the block's own and its item's plain align layers.</summary>
    private static long ItemAlign(Placeable p, LayoutLayer[] layers)
    {
        long a = p.Block.Align;
        foreach (var l in layers) if (l.Kind == LayoutLayerKind.Align && !l.Residue) a = Layouts.Lcm(a, l.Value);
        return a;
    }

    /// <summary>A placeable stands for its content.</summary>
    private static LEntry? Through(LEntry e) => e is Placeable p ? p.Content : e;

    /// <summary>The elements of the arrays a group's path reaches (through pointer targets).</summary>
    private static List<LEntry> ElementsOf(List<LEntry> reached)
    {
        var out_ = new List<LEntry>();
        foreach (var e in reached)
            if (Through(e) is LArray a) foreach (var it in a.Items) if (it is not null) out_.Add(it);
        return out_;
    }

    /// <summary>Entries a layout path reaches from struct <paramref name="s"/> (descending through placeables' contents).</summary>
    private static List<LEntry> ResolvePath(LEntry s, string[] path)
    {
        var cur = new List<LEntry> { s };
        foreach (var seg in path)
        {
            var next = new List<LEntry>();
            foreach (var e0 in cur)
            {
                var e = Through(e0);
                if (seg == "*")
                {
                    if (e is LArray a) foreach (var it in a.Items) if (it is not null) next.Add(it);
                }
                else if (e is LStruct st && st.Fields.TryGetValue(seg, out var f)) next.Add(f);
            }
            cur = next;
        }
        return cur;
    }

    private static readonly LayoutLayer[] None = Array.Empty<LayoutLayer>();

    /// <summary>Assigns positions to every block of the region.</summary>
    public static void LayoutRegion(Region region)
    {
        if (region.Sticky is { OrigRootSize: not null })
        {
            StickyLayout(region, region.Sticky);
            return;
        }
        foreach (var p in region.Placeables) p.Block.Pos = -1;
        var engine = new Engine(region);
        foreach (var p in region.Placeables) if (p.Fixed is not null) engine.PlaceFixed(p);
        engine.PlaceAll();
    }

    /// <summary>
    /// Runs the default layout from the given start positions, reporting every block placement,
    /// then restores the blocks' positions.
    /// </summary>
    private static void DryRun(Region region, Func<Placeable, long> start, Action<Engine, Placeable, LayoutLayer[]> onPlace)
    {
        var saved = region.Placeables.Select(p => p.Block.Pos).ToList();
        foreach (var p in region.Placeables) p.Block.Pos = start(p);
        Engine engine = null!;
        engine = new Engine(region) { OnPlace = (p, layers) => onPlace(engine, p, layers) };
        engine.PlaceAll();
        for (int i = 0; i < region.Placeables.Count; i++) region.Placeables[i].Block.Pos = saved[i];
    }

    /// <summary>Default placement order of every placeable (sticky mode uses it for new ones).</summary>
    private static List<Placeable> DefaultOrder(Region region)
    {
        var order = new List<Placeable>();
        var seen = new HashSet<Placeable>(ReferenceEqualityComparer.Instance);
        DryRun(region, p => p.Fixed is not null ? 0 : p.Block.Pos, (_, p, _) =>
        {
            if (seen.Add(p)) order.Add(p);
        });
        return order;
    }

    /// <summary>The item alignment and residues that apply to each placeable in default layout (for re-alignment when shifting).</summary>
    private static Dictionary<Placeable, (long Align, Residues? Residues)> ItemConstraints(Region region)
    {
        var out_ = new Dictionary<Placeable, (long, Residues?)>(ReferenceEqualityComparer.Instance);
        DryRun(region, p => p.Fixed ?? -1, (engine, p, layers) =>
        {
            // Only the first placement counts (ResiduesOf may raise the alignment of an anchor block).
            if (!out_.ContainsKey(p)) out_[p] = (ItemAlign(p, layers), engine.ResiduesOf(layers));
        });
        return out_;
    }

    private static bool Fits(Placeable p, long align, long pos, Residues? residues)
    {
        if (align > 1 && pos % align != 0) return false;
        if (p.Constraint is var (m, r) && m > 1 && Layouts.Mod(pos, m) != Layouts.Mod(r, m)) return false;
        return residues is null || residues.Hold(pos);
    }

    private static void StickyLayout(Region region, StickyPolicy policy)
    {
        var constraints = ItemConstraints(region);
        (long Align, Residues? Residues) Of(Placeable p) => constraints.TryGetValue(p, out var c) ? c : (p.Block.Align, null);
        var order = DefaultOrder(region);
        foreach (var p in region.Placeables) p.Block.Pos = -1;
        var engine = new Engine(region);
        foreach (var p in region.Placeables) if (p.Fixed is not null) engine.PlaceFixed(p);

        long origRoot = policy.OrigRootSize!.Value;
        if (policy.Grow == Grow.Error && region.Root.Size != origRoot)
            throw new YaffleException(ErrorCode.DERIVE, $"the base grew from {origRoot} to {region.Root.Size} bytes (grow: error)");
        var old = region.Placeables.Where(p => p.Orig is not null && p.Fixed is null).OrderBy(p => p.Orig!.Value).ToList();
        var toEnd = new List<Placeable>();
        long origCursor = origRoot;
        long origEnd = policy.OrigSize ?? origRoot;
        foreach (var p in old) origEnd = Math.Max(origEnd, p.Orig!.Value + (p.OrigSize ?? 0));

        foreach (var p in old)
        {
            long size = p.Block.Size;
            long origSize = p.OrigSize ?? size;
            long orig = p.Orig!.Value;
            if (policy.Grow == Grow.Error && size != origSize)
                throw new YaffleException(ErrorCode.DERIVE, $"{p.Name} changed size from {origSize} to {size} (grow: error)");
            var (align, residues) = Of(p);
            bool grows = size > origSize;
            bool keep = Fits(p, align, orig, residues);
            // The part of the original gap that alignment does not explain is kept.
            long extra = Math.Max(0, orig - Layouts.AlignUp(origCursor, align));
            long pos;
            if (grows && policy.Grow is Grow.Default or Grow.Append)
            {
                toEnd.Add(p);
                origCursor = Math.Max(origCursor, orig + origSize);
                continue;
            }
            if (size == 0 && origSize == 0 && keep && policy.Grow != Grow.Splice)
            {
                // An empty target overlaps nothing: it keeps its offset (which may equal the start
                // of a struct placed just before it).
                p.Block.Pos = orig;
                continue;
            }
            if (policy.Grow == Grow.Splice)
            {
                pos = engine.Cursor == origCursor && keep ? orig : engine.FindPos(p, align, residues, engine.Cursor + extra);
            }
            else if (engine.Cursor <= orig && keep)
            {
                pos = orig;
                if (engine.Overlaps(orig, size)) pos = engine.FindPos(p, align, residues, pos);
            }
            else if (policy.Grow == Grow.Append || !keep)
            {
                toEnd.Add(p);
                origCursor = Math.Max(origCursor, orig + origSize);
                continue;
            }
            else
            {
                pos = engine.FindPos(p, align, residues, engine.Cursor + extra);
            }
            p.Block.Pos = pos;
            engine.Cursor = Math.Max(engine.Cursor, pos + size);
            origCursor = Math.Max(origCursor, orig + origSize);
        }
        // Moved and new placeables go at the end, in default layout order.
        if (policy.Grow != Grow.Splice) engine.Cursor = Math.Max(engine.Cursor, origEnd);
        var rest = new HashSet<Placeable>(toEnd, ReferenceEqualityComparer.Instance);
        foreach (var p in region.Placeables) if (!p.Placed) rest.Add(p);
        foreach (var p in order)
        {
            if (!rest.Contains(p) || p.Placed) continue;
            var (align, residues) = Of(p);
            p.Block.Pos = engine.FindPos(p, align, residues, engine.Cursor);
            engine.Cursor = p.Block.Pos + p.Block.Size;
        }
        foreach (var p in region.Placeables)
        {
            if (!p.Placed)
            {
                p.Block.Pos = engine.FindPos(p, p.Block.Align, engine.Cursor);
                engine.Cursor = p.Block.Pos + p.Block.Size;
            }
        }
    }
}
