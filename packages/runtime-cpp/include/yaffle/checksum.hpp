// Built-in checksums (docs/IR.md §5, §6): crc32 (IEEE 802.3, reflected) and adler32.
#pragma once

#include "core.hpp"

namespace yaffle {

std::uint32_t crc32(BytesView data, std::uint32_t prev = 0);
std::uint32_t adler32(BytesView data, std::uint32_t prev = 1);
inline std::uint32_t crc32(std::string_view s) {
  return crc32(BytesView(reinterpret_cast<const std::uint8_t*>(s.data()), s.size()));
}
inline std::uint32_t adler32(std::string_view s) {
  return adler32(BytesView(reinterpret_cast<const std::uint8_t*>(s.data()), s.size()));
}
inline std::uint32_t crc32(const Bytes& b) { return crc32(BytesView(b)); }
inline std::uint32_t adler32(const Bytes& b) { return adler32(BytesView(b)); }

}  // namespace yaffle
