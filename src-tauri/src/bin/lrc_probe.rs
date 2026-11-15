// Probe offline: test lrc::fetch tanpa menjalankan app.
use desknotch_lib::lrc;
#[tokio::main]
async fn main() {
    let cases = vec![
        serde_json::json!({"title":"Paper Sky","artist":"Lumen Coast","album":"","duration":193.0}),
        serde_json::json!({"title":"Griffin - Bye Bye ft. Ivy Ada","artist":"","album":"","duration":0.0}),
        serde_json::json!({"title":"Tulus - Hati-Hati di Jalan (Official Music Video)","artist":"","album":"","duration":242.0}),
        serde_json::json!({"title":"Kangen","artist":"Dewa 19","album":"","duration":334.0}),
    ];
    for c in cases {
        let r = lrc::fetch(&c).await;
        let status = r.get("status").and_then(|s| s.as_str()).unwrap_or("?");
        let n = r.get("lines").and_then(|l| l.as_array()).map(|a| a.len()).unwrap_or(0);
        let first = r.get("lines").and_then(|l| l.as_array()).and_then(|a| a.first())
            .and_then(|l| l.get("text")).and_then(|t| t.as_str()).unwrap_or("");
        let track = r.get("trackName").and_then(|t| t.as_str()).unwrap_or("-");
        println!("status={} lines={} track='{}' first='{}' req_title='{}'", status, n, track, first,
            c.get("title").and_then(|t| t.as_str()).unwrap_or("?"));
    }
}
