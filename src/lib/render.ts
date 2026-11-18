// Engraves laid-out measures with VexFlow into an SVG. Used by the live view, the
// editor and PDF export, so all three look identical.

import {
  Accidental,
  BarlineType,
  Beam,
  Dot,
  Formatter,
  Renderer,
  Stave,
  StaveNote,
  StaveTie,
  Voice,
} from "vexflow";
import { keyAccidentalCount, vexKey } from "./music";
import type { ScoreItem, ScoreMeasure } from "./quantize";
import type { Clef } from "./types";

export interface RenderOptions {
  width: number;
  clef: Clef;
  /** VexFlow key signature of the *written* key, e.g. "D" or "Bb". */
  keySignature: string;
  /** e.g. "6/8". */
  timeSig: string;
  ink: string;
  /** Colour of the sounding note while recording. */
  liveColor?: string;
  /** Colour of the editor selection, and which items are selected. */
  selectColor?: string;
  isSelected?: (item: ScoreItem) => boolean;
  /** Fixed number of measures per system (default: fit to width). */
  measuresPerRow?: number;
  /** Draw the time signature on the first measure (default true). */
  showTimeSig?: boolean;
  /** Number of the first measure, for bar numbers at the start of each system. */
  firstMeasureNumber?: number;
  /** The first note continues a tie from before this excerpt (PDF page breaks). */
  tieIn?: boolean;
  /** Draw a final barline after the last measure. */
  finalBarline?: boolean;
  /** Called with each drawn item's SVG group (for click-to-select). */
  onItemElement?: (item: ScoreItem, el: SVGElement) => void;
}

/** Beam groups within a bar, in 16th steps: by beat, by quarter in cut time, and the
 *  usual 3+2 / 2+2+3 groupings for 5/8 and 7/8. */
export function beamGroups(num: number, den: number): number[] {
  if (den === 4) return Array(num).fill(4);
  if (den === 2) return Array(num * 2).fill(4);
  if (num % 3 === 0) return Array(num / 3).fill(6);
  if (num === 5) return [6, 4];
  if (num === 7) return [4, 4, 6];
  // Other x/8: groups of 3, with a final 2 or 4 as needed.
  const out: number[] = [];
  let left = num;
  while (left > 4) {
    out.push(6);
    left -= 3;
  }
  out.push(left * 2);
  return out;
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

export const ROW_HEIGHT = 130;
export const TOP_PAD = 24;
const SIDE_PAD = 12;
const MIN_MEASURE_WIDTH = 250;

export function measuresPerRowFor(width: number): number {
  return Math.max(1, Math.min(6, Math.floor((width - SIDE_PAD * 2) / MIN_MEASURE_WIDTH)));
}

/** Draws into `host` (its contents are replaced). Returns the drawing's height. */
export function renderScore(host: HTMLElement, measures: ScoreMeasure[], o: RenderOptions): { height: number } {
  host.innerHTML = "";
  const list: ScoreMeasure[] = measures.length ? measures : [{ items: [], complete: false }];
  const perRow = o.measuresPerRow ?? measuresPerRowFor(o.width);
  const rows = Math.max(1, Math.ceil(list.length / perRow));
  const height = TOP_PAD + rows * ROW_HEIGHT;

  const renderer = new Renderer(host as HTMLDivElement, Renderer.Backends.SVG);
  renderer.resize(o.width, height);
  const ctx = renderer.getContext();
  ctx.setFillStyle(o.ink);
  ctx.setStrokeStyle(o.ink);

  const ink = { fillStyle: o.ink, strokeStyle: o.ink };
  const live = { fillStyle: o.liveColor ?? o.ink, strokeStyle: o.liveColor ?? o.ink };
  const selected = { fillStyle: o.selectColor ?? o.ink, strokeStyle: o.selectColor ?? o.ink };
  const restKey = o.clef === "bass" ? "d/3" : "b/4";
  const keyExtra = 26 + keyAccidentalCount(o.keySignature) * 11;
  const usable = o.width - SIDE_PAD * 2;
  const showTimeSig = o.showTimeSig ?? true;
  const firstNumber = o.firstMeasureNumber ?? 1;

  const drawn: Array<{ note: StaveNote; item: ScoreItem; row: number }> = [];

  list.forEach((measure, index) => {
    const row = Math.floor(index / perRow);
    const col = index % perRow;
    const isFirstInRow = col === 0;
    const isFirst = index === 0;
    const extraFirst = keyExtra + (isFirst && showTimeSig ? 30 : 0);
    const baseWidth = (usable - extraFirst) / perRow;
    const x = SIDE_PAD + (isFirstInRow ? 0 : extraFirst + baseWidth * col);
    const w = baseWidth + (isFirstInRow ? extraFirst : 0);
    const y = TOP_PAD + row * ROW_HEIGHT;

    const stave = new Stave(x, y, w);
    if (isFirstInRow) {
      stave.addClef(o.clef).addKeySignature(o.keySignature);
      const number = firstNumber + index;
      if (number > 1) stave.setMeasure(number);
    }
    if (isFirst && showTimeSig) stave.addTimeSignature(o.timeSig);
    if (o.finalBarline && index === list.length - 1) stave.setEndBarType(BarlineType.END);
    stave.setStyle(ink);
    stave.setContext(ctx).draw();

    if (measure.items.length === 0) return;

    const notes = measure.items.map((item) => {
      const note = new StaveNote({
        clef: o.clef,
        keys: [item.kind === "rest" ? restKey : vexKey(item.midi, o.keySignature)],
        duration: item.duration + (item.kind === "rest" ? "r" : ""),
        dots: item.dots,
        align_center: item.measureRest,
      });
      if (item.dots) Dot.buildAndAttach([note], { all: true });
      const style = o.isSelected?.(item) ? selected : item.live ? live : ink;
      note.setStyle(style);
      drawn.push({ note, item, row });
      return note;
    });

    const [num, den] = o.timeSig.split("/").map(Number);
    const voice = new Voice({ num_beats: num, beat_value: den }).setMode(Voice.Mode.SOFT);
    voice.addTickables(notes);
    Accidental.applyAccidentals([voice], o.keySignature);
    notes.forEach((n) => n.getModifiers().forEach((m) => m.setStyle(n.getStyle() ?? ink)));

    const beams = beamNotes(measure.items, notes, beamGroups(num, den));
    new Formatter().joinVoices([voice]).formatToStave([voice], stave);
    voice.draw(ctx, stave);
    beams.forEach((b) => b.setStyle(ink).setContext(ctx).draw());
  });

  // Ties can cross barlines, systems and the edges of the excerpt.
  const noteEntries = drawn.filter((d) => d.item.kind === "note");
  noteEntries.forEach((cur, i) => {
    const tie = (notes: ConstructorParameters<typeof StaveTie>[0]) =>
      new StaveTie(notes).setStyle(o.isSelected?.(cur.item) ? selected : ink).setContext(ctx).draw();
    if (i === 0 && o.tieIn && cur.item.tieFromPrev) tie({ last_note: cur.note, last_indices: [0] });
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

  if (o.onItemElement) {
    for (const d of drawn) {
      const el = d.note.getSVGElement();
      if (el) o.onItemElement(d.item, el);
    }
  }
  return { height };
}
