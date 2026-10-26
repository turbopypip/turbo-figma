use crate::wire::Value as Wire;
use serde_json::{json, Value};
pub fn value(w: Wire) -> Value {
    match w {
        Wire::Null => Value::Null,
        Wire::Bool(v) => v.into(),
        Wire::String(v) => v.into(),
        Wire::Num(v) => {
            if !v.is_finite() {
                Value::Null
            } else if v.fract() == 0. && v.abs() <= 9007199254740991. {
                (v as i64).into()
            } else {
                json!(v)
            }
        }
        Wire::Array(a) => a.into_iter().map(value).collect(),
        Wire::Object(a) => Value::Object(a.into_iter().map(|(k, v)| (k, value(v))).collect()),
    }
}
