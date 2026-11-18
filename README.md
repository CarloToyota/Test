# Band Transcriber

Real-time, on-device music transcription for concert and jazz band instruments: flute, B♭ clarinet, alto, tenor and bari sax, trumpet, French horn, trombone and tuba. Play into the microphone and the app detects each note and its articulation, transposes it for your instrument and engraves it with VexFlow. All audio stays in Rust on your device. Nothing is uploaded.

Tauri v2 · Rust · React 18 + TypeScript + Vite · VexFlow 4

## Run it

Prerequisites: Rust (stable), Node 18+, and the [Tauri v2 system dependencies](https://v2.tauri.app/start/prerequisites/). On Linux that includes `libwebkit2gtk-4.1-dev` and `libasound2-dev`.

```bash
npm install
```

```bash
npm run tauri dev
```

To build a release bundle:

```bash
npm run tauri build
```

`npm run dev` on its own opens the UI in a normal browser. Without Tauri there is no microphone, so a scripted **demo** melody drives the same event stream, which is useful for UI work.

Tests:

```bash
cd src-tauri && cargo test --lib
```

```bash
npm test
```

## Using it

**Parts.** A score holds any number of parts (left panel). Select a part to record into it or edit it, and add more with **Add part**. Mute and volume apply to playback.

**Recording.** Pick the part, then **Record**. A one-bar count-in leads you in. Under the score, choose whether the take **replaces the part** or **adds to the end**, and whether to **hear the other parts** while you play (headphones help). **Stop** writes the take into the part; Ctrl+Z undoes a whole take.

**Playback.** **Play** (or Space) plays every part. A line moves across the score and the sounding notes light up. In edit mode, playback starts from the selected note.

**Views.** **Full score**: one staff per part, in score order, each in its own clef and transposed key. **Part**: just the selected part.

**Editing.** **Edit**, then click a note or rest on any staff, or move with ← →.

| Key | Action |
|---|---|
| A–G | Set the selected note's pitch (nearest octave), or write a note into a selected rest |
| 3 4 5 6 7 | 16th, 8th, quarter, half, whole (also sets the length for new notes) |
| . | Dot or un-dot |
| ↑ ↓ / Ctrl+↑ ↓ | Semitone / octave |
| Delete, Backspace, 0 | Turn the note into a rest |
| Space | Play / pause |
| Ctrl+Z, Ctrl+Shift+Z | Undo, redo (any change, including takes, imports and New) |
| Ctrl+S, Ctrl+O | Save project, open |

A longer note overwrites what follows it, as in MuseScore. Changing the time signature re-bars the whole score.

**Time signatures.** 2/4, 3/4, 4/4, 5/4, 2/2, 3/8, 5/8, 6/8, 7/8, 9/8, 12/8, or **Custom…**: any count over 2, 4, 8 or 16, with an optional grouping (`11/8`, `7/8 3+2+2`, `3+3+2/8`, `5/4 3+2`). Groupings set beaming, how notes are split, and metronome accents.

**Files** (File menu):
- **Open**: a Band Transcriber project (`.bandscore`), MusicXML (`.musicxml`, `.xml`, `.mxl`) or MIDI (`.mid`).
- **Add parts from a file**: brings another file's parts into this score.
- **Save project**: keeps every part editable for later.

Imported parts are matched to instruments by name, transposition, General MIDI program or range. Each becomes a single line: voice 1, the top note of chords. Tuplets round to the nearest 16th, and the first time signature applies throughout.

**Export.** **PDF** (full score, this part, or score + every part; Letter or A4), **MusicXML** (all parts, validated against the MusicXML 4.0 schema) and **MIDI** (one track per part, concert pitch).

## Real-world test cases

**Export → Save test case** writes the take's exact audio plus settings and detections. Put the folder in `test-cases/` and see `test-cases/README.md`: the replay tool re-runs the current engine on the audio, and `npm test` checks the notation against `expected.txt`.

## Architecture

```
cpal callback (real-time thread)          engine thread (owns the stream)              Tauri async task           WebView
──────────────────────────────            ───────────────────────────────              ────────────────           ───────
downmix → push into lock-free  ──rtrb──▶  band-pass → onset detector ─┐   tokio mpsc  emit("note-event") ──▶  clock sync → quantize
SPSC ring (no alloc, no locks)            sliding McLeod pitch ───────┴▶ note tracker ──▶ emit("engine-status")    → VexFlow render
                                                                         → transposition
```

* **No audio on the UI thread.** Raw samples never leave Rust. The webview receives only `note-event`, about 200 bytes per note, and `engine-status`, a 20 Hz heartbeat for the tuner, level meter and clock sync.
* **Portable core.** Everything in `src-tauri/src/audio_engine/` except `capture.rs` is pure Rust with no OS, cpal or Tauri dependencies. It compiles for `wasm32-unknown-unknown` unchanged, and the same `BandEngine::process(&[f32])` API serves iOS, Android or Web Audio.

| File | Role |
|---|---|
| `audio_engine/filter.rs` | 4th-order Butterworth high-pass + low-pass (RBJ biquads) |
| `audio_engine/pitch.rs` | McLeod pitch + unbiased clarity + octave correction |
| `audio_engine/onset.rs` | Level-envelope onset detector for tonguing |
| `audio_engine/tracker.rs` | Note state machine: debounce, vibrato hysteresis, legato, octave guard, re-articulation, release |
| `audio_engine/instrument.rs` | Transposition, clef, range, and per-instrument band and window |
| `audio_engine/engine.rs` | Pipeline + end-to-end tests on synthetic reed/brass tones |
| `audio_engine/capture.rs` | cpal capture + engine thread |
| `src/lib/quantize.ts` | Rhythm interpretation (alignment, hierarchical snapping, durations to the next attack) and layout into bars, rests, dots and ties |
| `src/lib/meter.ts` | Time signatures (including custom and additive) and beat structure |
| `src/lib/editor.ts` | The editable score and its operations (pure, for undo/redo) |
| `src/lib/render.ts` | VexFlow engraving of one or many staves (bars aligned across parts), shared by the screen, editor, playback and PDF |
| `src/lib/project.ts` | Multi-part project model and the `.bandscore` file format |
| `src/lib/playback.ts` | Web Audio synth and scheduler behind playback and play-along |
| `src/lib/import/` | MusicXML/.mxl and MIDI import |
| `src/lib/export/` | PDF (jsPDF + svg2pdf), MusicXML 4.0, MIDI |
| `src-tauri/examples/replay.rs` | Replays a WAV through the engine; used for test cases |
| `src/lib/music.ts` | Written key per instrument, key-aware note spelling |

## DSP notes

**Octave errors.** `pitch-detection` 0.3 has two quirks. Its "clarity threshold" is an absolute bar the first NSDF peak must clear, not MPM's *k*-relative rule. Its NSDF is also biased by lag: a perfect 220 Hz sine scores 0.89 in a 2048-sample window, and a low tuba note can never reach 0.85. So the crate only supplies a candidate period. That period, and 2×, 3× and 4× it, are then re-scored with the textbook unbiased NSDF. MPM's key-maximum rule (shortest period ≥ 0.90 × best) picks the fundamental, and the **unbiased clarity must exceed 0.85**. A 2nd harmonic 9 dB above the fundamental, and a dominant 3rd harmonic, are both tested.

**Band.** 70–2200 Hz by default. For instruments that play below 70 Hz the high-pass corner drops to 0.78 × the lowest note: bari sax (C2), horn and trombone pedals (B♭1), tuba (D1). The low-pass corner falls to 4 × the top note when that is lower than 2200 Hz. The analysis window holds ≥ 2.4 periods of the lowest note: 1024 samples for flute, clarinet, trumpet and alto; 2048 for tenor, bari, horn and trombone; 4096 for tuba (at 48 kHz). The hop is 256 samples (5.3 ms).

**Tonguing.** The onset detector measures level over 1.5 periods of the instrument's lowest note. A shorter window makes a steady tuba note's RMS ride its waveform and look like tonguing. A rise of ≥ 6 dB above the recent minimum while the level is climbing counts as an attack. During a sounding note, the tracker waits until the pitch window is centred past the onset. Then it emits `NoteOff` + `NoteOn` (articulation `tongued`) for the same pitch, or dates a pitch change at the onset.

**Vibrato.** Pitch within ±35 cents of the note's centre is the same note. The centre slowly follows the player's intonation. A new semitone must sit within ±40 cents of its own centre for 25 ms. Octave, twelfth and double-octave jumps need 60 ms, so a crack or overblow flicker is ignored. Unclear pitch while the level stays loud holds the note for up to 120 ms.

**Timing.** Pitch frames are stamped at the centre of their window. Note starts snap to the onset time when one is nearby, so timestamps are about ±10 ms from the attack. The UI maps engine time to `performance.now()` with a min-filtered offset from the heartbeat. The **Latency** slider (default 30 ms) cancels microphone and speaker delay.

**Metronome.** A Web Audio look-ahead scheduler plays band-passed noise clicks at 3.6 and 5.2 kHz, above the engine's low-pass and unpitched, so they are not transcribed. Headphones are still best. Recording starts after a one-bar count-in.

## Transposition table

| Instrument | Key | Written = concert + | Clef |
|---|---|---|---|
| Flute | C | 0 | treble |
| B♭ Clarinet | B♭ | +2 | treble |
| B♭ Trumpet | B♭ | +2 | treble |
| B♭ Tenor Sax | B♭ | +14 | treble |
| E♭ Alto Sax | E♭ | +9 | treble |
| E♭ Bari Sax | E♭ | +21 | treble |
| F French Horn | F | +7 | treble |
| Trombone | C | 0 | bass |
| Tuba | C | 0 | bass |

Tuba parts are written at concert pitch, so there is no octave shift.

## Events

```jsonc
// note-event
{ "kind": "noteOn", "articulation": "tongued", "concertMidi": 63, "writtenMidi": 72,
  "noteName": "C5", "concertName": "D#4", "timestampMs": 1834.6, "clarity": 0.97,
  "frequencyHz": 311.4, "cents": 3.2 }
```

Commands: `get_instruments`, `list_input_devices`, `start_engine { instrument, deviceId }`, `stop_engine`, `set_instrument { instrument }`.
