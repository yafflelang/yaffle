// Shared helpers of the C++ conformance externs (docs/CONFORMANCE.md §5, docs/targets/cpp.md).
#pragma once

#include <stdexcept>
#include <string>

#include <yaffle/yaffle.hpp>

namespace conformance_externs {

/// The codec's key argument (a u8).
inline int key_arg(const yaffle::CodecCtx& ctx, std::size_t index = 0) {
  if (index >= ctx.args.size()) throw std::runtime_error("codec key argument missing");
  yaffle::i128 v = ctx.args[index].as_int();
  if (v < 0 || v > 255) throw std::runtime_error("codec key must be a u8, got " + yaffle::to_string(v));
  return static_cast<int>(v);
}

inline yaffle::Bytes rle_decode(yaffle::BytesView input) {
  if (input.size() % 2 != 0) throw std::runtime_error("rle: odd input length " + std::to_string(input.size()));
  yaffle::Bytes out;
  for (std::size_t i = 0; i < input.size(); i += 2) {
    unsigned n = input[i];
    if (n == 0) throw std::runtime_error("rle: zero run length at " + std::to_string(i));
    out.insert(out.end(), n, input[i + 1]);
  }
  return out;
}

inline yaffle::Bytes rle_encode(yaffle::BytesView input) {
  yaffle::Bytes out;
  std::size_t i = 0;
  while (i < input.size()) {
    std::uint8_t b = input[i];
    std::size_t n = 1;
    while (i + n < input.size() && input[i + n] == b && n < 255) n++;
    out.push_back(static_cast<std::uint8_t>(n));
    out.push_back(b);
    i += n;
  }
  return out;
}

}  // namespace conformance_externs
