// Time signatures and their beat structure. Positions are counted in 16th-note steps.

export type Denominator = 2 | 4 | 8 | 16;

export interface TimeSignature {
  num: number;
  den: Denominator;
  /** Optional additive grouping in denominator units, e.g. [2, 2, 3] for 7/8.
   *  When set, the beat is the denominator note, beams follow the groups and the
   *  metronome accents each group's first beat. */
  groups?: number[];
}

/** Common meters offered directly; anything else is entered as a custom meter. */
export const TIME_SIGNATURES = ["2/4", "3/4", "4/4", "5/4", "2/2", "3/8", "5/8", "6/8", "7/8", "9/8", "12/8"] as const;
export const DENOMINATORS: Denominator[] = [2, 4, 8, 16];

/** Parse "7/8", "7/8 2+2+3" or "2+2+3/8". Returns null if it isn't a usable meter. */
export function parseMeter(text: string): TimeSignature | null {
  const t = text.trim().replace(/\s+/g, " ");
  let m = /^(\d+(?:\+\d+)*)\s*\/\s*(\d+)(?:\s+(\d+(?:\+\d+)+))?$/.exec(t);
  if (!m) m = /^(\d+)\s*\/\s*(\d+)\s*\((\d+(?:\+\d+)+)\)$/.exec(t);
  if (!m) return null;
  const den = Number(m[2]);
  if (!DENOMINATORS.includes(den as Denominator)) return null;
  const additiveNum = m[1].includes("+") ? m[1].split("+").map(Number) : null;
  const num = additiveNum ? additiveNum.reduce((a, b) => a + b, 0) : Number(m[1]);
  const groups = additiveNum ?? (m[3] ? m[3].split("+").map(Number) : undefined);
  if (num < 1 || num > 32) return null;
  if (groups && (groups.some((g) => g < 1) || groups.reduce((a, b) => a + b, 0) !== num)) return null;
  return { num, den: den as Denominator, ...(groups && groups.length > 1 ? { groups } : {}) };
}

/** Compatibility helper for the fixed list. */
export function parseTimeSignature(name: string): TimeSignature {
  return parseMeter(name) ?? { num: 4, den: 4 };
}

/** "7/8" or "7/8 (2+2+3)". */
export function meterName(ts: TimeSignature): string {
  return ts.groups ? `${ts.num}/${ts.den} (${ts.groups.join("+")})` : `${ts.num}/${ts.den}`;
}

/** The time signature as VexFlow draws it ("7/8"). */
export function meterGlyph(ts: TimeSignature): string {
  return `${ts.num}/${ts.den}`;
}

/** Steps (16ths) in one denominator unit. */
export function unitSteps(ts: TimeSignature): number {
  return 16 / ts.den;
}

/** 16th-note steps in one bar. */
export function measureSteps(ts: TimeSignature): number {
  return ts.num * unitSteps(ts);
}

/** True for 6/8, 9/8, 12/8 (and 6/16 ...) without a custom grouping: dotted beats. */
export function isCompound(ts: TimeSignature): boolean {
  return !ts.groups && (ts.den === 8 || ts.den === 16) && ts.num % 3 === 0 && ts.num > 3;
}

/** Length of the counted beat in steps: quarter = 4, half = 8, dotted quarter = 6,
 *  eighth = 2, 16th = 1. */
export function beatSteps(ts: TimeSignature): number {
  if (isCompound(ts)) return 3 * unitSteps(ts);
  return unitSteps(ts);
}

/** Metronome clicks per bar. */
export function beatsPerBar(ts: TimeSignature): number {
  return measureSteps(ts) / beatSteps(ts);
}

/** Group lengths (steps) used for beaming and for keeping groups visible in rhythms. */
export function groupSteps(ts: TimeSignature): number[] {
  const u = unitSteps(ts);
  if (ts.groups) return ts.groups.map((g) => g * u);
  if (ts.den === 4) return Array(ts.num).fill(4);
  if (ts.den === 2) return Array(ts.num * 2).fill(4);
  if (ts.num % 3 === 0) return Array(ts.num / 3).fill(3 * u);
  if (ts.num === 5) return [3 * u, 2 * u];
  if (ts.num === 7) return [2 * u, 2 * u, 3 * u];
  // Other odd x/8 or x/16: threes, finishing with a two or four.
  const out: number[] = [];
  let left = ts.num;
  while (left > 4) {
    out.push(3 * u);
    left -= 3;
  }
  out.push(left * u);
  return out;
}

/** Accent per click: 2 = downbeat, 1 = start of a group, 0 = other beats. */
export function metronomePattern(ts: TimeSignature): number[] {
  const clicks = beatsPerBar(ts);
  const pattern = Array(clicks).fill(0);
  pattern[0] = 2;
  if (ts.groups) {
    let at = 0;
    for (const g of ts.groups.slice(0, -1)) {
      at += g;
      pattern[at] = 1;
    }
  } else if (beatSteps(ts) <= 2 && ts.num > 3) {
    // x/8 counted in eighths: accent the groups (5/8 = 3+2, 7/8 = 2+2+3).
    let at = 0;
    for (const g of groupSteps(ts).slice(0, -1)) {
      at += g / beatSteps(ts);
      pattern[at] = 1;
    }
  }
  return pattern;
}

/** Symbol for the beat unit in a tempo marking. */
export function beatUnitSymbol(ts: TimeSignature): string {
  switch (beatSteps(ts)) {
    case 8:
      return "𝅗𝅥";
    case 6:
      return "♩.";
    case 3:
      return "♪.";
    case 2:
      return "♪";
    case 1:
      return "𝅘𝅥𝅯";
    default:
      return "♩";
  }
}

/** Snapping levels from coarsest (the beat) down to `finest` steps. */
export function gridLevels(ts: TimeSignature, finest: number): number[] {
  const beat = beatSteps(ts);
  const levels = [beat];
  for (const l of [4, 2, 1]) {
    if (l < beat && beat % l === 0 && l >= finest) levels.push(l);
  }
  if (levels[levels.length - 1] !== finest && finest < beat) levels.push(finest);
  return levels;
}

/** Quarter notes per minute, for MIDI and MusicXML `tempo`. */
export function quarterBpm(bpm: number, ts: TimeSignature): number {
  return (bpm * beatSteps(ts)) / 4;
}

/** The inverse: tempo in this meter's beat from quarter notes per minute. */
export function bpmFromQuarter(qpm: number, ts: TimeSignature): number {
  return Math.round(((qpm * 4) / beatSteps(ts)) * 10) / 10;
}
