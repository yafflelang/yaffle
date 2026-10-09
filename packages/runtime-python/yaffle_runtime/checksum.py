"""Built-in checksums (docs/IR.md §5): crc32 (IEEE 802.3, reflected) and adler32."""

from __future__ import annotations

import zlib
from typing import Any

from .strings import utf8

__all__ = ["adler32", "crc32"]


def crc32(data: Any, prev: int = 0) -> int:
    """CRC-32 of ``data`` (bytes, or a string as UTF-8). ``prev`` continues a running checksum."""
    return zlib.crc32(utf8(data) if isinstance(data, str) else data, prev) & 0xFFFFFFFF


def adler32(data: Any, prev: int = 1) -> int:
    """Adler-32 of ``data`` (bytes, or a string as UTF-8). ``prev`` continues a running checksum."""
    return zlib.adler32(utf8(data) if isinstance(data, str) else data, prev) & 0xFFFFFFFF
