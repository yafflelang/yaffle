// Derived arrays: `map`, `filter`, `indicesWhere`, `sortedBy`, `unique` and `concat` in write
// formulas and checks, value equality of composite values (docs/IR.md §6), and conversions of
// derived arrays to the field types they are written to.
//
// Struct values compare by canonical JSON: generated code defines `yaffle_struct_equal(a, b)` for
// every struct (found by argument-dependent lookup).
#pragma once

#include "core.hpp"
#include "helpers.hpp"

namespace yaffle {

namespace detail {
template <class T>
struct is_vector : std::false_type {};
template <class T, class A>
struct is_vector<std::vector<T, A>> : std::true_type {};
template <class T>
struct is_shared : std::false_type {};
template <class T>
struct is_shared<std::shared_ptr<T>> : std::true_type {};
template <class T>
struct is_optional : std::false_type {};
template <class T>
struct is_optional<std::optional<T>> : std::true_type {};
template <class T>
struct is_variant : std::false_type {};
template <class... T>
struct is_variant<std::variant<T...>> : std::true_type {};

template <class T>
inline constexpr bool is_number_v =
    (std::is_arithmetic_v<T> && !std::is_same_v<T, bool>) || std::is_same_v<T, i128> || std::is_same_v<T, u128>;
}  // namespace detail

/// Value equality (`==` on composite values): numbers by value (whatever their C++ types),
/// strings, bytes and arrays element-wise (bytes equal arrays of the same numbers), pointers and
/// optionals by their values, structs by canonical JSON.
template <class A, class B>
bool equals(const A& a, const B& b) {
  if constexpr (detail::is_shared<A>::value) {
    if (!a) {
      if constexpr (detail::is_shared<B>::value) return !b;
      return false;
    }
    return equals(*a, b);
  } else if constexpr (detail::is_shared<B>::value) {
    if (!b) return false;
    return equals(a, *b);
  } else if constexpr (detail::is_optional<A>::value) {
    if (!a) {
      if constexpr (detail::is_optional<B>::value) return !b;
      return false;
    }
    return equals(*a, b);
  } else if constexpr (detail::is_optional<B>::value) {
    if (!b) return false;
    return equals(a, *b);
  } else if constexpr (detail::is_number_v<A> && detail::is_number_v<B>) {
    if constexpr (std::is_floating_point_v<A> || std::is_floating_point_v<B>)
      return static_cast<double>(a) == static_cast<double>(b);
    else
      return static_cast<i128>(a) == static_cast<i128>(b);
  } else if constexpr (std::is_enum_v<A> && std::is_enum_v<B>) {
    return static_cast<i128>(a) == static_cast<i128>(b);
  } else if constexpr (std::is_enum_v<A> && detail::is_number_v<B>) {
    return static_cast<i128>(a) == static_cast<i128>(b);
  } else if constexpr (detail::is_number_v<A> && std::is_enum_v<B>) {
    return static_cast<i128>(a) == static_cast<i128>(b);
  } else if constexpr (std::is_same_v<A, bool> && std::is_same_v<B, bool>) {
    return a == b;
  } else if constexpr (std::is_convertible_v<const A&, std::string_view> &&
                       std::is_convertible_v<const B&, std::string_view>) {
    return std::string_view(a) == std::string_view(b);
  } else if constexpr (detail::is_vector<A>::value && detail::is_vector<B>::value) {
    if (a.size() != b.size()) return false;
    for (std::size_t i = 0; i < a.size(); i++)
      if (!equals(a[i], b[i])) return false;
    return true;
  } else if constexpr (detail::is_variant<A>::value && std::is_same_v<A, B>) {
    if (a.index() != b.index()) return false;
    return std::visit(
        [&](const auto& x) {
          using X = std::decay_t<decltype(x)>;
          return equals(x, std::get<X>(b));
        },
        a);
  } else if constexpr (std::is_same_v<A, B> && std::is_class_v<A>) {
    return yaffle_struct_equal(a, b);
  } else {
    static_assert(sizeof(A) == 0, "values of these types cannot be compared");
    return false;
  }
}

/// Order of `sortedBy` keys: numbers numerically, strings by code point (UTF-8 bytes compare in
/// code point order), bytes lexicographically, bools false < true.
template <class A, class B>
int compare_keys(const A& a, const B& b) {
  if constexpr (detail::is_shared<A>::value || detail::is_optional<A>::value) {
    return compare_keys(obj(a), b);
  } else if constexpr (detail::is_shared<B>::value || detail::is_optional<B>::value) {
    return compare_keys(a, obj(b));
  } else if constexpr ((detail::is_number_v<A> || std::is_enum_v<A>) && (detail::is_number_v<B> || std::is_enum_v<B>)) {
    if constexpr (std::is_floating_point_v<A> || std::is_floating_point_v<B>) {
      double x = static_cast<double>(a), y = static_cast<double>(b);
      return x < y ? -1 : x > y ? 1 : 0;
    } else {
      i128 x = static_cast<i128>(a), y = static_cast<i128>(b);
      return x < y ? -1 : x > y ? 1 : 0;
    }
  } else if constexpr (std::is_same_v<A, bool> && std::is_same_v<B, bool>) {
    return static_cast<int>(a) - static_cast<int>(b);
  } else if constexpr (std::is_convertible_v<const A&, std::string_view> &&
                       std::is_convertible_v<const B&, std::string_view>) {
    int c = std::string_view(a).compare(std::string_view(b));
    return c < 0 ? -1 : c > 0 ? 1 : 0;
  } else if constexpr (detail::is_vector<A>::value && detail::is_vector<B>::value) {
    std::size_t n = std::min(a.size(), b.size());
    for (std::size_t i = 0; i < n; i++) {
      int c = compare_keys(a[i], b[i]);
      if (c) return c;
    }
    return a.size() < b.size() ? -1 : a.size() > b.size() ? 1 : 0;
  } else {
    static_assert(sizeof(A) == 0, "values of these types cannot be sort keys");
    return 0;
  }
}

/// The element type of an array value (vectors, shared arrays, optional arrays).
template <class C>
using elem_t = std::decay_t<decltype(*std::begin(obj(std::declval<const C&>())))>;

/// `map(arr, x => expr)`.
template <class R, class C, class F>
std::vector<R> map_arr(const C& c, F&& f) {
  const auto& a = obj(c);
  std::vector<R> out;
  out.reserve(a.size());
  for (const auto& x : a) out.push_back(f(x));
  return out;
}

/// `filter(arr, x => bool)`.
template <class C, class F>
std::vector<elem_t<C>> filter_arr(const C& c, F&& f) {
  std::vector<elem_t<C>> out;
  for (const auto& x : obj(c))
    if (f(x)) out.push_back(x);
  return out;
}

/// `indicesWhere(arr, x => bool)`: the indices of the matching elements.
template <class C, class F>
std::vector<std::int64_t> indices_where(const C& c, F&& f) {
  std::vector<std::int64_t> out;
  std::int64_t i = 0;
  for (const auto& x : obj(c)) {
    if (f(x)) out.push_back(i);
    i++;
  }
  return out;
}

/// `sortedBy(arr, x => key)`: a stable sort by key.
template <class C, class F>
std::vector<elem_t<C>> sorted_by(const C& c, F&& key) {
  const auto& a = obj(c);
  using K = std::decay_t<decltype(key(*std::begin(a)))>;
  std::vector<std::pair<K, std::size_t>> keyed;
  keyed.reserve(a.size());
  std::size_t i = 0;
  for (const auto& x : a) keyed.emplace_back(key(x), i++);
  std::stable_sort(keyed.begin(), keyed.end(),
                   [](const auto& x, const auto& y) { return compare_keys(x.first, y.first) < 0; });
  std::vector<elem_t<C>> out;
  out.reserve(a.size());
  for (const auto& k : keyed) out.push_back(a[k.second]);
  return out;
}

/// `unique(arr)`: without later duplicates (value equality; the first occurrence is kept).
template <class C>
std::vector<elem_t<C>> unique_arr(const C& c) {
  std::vector<elem_t<C>> out;
  for (const auto& x : obj(c)) {
    bool seen = false;
    for (const auto& y : out)
      if (equals(x, y)) {
        seen = true;
        break;
      }
    if (!seen) out.push_back(x);
  }
  return out;
}

/// `concat(a, b, …)`.
template <class C, class... Cs>
std::vector<elem_t<C>> concat_arr(const C& first, const Cs&... rest) {
  std::vector<elem_t<C>> out;
  auto add = [&](const auto& c) {
    for (const auto& x : obj(c)) out.push_back(static_cast<elem_t<C>>(x));
  };
  add(first);
  (add(rest), ...);
  return out;
}

/// `isNull(x)`: a null pointer value.
template <class T>
bool is_null(const std::shared_ptr<T>& p) {
  return p == nullptr;
}
template <class T>
bool is_null(const std::optional<T>& o) {
  return !o.has_value();
}
template <class T>
bool is_null(const T&) {
  return false;
}

/// A derived array of numbers written to a `u8[]` field (RANGE if an element is not a byte).
template <class C>
Bytes array_to_bytes(const C& c) {
  if constexpr (std::is_same_v<std::decay_t<C>, Bytes>) {
    return c;
  } else {
    Bytes out;
    std::size_t i = 0;
    for (const auto& x : obj(c)) {
      i128 v = static_cast<i128>(x);
      if (v < 0 || v > 255) fail(ErrorCode::Range, to_string(v) + " is not a byte (element " + std::to_string(i) + ")");
      out.push_back(static_cast<std::uint8_t>(v));
      i++;
    }
    return out;
  }
}

/// A derived array converted to an array of integers of type `T` (range checked).
template <class T, class C>
std::vector<T> array_to_ints(const C& c) {
  std::vector<T> out;
  for (const auto& x : obj(c)) out.push_back(to<T>(static_cast<i128>(x), "element"));
  return out;
}

}  // namespace yaffle
