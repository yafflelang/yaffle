// Views (see view.hpp).
#include "yaffle/view.hpp"

#include "yaffle/yaffle.hpp"

namespace yaffle {

Doc::Doc(Bytes data) : Doc(std::static_pointer_cast<Store>(std::make_shared<MemStore>(std::move(data)))) {}

Doc::Doc(StorePtr source) : current(std::make_shared<OverlayStore>(std::move(source))) {
  root.loc = Loc{0, 0, 0, current->lazy_size() ? kUnknownEnd : current->size(), -1, false};
}

int Doc::space(const std::string& key, std::int64_t outer, std::function<StorePtr(Doc&)> make) {
  auto it = space_ids_.find(key);
  if (it != space_ids_.end()) return it->second;
  spaces_.push_back(Space{nullptr, std::move(make), outer});
  int id = static_cast<int>(spaces_.size());
  space_ids_.emplace(key, id);
  return id;
}

StorePtr Doc::store(int space) {
  if (space == 0) return current;
  if (space < 0 || static_cast<std::size_t>(space) > spaces_.size()) fail(ErrorCode::Input, "unknown view space");
  Space& sp = spaces_[static_cast<std::size_t>(space) - 1];
  if (!sp.store) sp.store = sp.make(*this);
  return sp.store;
}

void Doc::prime(int space, StorePtr st) {
  Space& sp = spaces_.at(static_cast<std::size_t>(space) - 1);
  if (!sp.store) sp.store = std::move(st);
}

Reader Doc::reader(const Loc& l) {
  std::int64_t outer = l.space == 0 ? -1 : spaces_.at(static_cast<std::size_t>(l.space) - 1).outer;
  Reader r(store(l.space), l.strict, outer);
  if (l.pos < 0 || !r.covers(l.pos)) fail(ErrorCode::Eof, "view position is outside the data");
  r.pos = l.pos;
  r.base = l.base;
  if (l.end < r.raw_end()) r.set_end(l.end);
  r.index = l.index;
  r.max_end = l.pos;
  return r;
}

Reader Doc::full_reader(bool strict) { return Reader(current, strict, -1); }

void Doc::reset_spaces() {
  for (auto& sp : spaces_) sp.store.reset();
}

void Doc::materialize() {
  if (value) return;
  if (!materialize_fn) fail(ErrorCode::Input, "this view cannot be materialized");
  origins = Origins{};
  materialize_fn(*this);
}

void Doc::patch(std::int64_t at, BytesView data) {
  if (at < 0 || !current->covers(at + static_cast<std::int64_t>(data.size())))
    fail(ErrorCode::Range, "patch outside the data");
  Bytes now = current->read(at, static_cast<std::int64_t>(data.size()));
  if (std::equal(data.begin(), data.end(), now.begin())) return;
  current->patch(at, data);
  inplace.push_back(Patch{at, static_cast<std::int64_t>(data.size()), Bytes(data.begin(), data.end())});
  version++;
  scans_.clear();
  // Decoded regions and streams may cover the patched bytes: rebuild them on next use.
  reset_spaces();
}

Doc::Plan Doc::plan(Grow grow) {
  Plan p;
  if (!structural) {
    // Fast path: merge the in-place patches into sorted, non-overlapping replacements.
    std::vector<std::pair<std::int64_t, std::int64_t>> ranges;
    for (const auto& x : inplace) ranges.emplace_back(x.at, x.at + x.remove);
    std::sort(ranges.begin(), ranges.end());
    std::vector<std::pair<std::int64_t, std::int64_t>> merged;
    for (const auto& r : ranges) {
      if (!merged.empty() && r.first <= merged.back().second)
        merged.back().second = std::max(merged.back().second, r.second);
      else
        merged.push_back(r);
    }
    for (const auto& m : merged) p.patches.push_back(Patch{m.first, m.second - m.first, current->read(m.first, m.second - m.first)});
    return p;
  }
  if (!serialize_fn) fail(ErrorCode::Input, "this view cannot be re-serialized");
  p.bytes = serialize_fn(*this, grow);
  std::shared_ptr<const Bytes> original = current->base()->all();
  if (grow == Grow::Error && p.bytes.size() != original->size())
    fail(ErrorCode::Derive, "the data changed size from " + std::to_string(original->size()) + " to " +
                                std::to_string(p.bytes.size()) + " bytes (grow: \"error\")");
  p.patches = diff(*original, p.bytes);
  return p;
}

std::vector<Patch> Doc::patches(Grow grow) { return plan(grow).patches; }

Bytes Doc::commit(Grow grow) {
  Plan p = plan(grow);
  Bytes out = structural ? std::move(p.bytes) : Bytes(*current->all());
  current = std::make_shared<OverlayStore>(std::make_shared<MemStore>(out));
  inplace.clear();
  spaces_.clear();
  space_ids_.clear();
  structural = false;
  value.reset();
  origins = Origins{};
  scans_.clear();
  root.loc.end = static_cast<std::int64_t>(out.size());
  version++;
  epoch++;
  return out;
}

const Kid& ViewBase::kid() const {
  if (epoch_ != doc_->epoch) {
    Kid k = doc_->root;
    for (std::size_t i = 0; i < path_.size(); i++) {
      const Step& s = path_[i];
      if (k.loc.pos < 0) fail(ErrorCode::Input, "null target");
      try {
        k = s.locate(*doc_, k, s.elem);
      } catch (Error& e) {
        // The parent's scan failed: the error belongs to the parent.
        if (!e.sealed) {
          prefix_path(e, i);
          e.sealed = true;
        }
        throw;
      }
    }
    kid_ = std::move(k);
    epoch_ = doc_->epoch;
  }
  return kid_;
}

void ViewBase::prefix_path(Error& e, std::size_t steps) const {
  for (std::size_t i = std::min(steps, path_.size()); i-- > 0;) {
    const Step& s = path_[i];
    if (s.many)
      e.prefix(s.name, {s.elem});
    else
      e.prefix(s.name);
  }
}

void* ViewBase::resolve() const {
  void* p = doc_->value.get();
  if (!p) fail(ErrorCode::Input, "the document is not materialized");
  for (const Step& s : path_) p = s.nav(p, s.elem);
  return p;
}

const Kid& kid_of(const ScanBase& s, int field, std::int64_t elem) {
  const auto& kids = s.fields.at(static_cast<std::size_t>(field)).kids;
  if (elem < 0 || elem >= static_cast<std::int64_t>(kids.size()))
    fail(ErrorCode::Range, "index " + std::to_string(elem) + " is out of bounds");
  return kids[static_cast<std::size_t>(elem)];
}

std::vector<Patch> diff(BytesView orig, BytesView out) {
  std::vector<Patch> patches;
  std::size_t nl = out.size(), ol = orig.size();
  if (nl == ol) {
    // Same length: the differing runs (gaps under 8 equal bytes are merged).
    std::size_t i = 0;
    while (i < nl) {
      if (out[i] == orig[i]) {
        i++;
        continue;
      }
      std::size_t j = i + 1, same = 0;
      while (j < nl && same < 8) {
        if (out[j] == orig[j])
          same++;
        else
          same = 0;
        j++;
      }
      std::size_t end = j - same;
      patches.push_back(Patch{static_cast<std::int64_t>(i), static_cast<std::int64_t>(end - i),
                              Bytes(out.begin() + static_cast<std::ptrdiff_t>(i),
                                    out.begin() + static_cast<std::ptrdiff_t>(end))});
      i = j;
    }
    return patches;
  }
  std::size_t p = 0;
  while (p < nl && p < ol && out[p] == orig[p]) p++;
  std::size_t s = 0;
  while (s < nl - p && s < ol - p && out[nl - 1 - s] == orig[ol - 1 - s]) s++;
  patches.push_back(Patch{static_cast<std::int64_t>(p), static_cast<std::int64_t>(ol - p - s),
                          Bytes(out.begin() + static_cast<std::ptrdiff_t>(p),
                                out.begin() + static_cast<std::ptrdiff_t>(nl - s))});
  return patches;
}

Bytes apply_patches(BytesView orig, const std::vector<Patch>& patches) {
  Bytes out;
  std::size_t o = 0;
  for (const auto& p : patches) {
    out.insert(out.end(), orig.begin() + static_cast<std::ptrdiff_t>(o), orig.begin() + p.at);
    out.insert(out.end(), p.insert.begin(), p.insert.end());
    o = static_cast<std::size_t>(p.at + p.remove);
  }
  out.insert(out.end(), orig.begin() + static_cast<std::ptrdiff_t>(o), orig.end());
  return out;
}

Bytes encode_standalone(const std::function<void(Writer&)>& write) {
  Region region;
  Writer w(&region);
  write(w);
  return region.finish();
}

}  // namespace yaffle
