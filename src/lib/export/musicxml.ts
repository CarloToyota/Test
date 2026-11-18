// MusicXML 4.0 (partwise) export: opens in MuseScore, Finale, Sibelius, Dorico, Noteflight.
// Pitches are written pitch; a <transpose> element tells the reader how the part sounds.

import { beatSteps, isCompound, measureSteps, quarterBpm, type TimeSignature } from "../meter";
import { keyAlter, keyFifths, spell } from "../music";
import type { ScoreMeasure } from "../quantize";
import type { Clef } from "../types";

export interface MusicXmlOptions {
  title: string;
  partName: string;
  clef: Clef;
  /** Written key, e.g. "D". */
  keySignature: string;
  timeSig: TimeSignature;
  bpm: number;
  /** Semitones written is above concert (e.g. 14 for tenor sax). */
  transpose: number;
}

const TYPE: Record<string, string> = { w: "whole", h: "half", q: "quarter", "8": "eighth", "16": "16th" };
const ACCIDENTAL: Record<number, string> = { [-2]: "flat-flat", [-1]: "flat", 0: "natural", 1: "sharp", 2: "double-sharp" };
/** Diatonic steps for each transposition within an octave. */
const DIATONIC: Record<number, number> = { 0: 0, 2: 1, 7: 4, 9: 5 };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function transposeXml(t: number): string {
  if (t === 0) return "";
  const within = ((t % 12) + 12) % 12;
  const octaves = Math.floor(t / 12);
  return (
    `<transpose><diatonic>${-(DIATONIC[within] ?? 0)}</diatonic><chromatic>${-within}</chromatic>` +
    (octaves ? `<octave-change>${-octaves}</octave-change>` : "") +
    `</transpose>`
  );
}

export function toMusicXml(measures: ScoreMeasure[], o: MusicXmlOptions): string {
  const spm = measureSteps(o.timeSig);
  const beat = beatSteps(o.timeSig);
  const beatUnit = beat === 8 ? "half" : beat === 2 ? "eighth" : "quarter";
  const out: string[] = [];
  out.push(
    `<?xml version="1.0" encoding="UTF-8" standalone="no"?>`,
    `<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">`,
    `<score-partwise version="4.0">`,
    `<work><work-title>${esc(o.title)}</work-title></work>`,
    `<identification><encoding><software>Band Transcriber</software></encoding></identification>`,
    `<part-list><score-part id="P1"><part-name>${esc(o.partName)}</part-name></score-part></part-list>`,
    `<part id="P1">`,
  );

  measures.forEach((m, mi) => {
    out.push(`<measure number="${mi + 1}">`);
    if (mi === 0) {
      out.push(
        `<attributes><divisions>4</divisions><key><fifths>${keyFifths(o.keySignature)}</fifths></key>` +
          `<time><beats>${o.timeSig.num}</beats><beat-type>${o.timeSig.den}</beat-type></time>` +
          (o.clef === "bass" ? `<clef><sign>F</sign><line>4</line></clef>` : `<clef><sign>G</sign><line>2</line></clef>`) +
          transposeXml(o.transpose) +
          `</attributes>`,
        `<direction placement="above"><direction-type><metronome><beat-unit>${beatUnit}</beat-unit>` +
          (isCompound(o.timeSig) ? `<beat-unit-dot/>` : "") +
          `<per-minute>${o.bpm}</per-minute></metronome></direction-type>` +
          `<sound tempo="${Math.round(quarterBpm(o.bpm, o.timeSig) * 100) / 100}"/></direction>`,
      );
    }
    // Accidentals in force in this bar, by letter+octave.
    const inForce = new Map<string, number>();
    let written = 0;
    for (const it of m.items) {
      if (it.kind === "rest") {
        if (it.measureRest) {
          out.push(`<note><rest measure="yes"/><duration>${spm}</duration></note>`);
          written = spm;
        } else {
          out.push(
            `<note><rest/><duration>${it.steps}</duration><type>${TYPE[it.duration]}</type>${it.dots ? "<dot/>" : ""}</note>`,
          );
          written += it.steps;
        }
        continue;
      }
      const p = spell(it.midi, o.keySignature);
      const id = `${p.letter}${p.octave}`;
      const current = inForce.get(id) ?? keyAlter(p.letter, o.keySignature);
      const showAcc = current !== p.alter && !it.tieFromPrev;
      inForce.set(id, p.alter);
      const ties =
        (it.tieFromPrev ? `<tie type="stop"/>` : "") + (it.tieToNext ? `<tie type="start"/>` : "");
      const tied =
        it.tieFromPrev || it.tieToNext
          ? `<notations>${it.tieFromPrev ? `<tied type="stop"/>` : ""}${it.tieToNext ? `<tied type="start"/>` : ""}</notations>`
          : "";
      out.push(
        `<note><pitch><step>${p.letter}</step>${p.alter ? `<alter>${p.alter}</alter>` : ""}<octave>${p.octave}</octave></pitch>` +
          `<duration>${it.steps}</duration>${ties}<type>${TYPE[it.duration]}</type>${it.dots ? "<dot/>" : ""}` +
          (showAcc ? `<accidental>${ACCIDENTAL[p.alter]}</accidental>` : "") +
          `${tied}</note>`,
      );
      written += it.steps;
    }
    if (m.items.length === 0 || (written < spm && !m.complete)) {
      // An unfinished last bar: pad with an invisible-length forward so readers accept it.
      if (written < spm) out.push(`<forward><duration>${spm - written}</duration></forward>`);
    }
    if (mi === measures.length - 1) out.push(`<barline location="right"><bar-style>light-heavy</bar-style></barline>`);
    out.push(`</measure>`);
  });
  out.push(`</part>`, `</score-partwise>`);
  return out.join("\n");
}
