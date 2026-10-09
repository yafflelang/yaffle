// The read context (docs/IR.md §2.1) used by generated readers: position, base, region end, array
// index and strict flag over a byte space, plus primitive, string and padding readers and the
// identity map of pointer targets.
//
// Positions are absolute within the reader's byte space; `base` and `end` are absolute too.
#pragma once

#include "core.hpp"
#include "prim.hpp"
#include "store.hpp"
#include "strings.hpp"

namespace yaffle {

/// Padding fill: a byte value, or a function of the byte's index within the padding run.
struct Fill {
  int byte = 0;
  std::function<i128(std::int64_t)> fn;
  Fill() = default;
  Fill(int b) : byte(b) {}
  template <class F>
  static Fill of(F f) {
    Fill x;
    x.fn = std::move(f);
    return x;
  }
  std::uint8_t at(std::int64_t i) const {
    return fn ? static_cast<std::uint8_t>(static_cast<std::uint64_t>(fn(i)) & 0xff)
              : static_cast<std::uint8_t>(byte);
  }
};

/// Original positions of values read for a view's materialization (sticky layout on commit).
struct Origins {
  struct Range {
    std::int64_t pos;
    std::int64_t size;
  };
  struct Base {
    std::int64_t base;
    std::int64_t inline_size;
    std::int64_t size;
  };
  std::unordered_map<const void*, Range> objects;
  std::map<std::pair<const void*, std::string>, Range> slots;
  std::unordered_map<const void*, Base> bases;
};

class Reader {
 public:
  explicit Reader(BytesView data, bool strict = false);
  /// A reader over a byte store (views): the window is refilled from the store as reads need it,
  /// and the region end stays unknown while the store's size is expensive.
  Reader(StorePtr store, bool strict, std::int64_t outer);
  Reader(Reader&&) = default;
  Reader& operator=(Reader&&) = default;
  Reader(const Reader&) = delete;
  Reader& operator=(const Reader&) = delete;

  /// A reader for a fresh region (virtual stream or codec output): base 0, end = length. Errors
  /// inside report `at` (the encoded window in this region), or this reader's own outer offset.
  Reader sub(StorePtr store, std::int64_t at) const { return Reader(std::move(store), strict, outer >= 0 ? outer : at); }
  Reader sub(std::shared_ptr<const Bytes> bytes, std::int64_t at) const {
    return sub(std::make_shared<MemStore>(std::move(bytes)), at);
  }

  std::int64_t pos = 0;
  std::int64_t base = 0;
  std::int64_t index = -1;
  bool strict = false;
  /// Offset reported for errors inside a decoded region (-1: none).
  std::int64_t outer = -1;
  /// Furthest position read inside the current base (a base struct consumes it all).
  std::int64_t max_end = 0;
  /// Number of enclosing `@base` structs being read (views measure base regions in full).
  int bases = 0;
  /// End position of the last target read with a target helper.
  std::int64_t last_target_end = 0;
  /// Records where targets were (views materializing a document), or null.
  Origins* origins = nullptr;

  void note_slot(const void* owner, const char* field, std::int64_t addr, std::int64_t size) {
    if (origins) origins->slots[std::make_pair(owner, std::string(field))] = Origins::Range{addr, size};
  }
  void note_base(const void* v, std::int64_t base_pos, std::int64_t inline_size, std::int64_t size) {
    if (origins) origins->bases[v] = Origins::Base{base_pos, inline_size, size};
  }

  /// Size of the whole byte space (resolves a lazy store).
  std::int64_t size() { return store_ ? store_->size() : wend_; }

  // ── region end ──────────────────────────────────────────────────────────────

  /// End of the current region (absolute); resolves an unknown end (may decode a lazy store).
  std::int64_t end() {
    if (end_ == kUnknownEnd) end_ = size();
    return end_;
  }
  /// The end as stored (kUnknownEnd while unknown): for saving and restoring.
  std::int64_t raw_end() const { return end_; }
  void set_end(std::int64_t e) { end_ = e; }
  /// `pos < end` without resolving an unknown end.
  bool more() { return has(1); }
  /// Whether `n` bytes from `pos` are inside the region (without resolving an unknown end).
  bool has(std::int64_t n) {
    if (n < 0) return false;
    if (end_ != kUnknownEnd) return n <= end_ - pos;
    return covers(pos + n);
  }
  /// `at >= end` without resolving an unknown end.
  bool past_end(std::int64_t at) { return end_ != kUnknownEnd ? at >= end_ : !covers(at + 1); }
  /// Bytes known to be left in the region (0 while the end is unknown).
  std::int64_t room() const { return end_ != kUnknownEnd ? std::max<std::int64_t>(0, end_ - pos) : 0; }
  /// Moves to the end of the region.
  void skip_to_end() { pos = end(); }
  /// Whether bytes [0, e) of the byte space exist.
  bool covers(std::int64_t e) { return store_ ? store_->covers(e) : e <= wend_; }

  // ── errors ──────────────────────────────────────────────────────────────────

  std::int64_t at(std::int64_t off) const { return outer >= 0 ? outer : off; }
  [[noreturn]] void fail_at(ErrorCode c, std::string detail, std::int64_t off) const {
    throw Error(c, std::move(detail), at(off));
  }
  [[noreturn]] void fail(ErrorCode c, std::string detail) const {
    fail_at(c, std::move(detail), pos);
  }
  [[noreturn]] void check_fail(const char* message, std::int64_t off) const {
    fail_at(ErrorCode::Check, std::string("check failed: ") + message, off);
  }

  // ── bounds and windows ────────────────────────────────────────────────────

  void need(std::int64_t n) {
    if (n < 0 || n > end_ - pos) eof(n);
    if (pos < wstart_ || pos + n > wend_) refill(pos, n);
  }
  /// The byte at `pos` in the window (after `need`).
  const std::uint8_t* here() const { return wptr_ + (pos - wstart_); }
  [[noreturn]] void eof(std::int64_t n) const;

  /// Narrows the region to `n` bytes from `pos`; returns the previous end for `close_window`.
  std::int64_t window(std::int64_t n);
  /// Skips the rest of the window (padding: zero in strict mode) and restores the outer end.
  void close_window(std::int64_t saved, bool strict_pad);

  /// Bytes `[start, stop)` (absolute) without moving `pos`; valid until the reader reads again.
  BytesView peek_bytes(std::int64_t start, std::int64_t stop);

  // ── integers and floats ─────────────────────────────────────────────────────

  std::uint8_t u8() {
    need(1);
    std::uint8_t b = *here();
    pos++;
    return b;
  }
  std::int8_t i8() { return static_cast<std::int8_t>(u8()); }
  std::uint64_t uN(int size, bool le) {
    need(size);
    std::uint64_t v = load_uint(here(), size, le);
    pos += size;
    return v;
  }
  std::int64_t iN(int size, bool le) { return sign_extend(uN(size, le), size * 8); }
  std::uint16_t u16(bool le) { return static_cast<std::uint16_t>(uN(2, le)); }
  std::int16_t i16(bool le) { return static_cast<std::int16_t>(uN(2, le)); }
  std::uint32_t u32(bool le) { return static_cast<std::uint32_t>(uN(4, le)); }
  std::int32_t i32(bool le) { return static_cast<std::int32_t>(uN(4, le)); }
  std::uint64_t u64(bool le) { return uN(8, le); }
  std::int64_t i64(bool le) { return static_cast<std::int64_t>(uN(8, le)); }
  float f16(bool le) { return half_to_float(static_cast<std::uint16_t>(uN(2, le))); }
  float f32(bool le) { return bits_to_f32(static_cast<std::uint32_t>(uN(4, le))); }
  double f64(bool le) { return bits_to_f64(uN(8, le)); }

  bool boolean(bool strict_check) {
    std::int64_t s = pos;
    std::uint8_t b = u8();
    if (strict_check && b > 1) fail_at(ErrorCode::Check, "bool byte " + hex(b) + " is not 0 or 1", s);
    return b != 0;
  }

  /// A count read from the data: negative is RANGE; a count no region could hold is EOF.
  std::int64_t count(i128 v, int unit = 1, const char* what = "length");

  // ── bytes ─────────────────────────────────────────────────────────────────

  Bytes bytes(std::int64_t n) {
    need(n);
    const std::uint8_t* p = here();
    pos += n;
    return Bytes(p, p + n);
  }
  /// Bytes up to a terminator byte (consumed, not part of the value).
  Bytes bytes_until(i128 term);
  Bytes bytes_rest() { return bytes(end() - pos); }

  // ── strings ───────────────────────────────────────────────────────────────

  std::string str(std::int64_t n_units, int unit, Encoding enc, bool le);
  std::string str_until(int unit, Encoding enc, bool le);
  std::string str_rest(int unit, Encoding enc, bool le) { return str((end() - pos) / unit, unit, enc, le); }

  // ── padding ─────────────────────────────────────────────────────────────

  void pad(std::int64_t n, const Fill& fill, bool strict_pad);
  void pad(i128 n, const Fill& fill, bool strict_pad) {
    if (n < 0 || n > (static_cast<i128>(1) << 62))
      fail(ErrorCode::Range, "invalid padding length " + to_string(n));
    pad(static_cast<std::int64_t>(n), fill, strict_pad);
  }
  /// Pads until `(pos - origin + offset) % to == 0`; `origin` is `base`, or 0 (the start of
  /// this byte space) for `align(…, from: file)`.
  void align_at(i128 to, std::int64_t origin, i128 offset, const Fill& fill, bool strict_pad);
  void align(i128 to, const Fill& fill, bool strict_pad) { align_at(to, base, 0, fill, strict_pad); }
  void pad_until(std::int64_t start, i128 size, const Fill& fill, bool strict_pad);

  // ── targets and identity ──────────────────────────────────────────────────

  /// Reads a shared target (struct, array, union) at `addr` into a default-constructed object.
  /// The same address and type key give the same object; the object is registered before its
  /// contents are read, so cycles work: a pointer back to an object still being read gets a
  /// non-owning reference, which keeps cyclic graphs free of reference-count cycles.
  template <class T, class F>
  std::shared_ptr<T> target_obj(std::int64_t addr, const std::string& key, F&& read) {
    std::string k = ident_key(addr, key);
    auto it = ident_.find(k);
    if (it != ident_.end()) {
      last_target_end = it->second.end;
      auto p = std::static_pointer_cast<T>(it->second.obj);
      return it->second.in_progress ? non_owning(p) : p;
    }
    check_addr(addr);
    auto obj = std::make_shared<T>();
    ident_[k] = IdentEntry{obj, addr, true};
    {
      Restore<std::int64_t> rp(pos, addr);
      Restore<std::int64_t> ri(index, -1);
      try {
        read(*obj);
      } catch (...) {
        ident_.erase(k);
        throw;
      }
      IdentEntry& e = ident_[k];
      e.end = pos;
      e.in_progress = false;
      last_target_end = pos;
      if (pos > max_end) max_end = pos;
      if (origins) origins->objects[obj.get()] = Origins::Range{addr, pos - addr};
    }
    return obj;
  }

  /// Reads a value target (string, bytes, scalar) at `addr`; values have no identity.
  template <class F>
  auto target_value(std::int64_t addr, F&& read) -> decltype(read()) {
    check_addr(addr);
    Restore<std::int64_t> rp(pos, addr);
    Restore<std::int64_t> ri(index, -1);
    auto v = read();
    last_target_end = pos;
    if (pos > max_end) max_end = pos;
    return v;
  }

  /// An inline struct of a type pointers can target: one object per (address, type).
  template <class T, class F>
  std::shared_ptr<T> inline_obj(const std::string& key, F&& read) {
    std::string k = ident_key(pos, key);
    auto it = ident_.find(k);
    std::shared_ptr<T> obj;
    if (it != ident_.end()) {
      obj = std::static_pointer_cast<T>(it->second.obj);
      it->second.in_progress = true;
    } else {
      obj = std::make_shared<T>();
      ident_[k] = IdentEntry{obj, pos, true};
    }
    try {
      read(*obj);
    } catch (...) {
      auto e = ident_.find(k);
      if (e != ident_.end()) e->second.in_progress = false;
      throw;
    }
    IdentEntry& e = ident_[k];
    e.end = pos;
    e.in_progress = false;
    return obj;
  }

  /// Runs `read` at absolute `addr` and restores `pos` (no identity tracking).
  template <class F>
  void peek_at(std::int64_t addr, F&& read) {
    Restore<std::int64_t> rp(pos, addr);
    read();
    if (pos > max_end) max_end = pos;
  }

  [[noreturn]] void union_fail(std::vector<Error> errors, std::int64_t start) const;

  // ── extern types ──────────────────────────────────────────────────────────

  /// Reads an extern type: host `size()` (unless the size is fixed), then `read()`.
  template <class Host, class... Args>
  auto extern_read(const Host& host, std::int64_t fixed_size, const Args&... args)
      -> decltype(host.read(BytesView(), args...)) {
    std::int64_t start = pos;
    std::int64_t size = fixed_size;
    if (size < 0) {
      std::int64_t probe = has(16) ? 16 : end() - pos;
      for (;;) {
        need(probe);
        BytesView view = peek_bytes(pos, pos + probe);
        std::optional<std::size_t> s;
        try {
          s = host.size(view, args...);
        } catch (const Error&) {
          throw;
        } catch (const std::exception& e) {
          fail_at(ErrorCode::Codec, std::string("extern type size(): ") + e.what(), start);
        }
        if (s) {
          size = static_cast<std::int64_t>(*s);
          break;
        }
        if (!has(probe + 1)) fail(ErrorCode::Eof, "extern type needs more bytes than the region has");
        probe = has(probe * 2) ? probe * 2 : end() - pos;
      }
    }
    need(size);
    BytesView bytes = peek_bytes(pos, pos + size);
    pos += size;
    try {
      return host.read(bytes, args...);
    } catch (const Error&) {
      throw;
    } catch (const std::exception& e) {
      fail_at(ErrorCode::Codec, std::string("extern type read(): ") + e.what(), start);
    }
  }

 private:
  struct IdentEntry {
    std::shared_ptr<void> obj;
    std::int64_t end = 0;
    bool in_progress = false;
  };
  StorePtr store_;
  /// End of the current region (kUnknownEnd: not known yet).
  std::int64_t end_ = 0;
  /// The window: bytes [wstart_, wend_) of the byte space at wptr_, kept alive by wown_.
  const std::uint8_t* wptr_ = nullptr;
  std::int64_t wstart_ = 0;
  std::int64_t wend_ = 0;
  std::shared_ptr<const void> wown_;
  /// Offset from pos of the next unit (1, 2 or 4 bytes) equal to `byte` (for units > 1: a NUL
  /// unit), or -1 if the region ends first.
  std::int64_t find_unit(std::int64_t unit, std::uint8_t byte);
  /// Refills the window to hold [at, at + n) (EOF if the bytes don't exist).
  void refill(std::int64_t at, std::int64_t n);
  std::unordered_map<std::string, IdentEntry> ident_;

  static std::string ident_key(std::int64_t addr, const std::string& key) {
    std::string k = std::to_string(addr);
    k += ':';
    k += key;
    return k;
  }
  void check_addr(std::int64_t addr) {
    if (addr < 0 || !covers(addr)) fail(ErrorCode::Eof, "target address " + hex(addr) + " is outside the data");
  }
};

/// Saves and restores the base around a `@base` struct (exception safe). On success the reader
/// moves past everything the base read (its targets included).
class BaseScope {
 public:
  explicit BaseScope(Reader& r) : r_(r), base_(r.base), max_(r.max_end) {
    r.base = r.pos;
    r.max_end = r.pos;
    r.bases++;
  }
  /// Called after the base's members: consume its whole region.
  void finish() {
    r_.pos = std::max(r_.pos, r_.max_end);
    done_ = true;
  }
  ~BaseScope() {
    r_.bases--;
    r_.base = base_;
    r_.max_end = done_ ? std::max(max_, r_.pos) : max_;
  }
  BaseScope(const BaseScope&) = delete;
  BaseScope& operator=(const BaseScope&) = delete;

 private:
  Reader& r_;
  std::int64_t base_;
  std::int64_t max_;
  bool done_ = false;
};

}  // namespace yaffle
