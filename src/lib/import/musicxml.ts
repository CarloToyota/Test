// MusicXML import (partwise, plain or compressed .mxl). Each part becomes a monophonic
// part: voice 1 of staff 1, the top note of chords, no grace notes. Tuplets are rounded
// to the nearest 16th. The first time signature, key and tempo apply to the whole score.

import { DOMParser, type Element as XmlElement } from "@xmldom/xmldom";
import { unzipSync, strFromU8 } from "fflate";
import type { DocNote } from "../editor";
import { bpmFromQuarter, measureSteps, type Denominator, type TimeSignature } from "../meter";
import { writtenKey } from "../music";
import { newId, normalizeLengths, type Part, type Project } from "../project";
import { instrumentFromName, instrumentFromRange, instrumentFromTranspose } from "./instruments";

type El = XmlElement;

const kids = (el: El, name?: string): El[] => {
  const out: El[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (!name || (n as El).nodeName === name)) out.push(n as El);
  }
  return out;
};
const kid = (el: El, name: string): El | undefined => kids(el, name)[0];
const text = (el: El | undefined, name: string): string | undefined => {
  const k = el && kid(el, name);
  return k?.textContent?.trim() ?? undefined;
};
const num = (el: El | undefined, name: string): number | undefined => {
  const t = text(el, name);
  return t === undefined || t === "" ? undefined : Number(t);
};

const STEP_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const FIFTHS = ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"];

/** Unpack an .mxl (zip) to its root score XML. */
export function mxlToXml(bytes: Uint8Array): string {
  const files = unzipSync(bytes);
  const container = files["META-INF/container.xml"];
  let root: string | undefined;
  if (container) {
    const doc = new DOMParser().parseFromString(strFromU8(container), "text/xml");
    root = doc.getElementsByTagName("rootfile")[0]?.getAttribute("full-path") ?? undefined;
  }
  root ??= Object.keys(files).find((f) => !f.startsWith("META-INF") && /\.(xml|musicxml)$/i.test(f));
  if (!root || !files[root]) throw new Error("No score found inside the .mxl file.");
  return strFromU8(files[root]);
}

export function importMusicXml(xml: string, fallbackTitle: string): Project {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const score = doc.getElementsByTagName("score-partwise")[0] as El | undefined;
  if (!score) {
    if (doc.getElementsByTagName("score-timewise")[0]) throw new Error("Timewise MusicXML isn't supported; export it as partwise.");
    throw new Error("This doesn't look like a MusicXML score.");
  }

  const names = new Map<string, string>();
  for (const sp of Array.from(doc.getElementsByTagName("score-part"))) {
    names.set(sp.getAttribute("id") ?? "", text(sp as El, "part-name") ?? "");
  }
  const title =
    text(kid(score, "work"), "work-title") || text(score, "movement-title") || fallbackTitle;

  let timeSig: TimeSignature | null = null;
  let qpm: number | null = null;
  let concertKey: string | null = null;

  const parsed: Array<{ name: string; notes: DocNote[]; transpose: [number, number]; bass: boolean }> = [];
  for (const partEl of kids(score, "part")) {
    let divisions = 1;
    let chromatic = 0;
    let octave = 0;
    let bass = false;
    let writtenFifths: number | null = null;
    const notes: Array<DocNote & { tieStop: boolean }> = [];
    let barStart = 0;

    kids(partEl, "measure").forEach((measure, mi) => {
      let pos = 0; // divisions from the start of the bar
      let maxPos = 0;
      const toSteps = (d: number) => Math.round((d * 4) / divisions);
      const startIndex = notes.length;
      for (const c of kids(measure)) {
        switch (c.nodeName) {
          case "attributes": {
            divisions = num(c, "divisions") ?? divisions;
            const key = kid(c, "key");
            if (key && writtenFifths === null) writtenFifths = num(key, "fifths") ?? 0;
            const time = kid(c, "time");
            if (time && !timeSig) {
              const beats = text(time, "beats") ?? "4";
              const den = Number(text(time, "beat-type") ?? 4);
              const groups = beats.includes("+") ? beats.split("+").map(Number) : undefined;
              const n = groups ? groups.reduce((a, b) => a + b, 0) : Number(beats);
              if ([2, 4, 8, 16].includes(den) && n >= 1 && n <= 32) timeSig = { num: n, den: den as Denominator, ...(groups ? { groups } : {}) };
            }
            const tr = kid(c, "transpose");
            if (tr) {
              chromatic = num(tr, "chromatic") ?? 0;
              octave = num(tr, "octave-change") ?? 0;
            }
            const clef = kid(c, "clef");
            if (clef && mi === 0) bass = text(clef, "sign") === "F";
            break;
          }
          case "direction":
          case "sound": {
            const sound = c.nodeName === "sound" ? c : kid(c, "sound");
            const t = sound?.getAttribute("tempo");
            if (t && qpm === null) qpm = Number(t);
            break;
          }
          case "backup":
            pos -= num(c, "duration") ?? 0;
            break;
          case "forward":
            pos += num(c, "duration") ?? 0;
            maxPos = Math.max(maxPos, pos);
            break;
          case "note": {
            if (kid(c, "grace") || kid(c, "cue")) break;
            if (kid(c, "chord")) break; // keep the first (written top-most is not guaranteed, but first is the melody in most exports)
            const dur = num(c, "duration") ?? 0;
            const voice = text(c, "voice") ?? "1";
            const staff = text(c, "staff") ?? "1";
            const pitch = kid(c, "pitch");
            if (pitch && voice === "1" && staff === "1") {
              const step = text(pitch, "step") ?? "C";
              const written = (Number(text(pitch, "octave") ?? 4) + 1) * 12 + STEP_PC[step] + Number(text(pitch, "alter") ?? 0);
              const ties = kids(c, "tie").map((t) => t.getAttribute("type"));
              notes.push({
                midi: Math.round(written) + chromatic + 12 * octave,
                s: barStart + toSteps(pos),
                e: barStart + toSteps(pos + dur),
                tieStop: ties.includes("stop"),
              });
            }
            pos += dur;
            maxPos = Math.max(maxPos, pos);
            break;
          }
        }
      }
      const bar = measureSteps(timeSig ?? { num: 4, den: 4 });
      const length = toSteps(maxPos);
      if (mi === 0 && measure.getAttribute("implicit") === "yes" && length < bar) {
        // A pickup: align it to the end of the first bar.
        for (let k = startIndex; k < notes.length; k++) {
          notes[k].s += bar - length;
          notes[k].e += bar - length;
        }
      }
      barStart += bar;
    });

    // Merge ties and keep the line monophonic.
    const line: DocNote[] = [];
    for (const n of notes) {
      if (n.e <= n.s) continue;
      const prev = line[line.length - 1];
      if (prev && n.tieStop && prev.midi === n.midi && prev.e === n.s) {
        prev.e = n.e;
        continue;
      }
      if (prev && n.s < prev.e) {
        if (n.s <= prev.s) continue;
        prev.e = n.s;
      }
      line.push({ midi: n.midi, s: n.s, e: n.e });
    }
    if (concertKey === null && writtenFifths !== null) {
      const name = FIFTHS[writtenFifths + 7] ?? "C";
      const k = writtenKey(name, chromatic);
      concertKey = k === "F#" ? "Gb" : k;
    }
    parsed.push({ name: names.get(partEl.getAttribute("id") ?? "") ?? "", notes: line, transpose: [chromatic, octave], bass });
  }

  const ts: TimeSignature = timeSig ?? { num: 4, den: 4 };
  const parts: Part[] = parsed.map((p) => {
    const instrument =
      instrumentFromName(p.name) ??
      instrumentFromTranspose(p.transpose[0], p.transpose[1]) ??
      instrumentFromRange(p.notes.map((n) => n.midi), p.bass);
    const endStep = p.notes.length ? p.notes[p.notes.length - 1].e : 0;
    return { id: newId(), instrument, name: p.name, doc: { notes: p.notes, endStep }, muted: false, volume: 0.8 };
  });
  if (parts.length === 0) throw new Error("The file has no parts.");
  return normalizeLengths({
    title,
    concertKey: concertKey ?? "C",
    timeSig: ts,
    bpm: qpm ? bpmFromQuarter(qpm, ts) : 100,
    parts,
  });
}
