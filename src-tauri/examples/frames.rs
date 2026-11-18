//! Debug view of pitch analysis on a recording: per analysis hop, the level, the
//! detected pitch, and the unbiased NSDF at the detected period and its multiples.
//! `cargo run --release --example frames -- rec.wav altoSax [start_s] [end_s]`

use band_transcriber_lib::audio_engine::filter::BandPass;
use band_transcriber_lib::audio_engine::instrument::hz_to_midi;
use band_transcriber_lib::audio_engine::pitch::{range_hz, PitchAnalyzer, PitchConfig};
use band_transcriber_lib::audio_engine::{wav::decode_wav, Instrument};

fn nsdf(x: &[f32], tau: usize) -> f32 {
    let n = x.len() - tau;
    let (mut a, mut m) = (0.0f32, 0.0f32);
    for i in 0..n {
        a += x[i] * x[i + tau];
        m += x[i] * x[i] + x[i + tau] * x[i + tau];
    }
    if m > 0.0 { 2.0 * a / m } else { 0.0 }
}

/// Power at `f` Hz in a Hann-windowed frame (single-bin DFT).
fn power(x: &[f32], sr: f32, f: f32) -> f32 {
    let n = x.len();
    let (mut re, mut im) = (0.0f32, 0.0f32);
    for (i, &v) in x.iter().enumerate() {
        let w = 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / n as f32).cos();
        let ph = std::f32::consts::TAU * f * i as f32 / sr;
        re += v * w * ph.cos();
        im -= v * w * ph.sin();
    }
    re * re + im * im
}

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let inst: Instrument = serde_json::from_value(serde_json::Value::String(a[1].clone())).unwrap();
    let (s, sr) = decode_wav(&std::fs::read(&a[0]).unwrap()).unwrap();
    let t0: f32 = a.get(2).map(|x| x.parse().unwrap()).unwrap_or(0.0);
    let t1: f32 = a.get(3).map(|x| x.parse().unwrap()).unwrap_or(2.0);
    let (lo, hi) = inst.band_hz();
    let mut bp = BandPass::new(sr as f32, lo, hi);
    let y: Vec<f32> = s.iter().map(|&v| bp.process(v)).collect();
    let w = inst.analysis_window(sr);
    let info = inst.info();
    let (min_hz, max_hz) = range_hz(info.concert_low, info.concert_high);
    let mut pa = PitchAnalyzer::new(sr, w, PitchConfig { peak_pick_k: 0.97, min_clarity: 0.0, gate_db: -70.0, min_hz, max_hz });
    let hop = 512;
    let mut i = (t0 * sr as f32) as usize;
    while i + w < y.len() && (i as f32) < t1 * sr as f32 {
        let win = &y[i..i + w];
        let lvl = 10.0 * (win.iter().map(|v| v * v).sum::<f32>() / w as f32 + 1e-12).log10();
        match pa.analyze(win) {
            Some(p) => {
                let tau = (sr as f32 / p.frequency_hz).round() as usize;
                let half = nsdf(win, tau / 2);
                let one = nsdf(win, tau);
                let two = if 2 * tau < w { nsdf(win, 2 * tau) } else { f32::NAN };
                let f = p.frequency_hz;
                let srf = sr as f32;
                let odd: f32 = [0.5f32, 1.5, 2.5].iter().map(|k| power(win, srf, f * k)).sum();
                let even: f32 = [1.0f32, 2.0, 3.0].iter().map(|k| power(win, srf, f * k)).sum();
                let sub_db = 10.0 * (odd / even.max(1e-12)).log10();
                println!("{:6.3}s {:6.1}dB {:7.1}Hz midi {:5.1} clar {:.3} | n(t/2) {:.3} n(t) {:.3} n(2t) {:.3} | sub {:6.1}dB",
                    (i + w / 2) as f32 / sr as f32, lvl, p.frequency_hz, hz_to_midi(p.frequency_hz), p.clarity, half, one, two, sub_db);
            }
            None => println!("{:6.3}s {:6.1}dB  -", (i + w / 2) as f32 / sr as f32, lvl),
        }
        i += hop;
    }
}
