import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mic, Music2, Pause, Pencil, Play, Square, Trash2, Volume2, VolumeX } from "lucide-react";
import { BeatIndicator } from "./components/BeatIndicator";
import { EditorToolbar } from "./components/EditorToolbar";
import { ExportMenu, type ExportKind, type PdfScope } from "./components/ExportMenu";
import { FileMenu } from "./components/FileMenu";
import { LivePanel } from "./components/LivePanel";
import { MeterField } from "./components/MeterField";
import { PartsPanel } from "./components/PartsPanel";
import { SheetMusic, type PlayheadSource } from "./components/SheetMusic";
import { engine, isTauri } from "./lib/bridge";
import { EngineClock } from "./lib/clock";
import {
  DURATION_KEYS,
  deleteNote,
  docToQNotes,
  insertNote,
  noteIndexAt,
  selectablePositions,
  setDuration,
  setPitch,
  toggleDot,
  transposeNote,
  type DocNote,
  type ScoreDoc,
} from "./lib/editor";
import { toMidi } from "./lib/export/midi";
import { toMusicXml } from "./lib/export/musicxml";
import type { PageSize, PdfSection } from "./lib/export/pdf";
import { fileStem, openFile, saveFile } from "./lib/export/save";
import { IMPORT_EXTENSIONS, importFile } from "./lib/import";
import { beatSteps, beatUnitSymbol, beatsPerBar, measureSteps, meterName, metronomePattern } from "./lib/meter";
import { Metronome } from "./lib/metronome";
import { CONCERT_KEYS, displayKey, displayName, letterNear, writtenKey, type Letter } from "./lib/music";
import { Player, type PlaybackPart } from "./lib/playback";
import {
  PROJECT_EXTENSION,
  emptyProject,
  newId,
  newPart,
  normalizeLengths,
  partLabel,
  projectEndStep,
  scoreOrder,
  serializeProject,
  updatePart,
  type Part,
  type Project,
} from "./lib/project";
import {
  buildScore,
  layoutMeasures,
  quantizeNotes,
  scoreSignature,
  type ScoreItem,
  type ScoreMeasure,
  type TimedNote,
} from "./lib/quantize";
import type { StaffInput } from "./lib/render";
import type { CaptureInfo, EngineStatus, InputDevice, InstrumentId, InstrumentInfo, NoteEvent, Resolution } from "./lib/types";

/** A note as recorded, in performance.now() time and concert pitch. */
interface RecordedNote {
  concertMidi: number;
  startPerf: number;
  endPerf: number | null;
}

/** Everything a take needs to become part of the score. */
interface Take {
  partId: string;
  mode: "replace" | "append";
  /** Step in the score where the take's bar 1 lands. */
  offset: number;
  /** The project before the take (for re-reading the take with another grid). */
  base: Project;
  gridOriginPerf: number;
}

type RunState = "idle" | "starting" | "running";
type ViewMode = "score" | "part";

const RESOLUTIONS: Array<{ value: Resolution; label: string }> = [
  { value: "16th", label: "16th" },
  { value: "8th", label: "8th" },
  { value: "beat", label: "Beat" },
];

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);

export default function App() {
  const [instruments, setInstruments] = useState<InstrumentInfo[]>([]);
  const [project, setProject] = useState<Project>(() => emptyProject("altoSax"));
  const [past, setPast] = useState<Project[]>([]);
  const [future, setFuture] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<string>(() => project.parts[0].id);
  const [viewMode, setViewMode] = useState<ViewMode>("score");

  const [resolution, setResolution] = useState<Resolution>("16th");
  const [clickOn, setClickOn] = useState(true);
  const [latencyMs, setLatencyMs] = useState(30);
  const [devices, setDevices] = useState<InputDevice[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [recordMode, setRecordMode] = useState<"replace" | "append">("replace");
  const [playAlong, setPlayAlong] = useState(true);

  const [runState, setRunState] = useState<RunState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [captureInfo, setCaptureInfo] = useState<CaptureInfo | null>(null);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [live, setLive] = useState<{ measures: ScoreMeasure[]; signature: string }>({ measures: [], signature: "" });
  const [beat, setBeat] = useState<{ beat: number | null; countIn: boolean }>({ beat: null, countIn: false });

  const [editMode, setEditMode] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [inputSteps, setInputSteps] = useState(4);
  const [editedSinceTake, setEditedSinceTake] = useState(true);
  const [hasTake, setHasTake] = useState(false);
  const [playing, setPlaying] = useState(false);

  const notesRef = useRef<RecordedNote[]>([]);
  const eventLogRef = useRef<NoteEvent[]>([]);
  const takeRef = useRef<Take | null>(null);
  const clockRef = useRef(new EngineClock());
  const metronomeRef = useRef(new Metronome());
  const playerRef = useRef(new Player());
  const pausedAtRef = useRef<number | null>(null);
  const firstBeatRef = useRef(0);
  const runningRef = useRef(false);

  // ---- derived -----------------------------------------------------------------------

  const ts = project.timeSig;
  const spm = measureSteps(ts);
  const ordered = useMemo(() => scoreOrder(project.parts), [project.parts]);
  const active: Part = project.parts.find((p) => p.id === activeId) ?? ordered[0];
  const infoOf = useCallback((id: InstrumentId) => instruments.find((i) => i.id === id), [instruments]);
  const activeInfo = infoOf(active.instrument);
  const transpose = activeInfo?.transposeSemitones ?? 0;
  const clef = activeInfo?.clef ?? "treble";
  const keySignature = writtenKey(project.concertKey, transpose);
  const labels = useMemo(
    () => new Map(project.parts.map((p) => [p.id, partLabel(project, p, instruments)])),
    [project, instruments],
  );
  const endStep = projectEndStep(project);

  const staffFor = useCallback(
    (part: Part): StaffInput => {
      const info = infoOf(part.instrument);
      const t = info?.transposeSemitones ?? 0;
      return {
        measures: layoutMeasures(docToQNotes(part.doc, t), endStep, ts),
        clef: info?.clef ?? "treble",
        keySignature: writtenKey(project.concertKey, t),
        name: partLabel(project, part, instruments),
        shortName: partLabel(project, part, instruments, true),
      };
    },
    [infoOf, endStep, ts, project, instruments],
  );

  const liveRef = useRef({ latencyMs, resolution, transpose });
  liveRef.current = { latencyMs, resolution, transpose };
  const projectRef = useRef(project);
  projectRef.current = project;

  // ---- history -------------------------------------------------------------------------

  /** Change the project as one undoable step. */
  const commit = useCallback((next: Project, edit = true) => {
    const prev = projectRef.current;
    if (next === prev) return;
    setPast((p) => [...p.slice(-99), prev]);
    setFuture([]);
    setProject(normalizeLengths(next));
    if (edit) setEditedSinceTake(true);
  }, []);

  /** Change something that isn't worth an undo step (volume, mute, typing a title). */
  const tweak = useCallback((change: (p: Project) => Project) => setProject((p) => change(p)), []);

  const undo = useCallback(() => {
    if (past.length === 0) return;
    setFuture((f) => [projectRef.current, ...f]);
    setProject(past[past.length - 1]);
    setPast((p) => p.slice(0, -1));
    setEditedSinceTake(true);
  }, [past]);

  const redo = useCallback(() => {
    if (future.length === 0) return;
    setPast((p) => [...p, projectRef.current]);
    setProject(future[0]);
    setFuture((f) => f.slice(1));
  }, [future]);

  // Keep the active part valid (after undo, open, remove ...).
  useEffect(() => {
    if (!project.parts.some((p) => p.id === activeId)) setActiveId(scoreOrder(project.parts)[0].id);
  }, [project.parts, activeId]);

  // ---- engine wiring -------------------------------------------------------------------

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
    const onStopped = ({ droppedSamples }: { droppedSamples: number; xruns: number }) => {
      if (droppedSamples > 0) {
        setNotice(`The computer couldn't keep up with the microphone: ${droppedSamples} samples were lost, so a few notes may be missing. Closing other apps usually helps.`);
      }
    };
    engine.subscribe({ onNote: handleNote, onStatus: handleStatus, onStopped }).then((off) => {
      if (cancelled) off();
      else unlisten = off;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [handleNote, handleStatus]);

  const timedNotes = useCallback((liveEndPerf: number, midiOffset: number): TimedNote[] => {
    const origin = takeRef.current?.gridOriginPerf ?? 0;
    return notesRef.current.map((n) => ({
      midi: n.concertMidi + midiOffset,
      startMs: n.startPerf - origin,
      endMs: (n.endPerf ?? liveEndPerf) - origin,
      live: n.endPerf === null,
    }));
  }, []);

  // ---- playback ------------------------------------------------------------------------

  const playheadSubs = useRef(new Set<(step: number | null) => void>());
  const playhead = useMemo<PlayheadSource>(
    () => ({
      subscribe(fn) {
        playheadSubs.current.add(fn);
        return () => playheadSubs.current.delete(fn);
      },
    }),
    [],
  );

  useEffect(() => {
    const player = playerRef.current;
    player.onPosition = (step) => playheadSubs.current.forEach((fn) => fn(step));
    player.onEnd = () => {
      pausedAtRef.current = null;
      setPlaying(false);
      playheadSubs.current.forEach((fn) => fn(null));
    };
    return () => {
      player.stop();
      metronomeRef.current.stop();
    };
  }, []);

  const playbackParts = useCallback(
    (p: Project, exclude?: string): PlaybackPart[] =>
      p.parts
        .filter((x) => x.id !== exclude)
        .map((x) => ({ id: x.id, instrument: x.instrument, notes: x.doc.notes, volume: x.volume, muted: x.muted })),
    [],
  );

  const play = async () => {
    const p = projectRef.current;
    const end = projectEndStep(p);
    let from = editMode ? cursor : (pausedAtRef.current ?? 0);
    if (from >= end) from = 0;
    try {
      await playerRef.current.play(playbackParts(p), {
        stepSec: 60 / p.bpm / beatSteps(p.timeSig),
        fromStep: from,
        endStep: end,
        click: clickOn ? { stepsPerBeat: beatSteps(p.timeSig), pattern: metronomePattern(p.timeSig), stepsPerBar: measureSteps(p.timeSig) } : undefined,
      });
      setPlaying(true);
    } catch (e) {
      setError(`Playback failed: ${e}`);
    }
  };

  const pause = () => {
    pausedAtRef.current = playerRef.current.stop(false);
    setPlaying(false);
  };

  const stopPlayback = () => {
    playerRef.current.stop();
    pausedAtRef.current = null;
    setPlaying(false);
  };

  // Mute/volume changes apply while playing.
  useEffect(() => {
    for (const p of project.parts) playerRef.current.setPartLevel(p.id, p.volume, p.muted);
  }, [project.parts]);

  // ---- live score + visual metronome ---------------------------------------------------

  useEffect(() => {
    if (runState !== "running") return;
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      const take = takeRef.current!;
      const p = projectRef.current;
      const beatMs = 60000 / p.bpm;
      const perBar = beatsPerBar(p.timeSig);
      const sinceFirst = now - firstBeatRef.current;
      if (sinceFirst >= 0) {
        const beatIndex = Math.floor(sinceFirst / beatMs);
        const next = { beat: beatIndex % perBar, countIn: beatIndex < perBar };
        setBeat((prev) => (prev.beat === next.beat && prev.countIn === next.countIn ? prev : next));
      }
      const scoreNow = now - liveRef.current.latencyMs;
      const measures = buildScore(timedNotes(scoreNow, liveRef.current.transpose), scoreNow - take.gridOriginPerf, {
        bpm: p.bpm,
        timeSig: p.timeSig,
        resolution: liveRef.current.resolution,
      });
      const signature = scoreSignature(measures);
      setLive((prev) => (prev.signature === signature ? prev : { measures, signature }));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [runState, timedNotes]);

  /** The project with the current take written into its part. */
  const projectWithTake = useCallback(
    (res: Resolution): Project | null => {
      const take = takeRef.current;
      if (!take) return null;
      const base = take.base;
      const q = quantizeNotes(timedNotes(0, 0), { bpm: base.bpm, timeSig: base.timeSig, resolution: res });
      const recorded: DocNote[] = q.map((n) => ({ midi: n.midi, s: n.s + take.offset, e: n.e + take.offset }));
      return updatePart(base, take.partId, (part) => {
        const kept = take.mode === "append" ? part.doc.notes : [];
        const notes = [...kept, ...recorded];
        const last = notes.length ? notes[notes.length - 1].e : 0;
        return { ...part, doc: { notes, endStep: Math.max(part.doc.endStep, last) } };
      });
    },
    [timedNotes],
  );

  // A different grid re-reads the last take, until something has been edited.
  useEffect(() => {
    if (runState !== "idle" || editedSinceTake || !takeRef.current) return;
    const next = projectWithTake(resolution);
    if (next) setProject(normalizeLengths(next));
  }, [resolution, runState, editedSinceTake, projectWithTake]);

  // ---- recording -----------------------------------------------------------------------

  const start = async () => {
    setError(null);
    setNotice(null);
    stopPlayback();
    setEditMode(false);
    setRunState("starting");
    try {
      const p = projectRef.current;
      notesRef.current = [];
      eventLogRef.current = [];
      clockRef.current.reset();
      const info = await engine.start(active.instrument, deviceId);
      setCaptureInfo(info);
      const pattern = metronomePattern(p.timeSig);
      const timing = await metronomeRef.current.start(p.bpm, pattern, clickOn);
      firstBeatRef.current = timing.firstBeatPerf;
      const lastNote = active.doc.notes.length ? active.doc.notes[active.doc.notes.length - 1].e : 0;
      const offset = recordMode === "append" ? Math.ceil(lastNote / spm) * spm : 0;
      takeRef.current = {
        partId: active.id,
        mode: recordMode,
        offset,
        base: p,
        gridOriginPerf: timing.firstBeatPerf + pattern.length * timing.beatMs,
      };
      // Hear the other parts from the take's first bar, after the count-in.
      const others = playbackParts(p, active.id).filter((x) => x.notes.some((n) => n.e > offset));
      if (playAlong && others.length) {
        await playerRef.current.play(others, {
          stepSec: 60 / p.bpm / beatSteps(p.timeSig),
          fromStep: offset,
          endStep: projectEndStep(p),
          startAt: timing.firstBeatTime + (pattern.length * timing.beatMs) / 1000,
        });
      }
      runningRef.current = true;
      setLive({ measures: [], signature: "" });
      setRunState("running");
    } catch (e) {
      metronomeRef.current.stop();
      playerRef.current.stop();
      runningRef.current = false;
      setRunState("idle");
      setError(String(e));
    }
  };

  const stop = async () => {
    metronomeRef.current.stop();
    playerRef.current.stop();
    try {
      await engine.stop();
    } catch (e) {
      setError(String(e));
    }
    runningRef.current = false;
    const now = performance.now() - latencyMs;
    const open = notesRef.current[notesRef.current.length - 1];
    if (open && open.endPerf === null) open.endPerf = now;
    setHasTake(eventLogRef.current.length > 0);
    setBeat({ beat: null, countIn: false });
    setStatus(null);
    setRunState("idle");
    const next = projectWithTake(resolution);
    if (next && notesRef.current.length > 0) {
      commit(next, false);
      setEditedSinceTake(false);
    }
  };

  const clearPart = () => {
    if (runningRef.current && takeRef.current) {
      // Restart the take at the next barline, keeping the metronome running.
      notesRef.current = [];
      const p = projectRef.current;
      const barMs = (60000 / p.bpm) * beatsPerBar(p.timeSig);
      const now = performance.now() - latencyMs;
      const elapsedBars = Math.ceil((now - takeRef.current.gridOriginPerf) / barMs);
      takeRef.current.gridOriginPerf += Math.max(0, elapsedBars) * barMs;
      setLive({ measures: [], signature: "" });
      return;
    }
    commit(updatePart(project, active.id, (x) => ({ ...x, doc: { ...x.doc, notes: [] } })));
    setCursor(0);
  };

  const changePart = (id: string, change: Partial<Pick<Part, "instrument" | "name" | "muted" | "volume">>) => {
    if ("instrument" in change || "name" in change) {
      commit(updatePart(project, id, (x) => ({ ...x, ...change })));
      if (change.instrument && runningRef.current && id === active.id) engine.setInstrument(change.instrument).catch((e) => setError(String(e)));
    } else {
      tweak((p) => updatePart(p, id, (x) => ({ ...x, ...change })));
    }
  };

  const addPart = (instrument: InstrumentId) => {
    const part = newPart(instrument, endStep);
    commit({ ...project, parts: [...project.parts, part] });
    setActiveId(part.id);
    setCursor(0);
  };

  const removePart = (id: string) => {
    if (project.parts.length <= 1) return;
    commit({ ...project, parts: project.parts.filter((p) => p.id !== id) });
  };

  const toggleClick = () => {
    const next = !clickOn;
    setClickOn(next);
    metronomeRef.current.setAudible(next);
  };

  // ---- files ---------------------------------------------------------------------------

  const openScore = async () => {
    setError(null);
    try {
      const f = await openFile("Scores", IMPORT_EXTENSIONS);
      if (!f) return;
      stopPlayback();
      const p = importFile(f.name, f.bytes);
      commit(p);
      setActiveId(scoreOrder(p.parts)[0].id);
      setCursor(0);
      setNotice(`Opened ${f.name}: ${p.parts.length} part${p.parts.length === 1 ? "" : "s"}, ${meterName(p.timeSig)}.`);
    } catch (e) {
      setError(`Couldn't open the file. ${e instanceof Error ? e.message : e}`);
    }
  };

  const importParts = async () => {
    setError(null);
    try {
      const f = await openFile("Scores", IMPORT_EXTENSIONS);
      if (!f) return;
      const other = importFile(f.name, f.bytes);
      const added = other.parts.map((x) => ({ ...x, id: newId() }));
      commit({ ...project, parts: [...project.parts, ...added] });
      const meterNote =
        meterName(other.timeSig) !== meterName(project.timeSig)
          ? ` The file is in ${meterName(other.timeSig)}; its notes keep their timing and are barred in ${meterName(project.timeSig)}.`
          : "";
      setNotice(`Added ${added.length} part${added.length === 1 ? "" : "s"} from ${f.name}.${meterNote}`);
    } catch (e) {
      setError(`Couldn't add parts from the file. ${e instanceof Error ? e.message : e}`);
    }
  };

  const saveProject = async () => {
    setError(null);
    try {
      const where = await saveFile({
        bytes: new TextEncoder().encode(serializeProject(project)),
        defaultName: `${fileStem(project.title)}.${PROJECT_EXTENSION}`,
        filterName: "Band Transcriber project",
        extension: PROJECT_EXTENSION,
        mime: "application/json",
      });
      if (where) setNotice(`Saved ${where}`);
    } catch (e) {
      setError(`Couldn't save. ${e}`);
    }
  };

  const newScore = () => {
    stopPlayback();
    const p = emptyProject(active.instrument);
    p.timeSig = project.timeSig;
    p.bpm = project.bpm;
    p.concertKey = project.concertKey;
    commit(p);
    setActiveId(p.parts[0].id);
    setCursor(0);
    setNotice("New score. Undo (Ctrl+Z) brings the previous one back.");
  };

  // ---- editing -------------------------------------------------------------------------

  const applyDoc = useCallback(
    (fn: (d: ScoreDoc) => ScoreDoc) => {
      const p = projectRef.current;
      const part = p.parts.find((x) => x.id === activeId);
      if (!part) return;
      const doc = fn(part.doc);
      if (doc !== part.doc) commit(updatePart(p, part.id, (x) => ({ ...x, doc })));
    },
    [activeId, commit],
  );

  const addBar = () => commit({ ...project, parts: project.parts.map((x) => ({ ...x, doc: { ...x.doc, endStep: endStep + spm } })) });
  const removeBar = () => {
    if (endStep <= spm || project.parts.some((x) => x.doc.notes.some((n) => n.e > endStep - spm))) {
      setNotice("Only an empty last bar can be removed.");
      return;
    }
    commit({ ...project, parts: project.parts.map((x) => ({ ...x, doc: { ...x.doc, endStep: endStep - spm } })) });
  };

  const views = useMemo(() => {
    const parts = viewMode === "score" ? ordered : [active];
    return { parts, staves: parts.map(staffFor) };
  }, [viewMode, ordered, active, staffFor]);

  const activeStaff = useMemo(
    () => views.staves[views.parts.findIndex((p) => p.id === active.id)] ?? staffFor(active),
    [views, active, staffFor],
  );

  const selectedNote = noteIndexAt(active.doc, cursor) >= 0 ? active.doc.notes[noteIndexAt(active.doc, cursor)] : null;

  const isSelected = useCallback(
    (si: number, item: ScoreItem) => {
      if (views.parts[si]?.id !== active.id) return false;
      if (item.kind === "note") return active.doc.notes[item.noteIndex]?.s === cursor;
      return item.start <= cursor && cursor < item.start + item.steps;
    },
    [views, active, cursor],
  );

  const onSelect = useCallback(
    (si: number, item: ScoreItem) => {
      const part = views.parts[si];
      if (!part) return;
      setActiveId(part.id);
      setCursor(item.kind === "note" ? part.doc.notes[item.noteIndex].s : item.start);
    },
    [views],
  );

  const referencePitch = useCallback((): number => {
    const prev = [...active.doc.notes].reverse().find((n) => n.s <= cursor);
    if (prev) return prev.midi + transpose;
    return clef === "bass" ? 50 : 71;
  }, [active, cursor, transpose, clef]);

  const writeLetter = useCallback(
    (letter: Letter) => {
      const concert = letterNear(letter, keySignature, referencePitch()) - transpose;
      if (selectedNote) applyDoc((d) => setPitch(d, cursor, concert));
      else {
        applyDoc((d) => insertNote(d, cursor, inputSteps, concert, spm));
        setCursor(cursor + inputSteps);
      }
    },
    [keySignature, referencePitch, transpose, selectedNote, applyDoc, cursor, inputSteps, spm],
  );

  const chooseDuration = useCallback(
    (steps: number) => {
      setInputSteps(steps);
      if (selectedNote) applyDoc((d) => setDuration(d, cursor, steps, spm));
    },
    [selectedNote, applyDoc, cursor, spm],
  );

  const moveCursor = useCallback(
    (dir: 1 | -1) => {
      const positions = selectablePositions(activeStaff.measures);
      if (positions.length === 0) return;
      let i = positions.findIndex((p) => p >= cursor);
      if (i < 0) i = positions.length;
      const exact = positions[i] === cursor;
      const target = dir > 0 ? (exact ? i + 1 : i) : i - 1;
      setCursor(positions[Math.max(0, Math.min(positions.length - 1, target))]);
    },
    [activeStaff, cursor],
  );

  // Keyboard: editing keys in edit mode; space to play; Ctrl+S / Ctrl+O always.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key;
      if (mod && key.toLowerCase() === "s") {
        e.preventDefault();
        void saveProject();
        return;
      }
      if (mod && key.toLowerCase() === "o") {
        e.preventDefault();
        void openScore();
        return;
      }
      if (runningRef.current) return;
      if (key === " ") {
        e.preventDefault();
        if (playing) pause();
        else void play();
        return;
      }
      if (mod && key.toLowerCase() === "z") {
        e.preventDefault();
        (e.shiftKey ? redo : undo)();
        return;
      }
      if (mod && key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (!editMode) return;
      let handled = true;
      if (key === "ArrowRight") moveCursor(1);
      else if (key === "ArrowLeft") moveCursor(-1);
      else if (key === "ArrowUp") applyDoc((d) => transposeNote(d, cursor, mod ? 12 : 1));
      else if (key === "ArrowDown") applyDoc((d) => transposeNote(d, cursor, mod ? -12 : -1));
      else if (!mod && /^[a-gA-G]$/.test(key)) writeLetter(key.toUpperCase() as Letter);
      else if (!mod && DURATION_KEYS[key]) chooseDuration(DURATION_KEYS[key]);
      else if (!mod && key === ".") applyDoc((d) => toggleDot(d, cursor, spm));
      else if (key === "Delete" || key === "Backspace" || (!mod && key === "0")) applyDoc((d) => deleteNote(d, cursor));
      else if (key === "Escape") setEditMode(false);
      else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const selectionLabel = selectedNote
    ? `${labels.get(active.id)}: ${displayName(selectedNote.midi + transpose, keySignature)} (written), bar ${Math.floor(cursor / spm) + 1}`
    : `${labels.get(active.id)}: rest, bar ${Math.floor(cursor / spm) + 1}`;

  // ---- export --------------------------------------------------------------------------

  const exportScore = async (kind: ExportKind, pageSize: PageSize, scope: PdfScope): Promise<string | null> => {
    const stem = fileStem(project.title);
    if (kind === "pdf") {
      const { toPdf } = await import("./lib/export/pdf");
      const score: PdfSection = { label: ordered.length > 1 ? "Full Score" : (labels.get(ordered[0].id) ?? ""), staves: ordered.map(staffFor) };
      const partSection = (p: Part): PdfSection => ({ label: labels.get(p.id) ?? "", staves: [staffFor(p)] });
      const sections = scope === "part" ? [partSection(active)] : scope === "parts" ? [score, ...ordered.map(partSection)] : [score];
      const bytes = await toPdf(sections, { title: project.title, timeSig: ts, bpm: project.bpm, pageSize });
      const suffix = scope === "part" ? ` - ${labels.get(active.id)}` : "";
      return saveFile({ bytes, defaultName: `${stem}${suffix}.pdf`, filterName: "PDF", extension: "pdf", mime: "application/pdf" });
    }
    if (kind === "musicxml") {
      const xml = toMusicXml(
        ordered.map((p) => {
          const st = staffFor(p);
          return { measures: st.measures, partName: st.name ?? "", clef: st.clef, keySignature: st.keySignature, transpose: infoOf(p.instrument)?.transposeSemitones ?? 0 };
        }),
        { title: project.title, timeSig: ts, bpm: project.bpm },
      );
      return saveFile({
        bytes: new TextEncoder().encode(xml), defaultName: `${stem}.musicxml`, filterName: "MusicXML",
        extension: "musicxml", mime: "application/vnd.recordare.musicxml+xml",
      });
    }
    const bytes = toMidi(
      ordered.map((p) => ({ name: labels.get(p.id) ?? "", instrument: p.instrument, notes: p.doc.notes, volume: p.volume })),
      { bpm: project.bpm, timeSig: ts, title: project.title },
    );
    return saveFile({ bytes, defaultName: `${stem}.mid`, filterName: "MIDI", extension: "mid", mime: "audio/midi" });
  };

  const exportTestCase = async (description: string): Promise<string | null> => {
    const take = takeRef.current;
    if (!take) return null;
    const { invoke } = await import("@tauri-apps/api/core");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const part = take.base.parts.find((p) => p.id === take.partId);
    const session = {
      format: "band-transcriber-test-case",
      version: 2,
      createdAt: new Date().toISOString(),
      description,
      instrument: part?.instrument ?? active.instrument,
      concertKey: take.base.concertKey,
      bpm: take.base.bpm,
      timeSignature: meterName(take.base.timeSig),
      resolution,
      latencyMs,
      clickOn,
      captureInfo,
      // Engine-clock time of bar 1 beat 1: event.timestampMs - this = position in ms.
      gridOriginEngineMs: clockRef.current.toEngine(take.gridOriginPerf) + latencyMs,
      events: eventLogRef.current,
      detected: activeStaff.measures.map((m) =>
        m.items.map((i) => `${i.kind === "rest" ? "r" : displayName(i.midi, keySignature)}:${i.duration}${i.dots ? "." : ""}${i.tieToNext ? "~" : ""}`).join(" "),
      ),
    };
    return invoke<string | null>("export_test_case", { folderName: `test-case-${stamp}`, sessionJson: JSON.stringify(session, null, 2) });
  };

  // ---- view ----------------------------------------------------------------------------

  const running = runState === "running";
  const staves: StaffInput[] = running
    ? [{ measures: live.measures, clef, keySignature, name: labels.get(active.id) }]
    : views.staves;
  const signature = running
    ? live.signature
    : `${views.staves.map((s) => `${s.clef}${s.keySignature}${s.name}${scoreSignature(s.measures)}`).join("/")}#${editMode ? `${active.id}:${cursor}` : "-"}`;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Music2 size={22} aria-hidden />
          <input
            id="title"
            className="title-input"
            style={{ width: `${Math.min(40, Math.max(8, project.title.length + 2))}ch` }}
            value={project.title}
            onChange={(e) => {
              const title = e.target.value;
              tweak((p) => ({ ...p, title }));
            }}
            aria-label="Score title"
          />
          {engine.isDemo && <span className="badge" title="Not running inside Tauri: a scripted melody stands in for the microphone">demo</span>}
        </div>
        <div className="topbar-actions">
          {running ? (
            <button className="btn btn-stop" onClick={stop}>
              <Square size={16} aria-hidden /> Stop
            </button>
          ) : (
            <button className="btn btn-primary" onClick={start} disabled={runState === "starting" || instruments.length === 0} title={`Record into ${labels.get(active.id)}`}>
              <Mic size={16} aria-hidden /> {runState === "starting" ? "Starting…" : "Record"}
            </button>
          )}
          <button className={`btn ${editMode ? "is-active" : ""}`} onClick={() => setEditMode((m) => !m)} disabled={running} aria-pressed={editMode}>
            <Pencil size={16} aria-hidden /> {editMode ? "Done" : "Edit"}
          </button>
          <FileMenu disabled={running} onNew={newScore} onOpen={openScore} onImportParts={importParts} onSave={saveProject} />
          <ExportMenu
            title={project.title}
            onTitle={(title) => tweak((p) => ({ ...p, title }))}
            disabled={running}
            onExport={exportScore}
            onExportTestCase={isTauri() && hasTake ? exportTestCase : undefined}
            activePartLabel={labels.get(active.id) ?? ""}
            partCount={project.parts.length}
          />
        </div>
      </header>

      <section className="controls">
        <label className="field">
          <span>Concert key</span>
          <select id="concert-key" value={project.concertKey} disabled={running} onChange={(e) => commit({ ...project, concertKey: e.target.value })}>
            {CONCERT_KEYS.map((k) => (
              <option key={k} value={k}>
                {displayKey(k)} major
              </option>
            ))}
            {!(CONCERT_KEYS as readonly string[]).includes(project.concertKey) && <option value={project.concertKey}>{displayKey(project.concertKey)} major</option>}
          </select>
        </label>

        <label className="field field-narrow">
          <span>Tempo {beatUnitSymbol(ts)} =</span>
          <input
            id="bpm"
            type="number"
            min={30}
            max={300}
            value={project.bpm}
            disabled={running}
            onChange={(e) => {
              const bpm = Math.max(30, Math.min(300, Number(e.target.value) || 100));
              tweak((p) => ({ ...p, bpm }));
            }}
          />
        </label>

        <MeterField value={ts} disabled={running} onChange={(timeSig) => commit({ ...project, timeSig })} />

        <div className="field">
          <span>Grid</span>
          <div className="segmented" role="group" aria-label="Snap notes to">
            {RESOLUTIONS.map((r) => (
              <button key={r.value} className={resolution === r.value ? "is-active" : ""} onClick={() => setResolution(r.value)}>
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span>Click</span>
          <button className={`btn btn-icon ${clickOn ? "is-active" : ""}`} onClick={toggleClick} aria-pressed={clickOn} title="Metronome while recording and playing">
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
      {notice && !error && (
        <div className="notice" role="status">
          {notice}
          <button className="tool" onClick={() => setNotice(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {editMode ? (
        <EditorToolbar
          inputSteps={inputSteps}
          onDuration={chooseDuration}
          onDot={() => applyDoc((d) => toggleDot(d, cursor, spm))}
          onTranspose={(s) => applyDoc((d) => transposeNote(d, cursor, s))}
          onDelete={() => applyDoc((d) => deleteNote(d, cursor))}
          onAddMeasure={addBar}
          onRemoveMeasure={removeBar}
          onUndo={undo}
          onRedo={redo}
          canUndo={past.length > 0}
          canRedo={future.length > 0}
          hasNote={!!selectedNote}
          selectionLabel={selectionLabel}
        />
      ) : (
        <section className="strip">
          <LivePanel status={status} writtenKey={keySignature} concertKeyName={project.concertKey} transpose={transpose} running={running} />
          <div className="strip-side">
            <BeatIndicator beatsPerMeasure={beatsPerBar(ts)} beat={beat.beat} countIn={beat.countIn} />
            <div className="facts">
              <span>
                Recording into <strong>{labels.get(active.id)}</strong>
                {activeInfo ? ` · ${activeInfo.key === "C" ? "concert pitch" : `in ${displayKey(activeInfo.key)}`}` : ""}
              </span>
              <span>written key {displayKey(keySignature)} · {clef} clef · {meterName(ts)}</span>
              {captureInfo && (
                <span>
                  {captureInfo.sampleRate / 1000} kHz · window {captureInfo.analysisWindow} · band {captureInfo.bandLowHz.toFixed(0)}–{captureInfo.bandHighHz.toFixed(0)} Hz
                </span>
              )}
            </div>
          </div>
        </section>
      )}

      <div className="workspace">
        <PartsPanel
          parts={ordered}
          labels={labels}
          activeId={active.id}
          instruments={instruments}
          disabled={running}
          onSelect={(id) => {
            setActiveId(id);
            setCursor(0);
          }}
          onAdd={addPart}
          onRemove={removePart}
          onChange={changePart}
        />

        <div className="score-area">
          <div className="transport" role="toolbar" aria-label="Playback and recording">
            <div className="transport-group">
              {playing ? (
                <button className="btn" onClick={pause} title="Pause (Space)">
                  <Pause size={16} aria-hidden /> Pause
                </button>
              ) : (
                <button className="btn" onClick={play} disabled={running} title={editMode ? "Play from the selection (Space)" : "Play (Space)"}>
                  <Play size={16} aria-hidden /> Play
                </button>
              )}
              <button className="btn btn-icon-only" onClick={stopPlayback} disabled={!playing && pausedAtRef.current === null} title="Back to the start" aria-label="Stop playback">
                <Square size={14} aria-hidden />
              </button>
            </div>
            <div className="segmented" role="group" aria-label="View">
              <button className={viewMode === "score" ? "is-active" : ""} onClick={() => setViewMode("score")}>
                Full score
              </button>
              <button className={viewMode === "part" ? "is-active" : ""} onClick={() => setViewMode("part")}>
                Part
              </button>
            </div>
            <div className="transport-group transport-record">
              <label className="inline-field">
                <span>Recording</span>
                <select id="record-mode" value={recordMode} disabled={running} onChange={(e) => setRecordMode(e.target.value as "replace" | "append")}>
                  <option value="replace">replaces the part</option>
                  <option value="append">adds to the end</option>
                </select>
              </label>
              <label className="inline-check">
                <input id="play-along" type="checkbox" checked={playAlong} disabled={running} onChange={(e) => setPlayAlong(e.target.checked)} />
                <span>Hear other parts</span>
              </label>
              <button className="btn" onClick={clearPart} disabled={!running && active.doc.notes.length === 0} title={running ? "Restart this take at the next bar" : "Remove every note from this part (undoable)"}>
                <Trash2 size={15} aria-hidden /> {running ? "Restart take" : "Clear part"}
              </button>
            </div>
          </div>

          <main className={`sheet ${editMode ? "is-editing" : ""}`}>
            <SheetMusic
              staves={staves}
              timeSig={ts}
              signature={signature}
              isSelected={editMode && !running ? isSelected : undefined}
              onSelect={editMode && !running ? onSelect : undefined}
              followEnd={running}
              playhead={running ? undefined : playhead}
              label={editMode ? "Score editor" : "Score"}
            />
          </main>
        </div>
      </div>
    </div>
  );
}
