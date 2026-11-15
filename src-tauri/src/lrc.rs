// Lyrics lookup via LRCLIB (lrclib.net) + LRC parser + in-memory cache.
// Flow: SMTC now-playing -> clean title -> /api/get -> /api/search fallback
// -> duration check -> parsed lines for the UI.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

const ENDPOINT: &str = "https://lrclib.net";
const UA: &str = "DeskNotch/1.0.5 (lyrics)";
const CACHE_CAP: usize = 25;

#[derive(Clone)]
struct CacheState {
    map: HashMap<String, Value>,
    order: Vec<String>,
}

fn cache() -> &'static Mutex<CacheState> {
    static CELL: OnceLock<Mutex<CacheState>> = OnceLock::new();
    CELL.get_or_init(|| {
        Mutex::new(CacheState {
            map: HashMap::new(),
            order: Vec::new(),
        })
    })
}

fn cache_get(key: &str) -> Option<Value> {
    cache().lock().ok()?.map.get(key).cloned()
}

fn cache_put(key: String, val: Value) {
    if let Ok(mut st) = cache().lock() {
        if st.map.contains_key(&key) {
            st.map.insert(key, val);
            return;
        }
        st.map.insert(key.clone(), val);
        st.order.push(key);
        if st.order.len() > CACHE_CAP {
            let old = st.order.remove(0);
            st.map.remove(&old);
        }
    }
}

/// Strip YouTube junk from a raw media title: "(Official Music Video)",
/// "[Lyric Video]", trailing " | ...", trailing HD/4K tokens, quotes.
pub fn clean_title(raw: &str) -> String {
    let mut t = raw.trim().to_string();
    // bracketed junk: paren/bracket/brace blocks mentioning video/lyric/etc
    let junk_words = [
        "official", "video", "lyric", "audio", "mv", "hd", "4k", "visualizer",
        "color coded", "sub", "temps", "m/v", "music video", "performance",
    ];
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for (open, close) in [('{', '}'), ('[', ']'), ('(', ')')] {
        let bytes = t.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == open as u8 {
                if let Some(rel) = t[i + 1..].find(close as char) {
                    let end = i + 1 + rel;
                    let inner = t[i + 1..end].to_lowercase();
                    if junk_words.iter().any(|w| inner.contains(w)) {
                        ranges.push((i, end + 1));
                    }
                    i = end + 2;
                    continue;
                }
            }
            i += 1;
        }
    }
    if !ranges.is_empty() {
        let mut out = String::new();
        let mut last = 0;
        for (a, b) in ranges {
            out.push_str(&t[last..a]);
            last = b.min(t.len());
        }
        out.push_str(&t[last..]);
        t = out;
    }
    // trailing section after a pipe
    if let Some(p) = t.find('|') {
        t.truncate(p);
    }
    // trailing junk tokens outside brackets: "... HD", "... Official"
    loop {
        let trimmed = t.trim().to_lowercase();
        let changed = ["hd", "4k", "official", "video", "lyric", "lyrics", "audio"]
            .iter()
            .any(|w| {
                trimmed.rsplit_once(' ')
                    .map(|(_, last)| last == *w)
                    .unwrap_or(false)
            });
        if changed {
            t = t
                .trim()
                .rsplit_once(' ')
                .map(|(a, _)| a.to_string())
                .unwrap_or(t);
        } else {
            break;
        }
    }
    // quotes + whitespace cleanup
    let t = t.replace(['"', '\u{201c}', '\u{201d}'], "");
    t.split_whitespace().collect::<Vec<_>>().join(" ").trim().to_string()
}

/// "Artist - Song" -> ("Artist", "Song"); otherwise ("", raw).
pub fn split_artist(raw: &str) -> (String, String) {
    let t = raw.trim();
    for sep in [" - ", " – ", " — "] {
        if let Some(p) = t.find(sep) {
            let a = t[..p].trim().to_string();
            let b = t[p + sep.len()..].trim().to_string();
            if !a.is_empty() && !b.is_empty() {
                return (a, b);
            }
        }
    }
    (String::new(), t.to_string())
}

/// Parse LRC text into sorted (t_ms, text) lines.
/// Handles [mm:ss], [mm:ss.xx], [mm:ss.xxx], multi-stamp lines and [offset:].
pub fn parse_lrc(lrc: &str) -> Vec<(u64, String)> {
    let mut offset_ms: i64 = 0;
    for cap in lrc.split('\n') {
        let low = cap.trim().to_lowercase();
        if low.starts_with("[offset:") && low.ends_with(']') {
            offset_ms = low[8..low.len() - 1].trim().parse::<i64>().unwrap_or(0);
            break;
        }
    }

    let mut out: Vec<(u64, String)> = Vec::new();
    for line in lrc.split('\n') {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        let mut stamps: Vec<u64> = Vec::new();
        let mut rest = line;
        loop {
            let trimmed = rest.trim_start();
            if !trimmed.starts_with('[') {
                break;
            }
            let close = match trimmed.find(']') {
                Some(c) => c,
                None => break,
            };
            let tag = &trimmed[1..close];
            let after = &trimmed[close + 1..];
            // metadata tags: ar, ti, al, by, re, ve, tool, length, offset
            let is_meta = tag.len() >= 2
                && tag[..2].chars().all(|c| c.is_ascii_alphabetic())
                && !tag.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(true);
            if is_meta {
                rest = after;
                // keep scanning: a metadata tag line may be followed by nothing
                continue;
            }
            // time tag: mm:ss(.xx/xxx)
            let mut parts = tag.split([':', '.']);
            let mm = parts.next().unwrap_or("");
            let ss = parts.next().unwrap_or("");
            let frac = parts.next().unwrap_or("");
            if mm.trim().parse::<u64>().is_err() || ss.trim().parse::<u64>().is_err() {
                // unknown tag shape -> stop scanning this line
                break;
            }
            let frac_ms = match frac.len() {
                0 => 0,
                1 => frac.parse::<u64>().unwrap_or(0) * 100,
                2 => frac.parse::<u64>().unwrap_or(0) * 10,
                _ => {
                    let f = &frac[..3.min(frac.len())];
                    f.parse::<u64>().unwrap_or(0)
                }
            };
            stamps.push(
                mm.trim().parse::<u64>().unwrap_or(0) * 60_000
                    + ss.trim().parse::<u64>().unwrap_or(0) * 1000
                    + frac_ms,
            );
            rest = after;
        }
        let text = rest.trim().to_string();
        if stamps.is_empty() || text.is_empty() {
            continue;
        }
        for t in stamps {
            let adj = (t as i64 + offset_ms).max(0) as u64;
            out.push((adj, text.clone()));
        }
    }
    out.sort_by_key(|(t, _)| *t);
    out.dedup_by(|a, b| a.0 == b.0 && a.1 == b.1);
    out
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(UA)
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())
}

async fn api_get(cl: &reqwest::Client, artist: &str, track: &str) -> Option<Value> {
    let url = format!(
        "{}/api/get?artist_name={}&track_name={}",
        ENDPOINT,
        urlencode(artist),
        urlencode(track)
    );
    let resp = cl.get(&url).send().await.ok()?;
    if resp.status().as_u16() != 200 {
        return None;
    }
    resp.json::<Value>().await.ok()
}

async fn api_search(cl: &reqwest::Client, q: &str) -> Vec<Value> {
    let url = format!("{}/api/search?q={}", ENDPOINT, urlencode(q));
    let resp = match cl.get(&url).send().await {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    if resp.status().as_u16() != 200 {
        return Vec::new();
    }
    resp.json::<Vec<Value>>().await.unwrap_or_default()
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn j_str(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn j_f64(v: &Value, key: &str) -> f64 {
    v.get(key).and_then(|x| x.as_f64()).unwrap_or(0.0)
}

fn duration_ok(resp: &Value, want: f64) -> bool {
    if want <= 0.0 {
        return true;
    }
    let d = j_f64(resp, "duration");
    d <= 0.0 || (d - want).abs() <= 3.0
}

fn norm_t(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .collect::<String>()
        .to_lowercase()
}

/// LRCLIB /api/get dapat fuzzy-match ke lagu LAIN ("Paper Sky" -> "Paper
/// Planes"). Tolak kandidat yang judulnya tidak saling memuat (dinormalisasi
/// alfanumerik) supaya pengguna tidak melihat lirik lagu yang salah.
fn title_plausible(want: &str, resp: &Value) -> bool {
    let got = j_str(resp, "trackName");
    if got.is_empty() {
        return true;
    }
    let w = norm_t(want);
    let g = norm_t(&got);
    if w.is_empty() || g.is_empty() {
        return true;
    }
    w.contains(&g) || g.contains(&w)
}

fn has_synced(resp: &Value) -> bool {
    !j_str(resp, "syncedLyrics").is_empty()
}

/// Pick the best candidate from a search result list:
/// synced + duration match first, then plain + duration match, then synced.
fn pick_from_search(list: &[Value], want: f64, want_title: &str) -> Option<Value> {
    let plausible = |v: &Value| title_plausible(want_title, v);
    if let Some(v) = list
        .iter()
        .find(|v| has_synced(v) && duration_ok(v, want) && plausible(v))
    {
        return Some(v.clone());
    }
    if let Some(v) = list.iter().find(|v| {
        !j_str(v, "plainLyrics").is_empty() && duration_ok(v, want) && plausible(v)
    }) {
        return Some(v.clone());
    }
    list.iter().find(|v| has_synced(v) && plausible(v)).cloned()
}

fn build_response(resp: &Value, cached: bool) -> Value {
    let synced_raw = j_str(resp, "syncedLyrics");
    let plain = j_str(resp, "plainLyrics");
    let instrumental = resp
        .get("instrumental")
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    let lines: Vec<Value> = parse_lrc(&synced_raw)
        .into_iter()
        .map(|(t, text)| json!({"t": t, "text": text}))
        .collect();
    let status = if instrumental {
        "instrumental"
    } else if !lines.is_empty() {
        "synced"
    } else if !plain.is_empty() {
        "plain"
    } else {
        "not-found"
    };
    json!({
        "ok": true,
        "status": status,
        "lines": lines,
        "plain": if status == "plain" { Value::String(plain) } else { Value::Null },
        "hasWordSync": resp.get("hasWordSync").and_then(|x| x.as_bool()).unwrap_or(false),
        "trackName": j_str(resp, "trackName"),
        "artistName": j_str(resp, "artistName"),
        "duration": j_f64(resp, "duration"),
        "cached": cached,
    })
}

/// Main entry: {"title","artist","album","duration"} -> lyrics state.
pub async fn fetch(req: &Value) -> Value {
    let raw_title = j_str(req, "title");
    if raw_title.trim().is_empty() {
        return json!({"ok": true, "status": "no-track"});
    }
    let mut title = raw_title.trim().to_string();
    let mut artist = j_str(req, "artist").trim().to_string();
    let want_dur = j_f64(req, "duration");

    // Raw SMTC titles from YouTube are often "Artist - Song (Official Video)"
    let cleaned = clean_title(&title);
    if !cleaned.is_empty() && cleaned != title {
        // prefer the cleaned string as the search key; keep the raw one for split fallback
        title = cleaned;
    }
    // SMTC sometimes leaves the artist field empty; the title then carries it
    if artist.is_empty() {
        let (a, t) = split_artist(&title);
        if !a.is_empty() {
            artist = a;
            title = t;
        }
    }

    let cache_key = format!(
        "{}|{}|{}",
        artist.to_lowercase(),
        title.to_lowercase(),
        (want_dur * 10.0).round() as i64 / 10
    );
    if let Some(v) = cache_get(&cache_key) {
        let mut v = v;
        v["cached"] = json!(true);
        return v;
    }

    let cl = match client() {
        Ok(c) => c,
        Err(e) => return json!({"ok": false, "status": "error", "error": e}),
    };

    let mut found: Option<Value> = None;

    // 1) exact get
    if !artist.is_empty() {
        if let Some(j) = api_get(&cl, &artist, &title).await {
            if has_synced(&j) && duration_ok(&j, want_dur) && title_plausible(&title, &j) {
                found = Some(j);
            } else if j.get("instrumental").and_then(|x| x.as_bool()).unwrap_or(false)
                && duration_ok(&j, want_dur)
                && title_plausible(&title, &j)
            {
                found = Some(j);
            }
        }
    }

    // 2) "Artist - Song" inside the title with a different artist field
    if found.is_none() {
        let (a2, t2) = split_artist(&title);
        if !a2.is_empty() && a2 != artist {
            if let Some(j) = api_get(&cl, &a2, &t2).await {
                if (has_synced(&j)
                    || j.get("instrumental").and_then(|x| x.as_bool()).unwrap_or(false))
                    && duration_ok(&j, want_dur)
                    && title_plausible(&t2, &j)
                {
                    found = Some(j);
                }
            }
        }
    }

    // 3) search fallback: "artist track" then just the track
    if found.is_none() {
        if !artist.is_empty() {
            let list = api_search(&cl, &format!("{} {}", artist, title)).await;
            if let Some(j) = pick_from_search(&list, want_dur, &title) {
                found = Some(j);
            }
        }
        if found.is_none() {
            let list = api_search(&cl, &title).await;
            if let Some(j) = pick_from_search(&list, want_dur, &title) {
                found = Some(j);
            }
        }
    }

    // 4) last resort: accept an exact get even when duration mismatches
    if found.is_none() && !artist.is_empty() {
        if let Some(j) = api_get(&cl, &artist, &title).await {
            if has_synced(&j) && title_plausible(&title, &j) {
                found = Some(j);
            }
        }
    }

    match found {
        Some(j) => {
            let resp = build_response(&j, false);
            cache_put(cache_key, resp.clone());
            resp
        }
        None => {
            let resp = json!({"ok": true, "status": "not-found"});
            cache_put(cache_key, resp.clone());
            resp
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_titles() {
        assert_eq!(clean_title("Tulus - Ruang Sendiri (Official Music Video)"), "Tulus - Ruang Sendiri");
        assert_eq!(clean_title("Nadin Amizah - Bertaut [Official Lyric Video]"), "Nadin Amizah - Bertaut");
        assert_eq!(clean_title("Coldplay - Yellow (Official Video) HD"), "Coldplay - Yellow");
        assert_eq!(clean_title("Song | Live Session"), "Song");
    }

    #[test]
    fn splits() {
        let (a, t) = split_artist("Tulus - Ruang Sendiri");
        assert_eq!(a, "Tulus");
        assert_eq!(t, "Ruang Sendiri");
    }

    #[test]
    fn parses_lrc() {
        let lrc = "[ar:X]\n[00:13.24] Baris satu\n[01:02.5] Baris dua\n[00:13.24] Baris satu\n[02:00] Baris tiga";
        let lines = parse_lrc(lrc);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], (13_240, "Baris satu".into()));
        assert_eq!(lines[1], (62_500, "Baris dua".into()));
        assert_eq!(lines[2], (120_000, "Baris tiga".into()));
    }

    #[test]
    fn title_plausibility() {
        let mk = |t: &str| serde_json::json!({"trackName": t});
        assert!(title_plausible("Paper Sky", &mk("Paper Planes")) == false);
        assert!(title_plausible("Yellow", &mk("Yellow (Remastered 2011)")));
        assert!(title_plausible("Coldplay - Yellow", &mk("Yellow")));
        assert!(title_plausible("Bye Bye ft. Ivy Ada", &mk("Bye Bye")));
        assert!(title_plausible("Paper Sky", &mk("")));
    }
}
