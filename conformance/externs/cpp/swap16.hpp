// `extern fn swap16(u16 v) -> u16`: swaps the two bytes. Its own inverse.
#pragma once

#include <cstdint>

inline std::uint16_t swap16(std::uint16_t v) {
  return static_cast<std::uint16_t>(((v & 0xff) << 8) | ((v >> 8) & 0xff));
}
