import { describe, expect, it } from "vitest";
import { docFromNotes } from "./editor";
import { toMidi } from "./export/midi";
import { toMusicXml } from "./export/musicxml";
import { layoutMeasures } from "./quantize";

const notes = [
  { midi: 63, s: 0, e: 4, live: false },
  { midi: 65, s: 4, e: 8, live: false },
  { midi: 66, s: 12, e: 20, live: false }, // tied over the barline
];

describe("MusicXML", () => {
  // Written pitch for a tenor sax (concert + 14), key of C written (concert Bb).
  const written = notes.map((n) => ({ ...n, midi: n.midi + 14 }));
  const xml = toMusicXml(layoutMeasures(written, 32, { num: 4, den: 4 }), {
    title: "Blues & Things", partName: "Bb Tenor Sax", clef: "treble", keySignature: "C",
    timeSig: { num: 4, den: 4 }, bpm: 120, transpose: 14,
  });

  it("is a partwise score with the transposition and escaped title", () => {
    expect(xml).toContain("<score-partwise");
    expect(xml).toContain("<work-title>Blues &amp; Things</work-title>");
    expect(xml).toContain("<transpose><diatonic>-1</diatonic><chromatic>-2</chromatic><octave-change>-1</octave-change></transpose>");
    expect(xml).toContain("<time><beats>4</beats><beat-type>4</beat-type></time>");
  });

  it("writes notes, rests and ties with correct durations", () => {
    expect(xml).toContain("<step>F</step><octave>5</octave></pitch><duration>4</duration><type>quarter</type>");
    expect(xml).toContain("<rest/><duration>4</duration><type>quarter</type>");
    expect((xml.match(/<tie type="start"\/>/g) ?? []).length).toBe(1);
    expect((xml.match(/<tie type="stop"\/>/g) ?? []).length).toBe(1);
    // Every measure adds up to the bar (16 divisions of a 16th... 4 per quarter).
    for (const m of xml.split("<measure").slice(1)) {
      const total = [...m.matchAll(/<duration>(\d+)<\/duration>/g)].reduce((a, x) => a + Number(x[1]), 0);
      expect(total).toBe(16);
    }
  });

  it("marks accidentals once per bar", () => {
    // G#5 written (concert F#4 = 66 + 14 = 80): needs a sharp in C.
    expect((xml.match(/<accidental>sharp<\/accidental>/g) ?? []).length).toBe(1);
  });
});

describe("MIDI", () => {
  it("writes a valid single-track file at concert pitch", () => {
    const doc = docFromNotes(notes, 16);
    const bytes = toMidi(doc.notes, { bpm: 120, timeSig: { num: 6, den: 8 }, instrument: "tenorSax", title: "T" });
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("MThd");
    expect(String.fromCharCode(...bytes.slice(14, 18))).toBe("MTrk");
    const trackLen = (bytes[18] << 24) | (bytes[19] << 16) | (bytes[20] << 8) | bytes[21];
    expect(bytes.length).toBe(22 + trackLen);
    // Note-on for concert Eb4 (63), and 6/8 time signature meta (6, log2(8) = 3).
    expect(Array.from(bytes).join(",")).toContain("144,63,90");
    expect(Array.from(bytes).join(",")).toContain("255,88,4,6,3");
    // Tempo: dotted quarter = 120 -> quarter = 180 -> 333333 µs.
    expect(Array.from(bytes).join(",")).toContain("255,81,3,5,22,21");
  });
});
