// Views: lazy, typed access to a document with surgical writes.
//
// - A `Doc` holds the bytes behind a family of views. Generated `XView` classes read a struct by
//   *scanning* it: its scalars are read, but pointer and `at` targets, codec regions, virtual
//   streams and large byte arrays are not; they are read on access (lazy closures in the scan).
// - Setting a field whose encoding has the same size and that nothing else depends on patches the
//   bytes in place. Any other edit *materializes* the document: it is parsed once into a typed
//   value (recording where every target was) and the edit is applied to that value.
// - `commit()` returns the new bytes: the in-place patches (fast path), or the materialized value
//   re-serialized with a sticky layout that keeps targets where they were as far as the grow
//   policy allows (slow path); `patches()` lists the edits against the original bytes.
#pragma once

#include "codec.hpp"
#include "reader.hpp"
#include "writer.hpp"

namespace yaffle {

/// An edit of the original bytes: at `at`, `remove` bytes are replaced by `insert`.
struct Patch {
  std::int64_t at = 0;
  std::int64_t remove = 0;
  Bytes insert;
  bool operator==(const Patch&) const = default;
};

class Doc;

/// Where a struct instance is: its space (0 = the document, others: decoded regions), position,
/// and the read context in effect there.
struct Loc {
  int space = 0;
  std::int64_t pos = 0;
  std::int64_t base = 0;
  std::int64_t end = 0;
  std::int64_t index = -1;
  bool strict = false;
};

/// A struct value inside a field (inline, an array element, a target): its location and the
/// arguments of its type (a generated `X_Args`). `loc.pos < 0` marks a null pointer.
struct Kid {
  Loc loc;
  std::shared_ptr<const void> args;
  /// Identity key of the value (type and arguments, as the reader keys targets).
  std::string key;
};

/// What a scan knows about one field.
struct FieldScan {
  /// Inline bytes of the field (-1: not present).
  std::int64_t start = -1;
  std::int64_t end = -1;
  /// Address of a pointer or `at` target (-1: none or null).
  std::int64_t target = -1;
  /// Struct values inside the field, in order.
  std::vector<Kid> kids;
  /// Reads the field's full value into its member (lazy fields).
  std::function<void(void*)> lazy;
  bool loaded = true;
  /// Bytes fields: the value's length when the scan knows it without reading the value (a count,
  /// or the innermost `@size` under a codec), and the value as a byte store (read on demand).
  std::optional<std::int64_t> length;
  std::function<StorePtr(Doc&)> store;
};

struct ScanBase {
  std::vector<FieldScan> fields;
  std::int64_t end = 0;
  virtual ~ScanBase() = default;
};

/// A scanned struct: its shallow value (lazy members unread) and per-field information.
template <class S>
struct NodeScan : ScanBase {
  S v;
  /// Loads a lazy field into `member` (once).
  template <class T>
  void load(std::size_t field, T& member) {
    FieldScan& f = fields[field];
    if (!f.loaded && f.lazy) {
      f.lazy(&member);
      f.loaded = true;
    }
  }
};

/// Context of a scan (the document, the space being scanned and the struct's own location).
struct ScanCtx {
  Doc* doc;
  int space;
  const Kid* self = nullptr;
  Loc loc(const Reader& r) const { return Loc{space, r.pos, r.base, r.raw_end(), r.index, r.strict}; }
};

/// A step of a view's path from the root: field and element, how to find the child's value in a
/// materialized parent, and how to locate it in the bytes from the parent's scan.
struct Step {
  int field;
  std::int64_t elem;
  /// Field name (error paths) and whether `elem` is an array index.
  const char* name;
  bool many;
  void* (*nav)(void* parent, std::int64_t elem);
  Kid (*locate)(Doc& doc, const Kid& parent, std::int64_t elem);
};

class Doc {
 public:
  /// A document in memory.
  explicit Doc(Bytes data);
  /// A document over a byte store (e.g. a FileStore: views read only the blocks they touch).
  explicit Doc(StorePtr source);
  Doc(const Doc&) = delete;
  Doc& operator=(const Doc&) = delete;

  /// The document as views read it: the source with the in-place edits (space 0).
  std::shared_ptr<OverlayStore> current;
  /// The in-place edits since the last commit.
  std::vector<Patch> inplace;
  /// Bumped by every edit (scans are re-run).
  std::uint64_t version = 0;
  /// Bumped by every commit (positions change: views re-locate themselves).
  std::uint64_t epoch = 0;
  bool structural = false;
  /// The materialized root value (after a structural edit).
  std::shared_ptr<void> value;
  Origins origins;
  /// Size of the root's own bytes in the original (sticky layout).
  std::int64_t root_inline = 0;
  /// The root struct's location and arguments.
  Kid root;
  /// Parses the document into `value` (with origins) — set by the generated root API.
  std::function<void(Doc&)> materialize_fn;
  /// Serializes `value` with a sticky layout — set by the generated root API.
  std::function<Bytes(Doc&, Grow)> serialize_fn;

  // ── byte spaces ─────────────────────────────────────────────────────────────

  /// A byte space views read (decoded codec regions, streams), created on first use.
  struct Space {
    StorePtr store;
    std::function<StorePtr(Doc&)> make;
    /// Offset reported for errors inside the space (its encoded region in the document), or -1.
    std::int64_t outer = -1;
  };
  /// The id of the space registered under `key` (registering it, without creating its store).
  int space(const std::string& key, std::int64_t outer, std::function<StorePtr(Doc&)> make);
  /// The store of a space (created on first use).
  StorePtr store(int space);
  /// Sets a space's store if it has none yet (a scan that already built it).
  void prime(int space, StorePtr store);
  /// A reader positioned at `l`.
  Reader reader(const Loc& l);
  /// A reader over the whole current document (materialization).
  Reader full_reader(bool strict);
  /// Size of the document the patches refer to.
  std::int64_t original_size() { return current->base()->size(); }

  /// The (cached) scan of struct `S` at `k`.
  template <class S>
  NodeScan<S>& scan(const Kid& k, const char* type,
                    void (*entry)(Reader&, ScanCtx&, NodeScan<S>&, const void* args)) {
    std::string key = std::to_string(k.loc.space) + ":" + std::to_string(k.loc.pos) + ":" + type;
    auto it = scans_.find(key);
    if (it != scans_.end()) return static_cast<NodeScan<S>&>(*it->second);
    if (k.loc.pos < 0) fail(ErrorCode::Input, "null target");
    auto ns = std::make_shared<NodeScan<S>>();
    Reader r = reader(k.loc);
    ScanCtx sc{this, k.loc.space, &k};
    entry(r, sc, *ns, k.args.get());
    ns->end = r.pos;
    NodeScan<S>& out = *ns;
    scans_.emplace(std::move(key), std::move(ns));
    return out;
  }

  /// The full value of struct `S` at `k` (a fresh parse of its subtree).
  template <class S>
  S read(const Kid& k, void (*entry)(Reader&, S&, const void* args)) {
    if (k.loc.pos < 0) fail(ErrorCode::Input, "null target");
    Reader r = reader(k.loc);
    S v{};
    entry(r, v, k.args.get());
    return v;
  }

  bool materialized() const { return value != nullptr; }
  /// Parses the document into `value` (once).
  void materialize();
  void mark_structural() {
    structural = true;
    version++;
  }
  /// Replaces bytes in place (same size).
  void patch(std::int64_t at, BytesView data);
  /// The edits as patches against the original (no side effects).
  std::vector<Patch> patches(Grow grow = Grow::Default);
  /// Applies all edits: returns the new bytes and rebinds the document to them.
  Bytes commit(Grow grow = Grow::Default);

 private:
  std::unordered_map<std::string, std::shared_ptr<ScanBase>> scans_;
  std::vector<Space> spaces_;
  std::unordered_map<std::string, int> space_ids_;
  void reset_spaces();
  struct Plan {
    std::vector<Patch> patches;
    Bytes bytes;
  };
  Plan plan(Grow grow);
};

using DocPtr = std::shared_ptr<Doc>;

/// Common part of generated views: the document, the path from the root, the location.
class ViewBase {
 public:
  ViewBase(DocPtr doc, std::vector<Step> path, bool in_place = true)
      : doc_(std::move(doc)), path_(std::move(path)), in_place_(in_place) {}

  /// Absolute position of the struct in its space.
  std::int64_t offset() const { return kid().loc.pos; }
  /// The edits so far as patches against the original bytes.
  std::vector<Patch> patches(Grow grow = Grow::Default) const { return doc_->patches(grow); }
  /// Applies the edits; returns the new bytes (views stay usable on the new bytes).
  Bytes commit(Grow grow = Grow::Default) const { return doc_->commit(grow); }
  /// True once an edit made the document structural (re-serialized on commit).
  bool materialized() const { return doc_->materialized(); }
  const DocPtr& doc() const { return doc_; }
  /// Where the struct is (its space, position and read context), and its type arguments.
  const Kid& location() const { return kid(); }
  /// True for the view of a null pointer element.
  bool is_null() const { return kid().loc.pos < 0; }
  /// Prepends the view's path from the root to an error raised inside it, and seals the error
  /// (its path is complete).
  void prefix_path(Error& e) const {
    if (e.sealed) return;
    prefix_path(e, path_.size());
    e.sealed = true;
  }

 protected:
  DocPtr doc_;
  std::vector<Step> path_;
  /// In-place patches are safe (no ancestor derives a value from this struct's content).
  bool in_place_;

  /// The struct's location (re-located through the path after a commit).
  const Kid& kid() const;
  /// The struct's value in the materialized document.
  void* resolve() const;
  /// A child path.
  std::vector<Step> child(int field, std::int64_t elem, const char* name, bool many,
                          void* (*nav)(void*, std::int64_t),
                          Kid (*locate)(Doc&, const Kid&, std::int64_t)) const {
    std::vector<Step> p = path_;
    p.push_back(Step{field, elem, name, many, nav, locate});
    return p;
  }
  /// Prepends the first `steps` steps of the path.
  void prefix_path(Error& e, std::size_t steps) const;

 private:
  mutable std::uint64_t epoch_ = ~std::uint64_t(0);
  mutable Kid kid_;
};

/// A sequence of struct views (array elements).
template <class V>
class ArrayView {
 public:
  ArrayView(DocPtr doc, std::vector<Step> parent, int field, const char* name, std::size_t size,
            void* (*nav)(void*, std::int64_t), Kid (*locate)(Doc&, const Kid&, std::int64_t),
            bool in_place)
      : doc_(std::move(doc)),
        parent_(std::move(parent)),
        field_(field),
        name_(name),
        size_(size),
        nav_(nav),
        locate_(locate),
        in_place_(in_place) {}

  std::size_t size() const { return size_; }
  bool empty() const { return size_ == 0; }
  V operator[](std::size_t i) const {
    std::vector<Step> p = parent_;
    p.push_back(Step{field_, static_cast<std::int64_t>(i), name_, true, nav_, locate_});
    return V(doc_, std::move(p), in_place_);
  }
  V at(std::size_t i) const {
    if (i >= size_) fail(ErrorCode::Range, "index " + std::to_string(i) + " is out of bounds");
    return (*this)[i];
  }

  class iterator {
   public:
    iterator(const ArrayView* a, std::size_t i) : a_(a), i_(i) {}
    V operator*() const { return (*a_)[i_]; }
    iterator& operator++() {
      i_++;
      return *this;
    }
    bool operator!=(const iterator& o) const { return i_ != o.i_; }

   private:
    const ArrayView* a_;
    std::size_t i_;
  };
  iterator begin() const { return iterator(this, 0); }
  iterator end() const { return iterator(this, size_); }

 private:
  DocPtr doc_;
  std::vector<Step> parent_;
  int field_;
  const char* name_;
  std::size_t size_;
  void* (*nav_)(void*, std::int64_t);
  Kid (*locate_)(Doc&, const Kid&, std::int64_t);
  bool in_place_;
};

/// The kid of a field of a scan (RANGE if missing; a null pointer has `loc.pos < 0`).
const Kid& kid_of(const ScanBase& s, int field, std::int64_t elem);

/// Patches turning `orig` into `out` (sorted, non-overlapping, in `orig` coordinates).
std::vector<Patch> diff(BytesView orig, BytesView out);
/// Applies sorted, non-overlapping patches.
Bytes apply_patches(BytesView orig, const std::vector<Patch>& patches);

/// Navigation helpers for generated `nav_` functions.
template <class T>
inline void* nav_ptr(T& v) {
  return &v;
}
template <class T>
inline void* nav_ptr(std::shared_ptr<T>& p) {
  if (!p) fail(ErrorCode::Input, "null target");
  return p.get();
}
template <class T>
inline void* nav_ptr(std::optional<T>& o) {
  if (!o) fail(ErrorCode::Input, "missing value");
  return nav_ptr(*o);
}
template <class T>
inline void* nav_elem(std::vector<T>& v, std::int64_t i) {
  if (i < 0 || i >= static_cast<std::int64_t>(v.size()))
    fail(ErrorCode::Range, "index " + std::to_string(i) + " is out of bounds");
  return nav_ptr(v[static_cast<std::size_t>(i)]);
}
template <class T>
inline void* nav_elem(std::shared_ptr<std::vector<T>>& v, std::int64_t i) {
  if (!v) fail(ErrorCode::Input, "null target");
  return nav_elem(*v, i);
}
template <class T>
inline void* nav_elem(std::optional<T>& o, std::int64_t i) {
  if (!o) fail(ErrorCode::Input, "missing value");
  return nav_elem(*o, i);
}

/// Whether a member holds a value (non-null pointer, engaged optional).
template <class T>
inline bool present(const T&) {
  return true;
}
template <class T>
inline bool present(const std::shared_ptr<T>& p) {
  return p != nullptr;
}
template <class T>
inline bool present(const std::optional<T>& o) {
  return o.has_value() && present(*o);
}

/// The struct a scan is reading (its location and arguments), for byte spaces created later.
inline const Kid& self_of(const ScanCtx& sc) {
  if (!sc.self) fail(ErrorCode::Input, "internal: a view scan without its own location");
  return *sc.self;
}

/// A `@ranged` codec region [start, start + n) of `parent` decoded block by block on access.
template <class C>
StorePtr ranged_store(StorePtr parent, std::int64_t start, std::int64_t n, const C& codec, const char* name,
                      CodecCtx cc, std::int64_t at) {
  auto enc = std::make_shared<SliceStore>(std::move(parent), start, n);
  const C* cp = &codec;
  return std::make_shared<RangedStore>(enc, [cp, name, cc, at](BytesView in, std::size_t position) {
    CodecCtx c = cc;
    c.position = position;
    return codec_decode(*cp, name, in, c, false, at).output;
  });
}

/// A codec region [start, start + n) of `parent`, decoded whole on first access.
template <class C>
StorePtr decoded_store(StorePtr parent, std::int64_t start, std::int64_t n, const C& codec, const char* name,
                       CodecCtx cc, std::int64_t at) {
  auto enc = std::make_shared<SliceStore>(std::move(parent), start, n);
  const C* cp = &codec;
  return std::make_shared<LazyStore>([enc, cp, name, cc, at]() -> std::shared_ptr<const Bytes> {
    Bytes in = enc->read(0, enc->size());
    return std::make_shared<const Bytes>(codec_decode(*cp, name, BytesView(in), cc, false, at).output);
  });
}

/// `raw[a..b]` over a stream store (EOF when the slice is outside the stream).
inline StorePtr slice_store(StorePtr inner, i128 start, std::optional<i128> stop) {
  if (start < 0 || (stop && *stop < start) || !inner->covers(static_cast<std::int64_t>(stop ? *stop : start)))
    fail(ErrorCode::Eof, "stream slice [" + to_string(start) + ", " + (stop ? to_string(*stop) : std::string("end")) +
                             ") is outside the stream");
  std::optional<std::int64_t> len;
  if (stop) len = static_cast<std::int64_t>(*stop - start);
  return std::make_shared<SliceStore>(std::move(inner), static_cast<std::int64_t>(start), len);
}

/// The byte store of a scanned bytes field (INPUT if the field has none: absent).
inline StorePtr field_store(Doc& d, const FieldScan& f, const char* name) {
  if (!f.store) fail(ErrorCode::Input, std::string("missing value ") + name);
  return f.store(d);
}

/// The stream of `from arr[*].piece`: a PieceStore over the element structs `kids`. A piece's
/// length comes from the element's scan when it states it, else from decoding the piece. Errors
/// carry the piece's path (`arr[k].piece`), sealed.
template <class E>
StorePtr piece_store(Doc& d, const std::vector<Kid>& kids, const char* type,
                     void (*entry)(Reader&, ScanCtx&, NodeScan<E>&, const void*), int piece, const char* arr,
                     const char* piece_name) {
  auto ks = std::make_shared<const std::vector<Kid>>(kids);
  Doc* dp = &d;
  auto at = [dp, ks, type, entry, arr, piece_name](std::int64_t k, auto&& f) {
    try {
      return f(dp->scan<E>((*ks)[static_cast<std::size_t>(k)], type, entry));
    } catch (Error& e) {
      if (!e.sealed) {
        if (e.path.empty()) e.prefix(piece_name);
        e.prefix(arr, {k});
        e.sealed = true;
      }
      throw;
    }
  };
  PieceStore::Source src;
  src.count = static_cast<std::int64_t>(ks->size());
  src.length = [at, piece](std::int64_t k) {
    return at(k, [piece](NodeScan<E>& es) { return es.fields[static_cast<std::size_t>(piece)].length; });
  };
  src.decode = [at, piece, dp, piece_name](std::int64_t k) {
    return at(k, [piece, dp, piece_name](NodeScan<E>& es) {
      return field_store(*dp, es.fields[static_cast<std::size_t>(piece)], piece_name)->all();
    });
  };
  return std::make_shared<PieceStore>(std::move(src));
}

/// Encodes a value standalone (in-place patch encoders).
Bytes encode_standalone(const std::function<void(Writer&)>& write);

// ── materialization through views ─────────────────────────────────────────────

/// Builds plain values from views, field by field through their getters and child views. Struct
/// values at one location with one type key are one object, cycles included: a view reached again
/// while it is being built gets a non-owning reference.
class MatCtx {
 public:
  template <class T, class F>
  std::shared_ptr<T> shared(const Kid& k, F&& build) {
    std::string key = std::to_string(k.loc.space) + ":" + std::to_string(k.loc.pos) + ":" + k.key;
    auto it = objs_.find(key);
    if (it != objs_.end()) {
      auto p = std::static_pointer_cast<T>(it->second.obj);
      return it->second.in_progress ? non_owning(p) : p;
    }
    auto obj = std::make_shared<T>();
    objs_[key] = Entry{obj, true};
    try {
      build(*obj);
    } catch (...) {
      objs_.erase(key);
      throw;
    }
    objs_[key].in_progress = false;
    return obj;
  }

 private:
  struct Entry {
    std::shared_ptr<void> obj;
    bool in_progress = false;
  };
  std::unordered_map<std::string, Entry> objs_;
};

/// Materializes the struct behind view `cv` into `dst` (a value, a shared object, an optional).
template <class S, class CV>
void mat_assign(S& dst, const CV& cv, MatCtx& m) {
  cv.materialize_into(dst, m);
}
template <class S, class CV>
void mat_assign(std::shared_ptr<S>& dst, const CV& cv, MatCtx& m) {
  if (cv.is_null()) {
    dst = nullptr;
    return;
  }
  dst = m.shared<S>(cv.location(), [&](S& o) { cv.materialize_into(o, m); });
}
template <class S, class CV>
void mat_assign(std::optional<S>& dst, const CV& cv, MatCtx& m) {
  dst.emplace();
  mat_assign(*dst, cv, m);
}

/// Materializes the elements of an array view into `dst`.
template <class E, class V>
void mat_array(std::vector<E>& dst, const ArrayView<V>& av, MatCtx& m) {
  dst.clear();
  dst.resize(av.size());
  for (std::size_t i = 0; i < av.size(); i++) mat_assign(dst[i], av[i], m);
}
template <class E, class V>
void mat_array(std::shared_ptr<std::vector<E>>& dst, const ArrayView<V>& av, MatCtx& m) {
  dst = std::make_shared<std::vector<E>>();
  mat_array(*dst, av, m);
}
template <class E, class V>
void mat_array(std::optional<E>& dst, const ArrayView<V>& av, MatCtx& m) {
  dst.emplace();
  mat_array(*dst, av, m);
}

}  // namespace yaffle
