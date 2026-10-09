"""`extern type Bcd16 : u16 @size(2)`: four BCD digits, most significant first (`12 34` -> 1234).

Fixed size, so generated code never needs `size`. A nibble above 9 is an error on read; a value
above 9999 is an error on write.
"""

from __future__ import annotations


class _Bcd16:
    def size(self, data: bytes) -> int:
        return 2

    def read(self, data: bytes) -> int:
        v = 0
        for i in range(2):
            hi, lo = data[i] >> 4, data[i] & 0x0F
            if hi > 9 or lo > 9:
                raise ValueError(f"Bcd16: invalid digit in 0x{data[i]:x}")
            v = v * 100 + hi * 10 + lo
        return v

    def write(self, value: int) -> bytes:
        if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 9999:
            raise ValueError(f"Bcd16: {value} out of range")
        d = [value // 1000 % 10, value // 100 % 10, value // 10 % 10, value % 10]
        return bytes(((d[0] << 4) | d[1], (d[2] << 4) | d[3]))


Bcd16 = _Bcd16()
