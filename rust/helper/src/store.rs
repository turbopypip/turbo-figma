//! Bounded filesystem operations for the managed store. No recursive deletion.
use crate::stage6::bounded;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const PART: usize = 8 * 1024 * 1024;
fn check(b: bool, message: &str) -> Result<()> {
    if b {
        Ok(())
    } else {
        Err(message.into())
    }
}
fn text<'a>(v: &'a Value, k: &str) -> Result<&'a str> {
    v[k].as_str().ok_or_else(|| format!("Invalid {k}").into())
}
fn hash(b: &[u8]) -> String {
    Sha256::digest(b)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn exact(v: &Value, required: &[&str], optional: &[&str]) -> bool {
    v.as_object().is_some_and(|o| {
        required.iter().all(|k| o.contains_key(*k))
            && o.keys()
                .all(|k| required.contains(&k.as_str()) || optional.contains(&k.as_str()))
    })
}
fn integer(v: &Value, lo: f64, hi: f64) -> bool {
    v.as_f64()
        .is_some_and(|n| n.fract() == 0. && n >= lo && n <= hi)
}
fn identity(v: &Value) -> bool {
    exact(v, &["fileKey", "sessionId", "generation"], &[])
        && v["fileKey"].as_str().is_some_and(|s| {
            !s.is_empty() && s.len() <= 256 && s.bytes().all(|b| b.is_ascii_alphanumeric())
        })
        && v["sessionId"].as_str().is_some_and(|s| {
            !s.is_empty()
                && s.len() <= 128
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
        && integer(&v["generation"], 1., 9007199254740991.)
}
fn guid(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() <= 100
            && s.split(':').count() == 2
            && s.split(':')
                .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
    })
}
fn frame(v: Option<&Value>) -> bool {
    v.is_none_or(|v| {
        exact(v, &["pageId", "frameId"], &[]) && guid(&v["pageId"]) && guid(&v["frameId"])
    })
}
fn key(v: &Value, f: Option<&Value>) -> Result<String> {
    check(identity(v) && frame(f), "Invalid snapshot identity")?;
    Ok(hash(&crate::json::bytes(&json!([
        v["fileKey"],
        f.map(|x| &x["pageId"]),
        f.map(|x| &x["frameId"]),
        v["sessionId"],
        v["generation"]
    ]))?))
}
fn stamp(p: &Path) -> Result<String> {
    let m = fs::symlink_metadata(p)?;
    check(
        m.is_dir() && !m.file_type().is_symlink() && fs::canonicalize(p)? == p,
        "Unsafe cache directory",
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(format!("{}:{}", m.dev(), m.ino()))
    }
    #[cfg(not(unix))]
    {
        let _ = m;
        Err("Native store directory identity is not supported on this platform".into())
    }
}
fn write(p: &Path, b: &[u8]) -> Result<()> {
    let mut o = OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let mut f = o.open(p)?;
    f.write_all(b)?;
    f.sync_all()?;
    Ok(())
}
fn mkdir(p: &Path) -> Result<()> {
    let mut b = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o700);
    }
    b.create(p)?;
    Ok(())
}
fn sync_dir(p: &Path) -> Result<()> {
    File::open(p)?.sync_all()?;
    Ok(())
}
fn manifest(root: &Path, id: &Value, f: Option<&Value>) -> Result<Value> {
    let dir = root.join(key(id, f)?);
    stamp(&dir)?;
    let m: Value = serde_json::from_slice(&bounded(&dir.join("ready.json"), 2 * 1024 * 1024)?)?;
    check(
        exact(
            &m,
            &["version", "status", "snapshot", "parts"],
            &["monitored", "frame"],
        ) && m["version"] == 1
            && m["status"] == "ready"
            && m.get("monitored").is_none_or(|v| v == true),
        "Invalid manifest identity or size",
    )?;
    check(
        key(&m["snapshot"], m.get("frame"))? == key(id, f)?,
        "Invalid manifest identity or size",
    )?;
    let parts = m["parts"].as_array().ok_or("Invalid manifest parts")?;
    check(
        !parts.is_empty() && parts.len() <= 10000,
        "Invalid manifest parts",
    )?;
    let mut total = 0u64;
    for p in parts {
        check(
            exact(p, &["bytes", "sha256"], &[])
                && integer(&p["bytes"], 1., PART as f64)
                && p["sha256"].as_str().is_some_and(hex_name),
            "Invalid manifest parts",
        )?;
        total += p["bytes"].as_f64().unwrap() as u64;
    }
    check(
        total <= 4 * 1024 * 1024 * 1024,
        "Invalid manifest identity or size",
    )?;
    Ok(m)
}
fn hex_name(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn file_name(s: &str) -> bool {
    if ["capture.json", "ready.json", "manifest.tmp"].contains(&s) {
        return true;
    }
    s.strip_prefix("part-")
        .and_then(|s| s.strip_suffix(".bin"))
        .is_some_and(|s| {
            s == "0"
                || (!s.starts_with('0')
                    && !s.is_empty()
                    && s.len() <= 4
                    && s.bytes().all(|b| b.is_ascii_digit()))
        })
}
fn recoverable(e: &(dyn std::error::Error + 'static)) -> bool {
    e.downcast_ref::<io::Error>()
        .is_none_or(|e| e.kind() == io::ErrorKind::NotFound)
}
fn inventory(root: &Path) -> Result<(Vec<Value>, usize)> {
    let mut entries = vec![];
    let mut protected = 0;
    let mut visited_files = 0;
    for (i, item) in fs::read_dir(root)?.enumerate() {
        check(i < 10000, "Cache directory entry limit exceeded")?;
        let item = item?;
        let name = item.file_name().to_string_lossy().into_owned();
        if !hex_name(&name) || !item.file_type()?.is_dir() {
            protected += 1;
            continue;
        }
        let dir = item.path();
        let entry = (|| -> Result<Option<Value>> {
            stamp(&dir)?;
            let owner: Value = serde_json::from_slice(&bounded(&dir.join("capture.json"), 4096)?)?;
            if !exact(&owner, &["owner", "version", "snapshot"], &["frame"])
                || owner["owner"] != "figma-kilo-mcp"
                || owner["version"] != 1
                || key(&owner["snapshot"], owner.get("frame"))? != name
            {
                return Ok(None);
            }
            let mut files = vec![];
            let mut bytes = 0u64;
            let mut modified = 0.;
            for file in fs::read_dir(&dir)? {
                visited_files += 1;
                check(visited_files <= 100000, "Cache file entry limit exceeded")?;
                if files.len() > 10003 {
                    return Ok(None);
                }
                let file = file?;
                let n = file.file_name().to_string_lossy().into_owned();
                if !file_name(&n) {
                    return Ok(None);
                }
                let m = fs::symlink_metadata(file.path())?;
                #[cfg(unix)]
                let one_link = {
                    use std::os::unix::fs::MetadataExt;
                    m.nlink() == 1
                };
                #[cfg(not(unix))]
                let one_link = true;
                if !m.is_file() || m.file_type().is_symlink() || !one_link {
                    return Ok(None);
                }
                bytes += m.len();
                if n == "ready.json" {
                    modified = m
                        .modified()?
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_secs_f64() * 1000.)
                        .unwrap_or(0.);
                }
                files.push(n);
            }
            let mut ready = false;
            if files.iter().any(|s| s == "ready.json") {
                match manifest(root, &owner["snapshot"], owner.get("frame")) {
                    Ok(m) => {
                        ready = m["parts"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .enumerate()
                            .all(|(i, _)| files.contains(&format!("part-{i}.bin")))
                    }
                    Err(e) => {
                        if !recoverable(e.as_ref()) {
                            return Err(e);
                        }
                    }
                }
            }
            let f = owner.get("frame");
            Ok(Some(
                json!({"name":name,"files":files,"bytes":bytes,"ready":ready,"modified":modified,"generation":owner["snapshot"]["generation"],"group":serde_json::to_string(&json!([owner["snapshot"]["fileKey"],f.map(|v|&v["pageId"]),f.map(|v|&v["frameId"])]))?}),
            ))
        })();
        match entry {
            Ok(Some(v)) => entries.push(v),
            Ok(None) => protected += 1,
            Err(e) => {
                if e.to_string() == "Cache file entry limit exceeded" || !recoverable(e.as_ref()) {
                    return Err(e);
                }
                protected += 1;
            }
        }
    }
    Ok((entries, protected))
}
fn command(q: &Value) -> Result<Value> {
    let root = PathBuf::from(text(q, "root")?);
    check(root.is_absolute(), "Cache root must be absolute")?;
    let stamps = q["stamps"].as_array().ok_or("Directory stamps required")?;
    check(stamps.len() == 2, "Directory stamps required")?;
    for (s, p) in stamps
        .iter()
        .zip([root.parent().ok_or("Invalid root")?, root.as_path()])
    {
        check(s[0].as_str() == p.to_str(), "Invalid guarded directory")?;
        check(
            stamp(p)? == s[1].as_str().ok_or("Invalid directory stamp")?,
            "Cache directory was replaced",
        )?;
    }
    let op = text(q, "op")?;
    if op == "info" || op == "clean" {
        let (mut entries, protected) = inventory(&root)?;
        if op == "info" {
            return Ok(
                json!({"bytes":entries.iter().map(|e|e["bytes"].as_u64().unwrap()).sum::<u64>(),"generations":entries.len(),"incomplete":entries.iter().filter(|e|e["ready"]!=true).count(),"protectedEntries":protected}),
            );
        }
        let mode = text(q, "mode")?;
        check(
            mode == "all" || mode == "prune",
            "Invalid cache cleanup mode",
        )?;
        entries.sort_by(|a, b| {
            b["modified"]
                .as_f64()
                .unwrap()
                .total_cmp(&a["modified"].as_f64().unwrap())
                .then_with(|| {
                    b["generation"]
                        .as_f64()
                        .unwrap()
                        .total_cmp(&a["generation"].as_f64().unwrap())
                })
                .then_with(|| a["name"].as_str().unwrap().cmp(b["name"].as_str().unwrap()))
        });
        let mut groups = HashSet::new();
        let mut retained = 0u64;
        let mut removed = 0u64;
        let mut count = 0;
        let now = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)?
            .as_secs_f64()
            * 1000.;
        for e in entries {
            let bytes = e["bytes"].as_u64().unwrap();
            let group = e["group"].as_str().unwrap();
            let ready = e["ready"] == true;
            let keep = mode == "prune"
                && ready
                && !groups.contains(group)
                && now - e["modified"].as_f64().unwrap() <= 604800000.
                && retained + bytes <= 1024 * 1024 * 1024;
            if ready {
                groups.insert(group.to_owned());
            }
            if keep {
                retained += bytes;
                continue;
            }
            let dir = root.join(e["name"].as_str().unwrap());
            stamp(&dir)?;
            let mut files: Vec<&str> = e["files"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s.as_str().unwrap())
                .collect();
            files.sort_by_key(|s| {
                if *s == "ready.json" {
                    0
                } else if *s == "capture.json" {
                    2
                } else {
                    1
                }
            });
            for f in files {
                fs::remove_file(dir.join(f))?;
            }
            fs::remove_dir(dir)?;
            removed += bytes;
            count += 1;
        }
        sync_dir(&root)?;
        return Ok(
            json!({"removedBytes":removed,"removedGenerations":count,"bytes":retained,"protectedEntries":protected}),
        );
    }
    let id = &q["snapshot"];
    let frame = q.get("frame");
    let dir = root.join(key(id, frame)?);
    if op == "manifest" {
        return manifest(&root, id, frame);
    }
    if op == "verify" {
        let m = manifest(&root, id, frame)?;
        for (i, p) in m["parts"].as_array().unwrap().iter().enumerate() {
            let b = bounded(&dir.join(format!("part-{i}.bin")), PART)?;
            check(
                b.len() as f64 == p["bytes"].as_f64().unwrap() && hash(&b) == p["sha256"],
                "Corrupt snapshot part",
            )?;
        }
        let mut result = json!({"calls":m["parts"].as_array().unwrap().len(),"bytes":m["parts"].as_array().unwrap().iter().map(|p|p["bytes"].as_f64().unwrap() as u64).sum::<u64>()});
        if q["includeManifest"] == true {
            result["manifest"] = m;
        }
        return Ok(result);
    }
    if op == "part" {
        let m = manifest(&root, id, frame)?;
        let seq = q["sequence"].as_u64().ok_or("Invalid part sequence")? as usize;
        let parts = m["parts"].as_array().unwrap();
        check(seq < parts.len(), "Invalid part sequence")?;
        let b = bounded(&dir.join(format!("part-{seq}.bin")), PART)?;
        check(
            b.len() as f64 == parts[seq]["bytes"].as_f64().unwrap()
                && hash(&b) == parts[seq]["sha256"],
            "Corrupt snapshot part",
        )?;
        return Ok(json!(STANDARD.encode(b)));
    }
    if op == "begin" {
        mkdir(&dir)?;
        let s = stamp(&dir)?;
        let mut owner = json!({"owner":"figma-kilo-mcp","version":1,"snapshot":id});
        if let Some(f) = frame {
            owner["frame"] = f.clone();
        }
        write(&dir.join("capture.json"), &serde_json::to_vec(&owner)?)?;
        sync_dir(&dir)?;
        sync_dir(&root)?;
        return Ok(json!(s));
    }
    check(
        stamp(&dir)? == text(q, "stamp")?,
        "Generation directory was replaced",
    )?;
    match op {
        "append" => {
            let seq = q["sequence"].as_u64().ok_or("Invalid part sequence")?;
            check(seq < 10000, "Invalid part sequence or part limit")?;
            let s = text(q, "data")?;
            check(
                s.len() <= PART.div_ceil(3) * 4,
                "Part or snapshot size limit exceeded",
            )?;
            let b = STANDARD.decode(s)?;
            check(
                !b.is_empty() && b.len() <= PART,
                "Part or snapshot size limit exceeded",
            )?;
            write(&dir.join(format!("part-{seq}.bin")), &b)?;
            Ok(json!({"bytes":b.len(),"sha256":hash(&b)}))
        }
        "prepare" => {
            let b = serde_json::to_vec(&q["manifest"])?;
            check(b.len() <= 2 * 1024 * 1024, "Metadata size limit exceeded")?;
            write(&dir.join("manifest.tmp"), &b)?;
            Ok(Value::Null)
        }
        "publish" => {
            fs::rename(dir.join("manifest.tmp"), dir.join("ready.json"))?;
            if let Err(e) = sync_dir(&dir) {
                let _ = fs::remove_file(dir.join("ready.json"));
                return Err(e);
            }
            Ok(Value::Null)
        }
        "unpublish" => {
            fs::remove_file(dir.join("ready.json"))?;
            sync_dir(&dir)?;
            Ok(Value::Null)
        }
        "guard" => Ok(Value::Null),
        _ => Err("Unknown store operation".into()),
    }
}
pub fn run() -> Result<()> {
    let mut bytes = vec![];
    io::stdin()
        .lock()
        .take((12 * 1024 * 1024 + 1) as u64)
        .read_to_end(&mut bytes)?;
    check(
        bytes.len() <= 12 * 1024 * 1024,
        "Store request limit exceeded",
    )?;
    let q: Value = serde_json::from_slice(&bytes)?;
    let result = match command(&q) {
        Ok(v) => json!({"result":v}),
        Err(e) => {
            let code = e.downcast_ref::<io::Error>().map(|e| match e.kind() {
                io::ErrorKind::NotFound => "ENOENT",
                io::ErrorKind::AlreadyExists => "EEXIST",
                io::ErrorKind::PermissionDenied => "EACCES",
                _ => "EIO",
            });
            json!({"error":e.to_string(),"code":code})
        }
    };
    let b = serde_json::to_vec(&result)?;
    check(b.len() <= 12 * 1024 * 1024, "Store response limit exceeded")?;
    io::stdout().lock().write_all(&b)?;
    Ok(())
}

/// Read-only entry point for the already-owned snapshot process. No write replay.
pub fn retained_verify(q: &Value) -> Result<Value> {
    check(q["op"] == "verify", "Invalid retained store operation")?;
    command(q)
}
