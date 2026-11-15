pub mod approval_gate;
pub mod bridge;
pub mod click_through;
pub mod crypto;
pub mod display;
pub mod logfile;
pub mod lrc;
pub mod notif;
pub mod ocr;
pub mod pipe_server;
pub mod privacy;
pub mod screenshot;
pub mod smtc;
pub mod store;
pub mod system;
pub mod voice;
pub mod win;
pub mod window_watcher;

use bridge::{bridge_invoke, bridge_send, AppState};
use click_through::ClickThroughManager;
use notif::NotificationWatcher;
use ocr::WinRtOcr;
use pipe_server::PipeServerManager;
use store::StoreManager;
use voice::VoiceManager;
use window_watcher::WindowWatcher;
use std::sync::Arc;
use tauri::Manager;

pub fn run() {
    let store = StoreManager::new();
    let click_through = ClickThroughManager::new();
    let pipe = PipeServerManager::new();
    let window_watcher = WindowWatcher::new();
    let notif_watcher = NotificationWatcher::new();
    let voice = match VoiceManager::new() {
        Ok(v) => Arc::new(v),
        Err(e) => {
            eprintln!("[DeskNotch] VoiceManager init failed: {}", e);
            panic!("Cannot start without VoiceManager: {}", e);
        }
    };
    let ocr = match WinRtOcr::new() {
        Ok(o) => Arc::new(o),
        Err(e) => {
            eprintln!("[DeskNotch] WinRtOcr init failed: {:?}", e);
            panic!("Cannot start without WinRtOcr: {:?}", e);
        }
    };

    let store_for_sync = store.clone();
    let app_state = AppState {
        store,
        click_through: click_through.clone(),
        voice: Arc::clone(&voice),
        pipe: pipe.clone(),
        ocr,
        window_watcher: window_watcher.clone(),
        approval: crate::approval_gate::ApprovalGate::new(),
    };

    let voice_hotkeys = Arc::clone(&voice);

    tauri::Builder::default()
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![bridge_invoke, bridge_send])
        .setup(move |app| {
            // Start named pipe server on \\.\pipe\desknotch-ai
            pipe.start(app.handle().clone());

            // Start screenshot directory watcher (%USERPROFILE%\Pictures\Screenshots)
            let screenshot_watcher = screenshot::ScreenshotWatcher::new();
            screenshot_watcher.start(app.handle().clone());

            // Start Windows toast notification watcher (%LOCALAPPDATA%\...\wpndatabase.db)
            notif_watcher.start(app.handle().clone());

            // Start Windows System Media Transport Controls (SMTC) watcher for Now Playing
            let smtc_watcher = smtc::SmtcWatcher::new();
            smtc_watcher.start(app.handle().clone());

            // Privacy sensor: watch the ConsentStore so the notch can show the
    // mic/camera dots. It only pushes an event when something changed.
    {
        let app_h = app.handle().clone();
        std::thread::spawn(move || {
            let mut last = crate::privacy::read_state(300);
            loop {
                std::thread::sleep(std::time::Duration::from_secs(4));
                if let Some(state) = crate::privacy::poll_changed(&mut last) {
                    use tauri::Emitter;
                    let _ = app_h.emit("privacy:state", state.to_json());
                }
            }
        });
    }

    // Start global hotkeys (Ctrl+Alt+V, Ctrl+Alt+D, Escape)
            voice_hotkeys.hotkeys.start_listener(app.handle().clone());

            if let Some(window) = app.get_webview_window("main") {
                // Start window watcher (hideOnFullscreen & tuckForBrowsers)
                window_watcher.start_polling(window.clone(), store_for_sync.clone());
                // Sits flush at top of screen (y = 0), overlapping the Mac menu bar
                display::sync_notch_window(&window, &store_for_sync);
                display::sync_zorder_with_myfinder(&window);

                // Initial click-through: ignore mouse clicks so desktop below is accessible
                let _ = window.set_ignore_cursor_events(true);

                // Set Windows WS_EX_TOOLWINDOW so the window doesn't appear in Alt+Tab
                #[cfg(target_os = "windows")]
                {
                    use windows_sys::Win32::UI::WindowsAndMessaging::{
                        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
                    };
                    if let Ok(hwnd) = window.hwnd() {
                        unsafe {
                            let hwnd_val = hwnd.0 as windows_sys::Win32::Foundation::HWND;
                            let current_style = GetWindowLongPtrW(hwnd_val, GWL_EXSTYLE);
                            SetWindowLongPtrW(hwnd_val, GWL_EXSTYLE, current_style | WS_EX_TOOLWINDOW as isize);
                        }
                    }
                }

                // Background watcher: keeps notch on top of MyFinder top bar and adjusts if resolution changes
                let win_for_watcher = window.clone();
                let store_for_watcher = store_for_sync.clone();
                std::thread::spawn(move || {
                    let mut last_bounds = (0, 0, 0, 0);
                    loop {
                        std::thread::sleep(std::time::Duration::from_millis(1500));
                        display::sync_zorder_with_myfinder(&win_for_watcher);

                        if let Ok(Some(mon)) = win_for_watcher.current_monitor() {
                            let pos = mon.position();
                            let sz = mon.size();
                            let current_b = (pos.x, pos.y, sz.width, sz.height);
                            if current_b != last_bounds {
                                last_bounds = current_b;
                                display::sync_notch_window(&win_for_watcher, &store_for_watcher);
                            }
                        }
                    }
                });

                // Start hit-testing thread
                click_through.start_polling(window);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running DeskNotch Tauri application");
}
