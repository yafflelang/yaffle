//! The read context (docs/IR.md §2): a buffer, the position of the next inline byte, the
//! current base and region end, strict mode, `$index`, and the shared state of the parse
//! (pointer targets, struct identities, decoded regions).

use std::any::Any;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use super::codec::{Arg, Codec, CodecCtx};
use super::error::{ErrorCode, Result, YaffleError};
use super::helpers::{Ident, IdentMap};
use super::prim::{f16_to_f32, get_uint, sign_extend, Endian};
use super::space::{ranged_space, RangedFn, Space, SpaceData, Src};
use super::strings::{decode, find_nul, Encoding};

/// Padding fill (docs/IR.md §2.4): a byte, or a function of the byte's index in the run.
#[derive(Clone, Copy)]
pub enum Fill<'f> {
    Byte(u8),
    Fn(&'f dyn Fn(i128) -> Result<u8>),
}

impl Fill<'_> {
    #[inline]
    pub fn at(&self, i: usize) -> Result<u8> {
        match self {
            Fill::Byte(b) => Ok(*b),
            Fill::Fn(f) => f(i as i128),
        }
    }
}

/// A value's position and type: the region, the address and a type key.
type IdKey = (u32, usize, &'static str);

/// The key of a region (a codec's decoded side or a stream): the region it is in, the
/// position it starts at, and a tag (1 for codec regions, a hash of the field for streams).
pub type RegionKey = (u32, usize, u32);

/// The cell readers borrow the shared state through, briefly per operation: lazily filled
/// spaces (streams in views) read other bytes while a reader of them is active.
pub type SharedCell = RefCell<Shared>;

/// State shared by every region of one parse (or of one view: views keep it for their whole
/// life, so every read through a view sees the same identities and decoded regions).
#[derive(Default)]
pub struct Shared {
    /// Pointer targets read so far, and the ones being read.
    targets: HashMap<IdKey, Rc<dyn Any>>,
    in_progress: HashSet<IdKey>,
    idents: IdentMap<IdKey>,
    /// Targets and identities registered, in order (union attempts roll them back).
    journal: Vec<IdKey>,
    ident_journal: Vec<IdKey>,
    region_keys: HashMap<RegionKey, u32>,
    /// Views: decoded regions and streams are kept (and decoded once), and `@ranged` regions are
    /// decoded lazily.
    pub views: bool,
    spaces: HashMap<u32, Rc<Space>>,
}

impl Shared {
    /// `Shared::default()` in the cell readers borrow it through.
    pub fn cell() -> SharedCell {
        RefCell::new(Self::default())
    }
    /// State for a view: decoded regions are kept and ranged regions decoded lazily.
    pub fn for_views() -> Self {
        Shared { views: true, ..Default::default() }
    }

    /// The region id of a region key: the same key always gets the same id (0 is the document).
    fn region_for(&mut self, key: RegionKey) -> u32 {
        let next = self.region_keys.len() as u32 + 1;
        *self.region_keys.entry(key).or_insert(next)
    }
    /// A kept space (views) by region id.
    pub fn space(&self, region: u32) -> Option<Rc<Space>> {
        self.spaces.get(&region).cloned()
    }
    /// The space kept for a region key, if any.
    pub fn kept(&self, key: RegionKey) -> Option<Rc<Space>> {
        self.region_keys.get(&key).and_then(|r| self.spaces.get(r)).cloned()
    }
    /// Registers a decoded region or stream, made by `make` from its region id (stable per key);
    /// views keep it.
    pub fn add_space(&mut self, key: RegionKey, make: impl FnOnce(u32) -> Rc<Space>) -> Rc<Space> {
        let sp = make(self.region_for(key));
        if self.views {
            self.spaces.insert(sp.region, sp.clone());
        }
        sp
    }

    /// Registers the struct value at `(region, pos)`; pair with [`Shared::end_ident`].
    pub fn begin_ident(&mut self, region: u32, pos: usize, key: &'static str) -> Ident {
        let (id, new) = self.idents.begin((region, pos, key));
        if new {
            self.ident_journal.push((region, pos, key));
        }
        id
    }
    /// Ends the read of the struct value at `(region, pos)`.
    pub fn end_ident(&mut self, region: u32, pos: usize, key: &'static str) {
        self.idents.end(&(region, pos, key));
    }
    /// Forgets the targets read so far (views: after an edit, targets are read again).
    pub fn forget_targets(&mut self) {
        self.targets.clear();
        self.journal.clear();
    }
}

/// Saved reader state, for union attempts.
#[derive(Clone, Copy)]
pub struct Snapshot {
    pos: usize,
    base: usize,
    end: usize,
    strict: bool,
    index: Option<usize>,
    journal: usize,
    ident_journal: usize,
}

/// How a string's length is given.
#[derive(Clone, Copy, Debug)]
pub enum StrLen {
    /// Exactly n code units (text ends at the first NUL).
    Count(usize),
    /// Code units up to and including a NUL unit.
    Until,
    /// Code units up to the region end.
    Rest,
}

pub struct Reader<'a> {
    src: Src<'a>,
    /// Absolute position of the next inline byte.
    pub pos: usize,
    /// Absolute position of the current base.
    pub base: usize,
    /// Absolute end of the current region.
    pub end: usize,
    pub strict: bool,
    /// `$index`.
    pub index: Option<usize>,
    region: u32,
    shared: &'a SharedCell,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8], shared: &'a SharedCell, strict: bool) -> Self {
        Self::over(Src::Bytes(buf), 0, shared, strict)
    }

    /// A reader over a space's bytes, in region `region` (views).
    pub fn over(src: Src<'a>, region: u32, shared: &'a SharedCell, strict: bool) -> Self {
        Reader { src, pos: 0, base: 0, end: src.len(), strict, index: None, region, shared }
    }

    /// A reader over a decoded region or a stream (base 0, end = its length).
    pub fn sub_space<'b>(&'b mut self, space: &'b Space) -> Reader<'b> {
        Reader { index: self.index, ..Reader::over(space.src(), space.region, self.shared, self.strict) }
    }

    /// The bytes being read.
    #[inline]
    pub fn src(&self) -> Src<'a> {
        self.src
    }
    /// The region id (identity scope) of the bytes being read.
    #[inline]
    pub fn region(&self) -> u32 {
        self.region
    }
    /// The bytes `[a, b)` of the buffer (absolute positions).
    #[inline]
    pub fn slice(&self, a: usize, b: usize) -> Result<&'a [u8]> {
        self.src.get(a, b)
    }
    /// The bytes `[base + offset, base + offset + size)` (`bytesof` on the read side).
    pub fn slice_rel(&self, offset: i128, size: i128) -> Result<&'a [u8]> {
        let a = usize::try_from(self.base as i128 + offset).map_err(|_| YaffleError::range("negative offset"))?;
        let n = usize::try_from(size).map_err(|_| YaffleError::range("negative size"))?;
        self.src.get(a, a + n)
    }

    // ─── Positions ───────────────────────────────────────────────────────────

    /// `$offset`: position relative to the base.
    #[inline]
    pub fn offset(&self) -> i128 {
        self.pos as i128 - self.base as i128
    }
    /// `$end`: region end relative to the base.
    #[inline]
    pub fn end_rel(&self) -> i128 {
        self.end as i128 - self.base as i128
    }
    /// `$index`.
    #[inline]
    pub fn index_value(&self) -> Result<i128> {
        self.index.map(|i| i as i128).ok_or_else(|| YaffleError::range("$index used outside an array"))
    }

    #[inline]
    pub fn need(&self, n: usize) -> Result<()> {
        if self.pos > self.end || self.end - self.pos < n {
            return Err(YaffleError::eof(
                self.pos,
                format!("need {n} bytes at 0x{:x}, region ends at 0x{:x}", self.pos, self.end),
            ));
        }
        Ok(())
    }

    /// Moves to `base + offset` (a placement), returning the old position.
    pub fn seek_rel(&mut self, offset: i128) -> Result<usize> {
        let abs = self.base as i128 + offset;
        if abs < 0 || abs > self.end as i128 {
            return Err(YaffleError::eof(self.pos, format!("offset {offset} is outside the region")));
        }
        Ok(std::mem::replace(&mut self.pos, abs as usize))
    }

    pub fn snapshot(&self) -> Snapshot {
        let sh = self.shared.borrow();
        Snapshot {
            pos: self.pos,
            base: self.base,
            end: self.end,
            strict: self.strict,
            index: self.index,
            journal: sh.journal.len(),
            ident_journal: sh.ident_journal.len(),
        }
    }
    pub fn restore(&mut self, s: Snapshot) {
        self.pos = s.pos;
        self.base = s.base;
        self.end = s.end;
        self.strict = s.strict;
        self.index = s.index;
        let mut guard = self.shared.borrow_mut();
        let sh = &mut *guard;
        for k in sh.journal.drain(s.journal..) {
            sh.targets.remove(&k);
        }
        for k in sh.ident_journal.drain(s.ident_journal..) {
            sh.idents.remove(&k);
        }
    }

    // ─── Primitives ──────────────────────────────────────────────────────────

    #[inline]
    pub fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        self.need(n)?;
        let s = self.src.get(self.pos, self.pos + n)?;
        self.pos += n;
        Ok(s)
    }
    #[inline]
    pub fn uint(&mut self, n: usize, e: Endian) -> Result<u64> {
        let b = self.take(n)?;
        Ok(get_uint(b, n, e))
    }
    #[inline]
    pub fn sint(&mut self, n: usize, e: Endian) -> Result<i64> {
        let v = self.uint(n, e)?;
        Ok(sign_extend(v, (n * 8) as u32))
    }
    #[inline]
    pub fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    #[inline]
    pub fn i8(&mut self) -> Result<i8> {
        Ok(self.take(1)?[0] as i8)
    }
    #[inline]
    pub fn u16(&mut self, e: Endian) -> Result<u16> {
        Ok(self.uint(2, e)? as u16)
    }
    #[inline]
    pub fn i16(&mut self, e: Endian) -> Result<i16> {
        Ok(self.uint(2, e)? as u16 as i16)
    }
    #[inline]
    pub fn u32(&mut self, e: Endian) -> Result<u32> {
        Ok(self.uint(4, e)? as u32)
    }
    #[inline]
    pub fn i32(&mut self, e: Endian) -> Result<i32> {
        Ok(self.uint(4, e)? as u32 as i32)
    }
    #[inline]
    pub fn u64(&mut self, e: Endian) -> Result<u64> {
        self.uint(8, e)
    }
    #[inline]
    pub fn i64(&mut self, e: Endian) -> Result<i64> {
        Ok(self.uint(8, e)? as i64)
    }
    #[inline]
    pub fn f16(&mut self, e: Endian) -> Result<f32> {
        Ok(f16_to_f32(self.uint(2, e)? as u16))
    }
    #[inline]
    pub fn f32(&mut self, e: Endian) -> Result<f32> {
        Ok(f32::from_bits(self.uint(4, e)? as u32))
    }
    #[inline]
    pub fn f64(&mut self, e: Endian) -> Result<f64> {
        Ok(f64::from_bits(self.uint(8, e)?))
    }
    /// One byte: nonzero is true. Strict: only 0 or 1.
    pub fn bool(&mut self) -> Result<bool> {
        let at = self.pos;
        let b = self.u8()?;
        if self.strict && b > 1 {
            return Err(YaffleError::check(at, format!("bool must be 0 or 1, got {b}")));
        }
        Ok(b != 0)
    }

    // ─── Bytes and strings ───────────────────────────────────────────────────

    pub fn bytes(&mut self, n: usize) -> Result<Vec<u8>> {
        Ok(self.take(n)?.to_vec())
    }
    /// Bytes up to a terminator byte (consumed, not included).
    pub fn bytes_until(&mut self, term: u8) -> Result<Vec<u8>> {
        let from = self.pos.min(self.end);
        match self.src.find(from, self.end, 1, |u| u[0] == term)? {
            Some(p) => {
                let v = self.src.get(from, p)?.to_vec();
                self.pos = p + 1;
                Ok(v)
            }
            None => Err(YaffleError::eof(self.end, format!("no terminator 0x{term:02x} before the region end"))),
        }
    }
    /// Bytes up to the region end.
    pub fn bytes_rest(&mut self) -> Result<Vec<u8>> {
        let n = self.end.saturating_sub(self.pos);
        self.bytes(n)
    }

    pub fn string(&mut self, enc: Encoding, e: Endian, len: StrLen) -> Result<String> {
        let unit = enc.unit();
        let start = self.pos;
        let units: &[u8] = match len {
            StrLen::Count(n) => {
                let n = n.checked_mul(unit).ok_or_else(|| YaffleError::range("string length too large"))?;
                let b = self.take(n)?;
                &b[..find_nul(b, unit).unwrap_or(b.len())]
            }
            StrLen::Until => {
                let from = self.pos.min(self.end);
                match self.src.find(from, self.end, unit, |u| u.iter().all(|&x| x == 0))? {
                    Some(p) => {
                        let b = self.src.get(from, p)?;
                        self.pos = p + unit;
                        b
                    }
                    None => return Err(YaffleError::eof(self.end, "unterminated string")),
                }
            }
            StrLen::Rest => {
                let n = self.end.saturating_sub(self.pos);
                if !n.is_multiple_of(unit) {
                    return Err(YaffleError::eof(self.end, "region end splits a code unit"));
                }
                let b = self.take(n)?;
                &b[..find_nul(b, unit).unwrap_or(b.len())]
            }
        };
        decode(units, enc, e).map_err(|m| YaffleError::check(start, m))
    }

    // ─── Padding and windows ─────────────────────────────────────────────────

    /// Skips `n` bytes of padding; `check` compares them with the fill (strict mode, or a
    /// `strict` padding layer).
    pub fn pad(&mut self, n: usize, fill: Fill, check: bool) -> Result<()> {
        let at = self.pos;
        if !check {
            self.need(n)?;
            self.pos += n;
            return Ok(());
        }
        let b = self.take(n)?;
        for (i, &x) in b.iter().enumerate() {
            let want = fill.at(i)?;
            if x != want {
                return Err(YaffleError::check(at + i, format!("padding byte 0x{x:02x}, expected 0x{want:02x}")));
            }
        }
        Ok(())
    }
    /// Skips until `(pos - origin + offset) % to == 0` (`@align(to, from: …, offset: …)`, the
    /// origin being the base or the start of the bytes).
    pub fn align(&mut self, to: usize, origin: usize, offset: i128, fill: Fill, check: bool) -> Result<()> {
        if to == 0 {
            return Err(YaffleError::range("alignment of 0"));
        }
        let rel = (self.pos as i128 - origin as i128 + offset).rem_euclid(to as i128) as usize;
        self.pad((to - rel) % to, fill, check)
    }
    /// After content starting at `start`, skips until it occupies `size` bytes.
    pub fn pad_until(&mut self, start: usize, size: usize, fill: Fill, check: bool) -> Result<()> {
        let used = self.pos - start;
        if used > size {
            return Err(YaffleError::check(start, format!("content is {used} bytes, larger than the padded size {size}")));
        }
        self.pad(size - used, fill, check)
    }
    /// Narrows the region to the next `n` bytes; returns the old end.
    pub fn narrow(&mut self, n: usize) -> Result<usize> {
        self.need(n)?;
        let old = self.end;
        self.end = self.pos + n;
        Ok(old)
    }
    /// Ends a window: the rest is padding (zero in strict mode); restores the old end.
    pub fn close_window(&mut self, old_end: usize) -> Result<()> {
        let n = self.end - self.pos.min(self.end);
        let strict = self.strict;
        self.pad(n, Fill::Byte(0), strict)?;
        self.end = old_end;
        Ok(())
    }


    // ─── Codecs and extern types ─────────────────────────────────────────────

    /// Decodes the codec region at `pos` (the window up to `end`, or what a streaming codec
    /// consumes). Returns the decoded region and the encoded bytes, and moves past them.
    ///
    /// In views, decoded regions are kept (each is decoded once), and a `@ranged` codec (given
    /// `ranged`) is decoded lazily, block by block.
    pub fn decode<C: Codec + ?Sized>(
        &mut self,
        codec: &C,
        streaming: bool,
        args: &[Arg],
        output_size: Option<usize>,
        ranged: Option<RangedFn>,
    ) -> Result<(Rc<Space>, &'a [u8])> {
        let at = self.pos;
        let key: RegionKey = (self.region, at, 1);
        let kept = self.shared.borrow().kept(key);
        if let Some(sp) = kept {
            let enc = self.slice(at, at + sp.encoded_len)?;
            self.pos += sp.encoded_len;
            return Ok((sp, enc));
        }
        let codec_error = |m: String| YaffleError::at(ErrorCode::Codec, at, m);
        let window = self.src.get(at.min(self.end), self.end)?;
        let views = self.shared.borrow().views;
        let (sp, used) = match ranged {
            Some(f) if views && !streaming => {
                if let Some(n) = output_size.filter(|&n| n != window.len()) {
                    return Err(codec_error(format!(
                        "a ranged codec keeps lengths, but {} bytes decode to {n}",
                        window.len()
                    )));
                }
                let sp = self.shared.borrow_mut().add_space(key, |region| ranged_space(region, window.to_vec(), f, at));
                (sp, window.len())
            }
            _ => {
                let ctx = CodecCtx { args, output_size, position: None };
                let (out, used) = if streaming {
                    codec.decode_streaming(window, &ctx)
                } else {
                    codec.decode(window, &ctx).map(|o| (o, window.len()))
                }
                .map_err(codec_error)?;
                if used > window.len() {
                    return Err(codec_error("codec consumed more bytes than available".into()));
                }
                if let Some(n) = output_size.filter(|&n| n != out.len()) {
                    return Err(codec_error(format!("codec produced {} bytes, expected {n}", out.len())));
                }
                let sp = self.shared.borrow_mut().add_space(key, |region| Space::new(region, SpaceData::Bytes(out), used));
                (sp, used)
            }
        };
        self.pos += used;
        Ok((sp, &window[..used]))
    }

    /// A stream's bytes as a region keyed by `tag` at the current position (identity of
    /// values read from it is stable). Views keep it.
    pub fn stream(&mut self, tag: u32, bytes: impl FnOnce() -> Result<Vec<u8>>) -> Result<Rc<Space>> {
        let key: RegionKey = (self.region, self.pos, tag);
        let kept = self.shared.borrow().kept(key);
        if let Some(sp) = kept {
            return Ok(sp);
        }
        let data = bytes()?;
        Ok(self.shared.borrow_mut().add_space(key, |region| Space::new(region, SpaceData::Bytes(data), 0)))
    }

    /// The bytes of an extern type value at `pos`, using its `size`.
    pub fn extern_bytes(&mut self, size: impl Fn(&[u8]) -> Option<usize>, fixed: Option<usize>) -> Result<&'a [u8]> {
        let n = match fixed {
            Some(n) => n,
            None => {
                let avail = self.src.get(self.pos.min(self.end), self.end)?;
                size(avail).ok_or_else(|| YaffleError::eof(self.end, "extern type needs more bytes"))?
            }
        };
        self.take(n)
    }

    // ─── Pointers ────────────────────────────────────────────────────────────

    /// Registers the struct value starting here: every read of one address and type within a
    /// parse gets the same identity. Pair with [`Reader::end_ident`].
    pub fn begin_ident(&mut self, key: &'static str) -> Ident {
        self.shared.borrow_mut().begin_ident(self.region, self.pos, key)
    }
    /// Ends the read of the struct value that started at `at`.
    pub fn end_ident(&mut self, at: usize, key: &'static str) {
        self.shared.borrow_mut().end_ident(self.region, at, key);
    }

    /// Reads a pointer target at an absolute address, preserving identity: the same address
    /// and target type give the same `Rc` within one parse.
    ///
    /// For struct targets, `stub` gives the struct's identity key and a placeholder maker: a
    /// pointer to a struct whose read is still in progress (a cycle) gets a stub with its id.
    pub fn follow<T: 'static>(
        &mut self,
        addr: i128,
        key: &'static str,
        stub: Option<Stub<T>>,
        f: impl FnOnce(&mut Self) -> Result<T>,
    ) -> Result<Rc<T>> {
        if addr < 0 || addr > self.end as i128 {
            return Err(YaffleError::eof(self.pos, format!("pointer target 0x{addr:x} is outside the region")));
        }
        let addr = addr as usize;
        follow_in(self.shared, self.region, addr, key, stub, || {
            let saved = std::mem::replace(&mut self.pos, addr);
            let r = f(self);
            self.pos = saved;
            r
        })
    }
}

/// A struct target's identity key and its placeholder maker (a stub for a cycle).
pub type Stub<T> = (&'static str, fn(Ident) -> T);

/// Reads a target with identity in `shared`: a target already read at `(region, addr)` with type
/// key `key` is shared, a struct whose read is in progress (a cycle) gets a stub (`stub`), and
/// otherwise `f` reads it. Used by readers and by views.
pub fn follow_in<T: 'static>(
    shared: &SharedCell,
    region: u32,
    addr: usize,
    key: &'static str,
    stub: Option<Stub<T>>,
    f: impl FnOnce() -> Result<T>,
) -> Result<Rc<T>> {
    let id = (region, addr, key);
    {
        let sh = shared.borrow();
        if let Some(v) = sh.targets.get(&id) {
            return v.clone().downcast::<T>().map_err(|_| YaffleError::check(addr, "pointer target type mismatch"));
        }
        if let Some((skey, mk)) = stub {
            if let Some(i) = sh.idents.stub(&(region, addr, skey)) {
                return Ok(Rc::new(mk(i)));
            }
        }
    }
    if !shared.borrow_mut().in_progress.insert(id) {
        return Err(YaffleError::check(addr, "cyclic pointer to a value that is not a struct"));
    }
    let r = f().map(Rc::new);
    let mut sh = shared.borrow_mut();
    sh.in_progress.remove(&id);
    if let Ok(rc) = &r {
        sh.targets.insert(id, rc.clone() as Rc<dyn Any>);
        sh.journal.push(id);
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rd(b: &[u8], f: impl FnOnce(&mut Reader) -> Result<()>) {
        let sh = Shared::cell();
        let mut r = Reader::new(b, &sh, false);
        f(&mut r).unwrap();
    }

    #[test]
    fn prims() {
        rd(&[1, 2, 3, 4, 5, 6, 7, 8, 0xff, 0xff, 0xff], |r| {
            assert_eq!(r.u16(Endian::Le)?, 0x0201);
            assert_eq!(r.u16(Endian::Be)?, 0x0304);
            assert_eq!(r.uint(3, Endian::Le)?, 0x070605);
            assert_eq!(r.u8()?, 8);
            assert_eq!(r.sint(3, Endian::Le)?, -1);
            assert_eq!(r.u8().unwrap_err().code, ErrorCode::Eof);
            Ok(())
        });
        rd(&[0, 0x3c, 0, 0, 0x80, 0x3f], |r| {
            assert_eq!(r.f16(Endian::Le)?, 1.0);
            assert_eq!(r.f32(Endian::Le)?, 1.0);
            Ok(())
        });
    }

    #[test]
    fn strict_bool() {
        let sh = Shared::cell();
        let mut r = Reader::new(&[2], &sh, true);
        assert_eq!(r.bool().unwrap_err().code, ErrorCode::Check);
        let sh = Shared::cell();
        let mut r = Reader::new(&[2], &sh, false);
        assert!(r.bool().unwrap());
    }

    #[test]
    fn strings() {
        rd(b"ab\0zzhi\0rest", |r| {
            assert_eq!(r.string(Encoding::Utf8, Endian::Le, StrLen::Count(5))?, "ab");
            assert_eq!(r.string(Encoding::Utf8, Endian::Le, StrLen::Until)?, "hi");
            assert_eq!(r.string(Encoding::Utf8, Endian::Le, StrLen::Rest)?, "rest");
            Ok(())
        });
        rd(&[0x41, 0, 0x42, 0, 0, 0, 0x43, 0], |r| {
            assert_eq!(r.string(Encoding::Utf16, Endian::Le, StrLen::Until)?, "AB");
            assert_eq!(r.pos, 6);
            assert!(r.string(Encoding::Utf16, Endian::Le, StrLen::Until).is_err());
            Ok(())
        });
        rd(&[0xff, 0], |r| {
            assert_eq!(r.string(Encoding::Utf8, Endian::Le, StrLen::Until).unwrap_err().code, ErrorCode::Check);
            Ok(())
        });
    }

    #[test]
    fn windows_and_padding() {
        rd(&[1, 2, 0, 0, 9, 9, 9, 9], |r| {
            let old = r.narrow(4)?;
            assert_eq!(r.u16(Endian::Le)?, 0x0201);
            assert_eq!(r.u32(Endian::Le).unwrap_err().code, ErrorCode::Eof);
            r.close_window(old)?;
            assert_eq!(r.pos, 4);
            r.align(4, r.base, 0, Fill::Byte(0), false)?;
            assert_eq!(r.pos, 4);
            r.pos = 5;
            r.align(4, r.base, 0, Fill::Byte(0), false)?;
            assert_eq!(r.pos, 8);
            Ok(())
        });
        let sh = Shared::cell();
        let mut r = Reader::new(&[1, 0xcc, 0xcd], &sh, true);
        r.pos = 1;
        assert_eq!(r.pad(2, Fill::Byte(0xcc), true).unwrap_err().offset, Some(2));
        let sh = Shared::cell();
        let mut r = Reader::new(&[1, 2, 3], &sh, false);
        r.pos = 3;
        assert_eq!(r.pad_until(0, 2, Fill::Byte(0), false).unwrap_err().code, ErrorCode::Check);
    }

    #[test]
    fn alignment_origins_and_strict_padding() {
        // (pos - origin + offset) % to == 0: at 0x19 with offset 0x19, 2 bytes (0x34 is aligned).
        let b = vec![0u8; 0x40];
        let sh = Shared::cell();
        let mut r = Reader::new(&b, &sh, false);
        r.pos = 0x19;
        r.align(4, 0, 0x19, Fill::Byte(0), false).unwrap();
        assert_eq!(r.pos, 0x1b);
        r.pos = 0x21;
        r.base = 0x20;
        r.align(0x10, 0, 0, Fill::Byte(0), false).unwrap();
        assert_eq!(r.pos, 0x30);
        // A strict padding layer checks even outside strict mode.
        let sh = Shared::cell();
        let mut r = Reader::new(&[1, 2], &sh, false);
        r.pos = 1;
        assert_eq!(r.pad(1, Fill::Byte(0), true).unwrap_err().code, ErrorCode::Check);
    }

    #[test]
    fn identity_and_rollback() {
        let sh = Shared::cell();
        let mut r = Reader::new(&[7, 8], &sh, false);
        let a = r.follow(1, "u8", None, |r| r.u8()).unwrap();
        let b = r.follow(1, "u8", None, |r| r.u8()).unwrap();
        assert!(Rc::ptr_eq(&a, &b));
        assert_eq!(r.pos, 0);
        let snap = r.snapshot();
        let c = r.follow(0, "u8", None, |r| r.u8()).unwrap();
        r.restore(snap);
        let d = r.follow(0, "u8", None, |r| r.u8()).unwrap();
        assert!(!Rc::ptr_eq(&c, &d));
        assert!(r.follow(5, "u8", None, |r| r.u8()).is_err());
        // Cycles are reported.
        let e = r.follow(0, "cyc", None, |r| r.follow(0, "cyc", None, |r| r.u8()).map(|x| *x)).unwrap_err();
        assert_eq!(e.code, ErrorCode::Check);
    }

    #[derive(Default)]
    struct N {
        id: Ident,
        v: u8,
        next: Option<Rc<N>>,
    }

    fn read_n(r: &mut Reader) -> Result<N> {
        let at = r.pos;
        let id = r.begin_ident("N");
        let v = r.u8()?;
        let p = r.u8()? as i128;
        let next = if p == 0 {
            None
        } else {
            Some(r.follow(p, "N", Some(("N", |i| N { id: i, ..Default::default() })), read_n)?)
        };
        r.end_ident(at, "N");
        Ok(N { id, v, next })
    }

    #[test]
    fn identity_of_inline_values_and_cycles() {
        let sh = Shared::cell();
        // A node at 1 pointing at itself.
        let mut r = Reader::new(&[0xff, 10, 1], &sh, false);
        r.pos = 1;
        let n = read_n(&mut r).unwrap();
        let next = n.next.as_ref().unwrap();
        assert!(next.id.stub && next.id.id == n.id.id && n.id.id != 0 && !n.id.stub);
        // Read inline, then through a pointer: one identity.
        let sh = Shared::cell();
        let mut r = Reader::new(&[0xff, 10, 0], &sh, false);
        r.pos = 1;
        let a = read_n(&mut r).unwrap();
        let b = r.follow(1, "N@ptr", Some(("N", |i| N { id: i, ..Default::default() })), read_n).unwrap();
        assert_eq!(a.id.id, b.id.id);
        assert!(!b.id.stub && b.v == 10);
    }

    #[test]
    fn bytes_until_and_rest() {
        rd(&[1, 2, 0, 3, 4], |r| {
            assert_eq!(r.bytes_until(0)?, vec![1, 2]);
            assert_eq!(r.bytes_rest()?, vec![3, 4]);
            assert_eq!(r.bytes_until(0).unwrap_err().code, ErrorCode::Eof);
            Ok(())
        });
    }

    struct Neg;
    impl Codec for Neg {
        fn decode(&self, input: &[u8], _: &CodecCtx) -> std::result::Result<Vec<u8>, String> {
            Ok(input.iter().map(|b| !b).collect())
        }
        fn encode(&self, input: &[u8], _: &CodecCtx) -> std::result::Result<Vec<u8>, String> {
            Ok(input.iter().map(|b| !b).collect())
        }
    }

    #[test]
    fn decoded_regions_are_keyed_and_kept_in_views() {
        let b = [0xfeu8, 0xfd, 0xfc];
        let sh = Shared::cell();
        let mut r = Reader::new(&b, &sh, false);
        let (sp, enc) = r.decode(&Neg, false, &[], None, None).unwrap();
        assert_eq!(sp.bytes().unwrap(), &[1, 2, 3]);
        assert_eq!(enc, &b);
        assert_eq!(r.pos, 3);
        let region = sp.region;
        r.pos = 0;
        let (sp2, _) = r.decode(&Neg, false, &[], None, None).unwrap();
        // The same key gives the same region id (and identity scope).
        assert_eq!(sp2.region, region);
        assert!(!Rc::ptr_eq(&sp, &sp2));
        // Views keep decoded regions (decoded once) and decode ranged ones lazily.
        let sh = RefCell::new(Shared::for_views());
        let mut r = Reader::new(&b, &sh, false);
        let (a, _) = r.decode(&Neg, false, &[], None, None).unwrap();
        r.pos = 0;
        let (a2, _) = r.decode(&Neg, false, &[], None, None).unwrap();
        assert!(Rc::ptr_eq(&a, &a2));
        r.pos = 0;
        r.end = 2;
        let f: RangedFn = Rc::new(|b: &[u8], _| Ok(b.iter().map(|x| !x).collect()));
        r.region = 5;
        let (l, _) = r.decode(&Neg, false, &[], None, Some(f)).unwrap();
        assert!(l.data.is_lazy());
        assert_eq!(l.bytes().unwrap(), &[1, 2]);
        let mut sub = r.sub_space(&l);
        assert_eq!(sub.u16(Endian::Le).unwrap(), 0x0201);
    }
}
