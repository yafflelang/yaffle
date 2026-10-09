"""Number semantics of generated expressions (docs/IR.md §6).

Python integers are exact, so arithmetic needs no widening, and bitwise operators already follow
two's complement. What remains: truncating division, ``%`` with the sign of the dividend, shift
counts 0..63, rounding half away from zero, IEEE float division and remainder, and lengths.
"""

from __future__ import annotations

import math
from typing import Any

from .errors import describe, fail

__all__ = ["div", "fdiv", "fmod", "length", "mod", "offset", "round_half_away", "shl", "shr", "trunc"]


def div(a: int, b: int) -> int:
    """Integer division truncating toward zero."""
    if b == 0:
        fail("RANGE", "division by zero")
    q = abs(a) // abs(b)
    return q if (a < 0) == (b < 0) else -q


def mod(a: int, b: int) -> int:
    """Remainder with the sign of the dividend."""
    if b == 0:
        fail("RANGE", "division by zero")
    r = abs(a) % abs(b)
    return -r if a < 0 else r


def fdiv(a: float, b: float) -> float:
    """IEEE float division (x/0 is ±Infinity or NaN, as in the other targets)."""
    try:
        return a / b
    except ZeroDivisionError:
        if a == 0 or math.isnan(a):
            return math.nan
        neg = (a < 0) != (math.copysign(1.0, b) < 0)
        return -math.inf if neg else math.inf


def fmod(a: float, b: float) -> float:
    """IEEE float remainder with the sign of the dividend (NaN for x % 0)."""
    if b == 0 or math.isinf(a) or math.isnan(a) or math.isnan(b):
        return math.nan
    if math.isinf(b):
        return a
    return math.fmod(a, b)


def _shift_count(n: Any) -> int:
    if not isinstance(n, int) or n < 0 or n > 63:
        fail("RANGE", f"shift count {n} is not in 0..63")
    return int(n)


def shl(a: int, n: int) -> int:
    return a << _shift_count(n)


def shr(a: int, n: int) -> int:
    return a >> _shift_count(n)


def trunc(x: float) -> int:
    """Float to integer, truncating toward zero."""
    if not math.isfinite(x):
        fail("RANGE", f"cannot convert {x} to an integer")
    return math.trunc(x)


def round_half_away(x: float) -> int:
    """Rounds half away from zero."""
    if not math.isfinite(x):
        fail("RANGE", f"cannot round {x} to an integer")
    if x < 0:
        return -round_half_away(-x)
    f = math.floor(x)
    return int(f) + 1 if x - f >= 0.5 else int(f)


def offset(v: Any, what: str = "offset") -> int:
    """An offset or position: an integer (an integral float is accepted)."""
    if isinstance(v, int) and not isinstance(v, bool):
        return int(v)
    if isinstance(v, float) and v.is_integer():
        return int(v)
    fail("RANGE", f"{what} {describe(v)} is not an integer")


def length(v: Any, what: str = "length") -> int:
    """A length or count: a non-negative integer."""
    n = offset(v, what)
    if n < 0:
        fail("RANGE", f"{what} {n} is negative")
    return n
