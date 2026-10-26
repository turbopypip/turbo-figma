mod assets;
mod platform;
mod server;
mod capture;
mod context;
mod decoder;
mod diagnostics;
mod storage;

use capture::{engine, inspector, live};
use decoder::{frame, json, wire};
use storage::{disk, store};
use context::{angle, bindings, geometry, instances, layout, style, traversal, variable_resolver, uikit};
use decoder::{input, wire_value};
use diagnostics::{decode, index};
use std::io;
use std::time::Duration;

fn main() -> io::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|s| s == "--server") {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
        let result = runtime.block_on(server::run(args.get(2).map(String::as_str).unwrap_or(""),args.get(3).map(String::as_str).unwrap_or(".")));
        runtime.shutdown_timeout(Duration::from_secs(2));
        return result.map_err(|e|io::Error::other(e.to_string()));
    }
    if args.get(1).is_some_and(|s| s == "--uikit") { return uikit::run().map_err(|e| io::Error::other(e.to_string())); }
    if args.get(1).is_some_and(|s| s == "--assets") {
        if let Err(e) = assets::run() {
            eprintln!("{e}");
            std::process::exit(1);
        }
        return Ok(());
    }
    if args.get(1).is_some_and(|s| s == "--store") {
        if let Err(e) = store::run() {
            eprintln!("{e}");
            std::process::exit(1);
        }
        return Ok(());
    }
    if args.get(1).is_some_and(|s| s == "--inspect-index") {
        if let Err(error) = index::run(
            args.get(2).map(String::as_str).unwrap_or(""),
            args.get(3).map(String::as_str),
        ) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        eprintln!("DECODER_METRICS {}", input::metrics());
        return Ok(());
    }
    if args.get(1).is_some_and(|s| s == "--decode") {
        if let Err(error) = decode::run(
            args.get(2).map(String::as_str).unwrap_or(""),
            args.get(3).map(String::as_str),
        ) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        eprintln!("DECODER_METRICS {}", input::metrics());
        return Ok(());
    }
    if args.get(1).is_some_and(|s| s == "--inspect-input") {
        if let Err(error) = input::run(
            args.get(2).map(String::as_str).unwrap_or(""),
            args.get(3).map(String::as_str),
        ) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        eprintln!("DECODER_METRICS {}", input::metrics());
        return Ok(());
    }
    if args.get(1).is_some_and(|s| s == "--diagnostics") {
        return diagnostics::protocol::run();
    }
    Err(io::Error::other("Usage: turbo-figma --server <config.json> <project-directory>"))
}
