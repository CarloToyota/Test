import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mic, Music2, Pencil, Square, Trash2, Volume2, VolumeX } from "lucide-react";
import { BeatIndicator } from "./components/BeatIndicator";
import { EditorToolbar } from "./components/EditorToolbar";
import { ExportMenu, type ExportKind } from "./components/ExportMenu";
import { LivePanel } from "./components/LivePanel";
import { SheetMusic } from "./components/SheetMusic";
import { engine, isTauri } from "./lib/bridge";
import { EngineClock } from "./lib/clock";
import {
  DURATION_KEYS,
  addMeasure,
  deleteNote,
  docFromNotes,
  docToQNotes,
  insertNote,
  noteIndexAt,
  removeLastMeasure,
  selectablePositions,
  setDuration,
  setPitch,
  toggleDot,
  transposeNote,
  type ScoreDoc,
} from "./lib/editor";
import { toMidi } from "./lib/export/midi";
import { toMusicXml } from "./lib/export/musicxml";
import type { PageSize } from "./lib/export/pdf";
import { fileStem, saveFile } from "./lib/export/save";
import {
  TIME_SIGNATURES,
  beatUnitSymbol,
  beatsPerBar,
  measureSteps,
  parseTimeSignature,
  type TimeSignature,
} from "./lib/meter";
import { Metronome } from "./lib/metronome";
import { CONCERT_KEYS, displayKey, displayName, letterNear, writtenKey, type Letter } from "./lib/music";
import {
  buildScore,
  layoutMeasures,
  quantizeNotes,
  scoreSignature,
  type ScoreItem,
  type ScoreMeasure,
  type TimedNote,
} from "./lib/quantize";
import type {
  CaptureInfo,
  EngineStatus,
  InputDevice,
  InstrumentId,
  InstrumentInfo,
  NoteEvent,
  Resolution,
} from "./lib/types";

/** A note as recorded, in performance.now() time and concert pitch. */
interface RecordedNote {
  concertMidi: number;
  startPerf: number;
  endPerf: number | null;
}

/** Settings a take was recorded with (the grid its timing refers to). */
interface TakeSettings {
  bpm: number;
  timeSig: TimeSignature;
  gridOriginPerf: number;
}

interface LiveSettings {
  bpm: number;
  timeSig: TimeSignature;
  resolution: Resolution;
  latencyMs: number;
}

type RunState = "idle" | "starting" | "running";

const RESOLUTIONS: Array<{ value: Resolution; label: string }> = [
  { value: "16th", label: "16th" },
  { value: "8th", label: "8th" },
  { value: "beat", label: "Beat" },
];

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);

export default function App() {
  const [instruments, setInstruments] = useState<InstrumentInfo[]>([]);
  const [instrumentId, setInstrumentId] = useState<InstrumentId>("altoSax");
  const [concertKey, setConcertKey] = useState<string>("Bb");
  const [bpm, setBpm] = useState(100);
  const [timeSigName, setTimeSigName] = useState<string>("4/4");
  const [resolution, setResolution] = useState<Resolution>("16th");
  const [clickOn, setClickOn] = useState(true);
  const [latencyMs, setLatencyMs] = useState(30);
  const [devices, setDevices] = useState<InputDevice[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [title, setTitle] = useState("Untitled");

  const [runState, setRunState] = useState<RunState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [captureInfo, setCaptureInfo] = useState<CaptureInfo | null>(null);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [live, setLive] = useState<{ measures: ScoreMeasure[]; signature: string }>({ measures: [], signature: "" });
  const [beat, setBeat] = useState<{ beat: number | null; countIn: boolean }>({ beat: null, countIn: false });

  // The editable score (concert pitch), its undo history, and the editor state.
  const [doc, setDoc] = useState<ScoreDoc | null>(null);
  const [edited, setEdited] = useState(false);
  const [past, setPast] = useState<ScoreDoc[]>([]);
  const [future, setFuture] = useState<ScoreDoc[]>([]);
  const [editMode, setEditMode] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [inputSteps, setInputSteps] = useState(4);
  const [hasTake, setHasTake] = useState(false);

  const notesRef = useRef<RecordedNote[]>([]);
  const eventLogRef = useRef<NoteEvent[]>([]);
  const takeRef = useRef<TakeSettings | null>(null);
  const clockRef = useRef(new EngineClock());
  const metronomeRef = useRef(new Metronome());
  const firstBeatRef = useRef(0); // perf time of the first count-in click
  const runningRef = useRef(false);

  const timeSig = useMemo(() => parseTimeSignature(timeSigName), [timeSigName]);
  const spm = measureSteps(timeSig);
  const instrument = useMemo(
    () => instruments.find((i) => i.id === instrumentId) ?? instruments[0],
    [instruments, instrumentId],
  );
  const transpose = instrument?.transposeSemitones ?? 0;
  const clef = instrument?.clef ?? "treble";
  const keySignature = writtenKey(concertKey, transpose);

  const liveRef = useRef<LiveSettings>({ bpm, timeSig, resolution, latencyMs });
  liveRef.current = { bpm, timeSig, resolution, latencyMs };
  const transposeRef = useRef(transpose);
  transposeRef.current = transpose;

  // ---- engine wiring -------------------------------------------------------------

  useEffect(() => {
    engine.getInstruments().then(setInstruments).catch((e) => setError(String(e)));
    engine
      .listInputDevices()
      .then((list) => {
        setDevices(list);
        setDeviceId(list.find((d) => d.isDefault)?.id ?? list[0]?.id ?? null);
      })
      .catch((e) => setError(`Could not list microphones: ${e}`));
  }, []);

  const handleNote = useCallback((e: NoteEvent) => {
    if (!runningRef.current) return;
    eventLogRef.current.push(e);
    const perf = clockRef.current.toPerf(e.timestampMs) - liveRef.current.latencyMs;
    const notes = notesRef.current;
    const open = notes.length ? notes[notes.length - 1] : null;
    if (open && open.endPerf === null) open.endPerf = Math.max(open.startPerf, perf);
    if (e.kind === "noteOn") notes.push({ concertMidi: e.concertMidi, startPerf: perf, endPerf: null });
  }, []);

  const handleStatus = useCallback((s: EngineStatus) => {
    clockRef.current.observe(s.timestampMs);
    setStatus(s);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    engine.subscribe({ onNote: handleNote, onStatus: handleStatus }).then((off) => {
      if (cancelled) off();
      else unlisten = off;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [handleNote, handleStatus]);

  /** Recorded notes as timed notes relative to the take's grid. */
  const timedNotes = useCallback((liveEndPerf: number, midiOffset: number): TimedNote[] => {
    const origin = takeRef.current?.gridOriginPerf ?? 0;
    return notesRef.current.map((n) => ({
      midi: n.concertMidi + midiOffset,
      startMs: n.startPerf - origin,
      endMs: (n.endPerf ?? liveEndPerf) - origin,
      live: n.endPerf === null,
    }));
  }, []);

  // ---- live score + visual metronome --------------------------------------------------

  useEffect(() => {
    if (runState !== "running") return;
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      const s = liveRef.current;
      const take = takeRef.current!;
      const beatMs = 60000 / take.bpm;
      const perBar = beatsPerBar(take.timeSig);
      const sinceFirst = now - firstBeatRef.current;
      if (sinceFirst >= 0) {
        const beatIndex = Math.floor(sinceFirst / beatMs);
        const next = { beat: beatIndex % perBar, countIn: beatIndex < perBar };
        setBeat((prev) => (prev.beat === next.beat && prev.countIn === next.countIn ? prev : next));
      }
      // Notes are latency-compensated, so the score's "now" is too.
      const scoreNow = now - s.latencyMs;
      const measures = buildScore(timedNotes(scoreNow, transposeRef.current), scoreNow - take.gridOriginPerf, {
        bpm: take.bpm,
        timeSig: take.timeSig,
        resolution: s.resolution,
      });
      const signature = scoreSignature(measures);
      setLive((prev) => (prev.signature === signature ? prev : { measures, signature }));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [runState, timedNotes]);

  /** Turn the recorded take into an editable score (unless it has been edited). */
  const rebuildDocFromTake = useCallback(() => {
    const take = takeRef.current;
    if (!take || notesRef.current.length === 0) return;
    const q = quantizeNotes(timedNotes(0, 0), {
      bpm: take.bpm,
      timeSig: take.timeSig,
      resolution: liveRef.current.resolution,
    });
    setDoc(docFromNotes(q, measureSteps(take.timeSig)));
  }, [timedNotes]);

  // Changing the grid after a take re-reads the take, until the score has been edited.
  useEffect(() => {
    if (runState === "idle" && !edited) rebuildDocFromTake();
  }, [resolution, runState, edited, rebuildDocFromTake]);

  // ---- recording controls ------------------------------------------------------------

  const start = async () => {
    setError(null);
    setRunState("starting");
    setEditMode(false);
    try {
      notesRef.current = [];
      eventLogRef.current = [];
      clockRef.current.reset();
      const info = await engine.start(instrumentId, deviceId);
      setCaptureInfo(info);
      const perBar = beatsPerBar(timeSig);
      const timing = await metronomeRef.current.start(bpm, perBar, clickOn);
      firstBeatRef.current = timing.firstBeatPerf;
      takeRef.current = { bpm, timeSig, gridOriginPerf: timing.firstBeatPerf + perBar * timing.beatMs };
      runningRef.current = true;
      setLive({ measures: [], signature: "" });
      setDoc(null);
      setEdited(false);
      setPast([]);
      setFuture([]);
      setRunState("running");
    } catch (e) {
      metronomeRef.current.stop();
      runningRef.current = false;
      setRunState("idle");
      setError(String(e));
    }
  };

  const stop = async () => {
    metronomeRef.current.stop();
    try {
      await engine.stop();
    } catch (e) {
      setError(String(e));
    }
    runningRef.current = false;
    const now = performance.now() - liveRef.current.latencyMs;
    const open = notesRef.current[notesRef.current.length - 1];
    if (open && open.endPerf === null) open.endPerf = now;
    setHasTake(notesRef.current.length > 0 || eventLogRef.current.length > 0);
    setBeat({ beat: null, countIn: false });
    setStatus(null);
    setRunState("idle");
    if (notesRef.current.length === 0) setDoc(null);
  };

  const clear = () => {
    notesRef.current = [];
    setLive({ measures: [], signature: "" });
    setDoc(null);
    setEdited(false);
    setPast([]);
    setFuture([]);
    setCursor(0);
    if (runningRef.current && takeRef.current) {
      // Restart the page at the next barline, keeping the metronome running.
      const take = takeRef.current;
      const barMs = (60000 / take.bpm) * beatsPerBar(take.timeSig);
      const now = performance.now() - latencyMs;
      const elapsedBars = Math.ceil((now - take.gridOriginPerf) / barMs);
      take.gridOriginPerf += Math.max(0, elapsedBars) * barMs;
    }
  };

  const changeInstrument = (id: InstrumentId) => {
    setInstrumentId(id);
    if (runningRef.current) engine.setInstrument(id).catch((e) => setError(String(e)));
  };

  const toggleClick = () => {
    const next = !clickOn;
    setClickOn(next);
    metronomeRef.current.setAudible(next);
  };

  useEffect(() => () => metronomeRef.current.stop(), []);

  const running = runState === "running";

  // ---- the editable score ------------------------------------------------------------

  const docMeasures = useMemo(
    () => (doc ? layoutMeasures(docToQNotes(doc, transpose), doc.endStep, timeSig) : []),
    [doc, transpose, timeSig],
  );

  const apply = useCallback(
    (next: ScoreDoc) => {
      if (!doc || next === doc) return;
      setPast((p) => [...p.slice(-199), doc]);
      setFuture([]);
      setDoc(next);
      setEdited(true);
    },
    [doc],
  );

  const undo = useCallback(() => {
    if (!doc || past.length === 0) return;
    setFuture((f) => [doc, ...f]);
    setDoc(past[past.length - 1]);
    setPast((p) => p.slice(0, -1));
    setEdited(true);
  }, [doc, past]);

  const redo = useCallback(() => {
    if (!doc || future.length === 0) return;
    setPast((p) => [...p, doc]);
    setDoc(future[0]);
    setFuture((f) => f.slice(1));
  }, [doc, future]);

  const toggleEdit = () => {
    if (editMode) {
      setEditMode(false);
      return;
    }
    if (!doc) {
      // Start a blank score to write into.
      setDoc({ notes: [], endStep: spm * 4 });
      setEdited(true);
    }
    setCursor(0);
    setEditMode(true);
  };

  const selectedNoteIndex = doc ? noteIndexAt(doc, cursor) : -1;
  const selectedNote = doc && selectedNoteIndex >= 0 ? doc.notes[selectedNoteIndex] : null;

  const isSelected = useCallback(
    (item: ScoreItem) => {
      if (!doc) return false;
      if (item.kind === "note") return doc.notes[item.noteIndex]?.s === cursor;
      return item.start <= cursor && cursor < item.start + item.steps;
    },
    [doc, cursor],
  );

  const onSelect = useCallback(
    (item: ScoreItem) => {
      if (!doc) return;
      setCursor(item.kind === "note" ? doc.notes[item.noteIndex].s : item.start);
    },
    [doc],
  );

  /** Written pitch to measure a typed letter against: this note, else the one before. */
  const referencePitch = useCallback((): number => {
    if (!doc) return clef === "bass" ? 50 : 71;
    const prev = [...doc.notes].reverse().find((n) => n.s <= cursor);
    if (prev) return prev.midi + transpose;
    return clef === "bass" ? 50 : 71;
  }, [doc, cursor, transpose, clef]);

  const writeLetter = useCallback(
    (letter: Letter) => {
      if (!doc) return;
      const written = letterNear(letter, keySignature, referencePitch());
      const concert = written - transpose;
      if (selectedNote) {
        apply(setPitch(doc, cursor, concert));
      } else {
        apply(insertNote(doc, cursor, inputSteps, concert, spm));
        setCursor(cursor + inputSteps);
      }
    },
    [doc, keySignature, referencePitch, transpose, selectedNote, apply, cursor, inputSteps, spm],
  );

  const chooseDuration = useCallback(
    (steps: number) => {
      setInputSteps(steps);
      if (doc && selectedNote) apply(setDuration(doc, cursor, steps, spm));
    },
    [doc, selectedNote, apply, cursor, spm],
  );

  const moveCursor = useCallback(
    (dir: 1 | -1) => {
      const positions = selectablePositions(docMeasures);
      if (positions.length === 0) return;
      let i = positions.findIndex((p) => p >= cursor);
      if (i < 0) i = positions.length;
      const exact = positions[i] === cursor;
      const target = dir > 0 ? (exact ? i + 1 : i) : i - 1;
      setCursor(positions[Math.max(0, Math.min(positions.length - 1, target))]);
    },
    [docMeasures, cursor],
  );

  useEffect(() => {
    if (!editMode || !doc) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key;
      let handled = true;
      if (mod && key.toLowerCase() === "z") (e.shiftKey ? redo : undo)();
      else if (mod && key.toLowerCase() === "y") redo();
      else if (key === "ArrowRight") moveCursor(1);
      else if (key === "ArrowLeft") moveCursor(-1);
      else if (key === "ArrowUp") apply(transposeNote(doc, cursor, mod ? 12 : 1));
      else if (key === "ArrowDown") apply(transposeNote(doc, cursor, mod ? -12 : -1));
      else if (!mod && /^[a-gA-G]$/.test(key)) writeLetter(key.toUpperCase() as Letter);
      else if (!mod && DURATION_KEYS[key]) chooseDuration(DURATION_KEYS[key]);
      else if (!mod && key === ".") apply(toggleDot(doc, cursor, spm));
      else if (key === "Delete" || key === "Backspace" || (!mod && key === "0")) apply(deleteNote(doc, cursor));
      else if (key === "Escape") setEditMode(false);
      else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editMode, doc, cursor, spm, apply, undo, redo, moveCursor, writeLetter, chooseDuration]);

  const selectionLabel = !doc
    ? ""
    : selectedNote
      ? `Selected: ${displayName(selectedNote.midi + transpose, keySignature)} (written), bar ${Math.floor(cursor / spm) + 1}`
      : `Rest selected, bar ${Math.floor(cursor / spm) + 1}`;

  // ---- export ---------------------------------------------------------------------------

  const exportScore = async (kind: ExportKind, pageSize: PageSize): Promise<string | null> => {
    if (!doc || !instrument) return null;
    const stem = fileStem(title);
    const takeBpm = takeRef.current?.bpm ?? bpm;
    if (kind === "pdf") {
      const { toPdf } = await import("./lib/export/pdf");
      const bytes = await toPdf(docMeasures, {
        title, partName: instrument.name, clef, keySignature, timeSig, bpm: takeBpm, pageSize,
      });
      return saveFile({ bytes, defaultName: `${stem}.pdf`, filterName: "PDF", extension: "pdf", mime: "application/pdf" });
    }
    if (kind === "musicxml") {
      const xml = toMusicXml(docMeasures, {
        title, partName: instrument.name, clef, keySignature, timeSig, bpm: takeBpm, transpose,
      });
      return saveFile({
        bytes: new TextEncoder().encode(xml), defaultName: `${stem}.musicxml`, filterName: "MusicXML",
        extension: "musicxml", mime: "application/vnd.recordare.musicxml+xml",
      });
    }
    const bytes = toMidi(doc.notes, { bpm: takeBpm, timeSig, instrument: instrument.id, title });
    return saveFile({ bytes, defaultName: `${stem}.mid`, filterName: "MIDI", extension: "mid", mime: "audio/midi" });
  };

  const exportTestCase = async (description: string): Promise<string | null> => {
    const take = takeRef.current;
    if (!take) return null;
    const { invoke } = await import("@tauri-apps/api/core");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const session = {
      format: "band-transcriber-test-case",
      version: 1,
      createdAt: new Date().toISOString(),
      description,
      instrument: instrumentId,
      concertKey,
      bpm: take.bpm,
      timeSignature: `${take.timeSig.num}/${take.timeSig.den}`,
      resolution,
      latencyMs,
      clickOn,
      captureInfo,
      // Engine-clock time of bar 1 beat 1: event.timestampMs - this = position in ms.
      gridOriginEngineMs: clockRef.current.toEngine(take.gridOriginPerf) + latencyMs,
      events: eventLogRef.current,
      detected: docMeasures.map((m) =>
        m.items.map((i) => `${i.kind === "rest" ? "r" : displayName(i.midi, keySignature)}:${i.duration}${i.dots ? "." : ""}${i.tieToNext ? "~" : ""}`).join(" "),
      ),
    };
    return invoke<string | null>("export_test_case", {
      folderName: `test-case-${stamp}`,
      sessionJson: JSON.stringify(session, null, 2),
    });
  };

  // ---- view -------------------------------------------------------------------------------

  const showDoc = !running && doc !== null;
  const measures = showDoc ? docMeasures : live.measures;
  const signature = showDoc ? `${scoreSignature(docMeasures)}#${editMode ? cursor : "-"}` : live.signature;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Music2 size={22} aria-hidden />
          <span>Band Transcriber</span>
          {engine.isDemo && <span className="badge" title="Not running inside Tauri: a scripted melody stands in for the microphone">demo</span>}
        </div>
        <div className="topbar-actions">
          {running ? (
            <button className="btn btn-stop" onClick={stop}>
              <Square size={16} aria-hidden /> Stop
            </button>
          ) : (
            <button className="btn btn-primary" onClick={start} disabled={runState === "starting" || !instrument}>
              <Mic size={16} aria-hidden /> {runState === "starting" ? "Starting…" : "Record"}
            </button>
          )}
          <button className={`btn ${editMode ? "is-active" : ""}`} onClick={toggleEdit} disabled={running} aria-pressed={editMode}>
            <Pencil size={16} aria-hidden /> {editMode ? "Done" : "Edit"}
          </button>
          <ExportMenu
            title={title}
            onTitle={setTitle}
            disabled={running || !doc}
            onExport={exportScore}
            onExportTestCase={isTauri() && hasTake ? exportTestCase : undefined}
          />
          <button className="btn" onClick={clear} title="Clear the page">
            <Trash2 size={16} aria-hidden /> Clear
          </button>
        </div>
      </header>

      <section className="controls">
        <label className="field">
          <span>Instrument</span>
          <select id="instrument" value={instrumentId} onChange={(e) => changeInstrument(e.target.value as InstrumentId)}>
            {instruments.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Concert key</span>
          <select id="concert-key" value={concertKey} onChange={(e) => setConcertKey(e.target.value)}>
            {CONCERT_KEYS.map((k) => (
              <option key={k} value={k}>
                {displayKey(k)} major
              </option>
            ))}
          </select>
        </label>

        <label className="field field-narrow">
          <span>Tempo {beatUnitSymbol(timeSig)} =</span>
          <input
            id="bpm"
            type="number"
            min={30}
            max={300}
            value={bpm}
            disabled={running}
            onChange={(e) => setBpm(Math.max(30, Math.min(300, Number(e.target.value) || 100)))}
          />
        </label>

        <label className="field field-narrow">
          <span>Time</span>
          <select id="time-signature" value={timeSigName} disabled={running} onChange={(e) => setTimeSigName(e.target.value)}>
            {TIME_SIGNATURES.map((t) => (
              <option key={t} value={t}>
                {t === "2/2" ? "2/2 (cut)" : t}
              </option>
            ))}
          </select>
        </label>

        <div className="field">
          <span>Grid</span>
          <div className="segmented" role="group" aria-label="Snap notes to">
            {RESOLUTIONS.map((r) => (
              <button
                key={r.value}
                className={resolution === r.value ? "is-active" : ""}
                onClick={() => setResolution(r.value)}
                disabled={edited && !running}
                title={edited && !running ? "The score has been edited; the grid applies to new takes" : undefined}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span>Click</span>
          <button className={`btn btn-icon ${clickOn ? "is-active" : ""}`} onClick={toggleClick} aria-pressed={clickOn} title="Audible metronome">
            {clickOn ? <Volume2 size={16} aria-hidden /> : <VolumeX size={16} aria-hidden />}
            {clickOn ? "On" : "Off"}
          </button>
        </div>

        <label className="field field-narrow" title="Shifts notes earlier to cancel mic + speaker delay">
          <span>Latency {latencyMs} ms</span>
          <input id="latency" type="range" min={0} max={150} step={5} value={latencyMs} onChange={(e) => setLatencyMs(Number(e.target.value))} />
        </label>

        <label className="field field-wide">
          <span>Microphone</span>
          <select id="microphone" value={deviceId ?? ""} disabled={running} onChange={(e) => setDeviceId(e.target.value || null)}>
            {devices.length === 0 && <option value="">Default input</option>}
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
                {d.isDefault ? " (default)" : ""}
              </option>
            ))}
          </select>
        </label>
      </section>

      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}

      {editMode && doc ? (
        <EditorToolbar
          inputSteps={inputSteps}
          onDuration={chooseDuration}
          onDot={() => apply(toggleDot(doc, cursor, spm))}
          onTranspose={(s) => apply(transposeNote(doc, cursor, s))}
          onDelete={() => apply(deleteNote(doc, cursor))}
          onAddMeasure={() => apply(addMeasure(doc, spm))}
          onRemoveMeasure={() => apply(removeLastMeasure(doc, spm))}
          onUndo={undo}
          onRedo={redo}
          canUndo={past.length > 0}
          canRedo={future.length > 0}
          hasNote={!!selectedNote}
          selectionLabel={selectionLabel}
        />
      ) : (
        <section className="strip">
          <LivePanel
            status={status}
            writtenKey={keySignature}
            concertKeyName={concertKey}
            transpose={transpose}
            running={running}
          />
          <div className="strip-side">
            <BeatIndicator beatsPerMeasure={beatsPerBar(timeSig)} beat={beat.beat} countIn={beat.countIn} />
            <div className="facts">
              <span>
                {instrument ? `${instrument.name} · ${instrument.key === "C" ? "concert pitch" : `in ${displayKey(instrument.key)}`}` : ""}
              </span>
              <span>written key {displayKey(keySignature)} · {clef} clef</span>
              {captureInfo && (
                <span>
                  {captureInfo.sampleRate / 1000} kHz · window {captureInfo.analysisWindow} · band {captureInfo.bandLowHz.toFixed(0)}–
                  {captureInfo.bandHighHz.toFixed(0)} Hz
                </span>
              )}
            </div>
          </div>
        </section>
      )}

      <main className={`sheet ${editMode ? "is-editing" : ""}`}>
        <SheetMusic
          measures={measures}
          clef={clef}
          keySignature={keySignature}
          timeSig={timeSigName}
          signature={signature}
          isSelected={editMode ? isSelected : undefined}
          onSelect={editMode ? onSelect : undefined}
          followEnd={running}
          label={editMode ? "Score editor" : "Transcription"}
        />
      </main>
    </div>
  );
}
