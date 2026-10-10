# TypeScript target

The TS backend (`packages/compiler/src/backends/ts`) compiles the IR into one TypeScript module
per `.yfl` module. Generated code imports the runtime `@yafflelang/runtime` (`packages/runtime`) as
`$rt`. The output passes `tsc --strict` with `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess` and erasable syntax only.

```jsonc
// yaffle.json
{
  "targets": {
    "ts": {
      "out": "src/gen",
      "externs": { "zstd": "./externs/zstd.ts", "pathHash": "./externs/hash.ts#hash" },
      "runtimeModule": "@yafflelang/runtime" // optional, the default
    }
  }
}
```

## Generated API

Every exported struct `X` gets an entry-point object `X`:

```ts
import { Archive } from "./gen/archive.ts";

const pf = Archive.parse(bytes); // Archive
const out = Archive.serialize(pf); // byte-identical when nothing changed
const r = Archive.safeParse(bytes); // { ok: true, value } | { ok: false, error }
const p = await Archive.parseAsync(source); // any source, sync or async

const v = Archive.view(bytes); // lazy, editable
v.entries[3].align = 0x200; // same size: patched in place
v.entries.push(entry); // structural: re-encoded on commit
v.$patches(); // [{ at, remove, insert }] against the original bytes
const updated = v.$commit({ grow: "splice" });

const json = Archive.toJson(pf); // canonical JSON (docs/CONFORMANCE.md §3)
const input = Archive.fromJson(json); // ArchiveInput
```

| Member                             | Notes                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `parse(source, options?)`          | `Uint8Array` or sync source; reads the whole source.                                                 |
| `safeParse(source, options?)`      | `YaffleError`s become `{ ok: false, error }`; other exceptions propagate.                            |
| `parseAsync` / `safeParseAsync`    | Any source.                                                                                          |
| `serialize(value, options?)`       | Takes an `XInput` (a parse result or a view works too).                                              |
| `serializeAsync(value, options?)`  | Promise variant.                                                                                     |
| `view(source, options?)`           | Sync view for byte arrays and sync sources, async view for async sources.                            |
| `viewAsync(source, options?)`      | Always an async view.                                                                                |
| `toJson(value)` / `fromJson(json)` | Canonical JSON. Shared targets become JSON-Pointer `$ref`s; one-way transforms show their raw value. |
| `optionsFromJson(json)`            | Options from canonical JSON (root parameters, `endian`, `strict`).                                   |
| `info`                             | `{ name, async }`.                                                                                   |

**Formats with async codecs** (`extern async codec`) have no `parse`, `safeParse` or `serialize`,
and `view` always returns an async view.

**Options** (`XOptions extends $rt.BaseOptions`): `endian` (the root `$endian`, default `"le"`),
`strict` (padding fill, reserved bits and bool bytes are checked), plus the root's parameters,
bound parameters without their `$`. Parameters with a default are optional.

**Errors** are `YaffleError`s with `code`, `path` (field names and indices from the root),
`offset` (absolute, `-1` on write), `detail` and, for `UNION`, `causes`:

| Code      | Meaning                                                                         |
| --------- | ------------------------------------------------------------------------------- |
| `EOF`     | Data ends before a read is complete, or a count can't fit the region.           |
| `CHECK`   | A constant, `in`/`where` check, enum member, strict padding or bool is wrong.   |
| `RANGE`   | A value doesn't fit its type, or a length, offset or alignment is invalid.      |
| `UNION`   | No union variant matched.                                                       |
| `CODEC`   | A codec or extern failed.                                                       |
| `INPUT`   | The input value has the wrong shape or type, or misuse of the API.              |
| `DERIVE`  | A given value disagrees with what the format derives (lengths, offsets, sizes). |
| `REF`     | A `@ref` pointer has no equal value placed in its base.                         |
| `OVERLAP` | Fixed placements overlap, or a stream piece doesn't fit its block.              |

### Types

Each struct gives an output type `X` and an input type `XInput`:

| yaffle                         | TypeScript                                                         |
| ------------------------------ | ------------------------------------------------------------------ |
| integers up to 48 bits, floats | `number`                                                           |
| 56/64-bit integers             | `bigint` (`bigint \| number` in `XInput`)                          |
| `bool`                         | `boolean`                                                          |
| strings                        | `string`                                                           |
| `u8 x[…]`                      | `Uint8Array`                                                       |
| arrays                         | `T[]`                                                              |
| enums                          | a union of member names (open enums add `number`)                  |
| pointers                       | the target's type; `T \| null` when `@nullable`                    |
| `union`                        | `{ type: "Variant"; value: T } \| …`                               |
| `switch` on a field            | a discriminated union, narrowed on the tag's literal values        |
| `if` without `else`, branches  | optional fields                                                    |
| `as` transforms                | the value type; `XInput` takes the raw type for one-way transforms |
| constants, `in (…)` literals   | literal types                                                      |
| extern types                   | the declared value type                                            |

`XInput` leaves out derived, computed and constant fields, and makes `?=` defaults and stream split
points optional. Expressions compute in `number` where interval analysis proves they stay within
±2^53, otherwise in `bigint`; conversions to lengths and offsets are range-checked. User types named
like a global the generated code uses (`Record`, `Map`, `Error`, …) get a `_` suffix.

Internally each struct also gets `read_X` (and `readAsync_X`), `scan_X` (views), `write_X` (and
`writeAsync_X`), `toJson_X`, `fromJson_X` and the view descriptor `$view_X`; these are internals
shared with the runtime and may change.

### Sources

A source is a `Uint8Array`, a `SyncSource` `{ size, read(offset, length), write?(offset, bytes) }`
or an `AsyncSource` whose `read` (and `write`) return Promises. A source is detected as async by a
zero-length probe read. `arraySource(bytes)` and `asyncArraySource(bytes)` from
`@yafflelang/runtime` wrap arrays (they count reads, for tests).

Views read sources through a block cache (64 KiB blocks, 256 blocks; reads over 8 blocks bypass
it). When a view over a source with `write` commits, the source is updated in place: the
patches before the first size change as they are, then everything from that change on in one
write, and `truncate(n)` (required) if the data shrank.

## Views

A view is a `Proxy` over the bytes. Reading a field scans its struct (scalars are read, each
field's byte range recorded); inline structs and arrays become child views, and pointer and `at`
targets, byte fields, codec regions and stream fields are read on first access.

| Member               | Meaning                                                                      |
| -------------------- | ---------------------------------------------------------------------------- |
| `$offset`, `$size`   | The struct's position and size in its byte space.                            |
| `$raw()`             | The struct's current bytes (in-place edits applied).                         |
| `$set({ … })`        | Sets several fields.                                                         |
| `$patches(options?)` | The edits as `{ at, remove, insert }` patches against the original bytes.    |
| `$commit(options?)`  | Applies the edits, returns the new bytes and rebinds the view to them.       |
| `$plain()`           | A deep plain snapshot.                                                       |
| `$source(field)`     | A `SyncSource` over a byte field, stream field or codec region, read lazily. |

`Inner.view(outer.$source("file"))` nests a view over decoded or joined bytes through the same
caches.

**Edits.** Setting a scalar to a value of the same encoded size that no derived or computed field
depends on patches the bytes in place. Anything else (array mutators, size changes, fields that
later reads depend on, replacing a struct or target) materializes the node; `$commit` then
re-encodes the root with the generated writer, passing unchanged byte arrays through, reusing the
encoded bytes of unchanged codec regions, and keeping placeables where they were. The result is
diffed into patches. `$commit({ rewrite: true })` takes this path without edits.

**Grow policies** (`$commit({ grow })`):

- default: targets that grow move to the end; everything else stays unless growth before it
  pushes it forward (by the least that keeps its alignment);
- `"append"`: also targets pushed by inline growth move to the end;
- `"splice"`: nothing moves to the end; every size change shifts what follows;
- `"error"`: any size change is a `DERIVE` error.

**Lazy streams and codecs.** A stream (`T x from arr[*].data`) is a byte store over its
pieces: an offset maps to a piece through the pieces' decoded lengths, taken from the element's
own fields when the schema states them (a counted `u8[n]`, or `u8[]` inside `@size(n)`), and
otherwise learned by decoding the pieces in order. Only the touched pieces are decoded, and at
most 16 pieces (64 MiB) are cached. A `@ranged` codec region decodes only the 4 KiB blocks a read
touches (256 cached). Regions over a stream keep their end unknown until something needs it. A
`@base` struct followed by inline data is measured with the eager reader.

**Async views.** Every property chain (`av.entries[3].data`) is awaitable. Awaiting walks the
sync view; when it needs bytes that aren't fetched or an async codec's output, the walk is
abandoned, the data is fetched and the walk retried (scans and decoded regions stay cached).
Async views change data with `await av.path.$set({ … })`, and `$commit` resolves to the patches
(written back to the source when it has `write`). `$read(f)` runs a side-effect-free function
against the sync view at that path, retrying as needed.

**Async parsing.** Parsing and serializing are sync unless the format has an async codec; then
only `parseAsync`/`serializeAsync` and async views exist, and an async view commits structural
edits through the async writer.

## Host interfaces

Externs are configured per target in `yaffle.json` (`targets.ts.externs`): extern name → module
(relative paths are relative to `yaffle.json`), optionally `module#export`; the default export
name is the extern's name. An unconfigured extern fails with `INPUT` when used. The extern types
`uleb128` and `sleb128` are built in.

```ts
// extern fn pathHash(char path[]) -> u32
export function pathHash(path: string): number { … }

// extern codec zstd / extern async codec oodle / extern codec chacha20(...) @ranged
export const zstd = {
  decode(input: Uint8Array, ctx: { args: unknown[]; outputSize?: number; position?: number }) { … },
  encode(input: Uint8Array, ctx) { … }
};

// extern type VarInt(u8 maxBytes) : u64
export const VarInt = {
  size(bytes: Uint8Array, maxBytes: number): number | undefined { … }, // undefined: need more
  read(bytes: Uint8Array, maxBytes: number): bigint { … },
  write(value: bigint, maxBytes: number): Uint8Array { … }
};
```

- Arguments arrive converted to their declared types (64-bit integers as `bigint`, byte arrays
  as `Uint8Array`). Exceptions thrown by host code become `CODEC` errors.
- Codecs get `ctx.args`, `ctx.outputSize` (when an inner `@size` gives the decoded size) and, for
  `@ranged` codecs, `ctx.position` (the slice's offset in the region). Async codecs return
  Promises. `@streaming` codecs return `{ output, consumed }`. Ranged codecs must map byte i to
  byte i and encode deterministically: views decode their blocks independently and re-encode
  them on commit.
- **Codec reuse:** a value read from a codec region remembers the encoded and decoded bytes. When
  the same object is serialized and its plain encoding is unchanged, the original encoded bytes
  are written instead of re-encoding, so rebuilds are byte-exact even for codecs that don't
  re-encode identically (zstd). `@hidden` stream pieces stay attached to their struct, so
  `serialize(parse(bytes))` reuses every piece.
- Extern types with `@size(n)` skip `size`; `write` must return exactly `n` bytes.

## Runtime structure

`@yafflelang/runtime` has no dependencies; generated modules import it whole.

| Module                   | Contents                                                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `errors.ts`              | `YaffleError`, path helpers, `safe`/`safeAsync`.                                                                                          |
| `prim.ts`, `int.ts`      | Primitive encodings; integer semantics of IR.md §6 (truncating `/`, 64-bit bitwise, ranges).                                              |
| `strings.ts`             | Text encodings, terminators, code-unit lengths.                                                                                           |
| `checksum.ts`            | crc32, adler32.                                                                                                                           |
| `arrays.ts`              | `map`, `filter`, `indicesWhere`, `sortedBy`, `unique`, `concat`.                                                                          |
| `json.ts`                | Canonical JSON conversions, raw values of one-way transforms, hidden stream pieces.                                                       |
| `source.ts`              | Sources, byte stores, block caches, `NeedBytes`/`NeedAsync` control signals.                                                              |
| `reader.ts`              | The read context: windows, bases, targets with identity per address and type, unions.                                                     |
| `writer.ts`, `layout.ts` | The relocation-style writer (blocks, placeables, fixups, regions) and the layout engine of IR.md §4, with sticky layout for view commits. |
| `codec.ts`, `helpers.ts` | Codec calls and reuse, stream join/split, write-side checks, LEB128.                                                                      |
| `api.ts`, `open.ts`      | Glue for the generated roots: parse/serialize, opening views, view types.                                                                 |
| `view.ts`, `lazy.ts`     | Lazy struct and array views, byte spaces and patches; piece and ranged-block stores.                                                      |
| `commit.ts`, `async.ts`  | `$patches`/`$commit`; async views.                                                                                                        |

The language service (`packages/compiler/src/service`) reads views through `nodeOf`,
`StructNode`/`ArrayNode`, `Lazy.target` and `Space` to annotate sample files.

## Tests

```sh
npx vitest run --project @yafflelang/runtime
npx vitest run --project yaffle packages/compiler/test/backends/ts
node --max-old-space-size=12000 --conditions=development conformance/src/cli.ts --targets ts
YAFFLE_TS_VIEW_REWRITE=1 node --max-old-space-size=12000 --conditions=development conformance/src/cli.ts --targets ts
```

- The backend tests compile IR fixtures (`ir.ts`) or `.yfl` sources, typecheck the output with
  `tsc --strict` and run it.
- `--targets ts` runs both `ts` (parse, serialize, round trips) and `ts:view` (every parse case
  through a view, committed without edits). With `YAFFLE_TS_VIEW_REWRITE=1`, view commits use
  `{ rewrite: true }`, exercising the structural-edit path.

## Known gaps

- `@split(fit)` needs element placements to know each block's capacity. After a view edit that
  changes a stream's length, the pieces' size fields from the view no longer cover it (`DERIVE`).
- Union values inside views are snapshots: editing one materializes the parent. Derived and
  computed fields of an edited view node are stale until `$commit`.
- Async ranged codecs decode their whole region in views; an async view's structural commit
  fetches the whole source first.
- NaN payloads are not preserved (f16 NaN is written as `0x7e00`; f32/f64 depend on the engine).
- A target whose content aligns relative to its base must itself start aligned: `@align` inside
  a target that is neither fixed nor aligned at its start is computed as if it were.
- The `@origin` of elements of an array of pointers may only use earlier fields and `this`
  (elements are followed right away, field pointers after the struct).
- A checksum in a nested `@base` that covers a `@ref` resolved by an enclosing base is computed
  over placeholder zeros.
- `inlineRuntime` (copy the runtime into the output) is a programmatic backend option only.
