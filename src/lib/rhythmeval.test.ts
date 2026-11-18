// Scores rhythm settings against the anthem recording and its .mxl (run with EVAL=1).
import { existsSync, readFileSync } from "node:fs";
import { it } from "vitest";
import { importFile } from "./import";
import { RHYTHM, quantizeNotes } from "./quantize";

const DIR = "test-cases/test-case-2026-11-18T21-28-12";
it.skipIf(!process.env.EVAL || !existsSync(DIR))("rhythm settings vs the anthem score", () => {
  const truth = importFile("a.mxl", new Uint8Array(readFileSync(`${DIR}/national-anthem-for-sax.mxl`))).parts[0].doc.notes;
  const s = JSON.parse(readFileSync(`${DIR}/session.json`, "utf8"));
  const ev = JSON.parse(readFileSync(`${DIR}/replayed.json`, "utf8"));
  const notes: any[] = [];
  for (const e of ev) {
    const t = e.timestampMs - s.gridOriginEngineMs;
    const o = notes[notes.length - 1];
    if (o && Number.isNaN(o.endMs)) o.endMs = t;
    if (e.kind === "noteOn") notes.push({ midi: e.concertMidi, startMs: t, endMs: NaN, live: false });
  }
  notes[notes.length - 1].endMs = notes[notes.length - 1].startMs + 600;
  const key = (n: { midi: number; s: number; e: number }) => `${n.midi}@${n.s}-${n.e}`;
  const want = new Set(truth.map(key));
  const wantStart = new Set(truth.map((n) => `${n.midi}@${n.s}`));
  const base = { ...RHYTHM };
  const trial = (label: string, change: Partial<typeof RHYTHM>) => {
    Object.assign(RHYTHM, base, change);
    const q = quantizeNotes(notes, { bpm: 80, timeSig: { num: 3, den: 4 }, resolution: "16th" });
    const exact = q.filter((n) => want.has(key(n))).length;
    const starts = q.filter((n) => wantStart.has(`${n.midi}@${n.s}`)).length;
    process.stderr.write(`${label.padEnd(34)} exact ${exact}/${truth.length}   right start ${starts}/${truth.length}   notes ${q.length}\n`);
  };
  trial("current", {});
  trial("old rule: only short notes held", { holdToBeat: false });
  trial("no alignment", { maxAlign: 0 });
  trial("alignment needs more evidence", { alignPenalty: 0.06 });
  trial("wider alignment window (12)", { alignWindow: 12 });
  trial("beat snap 0.22", { beatSnap: 0.22 });
  trial("no align + beat snap 0.22", { maxAlign: 0, beatSnap: 0.22 });
  trial("penalty 0.06 + window 12", { alignPenalty: 0.06, alignWindow: 12 });
  Object.assign(RHYTHM, base);
});
