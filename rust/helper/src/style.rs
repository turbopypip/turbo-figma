//! Visual values and UTF-16 text ranges. No inferred font names or CSS geometry.
use crate::layout::{num, truthy, Ordered};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
const TEXT: &[&str] = &[
    "fontName",
    "fontSize",
    "lineHeight",
    "letterSpacing",
    "textAlignHorizontal",
    "textAlignVertical",
    "textCase",
    "textDecoration",
    "fontVariations",
    "fontVariantSlashedZero",
    "paragraphSpacing",
    "paragraphIndent",
    "fillPaints",
];
fn pick(v: &Value, keys: &[&str]) -> Value {
    keys.iter()
        .filter_map(|k| v.get(k).map(|v| (k.to_string(), v.clone())))
        .collect()
}
fn finite(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite())
}
fn positive(v: &Value) -> Option<f64> {
    finite(v).filter(|n| *n >= 0.)
}
fn unit(v: &Value) -> Option<f64> {
    positive(v).filter(|n| *n <= 1.)
}
fn number(v: f64) -> String {
    num(if v.abs() < 1e15 {
        let x = v * 1e6;
        let floor = x.floor();
        (if x - floor >= 0.5 { floor + 1. } else { floor }) / 1e6
    } else {
        v
    })
}
fn rgba(c: &Value, opacity: f64) -> Option<String> {
    let r = unit(&c["r"])?;
    let g = unit(&c["g"])?;
    let b = unit(&c["b"])?;
    let a = unit(&c["a"])?;
    let channel = |v: f64| {
        if (((v * 255. + 0.5).floor() / 255.) as f32) == v as f32 {
            num((v * 255. + 0.5).floor())
        } else {
            number(v * 255.)
        }
    };
    Some(format!(
        "rgba({}, {}, {}, {})",
        channel(r),
        channel(g),
        channel(b),
        number(a * opacity)
    ))
}
fn paints(v: &Value, path: &str, issues: &mut Vec<String>) -> Value {
    let Some(a) = v.as_array() else {
        return Value::Null;
    };
    if a.len() > 128 {
        issues.push(format!("{path}.limit"));
        return Value::Null;
    }
    json!(a
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let mut out = pick(p, &["type", "visible", "opacity", "blendMode"]);
            if truthy(&p["color"]) {
                out["color"] = pick(&p["color"], &["r", "g", "b", "a"]);
            }
            if let Some(stops) = p["stops"].as_array() {
                if stops.len() > 128 {
                    issues.push(format!("{path}[{i}].stopsLimit"));
                } else {
                    out["stops"] = json!(stops
                        .iter()
                        .map(|s| {
                            let mut v = pick(s, &["position"]);
                            v["color"] = pick(&s["color"], &["r", "g", "b", "a"]);
                            v
                        })
                        .collect::<Vec<_>>());
                }
            }
            if truthy(&p["transform"]) {
                out["transform"] =
                    pick(&p["transform"], &["m00", "m01", "m02", "m10", "m11", "m12"]);
            }
            let color = if p["type"] == "SOLID" {
                unit(&p["opacity"]).and_then(|o| rgba(&p["color"], o))
            } else {
                None
            };
            if let Some(c) = &color {
                out["paintColor"] = json!(c);
            }
            let css = color.filter(|_| p["blendMode"] == "NORMAL");
            if let Some(c) = &css {
                out["cssColor"] = json!(c);
            }
            if p["visible"] != false && (css.is_none() || p["visible"] != true) {
                issues.push(format!("{path}[{i}].css"));
            }
            if p.as_object()
                .is_some_and(|o| o.keys().any(|k| k.ends_with("Var")))
            {
                out["variableBindingUnresolved"] = json!(true);
            }
            out
        })
        .collect::<Vec<_>>())
}
fn color(v: &Value) -> Option<&str> {
    let active: Vec<_> = v
        .as_array()?
        .iter()
        .filter(|p| p["visible"] != false)
        .collect();
    if active.len() == 1 && active[0]["visible"] == true {
        active[0]["cssColor"].as_str()
    } else {
        None
    }
}
fn active(v: &Value) -> bool {
    v.as_array()
        .is_some_and(|a| a.iter().any(|v| v["visible"] != false))
}
fn typography(n: &Value, metadata: &[Value], issues: &mut Vec<String>) -> (Value, Ordered) {
    let source = pick(
        n,
        &TEXT
            .iter()
            .copied()
            .filter(|k| *k != "fillPaints" && *k != "fontVariations")
            .collect::<Vec<_>>(),
    );
    let mut css = Ordered::default();
    if let Some(f) = n["fontName"]["family"].as_str() {
        let mut quoted = String::from("\"");
        for c in f.chars() {
            if matches!(c, '"' | '\\' | '\n' | '\r' | '\u{c}' | '\0') {
                quoted.push_str(&format!("\\{:x} ", c as u32));
            } else {
                quoted.push(c);
            }
        }
        quoted.push('"');
        css.set("font-family", quoted);
    } else {
        issues.push("font.family".into());
    }
    let matches: Vec<_> = metadata
        .iter()
        .filter(|m| {
            m["key"].get("family") == n["fontName"].get("family")
                && m["key"].get("style") == n["fontName"].get("style")
        })
        .collect();
    let meta = matches
        .first()
        .filter(|first| {
            matches.iter().all(|m| {
                m.get("fontWeight") == first.get("fontWeight")
                    && m.get("fontStyle") == first.get("fontStyle")
            })
        })
        .copied()
        .unwrap_or(&Value::Null);
    if let Some(w) =
        finite(&meta["fontWeight"]).filter(|w| w.fract() == 0. && (1. ..=1000.).contains(w))
    {
        css.set("font-weight", num(w));
    } else {
        issues.push("font.weight".into());
    }
    if matches!(meta["fontStyle"].as_str(), Some("NORMAL" | "ITALIC")) {
        css.set(
            "font-style",
            if meta["fontStyle"] == "ITALIC" {
                "italic"
            } else {
                "normal"
            },
        );
    } else {
        issues.push("font.style".into());
    }
    if let Some(v) = positive(&n["fontSize"]) {
        css.set("font-size", format!("{}px", number(v)));
    } else {
        issues.push("font.size".into());
    }
    for (key, field) in [
        ("line-height", "lineHeight"),
        ("letter-spacing", "letterSpacing"),
    ] {
        let v = &n[field];
        if let Some(x) = finite(&v["value"]).filter(|x| {
            (field != "lineHeight" || *x >= 0.)
                && matches!(v["units"].as_str(), Some("PIXELS" | "PERCENT"))
        }) {
            css.set(
                key,
                if v["units"] == "PIXELS" {
                    format!("{}px", number(x))
                } else if field == "letterSpacing" {
                    format!("{}em", number(x / 100.))
                } else {
                    format!("{}%", number(x))
                },
            );
        } else {
            issues.push(field.into());
        }
    }
    for (field, key, values) in [
        (
            "textAlignHorizontal",
            "text-align",
            &[
                ("LEFT", "left"),
                ("CENTER", "center"),
                ("RIGHT", "right"),
                ("JUSTIFIED", "justify"),
            ][..],
        ),
        (
            "textCase",
            "text-transform",
            &[
                ("ORIGINAL", "none"),
                ("UPPER", "uppercase"),
                ("LOWER", "lowercase"),
                ("TITLE", "capitalize"),
            ][..],
        ),
        (
            "textDecoration",
            "text-decoration-line",
            &[
                ("NONE", "none"),
                ("UNDERLINE", "underline"),
                ("STRIKETHROUGH", "line-through"),
            ][..],
        ),
    ] {
        if n.get(field).is_some() {
            if let Some((_, v)) = values.iter().find(|(s, _)| n[field] == *s) {
                css.set(key, *v);
            } else {
                issues.push(field.into());
            }
        }
    }
    if n["fontVariantSlashedZero"] == true {
        css.set("font-variant-numeric", "slashed-zero");
    }
    if n["fontVariations"]
        .as_array()
        .is_some_and(|a| !a.is_empty())
    {
        issues.push("font.variations".into());
    }
    if truthy(&n["paragraphSpacing"]) || truthy(&n["paragraphIndent"]) {
        issues.push("paragraph.layout".into());
    }
    let fills = paints(&n["fillPaints"], "fills", issues);
    if let Some(c) = color(&fills) {
        css.set("color", c);
    } else if active(&fills) {
        issues.push("fills.composition".into());
    }
    (
        json!({"source":source,"css":css.object(),"fills":fills}),
        css,
    )
}
fn text(n: &Value) -> (Value, Vec<String>) {
    let data = &n["textData"];
    let characters = if data.is_string() {
        data.as_str()
    } else {
        data["characters"].as_str()
    };
    let chars = characters.map(|s| s.encode_utf16().collect::<Vec<_>>());
    let raw = n["derivedTextData"]
        .get("fontMetaData")
        .filter(|v| !v.is_null())
        .or_else(|| data.get("fontMetaData"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut issues = vec![];
    let metadata = if raw.len() > 256 {
        issues.push("font.metadataLimit".into());
        &[][..]
    } else {
        raw
    };
    if data["lines"].as_array().is_some_and(|a| {
        a.iter().any(|l| {
            l["lineType"] != "PLAIN" || finite(&l["indentationLevel"]).is_some_and(|v| v > 0.)
        })
    }) {
        issues.push("paragraph.listLayout".into());
    }
    let ids = data.get("characterStyleIDs");
    let uniform = ids.is_none()
        || ids.and_then(Value::as_array).is_some_and(|a| {
            Some(a.len()) == chars.as_ref().map(Vec::len)
                && a.iter().all(|v| v.as_f64() == Some(0.))
        });
    let font = &n["fontName"];
    let rendered =
        if truthy(&n["derivedTextData"]["fontMetaData"]) && uniform && metadata.len() == 1 {
            &metadata[0]["key"]
        } else {
            &Value::Null
        };
    let mut n = n.clone();
    let substituted = font["family"].is_string()
        && font["style"].is_string()
        && rendered["family"].is_string()
        && rendered["style"].is_string()
        && (font["family"] != rendered["family"] || font["style"] != rendered["style"]);
    if substituted {
        n["fontName"] = rendered.clone();
    }
    let (mut base, base_css) = typography(&n, metadata, &mut issues);
    if substituted {
        base["source"]["requestedFontName"] = font.clone();
        base["source"]["fontNameProvenance"] = json!("derivedTextData.fontMetaData");
    }
    let mut result = json!({"base":base,"ranges":[],"rangeUnit":"utf-16"});
    let mut css_order = vec![];
    // All early returns preserve accumulated diagnostics and clear partial ranges where required.
    let build = (|| -> std::result::Result<(), (&str, bool)> {
        let chars = chars.as_ref().ok_or(("text.characters", false))?;
        let table = data["styleOverrideTable"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        if table.len() > 1024 {
            return Err(("text.styleTableLimit", false));
        }
        let safe_id = |v: &Value| {
            v.as_f64()
                .filter(|v| v.fract() == 0. && *v >= 0. && *v <= 9007199254740991.)
                .map(|v| v as u64)
        };
        let mut styles = BTreeMap::new();
        for entry in table {
            let id = safe_id(&entry["styleID"])
                .filter(|v| *v > 0)
                .ok_or(("text.invalidStyleTable", false))?;
            if styles.insert(id, entry).is_some() {
                return Err(("text.invalidStyleTable", false));
            }
        }
        let indices = if let Some(ids) = ids {
            let a = ids.as_array().ok_or(("text.invalidStyleIndices", false))?;
            if a.len() != chars.len() {
                return Err(("text.invalidStyleIndices", false));
            }
            let mut out = vec![];
            for v in a {
                let id = safe_id(v)
                    .filter(|v| *v == 0 || styles.contains_key(v))
                    .ok_or(("text.invalidStyleIndices", false))?;
                out.push(id);
            }
            Some(out)
        } else {
            None
        };
        let at = |i: usize| indices.as_ref().map(|a| a[i]).unwrap_or(0);
        let mut normalized: BTreeMap<u64, (Value, Vec<String>)> = BTreeMap::new();
        let mut start = 0;
        let mut range_bytes = 0;
        let mut range_ids = HashSet::new();
        while start < chars.len() {
            let id = at(start);
            let mut end = start + 1;
            while end < chars.len() && at(end) == id {
                end += 1;
            }
            if end < chars.len()
                && (0xd800..=0xdbff).contains(&chars[end - 1])
                && (0xdc00..=0xdfff).contains(&chars[end])
            {
                return Err(("text.splitSurrogate", true));
            }
            if result["ranges"].as_array().unwrap().len() >= 1024 {
                return Err(("text.rangeLimit", true));
            }
            if !normalized.contains_key(&id) {
                let mut local = vec![];
                let (mut style, css) = if id == 0 {
                    (base.clone(), Ordered(base_css.0.clone()))
                } else {
                    let mut effective = n.clone();
                    for k in TEXT {
                        if let Some(v) = styles[&id].get(k) {
                            effective[k] = v.clone();
                        }
                    }
                    typography(&effective, metadata, &mut local)
                };
                style["unresolved"] = json!(if id == 0 { issues.clone() } else { local });
                normalized.insert(id, (style, css.0.iter().map(|p| p.0.clone()).collect()));
            }
            let (style, order) = &normalized[&id];
            range_bytes += crate::json::bytes(style).unwrap().len() + 64;
            if range_bytes > 100000 {
                return Err(("text.rangeByteLimit", true));
            }
            let mut range = style.clone();
            range["start"] = json!(start);
            range["end"] = json!(end);
            range["styleId"] = json!(id);
            if start == 0 {
                css_order = order.clone();
            }
            result["ranges"].as_array_mut().unwrap().push(range);
            range_ids.insert(id);
            start = end;
        }
        result["mixed"] = json!(range_ids.len() > 1);
        Ok(())
    })();
    if let Err((issue, clear)) = build {
        if clear {
            result["ranges"] = json!([]);
            css_order.clear();
        }
        issues.push(issue.into());
    }
    result["unresolved"] = json!(issues);
    (result, css_order)
}
fn mark(paints: &mut Value, field: &str, prefix: &str, bindings: &Value) {
    if let Some(paints) = paints.as_array_mut() {
        for (i, p) in paints.iter_mut().enumerate() {
            if !truthy(&p["variableBindingUnresolved"]) {
                continue;
            }
            p["variableBindingPresent"] = json!(true);
            let path = format!("{prefix}{field}[{i}].");
            let refs = bindings["references"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter(|r| r["path"].as_str().is_some_and(|p| p.starts_with(&path)))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            p["variableBindingUnresolved"] =
                json!(refs.is_empty() || refs.iter().any(|r| r["status"] != "resolved"));
        }
    }
}
pub fn project(n: &Value, bindings: &Value) -> (Value, Ordered) {
    let mut css = Ordered::default();
    let mut issues = vec![];
    let mut fills = paints(&n["fillPaints"], "fills", &mut issues);
    let mut strokes = paints(&n["strokePaints"], "strokes", &mut issues);
    let source = pick(
        n,
        &[
            "opacity",
            "blendMode",
            "cornerRadius",
            "cornerSmoothing",
            "rectangleCornerRadiiIndependent",
            "rectangleTopLeftCornerRadius",
            "rectangleTopRightCornerRadius",
            "rectangleBottomRightCornerRadius",
            "rectangleBottomLeftCornerRadius",
            "strokeWeight",
            "strokeAlign",
            "strokeCap",
            "strokeJoin",
            "dashPattern",
            "borderStrokeWeightsIndependent",
            "borderTopWeight",
            "borderRightWeight",
            "borderBottomWeight",
            "borderLeftWeight",
        ],
    );
    if let Some(v) = unit(&n["opacity"]) {
        css.set("opacity", number(v));
    } else {
        issues.push("opacity".into());
    }
    if truthy(&n["blendMode"])
        && !matches!(n["blendMode"].as_str(), Some("NORMAL" | "PASS_THROUGH"))
    {
        issues.push("blendMode".into());
    }
    let rectangular = matches!(
        n["type"].as_str(),
        Some("FRAME" | "SYMBOL" | "INSTANCE" | "RECTANGLE" | "ROUNDED_RECTANGLE")
    );
    if n["type"] != "TEXT" {
        if let Some(c) = color(&fills).filter(|_| rectangular) {
            css.set("background-color", c);
        } else if active(&fills) {
            issues.push("fills.composition".into());
        }
    }
    let corners = [
        "rectangleTopLeftCornerRadius",
        "rectangleTopRightCornerRadius",
        "rectangleBottomRightCornerRadius",
        "rectangleBottomLeftCornerRadius",
    ];
    if !rectangular {
        if n.get("cornerRadius").is_some() || truthy(&n["rectangleCornerRadiiIndependent"]) {
            issues.push("corners.geometry".into());
        }
    } else if truthy(&n["cornerSmoothing"]) {
        issues.push("corners.smoothing".into());
    } else if n["rectangleCornerRadiiIndependent"] == true {
        let values: Option<Vec<_>> = corners.iter().map(|k| positive(&n[k])).collect();
        if let Some(v) = values {
            css.set(
                "border-radius",
                v.iter()
                    .map(|v| format!("{}px", number(*v)))
                    .collect::<Vec<_>>()
                    .join(" "),
            );
        } else {
            issues.push("corners.values".into());
        }
    } else if let Some(v) = positive(&n["cornerRadius"]) {
        css.set("border-radius", format!("{}px", number(v)));
    }
    if active(&strokes) {
        issues.push("strokes.geometry".into());
    }
    let effects = if let Some(e) = n["effects"].as_array() {
        if e.len() > 128 {
            issues.push("effects.limit".into());
            Value::Null
        } else {
            json!(e
                .iter()
                .enumerate()
                .map(|(i, e)| {
                    let mut v = pick(
                        e,
                        &[
                            "type",
                            "visible",
                            "blendMode",
                            "radius",
                            "spread",
                            "showShadowBehindNode",
                            "blurOpType",
                        ],
                    );
                    if truthy(&e["color"]) {
                        v["color"] = pick(&e["color"], &["r", "g", "b", "a"]);
                    }
                    if truthy(&e["offset"]) {
                        v["offset"] = pick(&e["offset"], &["x", "y"]);
                    }
                    if e["visible"] != false {
                        issues.push(format!("effects[{i}].css"));
                    }
                    v
                })
                .collect::<Vec<_>>())
        }
    } else {
        Value::Null
    };
    let text = if n["type"] == "TEXT" {
        Some(text(n))
    } else {
        None
    };
    let mut text = text.map(|(mut text, order)| {
        let ranges = text["ranges"].as_array().unwrap();
        if let Some(first) = ranges.first() {
            for key in order {
                if ranges.iter().all(|r| r["css"][&key] == first["css"][&key]) {
                    css.set(&key, first["css"][&key].clone());
                }
            }
        }
        for issue in text["unresolved"].as_array().unwrap() {
            issues.push(format!("text.{}", issue.as_str().unwrap()));
        }
        mark(&mut text["base"]["fills"], "fillPaints", "", bindings);
        for r in text["ranges"].as_array_mut().unwrap() {
            let over = n["textData"]["styleOverrideTable"]
                .as_array()
                .and_then(|a| a.iter().find(|s| s["styleID"] == r["styleId"]));
            let prefix = if over.is_some_and(|v| truthy(&v["fillPaints"])) {
                format!("textStyle[{}].", r["styleId"])
            } else {
                String::new()
            };
            mark(&mut r["fills"], "fillPaints", &prefix, bindings);
        }
        text
    });
    mark(&mut fills, "fillPaints", "", bindings);
    mark(&mut strokes, "strokePaints", "", bindings);
    let mut seen = HashSet::new();
    issues.retain(|s| seen.insert(s.clone()));
    let mut out = json!({"css":css.object(),"source":source,"fills":fills,"strokes":strokes,"effects":effects,"nativeBindings":bindings,"unresolved":issues,"complete":false,"provenance":"captured-wire; numeric colors retain float precision; effective native values applied before CSS; unsupported CSS compositions remain unresolved"});
    if let Some(text) = text.take() {
        out["text"] = text;
    }
    (out, css)
}
