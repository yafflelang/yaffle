"""`extern async codec axor(u8 key)`: the same transform as `xor`, through coroutines."""

from __future__ import annotations

import asyncio
from typing import Any


def _apply(data: bytes, ctx: Any) -> bytes:
    key = ctx.args[0]
    if not isinstance(key, int) or isinstance(key, bool) or not 0 <= key <= 255:
        raise ValueError(f"codec key must be a u8, got {key!r}")
    return bytes(data).translate(bytes(b ^ key for b in range(256)))


class _AXor:
    async def decode(self, data: bytes, ctx: Any) -> bytes:
        await asyncio.sleep(0)
        out = _apply(data, ctx)
        if ctx.output_size is not None and ctx.output_size != len(out):
            raise ValueError(f"axor: decoded {len(out)} bytes, expected {ctx.output_size}")
        return out

    async def encode(self, data: bytes, ctx: Any) -> bytes:
        await asyncio.sleep(0)
        return _apply(data, ctx)


axor = _AXor()
