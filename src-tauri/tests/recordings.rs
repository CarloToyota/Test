//! Runs the engine over the real recordings in `../test-cases` and checks the notes
//! against each case's `expected.txt` (written pitches; rhythm is checked on the
//! frontend). Cases without a recording or expected.txt are skipped.

use std::path::Path;

use band_transcriber_lib::audio_engine::instrument::note_name;
use band_transcriber_lib::audio_engine::{wav::decode_wav, BandEngine, EngineOutput, Instrument, NoteEventKind};

/// Written pitch names expected, in order: notes from expected.txt, skipping rests and
/// the tied continuations of a note.
fn expected_notes(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut tied = false;
    for tok in text.split_whitespace() {
        let (name, rest) = tok.split_once(':').unwrap_or((tok, ""));
        if name != "r" && !tied {
            out.push(name.replace('♯', "#").replace('♭', "b"));
        }
        tied = rest.ends_with('~');
    }
    out
}

/// Note names the engine reports, as the app would show them: corrections and attack
/// blips under 60 ms are folded away.
fn engine_notes(wav: &Path, instrument: Instrument) -> Vec<String> {
    let (samples, rate) = decode_wav(&std::fs::read(wav).unwrap()).unwrap();
    let mut engine = BandEngine::new(rate, instrument);
    let mut out = Vec::new();
    for block in samples.chunks(1024) {
        engine.process(block, &mut out);
    }
    engine.flush(&mut out);
    let mut notes: Vec<(u8, f64, f64)> = Vec::new();
    for o in out {
        if let EngineOutput::Note(e) = o {
            if let Some(last) = notes.last_mut() {
                if last.2.is_nan() {
                    last.2 = e.timestamp_ms;
                }
            }
            if e.kind == NoteEventKind::NoteOn {
                notes.push((e.written_midi, e.timestamp_ms, f64::NAN));
            }
        }
    }
    notes
        .into_iter()
        .filter(|n| n.2.is_nan() || n.2 - n.1 >= 60.0)
        .map(|n| note_name(n.0))
        .collect()
}

/// Longest common subsequence length.
fn lcs(a: &[String], b: &[String]) -> usize {
    let mut dp = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for i in 1..=a.len() {
        for j in 1..=b.len() {
            dp[i][j] = if a[i - 1] == b[j - 1] { dp[i - 1][j - 1] + 1 } else { dp[i - 1][j].max(dp[i][j - 1]) };
        }
    }
    dp[a.len()][b.len()]
}

#[test]
fn real_recordings_read_correctly() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../test-cases");
    let Ok(dirs) = std::fs::read_dir(&root) else { return };
    let mut checked = 0;
    for dir in dirs.flatten().map(|d| d.path()) {
        let (wav, expected, session) = (dir.join("recording.wav"), dir.join("expected.txt"), dir.join("session.json"));
        if !wav.exists() || !expected.exists() || !session.exists() {
            continue;
        }
        let session: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&session).unwrap()).unwrap();
        let instrument: Instrument = serde_json::from_value(session["instrument"].clone()).unwrap();
        let want = expected_notes(&std::fs::read_to_string(&expected).unwrap());
        let got = engine_notes(&wav, instrument);
        let common = lcs(&want, &got);
        let missing = want.len() - common;
        let extra = got.len() - common;
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        eprintln!("{name}: {} expected, {} read, {missing} missing, {extra} extra", want.len(), got.len());
        // Allow a little slack for expressive playing; catch any real regression.
        let budget = 2 + want.len() / 50;
        assert!(missing + extra <= budget, "{name}: {missing} missing + {extra} extra notes (allowed {budget})\n want {want:?}\n got  {got:?}");
        checked += 1;
    }
    eprintln!("{checked} recordings checked");
}
