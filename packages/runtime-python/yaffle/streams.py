"""Streams (``T x from …``) outside views: joining pieces and slicing on read, and on
write handing the encoded stream back to the fields it comes from (pieces of array elements, or
slice carriers)."""

from __future__ import annotations

import copy
from typing import Any, Callable, Sequence

from .errors import YaffleError, describe, fail
from .jsonc import field_value
from .values import array_value

__all__ = ["assemble_slices", "join_stream", "pieces", "slice_stream", "split_by_sizes", "split_stream"]

# ── read side ──────────────────────────────────────────────────────────────────


def pieces(arr: Any, field: str) -> list[bytes]:
    """The pieces of a joined stream: each element's ``field`` (hidden or not)."""
    from .view import force

    out: list[bytes] = []
    for i, e in enumerate(arr):
        v = force(field_value(e, field))
        if not isinstance(v, (bytes, bytearray, memoryview)):
            fail("INPUT", f"stream piece {i} has no bytes in {field}")
        out.append(bytes(v))
    return out


def join_stream(pieces: Sequence[bytes]) -> bytes:
    return bytes(pieces[0]) if len(pieces) == 1 else b"".join(pieces)


def slice_stream(s: bytes, start: int, end: int | None = None) -> bytes:
    """``raw[a..b]`` (end exclusive; omitted: to the end)."""
    e = len(s) if end is None else end
    if start < 0 or e > len(s) or start > e:
        fail("EOF", f"stream slice [{start}, {e}) is outside the stream of {len(s)} bytes")
    return s[start:e]


# ── write side ─────────────────────────────────────────────────────────────────


def split_by_sizes(data: bytes, sizes: Sequence[int]) -> list[bytes]:
    """Splits a joined stream into pieces of the given sizes (they must cover it exactly)."""
    out: list[bytes] = []
    at = 0
    for n in sizes:
        if at + n > len(data):
            fail("DERIVE", f"piece sizes exceed the stream length {len(data)}")
        out.append(data[at : at + n])
        at += n
    if at != len(data):
        fail("DERIVE", f"piece sizes cover {at} of {len(data)} stream bytes")
    return out


def _piece_size(v: Any) -> int:
    """A piece's size field given in the input."""
    if isinstance(v, int) and not isinstance(v, bool) and v >= 0:
        return int(v)
    fail("INPUT", 'split policy "sizes" needs every piece\'s size in the input')


def _with_field(e: Any, attr: str, value: Any) -> Any:
    """A shallow copy of a struct value with one field (hidden or not) replaced."""
    if e is None or isinstance(e, (bool, int, float, str, bytes, list, dict)):
        fail("INPUT", f"expected an object, got {describe(e)}")
    from .view import StructNode, Values, force, node_of

    n = node_of(e)
    if isinstance(n, StructNode):
        # A struct view: its fields (and hidden values) as a plain object.
        plain = Values()
        for k in n.keys():
            plain.__dict__[k] = n.get(k)
        hidden = getattr(e, "_yfl_hidden", None)
        if hidden:
            plain.__dict__["_yfl_hidden"] = {k: force(x) for k, x in hidden.items()}
        e = plain
    c = copy.copy(e)
    d = getattr(c, "__dict__", None)
    h = d.get("_yfl_hidden") if d is not None else None
    if h is not None and attr in h:
        d["_yfl_hidden"] = {**h, attr: value}  # type: ignore[index]
    else:
        setattr(c, attr, value)
    return c


def _with_piece(e: Any, attr: str, piece: bytes) -> Any:
    """``e`` with its piece replaced. A piece equal to the element's original value keeps that
    object, so codec reuse still recognizes it."""
    orig = field_value(e, attr)
    same = isinstance(orig, (bytes, bytearray)) and orig == piece
    return _with_field(e, attr, orig if same else piece)


def split_stream(
    elements: Any,
    attr: str,
    data: bytes,
    size_attr: str | None,
    fit: tuple[Callable[[int], int], Callable[[Any], int]] | None,
    make: Callable[[], Any],
) -> list[Any]:
    """Write side of ``T x from arr[*].field``: the encoded stream split into the elements.

    Piece sizes given in the input (``size_attr`` of every element) win; otherwise the ``fit``
    policy picks, for element k, the longest piece whose encoded element fits before element
    k+1's offset (the elements may then be omitted from the input). ``make`` creates an element
    for pieces beyond the given ones.
    """
    els = None if elements is None else array_value(elements)
    if els is not None and size_attr is not None:
        given = [getattr(e, size_attr, None) for e in els]
        if fit is None or (els and all(v is not None for v in given)):
            parts = split_by_sizes(data, [_piece_size(v) for v in given])
            return [_with_piece(e, attr, p) for e, p in zip(els, parts)]
    if fit is None:
        fail("INPUT", "cannot split the stream: give every piece's size in the input")
    offset_of, size_of = fit
    out: list[Any] = []
    pos = 0
    k = 0
    while pos < len(data):
        base = copy.copy(els[k]) if els is not None and k < len(els) else make()
        if size_attr is not None:
            setattr(base, size_attr, None)
        cap = offset_of(k + 1) - offset_of(k)
        left = len(data) - pos

        def fits(n: int, base: Any = base, pos: int = pos) -> bool:
            try:
                return size_of(_with_field(base, attr, data[pos : pos + n])) <= cap
            except YaffleError as e:
                if e.code == "RANGE":
                    return False
                raise

        n = left if fits(left) else _longest_fit(fits, left)
        if n == 0:
            fail("OVERLAP", f"stream piece {k} does not fit its block of {cap} bytes")
        out.append(_with_piece(base, attr, data[pos : pos + n]))
        pos += n
        k += 1
    return out


def _longest_fit(fits: Callable[[int], bool], hi: int) -> int:
    """The largest n below ``hi`` with ``fits(n)`` (0 if none), by binary search."""
    lo = 0
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if fits(mid):
            lo = mid
        else:
            hi = mid
    return lo


def assemble_slices(n: int | None, parts: Sequence[tuple[int, int | None, Any]]) -> bytes:
    """Write side of a slice carrier: ``n`` zero bytes (for ``[]`` lengths: up to the largest
    slice end) with every slice's encoding at its start. Overlapping slices must agree, and an
    encoding must fit its slice (DERIVE otherwise)."""
    if n is None:
        n = max([0, *(end if end is not None else start + len(enc) for start, end, enc in parts)])
    out = bytearray(n)
    owner: list[int] = [-1] * n if len(parts) > 1 else []
    for k, (start, end, enc) in enumerate(parts):
        stop = n if end is None else end
        if not isinstance(start, int) or start < 0 or stop > n or start > stop:
            fail("DERIVE", f"slice [{start}, {stop}) is outside the {n} bytes it is part of")
        if len(enc) > stop - start:
            fail("DERIVE", f"an encoding of {len(enc)} bytes does not fit its slice [{start}, {stop})")
        data = bytes(enc)
        if owner:
            for i, byte in enumerate(data):
                at = start + i
                if owner[at] >= 0 and out[at] != byte:
                    fail("DERIVE", f"overlapping slices disagree at byte {at}")
                owner[at] = k
        out[start : start + len(data)] = data
    return bytes(out)
