use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, WebviewWindow};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone)]
pub struct ClickThroughManager {
    bounds: Arc<Mutex<Vec<Rect>>>,
    last_cursor_inside: Arc<Mutex<bool>>,
}

impl ClickThroughManager {
    pub fn new() -> Self {
        Self {
            bounds: Arc::new(Mutex::new(Vec::new())),
            last_cursor_inside: Arc::new(Mutex::new(false)),
        }
    }

    pub fn update_bounds(&self, rects: Vec<Rect>) {
        if let Ok(mut guard) = self.bounds.lock() {
            *guard = rects;
        }
    }

    /// Spawns background thread that tracks cursor position and toggles window.set_ignore_cursor_events
    pub fn start_polling(&self, window: WebviewWindow) {
        let bounds_clone = Arc::clone(&self.bounds);
        let last_inside_clone = Arc::clone(&self.last_cursor_inside);

        std::thread::spawn(move || {
            let mut last_rel_x = -999;
            let mut last_rel_y = -999;

            loop {
                std::thread::sleep(Duration::from_millis(80));

                let Ok(win_pos) = window.outer_position() else {
                    continue;
                };

                let scale = window.scale_factor().unwrap_or(1.0);
                let scale = if scale > 0.0 { scale } else { 1.0 };

                let mut pt = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
                unsafe {
                    windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut pt);
                }

                let cur_x = pt.x as f64;
                let cur_y = pt.y as f64;
                let win_x = win_pos.x as f64;
                let win_y = win_pos.y as f64;

                let rel_x = ((cur_x - win_x) / scale).round() as i32;
                let rel_y = ((cur_y - win_y) / scale).round() as i32;

                let is_inside = if let Ok(guard) = bounds_clone.lock() {
                    guard.iter().any(|r| {
                        let rx = r.x * scale;
                        let ry = r.y * scale;
                        let rw = r.width * scale;
                        let rh = r.height * scale;
                        cur_x >= win_x + rx
                            && cur_x <= win_x + rx + rw
                            && cur_y >= win_y + ry
                            && cur_y <= win_y + ry + rh
                    })
                } else {
                    false
                };

                // Toggle click-through when transition happens
                let mut last_inside = last_inside_clone.lock().unwrap();
                if is_inside != *last_inside {
                    *last_inside = is_inside;
                    let _ = window.set_ignore_cursor_events(!is_inside);
                }

                // Emit notch:cursor relative logical coordinates when coordinates change
                if rel_x != last_rel_x || rel_y != last_rel_y {
                    last_rel_x = rel_x;
                    last_rel_y = rel_y;
                    let _ = window.emit("notch:cursor", serde_json::json!({ "x": rel_x, "y": rel_y }));
                }
            }
        });
    }
}
