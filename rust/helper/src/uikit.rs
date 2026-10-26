//! Flat UI-kit declarations and exact CSS value matching. Never evaluates Sass.
use crate::{disk::Result, instances::array};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs::File, io::Read, path::Path};
#[derive(Default)]
pub struct Variables {
    pub entries: Vec<(String, String)>,
    pub aliases: Vec<String>,
}
fn identifier(s: &str) -> bool {
    s.starts_with("--")
        && s.len() > 2
        && s[2..]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
pub fn parse(source: &str) -> Result<Variables> {
    let mut cleaned = String::new();
    let mut rest = source;
    while let Some(i) = rest.find("/*") {
        cleaned.push_str(&rest[..i]);
        if let Some(end) = rest[i + 2..].find("*/") {
            rest = &rest[i + 2 + end + 2..];
        } else {
            rest = &rest[i..];
            break;
        }
    }
    cleaned.push_str(rest);
    let cleaned = cleaned
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut rest = cleaned.trim();
    let mut bodies = vec![];
    while !rest.is_empty() {
        let tail=rest.strip_prefix(":root").ok_or("variablesFile supports flat :root declarations only; Sass imports, nesting and theme selectors must be exported to a separate flat file.")?.trim_start();
        let tail=tail.strip_prefix('{').ok_or("variablesFile supports flat :root declarations only; Sass imports, nesting and theme selectors must be exported to a separate flat file.")?;
        let end=tail.find('}').ok_or("variablesFile supports flat :root declarations only; Sass imports, nesting and theme selectors must be exported to a separate flat file.")?;
        if tail[..end].contains('{') {
            return Err("variablesFile supports flat :root declarations only; Sass imports, nesting and theme selectors must be exported to a separate flat file.".into());
        }
        bodies.push(&tail[..end]);
        rest = tail[end + 1..].trim();
    }
    let mut declarations: Vec<(String, Vec<String>)> = vec![];
    for body in bodies {
        let mut start = 0;
        for (i, c) in body.char_indices() {
            if c != ';' {
                continue;
            }
            let piece = &body[start..i];
            start = i + 1;
            if let Some(begin) = piece.find("--") {
                let piece = &piece[begin..];
                if let Some((name, value)) = piece.split_once(':') {
                    let name = name.trim_end();
                    if identifier(name) && !value.trim().is_empty() {
                        if let Some((_, values)) = declarations.iter_mut().find(|(k, _)| k == name)
                        {
                            values.push(value.trim().into());
                        } else {
                            declarations.push((name.into(), vec![value.trim().into()]));
                        }
                    }
                }
            }
        }
    }
    let mut expanded_bytes = 0usize;
    let mut result = Variables::default();
    for (name, values) in &declarations {
        if values[0].starts_with("var(") {
            result.aliases.push(name.clone());
        }
        let mut key = name.as_str();
        let mut seen = HashSet::new();
        loop {
            if !seen.insert(key) {
                break;
            }
            let Some((_, values)) = declarations.iter().find(|(k, _)| k == key) else {
                break;
            };
            if values.len() != 1 {
                break;
            }
            let value = &values[0];
            if let Some(alias) = value
                .strip_prefix("var(")
                .and_then(|v| v.strip_suffix(')'))
                .map(str::trim)
                .filter(|v| identifier(v))
            {
                key = alias;
            } else {
                expanded_bytes += name.len() + value.len() + 32;
                if expanded_bytes > 2 * 1024 * 1024 {
                    return Err("Network UI-kit expanded value byte limit exceeded".into());
                }
                result.entries.push((name.clone(), value.clone()));
                break;
            }
        }
    }
    if result.entries.len() > 8192 || result.entries.iter().any(|(n, _)| n.len() > 256) {
        return Err(
            "Network UI-kit limit: at most 8192 variables with names up to 256 characters".into(),
        );
    }
    Ok(result)
}
impl Variables {
    pub fn value(&self) -> Value {
        json!({"entries":self.entries,"aliases":self.aliases,"fingerprint":self.fingerprint()})
    }
    pub fn from_value(v: &Value) -> Result<Self> {
        let entries = v["entries"].as_array().ok_or("Invalid UI-kit variables")?;
        if entries.len() > 8192 {
            return Err("Network UI-kit limit exceeded".into());
        }
        let mut out = Self::default();
        let mut bytes = 0usize;
        for e in entries {
            let key = e[0]
                .as_str()
                .filter(|s| s.len() <= 256)
                .ok_or("Invalid UI-kit variable name")?;
            let value = e[1].as_str().ok_or("Invalid UI-kit value")?;
            bytes += key.len() + value.len() + 32;
            if bytes > 2 * 1024 * 1024 {
                return Err("Network UI-kit expanded value byte limit exceeded".into());
            }
            out.entries.push((key.into(), value.into()));
        }
        out.aliases = array(&v["aliases"])
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        Ok(out)
    }
    pub fn fingerprint(&self) -> String {
        Sha256::digest(crate::json::bytes(&json!([self.entries, self.aliases])).unwrap())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }
}
pub fn load(input: &str) -> Result<Variables> {
    let mut path = input.trim();
    if path.len() >= 2
        && ((path.starts_with('"') && path.ends_with('"'))
            || (path.starts_with('\'') && path.ends_with('\'')))
    {
        path = &path[1..path.len() - 1];
    }
    if !cfg!(windows)
        && !path.starts_with('/')
        && (path.starts_with("\\\\") || path.as_bytes().get(1) == Some(&b':'))
    {
        return Err("Windows variablesFile must be read by MCP running on Windows. Provide a local path on this machine.".into());
    }
    if !Path::new(path).is_absolute() {
        return Err("variablesFile must be an absolute local path.".into());
    }
    let lower = path.to_lowercase();
    if !lower.ends_with(".css") && !lower.ends_with(".scss") {
        return Err("variablesFile must be a .scss or .css file.".into());
    }
    let file = File::open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || meta.len() > 2 * 1024 * 1024 {
        return Err("variablesFile must be a regular file up to 2 MiB.".into());
    }
    let mut bytes = vec![];
    file.take(2 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("variablesFile exceeds 2 MiB.".into());
    }
    parse(&String::from_utf8_lossy(&bytes))
}
fn number(s: &str, negative: bool) -> Option<f64> {
    let s = if negative {
        s.strip_prefix('-').unwrap_or(s)
    } else {
        s
    };
    if s.is_empty() {
        return None;
    }
    let parts: Vec<_> = s.split('.').collect();
    if parts.len() > 2
        || !parts.iter().all(|p| p.bytes().all(|b| b.is_ascii_digit()))
        || parts.last()?.is_empty()
    {
        return None;
    }
    s.parse::<f64>().ok().filter(|n| n.is_finite())
}
fn normalize(s: &str) -> String {
    let s = s.trim();
    let (num, unit) = ["px", "rem", "em", "%"]
        .iter()
        .find_map(|u| s.strip_suffix(u).map(|n| (n, *u)))
        .unwrap_or((s, ""));
    if number(num, true).is_some() {
        format!("{}{}", crate::layout::num(num.parse().unwrap()), unit)
    } else {
        s.into()
    }
}
fn color(s: &str) -> Option<[f64; 4]> {
    let owned = s.trim().to_lowercase();
    let s = match owned.as_str() {
        "white" => "#ffffff",
        "black" => "#000000",
        "transparent" => "#00000000",
        s => s,
    };
    if let Some(hex) = s.strip_prefix('#') {
        if ![3, 4, 6, 8].contains(&hex.len()) || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let hex = if hex.len() < 5 {
            hex.chars().flat_map(|c| [c, c]).collect::<String>()
        } else {
            hex.into()
        };
        let mut out = [0., 0., 0., 1.];
        for (i, v) in out.iter_mut().enumerate().take(hex.len() / 2) {
            *v = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()? as f64
                / if i == 3 { 255. } else { 1. };
        }
        return Some(out);
    }
    let body = s
        .strip_prefix("rgb(")
        .or_else(|| s.strip_prefix("rgba("))?
        .strip_suffix(')')?;
    let compact = body
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>();
    if compact.starts_with([',', '/'])
        || compact.ends_with([',', '/'])
        || compact
            .as_bytes()
            .windows(2)
            .any(|w| b",/".contains(&w[0]) && b",/".contains(&w[1]))
    {
        return None;
    }
    let parts: Vec<_> = body
        .split(|c: char| c.is_whitespace() || c == ',' || c == '/')
        .filter(|s| !s.is_empty())
        .collect();
    if !(3..=4).contains(&parts.len()) {
        return None;
    }
    let mut out = [0., 0., 0., 1.];
    for (i, p) in parts.iter().enumerate() {
        let n = number(p.strip_suffix('%').unwrap_or(p), false)?;
        out[i] = n * if p.ends_with('%') {
            if i == 3 {
                1. / 100.
            } else {
                255. / 100.
            }
        } else {
            1.
        };
        if out[i] > if i == 3 { 1. } else { 255. } {
            return None;
        }
    }
    Some(out)
}
fn font(s: &str) -> String {
    s.split(',')
        .map(|s| {
            let s = s.trim();
            if s.len() >= 2
                && ((s.starts_with('"') && s.ends_with('"'))
                    || (s.starts_with('\'') && s.ends_with('\'')))
            {
                s[1..s.len() - 1].to_lowercase()
            } else {
                s.to_lowercase()
            }
        })
        .collect::<Vec<_>>()
        .join(",")
}
fn is_color(p: &str) -> bool {
    if [
        "color",
        "background-color",
        "outline-color",
        "text-decoration-color",
        "column-rule-color",
        "fill",
        "stroke",
        "caret-color",
        "accent-color",
    ]
    .contains(&p)
    {
        return true;
    }
    if p == "border-color" {
        return true;
    }
    p.strip_prefix("border-")
        .and_then(|s| s.strip_suffix("-color"))
        .is_some_and(|s| {
            [
                "top",
                "right",
                "bottom",
                "left",
                "block",
                "inline",
                "block-start",
                "block-end",
                "inline-start",
                "inline-end",
                "top-start",
                "top-end",
                "right-start",
                "right-end",
                "bottom-start",
                "bottom-end",
                "left-start",
                "left-end",
            ]
            .contains(&s)
        })
}
fn category(p: &str) -> u8 {
    if p == "padding"
        || p.starts_with("padding-")
        || p == "margin"
        || p.starts_with("margin-")
        || [
            "gap",
            "row-gap",
            "column-gap",
            "width",
            "height",
            "min-width",
            "min-height",
            "max-width",
            "max-height",
            "top",
            "right",
            "bottom",
            "left",
            "inset",
            "line-height",
            "flex-basis",
        ]
        .contains(&p)
        || p.starts_with("inset-")
    {
        1
    } else if p.starts_with("border-") && p.ends_with("-radius") {
        2
    } else if p.starts_with("border-") && p.ends_with("-width") {
        3
    } else {
        match p {
            "font-size" => 4,
            "font-weight" => 5,
            "font-family" => 6,
            _ => 0,
        }
    }
}
fn group(g: u8, n: &str) -> bool {
    match g {
        1 => n.starts_with("--mimir-space-"),
        2 => ["--mimir-control-radius", "--mimir-control-input-radius"]
            .iter()
            .any(|p| n == *p || n.starts_with(&format!("{p}-"))),
        3 => n == "--mimir-control-border-width",
        4 => n.starts_with("--mimir-size-text-"),
        5 => n.starts_with("--mimir-font-weight-text-"),
        6 => ["--mimir-font-inter", "--mimir-font-montserrat"].contains(&n),
        _ => false,
    }
}
fn color_candidates(vars: &Variables, actual: &str) -> Vec<String> {
    let Some(key) = color(actual) else {
        return vec![];
    };
    vars.entries
        .iter()
        .filter(|(n, v)| {
            !vars.aliases.contains(n) && !n.starts_with("--gos-znak-") && color(v) == Some(key)
        })
        .map(|(n, _)| n.clone())
        .collect()
}
fn map_layout(layout: &Value, vars: &Variables) -> Value {
    if !layout["css"].is_object() {
        return layout.clone();
    }
    let mut result = layout.clone();
    let css = layout["css"].as_object().unwrap();
    let mut mapped = layout["css"].clone();
    let mut matches = vec![];
    for (property, actual) in css {
        let Some(actual) = actual.as_str() else {
            continue;
        };
        let g = category(property);
        let colored = is_color(property);
        if g == 0 && !colored {
            matches.push(
                json!({"property":property,"value":actual,"candidates":[],"status":"unsupported"}),
            );
            continue;
        }
        let mut match_part = |part: &str| {
            let mut comparable = part.to_owned();
            if property == "line-height" {
                let raw = part
                    .strip_suffix("em")
                    .or_else(|| part.strip_suffix('%'))
                    .unwrap_or(part);
                if let (Some(n), Some(px)) = (
                    number(raw, false),
                    css.get("font-size")
                        .and_then(Value::as_str)
                        .and_then(|s| s.strip_suffix("px"))
                        .filter(|s| !s.starts_with('.'))
                        .and_then(|s| number(s, false)),
                ) {
                    comparable = format!(
                        "{}px",
                        crate::layout::num(n * px / if part.ends_with('%') { 100. } else { 1. })
                    );
                }
            }
            let candidates = if colored {
                color_candidates(vars, part)
            } else {
                vars.entries
                    .iter()
                    .filter(|(name, v)| {
                        group(g, name)
                            && if property == "font-family" {
                                let a = font(part);
                                let b = font(v);
                                a == b
                                    || !a.contains(',') && Some(a.as_str()) == b.split(',').next()
                            } else {
                                normalize(v) == normalize(&comparable)
                            }
                    })
                    .map(|(n, _)| n.clone())
                    .collect::<Vec<_>>()
            };
            let matched = if colored {
                !candidates.is_empty()
            } else {
                candidates.len() == 1
            };
            matches.push(json!({"property":property,"value":part,"candidates":candidates.iter().take(32).collect::<Vec<_>>(),"status":if matched{"matched"}else if candidates.is_empty(){"not-found"}else{"ambiguous"},"source":"ui-kit-value-match","candidateCount":candidates.len(),"candidatesTruncated":candidates.len()>32,"selectionPolicy":if colored{"first-literal-color"}else{"unique-category-match"},"ambiguous":candidates.len()>1}));
            if matched {
                format!("var({})", candidates[0])
            } else {
                part.into()
            }
        };
        let value = if [
            "padding",
            "margin",
            "gap",
            "inset",
            "border-radius",
            "border-width",
        ]
        .contains(&property.as_str())
            && !actual.is_empty()
            && actual
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c.is_whitespace() || "-./%".contains(c))
        {
            let mut out = String::new();
            let mut part = String::new();
            for c in actual.chars() {
                if c.is_whitespace() || c == '/' {
                    if !part.is_empty() {
                        out.push_str(&match_part(&part));
                        part.clear();
                    }
                    out.push(c);
                } else {
                    part.push(c);
                }
            }
            if !part.is_empty() {
                out.push_str(&match_part(&part));
            }
            out
        } else {
            match_part(actual)
        };
        mapped[property] = json!(value);
    }
    result["cssText"] = json!(mapped
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| format!("{k}: {};", v.as_str().unwrap_or("")))
        .collect::<Vec<_>>()
        .join("\n"));
    result["css"] = mapped;
    result["resolvedValues"] = layout["css"].clone();
    result["variableMatching"] = json!(matches);
    result["colors"] = json!([]);
    result
}
pub fn map_node(node: &Value, vars: &Variables) -> Result<Value> {
    let mut bytes = 0;
    let mut map = |v: &Value| -> Result<Value> {
        let v = map_layout(v, vars);
        bytes += crate::json::bytes(&v)?.len();
        if bytes > 100000 {
            Err("Variable mapping byte limit".into())
        } else {
            Ok(v)
        }
    };
    let result = (|| -> Result<Value> {
        let mut out = node.clone();
        if node.get("layout").is_some() {
            out["layout"] = map(&node["layout"])?;
        }
        if node.get("style").is_some() {
            out["style"] = map(&node["style"])?;
            if node["style"].get("text").is_some() {
                let mut t = node["style"]["text"].clone();
                t["base"] = map(&t["base"])?;
                t["ranges"] = json!(array(&t["ranges"])
                    .iter()
                    .map(&mut map)
                    .collect::<Result<Vec<_>>>()?);
                out["style"]["text"] = t;
            }
        }
        Ok(out)
    })();
    match result {
        Err(e) if e.to_string() == "Variable mapping byte limit" => {
            let mut v = json!({"propertiesOmitted":"Node properties including variable matches exceed normalization byte limit"});
            for k in ["id", "parentId", "depth", "type"] {
                if let Some(x) = node.get(k) {
                    v[k] = x.clone();
                }
            }
            Ok(v)
        }
        r => r,
    }
}
pub fn command(q: &Value) -> Result<Value> {
    match q["op"].as_str() {
        Some("load") => Ok(load(q["path"].as_str().ok_or("Invalid variables path")?)?.value()),
        Some("parse") => {
            Ok(parse(q["source"].as_str().ok_or("Invalid variables source")?)?.value())
        }
        Some("map") => {
            let vars = Variables::from_value(&q["variables"])?;
            Ok(json!(array(&q["nodes"])
                .iter()
                .map(|n| map_node(n, &vars))
                .collect::<Result<Vec<_>>>()?))
        }
        _ => Err("Invalid UI-kit operation".into()),
    }
}
pub fn run() -> Result<()> {
    let mut b = vec![];
    std::io::stdin()
        .take(3 * 1024 * 1024 + 1)
        .read_to_end(&mut b)?;
    if b.len() > 3 * 1024 * 1024 {
        return Err("UI-kit input limit exceeded".into());
    }
    let q = serde_json::from_slice(&b)?;
    let result = match command(&q) {
        Ok(r) => json!({"result":r}),
        Err(e) => json!({"error":e.to_string()}),
    };
    use std::io::Write;
    std::io::stdout().write_all(&crate::json::bytes(&result)?)?;
    Ok(())
}
