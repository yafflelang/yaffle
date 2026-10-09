"""The relocation-style writer (docs/IR.md §3.2).

1. Generated writers encode bottom-up into **blocks**: inline bytes plus **fixups** (a position
   and a callable computing the value once sizes and positions are final).
2. Pointer and ``at`` targets become **placeables**, each with its own block. Generated code also
   records the structure (:class:`LStruct` / :class:`LArray`) the layout engine matches ``layout``
   paths against.
3. When a base **region** (the root, a ``@base`` struct, a codec's decoded side) is complete, the
   layout engine assigns every block a position, the blocks are assembled, and the fixups run.
"""

from __future__ import annotations

import builtins
import dataclasses
from math import lcm
from typing import Any, Awaitable, Callable, Sequence

from .errors import PathSegment, YaffleError, clean_path, describe, fail, seal_path
from .prim import PRIMS, STRUCTS, check_prim, pack_prim
from .reader import Fill, fill_byte
from .strings import encode_string

__all__ = ["LArray", "LStruct", "Region", "Writer"]

# ── structure for layout ───────────────────────────────────────────────────────


class LStruct:
    """The placeables reachable from one struct instance, by field (declaration order), and the
    struct's layout items."""

    __slots__ = ("layout", "fields")

    def __init__(self, layout: Sequence[Any] | None = None) -> None:
        self.layout = layout
        self.fields: dict[str, Any] = {}

    def set(self, name: str, e: Any) -> None:
        if e is not None:
            self.fields[name] = e


class LArray:
    __slots__ = ("items",)

    def __init__(self) -> None:
        self.items: list[Any] = []

    def push(self, e: Any) -> None:
        self.items.append(e)


class Placeable:
    """A pointer or ``at`` target: its block plus the structure of its content."""

    __slots__ = ("block", "content", "constraint", "fixed", "orig", "orig_size", "name")

    def __init__(
        self,
        block: Block,
        name: str,
        constraint: tuple[int, int] | None = None,
        fixed: int | None = None,
    ) -> None:
        self.block = block
        self.name = name
        self.content: Any = None
        self.constraint = constraint
        self.fixed = fixed
        #: View commits: the original position and size, for sticky layout.
        self.orig: int | None = None
        self.orig_size: int | None = None
        # A fixed placement's position is known before its content is written: inner alignment
        # is computed from it instead of constraining the block's start.
        if fixed is not None:
            block.fixed_at = fixed


# ── blocks ─────────────────────────────────────────────────────────────────────


class Block:
    __slots__ = ("data", "align", "fixed_at", "pos", "region", "prov")

    def __init__(self, region: Region) -> None:
        self.data = bytearray()
        #: Required start alignment (from `align` layers inside, relative to the block start).
        self.align = 1
        #: The base-relative start when known before layout (fixed placements).
        self.fixed_at: int | None = None
        #: Base-relative position, assigned by layout (-1 until then). The region root is at 0.
        self.pos = -1
        self.region = region
        #: View commits: parts copied unchanged from a source, (at, length, (space, offset)).
        self.prov: list[tuple[int, int, tuple[Any, int]]] | None = None

    def fill(self, n: int, fill: Fill) -> None:
        if isinstance(fill, int):
            self.data += bytes((fill & 0xFF,)) * n
        else:
            self.data += bytes(fill_byte(fill, i) for i in range(n))


class Fixup:
    """A value computed once the region is laid out. Phase 0 runs first (sizes, positions,
    pointers), then `@ref` pointers are resolved, then phase 2 (content: checksums), innermost
    structs first."""

    __slots__ = ("block", "at", "phase", "depth", "path", "run")

    def __init__(
        self,
        block: Block,
        at: int,
        phase: int,
        depth: int,
        path: list[PathSegment],
        run: Callable[[bytearray, int], None],
    ) -> None:
        self.block = block
        self.at = at
        self.phase = phase
        self.depth = depth
        self.path = path
        self.run = run


class Mark:
    """A position inside a block (absolute = block.pos + at once laid out)."""

    __slots__ = ("block", "at")

    def __init__(self, block: Block, at: int) -> None:
        self.block = block
        self.at = at


class Extent:
    """Start and end of a field's encoding, for sizeof/offsetof/bytesof/encodedSize."""

    __slots__ = ("block", "start", "end", "stages", "placeable", "empty_is_null", "plain")

    def __init__(self, block: Block, start: int) -> None:
        self.block = block
        self.start = start
        self.end = -1
        #: Byte length after each layer stage (`encodedSize(field, k)`).
        self.stages: dict[int, int] = {}
        #: Placed fields: the placeable that holds the field.
        self.placeable: Placeable | None = None
        #: An empty placed array whose offset is written as 0 (`@nullable(empty)`).
        self.empty_is_null = False
        #: The plain encoding (before any codec), if a `via` layer recorded it.
        self.plain: builtins.bytes | None = None

    @property
    def size(self) -> int:
        if self.placeable is not None:
            return len(self.placeable.block.data)
        if self.end < 0:
            return len(self.block.data) - self.start
        return self.end - self.start

    @property
    def pos(self) -> int:
        """Base-relative position (valid after layout)."""
        p = self.placeable
        if p is not None:
            if self.empty_is_null and not p.block.data:
                return 0
            return p.block.pos
        if self.block.pos < 0:
            fail("DERIVE", "position used before layout")
        return self.block.pos + self.start

    def stage(self, k: int) -> int:
        """Encoded size after ``k`` layer stages (0 = plain encoding)."""
        v = self.stages.get(k)
        if v is None:
            n = max(self.stages) + 1 if self.stages else 0
            if k >= n and self.end >= 0:
                return self.size
            fail("DERIVE", f"encoded size at layer {k} is not available yet")
        return v

    def bytes(self) -> builtins.bytes:
        """The field's bytes in the finished region (content fixups only)."""
        b = self.placeable.block if self.placeable is not None else self.block
        out = b.region.output
        if out is None:
            fail("DERIVE", "bytes of a field used before its region was assembled")
        pos = self.pos
        return bytes(out[pos : pos + self.size])

    def plain_bytes(self) -> builtins.bytes:
        if self.plain is not None:
            return self.plain
        a = self.bytes()
        s0 = self.stages.get(0)
        return a[:s0] if s0 is not None else a


class RegionExtent(Extent):
    """``this`` of a base struct: its whole region (size known once the region is finished)."""

    __slots__ = ("region",)

    def __init__(self, region: Region) -> None:
        super().__init__(region.root, 0)
        self.region = region

    @property
    def size(self) -> int:
        out = self.region.output
        return len(out) if out is not None else len(self.region.root.data)


# ── regions ────────────────────────────────────────────────────────────────────


class RefSite:
    """An encoded value a `@ref` pointer may point at."""

    __slots__ = ("key", "block", "start", "end", "value")

    def __init__(self, key: str, block: Block, start: int, end: int, value: Any) -> None:
        self.key = key
        self.block = block
        self.start = start
        self.end = end
        self.value = value


@dataclasses.dataclass(slots=True)
class RefUse:
    """A `@ref` pointer waiting for resolution after layout."""

    key: str
    path: list[PathSegment]
    #: Object targets: matched by identity first.
    value: Any
    #: Lazily computed encoding (objects), or the encoding itself (primitives).
    encode: Callable[[], Any] | None
    encoding: Any
    origin: Callable[[], int] | None
    #: Where the pointer is written.
    mark: Mark
    #: Start of the pointer's own base (None: this region's start).
    base: Mark | None
    kind: str
    le: bool
    relative: bool
    null_value: int | None


def _shareable(v: Any) -> bool:
    """Values that are objects with identity (structs, arrays): shared by reference on write."""
    return not (v is None or isinstance(v, (bool, int, float, str, bytes, bytearray, memoryview)))


class Region:
    """A base region: the base's own block at offset 0, plus everything placed in it."""

    def __init__(self, layout: Sequence[Any] | None = None) -> None:
        self.root = Block(self)
        self.root.pos = 0
        self.blocks: list[Block] = [self.root]
        self.placeables: list[Placeable] = []
        self.fixups: list[Fixup] = []
        #: id(value) -> (value, {type key: placeable})
        self.identity: dict[int, tuple[Any, dict[Any, Placeable]]] = {}
        self.ref_sites: list[RefSite] = []
        self.ref_uses: list[RefUse] = []
        self.lroot: LStruct | None = None
        self.layout = layout
        #: The region's total size is padded to a multiple of this (a base's `@alignEnd`).
        self.align_end = 1
        #: A nested `@base` region: unresolved `@ref`s go to the enclosing base.
        self.escalate = False
        self.unresolved: list[RefUse] = []
        #: View commits: keep unchanged placeables where they were (layout.StickyPolicy).
        self.sticky: Any = None
        #: Position of the region's start in its byte space (``@align(…, from: file)``), and
        #: whether it is exact. When it isn't (a nested base inside a target whose position comes
        #: from layout), alignments from the file start used inside (``file_align``) constrain
        #: the block that holds the region instead.
        self.file_origin = 0
        self.file_exact = True
        self.file_align = 1
        #: ``@alignEnd`` of the whole region with an offset or from the file start.
        self.end_aligns: list[tuple[int, int, builtins.bool]] = []
        #: After finish: the assembled bytes and part provenance (view commits).
        self.output: bytearray | None = None
        self.provenance: list[tuple[int, int, tuple[Any, int]]] = []

    def attach_root(self, entry: Any) -> None:
        """Sets the structure of a root or base region (the entry its struct's writer returned).
        Without a layout of its own, the region takes its root struct's: a layout whose
        arguments read fields is only known once the struct is written."""
        if isinstance(entry, LStruct):
            self.lroot = entry
            if self.layout is None:
                self.layout = entry.layout

    def end_align(self, to: int, offset: int = 0, file: builtins.bool = False) -> None:
        """A base's ``@alignEnd``: the region's end is padded (with an offset, or from the file
        start)."""
        if not isinstance(to, int) or to <= 0:
            fail("RANGE", f"invalid alignment {to}")
        if offset == 0 and not file:
            self.align_end = lcm(self.align_end, to)
            return
        if file and not self.file_exact:
            self.file_align = lcm(self.file_align, to)
        self.end_aligns.append((to, offset, file))

    def new_block(self) -> Block:
        b = Block(self)
        self.blocks.append(b)
        return b

    def _size(self) -> int:
        """The laid-out region's size, end alignment included."""
        size = max((b.pos + len(b.data) for b in self.blocks if b.pos >= 0), default=0)
        if self.align_end > 1:
            size = -(-size // self.align_end) * self.align_end
        # `@alignEnd` with an offset or from the file start: (origin + size + offset) % n == 0.
        # Several of them may need several rounds.
        for _ in range(64):
            grown = size
            for n, off, file in self.end_aligns:
                origin = self.file_origin if file else 0
                grown += (n - (origin + grown + off) % n) % n
            if grown == size:
                break
            size = grown
        return size

    def finish(self) -> bytearray:
        """Lays out, assembles and runs the fixups. Returns the region's bytes."""
        from .layout import layout_region

        layout_region(self)
        out = bytearray(self._size())
        for b in self.blocks:
            if b.pos < 0:
                continue
            out[b.pos : b.pos + len(b.data)] = b.data
            for at, ln, prov in b.prov or ():
                self.provenance.append((b.pos + at, ln, prov))
        self.output = out

        def run(f: Fixup) -> None:
            try:
                f.run(out, f.block.pos + f.at)
            except YaffleError as e:
                seal_path(e, f.path)
                raise

        for f in self.fixups:
            if f.phase == 0:
                run(f)
        self._resolve_refs(out)
        for f in sorted((f for f in self.fixups if f.phase == 2), key=lambda f: -f.depth):
            run(f)
        return out

    def _resolve_refs(self, out: bytearray) -> None:
        """Points each `@ref` pointer at the same object if it is placed here, else at the first
        placed value with the same encoding (or leaves it to the enclosing base)."""
        if not self.ref_uses:
            return
        by_identity: dict[int, dict[str, int]] = {}
        for s in self.ref_sites:
            if s.block.pos < 0 or s.value is None:
                continue
            a = s.block.pos + s.start
            m = by_identity.setdefault(id(s.value), {})
            if s.key not in m or a < m[s.key]:
                m[s.key] = a
        by_encoding: dict[tuple[str, bytes], int] | None = None

        def encoding_index() -> dict[tuple[str, bytes], int]:
            nonlocal by_encoding
            if by_encoding is None:
                by_encoding = {}
                for s in self.ref_sites:
                    if s.block.pos < 0:
                        continue
                    a = s.block.pos + s.start
                    k = (s.key, bytes(out[a : s.block.pos + s.end]))
                    if k not in by_encoding or a < by_encoding[k]:
                        by_encoding[k] = a
            return by_encoding

        for u in self.ref_uses:
            try:
                target: int | None = None
                if u.value is not None:
                    target = by_identity.get(id(u.value), {}).get(u.key)
                if target is None:
                    enc = u.encoding if u.encoding is not None or u.encode is None else u.encode()
                    target = encoding_index().get((u.key, bytes(enc)))
                if target is None:
                    if self.escalate:
                        self.unresolved.append(u)
                        continue
                    raise YaffleError("REF", "no equal value is placed in this base for a @ref pointer")
                a = u.mark.block.pos + u.mark.at
                base = u.base.block.pos + u.base.at if u.base is not None else 0
                value = (target - a if u.relative else target - base) - (u.origin() if u.origin else 0)
                write_offset(out, a, u.kind, u.le, value, u.null_value)
            except YaffleError as e:
                seal_path(e, u.path)
                raise


def write_offset(out: bytearray, at: int, kind: str, le: bool, value: int, null_value: int | None) -> None:
    if null_value is not None and value == null_value:
        fail("DERIVE", f"pointer offset {value} equals the null value")
    info = PRIMS[kind]
    if not info.signed and value < 0:
        fail("RANGE", f"negative offset {value} for {kind}")
    out[at : at + info.size] = pack_prim(kind, check_prim(value, kind, "pointer"), le)


_P16 = (STRUCTS[("u16", False)].pack, STRUCTS[("u16", True)].pack)
_P32 = (STRUCTS[("u32", False)].pack, STRUCTS[("u32", True)].pack)
_P64 = (STRUCTS[("u64", False)].pack, STRUCTS[("u64", True)].pack)
_BYTES_LIKE = (bytes, bytearray, memoryview)


# ── the writer used by generated code ─────────────────────────────────────────


class Writer:
    """Encodes values into blocks of the current region. Generated writers call its methods."""

    def __init__(self, region: Region) -> None:
        #: Current block (inline bytes go here).
        self.b: Block = region.root
        #: Current base region.
        self.region: Region = region
        self.root_region: Region = region
        #: Struct nesting depth (orders content fixups).
        self.depth = 0
        self.index = -1
        #: The path frames of the structs being written (fixups snapshot them for errors).
        self.frames: list[Sequence[PathSegment]] = []
        # View commits (commit.py): where values were in the original, for sticky layout and
        # provenance. Positions are relative to ``origin_base`` (the current base's original).
        self.origin: Callable[[Any], tuple[int, int] | None] | None = None
        self.slot_origin: Callable[[Any, builtins.str], tuple[int, int] | None] | None = None
        self.region_origin: Callable[[Any], tuple[int, int, int] | None] | None = None
        self.provenance: Callable[[Any], tuple[Any, int] | None] | None = None
        self.origin_base = 0

    def enter(self, frame: Sequence[PathSegment]) -> None:
        """Enters a struct writer; ``frame`` holds its current field and indices."""
        self.frames.append(frame)
        self.depth += 1

    def leave(self) -> None:
        self.frames.pop()
        self.depth -= 1

    def path(self) -> list[PathSegment]:
        """The current path from the root (snapshot)."""
        return [s for frame in self.frames for s in clean_path(frame)]

    @property
    def offset(self) -> int:
        """Offset of the next byte within the current block."""
        return len(self.b.data)

    @property
    def position(self) -> int:
        """``$offset`` on write: the base-relative position (exact in a region's own block)."""
        b = self.b
        return (b.pos if b.pos >= 0 else 0) + len(b.data)

    def mark(self) -> Mark:
        return Mark(self.b, len(self.b.data))

    def extent(self) -> Extent:
        return Extent(self.b, len(self.b.data))

    def region_extent(self) -> Extent:
        return RegionExtent(self.region)

    def close(self, e: Extent) -> None:
        e.end = len(self.b.data)

    def bind_extent(self, e: Extent, p: Placeable, empty_is_null: builtins.bool = False) -> None:
        """Binds the extent of a placed field (created before its content) to its placeable."""
        e.placeable = p
        e.block = p.block
        e.start = 0
        e.end = len(p.block.data)
        e.empty_is_null = empty_is_null

    # ── primitives (validated) ──────────────────────────────────────────────

    def prim(self, kind: builtins.str, v: Any, le: builtins.bool) -> None:
        info = PRIMS[kind]
        if info.float or type(v) is not int or v < info.lo or v > info.hi:
            v = check_prim(v, kind)
        self.b.data += pack_prim(kind, v, le)

    # u8, u16, u32 and u64 are the common cases: validated and packed without lookups.

    def u8(self, v: Any) -> None:
        if type(v) is not int or v < 0 or v > 255:
            v = check_prim(v, "u8")
        self.b.data.append(v)

    def u16(self, v: Any, le: builtins.bool) -> None:
        if type(v) is not int or v < 0 or v > 0xFFFF:
            v = check_prim(v, "u16")
        self.b.data += _P16[le](v)

    def u32(self, v: Any, le: builtins.bool) -> None:
        if type(v) is not int or v < 0 or v > 0xFFFFFFFF:
            v = check_prim(v, "u32")
        self.b.data += _P32[le](v)

    def u64(self, v: Any, le: builtins.bool) -> None:
        if type(v) is not int or v < 0 or v > 0xFFFFFFFFFFFFFFFF:
            v = check_prim(v, "u64")
        self.b.data += _P64[le](v)

    def bool(self, v: Any) -> None:
        if not isinstance(v, bool):
            fail("INPUT", f"expected a boolean, got {describe(v)}")
        self.b.data.append(1 if v else 0)

    # ── bytes and strings ───────────────────────────────────────────────────

    def bytes(self, v: Any) -> None:
        if not isinstance(v, _BYTES_LIKE):
            fail("INPUT", f"expected bytes, got {describe(v)}")
        self.raw(v)

    def bytes_n(self, v: Any, n: int) -> None:
        """``u8 x[n]``: exactly ``n`` bytes (other lengths would read back differently)."""
        if not isinstance(v, _BYTES_LIKE):
            fail("INPUT", f"expected bytes, got {describe(v)}")
        if len(v) != n:
            fail("DERIVE", f"{len(v)} bytes given, the length expression says {n}")
        self.raw(v)

    def raw(self, v: Any) -> None:
        """Bytes known to be valid. View commits note where unchanged source bytes go."""
        if self.provenance is not None and self.region is self.root_region:
            prov = self.provenance(v)
            if prov is not None:
                b = self.b
                if b.prov is None:
                    b.prov = []
                b.prov.append((len(b.data), len(v), prov))
        self.b.data += v

    def bytes_until(self, v: Any, term: int) -> None:
        """Bytes followed by a terminator byte (which must not occur inside)."""
        if not isinstance(v, _BYTES_LIKE):
            fail("INPUT", f"expected bytes, got {describe(v)}")
        t = term & 0xFF
        if t in bytes(v):
            fail("INPUT", f"the bytes contain the terminator 0x{t:x}")
        self.b.data += v
        self.b.data.append(t)

    def str(self, v: Any, unit: int, enc: builtins.str, le: builtins.bool, mode: builtins.str, n: int = 0) -> None:
        """Text: ``count`` pads with NUL units up to ``n``, ``until`` appends one NUL unit."""
        data = encode_string(v, enc, le)
        if mode == "count":
            if len(data) > n * unit:
                fail("INPUT", f"string of {len(data) // unit} units exceeds the length {n}")
            self.b.data += data + bytes(n * unit - len(data))
        else:
            self.b.data += data
            if mode == "until":
                self.b.data += bytes(unit)

    def extern(self, host: Any, value: Any, args: Sequence[Any], fixed_size: int) -> None:
        """Writes an extern type through its host ``write``."""
        try:
            out = host.write(value, *args)
        except YaffleError:
            raise
        except Exception as e:
            fail("CODEC", f"extern type write() failed: {e}")
        if not isinstance(out, _BYTES_LIKE):
            fail("INPUT", "extern type write() must return bytes")
        if fixed_size >= 0 and len(out) != fixed_size:
            fail("DERIVE", f"extern type wrote {len(out)} bytes, its fixed size is {fixed_size}")
        self.b.data += out

    # ── padding ─────────────────────────────────────────────────────────────

    def pad(self, n: int, fill: Fill) -> None:
        if not isinstance(n, int) or n < 0:
            fail("RANGE", f"invalid padding length {n}")
        self.b.fill(n, fill)

    def _known_start(self) -> int | None:
        """The current block's base-relative start if it is known before layout."""
        b = self.b
        return 0 if b is self.region.root else b.fixed_at

    def align(self, to: int, fill: Fill, offset: int = 0, file: builtins.bool = False) -> None:
        """Pads until ``(position - origin + offset) % to == 0``, where the origin is the base, or
        with ``file`` the start of the byte space. In a block whose start comes from layout, the
        block's start is aligned instead."""
        if not isinstance(to, int) or to <= 0:
            fail("RANGE", f"invalid alignment {to}")
        b = self.b
        region = self.region
        known = self._known_start()
        if known is None:
            b.align = lcm(b.align, to)
            known = 0
        origin = 0
        if file:
            origin = region.file_origin
            if not region.file_exact:
                region.file_align = lcm(region.file_align, to)
        rel = origin + known + len(b.data) + offset
        b.fill((to - rel % to) % to, fill)

    def _file_position(self) -> tuple[int, builtins.bool]:
        """The next byte's position in the byte space, and whether it is exact (a block whose
        start comes from layout is assumed to start at a multiple of the alignments it needs)."""
        region = self.region
        known = self._known_start()
        if known is None:
            return region.file_origin + len(self.b.data), False
        return region.file_origin + known + len(self.b.data), region.file_exact

    def pad_until(self, start: int, size: int, fill: Fill) -> None:
        used = len(self.b.data) - start
        if used > size:
            fail("INPUT", f"content of {used} bytes exceeds padUntil({size})")
        self.b.fill(size - used, fill)

    def size_window(self, start: int, n: int) -> None:
        """Closes a ``size(n)`` window opened at ``start``: longer is DERIVE, shorter is padded."""
        if not isinstance(n, int) or n < 0:
            fail("RANGE", f"invalid size {n}")
        used = len(self.b.data) - start
        if used > n:
            fail("DERIVE", f"content of {used} bytes does not fit size {n}")
        self.b.data += bytes(n - used)

    # ── fixups ──────────────────────────────────────────────────────────────

    def _fixup(self, size: int, phase: int, run: Callable[[bytearray, int], None]) -> None:
        """Reserves ``size`` bytes whose content ``run(out, at)`` writes after layout."""
        block = self.b
        at = len(block.data)
        block.data += bytes(size)
        self.region.fixups.append(Fixup(block, at, phase, self.depth, self.path(), run))

    def defer_prim(self, kind: builtins.str, le: builtins.bool, compute: Callable[[], Any], phase: int = 0) -> None:
        """A primitive whose value is computed after layout."""
        size = PRIMS[kind].size

        def run(out: bytearray, a: int) -> None:
            out[a : a + size] = pack_prim(kind, check_prim(compute(), kind), le)

        self._fixup(size, phase, run)

    def defer_bytes(self, n: int, compute: Callable[[], Any], phase: int = 0) -> None:
        """``n`` bytes whose content is computed after layout."""

        def run(out: bytearray, a: int) -> None:
            v = compute()
            if len(v) != n:
                fail("DERIVE", f"derived bytes have length {len(v)}, expected {n}")
            out[a : a + n] = v

        self._fixup(n, phase, run)

    def defer_check(self, check: Callable[[], Any]) -> None:
        """A check evaluated after layout (e.g. read-side placement offsets must match)."""
        self._fixup(0, 0, lambda out, a: check())

    # ── targets ─────────────────────────────────────────────────────────────

    def _placeable(
        self, value: Any, key: Any, name: builtins.str, constraint: tuple[int, int] | None, fixed: int | None
    ) -> tuple[Placeable, builtins.bool]:
        """The placeable of a pointer target and whether it is new: identical objects with the
        same type key share one."""
        if not _shareable(value):
            return Placeable(self.region.new_block(), name, constraint, fixed), True
        entry = self.region.identity.setdefault(id(value), (value, {}))
        hit = entry[1].get(key)
        if hit is not None:
            return hit, False
        p = entry[1][key] = Placeable(self.region.new_block(), name, constraint, fixed)
        return p, True

    def _begin_fill(self, p: Placeable, value: Any, owner: Any) -> tuple[Block, int]:
        """Switches to a new placeable's block; returns the block and index to restore."""
        self._note_origin(p, value, owner)
        self.region.placeables.append(p)
        saved = (self.b, self.index)
        self.b = p.block
        self.index = -1
        return saved

    def _note_origin(self, p: Placeable, value: Any, owner: Any) -> None:
        """View commits: where the target was in the original (sticky layout keeps it there)."""
        sticky = self.region.sticky
        if self.origin is None or sticky is None or sticky.orig_root_size is None:
            return
        o = self.origin(value)
        if o is None and owner is not None and self.slot_origin is not None:
            o = self.slot_origin(owner, p.name)
        if o is not None and o[0] >= self.origin_base:
            p.orig = o[0] - self.origin_base
            p.orig_size = o[1]

    def target(
        self,
        value: Any,
        key: Any,
        name: builtins.str,
        write: Callable[[], Any],
        constraint: tuple[int, int] | None = None,
        fixed: int | None = None,
        owner: Any = None,
    ) -> Placeable:
        """Places a pointer target."""
        p, new = self._placeable(value, key, name, constraint, fixed)
        if new:
            saved = self._begin_fill(p, value, owner)
            try:
                p.content = write()
            finally:
                self.b, self.index = saved
        return p

    async def target_async(
        self,
        value: Any,
        key: Any,
        name: builtins.str,
        write: Callable[[], Awaitable[Any]],
        constraint: tuple[int, int] | None = None,
        fixed: int | None = None,
        owner: Any = None,
    ) -> Placeable:
        p, new = self._placeable(value, key, name, constraint, fixed)
        if new:
            saved = self._begin_fill(p, value, owner)
            try:
                p.content = await write()
            finally:
                self.b, self.index = saved
        return p

    def place(
        self,
        name: builtins.str,
        value: Any,
        write: Callable[[], Any],
        constraint: tuple[int, int] | None = None,
        fixed: int | None = None,
        owner: Any = None,
    ) -> Placeable:
        """Places an ``at`` field's value (no identity sharing)."""
        p = Placeable(self.region.new_block(), name, constraint, fixed)
        saved = self._begin_fill(p, value, owner)
        try:
            p.content = write()
        finally:
            self.b, self.index = saved
        return p

    async def place_async(
        self,
        name: builtins.str,
        value: Any,
        write: Callable[[], Awaitable[Any]],
        constraint: tuple[int, int] | None = None,
        fixed: int | None = None,
        owner: Any = None,
    ) -> Placeable:
        p = Placeable(self.region.new_block(), name, constraint, fixed)
        saved = self._begin_fill(p, value, owner)
        try:
            p.content = await write()
        finally:
            self.b, self.index = saved
        return p

    def pointer(
        self,
        kind: builtins.str,
        le: builtins.bool,
        p: Placeable | None,
        relative: builtins.bool,
        null_value: int | None,
        origin: Callable[[], int] | None = None,
    ) -> None:
        """Writes an owned pointer: the offset of ``p`` (None -> ``null_value``)."""
        size = PRIMS[kind].size
        if p is None:
            if null_value is None:
                fail("INPUT", "None for a pointer that is not nullable")
            nv = null_value

            def run_null(out: bytearray, a: int) -> None:
                out[a : a + size] = pack_prim(kind, check_prim(nv, kind), le)

            self._fixup(size, 0, run_null)
            return
        target = p

        def run(out: bytearray, a: int) -> None:
            if target.block.pos < 0:
                fail("DERIVE", f"target {target.name} was not placed")
            o = origin() if origin is not None else 0
            pos = target.block.pos
            write_offset(out, a, kind, le, (pos - a if relative else pos) - o, null_value)

        self._fixup(size, 0, run)

    def ref_pointer(
        self,
        kind: builtins.str,
        le: builtins.bool,
        key: builtins.str,
        value: Any,
        encode: Callable[[], Any],
        relative: builtins.bool,
        null_value: int | None,
        origin: Callable[[], int] | None = None,
    ) -> None:
        """Writes a ``@ref`` pointer: resolved after layout to an equal placed value."""
        if value is None:
            self.pointer(kind, le, None, relative, null_value)
            return
        mark = self.mark()
        self.b.data += bytes(PRIMS[kind].size)
        is_obj = _shareable(value)
        self.region.ref_uses.append(
            RefUse(
                key=key,
                path=self.path(),
                value=value if is_obj else None,
                encode=encode if is_obj else None,
                encoding=None if is_obj else encode(),
                origin=origin,
                mark=mark,
                base=None,
                kind=kind,
                le=le,
                relative=relative,
                null_value=null_value,
            )
        )

    def ref_site(self, key: builtins.str, start: int, value: Any = None) -> None:
        """Registers an encoded value as a possible ``@ref`` target."""
        self.region.ref_sites.append(
            RefSite(key, self.b, start, len(self.b.data), value if _shareable(value) else None)
        )

    # ── regions ─────────────────────────────────────────────────────────────

    def _enter_region(
        self, layout: Sequence[Any] | None, value: Any, file_at: tuple[int, builtins.bool] | None = None
    ) -> Callable[[], None]:
        """Makes a nested region current; returns the function that leaves it."""
        from .layout import StickyPolicy

        region = Region(layout)
        if file_at is not None:
            region.file_origin, region.file_exact = file_at
        outer_sticky = self.region.sticky
        save_base = self.origin_base
        if outer_sticky is not None:
            # View commits: a nested base keeps its own original layout where it can.
            o = self.region_origin(value) if value is not None and self.region_origin is not None else None
            if o is not None:
                region.sticky = StickyPolicy(outer_sticky.grow, o[1], o[2])
                self.origin_base = o[0]
            else:
                region.sticky = StickyPolicy(outer_sticky.grow, None)
        save_b, save_r, save_index = self.b, self.region, self.index
        self.region = region
        self.b = region.root

        def leave() -> None:
            self.region = save_r
            self.b = save_b
            self.index = save_index
            self.origin_base = save_base

        return leave

    def sub_region(self, layout: Sequence[Any] | None, write: Callable[[], Any]) -> bytearray:
        """Encodes a nested region (a codec's decoded side, a standalone encoding)."""
        leave = self._enter_region(layout, None)
        region = self.region
        try:
            _attach(region, write())
            return region.finish()
        finally:
            leave()

    async def sub_region_async(self, layout: Sequence[Any] | None, write: Callable[[], Awaitable[Any]]) -> bytearray:
        leave = self._enter_region(layout, None)
        region = self.region
        try:
            _attach(region, await write())
            return region.finish()
        finally:
            leave()

    def encode_alone(self, write: Callable[[], Any]) -> bytearray:
        """Encodes a value standalone (its plain encoding as a fresh region)."""
        return self.sub_region(None, write)

    def base(self, layout: Sequence[Any] | None, write: Callable[[], Any], value: Any = None) -> None:
        """Writes a ``@base`` struct inline: its region is laid out on its own, then appended."""
        leave = self._enter_region(layout, value, self._file_position())
        region = self.region
        region.escalate = True
        try:
            region.attach_root(write())
            out = region.finish()
        finally:
            leave()
        self._place_base(region, out)

    async def base_async(self, layout: Sequence[Any] | None, write: Callable[[], Awaitable[Any]], value: Any = None) -> None:
        leave = self._enter_region(layout, value, self._file_position())
        region = self.region
        region.escalate = True
        try:
            region.attach_root(await write())
            out = region.finish()
        finally:
            leave()
        self._place_base(region, out)

    def _place_base(self, region: Region, out: bytearray) -> None:
        block = self.b
        at = len(block.data)
        if region.file_align > 1:
            # Alignments from the file start inside assumed this block starts at a multiple of
            # them (its position comes from layout).
            if block is not self.region.root and block.fixed_at is None:
                block.align = lcm(block.align, region.file_align)
            if not self.region.file_exact:
                self.region.file_align = lcm(self.region.file_align, region.file_align)
        self.raw(out)
        # `@ref`s the nested base could not resolve are resolved here, relative to its start.
        for u in region.unresolved:
            inner = u.base.block.pos + u.base.at if u.base is not None else 0
            self.region.ref_uses.append(
                dataclasses.replace(
                    u, mark=Mark(block, at + u.mark.block.pos + u.mark.at), base=Mark(block, at + inner)
                )
            )


def _attach(region: Region, entry: Any) -> None:
    """Sets the structure of a nested region from what its writer returned."""
    if isinstance(entry, LStruct):
        region.lroot = entry
    elif entry is not None:
        s = LStruct()
        s.set("$", entry)
        region.lroot = s
