// Errors, integer formatting, primitives, checksums, codec helpers, misc helpers.
#include <mutex>
#include <regex>

#include "yaffle/yaffle.hpp"

namespace yaffle {

// ── errors ─────────────────────────────────────────────────────────────────────

const char* code_name(ErrorCode c) noexcept {
  switch (c) {
    case ErrorCode::Eof: return "EOF";
    case ErrorCode::Check: return "CHECK";
    case ErrorCode::Range: return "RANGE";
    case ErrorCode::Union: return "UNION";
    case ErrorCode::Codec: return "CODEC";
    case ErrorCode::Input: return "INPUT";
    case ErrorCode::Derive: return "DERIVE";
    case ErrorCode::Ref: return "REF";
    case ErrorCode::Overlap: return "OVERLAP";
  }
  return "?";
}

std::string format_path(const std::vector<PathSeg>& path) {
  std::string s;
  for (const auto& seg : path) {
    if (seg.is_index()) {
      s += '[';
      s += std::to_string(seg.index);
      s += ']';
    } else {
      if (!s.empty()) s += '.';
      s += seg.name;
    }
  }
  return s;
}

std::string Error::describe() const {
  std::string s = code_name(code);
  if (!path.empty()) s += " at " + format_path(path);
  if (offset >= 0) s += " (offset " + hex(offset) + ")";
  s += ": ";
  s += detail;
  return s;
}

const char* Error::what() const noexcept {
  try {
    what_ = describe();
  } catch (...) {
    return detail.c_str();
  }
  return what_.c_str();
}

Error& Error::prefix(std::string_view field, std::initializer_list<std::int64_t> indices) {
  if (sealed) return *this;
  std::vector<PathSeg> segs;
  if (!field.empty()) segs.push_back(PathSeg{std::string(field), -1});
  for (std::int64_t i : indices)
    if (i >= 0) segs.push_back(PathSeg{"", i});
  path.insert(path.begin(), segs.begin(), segs.end());
  return *this;
}

Error& Error::prefix(const Frame& f) {
  if (sealed) return *this;
  std::vector<PathSeg> segs;
  if (f.field && *f.field) segs.push_back(PathSeg{f.field, -1});
  for (std::int64_t i : f.idx) {
    if (i < 0) break;
    segs.push_back(PathSeg{"", i});
  }
  path.insert(path.begin(), segs.begin(), segs.end());
  return *this;
}

Error& Error::seal_with(const std::vector<PathSeg>& outer) {
  if (sealed) return *this;
  path.insert(path.begin(), outer.begin(), outer.end());
  sealed = true;
  return *this;
}

void fail(ErrorCode code, std::string detail, std::int64_t offset) {
  throw Error(code, std::move(detail), offset);
}

void missing(const char* field) {
  Error e(ErrorCode::Input, std::string("missing required field ") + field);
  e.path.push_back(PathSeg{field, -1});
  throw e;
}

std::string to_string(u128 v) {
  if (v == 0) return "0";
  char buf[48];
  int i = 47;
  buf[i] = 0;
  while (v > 0) {
    buf[--i] = static_cast<char>('0' + static_cast<int>(v % 10));
    v /= 10;
  }
  return std::string(buf + i);
}

std::string to_string(i128 v) {
  if (v < 0) return "-" + to_string(static_cast<u128>(0) - static_cast<u128>(v));
  return to_string(static_cast<u128>(v));
}

std::string hex(std::int64_t v) {
  char buf[32];
  if (v < 0)
    std::snprintf(buf, sizeof buf, "-0x%llx", static_cast<unsigned long long>(-v));
  else
    std::snprintf(buf, sizeof buf, "0x%llx", static_cast<unsigned long long>(v));
  return buf;
}

std::optional<i128> parse_i128(std::string_view s) {
  bool neg = false;
  std::size_t i = 0;
  if (i < s.size() && s[i] == '-') {
    neg = true;
    i++;
  }
  if (i >= s.size()) return std::nullopt;
  u128 v = 0;
  const u128 limit = static_cast<u128>(kI128Max) + (neg ? 1 : 0);
  for (; i < s.size(); i++) {
    char c = s[i];
    if (c < '0' || c > '9') return std::nullopt;
    u128 d = static_cast<u128>(c - '0');
    if (v > (limit - d) / 10) return std::nullopt;
    v = v * 10 + d;
  }
  if (neg) return static_cast<i128>(static_cast<u128>(0) - v);
  return static_cast<i128>(v);
}

void range_fail(i128 v, const char* what) {
  fail(ErrorCode::Range, std::string(what) + " " + to_string(v) + " is out of range");
}

// ── primitives ─────────────────────────────────────────────────────────────────

const char* prim_name(Prim p) noexcept {
  static const char* const names[] = {"u8",  "u16", "u24", "u32", "u40", "u48", "u56",
                                      "u64", "i8",  "i16", "i24", "i32", "i40", "i48",
                                      "i56", "i64", "f16", "f32", "f64"};
  return names[static_cast<int>(p)];
}

float half_to_float(std::uint16_t h) {
  int sign = (h & 0x8000) ? -1 : 1;
  int exp = (h >> 10) & 0x1f;
  int frac = h & 0x3ff;
  if (exp == 0) return static_cast<float>(sign * std::ldexp(static_cast<double>(frac), -24));
  if (exp == 0x1f)
    return frac ? std::numeric_limits<float>::quiet_NaN()
                : (sign < 0 ? -std::numeric_limits<float>::infinity() : std::numeric_limits<float>::infinity());
  return static_cast<float>(sign * std::ldexp(1.0 + frac / 1024.0, exp - 15));
}

std::uint16_t float_to_half(double v) {
  if (std::isnan(v)) return 0x7e00;
  std::uint16_t sign = std::signbit(v) ? 0x8000 : 0;
  double a = std::fabs(v);
  if (a == 0) return sign;
  if (std::isinf(a)) return sign | 0x7c00;
  int ex;
  std::frexp(a, &ex);  // a = m · 2^ex, m in [0.5, 1)
  int e = ex - 1;      // a in [2^e, 2^(e+1))
  if (e < -14) {
    double q = std::nearbyint(std::ldexp(a, 24));  // subnormal: units of 2^-24 (ties to even)
    return static_cast<std::uint16_t>(sign | static_cast<std::uint16_t>(q));
  }
  double q = std::nearbyint(std::ldexp(a, 10 - e));  // 1024..2048
  if (q >= 2048) {
    q = 1024;
    e++;
  }
  if (e > 15) return sign | 0x7c00;
  return static_cast<std::uint16_t>(sign | ((e + 15) << 10) | (static_cast<int>(q) - 1024));
}

void store_prim(std::uint8_t* p, Prim k, i128 v, bool le) {
  PrimInfo i = prim_info(k);
  if (i.is_float) {
    store_prim_float(p, k, static_cast<double>(v), le);
    return;
  }
  store_uint(p, i.size, static_cast<std::uint64_t>(v), le);
}

void store_prim_float(std::uint8_t* p, Prim k, double v, bool le) {
  switch (k) {
    case Prim::f16: store_uint(p, 2, float_to_half(v), le); return;
    case Prim::f32: store_uint(p, 4, f32_to_bits(static_cast<float>(v)), le); return;
    case Prim::f64: store_uint(p, 8, f64_to_bits(v), le); return;
    default: store_uint(p, prim_info(k).size, static_cast<std::uint64_t>(trunc_to_int(v)), le);
  }
}

// ── checksums ──────────────────────────────────────────────────────────────────

static const std::array<std::uint32_t, 256>& crc_table() {
  static const std::array<std::uint32_t, 256> t = [] {
    std::array<std::uint32_t, 256> x{};
    for (std::uint32_t n = 0; n < 256; n++) {
      std::uint32_t c = n;
      for (int k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320u ^ (c >> 1) : c >> 1;
      x[n] = c;
    }
    return x;
  }();
  return t;
}

std::uint32_t crc32(BytesView data, std::uint32_t prev) {
  const auto& t = crc_table();
  std::uint32_t c = prev ^ 0xffffffffu;
  for (std::uint8_t b : data) c = t[(c ^ b) & 0xff] ^ (c >> 8);
  return c ^ 0xffffffffu;
}

std::uint32_t adler32(BytesView data, std::uint32_t prev) {
  std::uint32_t a = prev & 0xffff;
  std::uint32_t b = (prev >> 16) & 0xffff;
  const std::uint32_t MOD = 65521;
  std::size_t i = 0;
  while (i < data.size()) {
    std::size_t stop = std::min(data.size(), i + 3800);
    for (; i < stop; i++) {
      a += data[i];
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return (b << 16) | a;
}

// ── codecs ─────────────────────────────────────────────────────────────────────

i128 Arg::as_int() const {
  if (auto p = std::get_if<i128>(&v)) return *p;
  if (auto p = std::get_if<bool>(&v)) return *p ? 1 : 0;
  if (auto p = std::get_if<double>(&v)) return static_cast<i128>(*p);
  throw std::runtime_error("codec argument is not an integer");
}
double Arg::as_double() const {
  if (auto p = std::get_if<double>(&v)) return *p;
  if (auto p = std::get_if<i128>(&v)) return static_cast<double>(*p);
  throw std::runtime_error("codec argument is not a number");
}
const Bytes& Arg::as_bytes() const {
  if (auto p = std::get_if<Bytes>(&v)) return *p;
  throw std::runtime_error("codec argument is not a byte array");
}
const std::string& Arg::as_string() const {
  if (auto p = std::get_if<std::string>(&v)) return *p;
  throw std::runtime_error("codec argument is not a string");
}

void codec_fail(const char* name, const char* op, const char* what, std::int64_t offset) {
  throw Error(ErrorCode::Codec, std::string("codec ") + name + " failed to " + op + ": " + what, offset);
}

void Meta::remember(std::string key, BytesView encoded, BytesView decoded) {
  if (!origins_) origins_ = std::make_shared<std::unordered_map<std::string, Origin>>();
  Origin& o = (*origins_)[std::move(key)];
  o.encoded.assign(encoded.begin(), encoded.end());
  o.decoded.assign(decoded.begin(), decoded.end());
}

const Bytes* Meta::reuse(const std::string& key, BytesView plain) const {
  if (!origins_) return nullptr;
  auto it = origins_->find(key);
  if (it == origins_->end()) return nullptr;
  const Origin& o = it->second;
  if (o.decoded.size() != plain.size()) return nullptr;
  if (!std::equal(o.decoded.begin(), o.decoded.end(), plain.begin())) return nullptr;
  return &o.encoded;
}

std::string slot_key(const char* slot, const Frame& f) {
  std::string k = slot;
  for (std::int64_t i : f.idx) {
    if (i < 0) break;
    k += '/';
    k += std::to_string(i);
  }
  return k;
}

Bytes slice_stream(const Bytes& s, i128 start, std::optional<i128> stop) {
  i128 e = stop ? *stop : static_cast<i128>(s.size());
  if (start < 0 || e > static_cast<i128>(s.size()) || start > e)
    fail(ErrorCode::Eof, "stream slice [" + to_string(start) + ", " + to_string(e) +
                             ") is outside the stream of " + std::to_string(s.size()) + " bytes");
  return Bytes(s.begin() + static_cast<std::ptrdiff_t>(start), s.begin() + static_cast<std::ptrdiff_t>(e));
}

Bytes assemble_slices(std::optional<std::int64_t> length, const std::vector<SlicePart>& parts) {
  std::int64_t size = 0;
  for (const auto& p : parts) {
    std::int64_t n = static_cast<std::int64_t>(p.bytes->size());
    if (p.start < 0) fail(ErrorCode::Range, "slice start " + std::to_string(p.start) + " of " + p.name + " is invalid");
    if (p.end) {
      if (*p.end < p.start)
        fail(ErrorCode::Range, "slice [" + std::to_string(p.start) + ", " + std::to_string(*p.end) + ") of " + p.name +
                                   " is invalid");
      if (n > *p.end - p.start)
        fail(ErrorCode::Derive, std::string(p.name) + " encodes to " + std::to_string(n) + " bytes, its slice [" +
                                    std::to_string(p.start) + ", " + std::to_string(*p.end) + ") has " +
                                    std::to_string(*p.end - p.start));
    }
    size = std::max({size, p.end ? *p.end : p.start + n, p.start + n});
  }
  if (length) {
    if (size > *length)
      fail(ErrorCode::Derive,
           "the slices need " + std::to_string(size) + " bytes, the sliced field has " + std::to_string(*length));
    size = *length;
  }
  Bytes out(static_cast<std::size_t>(size), 0);
  std::vector<int> owner(static_cast<std::size_t>(size), -1);
  for (std::size_t k = 0; k < parts.size(); k++) {
    const auto& p = parts[k];
    for (std::size_t i = 0; i < p.bytes->size(); i++) {
      std::size_t at = static_cast<std::size_t>(p.start) + i;
      if (owner[at] >= 0 && out[at] != (*p.bytes)[i])
        fail(ErrorCode::Derive, std::string("overlapping slices ") + parts[static_cast<std::size_t>(owner[at])].name +
                                    " and " + p.name + " disagree at byte " + hex(static_cast<std::int64_t>(at)));
      out[at] = (*p.bytes)[i];
      owner[at] = static_cast<int>(k);
    }
  }
  return out;
}

std::vector<Bytes> split_by_sizes(BytesView data, const std::vector<std::int64_t>& sizes) {
  std::vector<Bytes> out;
  std::size_t at = 0;
  for (std::int64_t n : sizes) {
    if (n < 0 || at + static_cast<std::size_t>(n) > data.size())
      fail(ErrorCode::Derive, "piece sizes exceed the stream length " + std::to_string(data.size()));
    out.emplace_back(data.begin() + static_cast<std::ptrdiff_t>(at),
                     data.begin() + static_cast<std::ptrdiff_t>(at + static_cast<std::size_t>(n)));
    at += static_cast<std::size_t>(n);
  }
  if (at != data.size())
    fail(ErrorCode::Derive, "piece sizes cover " + std::to_string(at) + " of " +
                                std::to_string(data.size()) + " stream bytes");
  return out;
}

// ── helpers ────────────────────────────────────────────────────────────────────

bool regex_match(const std::string& s, const char* pattern) {
  static std::mutex mu;
  static std::unordered_map<std::string, std::shared_ptr<std::regex>> cache;
  std::shared_ptr<std::regex> re;
  {
    std::lock_guard<std::mutex> lock(mu);
    auto it = cache.find(pattern);
    if (it == cache.end())
      it = cache.emplace(pattern, std::make_shared<std::regex>(pattern, std::regex::ECMAScript)).first;
    re = it->second;
  }
  return std::regex_match(s, *re);
}

void check_float_round_trip(double v, double back, double next) {
  if (std::isnan(v) && std::isnan(back)) return;
  double half = std::fabs(next - back) / 2;
  if (!(std::fabs(v - back) <= half * (1 + 1e-9)))
    fail(ErrorCode::Input, "value does not survive the transform");
}

std::uint64_t bits_of(i128 v, int width, bool is_signed) {
  i128 lo = is_signed ? -(static_cast<i128>(1) << (width - 1)) : 0;
  i128 hi = is_signed ? (static_cast<i128>(1) << (width - 1)) - 1 : (static_cast<i128>(1) << width) - 1;
  if (v < lo || v > hi) fail(ErrorCode::Range, to_string(v) + " does not fit in " + std::to_string(width) + " bits");
  if (v < 0) v += static_cast<i128>(1) << width;
  return static_cast<std::uint64_t>(v);
}

Bytes encode_fixed_string(std::string_view s, std::int64_t n, int unit, Encoding enc, bool le) {
  Bytes b = encode_string(s, enc, le);
  if (static_cast<std::int64_t>(b.size()) > n)
    fail(ErrorCode::Input, "string of " + std::to_string(b.size() / static_cast<std::size_t>(unit)) +
                               " units exceeds the length " + std::to_string(n / unit));
  b.resize(static_cast<std::size_t>(n), 0);
  return b;
}

std::optional<std::size_t> Uleb128::size(BytesView bytes, std::int64_t max_bytes) const {
  for (std::size_t i = 0; i < bytes.size() && static_cast<std::int64_t>(i) < max_bytes; i++)
    if (!(bytes[i] & 0x80)) return i + 1;
  if (static_cast<std::int64_t>(bytes.size()) >= max_bytes)
    fail(ErrorCode::Check, "LEB128 longer than " + std::to_string(max_bytes) + " bytes");
  return std::nullopt;
}

std::uint64_t Uleb128::read(BytesView bytes, std::int64_t) const {
  u128 v = 0;
  for (std::size_t i = bytes.size(); i-- > 0;) v = (v << 7) | (bytes[i] & 0x7f);
  if (v > std::numeric_limits<std::uint64_t>::max()) fail(ErrorCode::Range, "uleb128 value exceeds u64");
  return static_cast<std::uint64_t>(v);
}

Bytes Uleb128::write(std::uint64_t value, std::int64_t) const {
  Bytes out;
  do {
    std::uint8_t b = value & 0x7f;
    value >>= 7;
    if (value) b |= 0x80;
    out.push_back(b);
  } while (value);
  return out;
}

std::optional<std::size_t> Sleb128::size(BytesView bytes, std::int64_t max_bytes) const {
  return uleb128.size(bytes, max_bytes);
}

std::int64_t Sleb128::read(BytesView bytes, std::int64_t) const {
  i128 v = 0;
  for (std::size_t i = bytes.size(); i-- > 0;) v = (v << 7) | (bytes[i] & 0x7f);
  if (!bytes.empty() && (bytes.back() & 0x40)) v -= static_cast<i128>(1) << (7 * bytes.size());
  return to<std::int64_t>(v, "sleb128 value");
}

Bytes Sleb128::write(std::int64_t value, std::int64_t) const {
  Bytes out;
  i128 v = value;
  for (;;) {
    std::uint8_t b = static_cast<std::uint8_t>(static_cast<std::uint64_t>(v) & 0x7f);
    v >>= 7;
    bool done = (v == 0 && !(b & 0x40)) || (v == -1 && (b & 0x40));
    out.push_back(done ? b : static_cast<std::uint8_t>(b | 0x80));
    if (done) break;
  }
  return out;
}

}  // namespace yaffle
