//! Replay a recording through the engine, exactly as the app would hear it live.
//!
//! ```text
//! cargo run --release --example replay -- path/to/recording.wav altoSax > events.json
//! ```
//! Prints the note events as a JSON array (same shape as the `note-event` payload).

use band_transcriber_lib::audio_engine::{wav::decode_wav, BandEngine, EngineConfig, EngineOutput, Instrument};

/// Tuning overrides for experiments: BT_<NAME>=value.
fn env_f32(name: &str) -> Option<f32> {
    std::env::var(format!("BT_{name}")).ok()?.parse().ok()
}

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(path), Some(instrument)) = (args.next(), args.next()) else {
        eprintln!("usage: replay <recording.wav> <instrument>   (e.g. altoSax, tenorSax, trumpet, tuba)");
        std::process::exit(2);
    };
    let instrument: Instrument = serde_json::from_value(serde_json::Value::String(instrument.clone()))
        .unwrap_or_else(|_| panic!("unknown instrument {instrument:?}"));
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("cannot read {path}: {e}"));
    let (samples, rate) = decode_wav(&bytes).unwrap_or_else(|e| panic!("{path}: {e}"));

    let mut cfg = EngineConfig::default();
    if let Some(v) = env_f32("K") { cfg.peak_pick_k = v; }
    if let Some(v) = env_f32("CLARITY") { cfg.min_clarity = v; }
    if let Some(v) = env_f32("SUB") { cfg.tracker.sub_octave_db = v; }
    if let Some(v) = env_f32("RISE") { cfg.onset.rise_db = v; }
    if let Some(v) = env_f32("REARM") { cfg.onset.rearm_db = v; }
    if let Some(v) = env_f32("TUNING") { cfg.tracker.tuning_adapt = v; }
    if let Some(v) = env_f32("REFRACTORY") { cfg.onset.refractory_ms = v; }
    if let Some(v) = env_f32("MIN_NOTE") { cfg.tracker.min_note_ms = v; }
    if let Some(v) = env_f32("OCTAVE_MS") { cfg.tracker.octave_change_ms = v; }
    if let Some(v) = env_f32("CHANGE_MS") { cfg.tracker.change_ms = v; }
    if let Some(v) = env_f32("RELEASE_MS") { cfg.tracker.release_ms = v; }
    let mut engine = BandEngine::with_config(rate, instrument, cfg);
    let mut out = Vec::new();
    // Feed in device-sized blocks, like the live capture thread does.
    for block in samples.chunks(1024) {
        engine.process(block, &mut out);
    }
    engine.flush(&mut out);
    let notes: Vec<_> = out
        .into_iter()
        .filter_map(|o| match o {
            EngineOutput::Note(n) => Some(n),
            EngineOutput::Status(_) => None,
        })
        .collect();
    println!("{}", serde_json::to_string_pretty(&notes).expect("serialize"));
    eprintln!(
        "{path}: {:.1} s at {rate} Hz, {} notes",
        samples.len() as f64 / rate as f64,
        notes.len() / 2
    );
}
