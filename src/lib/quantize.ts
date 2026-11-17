// Turns timed notes into measures of notated durations (with rests and ties).
// Internally everything is counted in 16th-note steps.

import type { BeatsPerMeasure, Resolution } from "./types";

export interface TimedNote {
  /** Written MIDI pitch. */
  midi: number;
  /** Milliseconds from the grid origin (downbeat of bar 1). */
  startMs: number;
  endMs: number;
  /** Still sounding: rendered with the live highlight. */
  live: boolean;
}

export type VexDuration = "w" | "h" | "q" | "8" | "16";

export interface ScoreItem {
  kind: "note" | "rest";
  midi: number;
  duration: VexDuration;
  dots: 0 | 1;
  /** Tie this item to the next note item (across barlines too). */
  tieToNext: boolean;
  live: boolean;
  /** Whole-measure rest: drawn centred, whatever the meter. */
  measureRest: boolean;
}

export interface ScoreMeasure {
  items: ScoreItem[];
  complete: boolean;
}

export interface QuantizeOptions {
  bpm: number;
  beatsPerMeasure: BeatsPerMeasure;
  resolution: Resolution;
}

/** Notes shorter than this (ms) are treated as glitches and dropped. */
const MIN_NOTE_MS = 30;

const STEP_VALUES: Array<{ steps: number; duration: VexDuration; dots: 0 | 1 }> = [
  { steps: 16, duration: "w", dots: 0 },
  { steps: 12, duration: "h", dots: 1 },
  { steps: 8, duration: "h", dots: 0 },
  { steps: 6, duration: "q", dots: 1 },
  { steps: 4, duration: "q", dots: 0 },
  { steps: 3, duration: "8", dots: 1 },
  { steps: 2, duration: "8", dots: 0 },
  { steps: 1, duration: "16", dots: 0 },
];

/** Whether a value of `steps` may start at `pos` (steps into the measure) without
 *  hiding the beat, following common engraving practice. */
function allowedAt(steps: number, pos: number, stepsPerMeasure: number): boolean {
  switch (steps) {
    case 16:
      return pos === 0 && stepsPerMeasure >= 16;
    case 12:
      return pos % 4 === 0;
    case 8:
      // Half notes on beats 1 or 3 in 4/4; on any beat in 3/4.
      return stepsPerMeasure === 12 ? pos % 4 === 0 : pos % 8 === 0;
    case 6:
    case 4:
      return pos % 2 === 0;
    case 3:
      return pos % 4 === 0;
    case 2:
      return pos % 2 === 0 || pos % 4 === 1;
    default:
      return true;
  }
}

/** Split `len` steps starting at `pos` into notatable values. A span that starts and
 *  ends on beats is written in beat-multiples (q~q, not q.~8), and rests are never
 *  dotted. */
export function decompose(pos: number, len: number, stepsPerMeasure: number, isRest = false) {
  const pieces: Array<{ steps: number; duration: VexDuration; dots: 0 | 1 }> = [];
  let p = pos;
  let remaining = len;
  while (remaining > 0) {
    const grain = p % 4 === 0 && remaining % 4 === 0 ? 4 : p % 2 === 0 && remaining % 2 === 0 ? 2 : 1;
    const v =
      STEP_VALUES.find(
        (v) =>
          v.steps <= remaining &&
          v.steps % grain === 0 &&
          !(isRest && v.dots) &&
          allowedAt(v.steps, p, stepsPerMeasure),
      ) ?? STEP_VALUES[STEP_VALUES.length - 1];
    pieces.push(v);
    p += v.steps;
    remaining -= v.steps;
  }
  return pieces;
}

interface QNote {
  midi: number;
  s: number;
  e: number;
  live: boolean;
}

export function stepMs(bpm: number): number {
  return 60000 / bpm / 4;
}

// ---- Rhythm interpretation -------------------------------------------------------
//
// Notation records where notes *start*; how long a wind player lets a note ring is
// mostly articulation. A staccato quarter sounds for about 40% of the beat but is
// still written as a quarter. So:
//
// 1. Timing alignment. A steady early or late lean (audio latency, rushing, dragging)
//    is measured against the 8th-note grid over nearby notes and removed first.
// 2. Hierarchical snapping. An onset snaps to the beat if close enough, else to the
//    nearest 8th, and only then to the nearest 16th, so slightly late quarters never
//    become 16th-note syncopations.
// 3. Durations run to the next attack. A note shorter than a beat is written up to the
//    next beat (or the next note, if sooner); a rest appears only for real silence.

/** Onsets within this many beats of a beat snap to it. */
const BEAT_SNAP = 0.18;
/** Onsets within this many beats of an 8th position snap to it. */
const EIGHTH_SNAP = 0.12;
/** Largest steady timing offset the alignment corrects, in beats. */
const MAX_ALIGN = 0.2;
/** Neighbouring onsets on each side used to estimate the local offset. */
const ALIGN_WINDOW = 6;

/** Snap a position in beats to the simplest metric position near it; returns 16th steps. */
export function snapBeats(beats: number, resolution: Resolution): number {
  const beat = Math.round(beats);
  if (resolution === 4 || Math.abs(beats - beat) <= BEAT_SNAP) return beat * 4;
  const eighth = Math.round(beats * 2) / 2;
  if (resolution === 2 || Math.abs(beats - eighth) <= EIGHTH_SNAP) return eighth * 4;
  return Math.round(beats * 4);
}

/** The steady offset (in beats) of these onsets from the 8th-note grid. Robust: notes
 *  far off the 8th grid (real 16ths, swing) add a capped constant cost, and a small
 *  penalty keeps it at 0 unless the evidence is consistent. */
export function estimateOffset(onsetBeats: number[]): number {
  if (onsetBeats.length < 3) return 0;
  const steps = 40;
  let best = 0;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let k = -steps; k <= steps; k++) {
    const d = (k / steps) * MAX_ALIGN;
    let cost = onsetBeats.length * 0.02 * Math.abs(d);
    for (const t of onsetBeats) {
      const x = (t - d) * 2;
      cost += Math.min(Math.abs(x - Math.round(x)) / 2, 0.125);
    }
    if (cost < bestCost - 1e-9) {
      bestCost = cost;
      best = d;
    }
  }
  return best;
}

/** Interpret timed notes as notated rhythm in 16th steps (the engine is monophonic). */
export function quantizeNotes(notes: TimedNote[], opts: QuantizeOptions): QNote[] {
  const res = opts.resolution;
  const beatMs = 60000 / opts.bpm;
  const sorted = notes
    .filter((n) => n.live || n.endMs - n.startMs >= MIN_NOTE_MS)
    .sort((a, b) => a.startMs - b.startMs);
  const onsets = sorted.map((n) => n.startMs / beatMs);
  const offsets = onsets.map((_, i) =>
    estimateOffset(onsets.slice(Math.max(0, i - ALIGN_WINDOW), i + ALIGN_WINDOW + 1)),
  );
  const starts = onsets.map((t, i) => snapBeats(t - offsets[i], res));

  const q: QNote[] = [];
  sorted.forEach((n, i) => {
    let s = starts[i];
    const endBeats = n.endMs / beatMs - offsets[i];
    let e: number;
    if (n.live) {
      e = Math.round((endBeats * 4) / res) * res;
    } else {
      const next = i + 1 < starts.length ? starts[i + 1] : Number.POSITIVE_INFINITY;
      const sounded = Math.max(snapBeats(endBeats, res), s + res);
      // Shorter than a beat: articulation, so hold it to the next beat or next attack.
      const written = sounded - s < 4 ? Math.ceil(sounded / 4) * 4 : sounded;
      e = Math.min(written, next);
    }
    if (e <= s) e = s + res;
    if (e <= 0) return;
    s = Math.max(0, s);
    const prev = q[q.length - 1];
    if (prev && s <= prev.s) {
      // Two attacks in one grid slot: keep the longer note.
      if (e - s > prev.e - prev.s) q[q.length - 1] = { midi: n.midi, s: prev.s, e, live: n.live };
      return;
    }
    if (prev && s < prev.e) prev.e = s;
    q.push({ midi: n.midi, s, e, live: n.live });
  });
  return q;
}

/** Build measures from notes, covering the timeline up to `nowMs`. */
export function buildScore(notes: TimedNote[], nowMs: number, opts: QuantizeOptions): ScoreMeasure[] {
  const q = quantizeNotes(notes, opts);
  const spm = opts.beatsPerMeasure * 4;
  const nowStep = Math.max(0, Math.floor(nowMs / stepMs(opts.bpm)));
  const endStep = Math.max(nowStep, q.length ? q[q.length - 1].e : 0);
  const measureCount = Math.max(1, Math.ceil(endStep / spm));

  const measures: ScoreMeasure[] = [];
  let ni = 0;
  for (let m = 0; m < measureCount; m++) {
    const ms = m * spm;
    const me = ms + spm;
    const complete = endStep >= me;
    const visibleEnd = Math.min(me, endStep);
    const items: ScoreItem[] = [];
    let cursor = ms;

    const pushRest = (from: number, to: number) => {
      for (const p of decompose(from - ms, to - from, spm, true)) {
        items.push({ kind: "rest", midi: 0, duration: p.duration, dots: p.dots, tieToNext: false, live: false, measureRest: false });
      }
    };

    while (ni < q.length && q[ni].e <= ms) ni++;
    for (let j = ni; j < q.length && q[j].s < me; j++) {
      const n = q[j];
      const s = Math.max(n.s, ms);
      const e = Math.min(n.e, me);
      if (s > cursor) pushRest(cursor, s);
      const pieces = decompose(s - ms, e - s, spm);
      pieces.forEach((p, k) => {
        const last = k === pieces.length - 1;
        items.push({
          kind: "note",
          midi: n.midi,
          duration: p.duration,
          dots: p.dots,
          tieToNext: !last || n.e > me,
          live: n.live,
          measureRest: false,
        });
      });
      cursor = e;
    }
    if (cursor < visibleEnd) pushRest(cursor, visibleEnd);

    if (complete && items.every((i) => i.kind === "rest")) {
      measures.push({
        complete,
        items: [{ kind: "rest", midi: 0, duration: "w", dots: 0, tieToNext: false, live: false, measureRest: true }],
      });
    } else {
      measures.push({ complete, items });
    }
  }
  return measures;
}

/** A cheap fingerprint so the renderer only redraws when the notation changes. */
export function scoreSignature(measures: ScoreMeasure[]): string {
  return measures
    .map((m) => (m.complete ? "|" : ":") + m.items.map((i) => `${i.kind[0]}${i.midi}${i.duration}${i.dots}${i.tieToNext ? "~" : ""}${i.live ? "*" : ""}`).join(","))
    .join("");
}
