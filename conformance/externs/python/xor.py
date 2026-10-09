"""`extern codec xor(u8 key) @ranged`: every byte XOR `key`.

Its own inverse, and position independent, so any slice decodes on its own.

Host shape (docs/targets/python.md): an object with `decode(data, ctx)` and `encode(data, ctx)`.
`ctx.args` holds the codec arguments, `ctx.output_size` the decoded size when an inner `@size`
gives it, and `ctx.position` the slice offset for `@ranged` codecs.
"""

from __future__ import annotations

from typing import Any


def _apply(data: bytes, ctx: Any) -> bytes:
    key = ctx.args[0]
    if not isinstance(key, int) or isinstance(key, bool) or not 0 <= key <= 255:
        raise ValueError(f"codec key must be a u8, got {key!r}")
    return bytes(data).translate(bytes(b ^ key for b in range(256)))


class _Xor:
    def decode(self, data: bytes, ctx: Any) -> bytes:
        out = _apply(data, ctx)
        if ctx.output_size is not None and ctx.output_size != len(out):
            raise ValueError(f"xor: decoded {len(out)} bytes, expected {ctx.output_size}")
        return out

    def encode(self, data: bytes, ctx: Any) -> bytes:
        return _apply(data, ctx)


xor = _Xor()
