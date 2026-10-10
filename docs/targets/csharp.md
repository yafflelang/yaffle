# C# target

The C# backend (`packages/compiler/src/backends/csharp`) turns the IR into C# 13 source for .NET 8
and later; the generated code depends on the runtime library `Yaffle.Runtime`
(`packages/runtime-csharp`, no dependencies, built for `net8.0`, which runs on .NET 8 and later), or carries it
inline (`inlineRuntime`).

## Generated code

One `.cs` file per IR module (namespace `targets.csharp.namespace`, default `Yaffle.Generated`)
and `YaffleExterns.cs`. Nullable reference types are on; the output builds warning-free at every
warning level.

- **One class per struct**, `public sealed partial class X`, used both as the parse result and
  as the serialize input: `Serialize(Parse(bytes))` and `Serialize(FromJson(ToJson(x)))` work
  directly. Fields are PascalCase properties (`entry_count` → `EntryCount`; collisions get a
  `_2` suffix; the class name and the root API names are reserved). Derived, computed and
  constant fields are properties too: `Parse` sets them, `Serialize` recomputes them.
- **Hidden fields** (`@hidden`) are `internal` members named `Hidden_x`.
- **One-way transforms** (`as` without an inverse): the property holds the transformed value and
  a public `XxxRaw` property the raw value, which `Parse` and `FromJson` set, `Serialize` writes
  and canonical JSON shows.
- **Fields of different types in different branches** are `object?`.
- Readers, writers, JSON converters and view metadata are `internal static` members of the
  partial class `YaffleImpl` (`Read_X`, `ReadAsync_X`, `Scan_X`, `Write_X`, `WriteAsync_X`,
  `ToJson_X`, `FromJson_X`, `Info_X`, enum helpers).

### Type mapping

| IR                                                 | C#                                                               |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| `u8`…`u64`, `i8`…`i64`                             | `byte`…`ulong`, `sbyte`…`long` (u24 → `uint`, u40–u56 → `ulong`) |
| `f16`, `f32`, `f64`                                | `Half`, `float`, `double` (NaN is written canonically)           |
| `bool`, strings                                    | `bool`, `string`                                                 |
| `u8[]`, other arrays                               | `byte[]`, `List<T>`                                              |
| enums                                              | C# enums over the storage type (open enums keep any value)       |
| unions                                             | `Rt.UnionValue { Type, Value }`                                  |
| conditional fields, nullable pointers, `?=` inputs | nullable (`uint?`, `Entry?`)                                     |
| extern types                                       | their value type                                                 |

Required reference-typed inputs are non-nullable (`= null!`); `Serialize` and `FromJson` report a
missing one as `INPUT` with the field's path. Closed enums reject non-member values on write
(`CHECK`). Integer expressions are computed exactly in `long`, `Int128` or `BigInteger` (chosen by
interval analysis) and land in typed locations through range-checked conversions (`RANGE`).

### Root API

Static members of each root's class, with an options class `XOptions : Rt.ParseOptions`
(`Endian`, `Strict`, the root parameters by name, and `XOptions.FromJson` for canonical-JSON
`args`):

```csharp
X Parse(byte[] | Rt.ISource | Stream data, XOptions? options = null)
Rt.SafeResult<X> SafeParse(byte[] data, XOptions? options = null)
ValueTask<X> ParseAsync(byte[] | Rt.IAsyncSource data, XOptions? options = null)
ValueTask<Rt.SafeResult<X>> SafeParseAsync(byte[] data, XOptions? options = null)
byte[] Serialize(X value, XOptions? options = null)
ValueTask<byte[]> SerializeAsync(X value, XOptions? options = null)
JsonNode ToJson(X value)
X FromJson(JsonNode? json)
Rt.View<X> View(byte[] | Rt.ISource data, XOptions? options = null)
Rt.AsyncView<X> ViewAsync(byte[] | Rt.IAsyncSource data, XOptions? options = null)
```

Roots that reach an async codec get only the async members (and `ViewAsync`). Errors are
`Rt.YaffleException` with `Code`, `Path` (field names and `long` indices) and `Offset`; generated
methods add path segments in exception filters, so nothing is caught and rethrown.

## Host interfaces

`targets.csharp.externs[name]` is `path.cs`, `path.cs#Fully.Qualified.Item`, or an item name
without a file. Without `#Item` the item is the extern's name in PascalCase (`Externs.F` for
functions). Packages an extern needs go in `targets.csharp.dependencies`.

| Extern                    | Implementation                                                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extern codec c`          | a class with a parameterless constructor implementing `Rt.ICodec`: `Decode`/`Encode(ReadOnlyMemory<byte>, CodecContext) → byte[]`; `async codec`s override `DecodeAsync`/`EncodeAsync` |
| `@streaming` codec        | `Rt.IStreamingCodec`: `DecodeStreaming(input, ctx) → CodecResult(Output, Consumed)`                                                                                                    |
| `extern type T(args) : V` | `Rt.IExternType<V>`: `int? Size(bytes, args)` (null = need more bytes), `V Read(bytes, args)`, `byte[] Write(V, args)`                                                                 |
| `extern fn f(…) -> R`     | a static method taking the parameters' C# types                                                                                                                                        |

`CodecContext` carries the arguments (`Args`, `Arg<T>(i)`), the decoded size an inner `@size`
gives (`OutputSize`) and, for `@ranged` codecs, the block's position (`Position`). Host failures
become `CODEC` errors. Sources are `Rt.ISource` / `Rt.IAsyncSource` (`Size`, `Read(offset,
length)`); a source that is also an `Rt.ISink` / `Rt.IAsyncSink` receives committed bytes.

## Views and async

A view's root is an object of the regular class, filled lazily:

```csharp
var view = Archive.View(bytes);              // or View(ISource): block-cached, reads what you touch
view.Root.Entries[3].Align = 0x200;             // plain property and list edits
IReadOnlyList<Rt.Patch> p = view.Patches();     // { At, Remove, Insert } against the original
byte[] updated = view.Commit(new Rt.CommitOptions { Grow = Rt.Grow.Splice });

var av = Archive.ViewAsync(asyncSource);     // async sources and formats with async codecs
var size = await av.GetAsync(r => r.Entries[1].Size);
await av.SetAsync(r => r.Entries[2].Handler = 5);
await av.CommitAsync();
```

- `Scan_X` reads a struct's scalars and records each field's byte range and value in an
  `Rt.ViewNode`; inline structs become child nodes. Targets, byte arrays, arrays of fixed-size
  elements, codec regions and `from` streams are deferred in an `Rt.Slot<T>` and read on first
  access. A `from` stream reads through a store that opens (decodes) a piece only when a read
  reaches it; `@ranged` regions decode in 16 KiB blocks.
- **Commit**: same-size edits of scalars with an in-place encoder become patches without reading
  anything else. Any other change re-serializes the root with a sticky layout (placeables keep
  their positions where the grow policy allows: `Default`, `Append`, `Splice`, `Error`),
  unchanged bytes keep their provenance, codec regions reuse their encoded bytes, and the result
  is diffed into patches. `CommitOptions.Rewrite` forces the structural path.
- **Async views** run every access through a retry loop: a missing source block raises
  `NeedBytes`, an async codec `NeedAsync`; both are awaited and the access re-runs. Formats with
  async codecs commit structural edits through `ViewSpec.WriteAsync`.
- After `Commit`, the view is rebound to the committed bytes: use `view.Root` again rather than
  old references.

## Runtime (`packages/runtime-csharp/src/Yaffle.Runtime`)

| File                                                 | Contents                                                                                                                                                                                 |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Api.cs`                                             | `ParseOptions`, source and sink interfaces, array and file sources                                                                                                                       |
| `Errors.cs`                                          | `YaffleException`, `ErrorCode`, `Err`, `SafeResult<T>`, control signals                                                                                                                  |
| `Num.cs`                                             | primitives, exact integer helpers (`Num`), range checks (`Ck`), binary16, `Values`                                                                                                       |
| `Strings.cs`, `Checksum.cs`                          | text encodings and code-unit counts; CRC-32, Adler-32, hex                                                                                                                               |
| `Arrays.cs`                                          | derived arrays (`map`, `filter`, `indicesWhere`, `sortedBy`, `unique`, `concat`)                                                                                                         |
| `Reader.cs`                                          | the read context: primitives, counts, strings, padding, windows, targets with identity, unions, extern types                                                                             |
| `Region.cs`, `Writer.cs`, `Layout.cs`                | the relocation-style writer: blocks, placeables, fixups and base regions (`@ref` resolution), the writer generated code calls, and the layout engine of docs/IR.md §4 with sticky layout |
| `Codec.cs`                                           | codec interfaces and calls, codec reuse, streams, LEB128                                                                                                                                 |
| `Helpers.cs`                                         | write-side checks, stream splitting                                                                                                                                                      |
| `Json.cs`                                            | canonical JSON (`$ref` sharing, a writer without length limits)                                                                                                                          |
| `Stores.cs`, `Streams.cs`                            | byte stores for views: arrays, block-cached sources, windows, ranged codec regions, joined pieces                                                                                        |
| `ViewState.cs`, `ViewRoot.cs`, `Views.cs`, `View.cs` | view metadata and nodes; scanning, commit planning and patches; `View<T>` and `AsyncView<T>`                                                                                             |

## Tests

.NET comes from `$YAFFLE_DOTNET`, `dotnet` on `PATH`, or `nix shell nixpkgs#dotnet-sdk_10`
(the resolved path is cached). Caches and build output go to `$YAFFLE_CSHARP_CACHE` (default
`$TMPDIR/yaffle-csharp-cache`); runtime builds put bin/obj there through
`$YAFFLE_CSHARP_ARTIFACTS`. Test projects and the conformance host target `net10.0`; the backend
tests also build every conformance schema, and an inlined runtime, for `net8.0`.

```sh
# Conformance, parse and view mode (csharp and csharp:view)
node --max-old-space-size=12000 --conditions=development \
  conformance/src/cli.ts --targets csharp
# Backend tests: every schema builds warning-free; the API, views and features end to end
npx vitest run --project yaffle packages/compiler/test/backends/csharp
# Runtime unit tests
nix shell nixpkgs#dotnet-sdk_10 --command dotnet test packages/runtime-csharp/test/Yaffle.Runtime.Tests
```

The conformance adapter (`conformance.ts`) builds one long-running host (`harness/Host.cs`,
`harness/HarnessCore.cs`, the runtime and Roslyn), cached by a hash of its sources. Per case
directory it writes the generated code and a small generated harness, and the host compiles them
in memory, runs the cases and writes one result file per case.

## Known gaps

- One-way transforms on array elements are read but not written ("not implemented").
- Layout item arguments that depend on sizes or positions (`sizeof`, `offsetof`, derives through
  them) are "not implemented"; values, parameters and `$index` work.
- Views of unions that reach an async codec are "not implemented".
- Views read some values completely during the scan: unions and streaming-codec regions (a view
  holding one commits through re-serialization), element-placement arrays (`T x[] at f($index)`),
  and stream pieces whose decoded length the schema doesn't give. A deferred array loads all its
  elements on first access (their own targets stay lazy). `@ranged` async codecs decode whole
  regions.
- In views of a nested (non-root) `@base` struct followed by more inline fields, the base's
  extent covers its inline bytes only.
