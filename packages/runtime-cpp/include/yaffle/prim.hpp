// Primitive encodings: N-byte integers (1..8 bytes, both byte orders) and IEEE half/single/double.
#pragma once

#include "core.hpp"

namespace yaffle {

enum class Prim : std::uint8_t {
  u8, u16, u24, u32, u40, u48, u56, u64,
  i8, i16, i24, i32, i40, i48, i56, i64,
  f16, f32, f64
};

struct PrimInfo {
  int size;
  int bits;
  bool is_signed;
  bool is_float;
};

constexpr PrimInfo prim_info(Prim p) {
  switch (p) {
    case Prim::u8: return {1, 8, false, false};
    case Prim::u16: return {2, 16, false, false};
    case Prim::u24: return {3, 24, false, false};
    case Prim::u32: return {4, 32, false, false};
    case Prim::u40: return {5, 40, false, false};
    case Prim::u48: return {6, 48, false, false};
    case Prim::u56: return {7, 56, false, false};
    case Prim::u64: return {8, 64, false, false};
    case Prim::i8: return {1, 8, true, false};
    case Prim::i16: return {2, 16, true, false};
    case Prim::i24: return {3, 24, true, false};
    case Prim::i32: return {4, 32, true, false};
    case Prim::i40: return {5, 40, true, false};
    case Prim::i48: return {6, 48, true, false};
    case Prim::i56: return {7, 56, true, false};
    case Prim::i64: return {8, 64, true, false};
    case Prim::f16: return {2, 16, false, true};
    case Prim::f32: return {4, 32, false, true};
    case Prim::f64: return {8, 64, false, true};
  }
  return {0, 0, false, false};
}

const char* prim_name(Prim p) noexcept;

constexpr i128 prim_min(Prim p) {
  PrimInfo i = prim_info(p);
  return i.is_signed ? -(static_cast<i128>(1) << (i.bits - 1)) : 0;
}
constexpr i128 prim_max(Prim p) {
  PrimInfo i = prim_info(p);
  return i.is_signed ? (static_cast<i128>(1) << (i.bits - 1)) - 1 : (static_cast<i128>(1) << i.bits) - 1;
}

/// Checks that an integer fits a primitive (RANGE otherwise).
inline i128 check_prim(i128 v, Prim p, const char* what = nullptr) {
  if (v < prim_min(p) || v > prim_max(p))
    fail(ErrorCode::Range, to_string(v) + " is out of range for " + (what ? what : prim_name(p)));
  return v;
}

// ── raw access ──────────────────────────────────────────────────────────────────

/// Reads an unsigned integer of `size` bytes (1..8).
inline std::uint64_t load_uint(const std::uint8_t* p, int size, bool le) {
  std::uint64_t v = 0;
  if (le)
    for (int i = size - 1; i >= 0; i--) v = (v << 8) | p[i];
  else
    for (int i = 0; i < size; i++) v = (v << 8) | p[i];
  return v;
}

/// Writes the low `size` bytes of `v`.
inline void store_uint(std::uint8_t* p, int size, std::uint64_t v, bool le) {
  for (int i = 0; i < size; i++) {
    p[le ? i : size - 1 - i] = static_cast<std::uint8_t>(v & 0xff);
    v >>= 8;
  }
}

/// Sign-extends the low `bits` bits.
inline std::int64_t sign_extend(std::uint64_t v, int bits) {
  if (bits >= 64) return static_cast<std::int64_t>(v);
  std::uint64_t m = std::uint64_t(1) << (bits - 1);
  v &= (std::uint64_t(1) << bits) - 1;
  return static_cast<std::int64_t>((v ^ m) - m);
}

// ── half precision ──────────────────────────────────────────────────────────────

/// IEEE 754 binary16 bits → value.
float half_to_float(std::uint16_t h);
/// Value → binary16 bits, rounding to nearest even (directly from the double). NaN → 0x7e00.
std::uint16_t float_to_half(double v);

inline float bits_to_f32(std::uint32_t u) { return std::bit_cast<float>(u); }
inline std::uint32_t f32_to_bits(float f) { return std::bit_cast<std::uint32_t>(f); }
inline double bits_to_f64(std::uint64_t u) { return std::bit_cast<double>(u); }
inline std::uint64_t f64_to_bits(double f) { return std::bit_cast<std::uint64_t>(f); }

/// Encodes any primitive whose value is given as an integer (ints) or a double (floats).
void store_prim(std::uint8_t* p, Prim k, i128 v, bool le);
void store_prim_float(std::uint8_t* p, Prim k, double v, bool le);

}  // namespace yaffle
