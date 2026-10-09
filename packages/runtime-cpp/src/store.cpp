// Byte stores (see store.hpp).
#include "yaffle/store.hpp"

#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>

#include "yaffle/yaffle.hpp"

namespace yaffle {

namespace {

/// A chunk over a buffer (the whole buffer, placed at `start`).
Chunk chunk_of(std::shared_ptr<const Bytes> b, std::int64_t start) {
  Chunk c;
  c.data = b->data();
  c.size = static_cast<std::int64_t>(b->size());
  c.start = start;
  c.owner = std::move(b);
  return c;
}

void need_range(Store& s, std::int64_t off, std::int64_t n) {
  if (off < 0 || n < 0 || !s.covers(off + n))
    fail(ErrorCode::Eof, "bytes [" + hex(off) + ", " + hex(off + n) + ") are outside the data");
}

}  // namespace

// ── Store ──────────────────────────────────────────────────────────────────────

Bytes Store::read(std::int64_t off, std::int64_t n) {
  need_range(*this, off, n);
  Bytes out;
  out.reserve(static_cast<std::size_t>(n));
  std::int64_t at = off;
  while (at < off + n) {
    Chunk c = get(at, 1, off + n - at);
    std::int64_t from = at - c.start;
    std::int64_t take = std::min(c.end(), off + n) - at;
    out.insert(out.end(), c.data + from, c.data + from + take);
    at += take;
  }
  return out;
}

std::shared_ptr<const Bytes> Store::all() {
  if (auto w = whole()) return w;
  return std::make_shared<const Bytes>(read(0, size()));
}

// ── MemStore ───────────────────────────────────────────────────────────────────

Chunk MemStore::get(std::int64_t, std::int64_t, std::int64_t) { return chunk_of(bytes_, 0); }

// ── LazyStore ──────────────────────────────────────────────────────────────────

const std::shared_ptr<const Bytes>& LazyStore::bytes() {
  if (!bytes_) bytes_ = make_();
  return bytes_;
}

Chunk LazyStore::get(std::int64_t, std::int64_t, std::int64_t) { return chunk_of(bytes(), 0); }

// ── BufferLru ──────────────────────────────────────────────────────────────────

std::shared_ptr<const Bytes> BufferLru::get(std::int64_t key) {
  auto it = index_.find(key);
  if (it == index_.end()) return nullptr;
  items_.splice(items_.begin(), items_, it->second);
  return it->second->second;
}

void BufferLru::put(std::int64_t key, std::shared_ptr<const Bytes> value) {
  auto it = index_.find(key);
  if (it != index_.end()) {
    bytes_ -= it->second->second->size();
    items_.erase(it->second);
    index_.erase(it);
  }
  bytes_ += value->size();
  items_.emplace_front(key, std::move(value));
  index_[key] = items_.begin();
  // The latest item is always kept.
  while (items_.size() > 1 && (items_.size() > max_items_ || bytes_ > max_bytes_)) {
    auto& last = items_.back();
    bytes_ -= last.second->size();
    index_.erase(last.first);
    items_.pop_back();
  }
}

void BufferLru::clear() {
  items_.clear();
  index_.clear();
  bytes_ = 0;
}

// ── FileStore ──────────────────────────────────────────────────────────────────

FileStore::FileStore(const std::string& path, std::int64_t block_size, std::size_t cache_blocks)
    : path_(path), block_size_(block_size), cache_(cache_blocks, static_cast<std::size_t>(block_size) * cache_blocks) {
  fd_ = ::open(path.c_str(), O_RDONLY | O_CLOEXEC);
  if (fd_ < 0) fail(ErrorCode::Input, "cannot open " + path + ": " + std::strerror(errno));
  struct stat st {};
  if (::fstat(fd_, &st) != 0) {
    int err = errno;
    ::close(fd_);
    fail(ErrorCode::Input, "cannot stat " + path + ": " + std::strerror(err));
  }
  size_ = static_cast<std::int64_t>(st.st_size);
}

FileStore::~FileStore() {
  if (fd_ >= 0) ::close(fd_);
}

std::shared_ptr<const Bytes> FileStore::block(std::int64_t k) {
  if (auto hit = cache_.get(k)) return hit;
  std::int64_t start = k * block_size_;
  std::int64_t n = std::min(block_size_, size_ - start);
  Bytes b(static_cast<std::size_t>(std::max<std::int64_t>(n, 0)));
  std::int64_t done = 0;
  while (done < n) {
    ssize_t got = ::pread(fd_, b.data() + done, static_cast<std::size_t>(n - done), static_cast<off_t>(start + done));
    if (got < 0) {
      if (errno == EINTR) continue;
      fail(ErrorCode::Input, "cannot read " + path_ + ": " + std::strerror(errno));
    }
    if (got == 0) fail(ErrorCode::Eof, path_ + " ended early (it changed while it was read)");
    done += got;
  }
  reads++;
  bytes_read += n;
  auto p = std::make_shared<const Bytes>(std::move(b));
  cache_.put(k, p);
  return p;
}

Chunk FileStore::get(std::int64_t off, std::int64_t min, std::int64_t) {
  std::int64_t k0 = off / block_size_;
  std::int64_t k1 = (off + std::max<std::int64_t>(min, 1) - 1) / block_size_;
  if (k0 == k1) return chunk_of(block(k0), k0 * block_size_);
  // Spans blocks: assemble them.
  auto out = std::make_shared<Bytes>();
  out->reserve(static_cast<std::size_t>((k1 - k0 + 1) * block_size_));
  for (std::int64_t k = k0; k <= k1; k++) {
    auto b = block(k);
    out->insert(out->end(), b->begin(), b->end());
  }
  return chunk_of(std::move(out), k0 * block_size_);
}

// ── SliceStore ─────────────────────────────────────────────────────────────────

std::int64_t SliceStore::size() {
  if (length_) return *length_;
  return std::max<std::int64_t>(0, parent_->size() - start_);
}

bool SliceStore::covers(std::int64_t end) {
  if (length_) return end <= *length_;
  return parent_->covers(start_ + end);
}

Chunk SliceStore::get(std::int64_t off, std::int64_t min, std::int64_t max) {
  Chunk c = parent_->get(start_ + off, min, max);
  // Clip to the slice.
  std::int64_t lo = std::max(c.start, start_);
  std::int64_t hi = c.end();
  if (length_) hi = std::min(hi, start_ + *length_);
  c.data += lo - c.start;
  c.size = hi - lo;
  c.start = lo - start_;
  return c;
}

// ── OverlayStore ───────────────────────────────────────────────────────────────

void OverlayStore::patch(std::int64_t at, BytesView data) {
  patches_.emplace_back(at, Bytes(data.begin(), data.end()));
  merged_.reset();
}

Chunk OverlayStore::get(std::int64_t off, std::int64_t min, std::int64_t max) {
  if (auto w = whole()) return chunk_of(std::move(w), 0);
  Chunk c = base_->get(off, min, max);
  bool hit = false;
  for (const auto& p : patches_)
    if (p.first < c.end() && c.start < p.first + static_cast<std::int64_t>(p.second.size())) hit = true;
  if (!hit) return c;
  auto copy = std::make_shared<Bytes>(c.data, c.data + c.size);
  for (const auto& p : patches_) {
    for (std::size_t i = 0; i < p.second.size(); i++) {
      std::int64_t at = p.first + static_cast<std::int64_t>(i);
      if (at >= c.start && at < c.end()) (*copy)[static_cast<std::size_t>(at - c.start)] = p.second[i];
    }
  }
  return chunk_of(std::move(copy), c.start);
}

std::shared_ptr<const Bytes> OverlayStore::whole() {
  if (patches_.empty()) return base_->whole();
  if (merged_) return merged_;
  auto w = base_->whole();
  if (!w) return nullptr;
  auto copy = std::make_shared<Bytes>(*w);
  for (const auto& p : patches_) std::copy(p.second.begin(), p.second.end(), copy->begin() + p.first);
  merged_ = std::move(copy);
  return merged_;
}

// ── PieceStore ─────────────────────────────────────────────────────────────────

void PieceStore::learn_until(std::int64_t end) {
  while (starts_.back() < end && static_cast<std::int64_t>(starts_.size()) - 1 < src_.count) {
    std::int64_t k = static_cast<std::int64_t>(starts_.size()) - 1;
    std::optional<std::int64_t> n = src_.length ? src_.length(k) : std::nullopt;
    if (!n) n = static_cast<std::int64_t>(piece(k)->size());
    if (*n < 0) fail(ErrorCode::Range, "piece " + std::to_string(k) + " has a negative length");
    starts_.push_back(starts_.back() + *n);
  }
}

std::int64_t PieceStore::size() {
  learn_until(kUnknownEnd);
  return starts_.back();
}

bool PieceStore::covers(std::int64_t end) {
  learn_until(end);
  return end <= starts_.back();
}

std::int64_t PieceStore::piece_at(std::int64_t off) {
  learn_until(off + 1);
  // starts_[k] <= off < starts_[k + 1]
  auto it = std::upper_bound(starts_.begin(), starts_.end(), off);
  return static_cast<std::int64_t>(it - starts_.begin()) - 1;
}

std::shared_ptr<const Bytes> PieceStore::piece(std::int64_t k) {
  if (auto hit = cache_.get(k)) return hit;
  auto p = src_.decode(k);
  decodes++;
  if (static_cast<std::int64_t>(starts_.size()) > k + 1) {
    std::int64_t known = starts_[static_cast<std::size_t>(k) + 1] - starts_[static_cast<std::size_t>(k)];
    if (known != static_cast<std::int64_t>(p->size()))
      fail(ErrorCode::Codec, "piece " + std::to_string(k) + " decoded to " + std::to_string(p->size()) +
                                 " bytes, its size field says " + std::to_string(known));
  }
  cache_.put(k, p);
  return p;
}

Chunk PieceStore::get(std::int64_t off, std::int64_t min, std::int64_t) {
  std::int64_t k = piece_at(off);
  auto p = piece(k);
  std::int64_t start = starts_[static_cast<std::size_t>(k)];
  if (off + min <= start + static_cast<std::int64_t>(p->size())) return chunk_of(std::move(p), start);
  // Spans pieces: assemble [off, off + min).
  auto out = std::make_shared<Bytes>();
  out->reserve(static_cast<std::size_t>(min));
  std::int64_t at = off;
  while (at < off + min) {
    std::int64_t j = piece_at(at);
    auto q = piece(j);
    std::int64_t s = starts_[static_cast<std::size_t>(j)];
    std::int64_t from = at - s;
    std::int64_t take = std::min<std::int64_t>(static_cast<std::int64_t>(q->size()) - from, off + min - at);
    out->insert(out->end(), q->begin() + from, q->begin() + from + take);
    at += take;
  }
  return chunk_of(std::move(out), off);
}

// ── RangedStore ────────────────────────────────────────────────────────────────

Bytes RangedStore::run(std::int64_t start, std::int64_t n) {
  Bytes enc = enc_->read(start, n);
  Bytes out = decode_(BytesView(enc), static_cast<std::size_t>(start));
  decodes++;
  decoded_bytes += n;
  if (static_cast<std::int64_t>(out.size()) != n)
    fail(ErrorCode::Codec, "ranged codec decoded " + std::to_string(n) + " bytes into " + std::to_string(out.size()));
  return out;
}

std::shared_ptr<const Bytes> RangedStore::block(std::int64_t k) {
  if (auto hit = cache_.get(k)) return hit;
  std::int64_t start = k * block_;
  auto p = std::make_shared<const Bytes>(run(start, std::min(block_, size() - start)));
  cache_.put(k, p);
  return p;
}

Chunk RangedStore::get(std::int64_t off, std::int64_t min, std::int64_t) {
  std::int64_t k0 = off / block_;
  std::int64_t k1 = (off + std::max<std::int64_t>(min, 1) - 1) / block_;
  if (k0 == k1) return chunk_of(block(k0), k0 * block_);
  std::int64_t start = k0 * block_;
  std::int64_t stop = std::min((k1 + 1) * block_, size());
  // Long reads are decoded in one call (not cached).
  if (k1 - k0 + 1 > 8) return chunk_of(std::make_shared<const Bytes>(run(start, stop - start)), start);
  auto out = std::make_shared<Bytes>();
  out->reserve(static_cast<std::size_t>(stop - start));
  for (std::int64_t k = k0; k <= k1; k++) {
    auto b = block(k);
    out->insert(out->end(), b->begin(), b->end());
  }
  return chunk_of(std::move(out), start);
}

}  // namespace yaffle
