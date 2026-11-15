//! Privacy sensor: which apps are using the microphone or camera right now.
//!
//! Windows records device access under the CapabilityAccessManager key:
//!   HKCU / SOFTWARE / Microsoft / Windows / CurrentVersion /
//!   CapabilityAccessManager / ConsentStore / <device> / NonPackaged / <app>
//! Each key carries the FILETIME LastUsedTimeStart and LastUsedTimeStop; a
//! Stop of 0 means the device is still open. The Electron build polled this
//! with PowerShell; the native build reads the registry directly, which is
//! faster and spawns no process.

use std::ffi::c_void;
use windows_sys::Win32::Foundation::FILETIME;
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER,
};

const KEY_READ_VALUE: u32 = 0x20019;
const ERROR_SUCCESS: u32 = 0;
const ERROR_NO_MORE_ITEMS: u32 = 259;

/// One device's access record.
#[derive(Debug, Clone, Default)]
pub struct DeviceAccess {
    /// True while at least one app holds the device open.
    pub in_use: bool,
    /// Apps that touched the device recently (exe name, newest first).
    pub apps: Vec<String>,
}

fn read_reg_i64(key: HKEY, name: &str) -> Option<i64> {
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let mut value: i64 = 0;
    let mut size: u32 = std::mem::size_of::<i64>() as u32;
    let mut kind: u32 = 0;
    let ok = unsafe {
        RegQueryValueExW(
            key,
            wide.as_ptr(),
            std::ptr::null_mut(),
            &mut kind,
            &mut value as *mut i64 as *mut u8,
            &mut size,
        )
    };
    if ok != ERROR_SUCCESS {
        return None;
    }
    Some(value)
}

/// FILETIME (100 ns since 1601) -> unix seconds.
fn filetime_to_unix(ft: i64) -> i64 {
    if ft <= 0 {
        return 0;
    }
    ft / 10_000_000 - 11_644_473_600
}

/// Turns a mangled consent key ("C:#Program Files#Foo#bar.exe") into "bar".
fn pretty_app_name(mangled: &str) -> String {
    let bs = 92 as char;
    let restored = mangled.replace('#', &bs.to_string());
    let file = restored.rsplit(bs).next().unwrap_or(mangled);
    let file = file.trim();
    let stem = file.strip_suffix(".exe").unwrap_or(file);
    stem.to_string()
}

fn scan_device(device: &str, recent_secs: i64) -> DeviceAccess {
    let mut out = DeviceAccess::default();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let bs = 92 as char;
    let path = [
        "SOFTWARE",
        "Microsoft",
        "Windows",
        "CurrentVersion",
        "CapabilityAccessManager",
        "ConsentStore",
        device,
        "NonPackaged",
    ]
    .join(&bs.to_string());
    let wide_path: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();

    let mut hkey: HKEY = std::ptr::null_mut();
    let ok = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            wide_path.as_ptr(),
            0,
            KEY_READ_VALUE,
            &mut hkey,
        )
    };
    if ok != ERROR_SUCCESS || hkey.is_null() {
        return out;
    }

    let mut index: u32 = 0;
    loop {
        let mut name_buf = [0u16; 512];
        let mut name_len: u32 = name_buf.len() as u32;
        let ok = unsafe {
            RegEnumKeyExW(
                hkey,
                index,
                name_buf.as_mut_ptr(),
                &mut name_len,
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if ok == ERROR_NO_MORE_ITEMS {
            break;
        }
        if ok != ERROR_SUCCESS {
            break;
        }
        index += 1;

        let mangled = String::from_utf16_lossy(&name_buf[..name_len as usize]);
        let mut sub: HKEY = std::ptr::null_mut();
        let ok =
            unsafe { RegOpenKeyExW(hkey, name_buf.as_ptr(), 0, KEY_READ_VALUE, &mut sub) };
        if ok != ERROR_SUCCESS || sub.is_null() {
            continue;
        }
        let stop = read_reg_i64(sub, "LastUsedTimeStop");
        let start = read_reg_i64(sub, "LastUsedTimeStart");
        unsafe { RegCloseKey(sub) };

        // Stop == 0 means the device was never released: it is open right now.
        if stop == Some(0) {
            out.in_use = true;
        }
        let stop_at = stop.map(filetime_to_unix).unwrap_or(0);
        let start_at = start.map(filetime_to_unix).unwrap_or(0);
        let last_use = stop_at.max(start_at);
        if last_use > 0 && now - last_use <= recent_secs {
            out.apps.push(pretty_app_name(&mangled));
        }
    }
    unsafe { RegCloseKey(hkey) };

    out.apps.sort();
    out.apps.dedup();
    out.apps.reverse();
    out.apps.truncate(4);
    out
}

/// The whole snapshot the notch UI renders.
#[derive(Debug, Clone)]
pub struct PrivacyState {
    pub mic: bool,
    pub camera: bool,
    pub mic_apps: Vec<String>,
    pub camera_apps: Vec<String>,
}

impl PrivacyState {
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "mic": self.mic,
            "camera": self.camera,
            "micApps": self.mic_apps,
            "cameraApps": self.camera_apps,
            "wifi": serde_json::Value::Null,
            "bluetooth": Vec::<String>::new(),
        })
    }
}

/// Reads the current privacy state. `recent_secs` bounds how far back an app
/// counts as "recently used".
pub fn read_state(recent_secs: i64) -> PrivacyState {
    let mic = scan_device("microphone", recent_secs);
    let cam = scan_device("webcam", recent_secs);
    PrivacyState {
        mic: mic.in_use,
        camera: cam.in_use,
        mic_apps: mic.apps,
        camera_apps: cam.apps,
    }
}

/// True when two snapshots differ enough to be worth broadcasting.
pub fn changed(a: &PrivacyState, b: &PrivacyState) -> bool {
    a.mic != b.mic
        || a.camera != b.camera
        || a.mic_apps != b.mic_apps
        || a.camera_apps != b.camera_apps
}

/// Poll helper for the background watcher: returns the state only when it
/// changed since the last call.
pub fn poll_changed(last: &mut PrivacyState) -> Option<PrivacyState> {
    let now = read_state(300);
    if changed(last, &now) {
        *last = now.clone();
        Some(now)
    } else {
        None
    }
}

#[allow(dead_code)]
fn _marker(_f: FILETIME, _c: *mut c_void) {}
