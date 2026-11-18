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
const NAME_WIDTH = 96;
const SHORT_NAME_WIDTH = 54;

export function systemHeight(staves: number): number {
  return staves <= 1 ? 130 : staves * STAFF_SPACING + SYSTEM_GAP;
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

/** A bar's notes, built and measured before layout. */
interface BuiltBar {
  pending: Array<{ si: number; voice: Voice; notes: StaveNote[]; items: ScoreItem[]; beams: Beam[] }>;
  voices: Voice[];
  formatter: Formatter | null;
  /** Width the notes need (VexFlow's minimum, plus breathing room), px. */
  need: number;
}

/** Room a bar needs for its notes, generous enough that nothing collides. */
const NOTE_SPACE = 1.35;
const BAR_PADDING = 34;
const EMPTY_BAR = 90;
const MAX_BARS_PER_ROW = 8;

/** Pack bars into systems so each gets the room its notes need. Returns the bar
 *  indexes of each system. Exported for PDF pagination. */
export function planRows(needs: number[], width: number, firstExtra: number, rowExtra: number, indentFirst: number, indent: number): number[][] {
  const rows: number[][] = [];
  let row: number[] = [];
  let used = 0;
  needs.forEach((need, i) => {
    const room = width - SIDE_PAD * 2 - (rows.length === 0 ? indentFirst : indent) - (rows.length === 0 ? firstExtra : rowExtra);
    if (row.length > 0 && (used + need > room || row.length >= MAX_BARS_PER_ROW)) {
      rows.push(row);
      row = [];
      used = 0;
    }
    row.push(i);
    used += need;
  });
  if (row.length) rows.push(row);
  return rows;
}

/** Draws into `host` (its contents are replaced). */
export function renderScore(host: HTMLElement, staves: StaffInput[], o: RenderOptions): ScoreLayout {
  host.innerHTML = "";
  const nStaves = Math.max(1, staves.length);
  const measureCount = Math.max(1, ...staves.map((s) => s.measures.length));
  const showNames = o.showNames ?? nStaves > 1;

  const ink = { fillStyle: o.ink, strokeStyle: o.ink };
  const live = { fillStyle: o.liveColor ?? o.ink, strokeStyle: o.liveColor ?? o.ink };
  const selected = { fillStyle: o.selectColor ?? o.ink, strokeStyle: o.selectColor ?? o.ink };
  const showTimeSig = o.showTimeSig ?? true;
  const firstNumber = o.firstMeasureNumber ?? 1;
  const maxKeyAcc = Math.max(0, ...staves.map((s) => keyAccidentalCount(s.keySignature)));
  // Clef + key signature at the start of every system, plus the time signature at the start.
  const rowExtra = 40 + maxKeyAcc * 11;
  const firstExtra = rowExtra + (showTimeSig ? 30 : 0);
  const [num, den] = o.timeSig.split("/").map(Number);

  // 1. Build every bar's notes and measure the room they need.
  const drawnItems: Array<Array<{ note: StaveNote; item: ScoreItem; bar: number }>> = staves.map(() => []);
  const built: BuiltBar[] = [];
  for (let index = 0; index < measureCount; index++) {
    const voices: Voice[] = [];
    const pending: BuiltBar["pending"] = [];
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
        drawnItems[si].push({ note, item, bar: index });
        return note;
      });
      const voice = new Voice({ num_beats: num, beat_value: den }).setMode(Voice.Mode.SOFT);
      voice.addTickables(notes);
      Accidental.applyAccidentals([voice], s.keySignature);
      notes.forEach((n) => n.getModifiers().forEach((m) => m.setStyle(n.getStyle() ?? ink)));
      const beams = beamNotes(measure.items, notes, o.beamGroups);
      voices.push(voice);
      pending.push({ si, voice, notes, items: measure.items, beams });
    });
    let formatter: Formatter | null = null;
    let need = EMPTY_BAR;
    if (voices.length) {
      formatter = new Formatter();
      voices.forEach((v) => formatter!.joinVoices([v]));
      need = Math.max(EMPTY_BAR, formatter.preCalculateMinTotalWidth(voices) * NOTE_SPACE + BAR_PADDING);
    }
    built.push({ pending, voices, formatter, need });
  }

  // 2. Pack bars into systems.
  const rowPlan = planRows(
    built.map((b) => b.need),
    o.width,
    firstExtra,
    rowExtra,
    showNames ? NAME_WIDTH : 0,
    showNames ? SHORT_NAME_WIDTH : 0,
  );
  const sysH = systemHeight(nStaves);
  const height = TOP_PAD + rowPlan.length * sysH;
  const renderer = new Renderer(host as HTMLDivElement, Renderer.Backends.SVG);
  renderer.resize(o.width, height);
  const ctx = renderer.getContext();
  ctx.setFillStyle(o.ink);
  ctx.setStrokeStyle(o.ink);
  const layout: ScoreLayout = { height, systems: [], measures: [] };
  const rowOf: number[] = [];

  // Full systems are justified; a short last system keeps the spacing of the others.
  const fullScales: number[] = [];
  rowPlan.forEach((bars, row) => {
    const indent = showNames ? (row === 0 ? NAME_WIDTH : SHORT_NAME_WIDTH) : 0;
    const extra = row === 0 ? firstExtra : rowExtra;
    const room = o.width - SIDE_PAD * 2 - indent - extra;
    const needSum = bars.reduce((a, i) => a + built[i].need, 0);
    let scale = room / needSum;
    const isLast = row === rowPlan.length - 1;
    if (isLast && rowPlan.length > 1) {
      const typical = fullScales.length ? fullScales.reduce((a, b) => a + b, 0) / fullScales.length : 1;
      scale = Math.min(scale, Math.max(1, typical));
    } else if (isLast) {
      scale = Math.min(scale, 1.8);
    } else {
      fullScales.push(scale);
    }
    const top = TOP_PAD + row * sysH;
    layout.systems.push({ top: top + 10, bottom: top + (nStaves - 1) * STAFF_SPACING + 90 });

    let x = SIDE_PAD + indent;
    bars.forEach((index, col) => {
      rowOf[index] = row;
      const isFirstInRow = col === 0;
      const isFirst = index === 0;
      const w = built[index].need * scale + (isFirstInRow ? extra : 0);
      drawBar(index, row, top, x, w, isFirstInRow, isFirst);
      x += w;
    });
  });

  function drawBar(index: number, row: number, top: number, x: number, w: number, isFirstInRow: boolean, isFirst: boolean) {
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
            ctx.fillText(label, SIDE_PAD, top + si * STAFF_SPACING + 64);
          });
          ctx.restore();
        }
      }
      const endType = o.finalBarline && index === measureCount - 1 ? "boldDoubleRight" : "singleRight";
      new StaveConnector(first, last).setType(endType).setContext(ctx).draw();
    }

    // Notes, formatted jointly so they line up across staves.
    const b = built[index];
    if (b.formatter && b.voices.length) {
      b.formatter.format(b.voices, Math.max(20, bars[0].getNoteEndX() - noteStart - 14));
      for (const p of b.pending) {
        p.voice.draw(ctx, bars[p.si]);
        p.beams.forEach((beam) => beam.setStyle(ink).setContext(ctx).draw());
      }
    }

    // Playhead map for this bar.
    const sample = staves.find((s) => s.measures[index]?.items.length)?.measures[index];
    const startStep = sample?.items[0]?.start ?? -1;
    const spanSteps = sample ? sample.items.reduce((a, it) => Math.max(a, it.start + it.steps), startStep) - startStep : 0;
    const points: Array<[number, number]> = [];
    for (const p of b.pending) {
      p.items.forEach((it, k) => {
        if (!it.measureRest) points.push([it.start, p.notes[k].getAbsoluteX()]);
      });
    }
    points.sort((p1, p2) => p1[0] - p2[0] || p1[1] - p2[1]);
    const dedup = points.filter((pt, i) => i === 0 || pt[0] !== points[i - 1][0]);
    layout.measures[index] = { system: row, startStep, endStep: startStep + spanSteps, x0: noteStart, x1: x + w, points: dedup };
  }

  const drawn = drawnItems.map((list) => list.map((d) => ({ note: d.note, item: d.item, row: rowOf[d.bar] })));

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
