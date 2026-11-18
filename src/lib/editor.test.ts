import { describe, expect, it } from "vitest";
import {
  addMeasure, deleteNote, docFromNotes, insertNote, removeLastMeasure, selectablePositions,
  setDuration, toggleDot, transposeNote, type ScoreDoc,
} from "./editor";
import { layoutMeasures } from "./quantize";

const SPM = 16;
const doc = (notes: Array<[number, number, number]>): ScoreDoc =>
  docFromNotes(notes.map(([midi, s, e]) => ({ midi, s, e, live: false })), SPM);

describe("score editing", () => {
  const base = doc([[60, 0, 4], [62, 4, 8], [64, 8, 12], [65, 12, 16]]);

  it("pads a new document to whole bars", () => {
    expect(doc([[60, 0, 6]]).endStep).toBe(16);
    expect(doc([[60, 14, 20]]).endStep).toBe(32);
  });

  it("lengthening overwrites what follows", () => {
    const d = setDuration(base, 0, 8, SPM);
    expect(d.notes.map((n) => [n.midi, n.s, n.e])).toEqual([[60, 0, 8], [64, 8, 12], [65, 12, 16]]);
  });

  it("shortening leaves a rest", () => {
    const d = setDuration(base, 4, 2, SPM);
    expect(d.notes.map((n) => [n.s, n.e])).toEqual([[0, 4], [4, 6], [8, 12], [12, 16]]);
  });

  it("a long note trims, not deletes, a note it half-covers", () => {
    const d = setDuration(base, 0, 6, SPM);
    expect(d.notes.map((n) => [n.midi, n.s, n.e])).toEqual([[60, 0, 6], [62, 6, 8], [64, 8, 12], [65, 12, 16]]);
  });

  it("dots toggle", () => {
    const d = toggleDot(base, 0, SPM);
    expect(d.notes[0]).toMatchObject({ s: 0, e: 6 });
    expect(toggleDot(d, 0, SPM).notes[0]).toMatchObject({ s: 0, e: 4 });
  });

  it("insert into a rest, delete to a rest, transpose", () => {
    const empty = doc([]);
    const d = insertNote(empty, 4, 2, 67, SPM);
    expect(d.notes).toEqual([{ midi: 67, s: 4, e: 6 }]);
    expect(transposeNote(d, 4, 12).notes[0].midi).toBe(79);
    expect(deleteNote(d, 4).notes).toEqual([]);
    expect(deleteNote(d, 0)).toBe(d); // nothing at step 0
  });

  it("writing past the end grows the score by bars", () => {
    const d = insertNote(base, 12, 8, 67, SPM);
    expect(d.endStep).toBe(32);
  });

  it("bars can be added and removed only when empty", () => {
    const d = addMeasure(base, SPM);
    expect(d.endStep).toBe(32);
    expect(removeLastMeasure(d, SPM).endStep).toBe(16);
    expect(removeLastMeasure(base, SPM)).toBe(base);
  });

  it("cursor positions: note starts and rests, not tied continuations", () => {
    const d = doc([[60, 0, 6], [62, 12, 20]]);
    const m = layoutMeasures(d.notes.map((n) => ({ ...n, live: false })), d.endStep, { num: 4, den: 4 });
    // q. at 0, rest 8th at 6, rest quarter at 8, note at 12 (tied over the bar), rest at 20, 24...
    expect(selectablePositions(m)).toEqual([0, 6, 8, 12, 20, 24]);
  });
});
