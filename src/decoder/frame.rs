//! Frame envelope validation matching src/network.ts, before decoder allocation.
pub fn content_size(data: &[u8], limit: u64) -> Result<usize, &'static str> {
    if data.len() < 6 || data[..4] != [0x28, 0xb5, 0x2f, 0xfd] {
        return Err("Expected Zstandard frame");
    }
    let flags = data[4];
    let single = (flags >> 5) & 1;
    let size_flag = flags >> 6;
    if flags & 0x18 != 0 || flags & 3 != 0 {
        return Err("Unsupported Zstandard flags/dictionary");
    }
    let size_bytes = if size_flag != 0 {
        1 << size_flag
    } else {
        single
    } as usize;
    let mut offset = 6 - single as usize;
    if size_bytes == 0 || data.len() < offset + size_bytes {
        return Err("Zstandard content size missing");
    }
    let mut raw = [0; 8];
    raw[..size_bytes].copy_from_slice(&data[offset..offset + size_bytes]);
    let size = u64::from_le_bytes(raw) + if size_flag == 1 { 256 } else { 0 };
    let base = 1_u64 << (10 + (data[5] >> 3));
    let window = if single != 0 {
        size
    } else {
        base + base / 8 * (data[5] & 7) as u64
    };
    if size > 9_007_199_254_740_991 || size > limit || window > limit {
        return Err("Decompressed message exceeds limit");
    }
    offset += size_bytes;
    loop {
        if offset + 3 > data.len() {
            return Err("Truncated Zstandard block");
        }
        let header = u32::from_le_bytes([data[offset], data[offset + 1], data[offset + 2], 0]);
        offset += 3;
        let kind = (header >> 1) & 3;
        let length = (header >> 3) as usize;
        if kind == 3 || length > 131072 {
            return Err("Invalid Zstandard block");
        }
        offset += if kind == 1 { 1 } else { length };
        if offset > data.len() {
            return Err("Truncated Zstandard payload");
        }
        if header & 1 != 0 {
            break;
        }
    }
    if flags & 4 != 0 {
        offset += 4;
    }
    if offset != data.len() {
        return Err("Trailing or truncated Zstandard frame");
    }
    usize::try_from(size).map_err(|_| "Decompressed message exceeds limit")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_envelope() {
        let frame = [0x28, 0xb5, 0x2f, 0xfd, 0x20, 1, 9, 0, 0, 42];
        assert_eq!(content_size(&frame, 1), Ok(1));
        assert!(content_size(&frame, 0).is_err());
        for n in 0..frame.len() {
            assert!(content_size(&frame[..n], 1).is_err());
        }
        let mut trailing = frame.to_vec();
        trailing.push(0);
        assert!(content_size(&trailing, 1).is_err());
    }
}
