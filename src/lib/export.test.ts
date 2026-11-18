import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { toMidi } from "./export/midi";
import { toMusicXml, type MusicXmlPart } from "./export/musicxml";
import { importFile } from "./import";
import { parseMeter } from "./meter";
import { layoutMeasures } from "./quantize";
import { serializeProject, parseProject, emptyProject } from "./project";

const notes = [
  { midi: 63, s: 0, e: 4, live: false },
  { midi: 65, s: 4, e: 8, live: false },
  { midi: 66, s: 12, e: 20, live: false }, // tied over the barline
];
const tuba = [
  { midi: 39, s: 0, e: 8, live: false },
  { midi: 34, s: 8, e: 16, live: false },
  { midi: 39, s: 16, e: 32, live: false },
];
const ts44 = { num: 4, den: 4 } as const;

function tenorAndTuba(): MusicXmlPart[] {
  // Written pitch: tenor sax is concert + 14 (key C written for concert Bb), tuba concert.
  const written = notes.map((n) => ({ ...n, midi: n.midi + 14 }));
  return [
    { measures: layoutMeasures(written, 32, ts44), partName: "Bb Tenor Sax", clef: "treble", keySignature: "C", transpose: 14 },
    { measures: layoutMeasures(tuba, 32, ts44), partName: "Tuba", clef: "bass", keySignature: "Bb", transpose: 0 },
  ];
}

describe("MusicXML export", () => {
  const xml = toMusicXml(tenorAndTuba(), { title: "Blues & Things", timeSig: ts44, bpm: 120 });

  it("is a partwise score with both parts, the transposition and an escaped title", () => {
    expect(xml).toContain("<score-partwise");
    expect(xml).toContain("<work-title>Blues &amp; Things</work-title>");
    expect(xml).toContain('<score-part id="P1"><part-name>Bb Tenor Sax</part-name>');
    expect(xml).toContain('<score-part id="P2"><part-name>Tuba</part-name>');
    expect(xml).toContain("<transpose><diatonic>-1</diatonic><chromatic>-2</chromatic><octave-change>-1</octave-change></transpose>");
    expect(xml).toContain("<clef><sign>F</sign><line>4</line></clef>");
  });

  it("every bar of every part adds up", () => {
    for (const part of xml.split("<part id=").slice(1)) {
      for (const m of part.split("<measure").slice(1)) {
        const total = [...m.matchAll(/<duration>(\d+)<\/duration>/g)].reduce((a, x) => a + Number(x[1]), 0);
        expect(total).toBe(16);
      }
    }
  });

  it("writes additive meters as additive beats", () => {
    const m = parseMeter("7/8 2+2+3")!;
    const x = toMusicXml([{ measures: layoutMeasures([], 14, m), partName: "Fl", clef: "treble", keySignature: "C", transpose: 0 }], { title: "", timeSig: m, bpm: 200 });
    expect(x).toContain("<beats>2+2+3</beats><beat-type>8</beat-type>");
  });
});

describe("import round trips", () => {
  it("MusicXML: parts, instruments, concert pitch, ties, meter, tempo and key come back", () => {
    const xml = toMusicXml(tenorAndTuba(), { title: "Round Trip", timeSig: ts44, bpm: 120 });
    const p = importFile("x.musicxml", strToU8(xml));
    expect(p.title).toBe("Round Trip");
    expect(p.timeSig).toEqual(ts44);
    expect(p.bpm).toBe(120);
    expect(p.concertKey).toBe("Bb");
    expect(p.parts.map((x) => x.instrument)).toEqual(["tenorSax", "tuba"]);
    expect(p.parts[0].doc.notes).toEqual(notes.map(({ midi, s, e }) => ({ midi, s, e })));
    expect(p.parts[1].doc.notes).toEqual(tuba.map(({ midi, s, e }) => ({ midi, s, e })));
  });

  it("compressed .mxl", () => {
    const xml = toMusicXml(tenorAndTuba(), { title: "Zipped", timeSig: ts44, bpm: 90 });
    const zip = zipSync({
      "META-INF/container.xml": strToU8('<?xml version="1.0"?><container><rootfiles><rootfile full-path="score.xml"/></rootfiles></container>'),
      "score.xml": strToU8(xml),
    });
    const p = importFile("x.mxl", zip);
    expect(p.title).toBe("Zipped");
    expect(p.parts).toHaveLength(2);
  });

  it("MIDI: tracks, programs, meter and tempo come back", () => {
    const bytes = toMidi(
      [
        { name: "Alto", instrument: "altoSax", notes: notes.map(({ midi, s, e }) => ({ midi, s, e })) },
        { name: "", instrument: "tuba", notes: tuba.map(({ midi, s, e }) => ({ midi, s, e })) },
      ],
      { bpm: 60, timeSig: parseMeter("6/8")!, title: "Midi Trip" },
    );
    const p = importFile("x.mid", bytes);
    expect(p.title).toBe("Midi Trip");
    expect(p.timeSig).toEqual({ num: 6, den: 8 });
    expect(p.bpm).toBe(60); // dotted-quarter beats
    expect(p.parts.map((x) => x.instrument)).toEqual(["altoSax", "tuba"]);
    expect(p.parts[1].doc.notes).toEqual(tuba.map(({ midi, s, e }) => ({ midi, s, e })));
  });

  it("MIDI chords reduce to the top line", () => {
    const bytes = toMidi(
      [{ name: "Trumpet", instrument: "trumpet", notes: [{ midi: 60, s: 0, e: 4 }, { midi: 64, s: 0, e: 4 }, { midi: 62, s: 4, e: 8 }] }],
      { bpm: 100, timeSig: ts44, title: "" },
    );
    expect(importFile("c.mid", bytes).parts[0].doc.notes).toEqual([{ midi: 64, s: 0, e: 4 }, { midi: 62, s: 4, e: 8 }]);
  });

  it("project files", () => {
    const p = emptyProject("trumpet");
    p.title = "Saved";
    p.parts[0].doc.notes = [{ midi: 60, s: 0, e: 4 }];
    const back = parseProject(serializeProject(p));
    expect(back.title).toBe("Saved");
    expect(back.parts[0].doc.notes).toEqual([{ midi: 60, s: 0, e: 4 }]);
    expect(() => parseProject('{"hello":1}')).toThrow(/isn't a Band Transcriber project/);
  });

  it("rejects unknown files with a helpful message", () => {
    expect(() => importFile("song.mp3", new Uint8Array(4))).toThrow(/Can't open \.mp3/);
  });
});

describe("MIDI export", () => {
  it("writes format 1 with a tempo track and one track per part", () => {
    const bytes = toMidi(
      [
        { name: "A", instrument: "tenorSax", notes: [{ midi: 63, s: 0, e: 4 }] },
        { name: "B", instrument: "tuba", notes: [{ midi: 39, s: 0, e: 8 }] },
      ],
      { bpm: 120, timeSig: { num: 6, den: 8 }, title: "T" },
    );
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("MThd");
    expect([bytes[9], bytes[11]]).toEqual([1, 3]); // format 1, 3 tracks
    const all = Array.from(bytes).join(",");
    expect(all).toContain("144,63,"); // channel 1 note-on, concert Eb4
    expect(all).toContain("145,39,"); // channel 2
    expect(all).toContain("255,88,4,6,3"); // 6/8
    expect(all).toContain("255,81,3,5,22,21"); // dotted quarter 120 = quarter 180 = 333333 µs
  });
});
