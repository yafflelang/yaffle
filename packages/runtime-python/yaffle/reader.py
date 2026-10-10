"""The read context (docs/IR.md §2.1) used by generated readers.

Position, base, region end, array index and strict flag over a byte buffer, plus primitive,
string, padding, target and union readers. Positions are absolute within the buffer; ``base`` and
``end`` too.
"""

from __future__ import annotations

import builtins
import struct
from typing import Any, Awaitable, Callable, NoReturn, Sequence, TypeVar

from .errors import ErrorCode, YaffleError, host_error
from .prim import PRIMS, read_prim
from .strings import decode_string, find_nul_unit

__all__ = ["Reader"]

T = TypeVar("T")

#: Padding fill: a byte value, or a function of the byte's index within the padding run.
Fill = Any


def fill_byte(fill: Fill, i: int) -> int:
    if isinstance(fill, int):
        return fill & 0xFF
    return int(fill(i)) & 0xFF


def _unpackers(fmt: str) -> tuple[Callable[..., tuple[Any, ...]], Callable[..., tuple[Any, ...]]]:
    """(big-endian, little-endian) ``unpack_from``, indexable by a bool ``le``."""
    return (struct.Struct(">" + fmt).unpack_from, struct.Struct("<" + fmt).unpack_from)


_U16 = _unpackers("H")
_I16 = _unpackers("h")
_U32 = _unpackers("I")
_I32 = _unpackers("i")
_U64 = _unpackers("Q")
_I64 = _unpackers("q")
_F16 = _unpackers("e")
_F32 = _unpackers("f")
_F64 = _unpackers("d")
_I8 = struct.Struct("b").unpack_from


class Reader:
    """Reads one region of bytes. Generated readers call its methods; the primitive readers are
    written out one by one because they are the hot path of every parse."""

    __slots__ = (
        "buf",
        "size",
        "pos",
        "base",
        "end",
        "index",
        "strict",
        "max_end",
        "into",
        "inline_end",
        "last_target_end",
        "ident",
        "ident_end",
        "in_progress",
        "outer",
        "frozen",
    )

    def __init__(self, buf: Any, strict: builtins.bool = False, outer: int | None = None) -> None:
        if isinstance(buf, memoryview):
            buf = builtins.bytes(buf)
        #: bytes, or a bytearray or mmap for views (slices of those are converted to bytes).
        self.buf: Any = buf
        self.frozen = isinstance(buf, builtins.bytes)
        self.size = len(buf)
        self.pos = 0
        self.base = 0
        self.end = len(buf)
        self.index = -1
        self.strict = strict
        #: Furthest position read inside the current base (a base struct consumes it all).
        self.max_end = 0
        #: Object a struct reader fills instead of a new one (identity registered first: cycles).
        self.into: Any = None
        #: Set by a base struct's scan: the end of its inline bytes (before its targets).
        self.inline_end = -1
        #: End position of the last target read with ``target()``.
        self.last_target_end = 0
        #: Target identity within this region: (address, type key) -> value, and its end.
        self.ident: dict[Any, Any] = {}
        self.ident_end: dict[Any, int] = {}
        self.in_progress: set[Any] = set()
        #: Offset reported for errors inside a decoded region (the encoded window outside).
        self.outer = outer

    def _derived(self, data: Any, at: int) -> Reader:
        """A reader over a fresh byte space read for this one (a stream, a codec's output)."""
        r = Reader(data, self.strict, self.outer if self.outer is not None else at)
        r.into = self.into
        self.into = None
        return r

    def sub(self, data: Any) -> Reader:
        """A reader for a stream: base 0, end = length."""
        return self._derived(data, self.pos)

    def decoded(self, data: Any, at: int) -> Reader:
        """A reader over a codec's decoded output."""
        return self._derived(data, at)

    def take_into(self, cls: type[T]) -> T:
        """Called first by every generated struct reader: the pre-registered object, or a new one."""
        o = self.into
        if o is None:
            return cls.__new__(cls)
        self.into = None
        v: T = o
        return v

    def peek_bytes(self, start: int, end: int) -> builtins.bytes:
        """Bytes ``[start, end)`` (absolute) without moving ``pos``."""
        if start < 0 or end > self.size or start > end:
            self.fail("EOF", f"range [0x{start:x}, 0x{end:x}) is outside the data", start)
        out = self.buf[start:end]
        return out if self.frozen else builtins.bytes(out)

    # ── errors ──────────────────────────────────────────────────────────────

    def at(self, offset: int) -> int:
        """The offset errors report for ``offset`` (inside a decoded region: the region's)."""
        return self.outer if self.outer is not None else offset

    def fail(self, code: ErrorCode, detail: builtins.str, offset: int | None = None) -> NoReturn:
        raise YaffleError(code, detail, self.at(self.pos if offset is None else offset))

    def check_fail(self, message: builtins.str, offset: int) -> NoReturn:
        self.fail("CHECK", f"check failed: {message}", offset)

    def _eof(self, n: int) -> NoReturn:
        self.fail("EOF", f"need {n} bytes at 0x{self.pos:x}, region ends at 0x{self.end:x}")

    # ── windows ─────────────────────────────────────────────────────────────

    def window(self, n: int) -> int:
        """Narrows the region to ``n`` bytes from ``pos``; returns the previous end."""
        saved = self.end
        if not isinstance(n, int) or n < 0:
            self.fail("RANGE", f"invalid size {n}")
        if self.pos + n > saved:
            self.fail("EOF", f"size {n} at 0x{self.pos:x} exceeds the region end 0x{saved:x}")
        self.end = self.pos + n
        return saved

    def close_window(self, saved: int, strict: builtins.bool) -> None:
        """Skips the rest of the window (padding; strict: zero) and restores the outer end."""
        left = self.end - self.pos
        if left > 0:
            self.pad(left, 0, strict)
        self.end = saved

    # ── integers and floats ─────────────────────────────────────────────────

    def u8(self) -> int:
        p = self.pos
        if p >= self.end:
            self._eof(1)
        self.pos = p + 1
        v: int = self.buf[p]
        return v

    def i8(self) -> int:
        p = self.pos
        if p >= self.end:
            self._eof(1)
        self.pos = p + 1
        v: int = _I8(self.buf, p)[0]
        return v

    def u16(self, le: builtins.bool) -> int:
        p = self.pos
        e = p + 2
        if e > self.end:
            self._eof(2)
        self.pos = e
        v: int = _U16[le](self.buf, p)[0]
        return v

    def i16(self, le: builtins.bool) -> int:
        p = self.pos
        e = p + 2
        if e > self.end:
            self._eof(2)
        self.pos = e
        v: int = _I16[le](self.buf, p)[0]
        return v

    def u32(self, le: builtins.bool) -> int:
        p = self.pos
        e = p + 4
        if e > self.end:
            self._eof(4)
        self.pos = e
        v: int = _U32[le](self.buf, p)[0]
        return v

    def i32(self, le: builtins.bool) -> int:
        p = self.pos
        e = p + 4
        if e > self.end:
            self._eof(4)
        self.pos = e
        v: int = _I32[le](self.buf, p)[0]
        return v

    def u64(self, le: builtins.bool) -> int:
        p = self.pos
        e = p + 8
        if e > self.end:
            self._eof(8)
        self.pos = e
        v: int = _U64[le](self.buf, p)[0]
        return v

    def i64(self, le: builtins.bool) -> int:
        p = self.pos
        e = p + 8
        if e > self.end:
            self._eof(8)
        self.pos = e
        v: int = _I64[le](self.buf, p)[0]
        return v

    def f16(self, le: builtins.bool) -> float:
        p = self.pos
        e = p + 2
        if e > self.end:
            self._eof(2)
        self.pos = e
        v: float = _F16[le](self.buf, p)[0]
        return v

    def f32(self, le: builtins.bool) -> float:
        p = self.pos
        e = p + 4
        if e > self.end:
            self._eof(4)
        self.pos = e
        v: float = _F32[le](self.buf, p)[0]
        return v

    def f64(self, le: builtins.bool) -> float:
        p = self.pos
        e = p + 8
        if e > self.end:
            self._eof(8)
        self.pos = e
        v: float = _F64[le](self.buf, p)[0]
        return v

    def u_n(self, size: int, le: builtins.bool) -> int:
        """Unsigned N-byte integer: u24, u40, u48, u56."""
        p = self.pos
        e = p + size
        if e > self.end:
            self._eof(size)
        self.pos = e
        return int.from_bytes(self.buf[p:e], "little" if le else "big")

    def i_n(self, size: int, le: builtins.bool) -> int:
        """Signed N-byte integer: i24, i40, i48, i56."""
        p = self.pos
        e = p + size
        if e > self.end:
            self._eof(size)
        self.pos = e
        return int.from_bytes(self.buf[p:e], "little" if le else "big", signed=True)

    def prim(self, kind: builtins.str, le: builtins.bool) -> int | float:
        """Any primitive."""
        size = PRIMS[kind].size
        p = self.pos
        if p + size > self.end:
            self._eof(size)
        self.pos = p + size
        return read_prim(self.buf, p, kind, le)

    def bool(self, strict: builtins.bool) -> builtins.bool:
        at = self.pos
        b = self.u8()
        if strict and b > 1:
            self.fail("CHECK", f"bool byte 0x{b:x} is not 0 or 1", at)
        return b != 0

    def count(self, v: int, unit: int = 1, what: builtins.str = "length") -> int:
        """A count read from the data: negative is RANGE; more than any region holds is EOF."""
        if v < 0:
            self.fail("RANGE", f"{what} {v} is negative")
        if v * max(unit, 1) > (1 << 53):
            self.fail("EOF", f"{what} {v} needs more than the {max(0, self.end - self.pos)} bytes left")
        return int(v)

    # ── bytes and strings ───────────────────────────────────────────────────

    def bytes(self, n: int) -> builtins.bytes:
        p = self.pos
        e = p + n
        if n < 0 or e > self.end:
            self._eof(n)
        self.pos = e
        out = self.buf[p:e]
        return out if self.frozen else builtins.bytes(out)

    def bytes_until(self, term: int) -> builtins.bytes:
        """Bytes up to a terminator byte (consumed, not part of the value)."""
        i = self.buf.find(builtins.bytes((term & 0xFF,)), self.pos, self.end)
        if i < 0:
            self.fail("EOF", "terminator not found before the region end")
        out = self.buf[self.pos : i]
        self.pos = i + 1
        return out if self.frozen else builtins.bytes(out)

    def bytes_rest(self) -> builtins.bytes:
        return self.bytes(self.end - self.pos)

    def str(self, n_units: int, unit: int, enc: builtins.str, le: builtins.bool) -> builtins.str:
        """Fixed length: ``n_units`` code units; the value stops at the first NUL unit."""
        n = n_units * unit
        p = self.pos
        if p + n > self.end:
            self._eof(n)
        nul = find_nul_unit(self.buf, p, n_units, unit)
        s = decode_string(self.buf, p, n_units if nul < 0 else nul, enc, le, self.at(p))
        self.pos = p + n
        return s

    def _nul_unit(self, unit: int) -> int:
        """Units before the next NUL unit (EOF if there is none in the region)."""
        i = find_nul_unit(self.buf, self.pos, (self.end - self.pos) // unit, unit)
        if i < 0:
            self.fail("EOF", "terminator not found before the region end")
        return i

    def str_until(self, unit: int, enc: builtins.str, le: builtins.bool) -> builtins.str:
        """NUL-terminated: units up to a NUL unit (consumed)."""
        s = self.str(self._nul_unit(unit), unit, enc, le)
        self.pos += unit
        return s

    def str_rest(self, unit: int, enc: builtins.str, le: builtins.bool) -> builtins.str:
        """To the end of the region (the value stops at the first NUL unit)."""
        return self.str((self.end - self.pos) // unit, unit, enc, le)

    # ── padding ─────────────────────────────────────────────────────────────

    def pad(self, n: int, fill: Fill, strict: builtins.bool) -> None:
        """Skips ``n`` padding bytes; in strict mode they must match the fill."""
        if not isinstance(n, int) or n < 0:
            self.fail("RANGE", f"invalid padding length {n}")
        p = self.pos
        if p + n > self.end:
            self._eof(n)
        if strict:
            self._check_fill(p, self.buf[p : p + n], fill, 0)
        self.pos = p + n

    def _check_fill(self, at: int, data: Any, fill: Fill, first: int) -> None:
        """Padding bytes ``data`` at ``at`` (byte ``first`` of their run) must match the fill."""
        for k, byte in enumerate(data):
            want = fill_byte(fill, first + k)
            if byte != want:
                self.fail("CHECK", f"padding byte 0x{byte:x} is not 0x{want:x}", at + k)

    def align(
        self, to: int, fill: Fill, strict: builtins.bool, offset: int = 0, file: builtins.bool = False
    ) -> None:
        """Pads until ``(pos - origin + offset) % to == 0``. The origin is the base, or with
        ``file`` the start of the byte space."""
        if not isinstance(to, int) or to <= 0:
            self.fail("RANGE", f"invalid alignment {to}")
        rel = self.pos - (0 if file else self.base) + offset
        self.pad((to - rel % to) % to, fill, strict)

    def pad_until(self, start: int, size: int, fill: Fill, strict: builtins.bool) -> None:
        """``padUntil(size)`` after content that started at ``start``."""
        used = self.pos - start
        if used > size:
            self.fail("CHECK", f"content of {used} bytes exceeds padUntil({size})", start)
        self.pad(size - used, fill, strict)

    # ── targets ─────────────────────────────────────────────────────────────
    #
    # A target is read at its address without moving ``pos``. The same address and type key give
    # the same value object within a region. Struct targets register their object before reading
    # it, so cycles resolve to it.

    def _known(self, k: Any, addr: int) -> Any:
        """The value already read at ``k`` (records where it ended)."""
        self.last_target_end = self.ident_end.get(k, addr)
        return self.ident[k]

    def _check_addr(self, addr: int) -> None:
        if not isinstance(addr, int) or addr < 0 or addr > self.size:
            self.fail("EOF", f"target address 0x{addr:x} is outside the data")

    def _move(self, addr: int) -> tuple[int, int]:
        """Moves to a target's address; returns the position and index to restore."""
        saved = (self.pos, self.index)
        self.pos = addr
        self.index = -1
        return saved

    def _read_end(self, k: Any) -> None:
        """Records where the target at ``k`` ended."""
        self.ident_end[k] = self.pos
        self.last_target_end = self.pos
        if self.pos > self.max_end:
            self.max_end = self.pos

    def _begin(self, addr: int, key: Any) -> tuple[Any, tuple[int, int]]:
        k = (addr, key)
        self._check_addr(addr)
        if k in self.in_progress:
            self.fail("CHECK", f"pointer cycle at 0x{addr:x}")
        self.in_progress.add(k)
        return k, self._move(addr)

    def _end(self, k: Any, saved: tuple[int, int]) -> None:
        self.in_progress.discard(k)
        self.pos, self.index = saved

    def target(self, addr: int, key: Any, read: Callable[[], T]) -> T:
        """Reads a pointer or ``at`` target at ``addr``."""
        if (addr, key) in self.ident:
            v: T = self._known((addr, key), addr)
            return v
        k, saved = self._begin(addr, key)
        try:
            v = self.ident[k] = read()
            self._read_end(k)
            return v
        finally:
            self._end(k, saved)

    async def target_async(self, addr: int, key: Any, read: Callable[[], Awaitable[T]]) -> T:
        if (addr, key) in self.ident:
            v: T = self._known((addr, key), addr)
            return v
        k, saved = self._begin(addr, key)
        try:
            v = self.ident[k] = await read()
            self._read_end(k)
            return v
        finally:
            self._end(k, saved)

    def _begin_struct(self, addr: int, key: Any, cls: Any) -> tuple[Any, tuple[int, int]]:
        self._check_addr(addr)
        k = (addr, key)
        obj = self.ident[k] = cls.__new__(cls)
        self.ident_end[k] = addr
        saved = self._move(addr)
        self.into = obj
        return k, saved

    def target_struct(self, addr: int, key: Any, read: Callable[[], T], cls: Any) -> T:
        """A struct target: its object is registered before its contents are read."""
        if self.ident.get((addr, key)) is not None:
            v: T = self._known((addr, key), addr)
            return v
        k, saved = self._begin_struct(addr, key, cls)
        try:
            v = read()
            self._read_end(k)
            return v
        except BaseException:
            del self.ident[k]
            raise
        finally:
            self.into = None
            self.pos, self.index = saved

    async def target_struct_async(
        self, addr: int, key: Any, read: Callable[[], Awaitable[T]], cls: Any
    ) -> T:
        if self.ident.get((addr, key)) is not None:
            v: T = self._known((addr, key), addr)
            return v
        k, saved = self._begin_struct(addr, key, cls)
        try:
            v = await read()
            self._read_end(k)
            return v
        except BaseException:
            del self.ident[k]
            raise
        finally:
            self.into = None
            self.pos, self.index = saved

    def _inline_object(self, key: Any, cls: Any) -> None:
        """The object of an inline struct of a type pointers can target: one per (address, type)."""
        k = (self.pos, key)
        obj = self.ident.get(k)
        if obj is None:
            obj = self.ident[k] = cls.__new__(cls)
        self.into = obj

    def inline(self, key: Any, read: Callable[[], T], cls: Any) -> T:
        self._inline_object(key, cls)
        try:
            return read()
        finally:
            self.into = None

    async def inline_async(self, key: Any, read: Callable[[], Awaitable[T]], cls: Any) -> T:
        self._inline_object(key, cls)
        try:
            return await read()
        finally:
            self.into = None

    def peek_at(self, addr: int, read: Callable[[], T]) -> T:
        """Runs ``read`` at ``addr`` and restores ``pos`` (no identity tracking)."""
        save = self.pos
        self.pos = addr
        try:
            v = read()
            self.max_end = max(self.max_end, self.pos)
            return v
        finally:
            self.pos = save

    async def peek_at_async(self, addr: int, read: Callable[[], Awaitable[T]]) -> T:
        save = self.pos
        self.pos = addr
        try:
            v = await read()
            self.max_end = max(self.max_end, self.pos)
            return v
        finally:
            self.pos = save

    # ── unions ──────────────────────────────────────────────────────────────

    def union(self, variants: Sequence[tuple[builtins.str, Callable[[], Any]]]) -> Any:
        """Tries each variant at ``pos``; the first that reads without error wins."""
        from .jsonc import Variant

        start, save_end = self.pos, self.end
        errors: list[YaffleError] = []
        for name, read in variants:
            try:
                return Variant(name, read())
            except YaffleError as e:
                errors.append(e.prefix(name))
                self.pos, self.end = start, save_end
        self._union_fail(errors, start)

    async def union_async(
        self, variants: Sequence[tuple[builtins.str, Callable[[], Awaitable[Any]]]]
    ) -> Any:
        from .jsonc import Variant

        start, save_end = self.pos, self.end
        errors: list[YaffleError] = []
        for name, read in variants:
            try:
                return Variant(name, await read())
            except YaffleError as e:
                errors.append(e.prefix(name))
                self.pos, self.end = start, save_end
        self._union_fail(errors, start)

    def _union_fail(self, errors: list[YaffleError], start: int) -> NoReturn:
        detail = f"no variant matched ({'; '.join(e.describe() for e in errors)})"
        raise YaffleError("UNION", detail, self.at(start), [], errors)

    # ── extern types ────────────────────────────────────────────────────────

    def probe(self, n: int) -> builtins.bytes:
        """``n`` bytes at ``pos`` (within the region), without moving ``pos``."""
        return builtins.bytes(self.buf[self.pos : self.pos + n])

    def extern(self, host: Any, args: Sequence[Any], fixed_size: int | None = None) -> Any:
        """Reads an extern type: host ``size()`` (unless fixed) on a growing probe, then ``read()``."""
        start = self.pos
        size = fixed_size
        if size is None:
            n = min(self.end - self.pos, 16)
            while True:
                try:
                    s = host.size(self.probe(n), *args)
                except Exception as e:
                    raise host_error(e, "CODEC", "extern type size()", self.at(start)) from e
                if s is not None:
                    size = int(s)
                    break
                if n >= self.end - self.pos:
                    self.fail("EOF", "extern type needs more bytes than the region has")
                n = min(self.end - self.pos, n * 2)
        data = self.bytes(size)
        try:
            return host.read(data, *args)
        except Exception as e:
            raise host_error(e, "CODEC", "extern type read()", self.at(start)) from e
