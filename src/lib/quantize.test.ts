import { describe, expect, it } from "vitest";
import { buildScore, decompose, quantizeNotes } from "./quantize";

const opts = { bpm: 120, beatsPerMeasure: 4 as const, resolution: 1 as const };
// At 120 bpm: beat = 500 ms, 16th = 125 ms, bar = 2000 ms.
const n = (midi: number, startMs: number, endMs: number) => ({ midi, startMs, endMs, live: false });

describe("decompose", () => {
  it("uses single values on the beat", () => {
    expect(decompose(0, 4, 16).map((p) => p.duration)).toEqual(["q"]);
    expect(decompose(0, 16, 16).map((p) => p.duration)).toEqual(["w"]);
    expect(decompose(0, 6, 16).map((p) => [p.duration, p.dots])).toEqual([["q", 1]]);
  });
  it("does not start a half note on beat 2 in 4/4", () => {
    expect(decompose(4, 8, 16).map((p) => p.duration)).toEqual(["q", "q"]);
  });
  it("allows a half note on beat 2 in 3/4", () => {
    expect(decompose(4, 8, 12).map((p) => p.duration)).toEqual(["h"]);
  });
});

describe("quantizeNotes", () => {
  it("snaps slightly early/late playing to the 16th grid", () => {
    const q = quantizeNotes([n(60, 12, 480), n(62, 490, 1010)], opts);
    expect(q.map((x) => [x.s, x.e])).toEqual([[0, 4], [4, 8]]);
  });
  it("drops glitches shorter than 30 ms", () => {
    expect(quantizeNotes([n(60, 0, 20)], opts)).toEqual([]);
  });
  it("treats short gaps before the next attack as articulation", () => {
    // Detached quarters: each released 60 ms early.
    const q = quantizeNotes([n(60, 0, 440), n(62, 500, 940), n(64, 1000, 1440)], opts);
    expect(q.map((x) => [x.s, x.e])).toEqual([[0, 4], [4, 8], [8, 12]]);
  });
  it("keeps real rests", () => {
    const q = quantizeNotes([n(60, 0, 250), n(62, 500, 990)], opts);
    expect(q.map((x) => [x.s, x.e])).toEqual([[0, 2], [4, 8]]);
  });
  it("snaps to a coarser grid", () => {
    const q = quantizeNotes([n(60, 260, 740)], { ...opts, resolution: 2 });
    expect(q.map((x) => [x.s, x.e])).toEqual([[2, 6]]);
  });
});

describe("buildScore", () => {
  it("writes four quarter notes in one bar", () => {
    const notes = [0, 1, 2, 3].map((i) => n(60 + i, i * 500, i * 500 + 450));
    const [bar] = buildScore(notes, 2000, opts);
    expect(bar.complete).toBe(true);
    expect(bar.items.map((i) => `${i.kind}:${i.duration}`)).toEqual(["note:q", "note:q", "note:q", "note:q"]);
  });

  it("fills gaps with rests and ties notes across the barline", () => {
    // Rest for beat 1, then a note from beat 4 lasting two beats.
    const m = buildScore([n(67, 1500, 2500)], 4000, opts);
    expect(m).toHaveLength(2);
    expect(m[0].items.map((i) => `${i.kind}:${i.duration}`)).toEqual(["rest:h", "rest:q", "note:q"]);
    expect(m[0].items[2].tieToNext).toBe(true);
    expect(m[1].items[0]).toMatchObject({ kind: "note", duration: "q", tieToNext: false });
  });

  it("shows an empty finished bar as a centred whole rest", () => {
    const m = buildScore([n(60, 2000, 2500)], 2600, opts);
    expect(m[0].items).toEqual([expect.objectContaining({ kind: "rest", measureRest: true })]);
  });

  it("only covers time up to now in the live bar", () => {
    const [bar] = buildScore([], 1000, opts);
    expect(bar.complete).toBe(false);
    expect(bar.items.map((i) => i.duration)).toEqual(["h"]);
  });

  it("handles 3/4", () => {
    const notes = [n(60, 0, 1500)];
    const [bar] = buildScore(notes, 1500, { ...opts, beatsPerMeasure: 3 });
    expect(bar.items.map((i) => [i.duration, i.dots])).toEqual([["h", 1]]);
  });
});
