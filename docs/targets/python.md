# Python target

The Python backend (`packages/compiler/src/backends/python`) turns the IR into a Python package
with one module per IR module, over the pure-Python runtime `yaffle_runtime`
(`packages/runtime-python`, Python 3.12+, no dependencies). Generated code and the runtime are
`mypy --strict` clean.

## Generated API

```python
from gen.archive import Archive, Entry

pf = Archive.parse(data)                          # bytes, bytearray, memoryview or a sync source
pf.entries[3].align = 0x200                          # plain dataclasses
out = pf.serialize()                                 # derived fields (count, offset, size) recomputed
r = Archive.safe_parse(data)                      # SafeResult(ok, value, error)
j = pf.to_json(); pf2 = Archive.from_json(j)      # canonical JSON, $ref for shared targets
v = await Node.parse_async(src, key=k, nonce=n)      # root parameters are keyword-only arguments
new = Archive(entries=[Entry(handler=0, kind=1, align=0x100, data=b"..")])   # inputs only

v = Archive.view(rt.file_source("big.bin"))     # lazy, memory-mapped
v.entries[3].handler = 7                             # same size: patched in place
v.entries.append(Entry(...))                         # structural: re-encoded on commit
v._patches(); v._commit(grow="append")               # "default" | "append" | "splice" | "error"
```

- **Root API**, on the root's dataclass: `parse`, `safe_parse`, `parse_async`, `safe_parse_async`,
  `from_json`, `options_from_json`, `view`, `view_async` (class methods) and `serialize`,
  `serialize_async`, `to_json` (instance methods). Roots that reach an async codec only get the
  async parse and serialize methods. Keyword arguments: `endian` (`"le"`), `strict` (parse and
  views) and every root parameter (bound parameters without `$`); parameters with defaults are
  optional.
- **Modules:** IR module `formats/archive` becomes `formats/archive.py`, with an
  `__init__.py` per package. Modules import each other as module objects (relative imports), so
  cycles between modules work. With `inlineRuntime` the runtime is copied into
  `_yaffle_runtime/` and imported relatively; `targets.python.runtimeModule` names another
  runtime module.

### Types

| yaffle                  | Python                                                     |
| ----------------------- | ---------------------------------------------------------- |
| integers of every width | `int` (exact)                                              |
| `f16` / `f32` / `f64`   | `float` (the exact double of the stored value)             |
| `bool`, strings, `u8[]` | `bool`, `str`, `bytes`                                     |
| other arrays            | `list[T]`                                                  |
| struct                  | `@dataclass(kw_only=True)`                                 |
| enum                    | `enum.IntEnum` (open enums: `E \| int`)                    |
| union                   | `yaffle_runtime.Variant(type, value)`                      |
| nullable pointer        | `T \| None`                                                |
| one-way transform       | the transformed value (canonical JSON shows the raw value) |

- **Dataclass fields** are in declaration order (blocks, switches and bits flattened). Inputs the
  caller must give have no default; derived fields, constants, optional inputs and fields of
  conditional branches have defaults (`0`, `""`, the constant, `None`, …), so `X(...)` takes only
  the inputs. A field declared in several branches gets the union of its types.
- **Absent fields:** readers and `from_json` create objects with `cls.__new__` and only assign
  the fields they read, so an untaken branch's field is absent (the class default shows through)
  and a missing required input is reported as `INPUT` with the field's path.
- **Names:** structs keep their IR names; a trailing `_` avoids keywords and builtins. Field
  attributes are the yaffle names with a trailing `_` for hard keywords, builtin type names and,
  on root classes, the API method names; they never start with `_`. JSON keys are always the
  yaffle names. Enum members avoid keywords (`None_`). An exported root whose name differs from
  its class gets a module-level alias.
- **Values in:** writers accept an enum member, its name or (open enums, known values) an int;
  `True`/`False` are rejected for integer fields and ints for bool fields.
- **Side data** (raw values of one-way transforms, `@hidden` stream pieces) lives in the instance
  `__dict__` under `_yfl_raw` / `_yfl_hidden`, so `==` and `repr` ignore it.

## Runtime structure

| Module       | Contents                                                                          |
| ------------ | --------------------------------------------------------------------------------- |
| `errors`     | `YaffleError` (`code`, `path`, `offset`, `causes`), path prefixes while unwinding |
| `prim`       | primitive encodings and range checks                                              |
| `ints`       | truncating division, IEEE float division, shifts, rounding, lengths (IR.md §6)    |
| `strings`    | text encodings, code units                                                        |
| `checksum`   | `crc32`, `adler32`                                                                |
| `arrays`     | aggregates, derived arrays (`map`, `filter`, `sortedBy`, …), value equality       |
| `jsonc`      | canonical JSON (`$ref`s, hex, big integers), `Variant`, side data                 |
| `values`     | enums, bitfields, input validation, after-layout checks                           |
| `externs`    | loading and calling host code, built-in LEB128 types                              |
| `codec`      | `@via` codec calls and codec reuse                                                |
| `streams`    | virtual streams outside views: joining and slicing, splitting on write            |
| `reader`     | `Reader`: the read context, targets with identity, unions                         |
| `writer`     | `Writer`, regions, blocks, placeables, fixups, `@ref` resolution                  |
| `layout`     | the layout engine, including sticky layout for view commits                       |
| `api`        | what the root API runs on; sources, `file_source`                                 |
| `store`      | byte stores filled on demand (block cache, joined streams, ranged regions)        |
| `view`       | struct and array views, the scan helpers generated scanners call                  |
| `commit`     | `_commit` / `_patches`: fast in-place path, re-encoding with provenance, diff     |
| `async_view` | awaitable chains over async sources and async codecs                              |
| `_harness`   | the conformance harness (not copied by `inlineRuntime`)                           |

Readers are imperative functions per struct over `Reader`; the writer is relocation style (blocks,
placeables, fixups, extents for `sizeof`/`offsetof`/`bytesof`/`encodedSize`). The layout engine,
`@ref` resolution and the commit planner follow the TS runtime, so both targets make the same
placement decisions.

## Host interfaces

`targets.python.externs` maps an extern to a `.py` file (relative to the yaffle.json, or
absolute) or an importable module name, optionally with `#Item` (default: the extern's name).
Files are loaded by path, so extern files need not be packages.

| Extern                     | Python object                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `extern fn f(T a, …) -> R` | a callable `f(a, …)`; ints are `int`, `u8[]` `bytes`, `char[]` `str`                                                |
| `extern codec c(args)`     | `decode(data, ctx) -> bytes` and `encode(data, ctx) -> bytes`; `ctx` is `CodecContext(args, output_size, position)` |
| `@streaming` codec         | `decode` returns `(output, consumed)`                                                                               |
| `@ranged` codec            | may be called on any slice, with `ctx.position`                                                                     |
| `async codec`              | `decode` / `encode` may return awaitables                                                                           |
| `extern type X(args) : T`  | `size(data, *args) -> int \| None`, `read(data, *args)`, `write(value, *args) -> bytes`                             |

Any exception from host code is a `CODEC` error. An extern without an implementation fails with
`INPUT` when used.

## Views and async

- **Views** are lazy: a struct view (`StructView`) scans its scalars and records field ranges;
  inline structs and arrays are child views, and targets, bytes, codec regions and streams are
  read on access. View methods start with `_` (`_commit`, `_patches`, `_offset`, `_size`,
  `_raw`, `_set`, `_fields`, `_plain`), like `namedtuple`'s. Array views are mutable sequences.
  A struct view works as the input of `X.serialize(view)` and `X.to_json(view)`.
- **Sources:** bytes are viewed in memory; `file_source(path)` is memory-mapped (in-place patches
  go to a copy-on-write map); other sync sources are read through a block cache (64 KiB × 256).
  `@ranged` codec regions decode only the 4 KiB blocks a read touches, and `from arr[*].field`
  streams decode only the pieces it touches.
- **Edits:** a same-size scalar edit that no derive depends on is patched in place; anything else
  marks the view structural, and `_commit` re-encodes with the generated writer: unchanged bytes
  keep their provenance, unchanged codec regions reuse their encoded bytes, and placeables keep
  their positions where the grow policy allows. Writable sources (`file_source(path,
writable=True)`, or any source with `write`/`truncate`) get the commit written back.
- **Async:** `parse_async`, `serialize_async` and `safe_parse_async` accept async sources (a
  `read` returning an awaitable) and async codecs. `X.view(async_source)`, `X.view_async(any)`
  and the views of async roots are async views: attribute and item chains are awaitable and
  resolve to plain snapshots (dicts, lists); edits go through `await chain._set(...)` and
  `await view._commit()`. Missing bytes and async codec output are fetched and the walk retried.

## Tests

```sh
# conformance (python and python:view); Python comes from $YAFFLE_PYTHON, python3 on PATH or
# `nix shell nixpkgs#python3`
node --max-old-space-size=12000 --conditions=development \
  conformance/src/cli.ts --targets python
# backend tests (vitest), including the Python unit tests; YAFFLE_PYTHON_MYPY=1 adds mypy --strict
YAFFLE_PYTHON_MYPY=1 npx vitest run --project yaffle packages/compiler/test/backends/python
# Python unit tests directly
PYTHONPATH=packages/runtime-python python3 -m unittest discover -s packages/runtime-python/tests
python3 -m unittest discover -s conformance/externs/python
```

Caches live outside the repository, in `$YAFFLE_PYTHON_CACHE` (default
`<tmpdir>/yaffle-python-cache`): the resolved interpreter, bytecode, generated test packages and
mypy's cache. The conformance adapter runs one Python process per case directory, which writes
one result file per case.

## Known gaps

- Union values in views are snapshots (editing one replaces the value). A sync view of a union
  that reaches an async codec raises `INPUT` ("not supported").
- Bytes fields in views are read whole on first access.
- Async views resolve to plain snapshots, not dataclasses.
- A stream whose piece lengths the schema doesn't state decodes all its pieces once to learn its
  size.
- f16/f32 NaN payloads go through C float conversions and may be quieted; `"NaN"` in JSON writes
  the canonical quiet NaN.
- Python `bool` is an `int`: writers tell them apart, but plain `==` in user code does not.
- Elements of an array of pointers with `@origin` are followed right away, so their origin may
  only use earlier fields.
