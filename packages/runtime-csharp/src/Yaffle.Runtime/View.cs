using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Yaffle.Runtime;

/// <summary>A lazy view over a sync source: read what you touch, edit, commit.</summary>
public sealed class View<T> where T : class
{
    public ViewRoot State { get; }

    public View(ByteStore store, ViewSpec spec, ISink? sink = null) => State = new ViewRoot(store, spec, sink);

    /// <summary>The root value (after a commit: the value read from the committed bytes).</summary>
    public T Root => (T)State.Root;

    /// <summary>The edits as patches against the original bytes.</summary>
    public IReadOnlyList<Patch> Patches(CommitOptions? opts = null) => State.Patches(opts);

    /// <summary>Applies the edits, rebinds the view to the new bytes and returns them.</summary>
    public byte[] Commit(CommitOptions? opts = null) => State.Commit(opts);

    /// <summary>Where a scanned struct value starts (absolute offset in its byte space).</summary>
    public int OffsetOf(object value) => State.NodeOf(value, out var n) ? n.Pos : throw new YaffleException(ErrorCode.INPUT, "not a struct value of this view");

    /// <summary>The size of a scanned struct value's bytes.</summary>
    public int SizeOf(object value) => State.NodeOf(value, out var n) ? n.Size : throw new YaffleException(ErrorCode.INPUT, "not a struct value of this view");

    /// <summary>The original bytes of a scanned struct value.</summary>
    public byte[] RawOf(object value) =>
        State.NodeOf(value, out var n) ? n.Space.Store.Get(n.Pos, n.Size).ToArray() : throw new YaffleException(ErrorCode.INPUT, "not a struct value of this view");
}

/// <summary>
/// A lazy view over an async source: every access runs through <see cref="GetAsync{TR}"/>
/// or <see cref="SetAsync"/>, which fetch missing bytes (and run async codecs) and retry.
/// </summary>
public sealed class AsyncView<T> where T : class
{
    private readonly AsyncSourceStore? store;
    private readonly IAsyncSink? sink;
    public ViewRoot State { get; }

    public AsyncView(IAsyncSource source, ViewSpec spec)
    {
        store = new AsyncSourceStore(source);
        sink = source as IAsyncSink;
        State = new ViewRoot(store, spec);
    }

    public AsyncView(byte[] data, ViewSpec spec) => State = new ViewRoot(new ArrayStore(data), spec);

    /// <summary>Runs <paramref name="f"/> until it no longer needs bytes or an async codec, fetching or running them in between.</summary>
    private async ValueTask<TR> Retry<TR>(Func<ValueTask<TR>> f)
    {
        try
        {
            for (int guard = 0; ; guard++)
            {
                try
                {
                    return await f().ConfigureAwait(false);
                }
                catch (NeedBytes nb) when (store is not null && guard < 100000)
                {
                    await store.FetchAsync(nb).ConfigureAwait(false);
                }
                catch (NeedAsync na) when (guard < 100000)
                {
                    await na.Run().ConfigureAwait(false);
                }
            }
        }
        finally
        {
            store?.Release();
        }
    }

    private ValueTask<TR> Retry<TR>(Func<TR> f) => Retry(() => new ValueTask<TR>(f()));

    /// <summary>Reads through the view: <c>await view.GetAsync(r => r.Entries[3].Data)</c>.</summary>
    public ValueTask<TR> GetAsync<TR>(Func<T, TR> f) => Retry(() => f((T)State.Root));

    /// <summary>Edits through the view (the action may run again after fetching bytes).</summary>
    public async ValueTask SetAsync(Action<T> f) => await Retry(() =>
    {
        f((T)State.Root);
        return 0;
    }).ConfigureAwait(false);

    /// <summary>The edits as patches against the original bytes.</summary>
    public async ValueTask<IReadOnlyList<Patch>> PatchesAsync(CommitOptions? opts = null)
    {
        await FetchAll().ConfigureAwait(false);
        return (await PlanAsync(opts ?? new CommitOptions()).ConfigureAwait(false)).Patches;
    }

    /// <summary>
    /// The commit plan: in place when possible, else a re-serialization (through the async writer
    /// for formats with async codecs). Bytes the writer still needs are fetched and the write rerun.
    /// </summary>
    private async ValueTask<ViewRoot.CommitPlan> PlanAsync(CommitOptions opts) =>
        await Retry(() => State.FastPlan(opts)).ConfigureAwait(false) ?? await Retry(() => State.SlowPlanAsync(opts)).ConfigureAwait(false);

    /// <summary>Applies the edits, writes them back to the source when it is an <see cref="IAsyncSink"/>, and rebinds the view.</summary>
    public async ValueTask<byte[]> CommitAsync(CommitOptions? opts = null)
    {
        await FetchAll().ConfigureAwait(false);
        var plan = await PlanAsync(opts ?? new CommitOptions()).ConfigureAwait(false);
        var bytes = await Retry(plan.Bytes).ConfigureAwait(false);
        if (sink is not null) await sink.WriteAsync(bytes, plan.Patches).ConfigureAwait(false);
        State.Rebind(new ArrayStore(bytes));
        return bytes;
    }

    /// <summary>Patches and commits fetch the whole source first (a structural commit re-serializes it).</summary>
    private async ValueTask FetchAll()
    {
        if (store is not null) await store.FetchAsync(new NeedBytes(0, store.Size)).ConfigureAwait(false);
    }
}
