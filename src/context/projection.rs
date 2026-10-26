//! Public allowlist and layout projection; wire-only fields never enter public context.
use crate::{
    disk::Result,
    layout::{self, Ordered},
};
use serde_json::{json, Value};
fn copy(out: &mut Value, n: &Value, keys: &[&str]) {
    for k in keys {
        if let Some(v) = n.get(k) {
            out[k] = v.clone();
        }
    }
}
fn context(n: &Value, mut css: Ordered, style_order: &Value) -> Value {
    let mut out = json!({});
    copy(
        &mut out,
        n,
        &["id", "parentId", "depth", "name", "type", "hasChildren"],
    );
    if let Some(v) = n["visible"].as_bool() {
        out["hidden"] = json!(!v);
    }
    if n["opacity"].as_f64().is_some_and(f64::is_finite) {
        out["opacity"] = n["opacity"].clone();
    }
    let text = if n["textData"].is_string() {
        &n["textData"]
    } else {
        &n["textData"]["characters"]
    };
    if text.is_string() {
        out["text"] = text.clone();
    }
    if layout::truthy(&n["component"]) {
        out["component"] = n["component"].clone();
    }
    if layout::truthy(&n["instanceUnresolved"]) {
        out["instanceUnresolved"] = json!(true);
        copy(&mut out, n, &["instanceError"]);
    }
    if !layout::truthy(&n["layout"]) {
        out["propertiesOmitted"] = n
            .get("propertiesOmitted")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or(json!("Layout unavailable"));
        return out;
    }
    if layout::truthy(&n["style"]) {
        let mut style = n["style"].clone();
        if layout::truthy(&style["nativeBindings"]) {
            let b = &style["nativeBindings"];
            let refs = b["references"]
                .as_array()
                .map(|refs| {
                    refs.iter()
                        .map(|r| {
                            let mut v = json!({});
                            copy(&mut v, r, &["path", "status"]);
                            if layout::truthy(&r["reason"]) {
                                v["reason"] = r["reason"].clone();
                            }
                            v
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            style["nativeBindings"] =
                json!({"complete":b["complete"],"unresolved":b["unresolved"],"references":refs});
        } else if let Some(o) = style.as_object_mut() {
            o.remove("nativeBindings");
        }
        out["style"] = style;
    }
    let l = &n["layout"];
    let mut source = Ordered::default();
    let mut sizing = json!({});
    let mut hints = vec![];
    if let Some(f) = l["autoLayout"]["direction"]
        .as_str()
        .filter(|f| *f == "row" || *f == "column")
    {
        source.set("Flow", if f == "row" { "Horizontal" } else { "Vertical" });
    }
    for axis in ["width", "height"] {
        let rule = &l["sizing"][axis];
        let mode = rule["mode"].as_str().unwrap_or("unknown");
        let measured = rule["measured"]
            .as_f64()
            .filter(|v| v.is_finite())
            .map(|v| format!("{}px", layout::num(v)));
        sizing[axis] = json!({"mode":mode,"measured":measured});
        if let Some(measured) = measured {
            source.set(
                if axis == "width" { "Width" } else { "Height" },
                if mode == "unknown" {
                    measured
                } else {
                    let mut chars = mode.chars();
                    format!(
                        "{}{} ({measured})",
                        chars.next().unwrap().to_uppercase(),
                        chars.as_str()
                    )
                },
            );
        }
        if mode == "fill" || mode == "hug" {
            hints.push(json!({"property":axis,"value":mode,"reason":if mode=="fill" {"Size depends on the parent layout; measured size is not fixed CSS."} else {"Size follows content; measured size is not fixed CSS."}}));
        }
    }
    for (key, label) in [
        ("gap", "Gap"),
        ("row-gap", "Vertical gap"),
        ("column-gap", "Horizontal gap"),
        ("padding-top", "Padding—Top"),
        ("padding-right", "Padding—Right"),
        ("padding-bottom", "Padding—Bottom"),
        ("padding-left", "Padding—Left"),
        ("min-width", "Min width"),
        ("max-width", "Max width"),
        ("min-height", "Min height"),
        ("max-height", "Max height"),
        ("justify-content", "Justify"),
        ("align-items", "Align"),
    ] {
        if let Some(v) = l["css"].get(key) {
            source.set(label, v.clone());
        }
    }
    for key in ["Top", "Left", "Rotation"] {
        if let Some(v) = l["inspector"].get(key) {
            source.set(key, v.clone());
        }
    }
    let mut unresolved=l["unavailable"].as_array().map(|a|a.iter().map(|p|json!({"property":p,"reason":"Not available as a verified layout value in this snapshot."})).collect::<Vec<_>>()).unwrap_or_default();
    if layout::truthy(&n["instanceUnresolved"]) {
        unresolved.push(json!({"property":"children","reason":n.get("instanceError").filter(|v|!v.is_null()).cloned().unwrap_or(json!("Component could not be resolved."))}));
    }
    out["properties"] = json!([{"section":"properties-inspection-panel","fields":source.0.iter().map(|(k,v)|json!({"name":k,"value":v})).collect::<Vec<_>>()}]);
    if let Some(keys) = style_order.as_array() {
        for key in keys.iter().filter_map(Value::as_str) {
            if let Some(v) = n["style"]["css"].get(key) {
                css.set(key, v.clone());
            }
        }
    }
    out["layout"] = json!({"css":css.object(),"cssText":css.text(),"sizing":sizing,"source":source.object(),"unresolved":unresolved,"hints":hints,"complete":false,
        "geometry":l["geometry"],"measuredCss":l["measuredCss"],"constraints":l["constraints"],
        "note":"Values come from a captured snapshot. source contains normalized design values, not UI observations. Visual styles and text ranges are in style; unsupported mappings are explicit. UI-kit value matches, when enabled, preserve original CSS in resolvedValues and are independent of native Figma bindings."});
    out
}
pub fn project(q: &Value) -> Result<Value> {
    let entries = q["entries"]
        .as_array()
        .ok_or("Invalid projection entries")?;
    if entries.len() > 8 {
        return Err("Projection batch count limit exceeded".into());
    }
    let mut output = vec![];
    for item in entries {
        if !item["node"].is_object() || !item["entry"].is_object() {
            return Err("Invalid projection node".into());
        }
        let (layout, css) = layout::project(
            &item["node"],
            &item["parent"],
            &q["schema"],
            &item["geometry"],
        );
        let mut entry = item["entry"].clone();
        let mut style_order = item["styleOrder"].clone();
        if item.get("bindings").is_some() {
            // Raw records arrive once; metadata supplied by traversal takes precedence.
            let mut properties = item["node"].clone();
            for key in [
                "guid",
                "parentIndex",
                "phase",
                "symbolData",
                "derivedSymbolData",
                "componentPropAssignments",
                "componentPropRefs",
                "componentPropDefs",
                "overrideKey",
                "guidPath",
            ] {
                properties.as_object_mut().unwrap().remove(key);
            }
            for (key, value) in entry.as_object().unwrap() {
                properties[key] = value.clone();
            }
            entry = properties;
            let (style, order) = crate::style::project(&item["node"], &item["bindings"]);
            style_order = json!(order.0.iter().map(|p| &p.0).collect::<Vec<_>>());
            entry["style"] = style;
        }
        entry["layout"] = layout;
        if q["format"] != "debug" {
            entry = context(&entry, css, &style_order);
        }
        if q["compact"] == true {
            compact(&mut entry);
            let glyph = entry["type"] == "TEXT"
                && entry["text"].as_str().is_some_and(|text| text.chars().count() == 1);
            if q["summarizeDescendant"] == true && q["view"] != "map"
                && (entry["type"] == "VECTOR" || glyph) {
                // Preserve every ID and visual CSS; exact-node reads retain full provenance.
                let geometry = entry["layout"]["geometry"].clone();
                let css = entry["layout"]["css"].clone();
                entry["layout"] = json!({"geometry":geometry,"css":css});
                entry.as_object_mut().unwrap().remove("style");
                entry["detailsOmitted"] = json!(if glyph {
                    "Glyph summary; request this ID with nodeIds and depth:0 for full properties"
                } else {
                    "Vector summary; request this ID with nodeIds and depth:0 for full properties"
                });
            }
            select_fields(&mut entry, &q["view"], &q["fields"]);
        }
        if q["maxEntryBytes"].as_u64().is_some_and(|limit| {
            crate::json::bytes(&entry)
                .map(|b| b.len() as u64 > limit)
                .unwrap_or(true)
        }) {
            output.push(Value::Null);
        } else {
            output.push(entry);
        }
    }
    // Prevent an otherwise valid batch from exceeding the shared response buffer.
    if serde_json::to_vec(&output)?.len() > 3 * 1024 * 1024 {
        return Err("Projection output limit exceeded".into());
    }
    Ok(json!(output))
}

// Shared public representation, applied before byte limits and again after UI-kit mapping.
pub fn compact(node: &mut Value) {
    if let Some(o) = node.as_object_mut() {
        o.remove("properties");
    }
    fn clean(v: &mut Value) {
        match v {
            Value::Object(o) => {
                o.remove("cssText");
                if o.get("colors") == Some(&json!([])) {
                    o.remove("colors");
                }
                for v in o.values_mut() {
                    clean(v);
                }
            }
            Value::Array(a) => {
                for v in a {
                    clean(v);
                }
            }
            _ => {}
        }
    }
    // Keep property-specific provenance (e.g. requested fonts and geometry) intact.
    if let Some(l) = node.get_mut("layout").and_then(Value::as_object_mut) {
        l.remove("note");
        l.remove("hints");
        l.remove("cssText");
        if let Some(a) = l.get_mut("unresolved").and_then(Value::as_array_mut) {
            for u in a {
                if u["reason"] == "Not available as a verified layout value in this snapshot." {
                    u.as_object_mut().unwrap().remove("reason");
                }
            }
        }
    }
    let combined = node["layout"]["css"].is_object();
    if let Some(s) = node.get_mut("style").and_then(Value::as_object_mut) {
        if combined {
            s.remove("css");
        }
        s.remove("provenance");
    }
    // Remove legacy representations in nested text styles too.
    if let Some(s) = node.get_mut("style") {
        clean(s);
    }
    if let Some(l) = node.get_mut("layout").and_then(Value::as_object_mut) {
        l.remove("colors");
    }
}
pub fn select_fields(node: &mut Value, view: &Value, fields: &Value) {
    if view == "map" {
        let mut map = json!({});
        copy(
            &mut map,
            node,
            &[
                "id",
                "parentId",
                "depth",
                "name",
                "type",
                "hidden",
                "hasChildren",
                "propertiesOmitted",
                "instanceUnresolved",
            ],
        );
        let g = &node["layout"]["geometry"];
        map["geometry"] = json!({"size":g["size"],"position":g["position"],"absolutePosition":g["absolutePosition"]});
        *node = map;
        return;
    }
    let Some(fields) = fields.as_array() else {
        return;
    };
    let has = |s: &str| fields.iter().any(|v| v == s);
    if !has("layout") {
        if has("style") && node["layout"]["css"].is_object() {
            node["style"]["css"] = node["layout"]["css"].clone();
        }
        node.as_object_mut().unwrap().remove("layout");
    }
    if !has("text") {
        node.as_object_mut().unwrap().remove("text");
        if let Some(s) = node.get_mut("style").and_then(Value::as_object_mut) {
            s.remove("text");
        }
    }
    if !has("style") {
        if has("text") && !node["style"]["text"].is_null() {
            node["style"] = json!({"text":node["style"]["text"]});
        } else {
            node.as_object_mut().unwrap().remove("style");
        }
    }
    if !has("component") {
        node.as_object_mut().unwrap().remove("component");
    }
}
