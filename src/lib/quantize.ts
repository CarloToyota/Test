// Rhythm: interpreting timed notes as notated rhythm, then laying that rhythm out in
// measures of notated durations (rests, dots, ties). Positions are in 16th-note steps.

import { beatSteps, gridLevels, groupSteps, measureSteps, type TimeSignature } from "./meter";
import type { Resolution } from "./types";

export interface TimedNote {
  midi: number;
  /** Milliseconds from the grid origin (downbeat of bar 1). */
  startMs: number;
  endMs: number;
  /** Still sounding: rendered with the live highlight. */
  live: boolean;
}

/** A note placed on the grid: steps [s, e). */
export interface QNote {
  midi: number;
  s: number;
  e: number;
  live: boolean;
}

export type VexDuration = "w" | "h" | "q" | "8" | "16";

export interface ScoreItem {
  kind: "note" | "rest";
  midi: number;
  duration: VexDuration;
  dots: 0 | 1;
  /** Absolute position and length of this item, in steps. */
  start: number;
  steps: number;
  /** Index of the note in the laid-out note list, or -1 for a rest. */
  noteIndex: number;
  /** Tied to the next / from the previous piece of the same note. */
  tieToNext: boolean;
  tieFromPrev: boolean;
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
  timeSig: TimeSignature;
  resolution: Resolution;
}

/** Notes shorter than this (ms) are treated as glitches and dropped. */
const MIN_NOTE_MS = 30;

/** Finest snapping level in steps for a resolution setting. */
export function resolutionSteps(res: Resolution, ts: TimeSignature): number {
  return res === "16th" ? 1 : res === "8th" ? 2 : beatSteps(ts);
}

/** Milliseconds per 16th step. */
export function stepMs(bpm: number, ts: TimeSignature): number {
  return 60000 / bpm / beatSteps(ts);
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
//    next level down (8th, or quarter in cut time), and only then to the 16th, so
//    slightly late quarters never become 16th-note syncopations.
// 3. Durations run to the next attack. A note shorter than a beat is written up to the
//    next beat (or the next note, if sooner); a rest appears only for real silence.

/** Rhythm-reading parameters (tuned on recorded playing; tests may adjust them). */
export const RHYTHM = {
  /** Snap tolerance for the beat level, as a fraction of the beat. */
  beatSnap: 0.18,
  /** Snap tolerance for subdivision levels, as a fraction of the level. */
  subSnap: 0.24,
  /** Largest steady timing offset the alignment corrects, in steps. */
  maxAlign: 0.8,
  /** Neighbouring onsets on each side used to estimate the local offset. */
  alignWindow: 6,
  /** Cost per step of offset per onset: how much evidence a correction needs. */
  alignPenalty: 0.06,
  /** Hold notes of any length to the next beat (not only notes shorter than a beat). */
  holdToBeat: true,
  /** A note may snap at most this fraction of the gap to its nearest neighbouring attack. */
  densityTol: 0.45,
};

/** Snap a position (steps) to the simplest metric level that explains it. `maxTol`
 *  caps how far a note may move: in a run of fast notes a coarse level must not pull
 *  a note onto its neighbour's slot. */
export function snapSteps(t: number, levels: number[], maxTol = Number.POSITIVE_INFINITY): number {
  for (let i = 0; i < levels.length - 1; i++) {
    const l = levels[i];
    const nearest = Math.round(t / l) * l;
    const tol = Math.min(maxTol, i === 0 && l >= 4 ? RHYTHM.beatSnap * l : RHYTHM.subSnap * l);
    if (Math.abs(t - nearest) <= tol) return nearest;
  }
  const f = levels[levels.length - 1];
  return Math.round(t / f) * f;
}

/** The steady offset (in steps) of these onsets from the 8th-note grid. Robust: notes
 *  far off the 8th grid (real 16ths, swing) add a capped constant cost, and a small
 *  penalty keeps it at 0 unless the evidence is consistent. */
export function estimateOffset(onsetSteps: number[]): number {
  if (onsetSteps.length < 3) return 0;
  const n = 40;
  let best = 0;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let k = -n; k <= n; k++) {
    const d = (k / n) * RHYTHM.maxAlign;
    let cost = onsetSteps.length * RHYTHM.alignPenalty * Math.abs(d);
    for (const t of onsetSteps) {
      const x = (t - d) / 2;
      cost += Math.min(Math.abs(x - Math.round(x)) * 2, 0.5);
    }
    if (cost < bestCost - 1e-9) {
      bestCost = cost;
      best = d;
    }
  }
  return best;
}

/** Notes shorter than this that touch a neighbour are attack transients (the pitch
 *  settling as the note speaks, a tongue blip), not notes: they join the neighbour. */
const BLIP_MS = 60;
/** "Touching": no more silence than this between them. */
const TOUCH_MS = 20;

/** Fold transient blips into the note they belong to; drop isolated glitches. */
export function mergeBlips(notes: TimedNote[]): TimedNote[] {
  const out = notes.map((n) => ({ ...n })).sort((a, b) => a.startMs - b.startMs);
  for (let i = 0; i < out.length; i++) {
    const n = out[i];
    if (n.live || n.endMs - n.startMs >= BLIP_MS) continue;
    const next = out[i + 1];
    const prev = out[i - 1];
    if (next && next.startMs - n.endMs <= TOUCH_MS) {
      next.startMs = n.startMs; // the blip was the start of the next note
    } else if (prev && n.startMs - prev.endMs <= TOUCH_MS) {
      prev.endMs = Math.max(prev.endMs, n.endMs); // the tail of the previous note
    } else if (n.endMs - n.startMs >= MIN_NOTE_MS) {
      continue; // a short but separate note
    }
    out.splice(i, 1);
    i--;
  }
  return out;
}

/** Interpret timed notes as notated rhythm (the engine is monophonic). */
export function quantizeNotes(notes: TimedNote[], opts: QuantizeOptions): QNote[] {
  const ts = opts.timeSig;
  const beat = beatSteps(ts);
  const finest = resolutionSteps(opts.resolution, ts);
  const levels = gridLevels(ts, finest);
  const step = stepMs(opts.bpm, ts);
  const sorted = mergeBlips(notes);
  const onsets = sorted.map((n) => n.startMs / step);
  const offsets = onsets.map((_, i) =>
    estimateOffset(onsets.slice(Math.max(0, i - RHYTHM.alignWindow), i + RHYTHM.alignWindow + 1)),
  );
  // A steady lean changes slowly: smooth each note's estimate with its neighbours'
  // (a median, so one ambiguous window can't flip a note).
  const smooth = offsets.map((_, i) => {
    const w = offsets.slice(Math.max(0, i - 2), i + 3).sort((a, b) => a - b);
    return w[Math.floor(w.length / 2)];
  });
  const aligned = onsets.map((t, i) => t - smooth[i]);
  const starts = aligned.map((t, i) => {
    const gap = Math.min(
      i > 0 ? t - aligned[i - 1] : Number.POSITIVE_INFINITY,
      i + 1 < aligned.length ? aligned[i + 1] - t : Number.POSITIVE_INFINITY,
    );
    return snapSteps(t, levels, RHYTHM.densityTol * gap);
  });
  // A later attack never shares or precedes its predecessor's slot.
  for (let i = 1; i < starts.length; i++) {
    if (starts[i] <= starts[i - 1] && onsets[i] - onsets[i - 1] >= 0.5 * finest) starts[i] = starts[i - 1] + finest;
  }

  const q: QNote[] = [];
  sorted.forEach((n, i) => {
    let s = starts[i];
    const end = n.endMs / step - smooth[i];
    let e: number;
    if (n.live) {
      e = Math.round(end / finest) * finest;
    } else {
      const next = i + 1 < starts.length ? starts[i + 1] : Number.POSITIVE_INFINITY;
      const sounded = Math.max(snapSteps(end, levels), s + finest);
      // Players lift before a note's written end (staccato, breaths). Hold the note to
      // the next beat (or the next attack, if sooner); only silence that covers a
      // whole beat is written as a rest.
      const written = RHYTHM.holdToBeat || sounded - s < beat ? Math.ceil(sounded / beat) * beat : sounded;
      e = Math.min(written, next);
    }
    if (e <= s) e = s + finest;
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

// ---- Engraving: steps -> notated durations -----------------------------------------

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

/** Notated value for an exact length in steps, if a single one exists. */
export function valueForSteps(steps: number) {
  return STEP_VALUES.find((v) => v.steps === steps) ?? null;
}

/** Whether a value of `v` steps may start at `p` (steps into the bar) without hiding
 *  the beat, following common engraving practice for each kind of meter. */
function allowedAt(v: number, p: number, spm: number, beat: number, groups: number[]): boolean {
  if (p + v > spm) return false;
  if (v === spm) return p === 0;
  if (beat <= 3) {
    // Eighth- or 16th-based meters (3/8, 5/8, 7/8, custom groupings): a value either
    // fits inside one group or spans whole groups from a group boundary.
    let start = 0;
    for (const g of groups) {
      const end = start + g;
      if (p >= start && p < end) {
        if (p + v <= end) return true;
        break;
      }
      start = end;
    }
    const bounds = new Set<number>([0]);
    let acc = 0;
    for (const g of groups) bounds.add((acc += g));
    return bounds.has(p) && bounds.has(p + v);
  }
  const beats = spm / beat;
  // In 4/4 and 12/8, a note that starts mid-bar doesn't cross the middle of the bar.
  const mid = beats % 2 === 0 && beats >= 4 ? spm / 2 : -1;
  if (mid > 0 && p < mid && p + v > mid && p !== 0) return false;

  switch (beat) {
    case 6: // compound: 6/8, 9/8, 12/8
      if (v === 16 || v === 8) return false;
      if (v === 12 || v === 6 || v === 3) return p % 6 === 0;
      if (v === 4) return p % 6 === 0 || p % 6 === 2;
      if (v === 2) return p % 2 === 0;
      return true;
    case 8: // cut time
      if (v === 16) return p === 0;
      if (v === 12 || v === 8) return p % 8 === 0;
      if (v === 6 || v === 4) return p % 2 === 0;
      if (v === 3) return p % 4 === 0;
      if (v === 2) return p % 2 === 0 || p % 4 === 1;
      return true;
    default: // simple quarter-note meters
      if (v === 16) return p === 0;
      if (v === 12) return p % 4 === 0;
      if (v === 8) return beats % 2 === 0 ? p % 8 === 0 : p % 4 === 0;
      if (v === 6 || v === 4) return p % 2 === 0;
      if (v === 3) return p % 4 === 0;
      if (v === 2) return p % 2 === 0 || p % 4 === 1;
      return true;
  }
}

/** Split `len` steps starting at `pos` (steps into the bar) into notatable values. A
 *  span that starts and ends on beats is written in beat units (q~q, not q.~8). Rests
 *  are only dotted where that is the convention (a dotted-quarter beat in compound
 *  meter). */
export function decompose(
  pos: number,
  len: number,
  spm: number,
  beat: number,
  isRest = false,
  groups: number[] = Array(Math.max(1, Math.round(spm / beat))).fill(beat),
) {
  const pieces: Array<{ steps: number; duration: VexDuration; dots: 0 | 1 }> = [];
  const fillsGroup = (at: number, v: number) => {
    let start = 0;
    for (const g of groups) {
      if (start === at && g === v) return true;
      start += g;
    }
    return false;
  };
  let p = pos;
  let remaining = len;
  while (remaining > 0) {
    const grain = p % beat === 0 && remaining % beat === 0 ? beat : p % 2 === 0 && remaining % 2 === 0 ? 2 : 1;
    // Dotted rests only where they fill a whole dotted beat or group (6/8 beat, a 3 in 2+2+3).
    const restOk = (v: { steps: number; dots: number }) =>
      !(isRest && v.dots) || (beat === 6 && v.steps === 6) || fillsGroup(p, v.steps);
    const v =
      STEP_VALUES.find((v) => v.steps <= remaining && v.steps % grain === 0 && restOk(v) && allowedAt(v.steps, p, spm, beat, groups)) ??
      STEP_VALUES.find((v) => v.steps <= remaining && restOk(v) && allowedAt(v.steps, p, spm, beat, groups)) ??
      STEP_VALUES.find((v) => v.steps <= remaining && restOk(v)) ??
      STEP_VALUES[STEP_VALUES.length - 1];
    pieces.push(v);
    p += v.steps;
    remaining -= v.steps;
  }
  return pieces;
}

/** Lay notes out in measures up to `endStep`. Rests fill the gaps. */
export function layoutMeasures(q: QNote[], endStep: number, ts: TimeSignature): ScoreMeasure[] {
  const spm = measureSteps(ts);
  const beat = beatSteps(ts);
  const groups = groupSteps(ts);
  const last = Math.max(endStep, q.length ? q[q.length - 1].e : 0);
  const measureCount = Math.max(1, Math.ceil(last / spm));

  const restItem = (start: number, steps: number, duration: VexDuration, dots: 0 | 1, measureRest = false): ScoreItem => ({
    kind: "rest", midi: 0, duration, dots, start, steps, noteIndex: -1,
    tieToNext: false, tieFromPrev: false, live: false, measureRest,
  });

  const measures: ScoreMeasure[] = [];
  let ni = 0;
  for (let m = 0; m < measureCount; m++) {
    const ms = m * spm;
    const me = ms + spm;
    const complete = last >= me;
    const visibleEnd = Math.min(me, last);
    const items: ScoreItem[] = [];
    let cursor = ms;

    const pushRest = (from: number, to: number) => {
      let at = from;
      for (const p of decompose(from - ms, to - from, spm, beat, true, groups)) {
        items.push(restItem(at, p.steps, p.duration, p.dots));
        at += p.steps;
      }
    };

    while (ni < q.length && q[ni].e <= ms) ni++;
    for (let j = ni; j < q.length && q[j].s < me; j++) {
      const n = q[j];
      const s = Math.max(n.s, ms);
      const e = Math.min(n.e, me);
      if (e <= s) continue;
      if (s > cursor) pushRest(cursor, s);
      const pieces = decompose(s - ms, e - s, spm, beat, false, groups);
      let at = s;
      pieces.forEach((p, k) => {
        items.push({
          kind: "note",
          midi: n.midi,
          duration: p.duration,
          dots: p.dots,
          start: at,
          steps: p.steps,
          noteIndex: j,
          tieToNext: k < pieces.length - 1 || n.e > me,
          tieFromPrev: k > 0 || n.s < ms,
          live: n.live,
          measureRest: false,
        });
        at += p.steps;
      });
      cursor = e;
    }
    if (cursor < visibleEnd) pushRest(cursor, visibleEnd);

    if (complete && items.every((i) => i.kind === "rest")) {
      measures.push({ complete, items: [restItem(ms, spm, "w", 0, true)] });
    } else {
      measures.push({ complete, items });
    }
  }
  return measures;
}

/** Live view: interpret and lay out, covering the timeline up to `nowMs`. */
export function buildScore(notes: TimedNote[], nowMs: number, opts: QuantizeOptions): ScoreMeasure[] {
  const q = quantizeNotes(notes, opts);
  const nowStep = Math.max(0, Math.floor(nowMs / stepMs(opts.bpm, opts.timeSig)));
  return layoutMeasures(q, nowStep, opts.timeSig);
}

/** A cheap fingerprint so the renderer only redraws when the notation changes. */
export function scoreSignature(measures: ScoreMeasure[]): string {
  return measures
    .map((m) => (m.complete ? "|" : ":") + m.items.map((i) => `${i.kind[0]}${i.midi}${i.duration}${i.dots}${i.tieToNext ? "~" : ""}${i.live ? "*" : ""}`).join(","))
    .join("");
}
