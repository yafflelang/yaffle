using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

namespace Yaffle.Runtime;

/// <summary>The state of a view: its spaces, scanned nodes, loaded values and origins.</summary>
public sealed class ViewRoot
{
    public ViewSpec Spec { get; }
    public Space Space { get; private set; }
    internal readonly List<ViewNode> Nodes = new();
    private readonly Dictionary<(Space, int, string), (object Value, ViewNode? Node)> objects = new();
    internal readonly Dictionary<(Space, int, string), (object? Value, int Size)> Targets = new();
    internal readonly Dictionary<string, DecodedRegion> Regions = new();
    internal readonly Dictionary<object, byte[]> AsyncDecoded = new();
    internal ConditionalWeakTable<object, Tuple<Space, int, int>> Origins = new();
    internal ConditionalWeakTable<byte[], Tuple<Space, int>> BytesOrigins = new();
    /// <summary>Set when an untracked (opaque) value was read: commits take the slow path.</summary>
    internal bool Opaque;
    private object? root;
    public ViewNode? RootNode { get; private set; }
    internal readonly ISink? Sink;

    public ViewRoot(ByteStore store, ViewSpec spec, ISink? sink = null)
    {
        Spec = spec;
        Space = new Space(store);
        Sink = sink;
    }

    /// <summary>The root value (scanned on first access, and again after a commit).</summary>
    public object Root
    {
        get
        {
            if (root is null)
            {
                Nodes.Clear();
                var node = new ViewNode(this, Space, Spec.Info, 0, Spec.Strict, Spec.Args, Array.Empty<object>(), null);
                var r = Space.ReaderAt(0, 0, Space.Store.Size, Spec.Strict);
                var v = Spec.Scan(r, node);
                node.Value = v;
                if (node.InlineEnd < 0) node.InlineEnd = r.InlineEnd >= 0 ? r.InlineEnd : r.Pos;
                node.ExtentEnd = Math.Max(r.Pos, node.ExtentEnd);
                Nodes.Add(node);
                Origins.AddOrUpdate(v, Tuple.Create(Space, 0, node.ExtentEnd));
                RootNode = node;
                root = v;
            }
            return root;
        }
    }

    internal bool TryObject(Space space, int pos, string key, out object value, out ViewNode? node)
    {
        if (objects.TryGetValue((space, pos, key), out var hit))
        {
            value = hit.Value;
            node = hit.Node;
            return true;
        }
        value = null!;
        node = null;
        return false;
    }

    internal void AddObject(Space space, int pos, string key, object value, ViewNode? node) => objects[(space, pos, key)] = (value, node);

    internal void RemoveObject(Space space, int pos, string key) => objects.Remove((space, pos, key));

    // ── commit ─────────────────────────────────────────────────────────────────

    /// <summary>The edits as patches against the original bytes (no side effects).</summary>
    public IReadOnlyList<Patch> Patches(CommitOptions? opts = null) => Plan(opts ?? new CommitOptions()).Patches;

    /// <summary>Applies the edits and rebinds the view to the new bytes; returns them.</summary>
    public byte[] Commit(CommitOptions? opts = null)
    {
        var plan = Plan(opts ?? new CommitOptions());
        var bytes = plan.Bytes();
        Sink?.Write(bytes, plan.Patches);
        Rebind(new ArrayStore(bytes));
        return bytes;
    }

    internal void Rebind(ByteStore store)
    {
        Space = new Space(store);
        Nodes.Clear();
        objects.Clear();
        Targets.Clear();
        Regions.Clear();
        AsyncDecoded.Clear();
        Origins = new ConditionalWeakTable<object, Tuple<Space, int, int>>();
        BytesOrigins = new ConditionalWeakTable<byte[], Tuple<Space, int>>();
        Opaque = false;
        root = null;
        RootNode = null;
    }

    internal sealed class CommitPlan
    {
        public required IReadOnlyList<Patch> Patches;
        public required Func<byte[]> Bytes;
    }

    internal CommitPlan Plan(CommitOptions opts) => FastPlan(opts) ?? SlowPlan(opts);

    /// <summary>The in-place plan, or null when the edits are structural (re-serialization).</summary>
    internal CommitPlan? FastPlan(CommitOptions opts)
    {
        _ = Root;
        var inPlace = new List<(int At, byte[] Data, ViewNode Node)>();
        bool structural = Opaque || opts.Rewrite;
        foreach (var n in Nodes.ToArray())
        {
            if (structural) break;
            structural = Views.Changes(n, inPlace);
        }
        if (!structural)
        {
            foreach (var p in inPlace)
            {
                if (p.Node.Space != Space)
                {
                    structural = true;
                    break;
                }
                for (var a = p.Node.Parent; a is not null; a = a.Parent)
                {
                    if (!a.Info.ChildSafe)
                    {
                        structural = true;
                        break;
                    }
                }
            }
        }
        if (!structural)
        {
            var patches = Views.Merge(Space, inPlace);
            var space = Space;
            return new CommitPlan { Patches = patches, Bytes = () => Views.Apply(space.Store.ToArray(), patches) };
        }
        return null;
    }

    internal CommitPlan SlowPlan(CommitOptions opts)
    {
        var w = RewriteWriter(opts);
        return FinishRewrite(w, Spec.Write(w, Root), opts);
    }

    /// <summary>The structural plan of a format with async codecs (its writer awaits them).</summary>
    internal async ValueTask<CommitPlan> SlowPlanAsync(CommitOptions opts)
    {
        if (Spec.WriteAsync is null) return SlowPlan(opts);
        var w = RewriteWriter(opts);
        var l = await Spec.WriteAsync(w, Root).ConfigureAwait(false);
        return FinishRewrite(w, l, opts);
    }

    /// <summary>A writer that re-serializes the view with a sticky layout and provenance.</summary>
    private Writer RewriteWriter(CommitOptions opts)
    {
        var space = Space;
        var rootNode = RootNode!;
        var region = new Region
        {
            Layout = Spec.Layout,
            Sticky = new StickyPolicy(opts.Grow, rootNode.InlineEnd - rootNode.Pos, space.Store.Size)
        };
        var w = new Writer(region)
        {
            Origin = v => v is not null && Origins.TryGetValue(v, out var o) && o.Item1 == space ? (o.Item2, o.Item3) : null,
            SlotOrigin = (owner, field) =>
            {
                if (owner is null || !NodeOf(owner, out var n) || n.Space != space) return null;
                int i = Array.FindIndex(n.Info.Fields, f => f.Name == field);
                if (i < 0) return null;
                var t = n.TargetOrigin[i];
                if (t.Pos >= 0 && t.Size < 0 && n.OriginalLoad[i] is { } load)
                {
                    try
                    {
                        load();
                    }
                    catch (YaffleException)
                    {
                    }
                    t = n.TargetOrigin[i];
                }
                return t.Pos >= 0 && t.Size >= 0 ? (t.Pos, t.Size) : null;
            },
            RegionOrigin = v =>
            {
                if (v is null || !NodeOf(v, out var n) || n.Space != space) return null;
                return (n.Pos, n.InlineEnd - n.Pos, n.Size);
            },
            ProvenanceOf = mem =>
            {
                if (!MemoryMarshal.TryGetArray(mem, out var seg) || seg.Array is null) return null;
                if (!BytesOrigins.TryGetValue(seg.Array, out var o) || o.Item1 != space) return null;
                int at = o.Item2 + seg.Offset;
                var orig = space.Store.Get(at, seg.Count);
                return orig.AsSpan().SequenceEqual(seg.AsSpan()) ? new Provenance(space, at) : null;
            }
        };
        return w;
    }

    private CommitPlan FinishRewrite(Writer w, LEntry? l, CommitOptions opts)
    {
        var space = Space;
        var region = w.RootRegion;
        if (l is LStruct s) region.LRoot = s;
        var bytes = region.Finish();
        var orig = space.Store.ToArray();
        var anchors = new List<(int N, int O, int Len)>();
        foreach (var p in region.ProvenanceParts)
            if (p.Prov.Space == space) anchors.Add(((int)p.At, (int)p.Prov.Offset, p.Len));
        var patches = Views.Diff(orig, bytes, anchors);
        if (opts.Grow == Grow.Error && bytes.Length != orig.Length)
            throw new YaffleException(ErrorCode.DERIVE, $"the data changed size from {orig.Length} to {bytes.Length} bytes (grow: error)");
        return new CommitPlan { Patches = patches, Bytes = () => bytes };
    }

    private readonly ConditionalWeakTable<object, ViewNode> nodeOf = new();

    /// <summary>Associates a scanned struct value with its node.</summary>
    public void Register(object value, ViewNode node) => nodeOf.AddOrUpdate(value, node);

    /// <summary>The node of a scanned struct value of this view.</summary>
    public bool NodeOf(object value, out ViewNode node) => nodeOf.TryGetValue(value, out node!) && node.Root == this;
}
