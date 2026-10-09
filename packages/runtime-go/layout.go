package yaffle

import "sort"

// The layout engine (docs/IR.md §4): assigns every placeable of a base region a position.
//
//   - Default order: the base's own bytes first, then each placeable's unit in pre-order (a unit
//     is the target's own bytes, then its own targets).
//   - `layout { … }` items of a struct order that struct's own targets: a path naming a placeable
//     places its unit (minus anything already placed); a path naming inline data or `[*]`
//     elements places the remaining units reachable from there; `this` places the struct's own
//     bytes. A placeable named by any item of a container is placed by that item (pull-out).
//   - Groups: `volumes[*] { pieces[*]  portals[*].points }` places, for each element of the
//     array in order, what the nested items name (paths relative to the element).
//   - Item layers (align, padBefore, padAfter, alignEnd) apply to every block an item places
//     unless a nested item sets its own. Placement constraints and alignment required by a
//     block's content add to that. Alignments may have an offset and count from the file.
//   - Fixed placements go exactly where they say; overlaps are OVERLAP errors and sequential
//     placement flows around them.
//   - Sticky mode (view commits): placeables keep their original positions where possible.

// LayerKind of a layout item layer.
type LayerKind uint8

// Layout item layer kinds.
const (
	LAlign LayerKind = iota
	LPadBefore
	LPadAfter
	LAlignEnd
)

// LayoutLayer is a layer of a layout item. Alignments put (position + Offset) on a multiple of
// N, the position counted from the base or, with File, from the start of the byte space.
type LayoutLayer struct {
	Kind   LayerKind
	N      int
	Offset int
	File   bool
}

// LayoutItem is one `layout { … }` item: "this" (This) or a path of field names with "*" for
// `[*]`. With Group, Path names an array, and for each of its elements the Group items (paths
// relative to the element) are placed in order.
type LayoutItem struct {
	This   bool
	Path   []string
	Layers []LayoutLayer
	Group  []LayoutItem
}

// InstanceLayout checks the layout of one struct instance whose item arguments read fields
// and returns it: an alignment below 1 or a negative padding is RANGE, whether or
// not the item places anything.
func InstanceLayout(items []LayoutItem) []LayoutItem {
	for _, it := range items {
		for _, l := range it.Layers {
			switch {
			case (l.Kind == LAlign || l.Kind == LAlignEnd) && l.N < 1:
				Fail(RANGE, "the alignment of layout item %s is %d (it must be at least 1)", itemName(it), l.N)
			case (l.Kind == LPadBefore || l.Kind == LPadAfter) && l.N < 0:
				Fail(RANGE, "the padding of layout item %s is %d", itemName(it), l.N)
			}
		}
		InstanceLayout(it.Group)
	}
	return items
}

// itemName is a layout item's path as written (`recs[*].body`).
func itemName(it LayoutItem) string {
	if it.This {
		return "this"
	}
	s := ""
	for _, seg := range it.Path {
		switch {
		case seg == "*":
			s += "[*]"
		case s == "":
			s = seg
		default:
			s += "." + seg
		}
	}
	return s
}

// StickyPolicy says how a view commit treats size changes:
//   - "default": targets that grow move to the end; everything else stays unless pushed forward
//     by growth before it.
//   - "append": like default, but targets pushed by inline growth move to the end too.
//   - "splice": nothing moves to the end; every size change shifts what follows.
//   - "error": any size change is an error.
type StickyPolicy struct {
	Grow string
	// OrigRootSize is the size of the base's own bytes in the original (-1: no original).
	OrigRootSize int
	// OrigSize is the original size of the whole region (-1 if unknown).
	OrigSize int
}

func alignUp(x, a int) int {
	if a <= 1 {
		return x
	}
	return (x + a - 1) / a * a
}

func mod(a, m int) int { return ((a % m) + m) % m }

func gcd(a, b int) int {
	for b != 0 {
		a, b = b, a%b
	}
	return a
}

func lcm(a, b int) int { return a / gcd(a, b) * b }

// Lcm is the least common multiple (a base's @alignEnd).
func Lcm(a, b int) int { return lcm(a, b) }

// congr is a placement requirement: position ≡ r (mod m). constraint marks an `at` constraint
// (not an alignment).
type congr struct {
	m, r       int
	constraint bool
}

// alignments leaves out the placement constraint.
func alignments(cs []congr) []congr {
	var out []congr
	for _, c := range cs {
		if !c.constraint {
			out = append(out, c)
		}
	}
	return out
}

func meets(pos int, cs []congr) bool {
	for _, c := range cs {
		if mod(pos-c.r, c.m) != 0 {
			return false
		}
	}
	return true
}

// satisfyAll returns the first position >= from meeting every requirement.
func satisfyAll(from int, cs []congr, name string) int {
	if len(cs) == 0 {
		return from
	}
	big := cs[0]
	limit := 1
	for _, c := range cs {
		if c.m > big.m {
			big = c
		}
		if limit < 1<<24 {
			limit = lcm(limit, c.m)
		}
	}
	pos := from + mod(big.r-from, big.m)
	for steps := 0; steps <= limit/big.m+1; steps++ {
		if meets(pos, cs) {
			return pos
		}
		pos += big.m
	}
	Fail(DERIVE, "the alignments and placement constraints of %s cannot all be met", name)
	return 0
}

type lrange struct {
	start, end int
	name       string
}

type engine struct {
	cursor   int
	reserved []lrange
	region   *Region
	claimed  map[*Placeable]bool
	visiting map[*Placeable]bool
	onPlace  func(p *Placeable, cs []congr)
}

func newEngine(r *Region) *engine {
	e := &engine{cursor: r.Root.Size, region: r, claimed: map[*Placeable]bool{}, visiting: map[*Placeable]bool{}}
	if r.Root.Size > 0 {
		e.reserved = append(e.reserved, lrange{0, r.Root.Size, "base"})
	}
	return e
}

// layerOffset is the offset an item layer aligns with: its own, plus the base's position in the
// byte space for file alignment.
func (e *engine) layerOffset(l LayoutLayer) int {
	off := l.Offset
	if l.File && l.N > 0 {
		off += fileStart(e.region.Root, l.N)
	}
	return off
}

// congrs are the requirements of placing p with item layers: its block's own alignment, the
// items' alignments and its placement constraint.
func (e *engine) congrs(p *Placeable, layers []LayoutLayer) []congr {
	var cs []congr
	if p.Block.align > 1 {
		cs = append(cs, congr{p.Block.align, 0, false})
	}
	for _, l := range layers {
		if l.Kind == LAlign && l.N > 1 {
			cs = append(cs, congr{l.N, mod(-e.layerOffset(l), l.N), false})
		} else if l.Kind == LAlign && l.N <= 0 {
			Fail(RANGE, "invalid alignment %d", l.N)
		}
	}
	if m := p.Opts.Modulus; m > 1 {
		cs = append(cs, congr{m, mod(p.Opts.Remainder, m), true})
	}
	return cs
}

func (e *engine) placeFixed(p *Placeable) {
	start := p.Opts.Fixed
	if start < 0 {
		Fail(RANGE, "invalid fixed offset %d for %s", start, p.Name)
	}
	end := start + p.Block.Size
	if end > start {
		for _, r := range e.reserved {
			if start < r.end && r.start < end {
				Fail(OVERLAP, "%s at [0x%x, 0x%x) overlaps %s at [0x%x, 0x%x)", p.Name, start, end, r.name, r.start, r.end)
			}
		}
		e.reserved = append(e.reserved, lrange{start, end, p.Name})
	}
	p.Block.Pos = start
}

func (e *engine) findPos(p *Placeable, cs []congr, from int) int {
	size := p.Block.Size
	pos := satisfyAll(from, cs, p.Name)
	for guard := 0; guard < 100000; guard++ {
		var hit *lrange
		if size > 0 {
			for i := range e.reserved {
				r := &e.reserved[i]
				if pos < r.end && r.start < pos+size {
					hit = r
					break
				}
			}
		}
		if hit == nil {
			return pos
		}
		pos = satisfyAll(hit.end, cs, p.Name)
	}
	Fail(OVERLAP, "no room for %s", p.Name)
	return 0
}

func (e *engine) placeBlock(p *Placeable, layers []LayoutLayer) {
	cs := e.congrs(p, layers)
	if e.onPlace != nil {
		e.onPlace(p, cs)
	}
	if p.placed() {
		// Reaching a fixed placement moves the running position past it.
		if p.Opts.HasFixed {
			e.cursor = max(e.cursor, p.Block.Pos+p.Block.Size)
		}
		return
	}
	cursor := e.cursor
	for _, l := range layers {
		if l.Kind == LPadBefore {
			cursor += l.N
		}
	}
	pos := e.findPos(p, cs, cursor)
	p.Block.Pos = pos
	cursor = pos + p.Block.Size
	for _, l := range layers {
		switch l.Kind {
		case LPadAfter:
			cursor += l.N
		case LAlignEnd:
			if l.N > 1 {
				cursor = satisfyAll(cursor, []congr{{l.N, mod(-e.layerOffset(l), l.N), false}}, p.Name)
			}
		}
	}
	e.cursor = max(e.cursor, cursor)
}

func (e *engine) placeUnit(p *Placeable, layers []LayoutLayer) {
	if e.visiting[p] {
		e.placeBlock(p, layers)
		return
	}
	e.visiting[p] = true
	defer delete(e.visiting, p)
	if s, ok := p.Content.(*LStruct); ok {
		e.processStruct(s, s.Layout, p, layers)
		return
	}
	e.placeBlock(p, layers)
	if p.Content != nil {
		e.placeRemaining(p.Content, layers)
	}
}

func (e *engine) placeRemaining(x LEntry, layers []LayoutLayer) {
	switch v := x.(type) {
	case *Placeable:
		// A placeable claimed by a container's item is placed by that item only.
		if !e.claimed[v] {
			e.placeUnit(v, layers)
		}
	case *LArray:
		for _, it := range v.Items {
			if it != nil {
				e.placeRemaining(it, layers)
			}
		}
	case *LStruct:
		e.processStruct(v, v.Layout, nil, layers)
	}
}

// claims records every placeable the items name (from base; self is a group element's own
// placeable, which a nested `this` names) as claimed by this layout.
type claims struct {
	mine   []*Placeable
	isMine map[*Placeable]bool
}

func (e *engine) claim(c *claims, p *Placeable) {
	if !e.claimed[p] && !p.placed() {
		e.claimed[p] = true
		c.mine = append(c.mine, p)
		c.isMine[p] = true
	}
}

func (e *engine) claimItems(c *claims, base LEntry, self *Placeable, items []LayoutItem) {
	for _, item := range items {
		if item.This {
			if self != nil {
				e.claim(c, self)
			}
			continue
		}
		if item.Group != nil {
			for _, el := range elementsOf(resolvePath(base, item.Path)) {
				p, _ := el.(*Placeable)
				e.claimItems(c, el, p, item.Group)
			}
			continue
		}
		for _, x := range resolvePath(base, item.Path) {
			if p, ok := x.(*Placeable); ok {
				e.claim(c, p)
			}
		}
	}
}

func (e *engine) placeItems(c *claims, base LEntry, self *Placeable, items []LayoutItem, inherited []LayoutLayer) {
	for _, item := range items {
		layers := item.Layers
		if len(layers) == 0 {
			layers = inherited
		}
		if item.This {
			if self != nil {
				delete(e.claimed, self)
				e.placeBlock(self, layers)
			}
			continue
		}
		if item.Group != nil {
			// An element that is a target itself comes first, like `this` in a unit, unless the
			// group names `this` (the TS runtime's unit rule).
			namesThis := false
			for _, g := range item.Group {
				namesThis = namesThis || g.This
			}
			for _, el := range elementsOf(resolvePath(base, item.Path)) {
				p, _ := el.(*Placeable)
				if p != nil && !namesThis {
					e.placeBlock(p, layers)
				}
				e.placeItems(c, el, p, item.Group, layers)
			}
			continue
		}
		for _, x := range resolvePath(base, item.Path) {
			if p, ok := x.(*Placeable); ok {
				if c.isMine[p] {
					delete(e.claimed, p)
					e.placeUnit(p, layers)
				} else if !e.claimed[p] {
					e.placeUnit(p, layers)
				}
			} else {
				e.placeRemaining(x, layers)
			}
		}
	}
}

func (e *engine) processStruct(s *LStruct, items []LayoutItem, self *Placeable, inherited []LayoutLayer) {
	if len(items) > 0 {
		// Claim every placeable an item names, so no other unit places it first.
		c := &claims{isMine: map[*Placeable]bool{}}
		e.claimItems(c, s, nil, items)
		hasThis := false
		for _, item := range items {
			if item.This {
				hasThis = true
			}
		}
		if self != nil && !hasThis {
			e.placeBlock(self, inherited)
		}
		e.placeItems(c, s, self, items, inherited)
		for _, p := range c.mine {
			delete(e.claimed, p)
		}
		if self != nil {
			e.placeBlock(self, inherited)
		}
	} else if self != nil {
		e.placeBlock(self, inherited)
	}
	for _, name := range s.names {
		e.placeRemaining(s.fields[name], inherited)
	}
}

// resolvePath returns the entries a layout path reaches from base (descending through
// placeables' contents).
func resolvePath(base LEntry, path []string) []LEntry {
	cur := []LEntry{base}
	for _, seg := range path {
		var next []LEntry
		for _, x := range cur {
			if p, ok := x.(*Placeable); ok {
				if p.Content == nil {
					continue
				}
				x = p.Content
			}
			if seg == "*" {
				if a, ok := x.(*LArray); ok {
					for _, it := range a.Items {
						if it != nil {
							next = append(next, it)
						}
					}
				}
			} else if st, ok := x.(*LStruct); ok {
				if f := st.get(seg); f != nil {
					next = append(next, f)
				}
			}
		}
		cur = next
	}
	return cur
}

// elementsOf returns the elements of the arrays a group path reached (elements that hold no
// placeables are left out: there is nothing to place for them).
func elementsOf(xs []LEntry) []LEntry {
	var out []LEntry
	for _, x := range xs {
		if p, ok := x.(*Placeable); ok {
			x = p.Content
		}
		if a, ok := x.(*LArray); ok {
			for _, it := range a.Items {
				if it != nil {
					out = append(out, it)
				}
			}
		}
	}
	return out
}

// rootItems are the layout items of the region's own struct.
func (r *Region) rootItems() []LayoutItem {
	if r.Layout != nil || r.LRoot == nil {
		return r.Layout
	}
	return r.LRoot.Layout
}

func layoutRegion(r *Region) {
	if r.Sticky != nil && r.Sticky.OrigRootSize >= 0 {
		stickyLayout(r, r.Sticky)
		return
	}
	for _, p := range r.placeables {
		p.Block.Pos = -1
	}
	e := newEngine(r)
	for _, p := range r.placeables {
		if p.Opts.HasFixed {
			e.placeFixed(p)
		}
	}
	e.placeAll()
}

// placeAll places everything in the default order: the root struct's layout items, then every
// placeable not placed yet.
func (e *engine) placeAll() {
	r := e.region
	if r.LRoot != nil {
		e.processStruct(r.LRoot, r.rootItems(), nil, nil)
	}
	for _, p := range r.placeables {
		if !p.placed() {
			e.placeUnit(p, nil)
		}
	}
}

// defaultOrder is the default placement order of every placeable (sticky mode places new ones in
// it), plus the requirements each gets from its items.
func defaultOrder(r *Region) ([]*Placeable, map[*Placeable][]congr) {
	saved := make([]int, len(r.placeables))
	for i, p := range r.placeables {
		saved[i] = p.Block.Pos
		if p.Opts.HasFixed {
			p.Block.Pos = p.Opts.Fixed
		} else {
			p.Block.Pos = -1
		}
	}
	var order []*Placeable
	seen := map[*Placeable]bool{}
	reqs := map[*Placeable][]congr{}
	e := newEngine(r)
	e.onPlace = func(p *Placeable, cs []congr) {
		if !seen[p] {
			seen[p] = true
			order = append(order, p)
			reqs[p] = cs
		}
	}
	e.placeAll()
	for i, p := range r.placeables {
		p.Block.Pos = saved[i]
	}
	return order, reqs
}

func stickyLayout(r *Region, policy *StickyPolicy) {
	order, reqs := defaultOrder(r)
	for _, p := range r.placeables {
		p.Block.Pos = -1
	}
	e := newEngine(r)
	for _, p := range r.placeables {
		if p.Opts.HasFixed {
			e.placeFixed(p)
		}
	}
	origRoot := policy.OrigRootSize
	if policy.Grow == "error" && r.Root.Size != origRoot {
		Fail(DERIVE, "the base grew from %d to %d bytes (grow: \"error\")", origRoot, r.Root.Size)
	}
	var old []*Placeable
	for _, p := range r.placeables {
		if p.Orig >= 0 && !p.Opts.HasFixed {
			old = append(old, p)
		}
	}
	sort.SliceStable(old, func(i, j int) bool { return old[i].Orig < old[j].Orig })
	var toEnd []*Placeable
	origCursor := origRoot
	origEnd := origRoot
	if policy.OrigSize >= 0 {
		origEnd = policy.OrigSize
	}
	for _, p := range old {
		origEnd = max(origEnd, p.Orig+max(p.OrigSize, 0))
	}
	reqOf := func(p *Placeable) []congr {
		if cs, ok := reqs[p]; ok {
			return cs
		}
		return e.congrs(p, nil)
	}
	for _, p := range old {
		size := p.Block.Size
		origSize := p.OrigSize
		if origSize < 0 {
			origSize = size
		}
		grows := size > origSize
		if policy.Grow == "error" && size != origSize {
			Fail(DERIVE, "%s changed size from %d to %d (grow: \"error\")", p.Name, origSize, size)
		}
		cs := reqOf(p)
		if grows && (policy.Grow == "default" || policy.Grow == "append" || policy.Grow == "") {
			toEnd = append(toEnd, p)
			origCursor = max(origCursor, p.Orig+origSize)
			continue
		}
		extra := max(0, p.Orig-satisfyAll(origCursor, alignments(cs), p.Name))
		keep := meets(p.Orig, cs)
		var pos int
		switch {
		case policy.Grow == "splice":
			if e.cursor == origCursor && keep {
				pos = p.Orig
			} else {
				pos = e.findPos(p, cs, e.cursor+extra)
			}
		case e.cursor <= p.Orig && keep:
			pos = p.Orig
			for _, rr := range e.reserved {
				if pos < rr.end && rr.start < pos+size {
					pos = e.findPos(p, cs, pos)
					break
				}
			}
		case policy.Grow == "append" || !keep:
			toEnd = append(toEnd, p)
			origCursor = max(origCursor, p.Orig+origSize)
			continue
		default:
			pos = e.findPos(p, cs, e.cursor+extra)
		}
		p.Block.Pos = pos
		e.cursor = max(e.cursor, pos+size)
		origCursor = max(origCursor, p.Orig+origSize)
	}
	if policy.Grow != "splice" {
		e.cursor = max(e.cursor, origEnd)
	}
	rest := map[*Placeable]bool{}
	for _, p := range toEnd {
		rest[p] = true
	}
	for _, p := range r.placeables {
		if !p.placed() {
			rest[p] = true
		}
	}
	for _, p := range order {
		if !rest[p] || p.placed() {
			continue
		}
		p.Block.Pos = e.findPos(p, reqOf(p), e.cursor)
		e.cursor = p.Block.Pos + p.Block.Size
	}
	for _, p := range r.placeables {
		if !p.placed() {
			p.Block.Pos = e.findPos(p, e.congrs(p, nil), e.cursor)
			e.cursor = p.Block.Pos + p.Block.Size
		}
	}
}
