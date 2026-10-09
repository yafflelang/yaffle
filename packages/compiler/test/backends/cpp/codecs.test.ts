/**
 * Externs in C++: codecs (sync, std::future-based async, streaming), extern functions and extern
 * types from headers, and codec reuse for byte-exact rebuilds of non-canonical encodings.
 */
import { describe, expect, it } from "vitest";
import { PRELUDE, build, toolchain } from "./harness.ts";

const SCHEMA = `
extern codec pad
extern async codec slow(u8 k)
extern fn twice(u8 v) -> u8
extern type Nib : u8 @size(1)

export struct Packed {
  u8 n
  Body body @via(pad) @size(n)
}
struct Body { u8 a  u8 b }

export struct Async { u8 n  u8 data[] @via(slow(1)) @size(n) }

export struct Calc { u8 a  u8 c = twice(a)  Nib nib }
`;

const EXTERNS = `#pragma once
#include <future>
#include <stdexcept>
#include <yaffle/yaffle.hpp>

// Drops the last byte on decode (whatever it is) and appends 0x00 on encode: decoding is not
// injective, so only codec reuse rebuilds files whose last byte is not zero.
struct PadCodec {
  yaffle::Bytes decode(yaffle::BytesView in, const yaffle::CodecCtx&) const {
    if (in.empty()) throw std::runtime_error("pad: empty");
    return yaffle::Bytes(in.begin(), in.end() - 1);
  }
  yaffle::Bytes encode(yaffle::BytesView in, const yaffle::CodecCtx&) const {
    yaffle::Bytes out(in.begin(), in.end());
    out.push_back(0);
    return out;
  }
};
inline const PadCodec pad{};

// Adds k on encode, subtracts it on decode, through futures.
struct SlowCodec {
  static yaffle::Bytes add(yaffle::BytesView in, int k) {
    yaffle::Bytes out(in.begin(), in.end());
    for (auto& b : out) b = static_cast<std::uint8_t>(b + k);
    return out;
  }
  std::future<yaffle::Bytes> decode(yaffle::BytesView in, const yaffle::CodecCtx& ctx) const {
    return std::async(std::launch::async, add, yaffle::Bytes(in.begin(), in.end()), -static_cast<int>(ctx.args[0].as_int()));
  }
  std::future<yaffle::Bytes> encode(yaffle::BytesView in, const yaffle::CodecCtx& ctx) const {
    return std::async(std::launch::async, add, yaffle::Bytes(in.begin(), in.end()), static_cast<int>(ctx.args[0].as_int()));
  }
};
inline const SlowCodec slow{};

inline std::uint8_t twice(std::uint8_t v) {
  if (v > 127) throw std::runtime_error("twice: overflow");
  return static_cast<std::uint8_t>(v * 2);
}

struct NibType {
  std::optional<std::size_t> size(yaffle::BytesView) const { return 1; }
  std::uint8_t read(yaffle::BytesView b) const {
    if (b[0] > 15) throw std::runtime_error("not a nibble");
    return b[0];
  }
  yaffle::Bytes write(std::uint8_t v) const { return yaffle::Bytes{v}; }
};
inline const NibType Nib{};
`;

const MAIN = `${PRELUDE}
int main() {
  Packed p = Packed::parse(hex("03 0102ff"));
  CHECK(p.body.a == 1 && p.body.b == 2);
  std::printf("reuse=%s\\n", yaffle::to_hex(Packed::serialize(p)).c_str());
  Packed copy = p;  // copies keep the codec origins
  std::printf("copy=%s\\n", yaffle::to_hex(Packed::serialize(copy)).c_str());
  p.body.a = 9;
  std::printf("changed=%s\\n", yaffle::to_hex(Packed::serialize(p)).c_str());
  Packed j = Packed::from_json(Packed::to_json(copy));
  std::printf("json=%s\\n", yaffle::to_hex(Packed::serialize(j)).c_str());
  std::printf("codec-error=%s\\n", err([] { Packed::parse(hex("00")); }).c_str());

  Async a = Async::parse(hex("02 0203"));
  CHECK(a.data == hex("0102"));
  std::printf("async=%s\\n", yaffle::to_hex(Async::serialize(a)).c_str());

  Calc c = Calc::parse(hex("05 00 0f"));
  CHECK(c.nib == 15);
  std::printf("calc=%s\\n", yaffle::to_hex(Calc::serialize(c)).c_str());
  c.a = 200;
  std::printf("fn-error=%s\\n", err([&] { Calc::serialize(c); }).c_str());
  std::printf("type-error=%s\\n", err([] { Calc::parse(hex("01 02 10")); }).c_str());
  std::printf("failures=%d\\n", failures);
  return failures ? 1 : 0;
}
`;

describe.skipIf(!toolchain)("C++ externs and codec reuse", () => {
  it(
    "calls host codecs, functions and types; reuses original encodings",
    { timeout: 300_000 },
    async () => {
      const b = await build("codecs", SCHEMA, MAIN, {
        externs: {
          pad: "externs.hpp",
          slow: "externs.hpp",
          twice: "externs.hpp",
          Nib: "externs.hpp"
        },
        files: { "externs.hpp": EXTERNS }
      });
      expect(b.source).toContain(`#include "externs.hpp"`);
      const r = await b.run();
      const out = Object.fromEntries(
        r.stdout
          .split("\n")
          .filter(l => l.includes("="))
          .map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
      );
      expect(out.failures).toBe("0");
      expect(out.reuse).toBe("030102ff");
      expect(out.copy).toBe("030102ff");
      expect(out.changed).toBe("03090200");
      expect(out.json).toBe("03010200");
      expect(out["codec-error"]).toBe("CODEC body");
      expect(out.async).toBe("020203");
      expect(out.calc).toBe("050a0f");
      expect(out["fn-error"]).toBe("CODEC c");
      expect(out["type-error"]).toBe("CODEC nib");
    }
  );
});
