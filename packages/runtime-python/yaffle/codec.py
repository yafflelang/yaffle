"""Codecs (``@via``): calling host codecs, and codec reuse.

Codec reuse (docs/IR.md §3.6): a value read from a codec's decoded side remembers the original
encoded bytes and a copy of the decoded bytes. When the same object is serialized and its plain
encoding is unchanged, the original encoded bytes are reused instead of re-encoding.
"""

from __future__ import annotations

import inspect
import weakref
from dataclasses import dataclass, field
from typing import Any

from .errors import YaffleError, fail

__all__ = ["CodecContext", "decode", "decode_async", "encode", "encode_async", "remember_codec", "reuse_codec"]


@dataclass
class CodecContext:
    """What a host codec receives besides the bytes (docs/IR.md §5)."""

    #: The codec's arguments in declaration order (ints, bytes for ``u8[n]``, strings, …).
    args: list[Any] = field(default_factory=list)
    #: The decoded size, when an inner ``@size`` layer gives it.
    output_size: int | None = None
    #: For ``@ranged`` codecs: the slice's offset within the encoded region.
    position: int | None = None


def _codec_error(name: str, op: str, e: BaseException, offset: int) -> YaffleError:
    if isinstance(e, YaffleError):
        return e
    return YaffleError("CODEC", f"codec {name} failed to {op}: {e}", offset)


def _not_async(out: Any, name: str, use: str, offset: int = -1) -> None:
    """Rejects an awaitable from a codec called synchronously."""
    if inspect.isawaitable(out):
        if inspect.iscoroutine(out):
            out.close()
        fail("CODEC", f"codec {name} is async; use {use}", offset)


def _decoded(name: str, out: Any, data: bytes, streaming: bool, offset: int) -> tuple[bytes, int]:
    """``(output, consumed)`` from what a codec's ``decode`` returned."""
    if streaming:
        if (
            not isinstance(out, tuple)
            or len(out) != 2
            or not isinstance(out[0], (bytes, bytearray, memoryview))
            or not isinstance(out[1], int)
        ):
            fail("CODEC", f"streaming codec {name} must return (output, consumed)", offset)
        output, consumed = out
        if consumed < 0 or consumed > len(data):
            fail("CODEC", f"streaming codec {name} consumed {consumed} of {len(data)} bytes", offset)
        return bytes(output), consumed
    if not isinstance(out, (bytes, bytearray, memoryview)):
        fail("CODEC", f"codec {name} decode returned {type(out).__name__}", offset)
    return bytes(out), len(data)


def _encoded(name: str, out: Any) -> bytes:
    if not isinstance(out, (bytes, bytearray, memoryview)):
        fail("CODEC", f"codec {name} encode returned {type(out).__name__}")
    return bytes(out)


def decode(
    codec: Any, name: str, data: bytes, ctx: CodecContext, streaming: bool, offset: int = -1
) -> tuple[bytes, int]:
    """Decodes synchronously: ``(output, consumed)``. An async codec here is a CODEC error."""
    try:
        out = codec.decode(data, ctx)
    except Exception as e:
        raise _codec_error(name, "decode", e, offset) from e
    _not_async(out, name, "parse_async", offset)
    return _decoded(name, out, data, streaming, offset)


async def decode_async(
    codec: Any, name: str, data: bytes, ctx: CodecContext, streaming: bool, offset: int = -1
) -> tuple[bytes, int]:
    try:
        out = codec.decode(data, ctx)
        if inspect.isawaitable(out):
            out = await out
    except Exception as e:
        raise _codec_error(name, "decode", e, offset) from e
    return _decoded(name, out, data, streaming, offset)


def encode(codec: Any, name: str, data: bytes | bytearray, ctx: CodecContext) -> bytes:
    try:
        out = codec.encode(bytes(data), ctx)
    except Exception as e:
        raise _codec_error(name, "encode", e, -1) from e
    _not_async(out, name, "serialize_async")
    return _encoded(name, out)


async def encode_async(codec: Any, name: str, data: bytes | bytearray, ctx: CodecContext) -> bytes:
    try:
        out = codec.encode(bytes(data), ctx)
        if inspect.isawaitable(out):
            out = await out
    except Exception as e:
        raise _codec_error(name, "encode", e, -1) from e
    return _encoded(name, out)


# ── reuse ──────────────────────────────────────────────────────────────────────

#: id(value) -> (value or a weak reference to it, {slot: (encoded, decoded)}). Either side may be
#: a function computing it: views over lazily decoded regions resolve them only on reuse.
_origins: dict[int, tuple[Any, dict[str, tuple[Any, Any]]]] = {}


def _drop(key: int) -> None:
    _origins.pop(key, None)


def _weakable(v: Any) -> bool:
    try:
        weakref.ref(v)
        return True
    except TypeError:
        return False


def _entry(value: Any) -> dict[str, tuple[Any, Any]] | None:
    """The slots remembered for ``value`` (None if none, or if they belong to a dead object that
    had the same id)."""
    entry = _origins.get(id(value))
    if entry is None:
        return None
    held = entry[0]
    return entry[1] if (held() if isinstance(held, weakref.ref) else held) is value else None


def remember_codec(value: Any, slot: str, encoded: Any, decoded: Any, owner: Any = None) -> None:
    """Remembers that ``value`` (the content inside a ``via`` layer) was decoded from ``encoded``.

    Values that support weak references (structs) are tracked for as long as they live. Others
    (bytes, lists) are kept until ``owner`` (the struct holding them) is garbage collected.
    """
    if value is None or isinstance(value, (bool, int, float)):
        return
    slots = _entry(value)
    if slots is None:
        key = id(value)
        if _weakable(value):
            _origins[key] = (weakref.ref(value, lambda _ref: _drop(key)), {})
        elif owner is not None and _weakable(owner):
            _origins[key] = (value, {})
            weakref.finalize(owner, _drop, key)
        else:
            return
        slots = _origins[key][1]
    slots[slot] = (
        encoded if callable(encoded) else bytes(encoded),
        decoded if callable(decoded) else bytes(decoded),
    )


def reuse_codec(value: Any, slot: str, plain: Any) -> bytes | None:
    """The original encoded bytes if ``value`` came from a parse and its plain encoding is unchanged."""
    slots = _entry(value) if value is not None else None
    o = slots.get(slot) if slots is not None else None
    if slots is None or o is None:
        return None
    enc, dec = o
    if callable(dec):
        dec = bytes(dec())
    if len(dec) != len(plain) or dec != plain:
        return None
    if callable(enc):
        enc = bytes(enc())
    slots[slot] = (enc, dec)
    out: bytes = enc
    return out
