//! Conservative layout projection. Keep CSS insertion order: it is part of cssText.
use serde_json::{json, Value};
pub const SCHEMA: &str = "6518ae0a292d152a65a2a9d82ef27d8fb1f158b28c240d7aec5eb75ea93df288";
#[derive(Default)]
pub struct Ordered(pub Vec<(String, Value)>);
impl Ordered {
    pub fn set(&mut self, k: &str, v: impl Into<Value>) {
        let v = v.into();
        if let Some(p) = self.0.iter_mut().find(|p| p.0 == k) {
            p.1 = v;
        } else {
            self.0.push((k.into(), v));
        }
    }
    fn remove(&mut self, k: &str) {
        self.0.retain(|p| p.0 != k);
    }
    pub fn object(&self) -> Value {
        self.0.iter().cloned().collect()
    }
    pub fn text(&self) -> String {
        self.0
            .iter()
            .map(|(k, v)| format!("{k}: {};", v.as_str().unwrap_or("")))
            .collect::<Vec<_>>()
            .join("\n")
    }
}
pub fn num(v: f64) -> String {
    String::from_utf8(crate::json::bytes(&json!(v)).expect("number serialization"))
        .expect("JSON utf8")
}
fn px(v: f64) -> String {
    format!("{}px", num(v))
}
fn finite(v: &Value) -> Option<f64> {
    v.as_f64().filter(|v| v.is_finite())
}
fn nonnegative(v: &Value) -> Option<f64> {
    finite(v).filter(|v| *v >= 0.)
}
fn direction(v: &Value) -> Option<&'static str> {
    match v.as_str() {
        Some("HORIZONTAL") => Some("row"),
        Some("VERTICAL") => Some("column"),
        _ => None,
    }
}
pub fn matrix(v: &Value) -> Value {
    let keys = ["m00", "m10", "m01", "m11", "m02", "m12"];
    if keys.iter().any(|k| finite(&v[k]).is_none()) {
        return Value::Null;
    }
    ["a", "b", "c", "d", "tx", "ty"]
        .into_iter()
        .zip(keys)
        .map(|(k, s)| (k.to_owned(), v[s].clone()))
        .collect()
}
fn bounds(t: &Value, size: &Value) -> Option<[f64; 4]> {
    let [a, b, c, d, tx, ty] =
        ["a", "b", "c", "d", "tx", "ty"].map(|k| finite(&t[k]).unwrap_or(f64::NAN));
    let w = finite(&size["width"])?;
    let h = finite(&size["height"])?;
    let points =
        [(0., 0.), (w, 0.), (0., h), (w, h)].map(|(x, y)| (a * x + c * y + tx, b * x + d * y + ty));
    if points.iter().any(|(x, y)| !x.is_finite() || !y.is_finite()) {
        return None;
    }
    let minx = points.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
    let miny = points.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
    let maxx = points.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max);
    let maxy = points.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);
    Some([minx, miny, maxx - minx, maxy - miny])
}
pub fn project(n: &Value, parent: &Value, schema: &Value, geometry: &Value) -> (Value, Ordered) {
    let fields = [
        "size",
        "transform",
        "opacity",
        "stackMode",
        "stackSpacing",
        "stackHorizontalPadding",
        "stackVerticalPadding",
        "stackPaddingRight",
        "stackPaddingBottom",
        "stackPrimarySizing",
        "stackCounterSizing",
        "stackChildPrimaryGrow",
        "stackChildAlignSelf",
        "stackPrimaryAlignItems",
        "stackCounterAlignItems",
        "stackPositioning",
        "stackWrap",
        "stackCounterSpacing",
        "stackCounterAlignContent",
        "minSize",
        "maxSize",
        "horizontalConstraint",
        "verticalConstraint",
        "textAutoResize",
    ];
    let source: Value = fields
        .iter()
        .filter_map(|k| n.get(k).map(|v| (k.to_string(), v.clone())))
        .collect();
    let mut css = Ordered::default();
    let mut unavailable: Vec<String> = vec![];
    let size = match (nonnegative(&n["size"]["x"]), nonnegative(&n["size"]["y"])) {
        (Some(w), Some(h)) => json!({"width":w,"height":h}),
        _ => Value::Null,
    };
    if size.is_null() {
        unavailable.push("geometry.size".into());
    }
    let transform = matrix(&n["transform"]);
    if transform.is_null() {
        unavailable.push("geometry.localTransform".into());
    }
    let parent_bounds = bounds(&transform, &size).filter(|b| b.iter().all(|v| v.is_finite()));
    if parent_bounds.is_none() {
        unavailable.push("geometry.parentBounds".into());
    }
    let flow = direction(&n["stackMode"]);
    let mut auto = json!({"direction":flow.or(if n["stackMode"]=="NONE" {Some("none")} else {None}),"gap":null,"padding":{"top":null,"right":null,"bottom":null,"left":null},"primaryAlignment":null,"counterAlignment":null});
    if auto["direction"].is_null() {
        unavailable.push("autoLayout.direction".into());
    }
    if let Some(flow) = flow {
        css.set("display", "flex");
        css.set("flex-direction", flow);
        if let Some(v) = nonnegative(&n["stackSpacing"]) {
            auto["gap"] = json!(v);
            css.set("gap", px(v));
        } else {
            unavailable.push("autoLayout.gap".into());
        }
        for (side, field) in [
            ("top", "stackVerticalPadding"),
            ("right", "stackPaddingRight"),
            ("bottom", "stackPaddingBottom"),
            ("left", "stackHorizontalPadding"),
        ] {
            if let Some(v) = nonnegative(&n[field]) {
                auto["padding"][side] = json!(v);
                css.set(&format!("padding-{side}"), px(v));
            } else {
                unavailable.push(format!("autoLayout.padding.{side}"));
            }
        }
        let primary = match n["stackPrimaryAlignItems"].as_str() {
            Some("MIN") => Some("flex-start"),
            Some("CENTER") => Some("center"),
            Some("MAX") => Some("flex-end"),
            Some("SPACE_EVENLY") => Some("space-between"),
            _ => None,
        };
        let counter = match n["stackCounterAlignItems"].as_str() {
            Some("MIN") => Some("flex-start"),
            Some("CENTER") => Some("center"),
            Some("MAX") => Some("flex-end"),
            Some("BASELINE") => Some("baseline"),
            _ => None,
        };
        auto["primaryAlignment"] = json!(primary);
        auto["counterAlignment"] = json!(counter);
        if primary == Some("space-between") {
            auto["gap"] = Value::Null;
            css.remove("gap");
            unavailable.push("autoLayout.effectiveDistributedGap".into());
        }
        if let Some(v) = primary {
            css.set("justify-content", v);
        } else {
            unavailable.push("autoLayout.primaryAlignment".into());
        }
        if let Some(v) = counter {
            css.set("align-items", v);
        } else {
            unavailable.push("autoLayout.counterAlignment".into());
        }
    }
    let parent_flow = direction(&parent["stackMode"]);
    let mut sizing = json!({});
    for axis in ["width", "height"] {
        let main = flow.is_some_and(|f| (f == "row") == (axis == "width"));
        let own_field = flow.map(|_| {
            if main {
                "stackPrimarySizing"
            } else {
                "stackCounterSizing"
            }
        });
        let mut rule = own_field.and_then(|f| n[f].as_str());
        let verified = own_field.is_some_and(|f| n.get(f).is_none())
            && (n["type"] == "FRAME" || truthy(&n["layoutInheritance"]["componentId"]))
            && schema == SCHEMA;
        if verified {
            rule = Some(if main { "RESIZE_TO_FIT" } else { "FIXED" });
        }
        let parent_main = parent_flow.is_some_and(|f| (f == "row") == (axis == "width"));
        let mut mode = None;
        let mut evidence: Vec<String> = vec![];
        if parent_flow.is_some()
            && (n.get("stackPositioning").is_none() || n["stackPositioning"] == "AUTO")
            && (if parent_main {
                finite(&n["stackChildPrimaryGrow"]).is_some_and(|v| v > 0.)
            } else {
                n["stackChildAlignSelf"] == "STRETCH"
            })
        {
            mode = Some("fill");
            evidence = vec![
                "parent.stackMode".into(),
                if parent_main {
                    "stackChildPrimaryGrow"
                } else {
                    "stackChildAlignSelf"
                }
                .into(),
            ];
        } else if rule == Some("FIXED") {
            mode = Some("fixed");
            evidence.push(own_field.unwrap().into());
        } else if matches!(
            rule,
            Some("RESIZE_TO_FIT" | "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE")
        ) {
            mode = Some("hug");
            evidence.push(own_field.unwrap().into());
        }
        if verified && evidence.iter().any(|e| Some(e.as_str()) == own_field) {
            evidence.push(format!("verified-frame-default:{SCHEMA}"));
        }
        if mode.is_none()
            && n["type"] == "TEXT"
            && matches!(
                n["textAutoResize"].as_str(),
                Some("WIDTH_AND_HEIGHT" | "HEIGHT" | "NONE" | "TRUNCATE")
            )
        {
            mode = Some(
                if n["textAutoResize"] == "WIDTH_AND_HEIGHT"
                    || (n["textAutoResize"] == "HEIGHT" && axis == "height")
                {
                    "hug"
                } else {
                    "fixed"
                },
            );
            evidence = vec!["textAutoResize".into()];
        }
        if mode.is_none()
            && flow.is_none()
            && matches!(
                n["type"].as_str(),
                Some(
                    "RECTANGLE"
                        | "ROUNDED_RECTANGLE"
                        | "ELLIPSE"
                        | "LINE"
                        | "VECTOR"
                        | "BOOLEAN_OPERATION"
                )
            )
        {
            mode = Some("fixed");
            evidence = vec!["non-layout-shape".into()];
        }
        sizing[axis] = json!({"mode":mode,"measured":size[axis],"evidence":evidence});
        if mode.is_none() {
            unavailable.push(format!("sizing.{axis}"));
        }
        if mode == Some("fixed") {
            if let Some(v) = finite(&size[axis]) {
                css.set(axis, px(v));
            }
        }
    }
    if let Some(flow) = flow.filter(|_| matches!(n["stackWrap"].as_str(), Some("WRAP" | "NO_WRAP")))
    {
        auto["wrap"] = json!(if n["stackWrap"] == "WRAP" {
            "wrap"
        } else {
            "nowrap"
        });
        css.set("flex-wrap", auto["wrap"].clone());
        if n["stackWrap"] == "WRAP" {
            css.remove("gap");
            let (main, cross) = if flow == "row" {
                ("column-gap", "row-gap")
            } else {
                ("row-gap", "column-gap")
            };
            if let Some(v) = nonnegative(&n["stackSpacing"])
                .filter(|_| auto["primaryAlignment"] != "space-between")
            {
                css.set(main, px(v));
            }
            if let Some(v) = nonnegative(&n["stackCounterSpacing"]) {
                css.set(cross, px(v));
            } else {
                unavailable.push("autoLayout.counterGap".into());
            }
            if n["stackCounterAlignContent"] == "SPACE_BETWEEN" {
                css.set("align-content", "space-between");
                css.remove(cross);
            }
        }
    } else {
        unavailable.push("autoLayout.wrap".into());
    }
    if finite(&n["stackSpacing"]).is_some_and(|v| v < 0.) {
        unavailable.push("autoLayout.negativeSpacingRequiresOverlap".into());
    }
    for (field, prefix) in [("minSize", "min"), ("maxSize", "max")] {
        for (component, axis) in [("x", "width"), ("y", "height")] {
            if let Some(v) = nonnegative(&n[field]["value"][component]) {
                css.set(&format!("{prefix}-{axis}"), px(v));
            }
        }
    }
    if n["stackMode"] == "GRID" {
        unavailable.push("autoLayout.gridTracks".into());
    }
    if geometry["canvas"].is_null() {
        unavailable.push("geometry.absolutePosition".into());
    }
    let it = if geometry["frame"].is_null() {
        &transform
    } else {
        &geometry["frame"]
    };
    let angle = match (finite(&it["a"]), finite(&it["b"])) {
        (Some(a), Some(b)) if a != 0. || b != 0. => {
            Some((-crate::angle::atan2(b, a) * 180. / std::f64::consts::PI + 540.) % 360. - 180.)
        }
        _ => None,
    };
    let mut inspector = Ordered::default();
    if let Some([x, y, _, _]) = bounds(&geometry["frame"], &size) {
        inspector.set("Top", px(y));
        inspector.set("Left", px(x));
    }
    if let Some(angle) = angle {
        inspector.set("Rotation", format!("{}°", num(angle)));
    }
    let measured = if size.is_null() {
        json!({})
    } else {
        json!({"width":px(size["width"].as_f64().unwrap()),"height":px(size["height"].as_f64().unwrap())})
    };
    let result = json!({"cssText":css.text(),"measuredCss":measured,"inspector":inspector.object(),"source":source,
        "geometry":{"size":size,"localTransform":transform,"absoluteTransform":geometry["canvas"],
        "absolutePosition":if geometry["canvas"].is_null(){Value::Null}else{json!({"x":geometry["canvas"]["tx"],"y":geometry["canvas"]["ty"],"space":"canvas"})},
        "framePosition":if geometry["frame"].is_null(){Value::Null}else{json!({"x":geometry["frame"]["tx"],"y":geometry["frame"]["ty"],"frameId":geometry["frameId"]})},
        "position":if transform.is_null(){Value::Null}else{json!({"x":transform["tx"],"y":transform["ty"],"space":"parent"})},
        "parentBounds":parent_bounds.map(|[x,y,w,h]|json!({"x":x,"y":y,"width":w,"height":h,"provenance":"computed-from-size-and-transform"}))},
        "autoLayout":auto,"sizing":sizing,"constraints":{"horizontal":n["horizontalConstraint"],"vertical":n["verticalConstraint"]},"parentDirection":parent_flow,"css":css.object(),"unavailable":unavailable,"complete":false,
        "provenance":"captured-wire; computed bounds and sizing are identified separately; schema-scoped sizing defaults carry evidence"});
    (result, css)
}
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(n) => n.as_f64().is_some_and(|v| v != 0.),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
