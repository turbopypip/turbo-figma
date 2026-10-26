//! Loopback-only WebSocket transport. Application auth/capture handlers use bounded IPC.
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::{mpsc, Mutex, Semaphore},
};
use tokio_tungstenite::{
    accept_async_with_config,
    tungstenite::{
        protocol::{frame::coding::CloseCode, CloseFrame, WebSocketConfig},
        Message,
    },
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
const LIMIT: usize = 13 * 1024 * 1024;
pub async fn read_packet(r: &mut (impl tokio::io::AsyncRead + Unpin)) -> Result<Value> {
    let n = r.read_u32_le().await? as usize;
    if n > LIMIT {
        return Err("IPC packet limit exceeded".into());
    }
    let mut b = vec![0; n];
    r.read_exact(&mut b).await?;
    Ok(serde_json::from_slice(&b)?)
}
pub async fn write_packet(w: &mut (impl tokio::io::AsyncWrite + Unpin), v: &Value) -> Result<()> {
    let b = serde_json::to_vec(v)?;
    if b.len() > LIMIT {
        return Err("IPC packet limit exceeded".into());
    }
    w.write_u32_le(b.len() as u32).await?;
    w.write_all(&b).await?;
    w.flush().await?;
    Ok(())
}
pub async fn run() -> Result<()> {
    let mut input = tokio::io::stdin();
    let config = read_packet(&mut input).await?;
    let port = config["port"]
        .as_u64()
        .filter(|p| *p <= 65535)
        .ok_or("Invalid WebSocket port")? as u16;
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AddrInUse {
                format!("EADDRINUSE: {e}")
            } else {
                e.to_string()
            }
        })?;
    let (events, mut output) = mpsc::channel::<Value>(8);
    let mut writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(v) = output.recv().await {
            write_packet(&mut stdout, &v).await?;
        }
        Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
    });
    events
        .send(json!({"event":"listening","port":listener.local_addr()?.port()}))
        .await?;
    let (commands_tx, mut commands_rx) = mpsc::channel(1);
    let input_task = tokio::spawn(async move {
        loop {
            match read_packet(&mut input).await {
                Ok(q) => {
                    if commands_tx.send(q).await.is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    let peers = Arc::new(Mutex::new(HashMap::<u64, mpsc::Sender<Value>>::new()));
    let permits = Arc::new(Semaphore::new(8));
    let mut next = 0u64;
    loop {
        tokio::select! {
            result = &mut writer => { result??; break; },
         connection=listener.accept()=>{
          let (tcp,_)=connection?;
          let Ok(permit)=permits.clone().try_acquire_owned() else {drop(tcp);continue;};
          next+=1;let id=next;let peers=peers.clone();let events=events.clone();
          tokio::spawn(async move{
           let _permit=permit;
           let config=WebSocketConfig::default().read_buffer_size(16384).write_buffer_size(0).max_write_buffer_size(6*1024*1024+65536).max_message_size(Some(6*1024*1024)).max_frame_size(Some(6*1024*1024));
           let mut socket=match tokio::time::timeout(Duration::from_secs(3),accept_async_with_config(tcp,Some(config))).await{Ok(Ok(s))=>s,_=>return};
           let (tx,mut commands)=mpsc::channel::<Value>(1);peers.lock().await.insert(id,tx);
           if events.send(json!({"event":"connection","id":id})).await.is_err(){return;}
           let mut code=1006u16;let mut reason=String::new();
           loop {tokio::select!{
            msg=socket.next()=>{match msg {
             Some(Ok(Message::Text(t)))=>{if events.send(json!({"event":"message","id":id,"data":t.as_str()})).await.is_err(){break;}},
             Some(Ok(Message::Binary(b)))=>{if events.send(json!({"event":"message","id":id,"data":String::from_utf8_lossy(&b)})).await.is_err(){break;}},
             Some(Ok(Message::Close(c)))=>{if let Some(c)=c{code=c.code.into();reason=c.reason.to_string();}else{code=1005;}let _=socket.flush().await;break;},
             Some(Ok(Message::Ping(_)))=>{if socket.flush().await.is_err(){break;}},
             Some(Ok(_))=>{},Some(Err(tokio_tungstenite::tungstenite::Error::Capacity(_)))=>{code=1009;
               let _=events.send(json!({"event":"closing","id":id})).await;
               let _=socket.close(Some(CloseFrame{code:CloseCode::Size,reason:"Message too large".into()})).await;
               // Drain already-sent payload after FIN: dropping a TCP socket with unread
               // data can send RST and erase the peer's observable close code.
               let tcp=socket.get_mut();let _=tcp.shutdown().await;
               let _=tokio::time::timeout(Duration::from_secs(1),async {
                 let mut buffer=[0u8;16384];let mut bytes=0;
                 while bytes<8*1024*1024 {match tcp.read(&mut buffer).await{Ok(0)|Err(_)=>break,Ok(n)=>bytes+=n}}
               }).await;
               break;},Some(Err(_))|None=>break,
            }},
            cmd=commands.recv()=>{let Some(cmd)=cmd else{break;};match cmd["op"].as_str(){
             Some("send")=>{let Some(data)=cmd["data"].as_str() else{break;};if data.len()>6*1024*1024||socket.send(Message::Text(data.to_owned().into())).await.is_err(){break;}},
             Some("close")=>{code=cmd["code"].as_u64().unwrap_or(1000) as u16;reason=cmd["reason"].as_str().unwrap_or("").to_owned();let _=socket.close(Some(CloseFrame{code:CloseCode::from(code),reason:reason.clone().into()})).await;break;},
             _=>break,
            }}
           }}
           peers.lock().await.remove(&id);let _=events.send(json!({"event":"close","id":id,"code":code,"reason":reason})).await;
          });
         },
         command=commands_rx.recv()=>{
          let Some(q)=command else{break;};if q["op"]=="shutdown"{break;}
          let id=q["id"].as_u64().ok_or("Invalid peer")?;
          let tx=peers.lock().await.get(&id).cloned();
          if let Some(tx)=tx{if tx.try_send(q).is_err(){peers.lock().await.remove(&id);}}
         }
        }
    }
    peers.lock().await.clear();
    drop(events);
    writer.abort();
    input_task.abort();
    Ok(())
}
