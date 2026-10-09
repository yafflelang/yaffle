# C++ target

`yaffle build --target cpp` generates C++20 for one program: a header with the types and the root
API, and a source file with the readers, writers, canonical JSON, views and API definitions. The
generated code runs on the runtime in `packages/runtime-cpp`. The backend lives in
`packages/compiler/src/backends/cpp`.

## Building

Options in `yaffle.json` under `targets.cpp`:

| Option        | Meaning                                                                   |
| ------------- | ------------------------------------------------------------------------- |
| `namespace`   | Namespace of the generated code (default: from the file name)             |
| `file`        | Base name of the generated files (default: the module name)               |
| `views`       | Generate views (default `true`; `false` leaves them out)                  |
| `externs`     | Host implementations of externs (see [Host interfaces](#host-interfaces)) |
| `nixPackages` | Packages the externs need, resolved with `nix-build` by the test tooling  |
| `libs`        | Libraries the test tooling links (`-l` names)                             |

The backend option `inlineRuntime` copies the runtime into `yaffle-runtime/` next to the output.
Compile the generated source together with `packages/runtime-cpp/src/*.cpp`, with
`packages/runtime-cpp/include` on the include path, as C++20 (`-std=c++20`). The runtime uses
`__int128` and GCC's overflow builtins; it and the generated code build cleanly with
`-Wall -Wextra -Werror` under GCC.

## Generated API

```cpp
#include "fmt.hpp"

fmt::Archive pf = fmt::Archive::parse(bytes);       // or parse(bytes, options)
yaffle::Bytes out = fmt::Archive::serialize(pf);       // byte-identical if unchanged
yaffle::Json j = fmt::Archive::to_json(pf);            // canonical JSON, $refs for shared values
fmt::Archive back = fmt::Archive::from_json(j);
auto o = fmt::Archive::options_from_json(args);        // endian, strict, root parameters
```

Every root struct `X` has `X::Value` (the struct, or `std::shared_ptr<X>` for shared structs),
`X::Options` (`endian`, `strict`, and a `std::optional` per root parameter) and the static
functions above. Errors are `yaffle::Error` exceptions with a `code` (`yaffle::code_name` gives
`"EOF"`, `"CHECK"`, …), a `path` from the root and an `offset` (-1 on write).

### Type mapping

| yaffle                                         | C++                                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `u8`…`u64`, `i8`…`i64`                         | `std::uint8_t`…`std::uint64_t`, `std::int8_t`…`std::int64_t`                              |
| `u24`, `u40`/`u48`/`u56` (signed alike)        | `std::uint32_t`, `std::uint64_t` (range-checked on write)                                 |
| `f16`/`f32`, `f64`                             | `float`, `double`                                                                         |
| `bool`                                         | `bool`                                                                                    |
| strings (any encoding)                         | `std::string` (UTF-8)                                                                     |
| `u8[]`                                         | `yaffle::Bytes` (`std::vector<std::uint8_t>`)                                             |
| arrays                                         | `std::vector<T>`                                                                          |
| enums                                          | `enum class E : storage`                                                                  |
| unions                                         | `std::variant<…>` (aliases `Union1`, `Union2`, …)                                         |
| structs                                        | by value; `std::shared_ptr` when pointers or `at` can target them, or on a by-value cycle |
| pointers to structs, arrays, unions            | `std::shared_ptr` (shared targets keep their identity)                                    |
| pointers to scalars and strings                | the value (`std::optional` when nullable)                                                 |
| conditional and switch fields, optional inputs | `std::optional`                                                                           |

Switch cases are flattened into `std::optional` members (cases often share fields); `from_json`
chooses the case by the discriminant. A one-way transform keeps its raw value in a hidden
`<field>_raw` member, which canonical JSON shows. Structs with codec layers carry a hidden
`yaffle::Meta yaffle_meta_`: the original encoded bytes of every codec region, reused on serialize
when the decoded bytes are unchanged, so non-canonical encodings rebuild byte for byte.

Integers are computed exactly: expressions use `int64_t` where interval analysis proves it safe and
`__int128` with checked helpers otherwise. Overflow and out-of-range values are `RANGE` errors.

## Views

```cpp
auto v = fmt::Archive::view(bytes);                    // reads on access
auto es = v.entries_views();                              // child views, no reads yet
es[1].set_handler(3);                                     // same size: patched in place
es[1].set_data(bigger);                                   // structural: applied at commit
std::vector<yaffle::Patch> ps = v.patches(yaffle::Grow::Splice);
yaffle::Bytes edited = v.commit();                        // Default | Append | Splice | Error
auto whole = v.materialize();                             // every field through the view
auto fv = fmt::Archive::view_file("big.bin");          // positional reads through a block cache
```

A view's struct is _scanned_ once: scalars are read, while pointer targets, codec regions, streams
and byte arrays get lazy closures, and the locations of struct values are recorded so child views
need no reads. A setter patches in place when the field's encoding keeps its size and nothing
derives from it; any other edit materializes the document (one parse that records where every
target was) and edits that value. `commit` returns the patched bytes, or re-serializes with a
sticky layout that keeps targets where they were as far as the grow policy allows.

Views read through byte stores (`yaffle/store.hpp`): files (`FileStore`), decoded codec regions
(decoded whole, or block by block for `@ranged` codecs), and `from arr[*].piece` streams
(`PieceStore`: pieces located from their size fields, decoded one at a time when read).

## Host interfaces

`targets.cpp.externs[name]` is `path/file.hpp` (the item has the extern's name, with `_` appended
for C++ keywords), `path/file.hpp#ns::item`, or a bare `ns::item`.

- `extern fn f(T a) -> R`: a callable taking the C++ types (`u8[]` as `const yaffle::Bytes&`).
- `extern codec c(args)`: an object with
  `yaffle::Bytes decode(yaffle::BytesView, const yaffle::CodecCtx&) const` (returning
  `yaffle::Decoded { output, consumed }` for `@streaming` codecs) and
  `yaffle::Bytes encode(yaffle::BytesView, const yaffle::CodecCtx&) const`. `CodecCtx` holds the
  arguments (`yaffle::Arg`), the decoded size when an inner `@size` gives it, and the block offset
  for `@ranged` codecs. `async` codecs may return `std::future<…>`; the runtime waits for it.
- `extern type X(args) : T`: an object with
  `std::optional<std::size_t> size(yaffle::BytesView, args…) const` (`std::nullopt`: needs more
  bytes), `T read(yaffle::BytesView, args…) const` and `yaffle::Bytes write(const T&, args…) const`.

A host exception other than `yaffle::Error` becomes a `CODEC` error.

## Runtime

Headers are in `packages/runtime-cpp/include/yaffle/`, one per area (`yaffle.hpp` includes them
all), with the implementations in `src/`:

| Header        | Contents                                                         |
| ------------- | ---------------------------------------------------------------- |
| `core.hpp`    | `Error`, paths, exact integer helpers                            |
| `prim.hpp`    | integer and float encodings                                      |
| `strings.hpp` | text encodings                                                   |
| `json.hpp`    | the `Json` value and canonical JSON conversions                  |
| `codec.hpp`   | codec calls, codec reuse (`Meta`), stream slices                 |
| `helpers.hpp` | small helpers of generated code, LEB128, stream splitting        |
| `arrays.hpp`  | derived arrays and value equality                                |
| `store.hpp`   | byte stores                                                      |
| `reader.hpp`  | the read context and target identity                             |
| `writer.hpp`  | the relocation-style writer: blocks, placeables, fixups, regions |
| `view.hpp`    | documents, scans, view bases, materialization                    |
| `harness.hpp` | the conformance harness (not part of `yaffle.hpp`)               |

The layout engine (`src/layout.cpp`) places a base region's targets: pre-order by default,
`layout { … }` items, pull-out claims, constraints, fixed placements and the sticky mode of view
commits.

## Tests

```sh
# backend tests: generate, compile with g++, run (they skip without a C++ compiler: $CXX, else g++)
YAFFLE_CPP_CACHE=/tmp/yaffle-cpp-cache npx vitest run --project yaffle packages/compiler/test/backends/cpp

# conformance, parse and view modes
YAFFLE_CPP_CACHE=/tmp/yaffle-cpp-cache \
  node --max-old-space-size=12000 --conditions=development conformance/src/cli.ts --targets cpp
```

`runtime.test.ts` runs the runtime's own unit tests (`packages/runtime-cpp/test`). Builds are
cached under `$YAFFLE_CPP_CACHE` (default `<tmpdir>/yaffle-cpp-cache`), keyed by content. The
conformance runner compiles one program per case directory; a cold run takes a long time, and
disjoint `--filter` groups can run in parallel processes.

## Known gaps

- No async views. Non-ranged codec regions are decoded whole when first read, and so are views over
  `@ranged` regions with layers inside the codec or several codecs.
- Union values, and fields inside codec regions or streams, are edited structurally only. Replacing
  a whole array (`set_entries(copy)`) loses the copies' original positions.
- A commit after a structural edit reads the whole source and builds the new file in memory.
- Piece-decoding errors carry the path from the struct holding the stream, not from the root.
- Layout item arguments that depend on sizes or positions (`sizeof`, `offsetof`, `$offset`) are
  rejected.
- A field declared in several branches with different C++ types is rejected.
- Writing a one-way transform below the field level (an array element, a pointer target) is an
  `INPUT` error: only fields keep a raw value.
- `@origin` pointers that measure later fields work on plain pointer fields only.
- Large schemas generate a lot of C++ (about 1 MB for a dozen real-world formats), which takes
  minutes to compile.
