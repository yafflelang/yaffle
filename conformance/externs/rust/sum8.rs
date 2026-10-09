//! `extern fn sum8(u8 data[]) -> u8`: the sum of the bytes, modulo 256 (see ../ts/sum8.ts).

pub fn sum8(data: &[u8]) -> u8 {
    data.iter().fold(0u8, |s, b| s.wrapping_add(*b))
}

#[cfg(test)]
mod tests {
    #[test]
    fn wraps() {
        assert_eq!(super::sum8(&[0xff, 0x02]), 1);
        assert_eq!(super::sum8(&[]), 0);
    }
}
