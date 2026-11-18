//! `BandEngine`: the complete sample-in / events-out pipeline. It is pure, allocation-free
//! after construction (apart from the event names it formats) and has no I/O.

use super::filter::BandPass;
use super::instrument::{midi_to_hz, note_name, Instrument};
use super::onset::{OnsetConfig, OnsetDetector};
use super::pitch::{range_hz, PitchAnalyzer, PitchConfig, PitchFrame};
use super::tracker::{NoteTracker, TrackerConfig, TrackerEvent, TrackerEventKind};
use super::types::{EngineOutput, EngineStatus, NoteEvent, NoteEventKind};

#[derive(Clone, Copy, Debug)]
pub struct EngineConfig {
    /// MPM key-maximum selection constant *k* (see `pitch.rs`).
    pub peak_pick_k: f32,
    /// Minimum McLeod clarity for a frame to count as pitched.
    pub min_clarity: f32,
    /// Level gate for pitch analysis, dBFS (mean square of the filtered window).
    pub gate_db: f32,
    /// Analysis hop in samples. 256 at 48 kHz is 5.3 ms.
    pub hop: usize,
    /// Interval between `EngineStatus` outputs.
    pub status_interval_ms: f64,
    pub onset: OnsetConfig,
    pub tracker: TrackerConfig,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            peak_pick_k: 0.97,
            min_clarity: 0.85,
            gate_db: -55.0,
            hop: 256,
            status_interval_ms: 50.0,
            onset: OnsetConfig::default(),
            tracker: TrackerConfig::default(),
        }
    }
}

pub struct BandEngine {
    sample_rate: u32,
    cfg: EngineConfig,
    instrument: Instrument,
    filter: BandPass,
    pitch: PitchAnalyzer,
    onset: OnsetDetector,
    tracker: NoteTracker,
    /// Circular buffer of the last `window` filtered samples.
    ring: Vec<f32>,
    ring_pos: usize,
    ring_filled: usize,
    /// Scratch copy of the ring in chronological order, for the detector.
    window_buf: Vec<f32>,
    hop_fill: usize,
    /// Samples over which the onset detector measures level (>= 1.5 low-note periods).
    level_len: usize,
    samples_seen: u64,
    tracker_events: Vec<TrackerEvent>,
    last_status_ms: f64,
    last_level_db: f32,
    last_pitch: Option<PitchFrame>,
}

impl BandEngine {
    pub fn new(sample_rate: u32, instrument: Instrument) -> Self {
        Self::with_config(sample_rate, instrument, EngineConfig::default())
    }

    pub fn with_config(sample_rate: u32, instrument: Instrument, cfg: EngineConfig) -> Self {
        let hop_ms = cfg.hop as f64 * 1000.0 / sample_rate as f64;
        let (filter, pitch) = Self::build_instrument_dsp(sample_rate, instrument, &cfg);
        let window = pitch.window();
        Self {
            sample_rate,
            instrument,
            filter,
            onset: OnsetDetector::new(cfg.onset, sample_rate, cfg.hop),
            tracker: NoteTracker::new(cfg.tracker, hop_ms),
            ring: vec![0.0; window],
            ring_pos: 0,
            ring_filled: 0,
            window_buf: vec![0.0; window],
            hop_fill: 0,
            level_len: Self::level_len(sample_rate, instrument, cfg.hop, window),
            samples_seen: 0,
            tracker_events: Vec::with_capacity(8),
            last_status_ms: f64::NEG_INFINITY,
            last_level_db: -120.0,
            last_pitch: None,
            pitch,
            cfg,
        }
    }

    fn build_instrument_dsp(
        sample_rate: u32,
        instrument: Instrument,
        cfg: &EngineConfig,
    ) -> (BandPass, PitchAnalyzer) {
        let (low_hz, high_hz) = instrument.band_hz();
        let info = instrument.info();
        let (min_hz, max_hz) = range_hz(info.concert_low, info.concert_high);
        let window = instrument.analysis_window(sample_rate);
        let filter = BandPass::new(sample_rate as f32, low_hz, high_hz);
        let pitch = PitchAnalyzer::new(
            sample_rate,
            window,
            PitchConfig {
                peak_pick_k: cfg.peak_pick_k,
                min_clarity: cfg.min_clarity,
                gate_db: cfg.gate_db,
                min_hz,
                max_hz,
            },
        );
        (filter, pitch)
    }

    fn level_len(sample_rate: u32, instrument: Instrument, hop: usize, window: usize) -> usize {
        let f_low = midi_to_hz(instrument.info().concert_low as f32);
        ((1.5 * sample_rate as f32 / f_low).ceil() as usize).clamp(hop, window)
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn instrument(&self) -> Instrument {
        self.instrument
    }

    pub fn window(&self) -> usize {
        self.pitch.window()
    }

    pub fn hop(&self) -> usize {
        self.cfg.hop
    }

    pub fn band_hz(&self) -> (f32, f32) {
        self.filter.band()
    }

    /// Engine clock: ms of audio processed since the engine was created.
    pub fn now_ms(&self) -> f64 {
        self.samples_seen as f64 * 1000.0 / self.sample_rate as f64
    }

    /// Switch instrument. Any sounding note is closed first. The engine clock keeps running.
    pub fn set_instrument(&mut self, instrument: Instrument, out: &mut Vec<EngineOutput>) {
        if instrument == self.instrument {
            return;
        }
        self.flush(out);
        let (filter, pitch) = Self::build_instrument_dsp(self.sample_rate, instrument, &self.cfg);
        let window = pitch.window();
        self.instrument = instrument;
        self.filter = filter;
        self.pitch = pitch;
        self.ring = vec![0.0; window];
        self.window_buf = vec![0.0; window];
        self.ring_pos = 0;
        self.ring_filled = 0;
        self.level_len = Self::level_len(self.sample_rate, instrument, self.cfg.hop, window);
        self.onset.reset();
        self.last_pitch = None;
    }

    /// Process mono samples in -1.0..=1.0 and append any resulting events to `out`.
    pub fn process(&mut self, samples: &[f32], out: &mut Vec<EngineOutput>) {
        let window = self.ring.len();
        for &x in samples {
            let y = self.filter.process(x);
            self.ring[self.ring_pos] = y;
            self.ring_pos = (self.ring_pos + 1) % window;
            self.ring_filled = (self.ring_filled + 1).min(window);
            self.hop_fill += 1;
            self.samples_seen += 1;
            if self.hop_fill == self.cfg.hop {
                self.hop_fill = 0;
                self.analyze_hop(out);
            }
        }
    }

    /// Close any sounding note at the current engine time.
    pub fn flush(&mut self, out: &mut Vec<EngineOutput>) {
        let now = self.now_ms();
        self.tracker.flush(now, &mut self.tracker_events);
        self.drain_tracker_events(out);
    }

    fn analyze_hop(&mut self, out: &mut Vec<EngineOutput>) {
        let now_ms = self.now_ms();
        let sr = self.sample_rate as f64;
        let hop_ms = self.cfg.hop as f64 * 1000.0 / sr;
        let window = self.ring.len();

        // The ring is chronological from `ring_pos`; take its newest `level_len` samples.
        let level_len = self.level_len.min(self.ring_filled.max(1));
        let onset = if self.ring_pos >= level_len {
            self.onset.process(&self.ring[self.ring_pos - level_len..self.ring_pos])
        } else {
            let head = &self.ring[..self.ring_pos];
            let tail = &self.ring[window - (level_len - head.len())..];
            self.window_buf[..tail.len()].copy_from_slice(tail);
            self.window_buf[tail.len()..level_len].copy_from_slice(head);
            self.onset.process(&self.window_buf[..level_len])
        };
        self.last_level_db = onset.level_db;
        // Stamp the onset at the middle of the newest hop: the level window ends at "now"
        // and its most recent hop is where a rise first shows.
        let onset_ms = onset.onset.then_some(now_ms - hop_ms / 2.0);

        let pitch = if self.ring_filled == window {
            let (tail, head) = self.ring.split_at(self.ring_pos);
            self.window_buf[..head.len()].copy_from_slice(head);
            self.window_buf[head.len()..].copy_from_slice(tail);
            self.pitch.analyze(&self.window_buf)
        } else {
            None
        };
        self.last_pitch = pitch;

        // Stamp the pitch frame at the centre of its window (delay compensation).
        let pitch_time_ms = now_ms - (window as f64 / 2.0) * 1000.0 / sr;
        self.tracker
            .process(pitch_time_ms, pitch, onset_ms, onset.level_db, &mut self.tracker_events);
        self.drain_tracker_events(out);

        if now_ms - self.last_status_ms >= self.cfg.status_interval_ms {
            self.last_status_ms = now_ms;
            out.push(EngineOutput::Status(self.status(now_ms)));
        }
    }

    fn status(&self, now_ms: f64) -> EngineStatus {
        let active = self.tracker.active();
        let cents = match (self.last_pitch, active) {
            (Some(p), Some((midi, _))) => Some((p.midi - midi as f32) * 100.0),
            (Some(p), None) => Some((p.midi - p.midi.round()) * 100.0),
            _ => None,
        };
        EngineStatus {
            timestamp_ms: now_ms,
            level_db: self.last_level_db,
            frequency_hz: self.last_pitch.map(|p| p.frequency_hz),
            clarity: self.last_pitch.map(|p| p.clarity),
            active_concert_midi: active.map(|(m, _)| m),
            active_written_midi: active.map(|(m, _)| self.instrument.written_midi(m)),
            cents,
        }
    }

    fn drain_tracker_events(&mut self, out: &mut Vec<EngineOutput>) {
        for e in self.tracker_events.drain(..) {
            let written = self.instrument.written_midi(e.midi);
            out.push(EngineOutput::Note(NoteEvent {
                kind: match e.kind {
                    TrackerEventKind::On => NoteEventKind::NoteOn,
                    TrackerEventKind::Off => NoteEventKind::NoteOff,
                },
                articulation: e.articulation,
                concert_midi: e.midi,
                written_midi: written,
                note_name: note_name(written),
                concert_name: note_name(e.midi),
                timestamp_ms: e.time_ms.max(0.0),
                clarity: e.clarity,
                frequency_hz: e.frequency_hz,
                cents: e.cents,
            }));
        }
    }
}

#[cfg(test)]
mod tests {
    //! End-to-end tests on synthetic band-instrument tones.
    use super::*;
    use crate::audio_engine::types::Articulation;
    use std::f32::consts::TAU;

    const SR: u32 = 48_000;

    /// One segment of a synthetic performance.
    struct Seg {
        midi: f32,
        ms: f32,
        amp: f32,
        vibrato_cents: f32,
    }

    fn note(midi: f32, ms: f32) -> Seg {
        Seg { midi, ms, amp: 0.3, vibrato_cents: 0.0 }
    }

    fn rest(ms: f32) -> Seg {
        Seg { midi: 60.0, ms, amp: 0.0, vibrato_cents: 0.0 }
    }

    /// Reed/brass-like tone: weak fundamental, strong 2nd and 3rd harmonics. A naive
    /// detector reads this an octave up. Amplitude is smoothed over 3 ms (like a real
    /// attack) and vibrato runs at 5.5 Hz.
    fn render(segs: &[Seg]) -> Vec<f32> {
        let harmonics = [(1.0, 0.35), (2.0, 0.9), (3.0, 0.6), (4.0, 0.3), (5.0, 0.15)];
        let mut out = Vec::new();
        let mut phase = 0.0f32;
        let mut amp = 0.0f32;
        let smooth = 1.0 - (-1.0 / (0.003 * SR as f32)).exp();
        let mut t = 0usize;
        let mut noise = 12345u32;
        for s in segs {
            let n = (s.ms / 1000.0 * SR as f32) as usize;
            for _ in 0..n {
                let tt = t as f32 / SR as f32;
                let vib = s.vibrato_cents * (TAU * 5.5 * tt).sin();
                let f = midi_to_hz(s.midi + vib / 100.0);
                phase = (phase + f / SR as f32).fract();
                amp += smooth * (s.amp - amp);
                let tone: f32 = harmonics
                    .iter()
                    .map(|(h, a)| a * (TAU * h * phase).sin())
                    .sum::<f32>()
                    / 2.3;
                noise = noise.wrapping_mul(1664525).wrapping_add(1013904223);
                let breath = ((noise >> 9) as f32 / (1u32 << 23) as f32 - 0.5) * 0.002;
                out.push(amp * tone + breath);
                t += 1;
            }
        }
        out
    }

    fn run(instrument: Instrument, audio: &[f32]) -> Vec<NoteEvent> {
        let mut engine = BandEngine::new(SR, instrument);
        let mut out = Vec::new();
        for chunk in audio.chunks(1024) {
            engine.process(chunk, &mut out);
        }
        engine.flush(&mut out);
        out.into_iter()
            .filter_map(|o| match o {
                EngineOutput::Note(n) => Some(n),
                EngineOutput::Status(_) => None,
            })
            .collect()
    }

    fn ons(events: &[NoteEvent]) -> Vec<&NoteEvent> {
        events.iter().filter(|e| e.kind == NoteEventKind::NoteOn).collect()
    }

    fn assert_balanced(events: &[NoteEvent]) {
        let mut open = false;
        for e in events {
            match e.kind {
                NoteEventKind::NoteOn => {
                    assert!(!open, "NoteOn while a note is open: {events:#?}");
                    open = true;
                }
                NoteEventKind::NoteOff => {
                    assert!(open, "NoteOff without NoteOn: {events:#?}");
                    open = false;
                }
            }
        }
        assert!(!open);
    }

    #[test]
    fn harmonic_rich_tone_is_not_an_octave_error() {
        // Concert A3 on tenor sax, the 2nd harmonic 8 dB above the fundamental.
        let ev = run(Instrument::TenorSax, &render(&[rest(100.0), note(57.0, 800.0), rest(200.0)]));
        assert_balanced(&ev);
        let on = ons(&ev);
        assert_eq!(on.len(), 1, "{ev:#?}");
        assert_eq!(on[0].concert_midi, 57);
        assert_eq!(on[0].written_midi, 71); // B4 written
        assert_eq!(on[0].note_name, "B4");
        assert!(on[0].clarity > 0.85);
        // Onset-linked start time within ~15 ms of the true attack at 100 ms.
        assert!((on[0].timestamp_ms - 100.0).abs() < 15.0, "{}", on[0].timestamp_ms);
    }

    #[test]
    fn vibrato_within_35_cents_stays_one_note() {
        let mut seg = note(65.0, 1500.0);
        seg.vibrato_cents = 30.0;
        let ev = run(Instrument::AltoSax, &render(&[rest(80.0), seg, rest(150.0)]));
        assert_balanced(&ev);
        let on = ons(&ev);
        assert_eq!(on.len(), 1, "{ev:#?}");
        assert_eq!(on[0].concert_midi, 65);
    }

    #[test]
    fn tongued_repeats_on_one_pitch_are_separate_notes() {
        // Four quarter notes at 150 bpm on concert Bb3, with a 20 ms tongue stop
        // (level down 26 dB, pitch never disappears from the window).
        let mut segs = vec![rest(100.0)];
        for _ in 0..4 {
            segs.push(note(58.0, 380.0));
            segs.push(Seg { midi: 58.0, ms: 20.0, amp: 0.015, vibrato_cents: 0.0 });
        }
        segs.push(rest(200.0));
        let ev = run(Instrument::Trumpet, &render(&segs));
        assert_balanced(&ev);
        let on = ons(&ev);
        assert_eq!(on.len(), 4, "{ev:#?}");
        assert!(on.iter().all(|e| e.concert_midi == 58));
        assert_eq!(on[0].articulation, Articulation::Attack);
        assert!(on[1..].iter().all(|e| e.articulation == Articulation::Tongued));
        for (i, e) in on.iter().enumerate() {
            let expected = 100.0 + i as f64 * 400.0;
            assert!((e.timestamp_ms - expected).abs() < 30.0, "note {i}: {}", e.timestamp_ms);
        }
    }

    #[test]
    fn slurred_scale_steps_are_legato_changes() {
        let segs = [rest(100.0), note(60.0, 300.0), note(62.0, 300.0), note(64.0, 300.0), rest(200.0)];
        let ev = run(Instrument::Flute, &render(&segs));
        assert_balanced(&ev);
        let on = ons(&ev);
        let midis: Vec<u8> = on.iter().map(|e| e.concert_midi).collect();
        assert_eq!(midis, vec![60, 62, 64], "{ev:#?}");
        assert_eq!(on[1].articulation, Articulation::Legato);
        assert!((on[1].timestamp_ms - 400.0).abs() < 30.0, "{}", on[1].timestamp_ms);
    }

    #[test]
    fn separated_notes_with_rests() {
        let segs = [rest(100.0), note(48.0, 300.0), rest(150.0), note(43.0, 300.0), rest(200.0)];
        let ev = run(Instrument::Trombone, &render(&segs));
        assert_balanced(&ev);
        let midis: Vec<u8> = ons(&ev).iter().map(|e| e.concert_midi).collect();
        assert_eq!(midis, vec![48, 43], "{ev:#?}");
    }

    #[test]
    fn low_tuba_notes_are_tracked() {
        // Concert F1 (43.7 Hz): below the 70 Hz default band, so this checks the
        // per-instrument band and the 4096-sample window.
        let ev = run(Instrument::Tuba, &render(&[rest(100.0), note(29.0, 800.0), rest(200.0)]));
        assert_balanced(&ev);
        let on = ons(&ev);
        assert_eq!(on.len(), 1, "{ev:#?}");
        assert_eq!(on[0].concert_midi, 29);
    }

    #[test]
    fn silence_and_noise_produce_nothing() {
        let audio = render(&[rest(1000.0)]);
        assert!(run(Instrument::Clarinet, &audio).is_empty());
    }

    #[test]
    fn instrument_switch_closes_open_note() {
        let audio = render(&[rest(50.0), note(60.0, 400.0)]);
        let mut engine = BandEngine::new(SR, Instrument::Flute);
        let mut out = Vec::new();
        engine.process(&audio, &mut out);
        engine.set_instrument(Instrument::Trumpet, &mut out);
        let notes: Vec<_> = out
            .iter()
            .filter_map(|o| if let EngineOutput::Note(n) = o { Some(n.kind) } else { None })
            .collect();
        assert_eq!(notes, vec![NoteEventKind::NoteOn, NoteEventKind::NoteOff]);
        assert_eq!(engine.instrument(), Instrument::Trumpet);
    }

    #[test]
    fn event_json_is_camel_case_and_compact() {
        let ev = run(Instrument::AltoSax, &render(&[rest(50.0), note(61.0, 300.0), rest(100.0)]));
        let json = serde_json::to_string(&ev[0]).unwrap();
        assert!(json.contains("\"kind\":\"noteOn\""), "{json}");
        assert!(json.contains("\"concertMidi\":61"));
        assert!(json.contains("\"writtenMidi\":70"));
        assert!(json.contains("\"timestampMs\""));
        assert!(json.len() < 300);
    }

    #[test]
    fn tongued_repeats_on_low_trombone() {
        // Eighth notes at 120 bpm on concert F2 with a 30 ms tongue stop.
        let mut segs = vec![rest(100.0)];
        for _ in 0..4 {
            segs.push(note(41.0, 220.0));
            segs.push(Seg { midi: 41.0, ms: 30.0, amp: 0.01, vibrato_cents: 0.0 });
        }
        segs.push(rest(200.0));
        let ev = run(Instrument::Trombone, &render(&segs));
        assert_balanced(&ev);
        let on = ons(&ev);
        assert_eq!(on.len(), 4, "{ev:#?}");
        assert!(on.iter().all(|e| e.concert_midi == 41));
    }

    #[test]
    fn real_octave_slur_registers() {
        let segs = [rest(100.0), note(72.0, 400.0), note(84.0, 400.0), rest(200.0)];
        let ev = run(Instrument::Flute, &render(&segs));
        assert_balanced(&ev);
        let midis: Vec<u8> = ons(&ev).iter().map(|e| e.concert_midi).collect();
        assert_eq!(midis, vec![72, 84], "{ev:#?}");
    }

    #[test]
    fn brief_octave_crack_is_ignored() {
        // A 35 ms jump to the upper partial in the middle of a held note (a "crack").
        let segs = [rest(100.0), note(50.0, 300.0), note(62.0, 35.0), note(50.0, 300.0), rest(200.0)];
        let ev = run(Instrument::TenorSax, &render(&segs));
        assert_balanced(&ev);
        let midis: Vec<u8> = ons(&ev).iter().map(|e| e.concert_midi).collect();
        assert_eq!(midis, vec![50], "{ev:#?}");
    }

    #[test]
    fn wide_sax_vibrato_with_tonguing() {
        // Alto sax, 30-cent vibrato, three tongued quarter notes.
        let mut segs = vec![rest(100.0)];
        for _ in 0..3 {
            segs.push(Seg { midi: 63.0, ms: 450.0, amp: 0.3, vibrato_cents: 30.0 });
            segs.push(Seg { midi: 63.0, ms: 25.0, amp: 0.012, vibrato_cents: 0.0 });
        }
        segs.push(rest(200.0));
        let ev = run(Instrument::AltoSax, &render(&segs));
        assert_balanced(&ev);
        let on = ons(&ev);
        assert_eq!(on.len(), 3, "{ev:#?}");
        assert!(on.iter().all(|e| e.concert_midi == 63));
        assert!(on.iter().all(|e| e.written_midi == 72)); // written C5
    }

    #[test]
    fn staccato_quarters_have_accurate_onsets() {
        // 100 bpm: 220 ms of sound, 380 ms of silence, eight times.
        let mut segs = vec![rest(100.0)];
        for _ in 0..8 {
            segs.push(note(65.0, 220.0));
            segs.push(rest(380.0));
        }
        let ev = run(Instrument::AltoSax, &render(&segs));
        assert_balanced(&ev);
        let on = ons(&ev);
        assert_eq!(on.len(), 8, "{ev:#?}");
        for (i, e) in on.iter().enumerate() {
            let expected = 100.0 + i as f64 * 600.0;
            assert!((e.timestamp_ms - expected).abs() < 12.0, "note {i}: {}", e.timestamp_ms);
        }
    }
}
