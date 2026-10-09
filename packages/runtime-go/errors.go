// Package yaffle is the runtime used by Go code that the yaffle compiler generates.
//
// Generated readers and writers report failures by panicking with an *Error; the public entry
// points of generated packages (ParseX, SerializeX, XFromJSON, …) recover those panics and return
// them as ordinary errors. Code outside generated packages only ever sees errors.
package yaffle

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// Code is a stable error code (docs/CONFORMANCE.md §4).
type Code string

// Error codes.
const (
	EOF     Code = "EOF"
	CHECK   Code = "CHECK"
	RANGE   Code = "RANGE"
	UNION   Code = "UNION"
	CODEC   Code = "CODEC"
	INPUT   Code = "INPUT"
	DERIVE  Code = "DERIVE"
	REF     Code = "REF"
	OVERLAP Code = "OVERLAP"
)

// Error is every failure the runtime or generated code reports.
type Error struct {
	Code Code
	// Path lists field names (string) and array indices (int) from the root to the innermost
	// field or element being read or written.
	Path []any
	// Offset is the absolute byte offset for read errors, -1 for write errors.
	Offset int
	// Detail is the message without path and offset decoration.
	Detail string
	// Causes holds the error of every variant of a UNION error, in order.
	Causes []*Error
	// sealed: the path is complete (errors raised after layout know their full path).
	sealed bool
	// abs: the path is absolute from the root (errors of lazily decoded view pieces).
	abs bool
}

func (e *Error) Error() string {
	var b strings.Builder
	b.WriteString(string(e.Code))
	if len(e.Path) > 0 {
		b.WriteString(" at ")
		b.WriteString(FormatPath(e.Path))
	}
	if e.Offset >= 0 {
		b.WriteString(" (offset 0x")
		b.WriteString(strconv.FormatInt(int64(e.Offset), 16))
		b.WriteString(")")
	}
	b.WriteString(": ")
	b.WriteString(e.Detail)
	return b.String()
}

// FormatPath renders a path as `a.b[3].c`.
func FormatPath(path []any) string {
	var b strings.Builder
	for _, s := range path {
		switch x := s.(type) {
		case int:
			b.WriteString("[")
			b.WriteString(strconv.Itoa(x))
			b.WriteString("]")
		case string:
			if b.Len() > 0 {
				b.WriteString(".")
			}
			b.WriteString(x)
		}
	}
	return b.String()
}

// AsError returns the *Error inside err, if any.
func AsError(err error) (*Error, bool) {
	var e *Error
	if errors.As(err, &e) {
		return e, true
	}
	return nil, false
}

func newErr(code Code, offset int, format string, args ...any) *Error {
	return &Error{Code: code, Offset: offset, Detail: fmt.Sprintf(format, args...)}
}

// Fail panics with an *Error (offset -1).
func Fail(code Code, format string, args ...any) {
	panic(newErr(code, -1, format, args...))
}

// FailAt panics with an *Error at an absolute offset.
func FailAt(code Code, offset int, format string, args ...any) {
	panic(newErr(code, offset, format, args...))
}

// FailMsg panics with an *Error whose message is msg (not a format string).
func FailMsg(code Code, msg string) {
	panic(&Error{Code: code, Offset: -1, Detail: msg})
}

// FailInt is FailMsg with an int result, for use inside expressions.
func FailInt(code Code, msg string) int {
	FailMsg(code, msg)
	return 0
}

// wrapHost converts a host failure (an error or a panic value) into a CODEC *Error.
func wrapHost(what string, offset int, v any) *Error {
	if e, ok := v.(*Error); ok {
		return e
	}
	var msg string
	if err, ok := v.(error); ok {
		msg = err.Error()
	} else {
		msg = fmt.Sprint(v)
	}
	return &Error{Code: CODEC, Offset: offset, Detail: what + ": " + msg}
}

// ── path stack ──────────────────────────────────────────────────────────────

type pseg struct {
	name  string
	idx   int
	isIdx bool
}

// PathStack tracks the field names and array indices from the root while generated code reads
// or writes. It is not unwound when an error panics, so the entry point that recovers the error
// still sees where it happened.
type PathStack struct {
	segs []pseg
}

// Frame is the position of a struct's slot in the path stack.
type Frame int

// Enter pushes a slot for a struct's current field.
func (p *PathStack) Enter() Frame {
	p.segs = append(p.segs, pseg{idx: -1})
	return Frame(len(p.segs) - 1)
}

// Field names the field the struct at frame f is working on.
func (p *PathStack) Field(f Frame, name string) {
	p.segs = p.segs[:f+1]
	p.segs[f] = pseg{name: name, idx: -1}
}

// Leave pops a struct's slot (and anything above it).
func (p *PathStack) Leave(f Frame) {
	p.segs = p.segs[:f]
}

// PushIndex pushes an array index slot.
func (p *PathStack) PushIndex() Frame {
	p.segs = append(p.segs, pseg{idx: -1, isIdx: true})
	return Frame(len(p.segs) - 1)
}

// SetIndex sets the index of the array slot f (and drops anything above it).
func (p *PathStack) SetIndex(f Frame, i int) {
	p.segs = p.segs[:f+1]
	p.segs[f].idx = i
}

// Snapshot returns the current path (field names and non-negative indices).
func (p *PathStack) Snapshot() []any {
	return p.snapshotFrom(0)
}

func (p *PathStack) snapshotFrom(depth int) []any {
	out := []any{}
	for _, s := range p.segs[min(depth, len(p.segs)):] {
		if s.isIdx {
			if s.idx >= 0 {
				out = append(out, s.idx)
			}
		} else if s.name != "" {
			out = append(out, s.name)
		}
	}
	return out
}

// Catch runs f and converts an *Error panic into a returned error whose path is completed from
// the stack (unless it is sealed). Other panics propagate.
func Catch(ps *PathStack, f func()) (err error) {
	defer func() {
		if r := recover(); r != nil {
			e, ok := r.(*Error)
			if !ok {
				panic(r)
			}
			if !e.sealed && ps != nil {
				e.Path = append(ps.Snapshot(), e.Path...)
				e.sealed = true
			}
			err = e
		}
	}()
	f()
	return nil
}

// Try runs f; an *Error it raises is returned instead of propagating, with the path relative to
// the call. The path stack is restored.
func Try(ps *PathStack, f func()) (out *Error) {
	depth := 0
	if ps != nil {
		depth = len(ps.segs)
	}
	defer func() {
		if r := recover(); r != nil {
			e, ok := r.(*Error)
			if !ok {
				panic(r)
			}
			if ps != nil {
				if !e.sealed {
					e.Path = append(ps.snapshotFrom(depth), e.Path...)
				}
				ps.segs = ps.segs[:min(depth, len(ps.segs))]
			}
			out = e
		}
	}()
	f()
	return nil
}

// sealWith gives an error its complete path (fixups that run after layout).
func sealWith(r any, path []any) {
	if e, ok := r.(*Error); ok && !e.sealed {
		e.Path = append(append([]any{}, path...), e.Path...)
		e.sealed = true
	}
}
