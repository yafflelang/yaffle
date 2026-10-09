// Text encodings. Values are UTF-8 `std::string`s whatever the encoding on disk; lengths on disk
// count code units of the disk encoding. Invalid input on read is a CHECK error; text that can't be
// encoded (or contains NUL, which would read back differently) is an INPUT error on write.
//
// Strings that come from JSON may hold lone surrogates (JSON "\ud800"); they are kept as WTF-8
// (the surrogate's 3-byte UTF-8 form) and rejected with INPUT when encoded.
#pragma once

#include "core.hpp"

namespace yaffle {

enum class Encoding : std::uint8_t { utf8, ascii, latin1, utf16, utf32 };

constexpr int unit_of(Encoding e) { return e == Encoding::utf16 ? 2 : e == Encoding::utf32 ? 4 : 1; }

/// Index (in units) of the first all-zero unit among `n_units` units at `p`, or -1.
std::int64_t find_nul_unit(const std::uint8_t* p, std::int64_t n_units, int unit);

/// Decodes `n_units` code units (already cut at the NUL unit). `at` is the absolute offset reported
/// in errors.
std::string decode_string(const std::uint8_t* p, std::int64_t n_units, Encoding enc, bool le,
                          std::int64_t at);

/// Encodes text without terminator or padding (INPUT errors for NUL, unencodable characters,
/// invalid UTF-8 and lone surrogates).
Bytes encode_string(std::string_view s, Encoding enc, bool le);

/// Code units `s` occupies in the encoding (`len` / `.length`).
std::int64_t code_units(std::string_view s, Encoding enc);
/// Bytes `s` occupies in the encoding (the IR builtin `encodedLength`).
inline std::int64_t encoded_bytes(std::string_view s, Encoding enc) {
  return code_units(s, enc) * unit_of(enc);
}

/// Appends the UTF-8 (WTF-8 for surrogates) form of a code point.
void append_utf8(std::string& out, std::uint32_t cp);

/// Decodes UTF-8/WTF-8 into code points; false if malformed.
bool utf8_to_code_points(std::string_view s, std::vector<std::uint32_t>& out);

}  // namespace yaffle
