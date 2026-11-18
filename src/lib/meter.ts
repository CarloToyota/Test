// Time signatures and their beat structure. Positions are counted in 16th-note steps.

export interface TimeSignature {
  num: number;
  den: 2 | 4 | 8;
}

export const TIME_SIGNATURES = ["2/4", "3/4", "4/4", "5/4", "2/2", "3/8", "5/8", "6/8", "7/8", "9/8", "12/8"] as const;
export type TimeSignatureName = (typeof TIME_SIGNATURES)[number];

export function parseTimeSignature(name: string): TimeSignature {
  const [n, d] = name.split("/").map(Number);
  return { num: n, den: d as 2 | 4 | 8 };
}

export function meterName(ts: TimeSignature): string {
  return `${ts.num}/${ts.den}`;
}

/** 16th-note steps in one bar. */
export function measureSteps(ts: TimeSignature): number {
  return (ts.num * 16) / ts.den;
}

/** True for 6/8, 9/8 and 12/8: the beat is a dotted quarter. */
export function isCompound(ts: TimeSignature): boolean {
  return ts.den === 8 && ts.num % 3 === 0 && ts.num > 3;
}

/** Length of the counted beat in 16th steps: quarter = 4, half = 8, dotted quarter = 6,
 *  eighth = 2 (3/8, 5/8, 7/8, counted in eighths). */
export function beatSteps(ts: TimeSignature): number {
  if (ts.den === 4) return 4;
  if (ts.den === 2) return 8;
  return isCompound(ts) ? 6 : 2;
}

/** Metronome clicks per bar. */
export function beatsPerBar(ts: TimeSignature): number {
  return measureSteps(ts) / beatSteps(ts);
}

/** Symbol for the beat unit in a tempo marking: "♩", "♩.", "𝅗𝅥" or "♪". */
export function beatUnitSymbol(ts: TimeSignature): string {
  switch (beatSteps(ts)) {
    case 8:
      return "𝅗𝅥";
    case 6:
      return "♩.";
    case 2:
      return "♪";
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
