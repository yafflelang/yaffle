// Unit tests of the C++ runtime. Build: g++ -std=c++20 -I include test/runtime_test.cpp src/*.cpp
#include "test.hpp"

using namespace yaffle;

// ── integers ───────────────────────────────────────────────────────────────────

TEST("int: truncating division and modulo with the dividend's sign") {
  CHECK_EQ(yaffle::div(7, 2), i128(3));
  CHECK_EQ(yaffle::div(-7, 2), i128(-3));
  CHECK_EQ(yaffle::mod(-7, 2), i128(-1));
  CHECK_EQ(yaffle::mod(7, -2), i128(1));
  CHECK_THROWS(yaffle::div(1, 0), Range);
  CHECK_THROWS(yaffle::mod(1, 0), Range);
}

TEST("int: shifts are exact and checked") {
  CHECK_EQ(shl(1, 63), static_cast<i128>(1) << 63);
  CHECK_EQ(shr(-8, 1), i128(-4));
  CHECK_EQ(shr(-1, 63), i128(-1));
  CHECK_THROWS(shl(1, 64), Range);
  CHECK_THROWS(shr(1, -1), Range);
}

TEST("int: checked 128-bit arithmetic") {
  CHECK_THROWS(mul(kI128Max, 2), Range);
  CHECK_THROWS(add(kI128Max, 1), Range);
  CHECK_EQ(sub(0, 5), i128(-5));
}

TEST("int: conversions to destinations") {
  CHECK_EQ(to<std::uint8_t>(255), std::uint8_t(255));
  CHECK_THROWS(to<std::uint8_t>(256), Range);
  CHECK_THROWS(to<std::int8_t>(-129), Range);
  CHECK_EQ((to_bits<std::uint32_t>(0xffffff, 24)), std::uint32_t(0xffffff));
  CHECK_THROWS(to_bits<std::uint32_t>(0x1000000, 24), Range);
  CHECK_THROWS(to_bits<std::int64_t>(static_cast<i128>(1) << 39, 40), Range);
  CHECK_THROWS(len(-1), Range);
}

TEST("int: rounding half away from zero") {
  CHECK_EQ(round_half_away(2.5), i128(3));
  CHECK_EQ(round_half_away(-2.5), i128(-3));
  CHECK_EQ(round_half_away(0.49999999999999994), i128(0));
  CHECK_THROWS(round_half_away(std::numeric_limits<double>::infinity()), Range);
}

TEST("int: decimal formatting and parsing") {
  CHECK_EQ(to_string(static_cast<i128>(-123)), std::string("-123"));
  CHECK_EQ(to_string(kI128Min), std::string("-170141183460469231731687303715884105728"));
  CHECK_EQ(*parse_i128("18446744073709551615"), static_cast<i128>(UINT64_MAX));
  CHECK(!parse_i128("12a").has_value());
  CHECK(!parse_i128("").has_value());
  CHECK(!parse_i128("-").has_value());
}

// ── primitives ─────────────────────────────────────────────────────────────────

TEST("prim: N-byte integers in both byte orders") {
  std::uint8_t b[8] = {};
  store_uint(b, 3, 0x123456, true);
  CHECK_EQ(load_uint(b, 3, true), std::uint64_t(0x123456));
  CHECK_EQ(load_uint(b, 3, false), std::uint64_t(0x563412));
  CHECK_EQ(sign_extend(0xffffff, 24), std::int64_t(-1));
  CHECK_EQ(sign_extend(0x7fffff, 24), std::int64_t(0x7fffff));
}

TEST("prim: half precision") {
  CHECK_EQ(half_to_float(0x3c00), 1.0f);
  CHECK_EQ(half_to_float(0xc000), -2.0f);
  CHECK_EQ(half_to_float(0x0001), static_cast<float>(std::ldexp(1.0, -24)));
  CHECK(std::isnan(half_to_float(0x7e00)));
  CHECK_EQ(float_to_half(1.0), std::uint16_t(0x3c00));
  CHECK_EQ(float_to_half(65504.0), std::uint16_t(0x7bff));
  CHECK_EQ(float_to_half(65520.0), std::uint16_t(0x7c00));  // rounds to infinity
  CHECK_EQ(float_to_half(-0.0), std::uint16_t(0x8000));
  CHECK_EQ(float_to_half(std::nan("")), std::uint16_t(0x7e00));
  // ties to even: 1 + 2^-11 lies halfway between 1 and 1 + 2^-10
  CHECK_EQ(float_to_half(1.0 + std::ldexp(1.0, -11)), std::uint16_t(0x3c00));
  CHECK_EQ(float_to_half(1.0 + 3 * std::ldexp(1.0, -11)), std::uint16_t(0x3c02));
}

TEST("prim: range checks") {
  CHECK_EQ(check_prim(-1, Prim::i8), i128(-1));
  CHECK_THROWS(check_prim(-1, Prim::u64), Range);
  CHECK_THROWS(check_prim(static_cast<i128>(1) << 56, Prim::u56), Range);
}

// ── strings ────────────────────────────────────────────────────────────────────

TEST("strings: decode every encoding") {
  const std::uint8_t latin[] = {'a', 0xe9};
  CHECK_EQ(decode_string(latin, 2, Encoding::latin1, true, 0), std::string("a\xc3\xa9"));
  const std::uint8_t u16[] = {0x3d, 0xd8, 0x00, 0xde};  // U+1F600 as a surrogate pair (LE)
  CHECK_EQ(decode_string(u16, 2, Encoding::utf16, true, 0), std::string("\xf0\x9f\x98\x80"));
  const std::uint8_t u32[] = {0, 0, 0, 0x41};
  CHECK_EQ(decode_string(u32, 1, Encoding::utf32, false, 0), std::string("A"));
}

TEST("strings: invalid input is CHECK on read") {
  const std::uint8_t bad8[] = {0xc3, 0x28};
  CHECK_THROWS(decode_string(bad8, 2, Encoding::utf8, true, 0), Check);
  const std::uint8_t surrogate8[] = {0xed, 0xa0, 0x80};
  CHECK_THROWS(decode_string(surrogate8, 3, Encoding::utf8, true, 0), Check);
  const std::uint8_t ascii[] = {0x80};
  CHECK_THROWS(decode_string(ascii, 1, Encoding::ascii, true, 0), Check);
  const std::uint8_t lone[] = {0x00, 0xdc};
  CHECK_THROWS(decode_string(lone, 1, Encoding::utf16, true, 0), Check);
}

TEST("strings: encode and its INPUT errors") {
  CHECK_EQ(encode_string("\xc3\xa9", Encoding::latin1, true), (Bytes{0xe9}));
  CHECK_EQ(encode_string("\xf0\x9f\x98\x80", Encoding::utf16, false), (Bytes{0xd8, 0x3d, 0xde, 0x00}));
  CHECK_THROWS(encode_string(std::string("a\0b", 3), Encoding::utf8, true), Input);
  CHECK_THROWS(encode_string("\xc3\xa9", Encoding::ascii, true), Input);
  CHECK_THROWS(encode_string("\xed\xa0\x80", Encoding::utf16, true), Input);  // WTF-8 lone surrogate
  CHECK_THROWS(encode_string("\xff", Encoding::utf8, true), Input);
}

TEST("strings: code units per encoding") {
  std::string s = "a\xc3\xa9\xf0\x9f\x98\x80";  // a, é, 😀
  CHECK_EQ(code_units(s, Encoding::utf8), std::int64_t(7));
  CHECK_EQ(code_units(s, Encoding::utf16), std::int64_t(4));
  CHECK_EQ(code_units(s, Encoding::utf32), std::int64_t(3));
  CHECK_EQ(encoded_bytes(s, Encoding::utf16), std::int64_t(8));
}

// ── JSON ───────────────────────────────────────────────────────────────────────

TEST("json: parse and dump round trip with key order") {
  Json j = Json::parse(R"({"b":1,"a":[true,null,"x\n"],"c":{"d":-0.5}})");
  CHECK_EQ(j.dump(), std::string(R"({"b":1,"a":[true,null,"x\n"],"c":{"d":-0.5}})"));
  CHECK(j.find("a")->as_array()[0].as_bool());
}

TEST("json: escapes, surrogate pairs and lone surrogates") {
  Json j = Json::parse(R"(["😀","é","\ud800"])");
  CHECK_EQ(j.as_array()[0].as_string(), std::string("\xf0\x9f\x98\x80"));
  CHECK_EQ(j.as_array()[1].as_string(), std::string("\xc3\xa9"));
  CHECK_EQ(j.as_array()[2].as_string(), std::string("\xed\xa0\x80"));
  CHECK_EQ(Json(std::string("\xed\xa0\x80")).dump(), std::string(R"("\ud800")"));
}

TEST("json: numbers print shortest") {
  CHECK_EQ(Json(0.1).dump(), std::string("0.1"));
  CHECK_EQ(Json(static_cast<double>(0.1f)).dump(), std::string("0.10000000149011612"));
  CHECK_EQ(Json(281474976710655.0).dump(), std::string("281474976710655"));
}

TEST("json: malformed text is INPUT") {
  CHECK_THROWS(Json::parse("{"), Input);
  CHECK_THROWS(Json::parse("[1,]"), Input);
  CHECK_THROWS(Json::parse("1 2"), Input);
}

TEST("json: canonical conversions") {
  CHECK_EQ(float_to_json(-0.0).as_string(), std::string("-0"));
  CHECK(std::isnan(float_from_json(Json("NaN"))));
  CHECK_THROWS(int_from_json(Json(1.5)), Range);
  CHECK_THROWS(int_from_json(Json("1")), Input);
  CHECK_EQ(big_from_json(Json("-9223372036854775808")), static_cast<i128>(INT64_MIN));
  CHECK_EQ(to_hex(Bytes{0x0a, 0xff}), std::string("0aff"));
  CHECK_EQ(from_hex("0A ff"), (Bytes{0x0a, 0xff}));
  CHECK_THROWS(from_hex("abc"), Input);
  CHECK_EQ(ptr("/a", "b/c~"), std::string("/a/b~1c~0"));
}

TEST("json: $ref contexts") {
  ToJsonCtx t;
  int x = 0;
  CHECK(!t.ref(&x, "/a").has_value());
  CHECK_EQ(t.ref(&x, "/b")->find("$ref")->as_string(), std::string("/a"));
  FromJsonCtx f;
  auto obj = std::make_shared<int>(5);
  f.enter("/a", obj);
  auto weak = f.deref<int>("/a");  // still in progress: non-owning
  CHECK(weak.get() == obj.get());
  CHECK_EQ(weak.use_count(), long(0));
  f.leave("/a");
  CHECK_EQ(f.deref<int>("/a").use_count(), obj.use_count() + 1);
  CHECK_THROWS(f.deref<int>("/nope"), Input);
}

// ── checksums ──────────────────────────────────────────────────────────────────

TEST("checksums: crc32 and adler32") {
  CHECK_EQ(crc32(std::string_view("123456789")), std::uint32_t(0xcbf43926));
  CHECK_EQ(adler32(std::string_view("Wikipedia")), std::uint32_t(0x11e60398));
}

// ── reader ─────────────────────────────────────────────────────────────────────

TEST("reader: primitives, windows and EOF") {
  Bytes data{1, 2, 3, 4, 5};
  Reader r(data);
  CHECK_EQ(r.u16(true), std::uint16_t(0x0201));
  std::int64_t saved = r.window(2);
  CHECK_EQ(r.u8(), std::uint8_t(3));
  r.close_window(saved, false);
  CHECK_EQ(r.pos, std::int64_t(4));
  CHECK_THROWS(r.u16(true), Eof);
  CHECK_THROWS(r.window(9), Eof);
}

TEST("reader: counts, strings and padding") {
  Bytes data{'h', 'i', 0, 0xcc, 0xcc};
  Reader r(data);
  CHECK_THROWS(r.count(-1), Range);
  CHECK_THROWS(r.count(static_cast<i128>(1) << 60), Eof);
  CHECK_EQ(r.str_until(1, Encoding::utf8, true), std::string("hi"));
  r.pad(std::int64_t(2), Fill(0xcc), true);
  Reader r2(data);
  r2.pos = 3;
  CHECK_THROWS(r2.pad(std::int64_t(2), Fill(0), true), Check);
}

TEST("reader: fixed strings stop at NUL") {
  Bytes data{'a', 0, 'b', 'c'};
  Reader r(data);
  CHECK_EQ(r.str(4, 1, Encoding::utf8, true), std::string("a"));
  CHECK_EQ(r.pos, std::int64_t(4));
}

TEST("reader: identity of targets and cycles") {
  struct Node {
    std::shared_ptr<Node> next;
  };
  Bytes data{0};
  Reader r(data);
  std::shared_ptr<Node> inner;
  auto n = r.target_obj<Node>(0, "Node", [&](Node& o) {
    // A pointer back to the object being read: a non-owning reference (no ownership cycle).
    o.next = r.target_obj<Node>(0, "Node", [](Node&) {});
  });
  CHECK(n->next.get() == n.get());
  CHECK_EQ(n.use_count(), long(2));  // the reader's identity map and `n`
  auto again = r.target_obj<Node>(0, "Node", [](Node&) { throw std::runtime_error("re-read"); });
  CHECK(again.get() == n.get());
  auto other = r.target_obj<Node>(0, "Other", [](Node&) {});
  CHECK(other.get() != n.get());
}

TEST("reader: extern types ask for more bytes") {
  Bytes data{0x80, 0x80, 0x01, 0xff};
  Reader r(data);
  CHECK_EQ(r.extern_read(uleb128, -1), std::uint64_t(1u << 14));
  CHECK_EQ(r.pos, std::int64_t(3));
  Bytes unterminated{0x80, 0x80};
  Reader r2(unterminated);
  CHECK_THROWS(r2.extern_read(uleb128, -1), Eof);
}

// ── writer and layout ──────────────────────────────────────────────────────────

static Bytes write_root(const std::function<LEntry(Writer&)>& f, const Layout* layout = nullptr) {
  return serialize_root(layout, 1, f);
}

TEST("writer: owned pointers place targets after the base in pre-order") {
  Bytes out = write_root([](Writer& w) {
    auto L = std::make_shared<LStruct>();
    Placeable* a = w.target(nullptr, "u8", "a", [&] {
      w.u8(0xaa);
      return LEntry();
    });
    w.pointer(Prim::u8, true, a, false, std::nullopt);
    Placeable* b = w.target(nullptr, "u8", "b", [&] {
      w.u8(0xbb);
      return LEntry();
    });
    w.pointer(Prim::u8, true, b, false, std::nullopt);
    L->set("a", a);
    L->set("b", b);
    return LEntry(L);
  });
  CHECK_EQ(out, (Bytes{2, 3, 0xaa, 0xbb}));
}

TEST("writer: shared objects are placed once") {
  int shared = 0;
  Bytes out = write_root([&](Writer& w) {
    auto L = std::make_shared<LStruct>();
    auto arr = std::make_shared<LArray>();
    for (int i = 0; i < 2; i++) {
      Placeable* p = w.target(&shared, "T", "p", [&] {
        w.u8(7);
        return LEntry();
      });
      w.pointer(Prim::u8, true, p, false, std::nullopt);
      arr->push(p);
    }
    L->set("ps", arr);
    return LEntry(L);
  });
  CHECK_EQ(out, (Bytes{2, 2, 7}));
}

TEST("writer: layout items pull targets out and align them") {
  Layout layout{layout_item({"b"}, {layout_align(4)}), layout_item({"a"})};
  Bytes out = write_root(
      [](Writer& w) {
        auto L = std::make_shared<LStruct>(nullptr);
        Placeable* a = w.target(nullptr, "u8", "a", [&] {
          w.u8(0xaa);
          return LEntry();
        });
        w.pointer(Prim::u8, true, a, false, std::nullopt);
        Placeable* b = w.target(nullptr, "u8", "b", [&] {
          w.u8(0xbb);
          return LEntry();
        });
        w.pointer(Prim::u8, true, b, false, std::nullopt);
        L->set("a", a);
        L->set("b", b);
        return LEntry(L);
      },
      &layout);
  // base (2 bytes), b aligned to 4, then a
  CHECK_EQ(out, (Bytes{5, 4, 0, 0, 0xbb, 0xaa}));
}

TEST("writer: instance layouts and their range checks") {
  auto write = [](std::int64_t align) {
    return write_root([&](Writer& w) {
      auto L = std::make_shared<LStruct>();
      L->own({layout_item({"a"}, {layout_align(layout_alignment(align))})});
      Placeable* a = w.target(nullptr, "u8", "a", [&] {
        w.u8(0xaa);
        return LEntry();
      });
      w.pointer(Prim::u8, true, a, false, std::nullopt);
      L->set("a", a);
      return LEntry(L);
    });
  };
  // A null root layout takes the root struct's own.
  CHECK_EQ(write(4), (Bytes{4, 0, 0, 0, 0xaa}));
  CHECK_EQ(write(1), (Bytes{1, 0xaa}));
  CHECK_THROWS(write(0), Range);
  CHECK_THROWS(layout_padding(-1), Range);
  CHECK_EQ(layout_padding(0), 0);
}

TEST("writer: fixed placements overlap with OVERLAP") {
  CHECK_THROWS(write_root([](Writer& w) {
                 w.u8(0);
                 PlaceOptions o;
                 o.fixed = 0;
                 w.place("x", [&] {
                   w.u8(1);
                   return LEntry();
                 }, o);
                 return LEntry();
               }),
               Overlap);
}

TEST("writer: placement constraints") {
  Bytes out = write_root([](Writer& w) {
    w.u8(9);
    PlaceOptions o;
    o.constraint = Constraint{4, 1};
    Placeable* p = w.place("x", [&] {
      w.u8(1);
      return LEntry();
    }, o);
    (void)p;
    return LEntry();
  });
  CHECK_EQ(out, (Bytes{9, 1}));
  Bytes out2 = write_root([](Writer& w) {
    w.u8(9);
    w.u8(9);
    PlaceOptions o;
    o.constraint = Constraint{4, 1};
    w.place("x", [&] {
      w.u8(1);
      return LEntry();
    }, o);
    return LEntry();
  });
  CHECK_EQ(out2, (Bytes{9, 9, 0, 0, 0, 1}));
}

TEST("writer: fixups after layout and sizes") {
  Bytes out = write_root([](Writer& w) {
    auto e = std::make_shared<Extent>(nullptr, 0);
    w.defer_prim(Prim::u16, true, [e] { return static_cast<i128>(e->size()); });
    w.open(e);
    w.bytes(Bytes{1, 2, 3});
    w.close(e);
    return LEntry();
  });
  CHECK_EQ(out, (Bytes{3, 0, 1, 2, 3}));
}

TEST("writer: deferred values are range checked with the field's path") {
  Frame fr;
  fr.field = "n";
  bool caught = false;
  try {
    write_root([&](Writer& w) {
      FrameScope fs(w, fr);
      w.defer_prim(Prim::u8, true, [] { return i128(300); });
      return LEntry();
    });
  } catch (const Error& e) {
    caught = true;
    CHECK(e.code == ErrorCode::Range);
    CHECK_EQ(format_path(e.path), std::string("n"));
  }
  CHECK(caught);
}

TEST("writer: @ref resolves by identity, then by equal encoding") {
  int obj = 0;
  Bytes out = write_root([&](Writer& w) {
    std::int64_t s = w.offset();
    w.u8(0x11);
    w.ref_site("T", s, &obj);
    s = w.offset();
    w.u8(0x22);
    w.ref_site("T", s, nullptr);
    w.ref_pointer(Prim::u8, true, "T", false, &obj, [] { return Bytes{0x99}; }, false, std::nullopt);
    w.ref_pointer(Prim::u8, true, "T", false, nullptr, [] { return Bytes{0x22}; }, false, std::nullopt);
    return LEntry();
  });
  CHECK_EQ(out, (Bytes{0x11, 0x22, 0, 1}));
  CHECK_THROWS(write_root([&](Writer& w) {
                 w.ref_pointer(Prim::u8, true, "T", false, nullptr, [] { return Bytes{0x33}; }, false, std::nullopt);
                 return LEntry();
               }),
               Ref);
}

TEST("writer: strings and padding") {
  Bytes out = write_root([](Writer& w) {
    w.str("ab", 1, Encoding::utf8, true, Writer::StrMode::Count, 4);
    w.str("c", 2, Encoding::utf16, false, Writer::StrMode::Until);
    w.align(4, Fill(0xff));
    return LEntry();
  });
  CHECK_EQ(out, (Bytes{'a', 'b', 0, 0, 0, 'c', 0, 0}));
  CHECK_THROWS(write_root([](Writer& w) {
                 w.str("abc", 1, Encoding::utf8, true, Writer::StrMode::Count, 2);
                 return LEntry();
               }),
               Input);
}

// ── codecs ─────────────────────────────────────────────────────────────────────

struct Upper {
  Bytes decode(BytesView in, const CodecCtx&) const {
    Bytes out(in.begin(), in.end());
    for (auto& b : out) b = static_cast<std::uint8_t>(b - 0x20);
    return out;
  }
  Bytes encode(BytesView in, const CodecCtx&) const {
    Bytes out(in.begin(), in.end());
    for (auto& b : out) b = static_cast<std::uint8_t>(b + 0x20);
    return out;
  }
};

struct Failing {
  Bytes decode(BytesView, const CodecCtx&) const { throw std::runtime_error("boom"); }
  std::future<Bytes> encode(BytesView in, const CodecCtx&) const {
    Bytes copy(in.begin(), in.end());
    return std::async(std::launch::deferred, [copy] { return copy; });
  }
};

TEST("codec: calls, futures and CODEC errors") {
  CodecCtx ctx;
  Bytes in{'a', 'b'};
  CHECK_EQ(codec_decode(Upper{}, "upper", in, ctx, false, 0).output, (Bytes{'A', 'B'}));
  CHECK_THROWS(codec_decode(Failing{}, "failing", in, ctx, false, 0), Codec);
  CHECK_EQ(codec_encode(Failing{}, "failing", in, ctx), in);
}

TEST("codec: reuse only when the plain encoding is unchanged") {
  Meta m;
  m.remember("S.f#1", Bytes{1, 2, 3}, Bytes{9});
  Meta copy = m;
  CHECK(copy.reuse("S.f#1", Bytes{9}) != nullptr);
  CHECK(copy.reuse("S.f#1", Bytes{8}) == nullptr);
  CHECK(copy.reuse("S.g#1", Bytes{9}) == nullptr);
  Frame fr;
  fr.idx[0] = 3;
  CHECK_EQ(slot_key("S.f#1", fr), std::string("S.f#1/3"));
}

TEST("codec: streams") {
  Bytes s{1, 2, 3, 4};
  CHECK_EQ(slice_stream(s, 1, 3), (Bytes{2, 3}));
  CHECK_THROWS(slice_stream(s, 3, 5), Eof);
  CHECK_EQ(split_by_sizes(s, {1, 3})[1], (Bytes{2, 3, 4}));
  CHECK_THROWS(split_by_sizes(s, {1, 2}), Derive);
}

// ── helpers ────────────────────────────────────────────────────────────────────

TEST("helpers: LEB128") {
  CHECK_EQ(uleb128.write(624485), (Bytes{0xe5, 0x8e, 0x26}));
  CHECK_EQ(sleb128.write(-123456), (Bytes{0xc0, 0xbb, 0x78}));
  Bytes b{0xc0, 0xbb, 0x78};
  CHECK_EQ(sleb128.read(b), std::int64_t(-123456));
  Bytes long11(11, 0x80);
  CHECK_THROWS(uleb128.size(long11), Check);
}

TEST("helpers: aggregates and lookups") {
  std::vector<std::uint16_t> v{3, 1, 2};
  CHECK_EQ(sum_int(v), i128(6));
  CHECK_EQ(min_of(v), std::uint16_t(1));
  CHECK_EQ(max_of(v), std::uint16_t(3));
  CHECK_THROWS(min_of(std::vector<int>{}), Range);
  std::vector<std::string> names{"a", "b"};
  CHECK_EQ(index_of(names, std::string("b")), std::int64_t(1));
  CHECK_THROWS(index_of(names, std::string("c")), Input);
  CHECK_THROWS(at(names, 2), Range);
  CHECK(regex_match("v1.23", "v\\d\\.\\d{1,2}"));
  CHECK(!regex_match("v1.234", "v\\d\\.\\d{1,2}"));
  CHECK_EQ(bits_of(-1, 4, true), std::uint64_t(15));
  CHECK_THROWS(bits_of(16, 4, false), Range);
}

int main(int argc, char** argv) { return yt::run_all(argc, argv); }
