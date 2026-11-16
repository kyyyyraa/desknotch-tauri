//! Small Windows helpers used by the bridge commands.
//!
//! Everything here talks to the Win32 API directly so the backend does not
//! need extra crates for the two things the notch really needs: the battery
//! state and pasting text into the previously focused window.

use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};

/// HWND window yang harus menerima hasil paste.
///
/// Di-capture SEBELUM user pindah fokus ke UI notch/voice, karena saat
/// perintah paste sampai, window foreground sudah jadi UI DeskNotch — paste
/// akan mendarat di window yang salah kalau cuma_andalkan GetForegroundWindow.
static PASTE_TARGET: OnceLock<Mutex<Option<usize>>> = OnceLock::new();

fn paste_target_slot() -> &'static Mutex<Option<usize>> {
    PASTE_TARGET.get_or_init(|| Mutex::new(None))
}

#[cfg(windows)]
mod platform {
    use std::ffi::c_void;

    pub type BOOL = i32;
    pub type DWORD = u32;
    pub type UINT = u32;
    pub type HANDLE = *mut c_void;
    pub type HWND = *mut c_void;

    pub const CF_UNICODETEXT: UINT = 13;
    pub const GMEM_MOVEABLE: DWORD = 0x0002;
    pub const INPUT_KEYBOARD: DWORD = 1;
    pub const KEYEVENTF_KEYUP: DWORD = 0x0002;
    pub const VK_CONTROL: u16 = 0x11;
    pub const VK_V: u16 = 0x56;

    #[repr(C)]
    pub struct SYSTEM_POWER_STATUS {
        pub ac_line_status: u8,
        pub battery_flag: u8,
        pub battery_life_percent: u8,
        pub reserved: u8,
        pub battery_life_time: DWORD,
        pub battery_full_life_time: DWORD,
    }

    #[repr(C)]
    pub struct KEYBDINPUT {
        pub w_vk: u16,
        pub w_scan: u16,
        pub dw_flags: DWORD,
        pub time: DWORD,
        pub dw_extra_info: usize,
    }

    #[repr(C)]
    pub struct INPUT {
        pub r#type: DWORD,
        pub ki: KEYBDINPUT,
    }

    #[link(name = "user32")]
    extern "system" {
        pub fn OpenClipboard(hwnd: HWND) -> BOOL;
        pub fn CloseClipboard() -> BOOL;
        pub fn EmptyClipboard() -> BOOL;
        pub fn SetClipboardData(format: UINT, data: HANDLE) -> HANDLE;
        pub fn GetWindowTextW(hwnd: HWND, lpString: *mut u16, nMaxCount: i32) -> i32;
        pub fn SendInput(count: UINT, inputs: *mut INPUT, size: i32) -> UINT;
        // AttachThreadInput tidak ada di windows-sys::Win32::UI::WindowsAndMessaging
        // (di bindings itu dia ada di Win32::System::Threading, dan feature-nya
        // tidak aktif di Cargo.toml), jadi dideklarasi langsung di sini.
        pub fn AttachThreadInput(idattach: DWORD, idattachto: DWORD, fattach: BOOL) -> BOOL;
    }

    #[link(name = "kernel32")]
    extern "system" {
        pub fn GlobalAlloc(flags: DWORD, bytes: usize) -> HANDLE;
        pub fn GlobalLock(mem: HANDLE) -> *mut c_void;
        pub fn GlobalUnlock(mem: HANDLE) -> BOOL;
        pub fn GetSystemPowerStatus(status: *mut SYSTEM_POWER_STATUS) -> BOOL;
        // Sama seperti AttachThreadInput: windows-sys menaruhnya di
        // Win32::System::Threading yang tidak aktif, jadi declare manual.
        pub fn GetCurrentThreadId() -> DWORD;
    }
}

#[cfg(windows)]
pub fn battery() -> Value {
    use platform::*;

    let mut status = SYSTEM_POWER_STATUS {
        ac_line_status: 0,
        battery_flag: 255,
        battery_life_percent: 255,
        reserved: 0,
        battery_life_time: 0,
        battery_full_life_time: 0,
    };

    let ok = unsafe { GetSystemPowerStatus(&mut status) } != 0;
    if !ok {
        return json!({ "level": 1.0, "charging": false, "supported": false });
    }

    // 8 = no system battery, 255 = unknown.
    let has_battery = status.battery_flag != 8 && status.battery_flag != 255;
    let on_ac = status.ac_line_status == 1;
    let charging = if has_battery {
        (status.battery_flag & 4) != 0 || (on_ac && (status.battery_flag & 1) == 0)
    } else {
        on_ac
    };
    let level = if has_battery && status.battery_life_percent != 255 {
        f64::from(status.battery_life_percent) / 100.0
    } else {
        1.0
    };

    json!({ "level": level, "charging": charging, "supported": has_battery })
}

#[cfg(not(windows))]
pub fn battery() -> Value {
    json!({ "level": 1.0, "charging": false, "supported": false })
}

#[cfg(windows)]
pub fn get_foreground_window_info() -> Value {
    use platform::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return json!({ "hwnd": 0, "title": "" });
        }
        let mut buf = [0u16; 512];
        let len = GetWindowTextW(hwnd, buf.as_mut_ptr(), 512);
        let title = if len > 0 {
            String::from_utf16_lossy(&buf[..len as usize])
        } else {
            String::new()
        };
        json!({ "hwnd": hwnd as usize, "title": title })
    }
}

#[cfg(not(windows))]
pub fn get_foreground_window_info() -> Value {
    json!({ "hwnd": 0, "title": "" })
}

/// Captures the current foreground window as the paste target and returns its
/// handle (0 when there is no foreground window).
///
/// Call this BEFORE the recording starts, while the user's application still
/// has focus. `paste_text` then restores focus to this window instead of
/// pasting into the DeskNotch UI.
#[cfg(windows)]
pub fn capture_paste_target() -> usize {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    let hwnd = unsafe { GetForegroundWindow() };
    let value = if hwnd.is_null() { 0 } else { hwnd as usize };

    if let Ok(mut slot) = paste_target_slot().lock() {
        *slot = if value == 0 { None } else { Some(value) };
    }

    value
}

#[cfg(not(windows))]
pub fn capture_paste_target() -> usize {
    0
}

/// Forgets the captured paste target (call when the recording is done).
pub fn restore_paste_target() {
    if let Ok(mut slot) = paste_target_slot().lock() {
        *slot = None;
    }
}

/// HWND target yang tersimpan, kalau ada.
#[cfg(windows)]
fn stored_paste_target() -> Option<platform::HWND> {
    paste_target_slot()
        .lock()
        .ok()
        .and_then(|slot| *slot)
        .map(|hwnd| hwnd as platform::HWND)
}

/// Brings `target` to the foreground and reports whether it really is the
/// foreground window afterwards.
///
/// Windows blocks `SetForegroundWindow` when the caller does not own the
/// foreground input, so we attach to the input threads of the current
/// foreground window and of the target before calling it.
#[cfg(windows)]
fn focus_window(target: platform::HWND) -> bool {
    use platform::{AttachThreadInput, GetCurrentThreadId};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId, IsIconic, SetForegroundWindow, ShowWindow,
        SW_RESTORE,
    };

    unsafe {
        if GetForegroundWindow() == target {
            return true;
        }

        // A minimized window cannot take the focus, so restore it first.
        if IsIconic(target) != 0 {
            ShowWindow(target, SW_RESTORE);
        }

        let current_thread = GetCurrentThreadId();
        let foreground = GetForegroundWindow();

        let foreground_thread = if foreground.is_null() {
            0
        } else {
            GetWindowThreadProcessId(foreground, std::ptr::null_mut())
        };
        let target_thread = GetWindowThreadProcessId(target, std::ptr::null_mut());

        let mut attached_foreground = false;
        let mut attached_target = false;

        if foreground_thread != 0 && foreground_thread != current_thread {
            attached_foreground = AttachThreadInput(current_thread, foreground_thread, 1) != 0;
        }
        if target_thread != 0 && target_thread != current_thread {
            attached_target = AttachThreadInput(current_thread, target_thread, 1) != 0;
        }

        SetForegroundWindow(target);

        if attached_foreground {
            AttachThreadInput(current_thread, foreground_thread, 0);
        }
        if attached_target {
            AttachThreadInput(current_thread, target_thread, 0);
        }

        GetForegroundWindow() == target
    }
}

/// Writes `text` to the clipboard and replays Ctrl+V into the window that had
/// focus when the request arrived.
///
/// The target window is the one captured by `capture_paste_target()` (called
/// before the recording started), because by the time this runs the focus
/// already moved to the DeskNotch UI. Falls back to the current foreground
/// window when nothing was captured.
#[cfg(windows)]
pub fn paste_text(text: &str) -> Value {
    use platform::*;
    use std::ptr;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    if text.is_empty() {
        return json!({ "ok": false, "reason": "empty" });
    }

    let target = match stored_paste_target() {
        Some(hwnd) => hwnd,
        None => unsafe { GetForegroundWindow() },
    };
    if target.is_null() {
        return json!({ "ok": false, "reason": "no target window" });
    }

    // Give the focus back to the target app. Windows may refuse
    // (foreground lock), and in that case we must not pretend the paste
    // worked.
    if !focus_window(target) {
        return json!({ "ok": false, "reason": "foreground-lock" });
    }

    let mut wide: Vec<u16> = text.encode_utf16().collect();
    wide.push(0);
    let bytes = wide.len() * std::mem::size_of::<u16>();

    unsafe {
        if OpenClipboard(ptr::null_mut()) == 0 {
            return json!({ "ok": false, "reason": "clipboard busy" });
        }
        EmptyClipboard();

        let mem = GlobalAlloc(GMEM_MOVEABLE, bytes);
        if mem.is_null() {
            CloseClipboard();
            return json!({ "ok": false, "reason": "clipboard alloc failed" });
        }
        let dst = GlobalLock(mem);
        if dst.is_null() {
            CloseClipboard();
            return json!({ "ok": false, "reason": "clipboard lock failed" });
        }
        ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, dst as *mut u8, bytes);
        GlobalUnlock(mem);

        if SetClipboardData(CF_UNICODETEXT, mem).is_null() {
            CloseClipboard();
            return json!({ "ok": false, "reason": "clipboard write failed" });
        }
        CloseClipboard();
    }

    let mut inputs = [
        INPUT { r#type: INPUT_KEYBOARD, ki: KEYBDINPUT { w_vk: VK_CONTROL, w_scan: 0, dw_flags: 0, time: 0, dw_extra_info: 0 } },
        INPUT { r#type: INPUT_KEYBOARD, ki: KEYBDINPUT { w_vk: VK_V, w_scan: 0, dw_flags: 0, time: 0, dw_extra_info: 0 } },
        INPUT { r#type: INPUT_KEYBOARD, ki: KEYBDINPUT { w_vk: VK_V, w_scan: 0, dw_flags: KEYEVENTF_KEYUP, time: 0, dw_extra_info: 0 } },
        INPUT { r#type: INPUT_KEYBOARD, ki: KEYBDINPUT { w_vk: VK_CONTROL, w_scan: 0, dw_flags: KEYEVENTF_KEYUP, time: 0, dw_extra_info: 0 } },
    ];

    let sent = unsafe {
        SendInput(inputs.len() as UINT, inputs.as_mut_ptr(), std::mem::size_of::<INPUT>() as i32)
    };
    if sent != inputs.len() as UINT {
        return json!({ "ok": false, "reason": "keystroke injection failed" });
    }

    json!({ "ok": true })
}

#[cfg(not(windows))]
pub fn paste_text(_text: &str) -> Value {
    json!({ "ok": false, "reason": "clipboard paste is only implemented on Windows" })
}
