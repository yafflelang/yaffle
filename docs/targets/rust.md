# Rust target

The Rust backend (`packages/compiler/src/backends/rust`) turns the IR into Rust source that
depends on the runtime crate `yaffle-runtime` (`packages/runtime-rust`, no dependencies), referred
to as `yr`, or carries a copy of it inline (`inlineRuntime`).

## Generated code

One module file (`mod.rs`) with every type, its reader, writer and canonical JSON, the root API,
and one re-export submodule per IR module. Target options (`targets.rust`, all optional):

- `crate: { name?, runtimePath? }`: emit a whole crate (`Cargo.toml` + `src/lib.rs`);
- `runtime`: the runtime's Rust path in module mode (default `::yaffle_runtime`);
- `fileName`: the module file name (default `mod.rs`);
- `views`: also generate views (`X::view`, `XView`);
- `dependencies`: crates the externs need (`{ "zstd": "0.13" }`), added to `Cargo.toml`;
- `externs`: see [Host interfaces](#host-interfaces).

Generated code compiles without warnings, clippy included.

### Root API

```rust
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Table { pub count: u32, pub entries: Vec<Entry>, /* … */ }

impl Table {
    pub fn parse(bytes: &[u8]) -> yr::Result<Table>;
    pub fn parse_with(bytes: &[u8], opts: &yr::ParseOptions, params: &TableParams) -> yr::Result<Table>;
    pub fn serialize(&self) -> yr::Result<Vec<u8>>;
    pub fn serialize_with(&self, params: &TableParams) -> yr::Result<Vec<u8>>;
    pub fn to_json(&self) -> yr::Value;
    pub fn from_json(v: &yr::Value) -> yr::Result<Table>;
}
pub struct TableParams { pub endian: yr::Endian, pub version: u32, /* root parameters */ }
```

`yr::ParseOptions { strict }` turns on strict mode. Errors are `yr::YaffleError` with `code`,
`path` and `offset` (docs/CONFORMANCE.md §4); write errors carry the writer's path. `yr::Value` is
the runtime's own JSON type (ordered objects, parser and printer).

### Types

One Rust struct per IR struct serves as both parse output and serialize input. Derived, computed,
constant and optional-input fields stay in the struct; the writer ignores what the IR says is not
an input.

| IR                                    | Rust                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| `u8`…`u64`, `i8`…`i64`                | `u8`…`u64`, `i8`…`i64` (u24 → `u32`, u40–u56 → `u64`, range-checked)         |
| `f16`, `f32`, `f64`                   | `f32`, `f32`, `f64`                                                          |
| `bool`, strings, `u8[]`, other arrays | `bool`, `String`, `Vec<u8>`, `Vec<T>`                                        |
| pointers                              | `Rc<T>`; `Option<Rc<T>>` when nullable; `Rc<Vec<T>>` with `@nullable(empty)` |
| recursive inline fields               | `Box<T>`                                                                     |
| enums                                 | Rust enums (`@open` adds `Unknown(raw)`)                                     |
| unions                                | an enum with one tuple variant per IR variant, named after its first use     |
| switches                              | enums, with an accessor per field (`fn body(&self) -> Option<&T>`)           |
| conditional fields, optional inputs   | `Option<T>`                                                                  |
| one-way transforms                    | `yr::OneWay<V, R>` (JSON holds the raw value)                                |
| extern types                          | their value type                                                             |

Hidden members, which compare equal to anything and default to empty, so hand-built values use
`Table { entries, ..Default::default() }`:

- `__id: yr::Ident` on structs that pointers target: one object per (region, address, type), so
  shared targets and cycles print as `$ref` JSON Pointers and are written once;
- `__cache: yr::ViaCache` on structs with codecs: the original encoded bytes per region, reused
  when the decoded bytes and arguments are unchanged, so rebuilds are byte-exact;
- `@hidden` stream carriers, stored so the stream can be joined and never in JSON.

Integer expressions are computed exactly in `i128` (bitwise ops with infinite-precision two's
complement); overflow and out-of-range stores are `RANGE`.

## Runtime structure

`packages/runtime-rust/src`; modules refer to each other only through `super::`, so the crate can
be inlined as a module.

| Module                                                           | Contents                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `read.rs`                                                        | `Reader`: position, base, region end, strict mode, identities, decoded regions, padding           |
| `write.rs`                                                       | `Writer`: relocation-style encoding into units, then the layout engine and fixups                 |
| `view.rs`                                                        | `ViewRoot`, `ViewState`, scans, patches, `Grow` commits                                           |
| `space.rs`                                                       | byte spaces: plain bytes or a `LazyBuf` filled block by block (`Source`, `FileSource`)            |
| `codec.rs`                                                       | `Codec`, `ExternType`, `Arg`, `CodecCtx`, `ViaCache`, built-in `uleb128`/`sleb128`                |
| `json.rs`                                                        | `Value`, canonical JSON (docs/CONFORMANCE.md §3), `$ref` resolution                               |
| `int.rs`                                                         | exact integer arithmetic                                                                          |
| `error.rs`                                                       | `YaffleError`, `ErrorCode`, paths                                                                 |
| `prim.rs`, `strings.rs`, `checksum.rs`, `regex.rs`, `helpers.rs` | primitives, text encodings, crc32/adler32, the `in /re/` subset, small helpers for generated code |

The writer encodes first and lays out second: each base and placeable becomes a _unit_ of inline
bytes, because layout paths (`records[*].model`) must see placeables found inside other
placeables. Position-dependent padding is recorded as _pads_ and sized when the unit is placed;
values that depend on layout are _fixups_ run afterwards (values, then `@ref`, then byte-reading
fixups such as checksums in dependency order, then late checks). Nested `@base` regions and codec
regions are finished into bytes when they end. `@ref` takes the placed candidate with the same
identity, else the first equal value; a pointer with no candidate in its base is handed to the
enclosing base.

## Host interfaces

`targets.rust.externs[name]` is a Rust path used verbatim (`crate::hash::gt_hash`) or a file
(`./externs/zstd.rs#ZSTD`, relative to the output directory; the item defaults to the extern's
name). Files are mounted with `#[path]` as `ext_<stem>` modules; the conformance adapter copies
them into its harness crate.

| Extern                    | Implementation                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `extern codec c`          | a value implementing `yr::Codec` (`decode`, `encode`); arguments arrive as `yr::Arg`s in `CodecCtx { args, output_size, position }` |
| `@streaming` codec        | `Codec::decode_streaming`, returning the output and the bytes consumed                                                              |
| `extern type T(args) : V` | a value implementing `yr::ExternType<Value = V>`                                                                                    |
| `extern fn f(…) -> R`     | a function taking typed arguments (integers as their Rust type, strings `&str`, bytes `&[u8]`)                                      |

`conformance/externs/rust/stub/yaffle_runtime.rs` mirrors `Arg`, `CodecCtx`, `Codec` and
`ExternType`, so the extern files can be unit-tested on their own
(`conformance/scripts/test-rust-externs.sh`); keep it in sync with `codec.rs`. Async codecs run
synchronously.

## Views

With `views: true`:

```rust
let v = Table::view(bytes)?;               // or view_with(bytes, opts, params), view_source(Box<dyn yr::Source>, …)
let n = v.count()?;                        // getters read on demand
let e = &v.entries_views()?[3];            // views of inline and `at` structs, arrays of them, pointer targets
e.set_handler(7)?;                         // patched in place when possible, else a structural edit
let whole: Table = v.materialize()?;       // the whole value, read through the views
let bytes = v.commit_with(yr::Grow::Append)?; // Splice | Append | Error; commit() returns the patched bytes
```

Also `loc()`, `shallow()`, `span(field)`, `refresh()`, `patches()`, `params()`, and
`replace_<field>` for `at` fields and owned pointers (the new target is appended).

- **One `yr::ViewRoot` per document** holds the bytes, the reader state every read shares
  (identities, decoded regions, streams) and a node cache: every handle of the struct at (region,
  position, type) shares one `ViewState`.
- **Scans** read inline members only; pointer and `at` targets, `from` fields and non-streaming
  codec regions are read when asked for. `@ranged` codec regions decode block by block, file
  sources load in 64 KiB blocks, and `from arr[*].field` streams fill piece by piece.
- **`set_<field>`** patches in place when the field was scanned, keeps its encoded size, and
  neither a derived or computed field nor a layout item argument reads it; otherwise it records a
  structural edit.
- **`commit_with`**: `Splice` re-serializes the materialized value. `Append` keeps every placeable
  where it was when it still fits and is still aligned, and puts the rest at the end; it falls
  back to `Splice` when the original document doesn't rebuild byte-exact. `Error` is `Append` that
  fails if anything moves or changes size.

## Tests

```sh
export CARGO_TARGET_DIR=/tmp/yaffle-cargo-target
# Runtime unit tests and lints
cd packages/runtime-rust && nix shell nixpkgs#cargo nixpkgs#rustc nixpkgs#clippy \
  --command sh -c 'cargo test && cargo clippy --all-targets'
# Backend tests: generate, build and run crates per test file
npx vitest run --project yaffle packages/compiler/test/backends/rust
# Conformance, parse and view mode (rust and rust:view)
node --max-old-space-size=12000 --conditions=development conformance/src/cli.ts --targets rust
# Extern unit tests against the stub runtime
nix shell nixpkgs#rustc --command conformance/scripts/test-rust-externs.sh
```

`toolchain.ts` uses `cargo` from `PATH`, else `nix shell nixpkgs#cargo nixpkgs#rustc`. Builds share
`CARGO_TARGET_DIR` (default `$TMPDIR/yaffle-cargo-target`); `YAFFLE_RUST_RUNTIME_DIR` points them at
another copy of the runtime crate, and test crates live in `$TMPDIR/yaffle-rust-tests/<name>`
(`YAFFLE_RUST_TEST_DIR`). Each vitest file builds one crate with its fixtures and a harness binary
that runs JSON operations from stdin (`harness.ts`).

## Known gaps

- No async API: a `Source` is read on demand (blocking) and `async codec`s run synchronously.
- `@align(from: file)` inside a `@base` whose position isn't known while it is written (a `@base`
  inside a pointer target) is a `DERIVE` error.
- `@origin` that measures fields is supported on plain pointer fields only (the target is followed
  after the struct's members); elsewhere it is a generation error.
- `@ref` escalation stops at codec regions (`REF`); checksums of a nested base that cover an
  escalated pointer see its bytes before they are filled.
- `@split(fit)` assumes an element's encoded size grows with its piece (binary search).
- Layout-dependent values inside codec regions that refer to fields outside them, and
  layout-dependent bitfields, are rejected at generation time.
- Views: unions and fields read through `@origin` pointers in arrays have no child views; edits
  inside decoded regions and streams are structural; handles other than the root are stale after a
  structural commit; `Append` keys kept positions by writer path, so inserting array elements
  moves more than needed.
- `replace_<field>` applies only the placement alignment and the struct's own layout item for that
  field (not an enclosing struct's layout, nor `from`/`offset`), and isn't generated when an
  alignment needs the writer (`$index`, offsets, measurements).
