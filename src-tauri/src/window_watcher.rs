use crate::store::StoreManager;
use std::collections::HashSet;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, WebviewWindow};

type HWND = *mut c_void;
type HMONITOR = *mut c_void;
type HANDLE = *mut c_void;
type BOOL = i32;

#[repr(C)]
#[derive(Clone, Copy)]
struct RECT {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[repr(C)]
#[repr(C)]
struct POINT {
    x: i32,
    y: i32,
}

struct MONITORINFO {
    cb_size: u32,
    rc_monitor: RECT,
    rc_work: RECT,
    dw_flags: u32,
}

#[repr(C)]
struct PROCESSENTRY32W {
    dw_size: u32,
    cnt_usage: u32,
    th32_process_id: u32,
    th32_default_heap_id: usize,
    th32_module_id: u32,
    cnt_threads: u32,
    th32_parent_process_id: u32,
    pc_pri_class_base: i32,
    dw_flags: u32,
    sz_exe_file: [u16; 260],
}

const MONITOR_DEFAULTTONEAREST: u32 = 2;
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
const INVALID_HANDLE_VALUE: isize = -1;

/// Browsers whose tabs and address bar sit right under the notch.
const TUCK_BROWSERS: [&str; 9] = [
    "chrome", "msedge", "brave", "firefox", "opera", "vivaldi", "arc",
    // Zen Browser (Firefox-based) — nama prosesnya "zen"
    "zen", "zenbrowser",
];

/// The exam browser's own executables. SafeExamBrowser.Service is left out on
/// purpose: it runs as a background service for the whole session, so it says
/// nothing about whether an exam is actually open.
const EXAM_APPS: [&str; 2] = ["safeexambrowser", "safeexambrowser.client"];

#[link(name = "user32")]
extern "system" {
    fn GetForegroundWindow() -> HWND;
    fn GetWindowRect(hWnd: HWND, lpRect: *mut RECT) -> BOOL;
    fn MonitorFromWindow(hWnd: HWND, dwFlags: u32) -> HMONITOR;
    fn GetMonitorInfoW(hMonitor: HMONITOR, lpmi: *mut MONITORINFO) -> BOOL;
    fn GetClassNameW(hWnd: HWND, lpClassName: *mut u16, nMaxCount: i32) -> i32;
    fn GetWindowTextW(hWnd: HWND, lpString: *mut u16, nMaxCount: i32) -> i32;
    fn IsZoomed(hWnd: HWND) -> BOOL;
    fn GetClientRect(hWnd: HWND, lpRect: *mut RECT) -> BOOL;
    fn ClientToScreen(hWnd: HWND, lpPoint: *mut POINT) -> BOOL;
    fn GetWindowThreadProcessId(hWnd: HWND, lpdwProcessId: *mut u32) -> u32;
}

#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: BOOL, dwProcessId: u32) -> HANDLE;
    fn CloseHandle(hObject: HANDLE) -> BOOL;
    fn QueryFullProcessImageNameW(
        hProcess: HANDLE,
        dwFlags: u32,
        lpExeName: *mut u16,
        lpdwSize: *mut u32,
    ) -> BOOL;
    fn CreateToolhelp32Snapshot(dwFlags: u32, th32ProcessID: u32) -> HANDLE;
    fn Process32FirstW(hSnapshot: HANDLE, lppe: *mut PROCESSENTRY32W) -> BOOL;
    fn Process32NextW(hSnapshot: HANDLE, lppe: *mut PROCESSENTRY32W) -> BOOL;
}

fn is_exam_app(exe_name: &str) -> bool {
    EXAM_APPS.contains(&exe_name)
}

/// Whether SafeExamBrowser is currently open. The exam browser takes over the
/// screen, so the notch has to get out of its way whenever it is running.
fn exam_app_running() -> bool {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot as isize == INVALID_HANDLE_VALUE {
            return false;
        }

        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dw_size = std::mem::size_of::<PROCESSENTRY32W>() as u32;

        let mut found = false;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                let raw = String::from_utf16_lossy(&entry.sz_exe_file[..wstr_len(&entry.sz_exe_file)]);
                // The toolhelp snapshot keeps the extension, the foreground
                // lookup does not. Both have to end up as the same stem.
                let name = std::path::Path::new(&raw)
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                if is_exam_app(&name) {
                    found = true;
                    break;
                }
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }

        CloseHandle(snapshot);
        found
    }
}

/// The length of a null-terminated UTF-16 string.
fn wstr_len(buf: &[u16]) -> usize {
    buf.iter().position(|c| *c == 0).unwrap_or(buf.len())
}

/// Records every shrink/expand so the behaviour can be checked from a log
/// instead of by watching the bar. The release build has no console, so the
/// transitions go to a file next to the settings store.
fn log_transition(reason: &str, foreground: &str, tucked: bool) {
    use std::io::Write;

    let state = if tucked { "TUCKED" } else { "EXPANDED" };
    let Some(path) = log_file() else {
        return;
    };
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(file, "{stamp} {state} reason={reason} foreground={foreground}");
    }
}

/// The log the watcher writes to, trimmed once it gets too big.
fn log_file() -> Option<std::path::PathBuf> {
    const MAX_LOG_BYTES: u64 = 256 * 1024;

    let appdata = std::env::var("APPDATA").ok()?;
    let log_path = std::path::Path::new(&appdata)
        .join("DeskNotch")
        .join("notch-tuck.log");
    if let Some(dir) = log_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(meta) = std::fs::metadata(&log_path) {
        if meta.len() > MAX_LOG_BYTES {
            let _ = std::fs::write(&log_path, b"");
        }
    }
    Some(log_path)
}

/// Records what the watcher sees, so the detection can be checked from a log
/// instead of by watching the bar.
fn log_state(foreground: &str, exam_open: bool, is_fullscreen: bool) {
    log_state_detail(foreground, exam_open, is_fullscreen, (0, 0, 0, 0), (0, 0, 0, 0), (0, 0, 0, 0));
}

fn log_state_detail(
    foreground: &str,
    exam_open: bool,
    is_fullscreen: bool,
    win: (i32, i32, i32, i32),
    mon: (i32, i32, i32, i32),
    cli: (i32, i32, i32, i32),
) {
    use std::io::Write;

    let Some(path) = log_file() else {
        return;
    };
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(
            file,
            "{stamp} STATE foreground={foreground} exam_open={exam_open} fullscreen={is_fullscreen} win={:?} mon={:?} cli={:?}",
            win, mon, cli
        );
    }
}

#[derive(Clone)]
pub struct WindowWatcher {
    is_tucked: Arc<AtomicBool>,
    is_fullscreen_hidden: Arc<AtomicBool>,
}

impl WindowWatcher {
    pub fn new() -> Self {
        Self {
            is_tucked: Arc::new(AtomicBool::new(false)),
            is_fullscreen_hidden: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn is_tucked(&self) -> bool {
        self.is_tucked.load(Ordering::Relaxed)
    }

    pub fn start_polling(&self, window: WebviewWindow, store: StoreManager) {
        let is_tucked_clone = Arc::clone(&self.is_tucked);
        let is_hidden_clone = Arc::clone(&self.is_fullscreen_hidden);

        let browsers: HashSet<&'static str> = TUCK_BROWSERS.iter().cloned().collect();

        std::thread::spawn(move || {
            let mut last_foreground = String::new();
            let mut last_exam_open = false;

            loop {
                std::thread::sleep(Duration::from_millis(300));

                let fg = unsafe { inspect_foreground_detail() };
                let (is_fullscreen, exe_name) = (fg.fullscreen, fg.exe.clone());

                if exe_name == "self" {
                    continue;
                }

                let settings = store.get("settings");
                let hide_fullscreen = settings
                    .get("hideOnFullscreen")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let tuck_browsers = settings
                    .get("tuckForBrowsers")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                // SafeExamBrowser open: the notch shrinks so it never sits on
                // top of the exam, and it stays visible instead of hiding.
                let exam_open = exam_app_running() || is_exam_app(&exe_name);

                if exe_name != last_foreground || exam_open != last_exam_open {
                    last_foreground = exe_name.clone();
                    last_exam_open = exam_open;
                    log_state_detail(&exe_name, exam_open, is_fullscreen, fg.win, fg.mon, fg.cli);
                }

                // Handle hide on fullscreen. The exam browser is exempt: a
                // student mid-test should still find the notch waiting there.
                let hide = hide_fullscreen && is_fullscreen && !exam_open;
                if hide {
                    if !is_hidden_clone.load(Ordering::Relaxed) {
                        is_hidden_clone.store(true, Ordering::Relaxed);
                        let _ = window.hide();
                    }
                } else if is_hidden_clone.load(Ordering::Relaxed) {
                    is_hidden_clone.store(false, Ordering::Relaxed);
                    let _ = window.show();
                }

                // Handle tuck for browsers. The exam browser always shrinks:
                // it is never a coincidence that it is open.
                let is_browser = browsers.contains(exe_name.as_str());
                let should_tuck = !hide && (exam_open || (tuck_browsers && is_browser));
                let was_tucked = is_tucked_clone.load(Ordering::Relaxed);

                if should_tuck != was_tucked {
                    is_tucked_clone.store(should_tuck, Ordering::Relaxed);
                    let _ = window.emit("notch:tucked", should_tuck);
                    let reason = if exam_open {
                        "SafeExamBrowser"
                    } else if is_browser {
                        "browser"
                    } else {
                        "other"
                    };
                    log_transition(reason, &exe_name, should_tuck);
                }
            }
        });
    }
}

/// The executable name of a process, lowercased: "chrome", "safeexambrowser".
unsafe fn process_name(pid: u32) -> String {
    if pid == 0 {
        return String::new();
    }
    let h_proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if h_proc.is_null() {
        return String::new();
    }
    let mut name_buf = [0u16; 1024];
    let mut size = 1024u32;
    let mut exe_name = String::new();
    if QueryFullProcessImageNameW(h_proc, 0, name_buf.as_mut_ptr(), &mut size) != 0 {
        let full_path = String::from_utf16_lossy(&name_buf[..size as usize]);
        if let Some(file_name) = std::path::Path::new(&full_path).file_stem() {
            exe_name = file_name.to_string_lossy().to_lowercase();
        }
    }
    CloseHandle(h_proc);
    exe_name
}

struct FgDetail {
    fullscreen: bool,
    exe: String,
    win: (i32, i32, i32, i32),
    mon: (i32, i32, i32, i32),
    cli: (i32, i32, i32, i32),
}

unsafe fn inspect_foreground() -> (bool, String) {
    let d = inspect_foreground_detail();
    (d.fullscreen, d.exe)
}

unsafe fn inspect_foreground_detail() -> FgDetail {
    let hwnd = GetForegroundWindow();
    if hwnd.is_null() {
        return FgDetail { fullscreen: false, exe: String::new(), win: (0,0,0,0), mon: (0,0,0,0), cli: (0,0,0,0) };
    }

    let mut title_buf = [0u16; 256];
    let title_len = GetWindowTextW(hwnd, title_buf.as_mut_ptr(), 256);
    let title = String::from_utf16_lossy(&title_buf[..title_len as usize]);
    if title == "DeskNotch" {
        return FgDetail { fullscreen: false, exe: "self".to_string(), win: (0,0,0,0), mon: (0,0,0,0), cli: (0,0,0,0) };
    }

    let mut class_buf = [0u16; 256];
    let class_len = GetClassNameW(hwnd, class_buf.as_mut_ptr(), 256);
    let class_name = String::from_utf16_lossy(&class_buf[..class_len as usize]);
    let is_shell = class_name == "Progman"
        || class_name == "WorkerW"
        || class_name == "Shell_TrayWnd"
        || class_name == "Shell_SecondaryTrayWnd"
        || class_name == "MyFinderApp";

    let h_mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    let mut mi: MONITORINFO = std::mem::zeroed();
    mi.cb_size = std::mem::size_of::<MONITORINFO>() as u32;

    if GetMonitorInfoW(h_mon, &mut mi) == 0 {
        return FgDetail { fullscreen: false, exe: String::new(), win: (0,0,0,0), mon: (0,0,0,0), cli: (0,0,0,0) };
    }

    let mut rect: RECT = std::mem::zeroed();
    let mut is_fullscreen = false;

    // area klien (tanpa chrome browser) dalam koordinat layar
    let mut cli_rect: (i32, i32, i32, i32) = (0, 0, 0, 0);
    {
        let mut cr = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        let mut origin = POINT { x: 0, y: 0 };
        if GetClientRect(hwnd, &mut cr) != 0 && ClientToScreen(hwnd, &mut origin) != 0 {
            cli_rect = (
                origin.x,
                origin.y,
                origin.x + (cr.right - cr.left),
                origin.y + (cr.bottom - cr.top),
            );
        }
    }

    // Fullscreen = jendela menutup SELURUH monitor (termasuk area taskbar).
    // Syarat IsZoomed()==0 DIHAPUS: Zen/Firefox menampilkan video fullscreen
    // dengan jendela tetap "zoomed" (maximized), sehingga syarat lama membuat
    // Zen tidak pernah terdeteksi -> notch tetap nempel di atas video.
    // Jendela yang hanya maximized (taskbar terlihat) rect-nya berhenti
    // sebelum bawah monitor, jadi tidak salah positif.
    if !is_shell && GetWindowRect(hwnd, &mut rect) != 0 {
        is_fullscreen = rect.left <= mi.rc_monitor.left + 2
            && rect.top <= mi.rc_monitor.top + 2
            && rect.right >= mi.rc_monitor.right - 2
            && rect.bottom >= mi.rc_monitor.bottom - 2;
    }

    // Video fullscreen di browser: area klien (tanpa chrome) menutup monitor.
    if !is_fullscreen && !is_shell {
        let (cl, ct, cr_right, cr_bottom) = cli_rect;
        if cl <= mi.rc_monitor.left + 2
            && ct <= mi.rc_monitor.top + 2
            && cr_right >= mi.rc_monitor.right - 2
            && cr_bottom >= mi.rc_monitor.bottom - 2
        {
            is_fullscreen = true;
        }
    }

    let win = (rect.left, rect.top, rect.right, rect.bottom);
    let mon = (
        mi.rc_monitor.left,
        mi.rc_monitor.top,
        mi.rc_monitor.right,
        mi.rc_monitor.bottom,
    );

    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, &mut pid);
    let exe_name = process_name(pid);

    // An elevated exam browser hides its path from a normal process, so the
    // window title is the fallback signal.
    if exe_name.is_empty() && title.to_lowercase().contains("safe exam browser") {
        return FgDetail { fullscreen: is_fullscreen, exe: EXAM_APPS[0].to_string(), win, mon, cli: cli_rect };
    }

    FgDetail { fullscreen: is_fullscreen, exe: exe_name, win, mon, cli: cli_rect }
}
