"""``_commit`` / ``_patches`` for views.

- **Fast path:** only same-size scalar edits that no derived value depends on: the in-place
  patches are the result. Nothing else is read or re-encoded.
- **Slow path:** structural edits (or edits inside codec regions, streams, or under checksums).
  The root is re-serialized by the generated writer with the view as its input value: unchanged
  byte values keep their provenance, codec regions whose content did not change reuse their
  encoded bytes, and the layout is *sticky*: placeables keep their original positions where the
  grow policy allows (layout.py). The result is diffed against the original bytes into patches.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Sequence

from .errors import fail
from .layout import StickyPolicy
from .view import Patch, StructNode, ViewRoot, node_of
from .writer import Region, Writer

__all__ = ["apply_patches"]

GROW_POLICIES = ("default", "append", "splice", "error")


@dataclass
class CommitPlan:
    patches: list[Patch]
    #: The full new bytes (computed on demand: the fast path does not touch the rest).
    bytes: Callable[[], bytes]


def _fast_path_ok(root: ViewRoot) -> bool:
    if root.structural:
        return False
    if any(sp.patches for sp in root.regions.values()) or any(sp.patches for sp in root.streams):
        return False
    # An edit inside an inline child can change a derived value of an ancestor.
    for _at, _data, node in root.space.patches:
        n = node.ctx.parent if node is not None else None
        while n is not None:
            if not n.info.child_safe:
                return False
            n = n.ctx.parent
    return True


def _in_place_patches(root: ViewRoot) -> list[Patch]:
    """Merges in-place patches into sorted, non-overlapping replacements."""
    space = root.space
    merged: list[list[int]] = []
    for a, b in sorted((at, at + len(d)) for at, d, _ in space.patches):
        if merged and a <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return [Patch(a, b - a, space.get(a, b - a)) for a, b in merged]


def apply_patches(orig: Any, patches: Sequence[Patch]) -> bytes:
    """Applies patches (sorted by ``at``, non-overlapping, in original coordinates)."""
    out = bytearray()
    o = 0
    for p in patches:
        out += orig[o : p.at]
        out += p.insert
        o = p.at + p.remove
    out += orig[o:]
    return bytes(out)


def diff(orig: Any, out: Any, anchors: Sequence[tuple[int, int, int]]) -> list[Patch]:
    """Patches turning ``orig`` into ``out``.

    ``anchors`` are ``(new offset, original offset, length)`` ranges known to be copied unchanged
    from the original (provenance); between them the bytes are compared.
    """
    chain: list[tuple[int, int, int]] = []
    last_o = last_n = 0
    for n_at, o_at, ln in sorted((a for a in anchors if a[2] > 0), key=lambda a: a[0]):
        if o_at >= last_o and n_at >= last_n:
            chain.append((n_at, o_at, ln))
            last_o, last_n = o_at + ln, n_at + ln
    patches: list[Patch] = []
    n = o = 0
    for n_at, o_at, ln in chain:
        patches += _segment(orig, out, n, n_at, o, o_at)
        n, o = n_at + ln, o_at + ln
    patches += _segment(orig, out, n, len(out), o, len(orig))
    return [p for p in patches if p.remove > 0 or p.insert]


def _segment(orig: Any, out: Any, n0: int, n1: int, o0: int, o1: int) -> list[Patch]:
    """Patches turning ``orig[o0:o1]`` into ``out[n0:n1]``."""
    nl, ol = n1 - n0, o1 - o0
    if nl != ol:
        # One replacement between the common prefix and suffix.
        p = 0
        while p < nl and p < ol and out[n0 + p] == orig[o0 + p]:
            p += 1
        s = 0
        while s < nl - p and s < ol - p and out[n1 - 1 - s] == orig[o1 - 1 - s]:
            s += 1
        return [Patch(o0 + p, ol - p - s, bytes(out[n0 + p : n1 - s]))]
    if out[n0:n1] == orig[o0:o1]:
        return []
    # The differing runs; gaps under 8 equal bytes are merged.
    patches: list[Patch] = []
    i = 0
    while i < nl:
        if out[n0 + i] == orig[o0 + i]:
            i += 1
            continue
        j = i + 1
        same = 0
        while j < nl and same < 8:
            same = same + 1 if out[n0 + j] == orig[o0 + j] else 0
            j += 1
        end = j - same
        patches.append(Patch(o0 + i, end - i, bytes(out[n0 + i : n0 + end])))
        i = j
    return patches


def fast_plan(root: ViewRoot) -> CommitPlan | None:
    """The commit of a view with only in-place edits (None if it needs the slow path)."""
    if not _fast_path_ok(root):
        return None
    patches = _in_place_patches(root)
    orig = root.space.orig
    return CommitPlan(patches, lambda: apply_patches(orig, patches))


def _writer(root: ViewRoot, grow: str) -> tuple[Region, Writer]:
    """A writer over a fresh root region, wired to the view's provenance (sticky layout)."""
    space = root.space
    root_node = root.root_node
    root_node.ensure_scanned()
    region = Region(root.spec.layout)
    region.sticky = StickyPolicy(grow, root_node.inline_end - root_node.pos, space.size)
    w = Writer(region)

    def slot_origin(owner: Any, name: str) -> tuple[int, int] | None:
        n = node_of(owner)
        if not isinstance(n, StructNode) or n.space is not space:
            return None
        attr = next((a for a, fi in n.info.fields.items() if fi.name == name), name)
        return n.original_target(attr)

    def region_origin(value: Any) -> tuple[int, int, int] | None:
        n = node_of(value)
        if not isinstance(n, StructNode) or n.space is not space or n.materialized is not None:
            return None
        n.ensure_scanned()
        return n.pos, n.inline_end - n.pos, n.size

    def provenance(v: Any) -> tuple[Any, int] | None:
        o = root.bytes_origin(v)
        return o if o is not None and o[0] is space else None

    w.origin = lambda value: root.original_place(value, space)
    w.slot_origin = slot_origin
    w.region_origin = region_origin
    w.provenance = provenance
    return region, w


def _finish(root: ViewRoot, region: Region, entry: Any, grow: str) -> CommitPlan:
    space = root.space
    region.attach_root(entry)
    out = region.finish()
    anchors = [(at, prov[1], ln) for at, ln, prov in region.provenance if prov[0] is space]
    orig = space.orig if isinstance(space.orig, (bytes, bytearray)) or space.store is None else space.original()
    patches = diff(orig, out, anchors)
    if grow == "error" and len(out) != space.size:
        fail("DERIVE", f'the data changed size from {space.size} to {len(out)} bytes (grow: "error")')
    data = bytes(out)
    return CommitPlan(patches, lambda: data)


def _check_grow(grow: str) -> None:
    if grow not in GROW_POLICIES:
        fail("INPUT", f"grow must be one of {', '.join(GROW_POLICIES)}, got {grow!r}")


def plan(root: ViewRoot, grow: str = "default") -> CommitPlan:
    """Computes the commit of a view."""
    _check_grow(grow)
    fp = fast_plan(root)
    if fp is not None:
        return fp
    if root.spec.write is None:
        fail("INPUT", "this view is async: use `await view._commit()`")
    region, w = _writer(root, grow)
    return _finish(root, region, root.spec.write(w, root.view), grow)


async def plan_async(root: ViewRoot, grow: str = "default") -> CommitPlan:
    """:func:`plan` for async views (async roots re-encode with the async writer)."""
    _check_grow(grow)
    fp = fast_plan(root)
    if fp is not None:
        return fp
    region, w = _writer(root, grow)
    if root.spec.write_async is not None:
        entry = await root.spec.write_async(w, root.view)
    elif root.spec.write is not None:
        entry = root.spec.write(w, root.view)
    else:
        fail("INPUT", "this view has no writer")
    return _finish(root, region, entry, grow)
