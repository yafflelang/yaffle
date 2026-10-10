# Go target

The Go backend (`packages/compiler/src/backends/go`) turns a yaffle program into one Go package;
the generated code imports the runtime `yaffle.dev/yaffle` (`packages/runtime-go`, Go 1.22, no
dependencies). Every IR module becomes one `.go` file of the package: yaffle allows type cycles
across modules, Go packages can't import each other in cycles.

## Generated API

For every exported struct `X`:

```go
type X struct { … }                     // one type for output and input
type XOptions struct {                  // root parameters, endian, strict
	Endian  yaffle.Endian
	Strict  bool
	Version uint32                      // a root parameter; with a default: *uint32 (nil = default)
}
func ParseX(data []byte, opts *XOptions) (*X, error)
func ParseXContext(ctx context.Context, data []byte, opts *XOptions) (*X, error)
func SerializeX(v *X, opts *XOptions) ([]byte, error)
func SerializeXContext(ctx context.Context, v *X, opts *XOptions) ([]byte, error)
func ViewX(data []byte, opts *XOptions) (*XView, error)    // see "Views"
func XToJSON(v *X) ([]byte, error)      // canonical JSON (docs/CONFORMANCE.md §3), $refs
func XFromJSON(data []byte) (*X, error)
func XOptionsFromJSON(data []byte) (*XOptions, error)
```

`opts` may be nil. Errors are `*yaffle.Error` (`Code`, `Path []any`, `Offset`, `Detail`,
`Causes`); `yaffle.AsError(err)` unwraps them.

Target options (`targets.go` in yaffle.json, or `targetOptions`): `package` (default `gen`),
`runtimeModule` (the runtime's import path; required with `inlineRuntime`, which copies the
runtime's sources into `yaffle/`), `views` (default true), `materialize` (adds
`MaterializeXView`, used by the conformance view mode), `externs` and `dependencies` (below).

### Type mapping

| yaffle                                       | Go                                                                                           |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| u8/u16/u32/u64, i…                           | uint8…uint64, int8…int64                                                                     |
| u24, i24 / u40…u56, i40…i56                  | uint32, int32 / uint64, int64 (range-checked on write)                                       |
| f16 / f32 / f64                              | float32 (exact) / float32 / float64                                                          |
| bool, char/str…                              | bool, string (UTF-8; other encodings are converted)                                          |
| `u8[n]` (bytes)                              | `[]byte` (aliases the input after a parse; decoded regions are copies)                       |
| arrays                                       | `[]T`                                                                                        |
| structs                                      | `*S` (pointers: shared targets and cycles are the same object)                               |
| enums                                        | `type E uint16` with constants `EMember`, `IsKnown()`, `String()`; open enums hold any value |
| unions                                       | `*AOrB` with `Type string` and one field per variant                                         |
| pointers                                     | the target's type; nullable scalars and strings `*T`, nullable structs and slices nil        |
| conditional fields, optional inputs          | `*T` for scalars and strings, nil slices and pointers                                        |
| one-way transforms (`as` without an inverse) | the transformed value `F` plus the raw value `FRaw` (written, and shown in JSON)             |
| `@hidden` fields                             | unexported fields                                                                            |
| extern types                                 | their value type                                                                             |

Derived, computed and constant fields stay in the struct (filled by a parse, recomputed by a write).
A nil slice means "absent" only for conditional fields; elsewhere it is an empty slice. Every struct
carries an unexported `yfl yaffle.Meta` (codec reuse, lazy stream pieces).

## Host interfaces

Externs are configured in `targets.go.externs`. A spec is a file path (optionally `#Item`) or
`importpath.Name`:

- **File:** the file becomes part of the generated package (its `package` clause is rewritten),
  so the item may be unexported. Each extern file is copied on its own, so it must be
  self-contained, and helper names must not collide between the extern files of one package.
- **`importpath.Name`:** imported with an alias (`ext1`, …). Extra modules go into
  `targets.go.dependencies` (`{ "github.com/klauspost/compress": "v1.20.1" }`).
- **Missing:** a placeholder is generated; using it fails with `INPUT`.

```go
// extern codec c(args)
type Codec interface {
	Decode(input []byte, ctx *yaffle.CodecCtx) ([]byte, error)
	Encode(input []byte, ctx *yaffle.CodecCtx) ([]byte, error)
}
// @streaming: Decode also reports the bytes consumed
type StreamingCodec interface {
	Decode(input []byte, ctx *yaffle.CodecCtx) (out []byte, consumed int, err error)
	Encode(input []byte, ctx *yaffle.CodecCtx) ([]byte, error)
}
// CodecCtx: Context (from ParseXContext/SerializeXContext), Args []any (u8 → uint8, u64 → uint64,
// u8[n] → []byte, …), OutputSize (-1: unknown), Position (@ranged).

// extern type T(args) : V
type ExternType[V any] interface {
	Size(data []byte, args []any) (n int, ok bool, err error)  // ok=false: need more bytes
	Read(data []byte, args []any) (V, error)
	Write(value V, args []any) ([]byte, error)
}

// extern fn f(u8 data[]) -> u32
func f(data []byte) uint32   // plain Go types
```

`yaffle.ArgInt`, `ArgUint` and `ArgBytes` read arguments. Every host failure (an error or a panic)
is a `CODEC` error. `extern async` codecs are ordinary blocking codecs: a blocking call on a
goroutine is Go's equivalent of async, and the context of the `…Context` entry points reaches
codecs through `CodecCtx.Context`, so a slow codec can honour cancellation. The built-in
`uleb128`/`sleb128` are `yaffle.Uleb128` and `yaffle.Sleb128`.

## Views

Generated for every struct unless `targets.go.views` is false: lazy reads, in-place patches, and
structural edits committed through the writer with a sticky layout and a diff.

```go
v, err := gen.ViewArchive(data, nil)    // *ArchiveView (embeds *yaffle.Node)
n, err := v.Count()                        // scalars come from a shallow scan
es, err := v.EntriesViews()                // views of inline structs: no further reads
d, err := es[1].Data()                     // a target is read alone, on demand
err = es[1].SetHandler(2)                  // same size, nothing depends on it: patched in place
err = es[1].SetData(bigger)                // structural: applied at commit
all, err := v.Entries()                    // whole values when a getter needs more
p, err := v.Patches(yaffle.CommitOptions{Grow: "append"}) // []yaffle.Patch{At, Remove, Insert}
out, err := v.Commit(yaffle.CommitOptions{})              // new bytes; the root view rebinds
```

- **Scans.** A view runs the generated reader in a shallow mode: pointer and `at` targets,
  `from` fields nothing else reads and lazy codec regions are not read; the scan records where
  they are (with a closure that replays the read in the reader state it was found in), every
  field's byte span and each struct's arguments, per struct value. Inline children get views
  from the same scan. A nested `@base` struct, and a struct whose read-side expressions read
  targets, are read with targets followed.
- **Getters** return values from the scan when they are complete there, read a target or a
  deferred field alone, or else read the node completely. `FView()`/`FViews()` return views of
  inline structs, targets, deferred fields and arrays of them. Target values are cached per
  (address, identity key), so shared targets stay shared.
- **Setters** encode the value with the generated writer code for that field (checks run
  immediately). If the encoding has the field's size and nothing reads, derives from or lays out
  by the field, the bytes are patched in place; anything else is a structural edit.
- **Commit.** In-place patches alone (and no ancestor derives from child content) are returned
  as they are. Otherwise the document is read with origins tracked, the edits are applied, the
  root is re-serialized with the sticky layout (grow policies `default`, `append`, `splice`,
  `error`), codec regions reuse their bytes, and the output is diffed against the original,
  anchored on byte slices that still alias it.
- **Lazy stores.** A stream joined from pieces (`from arr[*].data`) is a `PieceStore`: pieces
  are decoded on demand (their lengths come from the data where the schema states them), with an
  LRU of 16 pieces and 64 MiB. A `@ranged` codec region is a `RangedStore` of 4 KiB blocks
  decoded alone (256 blocks cached). Readers over a store keep a window of it.

## Runtime structure

Generated readers and writers panic with `*yaffle.Error`; the entry points recover it and return
it, so host code only sees errors. A shared `PathStack` records struct frames and array indices
as code runs and isn't unwound by the panic, so the entry point attaches the exact path.

| File             | Contents                                                                               |
| ---------------- | -------------------------------------------------------------------------------------- |
| `api.go`         | the entry points' glue (`ParseWith`, `SerializeWith`, `ToJSONWith`, `FromJSONWith`)    |
| `errors.go`      | `Error`, codes, the path stack, `Catch`/`Try`                                          |
| `prim.go`        | byte orders, primitive kinds, raw integers, half floats, range checks                  |
| `expr.go`        | expression semantics: exact integers (int64, uint64, `*big.Int`), lengths, builtins    |
| `derived.go`     | derived arrays (`map`, `filter`, `sortedBy`, …) and value equality                     |
| `strings.go`     | text encodings                                                                         |
| `reader.go`      | `Reader`: primitives, padding, targets with identity per (address, type key), unions   |
| `writer.go`      | `Writer`: primitives, padding, fixups, targets, nested regions, write-side checks      |
| `region.go`      | blocks, placeables, regions: assembly, fixup phases, `@ref` resolution                 |
| `layout.go`      | the layout engine (items, groups, pull-out, alignments, fixed placements, sticky mode) |
| `codec.go`       | codec calls and codec reuse (`Meta`)                                                   |
| `extern.go`      | host interfaces, extern types and functions, placeholders, LEB128                      |
| `stream.go`      | streams on read and write, byte stores                                                 |
| `json.go`        | canonical JSON writer and reader                                                       |
| `scan.go`        | view scans and the reader's view hooks                                                 |
| `views.go`       | documents and nodes, getters, setters, commit, diff                                    |
| `commit.go`      | the writer's commit hooks (origins for the sticky layout)                              |
| `materialize.go` | reading a document through its views (conformance view mode)                           |

The generator: `index.ts` (files, options), `model.ts` (Go names and types, static sizes,
placeables, type keys), `irutil.ts` (pure IR analyses), `expr.ts` (expressions with interval
analysis: int64 or uint64 when the ranges provably fit, `*big.Int` helpers otherwise),
`emitter.ts` (what the reader and writer emitters share), `read.ts`, `write.ts` (relocation-style:
derived values that need sizes or positions are fixups), `json.ts`, `decls.ts`, `api.ts`,
`view.ts` with `viewinfo.ts` (what a scan reads, skips and defers), `module.ts` (imports, hoisted
variables, externs), `code.ts` (code builder, identifiers, unused temporaries) and `gofmt.ts`
(go/printer's operator spacing and line breaking, applied to the generated subset of Go, so the
output is gofmt-stable without running gofmt). `conformance.ts` and `harness.ts` are the
conformance adapter.

## Tests

```sh
# conformance in parse and view mode (Go from PATH, $YAFFLE_GO, or `nix shell nixpkgs#go`)
node --max-old-space-size=12000 --conditions=development conformance/src/cli.ts --targets go
# backend tests (skip without a Go toolchain); format.test.ts checks that generated code is gofmt-stable and vet-clean
npx vitest run --project yaffle packages/compiler/test/backends/go
# runtime and extern packages
(cd packages/runtime-go && go test ./... && go vet ./...)
(cd conformance/externs/go && go test ./...)
```

The adapter runs `go` with `GOTOOLCHAIN=local GOFLAGS=-mod=mod GOSUMDB=off` and keeps
`GOPATH`/`GOCACHE`/`GOMODCACHE` outside the repository: from the environment when set, otherwise
under `$YAFFLE_GO_CACHE` (default `<tmpdir>/yaffle-go-cache`). The backend tests write their
modules under `$YAFFLE_GO_TEST_DIR` (default the system temp directory).

## Known gaps

- Rejected at generation ("not implemented"): a field declared in several branches with
  different Go types, union-valued transforms, and layout item arguments that read sizes,
  positions or encodings.
- `from: file` alignment of a block whose position is only known after layout aligns the block
  itself; it is exact when the enclosing positions are known or aligned.
- Views: arrays are read whole by a scan, so a stream or ranged region whose struct has a large
  inline array is read completely when its view opens; pieces without a stated length are
  decoded up front to learn the stream's size. Values inside streams and codec regions can't be
  edited (`INPUT`: set the enclosing field), union variants have no view getters, structs read
  through a codec of their own have no views unless deferred, and after a commit only the root
  view is rebound.
