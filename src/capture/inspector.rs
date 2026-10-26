use crate::{disk::Result, instances::array, input, wire_value::value, wire::Decoder};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::collections::HashSet;
pub struct Inspector {
    pending: Vec<u8>,
    pub schema: Vec<u8>,
    codec: Option<Decoder>,
    pub socket: Option<Value>,
    pub sequence: u64,
    started: bool,
    ended: bool,
    nodes: usize,
    pub selection: Option<Vec<String>>,
}
impl Inspector {
    pub fn new() -> Self {
        Self {
            pending: vec![],
            schema: vec![],
            codec: None,
            socket: None,
            sequence: 0,
            started: false,
            ended: false,
            nodes: 0,
            selection: None,
        }
    }
    pub fn progress(&self) -> Value {
        json!({"schemaReceived":self.codec.is_some(),"joinStarted":self.started,"joinEnded":self.ended,"initialComplete":self.ended&&self.pending.is_empty()})
    }
    pub fn push(&mut self, bytes: &[u8]) -> Result<()> {
        if self.pending.len() + bytes.len() > 16 * 1024 * 1024 {
            return Err("Initial record too large".into());
        }
        self.pending.extend_from_slice(bytes);
        while let Some(end) = self.pending.iter().position(|b| *b == 10) {
            let record: Value = serde_json::from_slice(&self.pending[..end])?;
            self.pending.drain(..=end);
            validate_record(&record, false)?;
            if self.ended {
                return Err("Messages after JOIN_END; recapture a clean initial load".into());
            }
            if record["eventSequence"].as_u64() != Some(self.sequence) {
                return Err("Missing or repeated captured event".into());
            }
            self.sequence += 1;
            let socket = json!([record["session"], record["requestId"]]);
            if self.socket.as_ref().is_some_and(|s| *s != socket) {
                return Err("Multiple multiplayer streams; reload and capture again".into());
            }
            self.socket = Some(socket);
            let binary = STANDARD.decode(record["payload"].as_str().unwrap())?;
            if binary.is_empty() {
                return Err("Invalid binary multiplayer payload".into());
            }
            if binary.starts_with(b"fig-wire") {
                if self.codec.is_some() || binary.len() < 12 || binary[8..12] != 1u32.to_le_bytes()
                {
                    return Err("Unsupported or repeated wire schema".into());
                }
                self.schema = input::inflate(&binary[12..], 2 * 1024 * 1024)?;
                self.codec = Some(Decoder::new(
                    &self.schema,
                    &HashSet::from(["phase".into()]),
                )?);
            } else {
                let codec = self
                    .codec
                    .as_ref()
                    .ok_or("Initial schema missing: reload Figma and capture again")?;
                let before = self.nodes;
                let message = value(codec.decode(
                    &input::inflate(&binary, 64 * 1024 * 1024)?,
                    &mut |n| {
                        if !self.started || self.ended || value(n)["phase"] != "CREATED" {
                            return Err("Invalid initial node batch".into());
                        }
                        self.nodes += 1;
                        if self.nodes > 200000 {
                            return Err("Initial node count limit exceeded".into());
                        }
                        Ok(())
                    },
                )?);
                if message["type"] != "NODE_CHANGES" && self.nodes != before {
                    return Err("Nodes outside initial node batch".into());
                }
                match message["type"].as_str() {
                    Some("JOIN_START") => {
                        if self.started {
                            return Err("Repeated JOIN_START".into());
                        }
                        self.started = true;
                    }
                    Some("JOIN_END") => {
                        if !self.started || self.nodes == 0 {
                            return Err("Incomplete initial snapshot before JOIN_END".into());
                        }
                        self.ended = true;
                    }
                    Some("NODE_CHANGES") => {
                        if !self.started || self.nodes == before {
                            return Err("Missing initial node batch".into());
                        }
                    }
                    None => return Err("Invalid initial message type".into()),
                    _ => {}
                }
            }
        }
        self.pending.shrink_to_fit();
        Ok(())
    }
    pub fn service(&mut self, payload: &str, sent: bool) -> Result<bool> {
        if !self.ended {
            return Err("Live schema unavailable".into());
        }
        let binary = STANDARD.decode(payload)?;
        if binary.is_empty() {
            return Err("Invalid live base64".into());
        }
        let mut nodes = 0;
        let message = value(self.codec.as_ref().unwrap().decode_service(
            &input::inflate(&binary, 1024 * 1024)?,
            sent,
            &mut |_| {
                nodes += 1;
                Ok(())
            },
        )?);
        let only = |fields: &[&str]| {
            array(&message["wireFields"])
                .iter()
                .all(|f| f.as_str().is_some_and(|s| fields.contains(&s)))
        };
        if message["type"] == "USER_CHANGES"
            && nodes == 0
            && only(if sent {
                &["type", "userChanges", "sentTimestamp", "nodeChangeOrder"]
            } else {
                &["type", "userChanges"]
            })
        {
            if sent {
                let changes = array(&message["userChanges"]);
                let selected: Vec<_> = changes
                    .iter()
                    .filter(|c| c.get("selection").is_some())
                    .collect();
                if !selected.is_empty() {
                    if changes.len() != 1
                        || !selected[0]["selection"].is_array()
                        || array(&selected[0]["selection"]).len() > 100
                    {
                        self.selection = None;
                    } else {
                        let mut ids = vec![];
                        for g in array(&selected[0]["selection"]) {
                            let id = crate::disk::id(g)?;
                            if !ids.contains(&id) {
                                ids.push(id);
                            }
                        }
                        self.selection = Some(ids);
                    }
                }
            }
            return Ok(true);
        }
        if message["type"] == "CLIENT_BROADCAST"
            && nodes == 0
            && only(if sent {
                &["type", "broadcasts", "sentTimestamp", "nodeChangeOrder"]
            } else {
                &["type", "broadcasts"]
            })
        {
            return Ok(true);
        }
        if sent
            && message["type"] == "CLIENT_RENDERED"
            && nodes == 0
            && only(&[
                "type",
                "sentTimestamp",
                "clientRenderedMetadata",
                "nodeChangeOrder",
            ])
        {
            return Ok(true);
        }
        if !sent
            && message["type"] == "SIGNAL"
            && nodes == 0
            && only(&["type", "signalName", "signalPayload", "nodeChanges"])
            && matches!(
                message["signalName"].as_str(),
                Some("reconnect-key" | "reconnect-sequence-number")
            )
        {
            return Ok(true);
        }
        if message["type"] != "NODE_CHANGES" || message.get("signalName").is_some() {
            return Err("Unsupported live message type".into());
        }
        Ok(false)
    }
}
pub fn validate_record(r: &Value, live: bool) -> Result<()> {
    let keys = [
        "version",
        "kind",
        "session",
        "requestId",
        "opcode",
        "eventSequence",
        "payload",
    ];
    if r.as_object()
        .is_none_or(|o| o.len() != keys.len() || !keys.iter().all(|k| o.contains_key(*k)))
        || r["version"] != 1
        || r["opcode"] != 2
        || !(r["kind"] == "ws-received" || live && r["kind"] == "ws-sent")
        || ["session", "requestId"].iter().any(|k| {
            r[k].as_str()
                .is_none_or(|s| s.is_empty() || s.encode_utf16().count() > 256)
        })
        || r["eventSequence"]
            .as_u64()
            .is_none_or(|v| v > 9007199254740991)
        || r["payload"]
            .as_str()
            .is_none_or(|s| s.len() > if live { 256 * 1024 } else { 8 * 1024 * 1024 })
    {
        return Err("Invalid capture record".into());
    }
    Ok(())
}
