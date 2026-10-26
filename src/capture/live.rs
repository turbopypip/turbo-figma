use crate::{
    disk::{id, Result},
    wire::Decoder,
};
use serde_json::Value;
use std::collections::HashSet;
pub const FIELDS: &[&str] = &[
    "guid",
    "phase",
    "type",
    "parentIndex",
    "name",
    "visible",
    "opacity",
    "size",
    "transform",
    "cornerRadius",
    "rectangleCornerRadii",
    "strokeWeight",
    "stackMode",
    "stackSpacing",
    "stackHorizontalPadding",
    "stackVerticalPadding",
    "stackPaddingRight",
    "stackPaddingBottom",
    "resizeToFit",
    "minSize",
    "maxSize",
    "horizontalConstraint",
    "verticalConstraint",
    "stackCounterSpacing",
    "stackCounterAlignContent",
    "stackChildPrimaryGrow",
    "stackPositioning",
    "stackWrap",
    "stackChildAlignSelf",
    "stackPrimaryAlignItems",
    "stackCounterAlignItems",
    "stackPrimarySizing",
    "stackCounterSizing",
];
pub fn codec(schema: &[u8]) -> Result<Decoder> {
    Decoder::new(
        schema,
        &FIELDS.iter().map(|s| s.to_string()).collect::<HashSet<_>>(),
    )
}
pub fn validate(n: &Value) -> Result<()> {
    id(&n["guid"])?;
    let mut values = vec![n];
    let mut visited = 0;
    while let Some(v) = values.pop() {
        visited += 1;
        if visited > 10000 {
            return Err("Live value budget exceeded".into());
        }
        match v {
            Value::Array(a) => values.extend(a),
            Value::Object(o) => values.extend(o.values()),
            _ => {}
        }
    }
    let obj = n.as_object().ok_or("Invalid live change")?;
    for (k, v) in obj {
        if !FIELDS.contains(&k.as_str()) || v.is_null() {
            return Err(format!("Unsupported live field: {k}").into());
        }
    }
    if let Some(v) = n.get("phase") {
        if v != "CREATED" && v != "REMOVED" {
            return Err("Unsupported live node phase".into());
        }
    }
    if let Some(v) = n.get("parentIndex") {
        id(&v["guid"])?;
        if !v["position"]
            .as_str()
            .is_some_and(|s| s.encode_utf16().count() <= 4096)
        {
            return Err("Invalid live sibling position".into());
        }
    }
    if let Some(t) = n.get("type") {
        if !matches!(
            t.as_str(),
            Some("FRAME" | "GROUP" | "RECTANGLE" | "ELLIPSE" | "LINE" | "TEXT" | "VECTOR")
        ) {
            return Err("Unsupported live node type".into());
        }
    }
    if n["phase"] == "REMOVED" && obj.keys().any(|k| k != "guid" && k != "phase") {
        return Err("Removal with additional fields is unsupported".into());
    }
    Ok(())
}
