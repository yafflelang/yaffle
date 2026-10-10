using System;
using System.Collections;
using System.Collections.Generic;
using System.Runtime.CompilerServices;

namespace Yaffle.Runtime;

/// <summary>Helpers called by generated scan functions, and commit internals.</summary>
public static class Views
{
    /// <summary>Returned by <see cref="StructInfo.Get"/> for a field whose loader has not run.</summary>
    public static readonly object Pending = new();

    /// <summary>
    /// An inline struct: one object per (space, position, type), scanned now (shallowly). The scan
    /// delegate fills the object and its node at the reader's position.
    /// </summary>
    public static T Child<T>(Reader r, ViewNode parent, StructInfo info, object[] args, object[] seg, Action<T, ViewNode> scan) where T : class, new()
    {
        var root = parent.Root;
        string key = Key(info, args);
        if (root.TryObject(parent.Space, r.Pos, key, out var hit, out var hn) && hn is not null && hn.ExtentEnd >= 0)
        {
            r.Pos = hn.ExtentEnd;
            if (r.Pos > r.MaxEnd) r.MaxEnd = r.Pos;
            return (T)hit;
        }
        var path = YaffleException.Segments(parent.PathWith(seg)).ToArray();
        var node = new ViewNode(root, parent.Space, info, r.Pos, r.Strict, args, path, parent);
        var v = hit as T ?? new T();
        node.Value = v;
        int start = r.Pos;
        int inline = r.InlineEnd;
        r.InlineEnd = -1;
        root.AddObject(parent.Space, start, key, v, node);
        try
        {
            scan(v, node);
        }
        catch
        {
            root.RemoveObject(parent.Space, start, key);
            r.InlineEnd = inline;
            throw;
        }
        node.InlineEnd = r.InlineEnd >= 0 ? r.InlineEnd : r.Pos;
        node.ExtentEnd = r.Pos;
        r.InlineEnd = inline;
        root.Nodes.Add(node);
        root.Register(v, node);
        root.Origins.AddOrUpdate(v, Tuple.Create(parent.Space, start, r.Pos - start));
        return v;
    }

    private static string Key(StructInfo info, object[] args)
    {
        if (args.Length == 0) return info.Key;
        var sb = new System.Text.StringBuilder(info.Key).Append('(');
        foreach (var a in args) sb.Append(a is null || a.GetType().IsValueType || a is string ? Convert.ToString(a, System.Globalization.CultureInfo.InvariantCulture) : "o").Append(',');
        return sb.Append(')').ToString();
    }

    /// <summary>Wraps a deferred read of field <paramref name="i"/>: records the loaded value and prefixes error paths.</summary>
    public static Func<T> Lazy<T>(ViewNode node, int i, Func<T> load)
    {
        node.OriginalLoad[i] = () => load();
        return () =>
        {
            T v;
            try
            {
                v = load();
            }
            catch (YaffleException e)
            {
                e.SealWith(node.PathWith(node.Info.Fields[i].Name));
                throw;
            }
            node.Loaded[i] = true;
            node.LoadedValue[i] = v;
            node.Snapshot[i] = v switch
            {
                IList list and not byte[] => Copy(list),
                _ => null
            };
            return v;
        };
    }

    /// <summary>Records an eagerly read composite value of field <paramref name="i"/> (arrays, pointers) as loaded.</summary>
    public static void Loaded<T>(ViewNode node, int i, T value)
    {
        node.Loaded[i] = true;
        node.LoadedValue[i] = value;
        node.Snapshot[i] = value is IList list && value is not byte[] ? Copy(list) : null;
    }

    private static object?[] Copy(IList list)
    {
        var a = new object?[list.Count];
        list.CopyTo(a, 0);
        return a;
    }

    /// <summary>Skips <paramref name="n"/> bytes of a deferred field (EOF past the region end).</summary>
    public static void Skip(Reader r, long n)
    {
        r.Need(n);
        r.Pos += (int)n;
    }

    /// <summary>
    /// Skips the <paramref name="n"/> bytes of a deferred array. When the region is too short, the
    /// loader runs right away, so the error names the element that doesn't fit (as a parse does).
    /// </summary>
    public static void Skip<T>(Reader r, long n, Func<T> load)
    {
        if (n < 0 || r.Pos + n > r.End) load();
        Skip(r, n);
    }

    /// <summary>Bytes read on access (a deferred <c>u8 x[n]</c>).</summary>
    public static byte[] LoadBytes(ViewNode node, int start, int @base, int end, long n)
    {
        var r = node.ReaderAt(start, @base, end);
        var b = r.Bytes(n);
        node.Root.BytesOrigins.AddOrUpdate(b, Tuple.Create(node.Space, start));
        return b;
    }

    /// <summary>
    /// A pointer or <c>at</c> target read on access: one value per (space, address, type key).
    /// <paramref name="read"/> runs with a reader at the address.
    /// </summary>
    public static T LoadTarget<T>(ViewNode node, int field, long address, int @base, int end, string key, Func<Reader, T> read)
    {
        var root = node.Root;
        var space = node.Space;
        if (address < 0 || address > space.Store.Size)
            throw new YaffleException(ErrorCode.EOF, $"target address 0x{address:x} is outside the data", address);
        int addr = (int)address;
        if (root.Targets.TryGetValue((space, addr, key), out var hit))
        {
            if (field >= 0 && hit.Size >= 0) node.TargetOrigin[field] = (addr, hit.Size);
            return (T)hit.Value!;
        }
        if (root.TryObject(space, addr, key, out var obj, out var on) && obj is T t0)
        {
            int size = on is not null && on.ExtentEnd >= 0 ? on.ExtentEnd - on.Pos : -1;
            if (field >= 0 && size >= 0) node.TargetOrigin[field] = (addr, size);
            root.Targets[(space, addr, key)] = (t0, size);
            return t0;
        }
        var r = space.ReaderAt(addr, @base, end, node.Strict);
        var v = read(r);
        if (field >= 0) node.TargetOrigin[field] = (addr, r.Pos - addr);
        if (v is not null && !v.GetType().IsValueType && v is not string)
        {
            root.Origins.AddOrUpdate(v, Tuple.Create(space, addr, r.Pos - addr));
            if (v is byte[] b) root.BytesOrigins.AddOrUpdate(b, Tuple.Create(space, addr));
        }
        root.Targets[(space, addr, key)] = (v, r.Pos - addr);
        return v;
    }

    /// <summary>
    /// A codec region decoded on access: the encoded window <c>[start, end)</c> is decoded once per
    /// view, then <paramref name="read"/> scans the decoded bytes as a fresh region. Async codecs
    /// raise <see cref="NeedAsync"/> (async views await it and retry).
    /// </summary>
    public static T LoadRegion<T>(ViewNode node, int start, int end, ICodec codec, string name, CodecContext ctx, bool async, string slot, Func<Reader, ViewNode, T> read, bool ranged = false)
    {
        var root = node.Root;
        var space = node.Space;
        var region = Region(node, start, end, codec, name, ctx, async, ranged, slot);
        var inner = new ViewNode(root, region.Space, node.Info, 0, node.Strict, node.Args, node.Path, node);
        var r = region.Space.ReaderAt(0, 0, region.Space.Store.Size, node.Strict);
        var v = read(r, inner);
        if (region.Decoded is { } decoded) Codecs.Remember(v, slot, space.Store.Get(start, end - start).ToArray(), decoded);
        else Codecs.RememberLazy(v, slot, () => space.Store.Get(start, end - start).ToArray(), () => region.Space.Store.ToArray(), end - start);
        return v;
    }

    /// <summary>
    /// The decoded bytes of a codec region as a store (decoded once per view; <c>@ranged</c> codecs
    /// decode only the blocks that are read).
    /// </summary>
    public static ByteStore RegionStore(ViewNode node, int start, int end, ICodec codec, string name, CodecContext ctx, bool async, bool ranged, string slot) =>
        Region(node, start, end, codec, name, ctx, async, ranged, slot).Space.Store;

    private static DecodedRegion Region(ViewNode node, int start, int end, ICodec codec, string name, CodecContext ctx, bool async, bool ranged, string slot)
    {
        var root = node.Root;
        var space = node.Space;
        string key = $"{RuntimeHelpers.GetHashCode(space)}:{start}:{slot}";
        if (root.Regions.TryGetValue(key, out var region)) return region;
        if (ranged && !async)
        {
            region = new DecodedRegion(new Space(new RangedCodecStore(space.Store, start, end, codec, name, ctx)), null);
        }
        else
        {
            byte[] decoded;
            if (root.AsyncDecoded.TryGetValue(key, out var cached)) decoded = cached;
            else
            {
                var input = space.Store.Get(start, end - start).ToArray();
                if (async)
                {
                    throw new NeedAsync(key, async () =>
                    {
                        var d = await Codecs.DecodeAsync(codec, name, input, ctx, false, start).ConfigureAwait(false);
                        root.AsyncDecoded[key] = d.Output;
                    });
                }
                decoded = Codecs.Decode(codec, name, input, ctx, false, start).Output;
            }
            region = new DecodedRegion(new Space(new ArrayStore(decoded)), decoded.AsSpan().ToArray());
        }
        root.Regions[key] = region;
        return region;
    }

    /// <summary>
    /// A field read from a stream on access: a fresh region over a store of the stream
    /// (pieces are opened, and decoded, only when a read reaches them).
    /// </summary>
    public static T LoadStream<T>(ViewNode node, ByteStore stream, Func<Reader, ViewNode, T> read)
    {
        var root = node.Root;
        var space = new Space(stream);
        var inner = new ViewNode(root, space, node.Info, 0, node.Strict, node.Args, node.Path, node);
        return read(space.ReaderAt(0, 0, stream.Size, node.Strict), inner);
    }

    /// <summary>
    /// The bytes of field <paramref name="i"/> of a scanned struct as a store: without loading the
    /// field when its scan recorded how (<see cref="ViewNode.Bytes"/>), else its current value.
    /// </summary>
    public static ByteStore FieldStore(ViewNode? node, object owner, int i, Func<byte[]> get)
    {
        if (node is not null && node.LazyBytesOf[i] is { } lb && ReferenceEquals(node.Info.Get(owner, i, false), Pending)) return lb.Open();
        return new ArrayStore(get());
    }

    /// <summary>
    /// <c>arr[*].field</c> as a store: field <paramref name="i"/> of every element, joined. Pieces
    /// whose length the scan recorded are opened only when a read reaches them.
    /// </summary>
    public static ByteStore Pieces<E>(ViewRoot root, IReadOnlyList<E> elems, int i, Func<E, byte[]> get) where E : class
    {
        var pieces = new List<(long Length, Func<ByteStore> Open)>(elems.Count);
        foreach (var e in elems)
        {
            if (e is not null && root.NodeOf(e, out var n) && n.LazyBytesOf[i] is { } lb && ReferenceEquals(n.Info.Get(e, i, false), Pending))
            {
                pieces.Add((lb.Length, lb.Open));
                continue;
            }
            var b = get(e!);
            pieces.Add((b.Length, () => new ArrayStore(b)));
        }
        return new PieceStore(pieces);
    }

    /// <summary>Bytes <c>[start, start + n)</c> of a node's byte space, as a store (nothing is read yet).</summary>
    public static ByteStore Window(ViewNode node, int start, long n) => SliceStore.Of(node.Space.Store, start, n);

    /// <summary><c>raw[a..b]</c> over a stream store (end exclusive; null = to the end).</summary>
    public static ByteStore Slice(ByteStore s, long start, long? end)
    {
        long e = end ?? s.Size;
        if (start < 0 || e > s.Size || start > e)
            throw new YaffleException(ErrorCode.EOF, $"stream slice [{start}, {e}) is outside the stream of {s.Size} bytes");
        return SliceStore.Of(s, start, e - start);
    }

    /// <summary>Marks the view as holding untracked values (commits re-serialize).</summary>
    public static T Opaque<T>(ViewNode node, T value)
    {
        node.Root.Opaque = true;
        return value;
    }

    // ── change detection ───────────────────────────────────────────────────────

    /// <summary>Collects a node's in-place patches; true if it has a structural change.</summary>
    internal static bool Changes(ViewNode n, List<(int At, byte[] Data, ViewNode Node)> inPlace)
    {
        var info = n.Info;
        for (int i = 0; i < info.Fields.Length; i++)
        {
            var f = info.Fields[i];
            switch (f.Kind)
            {
                case ViewFieldKind.Opaque:
                    return true;
                case ViewFieldKind.Eager:
                {
                    var cur = info.Get(n.Value, i, true);
                    if (Values.Eq(cur, n.Original[i])) continue;
                    if (!f.Input) throw new YaffleException(ErrorCode.INPUT, $"{f.Name} is derived and cannot be set", -1, n.PathWith(f.Name));
                    if (f.Structural || f.Encode is null || n.RangeStart[i] < 0) return true;
                    byte[] bytes;
                    try
                    {
                        bytes = f.Encode(n.Value, n.Args);
                    }
                    catch (YaffleException e)
                    {
                        e.SealWith(n.PathWith(f.Name));
                        throw;
                    }
                    if (bytes.Length != n.RangeEnd[i] - n.RangeStart[i]) return true;
                    inPlace.Add((n.RangeStart[i], bytes, n));
                    continue;
                }
                case ViewFieldKind.Child:
                {
                    var cur = info.Get(n.Value, i, true);
                    if (!ReferenceEquals(cur, n.Original[i])) return true;
                    continue;
                }
                case ViewFieldKind.Lazy:
                {
                    var cur = info.Get(n.Value, i, false);
                    if (ReferenceEquals(cur, Pending)) continue;
                    if (!n.Loaded[i])
                    {
                        // Absent (a branch not taken) and still absent: unchanged.
                        if (cur is null && n.OriginalLoad[i] is null) continue;
                        // Set without being loaded (a new value): structural.
                        return true;
                    }
                    if (!ReferenceEquals(cur, n.LoadedValue[i]) && !Values.Eq(cur, n.LoadedValue[i])) return true;
                    if (cur is byte[] b)
                    {
                        if (n.Root.BytesOrigins.TryGetValue(b, out var o))
                        {
                            var orig = o.Item1.Store.Get(o.Item2, b.Length);
                            if (!orig.AsSpan().SequenceEqual(b)) return true;
                        }
                        continue;
                    }
                    if (cur is IList list && n.Snapshot[i] is object?[] snap)
                    {
                        if (list.Count != snap.Length) return true;
                        for (int k = 0; k < snap.Length; k++)
                        {
                            var x = list[k];
                            if (ReferenceEquals(x, snap[k])) continue;
                            if (x is null || snap[k] is null || !x.GetType().IsValueType || !x.Equals(snap[k])) return true;
                        }
                    }
                    continue;
                }
            }
        }
        return false;
    }

    /// <summary>Merges in-place patches into sorted, non-overlapping replacements.</summary>
    internal static List<Patch> Merge(Space space, List<(int At, byte[] Data, ViewNode Node)> points)
    {
        var sorted = new List<(int At, byte[] Data)>();
        foreach (var p in points) sorted.Add((p.At, p.Data));
        sorted.Sort((a, b) => a.At.CompareTo(b.At));
        var out_ = new List<Patch>();
        foreach (var (at, data) in sorted)
        {
            if (out_.Count > 0 && at <= out_[^1].At + out_[^1].Remove)
            {
                var last = out_[^1];
                int end = Math.Max(last.At + last.Remove, at + data.Length);
                var merged = new byte[end - last.At];
                last.Insert.CopyTo(merged, 0);
                Array.Copy(data, 0, merged, at - last.At, data.Length);
                out_[^1] = new Patch(last.At, end - last.At, merged);
            }
            else out_.Add(new Patch(at, data.Length, data));
        }
        return out_;
    }

    /// <summary>Applies patches (sorted by position, non-overlapping, in original coordinates).</summary>
    public static byte[] Apply(byte[] orig, IReadOnlyList<Patch> patches)
    {
        long size = orig.Length;
        foreach (var p in patches) size += p.Insert.Length - p.Remove;
        var out_ = new byte[size];
        int o = 0, n = 0;
        foreach (var p in patches)
        {
            Array.Copy(orig, o, out_, n, p.At - o);
            n += p.At - o;
            p.Insert.CopyTo(out_, n);
            n += p.Insert.Length;
            o = p.At + p.Remove;
        }
        Array.Copy(orig, o, out_, n, orig.Length - o);
        return out_;
    }

    /// <summary>
    /// Patches turning <paramref name="orig"/> into <paramref name="out_"/>. Anchors are ranges known
    /// to be copied unchanged from the original; between them the bytes are compared.
    /// </summary>
    internal static List<Patch> Diff(byte[] orig, byte[] out_, List<(int N, int O, int Len)> anchors)
    {
        anchors.RemoveAll(a => a.Len <= 0);
        anchors.Sort((a, b) => a.N.CompareTo(b.N));
        var chain = new List<(int N, int O, int Len)>();
        int lastO = 0, lastN = 0;
        foreach (var a in anchors)
        {
            if (a.O >= lastO && a.N >= lastN)
            {
                chain.Add(a);
                lastO = a.O + a.Len;
                lastN = a.N + a.Len;
            }
        }
        var patches = new List<Patch>();
        void Segment(int n0, int n1, int o0, int o1)
        {
            int nl = n1 - n0, ol = o1 - o0;
            if (nl == ol)
            {
                // Same length: emit the differing runs (gaps under 8 equal bytes are merged).
                int i = 0;
                while (i < nl)
                {
                    if (out_[n0 + i] == orig[o0 + i])
                    {
                        i++;
                        continue;
                    }
                    int j = i + 1, same = 0;
                    while (j < nl && same < 8)
                    {
                        if (out_[n0 + j] == orig[o0 + j]) same++;
                        else same = 0;
                        j++;
                    }
                    int end = j - same;
                    patches.Add(new Patch(o0 + i, end - i, out_.AsSpan(n0 + i, end - i).ToArray()));
                    i = j;
                }
                return;
            }
            int p = 0;
            while (p < nl && p < ol && out_[n0 + p] == orig[o0 + p]) p++;
            int s = 0;
            while (s < nl - p && s < ol - p && out_[n1 - 1 - s] == orig[o1 - 1 - s]) s++;
            patches.Add(new Patch(o0 + p, ol - p - s, out_.AsSpan(n0 + p, nl - p - s).ToArray()));
        }
        int nn = 0, oo = 0;
        foreach (var a in chain)
        {
            Segment(nn, a.N, oo, a.O);
            nn = a.N + a.Len;
            oo = a.O + a.Len;
        }
        Segment(nn, out_.Length, oo, orig.Length);
        patches.RemoveAll(p => p.Remove == 0 && p.Insert.Length == 0);
        return patches;
    }
}
