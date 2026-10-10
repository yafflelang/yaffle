// Byte stores: where readers get their bytes.
//
// Every byte space a view reads (the source, a codec's decoded side, a stream) is a Store.
// Readers keep a window (a Chunk) and refill it from the store, so a view over a file reads only
// the blocks it touches, a `from arr[*].piece` stream decodes only the pieces it touches, and a
// `@ranged` codec region decodes only the blocks it touches.
#pragma once

#include <list>

#include "core.hpp"

namespace yaffle {

/// Bytes [start, start + size) of a store, kept alive by `owner`.
struct Chunk {
  std::shared_ptr<const void> owner;
  const std::uint8_t* data = nullptr;
  std::int64_t start = 0;
  std::int64_t size = 0;
  std::int64_t end() const { return start + size; }
};

/// Region end of a reader over a store whose size is not known yet (`Store::lazy_size`).
inline constexpr std::int64_t kUnknownEnd = std::numeric_limits<std::int64_t>::max() / 4;

class Store {
 public:
  virtual ~Store() = default;
  /// Total size. Expensive for lazy stores (it may decode everything).
  virtual std::int64_t size() = 0;
  /// True when `size()` is expensive: readers keep region ends unknown and use `covers`.
  virtual bool lazy_size() const { return false; }
  /// Whether bytes [0, end) exist, discovering only as much as needed.
  virtual bool covers(std::int64_t end) { return end <= size(); }
  /// A chunk containing [off, off + min) (the caller checked `covers(off + min)`). It may extend
  /// beyond, up to `max` bytes from `off` (a hint), and may start before `off`.
  virtual Chunk get(std::int64_t off, std::int64_t min, std::int64_t max) = 0;
  /// The whole contents when they are in memory, else null.
  virtual std::shared_ptr<const Bytes> whole() { return nullptr; }
  /// Bytes [off, off + n) as a fresh buffer.
  Bytes read(std::int64_t off, std::int64_t n);
  /// Everything (whole() when in memory).
  std::shared_ptr<const Bytes> all();
};
using StorePtr = std::shared_ptr<Store>;

/// Bytes in memory.
class MemStore final : public Store {
 public:
  explicit MemStore(std::shared_ptr<const Bytes> bytes) : bytes_(std::move(bytes)) {}
  explicit MemStore(Bytes bytes) : bytes_(std::make_shared<const Bytes>(std::move(bytes))) {}
  std::int64_t size() override { return static_cast<std::int64_t>(bytes_->size()); }
  Chunk get(std::int64_t off, std::int64_t min, std::int64_t max) override;
  std::shared_ptr<const Bytes> whole() override { return bytes_; }

 private:
  std::shared_ptr<const Bytes> bytes_;
};

/// Bytes computed on first use (a codec region decoded whole, a field's value read on demand).
class LazyStore final : public Store {
 public:
  explicit LazyStore(std::function<std::shared_ptr<const Bytes>()> make) : make_(std::move(make)) {}
  std::int64_t size() override { return static_cast<std::int64_t>(bytes()->size()); }
  bool lazy_size() const override { return !bytes_; }
  Chunk get(std::int64_t, std::int64_t, std::int64_t) override;
  std::shared_ptr<const Bytes> whole() override { return bytes(); }

 private:
  const std::shared_ptr<const Bytes>& bytes();
  std::function<std::shared_ptr<const Bytes>()> make_;
  std::shared_ptr<const Bytes> bytes_;
};

/// A small LRU cache of byte buffers by key.
class BufferLru {
 public:
  BufferLru(std::size_t max_items, std::size_t max_bytes) : max_items_(max_items), max_bytes_(max_bytes) {}
  std::shared_ptr<const Bytes> get(std::int64_t key);
  void put(std::int64_t key, std::shared_ptr<const Bytes> value);
  void clear();

 private:
  using Item = std::pair<std::int64_t, std::shared_ptr<const Bytes>>;
  std::size_t max_items_, max_bytes_, bytes_ = 0;
  std::list<Item> items_;
  std::unordered_map<std::int64_t, std::list<Item>::iterator> index_;
};

/// A file read with positional reads (`pread`) through a block cache: views of large files read
/// only the blocks they touch.
class FileStore final : public Store {
 public:
  explicit FileStore(const std::string& path, std::int64_t block_size = 1 << 16, std::size_t cache_blocks = 64);
  ~FileStore() override;
  FileStore(const FileStore&) = delete;
  FileStore& operator=(const FileStore&) = delete;
  std::int64_t size() override { return size_; }
  Chunk get(std::int64_t off, std::int64_t min, std::int64_t max) override;

  /// Statistics (tests): positional reads issued and bytes read.
  std::int64_t reads = 0;
  std::int64_t bytes_read = 0;

 private:
  std::shared_ptr<const Bytes> block(std::int64_t k);
  int fd_ = -1;
  std::string path_;
  std::int64_t size_ = 0;
  std::int64_t block_size_;
  BufferLru cache_;
};

/// A window [start, start + length) of another store (length omitted: to the parent's end).
class SliceStore final : public Store {
 public:
  SliceStore(StorePtr parent, std::int64_t start, std::optional<std::int64_t> length)
      : parent_(std::move(parent)), start_(start), length_(length) {}
  std::int64_t size() override;
  bool lazy_size() const override { return !length_ && parent_->lazy_size(); }
  bool covers(std::int64_t end) override;
  Chunk get(std::int64_t off, std::int64_t min, std::int64_t max) override;

 private:
  StorePtr parent_;
  std::int64_t start_;
  std::optional<std::int64_t> length_;
};

/// A store with same-size in-place edits applied over another (a view's patched document).
class OverlayStore final : public Store {
 public:
  explicit OverlayStore(StorePtr base) : base_(std::move(base)) {}
  std::int64_t size() override { return base_->size(); }
  bool lazy_size() const override { return base_->lazy_size(); }
  bool covers(std::int64_t end) override { return base_->covers(end); }
  Chunk get(std::int64_t off, std::int64_t min, std::int64_t max) override;
  std::shared_ptr<const Bytes> whole() override;
  /// Replaces [at, at + data.size()) (later patches win where they overlap).
  void patch(std::int64_t at, BytesView data);
  bool patched() const { return !patches_.empty(); }
  const StorePtr& base() const { return base_; }

 private:
  StorePtr base_;
  std::vector<std::pair<std::int64_t, Bytes>> patches_;
  /// The base in memory with the patches applied (built on demand).
  std::shared_ptr<const Bytes> merged_;
};

/// The pieces of a `from arr[*].piece` stream (streams in views). The stream is not
/// joined: an offset maps to a piece through the prefix sums of piece lengths, learned in piece
/// order only as far as needed, from the pieces' size fields when they state them (no decoding)
/// or by decoding. Decoded pieces are kept in a small LRU.
class PieceStore final : public Store {
 public:
  struct Source {
    std::int64_t count = 0;
    /// The length of piece k when known without decoding it (its size field), else nullopt.
    std::function<std::optional<std::int64_t>(std::int64_t)> length;
    /// Decodes piece k.
    std::function<std::shared_ptr<const Bytes>(std::int64_t)> decode;
  };
  explicit PieceStore(Source src) : src_(std::move(src)), cache_(16, std::size_t(64) << 20) { starts_.push_back(0); }
  std::int64_t size() override;
  bool lazy_size() const override { return true; }
  bool covers(std::int64_t end) override;
  Chunk get(std::int64_t off, std::int64_t min, std::int64_t max) override;

  /// Statistics (tests): pieces decoded.
  std::int64_t decodes = 0;

 private:
  /// Learns piece lengths until `starts_` reaches `end` or every piece is known.
  void learn_until(std::int64_t end);
  /// The piece holding offset `off` (after learning).
  std::int64_t piece_at(std::int64_t off);
  std::shared_ptr<const Bytes> piece(std::int64_t k);
  Source src_;
  std::vector<std::int64_t> starts_;
  BufferLru cache_;
};

/// A `@ranged` codec region (not streaming, not async): fixed-size blocks decoded on demand with
/// `position` = the block's offset in the region. Ranged codecs keep the length (byte i of the
/// input is byte i of the output).
class RangedStore final : public Store {
 public:
  using Decode = std::function<Bytes(BytesView input, std::size_t position)>;
  RangedStore(StorePtr encoded, Decode decode, std::int64_t block_size = 0x1000)
      : enc_(std::move(encoded)), decode_(std::move(decode)), block_(block_size), cache_(256, std::size_t(64) << 20) {}
  std::int64_t size() override { return enc_->size(); }
  Chunk get(std::int64_t off, std::int64_t min, std::int64_t max) override;

  /// Statistics (tests): decode calls and bytes decoded.
  std::int64_t decodes = 0;
  std::int64_t decoded_bytes = 0;

 private:
  Bytes run(std::int64_t start, std::int64_t n);
  std::shared_ptr<const Bytes> block(std::int64_t k);
  StorePtr enc_;
  Decode decode_;
  std::int64_t block_;
  BufferLru cache_;
};

}  // namespace yaffle
