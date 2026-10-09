"""`extern codec rle`: run-length encoding as (count, byte) pairs with count 1..255.

- decode: an odd input length or a zero count is an error; so is a decoded length that differs
  from `output_size` when one is given.
- encode: greedy, runs of at most 255 (deterministic, so conformance cases can predict it).
"""

from __future__ import annotations

from typing import Any


def rle_decode(data: bytes) -> bytes:
    if len(data) % 2:
        raise ValueError(f"rle: odd input length {len(data)}")
    out = bytearray()
    for i in range(0, len(data), 2):
        n = data[i]
        if n == 0:
            raise ValueError(f"rle: zero run length at {i}")
        out += bytes((data[i + 1],)) * n
    return bytes(out)


def rle_encode(data: bytes) -> bytes:
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


class _Rle:
    def decode(self, data: bytes, ctx: Any) -> bytes:
        out = rle_decode(data)
        if ctx.output_size is not None and ctx.output_size != len(out):
            raise ValueError(f"rle: decoded {len(out)} bytes, expected {ctx.output_size}")
        return out

    def encode(self, data: bytes, ctx: Any) -> bytes:
        return rle_encode(data)


rle = _Rle()
