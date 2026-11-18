import { describe, expect, it } from "vitest";
import { buildScore, decompose, quantizeNotes, type QuantizeOptions } from "./quantize";

const opts: QuantizeOptions = { bpm: 120, timeSig: { num: 4, den: 4 }, resolution: "16th" };
// At 120 bpm: beat = 500 ms, 16th = 125 ms, bar = 2000 ms.
const n = (midi: number, startMs: number, endMs: number) => ({ midi, startMs, endMs, live: false });

describe("decompose", () => {
  it("uses single values on the beat", () => {
    expect(decompose(0, 4, 16, 4).map((p) => p.duration)).toEqual(["q"]);
    expect(decompose(0, 16, 16, 4).map((p) => p.duration)).toEqual(["w"]);
    expect(decompose(0, 6, 16, 4).map((p) => [p.duration, p.dots])).toEqual([["q", 1]]);
  });
  it("does not start a half note on beat 2 in 4/4", () => {
    expect(decompose(4, 8, 16, 4).map((p) => p.duration)).toEqual(["q", "q"]);
  });
  it("allows a half note on beat 2 in 3/4", () => {
    expect(decompose(4, 8, 12, 4).map((p) => p.duration)).toEqual(["h"]);
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
  it("keeps real rests that span a beat", () => {
    // Quarter, a full beat of silence, then a quarter.
    const q = quantizeNotes([n(60, 0, 450), n(62, 1000, 1450)], opts);
    expect(q.map((x) => [x.s, x.e])).toEqual([[0, 4], [8, 12]]);
  });
  it("snaps to a coarser grid", () => {
    // Starts on the "and" of 1 (8th grid); the note is then held to the beat.
    const q = quantizeNotes([n(60, 260, 740), n(62, 1000, 1400)], { ...opts, resolution: "8th" });
    expect(q.map((x) => [x.s, x.e])).toEqual([[2, 8], [8, 12]]);
  });

  it("breaths in long notes are not rests; a full beat of silence is", () => {
    // A half note released early (a breath), then a note on beat 3.
    const breath = quantizeNotes([n(60, 0, 620), n(62, 1000, 1450)], opts);
    expect(breath.map((x) => [x.s, x.e])).toEqual([[0, 8], [8, 12]]);
    // A quarter, then a full beat of silence before the next note.
    const rest = quantizeNotes([n(60, 0, 450), n(62, 1000, 1450)], opts);
    expect(rest.map((x) => [x.s, x.e])).toEqual([[0, 4], [8, 12]]);
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
    const [bar] = buildScore(notes, 1500, { ...opts, timeSig: { num: 3, den: 4 } });
    expect(bar.items.map((i) => [i.duration, i.dots])).toEqual([["h", 1]]);
  });
});

describe("fast passages", () => {
  it("16ths played a little early on the 'e' stay 16ths (no snapping onto the beat)", () => {
    // 80 bpm: 16th = 187.5 ms. Each 'e' and 'a' about a third of a 16th early.
    const t = [0, 0.7, 2, 2.7, 4, 4.7, 6, 6.7].map((x) => x * 187.5);
    const notes = t.map((s, i) => n(60 + (i >> 2), s, s + 150));
    const q = quantizeNotes(notes, { ...opts, bpm: 80 });
    expect(q.map((x) => x.s)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("staccato and timing", () => {
  const rhythm = (notes: ReturnType<typeof n>[], o = opts, now?: number) =>
    buildScore(notes, now ?? Math.max(...notes.map((x) => x.endMs)) + 1, o)
      .flatMap((m) => m.items)
      .map((i) => `${i.kind === "rest" ? "r" : ""}${i.duration}${i.dots ? "." : ""}`);

  it("writes staccato quarters on the beat as quarters", () => {
    // 100 bpm (600 ms beats); each note sounds 220 ms.
    const o = { ...opts, bpm: 100 };
    const notes = [0, 1, 2, 3, 4, 5, 6, 7].map((b) => n(65, b * 600, b * 600 + 220));
    expect(rhythm(notes, o, 4800)).toEqual(["q", "q", "q", "q", "q", "q", "q", "q"]);
  });

  it("removes a steady late lean (latency) before snapping", () => {
    // 140 bpm (429 ms beats, 107 ms 16ths): every note 75 ms late, staccato.
    const o = { ...opts, bpm: 140 };
    const beat = 60000 / 140;
    const notes = [0, 1, 2, 3, 4, 5, 6, 7].map((b) => n(65, b * beat + 75, b * beat + 75 + 160));
    expect(rhythm(notes, o, 8 * beat + 80)).toEqual(["q", "q", "q", "q", "q", "q", "q", "q"]);
  });

  it("tolerates human jitter on quarters", () => {
    const o = { ...opts, bpm: 120 };
    const jitter = [10, -35, 40, -20, 55, -45, 25, 0];
    const notes = jitter.map((j, b) => n(65, b * 500 + j, b * 500 + j + 200));
    expect(rhythm(notes, o, 4000)).toEqual(["q", "q", "q", "q", "q", "q", "q", "q"]);
  });

  it("keeps staccato eighths as eighths", () => {
    const notes = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => n(60 + k, k * 250, k * 250 + 110));
    expect(rhythm(notes, opts, 2000)).toEqual(["8", "8", "8", "8", "8", "8", "8", "8"]);
  });

  it("keeps real 16ths and dotted rhythms", () => {
    // Beat 1: four 16ths. Beat 2: dotted 8th + 16th. Beats 3-4: dotted quarter + 8th, quarter.
    const at = [0, 125, 250, 375, 500, 875, 1000, 1750];
    const ends = [115, 240, 365, 490, 860, 990, 1740, 1990];
    const notes = at.map((t, i) => n(60 + i, t, ends[i]));
    expect(rhythm(notes, opts, 2000)).toEqual(["16", "16", "16", "16", "8.", "16", "q.", "8"]);
  });

  it("keeps offbeat staccato eighths on the 'and'", () => {
    const notes = [0, 1, 2, 3].map((b) => n(67, b * 500 + 250, b * 500 + 360));
    expect(rhythm(notes, opts, 2000)).toEqual(["r8", "8", "r8", "8", "r8", "8", "r8", "8"]);
  });
});
