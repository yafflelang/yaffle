"""Text encodings: utf8 / ascii / latin1 (1-byte units), utf16 (2-byte units), utf32 (4-byte units).

Lengths always count code units. Reading stops the value at the first NUL unit. Invalid input on
read is a CHECK error; text that cannot be encoded (or contains NUL, which would read back
differently) is an INPUT error on write.
"""

from __future__ import annotations

from typing import Any

from .errors import YaffleError, describe, fail

__all__ = ["code_units", "encode_string", "encoded_bytes"]

#: Python codec per (encoding, little-endian).
_CODECS = {
    **{(enc, le): codec for enc, codec in (("utf8", "utf-8"), ("ascii", "ascii"), ("latin1", "latin-1"))
       for le in (True, False)},
    ("utf16", True): "utf-16-le",
    ("utf16", False): "utf-16-be",
    ("utf32", True): "utf-32-le",
    ("utf32", False): "utf-32-be",
}  # fmt: skip


def unit_of(enc: str) -> int:
    return 2 if enc == "utf16" else 4 if enc == "utf32" else 1


def find_nul_unit(buf: Any, start: int, n_units: int, unit: int) -> int:
    """Unit index (relative to ``start``) of the first NUL unit in ``n_units`` units, or -1."""
    end = start + n_units * unit
    if unit == 1:
        i: int = buf.find(b"\x00", start, end)
        return -1 if i < 0 else i - start
    pat = b"\x00" * unit
    p = start
    while True:
        i = buf.find(pat, p, end)
        if i < 0:
            return -1
        rel = i - start
        if rel % unit == 0:
            return rel // unit
        p = start + (rel // unit + 1) * unit


def decode_string(buf: Any, start: int, n_units: int, enc: str, le: bool, at: int) -> str:
    """Decodes ``n_units`` code units at ``start`` (already cut at the NUL unit). ``at`` is the
    absolute offset reported in errors."""
    raw = buf[start : start + n_units * unit_of(enc)]
    try:
        s: str = bytes(raw).decode(_CODECS[(enc, le)])
        return s
    except UnicodeDecodeError as e:
        if enc == "ascii":
            raise YaffleError("CHECK", f"byte 0x{raw[e.start]:x} is not ASCII", at + e.start) from None
        if enc == "utf8":
            raise YaffleError("CHECK", "invalid UTF-8", at) from None
        if enc == "utf16":
            raise YaffleError("CHECK", "invalid UTF-16 (lone surrogate)", at + e.start) from None
        raise YaffleError("CHECK", "invalid UTF-32 code point", at + e.start) from None


def encode_string(s: Any, enc: str, le: bool) -> bytes:
    """Encodes text without any terminator or padding."""
    if not isinstance(s, str):
        fail("INPUT", f"expected a string, got {describe(s)}")
    if "\x00" in s:
        fail("INPUT", "string contains NUL")
    try:
        return s.encode(_CODECS[(enc, le)])
    except UnicodeEncodeError as e:
        ch = s[e.start]
        if 0xD800 <= ord(ch) <= 0xDFFF:
            fail("INPUT", "string is not well-formed UTF-16 (lone surrogate)")
        fail("INPUT", f"character U+{ord(ch):04x} is not {enc}")


def code_units(s: Any, enc: str) -> int:
    """Code units ``s`` occupies in the given encoding (``len()`` of a string)."""
    if not isinstance(s, str):
        fail("INPUT", f"expected a string, got {describe(s)}")
    if enc == "utf8":
        return len(utf8(s))
    if enc == "utf32":
        return len(s)
    return len(s) + sum(1 for c in s if ord(c) > 0xFFFF)


def encoded_bytes(s: Any, enc: str) -> int:
    """Bytes ``s`` occupies in the given encoding (the IR builtin ``encodedLength``)."""
    return code_units(s, enc) * unit_of(enc)


def utf8(s: str) -> bytes:
    return s.encode("utf-8", "surrogatepass")
