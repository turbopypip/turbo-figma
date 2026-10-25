use std::io::{self, BufRead, Read, Write};
use std::time::Duration;

const LIMIT: usize = 65536;

// One bounded request per process. stdout is exclusively protocol data.
fn main() -> io::Result<()> {
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
