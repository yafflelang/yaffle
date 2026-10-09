"""Canonical JSON helpers (docs/CONFORMANCE.md §3).

Bytes are lowercase hex, 56/64-bit integers decimal strings, non-finite floats and -0 strings, and
shared targets JSON-Pointer ``$ref``s. Also the per-object side data that canonical JSON needs: the
raw values of one-way transforms and the values of ``@hidden`` stream pieces.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any, Callable, Mapping

from .errors import YaffleError, describe, fail

__all__ = [
    "FromJsonCtx", "ToJsonCtx", "Variant", "big_from_json", "bool_from_json", "enum_from_json",
    "enum_of", "enum_to_json", "field_value", "first_of", "float_from_json", "float_to_json",
    "from_hex", "get_raw", "has_field", "int_from_json", "object_from_json", "ptr", "set_hidden",
    "set_raw", "string_from_json", "to_hex", "union_from_json", "union_to_json",
]  # fmt: skip

_SPACE = re.compile(r"\s+")
_HEX = re.compile(r"[0-9a-fA-F]*")
_DEC = re.compile(r"-?[0-9]+")


@dataclass
class Variant:
    """A union value: the variant's name and its value (``{ "type", "value" }`` in JSON)."""

    type: str
    value: Any


def to_hex(b: Any) -> str:
    return bytes(b).hex()


def from_hex(s: str) -> bytes:
    clean = _SPACE.sub("", s)
    if len(clean) % 2 or not _HEX.fullmatch(clean):
        fail("INPUT", f"invalid hex string {describe(s)}")
    return bytes.fromhex(clean)


def float_to_json(x: float) -> float | str:
    if math.isnan(x):
        return "NaN"
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    if x == 0 and math.copysign(1.0, x) < 0:
        return "-0"
    return float(x)


_SPECIAL_FLOATS = {"NaN": math.nan, "Infinity": math.inf, "-Infinity": -math.inf, "-0": -0.0}


def float_from_json(j: Any) -> float:
    if isinstance(j, (int, float)) and not isinstance(j, bool):
        return float(j)
    if isinstance(j, str) and j in _SPECIAL_FLOATS:
        return _SPECIAL_FLOATS[j]
    fail("INPUT", f"expected a number, got {describe(j)}")


def int_from_json(j: Any) -> int:
    """Integers of up to 48 bits: JSON numbers (a non-integer is RANGE, other types INPUT)."""
    if isinstance(j, int) and not isinstance(j, bool):
        return j
    if isinstance(j, float):
        if j.is_integer():
            return int(j)
        fail("RANGE" if math.isfinite(j) else "INPUT", f"{j} is not an integer")
    fail("INPUT", f"expected an integer, got {describe(j)}")


def big_from_json(j: Any) -> int:
    """56/64-bit integers: decimal strings."""
    if isinstance(j, str) and _DEC.fullmatch(j):
        return int(j)
    fail("INPUT", f"expected a decimal integer string, got {describe(j)}")


def bool_from_json(j: Any) -> bool:
    if isinstance(j, bool):
        return j
    fail("INPUT", f"expected a boolean, got {describe(j)}")


def string_from_json(j: Any) -> str:
    if isinstance(j, str):
        return j
    fail("INPUT", f"expected a string, got {describe(j)}")


def object_from_json(j: Any) -> dict[str, Any]:
    if isinstance(j, dict):
        return j
    fail("INPUT", f"expected an object, got {describe(j)}")


def ptr(path: str, seg: str | int) -> str:
    """Appends an RFC 6901 reference token."""
    return f"{path}/{str(seg).replace('~', '~0').replace('/', '~1')}"


class ToJsonCtx:
    """State for ``to_json``: where each object was first written, for ``$ref``s."""

    __slots__ = ("seen",)

    def __init__(self) -> None:
        self.seen: dict[int, str] = {}

    def ref(self, v: Any, path: str) -> dict[str, str] | None:
        """The ``$ref`` to use if ``v`` was already written; otherwise records ``path``."""
        if v is None or isinstance(v, (bytes, bytearray, str, int, float)):
            return None
        if hasattr(v, "__len__") and not isinstance(v, dict) and len(v) == 0:
            return None
        prev = self.seen.get(id(v))
        if prev is not None:
            return {"$ref": prev}
        self.seen[id(v)] = path
        return None

    def obj(self, v: Any, path: str, fn: Callable[[Any, ToJsonCtx, str], Any]) -> Any:
        """A struct value: a ``$ref`` if already written, else ``fn(v, ctx, path)``."""
        r = self.ref(v, path)
        return r if r is not None else fn(v, self, path)

    def arr(self, v: Any, path: str, fn: Callable[[Any, str], Any]) -> Any:
        """An array: a ``$ref`` if already written, else each element converted."""
        r = self.ref(v, path)
        return r if r is not None else self.map(v, path, fn)

    def arr_plain(self, v: Any, path: str) -> Any:
        """An array of JSON-ready scalars."""
        r = self.ref(v, path)
        return r if r is not None else list(v)

    def map(self, v: Any, path: str, fn: Callable[[Any, str], Any]) -> list[Any]:
        """Each element converted (no ``$ref`` for the array itself)."""
        return [fn(e, f"{path}/{i}") for i, e in enumerate(v)]


class FromJsonCtx:
    """State for ``from_json``: values by JSON pointer, to restore identity from ``$ref``s."""

    __slots__ = ("by_path",)

    def __init__(self) -> None:
        self.by_path: dict[str, Any] = {}

    def deref(self, j: Any) -> tuple[Any] | None:
        """If ``j`` is a ``{"$ref": …}`` object, ``(value,)`` for the referenced value."""
        if not isinstance(j, dict) or len(j) != 1 or "$ref" not in j:
            return None
        target = j["$ref"]
        if not isinstance(target, str):
            return None
        if target not in self.by_path:
            fail("INPUT", f"$ref {target} does not point at an earlier value")
        return (self.by_path[target],)

    def register(self, path: str, v: Any) -> Any:
        if v is not None and not isinstance(v, (int, float, str)):
            self.by_path[path] = v
        return v

    def arr(self, j: Any, path: str, f: Callable[[Any, str], Any]) -> list[Any]:
        d = self.deref(j)
        if d is not None:
            v: list[Any] = d[0]
            return v
        if not isinstance(j, list):
            fail("INPUT", f"expected an array, got {describe(j)}")
        out: list[Any] = []
        self.register(path, out)
        for i, e in enumerate(j):
            try:
                out.append(f(e, ptr(path, i)))
            except YaffleError as err:
                err.prefix(i)
                raise
        return out

    def obj(self, j: Any, path: str, fn: Callable[[Any, FromJsonCtx, str], Any]) -> Any:
        """A struct (or a ``$ref`` to one): ``fn(j, ctx, path)`` registers the new object itself."""
        d = self.deref(j)
        return d[0] if d is not None else fn(j, self, path)

    def bytes(self, j: Any, path: str) -> bytes:
        d = self.deref(j)
        if d is not None:
            v: bytes = d[0]
            return v
        if not isinstance(j, str):
            fail("INPUT", f"expected a hex string, got {describe(j)}")
        b = from_hex(j)
        self.by_path[path] = b
        return b


def enum_from_json(cls: Any, values: Mapping[str, int], j: Any, is_open: bool) -> Any:
    """Enum member from JSON: a member name, or (open enums) a number or decimal string."""
    if isinstance(j, str) and j in values:
        return cls(values[j])
    if is_open:
        if isinstance(j, int) and not isinstance(j, bool):
            return enum_of(cls, j)
        if isinstance(j, float) and j.is_integer():
            return enum_of(cls, int(j))
        if isinstance(j, str) and _DEC.fullmatch(j):
            return enum_of(cls, int(j))
    fail("INPUT", f"{describe(j)} is not a member of the enum")


def enum_of(cls: Any, v: int) -> Any:
    """The enum member with value ``v``, or the plain integer (open enums)."""
    try:
        return cls(v)
    except ValueError:
        return int(v)


def enum_to_json(names: Mapping[int, str], v: Any, big: bool) -> Any:
    """Enum value to JSON: the member name, or the integer for an open enum's unknown value."""
    n = names.get(int(v))
    if n is not None:
        return n
    return str(int(v)) if big else int(v)


def union_to_json(v: Any, variants: Mapping[str, Callable[[Any, str], Any]], path: str) -> Any:
    t = getattr(v, "type", None)
    f = variants.get(t) if isinstance(t, str) else None
    if f is None:
        fail("INPUT", f"unknown union variant {describe(t)}")
    return {"type": t, "value": f(v.value, ptr(path, "value"))}


def union_from_json(j: Any, variants: Mapping[str, Callable[[Any, str], Any]], path: str) -> Variant:
    o = object_from_json(j)
    t = o.get("type")
    if not isinstance(t, str) or t not in variants:
        fail("INPUT", f"unknown union variant {describe(t)}")
    try:
        return Variant(t, variants[t](o.get("value"), ptr(path, "value")))
    except YaffleError as e:
        e.prefix("value")
        raise


def first_of(fs: list[Callable[[], Any]]) -> Any:
    """The first conversion that succeeds (fields whose type differs between branches)."""
    last: YaffleError | None = None
    for f in fs:
        try:
            return f()
        except YaffleError as e:
            last = e
    assert last is not None
    raise last


# ── side data on struct values ─────────────────────────────────────────────────


def _side(owner: Any, key: str) -> Any:
    """A side-data map of a struct value (struct views have no ``__dict__``: they look it up)."""
    d = getattr(owner, "__dict__", None)
    return d.get(key) if d is not None else getattr(owner, key, None)


def has_field(owner: Any, attr: str) -> bool:
    """True if a (conditional) field is present on a struct value."""
    d = getattr(owner, "__dict__", None)
    return attr in d if d is not None else hasattr(owner, attr)


def set_raw(owner: Any, field: str, raw: Any) -> None:
    """Remembers the raw (pre-transform) value of a one-way transform field."""
    owner.__dict__.setdefault("_yfl_raw", {})[field] = raw


def get_raw(owner: Any, field: str) -> Any:
    """The raw value remembered by :func:`set_raw` (None if the object did not come from a parse)."""
    m = _side(owner, "_yfl_raw")
    return None if m is None else m.get(field)


def set_hidden(owner: Any, field: str, value: Any) -> None:
    """Keeps a ``@hidden`` field's value with its struct (a ``from arr[*].piece`` stream reads it)."""
    owner.__dict__.setdefault("_yfl_hidden", {})[field] = value


def field_value(owner: Any, field: str) -> Any:
    """A field of a struct value, hidden (kept by :func:`set_hidden`) or not."""
    m = _side(owner, "_yfl_hidden")
    if m is not None and field in m:
        return m[field]
    return getattr(owner, field, None)
