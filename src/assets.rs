use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::Path,
};
use unicode_normalization::UnicodeNormalization;
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
fn check(b: bool, msg: &str) -> Result<()> {
    if b {
        Ok(())
    } else {
        Err(msg.into())
    }
}
fn field<'a>(v: &'a Value, k: &str, limit: usize) -> Result<&'a str> {
    let s = v[k].as_str().ok_or("Invalid image field")?;
    check(
        s.encode_utf16().count() <= limit,
        "Image field limit exceeded",
    )?;
    Ok(s)
}
fn decode(v: &Value) -> Result<Vec<u8>> {
    field(v, "nodeId", 100)?;
    field(v, "name", 500)?;
    let format = field(v, "format", 3)?;
    check(format == "PNG" || format == "SVG", "Invalid image format")?;
    if let Some(s) = v.get("scale") {
        check(
            s.as_f64().is_some_and(|s| s.is_finite() && s > 0.),
            "Invalid image scale",
        )?;
    }
    if let Some(s) = v.get("scaleBasis") {
        check(s == "clipboard" || s == "native-export", "Invalid image scale basis")?;
    }
    let s = field(v, "data", 4 * 1024 * 1024)?;
    let b = STANDARD.decode(s).map_err(|_| "Invalid base64 image")?;
    check(
        !b.is_empty() && b.len() <= 3 * 1024 * 1024,
        "Image exceeds 3 MiB limit or is empty",
    )?;
    if format == "PNG" {
        check(b.starts_with(b"\x89PNG\r\n\x1a\n"), "Invalid PNG signature")?;
    } else {
        let text = String::from_utf8_lossy(&b);
        check(
            text.match_indices("<svg").any(|(i, _)| {
                text[i + 4..].chars().next().is_some_and(|c| {
                    matches!(
                        c,
                        '>' | '\t'
                            | '\n'
                            | '\u{b}'
                            | '\u{c}'
                            | '\r'
                            | ' '
                            | '\u{a0}'
                            | '\u{1680}'
                            | '\u{2000}'
                            ..='\u{200a}'
                                | '\u{2028}'
                                | '\u{2029}'
                                | '\u{202f}'
                                | '\u{205f}'
                                | '\u{3000}'
                                | '\u{feff}'
                    )
                })
            }),
            "Invalid SVG",
        )?;
    }
    Ok(b)
}
pub fn command(q: &Value) -> Result<Value> {
    let v = &q["image"];
    let bytes = decode(v)?;
    if q["op"] == "decode" {
        let mut result =
            json!({"nodeId":v["nodeId"],"name":v["name"],"format":v["format"],"data":v["data"]});
        for k in ["scale", "scaleBasis"] {
            if let Some(x) = v.get(k) {
                result[k] = x.clone();
            }
        }
        return Ok(result);
    }
    check(q["op"] == "write", "Unknown asset operation")?;
    let root = Path::new(q["root"].as_str().ok_or("Invalid asset root")?);
    check(
        root.is_absolute() && crate::platform::canonicalize(root)? == root,
        "Asset directory was replaced",
    )?;
    let normalized: String = v["name"]
        .as_str()
        .unwrap()
        .nfkc()
        .map(|c| {
            if c.is_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    // Bound in UTF-16 units, keeping valid Unicode even at an astral boundary.
    let mut stem = String::new();
    let mut units = 0;
    for c in normalized.chars() {
        units += c.len_utf16();
        if units > 48 {
            break;
        }
        stem.push(c);
    }
    if stem.is_empty() {
        stem.push_str("asset");
    }
    let mut random = [0u8; 16];
    crate::platform::random(&mut random)?;
    let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let target = root.join(format!(
        "figma-{stem}-{suffix}.{}",
        v["format"].as_str().unwrap().to_lowercase()
    ));
    let mut o = OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let mut f = o.open(&target)?;
    if let Err(e) = f.write_all(&bytes) {
        drop(f);
        let _ = fs::remove_file(&target);
        return Err(e.into());
    }
    drop(f);
    let mut result =
        json!({"nodeId":v["nodeId"],"path":target,"bytes":bytes.len(),"format":v["format"]});
    for k in ["scale", "scaleBasis"] {
        if let Some(x) = v.get(k) {
            result[k] = x.clone();
        }
    }
    Ok(result)
}
pub fn run() -> Result<()> {
    let mut b = vec![];
    io::stdin()
        .lock()
        .take(6 * 1024 * 1024 + 1)
        .read_to_end(&mut b)?;
    check(b.len() <= 6 * 1024 * 1024, "Asset request limit exceeded")?;
    let q: Value = serde_json::from_slice(&b)?;
    let result = match command(&q) {
        Ok(v) => json!({"result":v}),
        Err(e) => json!({"error":e.to_string()}),
    };
    serde_json::to_writer(io::stdout().lock(), &result)?;
    Ok(())
}
