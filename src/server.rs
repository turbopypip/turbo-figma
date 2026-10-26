//! Standalone MCP + browser bridge. Rust owns both transports and the snapshot engine.
use crate::engine::Handle;
use futures_util::{SinkExt, StreamExt};
use rmcp::{model::*, service::RequestContext, ErrorData, RoleServer, ServerHandler, ServiceExt};
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::{mpsc, oneshot, Semaphore},
};
use tokio_tungstenite::{
    accept_async_with_config,
    tungstenite::{
        protocol::{frame::coding::CloseCode, CloseFrame, WebSocketConfig},
        Message,
    },
};
#[cfg(unix)]
use std::time::{SystemTime, UNIX_EPOCH};
type Result<T> = std::result::Result<T, String>;
#[cfg(unix)]
fn now() -> String {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = duration.as_secs() as libc::time_t;
    let mut tm = unsafe { std::mem::zeroed::<libc::tm>() };
    unsafe { libc::gmtime_r(&seconds, &mut tm) };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec,
        duration.subsec_millis()
    )
}
#[cfg(windows)]
fn now() -> String { crate::platform::utc_now() }
fn text(mut v: Value) -> Value {
    let encoded = if let Some(traversal) = v.as_object_mut().and_then(|o| o.remove("traversal")) {
        let rest = String::from_utf8(crate::json::bytes(&v).unwrap()).unwrap();
        format!(
            "{{\"traversal\":{},{}",
            String::from_utf8(crate::json::bytes(&traversal).unwrap()).unwrap(),
            &rest[1..]
        )
    } else {
        String::from_utf8(crate::json::bytes(&v).unwrap()).unwrap()
    };
    json!({"content":[{"type":"text","text":encoded}]})
}
fn error(e: String) -> Value {
    json!({"isError":true,"content":[{"type":"text","text":e}]})
}
fn close(reason: &str) -> Message {
    Message::Close(Some(CloseFrame {
        code: CloseCode::Policy,
        reason: reason.to_owned().into(),
    }))
}
#[derive(Clone)]
struct Peer {
    id: u64,
    file: Option<String>,
    tx: mpsc::Sender<Message>,
}
#[derive(Default)]
struct Bridge {
    peer: Option<Peer>,
    connected: Option<String>,
    disconnected: Option<String>,
    last: Option<Value>,
    capture_error: Option<String>,
    pending: Option<(String, oneshot::Sender<Result<Value>>)>,
    capture_busy: bool,
    capture_work: bool,
    cache_busy: bool,
    expires: Option<Instant>,
}
#[derive(Clone)]
struct Server {
    bridge: Arc<Mutex<Bridge>>,
    engine: Handle,
    tools: Arc<Vec<Tool>>,
    info: ServerConfig,
    asset: String,
    variables: Option<String>,
    read_busy: Arc<AtomicBool>,
    snapshot_gate: Arc<tokio::sync::Mutex<()>>,
    export_busy: Arc<AtomicBool>,
    limit: Arc<Semaphore>,
}
struct Busy(Arc<AtomicBool>);
impl Busy {
    fn acquire(flag: &Arc<AtomicBool>, message: &str) -> Result<Self> {
        if flag.swap(true, Ordering::SeqCst) {
            Err(message.into())
        } else {
            Ok(Self(flag.clone()))
        }
    }
}
impl Drop for Busy {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
impl Server {
    fn file(&self) -> Option<String> {
        self.bridge
            .lock()
            .unwrap()
            .peer
            .as_ref()
            .and_then(|p| p.file.clone())
    }
    fn status(&self) -> Value {
        let b = self.bridge.lock().unwrap();
        let connected = b.peer.is_some();
        let busy =
            connected && (b.pending.is_some() || b.capture_busy || b.capture_work || b.cache_busy);
        let mut v = json!({"mcp":"running","connected":connected,"busy":busy,"state":if !connected{"disconnected"}else if busy{"busy"}else{"connected"},"checkedAt":now(),"connectedAt":if connected{b.connected.clone()}else{None},"disconnectedAt":b.disconnected,"message":if !connected{"Расширение Figma не подключено. Открой макет и нажми значок расширения; сохранённый ключ загрузится автоматически. Если вкладка подключения уже открыта, дождись восстановления связи или нажми «Подключить»."}else if busy{"Figma подключена, выполняется запрос."}else{"Расширение Figma подключено."},"scope":"Authenticated browser bridge connection only; Figma tab availability and export readiness are not checked."});
        let observed = connected
            && b.capture_error.is_none()
            && b.expires.is_some_and(|expires| Instant::now() < expires)
            && self.engine.observed(b.peer.as_ref().and_then(|p| p.file.as_deref()));
        let snapshot_busy = b.capture_busy || b.cache_busy;
        v["readReady"] = json!(observed && !snapshot_busy);
        v["snapshotState"] = json!(if b.capture_busy && connected { "capturing" } else if observed { "ready" } else { "capture_required" });
        v["nextAction"] = json!(if !connected { "connect" } else if snapshot_busy { "wait" } else if !observed { "reload_and_capture" } else { "read" });
        v["scope"] = json!("Authenticated browser bridge and observed snapshot readiness for the paired file; selection, tab availability and export readiness are not checked.");
        if connected && !busy && !observed {
            v["message"] = json!("Мост Figma подключён, но актуального снимка нет. Нажми «Подключить» в расширении; после захвата начни чтение заново, без прежнего continuation.");
        }
        if let Some(last) = &b.last {
            v["lastDisconnect"] = last.clone();
        }
        if let Some(e) = &b.capture_error {
            v["captureError"] = json!(e);
        }
        v
    }
    async fn read(&self, query: Value) -> Result<Value> {
        let owner = self.bridge.lock().unwrap().peer.as_ref().map(|p| p.id);
        // Short snapshot reads queue independently of slow browser exports.
        // Live deltas use the same gate so a read cannot invalidate the stream.
        let _snapshot = self.snapshot_gate.lock().await;
        let _busy = Busy::acquire(&self.read_busy, "Network snapshot reader is busy")?;
        {
            let b = self.bridge.lock().unwrap();
            if owner != b.peer.as_ref().map(|p| p.id) {
                return Err("STALE: observation ended while waiting to read".into());
            }
            if b.capture_busy || b.cache_busy {
                return Err("Cache BUSY: reading or capturing; retry after completion".into());
            }
        }
        let result = self.engine.call(json!({"op":"read","query":query})).await;
        let current = self.bridge.lock().unwrap().peer.as_ref().map(|p| p.id);
        if owner != current {
            return Err("STALE: observation ended during read".into());
        }
        result
    }
    async fn selection(&self, file: &str) -> Result<Value> {
        self.engine
            .call(json!({"op":"selection","fileKey":file}))
            .await
    }
    async fn browser(&self, method: &str, params: Value) -> Result<Value> {
        let (tx, rx) = oneshot::channel();
        let id = crate::engine::random().map_err(|e| e.to_string())?;
        let peer = {
            let mut b = self.bridge.lock().unwrap();
            let p=b.peer.clone().ok_or("Figma browser extension is not connected. Open the file in Chrome, click turbo-figma and pair it using the local secret.")?;
            if b.pending.is_some() || b.cache_busy || b.capture_busy {
                return Err("Figma is busy. Wait for the current request.".into());
            }
            b.pending = Some((id.clone(), tx));
            p
        };
        struct Pending {
            bridge: Arc<Mutex<Bridge>>,
            peer: Peer,
            id: String,
        }
        impl Drop for Pending {
            fn drop(&mut self) {
                let mut b = self.bridge.lock().unwrap();
                if b.pending.as_ref().is_some_and(|(id, _)| *id == self.id) {
                    b.pending = None;
                    let _ = self.peer.tx.try_send(close(
                        "Request cancelled or timed out; reconnect browser extension.",
                    ));
                }
            }
        }
        let _pending = Pending {
            bridge: self.bridge.clone(),
            peer: peer.clone(),
            id: id.clone(),
        };
        peer.tx
            .try_send(Message::Text(
                json!({"type":"request","id":id,"method":method,"params":params})
                    .to_string()
                    .into(),
            ))
            .map_err(|_| "Could not send request to Figma")?;
        tokio::time::timeout(Duration::from_secs(30), rx)
            .await
            .map_err(|_| "Figma request timed out; reconnect browser extension.".to_string())?
            .map_err(|_| {
                "Figma browser extension disconnected. Reconnect the browser extension.".to_string()
            })?
    }
    async fn target(&self, p: &Value, screenshot: bool) -> Result<(String, String, String)> {
        let paired = self.file();
        let mut id = p["nodeId"].as_str().map(|s| s.replace('-', ":"));
        let (file, url) = if let Some(url) = p["url"].as_str() {
            let (file, node) = selection_url(url)?;
            if id.as_ref().is_some_and(|id| *id != node) {
                return Err("url and nodeId disagree".into());
            }
            id = Some(node);
            if screenshot && paired.as_ref() != Some(&file) {
                return Err("Screenshot URL points to another file".into());
            }
            (file, url.to_owned())
        } else {
            let file = paired.ok_or(if screenshot {
                "Figma is not connected"
            } else {
                "No paired file; connect the extension or supply a selection URL"
            })?;
            if id.is_none() {
                let selection = self.selection(&file).await?;
                let ids = crate::instances::array(&selection["ids"]);
                if ids.len() != 1 {
                    return Err("Select exactly one node or supply a selection URL".into());
                }
                id = ids[0].as_str().map(str::to_owned);
            }
            let node = id.as_deref().ok_or("Invalid node ID")?;
            let url = format!("https://www.figma.com/design/{file}/File?node-id={node}");
            selection_url(&url)?;
            (file, url)
        };
        Ok((file, id.unwrap(), url))
    }
    async fn execute(&self, name: &str, p: Value) -> Result<Value> {
        match name {
            "get_connection_status" => Ok(text(self.status())),
            "get_design_context" | "get_design_map" => {
                let (file, id, _) = self.target(&p, false).await?;
                let mut q = p.clone();
                q["view"] = json!(if name == "get_design_map" { "map" } else { "context" });
                q["fileKey"] = json!(file);
                q["id"] = json!(id);
                if name != "get_design_map" && q.get("variablesFile").is_none() {
                    if let Some(v) = &self.variables {
                        q["variablesFile"] = json!(v);
                    }
                }
                Ok(text(self.read(q).await?))
            }
            "get_selection" => {
                let file = self.file().ok_or("Figma is not connected")?;
                let selection = self.selection(&file).await?;
                let mut nodes = vec![];
                for id in crate::instances::array(&selection["ids"]) {
                    let result=self.read(json!({"fileKey":file,"id":id,"depth":0,"maxNodes":1,"maxBytes":4096,"includeHidden":true})).await?;
                    let mut node = json!({"id":id});
                    for k in ["name", "type"] {
                        if let Some(v) = result["nodes"][0].get(k) {
                            node[k] = v.clone();
                        }
                    }
                    nodes.push(node);
                }
                if self.file().as_deref() != Some(&file)
                    || self.selection(&file).await? != selection
                {
                    return Err("Selection changed during read; retry".into());
                }
                Ok(text(
                    json!({"adapter":"figma-network-selection","fileKey":file,"snapshot":selection["snapshot"],"nodes":nodes}),
                ))
            }
            "get_screenshot" => {
                let _busy = Busy::acquire(&self.export_busy, "Screenshot or asset export is busy")?;
                let (file, id, url) = self.target(&p, true).await?;
                let context=self.read(json!({"fileKey":file,"id":id,"depth":0,"maxNodes":1,"maxBytes":12000,"includeHidden":true})).await?;
                if self.file().as_deref() != Some(&file) {
                    return Err("Paired file changed during screenshot preparation".into());
                }
                let mut params = p;
                params["url"] = json!(url);
                params["nodeId"] = json!(id);
                params["ancestors"] = json!(crate::instances::array(&context["selectionPath"]).iter().rev().collect::<Vec<_>>());
                let response = self.browser("get_screenshot", params).await?;
                let image = crate::assets::command(&json!({"op":"decode","image":response}))
                    .map_err(|e| e.to_string())?;
                if image["nodeId"] != id {
                    return Err("Screenshot selection does not match request".into());
                }
                if image["format"] != "PNG" {
                    return Err("Expected PNG screenshot".into());
                }
                let mut metadata = json!({"nodeId":id});
                for k in ["scale", "scaleBasis"] {
                    if let Some(v) = image.get(k) {
                        metadata[k] = v.clone();
                    }
                }
                Ok(
                    json!({"content":[{"type":"image","data":image["data"],"mimeType":"image/png"},{"type":"text","text":metadata.to_string()}]}),
                )
            }
            "export_assets" => {
                let _busy = Busy::acquire(&self.export_busy, "Screenshot or asset export is busy")?;
                let mut ids = vec![];
                for id in crate::instances::array(&p["nodeIds"]) {
                    if !ids.contains(id) {
                        ids.push(id.clone());
                    }
                }
                let mut results = vec![];
                for id in ids {
                    let response = async {
                        // Keep exporting an already mounted node available without a capture.
                        // A ready snapshot additionally lets us reveal collapsed ancestors.
                        if self.status()["readReady"] != true {
                            return self.browser("export_asset", json!({"nodeId":id,"format":p["format"],"scale":p["scale"]})).await;
                        }
                        let (file, node, url) = self.target(&json!({"nodeId":id}), true).await?;
                        let context = self.read(json!({"fileKey":file,"id":node,"depth":0,"maxNodes":1,"maxBytes":12000,"includeHidden":true})).await?;
                        if self.file().as_deref() != Some(&file) {
                            return Err("Paired file changed during export preparation".into());
                        }
                        self.browser("export_asset", json!({"url":url,"nodeId":node,"ancestors":crate::instances::array(&context["selectionPath"]).iter().rev().collect::<Vec<_>>(),"format":p["format"],"scale":p["scale"]})).await
                    }.await;
                    let result = response.and_then(|image| {
                        if image["nodeId"] != id || image["format"] != p["format"] {
                            return Err("Asset response does not match request".into());
                        }
                        crate::assets::command(
                            &json!({"op":"write","root":self.asset,"image":image}),
                        )
                        .map_err(|e| e.to_string())
                    });
                    results.push(result.unwrap_or_else(|e| json!({"nodeId":id,"error":e})));
                }
                Ok(text(
                    json!({"directory":self.asset,"results":results,"cancelled":false}),
                ))
            }
            _ => Err("Tool not found".into()),
        }
    }
}
impl ServerHandler for Server {
    fn get_info(&self) -> ServerConfig {
        self.info.clone()
    }
    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.tools.iter().find(|t| t.name == name).cloned()
    }
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> std::result::Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult {
            tools: (*self.tools).clone(),
            ..Default::default()
        })
    }
    async fn call_tool(
        &self,
        q: CallToolRequestParams,
        ctx: RequestContext<RoleServer>,
    ) -> std::result::Result<CallToolResponse, ErrorData> {
        let tool = self
            .get_tool(&q.name)
            .ok_or_else(|| ErrorData::invalid_params("Tool not found", None))?;
        let _permit =
            self.limit.clone().try_acquire_owned().map_err(|_| {
                ErrorData::internal_error("MCP tool concurrency limit exceeded", None)
            })?;
        let args = Value::Object(q.arguments.unwrap_or_default());
        let schema = serde_json::to_value(&tool.input_schema).unwrap();
        let result = if serde_json::to_vec(&args).unwrap().len() > 65536 {
            error("Tool arguments limit exceeded".into())
        } else {
            match validate(&schema, args) {
                Ok(args) => {
                    tokio::select! {r=self.execute(&q.name,args)=>r.unwrap_or_else(error),_=ctx.ct.cancelled()=>error("Request cancelled".into()),_=tokio::time::sleep(Duration::from_secs(150))=>error("Request timed out".into())}
                }
                Err(e) => error(e),
            }
        };
        let result: CallToolResult = serde_json::from_value(result)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(result.into())
    }
}
fn validate(schema: &Value, mut v: Value) -> Result<Value> {
    if let Some(values) = schema["enum"].as_array() {
        if !values.contains(&v) {
            return Err("Invalid enum value".into());
        }
    }
    if schema.get("const").is_some_and(|c| *c != v) {
        return Err("Invalid constant value".into());
    }
    match schema["type"].as_str() {
        Some("object") => {
            let obj = v.as_object_mut().ok_or("Expected object")?;
            let props = schema["properties"]
                .as_object()
                .ok_or("Invalid tool schema")?;
            if schema["additionalProperties"] == false && obj.keys().any(|k| !props.contains_key(k))
            {
                return Err("Unrecognized argument".into());
            }
            let mut out = serde_json::Map::new();
            for (k, s) in props {
                let value = obj.remove(k).or_else(|| s.get("default").cloned());
                if let Some(value) = value {
                    out.insert(k.clone(), validate(s, value)?);
                } else if crate::instances::array(&schema["required"])
                    .iter()
                    .any(|v| v == k)
                {
                    return Err(format!("Missing argument: {k}"));
                }
            }
            v = Value::Object(out);
        }
        Some("string") => {
            let s = v.as_str().ok_or("Expected string")?;
            let len = s.encode_utf16().count() as u64;
            if schema["minLength"].as_u64().is_some_and(|n| len < n)
                || schema["maxLength"].as_u64().is_some_and(|n| len > n)
            {
                return Err("String length limit".into());
            }
        }
        Some("number" | "integer") => {
            let n = v
                .as_f64()
                .filter(|n| n.is_finite())
                .ok_or("Expected number")?;
            if schema["type"] == "integer" && n.fract() != 0.
                || schema["minimum"].as_f64().is_some_and(|m| n < m)
                || schema["maximum"].as_f64().is_some_and(|m| n > m)
            {
                return Err("Numeric limit exceeded".into());
            }
        }
        Some("boolean") => {
            if !v.is_boolean() {
                return Err("Expected boolean".into());
            }
        }
        Some("array") => {
            let a = v.as_array_mut().ok_or("Expected array")?;
            if schema["minItems"]
                .as_u64()
                .is_some_and(|n| a.len() < (n as usize))
                || schema["maxItems"]
                    .as_u64()
                    .is_some_and(|n| a.len() > n as usize)
            {
                return Err("Array count limit".into());
            }
            for value in a {
                *value = validate(&schema["items"], value.clone())?;
            }
        }
        _ => {}
    }
    Ok(v)
}
fn percent(s: &str) -> Result<String> {
    let b = s.as_bytes();
    let mut out = vec![];
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            if i + 2 >= b.len() {
                return Err("Invalid URL encoding".into());
            }
            let hex = std::str::from_utf8(&b[i + 1..i + 3]).map_err(|_| "Invalid URL encoding")?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| "Invalid URL encoding")?);
            i += 3;
        } else {
            out.push(if b[i] == b'+' { b' ' } else { b[i] });
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "Invalid URL encoding".into())
}
fn selection_url(url: &str) -> Result<(String, String)> {
    let invalid = "Expected a Figma design/file selection URL with node-id";
    let path = url.strip_prefix("https://www.figma.com/").ok_or(invalid)?;
    let (path, query) = path.split_once('?').ok_or(invalid)?;
    let mut parts = path.split('/');
    if !matches!(parts.next(), Some("design" | "file")) {
        return Err(invalid.into());
    }
    let file = parts
        .next()
        .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric()))
        .ok_or(invalid)?;
    let mut id = None;
    for part in query.split('#').next().unwrap_or("").split('&') {
        let (k, v) = part.split_once('=').unwrap_or((part, ""));
        if percent(k)? == "node-id" {
            id = Some(percent(v)?.replace('-', ":"));
            break;
        }
    }
    let id = id.ok_or(invalid)?;
    if id.split(':').count() != 2
        || !id
            .split(':')
            .all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err(invalid.into());
    }
    Ok((file.into(), id))
}
async fn connection(server: Server, tcp: tokio::net::TcpStream, id: u64, secret: Arc<String>) {
    let config = WebSocketConfig::default()
        .read_buffer_size(16384)
        .write_buffer_size(0)
        .max_write_buffer_size(6 * 1024 * 1024 + 65536)
        .max_message_size(Some(6 * 1024 * 1024))
        .max_frame_size(Some(6 * 1024 * 1024));
    let mut socket = match tokio::time::timeout(
        Duration::from_secs(3),
        accept_async_with_config(tcp, Some(config)),
    )
    .await
    {
        Ok(Ok(s)) => s,
        _ => return,
    };
    let auth = match tokio::time::timeout(Duration::from_secs(3), socket.next()).await {
        Ok(Some(Ok(Message::Text(t)))) => serde_json::from_str::<Value>(&t).ok(),
        _ => None,
    };
    let Some(auth) = auth else {
        let _ = socket
            .send(close(
                "Pairing failed or another browser extension is connected",
            ))
            .await;
        return;
    };
    let supplied = auth["secret"].as_str().unwrap_or("");
    let valid = auth["type"] == "auth"
        && supplied.len() == secret.len()
        && supplied
            .bytes()
            .zip(secret.bytes())
            .fold(0u8, |a, (b, c)| a | (b ^ c))
            == 0
        && auth.get("fileKey").is_none_or(|v| {
            v.as_str().is_some_and(|s| {
                !s.is_empty() && s.len() <= 256 && s.bytes().all(|b| b.is_ascii_alphanumeric())
            })
        });
    let (tx, mut rx) = mpsc::channel::<Message>(8);
    let accepted = {
        let mut b = server.bridge.lock().unwrap();
        if valid && b.peer.is_none() {
            b.peer = Some(Peer {
                id,
                file: auth["fileKey"].as_str().map(str::to_owned),
                tx: tx.clone(),
            });
            b.capture_busy = false;
            b.capture_work = false;
            b.cache_busy = false;
            b.expires = None;
            true
        } else {
            false
        }
    };
    if !accepted {
        let _ = socket
            .send(close(
                "Pairing failed or another browser extension is connected",
            ))
            .await;
        return;
    }
    let _ = server.engine.call(json!({"op":"disconnect"})).await;
    {
        let mut b = server.bridge.lock().unwrap();
        b.connected = Some(now());
        b.last = None;
        b.capture_error = None;
    }
    if socket
        .send(Message::Text(json!({"type":"ready"}).to_string().into()))
        .await
        .is_err()
    {
        disconnect(&server, id, 1006, "").await;
        return;
    }
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    let mut code = 1006;
    let mut reason = String::new();
    loop {
        tokio::select! {
        _=interval.tick()=>{let expired=server.bridge.lock().unwrap().expires.is_some_and(|e|Instant::now()>=e);if expired{reason="STALE: observation heartbeat lost; reload and capture again".into();let _=socket.send(Message::Text(json!({"type":"capture-error","error":reason}).to_string().into())).await;let _=socket.send(close("Capture failed")).await;code=1008;break;}},
        message=rx.recv()=>{let Some(m)=message else{break};let closing=m.is_close();if socket.send(m).await.is_err()||closing{code=1008;break;}},
        incoming=socket.next()=>{match incoming{
        Some(Ok(Message::Text(t)))=>{let msg=serde_json::from_str::<Value>(&t);let Ok(msg)=msg else{let _=socket.send(close("Invalid bridge message")).await;code=1008;break;};match msg["type"].as_str(){
        Some("ping")=>{if socket.send(Message::Text(json!({"type":"pong"}).to_string().into())).await.is_err(){break;}},
        Some("response")=>{let mut b=server.bridge.lock().unwrap();if b.pending.as_ref().is_some_and(|(id,_)|msg["id"]==*id){let(_,reply)=b.pending.take().unwrap();let response=msg["error"].as_str().map(|e|Err(e.chars().take(500).collect())).unwrap_or_else(||Ok(msg["result"].clone()));let _=reply.send(response);}},
        Some("capture")=>{let reject={let mut b=server.bridge.lock().unwrap();let action=msg["action"].as_str().unwrap_or("");let neutral=matches!(action,"heartbeat"|"delta");let reject=if b.capture_work{Some("Capture queue overflow: previous command is still pending")}else if b.peer.as_ref().and_then(|p|p.file.as_ref()).is_none_or(|file|msg["snapshot"]["fileKey"]!=*file)||(!neutral&&(b.pending.is_some()||b.cache_busy||server.read_busy.load(Ordering::SeqCst))){Some("Capture busy or file mismatch")}else{None};if reject.is_none(){b.capture_work=true;if action=="begin"{b.capture_busy=true;}b.expires=Some(Instant::now()+Duration::from_secs(if b.capture_busy{30}else{15}));}reject};if let Some(e)=reject{let _=socket.send(Message::Text(json!({"type":"capture-error","error":e}).to_string().into())).await;let _=socket.send(close("Capture failed")).await;code=1008;break;}let task=server.clone();let output=tx.clone();tokio::spawn(async move{let result={let _snapshot=if msg["action"]=="delta"{Some(task.snapshot_gate.lock().await)}else{None};task.engine.call(json!({"op":"capture","message":msg})).await};{let mut b=task.bridge.lock().unwrap();if b.peer.as_ref().is_none_or(|p|p.id!=id){return;}b.capture_work=false;match &result{Ok(r)=>{b.capture_busy=r["status"]!="ready";b.expires=Some(Instant::now()+Duration::from_secs(if b.capture_busy{30}else{15}));},Err(e)=>{b.capture_error=Some(e.clone());}}}let failed=result.is_err();let value=result.unwrap_or_else(|e|json!({"type":"capture-error","error":e.chars().take(500).collect::<String>()}));let _=output.send(Message::Text(value.to_string().into())).await;if failed{let _=output.send(close("Capture failed")).await;}});},
        Some("cache-control")=>{let action=msg["action"].as_str().unwrap_or("");if !matches!(action,"cache-info"|"cache-clear")||msg["id"].as_str().is_none_or(|s|s.is_empty()||s.len()>100||!s.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_')){let _=socket.send(close("Invalid cache control")).await;code=1008;break;}let busy={let mut b=server.bridge.lock().unwrap();let busy=b.pending.is_some()||b.capture_busy||b.capture_work||b.cache_busy||server.read_busy.load(Ordering::SeqCst);if !busy{b.cache_busy=true;}busy};if busy{let _=socket.send(Message::Text(json!({"type":"cache-result","id":msg["id"],"error":"Кэш занят: дождись завершения текущего запроса."}).to_string().into())).await;}else{let task=server.clone();let output=tx.clone();tokio::spawn(async move{let result=task.engine.call(if msg["action"]=="cache-clear"{json!({"op":"clean","mode":"all"})}else{json!({"op":"info"})}).await;{let mut b=task.bridge.lock().unwrap();if b.peer.as_ref().is_none_or(|p|p.id!=id){return;}b.cache_busy=false;}let mut reply=json!({"type":"cache-result","id":msg["id"]});match result{Ok(v)=>reply["result"]=v,Err(e)=>reply["error"]=json!(e)}let _=output.send(Message::Text(reply.to_string().into())).await;});}},_=>{}}},
        Some(Ok(Message::Close(c)))=>{if let Some(c)=c{code=c.code.into();reason=c.reason.to_string();}else{code=1005;}let _=socket.flush().await;break;},Some(Ok(Message::Ping(_)))=>{let _=socket.flush().await;},Some(Ok(_))=>{},Some(Err(tokio_tungstenite::tungstenite::Error::Capacity(_)))=>{code=1009;let _=socket.send(Message::Close(Some(CloseFrame{code:CloseCode::Size,reason:"Message too large".into()}))).await;let tcp=socket.get_mut();let _=tcp.shutdown().await;let _=tokio::time::timeout(Duration::from_secs(1),async {let mut buffer=[0u8;16384];let mut bytes=0;while bytes<8*1024*1024{match tcp.read(&mut buffer).await{Ok(0)|Err(_)=>break,Ok(n)=>bytes+=n}}}).await;break;},_=>break
        }}
        }
    }
    disconnect(&server, id, code, &reason).await;
}
async fn disconnect(server: &Server, id: u64, code: u16, reason: &str) {
    let owned = {
        let mut b = server.bridge.lock().unwrap();
        if b.peer.as_ref().is_some_and(|p| p.id == id) {
            b.peer = None;
            b.connected = None;
            b.disconnected = Some(now());
            b.last =
                Some(json!({"code":code,"reason":reason.chars().take(500).collect::<String>()}));
            if let Some((_, tx)) = b.pending.take() {
                let _ = tx.send(Err(
                    "Figma browser extension disconnected. Reconnect the browser extension.".into(),
                ));
            }
            true
        } else {
            false
        }
    };
    if owned {
        let _ = server.engine.call(json!({"op":"disconnect"})).await;
    }
}
static STOP: AtomicBool = AtomicBool::new(false);
#[cfg(unix)]
extern "C" fn stop(_: libc::c_int) {
    STOP.store(true, Ordering::Relaxed);
}
pub async fn run(
    config_path: &str,
    project: &str,
) -> std::result::Result<(), Box<dyn std::error::Error>> {
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGTERM, stop as *const () as libc::sighandler_t);
        libc::signal(libc::SIGINT, stop as *const () as libc::sighandler_t);
    }
    #[cfg(windows)]
    crate::platform::install_shutdown_handler(&STOP)?;
    let config: Value =
        serde_json::from_slice(&crate::input::bounded(Path::new(config_path), 65536)?)?;
    let secret = config["secret"]
        .as_str()
        .filter(|s| (32..=256).contains(&s.encode_utf16().count()))
        .ok_or("Invalid configuration; run setup again.")?
        .to_owned();
    let port = config
        .get("port")
        .map(|v| {
            v.as_u64()
                .filter(|n| *n >= 1024 && *n <= 65535)
                .ok_or("Invalid port")
        })
        .transpose()?
        .unwrap_or(3055) as u16;
    if config.get("adapter").is_some_and(|v| v != "browser") {
        return Err("Invalid adapter".into());
    }
    let asset = config["assetDirectory"]
        .as_str()
        .filter(|s| Path::new(s).is_absolute())
        .ok_or("Asset directory must be absolute")?;
    std::fs::create_dir_all(asset)?;
    let asset = crate::platform::canonicalize(asset)?;
    let cache = crate::platform::canonicalize(project)?.join(".cache/figma-network");
    if asset.starts_with(&cache) {
        return Err("Asset directory must be outside the managed cache".into());
    }
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let engine = Handle::start(project.to_owned())?;
    let metadata: Value = serde_json::from_str(include_str!("../resources/tools.json"))?;
    let tools = serde_json::from_value(metadata["tools"].clone())?;
    let mut info = ServerConfig::new(ServerCapabilities::builder().enable_tools().build());
    info.server_info = serde_json::from_value(metadata["info"].clone())?;
    info.instructions = metadata["instructions"].as_str().map(str::to_owned);
    let server = Server {
        bridge: Arc::new(Mutex::new(Bridge::default())),
        engine,
        tools: Arc::new(tools),
        info,
        asset: asset.to_string_lossy().into(),
        variables: config["variablesFile"].as_str().map(str::to_owned),
        read_busy: Arc::new(AtomicBool::new(false)),
        snapshot_gate: Arc::new(tokio::sync::Mutex::new(())),
        export_busy: Arc::new(AtomicBool::new(false)),
        limit: Arc::new(Semaphore::new(8)),
    };
    let bridge = server.clone();
    let secret = Arc::new(secret);
    let accept = tokio::spawn(async move {
        let permits = Arc::new(Semaphore::new(8));
        let mut id = 0;
        loop {
            let Ok((tcp, _)) = listener.accept().await else {
                break;
            };
            let Ok(permit) = permits.clone().try_acquire_owned() else {
                continue;
            };
            id += 1;
            let server = bridge.clone();
            let secret = secret.clone();
            tokio::spawn(async move {
                let _permit = permit;
                connection(server, tcp, id, secret).await;
            });
        }
    });
    eprintln!("turbo-figma MCP server (Rust)");
    eprintln!(
        "Figma bridge listening on ws://127.0.0.1:{port}. Pair the browser adapter. Assets: {}",
        asset.display()
    );
    let service = server.clone().serve(rmcp::transport::stdio()).await?;
    let cancellation = service.cancellation_token();
    let watcher = tokio::spawn(async move {
        while !STOP.load(Ordering::Relaxed) {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        cancellation.cancel();
    });
    let result = service.waiting().await;
    watcher.abort();
    accept.abort();
    if let Some(peer) = server.bridge.lock().unwrap().peer.clone() {
        let _ = peer.tx.try_send(close("Server is shutting down"));
    }
    let _ = server.engine.call(json!({"op":"disconnect"})).await;
    result?;
    Ok(())
}
