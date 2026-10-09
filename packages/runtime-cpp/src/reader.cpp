// The read context (see reader.hpp).
#include "yaffle/yaffle.hpp"

namespace yaffle {

Reader::Reader(BytesView d, bool s)
    : strict(s), end_(static_cast<std::int64_t>(d.size())), wptr_(d.data()), wend_(static_cast<std::int64_t>(d.size())) {}

Reader::Reader(StorePtr st, bool s, std::int64_t out) : strict(s), outer(out), store_(std::move(st)) {
  if (auto w = store_->whole()) {
    // In memory: one window over everything.
    wown_ = w;
    wptr_ = w->data();
    wend_ = static_cast<std::int64_t>(w->size());
    end_ = wend_;
  } else {
    end_ = store_->lazy_size() ? kUnknownEnd : store_->size();
  }
}

void Reader::refill(std::int64_t at, std::int64_t n) {
  if (!store_ || at < 0 || !store_->covers(at + n)) {
    std::int64_t saved = pos;
    pos = at;
    struct Back {
      std::int64_t& p;
      std::int64_t v;
      ~Back() { p = v; }
    } back{pos, saved};
    eof(n);
  }
  // Refill up to the end of the region when it is near, else a store-sized chunk.
  std::int64_t max = std::max<std::int64_t>(n, 1 << 16);
  if (end_ != kUnknownEnd) max = std::max(n, std::min(max, end_ - at));
  Chunk c;
  try {
    c = store_->get(at, n, max);
  } catch (Error& e) {
    if (e.offset < 0) e.offset = this->at(at);
    throw;
  }
  wown_ = std::move(c.owner);
  wptr_ = c.data;
  wstart_ = c.start;
  wend_ = c.end();
}

void Reader::eof(std::int64_t n) const {
  fail(ErrorCode::Eof, "need " + std::to_string(n) + " bytes at " + hex(pos) + ", region ends at " +
                           (end_ == kUnknownEnd ? std::string("the end of the data") : hex(end_)));
}

std::int64_t Reader::window(std::int64_t n) {
  std::int64_t saved = end_;
  if (n < 0) fail(ErrorCode::Range, "invalid size " + std::to_string(n));
  if (!has(n))
    fail(ErrorCode::Eof, "size " + std::to_string(n) + " at " + hex(pos) + " exceeds the region end" +
                             (saved == kUnknownEnd ? std::string() : " " + hex(saved)));
  end_ = pos + n;
  return saved;
}

void Reader::close_window(std::int64_t saved, bool strict_pad) {
  std::int64_t left = end_ - pos;
  if (left > 0) pad(left, Fill(0), strict_pad);
  end_ = saved;
}

BytesView Reader::peek_bytes(std::int64_t start, std::int64_t stop) {
  if (start < 0 || start > stop || !covers(stop))
    fail_at(ErrorCode::Eof, "range [" + hex(start) + ", " + hex(stop) + ") is outside the data", start);
  if (start < wstart_ || stop > wend_) refill(start, stop - start);
  return BytesView(wptr_ + (start - wstart_), static_cast<std::size_t>(stop - start));
}

std::int64_t Reader::count(i128 v, int unit, const char* what) {
  if (v < 0) fail(ErrorCode::Range, std::string(what) + " " + to_string(v) + " is negative");
  const i128 lim = static_cast<i128>(1) << 53;
  if (v > lim || (unit > 0 && v * unit > lim))
    fail(ErrorCode::Eof, std::string(what) + " " + to_string(v) + " needs more than the " +
                             std::to_string(room()) + " bytes left");
  return static_cast<std::int64_t>(v);
}

std::int64_t Reader::find_unit(std::int64_t unit, std::uint8_t byte) {
  // Searches window by window (a store reader refills as it goes), unit-aligned from pos.
  std::int64_t at = pos;
  for (;;) {
    if (!has(at - pos + unit)) return -1;
    if (at < wstart_ || at + unit > wend_) refill(at, unit);
    std::int64_t stop = wend_;
    if (end_ != kUnknownEnd) stop = std::min(stop, end_);
    const std::uint8_t* w = wptr_ + (at - wstart_);
    std::int64_t n = (stop - at) / unit;
    if (unit == 1) {
      const void* hit = n > 0 ? std::memchr(w, byte, static_cast<std::size_t>(n)) : nullptr;
      if (hit) return at + (static_cast<const std::uint8_t*>(hit) - w) - pos;
    } else {
      std::int64_t i = find_nul_unit(w, n, unit);
      if (i >= 0) return at + i * unit - pos;
    }
    at += std::max<std::int64_t>(n, 1) * unit;
  }
}

Bytes Reader::bytes_until(i128 term) {
  std::uint8_t t = static_cast<std::uint8_t>(static_cast<std::uint64_t>(term) & 0xff);
  std::int64_t n = find_unit(1, t);
  if (n < 0) fail(ErrorCode::Eof, "terminator not found before the region end");
  need(n + 1);
  const std::uint8_t* p = here();
  Bytes out(p, p + n);
  pos += n + 1;
  return out;
}

std::string Reader::str(std::int64_t n_units, int unit, Encoding enc, bool le) {
  if (n_units < 0 || n_units > (std::numeric_limits<std::int64_t>::max() / 8) || !has(n_units * unit))
    eof(n_units * unit);
  std::int64_t n = n_units * unit;
  need(n);
  const std::uint8_t* p = here();
  std::int64_t nul = find_nul_unit(p, n_units, unit);
  std::string s = decode_string(p, nul < 0 ? n_units : nul, enc, le, at(pos));
  pos += n;
  return s;
}

std::string Reader::str_until(int unit, Encoding enc, bool le) {
  std::int64_t i = find_unit(unit, 0);
  if (i < 0) fail(ErrorCode::Eof, "terminator not found before the region end");
  std::string s = str(i / unit, unit, enc, le);
  pos += unit;
  return s;
}

void Reader::pad(std::int64_t n, const Fill& fill, bool strict_pad) {
  if (n < 0) fail(ErrorCode::Range, "invalid padding length " + std::to_string(n));
  need(n);
  if (strict_pad) {
    const std::uint8_t* p = here();
    for (std::int64_t i = 0; i < n; i++) {
      std::uint8_t want = fill.at(i);
      if (p[i] != want)
        fail_at(ErrorCode::Check, "padding byte " + hex(p[i]) + " is not " + hex(want), pos + i);
    }
  }
  pos += n;
}

void Reader::align_at(i128 to, std::int64_t origin, i128 offset, const Fill& fill, bool strict_pad) {
  if (to <= 0 || to > (static_cast<i128>(1) << 62)) fail(ErrorCode::Range, "invalid alignment " + to_string(to));
  if (offset < -(static_cast<i128>(1) << 62) || offset > (static_cast<i128>(1) << 62))
    fail(ErrorCode::Range, "invalid alignment offset " + to_string(offset));
  std::int64_t t = static_cast<std::int64_t>(to);
  std::int64_t rel = (((pos - origin + static_cast<std::int64_t>(offset)) % t) + t) % t;
  pad((t - rel) % t, fill, strict_pad);
}

void Reader::pad_until(std::int64_t start, i128 size, const Fill& fill, bool strict_pad) {
  std::int64_t used = pos - start;
  if (size < used)
    fail_at(ErrorCode::Check, "content of " + std::to_string(used) + " bytes exceeds padUntil(" + to_string(size) + ")",
            start);
  pad(size - used, fill, strict_pad);
}

void Reader::union_fail(std::vector<Error> errors, std::int64_t start) const {
  std::string msg = "no variant matched (";
  for (std::size_t i = 0; i < errors.size(); i++) {
    if (i) msg += "; ";
    msg += errors[i].what();
  }
  msg += ")";
  Error e(ErrorCode::Union, msg, at(start));
  e.causes = std::move(errors);
  throw e;
}

}  // namespace yaffle
