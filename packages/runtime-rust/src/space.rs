//! Byte spaces: the bytes a reader reads. A space is plain bytes, or a buffer filled lazily chunk
//! by chunk on first access:
//!
//! - a file read block by block (`Source`);
//! - a `@ranged` codec region, decoded slice by slice;
//! - a virtual stream (`from arr[*].data`), decoded piece by piece, with the piece sizes known
//!   from size fields without decoding.
//!
//! Readers ask a space for byte ranges (`Src::get`); only the chunks a range touches are filled.

use std::cell::Cell;
use std::fmt;
use std::rc::Rc;

use super::error::{ErrorCode, Result, YaffleError};

/// Fills chunk `index`, which starts at `start`, into `out` (exactly the chunk's length).
pub type Filler = Box<dyn Fn(usize, usize, &mut [u8]) -> Result<()>>;

const EMPTY: u8 = 0;
const FILLING: u8 = 1;
const FILLED: u8 = 2;

/// A fixed-length buffer whose chunks are filled on first access.
///
/// Soundness: the buffer is allocated once and never moves or grows. Shared slices are only
/// ever handed out for chunks that are filled, and a filled chunk is never written again through
/// `&self`. A chunk is written (once, by the filler) only while it is unfilled, so no shared
/// slice can overlap it. Writes through `&mut self` (patches) can't overlap live slices either,
/// since slices borrow `&self`.
pub struct LazyBuf {
    ptr: *mut u8,
    len: usize,
    cap: usize,
    /// Chunk starts, ascending; the first is 0. Chunk `i` is `[starts[i], starts[i + 1])` (or up
    /// to `len` for the last one).
    starts: Vec<usize>,
    state: Vec<Cell<u8>>,
    filler: Filler,
}

impl LazyBuf {
    /// A buffer of `len` bytes split into chunks starting at `starts` (sorted, first 0).
    pub fn new(len: usize, mut starts: Vec<usize>, filler: Filler) -> Self {
        starts.retain(|&s| s < len);
        if starts.first() != Some(&0) {
            starts.insert(0, 0);
        }
        starts.dedup();
        let mut v = std::mem::ManuallyDrop::new(vec![0u8; len]);
        let state = (0..starts.len()).map(|_| Cell::new(EMPTY)).collect();
        LazyBuf { ptr: v.as_mut_ptr(), len, cap: v.capacity(), starts, state, filler }
    }

    /// A buffer of `len` bytes in fixed-size blocks.
    pub fn blocks(len: usize, block: usize, filler: Filler) -> Self {
        let block = block.max(1);
        let starts = (0..len.div_ceil(block)).map(|i| i * block).collect();
        Self::new(len, starts, filler)
    }

    /// A buffer over a random-access source, read in blocks of `block` bytes.
    pub fn from_source(src: Box<dyn Source>, block: usize) -> Self {
        let len = src.size();
        Self::blocks(
            len,
            block,
            Box::new(move |_, start, out| {
                src.read_at(start, out).map_err(|m| YaffleError::new(ErrorCode::Eof, format!("source read failed: {m}")))
            }),
        )
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.len
    }
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
    fn filled_chunks(&self) -> usize {
        self.state.iter().filter(|s| s.get() == FILLED).count()
    }
    /// The chunk boundaries `[start, end)` of chunk `i`.
    fn chunk(&self, i: usize) -> (usize, usize) {
        let s = self.starts[i];
        let e = self.starts.get(i + 1).copied().unwrap_or(self.len);
        (s, e)
    }

    fn ensure_chunk(&self, i: usize) -> Result<()> {
        match self.state[i].get() {
            FILLED => Ok(()),
            FILLING => Err(YaffleError::new(ErrorCode::Range, "a lazily filled chunk was read while being filled")),
            _ => {
                let (s, e) = self.chunk(i);
                self.state[i].set(FILLING);
                // SAFETY: [s, e) is inside the allocation, and the chunk is unfilled, so no shared
                // slice overlaps it (slices are only created for filled chunks).
                let out = unsafe { std::slice::from_raw_parts_mut(self.ptr.add(s), e - s) };
                match (self.filler)(i, s, out) {
                    Ok(()) => {
                        self.state[i].set(FILLED);
                        Ok(())
                    }
                    Err(err) => {
                        self.state[i].set(EMPTY);
                        Err(err)
                    }
                }
            }
        }
    }

    /// Makes sure the bytes `[a, b)` are filled.
    pub fn ensure(&self, a: usize, b: usize) -> Result<()> {
        if a >= b {
            return Ok(());
        }
        let mut i = self.starts.partition_point(|&s| s <= a).saturating_sub(1);
        while i < self.starts.len() && self.starts[i] < b {
            self.ensure_chunk(i)?;
            i += 1;
        }
        Ok(())
    }

    /// The bytes `[a, b)`, filling the chunks they touch.
    pub fn get(&self, a: usize, b: usize) -> Result<&[u8]> {
        if a > b || b > self.len {
            return Err(YaffleError::eof(a.min(self.len), format!("bytes 0x{a:x}..0x{b:x} are outside 0..0x{:x}", self.len)));
        }
        self.ensure(a, b)?;
        // SAFETY: every chunk overlapping [a, b) is filled and is never written through `&self`
        // again; the slice borrows `self`.
        Ok(unsafe { std::slice::from_raw_parts(self.ptr.add(a), b - a) })
    }

    /// Overwrites `bytes` at `at` (filling the chunks first).
    pub fn write(&mut self, at: usize, bytes: &[u8]) -> Result<()> {
        let end = at.checked_add(bytes.len()).filter(|&e| e <= self.len);
        let end = end.ok_or_else(|| YaffleError::new(ErrorCode::Range, "write outside the buffer"))?;
        self.ensure(at, end)?;
        // SAFETY: `&mut self` excludes live slices; the range is inside the allocation.
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), self.ptr.add(at), bytes.len()) };
        Ok(())
    }

    /// Every byte (fills every chunk).
    pub fn to_vec(&self) -> Result<Vec<u8>> {
        Ok(self.get(0, self.len)?.to_vec())
    }
}

impl Drop for LazyBuf {
    fn drop(&mut self) {
        // SAFETY: ptr/len/cap come from the vector made in `new`, which was never dropped.
        unsafe { drop(Vec::from_raw_parts(self.ptr, self.len, self.cap)) };
    }
}

impl fmt::Debug for LazyBuf {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "LazyBuf({} bytes, {}/{} chunks filled)", self.len, self.filled_chunks(), self.starts.len())
    }
}

/// A random-access byte source (a file, a memory map, …) for views over data that is not in
/// memory. Reads must fill `out` completely.
pub trait Source {
    fn size(&self) -> usize;
    fn read_at(&self, offset: usize, out: &mut [u8]) -> std::result::Result<(), String>;
}

/// A file as a `Source`.
pub struct FileSource {
    file: std::cell::RefCell<std::fs::File>,
    size: usize,
}

impl FileSource {
    pub fn open(path: impl AsRef<std::path::Path>) -> std::io::Result<Self> {
        let file = std::fs::File::open(path)?;
        let size = file.metadata()?.len() as usize;
        Ok(FileSource { file: std::cell::RefCell::new(file), size })
    }
}

impl Source for FileSource {
    fn size(&self) -> usize {
        self.size
    }
    fn read_at(&self, offset: usize, out: &mut [u8]) -> std::result::Result<(), String> {
        use std::io::{Read, Seek, SeekFrom};
        let mut f = self.file.borrow_mut();
        f.seek(SeekFrom::Start(offset as u64)).map_err(|e| e.to_string())?;
        f.read_exact(out).map_err(|e| e.to_string())
    }
}

/// Bytes a reader reads: a slice, or a lazily filled buffer.
#[derive(Clone, Copy)]
pub enum Src<'a> {
    Bytes(&'a [u8]),
    Lazy(&'a LazyBuf),
}

impl<'a> Src<'a> {
    #[inline]
    pub fn len(&self) -> usize {
        match self {
            Src::Bytes(b) => b.len(),
            Src::Lazy(l) => l.len(),
        }
    }
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    /// The bytes `[a, b)`.
    #[inline]
    pub fn get(&self, a: usize, b: usize) -> Result<&'a [u8]> {
        match self {
            Src::Bytes(s) => s
                .get(a..b)
                .ok_or_else(|| YaffleError::eof(a.min(s.len()), format!("bytes 0x{a:x}..0x{b:x} are outside 0..0x{:x}", s.len()))),
            Src::Lazy(l) => l.get(a, b),
        }
    }
    /// The position of the first unit-aligned unit at or after `from` (and before `end`) that
    /// `hit` accepts, scanning a lazy buffer in growing windows.
    pub fn find(&self, from: usize, end: usize, unit: usize, hit: impl Fn(&[u8]) -> bool) -> Result<Option<usize>> {
        let unit = unit.max(1);
        let usable = end.saturating_sub(from) / unit * unit;
        let search = |bytes: &[u8]| bytes.chunks_exact(unit).position(&hit).map(|i| from + i * unit);
        match self {
            Src::Bytes(_) => Ok(search(self.get(from, from + usable)?)),
            Src::Lazy(_) => {
                let mut w = 256usize.max(unit);
                loop {
                    let n = (w / unit * unit).min(usable);
                    if let Some(p) = search(self.get(from, from + n)?) {
                        return Ok(Some(p));
                    }
                    if n >= usable {
                        return Ok(None);
                    }
                    w = w.saturating_mul(4);
                }
            }
        }
    }
}

/// The contents of a space.
pub enum SpaceData {
    Bytes(Vec<u8>),
    Lazy(LazyBuf),
}

impl SpaceData {
    #[inline]
    pub fn src(&self) -> Src<'_> {
        match self {
            SpaceData::Bytes(b) => Src::Bytes(b),
            SpaceData::Lazy(l) => Src::Lazy(l),
        }
    }
    pub fn len(&self) -> usize {
        self.src().len()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
    /// Every byte (fills a lazy buffer completely).
    pub fn all(&self) -> Result<&[u8]> {
        match self {
            SpaceData::Bytes(b) => Ok(b),
            SpaceData::Lazy(l) => l.get(0, l.len()),
        }
    }
    /// Whether this is a lazily filled buffer.
    pub fn is_lazy(&self) -> bool {
        matches!(self, SpaceData::Lazy(_))
    }
    /// Turns a lazy buffer into plain bytes (reads everything).
    pub fn make_plain(&mut self) -> Result<()> {
        if let SpaceData::Lazy(l) = self {
            let v = l.to_vec()?;
            *self = SpaceData::Bytes(v);
        }
        Ok(())
    }
}

impl fmt::Debug for SpaceData {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SpaceData::Bytes(b) => write!(f, "Bytes({} bytes)", b.len()),
            SpaceData::Lazy(l) => l.fmt(f),
        }
    }
}

/// A decoded codec region or a virtual stream: its own byte space with its own region id (the
/// scope of values read in it).
#[derive(Debug)]
pub struct Space {
    pub region: u32,
    pub data: SpaceData,
    /// For codec regions: the length of the encoded bytes the region was decoded from.
    pub encoded_len: usize,
}

impl Space {
    pub fn new(region: u32, data: SpaceData, encoded_len: usize) -> Rc<Space> {
        Rc::new(Space { region, data, encoded_len })
    }
    #[inline]
    pub fn src(&self) -> Src<'_> {
        self.data.src()
    }
    pub fn len(&self) -> usize {
        self.data.len()
    }
    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }
    /// Every byte (decodes a lazy space completely).
    pub fn bytes(&self) -> Result<&[u8]> {
        self.data.all()
    }
}

/// Decodes one slice of a `@ranged` codec region: `(encoded slice, its position in the region)`.
pub type RangedFn = Rc<dyn Fn(&[u8], u64) -> std::result::Result<Vec<u8>, String>>;

/// The block size of lazily decoded `@ranged` regions.
pub const RANGED_BLOCK: usize = 16 * 1024;

/// A lazily decoded `@ranged` region over its encoded bytes: blocks are decoded on first access
/// with their position in the region. Ranged codecs keep lengths (byte for byte).
pub fn ranged_space(region: u32, encoded: Vec<u8>, f: RangedFn, at: usize) -> Rc<Space> {
    let len = encoded.len();
    let filler: Filler = Box::new(move |_, start, out| {
        let end = start + out.len();
        let dec = f(&encoded[start..end], start as u64).map_err(|m| YaffleError::at(ErrorCode::Codec, at + start, m))?;
        if dec.len() != out.len() {
            return Err(YaffleError::at(
                ErrorCode::Codec,
                at + start,
                format!("ranged codec decoded {} bytes from {}: ranged codecs must keep lengths", dec.len(), out.len()),
            ));
        }
        out.copy_from_slice(&dec);
        Ok(())
    });
    Space::new(region, SpaceData::Lazy(LazyBuf::blocks(len, RANGED_BLOCK, filler)), len)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn counting(len: usize, block: usize, log: Rc<RefCell<Vec<usize>>>) -> LazyBuf {
        LazyBuf::blocks(
            len,
            block,
            Box::new(move |i, start, out| {
                log.borrow_mut().push(i);
                for (k, b) in out.iter_mut().enumerate() {
                    *b = (start + k) as u8;
                }
                Ok(())
            }),
        )
    }

    #[test]
    fn fills_only_touched_chunks() {
        let log = Rc::new(RefCell::new(Vec::new()));
        let b = counting(100, 10, log.clone());
        assert_eq!(b.starts.len(), 10);
        assert_eq!(b.get(12, 15).unwrap(), &[12, 13, 14]);
        assert_eq!(*log.borrow(), vec![1]);
        assert_eq!(b.get(19, 21).unwrap(), &[19, 20]);
        assert_eq!(*log.borrow(), vec![1, 2]);
        assert_eq!(b.get(0, 0).unwrap(), &[] as &[u8]);
        assert_eq!(b.filled_chunks(), 2);
        assert_eq!(b.get(95, 101).unwrap_err().code, ErrorCode::Eof);
        let all = b.to_vec().unwrap();
        assert_eq!(all.len(), 100);
        assert_eq!(all[99], 99);
        assert_eq!(b.filled_chunks(), 10);
    }

    #[test]
    fn uneven_chunks_and_errors() {
        let b = LazyBuf::new(
            10,
            vec![0, 3, 7],
            Box::new(|i, _, out| {
                if i == 2 {
                    return Err(YaffleError::codec("bad piece"));
                }
                out.fill(i as u8 + 1);
                Ok(())
            }),
        );
        assert_eq!(b.get(2, 5).unwrap(), &[1, 2, 2]);
        assert_eq!(b.get(6, 8).unwrap_err().code, ErrorCode::Codec);
        // A failed chunk can be retried (it fails again).
        assert!(b.get(7, 8).is_err());
        assert_eq!(b.filled_chunks(), 2);
    }

    #[test]
    fn writes_and_finds() {
        let mut b = LazyBuf::blocks(
            1000,
            64,
            Box::new(|_, start, out| {
                for (k, x) in out.iter_mut().enumerate() {
                    *x = ((start + k) % 200) as u8;
                }
                Ok(())
            }),
        );
        b.write(500, &[0xff, 0xff]).unwrap();
        assert_eq!(b.get(499, 502).unwrap(), &[99, 0xff, 0xff]);
        let src = Src::Lazy(&b);
        assert_eq!(src.find(0, 1000, 1, |u| u[0] == 0xff).unwrap(), Some(500));
        assert_eq!(src.find(0, 1000, 2, |u| u == [0xff, 0xff]).unwrap(), Some(500));
        assert_eq!(src.find(0, 400, 1, |u| u[0] == 0xff).unwrap(), None);
        let plain = vec![1u8, 0, 2, 0, 0];
        assert_eq!(Src::Bytes(&plain).find(0, 5, 2, |u| u == [0, 0]).unwrap(), None);
        assert_eq!(Src::Bytes(&plain).find(1, 5, 2, |u| u == [0, 0]).unwrap(), Some(3));
    }

    #[test]
    fn ranged_regions_decode_blocks() {
        let enc: Vec<u8> = (0..(RANGED_BLOCK * 3) as u32).map(|i| i as u8 ^ 0x5a).collect();
        let calls = Rc::new(Cell::new(0));
        let c2 = calls.clone();
        let f: RangedFn = Rc::new(move |b: &[u8], _pos: u64| {
            c2.set(c2.get() + 1);
            Ok(b.iter().map(|x| x ^ 0x5a).collect())
        });
        let sp = ranged_space(7, enc, f, 0);
        assert_eq!(sp.region, 7);
        assert_eq!(sp.src().get(RANGED_BLOCK + 1, RANGED_BLOCK + 3).unwrap(), &[1, 2]);
        assert_eq!(calls.get(), 1);
        assert_eq!(sp.bytes().unwrap().len(), RANGED_BLOCK * 3);
        assert_eq!(calls.get(), 3);
    }
}
