//! Frame envelope validation before decoder allocation.
//! A valid streaming frame may omit its decompressed content size.
fn header(data: &[u8], limit: u64) -> Result<(Option<usize>, usize, bool), &'static str> {
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
    if data.len() < offset + size_bytes {
        return Err("Truncated Zstandard content size");
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
    let size = if size_bytes == 0 {
        None
    } else {
        Some(usize::try_from(size).map_err(|_| "Decompressed message exceeds limit")?)
    };
    Ok((size, offset, flags & 4 != 0))
}

fn blocks(
    data: &[u8],
    mut offset: usize,
    checksum: bool,
    streaming: bool,
) -> Result<bool, &'static str> {
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
            if checksum {
                offset += 4;
            }
            if offset != data.len() {
                return Err("Trailing or truncated Zstandard frame");
            }
            return Ok(true);
        }
        if streaming && offset == data.len() {
            return Ok(false);
        }
    }
}

pub fn content_size(data: &[u8], limit: u64) -> Result<Option<usize>, &'static str> {
    let (size, offset, checksum) = header(data, limit)?;
    blocks(data, offset, checksum, false)?;
    Ok(size)
}

// Each Figma STREAM message ends at a complete block boundary (a zstd flush).
// A continuation has no frame header; only the first message carries one.
pub fn stream_segment(data: &[u8], limit: u64, first: bool) -> Result<bool, &'static str> {
    let offset = if first {
        let (size, offset, checksum) = header(data, limit)?;
        if size.is_some() || checksum {
            return Err("Unsupported streaming Zstandard header");
        }
        offset
    } else {
        0
    };
    blocks(data, offset, false, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_size_envelope() {
        // No content size; a 1 KiB window and one raw byte.
        let frame = [0x28, 0xb5, 0x2f, 0xfd, 0, 0, 9, 0, 0, 42];
        assert_eq!(content_size(&frame, 1024), Ok(None));
        assert!(content_size(&frame, 1023).is_err());
        for n in 0..frame.len() {
            assert!(content_size(&frame[..n], 1024).is_err());
        }
        let mut trailing = frame.to_vec();
        trailing.push(0);
        assert!(content_size(&trailing, 1024).is_err());
    }

    #[test]
    fn bounded_envelope() {
        let frame = [0x28, 0xb5, 0x2f, 0xfd, 0x20, 1, 9, 0, 0, 42];
        assert_eq!(content_size(&frame, 1), Ok(Some(1)));
        assert!(content_size(&frame, 0).is_err());
        for n in 0..frame.len() {
            assert!(content_size(&frame[..n], 1).is_err());
        }
        let mut trailing = frame.to_vec();
        trailing.push(0);
        assert!(content_size(&trailing, 1).is_err());
    }
}
