// Byte transforms (`@via`): calling host codecs, codec reuse for byte-exact rebuilds
// (docs/IR.md §3.6), and virtual-stream helpers.
//
// Host shape (docs/targets/cpp.md): an object with
//   Bytes decode(BytesView input, const CodecCtx& ctx) const;   // or Decoded for @streaming
//   Bytes encode(BytesView input, const CodecCtx& ctx) const;
// `async codec`s may return std::future<Bytes> (std::future<Decoded>) instead; the runtime waits.
// Any exception other than yaffle::Error is a CODEC error.
#pragma once

#include <future>

#include "core.hpp"

namespace yaffle {

/// A codec argument (u8 → int, u64 → int, u8[n] → bytes, …).
struct Arg {
  std::variant<std::monostate, i128, double, bool, std::string, Bytes> v;
  Arg() = default;
  template <class T, std::enable_if_t<std::is_integral_v<T> && !std::is_same_v<T, bool>, int> = 0>
  Arg(T x) : v(static_cast<i128>(x)) {}
  Arg(i128 x) : v(x) {}
  Arg(double x) : v(x) {}
  Arg(float x) : v(static_cast<double>(x)) {}
  Arg(bool x) : v(x) {}
  Arg(std::string x) : v(std::move(x)) {}
  Arg(Bytes x) : v(std::move(x)) {}

  bool is_int() const { return std::holds_alternative<i128>(v); }
  i128 as_int() const;
  std::uint64_t as_u64() const { return static_cast<std::uint64_t>(as_int()); }
  double as_double() const;
  const Bytes& as_bytes() const;
  const std::string& as_string() const;
};

struct CodecCtx {
  std::vector<Arg> args;
  /// The decoded size, when an inner `@size` layer gives it.
  std::optional<std::size_t> output_size;
  /// For `@ranged` codecs: the slice's offset within the encoded region.
  std::optional<std::size_t> position;
};

/// Result of a `@streaming` decode: output plus the encoded bytes consumed.
struct Decoded {
  Bytes output;
  std::size_t consumed = 0;
};

[[noreturn]] void codec_fail(const char* name, const char* op, const char* what, std::int64_t offset);

namespace detail {
template <class T>
struct is_future : std::false_type {};
template <class T>
struct is_future<std::future<T>> : std::true_type {};
template <class T>
auto settle(T&& v) {
  if constexpr (is_future<std::decay_t<T>>::value)
    return v.get();
  else
    return std::forward<T>(v);
}
}  // namespace detail

/// Decodes `input` (the region window, or the rest of the region for streaming codecs).
template <class C>
Decoded codec_decode(const C& codec, const char* name, BytesView input, const CodecCtx& ctx,
                     bool streaming, std::int64_t offset) {
  try {
    auto out = detail::settle(codec.decode(input, ctx));
    using R = std::decay_t<decltype(out)>;
    if constexpr (std::is_same_v<R, Decoded>) {
      if (out.consumed > input.size())
        throw Error(ErrorCode::Codec,
                    std::string("streaming codec ") + name + " consumed " + std::to_string(out.consumed) +
                        " of " + std::to_string(input.size()) + " bytes",
                    offset);
      return out;
    } else {
      static_assert(std::is_same_v<R, Bytes>, "codec decode must return Bytes or Decoded");
      if (streaming)
        throw Error(ErrorCode::Codec, std::string("streaming codec ") + name + " must return Decoded",
                    offset);
      Decoded d;
      d.output = std::move(out);
      d.consumed = input.size();
      return d;
    }
  } catch (Error& e) {
    if (e.offset < 0) e.offset = offset;
    throw;
  } catch (const std::exception& e) {
    codec_fail(name, "decode", e.what(), offset);
  }
}

template <class C>
Bytes codec_encode(const C& codec, const char* name, BytesView input, const CodecCtx& ctx) {
  try {
    return detail::settle(codec.encode(input, ctx));
  } catch (const Error&) {
    throw;
  } catch (const std::exception& e) {
    codec_fail(name, "encode", e.what(), -1);
  }
}

/// Calls a host function (extern fn); host failures are CODEC errors.
template <class F, class... A>
auto call_host(const char* name, F&& f, A&&... args) -> decltype(f(std::forward<A>(args)...)) {
  try {
    return f(std::forward<A>(args)...);
  } catch (const Error&) {
    throw;
  } catch (const std::exception& e) {
    fail(ErrorCode::Codec, std::string("extern ") + name + ": " + e.what());
  }
}

// ── reuse ───────────────────────────────────────────────────────────────────────

/// Hidden per-struct metadata of parsed values: the original encoded bytes of every codec region
/// (keyed by slot and array indices) and a private copy of their decoded bytes. Copies of a struct
/// share it. When a struct is serialized and a region's plain encoding is unchanged, the original
/// encoded bytes are reused instead of re-encoding (byte-exact rebuilds).
class Meta {
 public:
  void remember(std::string key, BytesView encoded, BytesView decoded);
  /// The original encoded bytes if the plain encoding is unchanged.
  const Bytes* reuse(const std::string& key, BytesView plain) const;
  bool empty() const { return !origins_ || origins_->empty(); }
  /// Every struct compares equal on its metadata.
  bool operator==(const Meta&) const { return true; }

 private:
  struct Origin {
    Bytes encoded;
    Bytes decoded;
  };
  std::shared_ptr<std::unordered_map<std::string, Origin>> origins_;
};

/// A reuse key: the slot plus the array indices of the frame.
std::string slot_key(const char* slot, const Frame& f);

// ── virtual streams ─────────────────────────────────────────────────────────────

/// `raw[a..b]` (end exclusive; -1 = to the end). EOF when outside the stream.
Bytes slice_stream(const Bytes& s, i128 start, std::optional<i128> stop);

/// Splits `data` into pieces of the given sizes (DERIVE unless they cover it exactly).
std::vector<Bytes> split_by_sizes(BytesView data, const std::vector<std::int64_t>& sizes);

/// One `from raw[start..end]` field's encoding, for `assemble_slices`.
struct SlicePart {
  /// Field name (error messages).
  const char* name;
  std::int64_t start;
  /// Slice end (exclusive); none: to the end of the stream.
  std::optional<std::int64_t> end;
  const Bytes* bytes;
};

/// Write side of stream slices: the sliced bytes are a zero-filled buffer of `length` bytes (none:
/// the largest slice end) with every slice field's encoding written at its start. An encoding
/// longer than its slice, or overlapping slices whose bytes differ, is DERIVE.
Bytes assemble_slices(std::optional<std::int64_t> length, const std::vector<SlicePart>& parts);

}  // namespace yaffle
