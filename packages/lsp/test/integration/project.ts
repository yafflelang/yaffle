/**
 * The workspace of the integration tests: a small multi-file project (name → text) with imports,
 * pointers, layout rules, parameters, bit fields, externs and virtual streams, and its yaffle.json.
 */

/** The project's format files (name → text). */
export const PROJECT: Record<string, string> = {
  "archive.yfl": `// A ZIP-like archive: a header, a name pool, the entries with their data, and a directory at the
// end. Every offset counts from the start of the archive (@base); 0 = none.

import { Attrs } from "./common.yfl"
import { Comment } from "./notes.yfl"

export struct Archive @base @alignEnd(0x10) {
  @strict @padUntil(0x40) {
    char magic[4] = "ARCV"
    u32  size                     // the whole archive
    u16  version in (1..3)
         @padAfter(2)
    u16  n                        // written as entries.length
    u16  k                        // written as keep.length
    u32  entriesOfs
    u32  keepOfs
    u32  dirOfs
  }
  str     names[until ""]         // unique; holds names nothing points at, so stored
  Entry   entries[n]  at entriesOfs
  u16     keep[k]     at keepOfs
  Entry  *dir[n] : u32 at dirOfs @ref
  layout {
    entries[*].data @align(0x40)
    entries         @align(8)
    dir
    keep
  }
}

// One file (0x18 bytes).
struct Entry {
  str     *name : u32 @ref        // a string of the pool
  Comment *note : u32 @nullable
  Attrs    attrs
  u16      flags
           @padAfter(4) @strict
  u32      dataOfs = size > 0 ? offsetof(data) : 0
  u32      size
  u8       data[size] at dataOfs
  layout { note }
}
`,
  "chunks.yfl": `// A RIFF-like chunk file: a header, a table of contents, then the chunks, each a tag and a body
// chosen by it.

import { Archive } from "./archive.yfl"

export struct ChunkFile {
  char magic[4] = "CHNK"
  u32  dataStart = toc.slots[0].offset
  u32  tocOfs = offsetof(toc)
  u16  count
  u16  version = 1
  u8   pad[tocOfs - $offset]      // zero up to the table of contents
  Toc(count, tocOfs) toc
}

// Offsets in here count from the table's start, but it isn't a @base: slot data is aligned from
// the start of the file.
struct Toc(u16 n, u32 t) {
  u32   rel[n]                    // chunk i is at t + rel[i]
  Slot  slots[n]
  Chunk chunks[n] at t + rel[$index]
  layout {
    chunks
    slots[*].data @align(0x20)
  }
}

struct Slot {
  u32 offset                      // written as the data's position
  u32 size                        // written as data.length
  u8  data[size] at offset
}

struct Chunk {
  u32le tag
  u32   size
  switch (tag) {
    case 'fmt ': Format  format
    case 'list': Pair    pairs[size / 8]
    case 'arcv': Archive archive @size(size)
    default:     u8      body[size]
  }
}

struct Format { u16 channels  u16 bits  u32 rate }
struct Pair { u32 key  u32 value }
`,
  "common.yfl": `// Declarations shared by the files of the test project.

export enum Codec : u8 { Store = 0, Deflate = 1, Zstd = 2, Xor = 3 }

// Per-entry attributes (2 bytes).
export struct Attrs {
  bits u16 {
    Codec codec    : 2
    bool  hidden   : 1
    bool  readOnly : 1
    u16   level    : 12
  }
}
`,
  "notes.yfl": `// Notes attached to archive entries: a chain of text blocks, each one pointing at the next.

export struct Comment {
  char magic[4] = "NOTE"
  u16  next                      // the next block, from this one; 0 = last
  u16  length
  if (next != 0) {
    u8      body[next - 8]
    Comment more
  } else {
    char    last[length]
  }
}
`,
  "sealed.yfl": `// A sealed container: the content is compressed in blocks, then masked with a key the caller
// gives. Neither the key nor the codecs are part of this description.

import { Codec } from "./common.yfl"

extern codec zstd
extern codec xor(u8 key[16], u32 seed) @ranged

export struct Sealed(u8 $key[16]) {
  u32  seed
  Pack pack @via(xor($key, seed))
}

export struct Pack {
  char  magic[4] = "PACK"
  u64   stamp
  Codec codec
  u8    level where it <= 22
  u16   unit where it % 0x200 == 0
  u32   rawSize = content.length
  Block blocks[] at max($index * 0x1000, 0x14)
  u8    content[] from blocks[*].data @split(fit)
}

struct Block {
  char magic[4] = "BLCK"
  u32  exp                        // decoded size: where the split falls
  u32  comp
  u8   data[] @size(exp) @via(zstd) @size(comp) @hidden
}
`
};

export const PROJECT_CONFIG = '{ "sources": ["*.yfl"] }\n';
