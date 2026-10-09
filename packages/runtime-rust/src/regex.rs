//! A small regular expression engine for `value in /pattern/` checks: the portable RE2-style
//! subset (no backreferences or lookaround), always matched against the whole string, in
//! linear time (Thompson NFA simulation).
//!
//! Supported: literals, `.`, `[...]` / `[^...]` classes with ranges, `\d \w \s \D \W \S`,
//! escapes (`\n \t \r \f \v \xHH \x{H…} \uHHHH` and escaped punctuation), groups `(…)` and
//! `(?:…)`, alternation `|`, quantifiers `* + ? {n} {n,} {n,m}` (lazy forms accepted), anchors
//! `^` and `$`.

#[derive(Debug, Clone)]
enum Node {
    Empty,
    Char(char),
    Any,
    Class(Vec<(char, char)>, bool),
    Cat(Vec<Node>),
    Alt(Vec<Node>),
    Repeat(Box<Node>, u32, Option<u32>),
    Start,
    End,
}

#[derive(Debug, Clone)]
enum Inst {
    Char(char),
    Any,
    Class(Vec<(char, char)>, bool),
    Split(usize, usize),
    Jmp(usize),
    Start,
    End,
    Match,
}

/// A compiled pattern.
#[derive(Debug, Clone)]
pub struct Regex {
    prog: Vec<Inst>,
}

/// The pattern parser: characters and the position of the next one.
struct Parser {
    c: Vec<char>,
    i: usize,
}

const MAX_REPEAT: u32 = 1000;

impl Parser {
    fn peek(&self) -> Option<char> {
        self.c.get(self.i).copied()
    }
    fn alt(&mut self) -> Result<Node, String> {
        let mut alts = vec![self.cat()?];
        while self.peek() == Some('|') {
            self.i += 1;
            alts.push(self.cat()?);
        }
        Ok(if alts.len() == 1 { alts.pop().unwrap() } else { Node::Alt(alts) })
    }
    fn cat(&mut self) -> Result<Node, String> {
        let mut items = Vec::new();
        while let Some(c) = self.peek() {
            if c == '|' || c == ')' {
                break;
            }
            let atom = self.atom()?;
            items.push(self.quant(atom)?);
        }
        Ok(match items.len() {
            0 => Node::Empty,
            1 => items.pop().unwrap(),
            _ => Node::Cat(items),
        })
    }
    fn number(&mut self) -> Option<u32> {
        let start = self.i;
        while matches!(self.peek(), Some('0'..='9')) {
            self.i += 1;
        }
        if start == self.i {
            return None;
        }
        self.c[start..self.i].iter().collect::<String>().parse().ok()
    }
    fn quant(&mut self, atom: Node) -> Result<Node, String> {
        let mut node = atom;
        loop {
            let (min, max) = match self.peek() {
                Some('*') => {
                    self.i += 1;
                    (0, None)
                }
                Some('+') => {
                    self.i += 1;
                    (1, None)
                }
                Some('?') => {
                    self.i += 1;
                    (0, Some(1))
                }
                Some('{') => {
                    let save = self.i;
                    self.i += 1;
                    match self.number() {
                        None => {
                            // A literal '{'.
                            self.i = save;
                            return Ok(node);
                        }
                        Some(n) => {
                            let r = if self.peek() == Some(',') {
                                self.i += 1;
                                (n, self.number())
                            } else {
                                (n, Some(n))
                            };
                            if self.peek() != Some('}') {
                                return Err("unterminated {} quantifier".into());
                            }
                            self.i += 1;
                            r
                        }
                    }
                }
                _ => return Ok(node),
            };
            if min > MAX_REPEAT || max.is_some_and(|m| m > MAX_REPEAT || m < min) {
                return Err("bad repetition count".into());
            }
            if self.peek() == Some('?') {
                self.i += 1; // lazy: same language
            }
            node = Node::Repeat(Box::new(node), min, max);
        }
    }
    fn escape_class(c: char) -> Option<(Vec<(char, char)>, bool)> {
        let digits = vec![('0', '9')];
        let word = vec![('0', '9'), ('A', 'Z'), ('_', '_'), ('a', 'z')];
        let space = vec![('\t', '\r'), (' ', ' ')];
        Some(match c {
            'd' => (digits, false),
            'D' => (digits, true),
            'w' => (word, false),
            'W' => (word, true),
            's' => (space, false),
            'S' => (space, true),
            _ => return None,
        })
    }
    fn hex(&mut self, n: usize) -> Result<char, String> {
        let s: String = self.c.get(self.i..self.i + n).ok_or("bad escape")?.iter().collect();
        self.i += n;
        let v = u32::from_str_radix(&s, 16).map_err(|_| "bad hex escape")?;
        char::from_u32(v).ok_or_else(|| "bad code point".into())
    }
    /// After a backslash: a single character.
    fn escape_char(&mut self) -> Result<char, String> {
        let c = self.peek().ok_or("trailing backslash")?;
        self.i += 1;
        Ok(match c {
            'n' => '\n',
            't' => '\t',
            'r' => '\r',
            'f' => '\u{0c}',
            'v' => '\u{0b}',
            '0' => '\0',
            'x' => {
                if self.peek() == Some('{') {
                    self.i += 1;
                    let start = self.i;
                    while self.peek().is_some_and(|c| c != '}') {
                        self.i += 1;
                    }
                    let s: String = self.c[start..self.i].iter().collect();
                    self.i += 1;
                    let v = u32::from_str_radix(&s, 16).map_err(|_| "bad hex escape")?;
                    char::from_u32(v).ok_or("bad code point")?
                } else {
                    self.hex(2)?
                }
            }
            'u' => self.hex(4)?,
            c if c.is_ascii_alphanumeric() => return Err(format!("unsupported escape \\{c}")),
            c => c,
        })
    }
    fn atom(&mut self) -> Result<Node, String> {
        let c = self.peek().ok_or("unexpected end")?;
        self.i += 1;
        Ok(match c {
            '.' => Node::Any,
            '^' => Node::Start,
            '$' => Node::End,
            '(' => {
                if self.c.get(self.i..self.i + 2) == Some(&['?', ':']) {
                    self.i += 2;
                } else if self.peek() == Some('?') {
                    return Err("unsupported group syntax".into());
                }
                let n = self.alt()?;
                if self.peek() != Some(')') {
                    return Err("missing )".into());
                }
                self.i += 1;
                n
            }
            ')' => return Err("unbalanced )".into()),
            '*' | '+' | '?' => return Err("quantifier without operand".into()),
            '[' => self.class()?,
            '\\' => {
                let e = self.peek().ok_or("trailing backslash")?;
                if let Some((set, neg)) = Self::escape_class(e) {
                    self.i += 1;
                    Node::Class(set, neg)
                } else {
                    Node::Char(self.escape_char()?)
                }
            }
            c => Node::Char(c),
        })
    }
    fn class(&mut self) -> Result<Node, String> {
        let mut neg = false;
        if self.peek() == Some('^') {
            neg = true;
            self.i += 1;
        }
        let mut set: Vec<(char, char)> = Vec::new();
        let mut first = true;
        loop {
            let c = self.peek().ok_or("unterminated class")?;
            if c == ']' && !first {
                self.i += 1;
                break;
            }
            first = false;
            self.i += 1;
            let lo = if c == '\\' {
                let e = self.peek().ok_or("trailing backslash")?;
                if let Some((s, n)) = Self::escape_class(e) {
                    self.i += 1;
                    if n {
                        // Negated escape inside a class: add the complement.
                        let mut prev = '\0';
                        let mut sorted = s.clone();
                        sorted.sort();
                        for (a, b) in sorted {
                            if a > prev {
                                set.push((prev, char::from_u32(a as u32 - 1).unwrap_or(prev)));
                            }
                            prev = char::from_u32(b as u32 + 1).unwrap_or(b);
                        }
                        set.push((prev, char::MAX));
                    } else {
                        set.extend(s);
                    }
                    continue;
                }
                self.escape_char()?
            } else {
                c
            };
            if self.peek() == Some('-') && self.c.get(self.i + 1).is_some_and(|&x| x != ']') {
                self.i += 1;
                let h = self.peek().unwrap();
                self.i += 1;
                let hi = if h == '\\' { self.escape_char()? } else { h };
                if hi < lo {
                    return Err("bad class range".into());
                }
                set.push((lo, hi));
            } else {
                set.push((lo, lo));
            }
        }
        Ok(Node::Class(set, neg))
    }
}

fn compile(n: &Node, prog: &mut Vec<Inst>) {
    match n {
        Node::Empty => {}
        Node::Char(c) => prog.push(Inst::Char(*c)),
        Node::Any => prog.push(Inst::Any),
        Node::Class(s, neg) => prog.push(Inst::Class(s.clone(), *neg)),
        Node::Start => prog.push(Inst::Start),
        Node::End => prog.push(Inst::End),
        Node::Cat(items) => {
            for i in items {
                compile(i, prog);
            }
        }
        Node::Alt(alts) => {
            // split L1, next ; L1: a ; jmp end ; next: split L2, ... ; last
            let mut jumps = Vec::new();
            for (k, a) in alts.iter().enumerate() {
                if k + 1 < alts.len() {
                    let split = prog.len();
                    prog.push(Inst::Split(0, 0));
                    compile(a, prog);
                    jumps.push(prog.len());
                    prog.push(Inst::Jmp(0));
                    let next = prog.len();
                    prog[split] = Inst::Split(split + 1, next);
                } else {
                    compile(a, prog);
                }
            }
            let end = prog.len();
            for j in jumps {
                prog[j] = Inst::Jmp(end);
            }
        }
        Node::Repeat(inner, min, max) => {
            for _ in 0..*min {
                compile(inner, prog);
            }
            match max {
                None => {
                    // L: split body, end ; body ; jmp L
                    let l = prog.len();
                    prog.push(Inst::Split(0, 0));
                    compile(inner, prog);
                    prog.push(Inst::Jmp(l));
                    let end = prog.len();
                    prog[l] = Inst::Split(l + 1, end);
                }
                Some(m) => {
                    let mut splits = Vec::new();
                    for _ in *min..*m {
                        splits.push(prog.len());
                        prog.push(Inst::Split(0, 0));
                        compile(inner, prog);
                    }
                    let end = prog.len();
                    for s in splits {
                        prog[s] = Inst::Split(s + 1, end);
                    }
                }
            }
        }
    }
}

impl Regex {
    pub fn new(pattern: &str) -> Result<Regex, String> {
        let mut p = Parser { c: pattern.chars().collect(), i: 0 };
        let node = p.alt()?;
        if p.i != p.c.len() {
            return Err(format!("unexpected {:?} in pattern", p.c[p.i]));
        }
        let mut prog = Vec::new();
        compile(&node, &mut prog);
        prog.push(Inst::Match);
        Ok(Regex { prog })
    }

    fn add(&self, list: &mut Vec<usize>, seen: &mut [u32], gen: u32, pc: usize, at_start: bool, at_end: bool) {
        if seen[pc] == gen {
            return;
        }
        seen[pc] = gen;
        match &self.prog[pc] {
            Inst::Jmp(t) => self.add(list, seen, gen, *t, at_start, at_end),
            Inst::Split(a, b) => {
                self.add(list, seen, gen, *a, at_start, at_end);
                self.add(list, seen, gen, *b, at_start, at_end);
            }
            Inst::Start => {
                if at_start {
                    self.add(list, seen, gen, pc + 1, at_start, at_end);
                }
            }
            Inst::End => {
                if at_end {
                    self.add(list, seen, gen, pc + 1, at_start, at_end);
                }
            }
            _ => list.push(pc),
        }
    }

    /// Whether the pattern matches the whole string.
    pub fn is_full_match(&self, s: &str) -> bool {
        let chars: Vec<char> = s.chars().collect();
        let mut seen = vec![0u32; self.prog.len()];
        let mut gen = 1;
        let mut cur = Vec::new();
        self.add(&mut cur, &mut seen, gen, 0, true, chars.is_empty());
        for (i, &c) in chars.iter().enumerate() {
            gen += 1;
            let mut next = Vec::new();
            let at_end = i + 1 == chars.len();
            for &pc in &cur {
                let ok = match &self.prog[pc] {
                    Inst::Char(x) => *x == c,
                    Inst::Any => c != '\n',
                    Inst::Class(set, neg) => set.iter().any(|&(a, b)| a <= c && c <= b) != *neg,
                    _ => false,
                };
                if ok {
                    self.add(&mut next, &mut seen, gen, pc + 1, false, at_end);
                }
            }
            cur = next;
            if cur.is_empty() {
                return false;
            }
        }
        cur.iter().any(|&pc| matches!(self.prog[pc], Inst::Match))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(p: &str, s: &str) -> bool {
        Regex::new(p).unwrap().is_full_match(s)
    }

    #[test]
    fn basics() {
        assert!(m(r"v\d\.\d{1,2}", "v1.2"));
        assert!(m(r"v\d\.\d{1,2}", "v1.23"));
        assert!(!m(r"v\d\.\d{1,2}", "v1.234"));
        assert!(!m(r"v\d\.\d{1,2}", "xv1.2"));
        assert!(m("a|bc", "bc"));
        assert!(!m("a|bc", "abc"));
        assert!(m("(ab)*c", "ababc"));
        assert!(m("(?:ab)+", "abab"));
        assert!(!m("(?:ab)+", ""));
        assert!(m("[a-z_][a-z0-9_]*", "foo_1"));
        assert!(!m("[a-z_][a-z0-9_]*", "1foo"));
        assert!(m("[^0-9]+", "abc"));
        assert!(!m("[^0-9]+", "ab1"));
        assert!(m("^abc$", "abc"));
        assert!(m("a.c", "abc"));
        assert!(!m("a.c", "a\nc"));
        assert!(m(r"\w+\s\w+", "hello world"));
        assert!(m("x{3}", "xxx"));
        assert!(!m("x{3}", "xx"));
        assert!(m("x{2,}", "xxxxx"));
        assert!(m("", ""));
        assert!(!m("", "a"));
        assert!(m(r"\x41B", "AB"));
        assert!(m("[.]", "."));
        assert!(m(r"[\d\-]+", "1-2"));
        assert!(m(r"a{", "a{"));
        assert!(m("é+", "éé"));
    }

    #[test]
    fn errors() {
        assert!(Regex::new("(a").is_err());
        assert!(Regex::new("a)").is_err());
        assert!(Regex::new("*a").is_err());
        assert!(Regex::new(r"\1").is_err());
        assert!(Regex::new("(?=a)").is_err());
        assert!(Regex::new("[a").is_err());
    }

    #[test]
    fn linear_time() {
        let s = "a".repeat(5000);
        assert!(!m("(a*)*b", &s));
    }
}
