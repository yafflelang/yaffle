// Small helpers called by generated code: aggregates, field access through shared values, regex,
// write-side validation, bitfields, LEB128 built-ins and virtual-stream splitting.
#pragma once

#include "codec.hpp"
#include "core.hpp"
#include "json.hpp"
#include "strings.hpp"

namespace yaffle {

// ── values behind shared pointers ───────────────────────────────────────────────

template <class T>
inline const T& obj(const T& v) {
  return v;
}
template <class T>
inline const T& obj(const std::shared_ptr<T>& p) {
  if (!p) fail(ErrorCode::Input, "null value");
  return *p;
}
template <class T>
inline const T& obj(const std::optional<T>& o) {
  if (!o) fail(ErrorCode::Input, "missing value");
  return *o;
}

/// Bounds-checked element access (RANGE when out of bounds).
template <class C>
inline decltype(auto) at(const C& c, i128 i) {
  const auto& a = obj(c);
  if (i < 0 || i >= static_cast<i128>(a.size()))
    fail(ErrorCode::Range,
         "index " + to_string(i) + " is out of bounds (length " + std::to_string(a.size()) + ")");
  return a[static_cast<std::size_t>(i)];
}

inline Bytes to_bytes(BytesView v) { return Bytes(v.begin(), v.end()); }

/// A missing root option without a default (INPUT).
template <class T>
inline T missing_option(const char* name) {
  fail(ErrorCode::Input, std::string("missing option ") + name);
}

/// `$end` is not known while writing (a length using it is checked after layout instead).
inline std::int64_t end_unavailable() { fail(ErrorCode::Derive, "$end is not available on write"); }

inline Endian endian_from_json(const Json& j) {
  if (j.is_string() && j.as_string() == "le") return Endian::le;
  if (j.is_string() && j.as_string() == "be") return Endian::be;
  fail(ErrorCode::Input, "expected \"le\" or \"be\", got " + describe(j));
}

/// Part of an identity key (struct arguments and lengths are part of a target's type).
inline std::string key_part(Endian e) { return e == Endian::le ? "le" : "be"; }
inline std::string key_part(const std::string& s) { return s; }
inline std::string key_part(bool b) { return b ? "true" : "false"; }
inline std::string key_part(i128 v) { return to_string(v); }
template <class T>
inline std::string key_part(const T& v) {
  if constexpr (std::is_arithmetic_v<T>)
    return std::to_string(v);
  else if constexpr (std::is_enum_v<T>)
    return std::to_string(static_cast<long long>(v));
  else
    return "?";
}

/// The address used as the identity of a value (shared values: the object; others: none).
template <class T>
inline const void* identity_of(const std::shared_ptr<T>& p) {
  return p.get();
}
template <class T>
inline const void* identity_of(const T&) {
  return nullptr;
}

/// Length of an array value (vectors, bytes, shared arrays; null counts as empty).
template <class T>
inline std::int64_t size_of(const std::vector<T>& v) {
  return static_cast<std::int64_t>(v.size());
}
template <class T>
inline std::int64_t size_of(const std::shared_ptr<T>& p) {
  return p ? size_of(*p) : 0;
}
template <class T>
inline std::int64_t size_of(const std::optional<T>& o) {
  return o ? size_of(*o) : 0;
}
inline std::int64_t size_of(const std::string& s) { return static_cast<std::int64_t>(s.size()); }

// ── aggregates ──────────────────────────────────────────────────────────────────

template <class C, class F>
auto map_values(const C& c, F&& f) {
  using R = std::decay_t<decltype(f(*std::begin(obj(c))))>;
  std::vector<R> out;
  const auto& v = obj(c);
  out.reserve(v.size());
  for (const auto& e : v) out.push_back(f(e));
  return out;
}

template <class T>
inline i128 sum_int(const std::vector<T>& v) {
  i128 s = 0;
  for (const auto& x : v) s = add(s, static_cast<i128>(x));
  return s;
}
template <class T>
inline double sum_float(const std::vector<T>& v) {
  double s = 0;
  for (const auto& x : v) s += static_cast<double>(x);
  return s;
}
template <class T>
inline T min_of(const std::vector<T>& v) {
  if (v.empty()) fail(ErrorCode::Range, "min of an empty array");
  return *std::min_element(v.begin(), v.end());
}
template <class T>
inline T max_of(const std::vector<T>& v) {
  if (v.empty()) fail(ErrorCode::Range, "max of an empty array");
  return *std::max_element(v.begin(), v.end());
}
/// The element count of each element of an array of arrays (`lengths(lists)`).
template <class T>
inline std::vector<std::int64_t> lengths(const std::vector<T>& v) {
  std::vector<std::int64_t> out;
  out.reserve(v.size());
  for (const auto& x : v) out.push_back(size_of(x));
  return out;
}

/// `indexOf(array, value)`: the first index, or INPUT (inverse of `names[it]`).
template <class C, class V>
inline std::int64_t index_of(const C& c, const V& v) {
  const auto& a = obj(c);
  for (std::size_t i = 0; i < a.size(); i++)
    if (a[i] == v) return static_cast<std::int64_t>(i);
  fail(ErrorCode::Input, "value is not in the table");
}

/// `value in /pattern/` (ECMAScript regex, whole-string match).
bool regex_match(const std::string& s, const char* pattern);

// ── write-side validation ───────────────────────────────────────────────────────

/// `read(write(v))` must give `v` back (INPUT otherwise).
template <class A, class B>
inline void check_round_trip(const A& v, const B& back) {
  bool ok;
  if constexpr (std::is_arithmetic_v<A> && std::is_arithmetic_v<B>) {
    if constexpr (std::is_floating_point_v<A> || std::is_floating_point_v<B>)
      ok = (static_cast<double>(v) == static_cast<double>(back)) ||
           (std::isnan(static_cast<double>(v)) && std::isnan(static_cast<double>(back)));
    else
      ok = static_cast<i128>(v) == static_cast<i128>(back);
  } else if constexpr (std::is_same_v<A, i128> || std::is_same_v<B, i128>) {
    ok = static_cast<i128>(v) == static_cast<i128>(back);
  } else {
    ok = v == back;
  }
  if (!ok) fail(ErrorCode::Input, "value does not survive the transform");
}

/// Float transforms: the value must be within half a storage step of what reads back.
void check_float_round_trip(double v, double back, double next);

/// A bitfield value as unsigned bits of `width` (signed values in two's complement).
std::uint64_t bits_of(i128 v, int width, bool is_signed);

/// Encodes a string padded with NUL units to exactly `n` bytes.
Bytes encode_fixed_string(std::string_view s, std::int64_t n, int unit, Encoding enc, bool le);

// ── LEB128 built-in extern types ────────────────────────────────────────────────

struct Uleb128 {
  std::optional<std::size_t> size(BytesView bytes, std::int64_t max_bytes = 10) const;
  std::uint64_t read(BytesView bytes, std::int64_t max_bytes = 10) const;
  Bytes write(std::uint64_t value, std::int64_t max_bytes = 10) const;
};
struct Sleb128 {
  std::optional<std::size_t> size(BytesView bytes, std::int64_t max_bytes = 10) const;
  std::int64_t read(BytesView bytes, std::int64_t max_bytes = 10) const;
  Bytes write(std::int64_t value, std::int64_t max_bytes = 10) const;
};
inline const Uleb128 uleb128{};
inline const Sleb128 sleb128{};

// ── streams (write side) ────────────────────────────────────────────────────────

/// Split policy of `T x from arr[*].piece`: how to measure an element for `@split(fit)`.
template <class E>
struct FitPolicy {
  /// Base-relative offset of element k's block.
  std::function<std::int64_t(std::int64_t)> offset;
  /// Encoded size of an element on its own.
  std::function<std::int64_t(const E&)> size;
};

/// Write side of `T x from arr[*].piece`: splits the encoded stream into the elements' pieces.
/// Piece sizes given in the input (every element's size field) win, and an element whose piece is
/// unchanged is kept as it is (codec reuse still recognizes it); otherwise `fit` picks, for element
/// k, the longest piece whose encoded element fits before element k+1's block.
///
/// `given_size(e)`: the element's size field if given. `piece(e)`: its current piece.
/// `with_piece(e, bytes, clear_size)`: a copy with the piece replaced.
template <class E, class GivenSize, class PieceOf, class WithPiece>
std::vector<E> split_stream(const std::vector<E>& els, BytesView data, bool has_size_field,
                            GivenSize given_size, PieceOf piece_of, WithPiece with_piece,
                            const std::optional<FitPolicy<E>>& fit) {
  auto same = [](const Bytes& a, BytesView b) {
    return a.size() == b.size() && std::equal(a.begin(), a.end(), b.begin());
  };
  auto split_sizes = [&](const std::vector<std::int64_t>& sizes) {
    if (sizes.size() != els.size()) fail(ErrorCode::Input, "piece count does not match the elements");
    std::vector<Bytes> pieces = split_by_sizes(data, sizes);
    std::vector<E> out;
    out.reserve(els.size());
    for (std::size_t i = 0; i < els.size(); i++) {
      const Bytes& orig = piece_of(els[i]);
      if (same(orig, pieces[i]))
        out.push_back(els[i]);
      else
        out.push_back(with_piece(els[i], std::move(pieces[i]), false));
    }
    return out;
  };
  if (has_size_field) {
    std::vector<std::int64_t> sizes;
    for (const auto& e : els) {
      std::optional<std::int64_t> s = given_size(e);
      if (!s) break;
      sizes.push_back(*s);
    }
    bool all = sizes.size() == els.size();
    // With no elements, a fit policy creates them.
    if (all && (!els.empty() || !fit)) return split_sizes(sizes);
    if (!fit) fail(ErrorCode::Input, "split policy \"sizes\" needs every piece's size in the input");
  }
  if (!fit) fail(ErrorCode::Input, "cannot split the stream: give every piece's size in the input");
  std::vector<E> out;
  std::size_t pos = 0;
  for (std::int64_t k = 0; pos < data.size(); k++) {
    E base = static_cast<std::size_t>(k) < els.size() ? els[static_cast<std::size_t>(k)] : E{};
    std::int64_t cap = fit->offset(k + 1) - fit->offset(k);
    std::size_t left = data.size() - pos;
    auto fits = [&](std::size_t n) {
      E probe = with_piece(base, Bytes(data.begin() + static_cast<std::ptrdiff_t>(pos),
                                       data.begin() + static_cast<std::ptrdiff_t>(pos + n)),
                           true);
      try {
        return fit->size(probe) <= cap;
      } catch (const Error& e) {
        if (e.code == ErrorCode::Range) return false;
        throw;
      }
    };
    std::size_t n;
    if (fits(left))
      n = left;
    else {
      std::size_t lo = 0, hi = left;
      while (hi - lo > 1) {
        std::size_t mid = lo + (hi - lo) / 2;
        if (fits(mid))
          lo = mid;
        else
          hi = mid;
      }
      n = lo;
    }
    if (n == 0)
      fail(ErrorCode::Overlap, "stream piece " + std::to_string(k) + " does not fit its block of " +
                                   std::to_string(cap) + " bytes");
    BytesView piece = data.subspan(pos, n);
    out.push_back(with_piece(base, Bytes(piece.begin(), piece.end()), true));
    pos += n;
  }
  return out;
}

/// Joins pieces into one stream.
template <class C, class F>
Bytes join_pieces(const C& elements, F&& piece_of) {
  Bytes out;
  std::size_t n = 0;
  for (const auto& e : obj(elements)) n += piece_of(e).size();
  out.reserve(n);
  for (const auto& e : obj(elements)) {
    const Bytes& p = piece_of(e);
    out.insert(out.end(), p.begin(), p.end());
  }
  return out;
}

}  // namespace yaffle
