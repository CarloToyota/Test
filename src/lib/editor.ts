// The editable score: a monophonic list of notes on the 16th-step grid, in concert pitch.
// Every operation is pure (returns a new document), which makes undo/redo trivial.
// Editing overwrites like a notation program: a longer note replaces what follows it.

import type { QNote, ScoreMeasure } from "./quantize";

export interface DocNote {
  /** Concert MIDI pitch. */
  midi: number;
  s: number;
  e: number;
}

export interface ScoreDoc {
  notes: DocNote[];
  /** Length of the score in steps (a whole number of bars when created). */
  endStep: number;
}

/** Keyboard digits for durations, as in MuseScore: 3 = 16th ... 7 = whole. */
export const DURATION_KEYS: Record<string, number> = { "3": 1, "4": 2, "5": 4, "6": 8, "7": 16 };

export const DURATION_CHOICES: Array<{ steps: number; label: string; key: string }> = [
  { steps: 1, label: "16th", key: "3" },
  { steps: 2, label: "8th", key: "4" },
  { steps: 4, label: "Quarter", key: "5" },
  { steps: 8, label: "Half", key: "6" },
  { steps: 16, label: "Whole", key: "7" },
];

const roundUp = (x: number, spm: number) => Math.max(spm, Math.ceil(x / spm) * spm);

export function docFromNotes(q: QNote[], spm: number): ScoreDoc {
  const notes = q.map(({ midi, s, e }) => ({ midi, s, e }));
  return { notes, endStep: roundUp(notes.length ? notes[notes.length - 1].e : 0, spm) };
}

/** Notes in written pitch, for layout. */
export function docToQNotes(doc: ScoreDoc, transpose: number): QNote[] {
  return doc.notes.map((n) => ({ midi: n.midi + transpose, s: n.s, e: n.e, live: false }));
}

export function noteIndexAt(doc: ScoreDoc, step: number): number {
  return doc.notes.findIndex((n) => n.s === step);
}

/** Selectable positions in score order: each note's start and each rest. */
export function selectablePositions(measures: ScoreMeasure[]): number[] {
  const out: number[] = [];
  for (const m of measures) {
    for (const it of m.items) {
      if (it.kind === "note" && it.tieFromPrev) continue;
      if (out[out.length - 1] !== it.start) out.push(it.start);
    }
  }
  return out;
}

/** Clear [s, e) of notes, trimming any that overlap it. */
function clearSpan(notes: DocNote[], s: number, e: number): DocNote[] {
  const out: DocNote[] = [];
  for (const n of notes) {
    if (n.e <= s || n.s >= e) out.push(n);
    else {
      if (n.s < s) out.push({ ...n, e: s });
      if (n.e > e) out.push({ ...n, s: e });
    }
  }
  return out;
}

function withNotes(doc: ScoreDoc, notes: DocNote[], spm: number): ScoreDoc {
  notes.sort((a, b) => a.s - b.s);
  const last = notes.length ? notes[notes.length - 1].e : 0;
  return { notes, endStep: Math.max(doc.endStep, roundUp(last, spm)) };
}

/** Write a note of `steps` at `at`, replacing whatever was there. */
export function insertNote(doc: ScoreDoc, at: number, steps: number, midi: number, spm: number): ScoreDoc {
  const notes = clearSpan(doc.notes, at, at + steps);
  notes.push({ midi, s: at, e: at + steps });
  return withNotes(doc, notes, spm);
}

/** Change the length of the note starting at `at`. Longer overwrites what follows. */
export function setDuration(doc: ScoreDoc, at: number, steps: number, spm: number): ScoreDoc {
  const i = noteIndexAt(doc, at);
  if (i < 0) return doc;
  const without = { ...doc, notes: doc.notes.filter((_, k) => k !== i) };
  return insertNote(without, at, steps, doc.notes[i].midi, spm);
}

/** Toggle a dot on the note at `at` (x1.5, or back). */
export function toggleDot(doc: ScoreDoc, at: number, spm: number): ScoreDoc {
  const i = noteIndexAt(doc, at);
  if (i < 0) return doc;
  const len = doc.notes[i].e - doc.notes[i].s;
  if ([3, 6, 12, 24].includes(len)) return setDuration(doc, at, (len * 2) / 3, spm);
  if ([2, 4, 8, 16].includes(len)) return setDuration(doc, at, len * 1.5, spm);
  return doc;
}

export function deleteNote(doc: ScoreDoc, at: number): ScoreDoc {
  const i = noteIndexAt(doc, at);
  if (i < 0) return doc;
  return { ...doc, notes: doc.notes.filter((_, k) => k !== i) };
}

export function transposeNote(doc: ScoreDoc, at: number, semitones: number): ScoreDoc {
  const i = noteIndexAt(doc, at);
  if (i < 0) return doc;
  const midi = Math.max(0, Math.min(127, doc.notes[i].midi + semitones));
  return { ...doc, notes: doc.notes.map((n, k) => (k === i ? { ...n, midi } : n)) };
}

export function setPitch(doc: ScoreDoc, at: number, midi: number): ScoreDoc {
  const i = noteIndexAt(doc, at);
  if (i < 0) return doc;
  return { ...doc, notes: doc.notes.map((n, k) => (k === i ? { ...n, midi } : n)) };
}

export function addMeasure(doc: ScoreDoc, spm: number): ScoreDoc {
  return { ...doc, endStep: roundUp(doc.endStep, spm) + spm };
}

/** Remove the last bar if it has no notes in it. */
export function removeLastMeasure(doc: ScoreDoc, spm: number): ScoreDoc {
  const end = roundUp(doc.endStep, spm);
  if (end <= spm) return doc;
  if (doc.notes.some((n) => n.e > end - spm)) return doc;
  return { ...doc, endStep: end - spm };
}
