"""`extern type VarInt(u8 maxBytes) : u64`: unsigned LEB128, at most `maxBytes` bytes.

Host shape of an extern type: `size(data, *args) -> int | None`, `read(data, *args)` and
`write(value, *args) -> bytes`.

- size: the index after the first byte below 0x80; `None` if the bytes end first (need more);
  an error if no terminating byte is found within `maxBytes`.
- write: the shortest encoding; an error if it needs more than `maxBytes` bytes.
"""

from __future__ import annotations

U64_MAX = (1 << 64) - 1


class _VarInt:
    def size(self, data: bytes, max_bytes: int) -> int | None:
        for i in range(min(len(data), max_bytes)):
            if data[i] < 0x80:
                return i + 1
        if len(data) < max_bytes:
            return None
        raise ValueError(f"VarInt: longer than {max_bytes} bytes")

    def read(self, data: bytes, max_bytes: int) -> int:
        v = 0
        for i in range(min(len(data), max_bytes)):
            v |= (data[i] & 0x7F) << (7 * i)
            if data[i] < 0x80:
                if v > U64_MAX:
                    raise ValueError("VarInt: value exceeds u64")
                return v
        raise ValueError("VarInt: unterminated")

    def write(self, value: int, max_bytes: int) -> bytes:
        if not isinstance(value, int) or not 0 <= value <= U64_MAX:
            raise ValueError(f"VarInt: {value} is not a u64")
        out = bytearray()
        v = value
        while True:
            b = v & 0x7F
            v >>= 7
            out.append(b if v == 0 else b | 0x80)
            if v == 0:
                break
        if len(out) > max_bytes:
            raise ValueError(f"VarInt: {value} needs {len(out)} bytes, more than {max_bytes}")
        return bytes(out)


VarInt = _VarInt()
