//! Native capture ownership, retained-reader lifecycle and authenticated pagination.
use crate::{
    disk::{Disk, Result},
    inspector::Inspector,
    instances::array,
    input,
    wire_value::value,
    store, uikit,
    wire::Decoder,
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
thread_local! {static CANCELLATION:std::cell::RefCell<Option<Arc<AtomicBool>>>=const { std::cell::RefCell::new(None) };}
pub fn check_cancel() -> Result<()> {
    CANCELLATION.with(|c| {
        if c.borrow()
            .as_ref()
            .is_some_and(|f| f.load(Ordering::Relaxed))
        {
            Err("Request cancelled".into())
        } else {
            Ok(())
        }
    })
}
pub fn random() -> Result<String> {
    let mut b = [0u8; 24];
    crate::platform::random(&mut b)?;
    Ok(b.iter().map(|b| format!("{b:02x}")).collect())
}
fn hash(v: &Value) -> Result<String> {
    Ok(Sha256::digest(crate::json::bytes(v)?)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}
fn cancelled(flag: &AtomicBool) -> Result<()> {
    if flag.load(Ordering::Relaxed) {
        Err("Request cancelled".into())
    } else {
        Ok(())
    }
}
struct Capture {
    snapshot: Value,
    stamp: Value,
    parts: Vec<Value>,
    bytes: u64,
    inspector: Inspector,
    revision: u64,
    document_revision: u64,
    live_bytes: usize,
    ready: bool,
    expires: Instant,
}
struct Retained {
    disk: Disk,
    scratch: PathBuf,
    key: String,
    applied: u64,
    codec: Decoder,
    last: Instant,
    query: Value,
    schema: String,
}
impl Drop for Retained {
    fn drop(&mut self) {
        self.disk.close_files();
        let _ = fs::remove_dir_all(&self.scratch);
    }
}
struct Lease {
    snapshot: Value,
    expires: Instant,
    reply: Value,
}
pub struct Engine {
    lease: Arc<Mutex<Option<Lease>>>,
    root: PathBuf,
    stamps: Value,
    capture: Option<Capture>,
    retained: Option<Retained>,
    secret: Vec<u8>,
    stale_file: Option<String>,
    fields: HashSet<String>,
}
impl Engine {
    pub fn new(project: &str) -> Result<Self> {
        let project = crate::platform::canonicalize(project)?;
        let cache = project.join(".cache");
        let root = cache.join("figma-network");
        for p in [&cache, &root] {
            if !p.exists() {
                store::mkdir(p)?;
            }
        }
        let stamps = json!([[cache, store::stamp(&cache)?], [root, store::stamp(&root)?]]);
        let secret = random()?.into_bytes();
        let fields = serde_json::from_str::<Vec<String>>(include_str!("../../resources/fields.json"))?
            .into_iter()
            .collect();
        let engine = Self {
            lease: Arc::new(Mutex::new(None)),
            root,
            stamps,
            capture: None,
            retained: None,
            secret,
            stale_file: None,
            fields,
        };
        engine.store(json!({"op":"clean","mode":"prune"}))?;
        Ok(engine)
    }
    fn store(&self, mut q: Value) -> Result<Value> {
        q["root"] = json!(self.root);
        q["stamps"] = self.stamps.clone();
        store::command(&q)
    }
    fn invalidate(&mut self) {
        *self.lease.lock().unwrap() = None;
        if let Some(c) = &self.capture {
            if c.ready {
                self.stale_file = c.snapshot["fileKey"].as_str().map(str::to_owned);
            }
        }
        self.capture = None;
        self.retained = None;
    }
    fn release(&mut self) {
        if self.retained.take().is_some()
            && self
                .capture
                .as_ref()
                .is_some_and(|c| c.document_revision > 0)
        {
            self.invalidate();
        }
    }
    fn check(&mut self) -> Result<()> {
        if self.capture.as_ref().is_some_and(|c| {
            if c.ready {
                self.lease
                    .lock()
                    .unwrap()
                    .as_ref()
                    .is_none_or(|l| l.snapshot != c.snapshot || Instant::now() >= l.expires)
            } else {
                Instant::now() >= c.expires
            }
        }) {
            self.invalidate();
            return Err("STALE: observation expired; reload and capture again".into());
        }
        if self
            .retained
            .as_ref()
            .is_some_and(|r| r.last.elapsed() >= Duration::from_secs(60))
        {
            self.release();
        }
        Ok(())
    }
    pub fn command(&mut self, q: &Value, cancel: &AtomicBool) -> Result<Value> {
        cancelled(cancel)?;
        let op = q["op"].as_str().ok_or("Invalid engine operation")?;
        if op == "disconnect" {
            self.invalidate();
            return Ok(Value::Null);
        }
        if op == "tick" {
            let _ = self.check();
            return Ok(Value::Null);
        }
        if op == "capture" {
            let result = self.transfer(&q["message"], cancel);
            if result.is_err() {
                self.invalidate();
            }
            return result;
        }
        self.check()?;
        match op {
            "selection" => {
                let snapshot = self.snapshot(q["fileKey"].as_str().ok_or("Invalid file key")?)?;
                let ids=self.capture.as_ref().and_then(|c|c.inspector.selection.clone()).ok_or("Current selection has not been observed on the network. Select the layer again or supply a selection URL.")?;
                Ok(json!({"snapshot":snapshot,"ids":ids}))
            }
            "read" => {
                let result = self.read(&q["query"], cancel);
                if result.is_err()
                    && result
                        .as_ref()
                        .err()
                        .is_none_or(|e| !e.to_string().starts_with("Invalid or stale continuation"))
                {
                    self.release();
                }
                result
            }
            "info" => self.store(json!({"op":"info"})),
            "clean" => {
                if self.capture.as_ref().is_some_and(|c| !c.ready) {
                    return Err("Cache BUSY: reading or capturing; retry after completion".into());
                }
                self.release();
                self.store(json!({"op":"clean","mode":q["mode"]}))
            }
            _ => Err("Unknown engine operation".into()),
        }
    }
    fn snapshot(&self, file: &str) -> Result<Value> {
        if self.capture.is_none() && self.stale_file.as_deref() == Some(file) {
            return Err("STALE: observation ended; reload Figma and capture again".into());
        }
        let c = self
            .capture
            .as_ref()
            .filter(|c| c.ready && c.snapshot["fileKey"] == file)
            .ok_or(
                "No observed snapshot for this file. Use Reload and capture in the extension.",
            )?;
        Ok(c.snapshot.clone())
    }
    fn transfer(&mut self, q: &Value, cancel: &AtomicBool) -> Result<Value> {
        let action = q["action"].as_str().ok_or("Invalid capture command")?;
        let required = match action {
            "begin" => vec!["type", "id", "snapshot", "action"],
            "part" | "delta" => vec!["type", "id", "snapshot", "action", "sequence", "data"],
            "finish" => vec!["type", "id", "snapshot", "action", "evidence"],
            "heartbeat" => vec!["type", "id", "snapshot", "action"],
            _ => return Err("Invalid capture command".into()),
        };
        if q["type"] != "capture"
            || q["id"].as_str().is_none_or(|s| {
                s.is_empty()
                    || s.len() > 100
                    || !s
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            })
            || !store::identity(&q["snapshot"])
            || q.as_object().is_none_or(|o| {
                !required.iter().all(|k| o.contains_key(*k))
                    || o.keys().any(|k| {
                        !required.contains(&k.as_str()) && !(action == "begin" && k == "format")
                    })
            })
            || q.get("format").is_some_and(|v| v != "ndjson-v1")
        {
            return Err("Invalid capture command".into());
        }
        if action == "begin" {
            if self.capture.is_some() {
                return Err("Capture session mismatch".into());
            }
            self.release();
            let snapshot = q["snapshot"].clone();
            let directory = self.root.join(store::key(&snapshot, None)?);
            if directory.exists() {
                return Err("EEXIST: capture generation already exists".into());
            }
            self.store(json!({"op":"clean","mode":"prune"}))?;
            let stamp = self.store(json!({"op":"begin","snapshot":snapshot}))?;
            self.stale_file = None;
            self.capture = Some(Capture {
                snapshot,
                stamp,
                parts: vec![],
                bytes: 0,
                inspector: Inspector::new(),
                revision: 0,
                document_revision: 0,
                live_bytes: 0,
                ready: false,
                expires: Instant::now() + Duration::from_secs(30),
            });
        } else {
            self.check()?;
            let c = self.capture.as_ref().ok_or("Capture session mismatch")?;
            if c.snapshot != q["snapshot"] {
                return Err("Capture session mismatch".into());
            }
            if c.ready && !matches!(action, "heartbeat" | "delta") {
                return Err("Capture already committed".into());
            }
            match action {
                "part" => {
                    let seq = q["sequence"]
                        .as_u64()
                        .filter(|n| *n < 10000)
                        .ok_or("Invalid capture sequence")?;
                    if seq != c.parts.len() as u64 {
                        return Err("Capture sequence mismatch".into());
                    }
                    let text = q["data"]
                        .as_str()
                        .filter(|s| s.len() <= 4 * (256usize * 1024).div_ceil(3))
                        .ok_or("Invalid capture part")?;
                    let bytes = STANDARD.decode(text)?;
                    if bytes.is_empty()
                        || bytes.len() > 256 * 1024
                        || c.bytes + bytes.len() as u64 > 4 * 1024 * 1024 * 1024
                    {
                        return Err("Invalid capture part".into());
                    }
                    let snapshot = c.snapshot.clone();
                    let stamp = c.stamp.clone();
                    self.capture.as_mut().unwrap().inspector.push(&bytes)?;
                    cancelled(cancel)?;
                    let part=self.store(json!({"op":"append","snapshot":snapshot,"stamp":stamp,"sequence":seq,"data":text}))?;
                    let c = self.capture.as_mut().unwrap();
                    c.parts.push(part);
                    c.bytes += bytes.len() as u64;
                }
                "finish" => {
                    let e = &q["evidence"];
                    if e.as_object().is_none_or(|o| o.len() != 6)
                        || [
                            "schemaReceived",
                            "joinStarted",
                            "joinEnded",
                            "sequenceComplete",
                        ]
                        .iter()
                        .any(|k| e[k] != true)
                        || e["droppedParts"] != 0
                        || e["receivedParts"].as_u64() != Some(c.parts.len() as u64)
                        || c.parts.is_empty()
                    {
                        return Err("Capture part count mismatch or invalid evidence".into());
                    }
                    if c.inspector.progress()["initialComplete"] != true {
                        return Err("Initial load incomplete: schema, JOIN_START or JOIN_END missing; reload and capture again".into());
                    }
                    let snapshot = c.snapshot.clone();
                    let stamp = c.stamp.clone();
                    let manifest = json!({"version":1,"status":"ready","monitored":true,"snapshot":snapshot,"parts":c.parts});
                    self.store(json!({"op":"prepare","snapshot":snapshot,"stamp":stamp,"manifest":manifest}))?;
                    cancelled(cancel)?;
                    self.store(json!({"op":"publish","snapshot":snapshot,"stamp":stamp}))?;
                    if cancel.load(Ordering::Relaxed) {
                        self.store(json!({"op":"unpublish","snapshot":snapshot,"stamp":stamp}))?;
                        cancelled(cancel)?;
                    }
                    self.capture.as_mut().unwrap().ready = true;
                }
                "heartbeat" => {
                    if !c.ready {
                        return Err("Observation is not ready".into());
                    }
                }
                "delta" => {
                    if !c.ready
                        || q["sequence"].as_u64() != Some(c.revision)
                        || c.revision >= 9007199254740990
                    {
                        return Err("STALE: live sequence mismatch".into());
                    }
                    let text = q["data"]
                        .as_str()
                        .filter(|s| s.len() <= 4 * (256usize * 1024).div_ceil(3))
                        .ok_or("STALE: invalid live record size or encoding")?;
                    let bytes = STANDARD.decode(text)?;
                    if bytes.is_empty() || bytes.len() > 256 * 1024 {
                        return Err("STALE: invalid live record size or encoding".into());
                    }
                    let record: Value = serde_json::from_slice(&bytes)?;
                    crate::inspector::validate_record(&record, true)?;
                    if record["eventSequence"].as_u64() != Some(c.inspector.sequence + c.revision)
                        || c.inspector.socket.as_ref()
                            != Some(&json!([record["session"], record["requestId"]]))
                    {
                        return Err("STALE: live event gap or foreign stream".into());
                    }
                    let sent = record["kind"] == "ws-sent";
                    let payload = record["payload"].as_str().unwrap();
                    let c = self.capture.as_mut().unwrap();
                    if !c.inspector.service(payload, sent)? {
                        if sent {
                            return Err("Unsupported outgoing document message".into());
                        }
                        c.live_bytes += bytes.len();
                        if c.live_bytes > 8 * 1024 * 1024 {
                            return Err("STALE: live document byte budget exceeded".into());
                        }
                        let r = self
                            .retained
                            .as_mut()
                            .ok_or("STALE: no idle selection index; recapture")?;
                        if r.applied >= 128 {
                            return Err("Live batch limit exceeded".into());
                        }
                        let binary = input::inflate(&STANDARD.decode(payload)?, 1024 * 1024)?;
                        let mut changes = vec![];
                        let message = value(r.codec.decode_strict(&binary, &mut |n| {
                            if changes.len() >= 256 {
                                return Err("Live change count exceeded".into());
                            }
                            changes.push(value(n));
                            Ok(())
                        })?);
                        if message["type"] != "NODE_CHANGES" {
                            return Err("Unsupported live message type".into());
                        }
                        r.disk.apply_live(&changes)?;
                        r.applied += 1;
                        let mut validate = r.query.clone();
                        validate["offset"] = json!(0);
                        validate["maxNodes"] = json!(1);
                        validate["applied"] = json!(r.applied);
                        crate::traversal::query(&mut r.disk, &validate)?;
                        r.last = Instant::now();
                        c.document_revision += 1;
                    }
                    c.revision += 1;
                }
                _ => unreachable!(),
            }
        }
        let c = self.capture.as_mut().unwrap();
        c.expires = Instant::now() + Duration::from_secs(if c.ready { 15 } else { 30 });
        let reply = json!({"type":"capture-result","id":q["id"],"snapshot":c.snapshot,"action":action,"nextSequence":c.parts.len(),"revision":c.revision,"initial":c.inspector.progress(),"status":if c.ready{"ready"}else{"capturing"}});
        if c.ready {
            *self.lease.lock().unwrap() = Some(Lease {
                snapshot: c.snapshot.clone(),
                expires: c.expires,
                reply: reply.clone(),
            });
        }
        Ok(reply)
    }
    fn mac(&self, payload: &str) -> String {
        let mut key = [0u8; 64];
        key[..self.secret.len()].copy_from_slice(&self.secret);
        let mut inner = Sha256::new();
        inner.update(key.map(|b| b ^ 0x36));
        inner.update(payload.as_bytes());
        let mut outer = Sha256::new();
        outer.update(key.map(|b| b ^ 0x5c));
        outer.update(inner.finalize());
        URL_SAFE_NO_PAD.encode(outer.finalize())
    }
    fn token(&self, binding: &str, offset: u64) -> Result<String> {
        let p = URL_SAFE_NO_PAD.encode(crate::json::bytes(
            &json!({"v":1,"binding":binding,"offset":offset}),
        )?);
        Ok(format!("{p}.{}", self.mac(&p)))
    }
    fn offset(&self, token: &str, binding: &str) -> Result<u64> {
        let invalid = || {
            "Invalid or stale continuation: restart from the first page with the same source and query parameters"
        };
        let (p, s) = token
            .split_once('.')
            .filter(|_| token.len() <= 512)
            .ok_or_else(invalid)?;
        let expected = self.mac(p);
        if s.len() != expected.len()
            || s.bytes()
                .zip(expected.bytes())
                .fold(0u8, |a, (b, c)| a | (b ^ c))
                != 0
        {
            return Err(invalid().into());
        }
        let bytes = URL_SAFE_NO_PAD.decode(p).map_err(|_| invalid())?;
        let v: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        if v["v"] != 1 || v["binding"] != binding {
            return Err(invalid().into());
        }
        v["offset"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= 9007199254740991)
            .ok_or_else(|| invalid().into())
    }
    fn load(
        &mut self,
        snapshot: &Value,
        key: String,
        query: &Value,
        cancel: &AtomicBool,
    ) -> Result<()> {
        self.release();
        let scratch = self.root.join(format!("decode-{}", random()?));
        store::mkdir(&scratch)?;
        let result = (|| -> Result<Retained> {
            let mut disk = Disk::new(&scratch, self.fields.clone())?;
            let mut codec = None;
            let mut schema = vec![];
            let directory = self.root.join(store::key(snapshot, None)?);
            input::input(&directory, snapshot, |b| {
                cancelled(cancel)?;
                if b.starts_with(b"fig-wire") {
                    if codec.is_some() || b.len() < 12 || b[8..12] != 1u32.to_le_bytes() {
                        return Err("Unsupported or repeated fig-wire schema".into());
                    }
                    schema = input::inflate(&b[12..], 2 * 1024 * 1024)?;
                    codec = Some(Decoder::new(&schema, &self.fields)?);
                } else {
                    let d = codec.as_ref().ok_or("Missing wire schema")?;
                    let message = d.decode(&input::inflate(b, input::FRAME)?, &mut |n| {
                        cancelled(cancel)?;
                        disk.accept(value(n))
                    })?;
                    disk.message(&value(message))?;
                }
                Ok(())
            })?;
            disk.finish()?;
            let hash = Sha256::digest(&schema)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            Ok(Retained {
                disk,
                scratch: scratch.clone(),
                key,
                applied: 0,
                codec: crate::live::codec(&schema)?,
                last: Instant::now(),
                query: query.clone(),
                schema: hash,
            })
        })();
        match result {
            Ok(r) => {
                self.retained = Some(r);
                Ok(())
            }
            Err(e) => {
                let _ = fs::remove_dir_all(scratch);
                Err(e)
            }
        }
    }
    fn read(&mut self, q: &Value, cancel: &AtomicBool) -> Result<Value> {
        let file = q["fileKey"].as_str().ok_or("Invalid file key")?;
        let snapshot = self.snapshot(file)?;
        let c = self.capture.as_ref().unwrap();
        let revision = c.document_revision;
        let manifest = self.store(json!({"op":"manifest","snapshot":snapshot}))?;
        let max_bytes = q["maxBytes"]
            .as_u64()
            .filter(|n| *n >= 4096 && *n <= 150000)
            .ok_or("Invalid response byte limit")? as usize;
        let variables = q["variablesFile"].as_str().map(uikit::load).transpose()?;
        let fingerprint = variables.as_ref().map(|v| v.fingerprint());
        let binding = hash(&json!([
            self.root,
            manifest,
            revision,
            q["id"],
            q["depth"],
            q["maxNodes"],
            max_bytes,
            q["includeHidden"],
            q["variablesFile"],
            fingerprint
        ]))?;
        let offset = if let Some(token) = q["continuation"].as_str() {
            self.offset(token, &binding)?
        } else {
            0
        };
        let key = hash(&json!([self.root, manifest, q["id"]]))?;
        if self.retained.as_ref().is_none_or(|r| r.key != key) {
            if revision > 0 && self.retained.as_ref().is_some_and(|r| r.applied > 0) {
                return Err("STALE: updated selection index unavailable; recapture".into());
            }
            self.load(&snapshot, key, q, cancel)?;
        } else {
            self.store(json!({"op":"verify","snapshot":snapshot}))?;
        }
        cancelled(cancel)?;
        let r = self.retained.as_mut().unwrap();
        let mut params = q.clone();
        params["offset"] = json!(offset);
        params["schema"] = json!(r.schema);
        params["applied"] = json!(r.applied);
        params["format"] = json!("context");
        let mut result = r.disk.context_query(&params)?;
        r.query = params;
        r.last = Instant::now();
        self.check()?;
        cancelled(cancel)?;
        let o = result.as_object_mut().unwrap();
        o.remove("documentRecords");
        o.remove("initialBatches");
        result["node"] = json!({"id":q["id"]});
        result["snapshot"] = snapshot.clone();
        result["captureWarnings"] = json!([]);
        result["freshness"] = json!({"status":"observed","snapshot":snapshot,"revision":revision,"message":"Observed capture with supported updates; unsupported traffic requires recapture."});
        result["limitations"].as_array_mut().unwrap().push(json!("Visual style limitations and native Figma variable resolution results are listed per node. UI-kit matches are computed from values, not native bindings."));
        if let Some(vars) = &variables {
            result["nodes"] = json!(array(&result["nodes"])
                .iter()
                .map(|n| uikit::map_node(n, vars))
                .collect::<Result<Vec<_>>>()?);
        }
        result["variableMatching"] = json!({"source":"ui-kit-value-match","enabled":variables.is_some(),"nativeBindings":"style.nativeBindings"});
        if let Some(f) = fingerprint {
            result["variableMatching"]["fingerprint"] = json!(f);
        }
        loop {
            let len = array(&result["nodes"]).len();
            let next = offset + len as u64;
            let more = next < result["traversal"]["eligibleRecords"].as_u64().unwrap_or(0);
            result["traversal"]["returned"] = json!(len);
            result["traversal"]["nextOffset"] = if more { json!(next) } else { Value::Null };
            result["traversal"]["continuation"] = if more {
                json!(self.token(&binding, next)?)
            } else {
                Value::Null
            };
            result["traversal"]["maxBytes"] = json!(max_bytes);
            result["nodeCount"] = json!(len);
            let children = more
                || result["traversal"]["pendingDepthCount"]
                    .as_u64()
                    .unwrap_or(0)
                    > 0;
            let unresolved = result["traversal"]["unresolvedInstanceCount"]
                .as_u64()
                .unwrap_or(0)
                > 0;
            result["childrenTruncated"] = json!(children);
            result["traversal"]["complete"] = json!(!children && !unresolved);
            result["truncated"] = json!(
                children
                    || unresolved
                    || array(&result["nodes"])
                        .iter()
                        .any(|n| n.get("propertiesOmitted").is_some())
            );
            if crate::json::bytes(&result)?.len() <= max_bytes {
                break;
            }
            if len > 1 {
                result["nodes"].as_array_mut().unwrap().pop();
            } else if len == 1
                && result["nodes"][0]["propertiesOmitted"]
                    != "Node properties including variable matches exceed response byte limit"
            {
                let n = &result["nodes"][0];
                let mut node = json!({"id":n["id"],"parentId":n["parentId"],"depth":n["depth"],"propertiesOmitted":"Node properties including variable matches exceed response byte limit"});
                if let Some(t) = n.get("type") {
                    node["type"] = t.clone();
                }
                result["nodes"] = json!([node]);
            } else {
                return Err("Response metadata exceeds byte limit; increase maxBytes".into());
            }
        }
        cancelled(cancel)?;
        Ok(result)
    }
}
pub struct Job {
    pub query: Value,
    pub cancelled: Arc<AtomicBool>,
    pub reply: tokio::sync::oneshot::Sender<std::result::Result<Value, String>>,
}
#[derive(Clone)]
pub struct Handle {
    lease: Arc<Mutex<Option<Lease>>>,
    sender: std::sync::mpsc::SyncSender<Job>,
}
impl Handle {
    pub fn start(project: String) -> Result<Self> {
        let lease = Arc::new(Mutex::new(None));
        let engine_lease = lease.clone();
        let (tx, rx) = std::sync::mpsc::sync_channel::<Job>(8);
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut engine = match Engine::new(&project) {
                Ok(e) => {
                    let _ = ready_tx.send(Ok(()));
                    e
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e.to_string()));
                    return;
                }
            };
            engine.lease = engine_lease;
            loop {
                let job = match rx.recv_timeout(Duration::from_secs(1)) {
                    Ok(job) => job,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        let _ = engine.check();
                        continue;
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                };
                CANCELLATION.with(|c| *c.borrow_mut() = Some(job.cancelled.clone()));
                let result = engine
                    .command(&job.query, &job.cancelled)
                    .map_err(|e| e.to_string());
                CANCELLATION.with(|c| *c.borrow_mut() = None);
                let _ = job.reply.send(result);
            }
        });
        ready_rx.recv()?.map_err(|e| e.to_string())?;
        Ok(Self { lease, sender: tx })
    }
    /// Read observation readiness without waiting behind a long-running decode.
    pub fn observed(&self, file: Option<&str>) -> bool {
        self.lease.lock().unwrap().as_ref().is_some_and(|lease| {
            file.is_some_and(|file| lease.snapshot["fileKey"] == file)
                && Instant::now() < lease.expires
        })
    }
    pub async fn call(&self, q: Value) -> std::result::Result<Value, String> {
        if q["op"] == "disconnect" {
            *self.lease.lock().unwrap() = None;
        }
        if q["op"] == "capture" && q["message"]["action"] == "heartbeat" {
            let mut lease = self.lease.lock().unwrap();
            let msg = &q["message"];
            if let Some(l) = lease.as_mut() {
                if msg.as_object().is_none_or(|o| o.len() != 4)
                    || msg["type"] != "capture"
                    || msg["snapshot"] != l.snapshot
                    || msg["id"].as_str().is_none_or(|s| {
                        s.is_empty()
                            || s.len() > 100
                            || !s
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                    })
                    || Instant::now() >= l.expires
                {
                    *lease = None;
                    return Err("STALE: invalid heartbeat or observation expired".into());
                }
                l.expires = Instant::now() + Duration::from_secs(15);
                let mut reply = l.reply.clone();
                reply["id"] = msg["id"].clone();
                reply["action"] = json!("heartbeat");
                return Ok(reply);
            }
        }
        let flag = Arc::new(AtomicBool::new(false));
        struct Cancel(Arc<AtomicBool>);
        impl Drop for Cancel {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Relaxed);
            }
        }
        let _guard = Cancel(flag.clone());
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.sender
            .try_send(Job {
                query: q,
                cancelled: flag,
                reply: tx,
            })
            .map_err(|_| "Native engine is busy or unavailable".to_string())?;
        rx.await.map_err(|_| "Native engine stopped".to_string())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn heartbeat_renews_a_verified_lease_without_waiting_for_document_work() {
        let snapshot = json!({"fileKey":"test","sessionId":"capture","generation":1});
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let handle = Handle {
            sender,
            lease: Arc::new(Mutex::new(Some(Lease {
                snapshot: snapshot.clone(),
                expires: Instant::now() + Duration::from_secs(1),
                reply: json!({"status":"ready","revision":7,"nextSequence":4,"snapshot":snapshot}),
            }))),
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let q = json!({"op":"capture","message":{"type":"capture","action":"heartbeat","id":"keepalive","snapshot":snapshot}});
        let reply = runtime.block_on(handle.call(q.clone())).unwrap();
        assert_eq!(reply["revision"], 7);
        assert_eq!(reply["id"], "keepalive");
        assert!(receiver.try_recv().is_err());
        assert!(
            handle.lease.lock().unwrap().as_ref().unwrap().expires
                > Instant::now() + Duration::from_secs(10)
        );
        assert!(handle.observed(Some("test")));
        assert!(!handle.observed(Some("other")));
        assert!(!handle.observed(None));
        handle.lease.lock().unwrap().as_mut().unwrap().expires = Instant::now();
        assert!(!handle.observed(Some("test")));
        handle.lease.lock().unwrap().as_mut().unwrap().expires = Instant::now() + Duration::from_secs(15);
        let mut forged = q;
        forged["message"]["snapshot"]["generation"] = json!(2);
        assert!(runtime.block_on(handle.call(forged)).is_err());
        assert!(handle.lease.lock().unwrap().is_none());
    }
}
