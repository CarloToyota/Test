import { useState } from "react";
import { Plus, Trash2, Volume2, VolumeX } from "lucide-react";
import type { Part } from "../lib/project";
import type { InstrumentId, InstrumentInfo } from "../lib/types";

interface Props {
  parts: Part[];
  labels: Map<string, string>;
  activeId: string;
  instruments: InstrumentInfo[];
  disabled: boolean;
  onSelect: (id: string) => void;
  onAdd: (instrument: InstrumentId) => void;
  onRemove: (id: string) => void;
  onChange: (id: string, change: Partial<Pick<Part, "instrument" | "name" | "muted" | "volume">>) => void;
}

/** The score's parts: pick the one to record/edit, mute, balance, add and remove. */
export function PartsPanel({ parts, labels, activeId, instruments, disabled, onSelect, onAdd, onRemove, onChange }: Props) {
  const [adding, setAdding] = useState<InstrumentId>("trumpet");
  return (
    <aside className="parts" aria-label="Parts">
      <div className="parts-head">
        <span className="parts-title">Parts</span>
        <span className="parts-count">{parts.length}</span>
      </div>
      <ul className="parts-list">
        {parts.map((p) => {
          const active = p.id === activeId;
          const notes = p.doc.notes.length;
          return (
            <li key={p.id} className={`part ${active ? "is-active" : ""}`}>
              <button
                className="part-main"
                onClick={() => onSelect(p.id)}
                aria-pressed={active}
                title="Record into and edit this part"
              >
                <span className="part-dot" aria-hidden />
                <span className="part-name">{labels.get(p.id)}</span>
                <span className="part-meta">{notes ? `${notes} notes` : "empty"}</span>
              </button>
              {active && (
                <div className="part-detail">
                  <label className="field">
                    <span>Instrument</span>
                    <select
                      id={`part-instrument-${p.id}`}
                      value={p.instrument}
                      disabled={disabled}
                      onChange={(e) => onChange(p.id, { instrument: e.target.value as InstrumentId })}
                    >
                      {instruments.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Name on score</span>
                    <input
                      id={`part-name-${p.id}`}
                      type="text"
                      value={p.name}
                      placeholder={labels.get(p.id)}
                      onChange={(e) => onChange(p.id, { name: e.target.value })}
                    />
                  </label>
                </div>
              )}
              <div className="part-mix">
                <button
                  className={`tool tool-icon ${p.muted ? "is-muted" : ""}`}
                  onClick={() => onChange(p.id, { muted: !p.muted })}
                  aria-pressed={p.muted}
                  title={p.muted ? "Unmute in playback" : "Mute in playback"}
                >
                  {p.muted ? <VolumeX size={14} aria-hidden /> : <Volume2 size={14} aria-hidden />}
                </button>
                <input
                  id={`part-volume-${p.id}`}
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={p.volume}
                  onChange={(e) => onChange(p.id, { volume: Number(e.target.value) })}
                  aria-label={`${labels.get(p.id)} volume`}
                />
                <button
                  className="tool tool-icon"
                  onClick={() => onRemove(p.id)}
                  disabled={disabled || parts.length <= 1}
                  title="Remove this part"
                  aria-label={`Remove ${labels.get(p.id)}`}
                >
                  <Trash2 size={14} aria-hidden />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="parts-add">
        <select id="add-part-instrument" value={adding} onChange={(e) => setAdding(e.target.value as InstrumentId)} disabled={disabled}>
          {instruments.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => onAdd(adding)} disabled={disabled}>
          <Plus size={15} aria-hidden /> Add part
        </button>
      </div>
    </aside>
  );
}
