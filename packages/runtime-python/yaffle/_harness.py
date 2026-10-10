"""Conformance harness: runs a batch of conformance cases through generated code.

Usage: ``python -m yaffle._harness <spec.json> <results-dir>``

The spec (written by the Python backend's conformance adapter) lists the cases of one case
directory: which generated module and class to use, the input bytes (hex or a file), the JSON,
and what is expected. One result file per case is written to the results directory
(``<index>.json``), with the actual canonical JSON, output bytes and error, and the harness's own
verdict (the runner re-checks them). See docs/CONFORMANCE.md.
"""

from __future__ import annotations

import asyncio
import importlib
import json
import math
import os
import re
import sys
import traceback
from typing import Any

from .api import file_source
from .commit import apply_patches
from .errors import YaffleError

_NOT_IMPLEMENTED = re.compile(r"not implemented|not supported", re.IGNORECASE)


class _Failed(Exception):
    """Ends a case with a message (not an error the case could expect)."""


def _type_name(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    return "object"


def _show(v: Any) -> str:
    s = json.dumps(v)
    return s if len(s) <= 120 else s[:120] + "…"


def json_diff(actual: Any, expected: Any, path: str = "") -> str | None:
    """The first difference between two canonical JSON values (key order significant), or None."""
    where = path or "/"
    ta, te = _type_name(actual), _type_name(expected)
    if ta != te:
        return f"{where}: expected {_show(expected)}, got {_show(actual)}"
    if ta == "array":
        if len(actual) != len(expected):
            return f"{where}: expected {len(expected)} elements, got {len(actual)}"
        for i, (a, e) in enumerate(zip(actual, expected)):
            d = json_diff(a, e, f"{path}/{i}")
            if d:
                return d
        return None
    if ta == "object":
        for k in expected:
            if k not in actual:
                return f"{path}/{k}: missing"
        for k in actual:
            if k not in expected:
                return f"{path}/{k}: unexpected"
        for k in expected:
            d = json_diff(actual[k], expected[k], f"{path}/{k}")
            if d:
                return d
        if list(actual) != list(expected):
            return f"{where}: fields are not in declaration order"
        return None
    if ta == "number":
        a, e = float(actual), float(expected)
        if a != e or (a == 0 and math.copysign(1.0, a) != math.copysign(1.0, e)):
            return f"{where}: expected {_show(expected)}, got {_show(actual)}"
        return None
    if actual != expected:
        return f"{where}: expected {_show(expected)}, got {_show(actual)}"
    return None


def _load_bytes(spec: Any) -> bytes | None:
    if spec is None:
        return None
    if isinstance(spec, str):
        return bytes.fromhex(re.sub(r"[\s_]+", "", spec))
    with open(spec["file"], "rb") as f:
        return f.read()


def _options(cls: Any, c: dict[str, Any]) -> dict[str, Any]:
    options: dict[str, Any] = cls.options_from_json(c.get("args") or {})
    if c.get("strict"):
        options["strict"] = True
    return options


class _Case:
    """One case: its spec, its generated class and the result being built."""

    def __init__(self, c: dict[str, Any], cls: Any, max_hex: int) -> None:
        self.c = c
        self.cls = cls
        self.max_hex = max_hex
        self.is_async = bool(c.get("async"))
        self.error: Any = c.get("error")
        self.result: dict[str, Any] = {"name": c["name"], "ok": False}
        self.phase = "serialize" if c.get("input") is not None else "parse"

    def set_bytes(self, out: bytes) -> None:
        if len(out) <= self.max_hex:
            self.result["bytes"] = bytes(out).hex()

    def expect_no_error(self, phase: str | None, what: str) -> None:
        """Fails the case if it expects an error (in ``phase``, if given): ``what`` succeeded."""
        if self.error and (phase is None or self.error.get("phase") == phase):
            raise _Failed(f"expected {self.error['code']}, but {what} succeeded")

    def check_json(self, actual: Any, mode: str, what: str) -> None:
        """Records the JSON read; fails if a parse error was expected or the JSON differs."""
        self.result["json"] = actual
        self.expect_no_error("parse", what)
        expected = self.c.get("json")
        if expected is not None:
            d = json_diff(actual, expected)
            if d:
                raise _Failed(f"{mode}: {d}")

    async def parse(self, data: bytes, options: dict[str, Any]) -> Any:
        if self.is_async:
            return await self.cls.parse_async(data, **options)
        return self.cls.parse(data, **options)

    async def serialize(self, value: Any, options: dict[str, Any]) -> bytes:
        write_options = {k: v for k, v in options.items() if k != "strict"}
        if self.is_async:
            out: bytes = await self.cls.serialize_async(value, **write_options)
        else:
            out = self.cls.serialize(value, **write_options)
        self.set_bytes(out)
        return out

    async def run(self) -> None:
        c = self.c
        options = _options(self.cls, c)
        data = _load_bytes(c.get("bytes"))
        if c.get("input") is not None:
            out = await self.serialize(self.cls.from_json(c["input"]), options)
            self.expect_no_error(None, "serialize")
            if data is None:
                raise _Failed("serialize case without bytes")
            if out != data:
                raise _Failed(f"serialize: expected {data.hex()}, got {self.result.get('bytes', '(large)')}")
            return
        if data is None:
            raise _Failed("parse case without bytes")
        value = await self.parse(data, options)
        self.check_json(value.to_json(), "parse", "parse")
        # Cases expecting a serialize error round-trip the JSON.
        rt = "json" if (self.error and self.error.get("phase") == "serialize") else c.get("roundtrip", True)
        if rt is False:
            return
        self.phase = "serialize"
        source = value if rt == "value" else self.cls.from_json(c["json"] if c.get("json") is not None else self.result["json"])
        out = await self.serialize(source, options)
        self.expect_no_error("serialize", "serialize")
        if out != data:
            i = 0
            n = min(len(out), len(data))
            while i < n and out[i] == data[i]:
                i += 1
            raise _Failed(f"roundtrip: bytes differ at offset 0x{i:x} (expected {len(data)} bytes, got {len(out)})")

    async def run_view(self) -> None:
        """View mode (docs/CONFORMANCE.md §7): read every field through the lazy view, then commit
        with no edits (which must reproduce the input)."""
        c = self.c
        options = _options(self.cls, c)
        spec = c.get("bytes")
        if spec is None:
            raise _Failed("view case without bytes")
        # A file is viewed through a memory-mapped source.
        src: Any = _load_bytes(spec) if isinstance(spec, str) else file_source(spec["file"])
        try:
            if self.is_async:
                v = self.cls.view_async(src, **options)
                actual = await v._to_json()
            else:
                v = self.cls.view(src, **options)
                actual = self.cls.to_json(v)  # reads every field through the view
            self.check_json(actual, "view", "reading the view")
            if c.get("roundtrip", True) is False:
                return
            self.phase = "serialize"
            orig = _load_bytes(spec)
            assert orig is not None
            if self.is_async:
                out = apply_patches(orig, await v._commit())
            else:
                out = v._commit()
            self.set_bytes(out)
            if orig != bytes(out):
                raise _Failed(f"commit with no edits changed the bytes ({len(orig)} → {len(out)} bytes)")
        finally:
            close = getattr(src, "close", None)
            if callable(close):
                close()

    def failed(self, e: BaseException) -> None:
        """Records that the case raised ``e`` in the current phase."""
        result = self.result
        if not isinstance(e, YaffleError):
            msg = str(e)
            if _NOT_IMPLEMENTED.search(msg):
                result["skipped"] = msg
            else:
                result["message"] = f"unexpected exception: {type(e).__name__}: {msg}\n{traceback.format_exc()}"
            return
        message = e.describe()
        err = {"phase": self.phase, "code": e.code, "path": list(e.path), "offset": e.offset, "message": message}
        result["error"] = err
        expected = self.error
        if not expected:
            if _NOT_IMPLEMENTED.search(message):
                result["skipped"] = message
            else:
                result["message"] = f"unexpected {e.code} error in {self.phase}: {message}"
        elif expected.get("phase") != self.phase:
            result["message"] = f"expected a {expected['phase']} error, got {e.code} in {self.phase}: {message}"
        elif e.code != expected.get("code"):
            result["message"] = f"expected {expected['code']}, got {e.code}: {message}"
        elif expected.get("path") is not None and [str(x) for x in e.path] != [str(x) for x in expected["path"]]:
            result["message"] = f"expected path {expected['path']}, got {list(e.path)} ({message})"
        else:
            result["ok"] = True


async def run_case(c: dict[str, Any], max_hex: int, mode: str = "parse") -> dict[str, Any]:
    try:
        cls = getattr(importlib.import_module(c["module"]), c["cls"])
    except Exception as e:  # pragma: no cover - generated code that doesn't import
        return {"name": c["name"], "ok": False, "message": f"cannot import generated code: {e}\n{traceback.format_exc()}"}
    case = _Case(c, cls, max_hex)
    try:
        await (case.run_view() if mode == "view" else case.run())
        case.result["ok"] = True
    except _Failed as f:
        case.result["message"] = str(f)
    except (KeyboardInterrupt, SystemExit):
        raise
    except BaseException as e:  # noqa: BLE001 - every failure is reported
        case.failed(e)
    return case.result


async def main(spec_path: str, out_dir: str) -> None:
    with open(spec_path, encoding="utf-8") as f:
        spec = json.load(f)
    # Real files nest deeply.
    sys.setrecursionlimit(max(sys.getrecursionlimit(), 200_000))
    os.makedirs(out_dir, exist_ok=True)
    max_hex = int(spec.get("maxHexBytes", 1 << 20))
    mode = str(spec.get("mode", "parse"))
    for i, c in enumerate(spec["cases"]):
        res = await run_case(c, max_hex, mode)
        tmp = os.path.join(out_dir, f"{i}.json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            try:
                json.dump(res, f, allow_nan=False)
            except (TypeError, ValueError) as e:
                f.seek(0)
                f.truncate()
                json.dump({"name": c["name"], "ok": False, "message": f"result is not JSON: {e}"}, f)
        os.replace(tmp, os.path.join(out_dir, f"{i}.json"))


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2]))
