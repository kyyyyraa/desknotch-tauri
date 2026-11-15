pub mod hotkey;
pub mod mic;
pub mod tts;
pub mod vad;
pub mod whisper;

use hotkey::HotkeyManager;
use mic::MicCapture;
use std::sync::{Arc, Mutex};
use tts::WinRtTts;
use vad::{VadConfig, VoiceActivityDetector};

#[allow(dead_code)]
pub struct VoiceManager {
    pub tts: WinRtTts,
    pub hotkeys: HotkeyManager,
    current_mic: Arc<Mutex<Option<MicCapture>>>,
    audio_buffer: Arc<Mutex<Vec<f32>>>,
}

impl VoiceManager {
    pub fn new() -> Result<Self, String> {
        let tts = WinRtTts::new().map_err(|e| format!("Failed to initialize WinRT TTS: {:?}", e))?;
        let hotkeys = HotkeyManager::new();

        Ok(Self {
            tts,
            hotkeys,
            current_mic: Arc::new(Mutex::new(None)),
            audio_buffer: Arc::new(Mutex::new(Vec::new())),
        })
    }

    pub fn list_voices(&self) -> Vec<serde_json::Value> {
        self.tts.list_voices()
    }

    /// Speaks text using native Microsoft Andika WinRT voice (<50ms startup latency, 0 powershell processes)
    pub fn speak(&self, text: &str) -> Result<u64, String> {
        self.tts.speak(text).map_err(|e| format!("TTS synthesis error: {:?}", e))
    }

    /// Immediately halts speaking (on Escape)
    pub fn stop_speech(&self) {
        self.tts.stop();
    }

    /// Start a PTT recording session (command mode: 1.2s silence; dictate mode: 3.0s silence)
    pub fn start_recording<FLevel, FDone>(
        &self,
        mode: &str,
        mut on_level: FLevel,
        on_done: FDone,
    ) -> Result<(), String>
    where
        FLevel: FnMut(f32) + Send + 'static,
        FDone: FnOnce(Result<String, String>) + Send + 'static,
    {
        self.abort_recording();

        let silence_ms = if mode == "dictate" { 3000 } else { 1200 };
        let hard_cap_s = if mode == "dictate" { 180 } else { 30 };

        let vad_config = VadConfig {
            min_threshold: 0.0020,
            silence_duration: std::time::Duration::from_millis(silence_ms),
            hard_cap_duration: std::time::Duration::from_secs(hard_cap_s),
        };

        let mut detector = VoiceActivityDetector::new(vad_config);
        let buffer = Arc::clone(&self.audio_buffer);
        if let Ok(mut buf) = buffer.lock() {
            buf.clear();
        }

        let done_cell = Arc::new(Mutex::new(Some(on_done)));
        let buffer_clone = Arc::clone(&buffer);

        let capture = MicCapture::start(move |chunk| {
            let (rms, _is_speech, finished) = detector.process_chunk(chunk);
            on_level(rms);

            if let Ok(mut buf) = buffer_clone.lock() {
                buf.extend_from_slice(chunk);
            }

            if let Some(reason) = finished {
                if let Ok(mut done_guard) = done_cell.lock() {
                    if let Some(cb) = done_guard.take() {
                        let samples = buffer_clone.lock().map(|b| b.clone()).unwrap_or_default();
                        eprintln!("[VoiceManager] recording finished: {:?}, samples: {}", reason, samples.len());
                        cb(Ok(format!("Audio recorded: {} samples", samples.len())));
                    }
                }
            }
        })?;

        if let Ok(mut guard) = self.current_mic.lock() {
            *guard = Some(capture);
        }

        Ok(())
    }

    pub fn abort_recording(&self) {
        if let Ok(mut guard) = self.current_mic.lock() {
            if let Some(cap) = guard.take() {
                cap.stop();
            }
        }
        if let Ok(mut buf) = self.audio_buffer.lock() {
            buf.clear();
        }
    }
}
