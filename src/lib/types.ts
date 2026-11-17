// Mirrors the serde types in src-tauri/src/audio_engine (camelCase on the wire).

export type InstrumentId =
  | "flute"
  | "clarinet"
  | "altoSax"
  | "tenorSax"
  | "bariSax"
  | "trumpet"
  | "frenchHorn"
  | "trombone"
  | "tuba";

export type Clef = "treble" | "bass";

export interface InstrumentInfo {
  id: InstrumentId;
  name: string;
  key: "C" | "Bb" | "Eb" | "F";
  transposeSemitones: number;
  clef: Clef;
  concertLow: number;
  concertHigh: number;
}

export type Articulation = "attack" | "tongued" | "legato" | "release";

export interface NoteEvent {
  kind: "noteOn" | "noteOff";
  articulation: Articulation;
  concertMidi: number;
  writtenMidi: number;
  noteName: string;
  concertName: string;
  timestampMs: number;
  clarity: number;
  frequencyHz: number;
  cents: number;
}

export interface EngineStatus {
  timestampMs: number;
  levelDb: number;
  frequencyHz: number | null;
  clarity: number | null;
  activeConcertMidi: number | null;
  activeWrittenMidi: number | null;
  cents: number | null;
}

export interface CaptureInfo {
  deviceName: string;
  sampleRate: number;
  channels: number;
  bufferFrames: number | null;
  analysisWindow: number;
  hop: number;
  bandLowHz: number;
  bandHighHz: number;
}

export interface InputDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

export type BeatsPerMeasure = 3 | 4;

/** Quantization resolution in 16th-note steps: 1 = 16th, 2 = 8th, 4 = quarter. */
export type Resolution = 1 | 2 | 4;
