// A project: a score with any number of parts, each an editable monophonic line.
// Everything is plain data (JSON-serialisable) so it saves to disk and undoes as a whole.

import type { ScoreDoc } from "./editor";
import { measureSteps, type TimeSignature } from "./meter";
import type { InstrumentId, InstrumentInfo } from "./types";

export interface Part {
  id: string;
  instrument: InstrumentId;
  /** Display name; empty means "use the instrument name (numbered if repeated)". */
  name: string;
  doc: ScoreDoc;
  muted: boolean;
  /** Playback volume 0..1. */
  volume: number;
}

export interface Project {
  title: string;
  /** Concert key of the piece; each part shows its own written key. */
  concertKey: string;
  timeSig: TimeSignature;
  /** Tempo in beats of `timeSig` per minute. */
  bpm: number;
  parts: Part[];
}

/** Conventional concert-band score order. */
export const SCORE_ORDER: InstrumentId[] = [
  "flute", "clarinet", "altoSax", "tenorSax", "bariSax", "trumpet", "frenchHorn", "trombone", "tuba",
];

const SHORT: Record<InstrumentId, string> = {
  flute: "Fl.", clarinet: "Cl.", altoSax: "A. Sx.", tenorSax: "T. Sx.", bariSax: "B. Sx.",
  trumpet: "Tpt.", frenchHorn: "Hn.", trombone: "Tbn.", tuba: "Tba.",
};

let counter = 0;
export function newId(): string {
  counter += 1;
  return `p${Date.now().toString(36)}${counter.toString(36)}`;
}

export function emptyProject(instrument: InstrumentId = "altoSax"): Project {
  return {
    title: "Untitled",
    concertKey: "Bb",
    timeSig: { num: 4, den: 4 },
    bpm: 100,
    parts: [newPart(instrument, 4 * 16)],
  };
}

export function newPart(instrument: InstrumentId, endStep: number): Part {
  return { id: newId(), instrument, name: "", doc: { notes: [], endStep }, muted: false, volume: 0.8 };
}

/** Length of the score in steps: whole bars covering every part. */
export function projectEndStep(p: Project): number {
  const spm = measureSteps(p.timeSig);
  const last = Math.max(spm, ...p.parts.map((x) => Math.max(x.doc.endStep, x.doc.notes.length ? x.doc.notes[x.doc.notes.length - 1].e : 0)));
  return Math.ceil(last / spm) * spm;
}

/** Parts in score order (stable for repeated instruments). */
export function scoreOrder(parts: Part[]): Part[] {
  return [...parts].sort((a, b) => SCORE_ORDER.indexOf(a.instrument) - SCORE_ORDER.indexOf(b.instrument));
}

/** "Trumpet 1", "Trumpet 2" ... when an instrument appears more than once. */
export function partLabel(p: Project, part: Part, infos: InstrumentInfo[], short = false): string {
  const info = infos.find((i) => i.id === part.instrument);
  const base = short ? SHORT[part.instrument] : (info?.name ?? part.instrument);
  if (part.name) return short ? part.name.slice(0, 8) : part.name;
  const same = scoreOrder(p.parts).filter((x) => x.instrument === part.instrument && !x.name);
  return same.length > 1 ? `${base} ${same.indexOf(part) + 1}` : base;
}

export function updatePart(p: Project, id: string, change: (part: Part) => Part): Project {
  return { ...p, parts: p.parts.map((x) => (x.id === id ? change(x) : x)) };
}

/** Pad every part to the project length (so all staves have the same bars). */
export function normalizeLengths(p: Project): Project {
  const end = projectEndStep(p);
  if (p.parts.every((x) => x.doc.endStep === end)) return p;
  return { ...p, parts: p.parts.map((x) => ({ ...x, doc: { ...x.doc, endStep: end } })) };
}

// ---- project files -----------------------------------------------------------------

export const PROJECT_EXTENSION = "bandscore";
const FORMAT = "band-transcriber-project";

export function serializeProject(p: Project): string {
  return JSON.stringify({ format: FORMAT, version: 1, project: p }, null, 1);
}

export function parseProject(text: string): Project {
  const data = JSON.parse(text);
  if (data?.format !== FORMAT || !data.project) throw new Error("This isn't a Band Transcriber project file.");
  const p = data.project as Project;
  if (!Array.isArray(p.parts) || !p.timeSig) throw new Error("The project file is incomplete.");
  return normalizeLengths({
    ...p,
    parts: p.parts.map((x) => ({ ...x, id: x.id || newId(), muted: !!x.muted, volume: x.volume ?? 0.8 })),
  });
}
