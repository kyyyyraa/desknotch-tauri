//! Native STT: the official whisper.cpp CUDA build running as a transient CLI.
//!
//! Each transcription spawns `whisper-cuda/whisper-cli.exe`, which loads the
//! GGML model into the RTX 3050's VRAM, runs inference on the GPU, prints the
//! transcript to stdout and exits. DeskNotch itself never holds the model in
//! its own RAM — idle stays at the app baseline and nothing spikes to 2 GB.

use base64::prelude::*;
use std::path::PathBuf;
use std::time::Instant;

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(|p| p.to_path_buf())
}

fn cli_path() -> Option<PathBuf> {
    let dir = exe_dir()?.join("whisper-cuda");
    // v1.9.x release zips ship the CLI as main.exe; newer ones as whisper-cli.exe
    for name in ["whisper-cli.exe", "main.exe"] {
        let p = dir.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn model_path() -> Option<PathBuf> {
    let dir = exe_dir()?;
    for cand in [
        dir.join("desknotch-models").join("ggml-small.bin"),
        dir.join("whisper-cuda").join("ggml-small.bin"),
    ] {
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

/// True when the CUDA CLI and the GGML model are both present.
pub fn is_available() -> bool {
    cli_path().is_some() && model_path().is_some()
}

fn decode_pcm_b64(pcm_b64: &str) -> Result<Vec<f32>, String> {
    let bytes = BASE64_STANDARD
        .decode(pcm_b64.trim())
        .map_err(|e| format!("pcm decode: {}", e))?;
    let mut samples = Vec::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        samples.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    Ok(samples)
}

/// 16 kHz mono 16-bit PCM WAV, the input format whisper-cli expects.
fn f32_to_wav(samples: &[f32]) -> Vec<u8> {
    let data_len = samples.len() * 2;
    let mut wav = Vec::with_capacity(44 + data_len);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&1u16.to_le_bytes()); // mono
    wav.extend_from_slice(&16000u32.to_le_bytes()); // sample rate
    wav.extend_from_slice(&32000u32.to_le_bytes()); // byte rate
    wav.extend_from_slice(&2u16.to_le_bytes()); // block align
    wav.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(data_len as u32).to_le_bytes());
    for s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        wav.extend_from_slice(&v.to_le_bytes());
    }
    wav
}

fn transcribe_sync(samples: &[f32], lang: &str) -> Result<serde_json::Value, String> {
    if samples.is_empty() {
        return Ok(serde_json::json!({ "text": "", "ms": 0 }));
    }
    let cli = cli_path().ok_or("whisper-cuda/whisper-cli.exe tidak ditemukan")?;
    let model = model_path().ok_or("ggml-small.bin tidak ditemukan")?;
    let t0 = Instant::now();

    let tmp = std::env::temp_dir().join(format!(
        "desknotch-stt-{}-{}.wav",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos() as u64 + d.as_secs() * 1_000_000_000)
            .unwrap_or(0)
    ));
    std::fs::write(&tmp, f32_to_wav(samples)).map_err(|e| format!("wav write: {}", e))?;

    // CREATE_NO_WINDOW: the CLI must stay invisible — a console flashing over
    // the user's screen on every voice command is worse than the latency.
    #[cfg(windows)]
    use std::os::windows::process::CommandExt;
    #[cfg(windows)]
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(&cli);
    cmd.args([
        "-m",
        model.to_string_lossy().as_ref(),
        "-l",
        lang,
        "-nt", // no timestamps: plain text out
        "-np", // no system info banner
        "-f",
        tmp.to_string_lossy().as_ref(),
    ]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output();

    let _ = std::fs::remove_file(&tmp);

    match out {
        Ok(o) => {
            let text = String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(|l| l.trim())
                .filter(|l| !l.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            Ok(serde_json::json!({
                "text": text.trim(),
                "ms": t0.elapsed().as_millis() as u64
            }))
        }
        Err(e) => Err(format!("whisper-cli gagal jalan: {}", e)),
    }
}

/// Transcribes base64-encoded little-endian f32 PCM (16 kHz mono).
pub async fn transcribe_b64(pcm_b64: &str, lang: &str) -> Result<serde_json::Value, String> {
    let samples = decode_pcm_b64(pcm_b64)?;
    let lang = lang.to_string();
    tokio::task::spawn_blocking(move || transcribe_sync(&samples, &lang))
        .await
        .map_err(|e| format!("join: {}", e))?
}
