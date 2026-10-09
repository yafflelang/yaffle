"""Async views, following the TS runtime's design (packages/runtime/src/async.ts).

An async view wraps a sync view over a :class:`BlockStore` of an async source. Every attribute and
item chain (``av.entries[3].data``) is an :class:`AsyncChain` that records its path; awaiting it
walks the sync view. When the walk needs bytes that aren't fetched yet (:class:`NeedBytes`) or the
output of an async codec (:class:`NeedAsync`), the walk is abandoned, the data is fetched (or the
codec run), and the walk is retried. Scans, targets and decoded regions are cached, so retries
only redo the cheap part, and consecutive fetches read ahead further each time.

```python
av = Node.view(source)                      # an async source, or an async root over any source
size = await av.entries[3].size             # resolves to plain data (views become dicts/lists)
await av.entries[3]._set(align=0x200)       # edits go through _set
patches = await av._commit(grow="append")   # written back to the source if it has `write`
```
"""

from __future__ import annotations

import inspect
from typing import Any, AsyncIterator, Awaitable, Callable, Generator, TypeVar

from .api import ensure_recursion
from .commit import CommitPlan, fast_plan, plan_async
from .errors import YaffleError, fail
from .store import BlockStore, NeedAsync, NeedBytes, is_async_source
from .view import (
    Patch,
    RootSpec,
    StructView,
    ViewRoot,
    first_shift,
    cached_root,
    mapped_root,
    node_of,
    plain,
)

__all__ = ["AsyncChain", "open_async_view"]

T = TypeVar("T")


async def settle_async(store: BlockStore | None, f: Callable[[], Awaitable[T]]) -> T:
    """Runs ``f`` against the sync view, fetching whatever it asks for and retrying, until it
    completes."""
    touched: set[BlockStore] = set() if store is None else {store}
    try:
        while True:
            try:
                return await f()
            except NeedBytes as e:
                touched.add(e.store)
                await e.store.fetch(e)
            except NeedAsync as e:
                await e.run()
    finally:
        for s in touched:
            s.release()


async def settle(store: BlockStore | None, f: Callable[[], T]) -> T:
    """:func:`settle_async` for a synchronous ``f``."""

    async def run() -> T:
        return f()

    return await settle_async(store, run)


class AsyncViewState:
    def __init__(self, root: ViewRoot, store: BlockStore | None, source: Any) -> None:
        self.root = root
        self.store = store
        #: The async source (written back on commit when it has ``write``).
        self.source = source


def _walk(root: ViewRoot, path: tuple[Any, ...]) -> Any:
    v: Any = root.view
    for seg in path:
        if v is None:
            fail("INPUT", f"cannot read {seg!r} of None")
        v = v[seg] if isinstance(seg, int) else getattr(v, seg)
    return v


def _resolved(v: Any) -> Any:
    """The value an awaited chain resolves to: plain data (struct and array views are snapshots)."""
    return plain(v) if node_of(v) is not None else v


class _Awaitable:
    """Runs a coroutine function when awaited (so no unawaited coroutine is ever created)."""

    __slots__ = ("_f",)

    def __init__(self, f: Callable[[], Awaitable[Any]]) -> None:
        self._f = f

    def __await__(self) -> Generator[Any, None, Any]:
        return self._f().__await__()


class AsyncChain:
    """A path into an async view. Attributes and items extend it; ``await`` resolves it.

    Methods start with ``_`` like the sync view's: ``_set(**fields)``, ``_commit(grow=…)``,
    ``_patches(grow=…)``, ``_plain()``, ``_len()``, ``_offset()``, ``_size()``, ``_raw()``,
    ``_bytes()`` and, on the root, ``_to_json()``. Each returns an awaitable.
    """

    __slots__ = ("_state", "_path")

    def __init__(self, state: AsyncViewState, path: tuple[Any, ...]) -> None:
        object.__setattr__(self, "_state", state)
        object.__setattr__(self, "_path", path)

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        return AsyncChain(self._state, (*self._path, name))

    def __getitem__(self, i: Any) -> AsyncChain:
        if not isinstance(i, int):
            raise TypeError("async views are indexed with integers")
        return AsyncChain(self._state, (*self._path, i))

    def __setattr__(self, name: str, value: Any) -> None:
        raise YaffleError("INPUT", "async views are changed with `await view.path._set(field=value)`")

    def __setitem__(self, i: Any, value: Any) -> None:
        raise YaffleError("INPUT", "async views are changed with `await view.path._set(field=value)`")

    def __repr__(self) -> str:
        return f"<async view chain {list(self._path)}>"

    def __await__(self) -> Generator[Any, None, Any]:
        return self._run(_resolved).__await__()

    async def __aiter__(self) -> AsyncIterator[Any]:
        for i in range(await self._len()):
            yield await self[i]

    def _run(self, f: Callable[[Any], T]) -> _Awaitable:
        """Applies ``f`` to the value at this path."""
        st = self._state
        path = self._path
        return _Awaitable(lambda: settle(st.store, lambda: f(_walk(st.root, path))))

    def _set(self, **values: Any) -> _Awaitable:
        """Sets fields of the struct at this path."""

        def go(v: Any) -> None:
            if not isinstance(v, StructView):
                fail("INPUT", "_set needs a struct")
            v._set(**values)

        return self._run(go)

    def _plain(self) -> _Awaitable:
        """A plain snapshot of the value at this path."""
        return self._run(plain)

    def _len(self) -> _Awaitable:
        """The length of the array (or bytes) at this path."""
        return self._run(len)

    def _offset(self) -> _Awaitable:
        """Absolute offset of the struct at this path."""
        return self._run(lambda v: v._offset)

    def _size(self) -> _Awaitable:
        """Bytes the struct at this path occupies."""
        return self._run(lambda v: v._size)

    def _raw(self) -> _Awaitable:
        """The current bytes of the struct at this path."""
        return self._run(lambda v: v._raw())

    def _to_json(self) -> _Awaitable:
        """Canonical JSON of the root (every field read through the view)."""
        if self._path:
            fail("INPUT", "_to_json() is available on the root of an async view")
        to_json = self._state.root.spec.to_json
        if to_json is None:
            fail("INPUT", "this view has no JSON converter")
        return self._run(to_json)

    def _bytes(self) -> _Awaitable:
        """All of the current bytes (in-place edits applied; committed edits after ``_commit``)."""
        st = self._state

        async def go() -> bytes:
            if st.store is not None:
                await st.store.fetch_all()
            space = st.root.space
            return await settle(st.store, lambda: space.get(0, space.size))

        return _Awaitable(go)

    def _patches(self, grow: str = "default") -> _Awaitable:
        """The edits as patches against the original bytes (no side effects)."""
        return _Awaitable(lambda: commit_async(self._state, grow, True))

    def _commit(self, grow: str = "default") -> _Awaitable:
        """Applies the edits (written back to the source if it has ``write``); resolves to the
        patches."""
        return _Awaitable(lambda: commit_async(self._state, grow, False))


async def _plan(state: AsyncViewState, grow: str) -> CommitPlan:
    root = state.root
    store = state.store
    fp = await settle(store, lambda: fast_plan(root))
    if fp is not None:
        return fp
    # The slow path re-encodes everything: fetch the whole source first (one read) instead of
    # retrying block by block, and resolve every lazy value (async codecs) before the writer runs.
    if store is not None:
        await store.fetch_all()
    await settle(store, lambda: plain(root.view))
    return await settle_async(store, lambda: plan_async(root, grow))


async def commit_async(state: AsyncViewState, grow: str, dry: bool) -> list[Patch]:
    root = state.root
    p = await _plan(state, grow)
    if dry:
        return p.patches
    store = state.store
    src = state.source
    if store is not None and src is not None and callable(getattr(src, "write", None)):
        await _write_back_async(src, store, p)
        # The source now holds the result: read it afresh.
        fresh = BlockStore(src, store.unit, store.max_units)
        store.close()
        state.store = fresh
        root.reset(None, fresh)
        return p.patches
    if store is not None:
        await store.fetch_all()
    data = await settle(store, p.bytes)
    if root.sink is not None:
        root.sink(data, p.patches)
    if store is not None:
        store.close()
    state.store = None
    root.reset(data)
    return p.patches


async def _maybe_await(r: Any) -> None:
    if inspect.isawaitable(r):
        await r


async def _write_back_async(src: Any, store: BlockStore, p: CommitPlan) -> None:
    """Writes committed patches back to an async source: the patches up to the first size
    change, then the whole tail."""
    shift = first_shift(p.patches)
    for x in p.patches:
        if shift is not None and x.at >= shift.at:
            break
        await _maybe_await(src.write(x.at, x.insert))
    if shift is None:
        return
    await store.fetch_all()
    data = p.bytes()
    await _maybe_await(src.write(shift.at, data[shift.at :]))
    if len(data) < store.size:
        truncate = getattr(src, "truncate", None)
        if truncate is None:
            fail("INPUT", "the source cannot shrink (no truncate)")
        await _maybe_await(truncate(len(data)))


def open_async_view(source: Any, spec: RootSpec) -> AsyncChain:
    """An async view over any source: bytes, a sync source or an async source."""
    ensure_recursion()
    if isinstance(source, (bytes, bytearray, memoryview)):
        return AsyncChain(AsyncViewState(ViewRoot(bytes(source), spec), None, None), ())
    if is_async_source(source):
        store = BlockStore(source)
        return AsyncChain(AsyncViewState(ViewRoot(None, spec, None, store), store, source), ())
    # A sync source: the sync view machinery, awaited.
    root = mapped_root(source, spec) or cached_root(source, spec)
    return AsyncChain(AsyncViewState(root, None, None), ())
