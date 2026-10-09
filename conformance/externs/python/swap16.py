"""`extern fn swap16(u16 v) -> u16`: swaps the two bytes. Its own inverse."""

from __future__ import annotations


def swap16(v: int) -> int:
    return ((v & 0xFF) << 8) | ((v >> 8) & 0xFF)
