mod platform;
mod standalone;
mod engine;
mod inspector;
mod uikit;
mod instances;
mod geometry;
mod variable_resolver;
mod bindings;
mod traversal;
mod assets;
mod angle;
mod context;
mod layout;
mod style;
mod disk;
mod frame;
mod json;
mod live;
#[cfg(unix)]
mod mcp;
mod stage6;
mod stage7;
mod stage8;
mod store;
mod websocket;
mod wire;
use std::io::{self, BufRead, Read, Write};
use std::time::Duration;

const LIMIT: usize = 65536;

// One bounded request per process. stdout is exclusively protocol data.
fn main() -> io::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|s| s == "--server") {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
        let result = runtime.block_on(standalone::run(args.get(2).map(String::as_str).unwrap_or(""),args.get(3).map(String::as_str).unwrap_or(".")));
        runtime.shutdown_timeout(Duration::from_secs(2));
        return result.map_err(|e|io::Error::other(e.to_string()));
    }
    if args.get(1).is_some_and(|s| s == "--uikit") { return uikit::run().map_err(|e| io::Error::other(e.to_string())); }
    #[cfg(unix)]
    if args.get(1).is_some_and(|s| s == "--mcp") {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let result = runtime.block_on(mcp::run(args.get(2).map(String::as_str).unwrap_or("")));
        runtime.shutdown_background();
        if let Err(e) = result {
            eprintln!("{e}");
            std::process::exit(1);
        }
        return Ok(());
    }
    if args.get(1).is_some_and(|s| s == "--websocket") {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        if let Err(e) = runtime.block_on(websocket::run()) {
            eprintln!("{e}");
            std::process::exit(1);
        }
        return Ok(());
    }
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
    if args.get(1).is_some_and(|s| s == "--stage8") {
        if let Err(error) = stage8::run(
            args.get(2).map(String::as_str).unwrap_or(""),
            args.get(3).map(String::as_str),
        ) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        eprintln!("STAGE6_METRICS {}", stage6::metrics());
        return Ok(());
    }
    if args.get(1).is_some_and(|s| s == "--stage7") {
        if let Err(error) = stage7::run(
            args.get(2).map(String::as_str).unwrap_or(""),
            args.get(3).map(String::as_str),
        ) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        eprintln!("STAGE6_METRICS {}", stage6::metrics());
        return Ok(());
    }
    if args.get(1).is_some_and(|s| s == "--stage6") {
        if let Err(error) = stage6::run(
            args.get(2).map(String::as_str).unwrap_or(""),
            args.get(3).map(String::as_str),
        ) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        eprintln!("STAGE6_METRICS {}", stage6::metrics());
        return Ok(());
    }
    let mut input = io::stdin().lock().take((LIMIT + 1) as u64);
    let mut line = String::new();
    input.read_line(&mut line)?;
    let response = respond(&line);
    writeln!(io::stdout().lock(), "{response}")
}

fn respond(line: &str) -> String {
    if line.len() > LIMIT || !line.ends_with('\n') {
        return "1\t0\terror\tINVALID_FRAME".into();
    }
    let fields: Vec<_> = line.trim_end_matches('\n').split('\t').collect();
    if fields.len() != 4 || fields[1] != "1" {
        return "1\t0\terror\tINVALID_FRAME".into();
    }
    if fields[0] != "1" {
        return "1\t1\terror\tUNSUPPORTED_VERSION".into();
    }
    match (fields[2], fields[3]) {
        ("ping", "") => "1\t1\tok\tpong".into(),
        ("shutdown", "") => "1\t1\tok\tbye".into(),
        ("delay", value) => match value.parse::<u64>() {
            Ok(ms) if ms <= 60000 => {
                std::thread::sleep(Duration::from_millis(ms));
                "1\t1\tok\tdone".into()
            }
            _ => "1\t1\terror\tINVALID_ARGUMENT".into(),
        },
        // Diagnostic operation: validates host handling of a native crash.
        ("crash", "") => std::process::abort(),
        _ => "1\t1\terror\tUNKNOWN_OPERATION".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn contract() {
        assert_eq!(respond("1\t1\tping\t\n"), "1\t1\tok\tpong");
        assert!(respond("2\t1\tping\t\n").ends_with("UNSUPPORTED_VERSION"));
        assert!(respond("1\t1\tdelay\t60001\n").ends_with("INVALID_ARGUMENT"));
        assert!(respond("1\t1\tping\t").ends_with("INVALID_FRAME"));
        assert!(respond(&"x".repeat(LIMIT + 1)).ends_with("INVALID_FRAME"));
    }
}
