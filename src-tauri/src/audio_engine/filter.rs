//! Band-pass filtering: 4th-order Butterworth high-pass followed by 4th-order Butterworth
//! low-pass, each built from two cascaded RBJ biquads (transposed direct form II).
//!
//! The high-pass removes rumble, breath and handling noise below the instrument. The
//! low-pass removes the upper partials above the playable range, which is what lets a
//! strongly harmonic reed or brass tone pull the McLeod detector up an octave.

use std::f32::consts::PI;

/// Q values of the two second-order sections of a 4th-order Butterworth filter.
const BUTTERWORTH_Q4: [f32; 2] = [0.541_196_1, 1.306_563];

#[derive(Clone, Copy, Debug, Default)]
pub struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    pub fn high_pass(sample_rate: f32, cutoff_hz: f32, q: f32) -> Self {
        let (cos_w, alpha) = Self::prewarp(sample_rate, cutoff_hz, q);
        let a0 = 1.0 + alpha;
        Self::normalized(
            (1.0 + cos_w) / 2.0,
            -(1.0 + cos_w),
            (1.0 + cos_w) / 2.0,
            a0,
            -2.0 * cos_w,
            1.0 - alpha,
        )
    }

    pub fn low_pass(sample_rate: f32, cutoff_hz: f32, q: f32) -> Self {
        let (cos_w, alpha) = Self::prewarp(sample_rate, cutoff_hz, q);
        let a0 = 1.0 + alpha;
        Self::normalized(
            (1.0 - cos_w) / 2.0,
            1.0 - cos_w,
            (1.0 - cos_w) / 2.0,
            a0,
            -2.0 * cos_w,
            1.0 - alpha,
        )
    }

    fn prewarp(sample_rate: f32, cutoff_hz: f32, q: f32) -> (f32, f32) {
        // Keep the cutoff strictly inside (0, Nyquist) so the coefficients stay stable.
        let nyquist = sample_rate * 0.5;
        let f = cutoff_hz.clamp(1.0, nyquist * 0.95);
        let w0 = 2.0 * PI * f / sample_rate;
        (w0.cos(), w0.sin() / (2.0 * q))
    }

    fn normalized(b0: f32, b1: f32, b2: f32, a0: f32, a1: f32, a2: f32) -> Self {
        Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    #[inline(always)]
    pub fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }

    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }
}

/// 24 dB/octave band-pass: [high-pass x2] -> [low-pass x2].
#[derive(Clone, Debug)]
pub struct BandPass {
    sections: [Biquad; 4],
    low_hz: f32,
    high_hz: f32,
}

impl BandPass {
    pub fn new(sample_rate: f32, low_hz: f32, high_hz: f32) -> Self {
        Self {
            sections: [
                Biquad::high_pass(sample_rate, low_hz, BUTTERWORTH_Q4[0]),
                Biquad::high_pass(sample_rate, low_hz, BUTTERWORTH_Q4[1]),
                Biquad::low_pass(sample_rate, high_hz, BUTTERWORTH_Q4[0]),
                Biquad::low_pass(sample_rate, high_hz, BUTTERWORTH_Q4[1]),
            ],
            low_hz,
            high_hz,
        }
    }

    #[inline(always)]
    pub fn process(&mut self, x: f32) -> f32 {
        let mut y = x;
        for s in &mut self.sections {
            y = s.process(y);
        }
        // Flush denormals so a long silence never makes the filter crawl.
        if y.abs() < 1.0e-20 {
            0.0
        } else {
            y
        }
    }

    pub fn reset(&mut self) {
        self.sections.iter_mut().for_each(Biquad::reset);
    }

    pub fn band(&self) -> (f32, f32) {
        (self.low_hz, self.high_hz)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gain_db(bp: &mut BandPass, sr: f32, freq: f32) -> f32 {
        bp.reset();
        let n = (sr * 0.5) as usize;
        let mut peak = 0.0f32;
        for i in 0..n {
            let x = (2.0 * PI * freq * i as f32 / sr).sin();
            let y = bp.process(x);
            if i > n / 2 {
                peak = peak.max(y.abs());
            }
        }
        20.0 * peak.log10()
    }

    #[test]
    fn passes_band_and_rejects_outside() {
        let sr = 48_000.0;
        let mut bp = BandPass::new(sr, 70.0, 2200.0);
        assert!(gain_db(&mut bp, sr, 440.0).abs() < 0.5);
        assert!(gain_db(&mut bp, sr, 20.0) < -35.0);
        assert!(gain_db(&mut bp, sr, 8000.0) < -40.0);
    }
}
