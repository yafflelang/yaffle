# yaffle IR: semantics

The types live in `packages/compiler/src/ir/ir.ts`. This document says what they mean. It is the
contract between the frontend (which produces IR) and the backends (which turn IR into code).
Both sides must follow it.

## 1. What the frontend has already done

- **Monomorphized.** Generic structs are instantiated per distinct type argument list, type aliases
  are inlined, constants are folded, and `import`s are resolved. Every struct referenced anywhere is
  in `program.structs`.
- **Lowered scoping.** Bound values (`$version`) and lexical references to an enclosing struct's
  fields become implicit parameters (`origin: "bound" | "outer"`). Each use site passes them
  explicitly in `IrStructType.args`. `$endian` is the implicit `endian` parameter
  (`origin: "endian"`, value type `{ kind: "endian" }`). A struct with `usesEndian: false` may
  ignore it.
  - **Parameter order.** `IrStruct.params` is always: `endian` (default `le`) first, then the
    declared parameters in declaration order (`explicit`, and declared `$` parameters with origin
    `bound`), then implicit `bound` parameters sorted by name, then implicit `outer` parameters
    sorted by owner and field. Every struct has the `endian` parameter, even with
    `usesEndian: false`.
  - **Implicit names.** A lowered `$version` is the parameter `version` (`boundName: "version"`),
    suffixed with `_bound` if a declared parameter already has that name. An enclosing struct's
    field `count` is the parameter `count` (origin `outer`), suffixed with `_outer` on a collision.
    A use site passes a field of the current struct if it binds the value before the use (or _is_
    the enclosing struct), and the current struct's own implicit parameter otherwise.
- **Resolved reverses.** Every value the writer computes has a `derive` expression.
- **Normalized expressions.**
  - Constants are folded where the operands are literals, including enum and const references and
    `sizeof(Type)` of fixed-size types.
  - A character code assigned to or compared with an integer whose endianness is inherited lowers
    to `cond($endian == be, <big-endian value>, <little-endian value>)`. With fixed endianness it
    is a literal. Such a field is still `deriveKind: "constant"`, with a check `it == <same expr>`.
  - Arithmetic (`+ - * / % << >> & | ^`, unary `-` and `~`) always has type `bigint` or `float`
    (f64), and both operands have exactly the result type: the frontend inserts `convert` on
    integer fields. Comparisons don't convert when both sides already have the same type. An
    integer literal compared with an int field takes that field's type (`version >= 3` compares two
    `u32`).
  - String lengths are never `len(<string>)`. Derived string lengths and `s.length` use
    `encodedLength(s, unit, encoding)`, divided by `unit` for 2- and 4-byte units. `len` is used
    for arrays and bytes.
  - `x == null` is `isNull(x)` and `x != null` is `!isNull(x)`. There is no null literal.
- **Inferred value types.** The value type of an integer `transform` is the smallest standard
  integer type (u8/u16/u32/u64, i8/…/i64) holding the read expression's static range (interval
  analysis); unbounded or beyond 64 bits gives `i64` (`u64` if non-negative). The read
  expression's own `type` stays `bigint`. Untyped constants (`const N = 4`) get a type the same way.
- **Complete bit units.** Every `IrBits` unit's fields cover the whole storage unit: bits not
  declared become an implicit reserved field (`name: null`), so strict checks are well defined.
- **Checked:** names, types, bindings on every path, layout paths, reversibility, and layout
  cycles. A program that reaches a backend is valid.

## 2. Reading

### 2.1 Context

A read happens in a context with:

|                   |                                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `buffer` / source | the bytes (sync or async, random access)                                                                                                  |
| `pos`             | absolute position of the next inline byte                                                                                                 |
| `base`            | absolute position of the current base. The file start (0) at the root, changed by `@base` structs                                         |
| `end`             | absolute end of the current region: the source size at the root, narrowed by `@size` layers and by the extent of a codec's decoded output |
| `index`           | the index of the element being read, inside arrays                                                                                        |
| `strict`          | whether strict checks are on (root option, struct `strict`, or a `strict` layer)                                                          |
| params            | the struct's parameter values                                                                                                             |

`$offset` = `pos - base`, `$end` = `end - base`, `$index` = `index`. **All offsets in expressions
are relative to the base.** Absolute positions never appear in values.

### 2.2 Members in order

Members are read in declaration order. Each field's value becomes visible to later expressions
under its name. Blocks and switches don't introduce a scope: their fields are visible after them,
as if declared inline. A field from a branch not taken is "absent": reading it in an expression is
a frontend error unless the expression is guarded. The frontend guarantees this.

- **Inline field:** read its type at `pos` and advance `pos` by the bytes consumed.
- **`placement`:** evaluate `offset` and read the type at `base + offset` without moving `pos`. The
  region's `end` stays the same. With `emptyIsNull` (an array target), a stored offset of 0 reads
  as an empty array.
- **`from`:** build the virtual stream (§2.8) and read the type from it as a fresh region
  (base = 0, end = stream length). `pos` doesn't move.
- **`virtual`:** the field occupies no bytes. Evaluate `virtual.read` (type `bigint`, earlier
  fields only) and range-check the value against the field's declared type, which is an integer
  prim (`RANGE`, like any typed location, §6). Nothing is read with the prim.
- **Checks:** after reading the value, evaluate every check with `it` = the value. A false check is
  a `CHECK` error (CONFORMANCE.md §Errors). Strict-only checks run only in strict mode.

### 2.3 Types

| Type        | Read                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prim`      | little/big endian per `endian` (`inherit` = the `endian` param). `u24`…`i56` are N-byte integers; signed values are two's complement and sign-extended. `f16` is IEEE half.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `bool`      | one byte; nonzero → true (strict: anything other than 0 or 1 is a `CHECK` error).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `string`    | see the doc comment in ir.ts. Invalid UTF-8/16/32 is a `CHECK` error. `ascii` rejects bytes ≥ 0x80. `latin1` maps bytes 1:1 to U+0000–U+00FF.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `bytes`     | `count` bytes, bytes until a terminator byte, or bytes up to `end`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `array`     | elements per `length`. `until`: read an element, stop if it equals the terminator (compared as values). `before`: stop before an element that would equal the terminator; the terminator is not consumed. `untilPredicate`: read an element, stop if the predicate holds for it (`it` = the element); that element is included. `rest`: read elements while `pos < end`. If an element would cross `end`, that's an `EOF` error. With `elementPlacement`, element _i_ is read at `base + elementPlacement($index = i)`, and with `rest`, reading stops when that offset is ≥ `$end`. Elsewhere, `$index` is the index in the nearest enclosing array.                                                                                   |
| `struct`    | evaluate `args` in the caller's context, then read the struct's members. If the struct is `base`, set `base = pos` (or the placement address) for its contents. Struct-level `layers` wrap the struct (they apply inside any use-site layers).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `enum`      | read the storage prim. An unknown value is a `CHECK` error unless `open`; open unknowns are returned as plain integers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `pointer`   | read `storage`. Equal to `nullValue` → null. Otherwise target address = `base + offset` (owned and ref alike), or `fieldAddress + offset` if `relative`, where the offset is signed; with `origin`, it is `base + origin + offset`, where `origin` is evaluated like a write formula (§3.2: it may use `offsetof` of any field of the struct, also later ones, and `offsetof(this)`). Read the target there without moving `pos`. The target may be an array (`T[n] *p`). With `emptyIsNull` (always with `nullValue: "0"`), the target is an array and a stored 0 reads as an empty array, so the value is never null. **Identity:** within one parse, the same target address _and_ the same target type yield the same value object. |
| `extern`    | call host `size(view, ...args)` with a view starting at `pos`. `undefined` means "need more bytes": give a longer view, and at `end` that's an `EOF` error. Then `read(bytes[0..size], ...args)`. With `fixedSize`, skip `size()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `union`     | try each variant at `pos`. The first that reads without error (checks included) wins. If none does, that's a `UNION` error listing each variant's error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `transform` | read `inner`, then evaluate `read` with `it` = the inner value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `layered`   | apply the layers from outermost (last) to innermost (first) around reading `inner` (§2.4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### 2.4 Layers on read

Processed from the outermost layer inwards:

| Layer                          | Read behaviour                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `align(to)`                    | skip forward until `(pos - origin + offset) % to == 0`. Strict: the skipped bytes must equal the fill.                                                                                                                                                                                                                                                                                 |
| `padBefore(n)` / `padAfter(n)` | skip n bytes before or after the inner content.                                                                                                                                                                                                                                                                                                                                        |
| `padUntil(size)`               | read the inner content, then skip until it occupies `size` bytes. Content larger than `size` is a `CHECK` error.                                                                                                                                                                                                                                                                       |
| `alignEnd(to)`                 | after the inner content, skip until `(pos - origin + offset) % to == 0`.                                                                                                                                                                                                                                                                                                               |
| `size(n)`                      | narrow `end` to `pos + n`, read the inner content inside it, then set `pos` to the window end. The leftover is padding (strict: must be zero).                                                                                                                                                                                                                                         |
| `via(codec, args)`             | take the encoded bytes: the window `[pos, end)`, unless the codec is `streaming`, in which case it reports how many bytes it consumed. Decode them and read the inner content from the decoded bytes as a fresh region (base = 0, end = decoded length). Then `pos` advances by the encoded length. If an inner `size` layer exists, its value is passed to the codec as `outputSize`. |
| `endian(v)`                    | evaluate `v` (outside the layer) and use it as the `endian` argument for everything inside.                                                                                                                                                                                                                                                                                            |
| `strict`                       | turn on strict mode inside.                                                                                                                                                                                                                                                                                                                                                            |

- **Alignment origin.** `align` and `alignEnd` measure from the current base by default. With
  `from: "file"` they measure from the start of the current byte space: the root source, a
  codec's decoded region, or a virtual stream, i.e. whatever `$offset` would count from if there
  were no `@base` in between. `offset` (default 0) aligns the position that many bytes ahead. The
  frontend emits `from` only as `"file"` and `offset` only when it isn't 0.
- **Strict padding.** A padding layer (`align`, `alignEnd`, `padBefore`, `padAfter`, `padUntil`)
  with `strict: true` checks its own fill on read even outside strict mode. It may appear on
  field, block and struct layers.
- **Endian layers** rebind `$endian`: inside one, both `endian: "inherit"` and every
  `{ kind: "param", name: "endian" }` expression, including the `endian` argument passed to
  nested structs, mean the layer's value.

Padding fill: `{ kind: "byte" }`, or `{ kind: "fn" }` evaluated per byte index (0-based within that
padding run), keeping the low 8 bits.

### 2.5 Bits

Read the storage unit (prim, endianness per `endian`). Field value = `(unit >> shift) & mask(width)`,
sign-extended for signed prims, converted for bool/enum. Reserved fields (`name: null`) must be
zero in strict mode.

### 2.6 Switch and blocks

- **Block:** evaluate `condition`. If true, read `members`, otherwise `else` (if any). Apply
  `layers` around the members.
- **Switch:** evaluate the discriminant, then read the members of the first case with an equal
  literal, else `default`. If nothing matches and there is no default, that's a `CHECK` error.

### 2.7 Errors

Every error carries a **path** (field names and array indices from the root) and an **absolute
offset**. Codes are in CONFORMANCE.md.

### 2.8 Virtual streams

- **`field`:** that bytes field's value (the decoded bytes).
- **`each`:** the bytes field of every element of the array field, joined. `from.split` is present
  only for `each` streams.
- **`slice`:** `[start, end)` of another stream.

Lazy implementations may decode pieces on demand. If every piece has a fixed decoded size, or the
sizes are known from fields, an offset maps directly to a piece.

## 3. Writing

### 3.1 Input values

The writer takes an _input value_ shaped like the generated input type: every field with
`input: "required"`, optionally fields with `input: "optional"`, and never fields with
`input: "absent"`. If an `absent` field is present in the value, it is ignored. That way
`serialize(parse(bytes))` works directly.

- A `derive` that uses `it` normalizes the input (`u32 flags = it | 0x80`): `it` is the field's
  input value, the field stays `input: "required"`, and the writer stores the derived value. A
  `derive` without `it` comes with `input: "absent"` or `"optional"`.
- A default (`u32 align ?= 0x100`) is `input: "optional"` with the default as `derive`,
  `deriveKind: "formula"` and no check.
- A virtual field's value comes from the input (`required`, or `optional` with its default as
  `derive`). Its parts are derived from it: their `derive` expressions use `>>`, `&`, `/`, `%`, `+`
  and `-` on the virtual field's value, with `deriveKind: "auto"` and `input: "absent"` (parts may
  be bit fields). A virtual field is never a part of another one. After writing, `virtual.read`
  must give back the input value, otherwise it's a `DERIVE` error.

### 3.2 The write context and `derive`

`derive` expressions are evaluated in the **write context**:

- `field` references read the input value, or the derived value for derived fields. Derived fields
  may reference each other as long as there is no cycle (the frontend checks this).
- `sizeof` / `encodedSize` / `bytesof` / `encode` take the field's final encoding.
- `offsetof` takes the field's final position (from the base).
- `$index` is the element index, and params are as on read.

A derived field's final value can depend on positions that are only known after layout, e.g.
`u64 tableOfs` derived from `offsetof(table)`. **Recommended writer shape (relocation style):**

1. Encode bottom-up into nodes: inline bytes plus a list of fixups (position, width, endianness,
   closure computing the value from final sizes and positions) plus a list of placeable targets.
2. Run layout (§4) to assign every target a position.
3. Evaluate and patch the fixups.
4. Concatenate.

The frontend rejects layout cycles, i.e. a derived value whose own _size_ depends on a position.
Variable-size derived fields (varints, extern types) that feed into positions are a compile error.

### 3.3 Consistency

After writing, every field with a derive must satisfy its checks. The read-side expressions must
agree with what was written: an array written with N elements whose length expression evaluates to
M ≠ N is a `DERIVE` error, and so is a constant that would read back differently. A `transform` with
`write` must round-trip: read(write(v)) == v, or it's an `INPUT` error. Backends may skip the
round-trip check for float transforms when the difference is below the half-ulp of the storage.

An `untilPredicate` array must end with an element satisfying the predicate, and no earlier
element may satisfy it. A `before` terminator is not written.

### 3.4 Pointers on write

- **owned:** the target is a _placeable_ in the current base (the nearest enclosing `@base`
  struct, or the root). The pointer value is computed in a fixup: `offset = targetPos - base`
  (relative: `targetPos - fieldPos`; with `origin`: `targetPos - base - origin`), and a null value
  writes `nullValue`. With `emptyIsNull`, an empty target array writes `nullValue` (0); the same
  holds for the offset of a `placement` with `emptyIsNull`.
- **Identity:** two pointers to the _same object_ (reference identity in the input) share one
  target. Deduplicating equal values happens only for `ref` pointers.
- **ref:** the pointer gets the offset of an already-placed, _equal_ value of the same type in the
  same base: an element of an inline array, a field, or another target. Equality is equality of
  encodings. If no such value exists, that's a `REF` write error. When several match, the first
  placed wins.

### 3.5 Layers on write

These mirror reading:

- **size:** written as the derived value (the frontend has derived the size field from
  `encodedSize`). A size that doesn't match the actual inner length is a `DERIVE` error, unless
  the inner content is shorter and the remainder is padding.
- **via:** encode the inner bytes with the codec. With an inner `size` layer, pass `outputSize`.
- **padUntil:** content larger than the size is an error.
- Fill bytes come from `fill`.

### 3.6 Codec reuse (byte-exact rebuilds)

If a value came from a parse (same process, tracked by object identity) and the decoded content
of a `via` region is unchanged, the writer reuses the original encoded bytes instead of
re-encoding. Views get this naturally. The same applies to `from` pieces.

### 3.7 Streams on write

- **`from field`:** the consumed bytes field is `input: "absent"` and derived from the field read
  from it. It stays an output field unless `hidden`.
- **`from arr[*].piece`:** in the element struct of `arr`, `piece` is `input: "absent"` (its
  content comes from the stream), and fields whose `derive` measures it (`encodedSize(piece, i)`)
  are `input: "optional"`: split points, used when given for byte-exact rebuilds, otherwise
  `from.split` decides.
- **Slice carriers** (`carrier: "slices"`): a bytes field read only through `from` slices of
  itself (`T x from raw[a..b]`) is `input: "absent"`. On write it is a zero-filled buffer of the
  field's own length (or, for `rest` lengths, the largest slice end) with every slice field's
  encoding written at its start. Overlapping slices must produce identical bytes, otherwise it's
  a `DERIVE` error. Carriers are only single-level slices of a `field` stream, and their length is
  a constant, an input-only expression, or `rest`: the frontend never marks a carrier whose length
  or slice bounds depend on the carrier itself.

## 4. Layout: placing pointer and `at` targets

### 4.1 Placeables

Within a base, a **placeable** is the target of an owned pointer or a field with `placement`
(unless `fixed`). Each placeable has a **unit**: its own inline bytes ("this") plus the units of
its own placeables, ordered by its struct's `layout` (default: this first, then its placeables in
declaration order, recursively, i.e. pre-order depth-first). A nested `@base` struct's unit is
self-contained: its placeables are laid out inside its own region.

A placement is `fixed: false` exactly when its offset expression only uses fields that the writer
derives (automatically or by formula); constants, parameters and input fields make it `fixed`.
`constraint` comes from linear reverses (`at sector * 0x800` → modulus 2048, remainder 0).

### 4.2 Base region

`[base inline bytes][placeables per the base struct's layout]`. A base's `this` is always first,
because offsets count from it.

### 4.3 Layout items

Each placeable is placed at most once. The rules below are what the TS runtime's `layout.ts`
implements. The other runtimes port it, and the language service's layout simulator
(`layoutSuggest.ts`) mirrors it.

1. **Claims first.** Before anything is placed, every placeable named by _any_ item of a
   container's layout is claimed by that item and removed from every other unit, even when an
   earlier `x[*]` item would otherwise reach it (pulling groups out).
2. **Then items in order:**
   - **A path naming a placeable field** (`curves`, `records[*].model`) places the unit of each
     placeable it matches.
   - **A path naming inline data or `[*]` elements** (`records[*]` where elements are inline in
     the `records` target) places the remaining units of all placeables reachable from those
     elements, in their own layout order.
   - **`this`** places the struct's own inline bytes.
   - **A group** (`volumes[*] { … }`, `IrLayoutItem.group`) runs per element of the array its
     `path` names (the path has no trailing `each`), in order. If the element is a placeable (a
     pointer or `at` element target), its own bytes come first unless a group item names `this`
     (as in a unit, rule 3); then the group's items, relative to the element. Everything the
     nested items name is claimed by the group. Targets of elements the group doesn't name are
     leftovers.
3. **`this` comes first** in a unit unless an item names it.
4. **Leftovers** (placeables no item placed) follow the items in default order.
5. **Empty targets** (empty arrays and strings) are placed at the current position after alignment,
   and a writer accepts any stored offset for them.
6. **Fixed placements** go exactly where their offset says. When layout reaches one, the running
   position moves to its end if that is further on.

### 4.4 Alignment and constraints

- **Item layers** (`align`) apply to every structure placed by that item, unless a nested layout
  item specifies its own. Group layers apply to nested items without layers of their own.
- **Placement constraints** (`constraint`) add an alignment-like requirement: the writer moves the
  position forward to the next value ≡ remainder mod modulus.
- **Gaps** are filled with zero.

**Layout items that read fields.** Arguments of a layout item's layers (`@align(align)`,
`@align(1 << shift)`) are evaluated in the **write context of the struct that owns the layout**: its
fields (input or derived values), its parameters and `$index` where applicable, the same as its
write formulas. They never see fields of the placed target, so `recs[*].body @align(count * 2)` uses
the container's `count`. Any alignment, constant or computed, must be at least 1; 0 or a negative
value is a `RANGE` error, even when the item places nothing (arguments are evaluated per
instance, like write formulas). Arguments can't depend on sizes or positions (`sizeof`,
`offsetof`). Conformance: `conformance/cases/layout-fields`.

### 4.5 Fixed placements and overlaps

A `fixed` placement goes exactly at the given offset, and overlapping another placed byte range is
an `OVERLAP` error. The same applies to `elementPlacement` arrays: element _i_ goes at its computed
offset, and must not overlap element _i+1_.

## 5. Codecs, extern functions and extern types (host side)

Host implementations are found through `yaffle.json` `targets.<lang>.externs[name]` (a module
path per target). Shapes in TS:

```ts
// extern fn pathHash(char path[]) -> u32
export function pathHash(path: string): number;

// extern codec zstd / extern async codec oodle / … @ranged
export const zstd = {
  decode(input: Uint8Array, ctx: { args: unknown[]; outputSize?: number; position?: number }): Uint8Array, // or Promise for async
  encode(input: Uint8Array, ctx: { args: unknown[]; position?: number }): Uint8Array,
};
// @ranged: decode/encode may be called on any slice; ctx.position is the slice's offset within the encoded region.
// @streaming: decode returns { output: Uint8Array; consumed: number } and gets the rest of the region as input.

// extern type VarInt(u8 maxBytes) : u64
export const VarInt = {
  size(bytes: Uint8Array, maxBytes: number): number | undefined,
  read(bytes: Uint8Array, maxBytes: number): bigint,
  write(value: bigint, maxBytes: number): Uint8Array,
};
```

Built-in extern types: `uleb128` (value `u64`) and `sleb128` (value `i64`) have `builtin: true`,
`module: ""` and exactly those ids. Every runtime implements them; they need no `externs` entry.
Built-in codecs that need no host: none. Built-in functions (`crc32`, `adler32`, …) are implemented
by each runtime.

## 6. Expressions: integers, floats and built-ins

- **Exact arithmetic.** Integer expression arithmetic is mathematically exact: no wraparound. A
  result is checked when it lands in a typed location (array length, offset, field, argument). Out
  of range is a `RANGE` error.
- **Division** truncates toward zero. `%` takes the sign of the dividend. Division by zero is a
  `RANGE` error.
- **Shifts:** the shift count must be in 0..63. `>>` is arithmetic on negative values.
- **Bitwise operators** (`& | ^ ~`) work on the 64-bit two's complement representation.
- **Mixed int/float** arithmetic converts to f64 (the checker inserts `convert`).
- **`round`** rounds half away from zero.
- **Comparisons** across int widths compare mathematical values.
- **Equality of composite values.** `==` and `!=` on arrays, strings and bytes compare by value,
  element-wise; bytes may be compared with an array of integers (element-wise, as numbers). On
  structs they compare canonical JSON equality.
- **TS representation:** values of up to 32 bits (and u40/u48 when ≤ 2^53) are `number`; 64-bit
  fields are `bigint`. Generated code may compute in `number` when it can prove the range stays
  below 2^53, and must use `bigint` otherwise.

Built-ins beyond the obvious:

- **`encodedLength(s, unit, encoding)`** returns bytes, so `char16 t[n]` derives
  `n = encodedLength(t, 2, "utf16") / 2`.
- **`this`** is only the argument of `sizeof` (write context only; for a `@base` struct its whole
  region including targets and `@alignEnd`), `offsetof` (the struct's start from the base),
  `bytesof` and `encode`. Its type is the current struct.
- **`sum(arr)`** is the sum of an array of numbers (0 when empty), of type `bigint` (f64 for floats).
  **`min`/`max` with one array argument** give its smallest/largest element (the element type); an
  empty array is a `RANGE` error.
- **`lengths(arr)`** is the element count of each element of an array of arrays (pointer targets
  are transparent), as an array: the reverse of `u16[lens[$index]] *lists[9] : u64`, where
  `$index` inside the element type is the index in `lists`.
- **`isNull(x)`** takes one argument of a `nullable` type.
- **Derived arrays.** `map`, `filter`, `indicesWhere` and `sortedBy` take an array and a
  `{ kind: "lambda" }` as their second argument (the only place a lambda appears; its body sees the
  enclosing context). `unique` takes an array, `concat` one or more. Result types: `map` → an
  array of the lambda body's type; `filter`, `sortedBy`, `unique` → the input's type (bytes stay
  bytes); `indicesWhere` → an array of `bigint`; `concat` → `bytes` if every input is bytes, else
  an array of the unified element type. A derive or check operand of array type assigned to (or
  compared with) a bytes field converts element-wise, range-checked (`RANGE`). `sortedBy` keys
  compare as numbers, strings by code points, or bytes lexicographically, and the sort is stable.

## 7. Generated API (every backend)

For each root: `parse`, `parseAsync` (if async or for async sources), `serialize`,
`serializeAsync`, `safeParse`, `view` (tier 2), `toJson`, `fromJson`. Names are adapted to each
language's conventions (Rust: `parse`, `serialize`, `to_json`, …). Canonical JSON is defined in
CONFORMANCE.md. Root parameters (explicit + bound + endian) become parse/serialize options.

### Output and input types

- **Output type:** every field with `output: true`.
  - Fields of conditional blocks without else are optional.
  - if/else blocks and switches become discriminated unions where a discriminant field exists
    (TS: a union of object types). Otherwise the fields from both branches are optional.
  - Pointers have the target's type, plus null if nullable.
  - Unions are `{ type: "<Variant>", value }`.
- **Input type:** the same, minus `absent` fields, with `optional` fields optional.

## 8. Worked examples

`yaffle ir file.yfl` prints the IR for real sources. These sketches show the shapes.

### 8.1 Derived count

```c
struct Table { u32 count  Entry entries[count] }
```

```jsonc
{ "kind": "field", "name": "count", "type": { "kind": "prim", "prim": "u32", "endian": "inherit" },
  "derive": { "kind": "call", "callee": { "kind": "builtin", "name": "len" },
              "args": [{ "kind": "field", "name": "entries", "type": { "kind": "array", "element": { "kind": "struct", "struct": "Entry" } } }],
              "type": { "kind": "bigint" } },
  "deriveKind": "auto", "checks": [], "hidden": false, "output": true, "input": "absent" }
{ "kind": "field", "name": "entries",
  "type": { "kind": "array", "element": { "kind": "struct", "struct": "Entry", "args": [{ "kind": "param", "name": "endian", "type": { "kind": "endian" } }] },
            "length": { "kind": "count", "expr": { "kind": "field", "name": "count", "type": { "kind": "int", "bits": 32, "signed": false } } } },
  "checks": [], "hidden": false, "output": true, "input": "required" }
```

### 8.2 Endianness block

```c
struct TiffHeader { char order[2] in ("II", "MM")  @endian(order == "MM" ? be : le) { u16 magic = 42  u32 firstIfd } }
```

This gives a block with layers `[{ kind: "endian", value: cond(order == "MM", be, le) }]`. `magic`
has `derive: 42`, `deriveKind: "constant"`, a check `it == 42`, and `input: "absent"`. `order` has
`literals: ["II", "MM"]`, an `in` check, and `input: "required"`.

### 8.3 Layered sizes

```c
struct Packed { u32 expSize  u32 compSize  Asset body @size(expSize) @via(oodle) @size(compSize) }
```

- `body.type` is `layered(struct Asset, [size(field expSize), via(oodle), size(field compSize)])`.
- `expSize.derive` is `encodedSize(body, 0)` and `compSize.derive` is `encodedSize(body, 2)`.
- `program.structs` has `Packed.async = true` because `oodle` is async.

### 8.4 Bound value lowering

```c
struct Asset { u32 $version  Record r }
struct Record { Motion m }
struct Motion { if ($version >= 144) { u32 extra } }
```

- `Motion.params` gets `{ name: "version", origin: "bound", boundName: "version", type: u32 }`,
  and `Record.params` gets the same, because `Record` passes it through.
- In `Asset`, the field `r` has type `{ kind: "struct", struct: "Record", args: [endian, field version] }`.
- In `Record`, `m` passes `param version`.

### 8.5 `at` with a linear reverse

```c
u32 sector  u8 data[size] at sector * 0x800
```

- `sector.derive` is `offsetof(data) / 0x800`.
- `data.placement` is `{ offset: sector * 0x800, constraint: { modulus: "2048", remainder: "0" }, fixed: false }`.
