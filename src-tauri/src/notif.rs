use rusqlite::{Connection, OpenFlags};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub struct NotificationWatcher {
    running: Arc<AtomicBool>,
}

impl NotificationWatcher {
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
            let local_app_data = std::env::var("LOCALAPPDATA").unwrap_or_default();
            if local_app_data.is_empty() {
                eprintln!("[NotificationWatcher] LOCALAPPDATA environment variable not found");
                return;
            }

            let db_path = PathBuf::from(&local_app_data)
                .join("Microsoft")
                .join("Windows")
                .join("Notifications")
                .join("wpndatabase.db");

            if !db_path.exists() {
                eprintln!("[NotificationWatcher] wpndatabase.db does not exist at {:?}", db_path);
                return;
            }

            eprintln!("[NotificationWatcher] Watching Windows notifications from {:?}", db_path);

            // Everything already in wpndatabase at the first poll is history —
            // it may have piled up while the app was off. Seed all of it so a
            // restart never replays stale banners; only toasts that land
            // between later polls are treated as new.
            let mut seen: Option<HashSet<String>> = None;
            // Nilai ArrivalTime terbesar yang terlihat saat seed. Toast yang
            // ditulis BELAKANGAN tapi ber-stempel LAMA (delayed write) harus
            // tetap dianggap riwayat - bandingkan angka mentahnya, tanpa peduli unit.
            let mut seed_max_at: i64 = 0;

            while running.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(2000));

                let conn = match Connection::open_with_flags(
                    &db_path,
                    OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
                ) {
                    Ok(c) => c,
                    Err(_e) => {
                        // DB may be momentarily locked during write by Windows Push Notification Service
                        continue;
                    }
                };

                // 1. Map NotificationHandler RecordId -> PrimaryId
                let mut handlers: HashMap<i64, String> = HashMap::new();
                if let Ok(mut stmt) = conn.prepare("SELECT RecordId, PrimaryId FROM NotificationHandler") {
                    if let Ok(rows) = stmt.query_map([], |row| {
                        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                    }) {
                        for item in rows.flatten() {
                            handlers.insert(item.0, item.1);
                        }
                    }
                }

                // 2. Query recent toast notifications
                let mut query_stmt = match conn.prepare(
                    "SELECT Id, HandlerId, CAST(ArrivalTime AS TEXT), CAST(Payload AS TEXT) \
                     FROM Notification WHERE Type='toast' ORDER BY ArrivalTime DESC LIMIT 20",
                ) {
                    Ok(s) => s,
                    Err(_) => continue,
                };

                struct RawToast {
                    id: i64,
                    handler_id: i64,
                    at2: String,
                    p2: String,
                }

                let toasts: Vec<RawToast> = match query_stmt.query_map([], |row| {
                    Ok(RawToast {
                        id: row.get::<_, i64>(0)?,
                        handler_id: row.get::<_, i64>(1)?,
                        at2: row.get::<_, String>(2)?,
                        p2: row.get::<_, String>(3)?,
                    })
                }) {
                    Ok(mapped) => mapped.flatten().collect(),
                    Err(_) => continue,
                };

                let current_keys: HashSet<String> = toasts
                    .iter()
                    .map(|t| format!("{}@{}", t.id, t.at2))
                    .collect();

                let mut new_toasts: Vec<&RawToast> = Vec::new();
                match seen.as_mut() {
                    None => {
                        // First poll: seed everything, emit nothing. Remember the
                        // newest ArrivalTime we have ever seen at seed time.
                        for t in &toasts {
                            if let Ok(v) = t.at2.trim().parse::<i64>() {
                                if v > seed_max_at { seed_max_at = v; }
                            }
                        }
                        seen = Some(current_keys);
                    }
                    Some(seen_set) => {
                        for t in &toasts {
                            let key = format!("{}@{}", t.id, t.at2);
                            if !seen_set.contains(&key) {
                                // A delayed write of a toast that existed before
                                // the seed: keep it silent even though the key
                                // was never seen.
                                let stamped = t.at2.trim().parse::<i64>().unwrap_or(0);
                                if stamped == 0 || stamped > seed_max_at {
                                    new_toasts.push(t);
                                }
                            }
                        }
                        *seen_set = current_keys;
                    }
                }

                if new_toasts.is_empty() {
                    continue;
                }

                // Sort oldest to newest so they appear in chronological order
                new_toasts.sort_by(|a, b| a.at2.cmp(&b.at2));

                for t in new_toasts {
                    let handler_app = handlers
                        .get(&t.handler_id)
                        .cloned()
                        .unwrap_or_else(|| format!("handler:{}", t.handler_id));

                    if let Some(payload_json) = parse_toast_xml(&t.p2, t.id, &t.at2, &handler_app) {
                        eprintln!("[NotificationWatcher] Emitting notif:arrived -> {:?}", payload_json.get("title"));
                        let _ = app.emit("notif:arrived", payload_json);
                    }
                }
            }
        });
    }
}

fn parse_toast_xml(xml: &str, id: i64, at: &str, raw_app: &str) -> Option<serde_json::Value> {
    if xml.is_empty() {
        return None;
    }

    let mut text_parts = Vec::new();
    let mut attribution = String::new();
    let mut logo_path = String::new();
    let mut launch_str = String::new();

    // Extract launch="..."
    if let Some(start) = xml.find("launch=\"") {
        let rest = &xml[start + 8..];
        if let Some(end) = rest.find('\"') {
            launch_str = rest[..end].to_string();
        }
    }

    // Extract <text> tags
    let mut search_idx = 0;
    while let Some(open_tag) = xml[search_idx..].find("<text") {
        let tag_start = search_idx + open_tag;
        if let Some(tag_close) = xml[tag_start..].find('>') {
            let full_open = &xml[tag_start..tag_start + tag_close + 1];
            let is_attribution = full_open.contains("placement=\"attribution\"");

            if let Some(content_end) = xml[tag_start + tag_close + 1..].find("</text>") {
                let content_start = tag_start + tag_close + 1;
                let text_val = decode_xml(&xml[content_start..content_start + content_end]);

                if is_attribution {
                    attribution = text_val;
                } else if !text_val.trim().is_empty() {
                    text_parts.push(text_val);
                }
                search_idx = content_start + content_end + 7;
            } else {
                break;
            }
        } else {
            break;
        }
    }

    // Extract <image ... src="..." .../>
    if let Some(img_start) = xml.find("<image") {
        let rest = &xml[img_start..];
        if let Some(src_start) = rest.find("src=\"") {
            let src_rest = &rest[src_start + 5..];
            if let Some(src_end) = src_rest.find('\"') {
                logo_path = src_rest[..src_end].to_string();
            }
        }
    }

    let title = text_parts.get(0).cloned().unwrap_or_default();
    let body = if text_parts.len() > 1 {
        text_parts[1..].join("\n")
    } else {
        String::new()
    };

    if title.is_empty() && body.is_empty() {
        return None;
    }

    // Extract site and chat info from launch
    let mut site = String::new();
    let mut chat = String::new();

    for seg in launch_str.split('|') {
        if seg.starts_with("http://") || seg.starts_with("https://") {
            let clean = seg.trim_start_matches("https://").trim_start_matches("http://");
            let host = clean.split('/').next().unwrap_or("").trim_start_matches("www.");
            if !host.is_empty() {
                site = host.to_string();
            }
        }
        if seg.contains("@g.us") {
            chat = "group".to_string();
        } else if seg.contains("@lid") || seg.contains("n#") {
            chat = "chat".to_string();
        }
    }

    if site.is_empty() && !attribution.is_empty() {
        site = attribution.clone();
    }

    let mut app_label = raw_app.to_string();
    let lower_app = raw_app.to_lowercase();
    if lower_app.contains("chrome") && !site.is_empty() {
        if site.ends_with("whatsapp.com") {
            app_label = "WhatsApp".to_string();
        } else if site.ends_with("discord.com") {
            app_label = "Discord".to_string();
        } else {
            app_label = site.clone();
        }
    } else if lower_app.contains("discord") {
        app_label = "Discord".to_string();
    } else if lower_app.contains("whatsapp") {
        app_label = "WhatsApp".to_string();
    }

    // Extract JID
    let mut jid = String::new();
    for word in launch_str.split(|c: char| !c.is_alphanumeric() && c != '@' && c != '.') {
        if word.contains('@') && word.len() >= 8 {
            jid = word.to_string();
            break;
        }
    }

    Some(serde_json::json!({
        "id": id.to_string(),
        "launch": launch_str,
        "app": app_label,
        "rawApp": raw_app,
        "site": site,
        "chat": chat,
        "title": title,
        "body": body,
        "logo": logo_path,
        "at": at,
        "jid": jid
    }))
}

fn decode_xml(input: &str) -> String {
    input
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .trim()
        .to_string()
}
