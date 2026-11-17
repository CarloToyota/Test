//! McLeod Pitch Method with band-instrument octave-error protection.
//!
//! The `pitch-detection` crate (0.3) finds the candidate period. Two properties of
//! its output shape how it is used here:
//!
//! 1. Its `clarity_threshold` argument is an absolute bar the *first* NSDF peak must
//!    clear. It is not MPM's "first peak within k x highest peak" rule.
//! 2. Its NSDF is biased by lag: a perfect sine reads about `1 - lag/window`. A 220 Hz
//!    tone in a 2048-sample window peaks at 0.89; a low tuba note can never reach 0.85.
//!
//! So the crate runs with a permissive `CANDIDATE_THRESHOLD`, and its answer is then
//! re-scored with the textbook (unbiased) McLeod NSDF
//!
//! ```text
//! n'(tau) = 2 * sum x[i] x[i+tau] / sum (x[i]^2 + x[i+tau]^2),   i < W - tau
//! ```
//!
//! at the detected period and at 2x, 3x and 4x it. MPM's own key-maximum rule then
//! picks the *shortest* candidate period scoring at least `peak_pick_k` times the best.
//! This is what corrects a strong 2nd or 3rd harmonic dragging the estimate an octave
//! or a twelfth up, the classic sax, clarinet and low-brass failure. The chosen
//! period's unbiased NSDF value is the clarity gated against `min_clarity` (0.85).

use pitch_detection::detector::mcleod::McLeodDetector;
use pitch_detection::detector::PitchDetector;

use super::instrument::{hz_to_midi, midi_to_hz};

/// Absolute threshold handed to the crate for candidate peaks (see module docs).
const CANDIDATE_THRESHOLD: f32 = 0.45;
/// Highest sub-multiple of the detected frequency tried during octave correction.
const MAX_PERIOD_MULTIPLE: usize = 4;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PitchFrame {
    pub frequency_hz: f32,
    /// Fractional MIDI note (69.0 = A4 = 440 Hz).
    pub midi: f32,
    /// Unbiased McLeod clarity at the chosen period, 0..1.
    pub clarity: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct PitchConfig {
    /// MPM key-maximum constant *k* for octave correction.
    pub peak_pick_k: f32,
    /// Minimum unbiased clarity for a frame to count as pitched.
    pub min_clarity: f32,
    /// Frames whose mean-square level is below this (dBFS) are not analysed at all.
    pub gate_db: f32,
    /// Accepted fundamental range, Hz.
    pub min_hz: f32,
    pub max_hz: f32,
}

pub struct PitchAnalyzer {
    // `McLeodDetector` holds `Rc` buffers, so it is `!Send`. The engine is built on the
    // thread that runs it.
    detector: McLeodDetector<f32>,
    window: usize,
    sample_rate: usize,
    power_threshold: f32,
    config: PitchConfig,
}

/// Unbiased McLeod normalized square difference at integer lag `tau`.
fn nsdf_at(x: &[f32], tau: usize) -> f32 {
    if tau == 0 || tau >= x.len() {
        return 0.0;
    }
    let n = x.len() - tau;
    let (mut acf, mut m) = (0.0f32, 0.0f32);
    for i in 0..n {
        let (a, b) = (x[i], x[i + tau]);
        acf += a * b;
        m += a * a + b * b;
    }
    if m <= f32::EPSILON {
        0.0
    } else {
        2.0 * acf / m
    }
}

/// Unbiased NSDF peak near the fractional lag `tau`: the best of the surrounding
/// integer lags, refined with a parabola. Returns `(lag, value)`.
fn nsdf_peak_near(x: &[f32], tau: f32) -> (f32, f32) {
    let centre = tau.round() as isize;
    let mut best = (tau, f32::MIN);
    for d in -2..=2isize {
        let t = centre + d;
        if t < 2 || t as usize + 1 >= x.len() / 2 + x.len() / 4 {
            continue;
        }
        let t = t as usize;
        let (y0, y1, y2) = (nsdf_at(x, t - 1), nsdf_at(x, t), nsdf_at(x, t + 1));
        if y1 >= y0 && y1 >= y2 {
            let denom = y0 - 2.0 * y1 + y2;
            let (dx, peak) = if denom.abs() > 1e-9 {
                let dx = 0.5 * (y0 - y2) / denom;
                (dx, y1 - 0.25 * (y0 - y2) * dx)
            } else {
                (0.0, y1)
            };
            if peak > best.1 {
                best = (t as f32 + dx, peak);
            }
        } else if y1 > best.1 {
            best = (t as f32, y1);
        }
    }
    best
}

impl PitchAnalyzer {
    pub fn new(sample_rate: u32, window: usize, config: PitchConfig) -> Self {
        // The crate's `square_sum` is a plain sum of squares, so scale the dBFS gate by
        // the window length.
        let mean_square_gate = 10f32.powf(config.gate_db / 10.0);
        Self {
            detector: McLeodDetector::new(window, window / 2),
            window,
            sample_rate: sample_rate as usize,
            power_threshold: mean_square_gate * window as f32,
            config,
        }
    }

    pub fn window(&self) -> usize {
        self.window
    }

    /// Analyse exactly `window` samples, oldest first.
    pub fn analyze(&mut self, samples: &[f32]) -> Option<PitchFrame> {
        debug_assert_eq!(samples.len(), self.window);
        let raw = self.detector.get_pitch(
            samples,
            self.sample_rate,
            self.power_threshold,
            CANDIDATE_THRESHOLD,
        )?;
        if !raw.frequency.is_finite() || raw.frequency <= 0.0 {
            return None;
        }

        let sr = self.sample_rate as f32;
        let base_lag = sr / raw.frequency;
        // Periods of interest are at most half the window, so at least two cycles fit.
        let max_lag = (self.window / 2) as f32;
        let min_lag = sr / self.config.max_hz;
        let longest_lag = (sr / self.config.min_hz).min(max_lag);

        // Score the period candidates tau, 2tau, 3tau, 4tau with the unbiased NSDF.
        let mut candidates = [(0.0f32, f32::MIN); MAX_PERIOD_MULTIPLE];
        let mut best = f32::MIN;
        for (m, slot) in candidates.iter_mut().enumerate() {
            let lag = base_lag * (m + 1) as f32;
            if lag > longest_lag + 1.0 {
                break;
            }
            *slot = nsdf_peak_near(samples, lag);
            best = best.max(slot.1);
        }
        if best <= 0.0 {
            return None;
        }

        // MPM key-maximum rule: the shortest period within k of the best one, among
        // periods inside the instrument's range.
        let threshold = self.config.peak_pick_k * best;
        let (lag, clarity) = candidates
            .iter()
            .copied()
            .filter(|&(lag, v)| v != f32::MIN && lag >= min_lag * 0.97)
            .find(|&(_, v)| v >= threshold)?;

        if clarity < self.config.min_clarity {
            return None;
        }
        let f = sr / lag;
        if f < self.config.min_hz || f > self.config.max_hz {
            return None;
        }
        Some(PitchFrame {
            frequency_hz: f,
            midi: hz_to_midi(f),
            clarity: clarity.min(1.0),
        })
    }
}

/// Accepted fundamental range for a concert MIDI range, with a semitone of headroom
/// each side for intonation and bends.
pub fn range_hz(concert_low: u8, concert_high: u8) -> (f32, f32) {
    (
        midi_to_hz(concert_low as f32 - 1.0),
        midi_to_hz(concert_high as f32 + 1.0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f32::consts::TAU;

    const SR: u32 = 48_000;

    fn analyzer(window: usize) -> PitchAnalyzer {
        PitchAnalyzer::new(
            SR,
            window,
            PitchConfig {
                peak_pick_k: 0.90,
                min_clarity: 0.85,
                gate_db: -60.0,
                min_hz: 30.0,
                max_hz: 2400.0,
            },
        )
    }

    fn tone(f: f32, partials: &[(f32, f32)], n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| {
                let t = i as f32 / SR as f32;
                partials.iter().map(|(h, a)| a * (TAU * f * h * t).sin()).sum::<f32>() * 0.2
            })
            .collect()
    }

    #[test]
    fn pure_sine_has_full_clarity() {
        let p = analyzer(2048).analyze(&tone(220.0, &[(1.0, 1.0)], 2048)).unwrap();
        assert!((p.frequency_hz - 220.0).abs() < 0.5, "{p:?}");
        assert!(p.clarity > 0.97, "{p:?}");
    }

    #[test]
    fn strong_second_harmonic_is_not_an_octave_up() {
        // Fundamental 9 dB below the 2nd harmonic, like a low clarinet or bari sax.
        let x = tone(110.0, &[(1.0, 0.35), (2.0, 1.0), (3.0, 0.5), (4.0, 0.3)], 2048);
        let p = analyzer(2048).analyze(&x).unwrap();
        assert!((p.frequency_hz - 110.0).abs() < 1.0, "{p:?}");
    }

    #[test]
    fn strong_third_harmonic_is_not_a_twelfth_up() {
        let x = tone(98.0, &[(1.0, 0.3), (2.0, 0.4), (3.0, 1.0)], 4096);
        let p = analyzer(4096).analyze(&x).unwrap();
        assert!((p.frequency_hz - 98.0).abs() < 1.0, "{p:?}");
    }

    #[test]
    fn low_tuba_note_passes_clarity_gate() {
        let x = tone(43.65, &[(1.0, 1.0), (2.0, 0.7), (3.0, 0.4)], 4096);
        let p = analyzer(4096).analyze(&x).unwrap();
        assert!((p.frequency_hz - 43.65).abs() < 0.5, "{p:?}");
        assert!(p.clarity > 0.9);
    }

    #[test]
    fn noise_is_unpitched() {
        let mut s = 1u32;
        let x: Vec<f32> = (0..2048)
            .map(|_| {
                s = s.wrapping_mul(1664525).wrapping_add(1013904223);
                ((s >> 8) as f32 / (1u32 << 24) as f32 - 0.5) * 0.5
            })
            .collect();
        assert!(analyzer(2048).analyze(&x).is_none());
    }
}
