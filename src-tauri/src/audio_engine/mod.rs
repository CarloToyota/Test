//! Platform-agnostic band-instrument transcription engine.
//!
//! Everything in this module except `capture` is pure Rust with no OS, audio-API or
//! Tauri dependencies. It compiles unchanged for desktop, iOS, Android and
//! `wasm32-unknown-unknown`. Feed it mono `f32` samples with [`BandEngine::process`]
//! and it returns compact [`EngineOutput`] events.
//!
//! Signal chain, per analysis hop (~5 ms):
//!
//! ```text
//! mic -> downmix -> 4th-order Butterworth band-pass -> +-> RMS envelope -> onset/tonguing detector -+
//!                                                     |                                               |
//!                                                     +-> McLeod pitch (sliding window) --------------+-> note tracker -> transposition -> events
//! ```

pub mod engine;
pub mod filter;
pub mod instrument;
pub mod onset;
pub mod pitch;
pub mod tracker;
pub mod types;
pub mod wav;

#[cfg(feature = "capture")]
pub mod capture;

pub use engine::{BandEngine, EngineConfig};
pub use instrument::{Clef, Instrument, InstrumentInfo};
pub use types::{Articulation, EngineOutput, EngineStatus, NoteEvent, NoteEventKind};
