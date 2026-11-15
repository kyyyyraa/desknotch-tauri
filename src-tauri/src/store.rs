use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::Emitter;

#[derive(Clone)]
pub struct StoreManager {
    file_path: PathBuf,
    data: Arc<Mutex<HashMap<String, Value>>>,
}

impl StoreManager {
    pub fn new() -> Self {
        let app_data = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
        let dir = PathBuf::from(app_data).join("DeskNotch");
        let _ = fs::create_dir_all(&dir);
        let file_path = dir.join("desknotch-store.json");

        let mut data = HashMap::new();
        if file_path.exists() {
            if let Ok(content) = fs::read_to_string(&file_path) {
                if let Ok(json_map) = serde_json::from_str::<HashMap<String, Value>>(&content) {
                    data = json_map;
                }
            }
        }

        Self {
            file_path,
            data: Arc::new(Mutex::new(data)),
        }
    }

    pub fn get(&self, key: &str) -> Value {
        let guard = self.data.lock().unwrap();
        guard.get(key).cloned().unwrap_or(Value::Null)
    }

    pub fn set<R: tauri::Runtime>(&self, app: &tauri::AppHandle<R>, key: String, value: Value) -> bool {
        let mut guard = self.data.lock().unwrap();
        let changed = match guard.get(&key) {
            Some(old_val) => old_val != &value,
            None => true,
        };

        if changed {
            guard.insert(key.clone(), value.clone());
            // Save to disk
            if let Ok(json_str) = serde_json::to_string_pretty(&*guard) {
                let _ = fs::write(&self.file_path, json_str);
            }
            // Emit store:changed event with [key, value]
            let _ = app.emit("store:changed", serde_json::json!([key, value]));
        }

        true
    }
}
