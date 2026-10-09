//! Errors: `YaffleError` with a code, a path from the root and an absolute offset
//! (docs/CONFORMANCE.md §4).

use std::fmt;

/// Error codes shared by every yaffle backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorCode {
    /// Not enough bytes.
    Eof,
    /// A check failed (constant, `in`, `where`, regex, strict padding, bool, enum, encoding, switch).
    Check,
    /// An integer out of range for its destination, division by zero, a negative length.
    Range,
    /// No union variant matched.
    Union,
    /// A codec failed.
    Codec,
    /// Invalid input value on write.
    Input,
    /// A derived value contradicts the data.
    Derive,
    /// A `@ref` pointer has no equal placed value.
    Ref,
    /// Fixed placements overlap.
    Overlap,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::Eof => "EOF",
            ErrorCode::Check => "CHECK",
            ErrorCode::Range => "RANGE",
            ErrorCode::Union => "UNION",
            ErrorCode::Codec => "CODEC",
            ErrorCode::Input => "INPUT",
            ErrorCode::Derive => "DERIVE",
            ErrorCode::Ref => "REF",
            ErrorCode::Overlap => "OVERLAP",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One step of an error path: a field name or an array index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathSeg {
    Field(String),
    Index(usize),
}

impl fmt::Display for PathSeg {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PathSeg::Field(n) => f.write_str(n),
            PathSeg::Index(i) => write!(f, "{i}"),
        }
    }
}

/// An error from reading or writing.
#[derive(Debug, Clone)]
pub struct YaffleError {
    pub code: ErrorCode,
    /// Field names and indices from the root.
    pub path: Vec<PathSeg>,
    /// Absolute offset in the input (read errors), or `None` (write errors: `-1` in JSON).
    pub offset: Option<u64>,
    pub message: String,
    /// For `UNION` errors: each variant's error.
    pub variants: Vec<(String, YaffleError)>,
}

pub type Result<T> = std::result::Result<T, YaffleError>;

impl YaffleError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        YaffleError { code, path: Vec::new(), offset: None, message: message.into(), variants: Vec::new() }
    }
    pub fn at(code: ErrorCode, offset: usize, message: impl Into<String>) -> Self {
        YaffleError { offset: Some(offset as u64), ..Self::new(code, message) }
    }
    pub fn eof(offset: usize, message: impl Into<String>) -> Self {
        Self::at(ErrorCode::Eof, offset, message)
    }
    pub fn check(offset: usize, message: impl Into<String>) -> Self {
        Self::at(ErrorCode::Check, offset, message)
    }
    pub fn range(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Range, message)
    }
    pub fn input(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Input, message)
    }
    pub fn derive(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Derive, message)
    }
    pub fn codec(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Codec, message)
    }

    /// The offset as in canonical error objects: absolute, or -1 on write.
    pub fn offset_i64(&self) -> i64 {
        self.offset.map_or(-1, |o| o as i64)
    }

    /// Prepends a field name to the path.
    pub fn in_field(mut self, name: &str) -> Self {
        self.path.insert(0, PathSeg::Field(name.to_string()));
        self
    }
    /// Prepends an array index to the path.
    pub fn in_index(mut self, index: usize) -> Self {
        self.path.insert(0, PathSeg::Index(index));
        self
    }
    /// Sets the offset if the error has none yet.
    pub fn or_offset(mut self, offset: usize) -> Self {
        if self.offset.is_none() {
            self.offset = Some(offset as u64);
        }
        self
    }
    /// Replaces an empty path (write errors raised by helpers that don't know where they are).
    pub fn or_path(mut self, path: &[PathSeg]) -> Self {
        if self.path.is_empty() {
            self.path = path.to_vec();
        }
        self
    }

    /// The path as dotted text (`entries.2.count`).
    pub fn path_string(&self) -> String {
        self.path.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(".")
    }
}

impl fmt::Display for YaffleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.code)?;
        if !self.path.is_empty() {
            write!(f, " at {}", self.path_string())?;
        }
        if let Some(o) = self.offset {
            write!(f, " (offset 0x{o:x})")?;
        }
        write!(f, ": {}", self.message)?;
        for (name, e) in &self.variants {
            write!(f, "\n  {name}: {e}")?;
        }
        Ok(())
    }
}

impl std::error::Error for YaffleError {}

/// Path helpers for `Result`s, used by generated readers.
pub trait ResultExt<T> {
    /// Adds a field to the error path and fills in the offset if missing.
    fn rf(self, name: &str, offset: usize) -> Result<T>;
    /// Adds an index to the error path.
    fn ri(self, index: usize) -> Result<T>;
    /// Adds a field to the error path (write side).
    fn wf(self, name: &str) -> Result<T>;
}

impl<T> ResultExt<T> for Result<T> {
    #[inline]
    fn rf(self, name: &str, offset: usize) -> Result<T> {
        self.map_err(|e| e.or_offset(offset).in_field(name))
    }
    #[inline]
    fn ri(self, index: usize) -> Result<T> {
        self.map_err(|e| e.in_index(index))
    }
    #[inline]
    fn wf(self, name: &str) -> Result<T> {
        self.map_err(|e| e.in_field(name))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_and_offsets() {
        let r: Result<()> = Err(YaffleError::range("too big"));
        let e = r.rf("count", 4).ri(2).rf("entries", 0).unwrap_err();
        assert_eq!(e.code, ErrorCode::Range);
        assert_eq!(e.path, vec![PathSeg::Field("entries".into()), PathSeg::Index(2), PathSeg::Field("count".into())]);
        assert_eq!(e.offset, Some(4));
        assert_eq!(e.path_string(), "entries.2.count");
        assert!(e.to_string().starts_with("RANGE at entries.2.count (offset 0x4)"));
    }

    #[test]
    fn write_errors_have_no_offset() {
        let e = YaffleError::input("missing").in_field("x");
        assert_eq!(e.offset_i64(), -1);
        let e2 = YaffleError::input("y").or_path(&[PathSeg::Field("a".into())]);
        assert_eq!(e2.path_string(), "a");
        assert_eq!(ErrorCode::Overlap.as_str(), "OVERLAP");
    }
}
