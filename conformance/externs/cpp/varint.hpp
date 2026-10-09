// `extern type VarInt(u8 maxBytes) : u64`: unsigned LEB128, at most `maxBytes` bytes.
//
// - size: the index after the first byte below 0x80; nullopt if the bytes end first (need more);
//   an error if no terminating byte is found within `maxBytes`.
// - write: the shortest encoding; an error if it needs more than `maxBytes` bytes.
#pragma once

#include "types.hpp"

struct VarIntType {
  std::optional<std::size_t> size(yaffle::BytesView bytes, std::uint8_t maxBytes) const {
    for (std::size_t i = 0; i < std::min<std::size_t>(bytes.size(), maxBytes); i++)
      if (bytes[i] < 0x80) return i + 1;
    if (bytes.size() < maxBytes) return std::nullopt;
    throw std::runtime_error("VarInt: longer than " + std::to_string(maxBytes) + " bytes");
  }
  std::uint64_t read(yaffle::BytesView bytes, std::uint8_t maxBytes) const {
    yaffle::u128 v = 0;
    for (std::size_t i = 0; i < bytes.size() && i < maxBytes; i++) {
      v |= static_cast<yaffle::u128>(bytes[i] & 0x7f) << (7 * i);
      if (bytes[i] < 0x80) {
        if (v > std::numeric_limits<std::uint64_t>::max()) throw std::runtime_error("VarInt: value exceeds u64");
        return static_cast<std::uint64_t>(v);
      }
    }
    throw std::runtime_error("VarInt: unterminated");
  }
  yaffle::Bytes write(std::uint64_t value, std::uint8_t maxBytes) const {
    yaffle::Bytes out;
    std::uint64_t v = value;
    do {
      std::uint8_t b = v & 0x7f;
      v >>= 7;
      out.push_back(v == 0 ? b : static_cast<std::uint8_t>(b | 0x80));
    } while (v != 0);
    if (out.size() > maxBytes)
      throw std::runtime_error("VarInt: " + std::to_string(value) + " needs " + std::to_string(out.size()) +
                               " bytes, more than " + std::to_string(maxBytes));
    return out;
  }
};

inline const VarIntType VarInt{};
