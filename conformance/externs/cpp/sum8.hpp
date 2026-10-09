// `extern fn sum8(u8 data[]) -> u8`: the sum of the bytes, modulo 256.
#pragma once

#include "types.hpp"

inline std::uint8_t sum8(const yaffle::Bytes& data) {
  unsigned s = 0;
  for (std::uint8_t b : data) s = (s + b) & 0xff;
  return static_cast<std::uint8_t>(s);
}
