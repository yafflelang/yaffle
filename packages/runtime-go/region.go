package yaffle

import "slices"

// What generated writers produce: blocks of bytes with fixups, placeables (pointer and `at`
// targets) and the structure the layout engine matches `layout` paths against; and regions,
// which lay their blocks out, assemble them and run the fixups.

// ── structure for layout ────────────────────────────────────────────────────

// LEntry is an LStruct, an LArray or a *Placeable.
type LEntry interface{ isLEntry() }

// LStruct holds the placeables reachable from one struct instance, by field.
type LStruct struct {
	Layout []LayoutItem
	names  []string
	fields map[string]LEntry
}

func (*LStruct) isLEntry() {}

// NewLStruct starts the layout structure of a struct instance.
func NewLStruct(layout []LayoutItem) *LStruct {
	return &LStruct{Layout: layout, fields: map[string]LEntry{}}
}

// Set records a field's entry (nil entries are ignored).
func (s *LStruct) Set(name string, e LEntry) {
	if e == nil || isNilEntry(e) {
		return
	}
	if _, ok := s.fields[name]; !ok {
		s.names = append(s.names, name)
	}
	s.fields[name] = e
}

func (s *LStruct) get(name string) LEntry { return s.fields[name] }

func isNilEntry(e LEntry) bool {
	switch x := e.(type) {
	case *LStruct:
		return x == nil
	case *LArray:
		return x == nil
	case *Placeable:
		return x == nil
	}
	return false
}

// LArray holds the entries of an array's elements.
type LArray struct {
	Items []LEntry
}

func (*LArray) isLEntry() {}

// Push appends an element's entry (nil allowed).
func (a *LArray) Push(e LEntry) {
	if e != nil && isNilEntry(e) {
		e = nil
	}
	a.Items = append(a.Items, e)
}

// PlaceOpts are the options of a placeable.
type PlaceOpts struct {
	// Modulus/Remainder: `at` constraint from a derived linear offset (Modulus 0 = none).
	Modulus, Remainder int
	// Fixed: exactly this base-relative offset (HasFixed).
	Fixed    int
	HasFixed bool
}

// Placeable is a pointer or `at` target: its block plus the structure of its content.
type Placeable struct {
	Block   *Block
	Content LEntry
	Opts    PlaceOpts
	Name    string
	// Commit mode (views): original position and size, -1 if none.
	Orig, OrigSize int
}

func (*Placeable) isLEntry() {}

func (p *Placeable) placed() bool { return p.Block.Pos >= 0 }

func newPlaceable(b *Block, name string, opts PlaceOpts) *Placeable {
	p := &Placeable{Block: b, Name: name, Opts: opts, Orig: -1, OrigSize: -1}
	if opts.HasFixed {
		b.fixedAt = opts.Fixed
		b.hasFixedAt = true
	}
	return p
}

// ── blocks ──────────────────────────────────────────────────────────────────

type part struct {
	at   int
	data []byte
	// prov is the offset in the view's original bytes the data was copied from (-1: none).
	prov int
}

// Block is a run of bytes placed as a unit.
type Block struct {
	parts  []part
	cur    []byte
	curAt  int
	Size   int
	align  int
	Pos    int
	region *Region

	fixedAt    int
	hasFixedAt bool
}

func newBlock(r *Region) *Block { return &Block{align: 1, Pos: -1, region: r} }

func (b *Block) seal() {
	if len(b.cur) > 0 {
		b.parts = append(b.parts, part{at: b.curAt, data: b.cur, prov: -1})
		b.cur = nil
	}
	b.curAt = b.Size
}

func (b *Block) grow(n int) []byte {
	if b.cur == nil {
		b.cur = make([]byte, 0, max(64, n))
		b.curAt = b.Size
	}
	l := len(b.cur)
	if l+n > cap(b.cur) {
		next := make([]byte, l, max(2*cap(b.cur), l+n))
		copy(next, b.cur)
		b.cur = next
	}
	b.cur = b.cur[:l+n]
	b.Size += n
	return b.cur[l : l+n]
}

func (b *Block) u8(v byte) { b.grow(1)[0] = v }

func (b *Block) bytes(v []byte) { b.bytesProv(v, -1) }

func (b *Block) bytesProv(v []byte, prov int) {
	if len(v) >= 512 || prov >= 0 {
		b.seal()
		if len(v) > 0 {
			b.parts = append(b.parts, part{at: b.Size, data: v, prov: prov})
		}
		b.Size += len(v)
		b.curAt = b.Size
		return
	}
	copy(b.grow(len(v)), v)
}

func (b *Block) fill(n int, f Fill) {
	if n <= 0 {
		return
	}
	if f.Fn == nil && f.Byte == 0 && n >= 512 {
		b.bytes(make([]byte, n))
		return
	}
	dst := b.grow(n)
	for i := range dst {
		dst[i] = f.at(i)
	}
}

func (b *Block) copyTo(out []byte, at int) {
	for _, p := range b.parts {
		copy(out[at+p.at:], p.data)
	}
	if len(b.cur) > 0 {
		copy(out[at+b.curAt:], b.cur)
	}
}

// ── fixups ──────────────────────────────────────────────────────────────────

// A fixup writes a value once the region is laid out. Phase 0 (sizes, positions, pointers) runs
// first, then @ref pointers are resolved, then phase 2 (content-dependent values: checksums,
// bytesof), innermost first.
type fixup struct {
	block *Block
	at    int
	phase int
	depth int
	path  []any
	run   func(out []byte, abs int)
}

// Mark is a position inside a block (absolute = block.Pos + At once laid out).
type Mark struct {
	Block *Block
	At    int
}

// Abs is the base-relative position of the mark (after layout).
func (m Mark) Abs() int { return m.Block.Pos + m.At }

// Extent is the start/end of a field's encoding, for sizeof/offsetof/bytesof.
type Extent struct {
	block      *Block
	start      int
	end        int
	stages     map[int]int
	placeable  *Placeable
	emptyNull  bool
	plain      []byte
	regionSize func() int
}

// Stage records the byte length after layer stage k.
func (e *Extent) Stage(k, size int) {
	if e.stages == nil {
		e.stages = map[int]int{}
	}
	e.stages[k] = size
}

// SetPlain records the plain encoding (before any codec) if not yet recorded.
func (e *Extent) SetPlain(b []byte) {
	if e.plain == nil {
		e.plain = b
	}
}

// Size is the encoded size (sizeof).
func (e *Extent) Size() int {
	if e.regionSize != nil {
		return e.regionSize()
	}
	if e.placeable != nil {
		return e.placeable.Block.Size
	}
	if e.end < 0 {
		return e.block.Size - e.start
	}
	return e.end - e.start
}

// Pos is the base-relative position (offsetof; valid after layout).
func (e *Extent) Pos() int {
	if e.placeable != nil {
		if e.emptyNull && e.placeable.Block.Size == 0 {
			return 0
		}
		return e.placeable.Block.Pos
	}
	if e.block.Pos < 0 {
		Fail(DERIVE, "position used before layout")
	}
	return e.block.Pos + e.start
}

// StageSize is the encoded size after k layer stages (encodedSize).
func (e *Extent) StageSize(k int) int {
	if v, ok := e.stages[k]; ok {
		return v
	}
	if e.end >= 0 {
		maxK := -1
		for kk := range e.stages {
			maxK = max(maxK, kk)
		}
		if k > maxK {
			return e.Size()
		}
	}
	Fail(DERIVE, "encoded size at layer %d is not available yet", k)
	return 0
}

// Bytes is the field's bytes in the finished region (content-dependent fixups only).
func (e *Extent) Bytes() []byte {
	b := e.block
	if e.placeable != nil {
		b = e.placeable.Block
	}
	out := b.region.Output
	if out == nil {
		Fail(DERIVE, "bytes of a field used before its region was assembled")
	}
	pos := e.Pos()
	return out[pos : pos+e.Size()]
}

// PlainBytes is the field's plain encoding (before layers).
func (e *Extent) PlainBytes() []byte {
	if e.plain != nil {
		return e.plain
	}
	all := e.Bytes()
	if v, ok := e.stages[0]; ok {
		return all[:v]
	}
	return all
}

// ── regions ─────────────────────────────────────────────────────────────────

type refSite struct {
	key        string
	block      *Block
	start, end int
	value      any
}

type refUse struct {
	key      string
	path     []any
	value    any
	encode   func() []byte
	encoding []byte
	origin   func() int
	mark     Mark
	base     *Mark
	kind     Prim
	le       bool
	relative bool
	nullVal  *uint64
}

// Region is a base region: the base's own block at offset 0, plus everything placed in it.
type Region struct {
	Root       *Block
	blocks     []*Block
	placeables []*Placeable
	fixups     []*fixup
	identity   map[any]map[string]*Placeable
	refSites   []refSite
	refUses    []refUse
	LRoot      *LStruct
	Layout     []LayoutItem
	// AlignEnd pads the region's total size to a multiple (a base's @alignEnd); alignEnds are
	// the ones with an offset or counted from the file.
	AlignEnd  int
	alignEnds []alignEnd
	// anchor is where a nested @base written inline lands in the enclosing region: anchorAt
	// bytes into that block. nil for a region that starts its own byte space (the root, a
	// codec's decoded side, a stream, a temporary encoding).
	anchor   *Block
	anchorAt int
	// escalate: @ref pointers this region can't resolve are left in unresolved for the
	// enclosing region (a nested @base).
	escalate   bool
	unresolved []refUse
	// Sticky is set in commit mode (views): keep unchanged placeables where they were.
	Sticky *StickyPolicy
	// Output holds the assembled bytes once the region is finished.
	Output []byte
}

func newRegion() *Region {
	r := &Region{AlignEnd: 1, identity: map[any]map[string]*Placeable{}}
	r.Root = newBlock(r)
	r.Root.Pos = 0
	r.blocks = append(r.blocks, r.Root)
	return r
}

func (r *Region) newBlock() *Block {
	b := newBlock(r)
	r.blocks = append(r.blocks, b)
	return b
}

// finish lays out, assembles and runs the fixups. Returns the region's bytes.
func (r *Region) finish() []byte {
	layoutRegion(r)
	size := 0
	for _, b := range r.blocks {
		if b.Pos >= 0 {
			size = max(size, b.Pos+b.Size)
		}
	}
	if len(r.alignEnds) > 0 {
		cs := []congr{{max(r.AlignEnd, 1), 0, false}}
		for _, a := range r.alignEnds {
			start := 0
			if a.file {
				start = fileStart(r.Root, a.to)
			}
			cs = append(cs, congr{a.to, mod(-(start + a.offset), a.to), false})
		}
		size = satisfyAll(size, cs, "the region end")
	} else {
		size = alignUp(size, r.AlignEnd)
	}
	out := make([]byte, size)
	for _, b := range r.blocks {
		if b.Pos >= 0 {
			b.copyTo(out, b.Pos)
		}
	}
	r.Output = out
	run := func(f *fixup) {
		defer func() {
			if p := recover(); p != nil {
				sealWith(p, f.path)
				panic(p)
			}
		}()
		f.run(out, f.block.Pos+f.at)
	}
	var late []*fixup
	for _, f := range r.fixups {
		if f.phase == 0 {
			run(f)
		} else {
			late = append(late, f)
		}
	}
	r.resolveRefs(out)
	slices.SortStableFunc(late, func(x, y *fixup) int { return y.depth - x.depth })
	for _, f := range late {
		run(f)
	}
	return out
}

type encKey struct {
	key string
	enc string
}

func (r *Region) resolveRefs(out []byte) {
	if len(r.refUses) == 0 {
		return
	}
	byIdentity := map[any]map[string]int{}
	for _, s := range r.refSites {
		if s.block.Pos < 0 || s.value == nil {
			continue
		}
		abs := s.block.Pos + s.start
		m := byIdentity[s.value]
		if m == nil {
			m = map[string]int{}
			byIdentity[s.value] = m
		}
		if prev, ok := m[s.key]; !ok || abs < prev {
			m[s.key] = abs
		}
	}
	var byEncoding map[encKey]int
	encodingIndex := func() map[encKey]int {
		if byEncoding != nil {
			return byEncoding
		}
		byEncoding = map[encKey]int{}
		for _, s := range r.refSites {
			if s.block.Pos < 0 {
				continue
			}
			abs := s.block.Pos + s.start
			k := encKey{s.key, string(out[abs : s.block.Pos+s.end])}
			if prev, ok := byEncoding[k]; !ok || abs < prev {
				byEncoding[k] = abs
			}
		}
		return byEncoding
	}
	for _, u := range r.refUses {
		func() {
			defer func() {
				if p := recover(); p != nil {
					sealWith(p, u.path)
					panic(p)
				}
			}()
			target, found := 0, false
			if u.value != nil {
				target, found = byIdentity[u.value][u.key]
			}
			if !found {
				enc := u.encoding
				if enc == nil {
					enc = u.encode()
				}
				target, found = encodingIndex()[encKey{u.key, string(enc)}]
			}
			if !found {
				if r.escalate {
					r.unresolved = append(r.unresolved, u)
					return
				}
				Fail(REF, "no equal value is placed in this base for a @ref pointer")
			}
			abs := u.mark.Abs()
			base := 0
			if u.base != nil {
				base = u.base.Abs()
			}
			var v int
			if u.relative {
				v = target - abs
			} else {
				v = target - base
			}
			if u.origin != nil {
				v -= u.origin()
			}
			writeOffset(out, abs, u.kind, u.le, v, u.nullVal)
		}()
	}
}

func writeOffset(out []byte, abs int, kind Prim, le bool, value int, nullVal *uint64) {
	if nullVal != nil && value >= 0 && uint64(value) == *nullVal {
		Fail(DERIVE, "pointer offset %d equals the null value", value)
	}
	if !kind.Signed() && value < 0 {
		Fail(RANGE, "negative offset %d for %s", value, kind)
	}
	PutUint(out[abs:], kind.Size(), intBits(kind, int64(value)), le)
}

// anchors lists the output ranges copied unchanged from a view's document (once finished).
func (r *Region) anchors() []Anchor {
	var out []Anchor
	for _, b := range r.blocks {
		if b.Pos < 0 {
			continue
		}
		for _, p := range b.parts {
			if p.prov >= 0 {
				out = append(out, Anchor{N: b.Pos + p.at, O: p.prov, Len: len(p.data)})
			}
		}
	}
	return out
}

type alignEnd struct {
	to, offset int
	file       bool
}

// AlignEndAt makes the region's size satisfy (size + offset) % to == 0, the size counted from
// the base or, with file, from the start of the byte space (a base's @alignEnd).
func (r *Region) AlignEndAt(to, offset int, file bool) {
	if to <= 0 {
		Fail(RANGE, "invalid alignment %d", to)
	}
	r.alignEnds = append(r.alignEnds, alignEnd{to: to, offset: offset, file: file})
}

// fileStart is where block b starts in its byte space, as far as it matters for alignment to
// `to`: a block whose position a later layout decides gets `to` added to its alignment (so its
// start contributes a multiple of `to`) and counts as 0. Nested @base regions written inline
// count from where they land in the enclosing region.
func fileStart(b *Block, to int) int {
	r := b.region
	start := 0
	switch {
	case b == r.Root:
	case b.hasFixedAt:
		start = b.fixedAt
	default:
		b.align = lcm(b.align, to)
	}
	if r.anchor != nil {
		start += fileStart(r.anchor, to) + r.anchorAt
	}
	return start
}

// RegionEnd is the size of the finished region holding the mark (`$end` in deferred checks).
func (m Mark) RegionEnd() int {
	if m.Block.region.Output == nil {
		Fail(DERIVE, "$end used before its region was assembled")
	}
	return len(m.Block.region.Output)
}
