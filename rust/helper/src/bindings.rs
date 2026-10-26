use crate::{
    disk::Result,
    instances::array,
    layout::truthy,
    variable_resolver::{Modes, Reader},
};
use serde_json::{json, Value};
fn field(k: &str) -> Option<&'static str> {
    Some(match k {
        "CORNER_RADIUS" => "cornerRadius",
        "STROKE_WEIGHT" => "strokeWeight",
        "STACK_SPACING" => "stackSpacing",
        "STACK_COUNTER_SPACING" => "stackCounterSpacing",
        "STACK_PADDING_LEFT" => "stackHorizontalPadding",
        "STACK_PADDING_TOP" => "stackVerticalPadding",
        "STACK_PADDING_RIGHT" => "stackPaddingRight",
        "STACK_PADDING_BOTTOM" => "stackPaddingBottom",
        "VISIBLE" => "visible",
        "OPACITY" => "opacity",
        "FONT_SIZE" => "fontSize",
        "PARAGRAPH_SPACING" => "paragraphSpacing",
        "PARAGRAPH_INDENT" => "paragraphIndent",
        "RECTANGLE_TOP_LEFT_CORNER_RADIUS" => "rectangleTopLeftCornerRadius",
        "RECTANGLE_TOP_RIGHT_CORNER_RADIUS" => "rectangleTopRightCornerRadius",
        "RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS" => "rectangleBottomLeftCornerRadius",
        "RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS" => "rectangleBottomRightCornerRadius",
        "BORDER_TOP_WEIGHT" => "borderTopWeight",
        "BORDER_BOTTOM_WEIGHT" => "borderBottomWeight",
        "BORDER_LEFT_WEIGHT" => "borderLeftWeight",
        "BORDER_RIGHT_WEIGHT" => "borderRightWeight",
        _ => return None,
    })
}
fn path(n: &Value, k: &str) -> Option<(Vec<String>, &'static str)> {
    let (p, t) = if let Some(f) = field(k) {
        (vec![f], if k == "VISIBLE" { "BOOLEAN" } else { "FLOAT" })
    } else {
        match k {
            "WIDTH" | "HEIGHT" => (vec!["size", if k == "WIDTH" { "x" } else { "y" }], "FLOAT"),
            "MIN_WIDTH" | "MIN_HEIGHT" | "MAX_WIDTH" | "MAX_HEIGHT" => (
                vec![
                    if k.starts_with("MIN_") {
                        "minSize"
                    } else {
                        "maxSize"
                    },
                    "value",
                    if k.ends_with("WIDTH") { "x" } else { "y" },
                ],
                "FLOAT",
            ),
            "FONT_FAMILY" | "FONT_STYLE" => (
                vec![
                    "fontName",
                    if k == "FONT_FAMILY" {
                        "family"
                    } else {
                        "style"
                    },
                ],
                "STRING",
            ),
            "TEXT_DATA" => (
                if n["textData"].is_string() {
                    vec!["textData"]
                } else {
                    vec!["textData", "characters"]
                },
                "STRING",
            ),
            "LINE_HEIGHT" | "LETTER_SPACING" => {
                let key = if k == "LINE_HEIGHT" {
                    "lineHeight"
                } else {
                    "letterSpacing"
                };
                if n[key]["units"] != "PIXELS" {
                    return None;
                }
                (vec![key, "value"], "FLOAT")
            }
            _ => return None,
        }
    };
    Some((p.iter().map(|s| s.to_string()).collect(), t))
}
fn same(a: &Value, b: &Value) -> bool {
    if let (Some(a), Some(b)) = (a.as_f64(), b.as_f64()) {
        (a - b).abs() <= 1e-6
    } else if ["r", "g", "b", "a"]
        .iter()
        .all(|k| a.get(k).is_some() && b.get(k).is_some())
    {
        ["r", "g", "b", "a"].iter().all(|k| same(&a[k], &b[k]))
    } else {
        a == b
    }
}
fn label(v: &Value) -> String {
    v.as_str().map(str::to_owned).unwrap_or_else(|| {
        if v.is_null() {
            "undefined".into()
        } else {
            v.to_string()
        }
    })
}
fn entry_key(e: &Value) -> String {
    e.get("variableField")
        .filter(|v| !v.is_null())
        .map(label)
        .unwrap_or_else(|| {
            format!(
                "nodeField:{}",
                e.get("nodeField")
                    .filter(|v| !v.is_null())
                    .map(label)
                    .unwrap_or("unknown".into())
            )
        })
}
struct Scan<'a, 'b> {
    refs: Vec<Value>,
    unresolved: Vec<String>,
    bytes: usize,
    reader: &'a mut Reader<'b>,
    modes: &'a Modes,
    scale: Option<Value>,
}
impl Scan<'_, '_> {
    fn add(
        &mut self,
        path: String,
        data: &Value,
        captured: Option<&Value>,
        length: bool,
    ) -> Result<()> {
        if self.bytes > 100000 {
            return Ok(());
        }
        if self.refs.len() >= 128 {
            if !self.unresolved.iter().any(|v| v == "referenceLimit") {
                self.unresolved.push("referenceLimit".into())
            }
            return Ok(());
        }
        let mut resolution = self.reader.resolve(data, self.modes)?;
        if length && resolution["status"] == "resolved" && resolution["value"].is_number() {
            if let Some(s) = &self.scale {
                let scale = crate::instances::scale(s)?;
                let v = resolution["value"].as_f64().unwrap() * scale;
                if !v.is_finite() {
                    return Err("Instance scale variable overflow".into());
                }
                resolution["unscaledValue"] = resolution["value"].clone();
                resolution["instanceScaleFactor"] = json!(scale);
                resolution["value"] = json!(v);
            }
        }
        if resolution["status"] == "resolved" {
            resolution["definitionStatus"] = json!("resolved");
            resolution["capturedValueCheck"] = json!(if let Some(c) = captured {
                if same(c, &resolution["value"]) {
                    "matched"
                } else {
                    "different-fallback"
                }
            } else {
                "unavailable"
            });
            if let Some(c) = captured.filter(|c| !same(c, &resolution["value"])) {
                resolution["capturedValue"] = c.clone();
            }
        }
        let mut reference = json!({"path":path,"dataType":data.get("dataType").filter(|v|!v.is_null()).cloned().unwrap_or(json!("unknown"))});
        if let Ok(id) = crate::disk::id(&data["value"]["alias"]["guid"]) {
            reference["variableId"] = json!(id);
        }
        crate::instances::merge(&mut reference, &resolution);
        self.bytes += crate::json::bytes(&reference)?.len();
        if self.bytes > 100000 {
            if !self.unresolved.iter().any(|s| s == "referenceByteLimit") {
                self.unresolved.push("referenceByteLimit".into())
            }
            return Ok(());
        }
        self.refs.push(reference);
        Ok(())
    }
    fn scan(&mut self, n: &Value, prefix: &str) -> Result<()> {
        let entries = array(&n["variableConsumptionMap"]["entries"]);
        if entries.len() > 128 {
            self.unresolved.push(format!("{prefix}consumptionLimit"));
        }
        for e in entries.iter().take(128) {
            if let Some(data) = e.get("variableData") {
                let f = e["variableField"].as_str().unwrap_or("");
                let p = path(n, f);
                let mut captured = Some(n);
                if let Some((p, _)) = &p {
                    for k in p {
                        captured = captured.and_then(|v| v.get(k));
                    }
                } else {
                    captured = None;
                }
                let length = field(f).is_some() && !matches!(f, "VISIBLE" | "OPACITY")
                    || matches!(
                        f,
                        "WIDTH"
                            | "HEIGHT"
                            | "MIN_WIDTH"
                            | "MIN_HEIGHT"
                            | "MAX_WIDTH"
                            | "MAX_HEIGHT"
                            | "LINE_HEIGHT"
                            | "LETTER_SPACING"
                    );
                self.add(format!("{prefix}{}", entry_key(e)), data, captured, length)?;
            }
        }
        for field in ["fillPaints", "strokePaints", "effects"] {
            let items = array(&n[field]);
            if items.len() > 128 {
                self.unresolved.push(format!("{prefix}{field}.limit"));
            }
            for (i, p) in items.iter().take(128).enumerate() {
                if let Some(obj) = p.as_object() {
                    for (key, data) in obj {
                        if key.ends_with("Var") && key != "stopsVar" {
                            self.add(
                                format!("{prefix}{field}[{i}].{key}"),
                                data,
                                p.get(&key[..key.len() - 3]),
                                field == "effects"
                                    && matches!(key.as_str(), "radiusVar" | "spreadVar"),
                            )?;
                        }
                    }
                }
                for stop_field in ["stops", "stopsVar"] {
                    let stops = array(&p[stop_field]);
                    if stops.len() > 128 {
                        self.unresolved
                            .push(format!("{prefix}{field}[{i}].{stop_field}.limit"));
                    }
                    for (j, stop) in stops.iter().take(128).enumerate() {
                        if truthy(&stop["colorVar"]) {
                            self.add(
                                format!("{prefix}{field}[{i}].{stop_field}[{j}].colorVar"),
                                &stop["colorVar"],
                                stop.get("color"),
                                false,
                            )?;
                        }
                    }
                }
            }
        }
        Ok(())
    }
}
fn project(raw: &Value, prefix: &str, refs: &mut [Value]) -> Value {
    let mut out = raw.clone();
    let find = |path: &str, refs: &[Value]| refs.iter().rposition(|r| r["path"] == path);
    for e in array(&raw["variableConsumptionMap"]["entries"]) {
        if e.get("variableData").is_none() {
            continue;
        }
        let f = e["variableField"].as_str().unwrap_or("");
        let index = find(&format!("{prefix}{}", entry_key(e)), refs);
        if let Some((path, kind)) = path(raw, f) {
            let mut target = &mut out;
            for k in &path[..path.len() - 1] {
                if !target[k].is_object() {
                    target[k] = json!({});
                }
                target = &mut target[k];
            }
            let value = index
                .and_then(|i| {
                    if refs[i]["status"] == "resolved" && refs[i]["dataType"] == kind {
                        Some(refs[i]["value"].clone())
                    } else {
                        None
                    }
                })
                .unwrap_or(Value::Null);
            target[path.last().unwrap()] = value;
            if let Some(i) = index {
                if refs[i]["status"] == "resolved" && refs[i]["dataType"] != kind {
                    refs[i]["status"] = json!("unresolved");
                    refs[i]["reason"] = json!("Variable type does not match consuming property");
                }
            }
        } else {
            let reason = if matches!(f, "LINE_HEIGHT" | "LETTER_SPACING") {
                out[if f == "LINE_HEIGHT" {
                    "lineHeight"
                } else {
                    "letterSpacing"
                }] = Value::Null;
                "Bound text metric units are not established as pixels"
            } else {
                "Unsupported variable consuming field"
            };
            if let Some(i) = index {
                refs[i]["status"] = json!("unresolved");
                refs[i]["reason"] = json!(reason);
            }
        }
    }
    for field in ["fillPaints", "strokePaints", "effects"] {
        if let Some(items) = raw[field].as_array() {
            let mut values = vec![];
            for (i, item) in items.iter().enumerate() {
                let mut value = item.clone();
                if let Some(obj) = item.as_object() {
                    for key in obj.keys() {
                        if key.ends_with("Var") && key != "stopsVar" {
                            let target = &key[..key.len() - 3];
                            let kind = match target {
                                "color" => "COLOR",
                                "visible" => "BOOLEAN",
                                _ => "FLOAT",
                            };
                            let r = find(&format!("{prefix}{field}[{i}].{key}"), refs)
                                .map(|i| &refs[i]);
                            if let Some(r) =
                                r.filter(|r| r["status"] == "resolved" && r["dataType"] == kind)
                            {
                                value[target] = r["value"].clone();
                            } else {
                                value.as_object_mut().unwrap().remove(target);
                            }
                        }
                    }
                }
                if field != "effects"
                    && item["type"] == "SOLID"
                    && truthy(&item["colorVar"])
                    && truthy(&value["color"])
                {
                    value["opacity"] = value["color"]["a"].clone();
                    value["color"]["a"] = json!(1);
                }
                for key in ["stops", "stopsVar"] {
                    if let Some(stops) = item[key].as_array() {
                        value[key] = json!(stops
                            .iter()
                            .enumerate()
                            .map(|(j, s)| {
                                let mut s = s.clone();
                                if truthy(&s["colorVar"]) {
                                    if let Some(r) = find(
                                        &format!("{prefix}{field}[{i}].{key}[{j}].colorVar"),
                                        refs,
                                    )
                                    .map(|i| &refs[i])
                                    .filter(|r| {
                                        r["status"] == "resolved" && r["dataType"] == "COLOR"
                                    }) {
                                        s["color"] = r["value"].clone();
                                    } else {
                                        s.as_object_mut().unwrap().remove("color");
                                    }
                                }
                                s
                            })
                            .collect::<Vec<_>>());
                    }
                }
                values.push(value);
            }
            out[field] = json!(values);
        }
    }
    out
}
pub fn apply(n: &Value, modes: &Modes, reader: &mut Reader) -> Result<(Value, Value)> {
    let mut scan = Scan {
        refs: vec![],
        unresolved: vec![],
        bytes: 0,
        reader,
        modes,
        scale: n.get("instanceScaleFactor").cloned(),
    };
    scan.scan(n, "")?;
    let table = array(&n["textData"]["styleOverrideTable"]);
    if table.len() > 128 {
        scan.unresolved.push("textStyleLimit".into());
    }
    for s in table.iter().take(128) {
        scan.scan(s, &format!("textStyle[{}].", label(&s["styleID"])))?;
    }
    let mut effective = project(n, "", &mut scan.refs);
    if n["textData"]["styleOverrideTable"].is_array() {
        effective["textData"]["styleOverrideTable"] = json!(table
            .iter()
            .map(|s| project(
                s,
                &format!("textStyle[{}].", label(&s["styleID"])),
                &mut scan.refs
            ))
            .collect::<Vec<_>>());
    }
    Ok((
        effective,
        json!({"source":"figma-wire","references":scan.refs,"unresolved":scan.unresolved,"complete":false,"note":"Captured definitions, mode values and alias chains are independent of UI-kit matching. Unknown active modes and unavailable definitions stay explicit. Missing references do not prove absence of bindings."}),
    ))
}
