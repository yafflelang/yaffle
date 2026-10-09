"""`extern codec xorpos(u8 key) @ranged`: byte i of the encoded region XOR `(key + i) & 0xff`.

`i` counts from the start of the whole region, so a slice decodes on its own only when it is
given its position (`ctx.position`).
"""

from __future__ import annotations

from typing import Any


def _apply(data: bytes, ctx: Any) -> bytes:
    key = ctx.args[0]
    if not isinstance(key, int) or isinstance(key, bool) or not 0 <= key <= 255:
        raise ValueError(f"codec key must be a u8, got {key!r}")
    pos = ctx.position or 0
    return bytes(b ^ ((key + pos + i) & 0xFF) for i, b in enumerate(data))


class _XorPos:
    def decode(self, data: bytes, ctx: Any) -> bytes:
        return _apply(data, ctx)

    def encode(self, data: bytes, ctx: Any) -> bytes:
        return _apply(data, ctx)


xorpos = _XorPos()
