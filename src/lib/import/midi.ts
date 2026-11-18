// Standard MIDI File import (format 0 or 1). Each track (or channel, in format 0) with
// notes becomes a part, reduced to its top line. Times are rounded to 16th notes.

import type { DocNote } from "../editor";
import { bpmFromQuarter, type Denominator, type TimeSignature } from "../meter";
import { newId, normalizeLengths, type Part, type Project } from "../project";
import { instrumentFromName, instrumentFromProgram, instrumentFromRange } from "./instruments";

interface RawNote {
  key: number;
  start: number;
  end: number;
}

interface Stream {
  name: string;
  program: number | null;
  channel: number;
  notes: RawNote[];
}

export function importMidi(bytes: Uint8Array, fallbackTitle: string): Project {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (o: number, n: number) => String.fromCharCode(...bytes.slice(o, o + n));
  if (str(0, 4) !== "MThd") throw new Error("This isn't a MIDI file.");
  const ntrks = dv.getUint16(10);
  const division = dv.getUint16(12);
  if (division & 0x8000) throw new Error("SMPTE-timed MIDI files aren't supported.");

  let tempo: number | null = null;
  let timeSig: TimeSignature | null = null;
  let title = "";
  const streams: Stream[] = [];
  let off = 8 + dv.getUint32(4);

  for (let t = 0; t < ntrks && off + 8 <= bytes.length; t++) {
    if (str(off, 4) !== "MTrk") break;
    const len = dv.getUint32(off + 4);
    let p = off + 8;
    const end = Math.min(bytes.length, p + len);
    off = end;
    let tick = 0;
    let status = 0;
    let trackName = "";
    const byChannel = new Map<number, Stream>();
    const open = new Map<string, number>();
    const vlq = () => {
      let v = 0;
      let b: number;
      do {
        b = bytes[p++];
        v = (v << 7) | (b & 0x7f);
      } while (b & 0x80 && p < end);
      return v;
    };
    const stream = (ch: number) => {
      let s = byChannel.get(ch);
      if (!s) byChannel.set(ch, (s = { name: "", program: null, channel: ch, notes: [] }));
      return s;
    };
    while (p < end) {
      tick += vlq();
      let b = bytes[p];
      if (b & 0x80) {
        status = b;
        p++;
      } else b = status;
      const type = status & 0xf0;
      const ch = status & 0x0f;
      if (status === 0xff) {
        const meta = bytes[p++];
        const l = vlq();
        if (meta === 0x03) trackName = new TextDecoder().decode(bytes.slice(p, p + l));
        if (meta === 0x51 && tempo === null) tempo = (bytes[p] << 16) | (bytes[p + 1] << 8) | bytes[p + 2];
        if (meta === 0x58 && !timeSig) {
          const den = 2 ** bytes[p + 1];
          if ([2, 4, 8, 16].includes(den) && bytes[p] >= 1 && bytes[p] <= 32) timeSig = { num: bytes[p], den: den as Denominator };
        }
        p += l;
      } else if (status === 0xf0 || status === 0xf7) {
        p += vlq();
      } else if (type === 0x90 || type === 0x80) {
        const key = bytes[p++];
        const vel = bytes[p++];
        const id = `${ch}:${key}`;
        if (type === 0x90 && vel > 0) {
          if (!open.has(id)) open.set(id, tick);
        } else if (open.has(id)) {
          stream(ch).notes.push({ key, start: open.get(id)!, end: tick });
          open.delete(id);
        }
      } else if (type === 0xc0) {
        stream(ch).program = bytes[p++];
      } else if (type === 0xd0) {
        p += 1;
      } else {
        p += 2; // A0, B0, E0
      }
    }
    if (t === 0 && !title) title = trackName;
    for (const s of byChannel.values()) {
      if (s.channel === 9 || s.notes.length === 0) continue; // drums
      s.name = trackName;
      streams.push(s);
    }
  }

  const ticksPerStep = division / 4;
  const toStep = (tk: number) => Math.round(tk / ticksPerStep);
  const parts: Part[] = streams.map((s) => {
    // Top line: at each start time keep the highest key, then make it monophonic.
    const sorted = [...s.notes].sort((a, b) => a.start - b.start || b.key - a.key);
    const line: DocNote[] = [];
    for (const n of sorted) {
      const st = toStep(n.start);
      const en = Math.max(st + 1, toStep(n.end));
      const prev = line[line.length - 1];
      if (prev && st <= prev.s) continue;
      if (prev && st < prev.e) prev.e = st;
      line.push({ midi: n.key, s: st, e: en });
    }
    const instrument =
      instrumentFromName(s.name) ??
      (s.program !== null ? instrumentFromProgram(s.program) : null) ??
      instrumentFromRange(line.map((n) => n.midi), false);
    return {
      id: newId(), instrument, name: s.name.trim(), muted: false, volume: 0.8,
      doc: { notes: line, endStep: line.length ? line[line.length - 1].e : 0 },
    };
  });
  if (parts.length === 0) throw new Error("The MIDI file has no notes.");
  const ts = timeSig ?? { num: 4, den: 4 };
  const qpm = tempo ? 60_000_000 / tempo : 100;
  return normalizeLengths({ title: title.trim() || fallbackTitle, concertKey: "C", timeSig: ts, bpm: bpmFromQuarter(qpm, ts), parts });
}
