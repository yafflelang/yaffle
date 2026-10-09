// yaffle C++ runtime: core types, errors and exact integer semantics (docs/IR.md §6).
//
// Errors are C++ exceptions of type yaffle::Error carrying a code (docs/CONFORMANCE.md §4), the
// path from the root (field names and array indices) and an absolute byte offset (-1 on write).
#pragma once

#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <exception>
#include <functional>
#include <initializer_list>
#include <limits>
#include <map>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <type_traits>
#include <unordered_map>
#include <utility>
#include <variant>
#include <vector>

namespace yaffle {

/// Exact intermediate integer arithmetic (IR.md §6) uses 128-bit integers.
__extension__ typedef __int128 i128;
__extension__ typedef unsigned __int128 u128;

/// Byte strings: `u8` arrays, codec input/output, serialized files.
using Bytes = std::vector<std::uint8_t>;
using BytesView = std::span<const std::uint8_t>;

enum class Endian : std::uint8_t { le, be };

// ── errors ─────────────────────────────────────────────────────────────────────

enum class ErrorCode : std::uint8_t { Eof, Check, Range, Union, Codec, Input, Derive, Ref, Overlap };

/// "EOF", "CHECK", …: the code as spelled in docs/CONFORMANCE.md.
const char* code_name(ErrorCode c) noexcept;

/// One segment of an error path: a field name, or an array index (when `name` is empty).
struct PathSeg {
  std::string name;
  std::int64_t index = -1;
  bool is_index() const noexcept { return name.empty(); }
};

/// Field name and array indices of the member a generated reader or writer is working on.
/// Error paths are built from these while an exception unwinds.
struct Frame {
  static constexpr int kMaxDepth = 16;
  const char* field = "";
  std::array<std::int64_t, kMaxDepth> idx;
  Frame() { idx.fill(-1); }
};

class Error : public std::exception {
 public:
  ErrorCode code;
  /// The message without path and offset decoration.
  std::string detail;
  /// Absolute byte offset for read errors, -1 for write errors.
  std::int64_t offset;
  /// Field names and array indices from the root, filled in while the error propagates.
  std::vector<PathSeg> path;
  /// For UNION errors: the error of every variant, in order.
  std::vector<Error> causes;
  /// The path is complete (errors raised after layout know their full path).
  bool sealed = false;

  Error(ErrorCode c, std::string d, std::int64_t off = -1)
      : code(c), detail(std::move(d)), offset(off) {}

  /// `CODE at a.b[3] (offset 0x10): detail`.
  std::string describe() const;
  const char* what() const noexcept override;

  /// Prepends a field name (skipped when empty) and array indices (skipped when negative).
  Error& prefix(std::string_view field, std::initializer_list<std::int64_t> indices = {});
  /// Prepends the frame's field and indices.
  Error& prefix(const Frame& f);
  /// Prepends a complete path and seals the error.
  Error& seal_with(const std::vector<PathSeg>& outer);

 private:
  mutable std::string what_;
};

[[noreturn]] void fail(ErrorCode code, std::string detail, std::int64_t offset = -1);
std::string format_path(const std::vector<PathSeg>& path);
/// An INPUT error for a missing required field, with the field as its path.
[[noreturn]] void missing(const char* field);

// ── integers ───────────────────────────────────────────────────────────────────

std::string to_string(i128 v);
std::string to_string(u128 v);
/// `0x1f` (`-0x1f` for negative values): offsets and bytes in error messages.
std::string hex(std::int64_t v);
/// Parses a decimal integer (optional leading '-'); nullopt if malformed or beyond 128 bits.
std::optional<i128> parse_i128(std::string_view s);

inline constexpr i128 kI128Max = static_cast<i128>(~static_cast<u128>(0) >> 1);
inline constexpr i128 kI128Min = -kI128Max - 1;

[[noreturn]] void range_fail(i128 v, const char* what);

/// Converts to a destination integer type, failing with RANGE when out of range.
template <class T>
inline T to(i128 v, const char* what = "value") {
  static_assert(std::is_integral_v<T>);
  if (v < static_cast<i128>(std::numeric_limits<T>::min()) ||
      v > static_cast<i128>(std::numeric_limits<T>::max()))
    range_fail(v, what);
  return static_cast<T>(v);
}

/// A value for an N-bit integer (u24, i40, …) stored in a wider C++ type.
template <class T>
inline T to_bits(i128 v, int bits, const char* what = "value") {
  i128 lo = std::is_signed_v<T> ? -(static_cast<i128>(1) << (bits - 1)) : 0;
  i128 hi = std::is_signed_v<T> ? (static_cast<i128>(1) << (bits - 1)) - 1
                                : (static_cast<i128>(1) << bits) - 1;
  if (v < lo || v > hi) range_fail(v, what);
  return static_cast<T>(v);
}

/// A length or count: non-negative and representable.
inline std::int64_t len(i128 v, const char* what = "length") {
  if (v < 0 || v > static_cast<i128>(std::numeric_limits<std::int64_t>::max())) range_fail(v, what);
  return static_cast<std::int64_t>(v);
}

/// An offset or position (may be negative before checks).
inline std::int64_t offset(i128 v, const char* what = "offset") {
  return to<std::int64_t>(v, what);
}

inline i128 div(i128 a, i128 b) {
  if (b == 0) fail(ErrorCode::Range, "division by zero");
  if (a == kI128Min && b == -1) fail(ErrorCode::Range, "integer overflow in division");
  return a / b;
}

inline i128 mod(i128 a, i128 b) {
  if (b == 0) fail(ErrorCode::Range, "division by zero");
  if (b == -1) return 0;
  return a % b;
}

inline int shift_count(i128 n) {
  if (n < 0 || n > 63) fail(ErrorCode::Range, "shift count " + to_string(n) + " is not in 0..63");
  return static_cast<int>(n);
}

inline i128 add(i128 a, i128 b) {
  i128 r;
  if (__builtin_add_overflow(a, b, &r)) fail(ErrorCode::Range, "integer overflow");
  return r;
}
inline i128 sub(i128 a, i128 b) {
  i128 r;
  if (__builtin_sub_overflow(a, b, &r)) fail(ErrorCode::Range, "integer overflow");
  return r;
}
inline i128 mul(i128 a, i128 b) {
  i128 r;
  if (__builtin_mul_overflow(a, b, &r)) fail(ErrorCode::Range, "integer overflow");
  return r;
}
inline i128 neg(i128 a) {
  if (a == kI128Min) fail(ErrorCode::Range, "integer overflow");
  return -a;
}
/// `a << n` = a · 2^n (exact).
inline i128 shl(i128 a, i128 n) {
  return mul(a, static_cast<i128>(1) << shift_count(n));
}
/// `a >> n`: arithmetic (floor division by 2^n).
inline i128 shr(i128 a, i128 n) { return a >> shift_count(n); }

/// Rounds half away from zero (float → integer).
inline i128 round_half_away(double x) {
  if (!std::isfinite(x) || std::fabs(x) >= 1.7e38)
    fail(ErrorCode::Range, "cannot round " + std::to_string(x) + " to an integer");
  return static_cast<i128>(std::round(x));  // std::round: half away from zero
}

/// Float → integer conversion (truncating), checked.
inline i128 trunc_to_int(double x) {
  if (!std::isfinite(x) || std::fabs(x) >= 1.7e38)
    fail(ErrorCode::Range, "cannot convert " + std::to_string(x) + " to an integer");
  return static_cast<i128>(std::trunc(x));
}

inline i128 abs_int(i128 x) { return x < 0 ? neg(x) : x; }

/// Checked dereference of an optional value (a conditional field that must be present).
template <class T>
inline const T& val(const std::optional<T>& o, const char* what = "value") {
  if (!o) fail(ErrorCode::Input, std::string("missing ") + what);
  return *o;
}
template <class T>
inline T& val(std::optional<T>& o, const char* what = "value") {
  if (!o) fail(ErrorCode::Input, std::string("missing ") + what);
  return *o;
}

/// A pointer to an object that is still being built (a cycle back to it): it does not own the
/// object, so cyclic graphs hold no reference-count cycles and are freed normally.
template <class T>
inline std::shared_ptr<T> non_owning(const std::shared_ptr<T>& p) {
  return std::shared_ptr<T>(std::shared_ptr<T>(), p.get());
}

/// The value itself, through a call the compiler's type-limits analysis can't see through.
/// Generated comparisons whose outcome static ranges decide use it, so -Wtype-limits stays quiet.
/// (The warning comes from the front end, before inlining, so an inline function is enough.)
inline std::int64_t opaque(std::int64_t v) noexcept { return v; }
inline i128 opaque(i128 v) noexcept { return v; }

/// Restores a variable when the scope ends (exception safe).
template <class T>
class Restore {
 public:
  explicit Restore(T& ref) : ref_(ref), saved_(ref) {}
  Restore(T& ref, T now) : ref_(ref), saved_(ref) { ref_ = std::move(now); }
  ~Restore() { ref_ = std::move(saved_); }
  Restore(const Restore&) = delete;
  Restore& operator=(const Restore&) = delete;

 private:
  T& ref_;
  T saved_;
};

}  // namespace yaffle
