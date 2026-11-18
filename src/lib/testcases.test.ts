// Regression tests from real recordings. Each folder in /test-cases holds what the app's
// "Save test case" button wrote (session.json + recording.wav). Optional files:
//   replayed.json  events from the *current* engine (cargo run --release --example replay)
//   expected.txt   the correct notation, one bar per line, same format as session.detected
// With expected.txt present the case must match it; without it the result is printed.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_INSTRUMENTS } from "./demo";
import { parseTimeSignature } from "./meter";
import { displayName, writtenKey } from "./music";
import { layoutMeasures, quantizeNotes, type TimedNote } from "./quantize";
import type { NoteEvent, Resolution } from "./types";

const ROOT = join(process.cwd(), "test-cases");
const cases = existsSync(ROOT)
  ? readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(ROOT, d.name, "session.json")))
  : [];

interface Session {
  description: string;
  instrument: string;
  concertKey: string;
  bpm: number;
  timeSignature: string;
  resolution: Resolution;
  gridOriginEngineMs: number;
  events: NoteEvent[];
}

export function notateEvents(events: NoteEvent[], s: Session): string[] {
  const inst = DEMO_INSTRUMENTS.find((i) => i.id === s.instrument) ?? DEMO_INSTRUMENTS[0];
  const key = writtenKey(s.concertKey, inst.transposeSemitones);
  const timed: TimedNote[] = [];
  for (const e of events) {
    const t = e.timestampMs - s.gridOriginEngineMs;
    const open = timed[timed.length - 1];
    if (open && Number.isNaN(open.endMs)) open.endMs = t;
    if (e.kind === "noteOn") timed.push({ midi: e.concertMidi + inst.transposeSemitones, startMs: t, endMs: NaN, live: false });
  }
  const last = timed[timed.length - 1];
  if (last && Number.isNaN(last.endMs)) last.endMs = last.startMs + 100;
  const ts = parseTimeSignature(s.timeSignature);
  const q = quantizeNotes(timed, { bpm: s.bpm, timeSig: ts, resolution: s.resolution ?? "16th" });
  return layoutMeasures(q, 0, ts).map((m) =>
    m.items.map((i) => `${i.kind === "rest" ? "r" : displayName(i.midi, key)}:${i.duration}${i.dots ? "." : ""}${i.tieToNext ? "~" : ""}`).join(" "),
  );
}

describe.skipIf(cases.length === 0)("real-world test cases", () => {
  for (const c of cases) {
    it(c.name, () => {
      const dir = join(ROOT, c.name);
      const session = JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) as Session;
      const replayed = join(dir, "replayed.json");
      const events = existsSync(replayed) ? (JSON.parse(readFileSync(replayed, "utf8")) as NoteEvent[]) : session.events;
      const bars = notateEvents(events, session);
      const expectedPath = join(dir, "expected.txt");
      if (existsSync(expectedPath)) {
        const expected = readFileSync(expectedPath, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
        expect(bars).toEqual(expected);
      } else {
        console.log(`\n${c.name}: ${session.description}\n` + bars.map((b, i) => `  ${i + 1}| ${b}`).join("\n"));
      }
    });
  }
});
