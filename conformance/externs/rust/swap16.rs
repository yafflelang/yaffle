//! `extern fn swap16(u16 v) -> u16`: swaps the two bytes (see ../ts/swap16.ts).

pub fn swap16(v: u16) -> u16 {
    v.swap_bytes()
}

#[cfg(test)]
mod tests {
    #[test]
    fn swaps() {
        assert_eq!(super::swap16(0x1234), 0x3412);
    }
}
