/**
 * Lowering of every example in DESIGN.md (made compilable: missing declarations added).
 * Each produces a golden text dump (test/frontend/golden/design-*.txt) and targeted assertions.
 * Every program is validated against the IR invariants (helpers.check).
 */
import { describe, expect, it } from "vitest";
import { irToText } from "../../src/frontend/irtext.ts";
import type { IrBits, IrBlock, IrSwitch, IrType } from "../../src/ir/index.ts";
import { field, ok, struct } from "../helpers.ts";

function golden(name: string, source: string) {
  const p = ok(source);
  return { p, text: irToText(p), file: `./golden/design-${name}.txt` };
}

describe("DESIGN.md examples → IR", () => {
  it("structs and primitives", async () => {
    const g = golden(
      "structs",
      `export struct Entry {
  u16   handler
  u16   kind
  u32   align
  u64   offset
  u64   size
  u32be crc                 // fixed endianness
}`
    );
    await expect(g.text).toMatchFileSnapshot(g.file);
    const e = struct(g.p, "Entry");
    expect(field(e, "crc").type).toEqual({ kind: "prim", prim: "u32", endian: "be" });
    expect(field(e, "handler").type).toEqual({ kind: "prim", prim: "u16", endian: "inherit" });
    expect(e.usesEndian).toBe(true);
    expect(g.p.roots).toEqual([{ struct: "Entry", name: "Entry", module: "main.yfl" }]);
  });

  it("anonymous blocks flatten into the parent", () => {
    const p = ok("export struct S { u8 a  @align(4) { u32 b  u32 c }  u8 d[b] }");
    const s = struct(p, "S");
    expect(s.members[1]).toMatchObject({ kind: "block", layers: [{ kind: "align" }] });
    expect(field(s, "b").derive).toBeDefined();
  });

  it("endianness", async () => {
    const g = golden(
      "endianness",
      `export struct TiffHeader {
  char order[2] in ("II", "MM")
  @endian(order == "MM" ? be : le) {
    u16 magic = 42
    u32 firstIfd
  }
}`
    );
    await expect(g.text).toMatchFileSnapshot(g.file);
    const s = struct(g.p, "TiffHeader");
    const order = field(s, "order");
    expect(order.literals).toEqual([
      { kind: "string", value: "II" },
      { kind: "string", value: "MM" }
    ]);
    expect(order.input).toBe("required");
    const block = s.members[1] as IrBlock;
    expect(block.layers[0]!.kind).toBe("endian");
    const magic = field(s, "magic");
    expect(magic).toMatchObject({ deriveKind: "constant", input: "absent" });
    expect(magic.checks[0]!.message).toBe("magic == 42");
    // the constant layer value doesn't depend on $endian
    expect(s.usesEndian).toBe(false);
  });

  it("arrays, automatic reverses, shared counts", async () => {
    const g = golden(
      "arrays",
      `struct Entry { u32 x }
export struct Table {
  u32   count               // written as entries.length
  u32   pairs               // written as ids.length / 2
  Entry entries[count]
  u16   ids[pairs * 2]
  u8    hash[0x20]          // u8 arrays become Uint8Array
  u16   list[until 0xffff]  // terminator: consumed, not in the value, written back
  Entry more[count]         // shared count
  u8    rest[]              // to the end of the enclosing region
}`
    );
    await expect(g.text).toMatchFileSnapshot(g.file);
    const t = struct(g.p, "Table");
    expect(field(t, "count")).toMatchObject({ deriveKind: "auto", input: "absent" });
    expect(field(t, "pairs").derive).toMatchObject({ kind: "binary", op: "/" });
    expect(field(t, "hash").type).toMatchObject({ kind: "bytes", length: { kind: "count" } });
    expect(field(t, "list").type).toMatchObject({ kind: "array", length: { kind: "until" } });
    expect(field(t, "rest").type).toMatchObject({ kind: "bytes", length: { kind: "rest" } });
  });

  it("non-reversible lengths stay inputs", () => {
    const p = ok(
      "export struct S { u32 n  u32 rows  u32 cols  u8 flags[(n + 7) / 8]  u8 grid[rows * cols] }"
    );
    const s = struct(p, "S");
    for (const n of ["n", "rows", "cols"]) expect(field(s, n).input).toBe("required");
  });

  it("write formulas and externs", async () => {
    const g = golden(
      "formulas",
      `extern fn pathHash(char path[]) -> u32
struct Body { u32 v }
export struct Node {
  u32  n    = flags.length * 8     // you choose the reverse when the compiler can't
  u8   flags[(n + 7) / 8]
  u32  size = sizeof(body)
  u32  crc  = crc32(body)
  u32  hash = pathHash(path)
  char path[0x40]
  Body body
}`
    );
    await expect(g.text).toMatchFileSnapshot(g.file);
    const n = struct(g.p, "Node");
    expect(field(n, "n")).toMatchObject({ deriveKind: "formula", input: "absent" });
    expect(field(n, "hash").derive).toMatchObject({
      kind: "call",
      callee: { kind: "extern", extern: "pathHash" }
    });
    expect(field(n, "crc").derive).toMatchObject({
      kind: "call",
      callee: { name: "crc32" },
      args: [{ kind: "call", callee: { name: "bytesof" } }]
    });
    expect(g.p.externs).toEqual([
      {
        kind: "fn",
        id: "pathHash",
        name: "pathHash",
        module: "main.yfl",
        params: [{ name: "path", type: { kind: "string" } }],
        returns: { kind: "int", bits: 32, signed: false }
      }
    ]);
  });

  it("constants and constraints", async () => {
    const g = golden(
      "constants",
      `export struct C {
  u16  magic = 42                   // constant: written automatically, checked on read
  char tag[4] = "ARCV"
  char order[2] in ("II", "MM")     // input type "II" | "MM"
  u32  version in (1, 2, 5..9)
  str  ver in /v\\d\\.\\d{1,2}/        // portable regex subset
  u32  size where it % 4 == 0       // any condition; \`it\` = this field's value
  u32  tagLe = 'ARCV'               // character code: bytes in written order
  u32le fixedTag = 'ARCV'
}`
    );
    await expect(g.text).toMatchFileSnapshot(g.file);
    const c = struct(g.p, "C");
    expect(field(c, "version").checks[0]!.expr).toMatchObject({
      kind: "in",
      items: [{ kind: "value" }, { kind: "value" }, { kind: "range" }]
    });
    expect(field(c, "version").literals).toBeUndefined();
    expect(field(c, "ver").checks[0]!.expr).toMatchObject({
      kind: "regex",
      pattern: "v\\d\\.\\d{1,2}"
    });
    expect(field(c, "size").checks[0]!.message).toBe("size % 4 == 0");
    expect(field(c, "tagLe").derive!.kind).toBe("cond");
    expect(field(c, "fixedTag").derive).toEqual({
      kind: "literal",
      value: { kind: "int", value: String(0x56435241) },
      type: { kind: "int", bits: 32, signed: false }
    });
  });

  it("strings", async () => {
    const g = golden(
      "strings",
      `export struct S {
  char   name[0x20]   // fixed: text up to the first \\0, padded with \\0 on write
  str    path         // char[until 0]
  str16  wide         // char16[until 0], UTF-16, follows $endian
  str32  wider        // char32[until 0], UTF-32, follows $endian
  u8     len
  char   title[len]   // lengths count code units, never characters
  char   latin[4] @encoding("latin1")
  char16 units[len]
}`
    );
    await expect(g.text).toMatchFileSnapshot(g.file);
    const s = struct(g.p, "S");
    expect(field(s, "wide").type).toMatchObject({
      kind: "string",
      unit: 2,
      encoding: "utf16",
      length: { kind: "until" }
    });
    expect(field(s, "latin").type).toMatchObject({ encoding: "latin1" });
    // len is derived from the first string that uses it (title, in UTF-8 code units)
    expect(field(s, "len").derive).toMatchObject({
      kind: "call",
      callee: { name: "encodedLength" }
    });
  });

  it("attributes, padding, alignment", async () => {
    const g = golden(
      "attributes",
      `export struct Header @padUntil(0x80) {          // struct attributes go between the name and \`{\`
  char tag[4] = "ARCV"
  u32  count
}

export struct Entry {
  u32 a        @padBefore(4)
  u32 b        @padAfter(4, 0xcc)        // fill byte
  u8  data[16] @align(0x100)             // pad before, from the nearest @base
  str name     @padUntil(0x20, 0xff)     // "hello\\0" then 0xff up to 0x20 bytes
  u64 offset   @align(8)
               @padAfter(8)              // a line starting with @ continues the previous field
  u8  tail[]   @align(0x10, i => i & 0xff) @strict
}`
    );
    await expect(g.text).toMatchFileSnapshot(g.file);
    expect(struct(g.p, "Header").layers).toEqual([
      {
        kind: "padUntil",
        size: { kind: "literal", value: { kind: "int", value: "128" }, type: { kind: "bigint" } },
        fill: { kind: "byte", value: 0 }
      }
    ]);
    const e = struct(g.p, "Entry");
    expect(field(e, "offset").type).toMatchObject({
      kind: "layered",
      layers: [{ kind: "align" }, { kind: "padAfter" }]
    });
    expect(field(e, "tail").type).toMatchObject({
      kind: "layered",
      layers: [{ kind: "align", fill: { kind: "fn", param: "i" } }, { kind: "strict" }]
    });
    expect(field(e, "b").type).toMatchObject({
      layers: [{ kind: "padAfter", fill: { kind: "byte", value: 0xcc } }]
    });
  });

  it("pointers and bases", async () => {
    const g = golden(
      "pointers",
      `struct Model { u32 m }
struct Graph { u32 g }
struct Extra { u32 e }
struct Record { u32 r }
export struct Chunk @base {                       // offsets inside count from the start of Chunk
  u32    count
  u32    size
  Model  *model : u64                     // the pointer is transparent: the value is just \`model\`
  Graph  *graph : i32 @relative           // target = address of this field + value
  Extra  *extra : u64 @nullable           // 0 → null
  Extra  *other : u32 @nullable(0xffffffff)
  Record *recs[count] : u64               // an array of pointers
  u64    tableOfs                         // derived from where \`table\` is placed
  Record table[count] at tableOfs
  u32    sector
  u8     data[size] at sector * 0x800     // linear \`at\` → placement constraint (0x800-aligned)
  u8     fixed[4] at 0x10                 // constant offset: fixed placement
}`
    );
    await expect(g.text).toMatchFileSnapshot(g.file);
    const a = struct(g.p, "Chunk");
    expect(a.base).toBe(true);
    expect(field(a, "graph").type).toMatchObject({
      kind: "pointer",
      storage: "i32",
      relative: true,
      ownership: "owned"
    });
    expect(field(a, "extra").type).toMatchObject({ nullValue: "0" });
    expect(field(a, "other").type).toMatchObject({ nullValue: "4294967295" });
    expect(field(a, "recs").type).toMatchObject({ kind: "array", element: { kind: "pointer" } });
    expect(field(a, "tableOfs").derive).toMatchObject({
      kind: "call",
      callee: { name: "offsetof" }
    });
    expect(field(a, "table").placement).toMatchObject({ fixed: false });
    expect(field(a, "sector").derive).toMatchObject({ kind: "binary", op: "/" });
    expect(field(a, "data").placement).toMatchObject({
      fixed: false,
      constraint: { modulus: "2048", remainder: "0" }
    });
    expect(field(a, "fixed").placement).toMatchObject({ fixed: true });
  });

  it("conditionals and unions", async () => {
    const g = golden(
      "conditionals",
      `struct Archive { u32 p }
struct Chunk { u32 a }
struct Dict { u32 k }
export struct C {
  u32  version
  u32  size
  char tag[4]
  if (version >= 3) { u32 extra } else { u16 legacy }
  switch (tag) {
    case "ARCV": Archive body
    case "CHNK": Chunk   body
    default:     u8      body[size]
  }
}
union Node { Archive  Dict }           // try in order; the variant's checks decide
export struct U { Node n }`
    );
    await expect(g.text).toMatchFileSnapshot(g.file);
    const c = struct(g.p, "C");
    const sw = c.members.find(m => m.kind === "switch") as IrSwitch;
    expect(sw.discriminantField).toBe("tag");
    expect(sw.cases.map(x => x.values)).toEqual([
      [{ kind: "string", value: "ARCV" }],
      [{ kind: "string", value: "CHNK" }]
    ]);
    expect(sw.default).toHaveLength(1);
    const iff = c.members.find(m => m.kind === "block") as IrBlock;
    expect(iff.condition).toBeDefined();
    expect(iff.else).toHaveLength(1);
    const n = field(struct(g.p, "U"), "n");
    expect(n.type).toMatchObject({
      kind: "union",
      variants: [{ name: "Archive" }, { name: "Dict" }]
    });
  });

  it("value transforms and enums", async () => {
    const g = golden(
      "transforms",
      `enum MemKind : u16 { Sys = 0, Gpu = 1 }
enum Open : u8 @open { A = 1 }
extern fn decodeTag(u32 t) -> u32
extern fn encodeTag(u32 t) -> u32
extern fn hex(u32 v) -> str
export struct Entry {
  u8      count
  char    names[count][8]
  MemKind kind
  Open    open
  u16     angle as it * 360.0 / 65536              // reverse worked out
  u8      name  as names[it]                       // reverse: names.indexOf(it)
  u32     tag   as decodeTag(it) = encodeTag(it)   // explicit reverse
  u32     hash  as hex(it)                         // one-way: input stays u32, read-only in views
  u32     flags = it | 0x80                        // normalize on write
  i16     neg as -it + 3
}`
    );
    await expect(g.text).toMatchFileSnapshot(g.file);
    const e = struct(g.p, "Entry");
    const angle = field(e, "angle").type as Extract<IrType, { kind: "transform" }>;
    expect(angle.valueType).toEqual({ kind: "float", bits: 64 });
    expect(angle.writeInferred).toBe(true);
    expect(angle.write).toMatchObject({ kind: "call", callee: { name: "round" } });
    expect(field(e, "name").type).toMatchObject({
      kind: "transform",
      write: { kind: "call", callee: { name: "indexOf" } }
    });
    const tag = field(e, "tag").type as Extract<IrType, { kind: "transform" }>;
    expect(tag.writeInferred).toBeUndefined();
    expect(field(e, "hash").type).toMatchObject({ kind: "transform" });
    expect((field(e, "hash").type as { write?: unknown }).write).toBeUndefined();
    expect(field(e, "flags")).toMatchObject({ deriveKind: "formula", input: "required" });
    expect(g.p.enums.find(x => x.id === "Open")!.open).toBe(true);
  });

  it("byte transforms", async () => {
    const g = golden(
      "byte-transforms",
      `struct Chunk { u32 a }
struct Archive { u32 p }
extern codec zstd
extern codec inflate @streaming                       // finds its own end
extern async codec oodle                              // the host returns a Promise
extern codec chacha20(u8 key[32], u64 nonce) @ranged  // can decode any slice, given its position
const u8 KEY_A[32] = x"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"

export struct Packed {
  u32  expSize
  u32  compSize
  Chunk body @size(expSize) @via(oodle) @size(compSize)   // decoded size · codec · size on disk
}

export struct Node {
  u64        nonce
  u32        size
  Archive file @via(zstd) @via(chacha20(KEY_A, nonce)) @size(size)
}

export struct Stream {
  Archive file @via(inflate)
}`
    );
    await expect(g.text).toMatchFileSnapshot(g.file);
    const p = struct(g.p, "Packed");
    expect(field(p, "expSize").derive).toMatchObject({
      callee: { name: "encodedSize" },
      args: [{ kind: "field", name: "body" }, { value: { value: "0" } }]
    });
    expect(field(p, "compSize").derive).toMatchObject({ args: [{}, { value: { value: "2" } }] });
    expect(p.async).toBe(true);
    expect(struct(g.p, "Node").async).toBe(false);
    const codecs = g.p.externs.filter(x => x.kind === "codec");
    expect(
      codecs.map(c => [
        c.name,
        c.kind === "codec" && c.async,
        c.kind === "codec" && c.ranged,
        c.kind === "codec" && c.streaming
      ])
    ).toEqual([
      ["chacha20", false, true, false],
      ["inflate", false, false, true],
      ["oodle", true, false, false],
      ["zstd", false, false, false]
    ]);
  });

  it("parameters, nesting, bound values", async () => {
    const g = golden(
      "parameters",
      `struct Blob(u32 n) { u8 data[n] }          // explicit parameters, for reusable structs
struct Header { u32 count }
struct Body(Header hdr) { u32 items[hdr.count] }   // any parameter type, structs included

export struct Uses {
  Blob(16)    a                            // positional
  Blob(n: 32) b                            // named
  Header      h
  Body(h)     body
}

export struct Chunk {
  u32    $version                          // bound: later fields and everything nested in them can read it
  u32    r
  Record records[r]
  struct Inner { u8 data[r] }              // nested structs see outer fields lexically
  Inner  inner
  Node(KEY) node
}
const u8 KEY[32] = x"00000000000000000000000000000000000000000000000000000000000000ff"

struct Record { MotionTable m }
struct MotionTable {                       // any depth below; the structs in between stay untouched
  if ($version >= 144) { u32 extra }
}

struct Node(u8 $key[32]) { u8 tag[4] }     // bound parameters
export struct Strict(u32 $version) { if ($version > 2) { u8 x } }   // pins the type: checked on its own`
    );
    await expect(g.text).toMatchFileSnapshot(g.file);
    const mt = struct(g.p, "MotionTable");
    expect(mt.params).toEqual([
      {
        name: "endian",
        type: { kind: "endian" },
        origin: "endian",
        default: {
          kind: "literal",
          value: { kind: "endian", value: "le" },
          type: { kind: "endian" }
        }
      },
      {
        name: "version",
        type: { kind: "int", bits: 32, signed: false },
        origin: "bound",
        boundName: "version"
      }
    ]);
    expect(struct(g.p, "Record").params.map(p => p.name)).toEqual(["endian", "version"]);
    const chunk = struct(g.p, "Chunk");
    expect(field(chunk, "records").type).toMatchObject({
      element: {
        kind: "struct",
        struct: "Record",
        args: [
          { kind: "param", name: "endian" },
          { kind: "field", name: "version" }
        ]
      }
    });
    expect(field(chunk, "version").bind).toBe("version");
    const inner = struct(g.p, "Chunk.Inner");
    expect(inner.name).toBe("Chunk_Inner");
    expect(inner.params[1]).toMatchObject({ name: "r", origin: "outer" });
    expect(field(chunk, "inner").type).toMatchObject({ args: [{}, { kind: "field", name: "r" }] });
    expect(field(struct(g.p, "Uses"), "b").type).toMatchObject({
      args: [{}, { kind: "literal", value: { value: "32" } }]
    });
    expect(struct(g.p, "Strict").params[1]).toMatchObject({
      name: "version",
      origin: "bound",
      boundName: "version"
    });
  });

  it("types: aliases, generics, extern types", async () => {
    const g = golden(
      "types",
      `type Fixed16 = i16 as it / 256.0
type Fixed(u8 bits) = i32 as it / (1 << bits)
extern codec xor(u8 key)
struct Record { u32 r }
type EncRec  = Record @via(xor(0x5a)) @size(4)   // per-element transform: \`EncRec recs[n]\`
type Name    = char[0x20]

struct Point { f32 x  f32 y }
struct Span<T> { u64 n  u64 ofs  T items[n] at ofs }   // generics: Span<Point>

extern type VarInt(u8 maxBytes) : u64        // layer 3: a host-implemented primitive
extern type Half : f32 @size(2)              // fixed size

export struct T @base {
  Fixed16     a
  Fixed(8)    b
  u32         n
  EncRec      recs[n]
  Name        name
  Name        names[2]
  Span<Point> pts
  Span<u16>   nums
  VarInt(5)   v
  Half        h
  uleb128     len
  u8          blob[len]
}`
    );
    await expect(g.text).toMatchFileSnapshot(g.file);
    const t = struct(g.p, "T");
    expect(field(t, "recs").type).toMatchObject({
      kind: "array",
      element: {
        kind: "layered",
        inner: { kind: "struct", struct: "Record" },
        layers: [{ kind: "via", codec: "xor" }, { kind: "size" }]
      }
    });
    expect(field(t, "names").type).toMatchObject({
      kind: "array",
      element: { kind: "string", length: { kind: "count" } }
    });
    expect(field(t, "pts").type).toMatchObject({ kind: "struct", struct: "Span<Point>" });
    expect(struct(g.p, "Span<Point>").name).toBe("Span_Point");
    expect(field(struct(g.p, "Span<u16>"), "items").type).toMatchObject({
      kind: "array",
      element: { kind: "prim", prim: "u16" }
    });
    expect(field(t, "len")).toMatchObject({ deriveKind: "auto", input: "absent" });
    expect(g.p.externs.find(x => x.id === "uleb128")).toEqual({
      kind: "type",
      id: "uleb128",
      name: "uleb128",
      module: "",
      params: [],
      valueType: { kind: "int", bits: 64, signed: false },
      builtin: true
    });
    expect(g.p.externs.find(x => x.id === "Half")).toMatchObject({
      kind: "type",
      fixedSize: 2,
      valueType: { kind: "float", bits: 32 }
    });
  });

  it("bitfields", async () => {
    const g = golden(
      "bitfields",
      `enum MemKind : u8 { Sys = 0, Gpu = 1 }
export struct B {
  bits u8 {                       // explicit storage unit, LSB first
    bool    compressed : 1
    MemKind kind       : 3
    u8                 : 4        // reserved: 0 on write, checked with @strict
  }
  u16 sizeHigh : 12               // C style: packs while consecutive fields share an integer type
  u16 level    : 4
  bits u16 @bitorder(msb) {
    u8 hi : 4
    u8 lo : 4
  }
  i8 s : 3
  i8 t : 5
}`
    );
    await expect(g.text).toMatchFileSnapshot(g.file);
    const b = struct(g.p, "B");
    const [u1, u2, u3, u4] = b.members as IrBits[];
    expect(u1!.fields.map(f => [f.name, f.shift, f.width])).toEqual([
      ["compressed", 0, 1],
      ["kind", 1, 3],
      [null, 4, 4]
    ]);
    expect(u2!.fields.map(f => [f.name, f.shift, f.width])).toEqual([
      ["sizeHigh", 0, 12],
      ["level", 12, 4]
    ]);
    expect(u3!.bitOrder).toBe("msb");
    expect(u3!.fields.map(f => [f.name, f.shift, f.width])).toEqual([
      ["hi", 12, 4],
      ["lo", 8, 4],
      [null, 0, 8]
    ]);
    expect(u4!.storage).toBe("i8");
  });

  it("modules, constants, literals", () => {
    const p = ok(`export const u32 SECTOR = 0x800
const u32 MAGIC = 0x5643_5241
export struct Archive {
  u32le tag = 'ARCV'
  u32   m = MAGIC
  u8    data[SECTOR / 0x100]
  u8    key[4] = x"5f2a 91c3"
  u8    b[3] = b64"AQID"
  u8    bits = 0b1010
  u32   n = 1_000
}`);
    expect(p.consts).toEqual([
      {
        name: "SECTOR",
        module: "main.yfl",
        type: { kind: "int", bits: 32, signed: false },
        value: { kind: "int", value: "2048" }
      }
    ]);
    const s = struct(p, "Archive");
    expect(field(s, "m").derive).toMatchObject({ value: { value: String(0x56435241) } });
    expect(field(s, "data").type).toMatchObject({
      kind: "bytes",
      length: { kind: "count", expr: { kind: "literal", value: { value: "8" } } }
    });
    expect(field(s, "key").derive).toMatchObject({ value: { kind: "bytes", hex: "5f2a91c3" } });
    expect(field(s, "b").derive).toMatchObject({ value: { kind: "bytes", hex: "010203" } });
    expect(field(s, "bits").derive).toMatchObject({ value: { value: "10" } });
  });

  it("layout", async () => {
    const g = golden(
      "layout",
      `struct Model { u32 m }
struct Bank { u32 e }
struct Pt { f32 a  f32 b }
struct Curve { u64 n  u64 ofs  Pt points[n] at ofs }
struct Curves { Curve *x : u64  Curve *y : u64  layout { x.points, y.points, x, y, this } }
struct Motion { str *name : u64 @ref }  // points at an equal string that's already placed (the pool)
struct Record  {
  Model  *model   : u64
  Bank   *bank    : u64
  Curves *curves  : u64
  Motion *motions : u64
  layout { curves, motions }
}
export struct Chunk @base @alignEnd(0x10) {
  @padUntil(0x80) {
    u8  r
    u8  s
    u64 recordsOfs
    u64 indexOfs
    u64 recPtrsOfs
  }
  str     pool[until ""]
  Record  records[r]        at recordsOfs
  u8      index[s]          at indexOfs
  Record *recPtrs[r] : u64  at recPtrsOfs @ref
  layout {
    records[*].model @align(0x80)        // pulled out: all models together
    records[*].bank  @align(0x80)
    records[*]       @align(8)           // each record's remaining targets, in Record's own order
    records          @align(8)
    recPtrs
    index
  }
}`
    );
    await expect(g.text).toMatchFileSnapshot(g.file);
    const a = struct(g.p, "Chunk");
    expect(a.layout!.map(i => i.path)).toEqual([
      [{ kind: "field", name: "records" }, { kind: "each" }, { kind: "field", name: "model" }],
      [{ kind: "field", name: "records" }, { kind: "each" }, { kind: "field", name: "bank" }],
      [{ kind: "field", name: "records" }, { kind: "each" }],
      [{ kind: "field", name: "records" }],
      [{ kind: "field", name: "recPtrs" }],
      [{ kind: "field", name: "index" }]
    ]);
    expect(a.layout![0]!.layers).toMatchObject([
      { kind: "align", to: { value: { value: "128" } } }
    ]);
    expect(
      struct(g.p, "Curves").layout!.map(i =>
        i.path === "this"
          ? "this"
          : i.path.map(s => (s.kind === "field" ? s.name : "[*]")).join(".")
      )
    ).toEqual(["x.points", "y.points", "x", "y", "this"]);
    expect(field(a, "recPtrs").type).toMatchObject({
      element: { kind: "pointer", ownership: "ref" }
    });
    expect(field(struct(g.p, "Motion"), "name").type).toMatchObject({
      kind: "pointer",
      ownership: "ref",
      target: { kind: "string" }
    });
    expect(a.layers).toMatchObject([{ kind: "alignEnd" }]);
  });

  it("virtual streams", async () => {
    const g = golden(
      "streams",
      `extern codec zstd
struct FragHeader { u32 magic  u32 size }
struct Archive { u32 p }
export struct Fragmented {
  FragHeader hdr
  Frag       frags[] at max($index * 0x10000, 0x20)   // fragment k in its 64 KiB disk block
  Archive    file from frags[*].data @split(fit)   // joined decoded pieces, parsed as one stream
}
struct Frag {
  u32 magic = 0x46524147
  u32 exp                                             // decoded size: where the split falls
  u32 comp
  u32 check
  u8  data[] @size(exp) @via(zstd) @size(comp)
}
export struct Slices {
  u8 raw[0x1000]
  FragHeader h from raw[0x10..0x20]
  FragHeader t from raw[0x800..]
}`
    );
    await expect(g.text).toMatchFileSnapshot(g.file);
    const fr = struct(g.p, "Fragmented");
    expect(field(fr, "frags").type).toMatchObject({
      kind: "array",
      length: { kind: "rest" },
      elementPlacement: { kind: "call", callee: { name: "max" } }
    });
    expect(field(fr, "file").from).toEqual({
      stream: { kind: "each", array: "frags", field: "data" },
      split: { policy: "fit" }
    });
    const frag = struct(g.p, "Frag");
    expect(field(frag, "data").input).toBe("absent");
    expect(field(frag, "exp").input).toBe("optional");
    expect(field(frag, "comp").input).toBe("optional");
    expect(field(frag, "check").input).toBe("required");
    const sl = struct(g.p, "Slices");
    expect(field(sl, "h").from).toMatchObject({
      stream: {
        kind: "slice",
        stream: { kind: "field", field: "raw" },
        start: { value: { value: "16" } },
        end: { value: { value: "32" } }
      }
    });
    expect(field(sl, "t").from!.stream).not.toHaveProperty("end");
  });

  it("@hidden fields", () => {
    const p = ok("export struct S { u32 n @hidden  u8 d[n]  u32 k @hidden = 5 }");
    const s = struct(p, "S");
    expect(field(s, "n")).toMatchObject({
      hidden: true,
      output: false,
      input: "absent",
      deriveKind: "auto"
    });
    expect(field(s, "k")).toMatchObject({
      hidden: true,
      output: false,
      input: "absent",
      deriveKind: "constant"
    });
  });

  it("built-ins", () => {
    const p = ok(`export struct B @base {
  u32 a = sizeof(body)
  u64 o = offsetof(body)
  u8  hash[4]
  u32 c = crc32(bytesof(body))
  u32 d = adler32(encode(body))
  u32 e = max(a, 4) + min(1, 2) + abs(-3)
  u32 pos = $offset
  u32 rem = $end - $offset
  @endian($endian) { u16 x }
  u8  body[16]
}`);
    const b = struct(p, "B");
    expect(field(b, "e").derive).toMatchObject({ kind: "binary", op: "+" });
    expect(field(b, "pos").derive).toMatchObject({ kind: "builtinValue", name: "offset" });
    expect(field(b, "d").derive).toMatchObject({
      callee: { name: "adler32" },
      args: [{ callee: { name: "encode" } }]
    });
  });

  it("IR.md §8.1 example: derived count", () => {
    const p = ok("struct Entry { u32 x }\nexport struct Table { u32 count  Entry entries[count] }");
    const t = struct(p, "Table");
    expect(field(t, "count")).toEqual({
      kind: "field",
      name: "count",
      source: t.members[0]!.kind === "field" ? t.members[0]!.source : undefined,
      type: { kind: "prim", prim: "u32", endian: "inherit" },
      derive: {
        kind: "call",
        callee: { kind: "builtin", name: "len" },
        args: [
          {
            kind: "field",
            name: "entries",
            type: { kind: "array", element: { kind: "struct", struct: "Entry" } }
          }
        ],
        type: { kind: "bigint" }
      },
      deriveKind: "auto",
      checks: [],
      hidden: false,
      output: true,
      input: "absent"
    });
    expect(field(t, "entries")).toMatchObject({
      type: {
        kind: "array",
        element: {
          kind: "struct",
          struct: "Entry",
          args: [{ kind: "param", name: "endian", type: { kind: "endian" } }]
        },
        length: {
          kind: "count",
          expr: { kind: "field", name: "count", type: { kind: "int", bits: 32, signed: false } }
        }
      },
      input: "required"
    });
  });

  it("IR.md §8.5 example: at with a linear reverse", () => {
    const p = ok("export struct S @base { u32 size  u32 sector  u8 data[size] at sector * 0x800 }");
    const s = struct(p, "S");
    expect(field(s, "sector").derive).toEqual({
      kind: "binary",
      op: "/",
      left: {
        kind: "call",
        callee: { kind: "builtin", name: "offsetof" },
        args: [{ kind: "field", name: "data", type: { kind: "bytes" } }],
        type: { kind: "bigint" }
      },
      right: { kind: "literal", value: { kind: "int", value: "2048" }, type: { kind: "bigint" } },
      type: { kind: "bigint" }
    });
    expect(field(s, "data").placement).toEqual({
      offset: {
        kind: "binary",
        op: "*",
        left: {
          kind: "convert",
          operand: {
            kind: "field",
            name: "sector",
            type: { kind: "int", bits: 32, signed: false }
          },
          type: { kind: "bigint" }
        },
        right: { kind: "literal", value: { kind: "int", value: "2048" }, type: { kind: "bigint" } },
        type: { kind: "bigint" }
      },
      constraint: { modulus: "2048", remainder: "0" },
      fixed: false
    });
  });

  it("produces stable JSON IR", async () => {
    const p = ok(`extern codec zstd
enum K : u8 { A, B }
export struct S { u32 n  K k  u8 d[n] @via(zstd) @size(n) }`);
    await expect(JSON.stringify(p, null, 2) + "\n").toMatchFileSnapshot("./golden/json-small.json");
  });
});
