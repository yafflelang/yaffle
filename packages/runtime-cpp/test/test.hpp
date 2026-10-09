// A tiny test runner: TEST(name) { … } with CHECK / CHECK_EQ / CHECK_THROWS.
#pragma once

#include <cstdio>
#include <functional>
#include <sstream>
#include <string>
#include <vector>

#include <yaffle/yaffle.hpp>

namespace yt {

struct Test {
  const char* name;
  std::function<void()> fn;
};

inline std::vector<Test>& registry() {
  static std::vector<Test> tests;
  return tests;
}

struct Register {
  Register(const char* name, std::function<void()> fn) { registry().push_back({name, std::move(fn)}); }
};

struct Failure {
  std::string message;
};

inline int failures = 0;

template <class T>
std::string show(const T& v) {
  std::ostringstream ss;
  if constexpr (std::is_same_v<T, yaffle::i128>)
    ss << yaffle::to_string(v);
  else if constexpr (std::is_same_v<T, yaffle::Bytes>)
    ss << yaffle::to_hex(v);
  else if constexpr (std::is_enum_v<T>)
    ss << static_cast<long long>(v);
  else if constexpr (std::is_same_v<T, std::uint8_t> || std::is_same_v<T, std::int8_t>)
    ss << static_cast<int>(v);
  else
    ss << v;
  return ss.str();
}

inline int run_all(int argc, char** argv) {
  std::string filter = argc > 1 ? argv[1] : "";
  int run = 0;
  for (const auto& t : registry()) {
    if (!filter.empty() && std::string(t.name).find(filter) == std::string::npos) continue;
    run++;
    try {
      t.fn();
    } catch (const Failure& f) {
      failures++;
      std::printf("FAIL %s: %s\n", t.name, f.message.c_str());
    } catch (const std::exception& e) {
      failures++;
      std::printf("FAIL %s: unexpected exception %s\n", t.name, e.what());
    }
  }
  std::printf("%d tests, %d failed\n", run, failures);
  return failures ? 1 : 0;
}

}  // namespace yt

#define YT_CAT2(a, b) a##b
#define YT_CAT(a, b) YT_CAT2(a, b)
#define TEST(name)                                                       \
  static void YT_CAT(test_fn_, __LINE__)();                              \
  static yt::Register YT_CAT(test_reg_, __LINE__)(name, YT_CAT(test_fn_, __LINE__)); \
  static void YT_CAT(test_fn_, __LINE__)()

#define CHECK(cond)                                                                            \
  do {                                                                                         \
    if (!(cond)) throw yt::Failure{std::string(__FILE__ ":") + std::to_string(__LINE__) + ": " #cond}; \
  } while (0)

#define CHECK_EQ(a, b)                                                                              \
  do {                                                                                              \
    auto va_ = (a);                                                                               \
    auto vb_ = (b);                                                                               \
    if (!(va_ == vb_))                                                                              \
      throw yt::Failure{std::string(__FILE__ ":") + std::to_string(__LINE__) + ": " #a " == " #b " (" + \
                        yt::show(va_) + " vs " + yt::show(vb_) + ")"};                              \
  } while (0)

/// Expects a yaffle::Error with the given code.
#define CHECK_THROWS(expr, code_)                                                                     \
  do {                                                                                                \
    bool threw_ = false;                                                                              \
    try {                                                                                             \
      (void)(expr);                                                                                   \
    } catch (const yaffle::Error& e_) {                                                               \
      threw_ = true;                                                                                  \
      if (e_.code != yaffle::ErrorCode::code_)                                                        \
        throw yt::Failure{std::string(__FILE__ ":") + std::to_string(__LINE__) + ": expected " #code_ \
                          ", got " + e_.what()};                                                      \
    }                                                                                                 \
    if (!threw_)                                                                                      \
      throw yt::Failure{std::string(__FILE__ ":") + std::to_string(__LINE__) + ": " #expr " did not throw"}; \
  } while (0)
