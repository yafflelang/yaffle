// JSON value: parser, printer, canonical conversions.
#include <charconv>

#include "yaffle/yaffle.hpp"

namespace yaffle {

const Json* Json::find(std::string_view key) const {
  if (kind_ != Kind::Object) return nullptr;
  for (const auto& m : o_)
    if (m.first == key) return &m.second;
  return nullptr;
}

void Json::set(std::string key, Json value) {
  if (kind_ != Kind::Object) {
    *this = Json(Object{});
  }
  for (auto& m : o_)
    if (m.first == key) {
      m.second = std::move(value);
      return;
    }
  o_.emplace_back(std::move(key), std::move(value));
}

bool Json::operator==(const Json& o) const {
  if (kind_ != o.kind_) return false;
  switch (kind_) {
    case Kind::Null: return true;
    case Kind::Bool: return b_ == o.b_;
    case Kind::Number: return n_ == o.n_;
    case Kind::String: return s_ == o.s_;
    case Kind::Array: return a_ == o.a_;
    case Kind::Object:
      if (o_.size() != o.o_.size()) return false;
      for (std::size_t i = 0; i < o_.size(); i++)
        if (o_[i].first != o.o_[i].first || !(o_[i].second == o.o_[i].second)) return false;
      return true;
  }
  return false;
}

static void dump_string(std::string& out, const std::string& s) {
  out += '"';
  const auto* p = reinterpret_cast<const unsigned char*>(s.data());
  std::size_t n = s.size();
  for (std::size_t i = 0; i < n; i++) {
    unsigned char c = p[i];
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      default:
        if (c < 0x20) {
          char buf[32];
          std::snprintf(buf, sizeof buf, "\\u%04x", c);
          out += buf;
        } else if (c == 0xed && i + 2 < n && p[i + 1] >= 0xa0) {
          // WTF-8 surrogate: escape it so JSON readers see the lone surrogate.
          unsigned cp = ((c & 0x0fu) << 12) | ((p[i + 1] & 0x3fu) << 6) | (p[i + 2] & 0x3fu);
          char buf[32];
          std::snprintf(buf, sizeof buf, "\\u%04x", cp);
          out += buf;
          i += 2;
        } else {
          out += static_cast<char>(c);
        }
    }
  }
  out += '"';
}

static void dump_number(std::string& out, double n) {
  if (!std::isfinite(n)) {
    out += "null";
    return;
  }
  if (n == std::trunc(n) && std::fabs(n) < 1e17) {
    char buf[32];
    auto r = std::to_chars(buf, buf + sizeof buf, static_cast<long long>(n));
    out.append(buf, r.ptr);
    return;
  }
  char buf[64];
  auto r = std::to_chars(buf, buf + sizeof buf, n);
  out.append(buf, r.ptr);
}

void Json::dump_to(std::string& out) const {
  switch (kind_) {
    case Kind::Null: out += "null"; return;
    case Kind::Bool: out += b_ ? "true" : "false"; return;
    case Kind::Number: dump_number(out, n_); return;
    case Kind::String: dump_string(out, s_); return;
    case Kind::Array: {
      out += '[';
      bool first = true;
      for (const auto& e : a_) {
        if (!first) out += ',';
        first = false;
        e.dump_to(out);
      }
      out += ']';
      return;
    }
    case Kind::Object: {
      out += '{';
      bool first = true;
      for (const auto& m : o_) {
        if (!first) out += ',';
        first = false;
        dump_string(out, m.first);
        out += ':';
        m.second.dump_to(out);
      }
      out += '}';
      return;
    }
  }
}

std::string Json::dump() const {
  std::string s;
  dump_to(s);
  return s;
}

namespace {
struct Parser {
  std::string_view t;
  std::size_t i = 0;
  int depth = 0;

  [[noreturn]] void bad(const char* what) {
    fail(ErrorCode::Input, std::string("invalid JSON: ") + what + " at " + std::to_string(i));
  }
  void ws() {
    while (i < t.size() && (t[i] == ' ' || t[i] == '\t' || t[i] == '\n' || t[i] == '\r')) i++;
  }
  bool lit(const char* s) {
    std::size_t n = std::strlen(s);
    if (t.substr(i, n) == s) {
      i += n;
      return true;
    }
    return false;
  }
  unsigned hex4() {
    if (i + 4 > t.size()) bad("short \\u escape");
    unsigned v = 0;
    for (int k = 0; k < 4; k++) {
      char c = t[i++];
      v <<= 4;
      if (c >= '0' && c <= '9')
        v |= static_cast<unsigned>(c - '0');
      else if (c >= 'a' && c <= 'f')
        v |= static_cast<unsigned>(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F')
        v |= static_cast<unsigned>(c - 'A' + 10);
      else
        bad("bad \\u escape");
    }
    return v;
  }
  std::string str() {
    if (t[i] != '"') bad("expected a string");
    i++;
    std::string s;
    for (;;) {
      if (i >= t.size()) bad("unterminated string");
      char c = t[i++];
      if (c == '"') break;
      if (c != '\\') {
        s += c;
        continue;
      }
      if (i >= t.size()) bad("unterminated escape");
      char e = t[i++];
      switch (e) {
        case '"': s += '"'; break;
        case '\\': s += '\\'; break;
        case '/': s += '/'; break;
        case 'b': s += '\b'; break;
        case 'f': s += '\f'; break;
        case 'n': s += '\n'; break;
        case 'r': s += '\r'; break;
        case 't': s += '\t'; break;
        case 'u': {
          unsigned cp = hex4();
          if (cp >= 0xd800 && cp <= 0xdbff && i + 6 <= t.size() && t[i] == '\\' && t[i + 1] == 'u') {
            std::size_t save = i;
            i += 2;
            unsigned lo = hex4();
            if (lo >= 0xdc00 && lo <= 0xdfff)
              cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
            else
              i = save;
          }
          append_utf8(s, cp);
          break;
        }
        default: bad("bad escape");
      }
    }
    return s;
  }
  Json value() {
    ws();
    if (i >= t.size()) bad("unexpected end");
    if (++depth > 10000) bad("too deeply nested");
    Json out;
    char c = t[i];
    if (c == '{') {
      i++;
      Json::Object o;
      ws();
      if (i < t.size() && t[i] == '}') {
        i++;
      } else {
        for (;;) {
          ws();
          std::string k = str();
          ws();
          if (i >= t.size() || t[i] != ':') bad("expected ':'");
          i++;
          Json v = value();
          o.emplace_back(std::move(k), std::move(v));
          ws();
          if (i < t.size() && t[i] == ',') {
            i++;
            continue;
          }
          if (i < t.size() && t[i] == '}') {
            i++;
            break;
          }
          bad("expected ',' or '}'");
        }
      }
      out = Json(std::move(o));
    } else if (c == '[') {
      i++;
      Json::Array a;
      ws();
      if (i < t.size() && t[i] == ']') {
        i++;
      } else {
        for (;;) {
          a.push_back(value());
          ws();
          if (i < t.size() && t[i] == ',') {
            i++;
            continue;
          }
          if (i < t.size() && t[i] == ']') {
            i++;
            break;
          }
          bad("expected ',' or ']'");
        }
      }
      out = Json(std::move(a));
    } else if (c == '"') {
      out = Json(str());
    } else if (lit("true")) {
      out = Json(true);
    } else if (lit("false")) {
      out = Json(false);
    } else if (lit("null")) {
      out = Json();
    } else {
      std::size_t start = i;
      if (t[i] == '-') i++;
      while (i < t.size() && ((t[i] >= '0' && t[i] <= '9') || t[i] == '.' || t[i] == 'e' ||
                              t[i] == 'E' || t[i] == '+' || t[i] == '-'))
        i++;
      if (start == i) bad("unexpected character");
      double d = 0;
      auto r = std::from_chars(t.data() + start, t.data() + i, d);
      if (r.ec == std::errc::result_out_of_range) {
        d = (t[start] == '-' ? -1 : 1) * std::numeric_limits<double>::infinity();
      } else if (r.ec != std::errc() || r.ptr != t.data() + i) {
        bad("bad number");
      }
      out = Json(d);
    }
    depth--;
    return out;
  }
};
}  // namespace

Json Json::parse(std::string_view text) {
  Parser p{text};
  Json v = p.value();
  p.ws();
  if (p.i != text.size()) p.bad("trailing characters");
  return v;
}

std::string describe(const Json& j) {
  switch (j.kind()) {
    case Json::Kind::Null: return "null";
    case Json::Kind::Bool: return j.as_bool() ? "true" : "false";
    case Json::Kind::Number: return Json(j.as_number()).dump();
    case Json::Kind::String: {
      std::string s = j.as_string();
      if (s.size() > 40) s = s.substr(0, 40) + "…";
      return Json(s).dump();
    }
    case Json::Kind::Array: return "array(" + std::to_string(j.as_array().size()) + ")";
    case Json::Kind::Object: return "object";
  }
  return "?";
}

// ── canonical conversions ───────────────────────────────────────────────────────

std::string to_hex(BytesView b) {
  static const char* digits = "0123456789abcdef";
  std::string s;
  s.resize(b.size() * 2);
  for (std::size_t i = 0; i < b.size(); i++) {
    s[2 * i] = digits[b[i] >> 4];
    s[2 * i + 1] = digits[b[i] & 15];
  }
  return s;
}

static int hexval(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

Bytes from_hex(std::string_view s) {
  Bytes out;
  out.reserve(s.size() / 2);
  int hi = -1;
  for (char c : s) {
    if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '_') continue;
    int v = hexval(c);
    if (v < 0) fail(ErrorCode::Input, "invalid hex string");
    if (hi < 0)
      hi = v;
    else {
      out.push_back(static_cast<std::uint8_t>((hi << 4) | v));
      hi = -1;
    }
  }
  if (hi >= 0) fail(ErrorCode::Input, "invalid hex string (odd length)");
  return out;
}

std::string ptr(const std::string& path, std::string_view seg) {
  std::string s = path;
  s += '/';
  for (char c : seg) {
    if (c == '~')
      s += "~0";
    else if (c == '/')
      s += "~1";
    else
      s += c;
  }
  return s;
}

std::string ptr(const std::string& path, std::int64_t index) {
  return path + "/" + std::to_string(index);
}

Json float_to_json(double x) {
  if (std::isnan(x)) return Json("NaN");
  if (std::isinf(x)) return Json(x > 0 ? "Infinity" : "-Infinity");
  if (x == 0 && std::signbit(x)) return Json("-0");
  return Json(x);
}

double float_from_json(const Json& j) {
  if (j.is_number()) return j.as_number();
  if (j.is_string()) {
    const std::string& s = j.as_string();
    if (s == "NaN") return std::numeric_limits<double>::quiet_NaN();
    if (s == "Infinity") return std::numeric_limits<double>::infinity();
    if (s == "-Infinity") return -std::numeric_limits<double>::infinity();
    if (s == "-0") return -0.0;
  }
  fail(ErrorCode::Input, "expected a number, got " + describe(j));
}

i128 int_from_json(const Json& j) {
  if (j.is_number()) {
    double d = j.as_number();
    if (std::isfinite(d) && d == std::trunc(d)) {
      if (std::fabs(d) >= 1.7e38) fail(ErrorCode::Range, "integer out of range");
      return static_cast<i128>(d);
    }
    fail(std::isfinite(d) ? ErrorCode::Range : ErrorCode::Input, describe(j) + " is not an integer");
  }
  fail(ErrorCode::Input, "expected an integer, got " + describe(j));
}

i128 big_from_json(const Json& j) {
  if (j.is_string()) {
    if (auto v = parse_i128(j.as_string())) return *v;
  }
  fail(ErrorCode::Input, "expected a decimal integer string, got " + describe(j));
}

bool bool_from_json(const Json& j) {
  if (j.is_bool()) return j.as_bool();
  fail(ErrorCode::Input, "expected a boolean, got " + describe(j));
}

const std::string& string_from_json(const Json& j) {
  if (j.is_string()) return j.as_string();
  fail(ErrorCode::Input, "expected a string, got " + describe(j));
}

Bytes bytes_from_json(const Json& j) {
  if (j.is_string()) return from_hex(j.as_string());
  fail(ErrorCode::Input, "expected a hex string, got " + describe(j));
}

const Json::Array& array_from_json(const Json& j) {
  if (j.is_array()) return j.as_array();
  fail(ErrorCode::Input, "expected an array, got " + describe(j));
}

const Json& object_from_json(const Json& j) {
  if (j.is_object()) return j;
  fail(ErrorCode::Input, "expected an object, got " + describe(j));
}

std::optional<Json> ToJsonCtx::ref(const void* p, const std::string& path) {
  if (!p) return std::nullopt;
  auto it = seen_.find(p);
  if (it != seen_.end()) {
    Json r = Json::object();
    r.set("$ref", Json(it->second));
    return r;
  }
  seen_.emplace(p, path);
  return std::nullopt;
}

const std::string* FromJsonCtx::ref_path(const Json& j) {
  if (!j.is_object()) return nullptr;
  const auto& o = j.as_object();
  if (o.size() != 1 || o[0].first != "$ref" || !o[0].second.is_string()) return nullptr;
  return &o[0].second.as_string();
}

void FromJsonCtx::enter(const std::string& path, std::shared_ptr<void> v) {
  by_path_[path] = Entry{std::move(v), true};
}

void FromJsonCtx::leave(const std::string& path) {
  auto it = by_path_.find(path);
  if (it != by_path_.end()) it->second.in_progress = false;
}

}  // namespace yaffle
