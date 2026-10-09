package yaffle

import (
	"bytes"
	"container/list"
)

// Virtual streams (`T x from …`): on read, the bytes a `from` field is read from; on write, the
// encoding handed back to the stream's source fields.
//
// Views read streams lazily through a Store:
//
//   - PieceStore: a stream joined from pieces (`from arr[*].data`). An offset maps to a piece
//     through the pieces' decoded lengths, known from the data where the schema states them
//     (`@size(exp) @via(zstd)`: no decoding) and otherwise learned by decoding the pieces in
//     order. Only the pieces a read touches are decoded; decoded pieces live in a bounded LRU.
//   - RangedStore: the decoded side of a `@ranged` codec region. Only the touched blocks are
//     decoded (the codec gets each block's position in CodecCtx.Position), through an LRU too.
//
// Readers over a store (Reader.src) keep a window of the store's bytes and fetch the next one
// when a read leaves it.

// Stream is a virtual stream: bytes, or a store whose bytes are produced on demand.
type Stream struct {
	data  []byte
	store Store
}

// BytesStream is a stream over bytes.
func BytesStream(b []byte) Stream { return Stream{data: b} }

// JoinPieces joins the piece field of every element (`arr[*].field`). Pieces a view left lazy
// make the stream a PieceStore that decodes them on demand.
func JoinPieces[E any](els []E, data func(E) []byte, meta func(E) *Meta, field string) Stream {
	src := make([]*LazyPiece, len(els))
	lazy := false
	for i, e := range els {
		b := data(e)
		if b == nil {
			if p := meta(e).lazyPiece(field); p != nil {
				src[i], lazy = p, true
				continue
			}
		}
		src[i] = &LazyPiece{Size: len(b), Decode: func() []byte { return b }}
	}
	if lazy {
		return Stream{store: NewPieceStore(src)}
	}
	pieces := make([][]byte, len(src))
	for i, p := range src {
		pieces[i] = p.Decode()
	}
	if len(pieces) == 1 {
		// The piece itself: a view commit then sees bytes that alias the document.
		return Stream{data: pieces[0]}
	}
	return Stream{data: bytes.Join(pieces, nil)}
}

// SliceOf is the stream slice `s[start..end]` (end < 0: to the end).
func SliceOf(s Stream, start, end int) Stream {
	n := len(s.data)
	if s.store != nil {
		n = s.store.Size()
	}
	if end < 0 {
		end = n
	}
	if start < 0 || end > n || start > end {
		Fail(EOF, "stream slice [%d, %d) is outside the stream of %d bytes", start, end, n)
	}
	if s.store != nil {
		return Stream{store: &sliceStore{s.store, start, end - start}}
	}
	return Stream{data: s.data[start:end:end]}
}

// LazyPiece is a stream piece a view's shallow scan didn't decode: its decoded length when the
// data states it (-1 if not), and how to decode it.
type LazyPiece struct {
	Size   int
	Decode func() []byte
}

// SetLazyPiece records the lazy piece of field `field` (views; see JoinPieces).
func (m *Meta) SetLazyPiece(field string, p *LazyPiece) {
	d := m.data()
	if d.lazy == nil {
		d.lazy = map[string]*LazyPiece{}
	}
	d.lazy[field] = p
}

func (m *Meta) lazyPiece(field string) *LazyPiece {
	if m == nil || m.m == nil {
		return nil
	}
	return m.m.lazy[field]
}

// PieceValue is the value of a stream piece field: the field, or its lazy piece decoded (views).
func PieceValue(b []byte, m *Meta, field string) (out []byte, err error) {
	p := m.lazyPiece(field)
	if b != nil || p == nil {
		return b, nil
	}
	err = Catch(nil, func() { out = p.Decode() })
	return
}

// ── write side ──────────────────────────────────────────────────────────────

// SlicePart is the encoding of a field read from a stream slice `raw[Start..End]` (End -1: to
// the end of the stream).
type SlicePart struct {
	Start, End int
	Data       []byte
}

// AssembleSlices builds a stream from the fields read through its slices: size bytes (-1: up to
// the largest slice end), zero-filled, each part's encoding at its start. Overlapping parts must
// agree, and a part must fit its slice (DERIVE otherwise).
func AssembleSlices(size int, parts []SlicePart) []byte {
	n := size
	if n < 0 {
		n = 0
		for _, p := range parts {
			n = max(n, p.Start+len(p.Data), p.End)
		}
	}
	out := make([]byte, n)
	covered := make([]bool, n)
	for _, p := range parts {
		if p.Start < 0 || (p.End >= 0 && p.End < p.Start) {
			Fail(RANGE, "invalid stream slice [%d, %d)", p.Start, p.End)
		}
		if p.End >= 0 && p.Start+len(p.Data) > p.End {
			Fail(DERIVE, "a field read from the slice [%d, %d) encodes to %d bytes", p.Start, p.End, len(p.Data))
		}
		if p.Start+len(p.Data) > n || p.End > n {
			Fail(DERIVE, "a stream slice ends at %d, after the end of the stream (%d bytes)", max(p.Start+len(p.Data), p.End), n)
		}
		for i, b := range p.Data {
			j := p.Start + i
			if covered[j] && out[j] != b {
				Fail(DERIVE, "overlapping stream slices disagree at byte %d", j)
			}
			out[j] = b
			covered[j] = true
		}
	}
	return out
}

// SplitSpec describes the elements of `T x from arr[*].piece` on the write side.
type SplitSpec[E any] struct {
	// Piece returns an element's piece bytes; SetPiece returns a copy of the element with them
	// replaced (nil element: a new one).
	Piece    func(e E) []byte
	SetPiece func(e E, piece []byte) E
	// Size returns the piece size given in the input (ok=false when absent); nil when pieces
	// have no size field.
	Size func(e E) (int, bool)
	// ClearSize removes the size field from a copy (fit policy: the size is re-derived).
	ClearSize func(e E) E
	// Fit: nil unless the policy is fit. Offset(k) is element k's offset; Measure(e) the size of
	// element e's encoding.
	Offset  func(k int) int
	Measure func(e E) int
	New     func() E
}

// SplitStream splits the encoded stream data into the elements' pieces. Piece sizes given in the
// input win; otherwise the fit policy picks, for element k, the longest piece whose encoded element
// fits before element k+1's offset. A piece equal to an element's original piece keeps it.
func SplitStream[E any](els []E, data []byte, spec SplitSpec[E]) []E {
	keep := func(e E, piece []byte, has bool) E {
		if has {
			if orig := spec.Piece(e); bytes.Equal(orig, piece) && orig != nil {
				return spec.SetPiece(e, orig)
			}
		}
		return spec.SetPiece(e, piece)
	}
	if len(els) > 0 && spec.Size != nil {
		sizes := make([]int, len(els))
		all := true
		for i, e := range els {
			n, ok := spec.Size(e)
			if !ok {
				all = false
				break
			}
			sizes[i] = n
		}
		if all || spec.Offset == nil {
			if !all {
				Fail(INPUT, "split policy \"sizes\" needs every piece's size in the input")
			}
			pieces := splitBySizes(data, sizes)
			out := make([]E, len(els))
			for i, e := range els {
				out[i] = keep(e, pieces[i], true)
			}
			return out
		}
	}
	if spec.Offset == nil {
		Fail(INPUT, "cannot split the stream: give every piece's size in the input")
	}
	var out []E
	pos := 0
	for k := 0; pos < len(data); k++ {
		var base E
		has := k < len(els)
		if has {
			base = els[k]
		} else {
			base = spec.New()
		}
		if spec.ClearSize != nil {
			base = spec.ClearSize(base)
		}
		capacity := spec.Offset(k+1) - spec.Offset(k)
		fits := func(n int) bool {
			ok := false
			e := Try(nil, func() {
				ok = spec.Measure(spec.SetPiece(base, data[pos:pos+n:pos+n])) <= capacity
			})
			if e != nil {
				if e.Code == RANGE {
					return false
				}
				panic(e)
			}
			return ok
		}
		n := len(data) - pos
		if !fits(n) {
			lo, hi := 0, n
			for hi-lo > 1 {
				mid := (lo + hi) / 2
				if fits(mid) {
					lo = mid
				} else {
					hi = mid
				}
			}
			n = lo
		}
		if n == 0 {
			Fail(OVERLAP, "stream piece %d does not fit its block of %d bytes", k, capacity)
		}
		out = append(out, keep(base, data[pos:pos+n:pos+n], has))
		pos += n
	}
	return out
}

// splitBySizes splits data into pieces of the given sizes (DERIVE unless they cover it exactly).
func splitBySizes(data []byte, sizes []int) [][]byte {
	out := make([][]byte, 0, len(sizes))
	at := 0
	for _, n := range sizes {
		if n < 0 || at+n > len(data) {
			Fail(DERIVE, "piece sizes exceed the stream length %d", len(data))
		}
		out = append(out, data[at:at+n:at+n])
		at += n
	}
	if at != len(data) {
		Fail(DERIVE, "piece sizes cover %d of %d stream bytes", at, len(data))
	}
	return out
}

// ── stores ──────────────────────────────────────────────────────────────────

// Store is a random-access byte source.
type Store interface {
	// Size is the number of bytes.
	Size() int
	// Window returns bytes starting at pos, at least min of them (min <= Size() - pos); it may
	// return more (e.g. up to the end of a piece or block).
	Window(pos, min int) []byte
}

type lruEntry[V any] struct {
	key   int
	v     V
	bytes int
}

// lru is a small cache with an entry and a byte budget (the most recent entry always stays).
type lru[V any] struct {
	maxEntries, maxBytes, bytes int
	order                       *list.List
	items                       map[int]*list.Element
}

func newLru[V any](maxEntries, maxBytes int) *lru[V] {
	return &lru[V]{maxEntries: max(1, maxEntries), maxBytes: maxBytes, order: list.New(), items: map[int]*list.Element{}}
}

func (c *lru[V]) get(k int) (V, bool) {
	if e, ok := c.items[k]; ok {
		c.order.MoveToFront(e)
		return e.Value.(*lruEntry[V]).v, true
	}
	var zero V
	return zero, false
}

func (c *lru[V]) set(k int, v V, bytes int) {
	if e, ok := c.items[k]; ok {
		c.bytes -= e.Value.(*lruEntry[V]).bytes
		c.order.Remove(e)
	}
	c.items[k] = c.order.PushFront(&lruEntry[V]{k, v, bytes})
	c.bytes += bytes
	for c.order.Len() > 1 && (c.order.Len() > c.maxEntries || c.bytes > c.maxBytes) {
		last := c.order.Back()
		ent := last.Value.(*lruEntry[V])
		c.order.Remove(last)
		delete(c.items, ent.key)
		c.bytes -= ent.bytes
	}
}

type sliceStore struct {
	inner      Store
	start, len int
}

func (s *sliceStore) Size() int { return s.len }

func (s *sliceStore) Window(pos, min int) []byte {
	w := s.inner.Window(s.start+pos, min)
	if len(w) > s.len-pos {
		w = w[:s.len-pos]
	}
	return w
}

// PieceStore is a virtual stream over pieces decoded on demand.
type PieceStore struct {
	src    []*LazyPiece
	starts []int
	known  int
	cache  *lru[[]byte]
}

// NewPieceStore keeps up to 16 decoded pieces and 64 MiB.
func NewPieceStore(src []*LazyPiece) *PieceStore {
	return &PieceStore{src: src, starts: []int{0}, cache: newLru[[]byte](16, 64<<20)}
}

// learn learns the next piece's length; false when every length is known.
func (s *PieceStore) learn() bool {
	k := s.known
	if k >= len(s.src) {
		return false
	}
	n := s.src[k].Size
	if n < 0 {
		n = len(s.decode(k))
	}
	s.starts = append(s.starts, s.starts[k]+n)
	s.known = k + 1
	return true
}

// Size is the stream's length (pieces without a stated length are decoded to learn it).
func (s *PieceStore) Size() int {
	for s.learn() {
	}
	return s.starts[s.known]
}

func (s *PieceStore) covers(end int) bool {
	for s.starts[s.known] < end && s.learn() {
	}
	return end <= s.starts[s.known]
}

// index is the piece holding offset (offset < the last known start).
func (s *PieceStore) index(offset int) int {
	lo, hi := 0, s.known-1
	for lo < hi {
		mid := (lo + hi + 1) / 2
		if s.starts[mid] <= offset {
			lo = mid
		} else {
			hi = mid - 1
		}
	}
	for lo < s.known-1 && s.starts[lo+1] <= offset {
		lo++
	}
	return lo
}

func (s *PieceStore) decode(k int) []byte {
	if b, ok := s.cache.get(k); ok {
		return b
	}
	b := s.src[k].Decode()
	if k < s.known && len(b) != s.starts[k+1]-s.starts[k] {
		Fail(CODEC, "stream piece %d decoded to %d bytes, its size field says %d", k, len(b), s.starts[k+1]-s.starts[k])
	}
	s.cache.set(k, b, len(b))
	return b
}

func (s *PieceStore) piece(k int) []byte {
	for s.known <= k && s.learn() {
	}
	if k >= s.known {
		Fail(RANGE, "stream piece %d does not exist", k)
	}
	return s.decode(k)
}

// Window returns the rest of the piece holding pos when it has min bytes, else min bytes
// assembled from the pieces they span.
func (s *PieceStore) Window(pos, n int) []byte {
	if !s.covers(pos + max(n, 1)) {
		if n == 0 {
			return nil
		}
		Fail(EOF, "read of %d bytes at 0x%x is past the end of the stream", n, pos)
	}
	k := s.index(pos)
	p := s.piece(k)
	s0 := pos - s.starts[k]
	if len(p)-s0 >= n {
		return p[s0:len(p):len(p)]
	}
	out := make([]byte, 0, n)
	for len(out) < n {
		p = s.piece(k)
		out = append(out, p[s0:min(len(p), s0+n-len(out))]...)
		s0 = 0
		k++
	}
	return out
}

// RangedStore is the decoded side of a `@ranged` codec region: byte i of the input decodes to
// byte i of the output, so any block can be decoded alone given its position.
type RangedStore struct {
	input  []byte
	decode func(input []byte, position int) []byte
	block  int
	cache  *lru[[]byte]
}

// NewRangedStore decodes 4 KiB blocks and keeps up to 256 of them.
func NewRangedStore(input []byte, decode func(input []byte, position int) []byte) *RangedStore {
	return &RangedStore{input: input, decode: decode, block: 0x1000, cache: newLru[[]byte](256, 1<<62)}
}

// Size is the decoded size (the encoded size).
func (s *RangedStore) Size() int { return len(s.input) }

func (s *RangedStore) decodeRange(off, n int) []byte {
	out := s.decode(s.input[off:off+n:off+n], off)
	if len(out) != n {
		Fail(CODEC, "a ranged codec decoded %d bytes into %d (ranged codecs keep the length)", n, len(out))
	}
	return out
}

func (s *RangedStore) blockAt(i int) []byte {
	if b, ok := s.cache.get(i); ok {
		return b
	}
	off := i * s.block
	b := s.decodeRange(off, min(s.block, len(s.input)-off))
	s.cache.set(i, b, len(b))
	return b
}

// Window decodes the blocks [pos, pos+min) touches (large reads in one codec call).
func (s *RangedStore) Window(pos, n int) []byte {
	if pos < 0 || n < 0 || pos+n > len(s.input) {
		Fail(EOF, "read of %d bytes at 0x%x is past the end (0x%x)", n, pos, len(s.input))
	}
	if n == 0 {
		if pos == len(s.input) {
			return nil
		}
		n = 1
	}
	first, last := pos/s.block, (pos+n-1)/s.block
	if last-first >= 8 {
		return s.decodeRange(pos, n)
	}
	if first == last {
		b := s.blockAt(first)
		return b[pos-first*s.block:]
	}
	out := make([]byte, 0, n)
	for i := first; i <= last; i++ {
		b := s.blockAt(i)
		from := max(pos, i*s.block) - i*s.block
		to := min(pos+n, i*s.block+len(b)) - i*s.block
		out = append(out, b[from:to]...)
	}
	return out
}
