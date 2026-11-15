//! Approval gate for actions the assistant wants to run ON the user's machine.
//!
//! The renderer already knows how to show the approval card: it listens for
//! the `dnai:approval` event and answers with `dnai:respond`. That path was
//! only wired for requests arriving through the named pipe (an external agent
//! asking this app). The assistant's own plans went out through the same
//! channel but nothing in the backend answered, so the JS shim's
//! `false` fallback took over and every plan ended as "Aksi dibatalkan".
//!
//! This module is the missing half: it registers a pending request, shows the
//! card and waits for the user's answer (45 s, then deny).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;

#[derive(Clone)]
pub struct ApprovalGate {
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    counter: Arc<Mutex<u64>>,
}

impl ApprovalGate {
    pub fn new() -> Self {
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
            counter: Arc::new(Mutex::new(0)),
        }
    }

    fn next_id(&self) -> String {
        let mut c = self.counter.lock().unwrap();
        *c += 1;
        format!("dn-local-{}-{}", std::process::id(), *c)
    }

    /// Registers a request and returns its id plus the receiver to await.
    pub fn register(&self) -> (String, oneshot::Receiver<bool>) {
        let id = self.next_id();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        (id, rx)
    }

    /// Called when the renderer answers. Returns true when this request was
    /// waiting here.
    pub fn respond(&self, id: &str, decision: &str) -> bool {
        let allowed = matches!(decision, "allow" | "approve" | "yes" | "true" | "ok");
        let mut guard = self.pending.lock().unwrap();
        if let Some(tx) = guard.remove(id) {
            let _ = tx.send(allowed);
            true
        } else {
            false
        }
    }

    /// Drops a request without an answer (the renderer went away).
    pub fn cancel(&self, id: &str) {
        self.pending.lock().unwrap().remove(id);
    }
}

/// Waits for the user's answer, denying on timeout.
pub async fn await_decision(
    gate: &ApprovalGate,
    id: String,
    rx: oneshot::Receiver<bool>,
    timeout_secs: u64,
) -> bool {
    match tokio::time::timeout(Duration::from_secs(timeout_secs), rx).await {
        Ok(Ok(allowed)) => allowed,
        Ok(Err(_)) => {
            gate.cancel(&id);
            false
        }
        Err(_) => {
            gate.cancel(&id);
            false
        }
    }
}
