use serde::Serialize;

/// Whether a note started or stopped.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum NoteEventKind {
    NoteOn,
    NoteOff,
}

/// How a note began (on `NoteOn`) or why it ended (on `NoteOff`).
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Articulation {
    /// A new attack after silence.
    Attack,
    /// The same pitch was re-tongued: an amplitude dip followed by a fresh attack.
    Tongued,
    /// The pitch changed without a break in the sound (slurred).
    Legato,
    /// The sound stopped (`NoteOff` only).
    Release,
}

/// The payload of the `note-event` Tauri event. Kept small: about 200 bytes of JSON.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NoteEvent {
    pub kind: NoteEventKind,
    pub articulation: Articulation,
    /// Sounding pitch as a MIDI note number.
    pub concert_midi: u8,
    /// Pitch as written on the part for the selected instrument.
    pub written_midi: u8,
    /// Written note name with octave, e.g. `"F#4"`.
    pub note_name: String,
    /// Concert note name with octave, e.g. `"E3"`.
    pub concert_name: String,
    /// Engine clock in milliseconds since capture started, compensated for analysis-window delay.
    pub timestamp_ms: f64,
    /// McLeod clarity (normalized square difference peak), 0..1.
    pub clarity: f32,
    /// Measured fundamental at the moment of the event.
    pub frequency_hz: f32,
    /// Deviation of the measured pitch from equal temperament, in cents.
    pub cents: f32,
}

/// The payload of the `engine-status` Tauri event, sent at about 20 Hz.
/// It drives the level meter and tuner, and lets the UI map engine time to its own clock.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    /// Engine clock in ms of the most recent sample processed (not delay-compensated).
    pub timestamp_ms: f64,
    pub level_db: f32,
    pub frequency_hz: Option<f32>,
    pub clarity: Option<f32>,
    pub active_concert_midi: Option<u8>,
    pub active_written_midi: Option<u8>,
    pub cents: Option<f32>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum EngineOutput {
    Note(NoteEvent),
    Status(EngineStatus),
}
