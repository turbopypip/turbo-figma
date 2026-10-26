//! Captured variable definitions and explicit mode inheritance; no inferred theme.
use crate::{
    disk::{id, Disk, Result},
    instances::{array, merge},
    layout::truthy,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
pub type Modes = BTreeMap<String, Value>;
fn optional_id(v: &Value) -> Option<String> {
    id(v).ok()
}
fn ref_key(r: &Value) -> Option<String> {
    optional_id(&r["guid"])
        .map(|s| format!("g:{s}"))
        .or_else(|| {
            r["assetRef"]["key"].as_str().map(|s| {
                format!(
                    "a:{}",
                    serde_json::to_string(&json!([s, r["assetRef"]["version"]])).unwrap()
                )
            })
        })
}
pub fn inherit(parent: &Modes, n: &Value, node_id: &str) -> Result<Modes> {
    let mut result = parent.clone();
    if let Some(entries) = n["variableModeBySetMap"]["entries"].as_array() {
        if entries.len() > 128 {
            return Err("Variable mode context limit exceeded".into());
        }
        let order = parent
            .values()
            .filter_map(|v| v["order"].as_u64())
            .max()
            .unwrap_or(0)
            + 1;
        for e in entries {
            if let Some(key) = ref_key(&e["variableSetID"]) {
                result.insert(key,json!({"modeId":optional_id(&e["variableModeID"]).unwrap_or("invalid".into()),"sourceNodeId":node_id,"order":order}));
            }
        }
        if result.len() > 128 {
            return Err("Inherited variable mode context limit exceeded".into());
        }
    }
    Ok(result)
}
pub struct Reader<'a> {
    pub disk: &'a mut Disk,
    pub reads: usize,
    pub bytes: usize,
    pub default_mode: bool,
}
impl Reader<'_> {
    pub fn node(&mut self, id: &str) -> Result<Option<Value>> {
        let slot = self.disk.runtime_command(&json!({"op":"slot","id":id}))?;
        let len = slot["length"].as_u64().unwrap_or(0) as usize;
        self.reads += 1;
        self.bytes += len;
        if self.reads > 20000 || self.bytes > 64 * 1024 * 1024 {
            return Err("Variable dependency read budget exceeded".into());
        }
        if len > 0 {
            Ok(Some(self.disk.node(id, false)?))
        } else {
            Ok(None)
        }
    }
    fn locate(&mut self, r: &Value, kind: &str) -> Result<Option<(String, Value)>> {
        let target = if let Some(id) = optional_id(&r["guid"]) {
            Some(id)
        } else {
            self.disk
                .asset(kind, &r["assetRef"])?
                .as_str()
                .map(str::to_owned)
        };
        if let Some(id) = target {
            if let Some(n) = self.node(&id)? {
                if n["type"] == kind {
                    return Ok(Some((id, n)));
                }
            }
        }
        Ok(None)
    }
    pub fn resolve(&mut self, data: &Value, modes: &Modes) -> Result<Value> {
        let result = self.inner(data, modes, &HashSet::new(), 0, &mut 0)?;
        Ok(if crate::json::bytes(&result)?.len() <= 32768 {
            result
        } else {
            unresolved("Variable resolution output limit exceeded")
        })
    }
    fn inner(
        &mut self,
        data: &Value,
        modes: &Modes,
        seen: &HashSet<String>,
        depth: usize,
        ops: &mut usize,
    ) -> Result<Value> {
        *ops += 1;
        if *ops > 128 || depth > 16 {
            return Ok(unresolved("Variable alias resolution limit exceeded"));
        }
        if data["dataType"] != "ALIAS" {
            let v = &data["value"];
            let literal = match data["dataType"].as_str() {
                Some("FLOAT") => v["floatValue"]
                    .as_f64()
                    .filter(|v| v.is_finite())
                    .map(|v| json!(v)),
                Some("BOOLEAN") => v["boolValue"].as_bool().map(|v| json!(v)),
                Some("STRING") => v["textValue"]
                    .as_str()
                    .filter(|v| v.encode_utf16().count() <= 4096)
                    .map(|v| json!(v)),
                Some("COLOR") => {
                    let c = &v["colorValue"];
                    if ["r", "g", "b", "a"]
                        .iter()
                        .all(|k| c[k].as_f64().is_some_and(|v| (0. ..=1.).contains(&v)))
                    {
                        Some(json!({"r":c["r"],"g":c["g"],"b":c["b"],"a":c["a"]}))
                    } else {
                        None
                    }
                }
                _ => None,
            };
            return Ok(if let Some(v) = literal {
                json!({"status":"resolved","dataType":data["dataType"],"value":v,"chain":[]})
            } else {
                json!({"status":"unresolved","reason":"Unsupported or missing variable value","dataType":data.get("dataType").filter(|v|!v.is_null()).cloned().unwrap_or(json!("unknown"))})
            });
        }
        let Some((variable_id, node)) = self.locate(&data["value"]["alias"], "VARIABLE")? else {
            return Ok(unresolved(
                "Variable definition absent, version mismatch or ambiguous asset key",
            ));
        };
        let mut base = json!({"variableId":variable_id,"name":name(&node["name"])});
        if let Some(v) = node.get("variableResolvedType") {
            base["dataType"] = v.clone();
        }
        if seen.contains(&variable_id) {
            merge(&mut base, &unresolved("Variable alias cycle"));
            return Ok(base);
        }
        let mut next = seen.clone();
        next.insert(variable_id.clone());
        macro_rules! fail {
            ($msg:expr) => {{
                merge(&mut base, &unresolved($msg));
                return Ok(base);
            }};
        }
        if truthy(&node["backingVariableId"]) || truthy(&node["overriddenVariableId"]) {
            fail!("Extended variable definitions are not supported")
        }
        let Some((set_id, set)) = self.locate(&node["variableSetID"], "VARIABLE_SET")? else {
            fail!("Variable collection absent, version mismatch or ambiguous asset key")
        };
        let raw = array(&set["variableSetModes"]);
        if raw.is_empty() || raw.len() > 32 {
            fail!("Variable collection modes absent or over limit")
        }
        if truthy(&set["backingVariableSetId"])
            || raw
                .iter()
                .any(|m| truthy(&m["parentVariableSetId"]) || truthy(&m["parentModeId"]))
        {
            fail!("Extended collection mode inheritance is not supported")
        }
        let mode_ids: Vec<_> = raw.iter().map(|m| optional_id(&m["id"])).collect();
        if mode_ids.iter().any(Option::is_none)
            || mode_ids.iter().collect::<HashSet<_>>().len() != raw.len()
        {
            fail!("Invalid or duplicate collection mode IDs")
        }
        let mode_ids: Vec<_> = mode_ids.into_iter().flatten().collect();
        let collection = json!({"id":set_id,"name":name(&set["name"])});
        base["collection"] = collection.clone();
        let Some(entries) = node["variableDataValues"]["entries"]
            .as_array()
            .filter(|a| a.len() <= 32)
        else {
            fail!("Variable mode values absent or over limit")
        };
        let mut values = BTreeMap::new();
        for e in entries {
            let Some(mode) = optional_id(&e["modeID"]) else {
                fail!("Invalid or duplicate variable mode value")
            };
            if values.insert(mode, &e["variableData"]).is_some() {
                fail!("Invalid or duplicate variable mode value")
            }
        }
        let mut keys = vec![format!("g:{set_id}")];
        keys.extend(
            [
                ref_key(&node["variableSetID"]),
                ref_key(&json!({"assetRef":{"key":set["key"],"version":set["version"]}})),
                ref_key(&json!({"assetRef":{"key":set["key"]}})),
            ]
            .into_iter()
            .flatten(),
        );
        let candidates: Vec<_> = keys.iter().filter_map(|k| modes.get(k)).collect();
        let nearest = candidates
            .iter()
            .filter_map(|v| v["order"].as_u64())
            .max()
            .unwrap_or(0);
        let explicit: Vec<_> = candidates
            .into_iter()
            .filter(|v| v["order"].as_u64().unwrap_or(0) == nearest)
            .collect();
        let conflict = explicit
            .iter()
            .map(|v| v["modeId"].as_str())
            .collect::<HashSet<_>>()
            .len()
            > 1;
        let positions: Vec<_> = raw.iter().map(|m| m["sortPosition"].as_str()).collect();
        let ordered = positions
            .iter()
            .all(|p| p.is_some_and(|p| !p.is_empty() && p.encode_utf16().count() <= 256))
            && positions.iter().collect::<HashSet<_>>().len() == raw.len();
        let default = if ordered && self.default_mode {
            raw.iter()
                .min_by(|a, b| a["sortPosition"].as_str().cmp(&b["sortPosition"].as_str()))
                .and_then(|m| optional_id(&m["id"]))
        } else {
            None
        };
        let selected = if conflict {
            None
        } else {
            explicit
                .first()
                .and_then(|v| v["modeId"].as_str())
                .map(str::to_owned)
                .or_else(|| {
                    if raw.len() == 1 {
                        Some(mode_ids[0].clone())
                    } else {
                        default.clone()
                    }
                })
        };
        let mut mode_values = vec![];
        for (m, mode_id) in raw.iter().zip(&mode_ids) {
            let mut per = modes.clone();
            for key in &keys {
                per.insert(key.clone(),json!({"modeId":mode_id,"sourceNodeId":"collection-mode-value","order":nearest+1}));
            }
            let mut resolved = if let Some(data) = values.get(mode_id) {
                self.inner(data, &per, &next, depth + 1, ops)?
            } else {
                unresolved("Value absent for collection mode")
            };
            if truthy(&resolved["name"]) {
                resolved["variableName"] = resolved["name"].clone();
            }
            resolved["id"] = json!(mode_id);
            resolved["name"] = name(&m["name"]);
            mode_values.push(resolved);
        }
        let chosen = mode_values
            .iter()
            .find(|m| m["id"].as_str() == selected.as_deref());
        let mut chain_entry =
            json!({"variableId":variable_id,"name":base["name"],"collection":collection});
        if let Some(c) = chosen {
            chain_entry["modeId"] = c["id"].clone();
            chain_entry["modeName"] = c["name"].clone();
        }
        let common = mode_values.iter().all(|v| {
            v["status"] == "resolved"
                && v["value"] == mode_values[0]["value"]
                && v["dataType"] == mode_values[0]["dataType"]
        });
        let effective = chosen.or_else(|| {
            if selected.is_none() && !conflict && common {
                mode_values.first()
            } else {
                None
            }
        });
        if effective.is_some_and(|e| {
            e["status"] == "resolved"
                && truthy(&node["variableResolvedType"])
                && node["variableResolvedType"] != e["dataType"]
        }) {
            base["modes"] = json!(mode_values);
            fail!("Resolved value type does not match variable definition")
        }
        base["modeSelection"] = json!(if conflict {
            "conflicting"
        } else if !explicit.is_empty() {
            "explicit-or-inherited"
        } else if raw.len() == 1 {
            "single-mode"
        } else if default.is_some() {
            "collection-default"
        } else {
            "unknown"
        });
        if let Some(e) = explicit.first() {
            base["modeSourceNodeId"] = e["sourceNodeId"].clone();
        }
        if let Some(c) = chosen {
            base["modeId"] = c["id"].clone();
            base["modeName"] = c["name"].clone();
        }
        if let Some(e) = effective.filter(|e| e["status"] == "resolved") {
            let mut chain = vec![chain_entry];
            if chosen.is_some() {
                chain.extend_from_slice(array(&e["chain"]));
            }
            merge(
                &mut base,
                &json!({"status":"resolved","value":e["value"],"dataType":e["dataType"],"modeIndependent":chosen.is_none(),"chain":chain}),
            );
        } else {
            merge(
                &mut base,
                &json!({"status":"unresolved","reason":chosen.and_then(|c|c.get("reason")).cloned().unwrap_or(json!(if selected.is_some(){"Selected mode absent from collection"}else{"Active mode is not established"})),"chain":[chain_entry]}),
            );
        }
        base["modes"] = json!(mode_values);
        Ok(base)
    }
}
fn name(v: &Value) -> Value {
    v.as_str()
        .map(|s| {
            json!(s
                .chars()
                .scan(0, |len, c| {
                    *len += c.len_utf16();
                    if *len <= 4096 {
                        Some(c)
                    } else {
                        None
                    }
                })
                .collect::<String>())
        })
        .unwrap_or(Value::Null)
}
fn unresolved(reason: &str) -> Value {
    json!({"status":"unresolved","reason":reason})
}
