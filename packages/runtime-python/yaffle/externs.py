"""Host code: loading extern implementations, calling them, and the built-in extern types
(LEB128). Any exception from host code is a CODEC error."""

from __future__ import annotations

import hashlib
import importlib
import importlib.util
import os
import sys
from typing import Any, Callable, NoReturn

from .errors import YaffleError, describe, fail

__all__ = ["call_host", "host_float", "host_int", "load_extern", "missing_extern", "sleb128", "uleb128"]


def call_host(fn: Callable[..., Any], name: str, *args: Any) -> Any:
    """Calls a host function (extern fn)."""
    try:
        return fn(*args)
    except YaffleError:
        raise
    except Exception as e:
        raise YaffleError("CODEC", f"extern {name}: {e}") from e


def host_int(v: Any, name: str) -> int:
    """Validates an integer returned by host code."""
    if isinstance(v, int) and not isinstance(v, bool):
        return int(v)
    if isinstance(v, float) and v.is_integer():
        return int(v)
    fail("CODEC", f"extern {name} returned {describe(v)}, expected an integer")


def host_float(v: Any, name: str) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        fail("CODEC", f"extern {name} returned {describe(v)}, expected a number")
    return float(v)


class _Missing:
    """Stands in for an extern without a configured implementation: fails when used."""

    def __init__(self, name: str) -> None:
        self._name = name

    def _fail(self, *args: Any, **kw: Any) -> NoReturn:
        fail("INPUT", f"extern {self._name} has no implementation (configure targets.python.externs)")

    def __getattr__(self, attr: str) -> Any:
        return self._fail

    def __call__(self, *args: Any, **kw: Any) -> NoReturn:
        self._fail()


def missing_extern(name: str) -> Any:
    return _Missing(name)


def load_extern(module_file: str, spec: str, item: str) -> Any:
    """Loads an extern implementation: ``item`` of a file (relative to the directory of
    ``module_file``, the generated module, or absolute) or of an importable module. Files are
    loaded by path, so extern files need not be packages."""
    if not (spec.startswith(("./", "../", "/")) or spec.endswith(".py")):
        return getattr(importlib.import_module(spec), item)
    path = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(module_file)), spec))
    name = "_yaffle_extern_" + hashlib.sha1(path.encode()).hexdigest()[:16]
    mod = sys.modules.get(name)
    if mod is None:
        s = importlib.util.spec_from_file_location(name, path)
        if s is None or s.loader is None:
            raise ImportError(f"cannot load extern module {path}")
        mod = importlib.util.module_from_spec(s)
        sys.modules[name] = mod
        try:
            s.loader.exec_module(mod)
        except BaseException:
            del sys.modules[name]
            raise
    return getattr(mod, item)


# ── built-in extern types ──────────────────────────────────────────────────────


class _ULeb128:
    """Unsigned LEB128."""

    def size(self, data: bytes, max_bytes: int = 10) -> int | None:
        for i in range(min(len(data), max_bytes)):
            if not data[i] & 0x80:
                return i + 1
        if len(data) >= max_bytes:
            fail("CHECK", f"LEB128 longer than {max_bytes} bytes")
        return None

    def read(self, data: bytes, max_bytes: int = 10) -> int:
        v = 0
        for b in reversed(data):
            v = (v << 7) | (b & 0x7F)
        return v

    def write(self, value: int, max_bytes: int = 10) -> bytes:
        v = int(value)
        if v < 0:
            fail("RANGE", "uleb128 cannot encode a negative value")
        out = bytearray()
        while True:
            b = v & 0x7F
            v >>= 7
            out.append(b | 0x80 if v else b)
            if not v:
                return bytes(out)


class _SLeb128(_ULeb128):
    """Signed LEB128."""

    def read(self, data: bytes, max_bytes: int = 10) -> int:
        v = super().read(data)
        return v - (1 << (len(data) * 7)) if data and data[-1] & 0x40 else v

    def write(self, value: int, max_bytes: int = 10) -> bytes:
        v = int(value)
        out = bytearray()
        while True:
            b = v & 0x7F
            v >>= 7
            done = (v == 0 and not b & 0x40) or (v == -1 and b & 0x40)
            out.append(b if done else b | 0x80)
            if done:
                return bytes(out)


uleb128 = _ULeb128()
sleb128 = _SLeb128()
