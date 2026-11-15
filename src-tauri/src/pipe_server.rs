use serde::{Deserialize, Serialize};

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::ServerOptions;
use tokio::sync::oneshot;

pub const PIPE_NAME: &str = r"\\.\pipe\desknotch-ai";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalRequest {
    pub id: String,
    pub tool: String,
    pub title: String,
    pub detail: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub ts: u64,
}

#[derive(Clone)]
pub struct PipeServerManager {
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<String>>>>,
}

impl PipeServerManager {
    pub fn new() -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Called when the webview responds to an approval request via `dnai:respond`
    pub fn respond(&self, id: &str, decision: &str) -> bool {
        let mut guard = self.pending.lock().unwrap();
        if let Some(tx) = guard.remove(id) {
            let _ = tx.send(decision.to_string());
            true
        } else {
            false
        }
    }

    /// Spawns the named pipe listening loop in a background Tokio task
    pub fn start<R: tauri::Runtime>(&self, app_handle: AppHandle<R>) {
        let pending_map = Arc::clone(&self.pending);

        tauri::async_runtime::spawn(async move {
            loop {
                // Create a named pipe server instance
                let server = match ServerOptions::new()
                    .first_pipe_instance(false)
                    .create(PIPE_NAME)
                {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("[PipeServer] Failed to create named pipe: {}. Retrying in 2s...", e);
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        continue;
                    }
                };

                // Wait for a client to connect
                if let Err(e) = server.connect().await {
                    eprintln!("[PipeServer] Connection error: {}", e);
                    continue;
                }

                let app = app_handle.clone();
                let pending = Arc::clone(&pending_map);

                // Handle the connected client in its own task
                tokio::spawn(async move {
                    let (reader, mut writer) = tokio::io::split(server);
                    let mut lines = BufReader::new(reader).lines();

                    let Ok(Some(line)) = lines.next_line().await else {
                        return;
                    };

                    let req: ApprovalRequest = match serde_json::from_str(&line) {
                        Ok(r) => r,
                        Err(e) => {
                            eprintln!("[PipeServer] Invalid JSON request from hook: {}", e);
                            let _ = writer.write_all(b"{\"decision\":\"deny\",\"error\":\"invalid json\"}\n").await;
                            return;
                        }
                    };

                    let req_id = req.id.clone();
                    let (tx, rx) = oneshot::channel::<String>();

                    {
                        let mut guard = pending.lock().unwrap();
                        guard.insert(req_id.clone(), tx);
                    }

                    // Emit event to Tauri frontend
                    let _ = app.emit("dnai:approval", &req);

                    // Wait for response or 45-second timeout
                    let decision = match tokio::time::timeout(Duration::from_secs(45), rx).await {
                        Ok(Ok(dec)) => dec,
                        Ok(Err(_)) => "deny".to_string(), // Sender dropped
                        Err(_) => {
                            // Timeout
                            eprintln!("[PipeServer] Approval request timed out for id: {}", req_id);
                            {
                                let mut guard = pending.lock().unwrap();
                                guard.remove(&req_id);
                            }
                            let _ = app.emit("dnai:dismissed", serde_json::json!({ "id": req_id }));
                            "deny".to_string()
                        }
                    };

                    let response = serde_json::json!({
                        "decision": decision
                    });
                    let mut resp_str = response.to_string();
                    resp_str.push('\n');

                    let _ = writer.write_all(resp_str.as_bytes()).await;
                    let _ = writer.flush().await;
                });
            }
        });
    }
}
