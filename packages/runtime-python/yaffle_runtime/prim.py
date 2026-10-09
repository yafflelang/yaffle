"""Primitive encodings: N-byte integers (both byte orders, 1..8 bytes), IEEE half/single/double.

Integers of every width are Python ints (exact); floats are Python floats (f16 and f32 values are
the exact doubles of the stored value).
"""

from __future__ import annotations

import math
import struct
from typing import Any, NamedTuple

from .errors import describe, fail

__all__ = ["PRIMS", "check_prim", "check_value", "pack_prim", "read_prim"]


class PrimInfo(NamedTuple):
    size: int
    signed: bool
    float: bool
    lo: int
    hi: int


def _info(kind: str) -> PrimInfo:
    bits = int(kind[1:])
    if kind[0] == "f":
        return PrimInfo(bits // 8, False, True, 0, 0)
    if kind[0] == "i":
        return PrimInfo(bits // 8, True, False, -(1 << (bits - 1)), (1 << (bits - 1)) - 1)
    return PrimInfo(bits // 8, False, False, 0, (1 << bits) - 1)


PRIMS: dict[str, PrimInfo] = {
    k: _info(k)
    for k in (
        "u8", "u16", "u24", "u32", "u40", "u48", "u56", "u64",
        "i8", "i16", "i24", "i32", "i40", "i48", "i56", "i64",
        "f16", "f32", "f64",
    )
}  # fmt: skip

#: A ``struct.Struct`` per (kind, little-endian) for the kinds ``struct`` supports natively.
STRUCTS: dict[tuple[str, bool], struct.Struct] = {
    (kind, le): struct.Struct(("<" if le else ">") + fmt)
    for kind, fmt in {
        "u8": "B", "i8": "b", "u16": "H", "i16": "h", "u32": "I", "i32": "i", "u64": "Q",
        "i64": "q", "f16": "e", "f32": "f", "f64": "d",
    }.items()  # fmt: skip
    for le in (True, False)
}


def read_prim(buf: Any, off: int, kind: str, le: bool) -> int | float:
    """Reads any primitive at ``off`` (bounds already checked)."""
    s = STRUCTS.get((kind, le))
    if s is not None:
        v: int | float = s.unpack_from(buf, off)[0]
        return v
    info = PRIMS[kind]
    return int.from_bytes(buf[off : off + info.size], "little" if le else "big", signed=info.signed)


def pack_prim(kind: str, v: int | float, le: bool) -> bytes:
    """Packs a validated value (see :func:`check_prim`). Floats round to nearest even; out-of-range
    floats become ±Infinity."""
    s = STRUCTS.get((kind, le))
    if PRIMS[kind].float:
        assert s is not None
        try:
            return s.pack(float(v))
        except OverflowError:
            return s.pack(math.copysign(math.inf, v))
    if s is not None:
        return s.pack(v)
    info = PRIMS[kind]
    return int(v).to_bytes(info.size, "little" if le else "big", signed=info.signed)


def check_prim(v: Any, kind: str, what: str | None = None) -> int | float:
    """Validates a value destined for a primitive. Wrong type: INPUT; out of range: RANGE."""
    info = PRIMS[kind]
    if info.float:
        if isinstance(v, float):
            return v
        if isinstance(v, int) and not isinstance(v, bool):
            return float(v)
        fail("INPUT", f"expected a number for {what or kind}, got {describe(v)}")
    if isinstance(v, float):
        if not math.isfinite(v):
            fail("INPUT", f"{v} is not an integer ({kind})")
        if not v.is_integer():
            fail("RANGE", f"{v} is not an integer ({kind})")
        v = int(v)
    elif not isinstance(v, int) or isinstance(v, bool):
        fail("INPUT", f"expected an integer for {what or kind}, got {describe(v)}")
    if v < info.lo or v > info.hi:
        fail("RANGE", f"{v} is out of range for {kind}")
    return int(v)


def check_value(v: Any, kind: str) -> Any:
    """:func:`check_prim` typed for generated code (an ``int`` for integer kinds)."""
    return check_prim(v, kind)
