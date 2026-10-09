"""Tests of the Python conformance externs (run: python -m unittest discover -s conformance/externs/python).

They mirror conformance/test/externs.test.ts for the TS externs.
"""

from __future__ import annotations

import asyncio
import importlib.util
import os
import unittest
from dataclasses import dataclass, field
from types import ModuleType
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(f"_ext_{name}", os.path.join(HERE, f"{name}.py"))
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@dataclass
class Ctx:
    args: list[Any] = field(default_factory=list)
    output_size: int | None = None
    position: int | None = None


class Externs(unittest.TestCase):
    def test_xor(self) -> None:
        xor = load("xor").xor
        self.assertEqual(xor.encode(b"\x01\x02\x03", Ctx([0x5A])), b"\x5b\x58\x59")
        self.assertEqual(xor.decode(b"\x5b\x58\x59", Ctx([0x5A], 3)), b"\x01\x02\x03")
        self.assertRaises(ValueError, xor.decode, b"\x00", Ctx([1], 2))
        self.assertRaisesRegex(ValueError, "u8", xor.decode, b"\x00", Ctx([256]))

    def test_xorpos_uses_the_position(self) -> None:
        xorpos = load("xorpos").xorpos
        self.assertEqual(xorpos.encode(b"\x00\x00\x00", Ctx([0xFE])), b"\xfe\xff\x00")
        self.assertEqual(xorpos.decode(b"\x00\x00", Ctx([0xFE], None, 1)), b"\xff\x00")

    def test_axor_is_async_xor(self) -> None:
        axor = load("axor").axor
        self.assertEqual(asyncio.run(axor.encode(b"\xff", Ctx([0x0F]))), b"\xf0")
        self.assertEqual(asyncio.run(axor.decode(b"\xf0", Ctx([0x0F]))), b"\xff")

    def test_rle(self) -> None:
        m = load("rle")
        long = bytes([7] * 256 + [1])
        self.assertEqual(m.rle_encode(long), bytes([255, 7, 1, 7, 1, 1]))
        self.assertEqual(m.rle_decode(bytes([255, 7, 1, 7, 1, 1])), long)
        self.assertEqual(m.rle_encode(b""), b"")
        self.assertEqual(m.rle.decode(bytes([2, 9, 1, 8]), Ctx([], 3)), bytes([9, 9, 8]))
        self.assertRaisesRegex(ValueError, "zero", m.rle.decode, bytes([0, 9]), Ctx())
        self.assertRaisesRegex(ValueError, "odd", m.rle.decode, bytes([1]), Ctx())
        self.assertRaisesRegex(ValueError, "expected 2", m.rle.decode, bytes([1, 1]), Ctx([], 2))

    def test_rlez_streams_to_its_terminator(self) -> None:
        rlez = load("rlez").rlez
        self.assertEqual(rlez.encode(bytes([5, 5]), Ctx()), bytes([2, 5, 0]))
        self.assertEqual(rlez.decode(bytes([2, 5, 0, 0xAA]), Ctx()), (bytes([5, 5]), 3))
        self.assertEqual(rlez.decode(bytes([0]), Ctx()), (b"", 1))
        self.assertRaisesRegex(ValueError, "terminator", rlez.decode, bytes([2, 5]), Ctx())

    def test_sum8_and_swap16(self) -> None:
        self.assertEqual(load("sum8").sum8(bytes([0xFF, 2])), 1)
        self.assertEqual(load("sum8").sum8(b""), 0)
        self.assertEqual(load("swap16").swap16(0x1234), 0x3412)

    def test_varint(self) -> None:
        v = load("varint").VarInt
        self.assertEqual(v.write(300, 10), bytes([0xAC, 0x02]))
        self.assertEqual(v.read(bytes([0xAC, 0x02]), 10), 300)
        self.assertEqual(v.size(bytes([0xAC, 0x02, 0x99]), 10), 2)
        self.assertIsNone(v.size(bytes([0xAC]), 10))
        self.assertRaises(ValueError, v.size, bytes([0x80, 0x80]), 2)
        self.assertRaises(ValueError, v.write, 1 << 14, 2)
        self.assertRaises(ValueError, v.write, 1 << 64, 10)

    def test_bcd16(self) -> None:
        b = load("bcd16").Bcd16
        self.assertEqual(b.read(bytes([0x12, 0x34])), 1234)
        self.assertEqual(b.write(1234), bytes([0x12, 0x34]))
        self.assertEqual(b.size(b""), 2)
        self.assertRaises(ValueError, b.read, bytes([0x1A, 0x00]))
        self.assertRaises(ValueError, b.write, 10000)


if __name__ == "__main__":
    unittest.main()
