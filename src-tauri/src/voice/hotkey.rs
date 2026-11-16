use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

pub const WM_HOTKEY: u32 = 0x0312;
pub const MOD_ALT: u32 = 0x0001;
pub const MOD_CONTROL: u32 = 0x0002;
pub const MOD_NOREPEAT: u32 = 0x4000;

pub const HOTKEY_COMMAND: i32 = 1;
pub const HOTKEY_DICTATE: i32 = 2;
pub const HOTKEY_ESCAPE: i32 = 3;
pub const HOTKEY_LIVE: i32 = 4;
pub const HOTKEY_CHAT: i32 = 5;

type HWND = *mut c_void;

#[repr(C)]
pub struct POINT {
    pub x: i32,
    pub y: i32,
}

#[repr(C)]
#[allow(non_snake_case)]
pub struct MSG {
    pub hwnd: HWND,
    pub message: u32,
    pub wParam: usize,
    pub lParam: isize,
    pub time: u32,
    pub pt: POINT,
}

#[link(name = "user32")]
extern "system" {
    fn RegisterHotKey(hWnd: HWND, id: i32, fsModifiers: u32, vk: u32) -> i32;
    fn UnregisterHotKey(hWnd: HWND, id: i32) -> i32;
    fn GetMessageW(lpMsg: *mut MSG, hWnd: HWND, wMsgFilterMin: u32, wMsgFilterMax: u32) -> i32;
}

#[derive(Clone)]
pub struct HotkeyManager {
    is_busy: Arc<AtomicBool>,
    is_live: Arc<AtomicBool>,
}

impl HotkeyManager {
    pub fn new() -> Self {
        Self {
            is_busy: Arc::new(AtomicBool::new(false)),
            is_live: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn set_busy(&self, busy: bool) {
        self.is_busy.store(busy, Ordering::Relaxed);
    }

    pub fn set_live(&self, live: bool) {
        self.is_live.store(live, Ordering::Relaxed);
    }

    pub fn is_live(&self) -> bool {
        self.is_live.load(Ordering::Relaxed)
    }

    pub fn start_listener<R: tauri::Runtime>(&self, app: AppHandle<R>) {
        let is_busy = Arc::clone(&self.is_busy);

        std::thread::spawn(move || {
            unsafe {
                // Hotkey 1: Ctrl + Alt + V (0x56) -> Command Mode
                RegisterHotKey(
                    std::ptr::null_mut(),
                    HOTKEY_COMMAND,
                    MOD_CONTROL | MOD_ALT | MOD_NOREPEAT,
                    0x56,
                );

                // Hotkey 2: Ctrl + Alt + D (0x44) -> Dictate Mode
                RegisterHotKey(
                    std::ptr::null_mut(),
                    HOTKEY_DICTATE,
                    MOD_CONTROL | MOD_ALT | MOD_NOREPEAT,
                    0x44,
                );

                // Hotkey 3: Escape (0x1B) -> Dismiss / Stop speech / Stop session
                RegisterHotKey(
                    std::ptr::null_mut(),
                    HOTKEY_ESCAPE,
                    0,
                    0x1B,
                );

                // Hotkey 4: Alt + C (0x43) -> Open Chat / Conversation
                RegisterHotKey(
                    std::ptr::null_mut(),
                    HOTKEY_CHAT,
                    MOD_ALT | MOD_NOREPEAT,
                    0x43,
                );

                // Hotkey 5 (slot LIVE yang tidak terpakai): Ctrl + Alt + C ->
                // buka tab Ask (tanya singkat)
                RegisterHotKey(
                    std::ptr::null_mut(),
                    HOTKEY_LIVE,
                    MOD_CONTROL | MOD_ALT | MOD_NOREPEAT,
                    0x43,
                );

                let mut msg: MSG = std::mem::zeroed();
                while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                    if msg.message == WM_HOTKEY {
                        match msg.wParam as i32 {
                            HOTKEY_COMMAND => {
                                let busy = is_busy.load(Ordering::Relaxed);
                                crate::logfile::append(&format!(
                                    "[hotkey] cmd busy={} -> {}",
                                    busy,
                                    if busy { "abort" } else { "start" }
                                ));
                                if busy {
                                    is_busy.store(false, Ordering::Relaxed);
                                    let _ = app.emit("dnptt:abort", serde_json::json!({ "mode": "command" }));
                                } else {
                                    is_busy.store(true, Ordering::Relaxed);
                                    let _ = app.emit("dnptt:start", serde_json::json!({ "mode": "command" }));
                                }
                            }
                            HOTKEY_DICTATE => {
                                let busy = is_busy.load(Ordering::Relaxed);
                                crate::logfile::append(&format!(
                                    "[hotkey] dictate busy={} -> {}",
                                    busy,
                                    if busy { "abort" } else { "start" }
                                ));
                                if busy {
                                    is_busy.store(false, Ordering::Relaxed);
                                    let _ = app.emit("dnptt:abort", serde_json::json!({ "mode": "dictate" }));
                                } else {
                                    is_busy.store(true, Ordering::Relaxed);
                                    let _ = app.emit("dnptt:start", serde_json::json!({ "mode": "dictate" }));
                                }
                            }
                            HOTKEY_ESCAPE => {
                                is_busy.store(false, Ordering::Relaxed);
                                crate::logfile::append("[hotkey] escape -> abort");
                                let _ = app.emit("dnvoice:stop", serde_json::json!({}));
                                let _ = app.emit("dnptt:abort", serde_json::json!({ "mode": "user" }));
                            }
                            HOTKEY_CHAT => {
                                crate::logfile::append("[hotkey] alt+c -> open chat");
                                let _ = app.emit("hotkey:chat", serde_json::json!({}));
                            }
                            HOTKEY_LIVE => {
                                crate::logfile::append("[hotkey] ctrl+alt+c -> open ask");
                                let _ = app.emit("hotkey:ask", serde_json::json!({}));
                            }
                            _ => {}
                        }
                    }
                }

                UnregisterHotKey(std::ptr::null_mut(), HOTKEY_COMMAND);
                UnregisterHotKey(std::ptr::null_mut(), HOTKEY_DICTATE);
                UnregisterHotKey(std::ptr::null_mut(), HOTKEY_ESCAPE);
                UnregisterHotKey(std::ptr::null_mut(), HOTKEY_CHAT);
                UnregisterHotKey(std::ptr::null_mut(), HOTKEY_LIVE);
            }
        });
    }
}
