// Text encodings (see strings.hpp).
#include "yaffle/yaffle.hpp"

namespace yaffle {

std::int64_t find_nul_unit(const std::uint8_t* p, std::int64_t n_units, int unit) {
  if (unit == 1) {
    const void* z = std::memchr(p, 0, static_cast<std::size_t>(n_units));
    return z ? static_cast<const std::uint8_t*>(z) - p : -1;
  }
  for (std::int64_t i = 0; i < n_units; i++) {
    const std::uint8_t* q = p + i * unit;
    bool zero = true;
    for (int k = 0; k < unit; k++)
      if (q[k]) {
        zero = false;
        break;
      }
    if (zero) return i;
  }
  return -1;
}

void append_utf8(std::string& out, std::uint32_t cp) {
  if (cp < 0x80) {
    out += static_cast<char>(cp);
  } else if (cp < 0x800) {
    out += static_cast<char>(0xc0 | (cp >> 6));
    out += static_cast<char>(0x80 | (cp & 0x3f));
  } else if (cp < 0x10000) {
    out += static_cast<char>(0xe0 | (cp >> 12));
    out += static_cast<char>(0x80 | ((cp >> 6) & 0x3f));
    out += static_cast<char>(0x80 | (cp & 0x3f));
  } else {
    out += static_cast<char>(0xf0 | (cp >> 18));
    out += static_cast<char>(0x80 | ((cp >> 12) & 0x3f));
    out += static_cast<char>(0x80 | ((cp >> 6) & 0x3f));
    out += static_cast<char>(0x80 | (cp & 0x3f));
  }
}

/// Length of the valid (strict) UTF-8 sequence at p, or 0 if invalid. `surrogates` allows WTF-8.
static int utf8_seq(const std::uint8_t* p, std::size_t n, std::uint32_t& cp, bool surrogates) {
  std::uint8_t b0 = p[0];
  if (b0 < 0x80) {
    cp = b0;
    return 1;
  }
  auto cont = [&](std::size_t i) { return i < n && (p[i] & 0xc0) == 0x80; };
  if (b0 >= 0xc2 && b0 <= 0xdf) {
    if (!cont(1)) return 0;
    cp = ((b0 & 0x1fu) << 6) | (p[1] & 0x3fu);
    return 2;
  }
  if (b0 >= 0xe0 && b0 <= 0xef) {
    if (!cont(1) || !cont(2)) return 0;
    std::uint8_t b1 = p[1];
    if (b0 == 0xe0 && b1 < 0xa0) return 0;
    if (b0 == 0xed && b1 >= 0xa0 && !surrogates) return 0;
    cp = ((b0 & 0x0fu) << 12) | ((b1 & 0x3fu) << 6) | (p[2] & 0x3fu);
    return 3;
  }
  if (b0 >= 0xf0 && b0 <= 0xf4) {
    if (!cont(1) || !cont(2) || !cont(3)) return 0;
    std::uint8_t b1 = p[1];
    if (b0 == 0xf0 && b1 < 0x90) return 0;
    if (b0 == 0xf4 && b1 >= 0x90) return 0;
    cp = ((b0 & 0x07u) << 18) | ((b1 & 0x3fu) << 12) | ((p[2] & 0x3fu) << 6) | (p[3] & 0x3fu);
    return 4;
  }
  return 0;
}

bool utf8_to_code_points(std::string_view s, std::vector<std::uint32_t>& out) {
  const auto* p = reinterpret_cast<const std::uint8_t*>(s.data());
  std::size_t n = s.size();
  for (std::size_t i = 0; i < n;) {
    std::uint32_t cp;
    int k = utf8_seq(p + i, n - i, cp, true);
    if (!k) return false;
    out.push_back(cp);
    i += static_cast<std::size_t>(k);
  }
  return true;
}

std::string decode_string(const std::uint8_t* p, std::int64_t n_units, Encoding enc, bool le,
                          std::int64_t at) {
  std::string s;
  switch (enc) {
    case Encoding::latin1:
      s.reserve(static_cast<std::size_t>(n_units));
      for (std::int64_t i = 0; i < n_units; i++) append_utf8(s, p[i]);
      return s;
    case Encoding::ascii:
      for (std::int64_t i = 0; i < n_units; i++)
        if (p[i] >= 0x80) fail(ErrorCode::Check, "byte " + hex(p[i]) + " is not ASCII", at + i);
      return std::string(reinterpret_cast<const char*>(p), static_cast<std::size_t>(n_units));
    case Encoding::utf8: {
      std::size_t n = static_cast<std::size_t>(n_units);
      for (std::size_t i = 0; i < n;) {
        if (p[i] < 0x80) {
          i++;
          continue;
        }
        std::uint32_t cp;
        int k = utf8_seq(p + i, n - i, cp, false);
        if (!k) fail(ErrorCode::Check, "invalid UTF-8", at);
        i += static_cast<std::size_t>(k);
      }
      return std::string(reinterpret_cast<const char*>(p), n);
    }
    case Encoding::utf16: {
      for (std::int64_t i = 0; i < n_units; i++) {
        const std::uint8_t* q = p + i * 2;
        std::uint32_t u = le ? (q[0] | (q[1] << 8)) : ((q[0] << 8) | q[1]);
        if (u >= 0xd800 && u <= 0xdbff) {
          std::int64_t next = -1;
          if (i + 1 < n_units) {
            const std::uint8_t* r = q + 2;
            next = le ? (r[0] | (r[1] << 8)) : ((r[0] << 8) | r[1]);
          }
          if (next < 0xdc00 || next > 0xdfff)
            fail(ErrorCode::Check, "invalid UTF-16 (lone high surrogate)", at + i * 2);
          append_utf8(s, 0x10000 + ((u - 0xd800) << 10) + (static_cast<std::uint32_t>(next) - 0xdc00));
          i++;
        } else if (u >= 0xdc00 && u <= 0xdfff) {
          fail(ErrorCode::Check, "invalid UTF-16 (lone low surrogate)", at + i * 2);
        } else {
          append_utf8(s, u);
        }
      }
      return s;
    }
    case Encoding::utf32: {
      for (std::int64_t i = 0; i < n_units; i++) {
        std::uint32_t cp = static_cast<std::uint32_t>(load_uint(p + i * 4, 4, le));
        if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))
          fail(ErrorCode::Check, "invalid UTF-32 code point " + hex(cp), at + i * 4);
        append_utf8(s, cp);
      }
      return s;
    }
  }
  return s;
}

Bytes encode_string(std::string_view s, Encoding enc, bool le) {
  std::vector<std::uint32_t> cps;
  cps.reserve(s.size());
  if (!utf8_to_code_points(s, cps)) fail(ErrorCode::Input, "string is not valid UTF-8");
  for (std::uint32_t cp : cps) {
    if (cp == 0) fail(ErrorCode::Input, "string contains NUL");
    if (cp >= 0xd800 && cp <= 0xdfff) fail(ErrorCode::Input, "string is not well-formed (lone surrogate)");
  }
  Bytes out;
  switch (enc) {
    case Encoding::utf8:
      out.assign(s.begin(), s.end());
      return out;
    case Encoding::ascii:
    case Encoding::latin1: {
      std::uint32_t lim = enc == Encoding::ascii ? 0x80 : 0x100;
      out.reserve(cps.size());
      for (std::uint32_t cp : cps) {
        if (cp >= lim) {
          char buf[48];
          std::snprintf(buf, sizeof buf, "character U+%04X is not %s", cp,
                        enc == Encoding::ascii ? "ascii" : "latin1");
          fail(ErrorCode::Input, buf);
        }
        out.push_back(static_cast<std::uint8_t>(cp));
      }
      return out;
    }
    case Encoding::utf16: {
      out.reserve(cps.size() * 2);
      auto unit = [&](std::uint32_t u) {
        out.push_back(static_cast<std::uint8_t>(le ? (u & 0xff) : (u >> 8)));
        out.push_back(static_cast<std::uint8_t>(le ? (u >> 8) : (u & 0xff)));
      };
      for (std::uint32_t cp : cps) {
        if (cp >= 0x10000) {
          std::uint32_t c = cp - 0x10000;
          unit(0xd800 + (c >> 10));
          unit(0xdc00 + (c & 0x3ff));
        } else {
          unit(cp);
        }
      }
      return out;
    }
    case Encoding::utf32: {
      out.resize(cps.size() * 4);
      for (std::size_t i = 0; i < cps.size(); i++) store_uint(out.data() + i * 4, 4, cps[i], le);
      return out;
    }
  }
  return out;
}

std::int64_t code_units(std::string_view s, Encoding enc) {
  if (enc == Encoding::utf8) return static_cast<std::int64_t>(s.size());
  std::vector<std::uint32_t> cps;
  if (!utf8_to_code_points(s, cps)) return static_cast<std::int64_t>(s.size());
  if (enc == Encoding::utf32) return static_cast<std::int64_t>(cps.size());
  std::int64_t n = 0;
  for (std::uint32_t cp : cps) n += cp >= 0x10000 ? 2 : 1;
  return n;
}

}  // namespace yaffle
