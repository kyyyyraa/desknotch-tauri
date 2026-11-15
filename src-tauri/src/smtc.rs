use base64::prelude::*;
use serde_json::Value;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use windows::core::Interface;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionMediaProperties,
};
use windows::Storage::Streams::{DataReader, IInputStream};

#[link(name = "ole32")]
extern "system" {
    fn CoInitializeEx(pvReserved: *mut c_void, dwCoInit: u32) -> i32;
}

/// Detect the real image format from magic bytes so album art data URLs
/// always carry a mime the webview can render (webp/gif with a jpeg mime
/// silently fail to display).
fn sniff_mime(buf: &[u8]) -> &'static str {
    if buf.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        "image/png"
    } else if buf.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if buf.starts_with(b"GIF8") {
        "image/gif"
    } else if buf.starts_with(b"BM") {
        "image/bmp"
    } else if buf.len() > 12 && &buf[0..4] == b"RIFF" && &buf[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "image/jpeg"
    }
}

/// Extract album art as a data URL, retrying because the art stream is often
/// not ready at the exact moment a track starts.
fn extract_thumbnail(props: &GlobalSystemMediaTransportControlsSessionMediaProperties) -> Option<String> {
    for attempt in 0..4 {
        let thumb_url = (|| -> Option<String> {
            let thumb_ref = props.Thumbnail().ok()?;
            let stream_op = thumb_ref.OpenReadAsync().ok()?;
            let stream = stream_op.get().ok()?;
            let size = stream.Size().ok()?;
            if size == 0 || size >= 5 * 1024 * 1024 {
                return None;
            }
            let input_stream: IInputStream = stream.cast().ok()?;
            let reader = DataReader::CreateDataReader(&input_stream).ok()?;

            // Load the whole buffer before reading; a partial LoadAsync makes
            // ReadBytes fail and lose the art.
            let mut loaded = 0u32;
            for _ in 0..10 {
                loaded = reader.LoadAsync(size as u32).and_then(|op| op.get()).ok()?;
                if loaded as u64 >= size {
                    break;
                }
            }
            if (loaded as u64) < size {
                return None;
            }

            let mut buf = vec![0u8; size as usize];
            reader.ReadBytes(&mut buf).ok()?;
            Some(format!(
                "data:{};base64,{}",
                sniff_mime(&buf),
                BASE64_STANDARD.encode(&buf)
            ))
        })();

        if thumb_url.is_some() {
            return thumb_url;
        }
        if attempt < 3 {
            std::thread::sleep(Duration::from_millis(200 + attempt * 150));
        }
    }
    None
}

pub struct SmtcWatcher {
    running: Arc<AtomicBool>,
}

impl SmtcWatcher {
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
        // Clone before the first spawn: the watcher thread moves `app`.
        let app_pos = app.clone();

        std::thread::spawn(move || {
            unsafe {
                let _ = CoInitializeEx(std::ptr::null_mut(), 0); // COINIT_MULTITHREADED
            }

            let mut last_sig = String::new();
            let mut art_pending = false;
            let mut art_tries = 0u32;

            while running.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(1200));

                let info_opt = get_current_session_info();
                let current_sig = match &info_opt {
                    Some(v) => format!(
                        "{}_{}_{}_{}_{}",
                        v.get("title").and_then(|s| s.as_str()).unwrap_or(""),
                        v.get("artist").and_then(|s| s.as_str()).unwrap_or(""),
                        v.get("isPlaying").and_then(|b| b.as_bool()).unwrap_or(false),
                        v.get("sourceAppId").and_then(|s| s.as_str()).unwrap_or(""),
                        v.get("duration").and_then(|n| n.as_f64()).unwrap_or(0.0)
                    ),
                    None => String::new(),
                };

                let has_art = info_opt
                    .as_ref()
                    .and_then(|v| v.get("thumbnailUrl"))
                    .map(|t| !t.is_null())
                    .unwrap_or(false);

                if current_sig != last_sig {
                    last_sig = current_sig;
                    // Art stream often lags the track change: keep retrying on
                    // the following polls until it shows up.
                    art_pending = !has_art;
                    art_tries = 0;
                    let payload = info_opt.unwrap_or(Value::Null);
                    let _ = app.emit("smtc:now-playing", payload);
                } else if art_pending && art_tries < 15 {
                    art_tries += 1;
                    if has_art {
                        art_pending = false;
                        if let Some(v) = info_opt {
                            let _ = app.emit("smtc:now-playing", v);
                        }
                    }
                }
            }
        });

        // Lightweight position ticker for synced lyrics: timeline reads only,
        // 500 ms cadence. The renderer interpolates between ticks.
        // NOTE: the manager must be re-requested EVERY tick — one cached at
        // boot keeps returning a stale/frozen session, which made lyrics and
        // the timer only move on pause/play.
        let running_pos = Arc::clone(&self.running);
        std::thread::spawn(move || {
            unsafe {
                let _ = CoInitializeEx(std::ptr::null_mut(), 0);
            }
            while running_pos.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(500));
                let Ok(op) = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
                else {
                    continue;
                };
                let Ok(manager) = op.get() else { continue };
                if let Some(p) = read_position_once(&manager) {
                    let _ = app_pos.emit("smtc:position", p);
                }
            }
        });
    }
}

pub fn get_current_session_info() -> Option<Value> {
    unsafe {
        let _ = CoInitializeEx(std::ptr::null_mut(), 0);
    }
    let manager_op = GlobalSystemMediaTransportControlsSessionManager::RequestAsync().ok()?;
    let manager = manager_op.get().ok()?;

    let session = match manager.GetCurrentSession() {
        Ok(s) => s,
        Err(_) => {
            let sessions = manager.GetSessions().ok()?;
            let count = sessions.Size().ok()?;
            if count == 0 {
                return None;
            }
            let mut picked = None;
            for i in 0..count {
                if let Ok(s) = sessions.GetAt(i) {
                    if let Ok(pb) = s.GetPlaybackInfo() {
                        if pb.PlaybackStatus().map(|st| st.0 == 4).unwrap_or(false) {
                            picked = Some(s);
                            break;
                        }
                    }
                    if picked.is_none() {
                        picked = Some(s);
                    }
                }
            }
            picked?
        }
    };

    let app_id = session
        .SourceAppUserModelId()
        .map(|h| h.to_string())
        .unwrap_or_default();

    let props_op = session.TryGetMediaPropertiesAsync().ok()?;
    let props = props_op.get().ok()?;

    let title = props.Title().map(|h| h.to_string()).unwrap_or_default();
    let artist = props.Artist().map(|h| h.to_string()).unwrap_or_default();
    let album = props.AlbumTitle().map(|h| h.to_string()).unwrap_or_default();

    let playback = session.GetPlaybackInfo().ok();
    // 4 is Playing status
    let is_playing = playback
        .as_ref()
        .and_then(|p| p.PlaybackStatus().ok())
        .map(|s| s.0 == 4)
        .unwrap_or(false);

    let timeline = session.GetTimelineProperties().ok();
    let position = timeline
        .as_ref()
        .and_then(|t| t.Position().ok())
        .map(|ts| ts.Duration as f64 / 10_000_000.0)
        .unwrap_or(0.0);
    // Duration is the track length, so it must be EndTime - StartTime.
    // EndTime alone is an absolute offset and is wrong for tracks that do not
    // start at zero.
    let duration = match (
        timeline.as_ref().and_then(|t| t.StartTime().ok()),
        timeline.as_ref().and_then(|t| t.EndTime().ok()),
    ) {
        (Some(start), Some(end)) => {
            let span = end.Duration as i64 - start.Duration as i64;
            if span > 0 {
                span as f64 / 10_000_000.0
            } else {
                0.0
            }
        }
        _ => 0.0,
    };

    let thumbnail_url: Option<String> = extract_thumbnail(&props);

    if title.is_empty() && artist.is_empty() && !is_playing {
        return None;
    }

    Some(serde_json::json!({
        "sourceAppId": app_id,
        "title": title,
        "artist": artist,
        "album": album,
        "isPlaying": is_playing,
        "position": position,
        "duration": duration,
        "thumbnailUrl": thumbnail_url
    }))
}

/// Read ONLY the timeline + playback status (no media properties, no art) —
/// cheap enough for the 500 ms lyric ticker.
/// Session choice mirrors get_current_session_info: prefer the session that
/// is actually PLAYING, so a leftover paused session cannot freeze position.
pub fn read_position_once(
    manager: &GlobalSystemMediaTransportControlsSessionManager,
) -> Option<Value> {
    let status_of = |s: &windows::Media::Control::GlobalSystemMediaTransportControlsSession| {
        s.GetPlaybackInfo()
            .ok()
            .and_then(|p| p.PlaybackStatus().ok())
            .map(|st| st.0 == 4)
            .unwrap_or(false)
    };
    let mut session = manager.GetCurrentSession().ok();
    if session.as_ref().map(|s| !status_of(s)).unwrap_or(true) {
        // current is missing or paused — scan for a playing session
        if let Ok(sessions) = manager.GetSessions() {
            if let Ok(count) = sessions.Size() {
                for i in 0..count {
                    if let Ok(s) = sessions.GetAt(i) {
                        if status_of(&s) {
                            session = Some(s);
                            break;
                        }
                    }
                }
            }
        }
    }
    let session = session?;
    let timeline = session.GetTimelineProperties().ok()?;
    let pos = timeline
        .Position()
        .ok()
        .map(|ts| ts.Duration as f64 / 10_000_000.0)
        .unwrap_or(0.0);
    let playing = status_of(&session);
    Some(serde_json::json!({
        "pos_ms": (pos * 1000.0) as u64,
        "playing": playing
    }))
}

/// Seek aktif SMTC ke timestamp tertentu (untuk klik baris lirik / tombol
/// ±10s). windows 0.58 tidak punya TryChangeTimelinePositionAsync, jadi
/// panggilan ini lewat crate windows61 yang hanya berisi API itu.
pub fn try_seek(pos_secs: f64) -> bool {
    use windows61::Media::Control::GlobalSystemMediaTransportControlsSessionManager;
    unsafe {
        let _ = CoInitializeEx(std::ptr::null_mut(), 0);
    }
    let Ok(manager_op) = GlobalSystemMediaTransportControlsSessionManager::RequestAsync() else {
        return false;
    };
    let Ok(manager) = manager_op.get() else { return false };
    let Ok(session) = manager.GetCurrentSession() else { return false };
    let ts = (pos_secs * 10_000_000.0) as i64;
    session
        .TryChangePlaybackPositionAsync(ts)
        .ok()
        .and_then(|op| op.get().ok())
        .unwrap_or(false)
}

pub fn send_media_key(action: &str) -> bool {
    unsafe {
        let _ = CoInitializeEx(std::ptr::null_mut(), 0);
    }
    let Ok(manager_op) = GlobalSystemMediaTransportControlsSessionManager::RequestAsync() else {
        return false;
    };
    let Ok(manager) = manager_op.get() else {
        return false;
    };
    let session = match manager.GetCurrentSession() {
        Ok(s) => s,
        Err(_) => {
            let Ok(sessions) = manager.GetSessions() else { return false; };
            let Ok(count) = sessions.Size() else { return false; };
            if count == 0 { return false; }
            let Ok(s) = sessions.GetAt(0) else { return false; };
            s
        }
    };

    match action {
        "play-pause" => session.TryTogglePlayPauseAsync().ok().and_then(|op| op.get().ok()).unwrap_or(false),
        "next" => session.TrySkipNextAsync().ok().and_then(|op| op.get().ok()).unwrap_or(false),
        "previous" => session.TrySkipPreviousAsync().ok().and_then(|op| op.get().ok()).unwrap_or(false),
        _ => false,
    }
}

