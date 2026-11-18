// Standard MIDI File (format 1) export at concert pitch, one track per part.

import { quarterBpm, type TimeSignature } from "../meter";
import type { DocNote } from "../editor";
import type { InstrumentId } from "../types";

const PPQ = 480;
const TICKS_PER_STEP = PPQ / 4;

/** General MIDI programs (0-based). */
const GM_PROGRAM: Record<InstrumentId, number> = {
  flute: 73,
  clarinet: 71,
  altoSax: 65,
  tenorSax: 66,
  bariSax: 67,
  trumpet: 56,
  frenchHorn: 60,
  trombone: 57,
  tuba: 58,
};

function vlq(n: number): number[] {
  const bytes = [n & 0x7f];
  n >>= 7;
  while (n > 0) {
    bytes.unshift((n & 0x7f) | 0x80);
    n >>= 7;
  }
  return bytes;
}

const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u16 = (n: number) => [(n >>> 8) & 0xff, n & 0xff];

export interface MidiTrack {
  name: string;
  instrument: InstrumentId;
  /** Concert pitch. */
  notes: DocNote[];
  volume?: number;
}

/** Format 1: a tempo/meter track, then one track (and channel) per part. */
export function toMidi(tracks: MidiTrack[], o: { bpm: number; timeSig: TimeSignature; title: string }): Uint8Array {
  const usPerQuarter = Math.round(60_000_000 / quarterBpm(o.bpm, o.timeSig));
  const text = (meta: number, s: string) => {
    const b = Array.from(new TextEncoder().encode(s));
    return [0xff, meta, ...vlq(b.length), ...b];
  };
  const chunks: number[][] = [];
  chunks.push(
    encodeTrack([
      { tick: 0, order: 0, bytes: text(0x03, o.title) },
      { tick: 0, order: 0, bytes: [0xff, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff] },
      { tick: 0, order: 0, bytes: [0xff, 0x58, 0x04, o.timeSig.num, Math.log2(o.timeSig.den), 24, 8] },
    ]),
  );
  tracks.forEach((t, i) => {
    const ch = i >= 9 ? i + 1 : i; // skip the drum channel
    const vel = Math.max(1, Math.min(127, Math.round(70 + 40 * (t.volume ?? 0.8))));
    const events: TrackEvent[] = [
      { tick: 0, order: 0, bytes: text(0x03, t.name) },
      { tick: 0, order: 0, bytes: [0xc0 | (ch & 0x0f), GM_PROGRAM[t.instrument]] },
    ];
    for (const n of t.notes) {
      events.push({ tick: n.s * TICKS_PER_STEP, order: 2, bytes: [0x90 | (ch & 0x0f), n.midi, vel] });
      // Note-offs sort before note-ons at the same tick, so repeated notes re-attack.
      events.push({ tick: n.e * TICKS_PER_STEP, order: 1, bytes: [0x80 | (ch & 0x0f), n.midi, 0] });
    }
    chunks.push(encodeTrack(events));
  });
  return new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(1), ...u16(chunks.length), ...u16(PPQ),
    ...chunks.flat(),
  ]);
}

interface TrackEvent {
  tick: number;
  order: number;
  bytes: number[];
}

function encodeTrack(events: TrackEvent[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  const track: number[] = [];
  let last = 0;
  for (const e of events) {
    track.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  track.push(0x00, 0xff, 0x2f, 0x00);
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(track.length), ...track];
}
