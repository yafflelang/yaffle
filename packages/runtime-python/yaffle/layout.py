"""The layout engine (docs/IR.md §4): assigns every placeable of a base region a position.

- Default order: the base's own bytes first, then each placeable's unit in pre-order (a unit =
  the target's own bytes, then its own targets).
- ``layout { … }`` items of a struct order that struct's own targets: a path naming a placeable
  places its unit (minus anything already placed); a path naming inline data or ``[*]`` elements
  places the remaining units reachable from there; ``this`` places the struct's own bytes. Items in
  an outer struct run first, so they pull groups out of inner layouts.
- Item layers (``align``, ``padBefore``, ``padAfter``, ``alignEnd``) apply to every block an item
  places unless a nested item specifies its own. Placement constraints and alignment required by
  a block's content add to that.
- Fixed placements go exactly where they say; overlaps are OVERLAP errors and sequential
  placement flows around them.
- Sticky mode (view commits): placeables keep their original positions where possible.

Layout items are tuples ``(path, layers)`` where ``path`` is ``"this"`` or a tuple of field names
(``"*"`` for ``[*]``) and ``layers`` a tuple of ``(kind, n)`` pairs. A per-element group
(``volumes[*] { pieces[*]  portals[*].points }``) is ``(path, layers, items)``: for each element
of the array at ``path``, its ``items`` (relative to the element) are placed in order.

Layer arguments that read fields (``layout { data @align(align) }``) are evaluated by the owning
struct's writer, which then sets its ``LStruct.layout`` (checked by :func:`layout_align` and
:func:`layout_pad`); a root or base region takes such a layout from its root struct.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import gcd, lcm
from typing import Any, Callable, Iterable, Sequence

from .errors import fail
from .writer import LArray, LStruct, Placeable, Region

__all__ = ["layout_align", "layout_pad"]

#: ``(kind, n)``, or ``("align" | "alignEnd", n, offset, from_file)``.
LayoutLayer = tuple[Any, ...]
#: ``(path, layers)``, or ``(path, layers, group)`` for a per-element group.
LayoutItem = tuple[Any, ...]


@dataclass
class StickyPolicy:
    """How a view commit treats size changes ("default", "append", "splice" or "error")."""

    grow: str
    #: Size of the base's own bytes in the original (None: no original).
    orig_root_size: int | None
    #: Original size of the whole region.
    orig_size: int | None = None


def layout_align(n: Any) -> int:
    """A layout item's alignment, evaluated when its struct is written (it may read fields).
    Below 1 is a ``RANGE`` error."""
    if not isinstance(n, int) or isinstance(n, bool) or n < 1:
        fail("RANGE", f"invalid layout alignment {n}")
    return n


def layout_pad(n: Any) -> int:
    """A layout item's ``padBefore``/``padAfter`` count; negative is a ``RANGE`` error."""
    if not isinstance(n, int) or isinstance(n, bool) or n < 0:
        fail("RANGE", f"invalid layout padding {n}")
    return n


def _align_up(x: int, a: int) -> int:
    return x if a <= 1 else -(-x // a) * a


class _Range:
    __slots__ = ("start", "end", "name")

    def __init__(self, start: int, end: int, name: str) -> None:
        self.start = start
        self.end = end
        self.name = name


class Engine:
    def __init__(self, region: Region) -> None:
        self.region = region
        self.cursor = len(region.root.data)
        self.reserved: list[_Range] = []
        if region.root.data:
            self.reserved.append(_Range(0, len(region.root.data), "base"))
        #: Placeables claimed by a layout item of an enclosing container (placed only by it).
        self.claimed: set[int] = set()
        #: Placeables whose unit is being placed (cycles in the target graph).
        self.visiting: set[int] = set()
        self.on_place: Any = None

    def place_fixed(self, p: Placeable) -> None:
        start = p.fixed
        if not isinstance(start, int) or start < 0:
            fail("RANGE", f"invalid fixed offset {start} for {p.name}")
        end = start + len(p.block.data)
        if end > start:
            for r in self.reserved:
                if start < r.end and r.start < end:
                    fail(
                        "OVERLAP",
                        f"{p.name} at [0x{start:x}, 0x{end:x}) overlaps {r.name} at "
                        f"[0x{r.start:x}, 0x{r.end:x})",
                    )
            self.reserved.append(_Range(start, end, p.name))
        p.block.pos = start

    def find_pos(
        self, p: Placeable, align: int, start: int, congr: Sequence[tuple[int, int]] = ()
    ) -> int:
        """Smallest position >= start satisfying alignment, constraint and the extra congruences
        (``pos ≡ r mod m``: alignments from the file start or with an offset), avoiding fixed
        ranges."""
        size = len(p.block.data)
        pos = self.satisfy(p, align, start, congr)
        if size <= 0 or not self.reserved:
            return pos
        for _ in range(100000):
            hit = None
            for r in self.reserved:
                if pos < r.end and r.start < pos + size:
                    hit = r
                    break
            if hit is None:
                return pos
            pos = self.satisfy(p, align, hit.end, congr)
        fail("OVERLAP", f"no room for {p.name}")

    def satisfy(self, p: Placeable, align: int, start: int, congr: Sequence[tuple[int, int]] = ()) -> int:
        m, r = max(1, align), 0
        c = p.constraint
        for m2, r2 in ([(c[0], c[1])] if c is not None and c[0] > 1 else []) + list(congr):
            merged = _merge(m, r, m2, r2)
            if merged is None:
                fail("DERIVE", f"placement constraint ≡ {r2 % m2} (mod {m2}) cannot be met with alignment {align}")
            m, r = merged
        return start + (r - start) % m

    def place_block(self, p: Placeable, layers: Sequence[LayoutLayer]) -> None:
        if self.on_place is not None:
            self.on_place(p, layers)
        if p.block.pos >= 0:
            # Reaching a fixed placement moves the running position past it.
            if p.fixed is not None:
                self.cursor = max(self.cursor, p.block.pos + len(p.block.data))
            return
        align = p.block.align
        cursor = self.cursor
        congr: list[tuple[int, int]] = []
        for layer in layers:
            kind, n = layer[0], layer[1]
            if kind == "align":
                off, origin = self._origin(layer)
                if off == 0 and origin == 0:
                    align = lcm(align, n)
                else:
                    # (origin + pos + offset) % n == 0
                    congr.append((n, -(origin + off) % n))
            elif kind == "padBefore":
                cursor += n
        pos = self.find_pos(p, align, cursor, congr)
        p.block.pos = pos
        cursor = pos + len(p.block.data)
        for layer in layers:
            kind, n = layer[0], layer[1]
            if kind == "padAfter":
                cursor += n
            elif kind == "alignEnd":
                off, origin = self._origin(layer)
                cursor += (n - (origin + cursor + off) % n) % n
        if cursor > self.cursor:
            self.cursor = cursor

    def _origin(self, layer: Sequence[Any]) -> tuple[int, int]:
        """(offset, origin) of an align/alignEnd item layer: origin is the region's position in
        its byte space for ``from: file``, else 0 (the base)."""
        off = int(layer[2]) if len(layer) > 2 else 0
        file = bool(layer[3]) if len(layer) > 3 else False
        if not file:
            return off, 0
        region = self.region
        if not region.file_exact:
            region.file_align = lcm(region.file_align, int(layer[1]))
        return off, region.file_origin

    def place_unit(self, p: Placeable, layers: Sequence[LayoutLayer]) -> None:
        k = id(p)
        if k in self.visiting:
            self.place_block(p, layers)
            return
        self.visiting.add(k)
        try:
            c = p.content
            if isinstance(c, LStruct):
                self.process_struct(c, c.layout, p, layers)
            else:
                self.place_block(p, layers)
                if c is not None:
                    self.place_remaining(c, layers)
        finally:
            self.visiting.discard(k)

    def place_remaining(self, e: Any, layers: Sequence[LayoutLayer]) -> None:
        if isinstance(e, Placeable):
            # A placeable claimed by a container's item is placed by that item only.
            if id(e) not in self.claimed:
                self.place_unit(e, layers)
        elif isinstance(e, LArray):
            for it in e.items:
                if it is not None:
                    self.place_remaining(it, layers)
        else:
            self.process_struct(e, e.layout, None, layers)

    def process_struct(
        self,
        s: LStruct,
        items: Sequence[LayoutItem] | None,
        self_p: Placeable | None,
        inherited: Sequence[LayoutLayer],
    ) -> None:
        if items:
            # Claim every placeable an item names, so no other unit places it first.
            mine: list[Placeable] = []
            mine_ids: set[int] = set()
            self._claim(s, items, mine, mine_ids)
            has_this = any(item[0] == "this" for item in items)
            if self_p is not None and not has_this:
                self.place_block(self_p, inherited)
            for item in items:
                self._place_item(s, item, inherited, mine_ids, self_p)
            for p in mine:
                self.claimed.discard(id(p))
            if self_p is not None:
                self.place_block(self_p, inherited)
        elif self_p is not None:
            self.place_block(self_p, inherited)
        for e in list(s.fields.values()):
            self.place_remaining(e, inherited)

    def _claim(self, s: Any, items: Sequence[LayoutItem], mine: list[Placeable], mine_ids: set[int]) -> None:
        for item in items:
            path = item[0]
            if path == "this":
                continue
            reached = resolve_path(s, path)
            group = _group(item)
            if group is not None:
                # A per-element group claims what its nested items name in every element.
                for el in _elements(reached):
                    self._claim(el, group, mine, mine_ids)
                continue
            for e in reached:
                if isinstance(e, Placeable) and id(e) not in self.claimed and e.block.pos < 0:
                    self.claimed.add(id(e))
                    mine.append(e)
                    mine_ids.add(id(e))

    def _place_item(
        self,
        s: Any,
        item: LayoutItem,
        inherited: Sequence[LayoutLayer],
        mine_ids: set[int],
        self_p: Placeable | None,
    ) -> None:
        path, item_layers = item[0], item[1]
        layers = item_layers if item_layers else inherited
        if path == "this":
            if self_p is not None:
                self.place_block(self_p, layers)
            return
        reached = resolve_path(s, path)
        group = _group(item)
        if group is not None:
            # For each element, its items in order. An element that is itself a target comes
            # first, like `this` in a unit, unless an item names `this`. What the items don't name
            # is left over (default order, after the container's items).
            names_this = any(g[0] == "this" for g in group)
            for el in _elements(reached):
                el_p = el if isinstance(el, Placeable) else None
                if el_p is not None and not names_this:
                    self.place_block(el_p, layers)
                for sub in group:
                    self._place_item(el, sub, layers, mine_ids, el_p)
            return
        for e in reached:
            if isinstance(e, Placeable):
                if id(e) in mine_ids:
                    self.claimed.discard(id(e))
                    self.place_unit(e, layers)
                elif id(e) not in self.claimed:
                    self.place_unit(e, layers)
            else:
                self.place_remaining(e, layers)


def _merge(m1: int, r1: int, m2: int, r2: int) -> tuple[int, int] | None:
    """Combines ``x ≡ r1 (mod m1)`` and ``x ≡ r2 (mod m2)``; None if they are incompatible."""
    r1 %= m1
    r2 %= m2
    step = m2 // gcd(m1, m2)
    for k in range(step):
        x = r1 + k * m1
        if x % m2 == r2:
            m = m1 * step
            return m, x % m
    return None


def _group(item: LayoutItem) -> Sequence[LayoutItem] | None:
    """The nested items of a per-element layout group, if ``item`` is one."""
    g = item[2] if len(item) > 2 else None
    return g if g else None


def _elements(entries: Sequence[Any]) -> list[Any]:
    """The elements of the arrays a group's path reaches (inline, or through pointer targets)."""
    out: list[Any] = []
    for e in entries:
        if isinstance(e, Placeable):
            if e.content is None:
                continue
            e = e.content
        if isinstance(e, LArray):
            out.extend(it for it in e.items if it is not None)
    return out


def resolve_path(s: Any, path: Iterable[str]) -> list[Any]:
    """Entries a layout path reaches from struct ``s`` (through placeables' contents)."""
    cur: list[Any] = [s]
    for seg in path:
        nxt: list[Any] = []
        for e in cur:
            if isinstance(e, Placeable):
                if e.content is None:
                    continue
                e = e.content
            if seg == "*":
                if isinstance(e, LArray):
                    nxt.extend(it for it in e.items if it is not None)
            elif isinstance(e, LStruct):
                f = e.fields.get(seg)
                if f is not None:
                    nxt.append(f)
        cur = nxt
    return cur


def _run_default(region: Region, engine: Engine) -> None:
    if region.lroot is not None:
        engine.process_struct(region.lroot, region.layout, None, ())
    for p in region.placeables:
        if p.block.pos < 0:
            engine.place_unit(p, ())


def layout_region(region: Region) -> None:
    """Assigns positions to every block of the region."""
    sticky = region.sticky
    if sticky is not None and sticky.orig_root_size is not None:
        _sticky_layout(region, sticky)
    else:
        _run_default(region, _unplaced(region))


def _unplaced(region: Region) -> Engine:
    """An engine over the region with every block unplaced except the fixed ones."""
    for p in region.placeables:
        p.block.pos = -1
    engine = Engine(region)
    for p in region.placeables:
        if p.fixed is not None:
            engine.place_fixed(p)
    return engine


def _observe_default(
    region: Region,
    start: Callable[[Placeable], int],
    note: Callable[[Placeable, Sequence[LayoutLayer]], None],
) -> None:
    """Runs the default layout from the positions ``start`` gives, calling ``note`` for every
    block it places, then restores the positions."""
    saved = [p.block.pos for p in region.placeables]
    for p in region.placeables:
        p.block.pos = start(p)
    engine = Engine(region)
    engine.on_place = note
    _run_default(region, engine)
    for p, pos in zip(region.placeables, saved):
        p.block.pos = pos


def _default_order(region: Region) -> list[Placeable]:
    """Default placement order of every placeable (sticky mode places new ones in this order)."""
    order: dict[int, Placeable] = {}

    def note(p: Placeable, layers: Sequence[LayoutLayer]) -> None:
        order.setdefault(id(p), p)

    _observe_default(region, lambda p: 0 if p.fixed is not None else p.block.pos, note)
    return list(order.values())


def _item_alignments(region: Region) -> dict[int, int]:
    """The alignment items give each placeable in default layout (re-alignment when shifting)."""
    out: dict[int, int] = {}

    def note(p: Placeable, layers: Sequence[LayoutLayer]) -> None:
        if id(p) not in out:
            a = p.block.align
            for layer in layers:
                if layer[0] == "align" and len(layer) <= 2:
                    a = lcm(a, layer[1])
            out[id(p)] = a

    _observe_default(region, lambda p: p.fixed if p.fixed is not None else -1, note)
    return out


def _fits(p: Placeable, align: int, pos: int) -> bool:
    if align > 1 and pos % align:
        return False
    c = p.constraint
    if c is not None and c[0] > 1 and pos % c[0] != c[1] % c[0]:
        return False
    return True


def _sticky_layout(region: Region, policy: StickyPolicy) -> None:
    aligns = _item_alignments(region)
    order = _default_order(region)
    engine = _unplaced(region)
    orig_root = policy.orig_root_size
    assert orig_root is not None
    root_size = len(region.root.data)
    if policy.grow == "error" and root_size != orig_root:
        fail("DERIVE", f'the base grew from {orig_root} to {root_size} bytes (grow: "error")')
    old = sorted(
        (p for p in region.placeables if p.orig is not None and p.fixed is None),
        key=lambda p: p.orig,  # type: ignore[arg-type, return-value]
    )
    orig_cursor = orig_root
    orig_end = policy.orig_size if policy.orig_size is not None else orig_root
    for p in old:
        assert p.orig is not None
        orig_end = max(orig_end, p.orig + (p.orig_size or 0))
    for p in old:
        assert p.orig is not None
        size = len(p.block.data)
        orig_size = p.orig_size if p.orig_size is not None else size
        grows = size > orig_size
        if policy.grow == "error" and size != orig_size:
            fail("DERIVE", f'{p.name} changed size from {orig_size} to {size} (grow: "error")')
        align = aligns.get(id(p), p.block.align)
        if grows and policy.grow in ("default", "append"):
            # Left unplaced: appended after the original extent below.
            orig_cursor = max(orig_cursor, p.orig + orig_size)
            continue
        extra = max(0, p.orig - _align_up(orig_cursor, align))
        keep = _fits(p, align, p.orig)
        if policy.grow == "splice":
            pos = (
                p.orig
                if engine.cursor == orig_cursor and keep
                else engine.find_pos(p, align, engine.cursor + extra)
            )
        elif engine.cursor <= p.orig and keep:
            pos = p.orig
            if any(pos < r.end and r.start < pos + size for r in engine.reserved):
                pos = engine.find_pos(p, align, pos)
        elif policy.grow == "append" or not keep:
            orig_cursor = max(orig_cursor, p.orig + orig_size)
            continue
        else:
            pos = engine.find_pos(p, align, engine.cursor + extra)
        p.block.pos = pos
        engine.cursor = max(engine.cursor, pos + size)
        orig_cursor = max(orig_cursor, p.orig + orig_size)
    if policy.grow != "splice":
        engine.cursor = max(engine.cursor, orig_end)
    for p in order:
        if p.block.pos >= 0:
            continue
        p.block.pos = engine.find_pos(p, aligns.get(id(p), p.block.align), engine.cursor)
        engine.cursor = p.block.pos + len(p.block.data)
    for p in region.placeables:
        if p.block.pos < 0:
            p.block.pos = engine.find_pos(p, p.block.align, engine.cursor)
            engine.cursor = p.block.pos + len(p.block.data)
