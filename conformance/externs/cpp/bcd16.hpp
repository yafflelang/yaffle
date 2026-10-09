// `extern type Bcd16 : u16 @size(2)`: four BCD digits, most significant first (`12 34` → 1234).
// A nibble above 9 is an error on read; a value above 9999 is an error on write.
#pragma once

#include "types.hpp"

struct Bcd16Type {
  std::optional<std::size_t> size(yaffle::BytesView) const { return 2; }
  std::uint16_t read(yaffle::BytesView bytes) const {
    unsigned v = 0;
    for (std::size_t i = 0; i < 2; i++) {
      unsigned hi = bytes[i] >> 4, lo = bytes[i] & 0x0f;
      if (hi > 9 || lo > 9) throw std::runtime_error("Bcd16: invalid digit");
      v = v * 100 + hi * 10 + lo;
    }
    return static_cast<std::uint16_t>(v);
  }
  yaffle::Bytes write(std::uint16_t value) const {
    if (value > 9999) throw std::runtime_error("Bcd16: " + std::to_string(value) + " out of range");
    unsigned d0 = value / 1000 % 10, d1 = value / 100 % 10, d2 = value / 10 % 10, d3 = value % 10;
    return yaffle::Bytes{static_cast<std::uint8_t>((d0 << 4) | d1), static_cast<std::uint8_t>((d2 << 4) | d3)};
  }
};

inline const Bcd16Type Bcd16{};
