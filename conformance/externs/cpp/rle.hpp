// `extern codec rle`: run-length encoding as (count, byte) pairs with count 1..255.
//
// - decode: an odd input length or a zero count is an error; so is a decoded length that differs
//   from `output_size` when one is given.
// - encode: greedy, runs of at most 255 (deterministic).
#pragma once

#include "types.hpp"

struct RleCodec {
  yaffle::Bytes decode(yaffle::BytesView input, const yaffle::CodecCtx& ctx) const {
    yaffle::Bytes out = conformance_externs::rle_decode(input);
    if (ctx.output_size && *ctx.output_size != out.size())
      throw std::runtime_error("rle: decoded " + std::to_string(out.size()) + " bytes, expected " +
                               std::to_string(*ctx.output_size));
    return out;
  }
  yaffle::Bytes encode(yaffle::BytesView input, const yaffle::CodecCtx&) const {
    return conformance_externs::rle_encode(input);
  }
};

inline const RleCodec rle{};
