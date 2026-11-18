import { ArrowDown, ArrowUp, ChevronsDown, ChevronsUp, Eraser, Minus, Plus, Redo2, Undo2 } from "lucide-react";
import { DURATION_CHOICES } from "../lib/editor";

interface Props {
  inputSteps: number;
  onDuration: (steps: number) => void;
  onDot: () => void;
  onTranspose: (semitones: number) => void;
  onDelete: () => void;
  onAddMeasure: () => void;
  onRemoveMeasure: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  hasNote: boolean;
  selectionLabel: string;
}

/** Editor controls. Every button has a keyboard equivalent, shown in its tooltip. */
export function EditorToolbar(p: Props) {
  return (
    <section className="editor-bar" aria-label="Score editor">
      <div className="tool-group" role="group" aria-label="Duration">
        {DURATION_CHOICES.map((d) => (
          <button
            key={d.steps}
            className={`tool ${p.inputSteps === d.steps ? "is-active" : ""}`}
            onClick={() => p.onDuration(d.steps)}
            title={`${d.label} (${d.key})`}
          >
            {d.label}
          </button>
        ))}
        <button className="tool" onClick={p.onDot} disabled={!p.hasNote} title="Dotted (.)">
          Dot
        </button>
      </div>

      <div className="tool-group" role="group" aria-label="Pitch">
        <button className="tool tool-icon" onClick={() => p.onTranspose(1)} disabled={!p.hasNote} title="Up a semitone (↑)">
          <ArrowUp size={15} aria-hidden /> ♯
        </button>
        <button className="tool tool-icon" onClick={() => p.onTranspose(-1)} disabled={!p.hasNote} title="Down a semitone (↓)">
          <ArrowDown size={15} aria-hidden /> ♭
        </button>
        <button className="tool tool-icon" onClick={() => p.onTranspose(12)} disabled={!p.hasNote} title="Up an octave (Ctrl+↑)">
          <ChevronsUp size={15} aria-hidden /> 8va
        </button>
        <button className="tool tool-icon" onClick={() => p.onTranspose(-12)} disabled={!p.hasNote} title="Down an octave (Ctrl+↓)">
          <ChevronsDown size={15} aria-hidden /> 8vb
        </button>
        <button className="tool tool-icon" onClick={p.onDelete} disabled={!p.hasNote} title="Make it a rest (Delete or 0)">
          <Eraser size={15} aria-hidden /> Rest
        </button>
      </div>

      <div className="tool-group" role="group" aria-label="Bars">
        <button className="tool tool-icon" onClick={p.onAddMeasure} title="Add a bar at the end">
          <Plus size={15} aria-hidden /> Bar
        </button>
        <button className="tool tool-icon" onClick={p.onRemoveMeasure} title="Remove the last bar (if empty)">
          <Minus size={15} aria-hidden /> Bar
        </button>
      </div>

      <div className="tool-group" role="group" aria-label="History">
        <button className="tool tool-icon" onClick={p.onUndo} disabled={!p.canUndo} title="Undo (Ctrl+Z)">
          <Undo2 size={15} aria-hidden />
        </button>
        <button className="tool tool-icon" onClick={p.onRedo} disabled={!p.canRedo} title="Redo (Ctrl+Shift+Z)">
          <Redo2 size={15} aria-hidden />
        </button>
      </div>

      <p className="editor-hint">
        <strong>{p.selectionLabel}</strong> · Click a note or rest, or use ← →. Type A–G to set a pitch or write a note
        into a rest. 3–7 set the length, . adds a dot, ↑ ↓ change pitch.
      </p>
    </section>
  );
}
