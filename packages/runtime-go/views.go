package yaffle

import (
	"bytes"
	"context"
	"reflect"
	"sort"
	"unsafe"
)

// Views: lazy access to a document, in-place patches and surgical commits.
//
//   - A view node is opened by *scanning* a struct: generated readers run in a shallow mode where
//     pointer and `at` targets are not followed; their addresses and every field's byte span are
//     recorded (per struct value, so inline children get views without another scan).
//   - Getters read what they need: scalars come from the scan, targets are read on demand, and
//     anything else from a full read of the node.
//   - Setting a field re-encodes it; when the size is unchanged, nothing derived depends on it
//     and it doesn't steer later reads, the bytes are patched in place. Otherwise the edit is
//     structural: it is recorded and applied to a full parse at commit time.
//   - Commit: only in-place patches → those patches (nothing else is read). Structural edits →
//     the document is parsed, edited and re-serialized with a *sticky* layout (targets keep their
//     positions where the grow policy allows, codec regions reuse their bytes), and the result is
//     diffed against the original into patches.

// ── documents and nodes ─────────────────────────────────────────────────────

// RootSpec is what a root view needs from generated code.
type RootSpec struct {
	Strict bool
	Ctx    context.Context
	Args   []any
	// Read reads the root struct (struct-level layers included) with the root arguments.
	Read func(r *Reader) any
	// Write writes a root value (from a parse of the document) with the root arguments.
	Write  func(w *Writer, v any) LEntry
	Layout []LayoutItem
}

// Patch is an edit of the original bytes: at At, Remove bytes were replaced by Insert.
type Patch struct {
	At     int
	Remove int
	Insert []byte
}

// CommitOptions says how size changes are handled: Grow is "" or "default" (targets that grow
// move to the end, everything else stays unless pushed), "append" (pushed targets move to the end
// too), "splice" (every size change shifts what follows) or "error".
type CommitOptions struct {
	Grow string
}

type inPlace struct {
	at   int
	data []byte
	rec  *ObjRec
}

type structEdit struct {
	pos   int
	typ   reflect.Type
	apply func(obj any)
}

type nodeKey struct {
	pos int
	key string
}

// Doc is the document behind a family of views.
type Doc struct {
	orig    []byte
	cur     []byte
	patches []inPlace
	edits   []structEdit
	version int
	spec    RootSpec
	root    *Node
	nodes   map[nodeKey]*Node
	targets map[targetKey]any
}

// Node is a view of one struct value of a document.
type Node struct {
	doc     *Doc
	scanner *Node
	// inSpace: the node is not in the document's own bytes (a stream or decoded region): it can
	// be read but not edited.
	inSpace bool
	pos     int
	typ     reflect.Type
	path    []any
	// Scanning nodes: a function reading the struct, its read context, the last shallow scan and
	// the last full read.
	scan   func(r *Reader) any
	base   int
	end    int
	index  int
	strict bool
	args   []any
	ver    int
	sc     *scanState
	obj    any
	err    error
	full   *scanState
	fobj   any
	fver   int
	ferr   error
}

// OpenView opens a root view of data.
func OpenView(data []byte, spec RootSpec) (*Node, error) {
	if spec.Ctx == nil {
		spec.Ctx = context.Background()
	}
	d := &Doc{orig: data, cur: append([]byte{}, data...), spec: spec, nodes: map[nodeKey]*Node{}, targets: map[targetKey]any{}}
	d.root = d.newRoot()
	if _, err := d.root.Rec(); err != nil {
		return nil, err
	}
	return d.root, nil
}

func (d *Doc) newRoot() *Node {
	n := &Node{doc: d, pos: 0, scan: d.spec.Read, base: 0, end: -1, index: -1, strict: d.spec.Strict, args: d.spec.Args, ver: -1, fver: -1, path: []any{}}
	n.scanner = n
	return n
}

// Doc is the node's document.
func (n *Node) Doc() *Doc { return n.doc }

// Offset is the absolute position of the struct's first byte.
func (n *Node) Offset() int { return n.pos }

// Size is the size of the struct's bytes (a base struct includes its targets).
func (n *Node) Size() (int, error) {
	rec, err := n.Rec()
	if err != nil {
		return 0, err
	}
	if rec == nil {
		return 0, nil
	}
	return rec.End - rec.Start, nil
}

// Path is the node's path from the root.
func (n *Node) Path() []any { return n.path }

// scanStruct reads a scanning node's struct with a scan (shallow: targets are not followed) and
// applies the structural edits to the values it recorded, so they stay visible after rescans.
func (s *Node) scanStruct(shallow bool) (*scanState, any, error) {
	d := s.doc
	r := NewReader(d.cur, s.strict)
	r.Ctx = d.spec.Ctx
	r.Pos, r.Base, r.Index, r.MaxEnd = s.pos, s.base, s.index, s.pos
	if s.end >= 0 {
		r.End = s.end
	}
	r.sc = newScanState(shallow)
	r.sc.path = s.path
	var obj any
	err := Catch(r.PS, func() { obj = s.scan(r) })
	if e, ok := AsError(err); ok && !e.abs {
		e.Path = append(append([]any{}, s.path...), e.Path...)
	}
	if err == nil {
		for _, e := range s.edits() {
			if rec := r.sc.recs[recKey{e.pos, e.typ}]; rec != nil {
				e.apply(rec.Obj)
			}
		}
	}
	return r.sc, obj, err
}

// ensure scans the node's struct unless the last scan is of the current document.
func (n *Node) ensure() {
	s := n.scanner
	if s.ver == s.doc.version && (s.sc != nil || s.err != nil) {
		return
	}
	sc, obj, err := s.scanStruct(true)
	s.ver, s.err = s.doc.version, err
	if err != nil {
		s.sc = nil
		return
	}
	s.sc, s.obj = sc, obj
	if s.typ == nil {
		s.typ = reflect.TypeOf(obj)
	}
	if p := sc.pseudo; p != nil {
		p.Obj, p.Type = obj, reflect.TypeOf(obj)
	}
}

// Rec returns what the last scan recorded about the node's struct (nil when its bytes are not
// in the document, e.g. inside a codec region), scanning if the document changed.
func (n *Node) Rec() (*ObjRec, error) {
	n.ensure()
	s := n.scanner
	if s.err != nil {
		return nil, s.err
	}
	if n == s {
		if reflect.TypeOf(s.obj).Kind() != reflect.Pointer {
			return s.sc.pseudo, nil
		}
		return s.sc.byObj[s.obj], nil
	}
	rec := s.sc.recs[recKey{n.pos, n.typ}]
	if rec == nil {
		return nil, newErr(INPUT, -1, "the view's value no longer exists")
	}
	return rec, nil
}

// Object returns the scanned (shallow) value of the node: targets are not followed.
func (n *Node) Object() (any, error) {
	rec, err := n.Rec()
	if err != nil {
		return nil, err
	}
	if rec == nil {
		return n.scanner.obj, nil
	}
	return rec.Obj, nil
}

// Index is the struct's index in its enclosing array (-1 if none).
func (n *Node) Index() int {
	rec, _ := n.Rec()
	if rec == nil {
		return n.scanner.index
	}
	return rec.Index
}

// TargetCount is the number of targets a field points at (arrays of pointers).
func (n *Node) TargetCount(field string) (int, error) {
	sp, err := n.span(field)
	if err != nil || sp == nil {
		return 0, err
	}
	return len(sp.Targets), nil
}

// EncodeWith runs a writer callback in a fresh region and returns the bytes (view patch encoders).
func EncodeWith(f func(w *Writer)) []byte {
	w := NewWriter(nil)
	return w.Serialize(func() LEntry {
		f(w)
		return nil
	})
}

// Shallow returns the node's scanned value.
func Shallow[T any](n *Node) (*T, error) {
	o, err := n.Object()
	if err != nil {
		return nil, err
	}
	return o.(*T), nil
}

// Arg returns argument i of the struct (0 is endian).
func (n *Node) Arg(i int) any {
	rec, _ := n.Rec()
	var a []any
	if rec != nil && rec.Args != nil {
		a = rec.Args
	} else {
		a = n.scanner.args
	}
	if i < len(a) {
		return a[i]
	}
	return nil
}

// Child returns the view node of an inline struct value found by the node's scan. path are the
// segments from the node (field name, index).
func (n *Node) Child(obj any, path ...any) (*Node, error) {
	n.ensure()
	s := n.scanner
	if s.err != nil {
		return nil, s.err
	}
	rec := s.sc.byObj[obj]
	if rec == nil {
		return nil, newErr(INPUT, -1, "no view of this value (it is not in the document's bytes)")
	}
	return &Node{doc: n.doc, scanner: s, pos: rec.Start, typ: rec.Type, path: append(append([]any{}, n.path...), path...)}, nil
}

// edits are the structural edits that apply to the node's records (none for nodes outside the
// document's bytes: their positions are in another space).
func (n *Node) edits() []structEdit {
	if n.inSpace {
		return nil
	}
	return n.doc.edits
}

// fullParse reads the node's struct completely (targets followed, origins tracked), once per
// document version.
func (n *Node) fullParse() (*scanState, any, error) {
	s := n.scanner
	if s.fver != s.doc.version {
		s.full, s.fobj, s.ferr = s.scanStruct(false)
		s.fver = s.doc.version
	}
	return s.full, s.fobj, s.ferr
}

// Full returns the node's value read completely (targets followed).
func Full[T any](n *Node) (*T, error) {
	sc, obj, err := n.fullParse()
	if err != nil {
		return nil, err
	}
	if n == n.scanner {
		return obj.(*T), nil
	}
	rec := sc.recs[recKey{n.pos, n.typ}]
	if rec == nil {
		return nil, newErr(INPUT, -1, "the view's value no longer exists")
	}
	return rec.Obj.(*T), nil
}

// span is what the scan recorded about a field (nil: the field is absent).
func (n *Node) span(field string) (*Span, error) {
	rec, err := n.Rec()
	if err != nil || rec == nil {
		return nil, err
	}
	return rec.Fields[field], nil
}

// TargetAddr returns the address of target idx of a pointer or `at` field (ok=false: null or not
// in the document).
func (n *Node) TargetAddr(field string, idx int) (int, bool, error) {
	sp, err := n.span(field)
	if err != nil || sp == nil || idx >= len(sp.Targets) {
		return 0, false, err
	}
	return sp.Targets[idx], true, nil
}

// target returns the recorded target idx of a pointer or `at` field (nil: null pointer, or the
// field is absent).
func (n *Node) target(field string, idx int) (*targetRec, error) {
	sp, err := n.span(field)
	if err != nil || sp == nil || idx >= len(sp.recs) {
		return nil, err
	}
	return sp.recs[idx], nil
}

// ReadTarget reads target idx of a pointer or `at` field: the read the scan skipped, replayed
// (positioned at the target, with the endianness and arguments in force there). ok=false when the
// field has no such target (null pointer). Reads of one address and identity key give the same
// value until the document changes, as in a parse. path is appended to the field in
// error paths (an element index).
func ReadTarget[T any](n *Node, field string, idx int, path ...any) (v T, ok bool, err error) {
	t, err := n.target(field, idx)
	if err != nil || t == nil {
		return v, false, err
	}
	ck := targetKey{t.addr, t.key}
	if hit, found := n.doc.targets[ck]; found {
		return hit.(T), true, nil
	}
	ps := &PathStack{}
	var x any
	err = Catch(ps, func() { x = t.replay(nil, ps, t.follow) })
	if err != nil {
		if e, ok := AsError(err); ok && !e.abs {
			p := append([]any{}, n.path...)
			if field != ElemField {
				p = append(p, field)
			}
			e.Path = append(append(p, path...), e.Path...)
		}
		return v, false, err
	}
	v, _ = x.(T)
	n.doc.targets[ck] = v
	return v, true, nil
}

type targetKey struct {
	addr int
	key  string
}

// TargetView opens a view of the struct at target idx of a pointer or `at` field (nil, false for
// a null pointer). One address and identity key give one node. path is appended to the field in
// the view's path (an element index).
func (n *Node) TargetView(field string, idx int, path ...any) (*Node, bool, error) {
	t, err := n.target(field, idx)
	if err != nil || t == nil {
		return nil, false, err
	}
	k := nodeKey{t.addr, t.key}
	if c := n.doc.nodes[k]; c != nil {
		return c, true, nil
	}
	p := append([]any{}, n.path...)
	if field != ElemField {
		p = append(p, field)
	}
	c := &Node{doc: n.doc, pos: t.addr, base: t.base, end: t.end, index: -1, strict: t.strict, ver: -1, fver: -1,
		path: append(p, path...)}
	c.inSpace = t.space || n.scanner.inSpace
	c.scan = func(r *Reader) any {
		if r.sc != nil {
			r.sc.enterPseudo(t.addr)
		}
		v := t.replay(r.sc, r.PS, t.inner)
		if r.sc != nil {
			r.sc.leavePseudo(t.r)
		}
		return v
	}
	c.scanner = c
	if _, err := c.Rec(); err != nil {
		return nil, false, err
	}
	n.doc.nodes[k] = c
	return c, true, nil
}

// Set sets a field. enc (nil when the field can't be patched in place) encodes the new value
// given the struct's current value; apply stores it into a struct value. Same-size encodings of
// patchable fields are patched in place; anything else is a structural edit applied at commit.
func (n *Node) Set(field string, enc func(obj any) []byte, apply func(obj any)) error {
	rec, err := n.Rec()
	if err != nil {
		return err
	}
	if n.scanner.inSpace {
		return newErr(INPUT, -1, "not implemented: editing values inside a stream or a codec region through a view (set the enclosing field instead)")
	}
	if enc != nil {
		obj, _ := n.Object()
		var out []byte
		ps := &PathStack{}
		if err := Catch(ps, func() { out = enc(obj) }); err != nil {
			if e, ok := AsError(err); ok {
				e.Path = append(append(append([]any{}, n.path...), field), e.Path...)
			}
			return err
		}
		if rec != nil {
			if sp := rec.Fields[field]; sp != nil && sp.End >= 0 && sp.End-sp.Start == len(out) {
				n.doc.patch(sp.Start, out, rec)
				return nil
			}
		}
	}
	d := n.doc
	pos, typ := n.pos, n.typ
	if n == n.scanner {
		if rec == nil {
			return newErr(INPUT, -1, "this view's value can't be edited (it is not in the document's bytes)")
		}
		pos, typ = rec.Start, rec.Type
	}
	d.edits = append(d.edits, structEdit{pos: pos, typ: typ, apply: apply})
	for _, s := range []*Node{d.root, n.scanner} {
		if s.full != nil && s.fver == d.version && s.ferr == nil {
			if r := s.full.recs[recKey{pos, typ}]; r != nil {
				apply(r.Obj)
			}
		}
	}
	obj, _ := n.Object()
	apply(obj)
	return nil
}

func (d *Doc) patch(at int, data []byte, rec *ObjRec) {
	copy(d.cur[at:], data)
	d.patches = append(d.patches, inPlace{at: at, data: append([]byte{}, data...), rec: rec})
	d.version++
	for k := range d.targets {
		delete(d.targets, k)
	}
}

// Bytes returns the document's current bytes (in-place patches applied; structural edits are
// only applied by Commit).
func (d *Doc) Bytes() []byte { return d.cur }

// Patches returns the edits as patches against the original bytes (no side effects).
func (n *Node) Patches(o CommitOptions) ([]Patch, error) {
	p, _, err := n.doc.plan(o)
	return p, err
}

// Commit applies all edits, returns the new bytes and rebinds the document (and the root view) to
// them. Other views of the document must be opened again.
func (n *Node) Commit(o CommitOptions) ([]byte, error) {
	d := n.doc
	_, out, err := d.plan(o)
	if err != nil {
		return nil, err
	}
	d.orig = out
	d.cur = append([]byte{}, out...)
	d.patches = nil
	d.edits = nil
	d.version++
	d.nodes = map[nodeKey]*Node{}
	d.targets = map[targetKey]any{}
	*d.root = *d.newRoot()
	d.root.scanner = d.root
	return out, nil
}

func (d *Doc) fastPathOK() bool {
	if len(d.edits) > 0 {
		return false
	}
	for _, p := range d.patches {
		for a := p.rec.Parent; a != nil; a = a.Parent {
			if !a.ChildSafe {
				return false
			}
		}
	}
	return true
}

func (d *Doc) inPlacePatches() []Patch {
	if len(d.patches) == 0 {
		return nil
	}
	type rng struct{ a, b int }
	var rs []rng
	for _, p := range d.patches {
		rs = append(rs, rng{p.at, p.at + len(p.data)})
	}
	sort.Slice(rs, func(i, j int) bool { return rs[i].a < rs[j].a })
	var merged []rng
	for _, r := range rs {
		if len(merged) > 0 && r.a <= merged[len(merged)-1].b {
			if r.b > merged[len(merged)-1].b {
				merged[len(merged)-1].b = r.b
			}
			continue
		}
		merged = append(merged, r)
	}
	out := make([]Patch, 0, len(merged))
	for _, m := range merged {
		out = append(out, Patch{At: m.a, Remove: m.b - m.a, Insert: append([]byte{}, d.cur[m.a:m.b]...)})
	}
	return out
}

// ApplyPatches applies patches (sorted, non-overlapping, original coordinates) to orig.
func ApplyPatches(orig []byte, patches []Patch) []byte {
	var out []byte
	o := 0
	for _, p := range patches {
		out = append(out, orig[o:p.At]...)
		out = append(out, p.Insert...)
		o = p.At + p.Remove
	}
	return append(out, orig[o:]...)
}

func (d *Doc) plan(o CommitOptions) ([]Patch, []byte, error) {
	if d.fastPathOK() {
		p := d.inPlacePatches()
		return p, ApplyPatches(d.orig, p), nil
	}
	grow := o.Grow
	if grow == "" {
		grow = "default"
	}
	sc, root, err := d.root.fullParse()
	if err != nil {
		return nil, nil, err
	}
	rootRec := sc.byObj[root]
	origRoot := -1
	if rootRec != nil {
		origRoot = rootRec.InlineEnd - rootRec.Start
	}
	w := NewWriter(d.spec.Layout)
	w.Ctx = d.spec.Ctx
	if origRoot >= 0 {
		w.Region.Sticky = &StickyPolicy{Grow: grow, OrigRootSize: origRoot, OrigSize: len(d.cur)}
	}
	w.Commit = &CommitHooks{
		Origin: func(v any) (int, int, bool) {
			id := ValueID(v)
			if id == nil {
				return 0, 0, false
			}
			og, ok := sc.origins[id]
			return og.pos, og.size, ok
		},
		SlotOrigin: func(owner any, field string) (int, int, bool) {
			og, ok := sc.slots[slotKey{owner, field}]
			return og.pos, og.size, ok
		},
		RegionOrigin: func(v any) (int, int, int, bool) {
			rec := sc.byObj[v]
			if rec == nil || !rec.IsBase || rec.InlineEnd < 0 {
				return 0, 0, 0, false
			}
			return rec.Start, rec.InlineEnd - rec.Start, rec.End - rec.Start, true
		},
	}
	if len(d.patches) == 0 {
		w.provBuf = d.cur
	}
	var out []byte
	err = Catch(w.PS, func() { out = w.Serialize(func() LEntry { return d.spec.Write(w, root) }) })
	if err != nil {
		return nil, nil, err
	}
	if grow == "error" && len(out) != len(d.orig) {
		return nil, nil, newErr(DERIVE, -1, "the data changed size from %d to %d bytes (grow: \"error\")", len(d.orig), len(out))
	}
	return Diff(d.orig, out, w.Region.anchors()), out, nil
}

// Anchor is a range of the output copied unchanged from the original (provenance).
type Anchor struct{ N, O, Len int }

// Diff returns patches turning orig into out. Anchors are ranges known to be copied unchanged;
// between them the bytes are compared.
func Diff(orig, out []byte, anchors []Anchor) []Patch {
	sorted := append([]Anchor{}, anchors...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].N < sorted[j].N })
	var chain []Anchor
	lastO, lastN := 0, 0
	for _, a := range sorted {
		if a.Len > 0 && a.O >= lastO && a.N >= lastN && a.O+a.Len <= len(orig) && bytes.Equal(orig[a.O:a.O+a.Len], out[a.N:a.N+a.Len]) {
			chain = append(chain, a)
			lastO, lastN = a.O+a.Len, a.N+a.Len
		}
	}
	var patches []Patch
	segment := func(n0, n1, o0, o1 int) {
		nl, ol := n1-n0, o1-o0
		if nl == ol {
			for i := 0; i < nl; {
				if out[n0+i] == orig[o0+i] {
					i++
					continue
				}
				j, same := i+1, 0
				for j < nl && same < 8 {
					if out[n0+j] == orig[o0+j] {
						same++
					} else {
						same = 0
					}
					j++
				}
				end := j - same
				patches = append(patches, Patch{At: o0 + i, Remove: end - i, Insert: append([]byte{}, out[n0+i:n0+end]...)})
				i = j
			}
			return
		}
		p := 0
		for p < nl && p < ol && out[n0+p] == orig[o0+p] {
			p++
		}
		s := 0
		for s < nl-p && s < ol-p && out[n1-1-s] == orig[o1-1-s] {
			s++
		}
		patches = append(patches, Patch{At: o0 + p, Remove: ol - p - s, Insert: append([]byte{}, out[n0+p:n1-s]...)})
	}
	n, o := 0, 0
	for _, a := range chain {
		segment(n, a.N, o, a.O)
		n, o = a.N+a.Len, a.O+a.Len
	}
	segment(n, len(out), o, len(orig))
	var res []Patch
	for _, p := range patches {
		if p.Remove > 0 || len(p.Insert) > 0 {
			res = append(res, p)
		}
	}
	return res
}

// aliasOffset is the offset of b inside buf, or -1 if b doesn't alias it.
func aliasOffset(buf, b []byte) int {
	if len(b) == 0 || len(buf) == 0 {
		return -1
	}
	p := uintptr(unsafe.Pointer(unsafe.SliceData(b)))
	base := uintptr(unsafe.Pointer(unsafe.SliceData(buf)))
	if p >= base && p+uintptr(len(b)) <= base+uintptr(len(buf)) {
		return int(p - base)
	}
	return -1
}
