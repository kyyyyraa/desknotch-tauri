use crate::approval_gate::ApprovalGate;
use crate::click_through::{ClickThroughManager, Rect};
use crate::ocr::WinRtOcr;
use crate::pipe_server::PipeServerManager;
use crate::store::StoreManager;
use crate::system;
use crate::voice::VoiceManager;
use crate::win;
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

pub struct AppState {
    pub store: StoreManager,
    pub click_through: ClickThroughManager,
    pub voice: Arc<VoiceManager>,
    pub pipe: PipeServerManager,
    pub ocr: Arc<WinRtOcr>,
    pub window_watcher: crate::window_watcher::WindowWatcher,
    pub approval: ApprovalGate,
}

#[tauri::command]
pub async fn bridge_invoke(
    app: AppHandle,
    state: State<'_, AppState>,
    channel: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    match channel.as_str() {
        "store:get" => {
            let key = args.get(0).and_then(|v| v.as_str()).unwrap_or("");
            Ok(state.store.get(key))
        }
        "store:set" => {
            let key = args.get(0).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let val = args.get(1).cloned().unwrap_or(Value::Null);
            let ok = state.store.set(&app, key.clone(), val);
            if key == "settings" {
                use tauri::Manager;
                if let Some(win) = app.get_webview_window("main") {
                    crate::display::sync_notch_window(&win, &state.store);
                }
            }
            Ok(Value::Bool(ok))
        }
        "display:get-all" => {
            Ok(serde_json::json!(crate::display::get_displays_info(&app)))
        }
        "dn:shell" => {
            let cmd = args.get(0)
                .and_then(|v| v.get("cmd"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            Ok(system::run_sandboxed_shell(cmd).await)
        }
        "files:search" => {
            let req = args.get(0);
            let query = req.and_then(|v| v.get("query")).and_then(|v| v.as_str()).unwrap_or("");
            let hint = req.and_then(|v| v.get("hint")).and_then(|v| v.as_str());
            Ok(system::search_files(query, hint).await)
        }
        "files:open" => {
            let path = args.get(0).and_then(|v| v.as_str()).unwrap_or("");
            Ok(Value::Bool(system::open_path(path)))
        }
        "files:reveal" => {
            let path = args.get(0).and_then(|v| v.as_str()).unwrap_or("");
            Ok(Value::Bool(system::reveal_path(path)))
        }
        "app:open-url" => {
            let url = args.get(0).and_then(|v| v.as_str()).unwrap_or("");
            Ok(system::open_url_smart(url).await)
        }
        "app:open-uri" => {
            let uri = args.get(0).and_then(|v| v.as_str()).unwrap_or("");
            if uri.starts_with("spotify:") {
                let _ = std::process::Command::new("cmd")
                    .args(&["/c", "start", "", uri])
                    .spawn();
                Ok(Value::Bool(true))
            } else {
                Ok(Value::Bool(false))
            }
        }
        "app:focus-window" => {
            let hint = args.get(0).and_then(|v| v.as_str()).unwrap_or("");
            Ok(system::focus_window(hint).await)
        }
        "system:lock" => {
            Ok(Value::Bool(system::lock_workstation()))
        }
        "system:theme" => {
            let req = args.get(0);
            let mode = req
                .and_then(|v| v.get("mode").or_else(|| v.get("theme")))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            Ok(system::toggle_theme(mode).await)
        }
        "system:volume" => {
            let req = args.get(0);
            let level = req.and_then(|v| v.get("level")).and_then(|v| v.as_i64());
            let delta = req.and_then(|v| v.get("delta")).and_then(|v| v.as_i64());
            Ok(system::set_volume(level, delta).await)
        }
        "apps:launch" => {
            let target_id = args.get(0).and_then(|v| v.as_str()).unwrap_or("");
            let target_name = args.get(1).and_then(|v| v.as_str()).unwrap_or(target_id);
            Ok(Value::Bool(system::launch_app(target_id, target_name)))
        }
        "battery:get" => {
            Ok(win::battery())
        }
        "dnptt:paste" => {
            // Renderer mengirim {text}; string legacy tetap diterima.
            let first = args.get(0);
            let text = first
                .and_then(|v| v.get("text"))
                .and_then(|v| v.as_str())
                .or_else(|| first.and_then(|v| v.as_str()))
                .unwrap_or("")
                .to_string();
            Ok(win::paste_text(&text))
        }
        "dnptt:capture-target" => {
            // Simpan HWND window yang aktif SEBELUM rekaman dimulai, supaya
            // hasil dictate diklik ke tempat yang benar.
            Ok(serde_json::json!({ "hwnd": win::capture_paste_target() }))
        }
        "dnptt:clear-target" => {
            win::restore_paste_target();
            Ok(Value::Bool(true))
        }
        "system:diagnose" => {
            Ok(crate::system::diagnose_system().await)
        }
        "rates:get" => {
            Ok(crate::rates::get_usd_idr().await)
        }
        "dnptt:get-foreground" => {
            Ok(win::get_foreground_window_info())
        }
        "dnptt:set-hotkeys" => {
            Ok(serde_json::json!({ "ok": true, "failed": [] }))
        }
        "dnvoice:speak-onecore" | "dnvoice:speak-ps" => {
            let text = args.get(0)
                .and_then(|v| v.get("text"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let duration_ms = state.voice.speak(text)?;
            Ok(serde_json::json!({ "ok": true, "duration_ms": duration_ms }))
        }
        "dnvoice:stop-onecore" | "dnvoice:stop-ps" => {
            state.voice.stop_speech();
            Ok(Value::Bool(true))
        }
        "dnvoice:list-onecore" | "dnvoice:list-ps" => {
            Ok(serde_json::json!(state.voice.list_voices()))
        }
        "voice:gpu_check" => {
            // Cheap existence probe: the model itself loads lazily on the
            // first transcription so an idle app keeps no model resident.
            Ok(serde_json::json!({ "ok": crate::voice::whisper::is_available() }))
        }
        "voice:transcribe" => {
            let req = args.get(0);
            let pcm_b64 = req
                .and_then(|v| v.get("pcm_b64"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let lang = req
                .and_then(|v| v.get("lang"))
                .and_then(|v| v.as_str())
                .unwrap_or("id");
            crate::voice::whisper::transcribe_b64(pcm_b64, lang).await
        }
        "privacy:get" => {
            Ok(crate::privacy::read_state(300).to_json())
        }
        "ocr:recognize" => {
            let req = args.get(0);
            let path = req.and_then(|v| v.get("path")).and_then(|v| v.as_str());
            let text = if let Some(p) = path {
                state.ocr.recognize_file(p).map_err(|e| format!("{:?}", e))?
            } else {
                String::new()
            };
            Ok(serde_json::json!({ "ok": true, "text": text }))
        }
        "dnai:request-approval" => {
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
        "dnai:respond" => {
            let req = args.get(0);
            let id = req.and_then(|v| v.get("id")).and_then(|v| v.as_str()).unwrap_or("");
            let decision = req.and_then(|v| v.get("decision")).and_then(|v| v.as_str()).unwrap_or("deny");
            // Our own approval gate first; a pipe request is the fallback.
            if state.approval.respond(id, decision) {
                return Ok(Value::Bool(true));
            }
            Ok(Value::Bool(state.pipe.respond(id, decision)))
        }
        "settings:start-on-boot" => {
            Ok(Value::Bool(true))
        }
        "update:get" => {
            Ok(serde_json::json!({ "status": "idle", "version": "1.0.5" }))
        }
        "update:check" => {
            Ok(serde_json::json!({ "status": "idle" }))
        }
        "app:is-store" => {
            Ok(Value::Bool(false))
        }
        "dnrouter:seal" => {
            let key = args.get(0).and_then(|v| v.as_str()).unwrap_or("");
            match crate::crypto::seal_key(key) {
                Ok(sealed) => Ok(Value::String(sealed)),
                Err(e) => {
                    eprintln!("[dnrouter:seal] error: {}", e);
                    Ok(Value::Null)
                }
            }
        }
        "dnrouter:open" => {
            let sealed = args.get(0).and_then(|v| v.as_str()).unwrap_or("");
            match crate::crypto::open_key(sealed) {
                Ok(plain) => Ok(Value::String(plain)),
                Err(e) => {
                    if sealed.starts_with("sk-") {
                        Ok(Value::String(sealed.to_string()))
                    } else {
                        eprintln!("[dnrouter:open] error: {}", e);
                        Ok(Value::Null)
                    }
                }
            }
        }
        "dnrouter:http" => {
            let payload = args.get(0);
            let url_str = payload.and_then(|v| v.get("url")).and_then(|v| v.as_str()).unwrap_or("");
            if !url_str.starts_with("http://127.0.0.1:") && !url_str.starts_with("http://localhost:") {
                return Ok(serde_json::json!({
                    "ok": false,
                    "status": 0,
                    "error": "url tidak diizinkan"
                }));
            }

            let method = payload.and_then(|v| v.get("method")).and_then(|v| v.as_str()).unwrap_or("GET");
            let headers_map = payload.and_then(|v| v.get("headers")).and_then(|v| v.as_object());
            let body_str = payload.and_then(|v| v.get("body")).and_then(|v| v.as_str());

            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(25))
                .build()
                .map_err(|e| e.to_string())?;

            let mut req = match method.to_uppercase().as_str() {
                "POST" => client.post(url_str),
                "PUT" => client.put(url_str),
                "DELETE" => client.delete(url_str),
                _ => client.get(url_str),
            };

            if let Some(headers) = headers_map {
                for (k, v) in headers {
                    if let Some(val_str) = v.as_str() {
                        req = req.header(k.as_str(), val_str);
                    }
                }
            }

            if let Some(b) = body_str {
                req = req.body(b.to_string());
            }

            match req.send().await {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    let is_ok = resp.status().is_success();
                    let text = resp.text().await.unwrap_or_default();
                    Ok(serde_json::json!({
                        "ok": is_ok,
                        "status": status,
                        "body": text
                    }))
                }
                Err(e) => {
                    Ok(serde_json::json!({
                        "ok": false,
                        "status": 0,
                        "error": format!("{}", e)
                    }))
                }
            }
        }
        "files:describe" => {
            let paths = args.get(0).and_then(|v| v.as_array());
            let mut res = Vec::new();
            if let Some(arr) = paths {
                for item in arr {
                    if let Some(p) = item.as_str() {
                        if let Some(info) = crate::system::describe_file(p) {
                            res.push(info);
                        }
                    }
                }
            }
            Ok(serde_json::json!(res))
        }
        "screenshot:discard" => {
            let path = args.get(0).and_then(|v| v.as_str()).unwrap_or("");
            if !path.is_empty() {
                let _ = std::fs::remove_file(path);
                Ok(Value::Bool(true))
            } else {
                Ok(Value::Bool(false))
            }
        }
        "screenshot:rename" => {
            let path = args.get(0).and_then(|v| v.as_str()).unwrap_or("");
            let new_name = args.get(1).and_then(|v| v.as_str()).unwrap_or("");
            if path.is_empty() || new_name.is_empty() {
                return Ok(Value::Null);
            }
            let old_p = std::path::Path::new(path);
            if let Some(parent) = old_p.parent() {
                let ext = old_p.extension().and_then(|e| e.to_str()).unwrap_or("");
                let new_filename = if ext.is_empty() {
                    new_name.to_string()
                } else if new_name.ends_with(&format!(".{}", ext)) {
                    new_name.to_string()
                } else {
                    format!("{}.{}", new_name, ext)
                };
                let new_path = parent.join(new_filename);
                if std::fs::rename(old_p, &new_path).is_ok() {
                    return Ok(Value::String(new_path.to_string_lossy().to_string()));
                }
            }
            Ok(Value::Null)
        }
        "notch:tucked" => {
            Ok(Value::Bool(state.window_watcher.is_tucked()))
        }
        "smtc:get" => {
            Ok(crate::smtc::get_current_session_info().unwrap_or(Value::Null))
        }
        "lrc:get" => {
            let req = args.get(0).cloned().unwrap_or(Value::Null);
            Ok(crate::lrc::fetch(&req).await)
        }
        "lrc:seek" => {
            let pos = args
                .get(0)
                .and_then(|v| v.get("pos_sec"))
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            Ok(Value::Bool(crate::smtc::try_seek(pos)))
        }
        "clipboard:copy-image" => {
            // Klik kartu gambar di riwayat clipboard: tulis balik ke clipboard
            // Windows sebagai CF_DIB (data URL BMP -> bagian DIB saja).
            let data = args
                .get(0)
                .and_then(|v| v.get("data_url"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let bytes = crate::clipboard::data_url_to_dib(&data);
            match bytes {
                Some(dib) => Ok(Value::Bool(crate::clipboard::copy_image_bmp(&dib))),
                None => Ok(Value::Bool(false)),
            }
        }
        "clipboard:copy" => {
            // Klik item riwayat clipboard = salin kembali ke clipboard
            let text = args
                .get(0)
                .and_then(|v| v.get("text"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Ok(Value::Bool(crate::clipboard::copy_text(&text)))
        }
        "notif:open" => {
            // Klik notifikasi tab Notif: fokus sumber + buka URL DI sumbernya
            let req = args.get(0);
            let hint = req
                .and_then(|v| v.get("hint"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let url = req
                .and_then(|v| v.get("url"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let profile = req
                .and_then(|v| v.get("profile"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Ok(crate::system::notif_open(&hint, &url, &profile).await)
        }
        "notif:focus" => {
            // Klik notifikasi di tab Notif: fokuskan app asalnya (Discord,
            // WhatsApp via Chrome, dll). rawApp = AUMID, app = label rapih.
            let req = args.get(0);
            let raw = req
                .and_then(|v| v.get("raw"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let app = req
                .and_then(|v| v.get("app"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let hint = if !raw.is_empty() { raw } else { app };
            Ok(crate::system::focus_media_app(&hint).await)
        }
        "media:key" => {
            let act = args.get(0).and_then(|v| v.as_str()).unwrap_or("");
            Ok(Value::Bool(crate::smtc::send_media_key(act)))
        }
        "media:focus" => {
            // Klik album art di kartu Home: fokuskan jendela app pemutar
            // (SMTC sourceAppId, mis. "Chrome" / "Spotify").
            let app_id = args.get(0).and_then(|v| v.as_str()).unwrap_or("");
            Ok(crate::system::focus_media_app(app_id).await)
        }
        other => {
            eprintln!("[bridge_invoke] unhandled channel: {}", other);
            Ok(Value::Null)
        }
    }
}

#[tauri::command]
pub async fn bridge_send(
    app: AppHandle,
    state: State<'_, AppState>,
    channel: String,
    data: Option<Value>,
) -> Result<(), String> {
    match channel.as_str() {
        "notch:bounds" => {
            if let Some(val) = data {
                if let Ok(rects) = serde_json::from_value::<Vec<Rect>>(val) {
                    state.click_through.update_bounds(rects);
                }
            }
        }
        "app:quit" => {
            app.exit(0);
        }
        "live:start" => {
            state.voice.hotkeys.set_live(true);
            state.voice.hotkeys.set_busy(true);
        }
        "live:stop" => {
            state.voice.hotkeys.set_live(false);
            state.voice.hotkeys.set_busy(false);
            state.voice.stop_speech();
            state.voice.abort_recording();
        }
        "dnvoice:speaking-state" => {
            // Speech active indicator
        }
        "dnptt:log" => {
            // Renderer-side PTT trace: without this the log file only shows
            // the Rust side and the session chain is invisible.
            if let Some(line) = data.as_ref().and_then(|v| v.as_str()) {
                crate::logfile::append(&format!("[render] {}", line));
            }
        }
        "dnptt:done" => {
            state.voice.hotkeys.set_busy(false);
        }
        "dnptt:abort" => {
            state.voice.hotkeys.set_busy(false);
            state.voice.abort_recording();
        }
        other => {
            eprintln!("[bridge_send] unhandled channel: {}", other);
        }
    }
    Ok(())
}
