import { useEffect, useRef, useState } from "react";
import { FilePlus2, FolderOpen, Import, Save } from "lucide-react";

interface Props {
  disabled: boolean;
  onNew: () => void;
  onOpen: () => Promise<void>;
  onImportParts: () => Promise<void>;
  onSave: () => Promise<void>;
}

/** New / Open / Add parts from a file / Save. */
export function FileMenu({ disabled, onNew, onOpen, onImportParts, onSave }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const run = (fn: () => void | Promise<void>) => async () => {
    setOpen(false);
    await fn();
  };

  return (
    <div className="menu" ref={ref}>
      <button className="btn" onClick={() => setOpen((o) => !o)} disabled={disabled} aria-expanded={open} aria-haspopup="menu">
        <FolderOpen size={16} aria-hidden /> File
      </button>
      {open && (
        <div className="menu-panel" role="menu">
          <button role="menuitem" onClick={run(onNew)}>
            <FilePlus2 size={15} aria-hidden /> New score
          </button>
          <button role="menuitem" onClick={run(onOpen)}>
            <FolderOpen size={15} aria-hidden /> Open…
            <small>Project, MusicXML (.musicxml, .xml, .mxl) or MIDI</small>
          </button>
          <button role="menuitem" onClick={run(onImportParts)}>
            <Import size={15} aria-hidden /> Add parts from a file…
            <small>Adds the file's parts to this score</small>
          </button>
          <button role="menuitem" onClick={run(onSave)}>
            <Save size={15} aria-hidden /> Save project…
            <small>Keeps every part editable (.bandscore)</small>
          </button>
        </div>
      )}
    </div>
  );
}
