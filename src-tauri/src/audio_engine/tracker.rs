//! Monophonic note state machine: debounced note-on, vibrato hysteresis, legato pitch
//! changes, octave-jump guarding, tongued re-articulation and release.
//!
//! Time is measured on the *pitch clock*: each pitch frame is stamped with the centre of
//! its analysis window, so pitch-derived times line up with onset times (stamped at the
//! centre of their short level block) even though the pitch window is much longer.

use super::pitch::PitchFrame;
use super::types::Articulation;

#[derive(Clone, Copy, Debug)]
pub struct TrackerConfig {
    /// Pitch movement within +-this of the active note's centre is vibrato, not a change.
    pub vibrato_cents: f32,
    /// After a tonguing onset, a pitch within +-this of the old centre is a repeated note.
    pub same_pitch_cents: f32,
    /// A candidate for a *new* note must sit within +-this of its own semitone.
    pub snap_cents: f32,
    /// Stable pitch needed before the first note-on.
    pub note_on_ms: f32,
    /// Stable pitch needed for a slurred change to a new semitone.
    pub change_ms: f32,
    /// Stable pitch needed for a change of exactly one or two octaves, or an octave and a
    /// fifth (the overblow intervals), so harmonic flips do not register as notes.
    pub octave_change_ms: f32,
    /// Unclear pitch needed before note-off, once the level has dropped.
    pub release_ms: f32,
    /// Unclear pitch tolerated while the level stays loud (a crack, growl or key
    /// noise inside a held note) before the note is released anyway.
    pub hold_unclear_ms: f32,
    /// "Loud" means within this many dB of the note's peak level.
    pub hold_level_db: f32,
    /// Shortest note a tonguing onset may cut off.
    pub min_note_ms: f32,
    /// Maximum distance between an onset and the pitch event it belongs to.
    pub onset_link_ms: f32,
    /// How far past an onset (pitch clock) to wait before deciding what it was.
    pub onset_decide_ms: f32,
    /// Per-frame rate at which the vibrato centre follows the player's intonation.
    pub center_adapt: f32,
}

impl Default for TrackerConfig {
    fn default() -> Self {
        Self {
            vibrato_cents: 35.0,
            same_pitch_cents: 50.0,
            snap_cents: 40.0,
            note_on_ms: 15.0,
            change_ms: 25.0,
            octave_change_ms: 60.0,
            release_ms: 30.0,
            hold_unclear_ms: 120.0,
            hold_level_db: 12.0,
            min_note_ms: 60.0,
            onset_link_ms: 70.0,
            onset_decide_ms: 8.0,
            center_adapt: 0.04,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TrackerEventKind {
    On,
    Off,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TrackerEvent {
    pub kind: TrackerEventKind,
    pub articulation: Articulation,
    pub midi: u8,
    pub time_ms: f64,
    pub frequency_hz: f32,
    pub clarity: f32,
    /// Measured deviation from the equal-tempered semitone, cents.
    pub cents: f32,
}

#[derive(Clone, Copy, Debug)]
struct Candidate {
    midi: u8,
    frames: u32,
    first_ms: f64,
    midi_sum: f32,
}

impl Candidate {
    fn new(midi: u8, p: &PitchFrame, time_ms: f64) -> Self {
        Self {
            midi,
            frames: 1,
            first_ms: time_ms,
            midi_sum: p.midi,
        }
    }

    fn mean(&self) -> f32 {
        self.midi_sum / self.frames as f32
    }

    fn push(&mut self, p: &PitchFrame) {
        self.frames += 1;
        self.midi_sum += p.midi;
    }
}

#[derive(Clone, Copy, Debug)]
struct Active {
    midi: u8,
    /// Fractional-MIDI centre the vibrato band is measured from.
    center: f32,
    start_ms: f64,
    last_pitched_ms: f64,
    missing: u32,
    /// Loudest level seen during the note, dBFS.
    peak_db: f32,
    last: PitchFrame,
    candidate: Option<Candidate>,
    /// A tonguing onset that turned out to start a *different* pitch; it gives the
    /// time and articulation of the change once the candidate is confirmed.
    change_onset_ms: Option<f64>,
}

#[derive(Clone, Copy, Debug)]
enum State {
    Idle { candidate: Option<Candidate> },
    Active(Active),
}

pub struct NoteTracker {
    cfg: TrackerConfig,
    hop_ms: f64,
    note_on_frames: u32,
    change_frames: u32,
    octave_frames: u32,
    release_frames: u32,
    hold_frames: u32,
    state: State,
    pending_onset_ms: Option<f64>,
}

fn frames_for(ms: f32, hop_ms: f64) -> u32 {
    ((ms as f64 / hop_ms).ceil() as u32).max(1)
}

fn cents_off(p: &PitchFrame, midi: u8) -> f32 {
    (p.midi - midi as f32) * 100.0
}

fn is_overblow_interval(a: u8, b: u8) -> bool {
    matches!((a as i16 - b as i16).abs(), 12 | 19 | 24)
}

impl NoteTracker {
    pub fn new(cfg: TrackerConfig, hop_ms: f64) -> Self {
        Self {
            note_on_frames: frames_for(cfg.note_on_ms, hop_ms),
            change_frames: frames_for(cfg.change_ms, hop_ms),
            octave_frames: frames_for(cfg.octave_change_ms, hop_ms),
            release_frames: frames_for(cfg.release_ms, hop_ms),
            hold_frames: frames_for(cfg.hold_unclear_ms, hop_ms),
            cfg,
            hop_ms,
            state: State::Idle { candidate: None },
            pending_onset_ms: None,
        }
    }

    pub fn reset(&mut self) {
        self.state = State::Idle { candidate: None };
        self.pending_onset_ms = None;
    }

    /// The sounding note, if any, with its centre (fractional MIDI).
    pub fn active(&self) -> Option<(u8, f32)> {
        match self.state {
            State::Active(a) => Some((a.midi, a.center)),
            State::Idle { .. } => None,
        }
    }

    /// Feed one analysis hop.
    /// * `time_ms`: pitch-clock time of this frame (centre of the pitch window).
    /// * `pitch`: a clear pitch inside the instrument's range, or `None`.
    /// * `onset_ms`: time of an amplitude onset detected in this hop, if any.
    /// * `level_db`: current signal level, dBFS.
    pub fn process(
        &mut self,
        time_ms: f64,
        pitch: Option<PitchFrame>,
        onset_ms: Option<f64>,
        level_db: f32,
        out: &mut Vec<TrackerEvent>,
    ) {
        if let Some(t) = onset_ms {
            self.pending_onset_ms = Some(t);
        }
        if let Some(t) = self.pending_onset_ms {
            if time_ms - t > self.cfg.onset_link_ms as f64 {
                self.pending_onset_ms = None;
            }
        }

        match self.state {
            State::Idle { candidate } => self.process_idle(time_ms, pitch, candidate, level_db, out),
            State::Active(active) => self.process_active(time_ms, pitch, active, level_db, out),
        }
    }

    /// Close any sounding note, e.g. when capture stops.
    pub fn flush(&mut self, time_ms: f64, out: &mut Vec<TrackerEvent>) {
        if let State::Active(a) = self.state {
            out.push(Self::event(TrackerEventKind::Off, Articulation::Release, a.midi, time_ms, &a.last));
        }
        self.reset();
    }

    fn event(
        kind: TrackerEventKind,
        articulation: Articulation,
        midi: u8,
        time_ms: f64,
        p: &PitchFrame,
    ) -> TrackerEvent {
        TrackerEvent {
            kind,
            articulation,
            midi,
            time_ms,
            frequency_hz: p.frequency_hz,
            clarity: p.clarity,
            cents: cents_off(p, midi),
        }
    }

    fn start_note(
        &mut self,
        midi: u8,
        center: f32,
        start_ms: f64,
        now_ms: f64,
        p: PitchFrame,
        level_db: f32,
    ) {
        self.state = State::Active(Active {
            midi,
            center,
            start_ms,
            last_pitched_ms: now_ms,
            missing: 0,
            peak_db: level_db,
            last: p,
            candidate: None,
            change_onset_ms: None,
        });
    }

    fn process_idle(
        &mut self,
        time_ms: f64,
        pitch: Option<PitchFrame>,
        candidate: Option<Candidate>,
        level_db: f32,
        out: &mut Vec<TrackerEvent>,
    ) {
        let Some(p) = pitch else {
            self.state = State::Idle { candidate: None };
            return;
        };
        let rounded = p.midi.round().clamp(0.0, 127.0) as u8;
        let cand = match candidate {
            // Up to half a semitone of drift while the attack settles.
            Some(mut c) if (p.midi - c.mean()).abs() <= 0.5 => {
                c.push(&p);
                c
            }
            _ => Candidate::new(rounded, &p, time_ms),
        };

        if cand.frames < self.note_on_frames {
            self.state = State::Idle { candidate: Some(cand) };
            return;
        }

        let center = cand.mean();
        let midi = center.round().clamp(0.0, 127.0) as u8;
        let link = self.cfg.onset_link_ms as f64;
        let start_ms = match self.pending_onset_ms.take() {
            Some(t) if (t - cand.first_ms).abs() <= link => t,
            _ => cand.first_ms,
        };
        out.push(Self::event(TrackerEventKind::On, Articulation::Attack, midi, start_ms, &p));
        self.start_note(midi, center, start_ms, time_ms, p, level_db);
    }

    fn process_active(
        &mut self,
        time_ms: f64,
        pitch: Option<PitchFrame>,
        mut a: Active,
        level_db: f32,
        out: &mut Vec<TrackerEvent>,
    ) {
        let Some(p) = pitch else {
            a.missing += 1;
            a.candidate = None;
            let still_loud = level_db > a.peak_db - self.cfg.hold_level_db;
            let limit = if still_loud { self.hold_frames } else { self.release_frames };
            if a.missing >= limit {
                let off_ms = a.last_pitched_ms + self.hop_ms;
                out.push(Self::event(TrackerEventKind::Off, Articulation::Release, a.midi, off_ms, &a.last));
                self.state = State::Idle { candidate: None };
            } else {
                self.state = State::Active(a);
            }
            return;
        };

        a.missing = 0;
        a.peak_db = a.peak_db.max(level_db);
        a.last_pitched_ms = time_ms;
        a.last = p;
        let dev_cents = (p.midi - a.center) * 100.0;

        // Tonguing: an amplitude onset while the note sounds. Wait until the pitch window
        // is centred past the onset, so the pitch we look at is the *new* attack's.
        if let Some(t) = self.pending_onset_ms {
            let long_enough = t - a.start_ms >= self.cfg.min_note_ms as f64;
            if !long_enough {
                // This is the attack of the current note (or a bounce right after it).
                self.pending_onset_ms = None;
            } else if time_ms >= t + self.cfg.onset_decide_ms as f64 {
                self.pending_onset_ms = None;
                if dev_cents.abs() <= self.cfg.same_pitch_cents {
                    out.push(Self::event(TrackerEventKind::Off, Articulation::Tongued, a.midi, t, &p));
                    out.push(Self::event(TrackerEventKind::On, Articulation::Tongued, a.midi, t, &p));
                    let (midi, center) = (a.midi, a.center);
                    self.start_note(midi, center, t, time_ms, p, level_db);
                    return;
                }
                // A tongued attack on a different pitch: let the change logic below
                // confirm it, then date the change at the onset.
                a.change_onset_ms = Some(t);
            }
        }

        if dev_cents.abs() <= self.cfg.vibrato_cents {
            // Inside the vibrato band: the same note. Follow slow intonation drift.
            a.candidate = None;
            a.center += self.cfg.center_adapt * (p.midi - a.center);
            self.state = State::Active(a);
            return;
        }

        let rounded = p.midi.round().clamp(0.0, 127.0) as u8;
        if rounded == a.midi || (p.midi - rounded as f32).abs() * 100.0 > self.cfg.snap_cents {
            // Either a wide excursion that still rounds to this note, or a pitch between
            // semitones (the crest of a wide vibrato, or a glide). Neither is a new note.
            a.candidate = None;
            self.state = State::Active(a);
            return;
        }

        let cand = match a.candidate {
            Some(mut c) if c.midi == rounded => {
                c.push(&p);
                c
            }
            _ => Candidate::new(rounded, &p, time_ms),
        };
        let required = if a.change_onset_ms.is_some() {
            self.note_on_frames
        } else if is_overblow_interval(rounded, a.midi) {
            self.octave_frames
        } else {
            self.change_frames
        };

        if cand.frames < required {
            a.candidate = Some(cand);
            self.state = State::Active(a);
            return;
        }

        let (t, art) = match a.change_onset_ms.take() {
            Some(t) => (t, Articulation::Tongued),
            None => (cand.first_ms, Articulation::Legato),
        };
        let t = t.max(a.start_ms);
        out.push(Self::event(TrackerEventKind::Off, art, a.midi, t, &p));
        out.push(Self::event(TrackerEventKind::On, art, cand.midi, t, &p));
        let center = cand.mean();
        self.start_note(rounded, center, t, time_ms, p, level_db);
    }
}
