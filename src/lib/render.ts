// Engraves a score (one or more staves, bars aligned across them) with VexFlow into an
// SVG. Used by the live view, the editor, playback and PDF export, so all look alike.
// Returns where each bar and note landed, for the playback line.

import {
  Accidental,
  BarlineType,
  Beam,
  Dot,
  Formatter,
  Renderer,
  Stave,
  StaveConnector,
  StaveNote,
  StaveTie,
  Voice,
} from "vexflow";
import { keyAccidentalCount, vexKey } from "./music";
import type { ScoreItem, ScoreMeasure } from "./quantize";
import type { Clef } from "./types";

export interface StaffInput {
  measures: ScoreMeasure[];
  clef: Clef;
  /** VexFlow key signature of this staff's *written* key, e.g. "D" or "Bb". */
  keySignature: string;
  name?: string;
  shortName?: string;
  isSelected?: (item: ScoreItem) => boolean;
  /** The first note continues a tie from before this excerpt (PDF page breaks). */
  tieIn?: boolean;
}

export interface RenderOptions {
  width: number;
  /** As drawn, e.g. "7/8". */
  timeSig: string;
  /** Beam groups within a bar, in steps. */
  beamGroups: number[];
  ink: string;
  liveColor?: string;
  selectColor?: string;
  measuresPerRow?: number;
  showTimeSig?: boolean;
  firstMeasureNumber?: number;
  finalBarline?: boolean;
  /** Write staff names (full on the first system, short after). Default: if >1 staff. */
  showNames?: boolean;
  onItemElement?: (staff: number, item: ScoreItem, el: SVGElement) => void;
}

export interface MeasureBox {
  system: number;
  startStep: number;
  endStep: number;
  x0: number;
  x1: number;
  /** [step, x] of every drawn note/rest in the bar, sorted, for interpolation. */
  points: Array<[number, number]>;
}

export interface ScoreLayout {
  height: number;
  systems: Array<{ top: number; bottom: number }>;
  measures: MeasureBox[];
}

const TOP_PAD = 24;
const SIDE_PAD = 12;
const STAFF_SPACING = 105;
const SYSTEM_GAP = 30;
const MIN_MEASURE_WIDTH = 230;
const NAME_WIDTH = 96;
const SHORT_NAME_WIDTH = 54;

export function systemHeight(staves: number): number {
  return staves <= 1 ? 130 : staves * STAFF_SPACING + SYSTEM_GAP;
}

export function measuresPerRowFor(width: number): number {
  return Math.max(1, Math.min(6, Math.floor((width - SIDE_PAD * 2) / MIN_MEASURE_WIDTH)));
}

/** Beam runs of two or more 8ths/16ths that sit within one beam group. */
function beamNotes(items: ScoreItem[], notes: StaveNote[], groups: number[]): Beam[] {
  if (items.length === 0) return [];
  const origin = items[0].start;
  const edges: number[] = [];
  let acc = 0;
  for (const g of groups) edges.push((acc += g));
  const groupOf = (pos: number) => {
    const i = edges.findIndex((e) => pos < e);
    return i < 0 ? edges.length : i;
  };
  const beams: Beam[] = [];
  let run: StaveNote[] = [];
  let runGroup = -1;
  const flush = () => {
    if (run.length >= 2) beams.push(new Beam(run, true));
    run = [];
  };
  items.forEach((it, i) => {
    const beamable = it.kind === "note" && (it.duration === "8" || it.duration === "16");
    const g = groupOf(it.start - origin);
    if (!beamable || g !== runGroup) flush();
    if (beamable) {
      run.push(notes[i]);
      runGroup = g;
    }
  });
  flush();
  return beams;
}

/** Draws into `host` (its contents are replaced). */
export function renderScore(host: HTMLElement, staves: StaffInput[], o: RenderOptions): ScoreLayout {
  host.innerHTML = "";
  const nStaves = Math.max(1, staves.length);
  const measureCount = Math.max(1, ...staves.map((s) => s.measures.length));
  const perRow = o.measuresPerRow ?? measuresPerRowFor(o.width);
  const rows = Math.ceil(measureCount / perRow);
  const sysH = systemHeight(nStaves);
  const height = TOP_PAD + rows * sysH;
  const showNames = o.showNames ?? nStaves > 1;

  const renderer = new Renderer(host as HTMLDivElement, Renderer.Backends.SVG);
  renderer.resize(o.width, height);
  const ctx = renderer.getContext();
  ctx.setFillStyle(o.ink);
  ctx.setStrokeStyle(o.ink);

  const ink = { fillStyle: o.ink, strokeStyle: o.ink };
  const live = { fillStyle: o.liveColor ?? o.ink, strokeStyle: o.liveColor ?? o.ink };
  const selected = { fillStyle: o.selectColor ?? o.ink, strokeStyle: o.selectColor ?? o.ink };
  const showTimeSig = o.showTimeSig ?? true;
  const firstNumber = o.firstMeasureNumber ?? 1;
  const maxKeyAcc = Math.max(0, ...staves.map((s) => keyAccidentalCount(s.keySignature)));
  const keyExtra = 26 + maxKeyAcc * 11;
  const [num, den] = o.timeSig.split("/").map(Number);

  const drawn: Array<Array<{ note: StaveNote; item: ScoreItem; row: number }>> = staves.map(() => []);
  const layout: ScoreLayout = { height, systems: [], measures: [] };

  for (let index = 0; index < measureCount; index++) {
    const row = Math.floor(index / perRow);
    const col = index % perRow;
    const isFirstInRow = col === 0;
    const isFirst = index === 0;
    const indent = showNames ? (row === 0 ? NAME_WIDTH : SHORT_NAME_WIDTH) : 0;
    const usable = o.width - SIDE_PAD * 2 - indent;
    const extraFirst = keyExtra + (isFirst && showTimeSig ? 30 : 0);
    const baseWidth = (usable - extraFirst) / perRow;
    const x = SIDE_PAD + indent + (isFirstInRow ? 0 : extraFirst + baseWidth * col);
    const w = baseWidth + (isFirstInRow ? extraFirst : 0);
    const top = TOP_PAD + row * sysH;
    if (isFirstInRow) layout.systems.push({ top: top + 10, bottom: top + (nStaves - 1) * STAFF_SPACING + 90 });

    const bars = staves.map((s, si) => {
      const stave = new Stave(x, top + si * STAFF_SPACING, w);
      if (isFirstInRow) {
        stave.addClef(s.clef).addKeySignature(s.keySignature);
        const number = firstNumber + index;
        if (si === 0 && number > 1) stave.setMeasure(number);
      }
      if (isFirst && showTimeSig) stave.addTimeSignature(o.timeSig);
      if (o.finalBarline && index === measureCount - 1) stave.setEndBarType(BarlineType.END);
      stave.setStyle(ink);
      return stave;
    });
    // Align the first note of every staff in this bar.
    const noteStart = Math.max(...bars.map((b) => b.getNoteStartX())) + (isFirstInRow ? 6 : 0);
    bars.forEach((b) => {
      b.setNoteStartX(noteStart);
      b.setContext(ctx).draw();
    });

    if (nStaves > 1) {
      const first = bars[0];
      const last = bars[bars.length - 1];
      if (isFirstInRow) {
        new StaveConnector(first, last).setType("bracket").setContext(ctx).draw();
        new StaveConnector(first, last).setType("singleLeft").setContext(ctx).draw();
        if (showNames) {
          ctx.save();
          ctx.setFont("Arial", 11, row === 0 ? "bold" : "normal");
          staves.forEach((s, si) => {
            const label = (row === 0 ? s.name : s.shortName) ?? "";
            const ty = top + si * STAFF_SPACING + 64;
            ctx.fillText(label, SIDE_PAD, ty);
          });
          ctx.restore();
        }
      }
      const endType = o.finalBarline && index === measureCount - 1 ? "boldDoubleRight" : "singleRight";
      new StaveConnector(first, last).setType(endType).setContext(ctx).draw();
    }

    // Notes, formatted jointly so they line up across staves.
    const voices: Voice[] = [];
    const pending: Array<{ si: number; voice: Voice; notes: StaveNote[]; items: ScoreItem[] }> = [];
    staves.forEach((s, si) => {
      const measure = s.measures[index];
      if (!measure || measure.items.length === 0) return;
      const restKey = s.clef === "bass" ? "d/3" : "b/4";
      const notes = measure.items.map((item) => {
        const note = new StaveNote({
          clef: s.clef,
          keys: [item.kind === "rest" ? restKey : vexKey(item.midi, s.keySignature)],
          duration: item.duration + (item.kind === "rest" ? "r" : ""),
          dots: item.dots,
          align_center: item.measureRest,
        });
        if (item.dots) Dot.buildAndAttach([note], { all: true });
        note.setStyle(s.isSelected?.(item) ? selected : item.live ? live : ink);
        drawn[si].push({ note, item, row });
        return note;
      });
      const voice = new Voice({ num_beats: num, beat_value: den }).setMode(Voice.Mode.SOFT);
      voice.addTickables(notes);
      Accidental.applyAccidentals([voice], s.keySignature);
      notes.forEach((n) => n.getModifiers().forEach((m) => m.setStyle(n.getStyle() ?? ink)));
      voices.push(voice);
      pending.push({ si, voice, notes, items: measure.items });
    });
    if (voices.length) {
      const formatter = new Formatter();
      voices.forEach((v) => formatter.joinVoices([v]));
      formatter.format(voices, Math.max(20, bars[0].getNoteEndX() - noteStart - 26));
      for (const p of pending) {
        const beams = beamNotes(p.items, p.notes, o.beamGroups);
        p.voice.draw(ctx, bars[p.si]);
        beams.forEach((b) => b.setStyle(ink).setContext(ctx).draw());
      }
    }

    // Playhead map for this bar.
    const sample = staves.find((s) => s.measures[index]?.items.length)?.measures[index];
    const startStep = sample?.items[0]?.start ?? -1;
    const spanSteps = sample ? sample.items.reduce((a, it) => Math.max(a, it.start + it.steps), startStep) - startStep : 0;
    const points: Array<[number, number]> = [];
    for (const p of pending) {
      p.items.forEach((it, k) => {
        if (!it.measureRest) points.push([it.start, p.notes[k].getAbsoluteX()]);
      });
    }
    points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const dedup = points.filter((pt, i) => i === 0 || pt[0] !== points[i - 1][0]);
    layout.measures.push({ system: row, startStep, endStep: startStep + spanSteps, x0: noteStart, x1: x + w, points: dedup });
  }

  // Ties can cross barlines, systems and the edges of the excerpt.
  staves.forEach((s, si) => {
    const noteEntries = drawn[si].filter((d) => d.item.kind === "note");
    noteEntries.forEach((cur, i) => {
      const tie = (notes: ConstructorParameters<typeof StaveTie>[0]) =>
        new StaveTie(notes).setStyle(s.isSelected?.(cur.item) ? selected : ink).setContext(ctx).draw();
      if (i === 0 && s.tieIn && cur.item.tieFromPrev) tie({ last_note: cur.note, last_indices: [0] });
      if (!cur.item.tieToNext) return;
      const next = noteEntries[i + 1];
      if (!next) tie({ first_note: cur.note, first_indices: [0] });
      else if (next.row === cur.row)
        tie({ first_note: cur.note, last_note: next.note, first_indices: [0], last_indices: [0] });
      else {
        tie({ first_note: cur.note, first_indices: [0] });
        tie({ last_note: next.note, last_indices: [0] });
      }
    });
  });

  if (o.onItemElement) {
    drawn.forEach((list, si) => {
      for (const d of list) {
        const el = d.note.getSVGElement();
        if (el) o.onItemElement!(si, d.item, el);
      }
    });
  }
  return layout;
}

/** x position of `step` on the drawn score, by interpolating between drawn notes. */
export function playheadAt(layout: ScoreLayout, step: number, spm: number): { x: number; system: number } | null {
  const index = Math.floor(step / spm);
  const m = layout.measures[index];
  if (!m) return null;
  const start = index * spm;
  const pts: Array<[number, number]> = [[start, m.x0 - 6], ...m.points.filter((p) => p[0] > start), [start + spm, m.x1 - 4]];
  for (let i = 0; i < pts.length - 1; i++) {
    const [s0, x0] = pts[i];
    const [s1, x1] = pts[i + 1];
    if (step >= s0 && step <= s1) {
      const t = s1 === s0 ? 0 : (step - s0) / (s1 - s0);
      return { x: x0 + t * (x1 - x0), system: m.system };
    }
  }
  return { x: m.x1 - 4, system: m.system };
}
