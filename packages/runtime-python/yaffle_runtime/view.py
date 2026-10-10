"""Lazy views: a struct view reads only the bytes it touches.

- Generated ``_scan_X`` functions read a struct's scalars and record each field's byte range.
  Composite children stay lazy: inline structs and arrays become child views; pointer and ``at``
  targets, bytes, codec regions and streams become :class:`Lazy` values forced on first access.
- Setting a scalar to a value of the same encoded size patches the bytes in place (a
  :class:`Space` keeps the patches; the original bytes are never modified before ``_commit``).
- Anything else (appending to an array, a value changing size, replacing a struct or a target)
  "materializes" the node: its values become a plain dict that ``_commit`` re-encodes with the
  generated writer (commit.py).

View objects use ``_``-prefixed methods (``_commit``, ``_patches``, ``_offset``, …) the way
``namedtuple`` does: field attributes never start with an underscore.
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator, Sequence

from .api import ensure_recursion, reject_path
from .codec import CodecContext, decode, decode_async, remember_codec
from .errors import PathSegment, YaffleError, clean_path, fail, seal_path
from .jsonc import field_value
from .reader import Reader
from .store import (
    BlockStore,
    LazyStore,
    NeedAsync,
    PieceStore,
    RangedStore,
    SliceStore,
    SourceBytes,
    StoreReader,
    is_async_source,
)
from .streams import slice_stream

__all__ = [
    "FieldInfo", "RootSpec", "StructInfo", "Values", "array_of", "force", "lazy_array", "lazy_bytes",
    "lazy_region", "lazy_stream", "lazy_target", "open_view", "plain", "stream_each", "stream_field",
    "stream_slice", "view_child",
]  # fmt: skip

# ── lazy values ────────────────────────────────────────────────────────────────


class Lazy:
    """A value computed on first access (and again after an in-place patch of its space)."""

    __slots__ = ("f", "value", "done", "version", "space", "window")

    def __init__(self, f: Callable[[], Any], space: Space) -> None:
        self.f = f
        self.value: Any = None
        self.done = False
        self.version = -1
        self.space = space
        #: Bytes values: ``() -> (space, start, length)`` without reading them (lazy streams).
        self.window: Callable[[], tuple[Space, int, int] | None] | None = None

    def get(self) -> Any:
        v = self.space.version
        if not self.done or self.version != v:
            self.value = self.f()
            self.done = True
            self.version = v
        return self.value


def force(v: Any) -> Any:
    """Forces a lazy value (other values pass through)."""
    return v.get() if type(v) is Lazy else v


class Values:
    """The fields of a struct while it is scanned (attribute name → value)."""


# ── byte spaces ────────────────────────────────────────────────────────────────

_space_ids = itertools.count(1)


class Space:
    """A byte space: the view's source, a codec's decoded output or a stream. In-place patches
    live here. The bytes are ``bytes``, a memory map, or a :class:`LazyStore` (read on demand)."""

    def __init__(
        self,
        root: ViewRoot,
        data: Any,
        store: LazyStore | None = None,
        writable: Callable[[], Any] | None = None,
    ) -> None:
        self.id = next(_space_ids)
        self.root = root
        self.store = store
        #: The original bytes (bytes, an mmap, or the store's original bytes); never modified.
        self.orig: Any = SourceBytes(store) if store is not None else data
        #: The current bytes: the original until the first patch, then a patched copy (stores
        #: keep patches in their cache).
        self.data: Any = store.buf if store is not None else data
        #: Makes the patched copy (a copy-on-write map for memory-mapped files).
        self.writable = writable
        self.patches: list[tuple[int, bytes, StructNode | None]] = []
        #: Bumped by every patch: cached scans and lazy values re-read.
        self.version = 0
        self.size: int = store.size if store is not None else len(data)

    def patch(self, at: int, data: bytes, node: StructNode | None) -> None:
        if at < 0 or at + len(data) > self.size:
            fail("RANGE", "patch outside the data")
        if self.store is not None:
            self.store.patch(at, data)
        else:
            if self.data is self.orig:
                self.data = self.writable() if self.writable is not None else bytearray(self.data)
            self.data[at : at + len(data)] = data
        self.patches.append((at, bytes(data), node))
        self.version += 1
        self.root.version += 1

    def get(self, offset: int, length: int) -> bytes:
        if self.store is not None:
            return self.store.get(offset, length)
        return bytes(self.data[offset : offset + length])

    def original(self) -> bytes:
        """All of the original bytes."""
        return bytes(self.orig)

    def reader(self, pos: int, base: int, end: int, strict: bool) -> Reader:
        r = StoreReader(self.store, strict) if self.store is not None else Reader(self.data, strict)
        r.pos = pos
        r.base = base
        r.end = end
        r.max_end = pos
        return r


# ── generated metadata ─────────────────────────────────────────────────────────


@dataclass
class FieldInfo:
    """Per-field view metadata."""

    #: The field's name in yaffle (JSON key).
    name: str
    input: str
    #: Read-side expressions depend on it: setting it changes the structure.
    structural: bool


@dataclass
class StructInfo:
    """Per-struct view metadata emitted by the Python backend (``_view_X``)."""

    name: str
    key: str
    scan: Callable[..., tuple[Values, dict[str, tuple[int, int]]]]
    static_size: int | None
    base: bool
    #: In-place edits inside inline children cannot change this struct's derived values.
    child_safe: bool
    #: Attribute name → field info (output fields, declaration order).
    fields: dict[str, FieldInfo] = field(default_factory=dict)
    #: Attribute name → encoder ``(value, values, *args) -> bytes`` of fields that can be
    #: patched in place (no derive depends on them).
    encode: dict[str, Callable[..., bytes]] = field(default_factory=dict)


# ── scan context ───────────────────────────────────────────────────────────────


@dataclass
class _ScanCtx:
    """What the scan helpers called by generated code are working in."""

    root: ViewRoot
    space: Space
    node: StructNode | None
    path: list[PathSegment]


_scan_stack: list[_ScanCtx] = []


def _current() -> _ScanCtx:
    if not _scan_stack:
        fail("INPUT", "view helper used outside a scan")
    return _scan_stack[-1]


def _with_scan(ctx: _ScanCtx, f: Callable[[], Any]) -> Any:
    _scan_stack.append(ctx)
    try:
        return f()
    finally:
        _scan_stack.pop()


# ── nodes ──────────────────────────────────────────────────────────────────────


@dataclass
class NodeCtx:
    """Where a struct is read: its region, `$index`, strictness, parent and path."""

    base: int
    end: int
    index: int
    strict: bool
    parent: StructNode | None
    path: list[PathSegment]


_MISSING = object()


class StructNode:
    """The state behind a struct view."""

    def __init__(
        self, root: ViewRoot, space: Space, info: StructInfo, pos: int, args: Sequence[Any], ctx: NodeCtx
    ) -> None:
        self.root = root
        self.space = space
        self.info = info
        self.pos = pos
        self.args = tuple(args)
        self.ctx = ctx
        self.values: dict[str, Any] | None = None
        self.ranges: dict[str, tuple[int, int]] = {}
        self.version = -1
        #: End of the inline bytes (before a base struct's targets).
        self.inline_end = -1
        #: End of everything the struct consumes.
        self.extent_end = -1
        self.materialized: dict[str, Any] | None = None
        self.view = StructView(self)

    @property
    def path(self) -> list[PathSegment]:
        return self.ctx.path

    def ensure_scanned(self, prefix: bool = True) -> dict[str, Any]:
        """Scans the struct (again after an in-place patch of its space). Errors get the node's
        path, unless ``prefix`` is false: a scan run inside the parent's scan, whose own error
        handling adds the path."""
        if self.values is not None and self.version == self.space.version:
            return self.values
        r = self.space.reader(self.pos, self.ctx.base, self.ctx.end, self.ctx.strict)
        r.index = self.ctx.index
        try:
            vals, ranges = _with_scan(
                _ScanCtx(self.root, self.space, self, self.path), lambda: self.info.scan(r, *self.args)
            )
        except YaffleError as e:
            if prefix:
                e.prefix(*self.path)
            raise
        self.values = vals.__dict__
        self.ranges = ranges
        self.inline_end = r.inline_end if r.inline_end >= 0 else r.pos
        self.extent_end = r.pos
        self.version = self.space.version
        return self.values

    @property
    def size(self) -> int:
        """Size of the struct's bytes (inline extent; a base struct includes its targets)."""
        if self.info.static_size is not None and not self.info.base:
            return self.info.static_size
        self.ensure_scanned()
        return self.extent_end - self.pos

    def _src(self) -> dict[str, Any]:
        return self.materialized if self.materialized is not None else self.ensure_scanned()

    def keys(self) -> list[str]:
        src = self._src()
        return [k for k in self.info.fields if k in src]

    def _name(self, attr: str) -> str:
        fi = self.info.fields.get(attr)
        return fi.name if fi is not None else attr

    def get(self, attr: str) -> Any:
        v = self._src().get(attr, _MISSING)
        if v is _MISSING:
            raise AttributeError(attr)
        if type(v) is not Lazy:
            return v
        try:
            return v.get()
        except YaffleError as e:
            e.prefix(*self.path, self._name(attr))
            raise

    def raw_side(self, key: str) -> Any:
        """A side-data map (``_yfl_raw``, ``_yfl_hidden``) of the scanned values."""
        return self._src().get(key)

    def original_target(self, attr: str) -> tuple[int, int] | None:
        """Where the field's original target was (before any edit), for sticky layout."""
        v = self.ensure_scanned().get(attr)
        return None if v is None else self.root.original_place(force(v), self.space)

    def set(self, attr: str, value: Any) -> None:
        fi = self.info.fields.get(attr)
        try:
            if fi is None:
                fail("INPUT", f"{self.info.name} has no field {attr}")
            if fi.input == "absent":
                fail("INPUT", f"{fi.name} is derived and cannot be set")
            enc = self.info.encode.get(attr)
            if enc is not None and self.materialized is None:
                # Encoding validates the value (range, type, checks) right away.
                vals = self.ensure_scanned()
                rng = self.ranges.get(attr)
                values = Values()
                values.__dict__.update({k: (None if type(x) is Lazy else x) for k, x in vals.items()})
                values.__dict__[attr] = value
                data = enc(value, values, *self.args)
                if not fi.structural and rng is not None and len(data) == rng[1] - rng[0]:
                    self.space.patch(rng[0], data, self)
                    return
            self.materialize()[attr] = value
            self.root.mark_structural()
        except YaffleError as e:
            e.prefix(*self.path, self._name(attr))
            raise

    def delete(self, attr: str) -> None:
        self.materialize().pop(attr, None)
        self.root.mark_structural()

    def materialize(self) -> dict[str, Any]:
        if self.materialized is None:
            self.materialized = dict(self.ensure_scanned())
        return self.materialized


@dataclass
class _LazyElements:
    """Fixed-size elements read on access."""

    start: int
    count: int
    size: int
    read: Callable[[Reader, int], Any]
    #: Encoder of an element (in-place patches), if elements are scalars.
    encode: Callable[[Any], bytes] | None
    base: int
    end: int
    strict: bool


class ArrayNode:
    """An array of a field: lazy (fixed-size elements) or a list of values and views."""

    def __init__(
        self,
        root: ViewRoot,
        space: Space,
        owner: StructNode | None,
        path: list[PathSegment],
        owner_path: list[PathSegment],
        lazy: _LazyElements | None,
        items: list[Any] | None,
    ) -> None:
        self.root = root
        self.space = space
        self.owner = owner
        self.path = path
        #: Path of the context that created the array (element views extend it).
        self.owner_path = owner_path
        self.lazy = lazy
        self.items = items
        self.cache: dict[int, Any] = {}
        self.cache_version = 0
        self.view = ArrayView(self)

    def __len__(self) -> int:
        return len(self.items) if self.items is not None else self.lazy.count  # type: ignore[union-attr]

    def get(self, i: int) -> Any:
        if self.items is not None:
            return force(self.items[i])
        lz = self.lazy
        assert lz is not None
        if i < 0:
            i += lz.count
        if not 0 <= i < lz.count:
            raise IndexError(i)
        if self.cache_version != self.space.version:
            self.cache.clear()
            self.cache_version = self.space.version
        if i in self.cache:
            return self.cache[i]
        r = self.space.reader(lz.start + i * lz.size, lz.base, lz.end, lz.strict)
        r.index = i
        try:
            v = _with_scan(
                _ScanCtx(self.root, self.space, self.owner, self.owner_path), lambda: force(lz.read(r, i))
            )
        except YaffleError as e:
            e.prefix(*self.path, i)
            raise
        self.cache[i] = v
        return v

    def set(self, i: int, v: Any) -> None:
        lz = self.lazy
        if self.items is None and lz is not None and lz.encode is not None:
            if i < 0:
                i += lz.count
            if 0 <= i < lz.count and node_of(self.get(i)) is None:
                data = lz.encode(v)
                if len(data) == lz.size:
                    self.space.patch(lz.start + i * lz.size, data, self.owner)
                    return
        self.materialize()[i] = v
        self.root.mark_structural()

    def materialize(self) -> list[Any]:
        if self.items is None:
            self.items = self.snapshot()
        if self.owner is not None and self.owner.materialized is None:
            self.owner.materialize()
        return self.items

    def snapshot(self) -> list[Any]:
        return [self.get(i) for i in range(len(self))]


# ── view objects ───────────────────────────────────────────────────────────────


def node_of(v: Any) -> StructNode | ArrayNode | None:
    """The node behind a struct or array view (None for other values)."""
    if isinstance(v, StructView):
        return _struct_node(v)
    if isinstance(v, ArrayView):
        return _array_node(v)
    return None


def _struct_node(v: StructView) -> StructNode:
    n = object.__getattribute__(v, "_node")
    return n.root_node if isinstance(n, ViewRoot) else n


def _array_node(v: ArrayView) -> ArrayNode:
    n: ArrayNode = object.__getattribute__(v, "_node")
    return n


@dataclass
class Patch:
    """An edit against the original bytes: remove ``remove`` bytes at ``at``, insert ``insert``."""

    at: int
    remove: int
    insert: bytes


class StructView:
    """A lazy, editable view of a struct. Fields are attributes; methods start with ``_``."""

    __slots__ = ("_node", "__weakref__")

    def __init__(self, node: StructNode | ViewRoot) -> None:
        # The root view holds the ViewRoot: it resolves to the current root node (after commits).
        object.__setattr__(self, "_node", node)

    def __getattr__(self, name: str) -> Any:
        node = _struct_node(self)
        if name == "_yfl_hidden" or name == "_yfl_raw":
            return node.raw_side(name)
        if name.startswith("_"):
            raise AttributeError(name)
        if name not in node.info.fields:
            raise AttributeError(f"{node.info.name} has no field {name}")
        return node.get(name)

    def __setattr__(self, name: str, value: Any) -> None:
        _struct_node(self).set(name, value)

    def __delattr__(self, name: str) -> None:
        _struct_node(self).delete(name)

    def __dir__(self) -> list[str]:
        return _struct_node(self).keys()

    def __repr__(self) -> str:
        node = _struct_node(self)
        return f"<{node.info.name} view at 0x{node.pos:x}>"

    @property
    def _offset(self) -> int:
        """Absolute offset of the struct in its space."""
        return _struct_node(self).pos

    @property
    def _size(self) -> int:
        """Bytes the struct occupies."""
        return _struct_node(self).size

    def _raw(self) -> bytes:
        """The struct's current bytes (in-place edits applied)."""
        node = _struct_node(self)
        return node.space.get(node.pos, node.size)

    def _set(self, **values: Any) -> None:
        """Sets several fields."""
        node = _struct_node(self)
        for k, v in values.items():
            node.set(k, v)

    def _fields(self) -> list[str]:
        """The fields present (attribute names, declaration order)."""
        return _struct_node(self).keys()

    def _patches(self, grow: str = "default") -> list[Patch]:
        """The edits as patches against the original bytes (no side effects)."""
        return _struct_node(self).root.patches(grow)

    def _commit(self, grow: str = "default") -> bytes:
        """Applies the edits: returns the new bytes and rebinds the view to them."""
        return _struct_node(self).root.commit(grow)

    def _plain(self) -> dict[str, Any]:
        """A plain snapshot: field name → value (views and lazies resolved)."""
        return plain(self)  # type: ignore[no-any-return]


class ArrayView:
    """A lazy, editable view of an array (a mutable sequence)."""

    __slots__ = ("_node", "__weakref__")

    def __init__(self, node: ArrayNode) -> None:
        object.__setattr__(self, "_node", node)

    def __len__(self) -> int:
        return len(_array_node(self))

    def __getitem__(self, i: Any) -> Any:
        node = _array_node(self)
        if isinstance(i, slice):
            return [node.get(k) for k in range(*i.indices(len(node)))]
        return node.get(i)

    def __setitem__(self, i: Any, v: Any) -> None:
        node = _array_node(self)
        if isinstance(i, slice):
            node.materialize()[i] = v
            node.root.mark_structural()
        else:
            node.set(i, v)

    def __delitem__(self, i: Any) -> None:
        node = _array_node(self)
        del node.materialize()[i]
        node.root.mark_structural()

    def __iter__(self) -> Iterator[Any]:
        return iter(_array_node(self).snapshot())

    def __eq__(self, other: object) -> bool:
        return list(self) == list(other) if isinstance(other, (list, tuple, ArrayView)) else NotImplemented

    __hash__ = None  # type: ignore[assignment]

    def __repr__(self) -> str:
        return f"<array view of {len(self)}>"

    def _mutate(self) -> list[Any]:
        node = _array_node(self)
        items = node.materialize()
        node.root.mark_structural()
        return items

    def append(self, v: Any) -> None:
        self._mutate().append(v)

    def extend(self, vs: Any) -> None:
        self._mutate().extend(vs)

    def insert(self, i: int, v: Any) -> None:
        self._mutate().insert(i, v)

    def pop(self, i: int = -1) -> Any:
        return self._mutate().pop(i)

    def remove(self, v: Any) -> None:
        self._mutate().remove(v)

    def clear(self) -> None:
        self._mutate().clear()

    def reverse(self) -> None:
        self._mutate().reverse()

    def _plain(self) -> list[Any]:
        return plain(self)  # type: ignore[no-any-return]


def plain(v: Any, seen: dict[int, Any] | None = None) -> Any:
    """A deep plain snapshot of a view (struct views → dicts, array views → lists)."""
    if seen is None:
        seen = {}
    n = node_of(v)
    if n is None:
        if isinstance(v, list):
            return [plain(force(x), seen) for x in v]
        return v
    if id(v) in seen:
        return seen[id(v)]
    if isinstance(n, ArrayNode):
        out_l: list[Any] = []
        seen[id(v)] = out_l
        out_l.extend(plain(n.get(i), seen) for i in range(len(n)))
        return out_l
    out: dict[str, Any] = {}
    seen[id(v)] = out
    for k in n.keys():
        out[n.info.fields[k].name] = plain(n.get(k), seen)
    return out


# ── helpers called by generated scan functions ─────────────────────────────────


def view_child(r: Reader, info: StructInfo, args: Sequence[Any], seg: Sequence[PathSegment]) -> Any:
    """An inline struct: a child view (scanned now only if its size is not static)."""
    c = _current()
    path = [*c.path, *clean_path(seg)]
    node = c.root.node(c.space, r.pos, info, args, NodeCtx(r.base, r.end, r.index, r.strict, c.node, path))
    static = info.static_size if not info.base else None
    if static is not None and r.pos + static <= r.end:
        r.pos += static
        return node.view
    # A struct that doesn't fit is scanned too: the error names the field that crosses the end,
    # as in parse mode.
    node.ensure_scanned(False)
    if static is not None:
        r.fail("EOF", f"need {static} bytes for {info.name}")
    r.pos = node.extent_end
    r.max_end = max(r.max_end, r.pos)
    return node.view


def lazy_array(
    r: Reader,
    count: int,
    size: int,
    elem: Callable[[Reader, int], Any],
    encode: Callable[[Any], bytes] | None,
    seg: Sequence[PathSegment],
) -> Any:
    """A fixed-size-element array: elements are read on access."""
    c = _current()
    start = r.pos
    total = count * size
    if start + total > r.end:
        # Reads the elements in order, so the error names the element (and field) that crosses
        # the end, as in parse mode.
        saved = r.index
        for i in range(count):
            r.index = i
            p0 = r.pos
            try:
                if r.pos + size > r.end:
                    force(elem(r, i))
                r.pos = p0 + size
            except YaffleError as e:
                e.prefix(i)
                raise
        r.index = saved
        r.fail("EOF", f"need {total} bytes for {count} elements")
    r.pos += total
    lazy = _LazyElements(start, count, size, elem, encode, r.base, r.end, r.strict)
    return ArrayNode(c.root, c.space, c.node, [*c.path, *clean_path(seg)], c.path, lazy, None).view


def array_of(items: list[Any], seg: Sequence[PathSegment]) -> Any:
    """An array whose elements were read already (variable-size elements)."""
    c = _current()
    return ArrayNode(c.root, c.space, c.node, [*c.path, *clean_path(seg)], c.path, None, items).view


def lazy_bytes(r: Reader, n: int) -> Any:
    """Bytes read on access."""
    c = _current()
    start = r.pos
    if not isinstance(n, int) or n < 0:
        r.fail("RANGE", f"invalid length {n}")
    if start + n > r.end:
        r.fail("EOF", f"need {n} bytes at 0x{start:x}")
    r.pos += n
    space = c.space

    def read() -> bytes:
        b = space.get(start, n)
        # Unpatched bytes keep their provenance: commits copy them instead of comparing.
        if not any(a < start + n and start < a + len(d) for a, d, _ in space.patches):
            c.root.remember_bytes(b, space, start)
        return b

    lz = Lazy(read, space)
    lz.window = lambda: (space, start, n)
    return lz


def lazy_target(r: Reader, addr: int, key: Any, read: Callable[[Reader], Any], seg: Sequence[PathSegment] = ()) -> Any:
    """A pointer or ``at`` target, read on access (identity per address and type key)."""
    c = _current()
    base, end, strict = r.base, r.end, r.strict
    path = [*c.path, *clean_path(seg)]

    def get() -> Any:
        k = (c.space.id, addr, key, c.space.version)
        hit = c.root.targets.get(k, _MISSING)
        if hit is not _MISSING:
            return hit
        if not isinstance(addr, int) or addr < 0 or addr > c.space.size:
            fail("EOF", f"target address 0x{addr:x} is outside the data", addr)
        r2 = c.space.reader(addr, base, end, strict)
        v = _with_scan(_ScanCtx(c.root, c.space, None, path), lambda: force(read(r2)))
        if v is not None and not isinstance(v, (int, float, str, bool)):
            c.root.set_origin(v, addr, r2.pos - addr, c.space)
        c.root.targets[k] = v
        return v

    return Lazy(get, c.space)


def lazy_region(
    r: Reader,
    codec: Any,
    name: str,
    ctx: CodecContext,
    streaming: bool,
    ranged: bool,
    slot: str,
    read: Callable[[Reader], Any],
    is_async: bool = False,
) -> Any:
    """A codec region, decoded on access (streaming codecs right away: their length is unknown).

    Async codecs raise :class:`NeedAsync`: async views decode, cache the output, and retry.
    """
    c = _current()
    root = c.root
    parent = c.space
    start = r.pos
    strict = r.strict
    decoded: bytes | None = None
    end = r.end
    key = (parent.id, start, slot)

    def decode_now(data: bytes, stream: bool) -> tuple[bytes, int]:
        if not is_async:
            return decode(codec, name, data, ctx, stream, start)
        hit: tuple[bytes, int] | None = root.async_decoded.get(key)
        if hit is not None:
            return hit

        async def run() -> None:
            root.async_decoded[key] = await decode_async(codec, name, data, ctx, stream, start)

        raise NeedAsync(key, run)

    if streaming:
        decoded, consumed = decode_now(parent.get(start, r.end - start), True)
        end = start + consumed
    r.pos = end

    def region() -> Space:
        sp = root.regions.get(key)
        if sp is None or root.region_versions.get(key) != parent.version:
            if ranged and decoded is None and not is_async:
                # Ranged codecs decode only the blocks a read touches.
                sp = Space(root, None, RangedStore(parent, start, end - start, codec, name, ctx))
            else:
                sp = Space(root, decoded if decoded is not None else decode_now(parent.get(start, end - start), False)[0])
            root.regions[key] = sp
            root.region_versions[key] = parent.version
        return sp

    def scan(f: Callable[[Reader], Any]) -> tuple[Space, Any]:
        space = region()
        r2 = space.reader(0, 0, space.size, strict)
        return space, _with_scan(_ScanCtx(root, space, None, c.path), lambda: f(r2))

    def get() -> Any:
        space, v = scan(lambda r2: force(read(r2)))
        if space.store is None:
            remember_codec(v, slot, parent.get(start, end - start), bytes(space.data), root)
        else:
            # Resolved on reuse only (a commit that re-encodes this value).
            remember_codec(v, slot, lambda: parent.get(start, end - start), space.original, root)
        return v

    def window() -> tuple[Space, int, int] | None:
        # The decoded bytes' window, without reading them (a bytes field read from the region).
        inner = scan(read)[1]
        return inner.window() if type(inner) is Lazy and inner.window is not None else None

    lz = Lazy(get, parent)
    lz.window = window
    return lz


def lazy_stream(stream: Callable[[], Any], strict: bool, read: Callable[[Reader], Any]) -> Any:
    """A field read from a stream, on access. The stream is bytes or a lazy store
    (:func:`stream_each`, :func:`stream_field`, :func:`stream_slice`)."""
    c = _current()
    root = c.root
    built: list[Space] = []

    def get() -> Any:
        if built and built[0].patches:
            space = built[0]  # keeps in-place edits made in the stream
        else:
            data = stream()
            space = Space(root, None, data) if isinstance(data, LazyStore) else Space(root, data)
            built[:] = [space]
            # Commits check stream spaces for in-place edits (they are re-encoded).
            root.streams.append(space)
        r2 = space.reader(0, 0, space.size, strict)
        return _with_scan(_ScanCtx(root, space, None, c.path), lambda: force(read(r2)))

    return Lazy(get, c.space)


def _piece(e: Any, attr: str, name: str, k: int) -> bytes:
    """Stream piece ``k``: field ``attr`` of element ``e`` (hidden or not), decoded. Errors get
    the piece's own path (as in parse mode, where pieces are read with their elements)."""
    n = node_of(e)
    try:
        if isinstance(n, StructNode):
            src = n._src()
            hidden = src.get("_yfl_hidden")
            v = force(hidden[attr] if isinstance(hidden, dict) and attr in hidden else src.get(attr))
        else:
            v = force(field_value(e, attr))
    except YaffleError as err:
        seal_path(err, [*(n.path if isinstance(n, StructNode) else []), name])
        raise
    if not isinstance(v, (bytes, bytearray, memoryview)):
        fail("INPUT", f"stream piece {k} has no bytes in {name}")
    return bytes(v)


def stream_each(arr: Any, attr: str, name: str, length: Callable[[Any], int | None] | None = None) -> Any:
    """``arr[*].field`` in a view: a :class:`PieceStore` that decodes only the pieces a read
    touches. ``length(element)`` gives a piece's decoded length from its size fields (None:
    learned by decoding it)."""
    els = list(arr) if not isinstance(arr, ArrayView) else None

    def elem(k: int) -> Any:
        return els[k] if els is not None else arr[k]

    def piece_length(k: int) -> int | None:
        if length is None:
            return None
        e = elem(k)
        n = node_of(e)
        # An edited (materialized) element's length is learned by decoding it.
        return length(e) if isinstance(n, StructNode) and n.materialized is None else None

    count = len(arr)
    return PieceStore(count, [piece_length(k) for k in range(count)], lambda k: _piece(elem(k), attr, name, k))


def stream_field(v: Any) -> Any:
    """A bytes field as a stream: a window of its space when it can be read lazily (a ``@ranged``
    region or a source read on demand), else its bytes."""
    if type(v) is Lazy and v.window is not None and not v.done:
        w = v.window()
        if w is not None and w[0].store is not None:
            return SliceStore(*w)
    return force(v)


def stream_slice(s: Any, start: int, end: int | None = None) -> Any:
    """``raw[a..b]`` of a stream (bytes or a lazy store)."""
    if not isinstance(s, LazyStore):
        return slice_stream(s, start, end)
    e = s.size if end is None else end
    if start < 0 or e > s.size or start > e:
        fail("EOF", f"stream slice [{start}, {e}) is outside the stream of {s.size} bytes")
    return SliceStore(s, start, e - start)


# ── the view root ──────────────────────────────────────────────────────────────


@dataclass
class RootSpec:
    """What a view needs from the generated root API."""

    info: StructInfo
    args: tuple[Any, ...]
    strict: bool
    layout: Any
    #: The root writer ``(writer, value)`` (None for async roots).
    write: Callable[[Any, Any], Any] | None
    #: The async root writer (roots that reach an async codec).
    write_async: Callable[[Any, Any], Any] | None = None
    #: The root's canonical JSON converter (``X.to_json``), for async views' ``_to_json()``.
    to_json: Callable[[Any], Any] | None = None


class ViewRoot:
    """A view's shared state: its spaces, nodes, caches and where values came from."""

    def __init__(
        self,
        data: Any,
        spec: RootSpec,
        sink: Callable[[bytes, list[Patch]], None] | None = None,
        store: LazyStore | None = None,
        writable: Callable[[], Any] | None = None,
    ) -> None:
        self.spec = spec
        #: Receives committed bytes and patches (writes them back to the source).
        self.sink = sink
        self.version = 0
        self.view = StructView(self)
        self.reset(data, store, writable)

    def reset(self, data: Any, store: LazyStore | None = None, writable: Callable[[], Any] | None = None) -> None:
        """Starts over on new bytes (after a commit)."""
        self.space = Space(self, data, store, writable)
        self.nodes: dict[Any, StructNode] = {}
        self.targets: dict[Any, Any] = {}
        self.regions: dict[Any, Space] = {}
        self.region_versions: dict[Any, int] = {}
        #: Outputs of async codecs, (space id, offset, slot) -> (decoded, consumed).
        self.async_decoded: dict[Any, tuple[bytes, int]] = {}
        #: Spaces of streams read so far (in-place edits in them need a re-encode).
        self.streams: list[Space] = []
        #: id(value) -> (value, pos, size, space): where targets were read.
        self.origins: dict[int, tuple[Any, int, int, Space]] = {}
        #: id(bytes) -> (bytes, space, offset): byte values read unchanged from a space.
        self.byte_origins: dict[int, tuple[bytes, Space, int]] = {}
        self.structural = False
        self.version += 1
        self.root_node = StructNode(
            self, self.space, self.spec.info, 0, self.spec.args, NodeCtx(0, self.space.size, -1, self.spec.strict, None, [])
        )

    def node(self, space: Space, pos: int, info: StructInfo, args: Sequence[Any], ctx: NodeCtx) -> StructNode:
        k = (space.id, pos, info.key, tuple(a if isinstance(a, (int, str, float, bool)) else "o" for a in args))
        n = self.nodes.get(k)
        if n is None:
            n = self.nodes[k] = StructNode(self, space, info, pos, args, ctx)
        return n

    def set_origin(self, v: Any, pos: int, size: int, space: Space) -> None:
        self.origins[id(v)] = (v, pos, size, space)

    def original_place(self, v: Any, space: Space) -> tuple[int, int] | None:
        """Where ``v`` (a target or struct view) was in ``space``: (position, size)."""
        o = self.origins.get(id(v))
        if o is not None and o[0] is v and o[3] is space:
            return o[1], o[2]
        n = node_of(v)
        if isinstance(n, StructNode) and n.space is space:
            return n.pos, n.size
        return None

    def remember_bytes(self, b: bytes, space: Space, offset: int) -> None:
        self.byte_origins[id(b)] = (b, space, offset)

    def bytes_origin(self, b: Any) -> tuple[Space, int] | None:
        o = self.byte_origins.get(id(b))
        if o is None or o[0] is not b:
            return None
        return o[1], o[2]

    def mark_structural(self) -> None:
        self.structural = True
        self.version += 1

    def patches(self, grow: str = "default") -> list[Patch]:
        from .commit import plan

        return plan(self, grow).patches

    def commit(self, grow: str = "default") -> bytes:
        from .commit import plan

        if self.spec.write is None:
            fail("INPUT", "this view is async: use `await view._commit()`")
        p = plan(self, grow)
        data = p.bytes()
        if self.sink is not None:
            self.sink(data, p.patches)
        self.reset(data)
        return data


def first_shift(patches: list[Patch]) -> Patch | None:
    """The first patch that changes the size: everything after it moves."""
    return next((p for p in patches if p.remove != len(p.insert)), None)


def write_back(src: Any, data: bytes, patches: list[Patch]) -> None:
    """Writes committed bytes back to a source that has ``write`` (and ``truncate`` to shrink):
    the patches up to the first size change, then the whole tail."""
    shift = first_shift(patches)
    for p in patches:
        if shift is not None and p.at >= shift.at:
            break
        src.write(p.at, p.insert)
    if shift is not None:
        src.write(shift.at, data[shift.at :])
        if len(data) < src.size:
            truncate = getattr(src, "truncate", None)
            if truncate is None:
                fail("INPUT", "the source cannot shrink (no truncate)")
            truncate(len(data))


def _sink(source: Any) -> Callable[[bytes, list[Patch]], None] | None:
    """Commits are written back to sources that have ``write``."""
    return (lambda b, p: write_back(source, b, p)) if callable(getattr(source, "write", None)) else None


def mapped_root(source: Any, spec: RootSpec) -> ViewRoot | None:
    """The view root over a source with ``buffer()`` (``file_source``): memory-mapped in place, a
    copy-on-write map holding in-place patches if the source offers ``copy_buffer()``."""
    buf = getattr(source, "buffer", None)
    data = buf() if callable(buf) else None
    if data is None:
        return None
    cow = getattr(source, "copy_buffer", None)
    return ViewRoot(data, spec, _sink(source), None, cow if callable(cow) else None)


def cached_root(source: Any, spec: RootSpec) -> ViewRoot:
    """The view root over a random-access source read on demand through a block cache."""
    return ViewRoot(None, spec, _sink(source), BlockStore(source))


def open_view(source: Any, spec: RootSpec) -> Any:
    """Opens a view over bytes (in memory) or a source (memory-mapped, else read in blocks, never
    as a whole). Async sources, and roots that reach an async codec, get an async view."""
    from .async_view import open_async_view

    ensure_recursion()
    if spec.write is None:
        return open_async_view(source, spec)
    if isinstance(source, (bytes, bytearray, memoryview)):
        return ViewRoot(bytes(source), spec).view
    reject_path(source)
    root = mapped_root(source, spec)
    if root is None:
        if is_async_source(source):
            return open_async_view(source, spec)
        root = cached_root(source, spec)
    return root.view
