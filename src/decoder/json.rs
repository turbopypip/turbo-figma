//! JSON storage semantics: JSON.stringify maps nonfinite numbers to null,
//! negative zero to zero, and uses decimal notation for [1e-6, 1e21).
use crate::disk::Result;
use serde_json::Value;
use std::io::Write;
pub fn bytes(v: &Value) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    write(v, &mut out)?;
    Ok(out)
}
fn write(v: &Value, w: &mut impl Write) -> Result<()> {
    match v {
        Value::Number(n) => {
            let x = n.as_f64().ok_or("Invalid JSON number")?;
            if !x.is_finite() {
                w.write_all(b"null")?;
            } else if x == 0. {
                w.write_all(b"0")?;
            } else {
                let text = x.abs().to_string();
                let (whole, frac) = text.split_once('.').unwrap_or((&text, ""));
                let digits = format!("{whole}{frac}");
                let first = digits.bytes().position(|b| b != b'0').unwrap();
                let exp = whole.len() as i32 - first as i32 - 1;
                let sig = digits[first..].trim_end_matches('0');
                if x < 0. {
                    w.write_all(b"-")?;
                }
                if (-6..21).contains(&exp) {
                    w.write_all(text.as_bytes())?;
                } else {
                    w.write_all(&sig.as_bytes()[..1])?;
                    if sig.len() > 1 {
                        w.write_all(b".")?;
                        w.write_all(&sig.as_bytes()[1..])?;
                    }
                    write!(w, "e{}{exp}", if exp >= 0 { "+" } else { "" })?;
                }
            }
        }
        Value::Array(a) => {
            w.write_all(b"[")?;
            for (i, v) in a.iter().enumerate() {
                if i > 0 {
                    w.write_all(b",")?;
                }
                write(v, w)?;
            }
            w.write_all(b"]")?;
        }
        Value::Object(a) => {
            w.write_all(b"{")?;
            for (i, (k, v)) in a.iter().enumerate() {
                if i > 0 {
                    w.write_all(b",")?;
                }
                serde_json::to_writer(&mut *w, k)?;
                w.write_all(b":")?;
                write(v, w)?;
            }
            w.write_all(b"}")?;
        }
        _ => serde_json::to_writer(w, v)?,
    }
    Ok(())
}
