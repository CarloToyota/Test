// Standard MIDI File (format 0) export at concert pitch.

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

export function toMidi(notes: DocNote[], o: { bpm: number; timeSig: TimeSignature; instrument: InstrumentId; title: string }): Uint8Array {
  const events: Array<{ tick: number; order: number; bytes: number[] }> = [];
  const usPerQuarter = Math.round(60_000_000 / quarterBpm(o.bpm, o.timeSig));
  const title = Array.from(new TextEncoder().encode(o.title));
  events.push({ tick: 0, order: 0, bytes: [0xff, 0x03, ...vlq(title.length), ...title] });
  events.push({ tick: 0, order: 0, bytes: [0xff, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff] });
  events.push({ tick: 0, order: 0, bytes: [0xff, 0x58, 0x04, o.timeSig.num, Math.log2(o.timeSig.den), 24, 8] });
  events.push({ tick: 0, order: 0, bytes: [0xc0, GM_PROGRAM[o.instrument]] });
  for (const n of notes) {
    events.push({ tick: n.s * TICKS_PER_STEP, order: 2, bytes: [0x90, n.midi, 90] });
    // Note-offs sort before note-ons at the same tick, so repeated notes re-attack.
    events.push({ tick: n.e * TICKS_PER_STEP, order: 1, bytes: [0x80, n.midi, 0] });
  }
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const track: number[] = [];
  let last = 0;
  for (const e of events) {
    track.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  track.push(0x00, 0xff, 0x2f, 0x00);

  return new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(0), ...u16(1), ...u16(PPQ),
    0x4d, 0x54, 0x72, 0x6b, ...u32(track.length), ...track,
  ]);
}
