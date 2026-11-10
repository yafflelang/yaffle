//! Views: lazy access to a document, in-place patches, and commits.
//!
//! A view of a struct is opened by *scanning* it: its inline members are read, but pointer and
//! `at` targets, codec regions and streams are not (they get default placeholders), and
//! every field's location and read context is kept in a field span. Those fields are read, or
//! opened as views of their own, on demand.
//!
//! All views of one document share a [`ViewRoot`]: the document bytes, the reader state shared
//! by every read (identities of targets, so `$ref`s and cycles come out as in `parse`; decoded
//! codec regions and streams, kept and decoded once), and a cache of view nodes, so every handle
//! of one struct sees the same state.

use std::any::Any;
use std::cell::{Cell, Ref, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use super::error::{ErrorCode, Result, YaffleError};
use super::helpers::Ident;
use super::prim::{get_uint, sign_extend, Endian};
use super::read::{follow_in, Reader, RegionKey, Shared, SharedCell, Stub};
use super::space::{Filler, LazyBuf, Source, Space, SpaceData, Src};
use super::write::{constrained, Align, PtrFormat, WFill, Writer};

/// An edit of the document: at `at`, `remove` bytes were replaced by `insert`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Patch {
    pub at: usize,
    pub remove: usize,
    pub insert: Vec<u8>,
}

/// How a commit handles values whose size changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Grow {
    /// Targets that changed size move to the end; inline size changes shift what follows.
    #[default]
    Append,
    /// Every size change shifts what follows, and pointers across it are fixed.
    Splice,
    /// Any size change is an error.
    Error,
}

/// Where a field is: its inline bytes, its target's address (pointers and `at` fields), and the
/// read context there (region, base, region end, strict mode, endianness).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FieldSpan {
    pub start: usize,
    pub end: usize,
    pub target: Option<usize>,
    /// The region the field's bytes are in (0: the document).
    pub region: u32,
    pub base: usize,
    /// The region end at the field ([`DOC_END`]: the document's end, also after appends).
    pub limit: usize,
    pub strict: bool,
    pub endian: Endian,
}

impl FieldSpan {
    /// The span of bytes `[start, end)` read by `r` (whose state is the one at the field).
    pub fn of(r: &Reader<'_>, start: usize, end: usize, target: Option<usize>, endian: Endian) -> Self {
        FieldSpan {
            start,
            end,
            target,
            region: r.region(),
            base: r.base,
            limit: limit_of(r.region(), r.end, r.src().len()),
            strict: r.strict,
            endian,
        }
    }
}

/// Where a scanned struct is.
#[derive(Debug, Clone, Copy)]
pub struct Loc {
    /// Absolute position of the struct's first member.
    pub start: usize,
    /// The base in effect where the struct is used (a `@base` struct sets its own).
    pub base: usize,
    pub end: usize,
    pub strict: bool,
    pub index: Option<usize>,
    /// The region the struct is in (0: the document).
    pub region: u32,
}

impl Loc {
    /// The location of a struct about to be read by `r`.
    pub fn of(r: &Reader<'_>) -> Self {
        Loc {
            start: r.pos,
            base: r.base,
            end: limit_of(r.region(), r.end, r.src().len()),
            strict: r.strict,
            index: r.index,
            region: r.region(),
        }
    }
}

/// The result of scanning a struct: its shallow value, field spans, location and arguments.
#[derive(Debug, Clone)]
pub struct Scan<T, A> {
    pub value: T,
    pub spans: Vec<Option<FieldSpan>>,
    pub loc: Loc,
    /// Absolute position after the struct's inline bytes.
    pub end_pos: usize,
    pub args: A,
}

/// The state of a view node (shared by every handle of one struct).
#[derive(Debug)]
pub struct ViewState<T> {
    pub value: T,
    pub spans: Vec<Option<FieldSpan>>,
    pub end_pos: usize,
    /// The root's version when this was scanned (patches bump it; stale nodes rescan).
    pub version: u64,
    /// Fields set to values that can't be patched in place (structural edits), by field index.
    pub edits: HashMap<usize, Rc<dyn Any>>,
}

/// A region end that follows the document's length (views of the whole document keep working
/// after appends).
pub const DOC_END: usize = usize::MAX;

/// The end of a view's region given the document's current length.
#[inline]
pub fn end_of(end: usize, doc_len: usize) -> usize {
    if end == DOC_END {
        doc_len
    } else {
        end
    }
}

/// The region end to keep for a struct or field in `region` whose end is `end`.
#[inline]
pub fn limit_of(region: u32, end: usize, len: usize) -> usize {
    if region == 0 && end == len {
        DOC_END
    } else {
        end
    }
}

/// The bytes of a region, borrowed for reading.
pub enum Guard<'r> {
    Doc(Ref<'r, SpaceData>),
    Space(Rc<Space>),
}

impl Guard<'_> {
    #[inline]
    pub fn src(&self) -> Src<'_> {
        match self {
            Guard::Doc(d) => d.src(),
            Guard::Space(s) => s.src(),
        }
    }
}

type NodeKey = (u32, usize, &'static str, Box<[i128]>);

/// Everything the views of one document share.
pub struct ViewRoot {
    doc: RefCell<SpaceData>,
    patches: RefCell<Vec<Patch>>,
    /// Reader state shared by every read through the views (identities, decoded regions).
    pub shared: SharedCell,
    nodes: RefCell<HashMap<NodeKey, Rc<dyn Any>>>,
    version: Cell<u64>,
    structural: Cell<bool>,
    /// Materialize the values as they are in the document (commits compare with them).
    ignore_edits: Cell<bool>,
    pub strict: bool,
}

pub type ViewCtx = Rc<ViewRoot>;

impl ViewRoot {
    /// The root of views over `data`.
    pub fn new(data: SpaceData, strict: bool) -> ViewCtx {
        Rc::new(ViewRoot {
            doc: RefCell::new(data),
            patches: RefCell::new(Vec::new()),
            shared: RefCell::new(Shared::for_views()),
            nodes: RefCell::new(HashMap::new()),
            version: Cell::new(0),
            structural: Cell::new(false),
            ignore_edits: Cell::new(false),
            strict,
        })
    }
    /// Views over bytes in memory.
    pub fn from_bytes(bytes: Vec<u8>, strict: bool) -> ViewCtx {
        Self::new(SpaceData::Bytes(bytes), strict)
    }
    /// Views over a random-access source, read in 64 KiB blocks on demand.
    pub fn from_source(src: Box<dyn Source>, strict: bool) -> ViewCtx {
        Self::new(SpaceData::Lazy(LazyBuf::from_source(src, 64 * 1024)), strict)
    }

    /// Bumped by every patch: nodes scanned before rescan.
    pub fn version(&self) -> u64 {
        self.version.get()
    }
    /// The bytes of a region: the document (0), or a decoded region or stream.
    pub fn space(&self, region: u32) -> Result<Guard<'_>> {
        if region == 0 {
            return Ok(Guard::Doc(self.doc.borrow()));
        }
        self.shared
            .borrow()
            .space(region)
            .map(Guard::Space)
            .ok_or_else(|| YaffleError::new(ErrorCode::Range, format!("view region {region} is gone")))
    }
    /// The node of the struct `key` at `(region, pos)` with the identity parts of its arguments
    /// `parts` (see [`crate::read::Reader::follow_keyed`]): the cached one, or `make()`'s.
    pub fn node<S: 'static>(
        &self,
        region: u32,
        pos: usize,
        key: &'static str,
        parts: &[i128],
        make: impl FnOnce() -> S,
    ) -> Rc<S> {
        let k: NodeKey = (region, pos, key, parts.into());
        if let Some(n) = self.nodes.borrow().get(&k) {
            if let Ok(s) = n.clone().downcast::<S>() {
                return s;
            }
        }
        let s = Rc::new(make());
        self.nodes.borrow_mut().insert(k, s.clone() as Rc<dyn Any>);
        s
    }

    /// Registers a struct value being materialized at `(region, pos)`.
    pub fn begin_ident(&self, region: u32, pos: usize, key: &'static str, parts: &[i128]) -> Ident {
        self.shared.borrow_mut().begin_ident(region, pos, key, parts)
    }
    pub fn end_ident(&self, region: u32, pos: usize, key: &'static str, parts: &[i128]) {
        self.shared.borrow_mut().end_ident(region, pos, key, parts)
    }

    /// A target at `(region, addr)` with identity: shared with every other read of it (through
    /// views or readers), a stub for a struct that is being read (a cycle), else `f()`. `parts`
    /// are the run-time parts of its type (see [`Reader::follow_keyed`]).
    pub fn follow<T: 'static>(
        &self,
        region: u32,
        addr: usize,
        key: &'static str,
        parts: &[i128],
        stub: Option<Stub<T>>,
        f: impl FnOnce() -> Result<T>,
    ) -> Result<Rc<T>> {
        follow_in(&self.shared, region, addr, key, parts, stub, f)
    }

    /// Whether structural edits apply (false while materializing the document's own values).
    pub fn edits_apply(&self) -> bool {
        !self.ignore_edits.get()
    }
    /// Runs `f` with structural edits ignored: values as they are in the document.
    pub fn without_edits<T>(&self, f: impl FnOnce() -> Result<T>) -> Result<T> {
        let old = self.ignore_edits.replace(true);
        self.shared.borrow_mut().forget_targets();
        let r = f();
        self.ignore_edits.set(old);
        self.shared.borrow_mut().forget_targets();
        r
    }

    /// Marks a structural edit (a value that can't be patched in place).
    pub fn mark_structural(&self) {
        self.structural.set(true);
        self.bump();
    }
    /// Whether the views have structural edits.
    pub fn is_structural(&self) -> bool {
        self.structural.get()
    }
    fn bump(&self) {
        self.version.set(self.version.get() + 1);
        // Targets read before the change are read again.
        self.shared.borrow_mut().forget_targets();
    }

    /// Replaces `bytes.len()` bytes of the document at `at` (same size: an in-place patch).
    pub fn patch(&self, at: usize, bytes: &[u8]) -> Result<()> {
        let mut doc = self.doc.borrow_mut();
        let end = at.checked_add(bytes.len()).filter(|&e| e <= doc.len());
        if end.is_none() {
            return Err(YaffleError::new(ErrorCode::Range, "patch outside the document"));
        }
        if doc.src().get(at, at + bytes.len())? == bytes {
            return Ok(());
        }
        match &mut *doc {
            SpaceData::Bytes(b) => b[at..at + bytes.len()].copy_from_slice(bytes),
            SpaceData::Lazy(l) => l.write(at, bytes)?,
        }
        self.patches.borrow_mut().push(Patch { at, remove: bytes.len(), insert: bytes.to_vec() });
        self.bump();
        Ok(())
    }

    /// "append" strategy: appends a new target at the end of the document, aligned (from `base`)
    /// and satisfying the placement constraint. Returns its absolute position.
    pub fn append(&self, base: usize, aligns: &[Align], constraint: Option<(u64, u64)>, content: &[u8]) -> Result<usize> {
        let mut doc = self.doc.borrow_mut();
        doc.make_plain()?;
        let SpaceData::Bytes(bytes) = &mut *doc else {
            return Err(YaffleError::input("the document can't grow"));
        };
        let len = bytes.len();
        if base > len {
            return Err(YaffleError::range("base outside the document"));
        }
        // Alignments count from the base; their origins and offsets are not applied here.
        let mut pos = (len - base) as u64;
        for a in aligns.iter().filter(|a| a.to > 1) {
            pos = pos.div_ceil(a.to) * a.to;
        }
        if let Some(c) = constraint {
            pos = constrained(pos, c);
        }
        let abs = base + pos as usize;
        let fill = aligns.last().map_or(0, |a| a.fill);
        let mut insert = vec![fill; abs - len];
        insert.extend_from_slice(content);
        bytes.extend_from_slice(&insert);
        self.patches.borrow_mut().push(Patch { at: len, remove: 0, insert });
        self.bump();
        Ok(abs)
    }

    /// The patches applied to the document so far.
    pub fn patches(&self) -> Vec<Patch> {
        self.patches.borrow().clone()
    }
    /// The document's current bytes.
    pub fn bytes(&self) -> Result<Vec<u8>> {
        Ok(self.doc.borrow().all()?.to_vec())
    }
    /// Replaces the document (after a structural commit): every node and kept region is reset.
    pub fn rebind(&self, bytes: Vec<u8>) {
        *self.doc.borrow_mut() = SpaceData::Bytes(bytes);
        *self.shared.borrow_mut() = Shared::for_views();
        self.nodes.borrow_mut().clear();
        self.structural.set(false);
        self.bump();
    }
    /// Records the patches of a structural commit (the diff of the old and new bytes).
    pub fn record_commit(&self, old: &[u8], new: &[u8]) {
        if let Some(p) = diff(old, new) {
            self.patches.borrow_mut().push(p);
        }
    }

    /// A stream of pieces (`from arr[*].field`) as a kept region keyed by `key`. With
    /// `sizes` (every piece's decoded size, known without decoding), pieces are decoded on first
    /// access by `piece(k)`; otherwise `all()` gives the joined bytes now.
    pub fn stream(
        &self,
        key: RegionKey,
        sizes: Option<Vec<usize>>,
        piece: Rc<dyn Fn(usize) -> Result<Vec<u8>>>,
        all: impl FnOnce() -> Result<Vec<u8>>,
    ) -> Result<Rc<Space>> {
        let kept = self.shared.borrow().kept(key);
        if let Some(sp) = kept {
            return Ok(sp);
        }
        let data = match sizes {
            Some(sizes) => {
                // One chunk per non-empty piece: its start and the piece's index.
                let mut chunks: Vec<(usize, usize)> = Vec::new();
                let mut len = 0usize;
                for (k, &n) in sizes.iter().enumerate() {
                    if n > 0 {
                        chunks.push((len, k));
                    }
                    len += n;
                }
                let starts = chunks.iter().map(|&(s, _)| s).collect();
                let filler: Filler = Box::new(move |c, _, out| {
                    let k = chunks.get(c).map_or(c, |&(_, k)| k);
                    let bytes = piece(k)?;
                    if bytes.len() != out.len() {
                        return Err(YaffleError::derive(format!(
                            "stream piece {k} decoded to {} bytes, but its size field says {}",
                            bytes.len(),
                            out.len()
                        )));
                    }
                    out.copy_from_slice(&bytes);
                    Ok(())
                });
                SpaceData::Lazy(LazyBuf::new(len, starts, filler))
            }
            None => SpaceData::Bytes(all()?),
        };
        Ok(self.shared.borrow_mut().add_space(key, |region| Space::new(region, data, 0)))
    }
}

/// The structural edit of field `k` in a node's edits, if any (and if edits apply).
pub fn edit_of<T: Clone + 'static>(ctx: &ViewRoot, edits: &HashMap<usize, Rc<dyn Any>>, k: usize) -> Option<T> {
    if !ctx.edits_apply() {
        return None;
    }
    edits.get(&k).and_then(|e| e.downcast_ref::<T>()).cloned()
}

/// One patch turning `old` into `new` (common prefix and suffix kept), if they differ.
pub fn diff(old: &[u8], new: &[u8]) -> Option<Patch> {
    if old == new {
        return None;
    }
    let pre = old.iter().zip(new).take_while(|(a, b)| a == b).count();
    let max_suf = old.len().min(new.len()) - pre;
    let suf = old.iter().rev().zip(new.iter().rev()).take(max_suf).take_while(|(a, b)| a == b).count();
    Some(Patch { at: pre, remove: old.len() - pre - suf, insert: new[pre..new.len() - suf].to_vec() })
}

/// A 32-bit tag for a stream region key (a hash of the struct and field names).
pub const fn tag(s: &str) -> u32 {
    let b = s.as_bytes();
    let mut h: u32 = 0x811c9dc5;
    let mut i = 0;
    while i < b.len() {
        h ^= b[i] as u32;
        h = h.wrapping_mul(0x01000193);
        i += 1;
    }
    h | 0x100
}

/// The absolute target of a pointer stored at `at` (`None` for the null value).
pub fn pointer_target(src: Src<'_>, at: usize, fmt: PtrFormat, base: usize, null: Option<i128>) -> Option<usize> {
    let b = src.get(at, at + fmt.width).ok()?;
    let u = get_uint(b, fmt.width, fmt.endian);
    let s = sign_extend(u, (fmt.width * 8) as u32) as i128;
    let raw = if fmt.signed { s } else { u as i128 };
    if null == Some(raw) {
        return None;
    }
    let addr = if fmt.relative { at as i128 + s } else { base as i128 + raw };
    usize::try_from(addr).ok()
}

/// Encodes a value as if it started `prefix` bytes after its base (so alignment padding comes
/// out right), and returns the bytes after the prefix.
pub fn encode_at<'a>(prefix: usize, f: impl FnOnce(&mut Writer<'a>) -> Result<()>) -> Result<Vec<u8>> {
    encode_inline(prefix, Vec::new(), f)
}

/// Re-encodes a struct's own (inline) bytes at `prefix` bytes from its base, with its
/// placeables and `@ref` targets already at `presets` (from the base, in registration order).
pub fn encode_inline<'a>(prefix: usize, presets: Vec<u64>, f: impl FnOnce(&mut Writer<'a>) -> Result<()>) -> Result<Vec<u8>> {
    let mut w = Writer::new();
    w.preset_positions(presets);
    w.begin_base();
    w.fill(prefix, &WFill::Byte(0))?;
    f(&mut w).map_err(|e| w.locate(e))?;
    let mut out = w.end_base()?;
    out.drain(..prefix.min(out.len()));
    Ok(out)
}

/// Replaces a struct's inline bytes `[start, end)` with a re-encoding of the same size.
pub fn patch_inline(ctx: &ViewRoot, start: usize, end: usize, bytes: &[u8]) -> Result<()> {
    if end - start != bytes.len() {
        return Err(YaffleError::new(
            ErrorCode::Input,
            format!(
                "the struct's bytes would change size ({} instead of {}): views patch in place only",
                bytes.len(),
                end - start
            ),
        ));
    }
    ctx.patch(start, bytes)
}

/// Error for a field that has no span (untaken branch).
pub fn no_span(name: &str) -> YaffleError {
    YaffleError::new(ErrorCode::Input, format!("field {name} is not present in this view")).in_field(name)
}

/// Error for an in-place edit of bytes outside the document (a decoded region or a stream).
pub fn not_in_doc(name: &str) -> YaffleError {
    YaffleError::new(ErrorCode::Input, format!("{name} is inside a decoded region: it can't be patched in place")).in_field(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fmt(width: usize, signed_relative: bool) -> PtrFormat {
        PtrFormat { width, endian: Endian::Le, signed: signed_relative, relative: signed_relative }
    }

    #[test]
    fn patches() {
        let d = ViewRoot::from_bytes(vec![1, 2, 3, 4], false);
        d.patch(1, &[9, 9]).unwrap();
        d.patch(0, &[1]).unwrap(); // unchanged: not logged
        assert_eq!(d.bytes().unwrap(), vec![1, 9, 9, 4]);
        assert_eq!(d.patches(), vec![Patch { at: 1, remove: 2, insert: vec![9, 9] }]);
        assert!(d.patch(3, &[1, 2]).is_err());
        assert_eq!(patch_inline(&d, 0, 2, &[1, 2, 3]).unwrap_err().code, ErrorCode::Input);
        patch_inline(&d, 0, 2, &[7, 7]).unwrap();
        assert_eq!(d.bytes().unwrap(), vec![7, 7, 9, 4]);
        assert_eq!(d.version(), 2);
    }

    #[test]
    fn pointers() {
        let b = [0u8, 4, 0xff, 0, 0];
        let s = Src::Bytes(&b);
        assert_eq!(pointer_target(s, 1, fmt(1, false), 0, Some(0)), Some(4));
        assert_eq!(pointer_target(s, 0, fmt(1, false), 0, Some(0)), None);
        assert_eq!(pointer_target(s, 2, fmt(1, true), 0, None), Some(1));
        assert_eq!(pointer_target(s, 4, fmt(2, false), 0, None), None);
    }

    #[test]
    fn appends() {
        let d = ViewRoot::from_bytes(vec![1, 2, 3], false);
        let p = d.append(1, &[Align { to: 4, fill: 0xee, file: false, offset: 0 }], None, &[9, 9]).unwrap();
        assert_eq!(p, 5);
        assert_eq!(d.bytes().unwrap(), vec![1, 2, 3, 0xee, 0xee, 9, 9]);
        let p2 = d.append(0, &[], Some((8, 1)), &[7]).unwrap();
        assert_eq!(p2, 9);
        assert_eq!(d.patches().len(), 2);
        assert_eq!(end_of(DOC_END, 10), 10);
        assert_eq!(end_of(4, 10), 4);
        assert!(patch_inline(&d, 0, 2, &[1]).is_err());
    }

    #[test]
    fn re_encoding_with_presets() {
        // A pointer to an external target at 0x40, written at offset 2 from the base.
        let out = encode_inline(2, vec![0x40], |w| {
            let p = w.place(None, crate::write::Key::Field("t"), Default::default(), |_| panic!("not encoded"))?;
            w.pointer(p, fmt(1, false), None)
        })
        .unwrap();
        assert_eq!(out, vec![0x40]);
    }

    #[test]
    fn encoding_at_an_offset() {
        let out = encode_at(3, |w| {
            w.align(4, false, 0, WFill::Byte(0xcc))?;
            w.u8(7);
            Ok(())
        })
        .unwrap();
        assert_eq!(out, vec![0xcc, 7]);
    }

    #[test]
    fn nodes_and_identity() {
        let d = ViewRoot::from_bytes(vec![0; 8], false);
        let a = d.node(0, 4, "T", &[], || RefCell::new(5u32));
        let b = d.node(0, 4, "T", &[], || RefCell::new(6u32));
        assert!(Rc::ptr_eq(&a, &b));
        *a.borrow_mut() = 7;
        assert_eq!(*b.borrow(), 7);
        // A target read twice is one value; a struct being read gets a stub (a cycle).
        let x = d.follow(0, 4, "k", &[], None, || Ok(1u8)).unwrap();
        let y = d.follow(0, 4, "k", &[], None, || Ok(2u8)).unwrap();
        assert!(Rc::ptr_eq(&x, &y));
        let id = d.begin_ident(0, 0, "S", &[]);
        let s = d.follow(0, 0, "ks", &[], Some(("S", |i| (i.id, i.stub))), || Ok((0, false))).unwrap();
        assert_eq!(*s, (id.id, true));
        d.end_ident(0, 0, "S", &[]);
    }

    #[test]
    fn lazy_streams() {
        let d = ViewRoot::from_bytes(vec![], false);
        let calls = Rc::new(Cell::new(0));
        let c2 = calls.clone();
        let piece: Rc<dyn Fn(usize) -> Result<Vec<u8>>> = Rc::new(move |k| {
            c2.set(c2.get() + 1);
            Ok(vec![k as u8; 3])
        });
        let sp = d.stream((0, 0, 9), Some(vec![3, 0, 3]), piece.clone(), || unreachable!()).unwrap();
        assert_eq!(sp.len(), 6);
        assert_eq!(sp.src().get(4, 5).unwrap(), &[2]);
        assert_eq!(calls.get(), 1);
        // Kept: the same key gives the same space.
        let again = d.stream((0, 0, 9), None, piece, || unreachable!()).unwrap();
        assert!(Rc::ptr_eq(&sp, &again));
        assert!(d.space(sp.region).is_ok());
        assert!(d.space(999).is_err());
    }

    #[test]
    fn diffs() {
        assert_eq!(diff(&[1, 2, 3], &[1, 2, 3]), None);
        assert_eq!(diff(&[1, 2, 3], &[1, 9, 9, 3]), Some(Patch { at: 1, remove: 1, insert: vec![9, 9] }));
        assert_eq!(diff(&[1, 2], &[1, 2, 3]), Some(Patch { at: 2, remove: 0, insert: vec![3] }));
        assert_ne!(tag("A.x"), tag("A.y"));
    }
}
