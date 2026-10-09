"""What the generated root APIs (``X.parse``, ``X.serialize``, …) run on, and byte sources.

A source is a bytes-like object, or an object with a ``size`` and ``read(offset, length)``. If
``read`` returns an awaitable, the source is async: use ``parse_async`` (or an async view).
"""

from __future__ import annotations

import inspect
import mmap
import os
import sys
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Generic, Literal, Protocol, Sequence, TypeVar, Union

from .errors import YaffleError, fail
from .reader import Reader
from .writer import Region, Writer

__all__ = [
    "AsyncSource", "FileSource", "SafeResult", "Source", "SyncSource", "endian_option",
    "file_source", "parse_with", "parse_with_async", "read_all", "read_all_async", "safe",
    "safe_async", "serialize_with", "serialize_with_async",
]  # fmt: skip

T = TypeVar("T")


class SyncSource(Protocol):
    @property
    def size(self) -> int: ...

    def read(self, offset: int, length: int) -> bytes: ...


class AsyncSource(Protocol):
    @property
    def size(self) -> int: ...

    def read(self, offset: int, length: int) -> Awaitable[bytes]: ...


Source = Union[bytes, bytearray, memoryview, SyncSource, AsyncSource]


@dataclass
class SafeResult(Generic[T]):
    """The result of ``safe_parse``: ``ok`` with a ``value``, or not ``ok`` with an ``error``."""

    ok: bool
    value: T | None = None
    error: YaffleError | None = None


def ensure_recursion(limit: int = 100_000) -> None:
    """Raises the interpreter's recursion limit for deeply nested data (never lowers it)."""
    if sys.getrecursionlimit() < limit:
        sys.setrecursionlimit(limit)


def reject_path(source: Any) -> None:
    if isinstance(source, (str, os.PathLike)):
        fail("INPUT", "pass bytes or a source, not a path (use file_source(path))")


def read_all(source: Any) -> bytes:
    """Reads a whole sync source into memory."""
    if isinstance(source, (bytes, bytearray, memoryview)):
        return bytes(source)
    reject_path(source)
    out = source.read(0, source.size)
    if inspect.isawaitable(out):
        if inspect.iscoroutine(out):
            out.close()
        fail("INPUT", "this source is async; use parse_async or an async view")
    return bytes(out)


async def read_all_async(source: Any) -> bytes:
    """Reads a whole source (sync or async) into memory."""
    if isinstance(source, (bytes, bytearray, memoryview)):
        return bytes(source)
    out = source.read(0, source.size)
    if inspect.isawaitable(out):
        out = await out
    return bytes(out)


def parse_with(source: Any, strict: bool, read: Callable[[Reader], T]) -> T:
    """Runs a generated root reader over a sync source."""
    ensure_recursion()
    return read(Reader(read_all(source), strict))


async def parse_with_async(source: Any, strict: bool, read: Callable[[Reader], Any]) -> Any:
    """Runs a generated root reader (sync or async) over any source."""
    ensure_recursion()
    out = read(Reader(await read_all_async(source), strict))
    return await out if inspect.isawaitable(out) else out


def serialize_with(layout: Sequence[Any] | None, write: Callable[[Writer], Any]) -> bytes:
    """Runs a generated root writer in a fresh root region and returns the bytes."""
    ensure_recursion()
    region = Region(layout)
    region.attach_root(write(Writer(region)))
    return bytes(region.finish())


async def serialize_with_async(
    layout: Sequence[Any] | None, write: Callable[[Writer], Awaitable[Any]]
) -> bytes:
    ensure_recursion()
    region = Region(layout)
    region.attach_root(await write(Writer(region)))
    return bytes(region.finish())


def safe(fn: Callable[[], T]) -> SafeResult[T]:
    """Runs ``fn``; a raised :class:`YaffleError` becomes ``SafeResult(ok=False, error=…)``."""
    try:
        return SafeResult(True, fn())
    except YaffleError as e:
        return SafeResult(False, None, e)


async def safe_async(fn: Callable[[], Awaitable[T]]) -> SafeResult[T]:
    try:
        return SafeResult(True, await fn())
    except YaffleError as e:
        return SafeResult(False, None, e)


def endian_option(v: Any) -> Literal["le", "be"]:
    if v == "le":
        return "le"
    if v == "be":
        return "be"
    fail("INPUT", f'endian must be "le" or "be", got {v!r}')


class FileSource:
    """A sync random-access source over a file (``size``, ``read(offset, length)``).

    ``buffer()`` memory-maps the file, so views read only the pages they touch. With
    ``writable=True`` the source also has ``write`` and ``truncate``, and a view's ``_commit``
    writes the edits back to the file.
    """

    def __init__(self, path: str | os.PathLike[str], writable: bool = False) -> None:
        self._f = open(path, "r+b" if writable else "rb")  # noqa: SIM115
        self._f.seek(0, os.SEEK_END)
        self.size = self._f.tell()
        self.writable = writable
        self._map: mmap.mmap | None = None
        if not writable:
            # Views write commits back to sources that have `write`.
            self.write = None  # type: ignore[assignment, method-assign]

    def read(self, offset: int, length: int) -> bytes:
        self._f.seek(offset)
        data = self._f.read(length)
        if len(data) != length:
            fail("EOF", "short read from file", offset)
        return data

    def buffer(self) -> Any:
        """The file's bytes as a read-only memory map (bytes for an empty file)."""
        if self.size == 0:
            return b""
        if self._map is None:
            self._map = mmap.mmap(self._f.fileno(), 0, access=mmap.ACCESS_READ)
        return self._map

    def copy_buffer(self) -> Any:
        """A private copy-on-write map of the file: a view's in-place patches copy only the pages
        they write, and the file is not changed."""
        if self.size == 0:
            return bytearray()
        return mmap.mmap(self._f.fileno(), 0, access=mmap.ACCESS_COPY)

    def write(self, offset: int, data: bytes) -> None:
        self._drop_map()
        self._f.seek(offset)
        self._f.write(data)
        self._f.flush()
        self.size = max(self.size, offset + len(data))

    def truncate(self, n: int) -> None:
        self._drop_map()
        self._f.truncate(n)
        self.size = n

    def _drop_map(self) -> None:
        if self._map is not None:
            self._map.close()
            self._map = None

    def close(self) -> None:
        self._drop_map()
        self._f.close()

    def __enter__(self) -> FileSource:
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


def file_source(path: str | os.PathLike[str], writable: bool = False) -> FileSource:
    """A source over a file (memory-mapped for views; ``writable`` for committing views back)."""
    return FileSource(path, writable)
