//! Tiny append-only log used to trace the voice/PTT chain.
//!
//! The renderer sends its own trace lines over the `dnptt:log` channel; the
//! Rust side adds the hotkey fires and session events. Without a real file the
//! whole chain is invisible, because a GUI build has no console.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

static LOCK: Mutex<()> = Mutex::new(());

fn path() -> Option<PathBuf> {
    let dir = std::env::var("APPDATA").ok()?;
    let d = PathBuf::from(dir).join("DeskNotch");
    std::fs::create_dir_all(&d).ok()?;
    Some(d.join("dnptt.log"))
}

/// Appends one line with a timestamp.
pub fn append(line: &str) {
    let Some(p) = path() else { return };
    let _guard = LOCK.lock();
    let ts = chrono_now();
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{} {}", ts, line);
    }
}

/// A compact ISO-ish timestamp without pulling in a date library.
fn chrono_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Days since epoch -> civil date (Howard Hinnant's algorithm).
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}
