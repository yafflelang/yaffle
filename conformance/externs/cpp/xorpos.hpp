// `extern codec xorpos(u8 key) @ranged`: byte i of the encoded region is XORed with
// `(key + i) & 0xff`, where i counts from the start of the whole region (`ctx.position`).
#pragma once

#include "types.hpp"

struct XorPosCodec {
  static yaffle::Bytes apply(yaffle::BytesView input, const yaffle::CodecCtx& ctx) {
    int key = conformance_externs::key_arg(ctx);
    std::size_t pos = ctx.position.value_or(0);
    yaffle::Bytes out(input.size());
    for (std::size_t i = 0; i < input.size(); i++)
      out[i] = static_cast<std::uint8_t>(input[i] ^ ((key + pos + i) & 0xff));
    return out;
  }
  yaffle::Bytes decode(yaffle::BytesView input, const yaffle::CodecCtx& ctx) const { return apply(input, ctx); }
  yaffle::Bytes encode(yaffle::BytesView input, const yaffle::CodecCtx& ctx) const { return apply(input, ctx); }
};

inline const XorPosCodec xorpos{};
