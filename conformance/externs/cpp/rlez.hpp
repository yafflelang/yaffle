// `extern codec rlez @streaming`: `rle` pairs followed by a single 0x00 terminator. It finds its
// own end: decode reports how many bytes it consumed (terminator included).
#pragma once

#include "types.hpp"

struct RlezCodec {
  yaffle::Decoded decode(yaffle::BytesView input, const yaffle::CodecCtx& ctx) const {
    std::size_t i = 0;
    while (i < input.size() && input[i] != 0) i += 2;
    if (i >= input.size()) throw std::runtime_error("rlez: missing terminator");
    yaffle::Decoded d;
    d.output = conformance_externs::rle_decode(input.first(i));
    if (ctx.output_size && *ctx.output_size != d.output.size())
      throw std::runtime_error("rlez: decoded " + std::to_string(d.output.size()) + " bytes, expected " +
                               std::to_string(*ctx.output_size));
    d.consumed = i + 1;
    return d;
  }
  yaffle::Bytes encode(yaffle::BytesView input, const yaffle::CodecCtx&) const {
    yaffle::Bytes out = conformance_externs::rle_encode(input);
    out.push_back(0);
    return out;
  }
};

inline const RlezCodec rlez{};
