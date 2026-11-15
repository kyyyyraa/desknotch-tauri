use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub struct ScreenshotWatcher {
    running: Arc<AtomicBool>,
}

impl ScreenshotWatcher {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn start(&self, app: AppHandle) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }

        let running = Arc::clone(&self.running);

        std::thread::spawn(move || {
            let user_profile = std::env::var("USERPROFILE").unwrap_or_default();
            let mut watch_dirs = Vec::new();
            if !user_profile.is_empty() {
                let p1 = PathBuf::from(&user_profile).join("Pictures").join("Screenshots");
                if p1.exists() {
                    watch_dirs.push(p1);
                }
            }
            if let Ok(onedrive) = std::env::var("OneDrive") {
                let p2 = PathBuf::from(&onedrive).join("Pictures").join("Screenshots");
                if p2.exists() && !watch_dirs.contains(&p2) {
                    watch_dirs.push(p2);
                }
            }

            if watch_dirs.is_empty() {
                eprintln!("[ScreenshotWatcher] No Screenshots directory found to watch");
                return;
            }

            eprintln!("[ScreenshotWatcher] Watching screenshot directories: {:?}", watch_dirs);

            // Populate initial set of known files so existing screenshots don't trigger immediately
            let mut known_files: HashSet<PathBuf> = HashSet::new();
            for dir in &watch_dirs {
                if let Ok(entries) = std::fs::read_dir(dir) {
                    for entry in entries.flatten() {
                        known_files.insert(entry.path());
                    }
                }
            }

            while running.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(700));

                for dir in &watch_dirs {
                    if let Ok(entries) = std::fs::read_dir(dir) {
                        for entry in entries.flatten() {
                            let path = entry.path();
                            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                            if ext != "png" && ext != "jpg" && ext != "jpeg" {
                                continue;
                            }

                            if !known_files.contains(&path) {
                                // Wait until file write completes (file size stabilizes)
                                if wait_for_file_stable(&path) {
                                    known_files.insert(path.clone());
                                    eprintln!("[ScreenshotWatcher] New screenshot detected: {:?}", path);
                                    let path_str = path.to_string_lossy().to_string();
                                    let _ = app.emit("screenshot:new", path_str);
                                }
                            }
                        }
                    }
                }
            }
        });
    }
}

fn wait_for_file_stable(path: &Path) -> bool {
    let mut last_size = 0u64;
    for _ in 0..15 {
        std::thread::sleep(Duration::from_millis(150));
        if let Ok(meta) = path.metadata() {
            let sz = meta.len();
            if sz > 0 && sz == last_size {
                return true;
            }
            last_size = sz;
        }
    }
    last_size > 0
}
