// Matching an imported part to one of the app's instruments.

import type { InstrumentId } from "../types";

const NAME_RULES: Array<[RegExp, InstrumentId]> = [
  [/bari(tone)?\s*sax|bari\b|b\.\s*sx/i, "bariSax"],
  [/tenor\s*sax|ten(or)?\.?\s*sx|t\.\s*sx/i, "tenorSax"],
  [/alto\s*sax|alto\s*sx|a\.\s*sx/i, "altoSax"],
  [/sax/i, "altoSax"],
  [/trumpet|tpt|cornet|flugel/i, "trumpet"],
  [/horn|\bhn\b/i, "frenchHorn"],
  [/trombone|tbn|\bbone/i, "trombone"],
  [/euphonium|baritone/i, "trombone"],
  [/tuba|sousa|\btba\b/i, "tuba"],
  [/flute|picc|\bfl\b/i, "flute"],
  [/clarinet|\bcl\b/i, "clarinet"],
];

const GM: Record<number, InstrumentId> = {
  56: "trumpet", 57: "trombone", 58: "tuba", 59: "trumpet", 60: "frenchHorn", 61: "trumpet",
  64: "altoSax", 65: "altoSax", 66: "tenorSax", 67: "bariSax",
  68: "flute", 69: "frenchHorn", 70: "bariSax", 71: "clarinet", 72: "flute", 73: "flute", 74: "flute", 75: "flute",
};

export function instrumentFromName(name: string): InstrumentId | null {
  for (const [re, id] of NAME_RULES) if (re.test(name)) return id;
  return null;
}

/** From a MusicXML <transpose> (written -> concert): chromatic and octave-change. */
export function instrumentFromTranspose(chromatic: number, octave: number): InstrumentId | null {
  const total = chromatic + 12 * octave;
  if (total === -14) return "tenorSax";
  if (total === -21) return "bariSax";
  if (total === -9) return "altoSax";
  if (total === -2) return "trumpet";
  if (total === -7) return "frenchHorn";
  return null;
}

export function instrumentFromProgram(program: number): InstrumentId | null {
  return GM[program] ?? null;
}

/** Last resort: by range (concert pitch) and clef. */
export function instrumentFromRange(concertMidis: number[], bassClef: boolean): InstrumentId {
  if (concertMidis.length === 0) return bassClef ? "trombone" : "flute";
  const sorted = [...concertMidis].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median >= 67) return "flute";
  if (median >= 58) return bassClef ? "trombone" : "trumpet";
  if (median >= 50) return bassClef ? "trombone" : "tenorSax";
  if (median >= 41) return "trombone";
  return "tuba";
}
