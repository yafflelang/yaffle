/**
 * C++ views that read only what they touch: file-backed views (positional reads through a block
 * cache), `from arr[*].piece` streams that decode only the pieces a read needs, and `@ranged`
 * codec regions decoded block by block.
 */
import { describe, expect, it } from "vitest";
import { PRELUDE, build, toolchain } from "./harness.ts";

// ── @ranged codec regions and file-backed views (synthetic) ───────────────────────

const RANGED = `
extern codec xcount(u8 key) @ranged

struct Item { u16 a  u16 b }
struct Body { u32 count  Item items[count] }
export struct Sealed {
  u32  magic = 0x5345414c
  Body body @via(xcount(0x5a))
}
`;

const COUNTING_XOR = `#pragma once
#include <yaffle/yaffle.hpp>
// xor with a key, counting decode calls and decoded bytes (tests).
struct XCount {
  static inline int decodes = 0;
  static inline std::size_t bytes = 0;
  static yaffle::Bytes run(yaffle::BytesView in, const yaffle::CodecCtx& c) {
    int key = static_cast<int>(c.args.at(0).as_int());
    yaffle::Bytes out(in.begin(), in.end());
    for (auto& b : out) b = static_cast<std::uint8_t>(b ^ key);
    return out;
  }
  yaffle::Bytes decode(yaffle::BytesView in, const yaffle::CodecCtx& c) const {
    decodes++;
    bytes += in.size();
    return run(in, c);
  }
  yaffle::Bytes encode(yaffle::BytesView in, const yaffle::CodecCtx& c) const { return run(in, c); }
};
inline const XCount xcount{};
`;

const RANGED_MAIN = `${PRELUDE}
#include <fstream>
#include "xcount.hpp"
int main(int, char** argv) {
  const std::uint32_t N = 20000;
  Sealed s;
  s.body.items.resize(N);
  for (std::uint32_t i = 0; i < N; i++) s.body.items[i] = Item{static_cast<std::uint16_t>(i), static_cast<std::uint16_t>(i ^ 0x5a5a)};
  yaffle::Bytes bytes = Sealed::serialize(s);
  // Really encoded: the plaintext count does not appear.
  std::printf("encoded=%d\\n", bytes[4] != (N & 0xff));
  XCount::decodes = 0;
  XCount::bytes = 0;
  auto v = Sealed::view(bytes);
  std::printf("b=%u count=%u\\n", v.body_view().items_views()[17777].b(), v.body_view().count());
  std::printf("decodes=%d bytes=%zu\\n", XCount::decodes, XCount::bytes);
  std::printf("same=%d\\n", Sealed::to_json(Sealed::view(bytes).materialize()) == Sealed::to_json(Sealed::parse(bytes)));
  // The same through a file: positional reads of the blocks it touches.
  std::string path = std::string(argv[1]) + "/sealed.bin";
  { std::ofstream out(path, std::ios::binary); out.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size())); }
  auto fs = std::make_shared<yaffle::FileStore>(path, 0x1000, 16);
  auto fv = Sealed::view(fs);
  std::printf("file b=%u reads=%lld read=%lld size=%zu\\n", fv.body_view().items_views()[17777].b(),
              (long long)fs->reads, (long long)fs->bytes_read, bytes.size());
  // An in-place edit through a file-backed view, committed.
  auto fv2 = Sealed::view_file(path);
  fv2.body_view().items_views()[3].set_a(7);
  yaffle::Bytes out = fv2.commit();
  Sealed back = Sealed::parse(out);
  std::printf("edited a=%u b=%u n=%zu\\n", back.body.items[3].a, back.body.items[3].b, back.body.items.size());
  return failures ? 1 : 0;
}
`;

describe.skipIf(!toolchain)("C++ lazy views: @ranged regions and files", () => {
  it(
    "decodes only the blocks a read touches, through memory and files",
    { timeout: 600_000 },
    async () => {
      const b = await build("views-ranged", RANGED, RANGED_MAIN, {
        externs: { xcount: "xcount.hpp" },
        files: { "xcount.hpp": COUNTING_XOR }
      });
      const r = await b.run([b.dir]);
      expect(r.code, r.stdout + r.stderr).toBe(0);
      const lines = r.stdout.trim().split("\n");
      expect(lines[0]).toBe("encoded=1");
      expect(lines[1]).toBe(`b=${17777 ^ 0x5a5a} count=20000`);
      // Block 0 (the count), the block of items[17777] and possibly its neighbour: 4 KiB blocks.
      const [, decodes, bytes] = /decodes=(\d+) bytes=(\d+)/.exec(lines[2]!)!.map(Number);
      expect(decodes).toBeLessThanOrEqual(3);
      expect(bytes).toBeLessThanOrEqual(3 * 0x1000);
      expect(lines[3]).toBe("same=1");
      const [, fb, reads, read, size] = /file b=(\d+) reads=(\d+) read=(\d+) size=(\d+)/
        .exec(lines[4]!)!
        .map(Number);
      expect(fb).toBe(17777 ^ 0x5a5a);
      expect(reads).toBeLessThanOrEqual(4);
      expect(read).toBeLessThan(size! / 4);
      expect(lines[5]).toBe(`edited a=7 b=${3 ^ 0x5a5a} n=20000`);
    }
  );
});
