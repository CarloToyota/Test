import { describe, expect, it } from "vitest";
import { beatSteps, beatsPerBar, gridLevels, measureSteps, parseTimeSignature } from "./meter";
import { buildScore, decompose, type QuantizeOptions } from "./quantize";

const ts = parseTimeSignature;
const n = (midi: number, startMs: number, endMs: number) => ({ midi, startMs, endMs, live: false });
const rhythm = (notes: ReturnType<typeof n>[], o: QuantizeOptions, now: number) =>
  buildScore(notes, now, o).map((m) =>
    m.items.map((i) => `${i.kind === "rest" ? "r" : ""}${i.duration}${i.dots ? "." : ""}${i.tieToNext ? "~" : ""}`).join(" "),
  );

describe("meter structure", () => {
  it("beats and bar lengths", () => {
    expect([measureSteps(ts("6/8")), beatSteps(ts("6/8")), beatsPerBar(ts("6/8"))]).toEqual([12, 6, 2]);
    expect([measureSteps(ts("12/8")), beatsPerBar(ts("12/8"))]).toEqual([24, 4]);
    expect([measureSteps(ts("2/2")), beatSteps(ts("2/2")), beatsPerBar(ts("2/2"))]).toEqual([16, 8, 2]);
    expect([measureSteps(ts("7/8")), beatSteps(ts("7/8")), beatsPerBar(ts("7/8"))]).toEqual([14, 2, 7]);
    expect([measureSteps(ts("5/4")), beatsPerBar(ts("5/4"))]).toEqual([20, 5]);
  });
  it("snapping levels", () => {
    expect(gridLevels(ts("4/4"), 1)).toEqual([4, 2, 1]);
    expect(gridLevels(ts("6/8"), 1)).toEqual([6, 2, 1]);
    expect(gridLevels(ts("2/2"), 2)).toEqual([8, 4, 2]);
  });
});

describe("engraving in other meters", () => {
  it("6/8 writes dotted-quarter beats and quarter-eighth groups", () => {
    expect(decompose(0, 12, 12, 6).map((p) => p.duration + (p.dots ? "." : ""))).toEqual(["h."]);
    expect(decompose(0, 6, 12, 6).map((p) => p.duration + (p.dots ? "." : ""))).toEqual(["q."]);
    expect(decompose(0, 4, 12, 6).map((p) => p.duration)).toEqual(["q"]);
    // A half note's worth in 6/8 must show the beat: q. tied to 8.
    expect(decompose(0, 8, 12, 6).map((p) => p.duration + (p.dots ? "." : ""))).toEqual(["q.", "8"]);
    // Rests: a dotted-quarter rest for a whole beat is standard in compound time.
    expect(decompose(0, 6, 12, 6, true).map((p) => p.duration + (p.dots ? "." : ""))).toEqual(["q."]);
  });

  it("6/8 staccato on the beat reads as dotted quarters", () => {
    // ♩. = 60: each beat 1 s, notes sound 300 ms.
    const o: QuantizeOptions = { bpm: 60, timeSig: ts("6/8"), resolution: "16th" };
    const notes = [0, 1, 2, 3].map((b) => n(65, b * 1000, b * 1000 + 300));
    expect(rhythm(notes, o, 4000)).toEqual(["q. q.", "q. q."]);
  });

  it("6/8 quarter-eighth patterns", () => {
    const o: QuantizeOptions = { bpm: 60, timeSig: ts("6/8"), resolution: "16th" };
    const e = 1000 / 3; // an eighth
    const notes = [n(60, 0, 2 * e - 40), n(62, 2 * e, 3 * e - 40), n(64, 3 * e, 5 * e - 40), n(65, 5 * e, 6 * e - 40)];
    expect(rhythm(notes, o, 2000)).toEqual(["q 8 q 8"]);
  });

  it("cut time: half-note beats", () => {
    const o: QuantizeOptions = { bpm: 60, timeSig: ts("2/2"), resolution: "16th" };
    const notes = [n(60, 0, 950), n(62, 1000, 1500), n(64, 1500, 1990)];
    expect(rhythm(notes, o, 2000)).toEqual(["h q q"]);
  });

  it("7/8 in eighths", () => {
    const o: QuantizeOptions = { bpm: 240, timeSig: ts("7/8"), resolution: "16th" };
    const e = 250;
    const notes = [n(60, 0, 2 * e - 20), n(62, 2 * e, 4 * e - 20), n(64, 4 * e, 7 * e - 20)];
    expect(rhythm(notes, o, 7 * e)).toEqual(["q q q."]);
  });

  it("5/4 fills a bar with half + dotted half where it shows the beat", () => {
    const o: QuantizeOptions = { bpm: 120, timeSig: ts("5/4"), resolution: "16th" };
    const notes = [n(60, 0, 990), n(62, 1000, 2490)];
    expect(rhythm(notes, o, 2500)).toEqual(["h h."]);
  });
});

import { groupSteps, metronomePattern, meterName, parseMeter } from "./meter";
describe("beam groups", () => {
  it("per meter", () => {
    expect(groupSteps(ts("4/4"))).toEqual([4, 4, 4, 4]);
    expect(groupSteps(ts("6/8"))).toEqual([6, 6]);
    expect(groupSteps(ts("12/8"))).toEqual([6, 6, 6, 6]);
    expect(groupSteps(ts("2/2"))).toEqual([4, 4, 4, 4]);
    expect(groupSteps(ts("5/8"))).toEqual([6, 4]);
    expect(groupSteps(ts("7/8"))).toEqual([4, 4, 6]);
    expect(groupSteps(ts("3/8"))).toEqual([6]);
  });
});

describe("custom meters", () => {
  it("parses plain, grouped and additive forms", () => {
    expect(parseMeter("11/8")).toEqual({ num: 11, den: 8 });
    expect(parseMeter("7/8 3+2+2")).toEqual({ num: 7, den: 8, groups: [3, 2, 2] });
    expect(parseMeter("3+3+2/8")).toEqual({ num: 8, den: 8, groups: [3, 3, 2] });
    expect(parseMeter("7/8 (2+2+3)")).toEqual({ num: 7, den: 8, groups: [2, 2, 3] });
    expect(parseMeter("7/6")).toBeNull();
    expect(parseMeter("7/8 3+3")).toBeNull(); // groups must add up
    expect(parseMeter("0/4")).toBeNull();
  });

  it("structure follows the grouping", () => {
    const m = parseMeter("7/8 3+2+2")!;
    expect(meterName(m)).toBe("7/8 (3+2+2)");
    expect(groupSteps(m)).toEqual([6, 4, 4]);
    expect(beatsPerBar(m)).toBe(7);
    expect(metronomePattern(m)).toEqual([2, 0, 0, 1, 0, 1, 0]);
    expect(metronomePattern(ts("6/8"))).toEqual([2, 0]);
    expect(metronomePattern(ts("4/4"))).toEqual([2, 0, 0, 0]);
    const s16 = parseMeter("5/16")!;
    expect([measureSteps(s16), beatSteps(s16)]).toEqual([5, 1]);
  });

  it("rhythms respect the groups: 3+2+2 vs 2+2+3", () => {
    // A note lasting three eighths from the downbeat.
    const a = decompose(0, 6, 14, 2, false, groupSteps(parseMeter("7/8 3+2+2")!));
    const b = decompose(0, 6, 14, 2, false, groupSteps(parseMeter("7/8 2+2+3")!));
    expect(a.map((p) => p.duration + (p.dots ? "." : ""))).toEqual(["q."]);
    expect(b.map((p) => p.duration + (p.dots ? "." : ""))).toEqual(["q", "8"]);
    // A rest filling the 3-group is a dotted quarter rest.
    const r = decompose(8, 6, 14, 2, true, groupSteps(parseMeter("7/8 2+2+3")!));
    expect(r.map((p) => p.duration + (p.dots ? "." : ""))).toEqual(["q."]);
  });
});
