//! Stage 08 disposable disk index. No document-sized map or decoded-node IPC.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
#[cfg(not(unix))]
use std::io::{Read, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::unix::fs::FileExt;
use std::{
    collections::{HashMap, HashSet},
    fs::{File, OpenOptions},
    path::Path,
    rc::Rc,
};
pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const SLOTS: u64 = 524288;
const SLOT: usize = 48;
const EDGE: usize = 24;
const NODES: usize = 200000;
const NODE_BYTES: usize = 1024 * 1024;
const TOTAL: usize = 512 * 1024 * 1024;
const CACHE_NODES: usize = 2048;
const CACHE_BYTES: usize = 4 * 1024 * 1024;
fn check(ok: bool, error: &'static str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(error.into())
    }
}
fn u32at(b: &[u8], p: usize) -> u32 {
    u32::from_le_bytes(b[p..p + 4].try_into().unwrap())
}
fn u64at(b: &[u8], p: usize) -> u64 {
    u64::from_le_bytes(b[p..p + 8].try_into().unwrap())
}
fn put32(b: &mut [u8], p: usize, n: u32) {
    b[p..p + 4].copy_from_slice(&n.to_le_bytes());
}
fn put64(b: &mut [u8], p: usize, n: u64) {
    b[p..p + 8].copy_from_slice(&n.to_le_bytes());
}
pub fn id(v: &Value) -> Result<String> {
    let n = |key: &str| -> Result<u64> {
        let x = v[key].as_f64().ok_or("Invalid node GUID")?;
        check(
            x.is_finite() && x >= 0. && x <= 9007199254740991. && x.fract() == 0.,
            "Invalid node GUID",
        )?;
        Ok(x as u64)
    };
    Ok(format!("{}:{}", n("sessionID")?, n("localID")?))
}
fn parts(id: &str) -> Result<(u64, u64)> {
    let (a, b) = id.split_once(':').ok_or("Invalid node GUID")?;
    let (a, b) = (a.parse::<u64>()?, b.parse::<u64>()?);
    check(
        a <= 9007199254740991 && b <= 9007199254740991 && id == format!("{a}:{b}"),
        "Invalid node GUID",
    )?;
    Ok((a, b))
}
#[derive(Default)]
pub struct Io {
    pub reads: u64,
    pub read_bytes: u64,
    pub writes: u64,
    pub write_bytes: u64,
}
// Shared immutable decoded nodes: a cache hit does not parse or deep-clone JSON.
#[derive(Debug)]
struct NodeRecord {
    value: Value,
    json_bytes: usize,
}
// Conservative storage charge for serde_json's BTreeMap representation, including
// spare tree slots, strings, Vec capacity, Rc and hash-table entry overhead.
// This is deliberately stricter than charging just the former JSON text.
fn value_heap(v: &Value) -> usize {
    match v {
        Value::String(s) => s.capacity(),
        Value::Array(a) => {
            a.capacity() * std::mem::size_of::<Value>() + a.iter().map(value_heap).sum::<usize>()
        }
        Value::Object(m) => {
            // Current pinned Rust BTreeMap: leaf capacity 11, non-root minimum 5.
            // 768 bounds a leaf (11 key/value pairs plus header); 1024 bounds an
            // internal allocation including its 12 edges. Empty maps allocate no node.
            let tree = if m.is_empty() {
                0
            } else if m.len() <= 11 {
                768
            } else {
                1024 * (1 + (m.len() - 1) / 5)
            };
            tree + m
                .iter()
                .map(|(k, v)| k.capacity() + value_heap(v))
                .sum::<usize>()
        }
        _ => 0,
    }
}
pub struct Disk {
    files: Vec<File>,
    pub io: Io,
    bytes: usize,
    edge_bytes: usize,
    slots: usize,
    pub count: usize,
    started: bool,
    ended: bool,
    batch: usize,
    pub batches: usize,
    pub live: usize,
    selected: HashMap<String, Rc<NodeRecord>>,
    charge: usize,
    projected: HashMap<[u8; 32], String>,
    projected_bytes: usize,
    selection: Option<String>,
    fields: HashSet<String>,
    mutated: bool,
}
impl Disk {
    pub fn close_files(&mut self) { self.files.clear(); }
    pub fn new(dir: &Path, fields: HashSet<String>) -> Result<Self> {
        let open = |name: &str| -> Result<File> {
            let mut o = OpenOptions::new();
            o.read(true).write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                o.mode(0o600);
            }
            Ok(o.open(dir.join(name))?)
        };
        let files = vec![
            open("nodes.bin")?,
            open("index.bin")?,
            open("edges.bin")?,
            open("variable-assets.bin")?,
        ];
        files[1].set_len(SLOTS * SLOT as u64)?;
        files[3].set_len(32768 * 56)?;
        Ok(Self {
            files,
            io: Io::default(),
            bytes: 0,
            edge_bytes: 0,
            slots: 0,
            count: 0,
            started: false,
            ended: false,
            batch: 0,
            batches: 0,
            live: 0,
            selected: HashMap::new(),
            charge: 0,
            projected: HashMap::new(),
            projected_bytes: 0,
            selection: None,
            fields,
            mutated: false,
        })
    }
    fn read(&mut self, file: usize, size: usize, pos: u64) -> Result<Vec<u8>> {
        let mut b = vec![0; size];
        #[cfg(unix)]
        self.files[file]
            .read_exact_at(&mut b, pos)
            .map_err(|_| "Truncated disk index")?;
        #[cfg(not(unix))]
        {
            self.files[file].seek(SeekFrom::Start(pos))?;
            self.files[file]
                .read_exact(&mut b)
                .map_err(|_| "Truncated disk index")?;
        }
        self.io.reads += 1;
        self.io.read_bytes += size as u64;
        Ok(b)
    }
    fn write(&mut self, file: usize, b: &[u8], pos: u64) -> Result<()> {
        #[cfg(unix)]
        self.files[file].write_all_at(b, pos)?;
        #[cfg(not(unix))]
        {
            self.files[file].seek(SeekFrom::Start(pos))?;
            self.files[file].write_all(b)?;
        }
        self.io.writes += 1;
        self.io.write_bytes += b.len() as u64;
        Ok(())
    }
    fn slot(&mut self, key: &str, create: bool) -> Result<Option<(Vec<u8>, u64)>> {
        let (a, b) = parts(key)?;
        let mut hash = 2166136261_u32;
        for c in key.bytes() {
            hash = (hash ^ (c as u32)).wrapping_mul(16777619);
        }
        for i in 0..4096 {
            let p = ((hash as u64 + i) % SLOTS) * SLOT as u64;
            let mut s = self.read(1, SLOT, p)?;
            if s[0] == 0 {
                if !create {
                    return Ok(None);
                }
                self.slots += 1;
                check(
                    self.slots <= NODES * 2,
                    "Disk index identity limit exceeded",
                )?;
                s[0] = 1;
                put64(&mut s, 8, a);
                put64(&mut s, 16, b);
                self.write(1, &s, p)?;
                return Ok(Some((s, p)));
            }
            if u64at(&s, 8) == a && u64at(&s, 16) == b {
                return Ok(Some((s, p)));
            }
        }
        Err("Disk index capacity exceeded".into())
    }
    pub fn accept(&mut self, mut n: Value) -> Result<()> {
        check(self.started, "Node batch before JOIN_START")?;
        self.batch += 1;
        if self.ended {
            return Ok(());
        }
        check(
            n["phase"] == "CREATED",
            "Initial batch contains non-CREATED change",
        )?;
        self.count += 1;
        check(self.count <= NODES, "Node limit exceeded")?;
        let key = id(&n["guid"])?;
        let (mut s, p) = self.slot(&key, true)?.unwrap();
        check(u32at(&s, 32) == 0, "Duplicate node")?;
        n.as_object_mut()
            .ok_or("Invalid node")?
            .retain(|k, _| self.fields.contains(k));
        if n["type"] == "INSTANCE" {
            n["instanceUnresolved"] = true.into();
        }
        let data = crate::json::bytes(&n)?;
        check(
            data.len() <= NODE_BYTES && self.bytes + data.len() <= TOTAL,
            "Decoded node/disk size limit exceeded",
        )?;
        put64(&mut s, 24, self.bytes as u64);
        put32(&mut s, 32, data.len() as u32);
        self.write(0, &data, self.bytes as u64)?;
        self.write(1, &s, p)?;
        self.bytes += data.len();
        self.add_asset(&n)?;
        if !n["parentIndex"].is_null() {
            let parent = id(&n["parentIndex"]["guid"])?;
            let position = n["parentIndex"]["position"]
                .as_str()
                .ok_or("Invalid sibling position")?;
            let (mut s, p) = self.slot(&parent, true)?.unwrap();
            let (a, b) = parts(&key)?;
            let mut e = [0; EDGE];
            put64(&mut e, 0, a);
            put64(&mut e, 8, b);
            put32(&mut e, 16, u32at(&s, 36));
            // Immutable initial edges retain their ordering key. Traversal no
            // longer parses a complete child JSON node merely to sort siblings.
            put32(&mut e, 20, position.len() as u32);
            let head = self.edge_bytes as u32 + 1;
            let mut record = Vec::with_capacity(EDGE + position.len());
            record.extend_from_slice(&e);
            record.extend_from_slice(position.as_bytes());
            self.write(2, &record, self.edge_bytes as u64)?;
            self.edge_bytes += EDGE + position.len();
            let count = u32at(&s, 40);
            put32(&mut s, 36, head);
            put32(&mut s, 40, count + 1);
            self.write(1, &s, p)?;
        }
        Ok(())
    }
    pub fn message(&mut self, m: &Value) -> Result<()> {
        let t = m["type"].as_str().ok_or("Invalid message type")?;
        check(
            t == "NODE_CHANGES" || self.batch == 0,
            "Nodes outside initial node batch",
        )?;
        match t {
            "JOIN_START" => {
                check(!self.started, "Repeated JOIN_START")?;
                self.started = true
            }
            "JOIN_END" => {
                check(self.started && !self.ended, "Invalid JOIN_END")?;
                self.ended = true
            }
            "NODE_CHANGES" => {
                check(self.started && self.batch > 0, "Missing node changes")?;
                if self.ended {
                    self.live += 1
                } else {
                    self.batches += 1
                }
            }
            _ => {}
        }
        self.batch = 0;
        Ok(())
    }
    pub fn finish(&self) -> Result<()> {
        check(
            self.ended && self.count > 0,
            "Incomplete initial load: JOIN_END or nodes missing. Recapture after loading finishes.",
        )
    }
    pub fn node(&mut self, key: &str, cache: bool) -> Result<Value> {
        Ok(self.node_record(key, cache)?.value.clone())
    }
    fn node_record(&mut self, key: &str, cache: bool) -> Result<Rc<NodeRecord>> {
        if let Some(n) = self.selected.get(key) {
            return Ok(Rc::clone(n));
        }
        let (s, _) = self
            .slot(key, false)?
            .ok_or("Selected node not present in capture")?;
        let len = u32at(&s, 32) as usize;
        check(len > 0, "Selected node not present in capture")?;
        check(len <= NODE_BYTES, "Corrupt disk node length")?;
        let b = self.read(0, len, u64at(&s, 24))?;
        let value: Value = serde_json::from_slice(&b)?;
        let charge = value_heap(&value) + key.len() + 128 + std::mem::size_of::<NodeRecord>();
        let node = Rc::new(NodeRecord {
            value,
            json_bytes: len,
        });
        if cache
            && self.selection.is_some()
            && self.selected.len() < CACHE_NODES
            && self.charge + charge <= CACHE_BYTES
        {
            self.charge += charge;
            self.selected.insert(key.into(), Rc::clone(&node));
        }
        Ok(node)
    }
    pub fn children(&mut self, key: &str) -> Result<Vec<String>> {
        let Some((s, _)) = self.slot(key, false)? else {
            return Ok(vec![]);
        };
        check(
            u32at(&s, 40) <= 10000,
            "Sibling count limit exceeded; select a smaller branch",
        )?;
        let mut next = u32at(&s, 36);
        let mut list = vec![];
        let mut unique = HashSet::new();
        let mut bytes = 0;
        let mut edges = 0;
        while next != 0 {
            edges += 1;
            check(
                edges <= u32at(&s, 40) && (next as usize + EDGE - 1) <= self.edge_bytes,
                "Corrupt disk edge chain",
            )?;
            let offset = (next - 1) as u64;
            let e = self.read(2, EDGE, offset)?;
            next = u32at(&e, 16);
            let child = format!("{}:{}", u64at(&e, 0), u64at(&e, 8));
            if unique.contains(&child) {
                continue;
            }
            let len = u32at(&e, 20) as usize;
            check(
                len <= NODE_BYTES && offset as usize + EDGE + len <= self.edge_bytes,
                "Corrupt disk edge position",
            )?;
            let mut position = String::from_utf8(self.read(2, len, offset + EDGE as u64)?)?;
            if self.mutated {
                let Some((slot, _)) = self.slot(&child, false)? else {
                    continue;
                };
                if u32at(&slot, 32) == 0 {
                    continue;
                }
                let n = self.node(&child, false)?;
                if n["parentIndex"].is_null() || id(&n["parentIndex"]["guid"])? != key {
                    continue;
                }
                position = n["parentIndex"]["position"]
                    .as_str()
                    .ok_or("Invalid sibling position")?
                    .into();
            }
            bytes += position.len() + child.len();
            check(
                bytes <= 2 * 1024 * 1024,
                "Sibling ordering size limit exceeded",
            )?;
            unique.insert(child.clone());
            list.push((child, position));
        }
        // JS compares positions by UTF-16; decimal GUID ties have localeCompare's order.
        list.sort_by(|a, b| {
            a.1.encode_utf16().cmp(b.1.encode_utf16()).then_with(|| {
                a.0.bytes()
                    .map(|c| if c == b':' { 0 } else { c })
                    .cmp(b.0.bytes().map(|c| if c == b':' { 0 } else { c }))
            })
        });
        Ok(list.into_iter().map(|(id, _)| id).collect())
    }
    fn asset_slot(
        &mut self,
        kind: &str,
        key: &str,
        version: Option<&str>,
    ) -> Result<(Vec<u8>, u64, Vec<u8>)> {
        check(
            key.encode_utf16().count() <= 4096
                && version.map_or(0, |s| s.encode_utf16().count()) <= 256,
            "Variable asset identity limit exceeded",
        )?;
        let digest = Sha256::digest(serde_json::to_vec(&json!([kind, key, version]))?).to_vec();
        let start = u32at(&digest, 0) as u64 % 32768;
        for i in 0..4096 {
            let p = ((start + i) % 32768) * 56;
            let b = self.read(3, 56, p)?;
            if b[48] == 0 || b[..32] == digest {
                return Ok((b, p, digest));
            }
        }
        Err("Variable asset index capacity exceeded".into())
    }
    fn add_asset(&mut self, n: &Value) -> Result<()> {
        let kind = n["type"].as_str().unwrap_or("");
        let Some(key) = n["key"].as_str() else {
            return Ok(());
        };
        if !["VARIABLE", "VARIABLE_SET"].contains(&kind) {
            return Ok(());
        }
        let (a, b) = parts(&id(&n["guid"])?)?;
        let mut versions = vec![None];
        if let Some(v) = n["version"].as_str() {
            versions.push(Some(v));
        }
        for version in versions {
            let (mut buf, p, digest) = self.asset_slot(kind, key, version)?;
            if buf[48] != 0 {
                if u64at(&buf, 32) != a || u64at(&buf, 40) != b {
                    buf[48] = 2;
                }
            } else {
                buf[..32].copy_from_slice(&digest);
                put64(&mut buf, 32, a);
                put64(&mut buf, 40, b);
                buf[48] = 1;
            }
            self.write(3, &buf, p)?;
        }
        Ok(())
    }
    pub fn asset(&mut self, kind: &str, reference: &Value) -> Result<Value> {
        let Some(key) = reference["key"].as_str() else {
            return Ok(Value::Null);
        };
        let (b, _, _) = self.asset_slot(kind, key, reference["version"].as_str())?;
        Ok(if b[48] == 1 {
            json!(format!("{}:{}", u64at(&b, 32), u64at(&b, 40)))
        } else {
            Value::Null
        })
    }
    // Internal trusted host commands. Live semantic validation remains in the
    // existing projection adapter; Rust owns all index reads, writes and caching.
    /// Immutable public pages share the existing bounded projection cache.
    /// Selection and every accepted mutation clear both raw and projected entries.
    pub fn context_query(&mut self, q: &Value) -> Result<Value> {
        self.runtime_command(&json!({"op":"select","id":q["id"]}))?;
        let mut hash = Sha256::new();
        hash.update(b"public-context-v1");
        hash.update(serde_json::to_vec(q)?);
        let digest: [u8;32] = hash.finalize().into();
        if let Some(cached) = self.projected.get(&digest) { return Ok(serde_json::from_str(cached)?); }
        let result = crate::traversal::query(self,q)?;
        let text = String::from_utf8(crate::json::bytes(&result)?)?;
        let charge = text.capacity()+256;
        if self.projected.len()<128 && self.projected_bytes+charge<=4*1024*1024 {
            self.projected.insert(digest,text); self.projected_bytes+=charge;
        }
        Ok(result)
    }
    pub fn runtime_command(&mut self, q: &Value) -> Result<Value> {
        let key = || q["id"].as_str().ok_or("Invalid node GUID");
        match q["op"].as_str() {
            Some("batch") => {
                let requests = q["requests"].as_array().ok_or("Invalid read batch")?;
                check(requests.len() <= 512, "Read batch count limit exceeded")?;
                let mut result = Vec::new();
                let mut bytes = 2; // Array brackets; commas are charged below.
                for (index, request) in requests.iter().enumerate() {
                    check(
                        matches!(
                            request["op"].as_str(),
                            Some("node" | "slot" | "children" | "asset")
                        ),
                        "Invalid read batch operation",
                    )?;
                    // Speculative reads never turn an unused lookup failure into a query failure.
                    if let Ok(value) = self.runtime_command(request) {
                        let item = json!([index, serde_json::to_string(&value)?]);
                        bytes += serde_json::to_vec(&item)?.len() + 1;
                        if bytes > 1024 * 1024 {
                            break;
                        }
                        result.push(item);
                    }
                }
                Ok(json!(result))
            }
            Some("select") => {
                let k = key()?;
                parts(k)?;
                if self.selection.as_deref() != Some(k) {
                    self.clear();
                    self.selection = Some(k.into());
                }
                Ok(Value::Null)
            }
            Some("invalidate") => {
                self.selected.clear();
                self.charge = 0;
                self.projected.clear();
                self.projected_bytes = 0;
                Ok(Value::Null)
            }
            Some("node") => self.node(key()?, q["cache"].as_bool().unwrap_or(true)),
            Some("slot") => Ok(match self.slot(key()?, false)? {
                Some((s, _)) => json!({"length":u32at(&s,32),"children":u32at(&s,40)}),
                None => Value::Null,
            }),
            Some("children") => Ok(json!(self.children(key()?)?)),
            Some("asset") => self.asset(q["type"].as_str().ok_or("Invalid asset type")?, &q["ref"]),
            Some("query") => self.query(q),
            Some("contextQuery") => self.context_query(q),
            Some("uikit") => crate::uikit::command(&q["command"]),
            Some("storeVerify") => crate::store::retained_verify(&q["command"]),
            Some("project") => {
                let requests = q["entries"]
                    .as_array()
                    .ok_or("Invalid projection entries")?;
                check(requests.len() <= 8, "Projection batch count limit exceeded")?;
                let digest: [u8; 32] = Sha256::digest(serde_json::to_vec(q)?).into();
                if let Some(cached) = self.projected.get(&digest) {
                    return Ok(serde_json::from_str(cached)?);
                }
                let mut expanded = q.clone();
                for item in expanded["entries"].as_array_mut().unwrap() {
                    if let Some(id) = item["id"].as_str() {
                        let mut node = self.node(id, false)?;
                        let patch = item["patch"]
                            .as_object()
                            .ok_or("Invalid projection patch")?;
                        let removed = item["removed"]
                            .as_array()
                            .ok_or("Invalid projection removals")?;
                        for (key, value) in patch {
                            node[key] = value.clone();
                        }
                        for key in removed {
                            node.as_object_mut()
                                .ok_or("Invalid projection source")?
                                .remove(key.as_str().ok_or("Invalid removed field")?);
                        }
                        item["node"] = node;
                    }
                }
                let result = crate::context::project(&expanded)?;
                let text = String::from_utf8(crate::json::bytes(&result)?)?;
                let charge = text.capacity() + 256;
                if self.projected.len() < 128 && self.projected_bytes + charge <= 4 * 1024 * 1024 {
                    self.projected.insert(digest, text);
                    self.projected_bytes += charge;
                }
                Ok(result)
            }
            Some("remove") => {
                let (mut s, p) = self.slot(key()?, false)?.ok_or("Missing live node")?;
                check(u32at(&s, 32) > 0, "Missing live node")?;
                put32(&mut s, 32, 0);
                self.write(1, &s, p)?;
                self.count -= 1;
                self.selected.clear();
                self.charge = 0;
                self.projected.clear();
                self.projected_bytes = 0;
                self.mutated = true;
                Ok(Value::Null)
            }
            Some("upsert") => {
                self.runtime_upsert(&q["node"])?;
                Ok(Value::Null)
            }
            _ => Err("Unknown runtime operation".into()),
        }
    }
    pub fn apply_live(&mut self, changes: &[Value]) -> Result<()> {
        check(
            self.ended && self.selection.is_some(),
            "Live index is unavailable",
        )?;
        check(
            !changes.is_empty() && changes.len() <= 256,
            "Live batch limit exceeded",
        )?;
        self.selected.clear();
        self.charge = 0;
        self.projected.clear();
        self.projected_bytes = 0;
        let mut ids = HashSet::new();
        let supported = |v: &Value| {
            matches!(
                v.as_str(),
                Some("FRAME" | "GROUP" | "RECTANGLE" | "ELLIPSE" | "LINE" | "TEXT" | "VECTOR")
            )
        };
        for change in changes {
            crate::live::validate(change)?;
            let key = id(&change["guid"])?;
            check(ids.insert(key.clone()), "Repeated GUID in live batch")?;
            let slot = self.slot(&key, false)?;
            let old = if slot.as_ref().is_some_and(|(s, _)| u32at(s, 32) > 0) {
                Some(self.node(&key, false)?)
            } else {
                None
            };
            let created = change["phase"] == "CREATED";
            check(
                if created {
                    old.is_none() && slot.is_none()
                } else {
                    old.is_some()
                },
                "Ambiguous live creation/update/removal",
            )?;
            if let Some(n) = &old {
                check(supported(&n["type"]), "Unsupported live target type")?;
            }
            if created {
                check(
                    supported(&change["type"]) && change.get("parentIndex").is_some(),
                    "Incomplete live creation",
                )?;
            } else if let Some(t) = change.get("type") {
                check(
                    Some(t) == old.as_ref().map(|v| &v["type"]),
                    "Live type change unsupported",
                )?;
            }
            if change["phase"] == "REMOVED" {
                check(
                    self.selection.as_deref() != Some(&key) && self.children(&key)?.is_empty(),
                    "Removing selection root or non-leaf requires recapture",
                )?;
                self.runtime_command(&json!({"op":"remove","id":key}))?;
                continue;
            }
            let mut merged = old.unwrap_or_else(|| json!({}));
            for (k, v) in change.as_object().ok_or("Invalid live change")? {
                merged[k] = v.clone();
            }
            merged["phase"] = json!("CREATED");
            let mut parent = merged["parentIndex"]["guid"].clone();
            let mut ancestors = HashSet::from([key]);
            while !parent.is_null() {
                let p = id(&parent)?;
                check(
                    !ancestors.contains(&p) && ancestors.len() <= 64,
                    "Live parent cycle/depth limit",
                )?;
                ancestors.insert(p.clone());
                let n = self.node(&p, false)?;
                check(
                    matches!(
                        n["type"].as_str(),
                        Some("FRAME" | "GROUP" | "CANVAS" | "DOCUMENT")
                    ),
                    "Unsupported live parent dependency",
                )?;
                parent = n["parentIndex"]["guid"].clone();
            }
            self.runtime_upsert(&merged)?;
        }
        Ok(())
    }
    fn runtime_upsert(&mut self, n: &Value) -> Result<()> {
        let key = id(&n["guid"])?;
        let previous = self.slot(&key, false)?;
        let old = if previous.as_ref().is_some_and(|(s, _)| u32at(s, 32) > 0) {
            Some(self.node(&key, false)?)
        } else {
            None
        };
        let data = crate::json::bytes(n)?;
        check(
            data.len() <= NODE_BYTES && self.bytes + data.len() <= TOTAL,
            "Live disk size limit exceeded",
        )?;
        if old.is_none() {
            check(self.count < NODES, "Live node limit exceeded")?;
            self.count += 1;
        }
        let (mut s, p) = self.slot(&key, true)?.unwrap();
        self.write(0, &data, self.bytes as u64)?;
        put64(&mut s, 24, self.bytes as u64);
        put32(&mut s, 32, data.len() as u32);
        self.write(1, &s, p)?;
        self.bytes += data.len();
        if !n["parentIndex"].is_null() {
            let parent = id(&n["parentIndex"]["guid"])?;
            let previous_parent = old
                .as_ref()
                .filter(|n| !n["parentIndex"].is_null())
                .map(|n| id(&n["parentIndex"]["guid"]))
                .transpose()?;
            if previous_parent.as_deref() != Some(&parent) {
                let (mut s, p) = self.slot(&parent, false)?.ok_or("Missing live parent")?;
                let count = u32at(&s, 40);
                check(count < 10000, "Live sibling edge limit exceeded")?;
                let position = n["parentIndex"]["position"]
                    .as_str()
                    .ok_or("Invalid sibling position")?;
                check(
                    position.encode_utf16().count() <= 4096,
                    "Invalid live sibling position",
                )?;
                let (a, b) = parts(&key)?;
                let mut edge = vec![0; EDGE];
                put64(&mut edge, 0, a);
                put64(&mut edge, 8, b);
                put32(&mut edge, 16, u32at(&s, 36));
                put32(&mut edge, 20, position.len() as u32);
                edge.extend_from_slice(position.as_bytes());
                let head = self.edge_bytes as u32 + 1;
                self.write(2, &edge, self.edge_bytes as u64)?;
                self.edge_bytes += edge.len();
                put32(&mut s, 36, head);
                put32(&mut s, 40, count + 1);
                self.write(1, &s, p)?;
            }
        }
        self.selected.clear();
        self.charge = 0;
        self.projected.clear();
        self.projected_bytes = 0;
        self.mutated = true;
        Ok(())
    }
    pub fn stats(&self) -> Value {
        json!({"projectionCache":{"entries":self.projected.len(),"bytes":self.projected_bytes},"cache":{"nodes":self.selected.len(),"bytes":self.charge},"documentRecords":self.count,"initialBatches":self.batches,"ignoredLiveBatches":self.live,"scratchBytes":SLOTS*SLOT as u64+32768*56+self.bytes as u64+self.edge_bytes as u64,"nodeBytes":self.bytes,"io":{"reads":self.io.reads,"readBytes":self.io.read_bytes,"writes":self.io.writes,"writeBytes":self.io.write_bytes}})
    }
    pub fn clear(&mut self) {
        self.selected = HashMap::new();
        self.charge = 0;
        self.projected.clear();
        self.projected_bytes = 0;
        self.selection = None;
    }
    pub fn query(&mut self, q: &Value) -> Result<Value> {
        let key = q["rootId"].as_str().ok_or("Invalid node GUID")?;
        parts(key)?;
        let depth = q["depth"].as_u64().ok_or("Invalid traversal limits")?;
        let max = q["maxNodes"].as_u64().ok_or("Invalid traversal limits")?;
        let offset = q["offset"].as_u64().ok_or("Invalid traversal limits")?;
        let budget = q["maxBytes"].as_u64().unwrap_or(24000);
        check(
            depth <= 50
                && max > 0
                && max <= 500
                && offset <= 9007199254740991
                && (4096..=1024 * 1024).contains(&budget),
            "Invalid traversal limits",
        )?;
        if self.selection.as_deref() != Some(key) {
            self.clear();
            self.selection = Some(key.into());
        }
        let root = self.node_record(key, true)?;
        let mut ancestor = root.value["parentIndex"]["guid"].clone();
        drop(root);
        let mut ancestors = HashSet::from([key.to_owned()]);
        let mut path = vec![];
        while !ancestor.is_null() {
            let a = id(&ancestor)?;
            check(
                !ancestors.contains(&a) && ancestors.len() <= 64,
                "Cycle in ancestors or depth limit exceeded",
            )?;
            ancestors.insert(a.clone());
            let Some((s, _)) = self.slot(&a, false)? else {
                break;
            };
            if u32at(&s, 32) == 0 {
                break;
            }
            let record = self.node_record(&a, false)?;
            let n = &record.value;
            if n["type"] == "CANVAS" {
                break;
            }
            if n["type"] != "DOCUMENT" {
                path.push(a)
            }
            ancestor = n["parentIndex"]["guid"].clone();
        }
        let mut stack = vec![(key.to_owned(), 0_u64)];
        let mut seen = HashSet::new();
        let mut nodes = vec![];
        let (mut eligible, mut pending_count, mut skipped_count) = (0_u64, 0, 0);
        let (mut pending, mut skipped) = (vec![], vec![]);
        let mut bytes = 0;
        let mut full = false;
        while let Some((key, d)) = stack.pop() {
            check(seen.insert(key.clone()), "Cycle in selected tree")?;
            check(
                seen.len() <= NODES,
                "Rendered selection node limit exceeded",
            )?;
            let record = self.node_record(&key, true)?;
            let n = &record.value;
            if q["includeHidden"] != true && n["visible"] == false {
                skipped_count += 1;
                if skipped.len() < 10 {
                    skipped.push(key)
                }
                continue;
            }
            if eligible >= offset && nodes.len() < (max as usize) && !full {
                // JSON node bytes are immutable in this disposable initial index.
                // Count only the small wrapper; don't serialize the entire node again.
                let mut entry = json!({"id":key,"depth":d,"node":null});
                let mut len = crate::json::bytes(&entry)?.len() - 4 + record.json_bytes;
                let omitted = len + 1 > budget as usize - 3072;
                if omitted {
                    entry =
                        json!({"id":key,"depth":d,"propertiesOmitted":"Node exceeds output limit"});
                    len = crate::json::bytes(&entry)?.len();
                }
                if bytes + len + 1 > budget as usize - 3072 {
                    full = true;
                } else {
                    if !omitted {
                        entry["node"] = n.clone();
                    }
                    bytes += len + 1;
                    nodes.push(entry);
                }
            }
            eligible += 1;
            if d >= depth {
                if self
                    .slot(&key, false)?
                    .is_some_and(|(s, _)| u32at(&s, 40) > 0)
                {
                    pending_count += 1;
                    if pending.len() < 10 {
                        pending.push(key)
                    }
                }
            } else {
                let mut children = self.children(&key)?;
                if !["HORIZONTAL", "VERTICAL", "GRID"]
                    .contains(&n["stackMode"].as_str().unwrap_or(""))
                    && [
                        "GROUP",
                        "BOOLEAN_OPERATION",
                        "VECTOR",
                        "FRAME",
                        "SYMBOL",
                        "INSTANCE",
                    ]
                    .contains(&n["type"].as_str().unwrap_or(""))
                {
                    children.reverse();
                }
                for child in children.into_iter().rev() {
                    stack.push((child, d + 1));
                }
            }
        }
        let next = offset + nodes.len() as u64;
        let mut result = json!({"rootId":key,"selectionPath":path,"traversal":{"eligibleRecords":eligible,"returned":nodes.len(),"pendingDepth":pending,"skippedHidden":skipped,"pendingDepthCount":pending_count,"skippedHiddenCount":skipped_count,"diagnosticListsTruncated":pending_count>10||skipped_count>10,"nextOffset":if next<eligible{Some(next)}else{None}}});
        result["nodes"] = Value::Array(nodes);
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disk_integrity_and_join_contract() {
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.cache/figma-network");
        std::fs::create_dir_all(&base).unwrap();
        let dir = base.join(format!("stage8-unit-{}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        {
            let fields = ["guid", "phase", "parentIndex", "type"]
                .map(str::to_owned)
                .into_iter()
                .collect();
            let mut d = Disk::new(&dir, fields).unwrap();
            assert!(d.finish().is_err());
            d.message(&json!({"type":"JOIN_START"})).unwrap();
            assert!(d.message(&json!({"type":"JOIN_START"})).is_err());
            d.accept(json!({"guid":{"sessionID":1,"localID":1},"phase":"CREATED","type":"FRAME"}))
                .unwrap();
            d.accept(json!({"guid":{"sessionID":1,"localID":2},"phase":"CREATED","parentIndex":{"guid":{"sessionID":1,"localID":1},"position":"a"}})).unwrap();
            d.message(&json!({"type":"NODE_CHANGES"})).unwrap();
            d.message(&json!({"type":"JOIN_END"})).unwrap();
            d.finish().unwrap();
            // Cache hits share the immutable value and do not read or reparse it.
            d.selection = Some("1:1".into());
            let first = d.node_record("1:1", true).unwrap();
            let reads = d.io.reads;
            let second = d.node_record("1:1", true).unwrap();
            assert!(Rc::ptr_eq(&first, &second));
            assert_eq!(reads, d.io.reads);
            d.clear();
            assert_eq!(d.charge, 0);
            assert_eq!(Rc::strong_count(&first), 2);
            drop((first, second));
            // Bounds used by the conservative BTreeMap heap charge.
            assert!(std::mem::size_of::<Value>() <= 32);
            assert!(
                11 * (std::mem::size_of::<String>() + std::mem::size_of::<Value>()) + 64 <= 768
            );
            // A corrupt position length is bounded before allocation.
            let good = d.read(2, EDGE, 0).unwrap();
            let mut bad = good.clone();
            put32(&mut bad, 20, (NODE_BYTES + 1) as u32);
            d.write(2, &bad, 0).unwrap();
            assert!(d
                .children("1:1")
                .unwrap_err()
                .to_string()
                .contains("Corrupt disk edge position"));
            d.write(2, &good, 0).unwrap();
            // A corrupt edge loop must fail, not run forever.
            let mut edge = d.read(2, EDGE, 0).unwrap();
            put32(&mut edge, 16, 1);
            d.write(2, &edge, 0).unwrap();
            assert!(d
                .children("1:1")
                .unwrap_err()
                .to_string()
                .contains("Corrupt disk edge"));
            let (mut slot, p) = d.slot("1:1", false).unwrap().unwrap();
            put32(&mut slot, 32, (NODE_BYTES + 1) as u32);
            d.write(1, &slot, p).unwrap();
            assert!(d
                .node("1:1", false)
                .unwrap_err()
                .to_string()
                .contains("Corrupt disk node"));
            put32(&mut slot, 32, 50);
            d.write(1, &slot, p).unwrap();
            d.files[0].set_len(0).unwrap();
            assert!(d
                .node("1:1", false)
                .unwrap_err()
                .to_string()
                .contains("Truncated disk index"));
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
