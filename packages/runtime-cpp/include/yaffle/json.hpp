// A small JSON value type (no dependencies) and the canonical-JSON helpers of
// docs/CONFORMANCE.md §3: bytes as lowercase hex, 56/64-bit integers as decimal strings,
// non-finite floats and -0 as strings, shared targets as JSON-Pointer `$ref`s.
#pragma once

#include "core.hpp"

namespace yaffle {

class Json {
 public:
  enum class Kind : std::uint8_t { Null, Bool, Number, String, Array, Object };
  using Array = std::vector<Json>;
  using Member = std::pair<std::string, Json>;
  using Object = std::vector<Member>;

  Json() = default;
  Json(std::nullptr_t) {}
  Json(bool b) : kind_(Kind::Bool), b_(b) {}
  Json(double n) : kind_(Kind::Number), n_(n) {}
  Json(int n) : kind_(Kind::Number), n_(n) {}
  Json(std::int64_t n) : kind_(Kind::Number), n_(static_cast<double>(n)) {}
  Json(std::uint64_t n) : kind_(Kind::Number), n_(static_cast<double>(n)) {}
  Json(std::string s) : kind_(Kind::String), s_(std::move(s)) {}
  Json(const char* s) : kind_(Kind::String), s_(s) {}
  Json(Array a) : kind_(Kind::Array), a_(std::move(a)) {}
  Json(Object o) : kind_(Kind::Object), o_(std::move(o)) {}

  static Json array() { return Json(Array{}); }
  static Json object() { return Json(Object{}); }

  Kind kind() const { return kind_; }
  bool is_null() const { return kind_ == Kind::Null; }
  bool is_bool() const { return kind_ == Kind::Bool; }
  bool is_number() const { return kind_ == Kind::Number; }
  bool is_string() const { return kind_ == Kind::String; }
  bool is_array() const { return kind_ == Kind::Array; }
  bool is_object() const { return kind_ == Kind::Object; }

  bool as_bool() const { return b_; }
  double as_number() const { return n_; }
  const std::string& as_string() const { return s_; }
  std::string& as_string() { return s_; }
  const Array& as_array() const { return a_; }
  Array& as_array() { return a_; }
  const Object& as_object() const { return o_; }
  Object& as_object() { return o_; }

  /// Object member lookup (nullptr when absent or not an object).
  const Json* find(std::string_view key) const;
  /// Appends (or replaces) an object member.
  void set(std::string key, Json value);
  /// Appends an array element.
  void push(Json value) { a_.push_back(std::move(value)); }

  std::string dump() const;
  void dump_to(std::string& out) const;
  /// Parses JSON text (throws yaffle::Error INPUT on malformed text).
  static Json parse(std::string_view text);

  bool operator==(const Json& o) const;

 private:
  Kind kind_ = Kind::Null;
  bool b_ = false;
  double n_ = 0;
  std::string s_;
  Array a_;
  Object o_;
};

/// A short description of a JSON value for error messages.
std::string describe(const Json& j);

// ── canonical conversions ───────────────────────────────────────────────────────

std::string to_hex(BytesView b);
Bytes from_hex(std::string_view s);

/// Appends an RFC 6901 reference token.
std::string ptr(const std::string& path, std::string_view seg);
std::string ptr(const std::string& path, std::int64_t index);

Json float_to_json(double x);
double float_from_json(const Json& j);
/// Integers up to 48 bits (JSON numbers): a non-integer is RANGE, other types INPUT.
i128 int_from_json(const Json& j);
/// 56/64-bit integers (decimal strings).
i128 big_from_json(const Json& j);
bool bool_from_json(const Json& j);
const std::string& string_from_json(const Json& j);
Bytes bytes_from_json(const Json& j);
const Json::Array& array_from_json(const Json& j);
const Json& object_from_json(const Json& j);

/// Integer JSON for a value of the given bit width: numbers up to 48 bits, strings above.
template <class T>
inline Json int_json(T v, int bits) {
  if (bits > 48) return Json(to_string(static_cast<i128>(v)));
  return Json(static_cast<double>(v));
}
template <class T>
inline T int_from_json_as(const Json& j, int bits, bool is_signed, const char* what = nullptr) {
  i128 v = bits > 48 ? big_from_json(j) : int_from_json(j);
  i128 lo = is_signed ? -(static_cast<i128>(1) << (bits - 1)) : 0;
  i128 hi = is_signed ? (static_cast<i128>(1) << (bits - 1)) - 1 : (static_cast<i128>(1) << bits) - 1;
  if (v < lo || v > hi) range_fail(v, what ? what : "value");
  return static_cast<T>(v);
}

/// `toJson` state: where each shared object was first written, for `$ref`s.
class ToJsonCtx {
 public:
  /// The `$ref` object if `p` was already written; otherwise records `path` and returns nullopt.
  std::optional<Json> ref(const void* p, const std::string& path);

 private:
  std::unordered_map<const void*, std::string> seen_;
};

/// `fromJson` state: values by JSON pointer, to restore identity from `$ref`s.
class FromJsonCtx {
 public:
  /// The `$ref` target path if `j` is `{ "$ref": "…" }`.
  static const std::string* ref_path(const Json& j);
  /// Registers a shared value under its path; `in_progress` while its contents are converted.
  void enter(const std::string& path, std::shared_ptr<void> v);
  void leave(const std::string& path);
  /// The value a `$ref` points at (INPUT if dangling); a value still in progress (a cycle) comes
  /// back non-owning.
  template <class T>
  std::shared_ptr<T> deref(const std::string& target) {
    auto it = by_path_.find(target);
    if (it == by_path_.end())
      fail(ErrorCode::Input, "$ref " + target + " does not point at an earlier value");
    auto p = std::static_pointer_cast<T>(it->second.value);
    return it->second.in_progress ? non_owning(p) : p;
  }

 private:
  struct Entry {
    std::shared_ptr<void> value;
    bool in_progress = false;
  };
  std::unordered_map<std::string, Entry> by_path_;
};

}  // namespace yaffle
