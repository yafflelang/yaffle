package yaffle

import "reflect"

// Scans: what generated readers record while a view reads a struct. A shallow scan doesn't follow
// pointer and `at` targets, deferred `from` fields or lazy codec regions; it records where they
// are (with a closure that replays the read) and every field's byte span, per struct value. A
// tracking scan (a full read for a commit) follows everything and records where each value came
// from, for the sticky layout.

// Span is where a field's bytes are, and the addresses of the targets it points at.
type Span struct {
	Start, End int
	Targets    []int
	recs       []*targetRec
}

// targetRec is a pointer or `at` target a scan reached without following it. It keeps the
// generated read closure (bound to the scan's reader, with the endianness, arguments and identity
// key in force there) and the reader state, so a getter can replay exactly that read later.
type targetRec struct {
	r      *Reader
	addr   int
	key    string
	base   int
	end    int
	strict bool
	// follow reads the target like a parse does (identity, cycles); inner reads its value alone.
	follow func() any
	inner  func() any
	// space: the target is not in the document's own bytes (a stream or decoded region).
	space bool
}

// replay runs f on the recorded reader (over the bytes it was reading), reset to the state the
// target was found in, with sc (nil: plain read) and path stack ps.
func (t *targetRec) replay(sc *scanState, ps *PathStack, f func() any) any {
	r := t.r
	r.Pos, r.Base, r.End, r.Index, r.Strict = t.addr, t.base, t.end, -1, t.strict
	r.MaxEnd, r.sc, r.PS, r.into = t.addr, sc, ps, nil
	r.ident, r.identEnd, r.inProgress = nil, nil, nil
	return f()
}

// ObjRec is what a scan recorded about one struct value.
type ObjRec struct {
	Obj       any
	Type      reflect.Type
	Start     int
	InlineEnd int
	End       int
	Base      int
	RegionEnd int
	Index     int
	Strict    bool
	IsBase    bool
	ChildSafe bool
	Args      []any
	Fields    map[string]*Span
	Parent    *ObjRec
}

type recKey struct {
	pos int
	t   reflect.Type
}

type slotKey struct {
	owner any
	field string
}

type origin struct{ pos, size int }

type scanFrame struct {
	rec   *ObjRec
	field string
}

type scanState struct {
	shallow  bool
	tracking bool
	frames   []*scanFrame
	recs     map[recKey]*ObjRec
	byObj    map[any]*ObjRec
	origins  map[any]origin
	slots    map[slotKey]origin
	lastLeft *ObjRec
	// pseudo is the frame of a non-struct target node's scan (see enterPseudo).
	pseudo *ObjRec
	// path is the path of the node being scanned (lazy pieces report absolute paths).
	path []any
}

func newScanState(shallow bool) *scanState {
	return &scanState{
		shallow: shallow, tracking: !shallow, recs: map[recKey]*ObjRec{}, byObj: map[any]*ObjRec{},
		origins: map[any]origin{}, slots: map[slotKey]origin{},
	}
}

func (s *scanState) top() *scanFrame {
	if len(s.frames) == 0 {
		return nil
	}
	return s.frames[len(s.frames)-1]
}

// span is the span of the field being read, if any.
func (s *scanState) span() *Span {
	if t := s.top(); t != nil && t.field != "" {
		return t.rec.Fields[t.field]
	}
	return nil
}

func (s *scanState) enter(r *Reader, v any) {
	rec := &ObjRec{
		Obj: v, Type: reflect.TypeOf(v), Start: r.Pos, InlineEnd: -1, End: -1, Base: r.Base,
		RegionEnd: r.End, Index: r.Index, Strict: r.Strict, ChildSafe: true, Fields: map[string]*Span{},
	}
	if t := s.top(); t != nil {
		rec.Parent = t.rec
	}
	s.frames = append(s.frames, &scanFrame{rec: rec})
	s.recs[recKey{rec.Start, rec.Type}] = rec
	s.byObj[v] = rec
}

func (s *scanState) closeField(r *Reader, t *scanFrame) {
	if t.field != "" {
		if sp := t.rec.Fields[t.field]; sp != nil && sp.End < 0 {
			sp.End = r.Pos
		}
	}
}

func (s *scanState) field(r *Reader, name string) {
	t := s.top()
	if t == nil {
		return
	}
	s.closeField(r, t)
	t.field = name
	if name != "" {
		if _, ok := t.rec.Fields[name]; !ok {
			t.rec.Fields[name] = &Span{Start: r.Pos, End: -1}
		}
	}
}

func (s *scanState) leave(r *Reader) {
	t := s.top()
	if t == nil {
		return
	}
	s.closeField(r, t)
	t.rec.End = r.Pos
	if t.rec.InlineEnd < 0 {
		t.rec.InlineEnd = r.Pos
	}
	s.frames = s.frames[:len(s.frames)-1]
	s.lastLeft = t.rec
}

// ElemField is the pseudo field of a target that is not a struct (an array of pointers): the
// targets its elements point at are recorded under it.
const ElemField = "*"

// enterPseudo starts the frame of a non-struct target's scan.
func (s *scanState) enterPseudo(pos int) {
	rec := &ObjRec{Start: pos, InlineEnd: -1, End: -1, Index: -1, ChildSafe: true,
		Fields: map[string]*Span{ElemField: {Start: pos, End: -1}}}
	s.pseudo = rec
	s.frames = append(s.frames, &scanFrame{rec: rec, field: ElemField})
}

func (s *scanState) leavePseudo(r *Reader) {
	if len(s.frames) > 0 && s.frames[len(s.frames)-1].rec == s.pseudo {
		s.leave(r)
	}
}

func (s *scanState) target(r *Reader, addr int, key string, follow, inner func() any) {
	if sp := s.span(); sp != nil {
		sp.Targets = append(sp.Targets, addr)
		sp.recs = append(sp.recs, &targetRec{r: r, addr: addr, key: key, base: r.Base, end: r.End, strict: r.Strict, follow: follow, inner: inner, space: r.space})
	}
}

// origin records where a value read by a tracking scan came from (the commit's sticky layout
// keeps it there).
func (s *scanState) origin(r *Reader, v any, addr, end int) {
	if !s.tracking {
		return
	}
	o := origin{addr, end - addr}
	if id := ValueID(v); id != nil {
		if _, ok := s.origins[id]; !ok {
			s.origins[id] = o
		}
	}
	if t := s.top(); t != nil && t.field != "" {
		k := slotKey{t.rec.Obj, t.field}
		if _, ok := s.slots[k]; !ok {
			s.slots[k] = o
		}
	}
}

// ValueID identifies a value for target sharing and commit origins: struct pointers and
// non-empty slices (nil for everything else).
func ValueID(v any) any {
	if v == nil {
		return nil
	}
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Pointer:
		if rv.IsNil() {
			return nil
		}
		return v
	case reflect.Slice:
		if rv.Len() == 0 {
			return nil
		}
		return sliceKey{rv.UnsafePointer(), rv.Len(), rv.Type()}
	}
	return nil
}

// ── reader hooks ────────────────────────────────────────────────────────────

// Scanning reports whether a view is scanning (generated readers then record their arguments).
func (r *Reader) Scanning() bool { return r.sc != nil }

// Lazy reports whether a view's shallow scan is running: codec regions of fields nothing else
// reads are skipped (decoded when a getter reads them).
func (r *Reader) Lazy() bool { return r.sc != nil && r.sc.shallow }

// viewFlags is the first argument generated readers pass to NoteArgs: whether in-place edits
// inside the struct's inline children can't change its derived values.
type viewFlags bool

// ChildSafe marks NoteArgs' first argument.
func ChildSafe(b bool) any { return viewFlags(b) }

// NoteArgs records the arguments of the struct being read (views re-encode fields with them).
func (r *Reader) NoteArgs(args ...any) {
	if r.sc == nil {
		return
	}
	if t := r.sc.top(); t != nil {
		if len(args) > 0 {
			if cs, ok := args[0].(viewFlags); ok {
				t.rec.ChildSafe = bool(cs)
				args = args[1:]
			}
		}
		t.rec.Args = args
	}
}

// NoTarget records a null pointer while a view scans (element targets keep their indices).
func (r *Reader) NoTarget() {
	if r.sc == nil {
		return
	}
	if sp := r.sc.span(); sp != nil {
		sp.Targets = append(sp.Targets, -1)
		sp.recs = append(sp.recs, nil)
	}
}

// MarkInline records the end of a base struct's inline bytes (before its targets).
func (r *Reader) MarkInline() {
	if r.sc == nil {
		return
	}
	if t := r.sc.top(); t != nil {
		t.rec.InlineEnd = r.Pos
		t.rec.IsBase = true
	}
}

// BeginBase is called by base struct readers: inside a base struct nested in a view's scan,
// targets are followed (its extent depends on them). It returns the state EndBase restores.
func (r *Reader) BeginBase() bool {
	if r.sc == nil || len(r.sc.frames) <= 1 {
		return false
	}
	return r.BeginDeep()
}

// EndBase restores the state saved by BeginBase, and records the extent of the base struct that
// just ended (sticky layouts keep its region together).
func (r *Reader) EndBase(saved bool) {
	if r.sc == nil {
		return
	}
	if l := r.sc.lastLeft; l != nil && l.IsBase {
		l.End = r.Pos
	}
	r.EndDeep(saved)
}

// BeginDeep is called by readers of structs whose read-side expressions read targets: while a
// view scans them, targets are followed (and still recorded). It returns the state EndDeep
// restores.
func (r *Reader) BeginDeep() bool {
	if r.sc == nil || !r.sc.shallow {
		return false
	}
	r.sc.shallow = false
	return true
}

// EndDeep restores the state saved by BeginDeep.
func (r *Reader) EndDeep(saved bool) {
	if saved && r.sc != nil {
		r.sc.shallow = true
	}
}

// Defer is called by generated readers while a view scans shallowly: the field being read (a
// `from` stream, a lazy codec region) is not read now; getters replay read (with the scan's
// state for views of it, without for values).
func (r *Reader) Defer(name string, read func() any) {
	if r.sc == nil {
		return
	}
	r.sc.target(r, r.Pos, "\x00"+name, read, read)
	if sp := r.sc.span(); sp != nil && len(sp.recs) > 0 {
		sp.recs[len(sp.recs)-1].space = true
	}
}

// NewLazyPiece makes a stream piece decoded on demand (views). Its errors report the path the
// scan was at, as a parse reports them.
func (r *Reader) NewLazyPiece(size int, decode func() []byte) *LazyPiece {
	path := r.PS.Snapshot()
	if r.sc != nil {
		path = append(append([]any{}, r.sc.path...), path...)
	}
	return &LazyPiece{Size: size, Decode: func() []byte {
		defer func() {
			if p := recover(); p != nil {
				if e, ok := p.(*Error); ok && !e.abs {
					e.Path = append(append([]any{}, path...), e.Path...)
					e.sealed, e.abs = true, true
				}
				panic(p)
			}
		}()
		return decode()
	}}
}

// SubView is Sub inside a view's deferred read: the stream's contents are scanned too.
func (r *Reader) SubView(s Stream) *Reader {
	c := r.Sub(s)
	c.sc, c.space = r.sc, true
	return c
}

// DecodedView is Decoded inside a view's deferred read: the decoded contents are scanned too.
func (r *Reader) DecodedView(data []byte, at int) *Reader {
	c := r.Decoded(data, at)
	c.sc, c.space = r.sc, true
	return c
}

// RangedView reads a @ranged codec region inside a view's deferred read: only the blocks a
// read touches are decoded.
func (r *Reader) RangedView(codec Codec, name string, input []byte, ctx *CodecCtx, at int) *Reader {
	offset := r.At(at)
	store := NewRangedStore(input, func(in []byte, pos int) []byte {
		c := *ctx
		c.Position = pos
		return Decode(codec, name, in, &c, offset)
	})
	c := r.childStore(store, at)
	c.sc, c.space = r.sc, true
	return c
}
