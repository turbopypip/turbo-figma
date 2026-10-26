//! Bounded component expansion. Source records remain immutable in the disk index.
use crate::disk::{id, Result};
use crate::layout::truthy;
use serde_json::{json, Value};

pub fn array(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub fn merge(base: &mut Value, patch: &Value) {
    if let Some(m) = patch.as_object() {
        for (k, v) in m {
            base[k] = v.clone();
        }
    }
}
pub fn scale(v: &Value) -> Result<f64> {
    let n = if v.is_null() {
        1.
    } else {
        v.as_f64().ok_or("Invalid instance scale factor")?
    };
    if n.is_finite() && n > 0. {
        Ok(n)
    } else {
        Err("Invalid instance scale factor".into())
    }
}
fn fields(v: &mut Value, keys: &[&str], factor: f64) -> Result<()> {
    for key in keys {
        if let Some(n) = v[*key].as_f64() {
            let n = n * factor;
            if !n.is_finite() {
                return Err("Instance scale length overflow".into());
            }
            v[*key] = json!(n);
        }
    }
    Ok(())
}
pub fn scale_node(node: &Value, factor: f64) -> Result<Value> {
    scale(&json!(factor))?;
    let mut n = node.clone();
    if factor == 1. {
        return Ok(n);
    }
    fields(
        &mut n,
        &[
            "fontSize",
            "paragraphSpacing",
            "paragraphIndent",
            "strokeWeight",
            "cornerRadius",
            "rectangleTopLeftCornerRadius",
            "rectangleTopRightCornerRadius",
            "rectangleBottomLeftCornerRadius",
            "rectangleBottomRightCornerRadius",
            "borderTopWeight",
            "borderRightWeight",
            "borderBottomWeight",
            "borderLeftWeight",
            "stackSpacing",
            "stackCounterSpacing",
            "stackHorizontalPadding",
            "stackVerticalPadding",
            "stackPaddingRight",
            "stackPaddingBottom",
        ],
        factor,
    )?;
    for key in ["size", "minSize", "maxSize"] {
        if truthy(&n[key]) {
            fields(&mut n[key], &["x", "y"], factor)?;
            if truthy(&n[key]["value"]) {
                fields(&mut n[key]["value"], &["x", "y"], factor)?;
            }
        }
    }
    if truthy(&n["transform"]) {
        fields(&mut n["transform"], &["m02", "m12"], factor)?;
    }
    for key in ["lineHeight", "letterSpacing"] {
        if n[key]["units"] == "PIXELS" {
            fields(&mut n[key], &["value"], factor)?;
        }
    }
    for key in ["dashPattern", "rectangleCornerRadii"] {
        if n[key].is_array() {
            for v in n[key].as_array_mut().unwrap() {
                if let Some(x) = v.as_f64() {
                    let x = x * factor;
                    if !x.is_finite() {
                        return Err("Instance scale length overflow".into());
                    }
                    *v = json!(x);
                }
            }
        }
    }
    if n["effects"].is_array() {
        for e in n["effects"].as_array_mut().unwrap() {
            fields(e, &["radius", "spread"], factor)?;
            if truthy(&e["offset"]) {
                fields(&mut e["offset"], &["x", "y"], factor)?;
            }
        }
    }
    if n["textData"]["styleOverrideTable"].is_array() {
        for s in n["textData"]["styleOverrideTable"].as_array_mut().unwrap() {
            *s = scale_node(s, factor)?;
        }
    }
    Ok(n)
}
#[derive(Clone, Default)]
pub struct Scope {
    pub overrides: Vec<Value>,
    pub derived: Vec<Value>,
    pub scale: f64,
}
#[derive(Clone, Default)]
pub struct Context {
    pub scopes: Vec<Scope>,
    pub prefix: String,
    pub symbols: Vec<String>,
    pub properties: serde_json::Map<String, Value>,
}
fn path(n: &Value) -> Result<Vec<String>> {
    array(&n["guidPath"]["guids"]).iter().map(id).collect()
}
fn patch(n: &mut Value, changes: &[Value], key: &str) -> Result<()> {
    for c in changes {
        let p = path(c)?;
        if p.len() != 1 || p[0] != key {
            continue;
        }
        for (k, v) in c.as_object().ok_or("Invalid instance override")? {
            if ["guid", "guidPath", "parentIndex", "phase", "overrideKey"].contains(&k.as_str()) {
                continue;
            }
            if k == "componentPropAssignments" && !array(v).is_empty() {
                let mut assignments = array(&n[k]).to_vec();
                for a in array(v) {
                    let key = id(&a["defID"])?;
                    let mut found = None;
                    for (i, b) in assignments.iter().enumerate() {
                        if id(&b["defID"])? == key {
                            found = Some(i);
                            break;
                        }
                    }
                    if let Some(i) = found {
                        assignments[i] = a.clone();
                    } else {
                        assignments.push(a.clone());
                    }
                }
                n[k] = json!(assignments);
            } else {
                n[k] = v.clone();
            }
        }
    }
    Ok(())
}
pub fn node(node: &Value, context: Option<&Context>) -> Result<Value> {
    let Some(c) = context else {
        return Ok(node.clone());
    };
    let key = id(node.get("overrideKey").unwrap_or(&node["guid"]))?;
    let mut n = node.clone();
    for s in &c.scopes {
        patch(&mut n, &s.overrides, &key)?;
        n = scale_node(&n, s.scale)?;
        patch(&mut n, &s.derived, &key)?;
    }
    for r in array(&n["componentPropRefs"]).to_vec() {
        if truthy(&r["isDeleted"]) {
            continue;
        }
        let Some(a) = c.properties.get(&id(&r["defID"])?) else {
            n["instanceUnresolved"] = json!(true);
            n["instanceError"] = json!("Component property definition or assignment absent");
            continue;
        };
        let v = a["varValue"]
            .get("value")
            .filter(|v| !v.is_null())
            .or_else(|| a.get("value").filter(|v| !v.is_null()))
            .unwrap_or(&a["initialValue"]);
        if r["componentPropNodeField"] == "VISIBLE" && v["boolValue"].is_boolean() {
            n["visible"] = v["boolValue"].clone();
        } else if r["componentPropNodeField"] == "TEXT_DATA"
            && (v["textValue"].is_string()
                || v["textDataValue"]["characters"].is_string()
                || v["textValue"]["characters"].is_string())
        {
            n["textData"] = v
                .get("textDataValue")
                .filter(|v| !v.is_null())
                .unwrap_or(&v["textValue"])
                .clone();
        } else if r["componentPropNodeField"] == "OVERRIDDEN_SYMBOL_ID"
            && (truthy(&v["symbolIdValue"]["guid"]) || truthy(&v["guidValue"]))
        {
            n["overriddenSymbolID"] = v["symbolIdValue"]
                .get("guid")
                .filter(|v| !v.is_null())
                .unwrap_or(&v["guidValue"])
                .clone();
        } else {
            n["instanceUnresolved"] = json!(true);
            n["instanceError"] = json!("Unsupported component property binding");
        }
    }
    let mut factor = 1.;
    for s in &c.scopes {
        factor = scale(&json!(factor * s.scale))?;
    }
    if factor != 1. {
        n["instanceScaleFactor"] = json!(factor);
    }
    Ok(n)
}
pub struct Expanded {
    pub node: Value,
    pub master: String,
    pub context: Context,
}
pub fn enter(
    node: &Value,
    node_id: &str,
    read: &mut impl FnMut(&str) -> Result<Option<Value>>,
    context: Option<&Context>,
) -> Result<std::result::Result<Expanded, &'static str>> {
    let factor = scale(&node["symbolData"]["uniformScaleFactor"])?;
    let mut inherited = 1.;
    if let Some(c) = context {
        for s in &c.scopes {
            inherited = scale(&json!(inherited * s.scale))?;
        }
    }
    let symbol = node
        .get("overriddenSymbolID")
        .filter(|v| !v.is_null())
        .unwrap_or(&node["symbolData"]["symbolID"]);
    if !truthy(symbol) {
        return Ok(Err("Component reference absent"));
    }
    let symbol_id = id(symbol)?;
    let Some(master) = read(&symbol_id)?.filter(|m| m["type"] == "SYMBOL") else {
        return Ok(Err("Component definition absent"));
    };
    if context.is_some_and(|c| c.symbols.contains(&symbol_id) || c.symbols.len() >= 32) {
        return Err("Component cycle or nesting limit exceeded".into());
    }
    let mut scopes = vec![Scope {
        overrides: array(&node["symbolData"]["symbolOverrides"]).to_vec(),
        derived: array(&node["derivedSymbolData"]).to_vec(),
        scale: factor,
    }];
    let key = id(node.get("overrideKey").unwrap_or(&node["guid"]))?;
    let scope_to = |records: &[Value]| -> Result<Vec<Value>> {
        let mut out = vec![];
        for n in records {
            let p = path(n)?;
            if p.len() > 1 && p[0] == key {
                let mut n = n.clone();
                n["guidPath"] = json!({"guids":&array(&n["guidPath"]["guids"])[1..]});
                out.push(n);
            }
        }
        Ok(out)
    };
    if let Some(c) = context {
        for outer in &c.scopes {
            scopes.push(Scope {
                overrides: scope_to(&outer.overrides)?,
                derived: scope_to(&outer.derived)?,
                scale: outer.scale,
            });
        }
    }
    let serialized: Vec<_> = scopes
        .iter()
        .map(|s| json!({"overrides":s.overrides,"derived":s.derived,"scale":s.scale}))
        .collect();
    if crate::json::bytes(&json!(serialized))?.len() > 1024 * 1024 {
        return Err("Instance override context limit exceeded".into());
    }
    if scopes.iter().any(|s| {
        s.overrides.iter().chain(&s.derived).any(|n| {
            n.get("parentIndex").is_some()
                || n.get("phase")
                    .is_some_and(|p| p != "CREATED" && p != "UPDATED")
        })
    }) {
        return Ok(Err("Structural instance overrides are not supported"));
    }
    let definitions = array(&master["componentPropDefs"]);
    let parent = if definitions.iter().any(|d| truthy(&d["parentPropDefId"]))
        && truthy(&master["parentIndex"]["guid"])
    {
        read(&id(&master["parentIndex"]["guid"])?)?
    } else {
        None
    };
    let mut properties = serde_json::Map::new();
    let mut assignments = serde_json::Map::new();
    for a in array(&node["componentPropAssignments"]) {
        assignments.insert(id(&a["defID"])?, a.clone());
    }
    for d in definitions {
        if truthy(&d["isDeleted"]) {
            continue;
        }
        let parent_id = if truthy(&d["parentPropDefId"]) {
            Some(id(&d["parentPropDefId"])?)
        } else {
            None
        };
        let mut inherited_def = None;
        if let (Some(p), Some(key)) = (&parent, &parent_id) {
            for def in array(&p["componentPropDefs"]) {
                if id(&def["id"])? == *key && !truthy(&def["isDeleted"]) {
                    inherited_def = Some(def);
                    break;
                }
            }
        }
        let value = parent_id
            .as_ref()
            .and_then(|k| assignments.get(k))
            .or_else(|| {
                if truthy(&d["varValue"]) || truthy(&d["initialValue"]) {
                    Some(d)
                } else {
                    inherited_def
                }
            });
        if let Some(v) = value {
            properties.insert(id(&d["id"])?, v.clone());
        }
    }
    for (k, v) in assignments {
        properties.insert(k, v);
    }
    let total = scale(&json!(factor * inherited))?;
    let mut effective = scale_node(&master, total)?;
    merge(&mut effective, node);
    if total != 1. || node.get("instanceScaleFactor").is_some() {
        effective["instanceScaleFactor"] = json!(total);
    }
    effective["layoutInheritance"] = json!({"componentId":symbol_id});
    effective["component"] = json!({"definitionId":symbol_id,"status":"expanded","source":"captured-component","scaleFactor":factor,"inheritedScaleFactor":inherited,"complete":false});
    if truthy(&node["overriddenSymbolID"]) && truthy(&node["symbolData"]["symbolID"]) {
        if let Some(original) = read(&id(&node["symbolData"]["symbolID"])?)? {
            if original["name"] == node["name"] && master.get("name").is_some() {
                effective["name"] = master["name"].clone();
            }
        }
    }
    if !truthy(&node["instanceError"]) {
        effective
            .as_object_mut()
            .unwrap()
            .remove("instanceUnresolved");
    }
    let mut symbols = context.map(|c| c.symbols.clone()).unwrap_or_default();
    symbols.push(symbol_id.clone());
    Ok(Ok(Expanded {
        node: effective,
        master: symbol_id,
        context: Context {
            scopes,
            prefix: if node_id.starts_with('I') {
                node_id.into()
            } else {
                format!("I{node_id}")
            },
            symbols,
            properties,
        },
    }))
}
