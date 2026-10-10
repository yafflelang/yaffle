// The relocation-style writer (docs/IR.md §3.2) and the layout engine (§4):
//
// 1. Generated writers encode bottom-up into blocks: inline bytes plus fixups (a position and a
//    closure computing the value once sizes and positions are final).
// 2. Pointer and `at` targets become placeables, each with its own block. Generated code also
//    records the structure (LStruct / LArray) that `layout` paths are matched against.
// 3. When a base region (the root, a `@base` struct, a codec's decoded side) is complete, the
//    layout engine assigns every block a position, the blocks are assembled and the fixups run.
#pragma once

#include "core.hpp"
#include "prim.hpp"
#include "reader.hpp"
#include "strings.hpp"

namespace yaffle {

class Region;
class Placeable;
struct LStruct;
struct LArray;

/// What a struct writer reports to the layout engine: nothing, a struct, an array, a placeable.
using LEntry = std::variant<std::monostate, std::shared_ptr<LStruct>, std::shared_ptr<LArray>, Placeable*>;

struct LayoutLayer {
  enum class Kind : std::uint8_t { Align, PadBefore, PadAfter, AlignEnd };
  Kind kind;
  std::int64_t n;
  /// `@align(n, offset: k, from: file)`: the block start satisfies
  /// `(start - origin + offset) % n == 0`, the origin being the base or the byte space's start.
  std::int64_t offset = 0;
  bool file = false;
};

/// One `layout { … }` item: "this", or field names with "*" for `[*]`.
struct LayoutItem {
  bool is_this = false;
  std::vector<std::string> path;
  std::vector<LayoutLayer> layers;
  /// Per-element group: `path` names an array; for each element in order, these
  /// items (relative to the element) are placed in order. Everything they name is claimed.
  std::vector<LayoutItem> group;
  bool grouped = false;
};
using Layout = std::vector<LayoutItem>;

inline LayoutItem layout_item(std::vector<std::string> path, std::vector<LayoutLayer> layers = {}) {
  return LayoutItem{false, std::move(path), std::move(layers), {}, false};
}
inline LayoutItem layout_this(std::vector<LayoutLayer> layers = {}) {
  return LayoutItem{true, {}, std::move(layers), {}, false};
}
inline LayoutItem layout_group(std::vector<std::string> path, std::vector<LayoutItem> items,
                               std::vector<LayoutLayer> layers = {}) {
  return LayoutItem{false, std::move(path), std::move(layers), std::move(items), true};
}
inline LayoutLayer layout_align(std::int64_t n) { return {LayoutLayer::Kind::Align, n}; }
inline LayoutLayer layout_align_at(std::int64_t n, std::int64_t offset, bool file) {
  return {LayoutLayer::Kind::Align, n, offset, file};
}
inline LayoutLayer layout_align_end(std::int64_t n) { return {LayoutLayer::Kind::AlignEnd, n}; }
inline LayoutLayer layout_pad_before(std::int64_t n) { return {LayoutLayer::Kind::PadBefore, n}; }
inline LayoutLayer layout_pad_after(std::int64_t n) { return {LayoutLayer::Kind::PadAfter, n}; }
/// A layout item's alignment computed in the owning struct's write context: RANGE below 1.
std::int64_t layout_alignment(std::int64_t n);
/// A layout item's padding computed in the owning struct's write context: RANGE below 0.
std::int64_t layout_padding(std::int64_t n);

/// The placeables reachable from one struct instance, by field (declaration order).
struct LStruct {
  explicit LStruct(const Layout* l = nullptr) : layout(l) {}
  const Layout* layout;
  /// This instance's own layout, when item arguments read fields.
  std::shared_ptr<const Layout> owned;
  void own(Layout l) {
    owned = std::make_shared<const Layout>(std::move(l));
    layout = owned.get();
  }
  std::vector<std::pair<std::string, LEntry>> fields;
  void set(std::string_view name, LEntry e);
  const LEntry* get(std::string_view name) const;
};

struct LArray {
  std::vector<LEntry> items;
  void push(LEntry e) {
    if (auto p = std::get_if<Placeable*>(&e); p && !*p) e = std::monostate{};
    items.push_back(std::move(e));
  }
};

inline LEntry lentry(std::shared_ptr<LStruct> s) { return s ? LEntry(std::move(s)) : LEntry(); }
inline LEntry lentry(std::shared_ptr<LArray> a) { return a ? LEntry(std::move(a)) : LEntry(); }
inline LEntry lentry(Placeable* p) { return p ? LEntry(p) : LEntry(); }
inline LEntry lentry(LEntry e) { return e; }

struct Constraint {
  std::int64_t modulus;
  std::int64_t remainder;
};

struct PlaceOptions {
  /// `at` constraint from a derived linear offset: position ≡ remainder (mod modulus).
  std::optional<Constraint> constraint;
  /// Fixed placement: exactly this base-relative offset.
  std::optional<std::int64_t> fixed;
};

class Block {
 public:
  explicit Block(Region* r) : region(r) {}
  Bytes data;
  /// Required start alignment (from `align` layers inside, relative to the block start).
  std::int64_t align = 1;
  /// The base-relative start when known before layout (fixed placements).
  std::optional<std::int64_t> fixed_at;
  /// Base-relative position assigned by layout (-1 until then). The region root is at 0.
  std::int64_t pos = -1;
  Region* region;
  std::int64_t size() const { return static_cast<std::int64_t>(data.size()); }
};

/// A pointer or `at` target: its block plus the structure of its content.
class Placeable {
 public:
  Placeable(Block* b, std::string n, const PlaceOptions& o);
  Block* block;
  LEntry content;
  std::optional<Constraint> constraint;
  std::optional<std::int64_t> fixed;
  /// Commit mode (views): original position and size.
  std::optional<std::int64_t> orig;
  std::optional<std::int64_t> orig_size;
  /// Debug name (field).
  std::string name;
  bool placed() const { return block->pos >= 0; }
};

/// A position inside a block (absolute = block->pos + at once laid out).
struct Mark {
  Block* block;
  std::int64_t at;
  std::int64_t abs() const { return block->pos + at; }
};

/// Start/end of a field's encoding, for sizeof/offsetof/bytesof/encodedSize.
class Extent {
 public:
  Extent(Block* b, std::int64_t s) : block(b), start(s) {}
  Block* block;
  std::int64_t start;
  std::int64_t end = -1;
  /// Byte length after each layer stage (`encodedSize(field, k)`), -1 when unknown.
  std::vector<std::int64_t> stages;
  /// Set for placed fields: the placeable holding the field.
  Placeable* placeable = nullptr;
  /// An empty placed array whose offset is written as 0 (`@nullable(empty)`).
  bool empty_is_null = false;
  /// The plain encoding (before any codec), when a `via` layer recorded it.
  std::optional<Bytes> plain;
  /// `this` of a base struct: the whole region.
  Region* whole = nullptr;

  void set_stage(int k, std::int64_t size);
  std::int64_t size() const;
  std::int64_t pos() const;
  std::int64_t stage(int k) const;
  /// The field's bytes in the finished region (content-dependent fixups only).
  BytesView bytes() const;
  /// The field's plain encoding (before layers).
  BytesView plain_bytes() const;
};
using ExtentPtr = std::shared_ptr<Extent>;

/// Phases: 0 = sizes, positions, pointers; 1 = `@ref` pointers; 2 = content (checksums), innermost
/// first.
struct Fixup {
  Block* block;
  std::int64_t at;
  int phase;
  int depth;
  std::vector<PathSeg> path;
  std::function<void(Bytes& out, std::int64_t abs)> run;
};

struct RefSite {
  std::string key;
  Block* block;
  std::int64_t start;
  std::int64_t end;
  const void* value;
};

struct RefUse {
  std::string key;
  std::vector<PathSeg> path;
  /// Object targets match by identity first.
  const void* value = nullptr;
  /// Lazily computed encoding (objects), or the encoding itself (values).
  std::function<Bytes()> encode;
  std::optional<Bytes> encoding;
  std::function<std::int64_t()> origin;
  Mark mark;
  /// Start of the pointer's own base (nullopt: this region's start).
  std::optional<Mark> base;
  Prim kind;
  bool le;
  bool relative;
  std::optional<i128> null_value;
};

/// How a view commit treats targets that change size: `Default` moves a grown target to the end
/// and keeps the others where they were, `Append` also moves targets that no longer fit where they
/// were, `Splice` shifts what follows, `Error` makes any size change a DERIVE error.
enum class Grow : std::uint8_t { Default, Append, Splice, Error };
struct StickyPolicy {
  Grow grow = Grow::Default;
  std::optional<std::int64_t> orig_root_size;
  std::optional<std::int64_t> orig_size;
};

/// A base region: the base's own block at offset 0, plus everything placed in it.
class Region {
 public:
  Region();
  Region(const Region&) = delete;
  Region& operator=(const Region&) = delete;

  Block* root;
  std::vector<std::unique_ptr<Block>> blocks;
  std::vector<std::unique_ptr<Placeable>> placeables;
  std::vector<Fixup> fixups;
  std::map<std::pair<const void*, std::string>, Placeable*> identity;
  std::vector<RefSite> ref_sites;
  std::vector<RefUse> ref_uses;
  std::shared_ptr<LStruct> lroot;
  const Layout* layout = nullptr;
  /// The region's total size is padded to a multiple of this (a base's `@alignEnd`).
  std::int64_t align_end = 1;
  /// A base's `@alignEnd` with an origin or offset: the total size is padded until
  /// `(start + size + offset) % to == 0`, start being 0 or the region's start in its byte space.
  struct AlignEnd {
    std::int64_t to;
    bool file;
    std::int64_t offset;
  };
  std::vector<AlignEnd> align_ends;
  /// Where a nested `@base` written inline lands in the enclosing region (`at` bytes into
  /// `block`); empty for regions that start their own byte space.
  struct Anchor {
    Block* block;
    std::int64_t at;
  };
  std::optional<Anchor> anchor;
  /// A nested `@base` region: `@ref` pointers without a target here go to `unresolved`.
  bool escalate = false;
  std::vector<RefUse> unresolved;
  std::optional<StickyPolicy> sticky;
  /// After finish: the assembled bytes.
  std::optional<Bytes> output;
  /// Finished nested regions whose blocks escalated `@ref` closures still reference.
  std::vector<std::unique_ptr<Region>> kept;

  Block* new_block();
  /// Takes the structure the root's writer reported (and, with `take_layout`, its layout when the
  /// region has none).
  void adopt_root(const LEntry& l, bool take_layout);
  /// Lays out, assembles and runs the fixups. Returns the region's bytes.
  const Bytes& finish();

 private:
  void resolve_refs(Bytes& out);
};

/// Assigns positions to every block of the region (docs/IR.md §4).
void layout_region(Region& region);

class Writer {
 public:
  explicit Writer(Region* root);
  Writer(const Writer&) = delete;
  Writer& operator=(const Writer&) = delete;

  /// Current block (inline bytes go here).
  Block* b;
  /// Current base region.
  Region* region;
  /// Struct nesting depth (orders content-dependent fixups).
  int depth = 0;
  std::int64_t index = -1;

  void enter(const Frame* f) {
    frames_.push_back(f);
    depth++;
  }
  void leave() {
    frames_.pop_back();
    depth--;
  }
  /// The current path from the root (snapshot).
  std::vector<PathSeg> path() const;

  /// Offset of the next byte within the current block.
  std::int64_t offset() const { return b->size(); }
  /// `$offset` on write: the base-relative position (exact in a region's own block).
  std::int64_t position() const { return (b->pos >= 0 ? b->pos : 0) + b->size(); }
  Mark mark() const { return Mark{b, b->size()}; }

  ExtentPtr extent() { return std::make_shared<Extent>(b, b->size()); }
  /// (Re)starts a pre-allocated extent at the current position (fixup lambdas capture the extent
  /// before the field is written).
  void open(const ExtentPtr& e) {
    e->block = b;
    e->start = b->size();
    e->end = -1;
    e->stages.clear();
    e->placeable = nullptr;
    e->empty_is_null = false;
    e->plain.reset();
  }
  void close(const ExtentPtr& e) { e->end = b->size(); }
  /// `this` of a base struct: its whole region.
  ExtentPtr region_extent();
  /// Binds a placed field's extent to the placeable holding the field.
  void bind_extent(const ExtentPtr& e, Placeable* p, bool empty_is_null = false);

  // ── primitives ────────────────────────────────────────────────────────────

  void u8(std::uint8_t v) { b->data.push_back(v); }
  void uint(int size, std::uint64_t v, bool le) {
    std::size_t at = b->data.size();
    b->data.resize(at + static_cast<std::size_t>(size));
    store_uint(b->data.data() + at, size, v, le);
  }
  /// Any integer primitive, range checked (RANGE).
  void prim(Prim k, i128 v, bool le, const char* what = nullptr) {
    check_prim(v, k, what);
    uint(prim_info(k).size, static_cast<std::uint64_t>(v), le);
  }
  void f16(double v, bool le) { uint(2, float_to_half(v), le); }
  void f32(float v, bool le) { uint(4, f32_to_bits(v), le); }
  void f64(double v, bool le) { uint(8, f64_to_bits(v), le); }
  void boolean(bool v) { u8(v ? 1 : 0); }

  void bytes(BytesView v) { b->data.insert(b->data.end(), v.begin(), v.end()); }
  /// `u8 x[n]`: exactly n bytes (other lengths would read back differently: DERIVE).
  void bytes_n(BytesView v, std::int64_t n);
  /// Bytes followed by a terminator byte (which must not occur inside: INPUT).
  void bytes_until(BytesView v, i128 term);

  enum class StrMode : std::uint8_t { Count, Until, Rest };
  /// Text: Count pads with NUL units up to n (longer is INPUT), Until appends one NUL unit.
  void str(std::string_view s, int unit, Encoding enc, bool le, StrMode mode, std::int64_t n = 0);

  /// Writes an extern type through its host `write`.
  template <class Host, class V, class... Args>
  void extern_write(const Host& host, const V& value, std::int64_t fixed_size, const Args&... args) {
    Bytes out;
    try {
      out = host.write(value, args...);
    } catch (const Error&) {
      throw;
    } catch (const std::exception& e) {
      fail(ErrorCode::Codec, std::string("extern type write() failed: ") + e.what());
    }
    if (fixed_size >= 0 && static_cast<std::int64_t>(out.size()) != fixed_size)
      fail(ErrorCode::Derive, "extern type wrote " + std::to_string(out.size()) +
                                  " bytes, its fixed size is " + std::to_string(fixed_size));
    bytes(out);
  }

  // ── padding ───────────────────────────────────────────────────────────────

  void fill(std::int64_t n, const Fill& f);
  void pad(i128 n, const Fill& f);
  /// Pads until `(position + offset) % to == 0`, the position counting from the base, or from the
  /// start of the byte space (`file`). Block starts not known yet are required to be multiples of
  /// `to`.
  void align_at(i128 to, const Fill& f, bool file, i128 offset);
  /// Pads until the base-relative position is a multiple of `to`.
  void align(i128 to, const Fill& f) { align_at(to, f, false, 0); }
  /// A base's or the root's `@alignEnd(to, from: …, offset: …)`: pads the whole region.
  void region_align_end(i128 to, bool file, i128 offset);
  void pad_until(std::int64_t start, i128 size, const Fill& f);
  /// Closes a `size(n)` window opened at `start`: longer content is DERIVE, shorter is padded.
  void size_window(std::int64_t start, i128 n);

  // ── fixups ────────────────────────────────────────────────────────────────

  /// Reserves an integer primitive whose value is computed after layout.
  void defer_prim(Prim k, bool le, std::function<i128()> compute, int phase = 0);
  void defer_float(Prim k, bool le, std::function<double()> compute, int phase = 0);
  /// Reserves `n` bytes whose content is computed after layout.
  void defer_bytes(std::int64_t n, std::function<Bytes()> compute, int phase = 0);
  /// A check evaluated after layout.
  void defer_check(std::function<void()> run, int phase = 0);

  // ── targets ───────────────────────────────────────────────────────────────

  /// Places a pointer target: the same object (by address) with the same type key shares one
  /// placeable. `identity` is null for value types (strings, bytes, scalars), which never share.
  Placeable* target(const void* identity, const std::string& key, std::string name,
                    const std::function<LEntry()>& write, const PlaceOptions& opts = {},
                    const void* owner = nullptr);
  /// Places an `at` field's value (no sharing).
  Placeable* place(std::string name, const std::function<LEntry()>& write,
                   const PlaceOptions& opts = {}, const void* owner = nullptr);
  /// Writes an owned pointer: the offset of `p` (null → `null_value`).
  void pointer(Prim kind, bool le, Placeable* p, bool relative, std::optional<i128> null_value,
               std::function<std::int64_t()> origin = {});
  /// Writes a `@ref` pointer, resolved after layout to an already-placed value of the same type:
  /// by identity first, then by equal encoding (first placed wins).
  void ref_pointer(Prim kind, bool le, const std::string& key, bool is_null, const void* identity,
                   std::function<Bytes()> encode, bool relative, std::optional<i128> null_value,
                   std::function<std::int64_t()> origin = {});
  /// Registers an encoded value as a possible `@ref` target.
  void ref_site(const std::string& key, std::int64_t start, const void* value) {
    region->ref_sites.push_back(RefSite{key, b, start, b->size(), value});
  }

  // ── regions ───────────────────────────────────────────────────────────────

  /// Encodes a nested region (a codec's decoded side, a temporary encoding) and returns its bytes.
  Bytes sub_region(const Layout* layout, const std::function<LEntry()>& write);
  /// Writes a `@base` struct inline: its region is laid out on its own and appended here.
  /// Unresolved `@ref` pointers search the enclosing bases. A null `layout` takes the written
  /// struct's own (an instance layout).
  void base(const Layout* layout, const std::function<LEntry()>& write, const void* value = nullptr);
  /// Encodes a value standalone (its plain encoding as a fresh region).
  Bytes encode_alone(const std::function<LEntry()>& write) { return sub_region(nullptr, write); }

  // ── commit mode (views) ───────────────────────────────────────────────────

  /// Original positions of values (sticky layout), or null.
  const Origins* origins = nullptr;
  /// Absolute original position of the current region's base.
  std::int64_t origin_base = 0;

 private:
  void note_origin(Placeable* p, const void* identity, const void* owner);
  std::vector<const Frame*> frames_;
  /// Reserves `n` zero bytes whose content `run` writes after layout.
  void reserve(std::int64_t n, int phase, std::function<void(Bytes& out, std::int64_t abs)> run);
  /// Runs `write` as the root of the nested region `r` and finishes `r`.
  void finish_nested(Region& r, const std::function<LEntry()>& write, bool take_layout);
  Placeable* new_placeable(std::string name, const PlaceOptions& opts);
  void fill_placeable(Placeable* p, const std::function<LEntry()>& write);
  void adopt_refs(Region& nested, Block* block, std::int64_t at);
};

/// Enters a struct writer frame (exception safe).
class FrameScope {
 public:
  FrameScope(Writer& w, const Frame& f) : w_(w) { w.enter(&f); }
  ~FrameScope() { w_.leave(); }
  FrameScope(const FrameScope&) = delete;
  FrameScope& operator=(const FrameScope&) = delete;

 private:
  Writer& w_;
};

/// Sticky layout of a view commit: keep targets where they were in the original.
struct Sticky {
  Grow grow = Grow::Default;
  std::int64_t root_inline = 0;
  std::int64_t size = 0;
  const Origins* origins = nullptr;
};

/// Serializes a root: runs `write` in a fresh root region and finishes it. A null `layout` takes
/// the root struct's own (an instance layout).
Bytes serialize_root(const Layout* layout, std::int64_t align_end,
                     const std::function<LEntry(Writer&)>& write, const Sticky* sticky = nullptr);

/// A placed field whose read-side offset expression disagrees with where it was placed: DERIVE.
void check_placement(std::int64_t offset, const Placeable* p, const char* name);
/// An array written with `actual` elements whose length expression says `expected`: DERIVE.
void check_length(std::int64_t actual, i128 expected);

std::int64_t lcm(std::int64_t a, std::int64_t b);

/// The known part of block `b`'s start in its byte space (`from: file`): blocks whose position
/// a later layout decides get `to` added to their alignment and count as 0.
std::int64_t file_start(Block* b, std::int64_t to);

}  // namespace yaffle
