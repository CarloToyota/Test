//! Amplitude-envelope onset detector, tuned for tonguing.
//!
//! A tongued repeat on a sustained pitch shows no pitch change at all, only a short level
//! dip (the tongue stops the reed or lips for 10-60 ms) followed by a sharp rise. The
//! detector keeps a short history of block levels and reports an onset when the current
//! level has risen `rise_db` above the recent minimum while still climbing.
//!
//! The level is measured over the last 1.5 periods of the instrument's lowest note
//! (at least one hop), so it is phase-independent even for tuba pedal tones.
//!
//! A single rise is reported once (`refractory_ms`), and amplitude vibrato (2-4 dB on
//! sax and flute) stays well below the default 6 dB rise, so it never re-triggers.

use std::collections::VecDeque;

#[derive(Clone, Copy, Debug)]
pub struct OnsetConfig {
    /// Rise above the recent minimum that counts as an attack, dB.
    pub rise_db: f32,
    /// How far back the recent minimum is taken from, ms.
    pub lookback_ms: f32,
    /// Minimum time between two onsets, ms.
    pub refractory_ms: f32,
    /// Onsets below this absolute level are ignored, dBFS.
    pub gate_db: f32,
}

impl Default for OnsetConfig {
    fn default() -> Self {
        Self {
            rise_db: 6.0,
            lookback_ms: 45.0,
            refractory_ms: 60.0,
            gate_db: -50.0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OnsetFrame {
    pub level_db: f32,
    pub onset: bool,
}

pub struct OnsetDetector {
    config: OnsetConfig,
    history: VecDeque<f32>,
    history_len: usize,
    refractory_blocks: usize,
    blocks_since_onset: usize,
    prev_db: f32,
}

const FLOOR_DB: f32 = -120.0;

impl OnsetDetector {
    pub fn new(config: OnsetConfig, sample_rate: u32, block_len: usize) -> Self {
        let block_ms = block_len as f32 * 1000.0 / sample_rate as f32;
        let history_len = ((config.lookback_ms / block_ms).ceil() as usize).max(2);
        let refractory_blocks = ((config.refractory_ms / block_ms).ceil() as usize).max(1);
        Self {
            config,
            history: VecDeque::with_capacity(history_len + 1),
            history_len,
            refractory_blocks,
            blocks_since_onset: usize::MAX / 2,
            prev_db: FLOOR_DB,
        }
    }

    pub fn reset(&mut self) {
        self.history.clear();
        self.blocks_since_onset = usize::MAX / 2;
        self.prev_db = FLOOR_DB;
    }

    /// Feed one hop. `level_window` holds the most recent filtered samples over which
    /// the level is measured. It must span at least one period of the lowest note, or
    /// the RMS rides the waveform's phase and a steady low tone looks like tonguing.
    pub fn process(&mut self, level_window: &[f32]) -> OnsetFrame {
        let mean_sq =
            level_window.iter().map(|x| x * x).sum::<f32>() / level_window.len().max(1) as f32;
        let level_db = (10.0 * (mean_sq + 1e-12).log10()).max(FLOOR_DB);

        let recent_min = self.history.iter().copied().fold(f32::INFINITY, f32::min);
        let rising = level_db > self.prev_db;
        self.blocks_since_onset = self.blocks_since_onset.saturating_add(1);

        let onset = recent_min.is_finite()
            && level_db >= self.config.gate_db
            && rising
            && level_db - recent_min >= self.config.rise_db
            && self.blocks_since_onset >= self.refractory_blocks;

        if onset {
            self.blocks_since_onset = 0;
        }

        self.history.push_back(level_db);
        while self.history.len() > self.history_len {
            self.history.pop_front();
        }
        self.prev_db = level_db;
        OnsetFrame { level_db, onset }
    }
}
