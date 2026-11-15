use std::time::{Duration, Instant};

pub struct VadConfig {
    pub min_threshold: f32,
    pub silence_duration: Duration,
    pub hard_cap_duration: Duration,
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            min_threshold: 0.0020,
            silence_duration: Duration::from_millis(1200),
            hard_cap_duration: Duration::from_secs(30),
        }
    }
}

pub enum VadState {
    Listening,
    Speaking { _speech_start: Instant, last_speech: Instant },
    Finished(VadFinishReason),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VadFinishReason {
    SilenceTimeout,
    HardCapTimeout,
}

pub struct VoiceActivityDetector {
    config: VadConfig,
    noise_floor: f32,
    state: VadState,
    start_time: Instant,
}

impl VoiceActivityDetector {
    pub fn new(config: VadConfig) -> Self {
        let now = Instant::now();
        Self {
            noise_floor: config.min_threshold,
            config,
            state: VadState::Listening,
            start_time: now,
        }
    }

    pub fn calculate_rms(samples: &[f32]) -> f32 {
        if samples.is_empty() {
            return 0.0;
        }
        let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
        (sum_sq / samples.len() as f32).sqrt()
    }

    pub fn process_chunk(&mut self, samples: &[f32]) -> (f32, bool, Option<VadFinishReason>) {
        let rms = Self::calculate_rms(samples);
        let now = Instant::now();

        if rms < self.noise_floor {
            self.noise_floor = self.noise_floor * 0.95 + rms * 0.05;
        } else {
            self.noise_floor = self.noise_floor * 0.999 + rms * 0.001;
        }

        let threshold = (self.noise_floor * 3.0).max(self.config.min_threshold);
        let is_speech_sample = rms > threshold;

        if now.duration_since(self.start_time) >= self.config.hard_cap_duration {
            self.state = VadState::Finished(VadFinishReason::HardCapTimeout);
            return (rms, false, Some(VadFinishReason::HardCapTimeout));
        }

        match self.state {
            VadState::Listening => {
                if is_speech_sample {
                    self.state = VadState::Speaking {
                        _speech_start: now,
                        last_speech: now,
                    };
                    (rms, true, None)
                } else {
                    (rms, false, None)
                }
            }
            VadState::Speaking { _speech_start, mut last_speech } => {
                if is_speech_sample {
                    last_speech = now;
                    self.state = VadState::Speaking { _speech_start, last_speech };
                    (rms, true, None)
                } else {
                    if now.duration_since(last_speech) >= self.config.silence_duration {
                        self.state = VadState::Finished(VadFinishReason::SilenceTimeout);
                        (rms, false, Some(VadFinishReason::SilenceTimeout))
                    } else {
                        self.state = VadState::Speaking { _speech_start, last_speech };
                        (rms, true, None)
                    }
                }
            }
            VadState::Finished(reason) => (rms, false, Some(reason)),
        }
    }
}
