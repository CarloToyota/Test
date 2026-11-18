import { useEffect, useRef, useState } from "react";
import { Download, FileAudio, FileMusic, FileText, Music4, X } from "lucide-react";
import type { PageSize } from "../lib/export/pdf";

export type ExportKind = "pdf" | "musicxml" | "midi";
export type PdfScope = "score" | "part" | "parts";

interface Props {
  title: string;
  onTitle: (t: string) => void;
  disabled: boolean;
  onExport: (kind: ExportKind, pageSize: PageSize, scope: PdfScope) => Promise<string | null>;
  /** Name of the selected part, for "This part". */
  activePartLabel: string;
  partCount: number;
  /** Present only inside the desktop app, once a take has been recorded. */
  onExportTestCase?: (description: string) => Promise<string | null>;
}

export function ExportMenu({ title, onTitle, disabled, onExport, onExportTestCase, activePartLabel, partCount }: Props) {
  const [open, setOpen] = useState(false);
  const [pageSize, setPageSize] = useState<PageSize>("letter");
  const [scope, setScope] = useState<PdfScope>("score");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [description, setDescription] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const run = async (label: string, job: () => Promise<string | null>) => {
    setBusy(true);
    setMessage(null);
    try {
      const where = await job();
      if (where) setMessage({ text: `${label} saved: ${where}`, error: false });
    } catch (e) {
      setMessage({ text: `${label} failed: ${e}`, error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="export" ref={panelRef}>
      <button className="btn" onClick={() => setOpen((o) => !o)} disabled={disabled} aria-expanded={open}>
        <Download size={16} aria-hidden /> Export
      </button>
      {open && (
        <div className="export-panel" role="dialog" aria-label="Export">
          <div className="export-head">
            <strong>Export score</strong>
            <button className="tool tool-icon" onClick={() => setOpen(false)} aria-label="Close">
              <X size={15} aria-hidden />
            </button>
          </div>

          <label className="field">
            <span>Title</span>
            <input id="export-title" type="text" value={title} onChange={(e) => onTitle(e.target.value)} placeholder="Untitled" />
          </label>

          <div className="export-row">
            <button className="btn" disabled={busy} onClick={() => run("PDF", () => onExport("pdf", pageSize, partCount > 1 ? scope : "score"))}>
              <FileText size={16} aria-hidden /> PDF
            </button>
            <div className="segmented" role="group" aria-label="Page size">
              {(["letter", "a4"] as const).map((s) => (
                <button key={s} className={pageSize === s ? "is-active" : ""} onClick={() => setPageSize(s)}>
                  {s === "letter" ? "Letter" : "A4"}
                </button>
              ))}
            </div>
          </div>
          {partCount > 1 && (
            <div className="segmented segmented-wrap" role="group" aria-label="What to print">
              <button className={scope === "score" ? "is-active" : ""} onClick={() => setScope("score")}>
                Full score
              </button>
              <button className={scope === "part" ? "is-active" : ""} onClick={() => setScope("part")} title={activePartLabel}>
                This part
              </button>
              <button className={scope === "parts" ? "is-active" : ""} onClick={() => setScope("parts")}>
                Score + all parts
              </button>
            </div>
          )}
          <p className="export-note">Printable sheet music, vector quality.</p>

          <button className="btn" disabled={busy} onClick={() => run("MusicXML", () => onExport("musicxml", pageSize, scope))}>
            <FileMusic size={16} aria-hidden /> MusicXML
          </button>
          <p className="export-note">Every part. Opens in MuseScore, Finale, Sibelius, Dorico and Noteflight for further editing.</p>

          <button className="btn" disabled={busy} onClick={() => run("MIDI", () => onExport("midi", pageSize, scope))}>
            <Music4 size={16} aria-hidden /> MIDI
          </button>
          <p className="export-note">One track per part, concert pitch, for a DAW or notation app.</p>

          {onExportTestCase && (
            <div className="export-testcase">
              <span className="export-label">Test case for the developer</span>
              <textarea
                id="testcase-description"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What you played, e.g. “8 staccato quarter notes on concert F, 100 bpm, 4/4”"
              />
              <button
                className="btn"
                disabled={busy}
                onClick={() => run("Test case", () => onExportTestCase(description))}
              >
                <FileAudio size={16} aria-hidden /> Save test case
              </button>
              <p className="export-note">Saves the last take's audio, your settings and what was detected, so it can be replayed exactly.</p>
            </div>
          )}

          {message && <p className={message.error ? "export-msg is-error" : "export-msg"}>{message.text}</p>}
        </div>
      )}
    </div>
  );
}
