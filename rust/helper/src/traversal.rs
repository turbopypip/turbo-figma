//! Public selection traversal, executed wholly against the retained native index.
use crate::{
    disk::{id, Disk, Result},
    instances::{self, Context},
    layout::truthy,
    variable_resolver::{self, Modes, Reader},
};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::rc::Rc;
struct Item {
    id: String,
    source: String,
    depth: u64,
    parent: Option<Rc<Value>>,
    parent_id: Option<String>,
    context: Option<Rc<Context>>,
    geometry: Value,
    modes: Rc<Modes>,
}
fn slot(d: &mut Disk, id: &str) -> Result<Value> {
    d.runtime_command(&json!({"op":"slot","id":id}))
}
fn dependency(
    d: &mut Disk,
    key: &str,
    reads: &mut usize,
    bytes: &mut usize,
) -> Result<Option<Value>> {
    let len = slot(d, key)?["length"].as_u64().unwrap_or(0) as usize;
    *reads += 1;
    *bytes += len;
    if *reads > 20000 || *bytes > 64 * 1024 * 1024 {
        return Err("Component dependency read budget exceeded".into());
    }
    if len > 0 {
        Ok(Some(d.node(key, false)?))
    } else {
        Ok(None)
    }
}
fn children(
    d: &mut Disk,
    key: &str,
    dependent: bool,
    reads: &mut usize,
    bytes: &mut usize,
) -> Result<Vec<String>> {
    let children = d.children(key)?;
    if dependent {
        for child in &children {
            dependency(d, child, reads, bytes)?;
        }
    }
    Ok(children)
}
fn shorten(v: &Value) -> Option<Value> {
    v.as_str().map(|s| {
        json!(s
            .chars()
            .scan(0, |len, c| {
                *len += c.len_utf16();
                if *len <= 100 {
                    Some(c)
                } else {
                    None
                }
            })
            .collect::<String>())
    })
}
fn abbreviated(entry: &Value, n: &Value) -> Value {
    let mut e = json!({"id":entry["id"],"parentId":entry["parentId"],"depth":entry["depth"],"propertiesOmitted":"Node exceeds output limit"});
    for k in ["name", "type"] {
        if let Some(v) = shorten(&n[k]) {
            e[k] = v;
        }
    }
    e
}
pub fn query(d: &mut Disk, q: &Value) -> Result<Value> {
    let root = q["id"].as_str().ok_or("Invalid node GUID")?;
    let file = q["fileKey"].as_str().ok_or("Invalid file key")?;
    let depth = q["depth"]
        .as_u64()
        .filter(|n| *n <= 50)
        .ok_or("Invalid traversal limits")?;
    let max = q["maxNodes"]
        .as_u64()
        .filter(|n| *n >= 1 && *n <= 500)
        .ok_or("Invalid traversal limits")? as usize;
    let offset = q["offset"]
        .as_u64()
        .filter(|n| *n <= 9007199254740991)
        .ok_or("Invalid traversal limits")?;
    if q.get("format")
        .is_some_and(|v| v != "context" && v != "debug")
    {
        return Err("Invalid response format".into());
    }
    let budget = q
        .get("maxBytes")
        .map(|v| {
            v.as_u64()
                .filter(|n| *n >= 4096 && *n <= 150000)
                .ok_or("Invalid response byte limit")
        })
        .transpose()?
        .unwrap_or(150000) as usize
        - 3072;
    d.runtime_command(&json!({"op":"select","id":root}))?;
    let root_node = d.node(root, true)?;
    let mut ancestor = root_node["parentIndex"]["guid"].clone();
    let mut ancestors = vec![];
    let mut ids = HashSet::from([root.to_owned()]);
    let mut default_mode = true;
    while truthy(&ancestor) {
        let key = id(&ancestor)?;
        if ids.contains(&key) || ancestors.len() >= 64 {
            return Err("Cycle in ancestors or depth limit exceeded".into());
        }
        ids.insert(key.clone());
        if slot(d, &key)?["length"].as_u64().unwrap_or(0) == 0 {
            default_mode = false;
            break;
        }
        let n = d.node(&key, false)?;
        ancestor = n["parentIndex"]["guid"].clone();
        let canvas = n["type"] == "CANVAS";
        let mut kept = json!({});
        for k in ["type", "resizeToFit", "transform", "variableModeBySetMap"] {
            if let Some(v) = n.get(k) {
                kept[k] = v.clone();
            }
        }
        ancestors.push((key, kept));
        if canvas {
            break;
        }
    }
    let mut geometry = Value::Null;
    let mut modes = Modes::new();
    for (id, n) in ancestors.iter().rev() {
        geometry = crate::geometry::context(n, id, &geometry);
        modes = variable_resolver::inherit(&modes, n, id)?;
    }
    let mut stack = vec![Item {
        id: root.into(),
        source: root.into(),
        depth: 0,
        parent: None,
        parent_id: None,
        context: None,
        geometry,
        modes: Rc::new(modes),
    }];
    let mut seen = HashSet::new();
    let mut nodes = vec![];
    let mut pending = vec![];
    let mut skipped = vec![];
    let (mut eligible, mut pending_count, mut skipped_count, mut unresolved) = (0u64, 0, 0, 0);
    let (mut bytes, mut full) = (0, false);
    let (mut dep_reads, mut dep_bytes, mut var_reads, mut var_bytes) = (0, 0, 0, 0);
    let applied = q["applied"].as_u64().unwrap_or(0);
    while let Some(item) = stack.pop() {
        crate::engine::check_cancel()?;
        if !seen.insert(item.id.clone()) {
            return Err("Cycle in selected tree".into());
        }
        let source = if item.context.is_some() {
            dependency(d, &item.source, &mut dep_reads, &mut dep_bytes)?
                .ok_or("Selected node not present in capture")?
        } else {
            d.node(&item.source, true)?
        };
        let mut n = instances::node(&source, item.context.as_deref())?;
        if seen.len() > 200000 {
            return Err("Rendered selection node limit exceeded".into());
        }
        let mut child_source = item.source.clone();
        let mut child_context = item.context.clone();
        let mut skip_children = false;
        if n["type"] == "INSTANCE" {
            match instances::enter(
                &n,
                &item.id,
                &mut |id| dependency(d, id, &mut dep_reads, &mut dep_bytes),
                item.context.as_deref(),
            )? {
                Ok(e) => {
                    n = e.node;
                    child_source = e.master;
                    child_context = Some(Rc::new(e.context));
                }
                Err(error) => {
                    n["instanceUnresolved"] = json!(true);
                    n["instanceError"] = json!(error);
                    n["component"] = json!({"status":"unresolved","reason":error,"complete":false});
                    skip_children = true;
                }
            }
        }
        let modes = Rc::new(variable_resolver::inherit(&item.modes, &n, &item.id)?);
        let mut reader = Reader {
            disk: d,
            reads: var_reads,
            bytes: var_bytes,
            default_mode,
        };
        let (effective, bindings) = crate::bindings::apply(&n, &modes, &mut reader)?;
        var_reads = reader.reads;
        var_bytes = reader.bytes;
        n = effective;
        let geometry = crate::geometry::context(&n, &item.id, &item.geometry);
        if q["includeHidden"] != true && n["visible"] == false {
            skipped_count += 1;
            if skipped.len() < 10 {
                skipped.push(item.id);
            }
            continue;
        }
        if truthy(&n["instanceUnresolved"]) {
            unresolved += 1;
        }
        let output = eligible >= offset;
        eligible += 1;
        if output && nodes.len() < max && !full {
            let parent_id = if let Some(p) = &item.parent_id {
                json!(p)
            } else if truthy(&n["parentIndex"]) {
                json!(id(&n["parentIndex"]["guid"])?)
            } else {
                Value::Null
            };
            let parent = if let Some(p) = &item.parent {
                (**p).clone()
            } else if let Some(p) = parent_id.as_str() {
                if slot(d, p)?["length"].as_u64().unwrap_or(0) > 0 {
                    d.node(p, false)?
                } else {
                    Value::Null
                }
            } else {
                Value::Null
            };
            let mut entry = json!({"id":item.id,"parentId":parent_id,"depth":item.depth});
            if item.context.is_some() {
                entry["sourceNodeId"] = json!(item.source);
            }
            let request = json!({"entries":[{"node":n,"entry":entry,"bindings":bindings,"parent":parent,"geometry":geometry}],"schema":q["schema"],"format":q["format"],"maxEntryBytes":120000.min(budget-1)});
            let projected = crate::context::project(&request)?;
            let mut entry = if projected[0].is_null() {
                abbreviated(&entry, &n)
            } else {
                projected[0].clone()
            };
            if crate::json::bytes(&entry)?.len() + 1 > budget {
                entry = json!({"id":entry["id"],"parentId":entry["parentId"],"depth":entry["depth"],"propertiesOmitted":"Node exceeds output limit"});
            }
            let len = crate::json::bytes(&entry)?.len();
            if bytes + len + 1 > budget {
                full = true;
            } else {
                bytes += len + 1;
                nodes.push(entry);
            }
        }
        if skip_children {
            continue;
        }
        if item.depth >= depth {
            let has = if applied > 0 {
                !children(
                    d,
                    &child_source,
                    child_context.is_some(),
                    &mut dep_reads,
                    &mut dep_bytes,
                )?
                .is_empty()
            } else {
                slot(d, &child_source)?["children"].as_u64().unwrap_or(0) > 0
            };
            if has {
                pending_count += 1;
                if pending.len() < 10 {
                    pending.push(item.id);
                }
            }
        } else {
            let mut children = children(
                d,
                &child_source,
                child_context.is_some(),
                &mut dep_reads,
                &mut dep_bytes,
            )?;
            if !matches!(
                n["stackMode"].as_str(),
                Some("HORIZONTAL" | "VERTICAL" | "GRID")
            ) && matches!(
                n["type"].as_str(),
                Some("GROUP" | "BOOLEAN_OPERATION" | "VECTOR" | "FRAME" | "SYMBOL" | "INSTANCE")
            ) {
                children.reverse();
            }
            let parent = Rc::new(n);
            for child in children.into_iter().rev() {
                stack.push(Item {
                    id: child_context
                        .as_ref()
                        .map(|c| format!("{};{child}", c.prefix))
                        .unwrap_or(child.clone()),
                    source: child,
                    depth: item.depth + 1,
                    parent: Some(parent.clone()),
                    parent_id: Some(item.id.clone()),
                    context: child_context.clone(),
                    geometry: geometry.clone(),
                    modes: modes.clone(),
                });
            }
        }
    }
    let stats = d.stats();
    let next = offset + nodes.len() as u64;
    Ok(
        json!({"adapter":"figma-network-snapshot","live":applied>0,"appliedLiveBatches":applied,"fileKey":file,"rootId":root,"documentRecords":stats["documentRecords"],"initialBatches":stats["initialBatches"],"ignoredLiveBatches":stats["ignoredLiveBatches"],"nodes":nodes,"selectionPath":ancestors.iter().filter(|(_,n)|n["type"]!="CANVAS"&&n["type"]!="DOCUMENT").map(|(id,_)|id).collect::<Vec<_>>(),"traversal":{"eligibleRecords":eligible,"returned":nodes.len(),"pendingDepth":pending,"skippedHidden":skipped,"pendingDepthCount":pending_count,"skippedHiddenCount":skipped_count,"diagnosticListsTruncated":pending_count>pending.len()||skipped_count>skipped.len(),"nextOffset":if next<eligible{json!(next)}else{Value::Null},"unresolvedInstanceCount":unresolved},"incomplete":true,"nativeVariables":{"source":"captured-definitions","dependencyReads":var_reads,"dependencyBytes":var_bytes,"complete":false},"components":{"representation":"expanded-supported-subset","complete":false,"dependencyReads":dep_reads,"dependencyBytes":dep_bytes,"limits":{"reads":20000,"bytes":67108864}},"limitations":[if applied>0{"Bounded supported live changes applied to the retained disk index; unsupported changes require recapture."}else{"Captured initial state; freshness is checked by the managed reader."},"Instance children use canonical instance/source paths, not browser-session generated IDs; native variable resolution reports missing definitions and unknown modes; geometry blobs and image assets are not resolved.","Layers order uses wire position for Auto Layout and reverse paint order for other containers; layout parity is verified on the documented control selection."]}),
    )
}
