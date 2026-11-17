import { Activity, Gauge } from "lucide-react";
import { displayName } from "../lib/music";
import type { EngineStatus } from "../lib/types";

interface Props {
  status: EngineStatus | null;
  writtenKey: string;
  concertKeyName: string;
  transpose: number;
  running: boolean;
}

/** Live readout: written note, concert note, tuner and input level. */
export function LivePanel({ status, writtenKey, concertKeyName, transpose, running }: Props) {
  const concert = status?.activeConcertMidi ?? null;
  const written = concert === null ? null : concert + transpose;
  const cents = status?.cents ?? null;
  const level = status?.levelDb ?? -120;
  const levelPct = Math.max(0, Math.min(100, ((level + 70) / 70) * 100));
  const centsClamped = cents === null ? 0 : Math.max(-50, Math.min(50, cents));
  const inTune = cents !== null && Math.abs(cents) <= 10;

  return (
    <section className="live-panel" aria-live="polite">
      <div className="live-note">
        <span className="live-label">Written</span>
        <span className="live-written">{written === null ? "–" : displayName(written, writtenKey)}</span>
        <span className="live-concert">
          {concert === null ? (running ? "listening…" : "idle") : `Concert ${displayName(concert, concertKeyName)}`}
        </span>
      </div>

      <div className="live-meters">
        <div className="meter-row">
          <Gauge size={16} aria-hidden />
          <div className="tuner" title="Tuning (cents)">
            <div className="tuner-scale">
              <span>-50</span>
              <span>0</span>
              <span>+50</span>
            </div>
            <div className="tuner-track">
              <div className="tuner-center" />
              <div
                className={`tuner-needle ${cents === null ? "is-off" : inTune ? "is-in" : "is-out"}`}
                style={{ left: `${50 + centsClamped}%` }}
              />
            </div>
          </div>
          <span className="meter-value">{cents === null ? "—" : `${cents > 0 ? "+" : ""}${cents.toFixed(0)}¢`}</span>
        </div>
        <div className="meter-row">
          <Activity size={16} aria-hidden />
          <div className="level-track" title="Input level">
            <div className="level-fill" style={{ width: `${levelPct}%` }} />
          </div>
          <span className="meter-value">{level <= -119 ? "—" : `${level.toFixed(0)} dB`}</span>
        </div>
        <div className="meter-facts">
          <span>{status?.frequencyHz ? `${status.frequencyHz.toFixed(1)} Hz` : "— Hz"}</span>
          <span>clarity {status?.clarity ? status.clarity.toFixed(2) : "—"}</span>
        </div>
      </div>
    </section>
  );
}
