"""Byte stores whose bytes are produced on demand, for views.

Every store keeps its bytes in an anonymous memory map the size of the store, so readers index
it like ``bytes`` while the operating system only backs the pages that were filled. A store is
divided into *units*; :meth:`LazyStore.ensure` fills the units a read touches, and least recently
used units are dropped beyond a budget. In-place view patches are written into the map; the
original bytes they replaced are kept (and patched units are never dropped), so the original
bytes stay available for the commit diff (:class:`SourceBytes`).

- :class:`BlockStore`: a random-access source (``size``, ``read(offset, length)``), sync or async,
  in fixed blocks (64 KiB × 256 by default).
- :class:`PieceStore`: a stream joined from pieces (``T x from arr[*].data``). An offset
  maps to a piece through the pieces' decoded lengths, taken from size fields where the schema
  states them (``@size(exp) @via(zstd)``: no decoding needed) and otherwise learned by decoding
  the pieces. Only the pieces a read touches are decoded (16 pieces / 64 MiB kept).
- :class:`RangedStore`: the decoded side of a ``@ranged`` codec region. Only the touched 4 KiB
  blocks are decoded (the codec gets each run's position in ``ctx.position``).
- :class:`SliceStore`: a window ``[start, start + size)`` of another store (stream slices).

Async sources can't be read from the synchronous scans: a store raises :class:`NeedBytes` for
data it hasn't fetched, and the async view layer (async_view.py) fetches it and retries. An async
codec raises :class:`NeedAsync` the same way. Both are control signals, not errors: they derive
from ``BaseException``, so ``except Exception`` handlers in generated or host code never swallow
them.
"""

from __future__ import annotations

import bisect
import builtins
import inspect
import mmap
from collections import OrderedDict
from typing import Any, Awaitable, Callable, Sequence

from .codec import CodecContext, decode
from .errors import fail
from .prim import PRIMS
from .reader import Fill, Reader
from .strings import find_nul_unit


class NeedBytes(BaseException):
    """Control signal: the bytes ``[offset, offset + length)`` of ``store`` must be fetched first.

    ``blocks``: load them into the block cache (a reader reads them in place); otherwise they are
    a large read kept aside until the operation ends.
    """

    def __init__(self, store: BlockStore, offset: int, length: int, blocks: bool = True) -> None:
        super().__init__(f"need bytes [{offset}, {offset + length})")
        self.store = store
        self.offset = offset
        self.length = length
        self.blocks = blocks


class NeedAsync(BaseException):
    """Control signal: an async operation (an async codec) must complete first."""

    def __init__(self, key: Any, run: Callable[[], Awaitable[None]]) -> None:
        super().__init__(f"need async {key!r}")
        self.key = key
        self.run = run


def is_async_source(src: Any) -> bool:
    """True if ``src`` is an async source (``is_async``, a coroutine ``read``, or a ``read`` that
    returns an awaitable for a zero-length probe)."""
    if isinstance(src, (bytes, bytearray, memoryview)):
        return False
    flag = getattr(src, "is_async", None)
    if isinstance(flag, bool):
        return flag
    read = getattr(src, "read", None)
    if read is None:
        return False
    if inspect.iscoroutinefunction(read):
        return True
    probe = read(0, 0)
    if inspect.isawaitable(probe):
        if inspect.iscoroutine(probe):
            probe.close()
        return True
    return False


def _check_range(offset: int, length: int, size: int) -> None:
    if offset < 0 or length < 0 or offset + length > size:
        fail("EOF", f"read of {length} bytes at 0x{offset:x} is past the end (0x{size:x})", offset)


class LazyStore:
    """Bytes filled on demand into an anonymous map, in units (see the module docstring)."""

    #: Granularity of incremental searches (terminators, strict padding).
    chunk = 0x4000

    def __init__(self, size: int, nunits: int, max_units: int, max_bytes: int = 1 << 62) -> None:
        self.size = size
        self.buf: Any = mmap.mmap(-1, size) if size > 0 else b""
        self.loaded = bytearray(nunits)
        #: Filled units, least recently used first.
        self.lru: OrderedDict[int, None] = OrderedDict()
        self.max_units = max(1, max_units)
        self.max_bytes = max_bytes
        self.held_bytes = 0
        #: Units that must stay (fetched during the current async operation).
        self.pinned: set[int] = set()
        #: In-place patches: (offset, the bytes they replaced), in order.
        self.saved: list[tuple[int, builtins.bytes]] = []
        #: Units holding patches (never dropped).
        self.dirty: set[int] = set()

    # ── units (subclasses) ──────────────────────────────────────────────────

    def unit_range(self, i: int) -> tuple[int, int]:
        raise NotImplementedError

    def units(self, offset: int, end: int) -> range:
        """The units overlapping ``[offset, end)`` (``end`` > ``offset``)."""
        raise NotImplementedError

    def fill(self, missing: list[int]) -> None:
        """Fills the missing units into ``buf`` (via :meth:`put`)."""
        raise NotImplementedError

    # ── filling and dropping ────────────────────────────────────────────────

    def put(self, i: int, data: builtins.bytes) -> None:
        start, end = self.unit_range(i)
        if len(data) != end - start:
            fail("CODEC", f"filled {len(data)} bytes into a unit of {end - start}")
        if i in self.dirty and self.loaded[i]:
            return  # keeps the patched contents
        self.buf[start:end] = data
        if not self.loaded[i]:
            self.loaded[i] = 1
            self.held_bytes += end - start
        self.lru[i] = None
        self.lru.move_to_end(i)

    def _over_budget(self) -> bool:
        return len(self.lru) > self.max_units or self.held_bytes > self.max_bytes

    def _drop(self, keep: range | None) -> None:
        """Drops least recently used units beyond the budget (never pinned, patched or ``keep``
        units, and never the last one), giving their pages back."""
        if not self._over_budget():
            return
        madvise = getattr(self.buf, "madvise", None)
        dontneed = getattr(mmap, "MADV_DONTNEED", None)
        page = mmap.PAGESIZE
        for victim in list(self.lru):
            if not self._over_budget() or len(self.lru) <= 1:
                return
            if victim in self.pinned or victim in self.dirty or (keep is not None and victim in keep):
                continue
            del self.lru[victim]
            self.loaded[victim] = 0
            start, end = self.unit_range(victim)
            self.held_bytes -= end - start
            # The pages that lie wholly inside the unit.
            a = -(-start // page) * page
            b = (end // page) * page
            if madvise is not None and dontneed is not None and b > a:
                try:
                    madvise(dontneed, a, b - a)
                except (OSError, ValueError):  # pragma: no cover - platform specific
                    pass

    def ensure(self, offset: int, length: int) -> None:
        """Makes ``[offset, offset + length)`` (clipped to the store) readable in ``buf``."""
        end = min(self.size, offset + length)
        if offset >= end or offset < 0:
            return
        us = self.units(offset, end)
        loaded = self.loaded
        if len(us) == 1 and loaded[us[0]]:
            self.lru.move_to_end(us[0])
            return
        missing = [i for i in us if not loaded[i]]
        if missing:
            self.fill(missing)
        for i in us:
            if loaded[i]:
                self.lru.move_to_end(i)
        # Never drop units of the range just ensured (the caller reads them next).
        self._drop(us)

    def loaded_range(self, offset: int, length: int) -> bool:
        if length <= 0:
            return True
        loaded = self.loaded
        return all(loaded[i] for i in self.units(offset, min(self.size, offset + length)))

    def get(self, offset: int, length: int) -> builtins.bytes:
        """Bytes ``[offset, offset + length)`` (current contents: in-place patches applied)."""
        _check_range(offset, length, self.size)
        if length == 0:
            return b""
        self.ensure(offset, length)
        return builtins.bytes(self.buf[offset : offset + length])

    # ── patches ─────────────────────────────────────────────────────────────

    def patch(self, at: int, data: builtins.bytes) -> None:
        """Writes an in-place patch (the bytes it replaces are kept for :meth:`original`)."""
        if not data:
            return
        self.ensure(at, len(data))
        self.saved.append((at, builtins.bytes(self.buf[at : at + len(data)])))
        self.dirty.update(self.units(at, at + len(data)))
        self.buf[at : at + len(data)] = data

    def original(self, offset: int, length: int) -> builtins.bytes:
        """The original bytes ``[offset, offset + length)`` (in-place patches undone)."""
        cur = self.get(offset, length)
        if not self.saved:
            return cur
        out = bytearray(cur)
        end = offset + length
        for at, old in reversed(self.saved):
            a = max(offset, at)
            b = min(end, at + len(old))
            if a < b:
                out[a - offset : b - offset] = old[a - at : b - at]
        return builtins.bytes(out)

    def release(self) -> None:
        """Ends an async operation: unpins its units."""
        self.pinned.clear()
        self._drop(None)

    def close(self) -> None:
        if isinstance(self.buf, mmap.mmap):
            self.buf.close()


class _FixedUnits(LazyStore):
    """Units of a fixed size."""

    def __init__(self, size: int, unit: int, max_units: int) -> None:
        self.unit = unit
        super().__init__(size, (size + unit - 1) // unit, max_units)

    def unit_range(self, i: int) -> tuple[int, int]:
        start = i * self.unit
        return start, min(self.size, start + self.unit)

    def units(self, offset: int, end: int) -> range:
        return range(offset // self.unit, (end - 1) // self.unit + 1)

    def fill_runs(self, missing: list[int], produce: Callable[[int, int], builtins.bytes]) -> None:
        """Fills each run of consecutive missing units from one ``produce(offset, length)``."""
        runs: list[tuple[int, int]] = []
        for i in missing:
            if runs and runs[-1][1] == i - 1:
                runs[-1] = (runs[-1][0], i)
            else:
                runs.append((i, i))
        for first, last in runs:
            a = first * self.unit
            out = produce(a, min(self.size, (last + 1) * self.unit) - a)
            for i in range(first, last + 1):
                s = i * self.unit - a
                self.put(i, out[s : s + self.unit])


class BlockStore(_FixedUnits):
    """A block cache over a sync or async random-access source."""

    def __init__(self, source: Any, block_size: int = 0x10000, max_blocks: int = 256) -> None:
        page = mmap.PAGESIZE
        self.source = source
        self.is_async = is_async_source(source)
        super().__init__(int(source.size), max(page, (block_size // page) * page), max(4, max_blocks))
        #: Large reads that bypass the block cache (async: kept until ``release``).
        self.large: dict[tuple[int, int], builtins.bytes] = {}
        #: Read-ahead of consecutive async fetches within one operation (doubles each time).
        self.readahead = self.unit

    def _checked(self, out: Any, offset: int, length: int) -> builtins.bytes:
        data = builtins.bytes(out)
        if len(data) != length:
            fail("EOF", "short read from source", offset)
        return data

    def _read(self, offset: int, length: int) -> builtins.bytes:
        out = self.source.read(offset, length)
        if inspect.isawaitable(out):
            if inspect.iscoroutine(out):
                out.close()
            fail("INPUT", "this source is async; use an async view")
        return self._checked(out, offset, length)

    async def _read_async(self, offset: int, length: int) -> builtins.bytes:
        out = self.source.read(offset, length)
        if inspect.isawaitable(out):
            out = await out
        return self._checked(out, offset, length)

    def fill(self, missing: list[int]) -> None:
        start = missing[0] * self.unit
        stop = min(self.size, (missing[-1] + 1) * self.unit)
        if self.is_async:
            raise NeedBytes(self, start, stop - start)
        # One read for the whole missing span.
        data = self._read(start, stop - start)
        for i in missing:
            s = i * self.unit - start
            self.put(i, data[s : s + min(self.unit, self.size - i * self.unit)])

    def get(self, offset: int, length: int) -> builtins.bytes:
        _check_range(offset, length, self.size)
        if length == 0:
            return b""
        if self.loaded_range(offset, length):
            return builtins.bytes(self.buf[offset : offset + length])
        if length > self.unit * 8 and not self.saved:
            # A large read bypasses the cache.
            for (at, n), data in self.large.items():
                if offset >= at and offset + length <= at + n:
                    return data[offset - at : offset - at + length]
            if self.is_async:
                raise NeedBytes(self, offset, length, False)
            return self._read(offset, length)
        self.ensure(offset, length)
        return builtins.bytes(self.buf[offset : offset + length])

    # ── async ───────────────────────────────────────────────────────────────

    async def fetch(self, need: NeedBytes) -> None:
        """Fetches what a :class:`NeedBytes` asked for (async sources). Fetched blocks stay pinned
        until :meth:`release`; consecutive fetches read further ahead each time."""
        if not need.blocks:
            self.large[(need.offset, need.length)] = await self._read_async(need.offset, need.length)
            return
        bs = self.unit
        first = need.offset // bs
        last = (need.offset + need.length - 1) // bs
        # Read ahead over blocks that aren't loaded yet.
        ahead = min(len(self.loaded) - 1, (need.offset + self.readahead - 1) // bs)
        while last < ahead and not self.loaded[last + 1]:
            last += 1
        start = first * bs
        data = await self._read_async(start, min(self.size, (last + 1) * bs) - start)
        for i in range(first, last + 1):
            s = i * bs - start
            self.put(i, data[s : s + bs])
            self.pinned.add(i)
        self.readahead = min(self.readahead * 2, 1 << 26)

    async def fetch_all(self) -> None:
        """Fetches the whole source (before everything is re-encoded)."""
        missing = [i for i in range(len(self.loaded)) if not self.loaded[i]]
        if missing:
            start = missing[0] * self.unit
            await self.fetch(NeedBytes(self, start, self.size - start))

    def release(self) -> None:
        self.large.clear()
        self.readahead = self.unit
        super().release()


class PieceStore(LazyStore):
    """A stream joined from pieces decoded on demand.

    ``lengths[k]`` is piece k's decoded length when the schema states it (None: learned by
    decoding the piece), ``piece(k)`` decodes piece k.
    """

    def __init__(
        self,
        count: int,
        lengths: Sequence[int | None],
        piece: Callable[[int], builtins.bytes],
        max_pieces: int = 16,
        max_bytes: int = 64 << 20,
    ) -> None:
        self.piece = piece
        #: Statistics: pieces decoded.
        self.decodes = 0
        learned: dict[int, builtins.bytes] = {}
        starts = [0]
        for k in range(count):
            n = lengths[k]
            if n is None:
                learned[k] = self._decode(k)
                n = len(learned[k])
            elif not isinstance(n, int) or n < 0:
                fail("RANGE", f"stream piece {k} has length {n}")
            starts.append(starts[-1] + n)
        self.starts = starts
        super().__init__(starts[-1], count, max_pieces, max_bytes)
        for k, b in learned.items():
            self.put(k, b)
        self._drop(None)

    def _decode(self, k: int) -> builtins.bytes:
        b = self.piece(k)
        self.decodes += 1
        return b

    def unit_range(self, i: int) -> tuple[int, int]:
        return self.starts[i], self.starts[i + 1]

    def units(self, offset: int, end: int) -> range:
        first = bisect.bisect_right(self.starts, offset) - 1
        last = bisect.bisect_left(self.starts, end) - 1
        # Skip empty pieces at the edges.
        while first < last and self.starts[first + 1] <= offset:
            first += 1
        return range(max(0, first), max(first, last) + 1)

    def fill(self, missing: list[int]) -> None:
        for k in missing:
            b = self._decode(k)
            want = self.starts[k + 1] - self.starts[k]
            if len(b) != want:
                fail("CODEC", f"stream piece {k} decoded to {len(b)} bytes, its size field says {want}")
            self.put(k, b)


class RangedStore(_FixedUnits):
    """The decoded side of a ``@ranged`` codec region ``[start, start + size)`` of ``parent``
    (anything with ``get``). Ranged codecs map byte i of the input to byte i of the output, so any
    block can be decoded alone, given its position."""

    def __init__(
        self,
        parent: Any,
        start: int,
        size: int,
        codec: Any,
        name: str,
        ctx: CodecContext,
        block_size: int = 0x1000,
        max_blocks: int = 256,
    ) -> None:
        self.parent = parent
        self.start = start
        self.codec = codec
        self.name = name
        self.ctx = ctx
        super().__init__(size, max(1, block_size), max_blocks)
        self.chunk = self.unit
        #: Statistics: codec calls and bytes decoded.
        self.decodes = 0
        self.bytes_decoded = 0

    def decode_range(self, offset: int, length: int) -> builtins.bytes:
        data = self.parent.get(self.start + offset, length)
        ctx = CodecContext(list(self.ctx.args), self.ctx.output_size, offset)
        out = decode(self.codec, self.name, data, ctx, False, self.start + offset)[0]
        self.decodes += 1
        self.bytes_decoded += length
        if len(out) != length:
            fail("CODEC", f"ranged codec {self.name} decoded {length} bytes into {len(out)}")
        return out

    def fill(self, missing: list[int]) -> None:
        self.fill_runs(missing, self.decode_range)

    def get(self, offset: int, length: int) -> builtins.bytes:
        # Large reads are decoded in one call, without going through the block cache.
        if length > self.unit * 8 and not self.saved and not self.loaded_range(offset, length):
            _check_range(offset, length, self.size)
            return self.decode_range(offset, length)
        return super().get(offset, length)


class SliceStore(_FixedUnits):
    """A window ``[start, start + size)`` of ``parent`` (anything with ``get``), read on demand."""

    def __init__(self, parent: Any, start: int, size: int, block_size: int = 0x1000, max_blocks: int = 256) -> None:
        self.parent = parent
        self.start = start
        super().__init__(size, max(1, block_size), max_blocks)
        self.chunk = self.unit

    def fill(self, missing: list[int]) -> None:
        self.fill_runs(missing, lambda a, n: self.parent.get(self.start + a, n))


class SourceBytes:
    """The original bytes of a store, sliceable like ``bytes`` (the commit diff reads them)."""

    __slots__ = ("store",)

    def __init__(self, store: LazyStore) -> None:
        self.store = store

    def __len__(self) -> int:
        return self.store.size

    def __getitem__(self, k: Any) -> Any:
        if isinstance(k, slice):
            start, stop, step = k.indices(self.store.size)
            if step != 1:
                raise ValueError("SourceBytes slices must be contiguous")
            return self.store.original(start, max(0, stop - start))
        i = int(k)
        if i < 0:
            i += self.store.size
        if not 0 <= i < self.store.size:
            raise IndexError(k)
        return self.store.original(i, 1)[0]

    def __bytes__(self) -> builtins.bytes:
        return self.store.original(0, self.store.size)


class StoreReader(Reader):
    """A :class:`Reader` over a :class:`LazyStore`: it fills bytes before each access."""

    __slots__ = ("store",)

    def __init__(self, store: LazyStore, strict: builtins.bool = False) -> None:
        super().__init__(store.buf, strict)
        self.store = store
        self.size = store.size
        self.end = store.size
        self.frozen = False

    def u8(self) -> int:
        self.store.ensure(self.pos, 1)
        return super().u8()

    def i8(self) -> int:
        self.store.ensure(self.pos, 1)
        return super().i8()

    def u16(self, le: builtins.bool) -> int:
        self.store.ensure(self.pos, 2)
        return super().u16(le)

    def i16(self, le: builtins.bool) -> int:
        self.store.ensure(self.pos, 2)
        return super().i16(le)

    def u32(self, le: builtins.bool) -> int:
        self.store.ensure(self.pos, 4)
        return super().u32(le)

    def i32(self, le: builtins.bool) -> int:
        self.store.ensure(self.pos, 4)
        return super().i32(le)

    def u64(self, le: builtins.bool) -> int:
        self.store.ensure(self.pos, 8)
        return super().u64(le)

    def i64(self, le: builtins.bool) -> int:
        self.store.ensure(self.pos, 8)
        return super().i64(le)

    def f16(self, le: builtins.bool) -> float:
        self.store.ensure(self.pos, 2)
        return super().f16(le)

    def f32(self, le: builtins.bool) -> float:
        self.store.ensure(self.pos, 4)
        return super().f32(le)

    def f64(self, le: builtins.bool) -> float:
        self.store.ensure(self.pos, 8)
        return super().f64(le)

    def u_n(self, size: int, le: builtins.bool) -> int:
        self.store.ensure(self.pos, size)
        return super().u_n(size, le)

    def i_n(self, size: int, le: builtins.bool) -> int:
        self.store.ensure(self.pos, size)
        return super().i_n(size, le)

    def prim(self, kind: builtins.str, le: builtins.bool) -> int | float:
        self.store.ensure(self.pos, PRIMS[kind].size)
        return super().prim(kind, le)

    def str(self, n_units: int, unit: int, enc: builtins.str, le: builtins.bool) -> builtins.str:
        n = n_units * unit
        if self.pos + n <= self.end:
            self.store.ensure(self.pos, n)
        return super().str(n_units, unit, enc, le)

    def peek_bytes(self, start: int, end: int) -> builtins.bytes:
        if start < 0 or end > self.size or start > end:
            self.fail("EOF", f"range [0x{start:x}, 0x{end:x}) is outside the data", start)
        return self.store.get(start, end - start)

    def probe(self, n: int) -> builtins.bytes:
        return self.store.get(self.pos, max(0, min(n, self.size - self.pos)))

    def bytes(self, n: int) -> builtins.bytes:
        p = self.pos
        e = p + n
        if n < 0 or e > self.end:
            self._eof(n)
        out = self.store.get(p, n)
        self.pos = e
        return out

    def _find(self, start: int, n_units: int, unit: int) -> int:
        """Unit index of the first NUL unit of ``n_units`` units at ``start``, or -1, filling a
        chunk at a time."""
        step = max(1, self.store.chunk // unit)
        done = 0
        while done < n_units:
            k = min(n_units - done, step)
            at = start + done * unit
            self.store.ensure(at, k * unit)
            i = find_nul_unit(self.buf, at, k, unit)
            if i >= 0:
                return done + i
            done += k
        return -1

    def _find_byte(self, b: int, start: int, end: int) -> int:
        """Absolute index of byte ``b`` in ``[start, end)``, or -1 (fills a chunk at a time)."""
        step = self.store.chunk
        pat = builtins.bytes((b,))
        for at in range(start, end, step):
            stop = min(end, at + step)
            self.store.ensure(at, stop - at)
            i: int = self.buf.find(pat, at, stop)
            if i >= 0:
                return i
        return -1

    def bytes_until(self, term: int) -> builtins.bytes:
        i = self._find_byte(term & 0xFF, self.pos, self.end)
        if i < 0:
            self.fail("EOF", "terminator not found before the region end")
        out = self.store.get(self.pos, i - self.pos)
        self.pos = i + 1
        return out

    def _nul_unit(self, unit: int) -> int:
        i = self._find(self.pos, (self.end - self.pos) // unit, unit)
        if i < 0:
            self.fail("EOF", "terminator not found before the region end")
        return i

    def pad(self, n: int, fill: Fill, strict: builtins.bool) -> None:
        if not strict or not isinstance(n, int) or n <= 0 or self.pos + n > self.end:
            super().pad(n, fill, strict)
            return
        # Strict padding is checked a chunk at a time.
        p = self.pos
        step = self.store.chunk
        for at in range(p, p + n, step):
            self._check_fill(at, self.store.get(at, min(step, p + n - at)), fill, at - p)
        self.pos = p + n
