use serde_json::{json, Value};
fn matrix(t: &Value) -> Value {
    if ["m00", "m01", "m02", "m10", "m11", "m12"]
        .iter()
        .all(|k| t[k].as_f64().is_some_and(f64::is_finite))
    {
        json!({"a":t["m00"],"b":t["m10"],"c":t["m01"],"d":t["m11"],"tx":t["m02"],"ty":t["m12"]})
    } else {
        Value::Null
    }
}
fn compose(p: &Value, t: &Value) -> Value {
    if p.is_null() || t.is_null() {
        return Value::Null;
    }
    let p = |k: &str| p[k].as_f64().unwrap();
    let t = |k: &str| t[k].as_f64().unwrap();
    let values = [
        p("a") * t("a") + p("c") * t("b"),
        p("b") * t("a") + p("d") * t("b"),
        p("a") * t("c") + p("c") * t("d"),
        p("b") * t("c") + p("d") * t("d"),
        p("a") * t("tx") + p("c") * t("ty") + p("tx"),
        p("b") * t("tx") + p("d") * t("ty") + p("ty"),
    ];
    if values.iter().all(|n| n.is_finite()) {
        json!({"a":values[0],"b":values[1],"c":values[2],"d":values[3],"tx":values[4],"ty":values[5]})
    } else {
        Value::Null
    }
}
pub fn context(n: &Value, id: &str, parent: &Value) -> Value {
    let local = matrix(&n["transform"]);
    let is_frame = matches!(n["type"].as_str(), Some("FRAME" | "INSTANCE" | "SYMBOL"))
        && n["resizeToFit"] != true;
    json!({"canvas":if n["type"]=="CANVAS"{json!({"a":1,"b":0,"c":0,"d":1,"tx":0,"ty":0})}else{compose(&parent["canvas"],&local)},"frame":if parent["isFrame"]==true{local}else{compose(&parent["frame"],&local)},"frameId":if parent["isFrame"]==true{&parent["id"]}else{&parent["frameId"]},"isFrame":is_frame,"id":id})
}
