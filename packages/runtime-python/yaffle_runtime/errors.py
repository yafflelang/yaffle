"""Errors.

Every failure the runtime or generated code reports is a :class:`YaffleError` with a stable
``code`` (docs/CONFORMANCE.md §4), the ``path`` from the root (field names and array indices) and
an absolute byte ``offset`` (-1 on write).
"""

from __future__ import annotations

from typing import Any, Literal, NoReturn, Sequence, Union

__all__ = ["ErrorCode", "PathSegment", "YaffleError", "describe", "fail", "format_path"]

ErrorCode = Literal["EOF", "CHECK", "RANGE", "UNION", "CODEC", "INPUT", "DERIVE", "REF", "OVERLAP"]
PathSegment = Union[str, int]


def format_path(path: Sequence[PathSegment]) -> str:
    s = ""
    for seg in path:
        if isinstance(seg, int):
            s += f"[{seg}]"
        else:
            s += f".{seg}" if s else seg
    return s


def clean_path(segments: Sequence[PathSegment]) -> list[PathSegment]:
    """Drops the placeholders generated code uses for "no field" ("") and "no index" (-1)."""
    return [s for s in segments if (s >= 0 if isinstance(s, int) else s != "")]


class YaffleError(Exception):
    """A read or write failure with a code, a path from the root and an absolute offset."""

    code: ErrorCode
    path: list[PathSegment]
    offset: int
    detail: str
    causes: list[YaffleError] | None
    #: The path is complete: errors raised after layout know their whole path.
    sealed: bool

    def __init__(
        self,
        code: ErrorCode,
        detail: str,
        offset: int = -1,
        path: list[PathSegment] | None = None,
        causes: list[YaffleError] | None = None,
    ) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.offset = offset
        self.path = path if path is not None else []
        self.causes = causes
        self.sealed = False

    def describe(self) -> str:
        """Renders ``CODE at a.b[3] (offset 0x10): detail``."""
        where = f" at {format_path(self.path)}" if self.path else ""
        off = f" (offset 0x{self.offset:x})" if self.offset >= 0 else ""
        return f"{self.code}{where}{off}: {self.detail}"

    @property
    def message(self) -> str:
        return self.describe()

    def __str__(self) -> str:
        return self.describe()

    def prefix(self, *segments: PathSegment) -> YaffleError:
        """Adds outer path segments while the error unwinds through generated code (placeholders
        are skipped)."""
        if not self.sealed:
            self.path[0:0] = clean_path(segments)
        return self


def fail(code: ErrorCode, detail: str, offset: int = -1) -> NoReturn:
    """Raises a :class:`YaffleError`."""
    raise YaffleError(code, detail, offset)


def seal_path(e: BaseException, path: Sequence[PathSegment]) -> None:
    """Gives ``e`` its complete path from the root (no further prefixes are added)."""
    if isinstance(e, YaffleError) and not e.sealed:
        e.prefix(*path)
        e.sealed = True


def host_error(e: BaseException, code: ErrorCode, what: str, offset: int = -1) -> YaffleError:
    """Wraps a host failure (codec, extern) unless it already is a YaffleError."""
    if isinstance(e, YaffleError):
        return e
    return YaffleError(code, f"{what}: {e}", offset)


def describe(v: Any) -> str:
    """A short description of a value for error messages."""
    if v is None:
        return "None"
    if isinstance(v, bool):
        return str(v)
    if isinstance(v, str):
        return repr(v if len(v) <= 40 else v[:40] + "…")
    if isinstance(v, (bytes, bytearray, memoryview)):
        return f"bytes({len(v)})"
    if isinstance(v, list):
        return f"list({len(v)})"
    if isinstance(v, (int, float)):
        return repr(v)
    return type(v).__name__
