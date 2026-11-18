//! Replay a recording through the engine, exactly as the app would hear it live.
//!
//! ```text
//! cargo run --release --example replay -- path/to/recording.wav altoSax > events.json
//! ```
//! Prints the note events as a JSON array (same shape as the `note-event` payload).

use band_transcriber_lib::audio_engine::{wav::decode_wav, BandEngine, EngineOutput, Instrument};

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

    let mut engine = BandEngine::new(rate, instrument);
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
