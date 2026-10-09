package yaffle

import (
	"fmt"
	"reflect"
)

// Materializing through views: generated `Materialize…View` functions read every field of a
// document through its view getters (child views for structs, targets read on demand) and build
// the plain value. The conformance suite's view mode uses them (docs/CONFORMANCE.md §7): the
// result must equal what a parse gives.

// Mat remembers the values built while reading a document through its views: one value per
// struct (address, type, arguments) and per shared array, so shared targets stay shared as in a
// parse.
type Mat struct {
	seen map[matKey]any
}

type matKey struct {
	doc *Doc
	// space is the scanner of a node outside the document's bytes (positions are its own).
	space *Node
	pos   int
	typ   reflect.Type
	args  string
	n     int
}

// NewMat starts a materialization.
func NewMat() *Mat { return &Mat{seen: map[matKey]any{}} }

func (n *Node) matKey(typ reflect.Type, count int) matKey {
	k := matKey{doc: n.doc, pos: n.pos, typ: n.typ, n: count}
	if n.scanner != nil && n.scanner.inSpace {
		k.space = n.scanner
	}
	if rec, _ := n.Rec(); rec != nil {
		k.pos = rec.Start
		k.typ = rec.Type
		if len(rec.Args) > 0 {
			k.args = fmt.Sprint(rec.Args...)
		}
	}
	if typ != nil {
		k.typ = typ
	}
	return k
}

// MatGet returns the value already built for the node's struct.
func MatGet[T any](m *Mat, n *Node) (*T, bool) {
	v, ok := m.seen[n.matKey(nil, -1)]
	if !ok {
		return nil, false
	}
	return v.(*T), true
}

// MatPut records the value built for the node's struct (before its fields, so cycles end).
func MatPut[T any](m *Mat, n *Node, v *T) { m.seen[n.matKey(nil, -1)] = v }

// MatSlice returns the shared slice of an array target whose first element's view is first
// (empty arrays are never shared), building it with build on first use.
func MatSlice[T any](m *Mat, first *Node, count int, build func() ([]T, error)) ([]T, error) {
	if first == nil || count == 0 {
		return build()
	}
	k := first.matKey(reflect.TypeOf([]T(nil)), count)
	if v, ok := m.seen[k]; ok {
		return v.([]T), nil
	}
	s, err := build()
	if err == nil {
		m.seen[k] = s
	}
	return s, err
}
