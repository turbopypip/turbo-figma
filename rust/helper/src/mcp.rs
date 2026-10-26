//! MCP stdio transport; tool implementations are supplied by the migration host.
use crate::websocket::{read_packet, write_packet};
use rmcp::{model::*, service::RequestContext, ErrorData, RoleServer, ServerHandler, ServiceExt};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    net::UnixStream,
    sync::{mpsc, oneshot, Semaphore},
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
struct Host {
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    output: mpsc::Sender<Value>,
    sequence: AtomicU64,
    limit: Arc<Semaphore>,
}
struct Pending {
    host: Arc<Host>,
    id: u64,
}
impl Drop for Pending {
    fn drop(&mut self) {
        if self.host.pending.lock().unwrap().remove(&self.id).is_some() {
            let _ = self
                .host
                .output
                .try_send(json!({"kind":"cancel","id":self.id}));
        }
    }
}
#[derive(Clone)]
struct Server {
    host: Arc<Host>,
    tools: Vec<Tool>,
    info: ServerConfig,
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
            tools: self.tools.clone(),
            ..Default::default()
        })
    }
    async fn call_tool(
        &self,
        q: CallToolRequestParams,
        ctx: RequestContext<RoleServer>,
    ) -> std::result::Result<CallToolResponse, ErrorData> {
        if self.get_tool(&q.name).is_none() {
            return Err(ErrorData::invalid_params("Tool not found", None));
        }
        let _permit =
            self.host.limit.clone().try_acquire_owned().map_err(|_| {
                ErrorData::internal_error("MCP tool concurrency limit exceeded", None)
            })?;
        let id = self.host.sequence.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.host.pending.lock().unwrap().insert(id, tx);
        let _pending = Pending {
            host: self.host.clone(),
            id,
        };
        let request = json!({"kind":"call","id":id,"name":q.name,"arguments":q.arguments});
        if serde_json::to_vec(&request)
            .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?
            .len()
            > 65536
        {
            return Err(ErrorData::invalid_params(
                "Tool arguments limit exceeded",
                None,
            ));
        }
        self.host
            .output
            .send(request)
            .await
            .map_err(|_| ErrorData::internal_error("Tool host disconnected", None))?;
        let value = tokio::select! {
         value=rx=>value.map_err(|_|ErrorData::internal_error("Tool host disconnected",None))?,
         _=ctx.ct.cancelled()=>return Err(ErrorData::internal_error("Request cancelled",None)),
         _=tokio::time::sleep(Duration::from_secs(150))=>return Err(ErrorData::internal_error("Tool host timed out",None)),
        };
        let result: CallToolResult = serde_json::from_value(value)
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(result.into())
    }
}
pub async fn run(path: &str) -> Result<()> {
    let mut socket = UnixStream::connect(path).await?;
    let config = read_packet(&mut socket).await?;
    let tools: Vec<Tool> = serde_json::from_value(config["tools"].clone())?;
    let mut info = ServerConfig::new(ServerCapabilities::builder().enable_tools().build());
    info.server_info = serde_json::from_value(config["info"].clone())?;
    info.instructions = config["instructions"].as_str().map(str::to_owned);
    let (mut read, mut write) = socket.into_split();
    let (tx, mut rx) = mpsc::channel(32);
    let host = Arc::new(Host {
        pending: Mutex::new(HashMap::new()),
        output: tx,
        sequence: AtomicU64::new(1),
        limit: Arc::new(Semaphore::new(8)),
    });
    let writer = tokio::spawn(async move {
        while let Some(v) = rx.recv().await {
            write_packet(&mut write, &v).await?;
        }
        Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
    });
    let reader_host = host.clone();
    let mut reader = tokio::spawn(async move {
        loop {
            match read_packet(&mut read).await {
                Ok(v) => {
                    if let Some(id) = v["id"].as_u64() {
                        if let Some(tx) = reader_host.pending.lock().unwrap().remove(&id) {
                            let _ = tx.send(v["result"].clone());
                        }
                    }
                }
                Err(_) => {
                    reader_host.pending.lock().unwrap().clear();
                    break;
                }
            }
        }
    });
    let server = Server { host, tools, info }
        .serve(rmcp::transport::stdio())
        .await?;
    tokio::select! {result=server.waiting()=>{result?;},_=&mut reader=>{}}
    reader.abort();
    writer.abort();
    Ok(())
}
