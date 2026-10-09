// The relocation-style writer (see writer.hpp).
#include "yaffle/yaffle.hpp"

namespace yaffle {

std::int64_t lcm(std::int64_t a, std::int64_t b) {
  std::int64_t x = a, y = b;
  while (y) {
    std::int64_t t = x % y;
    x = y;
    y = t;
  }
  return a / x * b;
}

// ── structure ──────────────────────────────────────────────────────────────────

void LStruct::set(std::string_view name, LEntry e) {
  if (std::holds_alternative<std::monostate>(e)) return;
  if (auto p = std::get_if<Placeable*>(&e); p && !*p) return;
  for (auto& f : fields)
    if (f.first == name) {
      f.second = std::move(e);
      return;
    }
  fields.emplace_back(std::string(name), std::move(e));
}

const LEntry* LStruct::get(std::string_view name) const {
  for (const auto& f : fields)
    if (f.first == name) return &f.second;
  return nullptr;
}

Placeable::Placeable(Block* b, std::string n, const PlaceOptions& o)
    : block(b), constraint(o.constraint), fixed(o.fixed), name(std::move(n)) {
  // A fixed placement's position is known before its content is written: inner alignment is
  // computed from it instead of constraining the block's start.
  if (o.fixed) b->fixed_at = *o.fixed;
}

// ── extents ────────────────────────────────────────────────────────────────────

void Extent::set_stage(int k, std::int64_t size) {
  if (static_cast<int>(stages.size()) <= k) stages.resize(static_cast<std::size_t>(k) + 1, -1);
  stages[static_cast<std::size_t>(k)] = size;
}

std::int64_t Extent::size() const {
  if (!block && !whole) fail(ErrorCode::Derive, "size of a field that was not written");
  if (whole) return whole->output ? static_cast<std::int64_t>(whole->output->size()) : whole->root->size();
  if (placeable) return placeable->block->size();
  if (end < 0) return block->size() - start;
  return end - start;
}

std::int64_t Extent::pos() const {
  if (!block) fail(ErrorCode::Derive, "position of a field that was not written");
  if (placeable) return empty_is_null && placeable->block->size() == 0 ? 0 : placeable->block->pos;
  if (block->pos < 0) fail(ErrorCode::Derive, "position used before layout");
  return block->pos + start;
}

std::int64_t Extent::stage(int k) const {
  if (k < static_cast<int>(stages.size()) && stages[static_cast<std::size_t>(k)] >= 0)
    return stages[static_cast<std::size_t>(k)];
  if (k >= static_cast<int>(stages.size()) && (end >= 0 || placeable)) return size();
  fail(ErrorCode::Derive, "encoded size at layer " + std::to_string(k) + " is not available yet");
}

BytesView Extent::bytes() const {
  const Block* b = placeable ? placeable->block : block;
  const Region* r = whole ? whole : b->region;
  if (!r->output) fail(ErrorCode::Derive, "bytes of a field used before its region was assembled");
  std::int64_t p = whole ? 0 : pos();
  std::int64_t n = size();
  if (p < 0 || p + n > static_cast<std::int64_t>(r->output->size()))
    fail(ErrorCode::Derive, "field bytes are outside the region");
  return BytesView(*r->output).subspan(static_cast<std::size_t>(p), static_cast<std::size_t>(n));
}

BytesView Extent::plain_bytes() const {
  if (plain) return BytesView(*plain);
  BytesView all = bytes();
  if (!stages.empty() && stages[0] >= 0) return all.subspan(0, static_cast<std::size_t>(stages[0]));
  return all;
}

// ── regions ────────────────────────────────────────────────────────────────────

Region::Region() {
  blocks.push_back(std::make_unique<Block>(this));
  root = blocks.back().get();
  root->pos = 0;
}

Block* Region::new_block() {
  blocks.push_back(std::make_unique<Block>(this));
  return blocks.back().get();
}

const Bytes& Region::finish() {
  layout_region(*this);
  std::int64_t size = 0;
  for (const auto& b : blocks) {
    if (b->pos < 0) continue;
    size = std::max(size, b->pos + b->size());
  }
  if (align_end > 1) size = (size + align_end - 1) / align_end * align_end;
  for (bool changed = !align_ends.empty(); changed;) {
    changed = false;
    for (const auto& a : align_ends) {
      std::int64_t start = a.file ? file_start(root, a.to) : 0;
      std::int64_t pad = (((-(start + size + a.offset)) % a.to) + a.to) % a.to;
      if (pad) {
        size += pad;
        changed = true;
      }
    }
    if (align_end > 1 && size % align_end) {
      size = (size + align_end - 1) / align_end * align_end;
      changed = true;
    }
  }
  output.emplace(static_cast<std::size_t>(size), 0);
  Bytes& out = *output;
  for (const auto& b : blocks) {
    if (b->pos < 0 || b->data.empty()) continue;
    std::memcpy(out.data() + b->pos, b->data.data(), b->data.size());
  }
  auto run = [&](Fixup& f) {
    try {
      f.run(out, f.block->pos + f.at);
    } catch (Error& e) {
      e.seal_with(f.path);
      throw;
    }
  };
  for (auto& f : fixups)
    if (f.phase == 0) run(f);
  resolve_refs(out);
  std::vector<Fixup*> late;
  for (auto& f : fixups)
    if (f.phase == 2) late.push_back(&f);
  std::stable_sort(late.begin(), late.end(), [](const Fixup* a, const Fixup* b) { return a->depth > b->depth; });
  for (Fixup* f : late) run(*f);
  return out;
}

static void write_offset(Bytes& out, std::int64_t abs, Prim kind, bool le, std::int64_t value,
                         const std::optional<i128>& null_value) {
  if (null_value && static_cast<i128>(value) == *null_value)
    fail(ErrorCode::Derive, "pointer offset " + std::to_string(value) + " equals the null value");
  PrimInfo p = prim_info(kind);
  if (!p.is_signed && value < 0)
    fail(ErrorCode::Range, "negative offset " + std::to_string(value) + " for " + prim_name(kind));
  check_prim(value, kind, "pointer");
  store_uint(out.data() + abs, p.size, static_cast<std::uint64_t>(value), le);
}

void Region::resolve_refs(Bytes& out) {
  if (ref_uses.empty()) return;
  std::map<std::pair<const void*, std::string>, std::int64_t> by_identity;
  for (const auto& s : ref_sites) {
    if (s.block->pos < 0 || !s.value) continue;
    std::int64_t abs = s.block->pos + s.start;
    auto key = std::make_pair(s.value, s.key);
    auto it = by_identity.find(key);
    if (it == by_identity.end() || abs < it->second) by_identity[key] = abs;
  }
  std::optional<std::unordered_map<std::string, std::int64_t>> by_encoding;
  auto encoding_index = [&]() -> std::unordered_map<std::string, std::int64_t>& {
    if (by_encoding) return *by_encoding;
    by_encoding.emplace();
    for (const auto& s : ref_sites) {
      if (s.block->pos < 0) continue;
      std::int64_t abs = s.block->pos + s.start;
      std::string key = s.key;
      key += '|';
      key.append(reinterpret_cast<const char*>(out.data() + abs), static_cast<std::size_t>(s.end - s.start));
      auto it = by_encoding->find(key);
      if (it == by_encoding->end() || abs < it->second) (*by_encoding)[key] = abs;
    }
    return *by_encoding;
  };
  for (auto& u : ref_uses) {
    try {
      std::optional<std::int64_t> target;
      if (u.value) {
        auto it = by_identity.find(std::make_pair(u.value, u.key));
        if (it != by_identity.end()) target = it->second;
      }
      if (!target) {
        Bytes enc = u.encoding ? *u.encoding : u.encode();
        std::string key = u.key;
        key += '|';
        key.append(reinterpret_cast<const char*>(enc.data()), enc.size());
        auto& idx = encoding_index();
        auto it = idx.find(key);
        if (it != idx.end()) target = it->second;
      }
      if (!target) {
        if (escalate) {
          unresolved.push_back(u);
          continue;
        }
        fail(ErrorCode::Ref, "no equal value is placed in this base for a @ref pointer");
      }
      std::int64_t abs = u.mark.abs();
      std::int64_t base = u.base ? u.base->abs() : 0;
      std::int64_t value = (u.relative ? *target - abs : *target - base) - (u.origin ? u.origin() : 0);
      write_offset(out, abs, u.kind, u.le, value, u.null_value);
    } catch (Error& e) {
      e.seal_with(u.path);
      throw;
    }
  }
}

// ── writer ─────────────────────────────────────────────────────────────────────

Writer::Writer(Region* r) : b(r->root), region(r) {}

std::vector<PathSeg> Writer::path() const {
  std::vector<PathSeg> out;
  for (const Frame* f : frames_) {
    if (f->field && *f->field) out.push_back(PathSeg{f->field, -1});
    for (std::int64_t i : f->idx) {
      if (i < 0) break;
      out.push_back(PathSeg{"", i});
    }
  }
  return out;
}

ExtentPtr Writer::region_extent() {
  auto e = std::make_shared<Extent>(region->root, 0);
  e->whole = region;
  return e;
}

void Writer::bind_extent(const ExtentPtr& e, Placeable* p, bool empty_is_null) {
  e->placeable = p;
  e->block = p->block;
  e->start = 0;
  e->end = p->block->size();
  e->empty_is_null = empty_is_null;
}

void Writer::bytes_n(BytesView v, std::int64_t n) {
  if (static_cast<std::int64_t>(v.size()) != n)
    fail(ErrorCode::Derive,
         std::to_string(v.size()) + " bytes given, the length expression says " + std::to_string(n));
  bytes(v);
}

void Writer::bytes_until(BytesView v, i128 term) {
  std::uint8_t t = static_cast<std::uint8_t>(static_cast<std::uint64_t>(term) & 0xff);
  if (std::find(v.begin(), v.end(), t) != v.end())
    fail(ErrorCode::Input, "the bytes contain the terminator " + hex(t));
  bytes(v);
  u8(t);
}

void Writer::str(std::string_view s, int unit, Encoding enc, bool le, StrMode mode, std::int64_t n) {
  Bytes bs = encode_string(s, enc, le);
  if (mode == StrMode::Count) {
    if (static_cast<std::int64_t>(bs.size()) > n * unit)
      fail(ErrorCode::Input, "string of " + std::to_string(bs.size() / static_cast<std::size_t>(unit)) +
                                 " units exceeds the length " + std::to_string(n));
    bytes(bs);
    fill(n * unit - static_cast<std::int64_t>(bs.size()), Fill(0));
  } else {
    bytes(bs);
    if (mode == StrMode::Until) fill(unit, Fill(0));
  }
}

void Writer::fill(std::int64_t n, const Fill& f) {
  if (n <= 0) return;
  std::size_t at = b->data.size();
  if (!f.fn) {
    b->data.resize(at + static_cast<std::size_t>(n), static_cast<std::uint8_t>(f.byte));
    return;
  }
  b->data.resize(at + static_cast<std::size_t>(n));
  for (std::int64_t i = 0; i < n; i++) b->data[at + static_cast<std::size_t>(i)] = f.at(i);
}

void Writer::pad(i128 n, const Fill& f) {
  if (n < 0 || n > (static_cast<i128>(1) << 40)) fail(ErrorCode::Range, "invalid padding length " + to_string(n));
  fill(static_cast<std::int64_t>(n), f);
}

static std::int64_t checked_align(i128 to, i128 offset) {
  if (to <= 0 || to > (static_cast<i128>(1) << 40)) fail(ErrorCode::Range, "invalid alignment " + to_string(to));
  if (offset < -(static_cast<i128>(1) << 40) || offset > (static_cast<i128>(1) << 40))
    fail(ErrorCode::Range, "invalid alignment offset " + to_string(offset));
  return static_cast<std::int64_t>(to);
}

std::int64_t file_start(Block* b, std::int64_t to) {
  Region* r = b->region;
  std::int64_t start;
  if (b == r->root)
    start = 0;
  else if (b->fixed_at)
    start = *b->fixed_at;
  else {
    b->align = lcm(b->align, to);
    start = 0;
  }
  if (r->anchor) start += file_start(r->anchor->block, to) + r->anchor->at;
  return start;
}

void Writer::align_at(i128 to, const Fill& f, bool file, i128 offset) {
  std::int64_t t = checked_align(to, offset);
  std::int64_t start;
  if (file)
    start = file_start(b, t);
  else {
    std::optional<std::int64_t> known = b == region->root ? std::optional<std::int64_t>(0) : b->fixed_at;
    if (!known) b->align = lcm(b->align, t);
    start = known.value_or(0);
  }
  std::int64_t v = start + b->size() + static_cast<std::int64_t>(offset);
  fill((((-v) % t) + t) % t, f);
}

void Writer::region_align_end(i128 to, bool file, i128 offset) {
  std::int64_t t = checked_align(to, offset);
  if (!file && offset == 0)
    region->align_end = lcm(region->align_end, t);
  else
    region->align_ends.push_back(Region::AlignEnd{t, file, static_cast<std::int64_t>(offset)});
}

void Writer::pad_until(std::int64_t start, i128 size, const Fill& f) {
  std::int64_t used = b->size() - start;
  if (size < used)
    fail(ErrorCode::Input, "content of " + std::to_string(used) + " bytes exceeds padUntil(" + to_string(size) + ")");
  fill(static_cast<std::int64_t>(size) - used, f);
}

void Writer::size_window(std::int64_t start, i128 n) {
  if (n < 0 || n > (static_cast<i128>(1) << 53)) fail(ErrorCode::Range, "invalid size " + to_string(n));
  std::int64_t used = b->size() - start;
  if (used > n)
    fail(ErrorCode::Derive, "content of " + std::to_string(used) + " bytes does not fit size " + to_string(n));
  fill(static_cast<std::int64_t>(n) - used, Fill(0));
}

void Writer::reserve(std::int64_t n, int phase, std::function<void(Bytes& out, std::int64_t abs)> run) {
  Block* block = b;
  std::int64_t at = block->size();
  fill(n, Fill(0));
  region->fixups.push_back(Fixup{block, at, phase, depth, path(), std::move(run)});
}

void Writer::defer_prim(Prim k, bool le, std::function<i128()> compute, int phase) {
  reserve(prim_info(k).size, phase, [k, le, compute = std::move(compute)](Bytes& out, std::int64_t abs) {
    store_prim(out.data() + abs, k, check_prim(compute(), k), le);
  });
}

void Writer::defer_float(Prim k, bool le, std::function<double()> compute, int phase) {
  reserve(prim_info(k).size, phase, [k, le, compute = std::move(compute)](Bytes& out, std::int64_t abs) {
    store_prim_float(out.data() + abs, k, compute(), le);
  });
}

void Writer::defer_bytes(std::int64_t n, std::function<Bytes()> compute, int phase) {
  reserve(n, phase, [n, compute = std::move(compute)](Bytes& out, std::int64_t abs) {
    Bytes v = compute();
    if (static_cast<std::int64_t>(v.size()) != n)
      fail(ErrorCode::Derive, "derived bytes have length " + std::to_string(v.size()) + ", expected " + std::to_string(n));
    std::memcpy(out.data() + abs, v.data(), v.size());
  });
}

void Writer::defer_check(std::function<void()> run, int phase) {
  region->fixups.push_back(
      Fixup{b, 0, phase, depth, path(), [run = std::move(run)](Bytes&, std::int64_t) { run(); }});
}

Placeable* Writer::new_placeable(std::string name, const PlaceOptions& opts) {
  region->placeables.push_back(std::make_unique<Placeable>(region->new_block(), std::move(name), opts));
  return region->placeables.back().get();
}

void Writer::fill_placeable(Placeable* p, const std::function<LEntry()>& write) {
  Restore<Block*> rb(b, p->block);
  Restore<std::int64_t> ri(index, -1);
  p->content = write();
}

void Writer::note_origin(Placeable* p, const void* identity, const void* owner) {
  if (!origins || !region->sticky || !region->sticky->orig_root_size) return;
  const Origins::Range* o = nullptr;
  if (identity) {
    auto it = origins->objects.find(identity);
    if (it != origins->objects.end()) o = &it->second;
  }
  if (!o && owner) {
    auto it = origins->slots.find(std::make_pair(owner, p->name));
    if (it != origins->slots.end()) o = &it->second;
  }
  if (o && o->pos >= origin_base) {
    p->orig = o->pos - origin_base;
    p->orig_size = o->size;
  }
}

Placeable* Writer::target(const void* identity, const std::string& key, std::string name,
                          const std::function<LEntry()>& write, const PlaceOptions& opts, const void* owner) {
  if (identity) {
    auto k = std::make_pair(identity, key);
    auto it = region->identity.find(k);
    if (it != region->identity.end()) return it->second;
    Placeable* p = new_placeable(std::move(name), opts);
    region->identity.emplace(k, p);
    note_origin(p, identity, owner);
    fill_placeable(p, write);
    return p;
  }
  Placeable* p = new_placeable(std::move(name), opts);
  note_origin(p, nullptr, owner);
  fill_placeable(p, write);
  return p;
}

Placeable* Writer::place(std::string name, const std::function<LEntry()>& write, const PlaceOptions& opts,
                         const void* owner) {
  Placeable* p = new_placeable(std::move(name), opts);
  note_origin(p, nullptr, owner);
  fill_placeable(p, write);
  return p;
}

void Writer::pointer(Prim kind, bool le, Placeable* p, bool relative, std::optional<i128> null_value,
                     std::function<std::int64_t()> origin) {
  const int size = prim_info(kind).size;
  if (!p) {
    if (!null_value) fail(ErrorCode::Input, "null for a pointer that is not nullable");
    i128 nv = *null_value;
    reserve(size, 0, [kind, le, nv](Bytes& out, std::int64_t abs) {
      store_prim(out.data() + abs, kind, check_prim(nv, kind), le);
    });
    return;
  }
  reserve(size, 0, [kind, le, p, relative, null_value, origin = std::move(origin)](Bytes& out, std::int64_t abs) {
    if (p->block->pos < 0) fail(ErrorCode::Derive, "target " + p->name + " was not placed");
    std::int64_t o = origin ? origin() : 0;
    write_offset(out, abs, kind, le, (relative ? p->block->pos - abs : p->block->pos) - o, null_value);
  });
}

void Writer::ref_pointer(Prim kind, bool le, const std::string& key, bool is_null, const void* identity,
                         std::function<Bytes()> encode, bool relative, std::optional<i128> null_value,
                         std::function<std::int64_t()> origin) {
  if (is_null) {
    pointer(kind, le, nullptr, relative, null_value);
    return;
  }
  Mark m = mark();
  fill(prim_info(kind).size, Fill(0));
  RefUse u;
  u.key = key;
  u.path = path();
  u.value = identity;
  // Objects resolve by identity first; their encoding is computed only when that fails. Values
  // (strings) match by encoding.
  if (identity)
    u.encode = std::move(encode);
  else
    u.encoding = encode();
  u.origin = std::move(origin);
  u.mark = m;
  u.kind = kind;
  u.le = le;
  u.relative = relative;
  u.null_value = null_value;
  region->ref_uses.push_back(std::move(u));
}

void Writer::adopt_refs(Region& nested, Block* block, std::int64_t at) {
  for (const auto& u : nested.unresolved) {
    std::int64_t inner = u.base ? u.base->abs() : 0;
    RefUse v = u;
    v.mark = Mark{block, at + u.mark.abs()};
    v.base = Mark{block, at + inner};
    region->ref_uses.push_back(std::move(v));
  }
}

void Region::adopt_root(const LEntry& l, bool take_layout) {
  if (auto s = std::get_if<std::shared_ptr<LStruct>>(&l)) {
    lroot = *s;
    if (take_layout && !layout) layout = (*s)->layout;
  } else if (!std::holds_alternative<std::monostate>(l)) {
    lroot = std::make_shared<LStruct>();
    lroot->set("$", l);
  }
}

void Writer::finish_nested(Region& r, const std::function<LEntry()>& write, bool take_layout) {
  Restore<Region*> rr(region, &r);
  Restore<Block*> rb(b, r.root);
  Restore<std::int64_t> ri(index, index);
  r.adopt_root(write(), take_layout);
  r.finish();
}

Bytes Writer::sub_region(const Layout* layout, const std::function<LEntry()>& write) {
  Region nested;
  nested.layout = layout;
  if (region->sticky) nested.sticky = StickyPolicy{region->sticky->grow, std::nullopt, std::nullopt};
  finish_nested(nested, write, false);
  return std::move(*nested.output);
}

void Writer::base(const Layout* layout, const std::function<LEntry()>& write, const void* value) {
  auto nested = std::make_unique<Region>();
  nested->layout = layout;
  nested->escalate = true;
  // A nested base written inline lands where the enclosing block is now (`from: file` origins).
  nested->anchor = Region::Anchor{b, b->size()};
  std::int64_t base_origin = origin_base;
  if (region->sticky) {
    nested->sticky = StickyPolicy{region->sticky->grow, std::nullopt, std::nullopt};
    // An unchanged nested base keeps its targets where they were (relative to its own start).
    if (origins && value && region->sticky->orig_root_size) {
      auto it = origins->bases.find(value);
      if (it != origins->bases.end()) {
        nested->sticky = StickyPolicy{region->sticky->grow, it->second.inline_size, it->second.size};
        base_origin = it->second.base;
      }
    }
  }
  {
    Restore<std::int64_t> ro(origin_base, base_origin);
    finish_nested(*nested, write, true);
  }
  Block* block = b;
  std::int64_t at = block->size();
  bytes(*nested->output);
  if (!nested->unresolved.empty()) {
    adopt_refs(*nested, block, at);
    region->kept.push_back(std::move(nested));
  }
}

Bytes serialize_root(const Layout* layout, std::int64_t align_end, const std::function<LEntry(Writer&)>& write,
                     const Sticky* sticky) {
  Region region;
  region.layout = layout;
  region.align_end = align_end;
  Writer w(&region);
  if (sticky) {
    region.sticky = StickyPolicy{sticky->grow, sticky->root_inline, sticky->size};
    w.origins = sticky->origins;
  }
  region.adopt_root(write(w), true);
  region.finish();
  return std::move(*region.output);
}

std::int64_t layout_alignment(std::int64_t n) {
  if (n < 1) fail(ErrorCode::Range, "layout alignment " + std::to_string(n) + " is below 1");
  return n;
}

std::int64_t layout_padding(std::int64_t n) {
  if (n < 0) fail(ErrorCode::Range, "layout padding " + std::to_string(n) + " is negative");
  return n;
}

void check_placement(std::int64_t offset, const Placeable* p, const char* name) {
  // An empty target reads back the same wherever its offset points.
  if (p->block->size() == 0) return;
  if (offset != p->block->pos)
    fail(ErrorCode::Derive, std::string(name) + " was placed at " + std::to_string(p->block->pos) +
                                " but its offset expression gives " + std::to_string(offset));
}

void check_length(std::int64_t actual, i128 expected) {
  if (static_cast<i128>(actual) != expected)
    fail(ErrorCode::Derive, std::to_string(actual) + " elements given, the length expression says " +
                                to_string(expected));
}

}  // namespace yaffle
