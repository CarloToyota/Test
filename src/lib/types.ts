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

/** Finest rhythmic value notes snap to: a 16th, an 8th, or the beat itself. */
export type Resolution = "16th" | "8th" | "beat";
