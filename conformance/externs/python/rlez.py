"""`extern codec rlez @streaming`: `rle` pairs followed by a single 0x00 terminator.

It finds its own end, so it needs no outer `@size`: decode returns `(output, consumed)`, where
`consumed` includes the terminator. A missing terminator is an error. Extern files are loaded by
path (no package), so the `rle` helpers are repeated here.
"""

from __future__ import annotations

from typing import Any


def _decode_pairs(data: bytes) -> bytes:
    out = bytearray()
    for i in range(0, len(data), 2):
        n = data[i]
        if n == 0:
            raise ValueError(f"rle: zero run length at {i}")
        out += bytes((data[i + 1],)) * n
    return bytes(out)


def _encode_pairs(data: bytes) -> bytes:
    out = bytearray()
    i = 0
    while i < len(data):
        b = data[i]
        n = 1
        while i + n < len(data) and data[i + n] == b and n < 255:
            n += 1
        out += bytes((n, b))
        i += n
    return bytes(out)


class _Rlez:
    def decode(self, data: bytes, ctx: Any) -> tuple[bytes, int]:
        i = 0
        while i < len(data) and data[i] != 0:
            i += 2
        if i >= len(data):
            raise ValueError("rlez: missing terminator")
        output = _decode_pairs(data[:i])
        if ctx.output_size is not None and ctx.output_size != len(output):
            raise ValueError(f"rlez: decoded {len(output)} bytes, expected {ctx.output_size}")
        return output, i + 1

    def encode(self, data: bytes, ctx: Any) -> bytes:
        return _encode_pairs(data) + b"\x00"


rlez = _Rlez()
