use crate::approval_gate::ApprovalGate;
use crate::click_through::{ClickThroughManager, Rect};
use crate::ocr::WinRtOcr;
use crate::pipe_server::PipeServerManager;
use crate::store::StoreManager;
use crate::system;
use crate::voice::VoiceManager;
use crate::win;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

// ------------------------------------------------------------- spotify: uri --
// `spotify:` URIs are opened with ShellExecuteW (shell32), never cmd.exe, so
// there is no command interpreter to inject into. The allowlist still blocks
// quotes, whitespace and shell metacharacters so the value cannot break out of
// the protocol handler's command template. '%' is allowed on purpose: the only
// caller (dn-voice-exec.js) sends encodeURIComponent() output, which escapes
// every space as %NN — without it every search containing a space would be
// rejected and silently fall back to the web player.
fn is_safe_spotify_uri(uri: &str) -> bool {
    if !uri.starts_with("spotify:") || uri.len() > 256 {
        return false;
    }
    uri.chars().all(|c| {
        c.is_ascii_alphanumeric()
            || matches!(
                c,
                ':' | '/' | '?' | '=' | '&' | '-' | '_' | '.' | '%' | '!' | '~' | '*' | '(' | ')'
            )
    })
}

/// Open a URI through the shell association for its protocol. Returns true
/// only when ShellExecuteW reports success (HINSTANCE > 32).
fn open_uri_via_shell(uri: &str) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let file: Vec<u16> = std::ffi::OsStr::new(uri)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let verb: Vec<u16> = std::ffi::OsStr::new("open")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // windows-sys 0.59: HWND/HINSTANCE are *mut c_void, string params are
    // PCWSTR (*const u16), nshowcmd is SHOW_WINDOW_CMD (i32).
    let res = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    } as isize;
    // HINSTANCE > 32 means success.
    res > 32
}

// -------------------------------------------------------------- screenshots --
// Screenshot paths come from the `screenshot:new` event (src/screenshot.rs):
// PNG/JPG files Windows drops into %USERPROFILE%\Pictures\Screenshots or the
// OneDrive variant. `screenshot:discard`/`screenshot:rename` receive that path
// back from the renderer, so it must be pinned to those directories before it
// touches the filesystem (same base-dir logic as ScreenshotWatcher::start).
fn screenshot_base_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        dirs.push(
            PathBuf::from(user_profile)
                .join("Pictures")
                .join("Screenshots"),
        );
    }
    if let Ok(one_drive) = std::env::var("OneDrive") {
        let p = PathBuf::from(one_drive).join("Pictures").join("Screenshots");
        if !dirs.contains(&p) {
            dirs.push(p);
        }
    }
    dirs
}

/// Extensions the screenshot watcher emits (src/screenshot.rs).
fn is_screenshot_ext(ext: &str) -> bool {
    matches!(ext.to_lowercase().as_str(), "png" | "jpg" | "jpeg")
}

/// Strip the \\?\ verbatim prefix that std::fs::canonicalize adds on Windows
/// so the renderer keeps seeing plain C:\... paths.
fn strip_verbatim_prefix(p: PathBuf) -> PathBuf {
    let s = p.as_os_str().to_string_lossy().into_owned();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{}", rest));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    p
}

/// Validate a raw screenshot path from the renderer: it must canonicalize to
/// an existing file inside one of the watched Screenshots directories and
/// carry a screenshot extension. Returns the canonical (verbatim) path.
fn validate_screenshot_path(raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty() {
        return Err("empty screenshot path".to_string());
    }
    let target = std::fs::canonicalize(raw)
        .map_err(|e| format!("screenshot path not found: {} ({})", raw, e))?;
    let canonical_bases: Vec<PathBuf> = screenshot_base_dirs()
        .iter()
        .filter_map(|b| std::fs::canonicalize(b).ok())
        .collect();
    if canonical_bases.is_empty() {
        return Err("no Screenshots directory available".to_string());
    }
    // starts_with compares path components, so .../Screenshots-evil/... does
    // not match the .../Screenshots base.
    if !canonical_bases.iter().any(|b| target.starts_with(b)) {
        return Err("screenshot path escapes the Screenshots directory".to_string());
    }
    let ext = target.extension().and_then(|e| e.to_str()).unwrap_or("");
    if !is_screenshot_ext(ext) {
        return Err(format!("not a screenshot extension: {}", ext));
    }
    Ok(target)
}

/// Reject anything that is not a single plain filename: no separators, no
/// dot-dot, no trailing dot/space, no reserved device names.
fn sanitize_filename(name: &str) -> Result<String, String> {
    let cleaned = name.trim();
    if cleaned.is_empty() {
        return Err("filename is empty".to_string());
    }
    if cleaned.contains('/')
        || cleaned.contains('\\')
        || cleaned.contains("..")
        || cleaned.contains(':')
        || cleaned.contains('\0')
    {
        return Err("filename contains path separators or traversal".to_string());
    }
    if Path::new(cleaned).file_name().and_then(|f| f.to_str()) != Some(cleaned) {
        return Err("filename is not a single plain name".to_string());
    }
    if cleaned.ends_with('.') || cleaned.ends_with(' ') {
        return Err("filename ends with '.' or space".to_string());
    }
    let stem = cleaned.split('.').next().unwrap_or("").to_uppercase();
    if matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6"
            | "COM7" | "COM8" | "COM9" | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6"
            | "LPT7" | "LPT8" | "LPT9"
    ) {
        return Err("filename is a reserved device name".to_string());
    }
    Ok(cleaned.to_string())
}

pub struct AppState {
    pub store: StoreManager,
    pub click_through: ClickThroughManager,
    /// None when WinRT TTS failed to initialize: voice features degrade to
    /// honest errors instead of refusing to start the whole app.
    pub voice: Option<Arc<VoiceManager>>,
    pub pipe: PipeServerManager,
    /// None when the Windows OCR engine/language pack is unavailable.
    pub ocr: Option<Arc<WinRtOcr>>,
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
            if is_safe_spotify_uri(uri) {
                let ok = open_uri_via_shell(uri);
                if !ok {
                    eprintln!("[app:open-uri] ShellExecuteW failed to open spotify uri");
                }
                Ok(Value::Bool(ok))
            } else {
                eprintln!(
                    "[app:open-uri] rejected unsafe/non-spotify uri (len={}): {:?}",
                    uri.len(),
                    &uri[..uri.len().min(48)]
                );
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
            // Hotkey combos are compiled in (Ctrl+Alt+V/D, Ctrl+Alt+C, Alt+C,
            // Esc) and were registered at startup — report the REAL failures
            // (combo held by another app) instead of a fake empty list.
            let failed = state
                .voice
                .as_ref()
                .map(|v| v.hotkeys.registration_failures())
                .unwrap_or_default();
            Ok(serde_json::json!({
                "ok": true,
                "failed": failed,
                "fixed": true,
                "command": "Ctrl+Alt+V",
                "dictate": "Ctrl+Alt+D",
                "shortAsk": "Ctrl+Alt+C"
            }))
        }
        "dnvoice:speak-onecore" | "dnvoice:speak-ps" => {
            let text = args.get(0)
                .and_then(|v| v.get("text"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let duration_ms = state
                .voice
                .as_ref()
                .ok_or_else(|| "Voice/TTS unavailable on this system".to_string())?
                .speak(text)?;
            Ok(serde_json::json!({ "ok": true, "duration_ms": duration_ms }))
        }
        "dnvoice:stop-onecore" | "dnvoice:stop-ps" => {
            if let Some(v) = state.voice.as_ref() {
                v.stop_speech();
            }
            Ok(Value::Bool(true))
        }
        "dnvoice:list-onecore" | "dnvoice:list-ps" => {
            Ok(serde_json::json!(
                state.voice.as_ref().map(|v| v.list_voices()).unwrap_or_default()
            ))
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
            let ocr = state
                .ocr
                .as_ref()
                .ok_or_else(|| "OCR unavailable on this system".to_string())?;
            let text = if let Some(p) = path {
                ocr.recognize_file(p).map_err(|e| format!("{:?}", e))?
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
            // The renderer passes the toggle state: a plain boolean, or an
            // object carrying it. Registry writes are skipped when the
            // entry already matches, so opening Settings never rewrites it.
            let requested = args.get(0).and_then(|v| {
                v.as_bool().or_else(|| {
                    v.get("enabled")
                        .or_else(|| v.get("enable"))
                        .or_else(|| v.get("value"))
                        .and_then(|b| b.as_bool())
                })
            });
            match requested {
                Some(enable) => {
                    let already = crate::system::start_on_boot_entry().is_some();
                    if already != enable {
                        let applied = crate::system::set_start_on_boot(enable)?;
                        if !applied {
                            // Dev build: the entry was deliberately not written.
                            return Ok(Value::Bool(already));
                        }
                        eprintln!(
                            "[DeskNotch] autostart {}",
                            if enable { "enabled" } else { "disabled" }
                        );
                    }
                    Ok(Value::Bool(enable))
                }
                None => Ok(Value::Bool(crate::system::start_on_boot_entry().is_some())),
            }
        }
        "update:get" => {
            // No updater is built into DeskNotch — report the real compile-time
            // version with status "idle" (the Settings panel renders nothing
            // for "idle", which is the honest display for "no update system").
            Ok(serde_json::json!({
                "status": "idle",
                "version": env!("CARGO_PKG_VERSION"),
                "supported": false
            }))
        }
        "update:check" => {
            Ok(serde_json::json!({ "status": "idle", "supported": false }))
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
                        // Legacy plaintext key from before DPAPI sealing existed.
                        // One-way migration: seal it now and persist the sealed
                        // form into the same settings entry dn-router.js reads
                        // (settings.dnRouterKeySealed), then return the
                        // plaintext one last time. Future calls receive the
                        // DPAPI-sealed value and decrypt normally, so the
                        // plaintext never hits this branch again.
                        match crate::crypto::seal_key(sealed) {
                            Ok(new_sealed) if !new_sealed.is_empty() => {
                                let mut next = match state.store.get("settings").as_object() {
                                    Some(obj) => obj.clone(),
                                    None => serde_json::Map::new(),
                                };
                                next.insert(
                                    "dnRouterKeySealed".to_string(),
                                    Value::String(new_sealed),
                                );
                                let persisted = state
                                    .store
                                    .set(&app, "settings".to_string(), Value::Object(next));
                                if persisted {
                                    eprintln!(
                                        "[dnrouter:open] plaintext sk- key migrated to DPAPI-sealed store entry"
                                    );
                                } else {
                                    eprintln!(
                                        "[dnrouter:open] WARNING: could not persist migrated key; plaintext will be returned again"
                                    );
                                }
                                Ok(Value::String(sealed.to_string()))
                            }
                            Ok(_) => {
                                eprintln!(
                                    "[dnrouter:open] WARNING: DPAPI seal produced empty output; plaintext key returned unmigrated"
                                );
                                Ok(Value::String(sealed.to_string()))
                            }
                            Err(se) => {
                                eprintln!(
                                    "[dnrouter:open] WARNING: DPAPI seal failed ({}); plaintext key returned unmigrated",
                                    se
                                );
                                Ok(Value::String(sealed.to_string()))
                            }
                        }
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
            if path.is_empty() {
                return Ok(Value::Bool(false));
            }
            match validate_screenshot_path(path) {
                Ok(valid) => match std::fs::remove_file(&valid) {
                    Ok(_) => Ok(Value::Bool(true)),
                    Err(e) => Err(format!("Failed to delete screenshot: {}", e)),
                },
                Err(e) => Err(format!("Failed to delete screenshot: {}", e)),
            }
        }
        "screenshot:rename" => {
            let path = args.get(0).and_then(|v| v.as_str()).unwrap_or("");
            let new_name = args.get(1).and_then(|v| v.as_str()).unwrap_or("");
            if path.is_empty() || new_name.is_empty() {
                return Ok(Value::Null);
            }
            let result = (|| -> Result<String, String> {
                let old_p = validate_screenshot_path(path)?;
                let name = sanitize_filename(new_name)?;
                // Preserve the original extension logic: keep the screenshot's
                // extension, appending it when the new name lacks it.
                let ext = old_p.extension().and_then(|e| e.to_str()).unwrap_or("");
                let new_filename = if ext.is_empty() {
                    name
                } else if name.ends_with(&format!(".{}", ext)) {
                    name
                } else {
                    format!("{}.{}", name, ext)
                };
                let parent = old_p
                    .parent()
                    .ok_or_else(|| "screenshot has no parent directory".to_string())?;
                let new_path = parent.join(new_filename);
                std::fs::rename(&old_p, &new_path)
                    .map_err(|e| format!("Failed to rename screenshot: {}", e))?;
                Ok(strip_verbatim_prefix(new_path).to_string_lossy().to_string())
            })();
            match result {
                Ok(new_path) => Ok(Value::String(new_path)),
                Err(e) => Err(e),
            }
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
            Err(format!("Unsupported channel: {}", other))
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
            if let Some(v) = state.voice.as_ref() {
                v.hotkeys.set_live(true);
                v.hotkeys.set_busy(true);
            }
        }
        "live:stop" => {
            if let Some(v) = state.voice.as_ref() {
                v.hotkeys.set_live(false);
                v.hotkeys.set_busy(false);
                v.stop_speech();
                v.abort_recording();
            }
        }
        "dnvoice:speaking-state" => {
            // Fire-and-forget indicator broadcast: the renderer announces TTS
            // state; there is intentionally no backend action or fake reply.
        }
        "dnptt:log" => {
            // Renderer-side PTT trace: without this the log file only shows
            // the Rust side and the session chain is invisible.
            if let Some(line) = data.as_ref().and_then(|v| v.as_str()) {
                crate::logfile::append(&format!("[render] {}", line));
            }
        }
        "dnptt:done" => {
            if let Some(v) = state.voice.as_ref() {
                v.hotkeys.set_busy(false);
            }
        }
        "dnptt:abort" => {
            if let Some(v) = state.voice.as_ref() {
                v.hotkeys.set_busy(false);
                v.abort_recording();
            }
        }
        other => {
            eprintln!("[bridge_send] unhandled channel: {}", other);
        }
    }
    Ok(())
}
