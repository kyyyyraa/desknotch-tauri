use std::sync::{Arc, Mutex};
use windows::core::{HSTRING, Interface, Result};
use windows::Media::SpeechSynthesis::SpeechSynthesizer;
use windows::Storage::Streams::{DataReader, IInputStream};
use windows_sys::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_MEMORY, SND_NODEFAULT};

pub struct WinRtTts {
    synthesizer: SpeechSynthesizer,
    current_buffer: Arc<Mutex<Option<Vec<u8>>>>,
}

impl WinRtTts {
    pub fn new() -> Result<Self> {
        let synth = SpeechSynthesizer::new()?;
        
        if let Ok(voices) = SpeechSynthesizer::AllVoices() {
            let count = voices.Size().unwrap_or(0);
            for i in 0..count {
                if let Ok(voice) = voices.GetAt(i) {
                    if let Ok(name) = voice.DisplayName() {
                        let name_str = name.to_string();
                        let is_id = voice.Language().map(|l| l.to_string() == "id-ID").unwrap_or(false);
                        if name_str.contains("Andika") || is_id {
                            let _ = synth.SetVoice(&voice);
                            break;
                        }
                    }
                }
            }
        }
        
        Ok(Self {
            synthesizer: synth,
            current_buffer: Arc::new(Mutex::new(None)),
        })
    }

    pub fn list_voices(&self) -> Vec<serde_json::Value> {
        let mut list = Vec::new();
        if let Ok(voices) = SpeechSynthesizer::AllVoices() {
            let count = voices.Size().unwrap_or(0);
            for i in 0..count {
                if let Ok(v) = voices.GetAt(i) {
                    let id = v.Id().map(|s| s.to_string()).unwrap_or_default();
                    let name = v.DisplayName().map(|s| s.to_string()).unwrap_or_default();
                    let lang = v.Language().map(|s| s.to_string()).unwrap_or_default();
                    list.push(serde_json::json!({
                        "id": id,
                        "name": name,
                        "language": lang
                    }));
                }
            }
        }
        list
    }

    pub fn speak(&self, text: &str) -> Result<u64> {
        let stream = self.synthesizer.SynthesizeTextToStreamAsync(&HSTRING::from(text))?.get()?;
        let size = stream.Size()? as usize;
        let input_stream: IInputStream = stream.cast()?;
        let reader = DataReader::CreateDataReader(&input_stream)?;
        reader.LoadAsync(size as u32)?.get()?;
        let mut buffer = vec![0u8; size];
        reader.ReadBytes(&mut buffer)?;
        
        self.stop();
        
        let mut guard = self.current_buffer.lock().unwrap();
        *guard = Some(buffer);
        
        if let Some(ref buf) = *guard {
            unsafe {
                PlaySoundW(buf.as_ptr() as *const u16, 0 as _, SND_MEMORY | SND_ASYNC | SND_NODEFAULT);
            }
        }
        
        // 16 kHz 16-bit mono WAV header is 44 bytes, 32 bytes/ms
        let duration_ms = if size > 44 {
            ((size - 44) as f64 / 32.0).round() as u64
        } else {
            1000
        };
        
        Ok(duration_ms)
    }

    pub fn stop(&self) {
        unsafe {
            PlaySoundW(std::ptr::null(), 0 as _, 0);
        }
        if let Ok(mut guard) = self.current_buffer.lock() {
            *guard = None;
        }
    }
}

unsafe impl Send for WinRtTts {}
unsafe impl Sync for WinRtTts {}
