# The yaffle language

yaffle describes binary file formats in `.yfl` files. A description is read in both directions:
it parses bytes into values and serializes values back into bytes, byte-exact when the
description says enough. `docs/IR.md` is normative for the precise semantics, and
`docs/CONFORMANCE.md` defines the canonical JSON form and the error codes.

## 1. Principles

1. **Read-side expressions see only earlier fields.** Lengths, `at`, conditions and attribute
   arguments may refer to fields declared before them, parameters, enclosing structs (lexical
   nesting) and bound `$values`. This one rule also explains endianness switches and every other
   scoping question.
2. **Write formulas (`= expr`) see every field**, because the whole value is known at write time.
3. **Bytes that would read back differently are never written.** A contradiction between a formula
   and a read-side expression is a compile error when provable, otherwise a write error.
4. **Attributes nearest the thing apply first.** For postfix attributes on a field, that's the
   leftmost. For a block, it's the one just before `{`. Each wraps the result so far.
5. **Derived fields fill themselves in.** Lengths, counts, offsets and sizes are reversed
   automatically when the expression allows it, and the field drops out of the input.
6. **Byte-exact rebuilds are supported, not required.** The defaults produce valid files.
   `layout`, `@ref`, split points and codec reuse exist to reproduce originals exactly.

Every struct therefore has two value shapes. The **output** is everything a parse produces. The
**input** is what a serialize needs: the output minus derived fields, constants, padding and
`@hidden` fields, with `?=` fields optional. Within one parse, every struct read at a given address
with a given type is one object, so shared pointer targets are shared values and cycles are
allowed. Trailing bytes after the root are ignored.

## 2. Reference

### 2.1 Structs and primitives

```c
struct Entry {
  u16   handler
  u16   kind
  u32   align
  u64   offset
  u64   size
  u32be crc                 // fixed endianness
}
```

- C style: type before name, array size after the name. Semicolons are optional, so a struct
  pasted from Ghidra mostly parses as is. Comments are `//` and `/* */`.
- `u8`, `u16`, `u24`, `u32`, `u40`, `u48`, `u56`, `u64` (and `i…`), `f16`/`f32`/`f64`, `bool`,
  with `le`/`be` suffixes for fixed endianness. `bool` is one byte: nonzero reads as true (strict:
  only 0 or 1), and writes 0/1.
- **Anonymous blocks** `{ … }` group fields under attributes or conditions. Their fields flatten
  into the parent.

### 2.2 Endianness

```c
struct TiffHeader {
  char order[2] in ("II", "MM")
  @endian(order == "MM" ? be : le) {
    u16 magic = 42
    u32 firstIfd
  }
}
```

There's no file-wide setting. A struct inherits endianness from where it's used, and the root
defaults to `le`. `@endian(x)` sets the built-in bound value `$endian` (§2.12) for a struct, field
or block.

### 2.3 Arrays

```c
struct Table {
  u32   count                    // written as entries.length
  u32   pairs                    // written as ids.length / 2
  Entry entries[count]
  u16   ids[pairs * 2]
  u8    hash[0x20]               // a byte string
  u8    rest[]                   // to the end of the enclosing region
  u16   list[until 0xffff]       // terminator: consumed, not in the value, written back
  Bank  banks[until it.next == 0]  // inclusive: the element that satisfies it is part of the array
  str   pool[before ""]          // stops before an element equal to "", without consuming it
}
```

- **Automatic reverse:** a field used only as a length, directly or through `+ − × <<` with
  constants, is computed on write and left out of the input. Divisibility is checked.
- **Can't be reversed** (`(n + 7) / 8`, `rows * cols`): the field stays an input and is checked.
- **Shared counts:** several arrays using the same count must agree on write.
- **`T x[]` with struct elements** repeats until the region ends. Combined with `at`, see §2.18.
- **`until`** takes a terminator value, or a boolean expression over `it` (the element just read).

### 2.4 Write formulas and externs

```c
extern fn pathHash(char path[]) -> u32

struct Node {
  u32  n     = flags.length * 8     // you choose the reverse when the compiler can't
  u8   flags[(n + 7) / 8]
  u32  size  = sizeof(body)
  u32  crc   = crc32(body)
  u32  hash  = pathHash(path)
  u32  align ?= 0x100               // optional input: the default when absent, kept when given
  char path[0x40]
  Body body
}
```

- `=` gives the **raw value written**, always computed. Without `it` the field leaves the input;
  with `it` it's a transform (§2.10). Formulas are not checked on read, except constants.
- A formula equal to the automatic reverse is redundant. A formula that agrees with the read side
  only for some values is lossy: it breaks byte-exact rebuilds of files with other values.
- **Externs** are declared in yaffle and implemented once per target language. Their failures are
  `CODEC` errors.

### 2.5 Constants and constraints

```c
u16  magic = 42                   // constant: written automatically, checked on read
char tag[4] = "ARCV"
char order[2] in ("II", "MM")     // input type "II" | "MM"
u32  version in (1, 2, 5..9)
str  ver in /v\d\.\d{1,2}/        // portable regex subset (RE2-style: no backrefs or lookaround)
u32  size where it % 4 == 0       // any condition; `it` = this field's value
```

Checks apply in both directions: a violation is a `CHECK` error on parse and on serialize.

### 2.6 Strings

```c
char   name[0x20]   // fixed: text up to the first \0, padded with \0 on write
str    path         // char[until 0]
str16  wide         // char16[until 0], UTF-16, follows $endian
str32  wider        // char32[until 0], UTF-32, follows $endian
u8     len
char   title[len]   // lengths count code units, never characters
```

`char` is UTF-8 by default; `@encoding("latin1" | "ascii")` changes it. Other encodings go through
`extern`. Data after the `\0` in a fixed `char[n]` is dropped by a parse (views keep it); use
`u8[n]` if it matters.

### 2.7 Attributes, padding, alignment

```c
struct Header @padUntil(0x80) {          // struct attributes go between the name and `{`
  char tag[4] = "ARCV"
  u32  count
}

struct Entry {
  u32 a        @padBefore(4)
  u32 b        @padAfter(4, 0xcc)        // fill byte
  u8  data[16] @align(0x100)             // pad before, from the nearest @base
  u8  tail[]   @align(0x10, i => i & 0xff) @strict
  str name     @padUntil(0x20, 0xff)     // "hello\0" then 0xff up to 0x20 bytes
  u8  head[25] @align(4, offset: 0x19)   // pad until (position + 0x19) % 4 == 0
  u8  blk[64]  @align(0x100, from: file) // from the file start, not the nearest @base
  u64 offset   @align(8)
               @padAfter(8)              // a line starting with @ continues the previous field
}
```

- Field attributes go **after** the declaration. Block attributes go in front.
- `@align(n, fill?, strict?, from: file | base, offset: k)`. Named arguments may also name the
  positional ones (`to:`, `fill:`).
- `@padUntil(n, fill?)` pads after the content; content that is too large is a `CHECK` error on
  parse and an `INPUT` error on serialize. `@padUntil(n, strict)` is zero fill, checked.
  `@alignEnd(n)` pads the end of a struct; on a `@base` struct, after all its targets.
- Reading skips padding without checking it; `@strict` makes a fill mismatch a parse error.

### 2.8 Pointers and bases

```c
struct Asset @base {                      // offsets inside count from the start of Asset
  Model  *model : u64                     // the pointer is transparent: the value is just `model`
  Graph  *graph : i32 @relative           // target = address of this field + value
  Extra  *extra : u64 @nullable           // 0 → null; @nullable(0xffffffff) for other nulls
  Record *recs[count] : u64               // an array of pointers
  CurvePoint[n] *points : u64             // a pointer to an array; n is derived from its length
  Step[k] *steps : u64 @nullable(empty)   // an empty array writes 0, and 0 reads as empty
  u16[lens[$index]] *lists[9] : u64       // element-wise: lens[i] = lists[i].length on write
  str    *name : i32 @ref @origin(offsetof(pool))   // target = base + origin + value
  u64    tableOfs                         // derived from where `table` is placed
  Record table[count] at tableOfs
  u8     data[size] at sector * 0x800     // linear `at` → placement constraint (0x800-aligned)
}
```

- **Shared targets:** the same offset gives the same object on read, and it's written once.
- **`at` that can't be reversed:** the offset stays an input, the target goes exactly there, and
  overlaps are `OVERLAP` errors. Alternatively, `= offsetof(t) - base`.
- **An empty `at` array** is placed at the current position, whatever its offset expression.
- **`x == null` / `x != null`** test `@nullable` pointers.
- **Following a pointer** is lazy in views, and an await point with async sources.

### 2.9 Conditionals and unions

```c
if (version >= 3) { u32 extra } else { u16 legacy }

switch (tag) {
  case "ARCV": Archive body
  case "ASST": Asset   body
  default:     u8      body[size]
}

union Node { Archive  Index }        // try in order; the variant's checks decide
```

- A `switch` field's value is a union discriminated by the tag. A `union`'s value records which
  variant matched; variants are named after their types.
- **`if` without `else`** makes the block's fields optional.

### 2.10 Value transforms and enums

```c
enum MemKind : u16 { Sys = 0, Vram = 1 }    // @open: unknown values pass through as numbers

struct Entry {
  MemKind kind
  u16     angle as it * 360.0 / 65536              // reverse worked out
  u8      name  as names[it]                       // reverse: names.indexOf(it)
  u32     tag   as decodeTag(it) = encodeTag(it)   // explicit reverse
  u32     hash  as hex(it)                         // one-way: input stays u32, read-only in views
  u32     flags = it | 0x80                        // normalize on write
}
```

`as` reads (raw → value, `it` = raw). `=` writes (value → raw).

### 2.11 Byte transforms

```c
extern codec zstd
extern codec inflate @streaming                       // finds its own end
extern async codec oodle                              // the host's implementation is async
extern codec chacha20(u8 key[32], u64 nonce) @ranged  // can decode any slice, given its position

struct Packed {
  u32  expSize
  u32  compSize
  Asset body @size(expSize) @via(oodle) @size(compSize)    // decoded size · codec · size on disk
}

struct Node {
  u64     nonce
  u32     size
  Archive file @via(zstd) @via(chacha20(KEY_A, nonce)) @size(size)
}
```

- **`@size` measures whatever it wraps,** so the inner and outer sizes are the decoded and on-disk
  sizes, both derived. The inner size is handed to the codec (Oodle and LZ4 need it). An `@size`
  on the wrong side of a non-streaming codec is a compile error.
- **`async codec`** makes every schema containing it async.
- **`@ranged`:** lazy views decode only what they read. Other codecs decode the whole region once.
- **Stable re-encoding:** a codec is re-run only if its decoded content changed.
- **Partial transforms** (e.g. one that unmasks only `[0, 0x800)`) are codec parameters on a
  struct-level `@via`.

### 2.12 Parameters, nesting, bound values

```c
struct Blob(u32 n) { u8 data[n] }          // explicit parameters, for reusable structs
struct Body(Header hdr) { … }              // any parameter type, structs included

struct Uses {
  Blob(16)    a                            // positional
  Blob(n: 32) b                            // named
}

struct Asset {
  u32    $version                          // bound: later fields and everything nested in them can read it
  Record records[r]
  struct Inner { … }                       // nested structs see outer fields lexically
}

struct MotionTable {                       // any depth below; the structs in between stay untouched
  if ($version >= 144) { u32 extra }
}

struct Node(u8 $key[32]) { … }             // bound parameters
struct Strict(u32 $version) { … }          // optional: pins the type, so the struct is checked on its own
```

- **`$name` is always a bound or built-in value.** Plain names are only fields and parameters.
- **Nearest binding wins;** inner bindings shadow outer ones (with a warning).
- **Every path is checked:** a path that reaches a `$version` read without a binding is a compile
  error naming the path.
- **Built-ins:** `$endian`, `$offset` (current position), `$end` (end of the enclosing region),
  `$index` (index in the enclosing array). A length using `$end` stays an input on write.
- A root struct's parameters, and the bound values it reads, are arguments to parse.

### 2.13 Types and generics

```c
type Fixed16 = i16 as it / 256.0
type Fixed(u8 bits) = i32 as it * 1.0 / (1 << bits)   // `* 1.0` makes it float division
type EncRec  = Record @via(xor(0x5a))        // per-element transform: `EncRec recs[n]`
type Name    = char[0x20]

struct Span<T> { u64 n  u64 ofs  T items[n] at ofs }   // generics: Span<Point>

extern type VarInt(u8 maxBytes) : u64        // a host-implemented primitive
extern type Half : f32 @size(2)              // fixed size
```

An extern type's implementation provides `size(bytes, ...args)` (returning "need more bytes" when
it can't tell yet), `read(bytes, ...args)` and `write(value, ...args)`. LEB128 (`uleb128`,
`sleb128`) and common checksums are built in.

### 2.14 Bitfields

```c
bits u8 {                       // explicit storage unit, LSB first; @bitorder(msb) flips it
  bool    compressed : 1
  MemKind kind       : 3
  u8                 : 4        // reserved: 0 on write, checked with @strict
}
u16 sizeHigh : 12               // C style: packs while consecutive fields share an integer type
u16 level    : 4
```

The storage unit follows `$endian`.

### 2.15 Virtual fields

```c
struct Node {
  u8  sizeHigh
  u32 sizeLow
  virtual u40 size = (sizeHigh << 32) | sizeLow    // no bytes; a write derives sizeHigh and sizeLow
}
```

- A virtual field occupies no bytes. Its formula is read on parse and reversed on serialize, so
  the parts leave the input.
- **Reversible forms:** bit concatenation `(a << k) | b` (where `b` fits in `k` bits),
  `a * K + b` (with `0 ≤ b < K`), and linear forms, nested. Anything else is the error
  `virtual-not-reversible`.
- Virtual fields take `where`/`in` checks and `?=` defaults, but no attributes, `at`, `from` or
  `as`. A part may be a bit field, and an `in (lo..hi)` check narrows its range.

### 2.16 Derived arrays

```c
struct Asset {
  u8  index[s] = indicesWhere(records, r => r.model != null)
  Key keys[n] where it == sortedBy(it, k => k.name)      // or a check stating the rule
}
```

Lambdas (`x => expr`) appear only as arguments of `map`, `filter`, `indicesWhere` and `sortedBy`.
`unique` and `concat` take arrays. Lambda parameters may shadow fields.

### 2.17 Modules, constants, literals

```c
import { Span, Name, SECTOR } from "./common.yfl"
import * as textures from "./textures.yfl"

export const u32 SECTOR = 0x800
export extern codec zstd                       // externs can be shared and imported by name
export struct Archive { u32 tag = 'ARCV'  … }   // a root: gets parse/serialize/view
```

- **`export` marks roots.** Every top-level declaration can be imported, and exported structs of
  imported modules are roots too. Exported generic structs and aliases are importable but never
  roots. Import paths are relative, and `.yfl` may be omitted.
- **Cross-file cycles** between types are allowed.
- **Literals:**
  - numbers: `0x4c43_4150`, `0b1010`, `1_000`;
  - hex bytes `x"5f2a 91c3"` and base64 bytes `b64"…"`;
  - four-character codes `'ARCV'`: the bytes in written order, whatever the endianness;
  - strings `"…"`.

### 2.18 Layout: where pointer targets go on write

The default is depth-first declaration order: each struct comes before its targets. `layout`
reproduces formats written in a different order:

```c
struct Asset @base @alignEnd(0x10) {
  @padUntil(0x80) { /* header */ }
  str     pool[until ""]
  Record  records[r]        at recordsOfs
  u8      index[s]          at indexOfs
  Record *recPtrs[r] : u64  at recPtrsOfs @ref
  layout {
    records[*].model @align(0x80)        // pulled out: all model sets together
    records[*].anims  @align(0x80)
    records[*]       @align(8)           // each record's remaining targets, in Record's own order
    records          @align(8)
    recPtrs
    index
  }
}
struct Record  { …  layout { curves, motions } }
struct Curves  { …  layout { x.points, y.points, x, y, this } }
struct Motion  { str *name : u64 @ref }  // points at an equal string that's already placed (the pool)
struct Entry   { u32 align  u32 n  u64 ofs  u8 data[n] at ofs  layout { data @align(align) } }
struct World   { Volume volumes[n]  layout { volumes[*] { pieces[*]  portals[*].points } } }
```

- **`layout`** orders only a struct's **own** targets, using local paths. `this` is the struct
  itself. Targets go after the inline fields, and targets no item names follow the items in
  default order.
- **Pulling out:** a container can pull shared groups out of inner structs
  (`records[*].model`), which overrides the inner layouts.
- **Item attributes** may read fields, like write formulas. An item's alignment applies to
  everything it places.
- **Groups** (`volumes[*] { … }`) place, for each element, the named targets in order. The
  element itself comes first unless the group names `this`.
- **`@ref`** pointers don't own their target. On write they resolve to the input object itself if
  it was placed, otherwise to the first placed value with an equal encoding, searching the current
  base, then the enclosing ones. If none exists, the write fails with `REF`.
- **Fixed placements** (non-reversible `at`) go exactly where their offset says, and layout
  continues after them.

### 2.19 Virtual streams

```c
struct Fragmented {
  FragHeader hdr
  Frag       frags[] at max($index * 0x10000, 0x20)   // fragment k in its 64 KiB disk block
  Archive    file from frags[*].data @split(fit)      // joined decoded pieces, parsed as one stream
}
struct Frag {
  u32 magic = 0x46524147
  u32 exp                                             // decoded size: where the split falls
  u32 comp
  u32 check
  u8  data[] @size(exp) @via(zstd) @size(comp)
}

struct Overlay {
  u8     raw[0x40] @hidden
  Header hdr  from raw[0x00..0x20]                    // slices: raw is assembled from them on write
  Footer foot from raw[0x20..0x40]
}
```

- **`from <stream>`** takes no space where it's declared. A stream is a byte field,
  `arr[*].field`, or a slice `raw[a..b]`. Decoded bytes the struct doesn't read are dropped.
- **A field consumed by `from`** is derived on write and leaves the input; it stays in the output
  unless `@hidden`. `@hidden` fields must be fully derivable on write.
- **Write-side split:** the pieces' size fields, when given in the input, win (byte-exact);
  otherwise the `@split` policy decides. `fit` means the largest piece whose encoded form fits its
  block, and overlap checks enforce the fit.
- **Slice writes:** the sliced field is assembled from every `from` slice of it, zero-filled
  elsewhere. Overlapping slices must agree (a warning when they provably overlap). It stays an
  input when it is also read directly, when its slices don't provably cover it and it isn't
  `@hidden`, or when its length depends on itself (`u32 n  u8 raw[n]`: use `[]` with `@size`).

### 2.20 Built-ins

| Built-in                               | Meaning                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------- |
| `sizeof(x)`, `offsetof(x)`             | size on disk, position (from the nearest base)                          |
| `bytesof(x)`                           | bytes on disk (after codecs)                                            |
| `encode(x)`                            | plain encoding (before codecs)                                          |
| `crc32(x)`, `adler32(x)`               | checksums (of a struct: its plain encoding)                             |
| `min`, `max`, `sum`                    | of values, or over one array (`max(probes[*].total)`)                   |
| `sizeof(this)`, `offsetof(this)`       | the current struct; for a `@base` struct, its whole region (write side) |
| `x.length`                             | element count; code units for strings                                   |
| `map`, `filter`, `indicesWhere`, …     | derived arrays (§2.16)                                                  |
| `$endian`, `$offset`, `$end`, `$index` | see §2.12                                                               |
| `it`                                   | this field's own value, in `as`, `=` and `where`                        |
| `null`                                 | the null pointer, in comparisons                                        |

## 3. Syntax details

- **Line rules.** Members end at a line break, `;`, or where the next member starts
  (`u64 n  u64 ofs`). A line starting with `@` continues the previous field unless it contains a
  `{` (then the attributes prefix a block). Lines starting with `at`, `from`, `as`, `in`,
  `where` or `=` also continue the previous field. Binary operators continue expressions across
  lines, and line breaks inside `()`/`[]` don't matter.
- **Operator precedence is Rust-like:** `* / %` > `+ -` > `<< >>` > `&` > `^` > `|` >
  comparisons and `in` > `&&` > `||` > `?:`. So `it & 0x80 == 0` means `(it & 0x80) == 0`.
- **Contextual keywords.** `type`, `from`, `at`, … may be field names (Ghidra structs have `type`
  fields). Declaration names can't be keywords, and field names can't be `it`, `true`, `false`,
  `le`, `be` or `this`.
- **C conveniences:** `u8 r, g, b`; `struct Foo name`; trailing `};`; Ghidra/C type names
  (`uint32_t`, `dword`, …) get a quick fix to the yaffle type. Multi-value cases: `case 2, 3:`.
  Enum members in expressions: `Kind.Vram`. Attributes may follow `at` (`T x at ofs @size(n)`).
- **Generic type arguments must be constants** (`Span<Blob(16)>`, not `Span<Blob(n)>`), so an
  instance is context-free. Unions are inlined at each use.
- **Conditional fields** can be read only where they're known to exist: in the same branch, under a
  structurally identical guard, or when every branch declares them.
- **`=` with `it`** (`u32 flags = it | 0x80`) normalizes the value on write, and the field stays
  an input. Without `it` it's a formula, or a constant (checked on read).
- **Integers are exact.** Arithmetic has no overflow; values are range-checked where they reach a
  typed destination. Division truncates, and float-to-integer conversion rounds half away from
  zero.
- **Integer types from ranges.** Integer `as` transforms and untyped constants get the smallest
  standard type holding the expression's static range (`u8 v as it + 100` → `u16`).
- **Formula analysis is by sampling** the formula against the read side over the values the field
  can hold (its type, width and checks). Never agreeing is `contradictory-formula`, agreeing only
  sometimes is `formula-mismatch`, lossy is `lossy-formula`, and equal to the automatic reverse is
  `redundant-formula`.
- **Automatic reverses** come from the first read-side use that is linear in the field: lengths,
  `@size` layers, `at` offsets (with placement constraints) and struct arguments (`Blob(len) c`
  derives `len` from `Blob`'s own derivation). Later uses are consistency checks.

## 4. Extensibility

| Layer                | yaffle                                                          | Implemented by                  |
| -------------------- | --------------------------------------------------------------- | ------------------------------- |
| 1. Value transforms  | `as expr`, `= expr`, enums, `type X = T as …`                   | yaffle expressions, `extern fn` |
| 2. Byte transforms   | `@via(codec)`, `extern codec`, `async`, `@ranged`, `@streaming` | host                            |
| 3. Custom primitives | `extern type X(args) : T` with `size`/`read`/`write`            | host                            |

## 5. Open questions

- **Display and documentation attributes:** `/** doc */`, `@format(hex)`, colours.
- **Regex-sized fields,** where the regex decides how many bytes to read.
- **Constraints on generic type parameters.**
- **`@split` policies** beyond `fit`.
- **Unknown gap fill:** gaps between placed regions are rebuilt byte-exact from plain values only
  when they were zero.
- **String interpolation,** if ever added, uses `{x}` (not `${x}`) to avoid clashing with `$`.
