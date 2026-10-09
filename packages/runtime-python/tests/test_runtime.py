"""Unit tests of yaffle_runtime (run: python -m unittest discover -s packages/runtime-python/tests)."""

from __future__ import annotations

import asyncio
import gc
import math
import unittest
from dataclasses import dataclass
from typing import Any

import yaffle_runtime as rt
from yaffle_runtime.layout import StickyPolicy


def code_of(f: Any) -> tuple[str, list[Any]]:
    try:
        f()
    except rt.YaffleError as e:
        return e.code, e.path
    raise AssertionError("no YaffleError")


class Primitives(unittest.TestCase):
    def test_every_prim_round_trips_in_both_endiannesses(self) -> None:
        samples = {
            "u8": [0, 255], "i8": [-128, 127], "u16": [0, 0xFFFF], "i16": [-0x8000, 0x7FFF],
            "u24": [0, 0xFFFFFF], "i24": [-0x800000, 0x7FFFFF], "u32": [0, 0xFFFFFFFF],
            "i32": [-(2**31), 2**31 - 1], "u40": [2**40 - 1], "i40": [-(2**39)], "u48": [2**48 - 1],
            "i48": [-(2**47), 2**47 - 1], "u56": [2**56 - 1], "i56": [-(2**55)],
            "u64": [2**64 - 1], "i64": [-(2**63), 2**63 - 1],
        }  # fmt: skip
        for kind, values in samples.items():
            for le in (True, False):
                for v in values:
                    b = rt.pack_prim(kind, v, le)
                    self.assertEqual(len(b), rt.PRIMS[kind].size)
                    self.assertEqual(rt.read_prim(b, 0, kind, le), v, (kind, le, v))
                    r = rt.Reader(b)
                    self.assertEqual(r.prim(kind, le), v)

    def test_u24_byte_order(self) -> None:
        self.assertEqual(rt.pack_prim("u24", 0x010203, True), b"\x03\x02\x01")
        self.assertEqual(rt.pack_prim("u24", 0x010203, False), b"\x01\x02\x03")
        self.assertEqual(rt.Reader(b"\xff\xff\xff").i_n(3, True), -1)

    def test_floats(self) -> None:
        self.assertEqual(rt.pack_prim("f16", 1.0, True), b"\x00\x3c")
        self.assertEqual(rt.pack_prim("f16", float("nan"), True), b"\x00\x7e")
        self.assertEqual(rt.pack_prim("f16", 1e9, False), b"\x7c\x00")  # overflow -> Infinity
        self.assertEqual(rt.pack_prim("f32", -1e40, False), b"\xff\x80\x00\x00")
        self.assertEqual(rt.pack_prim("f32", float("nan"), False), b"\x7f\xc0\x00\x00")
        # round to nearest, ties to even: 1 + 2^-11 is halfway between two halfs
        self.assertEqual(rt.pack_prim("f16", 1 + 2**-11, True), b"\x00\x3c")
        self.assertEqual(rt.Reader(b"\x00\x00\x80\x3f").f32(True), 1.0)
        self.assertTrue(math.isnan(rt.Reader(b"\x01\x7c").f16(True)))

    def test_check_prim(self) -> None:
        self.assertEqual(code_of(lambda: rt.check_prim(256, "u8"))[0], "RANGE")
        self.assertEqual(code_of(lambda: rt.check_prim(True, "u8"))[0], "INPUT")
        self.assertEqual(code_of(lambda: rt.check_prim("1", "u8"))[0], "INPUT")
        self.assertEqual(code_of(lambda: rt.check_prim(1.5, "u8"))[0], "RANGE")
        self.assertEqual(code_of(lambda: rt.check_prim(float("inf"), "u8"))[0], "INPUT")
        self.assertEqual(rt.check_prim(2.0, "u8"), 2)
        self.assertEqual(rt.check_prim(3, "f32"), 3.0)
        self.assertEqual(code_of(lambda: rt.check_prim(None, "f32"))[0], "INPUT")


class Integers(unittest.TestCase):
    def test_truncating_division_and_remainder(self) -> None:
        self.assertEqual((rt.div(7, 2), rt.div(-7, 2), rt.div(7, -2), rt.div(-7, -2)), (3, -3, -3, 3))
        self.assertEqual((rt.mod(7, 2), rt.mod(-7, 2), rt.mod(7, -2), rt.mod(-7, -2)), (1, -1, 1, -1))
        self.assertEqual(code_of(lambda: rt.div(1, 0))[0], "RANGE")
        self.assertEqual(code_of(lambda: rt.mod(1, 0))[0], "RANGE")

    def test_shifts_and_rounding(self) -> None:
        self.assertEqual(rt.shl(1, 63), 2**63)
        self.assertEqual(rt.shr(-8, 1), -4)
        self.assertEqual(code_of(lambda: rt.shl(1, 64))[0], "RANGE")
        self.assertEqual(code_of(lambda: rt.shr(1, -1))[0], "RANGE")
        self.assertEqual([rt.round_half_away(x) for x in (0.5, 1.5, 2.5, -0.5, -2.5, 2.4)], [1, 2, 3, -1, -3, 2])
        self.assertEqual(rt.trunc(-2.9), -2)
        self.assertEqual(code_of(lambda: rt.round_half_away(float("nan")))[0], "RANGE")

    def test_float_division(self) -> None:
        self.assertEqual(rt.fdiv(1.0, 0.0), math.inf)
        self.assertEqual(rt.fdiv(-1.0, 0.0), -math.inf)
        self.assertTrue(math.isnan(rt.fdiv(0.0, 0.0)))
        self.assertTrue(math.isnan(rt.fmod(1.0, 0.0)))
        self.assertEqual(rt.fmod(-7.0, 2.0), -1.0)

    def test_lengths_and_aggregates(self) -> None:
        self.assertEqual(code_of(lambda: rt.length(-1))[0], "RANGE")
        self.assertEqual(rt.sum_of([1, 2, 3]), 6)
        self.assertEqual(rt.max_of([1, 5, 3]), 5)
        self.assertEqual(code_of(lambda: rt.min_of([]))[0], "RANGE")
        self.assertEqual(rt.lengths([[1], [], None, [1, 2]]), [1, 0, 0, 2])
        self.assertEqual(code_of(lambda: rt.at([1], 1))[0], "RANGE")
        self.assertEqual(rt.index_of(["a", "b"], "b"), 1)
        self.assertEqual(code_of(lambda: rt.index_of(["a"], "c"))[0], "INPUT")

    def test_equals(self) -> None:
        self.assertTrue(rt.equals(1, 1.0))
        self.assertFalse(rt.equals(True, 1))
        self.assertTrue(rt.equals(float("nan"), float("nan")))
        self.assertTrue(rt.equals(b"ab", bytearray(b"ab")))
        self.assertTrue(rt.equals([1, [2]], [1, [2]]))


class Strings(unittest.TestCase):
    def test_decode_and_nul(self) -> None:
        r = rt.Reader(b"hi\x00xyz")
        self.assertEqual(r.str(6, 1, "utf8", True), "hi")
        self.assertEqual(rt.Reader("é\x00".encode("utf-16-be")).str_until(2, "utf16", False), "é")
        self.assertEqual(rt.Reader(b"\x00\xf6\x01\x00").str(1, 4, "utf32", True), "\U0001f600")

    def test_invalid_input_is_check(self) -> None:
        self.assertEqual(code_of(lambda: rt.Reader(b"\xff").str(1, 1, "utf8", True))[0], "CHECK")
        self.assertEqual(code_of(lambda: rt.Reader(b"\x80").str(1, 1, "ascii", True))[0], "CHECK")
        self.assertEqual(code_of(lambda: rt.Reader(b"\x00\xd8").str(1, 2, "utf16", True))[0], "CHECK")
        self.assertEqual(code_of(lambda: rt.Reader(b"\x00\x00\x11\x00").str(1, 4, "utf32", True))[0], "CHECK")
        self.assertEqual(rt.Reader(b"\xe9").str(1, 1, "latin1", True), "é")

    def test_encode(self) -> None:
        self.assertEqual(code_of(lambda: rt.encode_string("a\x00", "utf8", True))[0], "INPUT")
        self.assertEqual(code_of(lambda: rt.encode_string("é", "ascii", True))[0], "INPUT")
        self.assertEqual(code_of(lambda: rt.encode_string("\ud800", "utf16", True))[0], "INPUT")
        self.assertEqual(rt.code_units("\U0001f600", "utf16"), 2)
        self.assertEqual(rt.code_units("\U0001f600", "utf8"), 4)
        self.assertEqual(rt.encoded_bytes("ab", "utf32"), 8)
        w = rt.Writer(rt.Region())
        self.assertEqual(code_of(lambda: w.str("abc", 1, "utf8", True, "count", 2))[0], "INPUT")


class Checksums(unittest.TestCase):
    def test_known_values(self) -> None:
        self.assertEqual(rt.crc32(b"123456789"), 0xCBF43926)
        self.assertEqual(rt.adler32(b"Wikipedia"), 0x11E60398)
        self.assertEqual(rt.crc32("123456789"), 0xCBF43926)


class Json(unittest.TestCase):
    def test_scalars(self) -> None:
        self.assertEqual([rt.float_to_json(x) for x in (math.nan, math.inf, -math.inf, -0.0, 1.5)],
                         ["NaN", "Infinity", "-Infinity", "-0", 1.5])  # fmt: skip
        self.assertTrue(math.isnan(rt.float_from_json("NaN")))
        self.assertEqual(math.copysign(1, rt.float_from_json("-0")), -1)
        self.assertEqual(code_of(lambda: rt.int_from_json(True))[0], "INPUT")
        self.assertEqual(code_of(lambda: rt.int_from_json(1.5))[0], "RANGE")
        self.assertEqual(rt.big_from_json("-12"), -12)
        self.assertEqual(code_of(lambda: rt.big_from_json(12))[0], "INPUT")
        self.assertEqual(rt.from_hex("0a 0B"), b"\x0a\x0b")
        self.assertEqual(code_of(lambda: rt.from_hex("0"))[0], "INPUT")

    def test_refs(self) -> None:
        c = rt.ToJsonCtx()
        shared = [1]
        self.assertIsNone(c.ref(shared, "/a"))
        self.assertEqual(c.ref(shared, "/b"), {"$ref": "/a"})
        self.assertIsNone(c.ref([], "/c"))
        self.assertIsNone(c.ref(b"x", "/d"))
        f = rt.FromJsonCtx()
        out = f.arr([1, 2], "/x", lambda j, p: j)
        self.assertIs(f.deref({"$ref": "/x"})[0], out)  # type: ignore[index]
        self.assertEqual(code_of(lambda: f.deref({"$ref": "/nope"}))[0], "INPUT")
        self.assertEqual(rt.ptr("/a", "b/c~"), "/a/b~1c~0")


class Reading(unittest.TestCase):
    def test_eof_and_windows(self) -> None:
        r = rt.Reader(b"\x01\x02\x03")
        self.assertEqual(code_of(lambda: r.u32(True))[0], "EOF")
        saved = r.window(2)
        self.assertEqual(r.u8(), 1)
        self.assertEqual(code_of(lambda: r.u16(True))[0], "EOF")
        r.close_window(saved, False)
        self.assertEqual(r.pos, 2)
        self.assertEqual(code_of(lambda: rt.Reader(b"\x01").pad(1, 0, True))[0], "CHECK")
        self.assertEqual(code_of(lambda: rt.Reader(b"\x05").bool(True))[0], "CHECK")

    def test_targets_share_identity(self) -> None:
        @dataclass
        class S:
            x: int = 0

        r = rt.Reader(b"\x07\x00")

        def read() -> S:
            s = r.take_into(S)
            s.x = r.u8()
            return s

        a = r.target_struct(0, "S", read, S)
        b = r.target_struct(0, "S", read, S)
        self.assertIs(a, b)
        self.assertEqual(r.pos, 0)

    def test_union_errors(self) -> None:
        r = rt.Reader(b"\x01")

        def bad() -> int:
            r.u16(True)
            return 0

        code, _ = code_of(lambda: r.union([("A", bad), ("B", bad)]))
        self.assertEqual(code, "UNION")
        v = r.union([("A", bad), ("B", r.u8)])
        self.assertEqual((v.type, v.value), ("B", 1))


class Writing(unittest.TestCase):
    def test_placeables_and_pointers(self) -> None:
        region = rt.Region()
        w = rt.Writer(region)
        w.u8(1)
        target = [1, 2]

        def body() -> None:
            w.u8(0xAA)
            w.u8(0xBB)

        p = w.target(target, "k", "t", body)
        p2 = w.target(target, "k", "t", body)
        self.assertIs(p, p2)
        w.pointer("u16", True, p, False, None)
        w.pointer("u16", True, None, False, 0)
        self.assertEqual(bytes(region.finish()), b"\x01\x05\x00\x00\x00\xaa\xbb")

    def test_alignment_constraints_and_overlap(self) -> None:
        region = rt.Region()
        w = rt.Writer(region)
        w.u8(1)
        a = w.place("a", None, lambda: w.u8(2), constraint=(4, 0))
        w.place("b", None, lambda: w.u8(3), fixed=2)
        out = bytes(region.finish())
        self.assertEqual(a.block.pos, 4)
        self.assertEqual(out, b"\x01\x00\x03\x00\x02")
        region = rt.Region()
        w = rt.Writer(region)
        w.u32(0, True)
        w.place("b", None, lambda: w.u8(3), fixed=2)
        self.assertEqual(code_of(region.finish)[0], "OVERLAP")

    def test_layout_items_order(self) -> None:
        region = rt.Region()
        w = rt.Writer(region)
        # The region's layout orders its root struct's targets (a struct's own `layout`).
        region.layout = ((("y",), (("align", 4),)), (("x",), ()))
        lroot = rt.LStruct()
        x = w.place("x", None, lambda: w.u8(0x11))
        y = w.place("y", None, lambda: w.u8(0x22))
        lroot.set("x", x)
        lroot.set("y", y)
        w.u8(0)
        region.lroot = lroot
        out = bytes(region.finish())
        self.assertEqual(out, b"\x00\x00\x00\x00\x22\x11")

    def test_layout_from_the_root_struct(self) -> None:
        # A layout computed by the struct's writer reaches a region without its own.
        region = rt.Region()
        w = rt.Writer(region)
        w.u8(0)
        lroot = rt.LStruct()
        lroot.set("x", w.place("x", None, lambda: w.u8(0x11)))
        lroot.layout = ((("x",), (("align", rt.layout_align(8)),)),)
        region.attach_root(lroot)
        self.assertEqual(bytes(region.finish()), b"\x00" + b"\x00" * 7 + b"\x11")
        self.assertEqual(code_of(lambda: rt.layout_align(0))[0], "RANGE")
        self.assertEqual(code_of(lambda: rt.layout_align(True))[0], "RANGE")
        self.assertEqual(code_of(lambda: rt.layout_pad(-1))[0], "RANGE")
        self.assertEqual(rt.layout_pad(0), 0)

    def test_ref_pointers(self) -> None:
        region = rt.Region()
        w = rt.Writer(region)
        start = w.offset
        w.str("abc", 1, "utf8", True, "until")
        w.ref_site("str", start, "abc")
        w.ref_pointer("u8", True, "str", "abc", lambda: b"abc\x00", False, None)
        w.ref_pointer("u8", True, "str", "zzz", lambda: b"zzz\x00", False, None)
        self.assertEqual(code_of(region.finish)[0], "REF")

    def test_deferred_values_and_extents(self) -> None:
        region = rt.Region()
        w = rt.Writer(region)
        e = w.extent()
        w.defer_prim("u8", True, lambda: e.size)
        w.bytes(b"xyz")
        w.close(e)
        self.assertEqual(bytes(region.finish()), b"\x04xyz")

    def test_sticky_layout_keeps_positions(self) -> None:
        region = rt.Region()
        region.sticky = StickyPolicy("default", 1, 8)
        w = rt.Writer(region)
        w.u8(0)
        p = w.place("p", None, lambda: w.u8(9))
        p.orig, p.orig_size = 6, 1
        out = bytes(region.finish())
        self.assertEqual(out, b"\x00\x00\x00\x00\x00\x00\x09")


class Codecs(unittest.TestCase):
    def test_reuse_tracks_objects(self) -> None:
        @dataclass
        class V:
            a: int

        v = V(1)
        rt.remember_codec(v, "s", b"ENC", b"\x01")
        self.assertEqual(rt.reuse_codec(v, "s", b"\x01"), b"ENC")
        self.assertIsNone(rt.reuse_codec(v, "s", b"\x02"))
        self.assertIsNone(rt.reuse_codec(V(1), "s", b"\x01"))

        owner = V(2)
        data = b"plain bytes value"
        rt.remember_codec(data, "t", b"E", data, owner)
        self.assertEqual(rt.reuse_codec(data, "t", data), b"E")
        del owner
        gc.collect()
        self.assertIsNone(rt.reuse_codec(data, "t", data))

    def test_codec_errors(self) -> None:
        class Bad:
            def decode(self, data: bytes, ctx: rt.CodecContext) -> bytes:
                raise ValueError("boom")

            def encode(self, data: bytes, ctx: rt.CodecContext) -> bytes:
                return b""

        self.assertEqual(code_of(lambda: rt.decode(Bad(), "bad", b"", rt.CodecContext(), False))[0], "CODEC")

        class Async:
            async def decode(self, data: bytes, ctx: rt.CodecContext) -> bytes:
                return data

            async def encode(self, data: bytes, ctx: rt.CodecContext) -> bytes:
                return data

        self.assertEqual(code_of(lambda: rt.decode(Async(), "a", b"x", rt.CodecContext(), False))[0], "CODEC")
        out = asyncio.run(rt.decode_async(Async(), "a", b"x", rt.CodecContext(), False))
        self.assertEqual(out, (b"x", 1))

    def test_streams(self) -> None:
        self.assertEqual(rt.join_stream([b"ab", b"c"]), b"abc")
        self.assertEqual(rt.split_by_sizes(b"abc", [1, 2]), [b"a", b"bc"])
        self.assertEqual(code_of(lambda: rt.split_by_sizes(b"abc", [1]))[0], "DERIVE")
        self.assertEqual(code_of(lambda: rt.slice_stream(b"abc", 2, 5))[0], "EOF")

    def test_leb128(self) -> None:
        self.assertEqual(rt.uleb128.write(624485), bytes.fromhex("e58e26"))
        self.assertEqual(rt.uleb128.read(bytes.fromhex("e58e26")), 624485)
        self.assertEqual(rt.sleb128.write(-123456), bytes.fromhex("c0bb78"))
        self.assertEqual(rt.sleb128.read(bytes.fromhex("c0bb78")), -123456)
        self.assertEqual(rt.uleb128.size(b"\x80\x80"), None)
        r = rt.Reader(bytes.fromhex("e58e2600"))
        self.assertEqual(r.extern(rt.uleb128, ()), 624485)
        self.assertEqual(r.pos, 3)


class Errors(unittest.TestCase):
    def test_paths(self) -> None:
        e = rt.YaffleError("CHECK", "bad", 16)
        e.prefix("x", -1, "")
        e.prefix("entries", 2)
        self.assertEqual(e.path, ["entries", 2, "x"])
        self.assertEqual(str(e), "CHECK at entries[2].x (offset 0x10): bad")
        e.sealed = True
        e.prefix("outer")
        self.assertEqual(e.path, ["entries", 2, "x"])
        r = rt.safe(lambda: rt.fail("EOF", "x"))
        self.assertFalse(r.ok)
        self.assertEqual(r.error.code if r.error else None, "EOF")


class Sources(unittest.TestCase):
    def test_async_source_rejected_by_sync_parse(self) -> None:
        class Src:
            size = 1

            async def read(self, off: int, n: int) -> bytes:
                return b"\x00"

        self.assertEqual(code_of(lambda: rt.read_all(Src()))[0], "INPUT")
        self.assertEqual(asyncio.run(rt.read_all_async(Src())), b"\x00")


if __name__ == "__main__":
    unittest.main()
