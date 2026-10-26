//! Experimental one-job boundary: decode/index in Rust, bounded query pages out.
use crate::{
    disk::{Disk, Result},
    stage6,
    wire::{Decoder, Value as Wire},
};
use base64::Engine;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs::File,
    io::{self, Read, Write},
    path::Path,
    time::Instant,
};
fn value(w: Wire) -> Value {
    match w {
        Wire::Null => Value::Null,
        Wire::Bool(v) => v.into(),
        Wire::String(v) => v.into(),
        Wire::Num(v) => {
            if !v.is_finite() {
                Value::Null
            } else if v.fract() == 0. && v.abs() <= 9007199254740991. {
                (v as i64).into()
            } else {
                json!(v)
            }
        }
        Wire::Array(a) => a.into_iter().map(value).collect(),
        Wire::Object(a) => Value::Object(a.into_iter().map(|(k, v)| (k, value(v))).collect()),
    }
}
fn packet(w: &mut impl Write, v: &Value) -> Result<()> {
    let b = serde_json::to_vec(v)?;
    if b.len() > 4 * 1024 * 1024 {
        return Err("Output limit exceeded".into());
    }
    w.write_all(&(b.len() as u32).to_le_bytes())?;
    w.write_all(&b)?;
    Ok(())
}
pub fn run(mode: &str, config: Option<&str>) -> Result<()> {
    let c: Value = serde_json::from_slice(&stage6::bounded(
        Path::new(config.ok_or("Config required")?),
        65536,
    )?)?;
    let fields: HashSet<String> = c["fields"]
        .as_array()
        .ok_or("Fields required")?
        .iter()
        .map(|v| v.as_str().map(str::to_owned).ok_or("Invalid fields"))
        .collect::<std::result::Result<_, _>>()?;
    let mut disk = Disk::new(
        Path::new(c["scratch"].as_str().ok_or("Scratch required")?),
        fields.clone(),
    )?;
    let runtime = mode == "runtime";
    let mut wire_schema = Vec::new();
    let start = Instant::now();
    let mut index_ms = 0.;
    if mode == "managed" || runtime {
        let mut codec = None;
        stage6::input(
            Path::new(c["directory"].as_str().ok_or("Directory required")?),
            &c["snapshot"],
            |b| {
                if b.starts_with(b"fig-wire") {
                    if codec.is_some() || b.len() < 12 || b[8..12] != 1_u32.to_le_bytes() {
                        return Err("Unsupported or repeated fig-wire schema".into());
                    }
                    let schema = stage6::inflate(&b[12..], 2 * 1024 * 1024)?;
                    codec = Some(Decoder::new(&schema, &fields)?);
                    if runtime {
                        wire_schema = schema;
                    }
                } else {
                    let d = codec.as_ref().ok_or("Missing wire schema")?;
                    let bytes = stage6::inflate(b, stage6::FRAME)?;
                    let m = d.decode(&bytes, &mut |n| {
                        let t = Instant::now();
                        disk.accept(value(n))?;
                        index_ms += t.elapsed().as_secs_f64() * 1000.;
                        Ok(())
                    })?;
                    disk.message(&value(m))?;
                }
                Ok(())
            },
        )?;
    } else if mode == "model" {
        let mut file = File::open(c["model"].as_str().ok_or("Model required")?)?;
        loop {
            let mut h = [0; 4];
            if file.read(&mut h[..1])? == 0 {
                break;
            }
            file.read_exact(&mut h[1..])?;
            let len = u32::from_le_bytes(h) as usize;
            if len > 2 * 1024 * 1024 {
                return Err("Model record limit exceeded".into());
            }
            let mut b = vec![0; len];
            file.read_exact(&mut b)?;
            let v: Value = serde_json::from_slice(&b)?;
            let t = Instant::now();
            if v["kind"] == "N" {
                disk.accept(v["value"].clone())?
            } else if v["kind"] == "M" {
                disk.message(&v["value"])?
            } else {
                return Err("Invalid model record".into());
            }
            index_ms += t.elapsed().as_secs_f64() * 1000.;
        }
    } else {
        return Err("Unknown stage8 operation".into());
    }
    disk.finish()?;
    let load_ms = start.elapsed().as_secs_f64() * 1000.;
    let mut out = io::BufWriter::new(io::stdout().lock());
    packet(
        &mut out,
        &json!({"kind":"loaded","version":1,"loadMs":load_ms,"indexMs":index_ms,"stats":disk.stats(),"schema":base64::engine::general_purpose::STANDARD.encode(&wire_schema)}),
    )?;
    if runtime {
        out.flush()?;
        let live_codec = crate::live::codec(&wire_schema)?;
        let mut applied = 0usize;
        let mut poisoned = false;
        let mut input = io::stdin().lock();
        loop {
            let mut header = [0; 4];
            if input.read(&mut header[..1])? == 0 {
                break;
            }
            input.read_exact(&mut header[1..])?;
            let len = u32::from_le_bytes(header) as usize;
            if len > 2 * 1024 * 1024 {
                return Err("Request limit exceeded".into());
            }
            let mut bytes = vec![0; len];
            input.read_exact(&mut bytes)?;
            let q: Value = serde_json::from_slice(&bytes)?;
            let result = if poisoned {
                Err("STALE: live index failed; recapture".into())
            } else if q["op"] == "live" {
                let result = (|| -> Result<Value> {
                    let payload = q["payload"].as_str().ok_or("Invalid live payload")?;
                    if payload.len() > 256 * 1024 || applied >= 128 {
                        return Err("Live batch limit exceeded".into());
                    }
                    let bytes = base64::engine::general_purpose::STANDARD.decode(payload)?;
                    if bytes.is_empty() {
                        return Err("Invalid live base64".into());
                    }
                    let bytes = stage6::inflate(&bytes, 1024 * 1024)?;
                    let mut changes = Vec::new();
                    let message = live_codec.decode_strict(&bytes, &mut |n| {
                        if changes.len() >= 256 {
                            return Err("Live change count exceeded".into());
                        }
                        changes.push(value(n));
                        Ok(())
                    })?;
                    if value(message)["type"] != "NODE_CHANGES" {
                        return Err("Unsupported live message type".into());
                    }
                    disk.apply_live(&changes)?;
                    applied += 1;
                    Ok(json!({"applied":applied,"count":disk.count}))
                })();
                if result.is_err() {
                    poisoned = true;
                }
                result
            } else {
                disk.runtime_command(&q)
            };
            let reply = match result {
                Ok(v) => json!({"result":v,"stats":disk.stats()}),
                Err(e) => json!({"error":e.to_string()}),
            };
            packet(&mut out, &reply)?;
            out.flush()?;
        }
        return Ok(());
    }
    let commands = c["commands"].as_array().ok_or("Commands required")?;
    if commands.len() > 1000 {
        return Err("Command limit exceeded".into());
    }
    for q in commands {
        let t = Instant::now();
        let result = match q["op"].as_str() {
            Some("query") => disk.query(q),
            Some("lookup") => {
                let key = q["id"].as_str().ok_or("Invalid node GUID")?;
                disk.node(key, false)
            }
            Some("children") => {
                let key = q["id"].as_str().ok_or("Invalid node GUID")?;
                disk.children(key).map(|v| json!(v))
            }
            Some("asset") => disk.asset(q["type"].as_str().ok_or("Invalid asset type")?, &q["ref"]),
            Some("release") => {
                disk.clear();
                Ok(Value::Null)
            }
            _ => Err("Unknown index command".into()),
        };
        let reply = match result {
            Ok(result) => json!({"result":result}),
            Err(e) => json!({"error":e.to_string()}),
        };
        packet(
            &mut out,
            &json!({"kind":"reply","reply":reply,"ms":t.elapsed().as_secs_f64()*1000.,"stats":disk.stats(),"metrics":stage6::metrics()}),
        )?;
    }
    out.flush()?;
    Ok(())
}
