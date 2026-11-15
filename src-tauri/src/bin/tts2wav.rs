//! Dev utility: synth text to a WAV file with the same WinRT voice the app
//! uses (Microsoft Andika / id-ID). Usage:
//!   tts2wav.exe "teks" output.wav

use std::ffi::c_void;
use windows::core::Interface;

#[link(name = "ole32")]
extern "system" {
    fn CoInitializeEx(pvReserved: *mut c_void, dwCoInit: u32) -> i32;
}

fn main() {
    unsafe {
        CoInitializeEx(std::ptr::null_mut(), 0);
    }
    let args: Vec<String> = std::env::args().collect();
    let text = args.get(1).cloned().unwrap_or_else(|| "tes suara".into());
    let out = args.get(2).cloned().unwrap_or_else(|| "test-id.wav".into());

    let synth = windows::Media::SpeechSynthesis::SpeechSynthesizer::new().expect("synth");
    if let Ok(voices) = windows::Media::SpeechSynthesis::SpeechSynthesizer::AllVoices() {
        let count = voices.Size().unwrap_or(0);
        for i in 0..count {
            if let Ok(v) = voices.GetAt(i) {
                let is_id = v.Language().map(|l| l.to_string() == "id-ID").unwrap_or(false);
                let is_andika = v.DisplayName().map(|n| n.to_string().contains("Andika")).unwrap_or(false);
                if is_andika || is_id {
                    let _ = synth.SetVoice(&v);
                    break;
                }
            }
        }
    }

    let stream = synth
        .SynthesizeTextToStreamAsync(&windows::core::HSTRING::from(text.as_str()))
        .expect("synth async")
        .get()
        .expect("synth get");
    let size = stream.Size().expect("size") as usize;
    let input: windows::Storage::Streams::IInputStream = stream.cast().expect("cast");
    let reader = windows::Storage::Streams::DataReader::CreateDataReader(&input).expect("reader");
    reader
        .LoadAsync(size as u32)
        .expect("load async")
        .get()
        .expect("load get");
    let mut buf = vec![0u8; size];
    reader.ReadBytes(&mut buf).expect("read");
    std::fs::write(&out, &buf).expect("write");
    println!("saved {} bytes -> {}", size, out);
}
