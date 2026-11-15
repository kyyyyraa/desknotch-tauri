use crate::store::StoreManager;
use tauri::{AppHandle, WebviewWindow};

/// Structure representing DisplayInfo expected by DeskNotch frontend
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    pub id: String,
    pub label: String,
    pub bounds: RectData,
    pub work_area: RectData,
    pub scale_factor: f64,
    pub is_primary: bool,
}

#[derive(Debug, serde::Serialize)]
pub struct RectData {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Enumerates all monitors and returns DisplayInfo array matching DeskNotch frontend schema
pub fn get_displays_info<R: tauri::Runtime>(app: &AppHandle<R>) -> Vec<DisplayInfo> {
    let Ok(monitors) = app.available_monitors() else {
        return Vec::new();
    };

    let primary_name = app
        .primary_monitor()
        .ok()
        .flatten()
        .and_then(|m| m.name().cloned());

    monitors
        .into_iter()
        .enumerate()
        .map(|(idx, m)| {
            let name = m.name().cloned().unwrap_or_else(|| format!("Display {}", idx + 1));
            let is_primary = primary_name.as_ref().map(|pn| pn == &name).unwrap_or(idx == 0);
            let scale = m.scale_factor();

            let b_pos = m.position();
            let b_size = m.size();
            let w_rect = m.work_area();

            // Dimensions in logical pixels matching Electron's screen API
            let bounds = RectData {
                x: (b_pos.x as f64 / scale).round() as i32,
                y: (b_pos.y as f64 / scale).round() as i32,
                width: (b_size.width as f64 / scale).round() as u32,
                height: (b_size.height as f64 / scale).round() as u32,
            };

            let work_area = RectData {
                x: (w_rect.position.x as f64 / scale).round() as i32,
                y: (w_rect.position.y as f64 / scale).round() as i32,
                width: (w_rect.size.width as f64 / scale).round() as u32,
                height: (w_rect.size.height as f64 / scale).round() as u32,
            };

            let res = format!("{}×{}", bounds.width, bounds.height);
            let label = if is_primary {
                format!("{} (Primary - {})", name, res)
            } else {
                format!("{} ({})", name, res)
            };

            DisplayInfo {
                id: name,
                label,
                bounds,
                work_area,
                scale_factor: scale,
                is_primary,
            }
        })
        .collect()
}

/// Syncs the notch window position to the top edge of the selected display.
/// Placed flush at the very top of the screen (y = bounds.y, typically 0),
/// seamlessly overlapping the Mac menubar (MyDockFinder / MyFinderApp) like a real MacBook notch.
pub fn sync_notch_window(window: &WebviewWindow, store: &StoreManager) {
    let settings = store.get("settings");
    let selected_id = settings
        .get("selectedDisplayId")
        .and_then(|v| v.as_str())
        .unwrap_or("primary");

    let Ok(monitors) = window.available_monitors() else {
        return;
    };

    if monitors.is_empty() {
        return;
    }

    // Find target monitor matching selectedDisplayId or fallback to primary
    let target = if selected_id != "primary" && selected_id != "all" {
        monitors
            .iter()
            .find(|m| m.name().map(|n| n == selected_id).unwrap_or(false))
            .or_else(|| {
                window
                    .primary_monitor()
                    .ok()
                    .flatten()
                    .as_ref()
                    .and_then(|pm| monitors.iter().find(|m| m.name() == pm.name()))
            })
            .unwrap_or(&monitors[0])
    } else {
        window
            .primary_monitor()
            .ok()
            .flatten()
            .as_ref()
            .and_then(|pm| monitors.iter().find(|m| m.name() == pm.name()))
            .unwrap_or(&monitors[0])
    };

    let b_pos = target.position();
    let b_size = target.size();
    let scale = target.scale_factor();

    // Sits flush at the top edge of the monitor (y = b_pos.y), perfectly flush with the top!
    let target_x = b_pos.x;
    let target_y = b_pos.y;
    let target_width = b_size.width;
    let target_height = (500.0 * scale).round() as u32;

    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
        x: target_x,
        y: target_y,
    }));

    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
        width: target_width,
        height: target_height,
    }));
}

/// Keeps the notch window always on top of MyDockFinder (MyFinderApp / Dock_64)
/// so that the notch is seamlessly embedded on top of the Mac menu bar.
pub fn sync_zorder_with_myfinder(window: &WebviewWindow) {
    #[cfg(target_os = "windows")]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            FindWindowW, SetWindowPos, HWND_TOPMOST, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE,
            SWP_NOMOVE, SWP_NOSIZE,
        };

        let class_name: Vec<u16> = "MyFinderApp\0".encode_utf16().collect();
        let bar_hwnd = FindWindowW(class_name.as_ptr(), std::ptr::null());
        if !bar_hwnd.is_null() {
            if let Ok(hwnd) = window.hwnd() {
                let notch_hwnd = hwnd.0 as windows_sys::Win32::Foundation::HWND;
                let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS;
                // 1. Assert bar is TOPMOST
                SetWindowPos(bar_hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags);
                // 2. Assert notch is TOPMOST after bar (so notch is strictly above the bar)
                SetWindowPos(notch_hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags);
            }
        }
    }
}
