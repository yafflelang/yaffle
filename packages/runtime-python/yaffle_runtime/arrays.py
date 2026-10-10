"""Array builtins and value equality (docs/IR.md §6).

Aggregates (``sum``, ``min``, ``max``, ``lengths``, indexing, ``indexOf``), derived arrays
(``map``, ``filter``, ``indicesWhere``, ``sortedBy``, ``unique``, ``concat``) and ``==``/``!=`` on
arrays, strings, bytes and structs: arrays compare element-wise, structs by canonical JSON.
Generated code passes a *canonicalizer* (``canon``) for element values whose plain Python equality
differs from canonical-JSON equality: structs (their ``to_json``), floats (NaN equals NaN, -0
differs from 0) and arrays of those.
"""

from __future__ import annotations

import math
from typing import Any, Callable, Sequence

from .errors import YaffleError, describe, fail

__all__ = [
    "as_bytes", "at", "canonical", "concat_of", "equal", "equals", "filter_of", "index_of",
    "indices_where", "lengths", "map_of", "max_of", "min_of", "sorted_by", "sum_of", "unique_of",
]  # fmt: skip

Canon = Callable[[Any], Any] | None

_BYTES = (bytes, bytearray, memoryview)


def _indexable(arr: Any) -> Sequence[Any]:
    """An array for aggregates: anything with a length and items (views included)."""
    if isinstance(arr, (list, tuple, bytes, bytearray)):
        return arr
    if hasattr(arr, "__len__") and hasattr(arr, "__getitem__"):
        return arr  # type: ignore[no-any-return]
    fail("INPUT", f"expected an array, got {describe(arr)}")


def _elements(arr: Any) -> Sequence[Any]:
    """An array for derived arrays: a list, tuple or bytes (views are copied into a list)."""
    if isinstance(arr, (list, tuple)) or isinstance(arr, _BYTES):
        return arr
    if arr is not None and not isinstance(arr, (str, dict)) and hasattr(arr, "__len__") and hasattr(arr, "__getitem__"):
        return list(arr)
    fail("INPUT", f"expected an array, got {describe(arr)}")


# ── aggregates and indexing ────────────────────────────────────────────────────


def sum_of(arr: Any) -> Any:
    """Sum of an array of numbers (0 for an empty array)."""
    return sum(_indexable(arr))


def min_of(arr: Any) -> Any:
    a = _indexable(arr)
    if not len(a):
        fail("RANGE", "min of an empty array")
    return min(a)


def max_of(arr: Any) -> Any:
    a = _indexable(arr)
    if not len(a):
        fail("RANGE", "max of an empty array")
    return max(a)


def lengths(arr: Any) -> list[int]:
    """The length of each element of an array of arrays (None counts as empty)."""
    return [0 if x is None else len(_indexable(x)) for x in _indexable(arr)]


def at(arr: Any, i: int) -> Any:
    """Array or bytes index with a bounds check."""
    if i < 0 or i >= len(arr):
        fail("RANGE", f"index {i} is out of bounds (length {len(arr)})")
    return arr[i]


def index_of(arr: Sequence[Any], v: Any) -> int:
    """``indexOf(array, value)`` inverse lookup: a missing value is an INPUT error on write."""
    for i, x in enumerate(arr):
        if equals(x, v):
            return i
    fail("INPUT", f"value {describe(v)} is not in the table")


def equals(a: Any, b: Any) -> bool:
    """Structural equality of values (table lookups, virtual fields reading back): numbers by
    value (NaN equals NaN), bools only with bools, sequences element-wise, objects field-wise."""
    if a is b:
        return True
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if isinstance(a, float) and isinstance(b, float) and math.isnan(a) and math.isnan(b):
            return True
        return a == b
    if isinstance(a, _BYTES) and isinstance(b, _BYTES):
        return bytes(a) == bytes(b)
    if isinstance(a, str) or isinstance(b, str):
        return isinstance(a, str) and isinstance(b, str) and a == b
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        return len(a) == len(b) and all(equals(x, y) for x, y in zip(a, b))
    da = getattr(a, "__dict__", None)
    db = getattr(b, "__dict__", None)
    if da is not None and db is not None:
        # Side data (raw values, hidden pieces) is not part of the value.
        ka = [k for k in da if not k.startswith("_yfl")]
        kb = [k for k in db if not k.startswith("_yfl")]
        return sorted(ka) == sorted(kb) and all(equals(da[k], db[k]) for k in ka)
    eq: bool = a == b
    return eq


# ── derived arrays ─────────────────────────────────────────────────────────────


def map_of(arr: Any, fn: Callable[[Any], Any]) -> list[Any]:
    """``map(array, x => expr)``."""
    return [fn(x) for x in _elements(arr)]


def filter_of(arr: Any, fn: Callable[[Any], Any]) -> Any:
    """``filter(array, x => bool)`` (bytes stay bytes)."""
    a = _elements(arr)
    out = [x for x in a if fn(x)]
    return bytes(out) if isinstance(a, _BYTES) else out


def indices_where(arr: Any, fn: Callable[[Any], Any]) -> list[int]:
    """``indicesWhere(array, x => bool)``: the indices of the elements for which it holds."""
    return [i for i, x in enumerate(_elements(arr)) if fn(x)]


def _sort_key(v: Any) -> Any:
    if isinstance(v, bool):
        return (0, int(v))
    if isinstance(v, (int, float)):
        return (0, v)
    if isinstance(v, str):
        return (1, v)
    if isinstance(v, _BYTES):
        return (2, bytes(v))
    fail("INPUT", f"sortedBy: cannot compare {describe(v)} (keys must be numbers, strings or bytes)")


def sorted_by(arr: Any, fn: Callable[[Any], Any]) -> Any:
    """``sortedBy(array, x => key)``: a stable sort; keys compare as numbers, strings by code
    points, bytes lexicographically (bytes stay bytes)."""
    a = _elements(arr)
    out = sorted(a, key=lambda x: _sort_key(fn(x)))
    return bytes(out) if isinstance(a, _BYTES) else out


def canonical(v: Any, canon: Canon = None) -> Any:
    """A hashable form of ``v`` whose Python equality is canonical-JSON equality."""
    if isinstance(v, _BYTES):
        return ("b", bytes(v))
    if isinstance(v, (list, tuple)) or (
        v is not None
        and not isinstance(v, (str, int, float, dict))
        and hasattr(v, "__len__")
        and hasattr(v, "__getitem__")
        and not hasattr(v, "__dataclass_fields__")
    ):
        items = list(v)
        if canon is None and all(
            isinstance(x, int) and not isinstance(x, bool) and 0 <= x <= 255 for x in items
        ):
            # A list of byte values equals the same bytes (u8 arrays are bytes).
            return ("b", bytes(items))
        return ("a", tuple(canonical(x, canon) for x in items))
    if v is None:
        return None
    if canon is not None:
        return _freeze(canon(v))
    if isinstance(v, bool):
        return ("bool", v)
    return v


def _freeze(j: Any) -> Any:
    """Canonical JSON as a hashable value."""
    if isinstance(j, dict):
        return ("o", tuple((k, _freeze(x)) for k, x in j.items()))
    if isinstance(j, list):
        return ("a", tuple(_freeze(x) for x in j))
    if isinstance(j, bool):
        return ("bool", j)
    return j


def equal(a: Any, b: Any, canon: Canon = None) -> bool:
    """``a == b`` on composite values (canonical-JSON equality)."""
    if isinstance(a, _BYTES) and isinstance(b, _BYTES):
        return bytes(a) == bytes(b)
    if isinstance(a, str) or isinstance(b, str):
        return isinstance(a, str) and isinstance(b, str) and a == b
    try:
        eq: bool = canonical(a, canon) == canonical(b, canon)
    except YaffleError:
        return False
    return eq


def unique_of(arr: Any, canon: Canon = None) -> Any:
    """``unique(array)``: later duplicates removed (first occurrence kept; value equality)."""
    a = _elements(arr)
    seen: set[Any] = set()
    out: list[Any] = []
    for x in a:
        k = canonical(x, canon)
        try:
            if k in seen:
                continue
            seen.add(k)
        except TypeError:  # an unhashable value (a union value without a canonicalizer)
            if any(equal(x, y, canon) for y in out):
                continue
        out.append(x)
    return bytes(out) if isinstance(a, _BYTES) else out


def concat_of(*arrs: Any) -> Any:
    """``concat(a, b, …)``: arrays joined in order (all bytes: bytes)."""
    seqs = [_elements(a) for a in arrs]
    if seqs and all(isinstance(s, _BYTES) for s in seqs):
        return b"".join(bytes(s) for s in seqs)
    return [x for s in seqs for x in s]


def as_bytes(v: Any) -> Any:
    """A derived array written to a ``u8`` array field: its bytes."""
    if isinstance(v, (list, tuple)):
        for x in v:
            if isinstance(x, bool) or not isinstance(x, int):
                fail("INPUT", f"expected a byte value, got {describe(x)}")
            if not 0 <= x <= 255:
                fail("RANGE", f"{x} does not fit in u8")
        return bytes(v)
    return v
