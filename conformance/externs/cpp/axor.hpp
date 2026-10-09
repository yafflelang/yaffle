// `extern async codec axor(u8 key)`: the same transform as `xor`, through std::future (the C++
// form of an async codec; the runtime waits for the result).
#pragma once

#include <future>

#include "xor.hpp"

struct AsyncXorCodec {
  std::future<yaffle::Bytes> decode(yaffle::BytesView input, const yaffle::CodecCtx& ctx) const {
    yaffle::Bytes copy(input.begin(), input.end());
    return std::async(std::launch::deferred, [copy, ctx]() { return xor_.decode(copy, ctx); });
  }
  std::future<yaffle::Bytes> encode(yaffle::BytesView input, const yaffle::CodecCtx& ctx) const {
    yaffle::Bytes copy(input.begin(), input.end());
    return std::async(std::launch::deferred, [copy, ctx]() { return xor_.encode(copy, ctx); });
  }
};

inline const AsyncXorCodec axor{};
