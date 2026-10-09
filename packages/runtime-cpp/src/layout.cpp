// The layout engine (docs/IR.md §4): assigns every placeable of a base region a position.
//
// - Default order: the base's own bytes first, then each placeable's unit in pre-order (a unit =
//   the target's own bytes, then its own targets).
// - `layout { … }` items of a struct order that struct's own targets: a path naming a placeable
//   places its unit (minus anything already placed); a path naming inline data or `[*]` elements
//   places the remaining units reachable from there; `this` places the struct's own bytes. Items
//   of an outer struct claim the placeables they name, so they pull groups out of inner layouts.
// - Item layers apply to every block an item places unless a nested item has its own. Placement
//   constraints and the alignment a block's content needs add to that.
// - Fixed placements go exactly where they say; overlaps are OVERLAP errors and sequential
//   placement flows around them.
// - Sticky mode (view commits): placeables keep their original positions where possible.
#include <unordered_set>

#include "yaffle/yaffle.hpp"

namespace yaffle {

namespace {

std::int64_t align_up(std::int64_t x, std::int64_t a) { return a <= 1 ? x : (x + a - 1) / a * a; }

using Layers = std::vector<LayoutLayer>;

struct Range {
  std::int64_t start;
  std::int64_t end;
  std::string name;
};

std::int64_t mod(std::int64_t a, std::int64_t m) { return ((a % m) + m) % m; }

/// What an entry holds: a placeable's content (null when it has none), else the entry itself.
const LEntry* content_of(const LEntry& e) {
  auto pp = std::get_if<Placeable*>(&e);
  if (!pp) return &e;
  return std::holds_alternative<std::monostate>((*pp)->content) ? nullptr : &(*pp)->content;
}

/// Appends the (non-empty) elements of an array entry.
void push_elements(const LEntry* e, std::vector<LEntry>& out) {
  if (auto a = e ? std::get_if<std::shared_ptr<LArray>>(e) : nullptr)
    for (const auto& it : (*a)->items)
      if (!std::holds_alternative<std::monostate>(it)) out.push_back(it);
}

/// Entries a layout path reaches from `s` (descending through placeables' contents).
std::vector<LEntry> resolve_path(const LEntry& s, const std::vector<std::string>& path) {
  std::vector<LEntry> cur{s};
  for (const auto& seg : path) {
    std::vector<LEntry> next;
    for (const LEntry& e : cur) {
      const LEntry* c = content_of(e);
      if (seg == "*")
        push_elements(c, next);
      else if (auto st = c ? std::get_if<std::shared_ptr<LStruct>>(c) : nullptr) {
        if (const LEntry* f = (*st)->get(seg)) next.push_back(*f);
      }
    }
    cur = std::move(next);
  }
  return cur;
}

/// The elements of the arrays a group's path reaches (through pointer targets).
std::vector<LEntry> elements_of(const std::vector<LEntry>& reached) {
  std::vector<LEntry> out;
  for (const LEntry& e : reached) push_elements(content_of(e), out);
  return out;
}

class Engine {
 public:
  explicit Engine(Region& r) : region(r), cursor(r.root->size()) {
    if (r.root->size()) reserved.push_back(Range{0, r.root->size(), "base"});
  }

  Region& region;
  std::int64_t cursor;
  std::vector<Range> reserved;
  std::unordered_set<Placeable*> claimed;
  std::unordered_set<Placeable*> visiting;
  /// Hook for sticky mode: called for every block placed (first time only).
  std::function<void(Placeable*, const Layers&)> on_place;
  std::unordered_set<Placeable*> seen;

  void place_fixed(Placeable* p) {
    std::int64_t start = *p->fixed;
    if (start < 0) fail(ErrorCode::Range, "invalid fixed offset " + std::to_string(start) + " for " + p->name);
    std::int64_t stop = start + p->block->size();
    if (stop > start) {
      for (const auto& r : reserved) {
        if (start < r.end && r.start < stop)
          fail(ErrorCode::Overlap, p->name + " at [" + hex(start) + ", " + hex(stop) + ") overlaps " + r.name + " at [" +
                                       hex(r.start) + ", " + hex(r.end) + ")");
      }
      reserved.push_back(Range{start, stop, p->name});
    }
    p->block->pos = start;
  }

  std::int64_t satisfy(const Placeable* p, std::int64_t align, std::int64_t from) {
    std::int64_t pos = align_up(from, align);
    if (p->constraint && p->constraint->modulus > 1) {
      std::int64_t m = p->constraint->modulus;
      std::int64_t r = mod(p->constraint->remainder, m);
      std::int64_t guard = 0;
      while (mod(pos, m) != r) {
        pos += align;
        if (++guard > m)
          fail(ErrorCode::Derive, "placement constraint = " + std::to_string(r) + " (mod " + std::to_string(m) +
                                      ") cannot be met with alignment " + std::to_string(align));
      }
    }
    return pos;
  }

  /// Smallest position ≥ from satisfying alignment and constraint and not overlapping fixed ranges.
  std::int64_t find_pos(const Placeable* p, std::int64_t align, std::int64_t from) {
    std::int64_t size = p->block->size();
    std::int64_t pos = satisfy(p, align, from);
    for (int guard = 0; guard < 100000; guard++) {
      const Range* hit = nullptr;
      if (size > 0)
        for (const auto& r : reserved)
          if (pos < r.end && r.start < pos + size) {
            hit = &r;
            break;
          }
      if (!hit) return pos;
      pos = satisfy(p, align, hit->end);
    }
    fail(ErrorCode::Overlap, "no room for " + p->name);
  }

  void place_block(Placeable* p, const Layers& layers) {
    if (on_place && seen.insert(p).second) on_place(p, layers);
    if (p->placed()) {
      // Reaching a fixed placement moves the running position past it.
      if (p->fixed) cursor = std::max(cursor, p->block->pos + p->block->size());
      return;
    }
    std::int64_t align = p->block->align;
    std::int64_t c = cursor;
    // `@align(n, offset: k)` / `from: file` items: a residue instead of a plain alignment.
    std::vector<std::pair<std::int64_t, std::int64_t>> residues;
    for (const auto& l : layers) {
      if (l.kind == LayoutLayer::Kind::Align) {
        if (l.offset || l.file) {
          std::int64_t origin = l.file ? file_start(region.root, l.n) : 0;
          residues.emplace_back(l.n, mod(-(origin + l.offset), l.n));
        } else
          align = lcm(align, l.n);
      } else if (l.kind == LayoutLayer::Kind::PadBefore)
        c += l.n;
    }
    std::int64_t pos = find_pos(p, align, c);
    auto unmet = [&] {
      for (const auto& r : residues)
        if (mod(pos, r.first) != r.second) return true;
      return false;
    };
    for (std::int64_t guard = 0; unmet(); guard++) {
      if (guard > (1 << 20)) fail(ErrorCode::Derive, "no position satisfies the alignment of " + p->name);
      pos = find_pos(p, align, pos + 1);
    }
    p->block->pos = pos;
    c = pos + p->block->size();
    for (const auto& l : layers) {
      if (l.kind == LayoutLayer::Kind::PadAfter)
        c += l.n;
      else if (l.kind == LayoutLayer::Kind::AlignEnd)
        c = align_up(c, l.n);
    }
    cursor = std::max(cursor, c);
  }

  void place_unit(Placeable* p, const Layers& layers) {
    if (visiting.count(p)) {
      place_block(p, layers);
      return;
    }
    visiting.insert(p);
    struct Unvisit {
      Engine& e;
      Placeable* p;
      ~Unvisit() { e.visiting.erase(p); }
    } unvisit{*this, p};
    if (auto s = std::get_if<std::shared_ptr<LStruct>>(&p->content)) {
      process_struct(*s, (*s)->layout, p, layers);
    } else {
      place_block(p, layers);
      if (!std::holds_alternative<std::monostate>(p->content)) place_remaining(p->content, layers);
    }
  }

  void place_remaining(const LEntry& e, const Layers& layers) {
    if (auto pp = std::get_if<Placeable*>(&e)) {
      // A placeable claimed by a container's item is placed by that item only.
      if (!claimed.count(*pp)) place_unit(*pp, layers);
    } else if (auto a = std::get_if<std::shared_ptr<LArray>>(&e)) {
      for (const auto& it : (*a)->items)
        if (!std::holds_alternative<std::monostate>(it)) place_remaining(it, layers);
    } else if (auto s = std::get_if<std::shared_ptr<LStruct>>(&e)) {
      process_struct(*s, (*s)->layout, nullptr, layers);
    }
  }

  void process_struct(const std::shared_ptr<LStruct>& s, const Layout* items, Placeable* self, const Layers& inherited) {
    if (items && !items->empty()) {
      // Claim every placeable an item names, so no other unit places it first.
      std::vector<Placeable*> mine;
      claim_items(LEntry(s), *items, mine);
      bool has_this = false;
      for (const auto& item : *items)
        if (item.is_this) has_this = true;
      if (self && !has_this) place_block(self, inherited);
      place_items(LEntry(s), *items, self, inherited, mine);
      for (Placeable* p : mine) claimed.erase(p);
      if (self) place_block(self, inherited);
    } else if (self) {
      place_block(self, inherited);
    }
    for (const auto& f : s->fields) place_remaining(f.second, inherited);
  }

  /// Claims every placeable the items name (group items: for every element of their array).
  void claim_items(const LEntry& s, const Layout& items, std::vector<Placeable*>& mine) {
    for (const auto& item : items) {
      if (item.is_this) continue;
      std::vector<LEntry> reached = resolve_path(s, item.path);
      if (item.grouped) {
        for (const auto& el : elements_of(reached)) claim_items(el, item.group, mine);
        continue;
      }
      for (const auto& e : reached) {
        if (auto pp = std::get_if<Placeable*>(&e)) {
          Placeable* p = *pp;
          if (!claimed.count(p) && !p->placed()) {
            claimed.insert(p);
            mine.push_back(p);
          }
        }
      }
    }
  }

  /// Places the items in order (`self` is what `this` names).
  void place_items(const LEntry& s, const Layout& items, Placeable* self, const Layers& inherited,
                   const std::vector<Placeable*>& mine) {
    for (const auto& item : items) {
      const Layers& layers = item.layers.empty() ? inherited : item.layers;
      if (item.is_this) {
        if (self) place_block(self, layers);
        continue;
      }
      std::vector<LEntry> reached = resolve_path(s, item.path);
      if (item.grouped) {
        // For each element, its items in order (claims stay until the container is done).
        // An element that is itself a target comes first, like `this` in a unit, unless named.
        bool names_this = false;
        for (const auto& g : item.group)
          if (g.is_this) names_this = true;
        for (const auto& el : elements_of(reached)) {
          Placeable* el_self = nullptr;
          if (auto pp = std::get_if<Placeable*>(&el)) el_self = *pp;
          if (el_self && !names_this) place_block(el_self, layers);
          place_items(el, item.group, el_self, layers, mine);
        }
        continue;
      }
      for (const auto& e : reached) {
        if (auto pp = std::get_if<Placeable*>(&e)) {
          Placeable* p = *pp;
          if (std::find(mine.begin(), mine.end(), p) != mine.end()) {
            claimed.erase(p);
            place_unit(p, layers);
          } else if (!claimed.count(p)) {
            place_unit(p, layers);
          }
        } else {
          place_remaining(e, layers);
        }
      }
    }
  }

  void run_default() {
    if (region.lroot) process_struct(region.lroot, region.layout, nullptr, {});
    for (const auto& p : region.placeables)
      if (!p->placed()) place_unit(p.get(), {});
  }
};

/// Default placement order and the alignment each placeable gets in it (sticky mode).
void default_order(Region& region, std::vector<Placeable*>& order, std::unordered_map<Placeable*, std::int64_t>& aligns) {
  std::vector<std::int64_t> saved;
  for (const auto& p : region.placeables) saved.push_back(p->block->pos);
  for (const auto& p : region.placeables) p->block->pos = p->fixed ? *p->fixed : -1;
  Engine engine(region);
  engine.on_place = [&](Placeable* p, const Layers& layers) {
    order.push_back(p);
    std::int64_t a = p->block->align;
    for (const auto& l : layers)
      if (l.kind == LayoutLayer::Kind::Align) a = lcm(a, l.n);
    aligns[p] = a;
  };
  engine.run_default();
  for (std::size_t i = 0; i < region.placeables.size(); i++) region.placeables[i]->block->pos = saved[i];
}

bool fits(const Placeable* p, std::int64_t align, std::int64_t pos) {
  if (align > 1 && pos % align != 0) return false;
  if (p->constraint && p->constraint->modulus > 1) {
    std::int64_t m = p->constraint->modulus;
    if (mod(pos, m) != mod(p->constraint->remainder, m)) return false;
  }
  return true;
}

void sticky_layout(Region& region, const StickyPolicy& policy) {
  std::vector<Placeable*> order;
  std::unordered_map<Placeable*, std::int64_t> aligns;
  default_order(region, order, aligns);
  for (const auto& p : region.placeables) p->block->pos = -1;
  Engine engine(region);
  for (const auto& p : region.placeables)
    if (p->fixed) engine.place_fixed(p.get());

  std::int64_t orig_root = *policy.orig_root_size;
  if (policy.grow == Grow::Error && region.root->size() != orig_root)
    fail(ErrorCode::Derive, "the base grew from " + std::to_string(orig_root) + " to " +
                                std::to_string(region.root->size()) + " bytes (grow: \"error\")");
  std::vector<Placeable*> old;
  for (const auto& p : region.placeables)
    if (p->orig && !p->fixed) old.push_back(p.get());
  std::stable_sort(old.begin(), old.end(), [](Placeable* a, Placeable* b) { return *a->orig < *b->orig; });
  std::vector<Placeable*> to_end;
  std::int64_t orig_cursor = orig_root;
  std::int64_t orig_end = policy.orig_size.value_or(orig_root);
  for (Placeable* p : old) orig_end = std::max(orig_end, *p->orig + p->orig_size.value_or(0));
  auto align_of = [&](Placeable* p) {
    auto it = aligns.find(p);
    return it != aligns.end() ? it->second : p->block->align;
  };

  for (Placeable* p : old) {
    std::int64_t size = p->block->size();
    std::int64_t orig_size = p->orig_size.value_or(size);
    bool grows = size > orig_size;
    if (policy.grow == Grow::Error && size != orig_size)
      fail(ErrorCode::Derive, p->name + " changed size from " + std::to_string(orig_size) + " to " +
                                  std::to_string(size) + " (grow: \"error\")");
    std::int64_t align = align_of(p);
    if (grows && (policy.grow == Grow::Default || policy.grow == Grow::Append)) {
      to_end.push_back(p);
      orig_cursor = std::max(orig_cursor, *p->orig + orig_size);
      continue;
    }
    // The part of the original gap that alignment does not explain is kept.
    std::int64_t extra = std::max<std::int64_t>(0, *p->orig - align_up(orig_cursor, align));
    std::int64_t pos;
    bool keep = fits(p, align, *p->orig);
    if (policy.grow == Grow::Splice) {
      pos = engine.cursor == orig_cursor && keep ? *p->orig : engine.find_pos(p, align, engine.cursor + extra);
    } else if (engine.cursor <= *p->orig && keep) {
      pos = *p->orig;
      bool clash = false;
      for (const auto& r : engine.reserved)
        if (pos < r.end && r.start < pos + size) clash = true;
      if (clash) pos = engine.find_pos(p, align, pos);
    } else if (policy.grow == Grow::Append || !keep) {
      to_end.push_back(p);
      orig_cursor = std::max(orig_cursor, *p->orig + orig_size);
      continue;
    } else {
      pos = engine.find_pos(p, align, engine.cursor + extra);
    }
    p->block->pos = pos;
    engine.cursor = std::max(engine.cursor, pos + size);
    orig_cursor = std::max(orig_cursor, *p->orig + orig_size);
  }
  // Moved and new placeables go at the end, in default layout order.
  if (policy.grow != Grow::Splice) engine.cursor = std::max(engine.cursor, orig_end);
  std::unordered_set<Placeable*> rest(to_end.begin(), to_end.end());
  for (const auto& p : region.placeables)
    if (!p->placed()) rest.insert(p.get());
  for (Placeable* p : order) {
    if (!rest.count(p) || p->placed()) continue;
    p->block->pos = engine.find_pos(p, align_of(p), engine.cursor);
    engine.cursor = p->block->pos + p->block->size();
  }
  for (const auto& p : region.placeables) {
    if (!p->placed()) {
      p->block->pos = engine.find_pos(p.get(), p->block->align, engine.cursor);
      engine.cursor = p->block->pos + p->block->size();
    }
  }
}

}  // namespace

void layout_region(Region& region) {
  if (region.sticky && region.sticky->orig_root_size) {
    sticky_layout(region, *region.sticky);
    return;
  }
  for (const auto& p : region.placeables) p->block->pos = -1;
  Engine engine(region);
  for (const auto& p : region.placeables)
    if (p->fixed) engine.place_fixed(p.get());
  engine.run_default();
}

}  // namespace yaffle
