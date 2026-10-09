"""`extern fn sum8(u8 data[]) -> u8`: the sum of the bytes, modulo 256."""

from __future__ import annotations


def sum8(data: bytes) -> int:
    return sum(data) & 0xFF
