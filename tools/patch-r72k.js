// r72k: implement dnai:request-approval in the backend (the approval gate the
// assistant's own plans need). Without it the JS shim's `false` fallback
// answered every plan and the UI showed "Aksi dibatalkan".
const fs = require('fs');
const path = require('path');

const base = path.join(__dirname, '..', 'src-tauri', 'src');
let fail = 0;

function patch(file, edits) {
  const p = path.join(base, file);
  let src = fs.readFileSync(p, 'utf8');
  for (const [name, from, to] of edits) {
    if (!src.includes(from)) { console.error('NOT FOUND [' + file + '/' + name + ']'); fail = 1; continue; }
    src = src.split(from).join(to);
    console.log('OK [' + file + '/' + name + ']');
  }
  fs.writeFileSync(p, src, 'utf8');
}

// ---- bridge.rs --------------------------------------------------------
patch('bridge.rs', [
  ['imports',
    'use crate::click_through::{ClickThroughManager, Rect};',
    'use crate::approval_gate::ApprovalGate;\nuse crate::click_through::{ClickThroughManager, Rect};'],
  ['tauri-emitter',
    'use tauri::{AppHandle, State};',
    'use tauri::{AppHandle, Emitter, State};'],
  ['state-field',
    '    pub window_watcher: crate::window_watcher::WindowWatcher,\n}',
    '    pub window_watcher: crate::window_watcher::WindowWatcher,\n    pub approval: ApprovalGate,\n}'],
  ['request-approval',
    '        "dnai:respond" => {',
    `        "dnai:request-approval" => {
            let req = args.get(0);
            let title = req
                .and_then(|v| v.get("title"))
                .and_then(|v| v.as_str())
                .unwrap_or("Izin Aksi AI")
                .to_string();
            let detail = req
                .and_then(|v| v.get("detail"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let tool = req
                .and_then(|v| v.get("tool"))
                .and_then(|v| v.as_str())
                .unwrap_or("ai")
                .to_string();

            // Register, show the card, wait for the answer.
            let (id, rx) = state.approval.register();
            let payload = serde_json::json!({
                "id": id,
                "tool": tool,
                "title": title,
                "detail": detail,
                "cwd": "",
                "ts": std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
            });
            let _ = app.emit("dnai:approval", &payload);

            let allowed = crate::approval_gate::await_decision(
                &state.approval,
                id.clone(),
                rx,
                45,
            )
            .await;
            Ok(Value::Bool(allowed))
        }
        "dnai:respond" => {`],
  ['respond-handler',
    `        "dnai:respond" => {
            let req = args.get(0);
            let id = req.and_then(|v| v.get("id")).and_then(|v| v.as_str()).unwrap_or("");
            let decision = req.and_then(|v| v.get("decision")).and_then(|v| v.as_str()).unwrap_or("deny");
            Ok(Value::Bool(state.pipe.respond(id, decision)))
        }`,
    `        "dnai:respond" => {
            let req = args.get(0);
            let id = req.and_then(|v| v.get("id")).and_then(|v| v.as_str()).unwrap_or("");
            let decision = req.and_then(|v| v.get("decision")).and_then(|v| v.as_str()).unwrap_or("deny");
            // Our own approval gate first; a pipe request is the fallback.
            if state.approval.respond(id, decision) {
                return Ok(Value::Bool(true));
            }
            Ok(Value::Bool(state.pipe.respond(id, decision)))
        }`],
]);

// ---- lib.rs -----------------------------------------------------------
patch('lib.rs', [
  ['module',
    'pub mod bridge;',
    'pub mod approval_gate;\npub mod bridge;'],
  ['state-init',
    '        window_watcher: window_watcher.clone(),\n    };',
    '        window_watcher: window_watcher.clone(),\n        approval: crate::approval_gate::ApprovalGate::new(),\n    };'],
]);

if (fail) process.exit(1);
console.log('r72k backend patch done');
