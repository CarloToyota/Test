import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mic, Music2, Square, Trash2, Volume2, VolumeX } from "lucide-react";
import { BeatIndicator } from "./components/BeatIndicator";
import { LivePanel } from "./components/LivePanel";
import { SheetMusic } from "./components/SheetMusic";
import { engine } from "./lib/bridge";
import { EngineClock } from "./lib/clock";
import { Metronome } from "./lib/metronome";
import { CONCERT_KEYS, displayKey, writtenKey } from "./lib/music";
import { buildScore, scoreSignature, type ScoreMeasure, type TimedNote } from "./lib/quantize";
import type {
  BeatsPerMeasure,
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

interface Settings {
  bpm: number;
  beatsPerMeasure: BeatsPerMeasure;
  resolution: Resolution;
  latencyMs: number;
  transpose: number;
}

type RunState = "idle" | "starting" | "running";

const RESOLUTIONS: Array<{ value: Resolution; label: string }> = [
  { value: 1, label: "16th" },
  { value: 2, label: "8th" },
  { value: 4, label: "Quarter" },
];

export default function App() {
  const [instruments, setInstruments] = useState<InstrumentInfo[]>([]);
  const [instrumentId, setInstrumentId] = useState<InstrumentId>("altoSax");
  const [concertKey, setConcertKey] = useState<string>("Bb");
  const [bpm, setBpm] = useState(100);
  const [beatsPerMeasure, setBeatsPerMeasure] = useState<BeatsPerMeasure>(4);
  const [resolution, setResolution] = useState<Resolution>(1);
  const [clickOn, setClickOn] = useState(true);
  const [latencyMs, setLatencyMs] = useState(30);
  const [devices, setDevices] = useState<InputDevice[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);

  const [runState, setRunState] = useState<RunState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [captureInfo, setCaptureInfo] = useState<CaptureInfo | null>(null);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [score, setScore] = useState<{ measures: ScoreMeasure[]; signature: string }>({ measures: [], signature: "" });
  const [beat, setBeat] = useState<{ beat: number | null; countIn: boolean }>({ beat: null, countIn: false });

  const notesRef = useRef<RecordedNote[]>([]);
  const clockRef = useRef(new EngineClock());
  const metronomeRef = useRef(new Metronome());
  const gridOriginRef = useRef(0); // perf time of bar 1, beat 1 (after the count-in)
  const firstBeatRef = useRef(0); // perf time of the first count-in click
  const runningRef = useRef(false);

  const instrument = useMemo(
    () => instruments.find((i) => i.id === instrumentId) ?? instruments[0],
    [instruments, instrumentId],
  );
  const transpose = instrument?.transposeSemitones ?? 0;
  const clef = instrument?.clef ?? "treble";
  const keySignature = writtenKey(concertKey, transpose);

  // Latest settings for callbacks that outlive a render (event listeners, rAF loop).
  const settingsRef = useRef<Settings>({ bpm, beatsPerMeasure, resolution, latencyMs, transpose });
  settingsRef.current = { bpm, beatsPerMeasure, resolution, latencyMs, transpose };

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
    const perf = clockRef.current.toPerf(e.timestampMs) - settingsRef.current.latencyMs;
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

  // ---- score + visual metronome loop ----------------------------------------------

  const renderScore = useCallback((nowPerf: number, liveEndPerf: number) => {
    const s = settingsRef.current;
    const origin = gridOriginRef.current;
    const timed: TimedNote[] = notesRef.current.map((n) => ({
      midi: n.concertMidi + s.transpose,
      startMs: n.startPerf - origin,
      endMs: (n.endPerf ?? liveEndPerf) - origin,
      live: n.endPerf === null,
    }));
    const measures = buildScore(timed, nowPerf - origin, s);
    const signature = scoreSignature(measures);
    setScore((prev) => (prev.signature === signature ? prev : { measures, signature }));
  }, []);

  useEffect(() => {
    if (runState !== "running") return;
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      const s = settingsRef.current;
      const beatMs = 60000 / s.bpm;
      const sinceFirst = now - firstBeatRef.current;
      if (sinceFirst >= 0) {
        const beatIndex = Math.floor(sinceFirst / beatMs);
        const next = { beat: beatIndex % s.beatsPerMeasure, countIn: beatIndex < s.beatsPerMeasure };
        setBeat((prev) => (prev.beat === next.beat && prev.countIn === next.countIn ? prev : next));
      }
      // Notes are latency-compensated, so the score's "now" is too.
      const scoreNow = now - s.latencyMs;
      renderScore(scoreNow, scoreNow);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [runState, renderScore]);

  // Re-render a stopped score when display settings change.
  useEffect(() => {
    if (runState === "running") return;
    const last = notesRef.current[notesRef.current.length - 1];
    if (!last) return;
    const end = last.endPerf ?? last.startPerf;
    renderScore(end, end);
  }, [runState, transpose, resolution, renderScore]);

  // ---- controls ------------------------------------------------------------------------

  const start = async () => {
    setError(null);
    setRunState("starting");
    try {
      notesRef.current = [];
      clockRef.current.reset();
      const info = await engine.start(instrumentId, deviceId);
      setCaptureInfo(info);
      const timing = await metronomeRef.current.start(bpm, beatsPerMeasure, clickOn);
      firstBeatRef.current = timing.firstBeatPerf;
      gridOriginRef.current = timing.firstBeatPerf + beatsPerMeasure * timing.beatMs;
      runningRef.current = true;
      setScore({ measures: [], signature: "" });
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
    const now = performance.now() - settingsRef.current.latencyMs;
    const open = notesRef.current[notesRef.current.length - 1];
    if (open && open.endPerf === null) open.endPerf = now;
    renderScore(open?.endPerf ?? now, now);
    setBeat({ beat: null, countIn: false });
    setStatus(null);
    setRunState("idle");
  };

  const clear = () => {
    notesRef.current = [];
    if (runningRef.current) {
      // Restart the page at the next barline, keeping the metronome running.
      const barMs = (60000 / bpm) * beatsPerMeasure;
      const now = performance.now() - latencyMs;
      const elapsedBars = Math.ceil((now - gridOriginRef.current) / barMs);
      gridOriginRef.current += Math.max(0, elapsedBars) * barMs;
    }
    setScore({ measures: [], signature: "" });
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
              <Mic size={16} aria-hidden /> {runState === "starting" ? "Starting…" : "Start"}
            </button>
          )}
          <button className="btn" onClick={clear} title="Clear the page">
            <Trash2 size={16} aria-hidden /> Clear
          </button>
        </div>
      </header>

      <section className="controls">
        <label className="field">
          <span>Instrument</span>
          <select value={instrumentId} onChange={(e) => changeInstrument(e.target.value as InstrumentId)}>
            {instruments.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Concert key</span>
          <select value={concertKey} onChange={(e) => setConcertKey(e.target.value)}>
            {CONCERT_KEYS.map((k) => (
              <option key={k} value={k}>
                {displayKey(k)} major
              </option>
            ))}
          </select>
        </label>

        <label className="field field-narrow">
          <span>BPM</span>
          <input
            type="number"
            min={40}
            max={240}
            value={bpm}
            disabled={running}
            onChange={(e) => setBpm(Math.max(40, Math.min(240, Number(e.target.value) || 100)))}
          />
        </label>

        <div className="field">
          <span>Time</span>
          <div className="segmented" role="group" aria-label="Time signature">
            {([4, 3] as const).map((b) => (
              <button key={b} className={beatsPerMeasure === b ? "is-active" : ""} disabled={running} onClick={() => setBeatsPerMeasure(b)}>
                {b}/4
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span>Grid</span>
          <div className="segmented" role="group" aria-label="Quantize to">
            {RESOLUTIONS.map((r) => (
              <button key={r.value} className={resolution === r.value ? "is-active" : ""} onClick={() => setResolution(r.value)}>
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
          <input type="range" min={0} max={150} step={5} value={latencyMs} onChange={(e) => setLatencyMs(Number(e.target.value))} />
        </label>

        <label className="field field-wide">
          <span>Microphone</span>
          <select value={deviceId ?? ""} disabled={running} onChange={(e) => setDeviceId(e.target.value || null)}>
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

      <section className="strip">
        <LivePanel
          status={status}
          writtenKey={keySignature}
          concertKeyName={concertKey}
          transpose={transpose}
          running={running}
        />
        <div className="strip-side">
          <BeatIndicator beatsPerMeasure={beatsPerMeasure} beat={beat.beat} countIn={beat.countIn} />
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

      <main className="sheet">
        <SheetMusic
          measures={score.measures}
          clef={clef}
          keySignature={keySignature}
          beatsPerMeasure={beatsPerMeasure}
          signature={score.signature}
        />
      </main>
    </div>
  );
}
