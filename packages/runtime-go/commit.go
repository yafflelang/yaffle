package yaffle

// CommitHooks put a Writer in commit mode (views): placeables that came from the view's
// source keep their original positions where the grow policy allows (sticky layout).
type CommitHooks struct {
	// Origin returns the original absolute position and size of a value (pointer targets, `at`
	// values) in the view's source.
	Origin func(value any) (pos, size int, ok bool)
	// SlotOrigin returns the original target of a field of a view struct.
	SlotOrigin func(owner any, field string) (pos, size int, ok bool)
	// RegionOrigin returns the original position of a nested base struct.
	RegionOrigin func(value any) (base, inline, size int, ok bool)
}

func (w *Writer) noteOrigin(p *Placeable, value, owner any) {
	c := w.Commit
	if c == nil || c.Origin == nil || w.Region.Sticky == nil || w.Region.Sticky.OrigRootSize < 0 {
		return
	}
	pos, size, ok := 0, 0, false
	if value != nil {
		pos, size, ok = c.Origin(value)
	}
	if !ok && owner != nil && c.SlotOrigin != nil {
		pos, size, ok = c.SlotOrigin(owner, p.Name)
	}
	if ok && pos >= w.origB {
		p.Orig = pos - w.origB
		p.OrigSize = size
	}
}

func (w *Writer) commitEnterRegion(region *Region, value any) func() {
	if w.Commit == nil || w.Region.Sticky == nil {
		return func() {}
	}
	saveBase := w.origB
	if value != nil && w.Commit.RegionOrigin != nil {
		if base, inline, size, ok := w.Commit.RegionOrigin(value); ok {
			region.Sticky = &StickyPolicy{Grow: w.Region.Sticky.Grow, OrigRootSize: inline, OrigSize: size}
			w.origB = base
			return func() { w.origB = saveBase }
		}
	}
	region.Sticky = &StickyPolicy{Grow: w.Region.Sticky.Grow, OrigRootSize: -1, OrigSize: -1}
	return func() { w.origB = saveBase }
}
