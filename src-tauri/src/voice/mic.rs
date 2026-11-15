use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream};

pub struct MicCapture {
    _stream: Stream,
    is_recording: Arc<AtomicBool>,
}

impl MicCapture {
    pub fn start<F>(callback: F) -> Result<Self, String>
    where
        F: FnMut(&[f32]) + Send + 'static,
    {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| "No default audio input device found".to_string())?;

        let config = device
            .default_input_config()
            .map_err(|e| format!("Failed to get default input config: {}", e))?;

        let sample_rate = config.sample_rate().0;
        let channels = config.channels() as usize;
        let is_recording = Arc::new(AtomicBool::new(true));
        let is_recording_clone = Arc::clone(&is_recording);

        let callback_mutex = Arc::new(Mutex::new(callback));
        let cb = Arc::clone(&callback_mutex);

        let err_fn = |err| eprintln!("[MicCapture] audio stream error: {}", err);

        let stream = match config.sample_format() {
            SampleFormat::F32 => device.build_input_stream(
                &config.into(),
                move |data: &[f32], _| {
                    if !is_recording_clone.load(Ordering::Relaxed) {
                        return;
                    }
                    let mono_16k = resample_to_16k(data, channels, sample_rate);
                    if let Ok(mut cb_guard) = cb.lock() {
                        cb_guard(&mono_16k);
                    }
                },
                err_fn,
                None,
            ),
            SampleFormat::I16 => device.build_input_stream(
                &config.into(),
                move |data: &[i16], _| {
                    if !is_recording_clone.load(Ordering::Relaxed) {
                        return;
                    }
                    let f32_data: Vec<f32> = data.iter().map(|&s| s as f32 / i16::MAX as f32).collect();
                    let mono_16k = resample_to_16k(&f32_data, channels, sample_rate);
                    if let Ok(mut cb_guard) = cb.lock() {
                        cb_guard(&mono_16k);
                    }
                },
                err_fn,
                None,
            ),
            SampleFormat::U16 => device.build_input_stream(
                &config.into(),
                move |data: &[u16], _| {
                    if !is_recording_clone.load(Ordering::Relaxed) {
                        return;
                    }
                    let f32_data: Vec<f32> = data.iter().map(|&s| (s as f32 - 32768.0) / 32768.0).collect();
                    let mono_16k = resample_to_16k(&f32_data, channels, sample_rate);
                    if let Ok(mut cb_guard) = cb.lock() {
                        cb_guard(&mono_16k);
                    }
                },
                err_fn,
                None,
            ),
            f => return Err(format!("Unsupported sample format: {:?}", f)),
        }
        .map_err(|e| format!("Failed to build input stream: {}", e))?;

        stream
            .play()
            .map_err(|e| format!("Failed to play input stream: {}", e))?;

        Ok(Self {
            _stream: stream,
            is_recording,
        })
    }

    pub fn stop(&self) {
        self.is_recording.store(false, Ordering::Relaxed);
    }
}

fn resample_to_16k(input: &[f32], channels: usize, in_rate: u32) -> Vec<f32> {
    if input.is_empty() {
        return Vec::new();
    }
    let mono: Vec<f32> = if channels > 1 {
        input
            .chunks_exact(channels)
            .map(|frame| frame.iter().sum::<f32>() / channels as f32)
            .collect()
    } else {
        input.to_vec()
    };

    if in_rate == 16000 {
        return mono;
    }

    let ratio = in_rate as f64 / 16000.0;
    let out_len = (mono.len() as f64 / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);

    for i in 0..out_len {
        let src_idx = i as f64 * ratio;
        let idx0 = src_idx.floor() as usize;
        let idx1 = (idx0 + 1).min(mono.len() - 1);
        let frac = (src_idx - idx0 as f64) as f32;
        let s0 = mono[idx0];
        let s1 = mono[idx1];
        out.push(s0 + frac * (s1 - s0));
    }

    out
}

unsafe impl Send for MicCapture {}
unsafe impl Sync for MicCapture {}
