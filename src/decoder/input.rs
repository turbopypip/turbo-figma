//! Bounded snapshot input, integrity checks and Zstandard decompression.
use crate::frame;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::Path,
    time::Instant,
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const PART: usize = 8 * 1024 * 1024;
const RECORD: usize = 24 * 1024 * 1024 + 4096;
pub const FRAME: usize = 64 * 1024 * 1024;
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn require(ok: bool, message: &'static str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(message.into())
    }
}
#[cfg(unix)]
fn same_file(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev() && a.ino() == b.ino() && a.nlink() == 1 && b.nlink() == 1
}
pub fn bounded(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let before = fs::symlink_metadata(path)?;
    require(
        before.is_file() && !before.file_type().is_symlink(),
        "Unsafe cache file",
    )?;
    #[cfg(windows)]
    let before_handle = crate::platform::open_read(path, false)?;
    #[cfg(windows)]
    let before_info = crate::platform::file_info(&before_handle)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x100);
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(0x20000);
    }
    #[cfg(windows)]
    let file = crate::platform::open_read(path, false)?;
    #[cfg(unix)]
    let file = options.open(path)?;
    #[cfg(unix)]
    let same = same_file(&before, &file.metadata()?);
    #[cfg(windows)]
    let same = {
        let info = crate::platform::file_info(&file)?;
        info.volume == before_info.volume && info.index == before_info.index
            && info.links == 1 && before_info.links == 1
    };
    let stat = file.metadata()?;
    require(
        stat.is_file() && same && stat.len() <= limit as u64,
        "Invalid cache file or size",
    )?;
    let mut bytes = Vec::with_capacity(stat.len() as usize + 1);
    file.take(stat.len() + 1).read_to_end(&mut bytes)?;
    require(
        bytes.len() as u64 == stat.len(),
        "Cache file changed during read",
    )?;
    Ok(bytes)
}
fn directory(path: &Path) -> Result<()> {
    let stat = fs::symlink_metadata(path)?;
    require(
        stat.is_dir() && !stat.file_type().is_symlink() && crate::platform::canonicalize(path)? == path,
        "Unsafe cache directory",
    )
}
fn exact_keys(v: &Value, required: &[&str], optional: &[&str]) -> bool {
    v.as_object().is_some_and(|o| {
        required.iter().all(|k| o.contains_key(*k))
            && o.keys()
                .all(|k| required.contains(&k.as_str()) || optional.contains(&k.as_str()))
    })
}
fn int(v: &Value, low: f64, high: f64) -> bool {
    v.as_f64()
        .is_some_and(|x| x.is_finite() && x.fract() == 0.0 && x >= low && x <= high)
}
fn identity(v: &Value) -> bool {
    exact_keys(v, &["fileKey", "sessionId", "generation"], &[])
        && v["fileKey"].as_str().is_some_and(|s| {
            !s.is_empty() && s.len() <= 256 && s.bytes().all(|b| b.is_ascii_alphanumeric())
        })
        && v["sessionId"].as_str().is_some_and(|s| {
            !s.is_empty()
                && s.len() <= 128
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
        && int(&v["generation"], 1.0, 9007199254740991.0)
}
fn manifest(dir: &Path, snapshot: &Value) -> Result<Value> {
    directory(dir)?;
    let m: Value = serde_json::from_slice(&bounded(&dir.join("ready.json"), 2 * 1024 * 1024)?)?;
    require(
        exact_keys(
            &m,
            &["version", "status", "snapshot", "parts"],
            &["monitored"],
        ) && m["version"].as_f64() == Some(1.0)
            && m["status"] == "ready"
            && (m.get("monitored").is_none() || m["monitored"] == true)
            && identity(&m["snapshot"])
            && m["snapshot"] == *snapshot,
        "Invalid manifest identity or size",
    )?;
    let parts = m["parts"].as_array().ok_or("Invalid parts")?;
    require(!parts.is_empty() && parts.len() <= 10000, "Invalid parts")?;
    let mut total = 0.0;
    for p in parts {
        require(
            exact_keys(p, &["bytes", "sha256"], &[])
                && int(&p["bytes"], 1.0, PART as f64)
                && p["sha256"].as_str().is_some_and(|s| {
                    s.len() == 64
                        && s.bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                }),
            "Invalid part metadata",
        )?;
        total += p["bytes"].as_f64().unwrap();
    }
    require(total <= 4294967296.0, "Invalid manifest identity or size")?;
    Ok(m)
}
pub fn input(
    dir: &Path,
    snapshot: &Value,
    mut consume: impl FnMut(&[u8]) -> Result<()>,
) -> Result<()> {
    require(identity(snapshot), "Invalid snapshot identity")?;
    let count = manifest(dir, snapshot)?["parts"].as_array().unwrap().len();
    let mut pending = Vec::new();
    let mut sequence = 0_u64;
    let mut socket = None;
    for i in 0..count {
        let m = manifest(dir, snapshot)?;
        let expected = m["parts"].get(i).ok_or("Invalid part sequence")?;
        let part = bounded(&dir.join(format!("part-{i}.bin")), PART)?;
        require(
            expected["bytes"].as_f64() == Some(part.len() as f64)
                && expected["sha256"] == hex(&Sha256::digest(&part)),
            "Corrupt snapshot part",
        )?;
        let mut offset = 0;
        while offset < part.len() {
            let newline = part[offset..]
                .iter()
                .position(|b| *b == b'\n')
                .map(|n| offset + n);
            let end = newline.unwrap_or(part.len());
            require(
                pending.len() + end - offset <= RECORD,
                "Capture record size limit exceeded",
            )?;
            pending.extend_from_slice(&part[offset..end]);
            offset = end + 1;
            if newline.is_none() {
                break;
            }
            let r: Value = serde_json::from_slice(&pending)?;
            require(
                r["version"].as_f64() == Some(1.0)
                    && r["kind"] == "ws-received"
                    && r["opcode"].as_f64() == Some(2.0)
                    && r["eventSequence"].as_f64() == Some(sequence as f64)
                    && ["session", "requestId"].iter().all(|k| {
                        r[k].as_str()
                            .is_some_and(|s| s.encode_utf16().count() <= 256)
                    }),
                "Invalid stored capture event",
            )?;
            let key = (
                r["session"].as_str().unwrap().to_owned(),
                r["requestId"].as_str().unwrap().to_owned(),
            );
            require(
                socket.as_ref().is_none_or(|s| *s == key),
                "Multiple multiplayer streams",
            )?;
            socket = Some(key);
            sequence += 1;
            let payload = r["payload"].as_str().ok_or("Invalid binary payload")?;
            require(payload.len() <= 24 * 1024 * 1024, "Invalid binary payload")?;
            let binary = STANDARD
                .decode(payload)
                .map_err(|_| "Invalid binary payload")?;
            require(
                !binary.is_empty() && STANDARD.encode(&binary) == payload,
                "Invalid binary payload",
            )?;
            consume(&binary)?;
            pending.clear();
        }
    }
    require(
        pending.is_empty() && sequence > 0,
        "Incomplete stored capture record",
    )
}
pub fn inflate(data: &[u8], limit: usize) -> Result<Vec<u8>> {
    require(limit <= FRAME, "Invalid inflate limit")?;
    let size = frame::content_size(data, limit as u64)?;
    let mut decoder = zstd::bulk::Decompressor::new()?;
    // fzstd deliberately ignores checksum content; preserve its acceptance contract.
    decoder.set_parameter(zstd::zstd_safe::DParameter::ForceIgnoreChecksum(true))?;
    let mut out = vec![0; size];
    let written = decoder.decompress_to_buffer(data, &mut out[..])?;
    require(written == size, "Zstandard size mismatch")?;
    Ok(out)
}
fn packet(w: &mut impl Write, data: &[u8]) -> Result<()> {
    w.write_all(&(data.len() as u32).to_le_bytes())?;
    w.write_all(data)?;
    w.flush()?;
    Ok(())
}
fn read_header(r: &mut impl Read) -> Result<Option<[u8; 8]>> {
    let mut header = [0; 8];
    if r.read(&mut header[..1])? == 0 {
        return Ok(None);
    }
    r.read_exact(&mut header[1..])?;
    Ok(Some(header))
}
pub fn run(mode: &str, config: Option<&str>) -> Result<()> {
    if mode == "inflate-stream" {
        let mut r = io::stdin().lock();
        let mut w = io::stdout().lock();
        while let Some(h) = read_header(&mut r)? {
            let n = u32::from_le_bytes(h[..4].try_into().unwrap()) as usize;
            let limit = u32::from_le_bytes(h[4..].try_into().unwrap()) as usize;
            require(n <= RECORD && limit <= FRAME, "Invalid packet size")?;
            let mut b = vec![0; n];
            r.read_exact(&mut b)?;
            packet(&mut w, &inflate(&b, limit)?)?;
        }
        return Ok(());
    }
    let config: Value = serde_json::from_slice(&bounded(
        Path::new(config.ok_or("Config required")?),
        65536,
    )?)?;
    let dir = Path::new(config["directory"].as_str().ok_or("Directory required")?);
    if mode == "input-stream" {
        return input(dir, &config["snapshot"], |b| {
            packet(&mut io::stdout().lock(), b)
        });
    }
    require(
        mode == "input-bench" || mode == "inflate-bench",
        "Unknown input operation",
    )?;
    let warm = config["warmup"].as_u64().unwrap_or(0);
    let runs = config["runs"].as_u64().unwrap_or(1);
    require(warm <= 100 && runs > 0 && runs <= 1000, "Invalid runs")?;
    let cpu_before = metrics()["cpuMs"].as_f64();
    let mut times = Vec::new();
    let mut last = Value::Null;
    for i in 0..warm + runs {
        let at = Instant::now();
        let mut hash = Sha256::new();
        let mut count = 0;
        let mut bytes = 0;
        let mut consume = |b: &[u8]| {
            hash.update((b.len() as u32).to_le_bytes());
            hash.update(b);
            count += 1;
            bytes += b.len();
            Ok(())
        };
        if mode == "input-bench" {
            input(dir, &config["snapshot"], &mut consume)?;
        } else {
            let mut f = File::open(dir.join("frames.bin"))?;
            while let Some(h) = read_header(&mut f)? {
                let n = u32::from_le_bytes(h[..4].try_into().unwrap()) as usize;
                let limit = u32::from_le_bytes(h[4..].try_into().unwrap()) as usize;
                require(n <= RECORD, "Invalid packet size")?;
                let mut b = vec![0; n];
                f.read_exact(&mut b)?;
                consume(&inflate(&b, limit)?)?;
            }
        }
        if i >= warm {
            times.push(at.elapsed().as_secs_f64() * 1000.0);
        }
        last = json!({"hash":hex(&hash.finalize()),"count":count,"bytes":bytes});
    }
    println!(
        "{}",
        json!({"times":times,"result":last,"workCpuMs":cpu_before.zip(metrics()["cpuMs"].as_f64()).map(|(a,b)|b-a)})
    );
    Ok(())
}

// getrusage fills the platform-defined libc struct. No pointers escape this call.
#[cfg(unix)]
pub fn metrics() -> Value {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    let ok = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
    if ok != 0 {
        return Value::Null;
    }
    let u = unsafe { usage.assume_init() };
    let cpu_ms = (u.ru_utime.tv_sec + u.ru_stime.tv_sec) as f64 * 1000.0
        + (u.ru_utime.tv_usec + u.ru_stime.tv_usec) as f64 / 1000.0;
    let rss = u.ru_maxrss as u64 * if cfg!(target_os = "macos") { 1 } else { 1024 };
    json!({"cpuMs":cpu_ms,"maxRssBytes":rss})
}

#[cfg(not(unix))]
pub fn metrics() -> Value {
    Value::Null
}
