"""Checks and conversions of values in generated readers and writers: enums, bitfields, input
values, lengths, placements and transform round trips."""

from __future__ import annotations

import math
from typing import Any, Mapping, Sequence

from .errors import YaffleError, describe, fail
from .reader import Reader
from .strings import encode_string

__all__ = [
    "array_value", "bits_of", "bool_bit", "check_float_round_trip", "check_length",
    "check_placement", "check_round_trip", "encode_fixed_string", "enum_read", "enum_value",
    "is_empty", "need", "sign_extend", "size_of", "union_value",
]  # fmt: skip

# ── enums and bitfields ────────────────────────────────────────────────────────


def enum_read(members: Mapping[int, Any], raw: int, is_open: bool, r: Reader, at: int) -> Any:
    """Enum read: raw value -> member; unknown values fail unless the enum is open."""
    m = members.get(raw)
    if m is not None:
        return m
    if is_open:
        return raw
    r.fail("CHECK", f"{raw} is not a member of the enum", at)


def enum_value(values: Mapping[str, int], members: Mapping[int, Any], is_open: bool, v: Any) -> int:
    """Enum write: a member (or its name, or a raw integer for open enums) -> its value."""
    if isinstance(v, int) and not isinstance(v, bool):
        n = int(v)
        if not is_open and n not in members:
            fail("CHECK", f"{n} is not a member of the enum")
        return n
    if isinstance(v, str):
        x = values.get(v)
        if x is not None:
            return x
        fail("INPUT", f"{v!r} is not a member of the enum")
    fail("INPUT", f"expected an enum member, got {describe(v)}")


def sign_extend(v: int, width: int) -> int:
    """Sign-extends the low ``width`` bits of a non-negative integer."""
    return v - (1 << width) if v >> (width - 1) & 1 else v


def bool_bit(v: Any) -> int:
    if not isinstance(v, bool):
        fail("INPUT", f"expected a boolean, got {describe(v)}")
    return 1 if v else 0


def bits_of(v: Any, width: int, signed: bool) -> int:
    """A bitfield value as unsigned bits of ``width`` (signed values in two's complement)."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        fail("INPUT", f"expected an integer, got {describe(v)}")
    if isinstance(v, float):
        if not v.is_integer():
            fail("RANGE", f"{v} is not an integer")
        v = int(v)
    lo = -(1 << (width - 1)) if signed else 0
    hi = (1 << (width - 1)) - 1 if signed else (1 << width) - 1
    if v < lo or v > hi:
        fail("RANGE", f"{v} does not fit in {width} bits")
    return int(v) + (1 << width) if v < 0 else int(v)


# ── input values ───────────────────────────────────────────────────────────────


def need(v: Any, fields: Sequence[Any]) -> None:
    """Checks that an input value is an object with the given required fields. Each entry is an
    attribute name, or ``(attribute, field name)`` when they differ."""
    if v is None or isinstance(v, (bool, int, float, str, bytes, bytearray, list, tuple, dict)):
        fail("INPUT", f"expected an object, got {describe(v)}")
    for f in fields:
        attr, name = (f, f) if isinstance(f, str) else f
        if not hasattr(v, attr):
            raise YaffleError("INPUT", f"missing required field {name}", -1, [name])


def union_value(v: Any) -> Any:
    """An input union value (a :class:`Variant` or anything with ``type`` and ``value``)."""
    if not isinstance(getattr(v, "type", None), str) or not hasattr(v, "value"):
        fail("INPUT", f"expected a union value (Variant(type, value)), got {describe(v)}")
    return v


def array_value(v: Any) -> Sequence[Any]:
    """An input array (lists, tuples and other sequences)."""
    if isinstance(v, (list, tuple)):
        return v
    if (
        v is not None
        and not isinstance(v, (str, bytes, bytearray, dict))
        and hasattr(v, "__len__")
        and hasattr(v, "__getitem__")
    ):
        return v  # type: ignore[no-any-return]
    fail("INPUT", f"expected an array, got {describe(v)}")


def is_empty(v: Any) -> bool:
    """``@nullable(empty)``: an empty (or None) array, bytes or string is written as null."""
    if v is None:
        return True
    if isinstance(v, (str, bytes, bytearray)):
        return len(v) == 0
    return len(array_value(v)) == 0


def size_of(v: Any) -> int:
    """The length of an input array, bytes or string value."""
    if v is None or isinstance(v, (bool, int, float)) or not hasattr(v, "__len__"):
        fail("INPUT", f"expected an array, got {describe(v)}")
    return len(v)


def encode_fixed_string(s: Any, n: int, unit: int, enc: str, le: bool) -> bytes:
    """Encodes a string padded with NUL units to exactly ``n`` bytes."""
    b = encode_string(s, enc, le)
    if len(b) > n:
        fail("INPUT", f"string of {len(b) // unit} units exceeds the length {n // unit}")
    return b + bytes(n - len(b))


# ── checks after the fact ──────────────────────────────────────────────────────


def check_length(actual: int, expected: int) -> None:
    """An array written with ``actual`` elements whose length expression says ``expected``."""
    if actual != expected:
        fail("DERIVE", f"{actual} elements given, the length expression says {expected}")


def check_placement(offset: int, p: Any, name: str) -> None:
    """A placed field whose read-side offset expression disagrees with where it was placed."""
    # An empty target reads back the same wherever its offset points.
    if p.block.data and offset != p.block.pos:
        fail("DERIVE", f"{name} was placed at {p.block.pos} but its offset expression gives {offset}")


def check_round_trip(v: Any, back: Any) -> None:
    """``read(write(v))`` must give ``v`` back (bools only equal bools; NaN equals NaN)."""
    if isinstance(v, bool) or isinstance(back, bool):
        if type(v) is type(back) and v == back:
            return
    elif v == back:
        return
    elif isinstance(v, float) and isinstance(back, float) and math.isnan(v) and math.isnan(back):
        return
    fail("INPUT", f"value {describe(v)} does not survive the transform (reads back as {describe(back)})")


def check_float_round_trip(v: Any, back: float, nxt: float) -> None:
    """Float transforms: the value must be within half a storage step of what reads back."""
    if not isinstance(v, (int, float)) or isinstance(v, bool):
        fail("INPUT", f"expected a number, got {describe(v)}")
    if isinstance(v, float) and math.isnan(v) and math.isnan(back):
        return
    half = abs(nxt - back) / 2
    if not abs(v - back) <= half * (1 + 1e-9):
        fail("INPUT", f"value {v} does not survive the transform (reads back as {back})")
