// `extern codec xor(u8 key) @ranged`: every byte XOR `key`. Its own inverse and position
// independent, so any slice decodes on its own. `xor` is a C++ keyword: the item is `xor_`.
#pragma once

#include "types.hpp"

struct XorCodec {
  static yaffle::Bytes apply(yaffle::BytesView input, const yaffle::CodecCtx& ctx) {
    int key = conformance_externs::key_arg(ctx);
    yaffle::Bytes out(input.begin(), input.end());
    for (auto& b : out) b = static_cast<std::uint8_t>(b ^ key);
    return out;
  }
  yaffle::Bytes decode(yaffle::BytesView input, const yaffle::CodecCtx& ctx) const {
    yaffle::Bytes out = apply(input, ctx);
    if (ctx.output_size && *ctx.output_size != out.size())
      throw std::runtime_error("xor: decoded " + std::to_string(out.size()) + " bytes, expected " +
                               std::to_string(*ctx.output_size));
    return out;
  }
  yaffle::Bytes encode(yaffle::BytesView input, const yaffle::CodecCtx& ctx) const { return apply(input, ctx); }
};

inline const XorCodec xor_{};
