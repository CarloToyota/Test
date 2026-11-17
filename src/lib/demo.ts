// Browser-only stand-in for the Rust engine: replays a scripted melody as the same
// note-event / engine-status stream, so the UI can be developed without Tauri or a mic.
// Never used inside the Tauri app.

import type { EngineHandlers } from "./bridge";
import type { CaptureInfo, InstrumentId, InstrumentInfo, NoteEvent } from "./types";

// Mirrors audio_engine::instrument (the Rust table is authoritative inside Tauri).
export const DEMO_INSTRUMENTS: InstrumentInfo[] = [
  { id: "flute", name: "Flute", key: "C", transposeSemitones: 0, clef: "treble", concertLow: 59, concertHigh: 98 },
  { id: "clarinet", name: "Bb Clarinet", key: "Bb", transposeSemitones: 2, clef: "treble", concertLow: 50, concertHigh: 94 },
  { id: "altoSax", name: "Eb Alto Sax", key: "Eb", transposeSemitones: 9, clef: "treble", concertLow: 49, concertHigh: 84 },
  { id: "tenorSax", name: "Bb Tenor Sax", key: "Bb", transposeSemitones: 14, clef: "treble", concertLow: 44, concertHigh: 79 },
  { id: "bariSax", name: "Eb Bari Sax", key: "Eb", transposeSemitones: 21, clef: "treble", concertLow: 36, concertHigh: 72 },
  { id: "trumpet", name: "Bb Trumpet", key: "Bb", transposeSemitones: 2, clef: "treble", concertLow: 52, concertHigh: 86 },
  { id: "frenchHorn", name: "F French Horn", key: "F", transposeSemitones: 7, clef: "treble", concertLow: 34, concertHigh: 77 },
  { id: "trombone", name: "Trombone", key: "C", transposeSemitones: 0, clef: "bass", concertLow: 34, concertHigh: 77 },
  { id: "tuba", name: "Tuba", key: "C", transposeSemitones: 0, clef: "bass", concertLow: 26, concertHigh: 65 },
];

/** [semitones above concert Bb, start beat, length in beats], at 100 bpm after a 4-beat count-in. */
const MELODY: Array<[number, number, number]> = [
  [0, 0, 1], [2, 1, 1], [4, 2, 0.5], [5, 2.5, 0.5], [7, 3, 1.5],
  [7, 4.5, 0.25], [7, 4.75, 0.25], [9, 5, 0.5], [7, 5.5, 0.5], [5, 6, 2],
  [4, 8.5, 0.5], [5, 9, 0.75], [7, 9.75, 0.25], [9, 10, 1], [10, 11, 3],
  [12, 14, 0.5], [10, 14.5, 0.5], [9, 15, 1],
  [7, 16, 0.25], [7, 16.25, 0.25], [7, 16.5, 0.25], [7, 16.75, 0.25], [5, 17, 1], [2, 18, 1], [0, 19, 4],
];
const DEMO_BPM = 100;
const COUNT_IN_BEATS = 4;
const LEAD_MS = 150;

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const nameOf = (m: number) => `${NAMES[m % 12]}${Math.floor(m / 12) - 1}`;

export class DemoEngine {
  readonly listeners = new Set<EngineHandlers>();
  private timers: number[] = [];
  private statusTimer: number | null = null;
  private t0 = 0;
  private info: InstrumentInfo = DEMO_INSTRUMENTS[0];
  private active: number | null = null;

  start(instrument: InstrumentId): CaptureInfo {
    this.stop();
    this.setInstrument(instrument);
    this.t0 = performance.now();
    const beatMs = 60000 / DEMO_BPM;
    // A concert Bb in the lower-middle of the instrument's range.
    const mid = Math.round((this.info.concertLow * 2 + this.info.concertHigh) / 3);
    const root = mid - ((((mid - 58) % 12) + 12) % 12);
    for (const [offset, beat, len] of MELODY) {
      const on = LEAD_MS + (COUNT_IN_BEATS + beat) * beatMs;
      const off = on + len * beatMs - Math.min(40, len * beatMs * 0.15);
      this.timers.push(window.setTimeout(() => this.emit("noteOn", root + offset, on), on));
      this.timers.push(window.setTimeout(() => this.emit("noteOff", root + offset, off), off));
    }
    this.statusTimer = window.setInterval(() => {
      const ts = performance.now() - this.t0;
      const midi = this.active;
      this.listeners.forEach((l) => l.onStatus({
        timestampMs: ts,
        levelDb: midi === null ? -70 : -18 + Math.sin(ts / 90) * 2,
        frequencyHz: midi === null ? null : 440 * 2 ** ((midi - 69) / 12),
        clarity: midi === null ? null : 0.95,
        activeConcertMidi: midi,
        activeWrittenMidi: midi === null ? null : midi + this.info.transposeSemitones,
        cents: midi === null ? null : Math.sin(ts / 160) * 12,
      }));
    }, 50);
    return {
      deviceName: "Demo melody",
      sampleRate: 48000,
      channels: 1,
      bufferFrames: 1024,
      analysisWindow: 2048,
      hop: 256,
      bandLowHz: 70,
      bandHighHz: 2200,
    };
  }

  stop(): void {
    this.timers.forEach((t) => window.clearTimeout(t));
    this.timers = [];
    if (this.statusTimer !== null) window.clearInterval(this.statusTimer);
    this.statusTimer = null;
    if (this.active !== null) this.emit("noteOff", this.active, performance.now() - this.t0);
  }

  setInstrument(instrument: InstrumentId): void {
    this.info = DEMO_INSTRUMENTS.find((i) => i.id === instrument) ?? DEMO_INSTRUMENTS[0];
  }

  private emit(kind: NoteEvent["kind"], concert: number, timestampMs: number): void {
    this.active = kind === "noteOn" ? concert : null;
    const written = concert + this.info.transposeSemitones;
    const event: NoteEvent = {
      kind,
      articulation: kind === "noteOn" ? "attack" : "release",
      concertMidi: concert,
      writtenMidi: written,
      noteName: nameOf(written),
      concertName: nameOf(concert),
      timestampMs,
      clarity: 0.95,
      frequencyHz: 440 * 2 ** ((concert - 69) / 12),
      cents: 0,
    };
    this.listeners.forEach((l) => l.onNote(event));
  }
}
