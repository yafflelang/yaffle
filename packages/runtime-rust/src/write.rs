//! The relocation-style writer (docs/IR.md §3) and the layout engine (§4).
//!
//! Encoding happens first, layout second:
//!
//! 1. Generated code encodes values into **units**: the inline bytes of a base or of a
//!    placeable (a pointer or `at` target). Bytes whose size depends on the final position
//!    (`@align`, `@padUntil` around such content) are **pads**, sized at placement. Values that
//!    depend on positions, sizes or final bytes (derived offsets, sizes, checksums, pointers)
//!    are **fixups**: reserved bytes plus a closure evaluated after layout.
//! 2. While encoding, generated code mirrors the value structure as **scopes** (struct fields,
//!    array elements), so layout paths like `records[*].model` can be resolved.
//! 3. At the end of a base, the layout engine orders and positions every unit, the region is
//!    assembled, fixups run (values first, then `@ref` pointers, then byte-reading fixups such
//!    as checksums, in dependency order), and late consistency checks run.
//!
//! Nested bases and codec regions are self-contained: they are finished into bytes as soon as
//! they end and become ordinary bytes of the enclosing unit.

use std::any::Any;
use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;

use super::codec::{Arg, Codec, CodecCtx};
use super::error::{ErrorCode, PathSeg, Result, YaffleError};
use super::prim::{f32_to_f16, put_uint, Endian};
use super::read::StrLen;
use super::strings::{encode, Encoding};

pub type UnitId = usize;
pub type PlaceId = usize;
pub type ScopeId = usize;
pub type SlotId = usize;

/// A position inside a unit: buffer offset plus the number of pads registered before it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mark {
    pub unit: UnitId,
    pub off: usize,
    pub pads: usize,
}

/// Padding fill on the write side.
#[derive(Clone)]
pub enum WFill<'a> {
    Byte(u8),
    Fn(Rc<dyn Fn(i128) -> Result<u8> + 'a>),
}

impl WFill<'_> {
    fn at(&self, i: usize) -> Result<u8> {
        match self {
            WFill::Byte(b) => Ok(*b),
            WFill::Fn(f) => f(i as i128),
        }
    }
}

enum PadKind {
    Align(Align),
    Until { start: Mark, size: u64 },
}

/// An alignment: pad until `(pos - origin + offset) % to == 0`, where the origin is the base
/// (default) or, with `file`, the start of the byte space: the file, a codec's decoded region or
/// a virtual stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Align {
    pub to: u64,
    pub fill: u8,
    pub file: bool,
    pub offset: i128,
}

impl Align {
    /// A computed alignment; below 1 is `RANGE`.
    pub fn checked(to: i128, fill: u8, file: bool, offset: i128) -> Result<Self> {
        if to < 1 {
            return Err(YaffleError::range(format!("alignment of {to}, must be at least 1")));
        }
        Ok(Align { to: super::int::to::<u64>(to)?, fill, file, offset })
    }
    /// The padding before `pos` (from the base), given where the base is in its byte space.
    pub fn pad(&self, pos: u64, origin: Option<u64>) -> Result<u64> {
        if self.to == 0 {
            return Err(YaffleError::range("alignment of 0"));
        }
        if self.to == 1 {
            return Ok(0);
        }
        let at = if self.file {
            pos as i128 + origin.ok_or_else(file_origin_unknown)? as i128
        } else {
            pos as i128
        };
        let r = (at + self.offset).rem_euclid(self.to as i128) as u64;
        Ok((self.to - r) % self.to)
    }
}

fn file_origin_unknown() -> YaffleError {
    YaffleError::derive("@align(from: file) inside a @base whose position isn't known while it is written")
}

struct Pad<'a> {
    at: usize,
    kind: PadKind,
    fill: WFill<'a>,
    path: Vec<PathSeg>,
}

struct Unit<'a> {
    buf: Vec<u8>,
    pads: Vec<Pad<'a>>,
    scope: ScopeId,
    /// After layout: start (relative to the base) and prefix sums of pad sizes.
    start: Option<u64>,
    pad_prefix: Vec<u64>,
    size: u64,
}

/// What `sizeof`, `offsetof`, `bytesof` and `encode` measure.
#[derive(Clone, Debug)]
pub enum Span {
    /// Bytes between two marks of one unit.
    Marks(Mark, Mark),
    /// Bytes that are not in any unit (a codec's decoded side).
    Data(Rc<Vec<u8>>),
    /// A placeable (its `this` bytes).
    Place(PlaceId),
    /// An empty `@nullable(empty)` target, not placed: offset 0, no bytes.
    Null,
}

/// Placement options of a placeable.
#[derive(Clone, Debug, Default)]
pub struct PlaceOpts {
    /// The target's own leading `@align` layers.
    pub align: Vec<Align>,
    /// `at` with a linear reverse: position ≡ remainder (mod modulus).
    pub constraint: Option<(u64, u64)>,
    /// `at` that could not be reversed: exactly this offset.
    pub fixed: Option<u64>,
}

/// A scope key: a field name or an array index.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Field(&'static str),
    Index(usize),
}

/// A layout path segment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LSeg {
    Field(&'static str),
    Each,
}

/// One item of a struct's `layout { … }`.
#[derive(Clone, Debug, Default)]
pub struct LayoutItem {
    /// `None` = `this`.
    pub path: Option<Vec<LSeg>>,
    /// The item's `@align`.
    pub align: Option<Align>,
    /// A per-element group: for each element of the array at `path`, these items (paths relative
    /// to the element; `None` = the element itself) in order.
    pub group: Option<Vec<LayoutItem>>,
}

/// A child of a layout scope: an inline value's scope or a placeable.
#[derive(Clone, Copy, Debug)]
enum Node {
    Scope(ScopeId),
    Place(PlaceId),
}

struct Scope {
    layout: Option<Vec<LayoutItem>>,
    children: Vec<(Key, Node)>,
}

struct Place {
    unit: UnitId,
    opts: PlaceOpts,
    path: Vec<PathSeg>,
    /// Placed elsewhere already (views): never encoded, laid out or written.
    external: bool,
}

type IdKey = (usize, &'static str);
type FixFn<'a> = Box<dyn Fn(&Resolver) -> Result<Vec<u8>> + 'a>;
type CheckFn<'a> = Box<dyn Fn(&Resolver) -> Result<()> + 'a>;

struct Fixup<'a> {
    at: Mark,
    width: usize,
    reads: Vec<SlotId>,
    path: Vec<PathSeg>,
    f: FixFn<'a>,
}

struct LateCheck<'a> {
    path: Vec<PathSeg>,
    f: CheckFn<'a>,
}

/// How a pointer is stored: its width and byte order, whether it is signed, and whether it
/// counts from its own position (relative) rather than from its base.
#[derive(Clone, Copy, Debug)]
pub struct PtrFormat {
    pub width: usize,
    pub endian: Endian,
    pub signed: bool,
    pub relative: bool,
}

impl PtrFormat {
    /// The stored bytes of an offset (relative offsets are signed).
    pub fn encode(self, v: i128) -> Result<Vec<u8>> {
        enc_int(v, self.width, self.endian, self.signed || self.relative)
    }
}

struct RefFixup<'a> {
    at: Mark,
    fmt: PtrFormat,
    key: &'static str,
    value: &'a dyn Any,
    /// The target object's identity (0: none): an equal identity wins over an equal value.
    ident: u64,
    eq: fn(&dyn Any, &dyn Any) -> bool,
    path: Vec<PathSeg>,
    /// What an absolute pointer counts from.
    origin: RefOrigin<'a>,
}

/// The position an absolute pointer counts from.
enum RefOrigin<'a> {
    /// Its own base's start.
    Base,
    /// A position in this base (a pointer handed up from a nested base: that base's start).
    Mark(Mark),
    /// `@origin(expr)`: base + expr, evaluated after layout.
    Expr(OriginFn<'a>),
}

/// A pointer's `@origin` expression, evaluated after layout (relative to its base).
pub type OriginFn<'a> = Box<dyn Fn(&Resolver) -> Result<i128> + 'a>;

/// A `@ref` pointer a nested base couldn't resolve, handed to the enclosing base: its position
/// and origin within the nested region.
struct Escaped<'a> {
    rf: RefFixup<'a>,
    pos: u64,
    origin: u64,
}

struct Cand<'a> {
    value: &'a dyn Any,
    ident: u64,
    at: Mark,
}

struct Base<'a> {
    this_unit: UnitId,
    root_scope: ScopeId,
    prev_unit: UnitId,
    prev_scopes: usize,
    ids: HashMap<IdKey, PlaceId>,
    places: Vec<PlaceId>,
    fixups: Vec<Fixup<'a>>,
    checks: Vec<LateCheck<'a>>,
    refs: Vec<RefFixup<'a>>,
    cands: HashMap<&'static str, Vec<Cand<'a>>>,
    /// `@alignEnd` of a `@base` struct: pads the whole region (after its targets).
    align_end: Vec<Align>,
    /// Where the base starts in its byte space, if known (`@align(from: file)`).
    origin: Option<u64>,
}

/// The writer. `'a` is the lifetime of the input value being serialized.
pub struct Writer<'a> {
    units: Vec<Unit<'a>>,
    places: Vec<Place>,
    scopes: Vec<Scope>,
    slots: Vec<Option<Span>>,
    bases: Vec<Base<'a>>,
    cur: UnitId,
    scope_stack: Vec<ScopeId>,
    /// The current path, for error messages.
    pub path: Vec<PathSeg>,
    /// `$index`.
    pub index: Option<usize>,
    pieces: HashMap<u32, VecDeque<Vec<u8>>>,
    /// Views: positions (from the base) of the next placeables and `@ref` targets, which are
    /// then not encoded or laid out ("external"), in registration order.
    presets: Option<VecDeque<u64>>,
    /// View commits ("append"): where each placeable was (by path), kept there if it still fits.
    sticky: Option<HashMap<String, (u64, u64)>>,
    /// View commits: where every placeable went (path, position from its base, size).
    recorded: Option<Vec<(String, u64, u64)>>,
    arena: Option<&'a super::helpers::Arena>,
}

impl<'a> Default for Writer<'a> {
    fn default() -> Self {
        Self::new()
    }
}

fn no_ref(rf: &RefFixup) -> YaffleError {
    YaffleError::new(ErrorCode::Ref, "no equal value is placed in this base or an enclosing one for the @ref pointer")
        .or_path(&rf.path)
}

fn eq_any<T: PartialEq + 'static>(a: &dyn Any, b: &dyn Any) -> bool {
    match (a.downcast_ref::<T>(), b.downcast_ref::<T>()) {
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

/// A path as a key (`entries.3.data`).
fn path_key(path: &[PathSeg]) -> String {
    let parts: Vec<String> = path.iter().map(|p| p.to_string()).collect();
    parts.join(".")
}

/// Encodes an integer into `width` bytes with a range check.
pub fn enc_int(v: i128, width: usize, e: Endian, signed: bool) -> Result<Vec<u8>> {
    let bits = (width * 8) as u32;
    let ok = if signed {
        let lo = -(1i128 << (bits - 1));
        let hi = (1i128 << (bits - 1)) - 1;
        v >= lo && v <= hi
    } else {
        v >= 0 && (bits >= 128 || v < (1i128 << bits))
    };
    if !ok {
        return Err(YaffleError::range(format!(
            "value {v} out of range for {}{bits}",
            if signed { "i" } else { "u" }
        )));
    }
    let mut out = Vec::with_capacity(width);
    put_uint(&mut out, v as u64, width, e);
    Ok(out)
}

impl<'a> Writer<'a> {
    pub fn new() -> Self {
        let mut w = Writer {
            units: Vec::new(),
            places: Vec::new(),
            scopes: Vec::new(),
            slots: Vec::new(),
            bases: Vec::new(),
            cur: 0,
            scope_stack: Vec::new(),
            path: Vec::new(),
            index: None,
            pieces: HashMap::new(),
            presets: None,
            sticky: None,
            recorded: None,
            arena: None,
        };
        // A dummy unit 0 so `cur` is always valid.
        let s = w.new_scope();
        w.new_unit(s);
        w
    }

    /// A writer that can synthesize values (stream pieces and elements) in `arena`.
    pub fn with_arena(arena: &'a super::helpers::Arena) -> Self {
        let mut w = Self::new();
        w.arena = Some(arena);
        w
    }

    /// The arena for values synthesized during the write.
    pub fn arena(&self) -> Result<&'a super::helpers::Arena> {
        self.arena.ok_or_else(|| YaffleError::new(ErrorCode::Input, "this writer has no arena"))
    }

    fn new_scope(&mut self) -> ScopeId {
        self.scopes.push(Scope { layout: None, children: Vec::new() });
        self.scopes.len() - 1
    }
    fn new_unit(&mut self, scope: ScopeId) -> UnitId {
        self.units.push(Unit {
            buf: Vec::new(),
            pads: Vec::new(),
            scope,
            start: None,
            pad_prefix: Vec::new(),
            size: 0,
        });
        self.units.len() - 1
    }
    fn base(&mut self) -> Result<&mut Base<'a>> {
        self.bases.last_mut().ok_or_else(|| YaffleError::new(ErrorCode::Input, "no active base"))
    }
    fn scope_now(&self) -> ScopeId {
        *self.scope_stack.last().unwrap_or(&0)
    }

    // ─── Bases ───────────────────────────────────────────────────────────────

    /// Starts a byte space: the root, a codec's decoded side, or a virtual stream. `@align(from:
    /// file)` counts from its start.
    pub fn begin_space(&mut self) {
        self.begin_region(Some(0));
    }

    /// Starts a `@base` struct's region (inside the current byte space).
    pub fn begin_base(&mut self) {
        // Where it starts in its byte space: known in the enclosing base's own bytes.
        let origin = match self.bases.last() {
            None => Some(0),
            Some(b) => {
                let here = self.mark();
                b.origin.and_then(|o| self.mark_now(here).map(|p| o + p))
            }
        };
        self.begin_region(origin);
    }

    fn begin_region(&mut self, origin: Option<u64>) {
        let scope = self.new_scope();
        let unit = self.new_unit(scope);
        self.bases.push(Base {
            origin,
            this_unit: unit,
            root_scope: scope,
            prev_unit: self.cur,
            prev_scopes: self.scope_stack.len(),
            ids: HashMap::new(),
            places: Vec::new(),
            fixups: Vec::new(),
            checks: Vec::new(),
            refs: Vec::new(),
            cands: HashMap::new(),
            align_end: Vec::new(),
        });
        self.cur = unit;
        self.scope_stack.push(scope);
    }

    /// `@alignEnd` of the current `@base` struct (or the root): pads its whole region, after its
    /// targets.
    pub fn base_align_end(&mut self, a: Align) -> Result<()> {
        self.base()?.align_end.push(a);
        Ok(())
    }

    /// Ends the current base: layout, assembly, fixups, checks. Returns the region's bytes.
    pub fn end_base(&mut self) -> Result<Vec<u8>> {
        let (region, escaped) = self.pop_base()?;
        match escaped.first() {
            Some(e) => Err(no_ref(&e.rf)),
            None => Ok(region),
        }
    }

    /// Ends an `@base` struct's region and writes it inline into the enclosing unit. `@ref`
    /// pointers the region can't resolve are resolved in the enclosing bases, still counting
    /// from the region's start.
    pub fn end_base_inline(&mut self) -> Result<()> {
        let (region, escaped) = self.pop_base()?;
        if let Some(e) = escaped.first().filter(|_| self.bases.is_empty()) {
            return Err(no_ref(&e.rf));
        }
        let m0 = self.mark();
        let at = |off: u64| Mark { off: m0.off + off as usize, ..m0 };
        for e in escaped {
            let rf = RefFixup { at: at(e.pos), origin: RefOrigin::Mark(at(e.origin)), ..e.rf };
            self.base()?.refs.push(rf);
        }
        self.byte_vec(region);
        Ok(())
    }

    fn pop_base(&mut self) -> Result<(Vec<u8>, Vec<Escaped<'a>>)> {
        let base = self.bases.pop().ok_or_else(|| YaffleError::input("end_base without begin_base"))?;
        self.cur = base.prev_unit;
        self.scope_stack.truncate(base.prev_scopes);
        self.finish(base)
    }

    // ─── Emitting bytes ──────────────────────────────────────────────────────

    #[inline]
    pub fn mark(&self) -> Mark {
        let u = &self.units[self.cur];
        Mark { unit: self.cur, off: u.buf.len(), pads: u.pads.len() }
    }
    /// The span from `start` to the current position.
    #[inline]
    pub fn span_from(&self, start: Mark) -> Span {
        Span::Marks(start, self.mark())
    }
    #[inline]
    pub fn bytes(&mut self, b: &[u8]) {
        self.units[self.cur].buf.extend_from_slice(b);
    }
    #[inline]
    pub fn byte_vec(&mut self, b: Vec<u8>) {
        let buf = &mut self.units[self.cur].buf;
        if buf.is_empty() {
            *buf = b;
        } else {
            buf.extend_from_slice(&b);
        }
    }
    #[inline]
    pub fn uint(&mut self, v: u64, n: usize, e: Endian) {
        put_uint(&mut self.units[self.cur].buf, v, n, e);
    }
    #[inline]
    pub fn sint(&mut self, v: i64, n: usize, e: Endian) {
        put_uint(&mut self.units[self.cur].buf, v as u64, n, e);
    }
    #[inline]
    pub fn u8(&mut self, v: u8) {
        self.units[self.cur].buf.push(v);
    }
    #[inline]
    pub fn bool(&mut self, v: bool) {
        self.units[self.cur].buf.push(v as u8);
    }
    #[inline]
    pub fn f16(&mut self, v: f32, e: Endian) {
        self.uint(f32_to_f16(v) as u64, 2, e);
    }
    #[inline]
    pub fn f32(&mut self, v: f32, e: Endian) {
        self.uint(v.to_bits() as u64, 4, e);
    }
    #[inline]
    pub fn f64(&mut self, v: f64, e: Endian) {
        self.uint(v.to_bits(), 8, e);
    }

    /// Text in an encoding with a length rule (docs/IR.md, IrStringType).
    pub fn string(&mut self, s: &str, enc: Encoding, e: Endian, len: StrLen) -> Result<()> {
        let b = encode(s, enc, e).map_err(YaffleError::input)?;
        let unit = enc.unit();
        match len {
            StrLen::Count(n) => {
                let max = n * unit;
                if b.len() > max {
                    return Err(YaffleError::input(format!(
                        "text is {} code units, longer than the fixed length {n}",
                        b.len() / unit
                    )));
                }
                self.bytes(&b);
                let buf = &mut self.units[self.cur].buf;
                buf.resize(buf.len() + (max - b.len()), 0);
            }
            StrLen::Until => {
                self.bytes(&b);
                let buf = &mut self.units[self.cur].buf;
                buf.resize(buf.len() + unit, 0);
            }
            StrLen::Rest => self.bytes(&b),
        }
        Ok(())
    }

    /// `n` bytes of fixed-size padding.
    pub fn fill(&mut self, n: usize, fill: &WFill<'a>) -> Result<()> {
        match fill {
            WFill::Byte(b) => {
                let buf = &mut self.units[self.cur].buf;
                buf.resize(buf.len() + n, *b);
            }
            WFill::Fn(_) => {
                for i in 0..n {
                    let b = fill.at(i)?;
                    self.units[self.cur].buf.push(b);
                }
            }
        }
        Ok(())
    }
    /// Padding until `(pos - origin + offset) % to == 0`, the origin being the base or (`file`)
    /// the start of the byte space; sized at placement.
    pub fn align(&mut self, to: u64, file: bool, offset: i128, fill: WFill<'a>) -> Result<()> {
        if to == 0 {
            return Err(YaffleError::range("alignment of 0"));
        }
        if to == 1 {
            return Ok(());
        }
        let path = self.path.clone();
        let a = Align { to, fill: 0, file, offset };
        let u = &mut self.units[self.cur];
        u.pads.push(Pad { at: u.buf.len(), kind: PadKind::Align(a), fill, path });
        Ok(())
    }
    /// Padding after content starting at `start` until it occupies `size` bytes.
    pub fn pad_until(&mut self, start: Mark, size: u64, fill: WFill<'a>) -> Result<()> {
        let now = self.mark();
        if start.unit == now.unit && start.pads == now.pads {
            // No variable padding in between: size it now.
            let used = (now.off - start.off) as u64;
            if used > size {
                return Err(YaffleError::input(format!(
                    "content is {used} bytes, larger than the padded size {size}"
                )));
            }
            return self.fill((size - used) as usize, &fill);
        }
        let path = self.path.clone();
        let u = &mut self.units[self.cur];
        u.pads.push(Pad { at: u.buf.len(), kind: PadKind::Until { start, size }, fill, path });
        Ok(())
    }

    /// Ends a `@size(n)` window started at `start` whose size comes from the input: content
    /// larger than `n` is a `DERIVE` error, a shorter content is padded with zeros.
    pub fn size_end(&mut self, start: Mark, size: u64) -> Result<()> {
        self.pad_until(start, size, WFill::Byte(0)).map_err(|mut e| {
            if e.code == ErrorCode::Input {
                e.code = ErrorCode::Derive;
            }
            e
        })
    }

    // ─── Measurements ────────────────────────────────────────────────────────

    pub fn slot(&mut self) -> SlotId {
        self.slots.push(None);
        self.slots.len() - 1
    }
    pub fn set_slot(&mut self, slot: SlotId, span: Span) {
        self.slots[slot] = Some(span);
    }
    fn get_slot(&self, slot: SlotId) -> Result<&Span> {
        self.slots
            .get(slot)
            .and_then(|s| s.as_ref())
            .ok_or_else(|| YaffleError::derive("measured field is absent"))
    }
    /// A mark's position while encoding: known in the current base's own unit, which always
    /// starts at 0, so its padding can be sized before layout.
    fn mark_now(&self, m: Mark) -> Option<u64> {
        let base = self.bases.last()?;
        if m.unit != base.this_unit {
            return None;
        }
        let prefix = self.pad_prefix(m.unit, 0, base.origin, m.pads).ok()?;
        Some(m.off as u64 + prefix.get(m.pads).copied()?)
    }
    /// `sizeof` during encoding: known when no variable padding is involved.
    pub fn size_now(&self, slot: SlotId) -> Result<i128> {
        let unknown = || YaffleError::derive("size depends on the layout and is not known yet");
        match self.get_slot(slot)? {
            Span::Marks(s, e) if s.unit == e.unit && s.pads == e.pads => Ok((e.off - s.off) as i128),
            Span::Marks(s, e) if s.unit == e.unit => match (self.mark_now(*s), self.mark_now(*e)) {
                (Some(a), Some(b)) => Ok(b as i128 - a as i128),
                _ => Err(unknown()),
            },
            Span::Data(d) => Ok(d.len() as i128),
            Span::Null => Ok(0),
            Span::Place(p) => {
                let u = &self.units[self.places[*p].unit];
                if u.pads.is_empty() {
                    Ok(u.buf.len() as i128)
                } else {
                    Err(unknown())
                }
            }
            _ => Err(unknown()),
        }
    }
    /// `bytesof`/`encode` during encoding: known for codec data and plain spans without fixups.
    pub fn bytes_now(&self, slot: SlotId) -> Result<Vec<u8>> {
        let unknown = || YaffleError::derive("bytes depend on the layout and are not known yet");
        match self.get_slot(slot)? {
            Span::Data(d) => Ok(d.as_ref().clone()),
            Span::Null => Ok(Vec::new()),
            Span::Marks(s, e) if s.unit == e.unit && s.pads == e.pads => {
                let overlaps = |at: Mark, width: usize| at.unit == s.unit && at.off < e.off && at.off + width > s.off;
                let pending = self.bases.iter().any(|b| {
                    b.fixups.iter().any(|f| overlaps(f.at, f.width)) || b.refs.iter().any(|f| overlaps(f.at, f.fmt.width))
                });
                if pending {
                    return Err(unknown());
                }
                Ok(self.units[s.unit].buf[s.off..e.off].to_vec())
            }
            _ => Err(unknown()),
        }
    }
    /// `$offset` during encoding: only known in a base's own inline bytes.
    pub fn offset_now(&self) -> Result<i128> {
        self.mark_now(self.mark())
            .map(|p| p as i128)
            .ok_or_else(|| YaffleError::derive("$offset depends on the layout and is not known while encoding"))
    }
    /// `offsetof` during encoding: only known for fields in a base's own inline bytes.
    pub fn offset_of_now(&self, slot: SlotId) -> Result<i128> {
        let unknown = || YaffleError::derive("offsetof depends on the layout and is not known while encoding");
        match self.get_slot(slot)? {
            Span::Null => Ok(0),
            Span::Marks(s, _) => self.mark_now(*s).map(|p| p as i128).ok_or_else(unknown),
            _ => Err(unknown()),
        }
    }
    /// `$index`.
    pub fn index_value(&self) -> Result<i128> {
        self.index.map(|i| i as i128).ok_or_else(|| YaffleError::range("$index used outside an array"))
    }

    // ─── Fixups and late checks ──────────────────────────────────────────────

    /// Reserves `width` bytes, filled after layout by `f`. `reads` lists slots whose final bytes
    /// `f` reads (checksums), so it runs after fixups inside them.
    pub fn fixup(&mut self, width: usize, reads: Vec<SlotId>, f: FixFn<'a>) -> Result<()> {
        let at = self.mark();
        let path = self.path.clone();
        let buf = &mut self.units[self.cur].buf;
        buf.resize(buf.len() + width, 0);
        self.base()?.fixups.push(Fixup { at, width, reads, path, f });
        Ok(())
    }
    /// A consistency check evaluated after layout and fixups.
    pub fn late_check(&mut self, f: CheckFn<'a>) -> Result<()> {
        let path = self.path.clone();
        self.base()?.checks.push(LateCheck { path, f });
        Ok(())
    }

    // ─── Placeables and pointers ─────────────────────────────────────────────

    /// Registers a placeable in the current base and encodes it with `f` (into its own unit).
    /// With `ident` (pointer targets: `Rc` address and type), a target that is already
    /// registered is shared instead of encoded again.
    pub fn place(
        &mut self,
        ident: Option<(usize, &'static str)>,
        key: Key,
        opts: PlaceOpts,
        f: impl FnOnce(&mut Self) -> Result<()>,
    ) -> Result<PlaceId> {
        if let Some(pos) = self.next_preset() {
            return self.external(pos, key);
        }
        if let Some(id) = ident {
            if let Some(&p) = self.base()?.ids.get(&id) {
                return Ok(p);
            }
        }
        let pid = self.new_place(key, opts, false)?;
        if let Some(id) = ident {
            self.base()?.ids.insert(id, pid);
        }
        let unit = self.places[pid].unit;
        let saved_unit = std::mem::replace(&mut self.cur, unit);
        let saved_scopes = self.scope_stack.len();
        self.scope_stack.push(self.units[unit].scope);
        let r = f(self);
        self.cur = saved_unit;
        self.scope_stack.truncate(saved_scopes);
        r.map(|_| pid)
    }

    /// A placeable (with its own unit and scope) under `key` in the current scope and base.
    fn new_place(&mut self, key: Key, opts: PlaceOpts, external: bool) -> Result<PlaceId> {
        let scope = self.new_scope();
        let unit = self.new_unit(scope);
        let pid = self.places.len();
        self.places.push(Place { unit, opts, path: self.path.clone(), external });
        let parent = self.scope_now();
        self.scopes[parent].children.push((key, Node::Place(pid)));
        self.base()?.places.push(pid);
        Ok(pid)
    }

    /// A placeable that is already in the document at `pos` (views): never encoded, laid out
    /// or written, only pointed at.
    fn external(&mut self, pos: u64, key: Key) -> Result<PlaceId> {
        self.new_place(key, PlaceOpts { fixed: Some(pos), ..Default::default() }, true)
    }

    /// Views: the next placeables and `@ref` targets are already at these positions (from the
    /// base, in registration order).
    pub fn preset_positions(&mut self, positions: Vec<u64>) {
        self.presets = Some(positions.into());
    }

    fn next_preset(&mut self) -> Option<u64> {
        self.presets.as_mut().and_then(|q| q.pop_front())
    }

    /// View commits ("append" strategy): placeables keep these positions (from their base, by
    /// path) when they still fit there; the others are laid out after everything.
    pub fn set_sticky(&mut self, places: HashMap<String, (u64, u64)>) {
        self.sticky = Some(places);
    }
    /// View commits: records where every placeable goes ([`Writer::take_recorded`]).
    pub fn record_places(&mut self) {
        self.recorded = Some(Vec::new());
    }
    /// The recorded placements: (path, position from its base, size).
    pub fn take_recorded(&mut self) -> Vec<(String, u64, u64)> {
        self.recorded.take().unwrap_or_default()
    }

    /// An owned pointer to a placeable: reserved bytes, filled after layout with `target - base`,
    /// `target - field` when relative, or `target - base - origin` with an `@origin`.
    pub fn pointer(&mut self, target: PlaceId, fmt: PtrFormat, origin: Option<OriginFn<'a>>) -> Result<()> {
        let at = self.mark();
        self.fixup(
            fmt.width,
            Vec::new(),
            Box::new(move |r: &Resolver| {
                let t = r.place_pos(target)? as i128;
                match &origin {
                    Some(o) => enc_int(t - o(r)?, fmt.width, fmt.endian, fmt.signed),
                    None if fmt.relative => fmt.encode(t - r.mark_pos(at) as i128),
                    None => fmt.encode(t),
                }
            }),
        )
    }

    /// A `@ref` pointer: resolved after layout to the identical, else an equal value placed in
    /// the same base (or an enclosing one).
    pub fn ref_pointer<T: PartialEq + 'static>(
        &mut self,
        value: &'a T,
        ident: u64,
        key: &'static str,
        fmt: PtrFormat,
        origin: Option<OriginFn<'a>>,
    ) -> Result<()> {
        if let Some(pos) = self.next_preset() {
            let pid = self.external(pos, Key::Field(""))?;
            return self.pointer(pid, fmt, origin);
        }
        let at = self.mark();
        let path = self.path.clone();
        let buf = &mut self.units[self.cur].buf;
        buf.resize(buf.len() + fmt.width, 0);
        let origin = origin.map_or(RefOrigin::Base, RefOrigin::Expr);
        self.base()?.refs.push(RefFixup { at, fmt, key, value, ident, eq: eq_any::<T>, path, origin });
        Ok(())
    }

    /// Registers a value written at `start` as a candidate target for `@ref` pointers.
    pub fn candidate<T: PartialEq + 'static>(&mut self, value: &'a T, ident: u64, key: &'static str, start: Mark) -> Result<()> {
        self.base()?.cands.entry(key).or_default().push(Cand { value, ident, at: start });
        Ok(())
    }

    // ─── Scopes (for layout paths) ───────────────────────────────────────────

    /// Enters a child scope (an inline struct field, array, or element) of the current scope.
    pub fn enter(&mut self, key: Key) {
        let s = self.new_scope();
        let parent = self.scope_now();
        self.scopes[parent].children.push((key, Node::Scope(s)));
        self.scope_stack.push(s);
    }
    pub fn leave(&mut self) {
        self.scope_stack.pop();
    }
    /// Sets the `layout` of the struct being written in the current scope.
    pub fn set_layout(&mut self, items: Vec<LayoutItem>) {
        let s = self.scope_now();
        self.scopes[s].layout = Some(items);
    }

    // ─── Error paths ─────────────────────────────────────────────────────────

    #[inline]
    pub fn push_field(&mut self, name: &str) {
        self.path.push(PathSeg::Field(name.to_string()));
    }
    #[inline]
    pub fn push_index(&mut self, i: usize) {
        self.path.push(PathSeg::Index(i));
    }
    #[inline]
    pub fn pop_path(&mut self) {
        self.path.pop();
    }
    /// Attaches the current path to an error that has none.
    pub fn locate(&self, e: YaffleError) -> YaffleError {
        e.or_path(&self.path)
    }

    // ─── Virtual streams ─────────────────────────────────────────────────────

    /// Queues the pieces a stream's source fields will write (in order).
    pub fn push_pieces(&mut self, stream: u32, pieces: Vec<Vec<u8>>) {
        self.pieces.entry(stream).or_default().extend(pieces);
    }
    /// The next queued piece for a stream source field, if any.
    pub fn take_piece(&mut self, stream: u32) -> Option<Vec<u8>> {
        self.pieces.get_mut(&stream).and_then(|q| q.pop_front())
    }

    // ─── Codecs ──────────────────────────────────────────────────────────────

    pub fn codec_encode<C: Codec + ?Sized>(&self, codec: &C, plain: &[u8], args: &[Arg], output_size: Option<usize>) -> Result<Vec<u8>> {
        let ctx = CodecCtx { args, output_size, position: None };
        codec.encode(plain, &ctx).map_err(YaffleError::codec)
    }

    // ─── Finishing a base ────────────────────────────────────────────────────

    /// Prefix sums of the sizes of a unit's first `upto` pads, with the unit at `start` (from the
    /// base) and the base at `origin` in its byte space.
    fn pad_prefix(&self, uid: UnitId, start: u64, origin: Option<u64>, upto: usize) -> Result<Vec<u64>> {
        let u = &self.units[uid];
        let mut prefix = Vec::with_capacity(upto.min(u.pads.len()) + 1);
        prefix.push(0u64);
        for (k, p) in u.pads.iter().take(upto).enumerate() {
            let pos = start + p.at as u64 + prefix[k];
            let size = match &p.kind {
                PadKind::Align(a) => a.pad(pos, origin).map_err(|e| e.or_path(&p.path))?,
                PadKind::Until { start: m, size } => {
                    let used = pos - (start + m.off as u64 + prefix[m.pads]);
                    size.checked_sub(used).ok_or_else(|| {
                        YaffleError::input(format!("content is {used} bytes, larger than the padded size {size}"))
                            .or_path(&p.path)
                    })?
                }
            };
            prefix.push(prefix[k] + size);
        }
        Ok(prefix)
    }

    /// Places a unit at `start` (from the base): sizes its pads. Returns its size.
    fn resolve_unit(&mut self, uid: UnitId, start: u64, origin: Option<u64>) -> Result<u64> {
        let prefix = self.pad_prefix(uid, start, origin, usize::MAX)?;
        let u = &mut self.units[uid];
        u.size = u.buf.len() as u64 + prefix.last().copied().unwrap_or(0);
        u.start = Some(start);
        u.pad_prefix = prefix;
        Ok(u.size)
    }

    fn mark_pos(&self, m: Mark) -> u64 {
        let u = &self.units[m.unit];
        u.start.unwrap_or(0) + m.off as u64 + u.pad_prefix.get(m.pads).copied().unwrap_or(0)
    }

    fn write_unit_into(&self, uid: UnitId, region: &mut [u8]) -> Result<()> {
        let u = &self.units[uid];
        let mut dst = u.start.unwrap_or(0) as usize;
        let mut src = 0usize;
        for (k, p) in u.pads.iter().enumerate() {
            let n = p.at - src;
            region[dst..dst + n].copy_from_slice(&u.buf[src..p.at]);
            dst += n;
            src = p.at;
            let size = (u.pad_prefix[k + 1] - u.pad_prefix[k]) as usize;
            for (i, b) in region[dst..dst + size].iter_mut().enumerate() {
                *b = p.fill.at(i)?;
            }
            dst += size;
        }
        let n = u.buf.len() - src;
        region[dst..dst + n].copy_from_slice(&u.buf[src..]);
        Ok(())
    }

    /// Lays out, assembles and fixes up a base's region. Returns its bytes and the `@ref`
    /// pointers that have no target in it.
    fn finish(&mut self, base: Base<'a>) -> Result<(Vec<u8>, Vec<Escaped<'a>>)> {
        let (size, gaps) = self.lay_out(&base)?;
        let mut region = vec![0u8; size];
        for &(a, b, fill) in &gaps {
            region[a as usize..b as usize].fill(fill);
        }
        let units: Vec<UnitId> = std::iter::once(base.this_unit)
            .chain(base.places.iter().filter(|&&p| !self.places[p].external).map(|&p| self.places[p].unit))
            .collect();
        for &u in &units {
            self.write_unit_into(u, &mut region)?;
        }

        let (plain, reading): (Vec<_>, Vec<_>) = base.fixups.into_iter().partition(|f| f.reads.is_empty());
        for f in &plain {
            self.run_fixup(f, &mut region)?;
        }
        let escaped = self.resolve_refs(base.refs, &base.cands, &mut region)?;
        self.run_reading_fixups(&reading, &mut region)?;
        for c in &base.checks {
            (c.f)(&Resolver { w: self, region: &region }).map_err(|e| e.or_path(&c.path))?;
        }

        if let Some(rec) = self.recorded.as_mut() {
            for &p in &base.places {
                let pl = &self.places[p];
                if !pl.external {
                    let u = &self.units[pl.unit];
                    rec.push((path_key(&pl.path), u.start.unwrap_or(0), u.size));
                }
            }
        }
        // The units' bytes are in the region now.
        for u in units {
            self.units[u].buf = Vec::new();
            self.units[u].pads = Vec::new();
        }
        Ok((region, escaped))
    }

    /// Positions every unit of a base. Returns the region's size and its filled gaps.
    fn lay_out(&mut self, base: &Base<'a>) -> Result<(usize, Vec<Gap>)> {
        let mut lay = Layout { origin: base.origin, ..Default::default() };
        // The base's own bytes are first.
        lay.cursor = self.resolve_unit(base.this_unit, 0, base.origin)?;
        lay.ranges.push((0, lay.cursor));
        // External placeables (views) are already in the document: positions only.
        for &p in &base.places {
            if self.places[p].external {
                let off = self.places[p].opts.fixed.unwrap_or(0);
                self.resolve_unit(self.places[p].unit, off, base.origin)?;
                lay.placed.insert(p);
            }
        }
        // Fixed placements go exactly where they say.
        for &p in &base.places {
            let Some(off) = self.places[p].opts.fixed.filter(|_| !self.places[p].external) else { continue };
            let size = self.resolve_unit(self.places[p].unit, off, base.origin)?;
            if let Some((a, b)) = lay.overlap(off, size) {
                return Err(YaffleError::new(
                    ErrorCode::Overlap,
                    format!("placement at 0x{off:x}..0x{:x} overlaps 0x{a:x}..0x{b:x}", off + size),
                )
                .or_path(&self.places[p].path));
            }
            lay.reserve(p, off, size);
        }
        // Sticky placements (view commits): at their old position when they still fit there.
        if let Some(sticky) = self.sticky.take() {
            for &p in &base.places {
                if self.places[p].external || self.places[p].opts.fixed.is_some() {
                    continue;
                }
                let Some(&(pos, old)) = sticky.get(&path_key(&self.places[p].path)) else { continue };
                let size = self.resolve_unit(self.places[p].unit, pos, base.origin)?;
                if size <= old && lay.overlap(pos, size).is_none() {
                    lay.reserve(p, pos, size);
                    lay.sticky.insert(p);
                }
            }
            // The others go after everything ("append").
            lay.cursor = lay.end();
            self.sticky = Some(sticky);
        }
        lay.reserved.sort();
        self.emit_scope(&mut lay, base.root_scope, None, None)?;
        // Anything left over (should not happen) goes at the end.
        for &p in &base.places {
            if !lay.placed.contains(&p) {
                self.place_this(&mut lay, p, None)?;
            }
        }
        let mut size = lay.end();
        for a in &base.align_end {
            let pad = a.pad(size, base.origin)?;
            lay.gap(size, size + pad, a.fill);
            size += pad;
        }
        Ok((size as usize, lay.gaps))
    }

    fn run_fixup(&self, f: &Fixup<'a>, region: &mut [u8]) -> Result<()> {
        let pos = self.mark_pos(f.at) as usize;
        let bytes = (f.f)(&Resolver { w: self, region: &*region }).map_err(|e| e.or_path(&f.path))?;
        if bytes.len() != f.width {
            return Err(YaffleError::derive("fixup produced the wrong number of bytes").or_path(&f.path));
        }
        region[pos..pos + f.width].copy_from_slice(&bytes);
        Ok(())
    }

    /// Runs fixups that read final bytes (checksums), each after every fixup inside the bytes it
    /// reads.
    fn run_reading_fixups(&self, fixups: &[Fixup<'a>], region: &mut [u8]) -> Result<()> {
        let reads: Vec<Vec<(usize, usize)>> = {
            let r = Resolver { w: self, region: &*region };
            fixups.iter().map(|f| f.reads.iter().filter_map(|&s| r.range(s).ok().flatten()).collect()).collect()
        };
        let at: Vec<usize> = fixups.iter().map(|f| self.mark_pos(f.at) as usize).collect();
        let waits = |i: usize, j: usize| reads[i].iter().any(|&(a, b)| at[j] < b && at[j] + fixups[j].width > a);
        let mut todo: Vec<usize> = (0..fixups.len()).collect();
        while !todo.is_empty() {
            let next = todo
                .iter()
                .position(|&i| todo.iter().all(|&j| j == i || !waits(i, j)))
                .ok_or_else(|| YaffleError::derive("cyclic dependency between checksums"))?;
            let i = todo.remove(next);
            self.run_fixup(&fixups[i], region)?;
        }
        Ok(())
    }

    /// Resolves `@ref` pointers to the identical, else the first equal, value placed in this
    /// base; returns the ones that have no target here (for the enclosing base).
    fn resolve_refs(
        &self,
        refs: Vec<RefFixup<'a>>,
        cands: &HashMap<&'static str, Vec<Cand<'a>>>,
        region: &mut [u8],
    ) -> Result<Vec<Escaped<'a>>> {
        let mut escaped = Vec::new();
        if refs.is_empty() {
            return Ok(escaped);
        }
        // String candidates are indexed by value; others are compared one by one.
        let mut by_str: HashMap<&'static str, HashMap<&str, u64>> = HashMap::new();
        for (k, list) in cands {
            if list.first().is_some_and(|c| c.value.is::<String>()) {
                let m = by_str.entry(k).or_default();
                for c in list {
                    if let Some(s) = c.value.downcast_ref::<String>() {
                        let pos = self.mark_pos(c.at);
                        m.entry(s.as_str()).and_modify(|p| *p = (*p).min(pos)).or_insert(pos);
                    }
                }
            }
        }
        let first = |rf: &RefFixup, hit: &dyn Fn(&Cand) -> bool| {
            cands.get(rf.key).into_iter().flatten().filter(|c| hit(c)).map(|c| self.mark_pos(c.at)).min()
        };
        for rf in refs {
            let by_ident = if rf.ident != 0 { first(&rf, &|c| c.ident == rf.ident) } else { None };
            let found = by_ident.or_else(|| match (by_str.get(rf.key), rf.value.downcast_ref::<String>()) {
                (Some(m), Some(s)) => m.get(s.as_str()).copied(),
                _ => first(&rf, &|c| (rf.eq)(rf.value, c.value)),
            });
            let pos = self.mark_pos(rf.at);
            let origin: i128 = match &rf.origin {
                RefOrigin::Base => 0,
                RefOrigin::Mark(m) => self.mark_pos(*m) as i128,
                RefOrigin::Expr(f) => f(&Resolver { w: self, region: &*region }).map_err(|e| e.or_path(&rf.path))?,
            };
            let origin = u64::try_from(origin)
                .map_err(|_| YaffleError::derive("a pointer origin before its base").or_path(&rf.path))?;
            let Some(target) = found else {
                escaped.push(Escaped { rf, pos, origin });
                continue;
            };
            let from = if rf.fmt.relative { pos } else { origin };
            let bytes = rf.fmt.encode(target as i128 - from as i128).map_err(|e| e.or_path(&rf.path))?;
            region[pos as usize..pos as usize + rf.fmt.width].copy_from_slice(&bytes);
        }
        Ok(escaped)
    }

    // ─── Layout ──────────────────────────────────────────────────────────────

    /// Places a placeable's own bytes at the cursor (aligned by `align`, its layout item's, then
    /// by its own placement alignments and constraint).
    fn place_this(&mut self, lay: &mut Layout, p: PlaceId, align: Option<Align>) -> Result<()> {
        if lay.sticky.remove(&p) {
            // A sticky placement stays only where it is still aligned (alignments can read edited
            // fields); otherwise it goes after everything.
            let u = &self.units[self.places[p].unit];
            let range = (u.start.unwrap_or(0), u.start.unwrap_or(0) + u.size);
            if !self.aligned_at(lay, p, align, range.0)? {
                for v in [&mut lay.ranges, &mut lay.reserved] {
                    if let Some(i) = v.iter().position(|&r| r == range) {
                        v.remove(i);
                    }
                }
                lay.placed.remove(&p);
            }
        }
        if lay.placed.contains(&p) {
            // Reaching a fixed placement moves the running position to its end.
            if self.places[p].opts.fixed.is_some() && !self.places[p].external {
                lay.reached.insert(p);
                let u = &self.units[self.places[p].unit];
                if let Some(start) = u.start {
                    lay.cursor = lay.cursor.max(start + u.size);
                }
            }
            return Ok(());
        }
        lay.placed.insert(p);
        let place = &self.places[p];
        let (unit, opts, path) = (place.unit, place.opts.clone(), place.path.clone());
        let mut pos = lay.cursor;
        loop {
            for a in align.iter().chain(&opts.align) {
                let s = pos;
                pos += a.pad(pos, lay.origin).map_err(|e| e.or_path(&path))?;
                lay.gap(s, pos, a.fill);
            }
            if let Some(c) = opts.constraint {
                pos = constrained(pos, c);
            }
            let size = self.resolve_unit(unit, pos, lay.origin)?;
            // Skip over fixed placements.
            if let Some(&(_, b)) = lay.reserved.iter().find(|&&(a, b)| pos < b && a < pos + size.max(1) && b > a) {
                pos = b;
                continue;
            }
            lay.ranges.push((pos, pos + size));
            lay.cursor = pos + size;
            return Ok(());
        }
    }

    /// Whether `pos` satisfies a placeable's alignments (its layout item's and its own) and its
    /// placement constraint.
    fn aligned_at(&self, lay: &Layout, p: PlaceId, align: Option<Align>, pos: u64) -> Result<bool> {
        let opts = &self.places[p].opts;
        for a in align.iter().chain(&opts.align) {
            if a.pad(pos, lay.origin).map_err(|e| e.or_path(&self.places[p].path))? != 0 {
                return Ok(false);
            }
        }
        Ok(opts.constraint.is_none_or(|c| constrained(pos, c) == pos))
    }

    /// Not laid out yet: unplaced, a fixed placement the layout order hasn't reached, or a sticky
    /// placement whose alignment isn't checked yet.
    fn unreached(&self, lay: &Layout, p: PlaceId) -> bool {
        !lay.placed.contains(&p)
            || lay.sticky.contains(&p)
            || (self.places[p].opts.fixed.is_some() && !self.places[p].external && !lay.reached.contains(&p))
    }

    /// Places a placeable's unit: its `this` (unless its layout places it later) and its own
    /// placeables in its layout order.
    fn emit_unit(&mut self, lay: &mut Layout, p: PlaceId, align: Option<Align>) -> Result<()> {
        let unit = self.places[p].unit;
        let scope = self.units[unit].scope;
        let explicit_this = self.scopes[scope].layout.as_ref().is_some_and(|l| l.iter().any(|i| i.path.is_none()));
        if !explicit_this {
            self.place_this(lay, p, align)?;
        }
        self.emit_scope(lay, scope, Some(p), align)?;
        self.place_this(lay, p, align)
    }

    /// Claims every placeable an item names (for groups, under every element), for `key`.
    fn claim_item(&self, lay: &mut Layout, from: Node, item: &LayoutItem, key: (usize, usize)) {
        let claim = |lay: &mut Layout, p: PlaceId| {
            if self.unreached(lay, p) {
                lay.claims.entry(p).or_insert(key);
            }
        };
        match &item.path {
            None => {
                if let Node::Place(p) = from {
                    claim(lay, p);
                }
            }
            Some(path) => {
                for t in self.resolve_from(from, path) {
                    match &item.group {
                        Some(group) => {
                            for e in self.elements(t) {
                                for gi in group {
                                    self.claim_item(lay, e, gi, key);
                                }
                            }
                        }
                        None => {
                            if let Node::Place(p) = t {
                                claim(lay, p);
                            }
                        }
                    }
                }
            }
        }
    }

    /// Places what an item names, from `from` (a scope, or an element of a group).
    fn emit_item(
        &mut self,
        lay: &mut Layout,
        from: Node,
        owner: Option<PlaceId>,
        item: &LayoutItem,
        key: (usize, usize),
        align: Option<Align>,
    ) -> Result<()> {
        let a = item.align.or(align);
        match &item.path {
            None => match from {
                // `this` of a group's element: the element's own bytes.
                Node::Place(p) => {
                    if lay.claims.get(&p).is_none_or(|&c| c == key) && self.unreached(lay, p) {
                        self.place_this(lay, p, a)?;
                    }
                }
                Node::Scope(_) => {
                    if let Some(o) = owner {
                        self.place_this(lay, o, a)?;
                    }
                }
            },
            Some(path) => {
                for t in self.resolve_from(from, path) {
                    match &item.group {
                        Some(group) => {
                            // An element that is itself a target comes first, like `this` in a
                            // unit, unless an item names it.
                            let names_this = group.iter().any(|g| g.path.is_none());
                            for e in self.elements(t) {
                                if let (Node::Place(p), false) = (e, names_this) {
                                    if self.unreached(lay, p) {
                                        self.place_this(lay, p, a)?;
                                    }
                                }
                                for gi in group {
                                    self.emit_item(lay, e, None, gi, key, a)?;
                                }
                            }
                        }
                        None => match t {
                            Node::Place(p) => {
                                let ok = lay.claims.get(&p).is_none_or(|&c| c == key);
                                if ok && self.unreached(lay, p) {
                                    lay.claims.remove(&p);
                                    self.emit_unit(lay, p, a)?;
                                }
                            }
                            Node::Scope(s) => self.emit_scope(lay, s, None, a)?,
                        },
                    }
                }
            }
        }
        Ok(())
    }

    fn emit_scope(&mut self, lay: &mut Layout, scope: ScopeId, owner: Option<PlaceId>, align: Option<Align>) -> Result<()> {
        if let Some(layout) = self.scopes[scope].layout.clone() {
            let token = lay.next_token;
            lay.next_token += 1;
            // Claim every placeable the items name (outer layouts win).
            for (idx, item) in layout.iter().enumerate() {
                if item.path.is_some() {
                    self.claim_item(lay, Node::Scope(scope), item, (token, idx));
                }
            }
            for (idx, item) in layout.iter().enumerate() {
                self.emit_item(lay, Node::Scope(scope), owner, item, (token, idx), align)?;
            }
            lay.claims.retain(|_, c| c.0 != token);
        }
        // Leftovers in default (declaration, pre-order) order.
        let children = self.scopes[scope].children.clone();
        for (_, c) in children {
            match c {
                Node::Place(p) => {
                    if self.unreached(lay, p) && !lay.claims.contains_key(&p) {
                        self.emit_unit(lay, p, align)?;
                    }
                }
                Node::Scope(s) => self.emit_scope(lay, s, None, align)?,
            }
        }
        Ok(())
    }

    /// The scope a node's children are in.
    fn scope_of(&self, t: Node) -> ScopeId {
        match t {
            Node::Scope(s) => s,
            Node::Place(p) => self.units[self.places[p].unit].scope,
        }
    }

    /// The elements of an array node (its indexed children), in order.
    fn elements(&self, t: Node) -> Vec<Node> {
        self.resolve_from(t, &[LSeg::Each])
    }

    /// The nodes a layout path names, from `from`.
    fn resolve_from(&self, from: Node, path: &[LSeg]) -> Vec<Node> {
        let mut cur = vec![from];
        for seg in path {
            cur = cur
                .iter()
                .flat_map(|&t| &self.scopes[self.scope_of(t)].children)
                .filter(|(k, _)| match (seg, k) {
                    (LSeg::Field(a), Key::Field(b)) => a == b,
                    (LSeg::Each, Key::Index(_)) => true,
                    _ => false,
                })
                .map(|&(_, c)| c)
                .collect();
        }
        cur
    }
}

/// A gap filled with a byte: start, end, fill.
type Gap = (u64, u64, u8);

/// The state of laying out one base. Positions are from the base.
#[derive(Default)]
struct Layout {
    /// Where the base starts in its byte space (`@align(from: file)`).
    origin: Option<u64>,
    /// Where the next sequential placement goes.
    cursor: u64,
    /// Every placed range, and the fixed and sticky ones (sequential placements skip them).
    ranges: Vec<(u64, u64)>,
    reserved: Vec<(u64, u64)>,
    /// Alignment gaps with a nonzero fill.
    gaps: Vec<Gap>,
    placed: HashSet<PlaceId>,
    /// Placeables a layout item names, by (layout token, item index): other items skip them.
    claims: HashMap<PlaceId, (usize, usize)>,
    next_token: usize,
    /// Fixed placements the layout order has reached.
    reached: HashSet<PlaceId>,
    /// Sticky placements (view commits) whose alignment is checked when the layout order reaches them.
    sticky: HashSet<PlaceId>,
}

impl Layout {
    fn gap(&mut self, a: u64, b: u64, fill: u8) {
        if b > a && fill != 0 {
            self.gaps.push((a, b, fill));
        }
    }
    /// A placed range that `size` bytes at `pos` would overlap.
    fn overlap(&self, pos: u64, size: u64) -> Option<(u64, u64)> {
        self.ranges.iter().copied().find(|&(a, b)| pos < b && a < pos + size && size > 0 && b > a)
    }
    /// Places a fixed or sticky placement.
    fn reserve(&mut self, p: PlaceId, pos: u64, size: u64) {
        self.ranges.push((pos, pos + size));
        self.reserved.push((pos, pos + size));
        self.placed.insert(p);
    }
    /// The end of the last placed range.
    fn end(&self) -> u64 {
        self.ranges.iter().map(|r| r.1).max().unwrap_or(0)
    }
}

/// The first position at or after `pos` that is ≡ `r` (mod `m`).
pub(crate) fn constrained(pos: u64, (m, r): (u64, u64)) -> u64 {
    if m == 0 {
        pos
    } else {
        pos + (r % m + m - pos % m) % m
    }
}

/// Read access to final positions, sizes and bytes, for fixups and late checks.
pub struct Resolver<'r, 'a> {
    w: &'r Writer<'a>,
    region: &'r [u8],
}

impl<'r, 'a> Resolver<'r, 'a> {
    /// Final position (from the base) of a mark.
    pub fn mark_pos(&self, m: Mark) -> u64 {
        self.w.mark_pos(m)
    }
    /// Final position of a placeable's `this`.
    pub fn place_pos(&self, p: PlaceId) -> Result<u64> {
        let u = &self.w.units[self.w.places[p].unit];
        u.start.ok_or_else(|| YaffleError::derive("pointer target was not placed"))
    }
    fn span(&self, slot: SlotId) -> Result<&'r Span> {
        self.w.get_slot(slot)
    }
    /// Region range of a slot (None for codec data).
    fn range(&self, slot: SlotId) -> Result<Option<(usize, usize)>> {
        Ok(match self.span(slot)? {
            Span::Marks(s, e) => Some((self.mark_pos(*s) as usize, self.mark_pos(*e) as usize)),
            Span::Place(p) => {
                let u = &self.w.units[self.w.places[*p].unit];
                let s = u.start.unwrap_or(0) as usize;
                Some((s, s + u.size as usize))
            }
            Span::Data(_) => None,
            Span::Null => Some((0, 0)),
        })
    }
    /// `offsetof`: position from the base.
    pub fn offset(&self, slot: SlotId) -> Result<i128> {
        match self.range(slot)? {
            Some((a, _)) => Ok(a as i128),
            None => Err(YaffleError::derive("offsetof a value that has no position")),
        }
    }
    /// `sizeof` / `encodedSize`.
    pub fn size(&self, slot: SlotId) -> Result<i128> {
        match self.span(slot)? {
            Span::Data(d) => Ok(d.len() as i128),
            _ => {
                let (a, b) = self.range(slot)?.unwrap_or((0, 0));
                Ok((b - a) as i128)
            }
        }
    }
    /// `bytesof` / `encode`: final bytes.
    pub fn bytes(&self, slot: SlotId) -> Result<&'r [u8]> {
        match self.span(slot)? {
            Span::Data(d) => Ok(d.as_slice()),
            _ => {
                let (a, b) = self.range(slot)?.unwrap_or((0, 0));
                Ok(&self.region[a..b])
            }
        }
    }
    /// `$offset` at a mark.
    pub fn offset_at(&self, m: Mark) -> i128 {
        self.mark_pos(m) as i128
    }
    /// `$end`: the region size.
    pub fn region_len(&self) -> i128 {
        self.region.len() as i128
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn al(to: u64) -> Align {
        Align { to, fill: 0, file: false, offset: 0 }
    }

    fn ptr(width: usize) -> PtrFormat {
        PtrFormat { width, endian: Endian::Le, signed: false, relative: false }
    }

    fn finish(w: &mut Writer) -> Vec<u8> {
        w.end_base().unwrap()
    }

    #[test]
    fn plain_bytes_and_pads() {
        let mut w = Writer::new();
        w.begin_base();
        w.u8(1);
        w.align(4, false, 0, WFill::Byte(0xcc)).unwrap();
        w.u8(2);
        let s = w.mark();
        w.u8(3);
        w.pad_until(s, 3, WFill::Byte(0)).unwrap();
        assert_eq!(finish(&mut w), vec![1, 0xcc, 0xcc, 0xcc, 2, 3, 0, 0]);
    }

    #[test]
    fn pad_until_overflow_is_input_error() {
        let mut w = Writer::new();
        w.begin_base();
        let s = w.mark();
        w.bytes(&[1, 2, 3]);
        assert_eq!(w.pad_until(s, 2, WFill::Byte(0)).unwrap_err().code, ErrorCode::Input);
    }

    #[test]
    fn pointers_and_default_order() {
        // root: ptr a, ptr b ; a: ptr c ; layout default pre-order → a, c, b
        let mut w = Writer::new();
        w.begin_base();
        let pa = w
            .place(Some((1, "T")), Key::Field("a"), PlaceOpts::default(), |w| {
                w.u8(0xaa);
                let pc = w.place(Some((3, "T")), Key::Field("c"), PlaceOpts::default(), |w| {
                    w.u8(0xcc);
                    Ok(())
                })?;
                w.pointer(pc, ptr(1), None)
            })
            .unwrap();
        w.pointer(pa, ptr(1), None).unwrap();
        let pb = w
            .place(Some((2, "T")), Key::Field("b"), PlaceOpts::default(), |w| {
                w.u8(0xbb);
                Ok(())
            })
            .unwrap();
        w.pointer(pb, ptr(1), None).unwrap();
        // shared: same ident gives the same placeable
        let pa2 = w.place(Some((1, "T")), Key::Field("a2"), PlaceOpts::default(), |_| panic!()).unwrap();
        assert_eq!(pa, pa2);
        w.pointer(pa2, ptr(1), None).unwrap();
        // root = [pa, pb, pa] (3 bytes) then a(aa, ptr c) c(cc) b(bb)
        assert_eq!(finish(&mut w), vec![3, 6, 3, 0xaa, 5, 0xcc, 0xbb]);
    }

    #[test]
    fn layout_items_pull_out_and_align() {
        // root scope: items[2] each with a placeable `m` and `n`; layout { items[*].n @align(4), this-default }
        let mut w = Writer::new();
        w.begin_base();
        w.set_layout(vec![LayoutItem { path: Some(vec![LSeg::Field("items"), LSeg::Each, LSeg::Field("n")]), align: Some(al(4)), group: None }]);
        w.enter(Key::Field("items"));
        for i in 0..2u8 {
            w.enter(Key::Index(i as usize));
            let m = w.place(None, Key::Field("m"), PlaceOpts::default(), |w| {
                w.u8(0x10 + i);
                Ok(())
            })
            .unwrap();
            w.pointer(m, ptr(1), None).unwrap();
            let n = w.place(None, Key::Field("n"), PlaceOpts::default(), |w| {
                w.u8(0x20 + i);
                Ok(())
            })
            .unwrap();
            w.pointer(n, ptr(1), None).unwrap();
            w.leave();
        }
        w.leave();
        // this = 4 bytes [m0 n0 m1 n1]; n0 @4, n1 @8 (aligned 4), then leftovers m0 @9, m1 @10
        assert_eq!(finish(&mut w), vec![9, 4, 10, 8, 0x20, 0, 0, 0, 0x21, 0x10, 0x11]);
    }

    #[test]
    fn this_later_in_unit_layout() {
        // a placeable whose layout puts its targets before its own bytes
        let mut w = Writer::new();
        w.begin_base();
        let p = w
            .place(None, Key::Field("c"), PlaceOpts::default(), |w| {
                w.set_layout(vec![
                    LayoutItem { path: Some(vec![LSeg::Field("x")]), align: None, group: None },
                    LayoutItem { path: None, align: None, group: None },
                ]);
                let x = w.place(None, Key::Field("x"), PlaceOpts::default(), |w| {
                    w.bytes(&[0xee, 0xee]);
                    Ok(())
                })?;
                w.pointer(x, ptr(1), None)?;
                w.u8(0xcc);
                Ok(())
            })
            .unwrap();
        w.pointer(p, ptr(1), None).unwrap();
        assert_eq!(finish(&mut w), vec![3, 0xee, 0xee, 1, 0xcc]);
    }

    #[test]
    fn fixed_placements_and_overlap() {
        let mut w = Writer::new();
        w.begin_base();
        w.u8(1);
        w.place(None, Key::Field("f"), PlaceOpts { fixed: Some(4), ..Default::default() }, |w| {
            w.bytes(&[9, 9]);
            Ok(())
        })
        .unwrap();
        w.place(None, Key::Field("g"), PlaceOpts::default(), |w| {
            w.bytes(&[7, 7, 7, 7]);
            Ok(())
        })
        .unwrap();
        // g doesn't fit before 4 → skips past the fixed range
        assert_eq!(finish(&mut w), vec![1, 0, 0, 0, 9, 9, 7, 7, 7, 7]);

        let mut w = Writer::new();
        w.begin_base();
        w.u8(1);
        for off in [2u64, 3] {
            w.place(None, Key::Field("f"), PlaceOpts { fixed: Some(off), ..Default::default() }, |w| {
                w.bytes(&[9, 9]);
                Ok(())
            })
            .unwrap();
        }
        assert_eq!(w.end_base().unwrap_err().code, ErrorCode::Overlap);
    }

    #[test]
    fn constraints() {
        let mut w = Writer::new();
        w.begin_base();
        w.u8(1);
        let p = w
            .place(None, Key::Field("d"), PlaceOpts { constraint: Some((8, 2)), ..Default::default() }, |w| {
                w.u8(5);
                Ok(())
            })
            .unwrap();
        w.pointer(p, ptr(1), None).unwrap();
        assert_eq!(finish(&mut w), vec![1, 2, 5]);
    }

    #[test]
    fn fixups_and_checksums() {
        let mut w = Writer::new();
        w.begin_base();
        let s_body = w.slot();
        // size field before the body
        w.fixup(1, vec![], Box::new(move |r| Ok(vec![r.size(s_body)? as u8]))).unwrap();
        // crc of the body (reads its bytes, which contain a pointer)
        w.fixup(4, vec![s_body], Box::new(move |r| Ok(super::super::checksum::crc32(r.bytes(s_body)?).to_le_bytes().to_vec())))
            .unwrap();
        let start = w.mark();
        let p = w
            .place(None, Key::Field("t"), PlaceOpts::default(), |w| {
                w.u8(0x42);
                Ok(())
            })
            .unwrap();
        w.u8(7);
        w.pointer(p, ptr(1), None).unwrap();
        let sp = w.span_from(start);
        w.set_slot(s_body, sp);
        w.late_check(Box::new(move |r| {
            if r.size(s_body)? == 2 {
                Ok(())
            } else {
                Err(YaffleError::derive("bad"))
            }
        }))
        .unwrap();
        let out = finish(&mut w);
        let crc = super::super::checksum::crc32(&[7, 7]);
        let mut want = vec![2];
        want.extend_from_slice(&crc.to_le_bytes());
        want.extend_from_slice(&[7, 7, 0x42]);
        assert_eq!(out, want);
    }

    #[test]
    fn refs_resolve_to_equal_values() {
        let pool = vec!["ab".to_string(), "cd".to_string()];
        let want = "cd".to_string();
        let missing = "zz".to_string();
        let mut w = Writer::new();
        w.begin_base();
        w.ref_pointer(&want, 0, "str", ptr(1), None).unwrap();
        for s in &pool {
            let m = w.mark();
            w.string(s, Encoding::Utf8, Endian::Le, StrLen::Until).unwrap();
            w.candidate(s, 0, "str", m).unwrap();
        }
        assert_eq!(finish(&mut w), vec![4, b'a', b'b', 0, b'c', b'd', 0]);

        let mut w = Writer::new();
        w.begin_base();
        w.ref_pointer(&missing, 0, "str", ptr(1), None).unwrap();
        assert_eq!(w.end_base().unwrap_err().code, ErrorCode::Ref);
        // @origin: the pointer counts from base + origin.
        let pool2 = String::from("ab");
        let want2 = String::from("ab");
        let mut w = Writer::new();
        w.begin_base();
        let m = w.mark();
        w.string(&pool2, Encoding::Utf8, Endian::Le, StrLen::Until).unwrap();
        w.candidate(&pool2, 0, "str", m).unwrap();
        w.ref_pointer(&want2, 0, "str", PtrFormat { signed: true, ..ptr(1) }, Some(Box::new(|_: &Resolver| Ok(2)))).unwrap();
        let t = w.place(None, Key::Field("t"), PlaceOpts::default(), |w| {
            w.u8(5);
            Ok(())
        })
        .unwrap();
        w.pointer(t, PtrFormat { signed: true, ..ptr(1) }, Some(Box::new(|_: &Resolver| Ok(1)))).unwrap();
        assert_eq!(finish(&mut w), vec![b'a', b'b', 0, 0xfe, 4, 5]);
    }

    #[test]
    fn nested_bases_are_self_contained() {
        let mut w = Writer::new();
        w.begin_base();
        w.u8(0xff);
        w.begin_base();
        let p = w
            .place(None, Key::Field("t"), PlaceOpts::default(), |w| {
                w.u8(0x42);
                Ok(())
            })
            .unwrap();
        w.pointer(p, ptr(1), None).unwrap();
        let inner = w.end_base().unwrap();
        assert_eq!(inner, vec![1, 0x42]);
        w.bytes(&inner);
        assert_eq!(finish(&mut w), vec![0xff, 1, 0x42]);
    }

    #[test]
    fn relative_pointers_and_ranges() {
        let mut w = Writer::new();
        w.begin_base();
        w.u8(0);
        let p = w
            .place(None, Key::Field("t"), PlaceOpts::default(), |w| {
                w.u8(0x42);
                Ok(())
            })
            .unwrap();
        w.pointer(p, PtrFormat { signed: true, relative: true, ..ptr(1) }, None).unwrap();
        assert_eq!(finish(&mut w), vec![0, 1, 0x42]);
        assert!(enc_int(256, 1, Endian::Le, false).is_err());
        assert!(enc_int(-129, 1, Endian::Le, true).is_err());
        assert_eq!(enc_int(-1, 2, Endian::Be, true).unwrap(), vec![0xff, 0xff]);
    }

    #[test]
    fn strings_on_write() {
        let mut w = Writer::new();
        w.begin_base();
        w.string("ab", Encoding::Utf8, Endian::Le, StrLen::Count(4)).unwrap();
        w.string("x", Encoding::Utf16, Endian::Be, StrLen::Until).unwrap();
        assert_eq!(w.string("abcde", Encoding::Utf8, Endian::Le, StrLen::Count(4)).unwrap_err().code, ErrorCode::Input);
        assert_eq!(finish(&mut w), vec![b'a', b'b', 0, 0, 0, b'x', 0, 0]);
    }

    #[test]
    fn refs_escalate_to_enclosing_bases() {
        let pool = String::from("ab");
        let want = String::from("ab");
        let mut w = Writer::new();
        w.begin_base();
        let m = w.mark();
        w.string(&pool, Encoding::Utf8, Endian::Le, StrLen::Until).unwrap();
        w.candidate(&pool, 0, "str", m).unwrap();
        w.u8(9);
        // A nested base at 4 whose pointer counts from its own start: 0 - 4.
        w.begin_base();
        w.u8(7);
        w.ref_pointer(&want, 0, "str", PtrFormat { signed: true, ..ptr(1) }, None).unwrap();
        w.end_base_inline().unwrap();
        assert_eq!(finish(&mut w), vec![b'a', b'b', 0, 9, 7, 0xfc]);
        // Without an enclosing base to search, it's a REF error.
        let mut w = Writer::new();
        w.begin_base();
        w.begin_base();
        w.ref_pointer(&want, 0, "str", PtrFormat { signed: true, ..ptr(1) }, None).unwrap();
        w.end_base_inline().unwrap();
        assert_eq!(w.end_base().unwrap_err().code, ErrorCode::Ref);
    }

    #[test]
    fn eager_measurements() {
        let mut w = Writer::new();
        w.begin_base();
        let s = w.slot();
        let m = w.mark();
        w.bytes(&[1, 2, 3]);
        let sp = w.span_from(m);
        w.set_slot(s, sp);
        assert_eq!(w.size_now(s).unwrap(), 3);
        assert_eq!(w.bytes_now(s).unwrap(), vec![1, 2, 3]);
        assert_eq!(w.offset_now().unwrap(), 3);
        // The base's own unit starts at 0: its padding is known while encoding.
        w.align(8, false, 0, WFill::Byte(0)).unwrap();
        assert_eq!(w.offset_now().unwrap(), 8);
        let s2 = w.slot();
        assert!(w.size_now(s2).is_err());
        // Inside a placeable, padding depends on the layout.
        w.place(None, Key::Field("p"), PlaceOpts::default(), |w| {
            w.u8(1);
            w.align(4, false, 0, WFill::Byte(0))?;
            assert!(w.offset_now().is_err());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn layout_groups_place_per_element() {
        // vols[2], each with placeables a and b; layout { vols[*]-group { b, a } } → b0 a0 b1 a1.
        let mut w = Writer::new();
        w.begin_space();
        let group = LayoutItem {
            path: Some(vec![LSeg::Field("vols")]),
            align: None,
            group: Some(vec![
                LayoutItem { path: Some(vec![LSeg::Field("b")]), align: None, group: None },
                LayoutItem { path: Some(vec![LSeg::Field("a")]), align: None, group: None },
            ]),
        };
        w.set_layout(vec![group]);
        w.enter(Key::Field("vols"));
        for i in 0..2u8 {
            w.enter(Key::Index(i as usize));
            for (name, v) in [("a", 0xa0 + i), ("b", 0xb0 + i)] {
                let p = w.place(None, Key::Field(name), PlaceOpts::default(), |w| {
                    w.u8(v);
                    Ok(())
                })
                .unwrap();
                w.pointer(p, ptr(1), None).unwrap();
            }
            w.leave();
        }
        w.leave();
        // this = [a0 b0 a1 b1] pointers; then b0 @4, a0 @5, b1 @6, a1 @7.
        assert_eq!(finish(&mut w), vec![5, 4, 7, 6, 0xb0, 0xa0, 0xb1, 0xa1]);
    }

    #[test]
    fn alignment_origins_and_offsets() {
        // @align(4, offset: 3) at 1: (1 + 3 + 0) % 4 == 0 → no padding; at 2 → 3 bytes.
        let mut w = Writer::new();
        w.begin_space();
        w.u8(1);
        w.align(4, false, 3, WFill::Byte(0xee)).unwrap();
        w.u8(2);
        w.align(4, false, 3, WFill::Byte(0xee)).unwrap();
        w.u8(3);
        assert_eq!(finish(&mut w), vec![1, 2, 0xee, 0xee, 0xee, 3]);
        // From the file: a @base at 3 aligning to 4 from the file pads 1 byte, from the base 0.
        let mut w = Writer::new();
        w.begin_space();
        w.bytes(&[9, 9, 9]);
        w.begin_base();
        w.align(4, true, 0, WFill::Byte(0xcc)).unwrap();
        w.u8(1);
        w.align(4, false, 0, WFill::Byte(0xdd)).unwrap();
        w.u8(2);
        w.end_base_inline().unwrap();
        assert_eq!(finish(&mut w), vec![9, 9, 9, 0xcc, 1, 0xdd, 0xdd, 2]);
        // Placement alignment from the file inside a base at 2.
        let mut w = Writer::new();
        w.begin_space();
        w.bytes(&[7, 7]);
        w.begin_base();
        w.u8(1);
        let p = w
            .place(None, Key::Field("t"), PlaceOpts { align: vec![Align { file: true, ..al(8) }], ..Default::default() }, |w| {
                w.u8(5);
                Ok(())
            })
            .unwrap();
        w.pointer(p, ptr(1), None).unwrap();
        w.end_base_inline().unwrap();
        // The base is at 2: its target goes at file offset 8 = base offset 6.
        assert_eq!(finish(&mut w), vec![7, 7, 1, 6, 0, 0, 0, 0, 5]);
        // A @base inside a placeable doesn't know its file position.
        let mut w = Writer::new();
        w.begin_space();
        w.place(None, Key::Field("t"), PlaceOpts::default(), |w| {
            w.begin_base();
            w.align(4, true, 0, WFill::Byte(0))?;
            w.u8(1);
            w.end_base_inline()
        })
        .unwrap_err();
    }

    #[test]
    fn computed_alignments_must_be_positive() {
        assert_eq!(Align::checked(8, 0, false, 0).unwrap(), al(8));
        assert_eq!(Align::checked(0, 0, false, 0).unwrap_err().code, ErrorCode::Range);
        assert_eq!(Align::checked(-4, 0, false, 0).unwrap_err().code, ErrorCode::Range);
        assert_eq!(al(0).pad(3, None).unwrap_err().code, ErrorCode::Range);
    }

    /// A root `[ptr]` whose target `d` (2 bytes) is aligned by a layout item; `sticky` keeps old positions.
    fn item_aligned(to: u64, sticky: Option<HashMap<String, (u64, u64)>>) -> (Vec<u8>, Vec<(String, u64, u64)>) {
        let mut w = Writer::new();
        if let Some(s) = sticky {
            w.set_sticky(s);
        }
        w.record_places();
        w.begin_base();
        w.set_layout(vec![LayoutItem { path: Some(vec![LSeg::Field("d")]), align: Some(al(to)), group: None }]);
        w.push_field("d");
        let d = w
            .place(None, Key::Field("d"), PlaceOpts::default(), |w| {
                w.bytes(&[0xdd, 0xdd]);
                Ok(())
            })
            .unwrap();
        w.pointer(d, ptr(1), None).unwrap();
        w.pop_path();
        let out = finish(&mut w);
        (out, w.take_recorded())
    }

    #[test]
    fn sticky_placements_keep_their_alignment() {
        let (out, rec) = item_aligned(4, None);
        assert_eq!(out, vec![4, 0, 0, 0, 0xdd, 0xdd]);
        let places: HashMap<String, (u64, u64)> = rec.into_iter().map(|(k, p, s)| (k, (p, s))).collect();
        // Still aligned at 4: kept.
        assert_eq!(item_aligned(2, Some(places.clone())).0, vec![4, 0, 0, 0, 0xdd, 0xdd]);
        // The item now aligns to 8 (an edited field it reads): moved after everything, aligned.
        assert_eq!(item_aligned(8, Some(places)).0, vec![8, 0, 0, 0, 0, 0, 0, 0, 0xdd, 0xdd]);
    }

    #[test]
    fn stream_pieces() {
        let mut w = Writer::new();
        w.push_pieces(1, vec![vec![1], vec![2]]);
        assert_eq!(w.take_piece(1), Some(vec![1]));
        assert_eq!(w.take_piece(1), Some(vec![2]));
        assert_eq!(w.take_piece(1), None);
        assert_eq!(w.take_piece(2), None);
    }
}
