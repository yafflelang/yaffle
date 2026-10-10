//! Small helpers used by generated code.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::OnceLock;

use super::error::{ErrorCode, Result, YaffleError};
use super::regex::Regex;

/// A field that must be present (a guarded reference to a conditional field, or a required
/// input inside a taken branch).
#[inline]
pub fn present<'v, T>(v: Option<&'v T>, name: &str) -> Result<&'v T> {
    v.ok_or_else(|| YaffleError::input(format!("missing field {name}")).in_field(name))
}

/// Moves a conditional field's value out once its branch is known to be taken.
#[inline]
pub fn take<T>(v: Option<T>, name: &str) -> Result<T> {
    v.ok_or_else(|| YaffleError::new(ErrorCode::Check, format!("field {name} was not read")))
}

/// `a[i]` with a range check.
#[inline]
pub fn index<T>(v: &[T], i: i128) -> Result<&T> {
    usize::try_from(i)
        .ok()
        .and_then(|i| v.get(i))
        .ok_or_else(|| YaffleError::range(format!("index {i} out of range 0..{}", v.len())))
}

/// A cached regex full match (`value in /pattern/`). A pattern that doesn't compile matches
/// nothing.
pub fn regex_match(cell: &'static OnceLock<Regex>, pattern: &str, s: &str) -> bool {
    cell.get_or_init(|| Regex::new(pattern).unwrap_or_else(|_| Regex::new("[^\\s\\S]").expect("regex")))
        .is_full_match(s)
}

/// A float equality for transform round-trip checks: equal, both NaN, or within the storage's
/// rounding (relative to f32 precision when `single`).
pub fn float_close(a: f64, b: f64, single: bool) -> bool {
    if a == b || (a.is_nan() && b.is_nan()) {
        return true;
    }
    let tol = if single { 1e-6 } else { 1e-12 };
    (a - b).abs() <= tol * a.abs().max(b.abs()).max(1e-30)
}

/// `CHECK` error for a failed check at `offset`.
#[inline]
pub fn check_failed(offset: usize, message: &str) -> YaffleError {
    YaffleError::check(offset, format!("check failed: {message}"))
}

/// `UNION` error listing each variant's error.
pub fn union_error(offset: usize, variants: Vec<(String, YaffleError)>) -> YaffleError {
    YaffleError { variants, ..YaffleError::at(ErrorCode::Union, offset, "no union variant matched") }
}

/// Values the writer synthesizes while serializing (stream pieces, generated stream elements),
/// kept alive for the whole write so generated code can borrow them like the input.
#[derive(Default)]
pub struct Arena {
    items: std::cell::RefCell<Vec<Box<dyn std::any::Any>>>,
}

impl Arena {
    pub fn new() -> Self {
        Self::default()
    }
    /// Moves a value into the arena and borrows it for the arena's lifetime.
    pub fn alloc<T: 'static>(&self, v: T) -> &T {
        let b = Box::new(v);
        let p: *const T = &*b;
        self.items.borrow_mut().push(b);
        // SAFETY: the box is never removed or moved out until the arena is dropped, and its heap
        // allocation doesn't move when the vector grows; the reference can't outlive `&self`.
        unsafe { &*p }
    }
}

/// The identity of a struct value that pointers can share: values with the same non-zero `id`
/// are one object (a parse gives the same id to every read of one address and type; `from_json`
/// to every `$ref` to one JSON path). A `stub` is the placeholder for an object that contains
/// itself (a cycle): it has default contents and is printed and written as a reference to the
/// object. Identity never affects equality.
#[derive(Clone, Copy, Default)]
pub struct Ident {
    pub id: u64,
    pub stub: bool,
}

impl Ident {
    /// The writer's sharing key of a pointer target: its identity, else its `Rc` address.
    pub fn key(self, addr: usize) -> usize {
        if self.id != 0 {
            (self.id as usize) | (1usize << (usize::BITS - 1))
        } else {
            addr
        }
    }
}

impl PartialEq for Ident {
    fn eq(&self, _: &Self) -> bool {
        true
    }
}

impl std::fmt::Debug for Ident {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.stub {
            write!(f, "Ident(stub {})", self.id)
        } else {
            write!(f, "Ident({})", self.id)
        }
    }
}

/// Identities of struct values by position (an address, or a JSON path), with how many reads of
/// each are in progress (a pointer reaching a value being read is a cycle).
pub(crate) struct IdentMap<K> {
    entries: HashMap<K, (u64, u32)>,
    last: u64,
}

impl<K> Default for IdentMap<K> {
    fn default() -> Self {
        IdentMap { entries: HashMap::new(), last: 0 }
    }
}

impl<K: Hash + Eq> IdentMap<K> {
    /// Starts reading the value at `k`: its identity, and whether `k` is new.
    pub(crate) fn begin(&mut self, k: K) -> (Ident, bool) {
        let mut new = false;
        let e = self.entries.entry(k).or_insert_with(|| {
            new = true;
            self.last += 1;
            (self.last, 0)
        });
        e.1 += 1;
        (Ident { id: e.0, stub: false }, new)
    }
    /// Ends a read of the value at `k`.
    pub(crate) fn end(&mut self, k: &K) {
        if let Some(e) = self.entries.get_mut(k) {
            e.1 = e.1.saturating_sub(1);
        }
    }
    /// The placeholder of the value at `k` if a read of it is in progress.
    pub(crate) fn stub(&self, k: &K) -> Option<Ident> {
        self.entries.get(k).filter(|e| e.1 > 0).map(|e| Ident { id: e.0, stub: true })
    }
    pub(crate) fn remove(&mut self, k: &K) {
        self.entries.remove(k);
    }
}

/// A one-way transform (`as` without an inverse): the transformed value plus the raw value it
/// was read from. Writers use `raw`; JSON shows the raw value too, so it stays lossless.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct OneWay<V, R> {
    pub value: V,
    pub raw: R,
}

fn empty_aggregate() -> YaffleError {
    YaffleError::range("min/max of an empty array")
}

/// `min(array)` / `max(array)` over integers; an empty array is a `RANGE` error.
pub fn agg_int(it: impl Iterator<Item = i128>, max: bool) -> Result<i128> {
    let r = if max { it.max() } else { it.min() };
    r.ok_or_else(empty_aggregate)
}

/// `min(array)` / `max(array)` over floats; an empty array is a `RANGE` error.
pub fn agg_f64(it: impl Iterator<Item = f64>, max: bool) -> Result<f64> {
    it.reduce(|a, x| if max { a.max(x) } else { a.min(x) }).ok_or_else(empty_aggregate)
}

/// `sum(array)` of integers, exact (overflowing `i128` is `RANGE`).
pub fn sum_int(mut it: impl Iterator<Item = i128>) -> Result<i128> {
    it.try_fold(0i128, |s, x| s.checked_add(x)).ok_or_else(|| YaffleError::range("integer overflow"))
}

/// Splits a stream's bytes into pieces of the given sizes (`@split` by sizes).
pub fn split_sizes(data: &[u8], sizes: &[usize]) -> Result<Vec<Vec<u8>>> {
    let total: usize = sizes.iter().sum();
    if total != data.len() {
        return Err(YaffleError::derive(format!(
            "piece sizes add up to {total}, but the stream is {} bytes",
            data.len()
        )));
    }
    let mut rest = data;
    Ok(sizes
        .iter()
        .map(|&s| {
            let (piece, tail) = rest.split_at(s);
            rest = tail;
            piece.to_vec()
        })
        .collect())
}

/// Splits a stream's bytes by the `@split(fit)` policy: piece `k` is the longest prefix
/// of the remaining content whose encoded element (`size(k, piece)` bytes), placed at
/// `bounds(k).0`, ends at or before the next element's offset `bounds(k).1`. Encoded sizes are
/// assumed to grow with the piece (a binary search). No content gives no pieces; a piece that
/// can't take even one byte is an `OVERLAP` error.
pub fn split_fit(
    data: &[u8],
    mut bounds: impl FnMut(usize) -> Result<(u64, u64)>,
    mut size: impl FnMut(usize, &[u8]) -> Result<usize>,
) -> Result<Vec<Vec<u8>>> {
    let mut out = Vec::new();
    let mut rest = data;
    while !rest.is_empty() {
        let k = out.len();
        let (start, limit) = bounds(k)?;
        let room = limit.saturating_sub(start);
        let mut fits = |n: usize| -> Result<bool> { Ok(size(k, &rest[..n])? as u64 <= room) };
        let best = if fits(rest.len())? {
            rest.len()
        } else {
            // Invariant: `lo` fits (or is 0), `hi` doesn't.
            let (mut lo, mut hi) = (0usize, rest.len());
            while hi - lo > 1 {
                let mid = lo + (hi - lo) / 2;
                if fits(mid)? {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            lo
        };
        if best == 0 {
            return Err(YaffleError::new(ErrorCode::Overlap, format!("stream piece {k} doesn't fit in {room} bytes")));
        }
        out.push(rest[..best].to_vec());
        rest = &rest[best..];
    }
    Ok(out)
}

/// One `from raw[start..end]` field's encoding, for [`assemble_slices`].
pub struct SlicePart<'b> {
    /// Field name (error messages).
    pub name: &'static str,
    pub start: i128,
    /// Slice end (exclusive); `None`: to the end of the stream.
    pub end: Option<i128>,
    pub bytes: &'b [u8],
}

/// Write side of stream slices: the sliced bytes are a zero-filled buffer of `length` bytes
/// (`None`: the largest slice end) with every slice field's encoding written at its start. An
/// encoding longer than its slice, or overlapping slices whose bytes differ, is a `DERIVE` error.
pub fn assemble_slices(length: Option<usize>, parts: &[SlicePart]) -> Result<Vec<u8>> {
    let mut size = 0usize;
    let mut starts = Vec::with_capacity(parts.len());
    for p in parts {
        let start = usize::try_from(p.start)
            .map_err(|_| YaffleError::range(format!("slice start {} of {} is invalid", p.start, p.name)))?;
        let mut end = start + p.bytes.len();
        if let Some(e) = p.end {
            let e = usize::try_from(e)
                .ok()
                .filter(|&e| e >= start)
                .ok_or_else(|| YaffleError::range(format!("slice [{}, {e}) of {} is invalid", p.start, p.name)))?;
            if p.bytes.len() > e - start {
                return Err(YaffleError::derive(format!(
                    "{} encodes to {} bytes, its slice [{start}, {e}) has {}",
                    p.name,
                    p.bytes.len(),
                    e - start
                )));
            }
            end = e;
        }
        size = size.max(end);
        starts.push(start);
    }
    if let Some(n) = length {
        if size > n {
            return Err(YaffleError::derive(format!("the slices need {size} bytes, the sliced field has {n}")));
        }
        size = n;
    }
    let mut out = vec![0u8; size];
    let mut owner: Vec<Option<usize>> = vec![None; size];
    for (k, (p, &start)) in parts.iter().zip(&starts).enumerate() {
        for (at, &b) in (start..).zip(p.bytes) {
            if let Some(prev) = owner[at] {
                if out[at] != b {
                    return Err(YaffleError::derive(format!(
                        "{} and {} overlap at byte {at} and disagree",
                        parts[prev].name, p.name
                    )));
                }
            }
            out[at] = b;
            owner[at] = Some(k);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helpers() {
        let v = vec![10, 20];
        assert_eq!(*index(&v, 1).unwrap(), 20);
        assert_eq!(index(&v, 2).unwrap_err().code, ErrorCode::Range);
        assert_eq!(index(&v, -1).unwrap_err().code, ErrorCode::Range);
        assert_eq!(present::<u8>(None, "x").unwrap_err().path_string(), "x");
        static RE: OnceLock<Regex> = OnceLock::new();
        assert!(regex_match(&RE, "a+", "aaa"));
        assert!(!regex_match(&RE, "a+", "b"));
        assert!(float_close(1.0, 1.0 + 1e-9, true));
        assert!(!float_close(1.0, 1.1, true));
        assert_eq!(agg_int([3, 1, 2].into_iter(), true).unwrap(), 3);
        assert_eq!(agg_f64([3.0, 1.0].into_iter(), false).unwrap(), 1.0);
        assert_eq!(agg_int(std::iter::empty(), false).unwrap_err().code, ErrorCode::Range);
        assert_eq!(sum_int([i128::MAX, 1].into_iter()).unwrap_err().code, ErrorCode::Range);
    }

    #[test]
    fn identities() {
        let mut m: IdentMap<u32> = IdentMap::default();
        let (a, new) = m.begin(7);
        assert!(new && a.id == 1 && !a.stub);
        assert_eq!(m.stub(&7).map(|i| (i.id, i.stub)), Some((1, true)));
        let (b, new) = m.begin(7);
        assert!(!new && b.id == 1);
        m.end(&7);
        m.end(&7);
        assert!(m.stub(&7).is_none());
        assert_eq!(m.begin(8).0.id, 2);
    }

    #[test]
    fn fit_splitting() {
        // Blocks of 4 bytes, an element is a 1-byte header plus the piece.
        let bounds = |k: usize| Ok(((k * 4) as u64, ((k + 1) * 4) as u64));
        let size = |_: usize, p: &[u8]| Ok(1 + p.len());
        let r = split_fit(b"abcdefg", bounds, size).unwrap();
        assert_eq!(r, vec![b"abc".to_vec(), b"def".to_vec(), b"g".to_vec()]);
        assert!(split_fit(b"", bounds, size).unwrap().is_empty());
        let big = |_: usize, p: &[u8]| Ok(5 + p.len());
        assert_eq!(split_fit(b"a", bounds, big).unwrap_err().code, ErrorCode::Overlap);
        assert_eq!(split_sizes(b"abc", &[1, 2]).unwrap(), vec![b"a".to_vec(), b"bc".to_vec()]);
        assert_eq!(split_sizes(b"abc", &[1]).unwrap_err().code, ErrorCode::Derive);
    }

    #[test]
    fn slice_assembly() {
        let p = |name, start, end, bytes| SlicePart { name, start, end, bytes };
        let out = assemble_slices(Some(6), &[p("a", 0, Some(2), &[1, 2][..]), p("b", 4, Some(6), &[3][..])]).unwrap();
        assert_eq!(out, vec![1, 2, 0, 0, 3, 0]);
        // Without a length: the largest slice end.
        assert_eq!(assemble_slices(None, &[p("a", 1, Some(3), &[1][..])]).unwrap(), vec![0, 1, 0]);
        assert_eq!(assemble_slices(None, &[p("a", 1, None, &[1, 2][..])]).unwrap(), vec![0, 1, 2]);
        // Agreeing overlaps are fine; disagreeing ones and overflows are DERIVE.
        assert!(assemble_slices(None, &[p("a", 0, Some(2), &[1, 2][..]), p("b", 1, Some(2), &[2][..])]).is_ok());
        let e = assemble_slices(None, &[p("a", 0, Some(2), &[1, 2][..]), p("b", 1, Some(2), &[9][..])]).unwrap_err();
        assert_eq!(e.code, ErrorCode::Derive);
        assert_eq!(assemble_slices(None, &[p("a", 0, Some(1), &[1, 2][..])]).unwrap_err().code, ErrorCode::Derive);
        assert_eq!(assemble_slices(Some(1), &[p("a", 0, Some(2), &[1, 2][..])]).unwrap_err().code, ErrorCode::Derive);
        assert_eq!(assemble_slices(None, &[p("a", -1, None, &[][..])]).unwrap_err().code, ErrorCode::Range);
    }

    #[test]
    fn arena_keeps_values() {
        let a = Arena::new();
        let x = a.alloc(vec![1u8, 2, 3]);
        let y = a.alloc(String::from("s"));
        for i in 0..100 {
            a.alloc(i);
        }
        assert_eq!(x, &vec![1, 2, 3]);
        assert_eq!(y, "s");
    }
}
