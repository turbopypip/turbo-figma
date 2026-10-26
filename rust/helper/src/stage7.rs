//! Experimental stream and isolated decoder benchmark, no production switch.
use crate::{
    stage6,
    wire::{Decoder, Value},
};
use serde_json::json;
use std::{
    collections::HashSet,
    io::{self, Read, Write},
    path::Path,
    time::Instant,
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
fn packet(w: &mut impl Write, kind: u8, b: &[u8]) -> Result<()> {
    w.write_all(&((b.len() + 1) as u32).to_le_bytes())?;
    w.write_all(&[kind])?;
    w.write_all(b)?;
    Ok(())
}
fn value(w: &mut impl Write, kind: u8, v: Value) -> Result<()> {
    let mut b = Vec::new();
    v.write(&mut b)?;
    packet(w, kind, &b)
}
pub fn run(mode: &str, config: Option<&str>) -> Result<()> {
    let c: serde_json::Value = serde_json::from_slice(&stage6::bounded(
        Path::new(config.ok_or("Config required")?),
        65536,
    )?)?;
    let fields: HashSet<String> = c["fields"]
        .as_array()
        .ok_or("Fields required")?
        .iter()
        .map(|s| s.as_str().map(str::to_owned).ok_or("Invalid fields"))
        .collect::<std::result::Result<_, _>>()?;
    if mode == "stream" {
        let mut w = io::BufWriter::new(io::stdout().lock());
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
                    packet(&mut w, b'S', &schema)?;
                } else {
                    let d = codec.as_ref().ok_or("Missing wire schema")?;
                    let bytes = stage6::inflate(b, stage6::FRAME)?;
                    let message = d.decode(&bytes, &mut |v| value(&mut w, b'N', v))?;
                    value(&mut w, b'M', message)?;
                }
                Ok(())
            },
        )?;
        w.flush()?;
        return Ok(());
    }
    if mode != "decode" && mode != "bench" {
        return Err("Unknown stage7 operation".into());
    }
    let schema = stage6::bounded(
        Path::new(c["schema"].as_str().ok_or("Schema required")?),
        2 * 1024 * 1024,
    )?;
    let warm = c["warmup"].as_u64().unwrap_or(0);
    let runs = c["runs"].as_u64().unwrap_or(1);
    if warm > 100 || runs == 0 || runs > 1000 {
        return Err("Invalid runs".into());
    }
    let mut schema_times = Vec::new();
    let mut times = Vec::new();
    let mut count = 0;
    let start_cpu = stage6::metrics()["cpuMs"].as_f64();
    for i in 0..warm + runs {
        let at = Instant::now();
        let decoder = Decoder::new(&schema, &fields)?;
        let schema_ms = at.elapsed().as_secs_f64() * 1000.;
        let mut input = std::fs::File::open(c["messages"].as_str().ok_or("Messages required")?)?;
        let mut decode_ms = 0.;
        count = 0;
        loop {
            let mut h = [0; 4];
            if input.read(&mut h[..1])? == 0 {
                break;
            }
            input.read_exact(&mut h[1..])?;
            let n = u32::from_le_bytes(h) as usize;
            if n > stage6::FRAME {
                return Err("Wire frame size limit exceeded".into());
            }
            let mut b = vec![0; n];
            input.read_exact(&mut b)?;
            let before = Instant::now();
            let m = decoder.decode(&b, &mut |v| {
                count += 1;
                if mode == "decode" {
                    value(&mut io::stdout().lock(), b'N', v)?;
                }
                Ok(())
            })?;
            decode_ms += before.elapsed().as_secs_f64() * 1000.;
            if mode == "decode" {
                value(&mut io::stdout().lock(), b'M', m)?;
            }
        }
        if i >= warm {
            schema_times.push(schema_ms);
            times.push(decode_ms);
        }
    }
    if mode == "bench" {
        println!(
            "{}",
            json!({"times":times,"schemaTimes":schema_times,"result":{"nodes":count},"workCpuMs":start_cpu.zip(stage6::metrics()["cpuMs"].as_f64()).map(|(a,b)|b-a)})
        );
    }
    Ok(())
}
