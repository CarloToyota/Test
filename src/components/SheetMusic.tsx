import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Accidental, Beam, Dot, Formatter, Renderer, Stave, StaveNote, StaveTie, Voice } from "vexflow";
import { keyAccidentalCount, vexKey } from "../lib/music";
import type { ScoreMeasure } from "../lib/quantize";
import type { BeatsPerMeasure, Clef } from "../lib/types";

interface Props {
  measures: ScoreMeasure[];
  clef: Clef;
  /** VexFlow key-signature spec for the *written* key, e.g. "D" or "Bb". */
  keySignature: string;
  beatsPerMeasure: BeatsPerMeasure;
  /** Changes whenever the notation changes; skips redundant redraws. */
  signature: string;
}

const ROW_HEIGHT = 130;
const TOP_PAD = 20;
const SIDE_PAD = 12;
const MIN_MEASURE_WIDTH = 250;
const LIVE_COLOR = "#e0902a";

interface Theme {
  ink: string;
}

function readTheme(el: HTMLElement): Theme {
  return { ink: getComputedStyle(el).getPropertyValue("--staff-ink").trim() || "#1d2130" };
}

export function SheetMusic({ measures, clef, keySignature, beatsPerMeasure, signature }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [themeTick, setThemeTick] = useState(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(320, Math.floor(entry.contentRect.width))));
    ro.observe(el);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => setThemeTick((t) => t + 1);
    mq.addEventListener("change", onScheme);
    return () => {
      ro.disconnect();
      mq.removeEventListener("change", onScheme);
    };
  }, []);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const theme = readTheme(host);
    host.innerHTML = "";

    const list: ScoreMeasure[] = measures.length ? measures : [{ items: [], complete: false }];
    const timeSig = `${beatsPerMeasure}/4`;
    const perRow = Math.max(1, Math.min(6, Math.floor((width - SIDE_PAD * 2) / MIN_MEASURE_WIDTH)));
    const rows = Math.max(1, Math.ceil(list.length / perRow));
    const height = TOP_PAD + rows * ROW_HEIGHT;

    const renderer = new Renderer(host, Renderer.Backends.SVG);
    renderer.resize(width, height);
    const ctx = renderer.getContext();
    ctx.setFillStyle(theme.ink);
    ctx.setStrokeStyle(theme.ink);

    const restKey = clef === "bass" ? "d/3" : "b/4";
    const keyExtra = 26 + keyAccidentalCount(keySignature) * 11;
    const usable = width - SIDE_PAD * 2;

    // Rendered notes, flat, to draw ties afterwards (they can cross barlines and rows).
    const drawn: Array<{ note: StaveNote; tieToNext: boolean; isNote: boolean; row: number }> = [];
    const inkStyle = { fillStyle: theme.ink, strokeStyle: theme.ink };

    list.forEach((measure, index) => {
      const row = Math.floor(index / perRow);
      const col = index % perRow;
      const isFirstInRow = col === 0;
      const isFirst = index === 0;
      const extraFirst = keyExtra + (isFirst ? 28 : 0);
      const baseWidth = (usable - extraFirst) / perRow;
      const x = SIDE_PAD + (isFirstInRow ? 0 : extraFirst + baseWidth * col);
      const w = baseWidth + (isFirstInRow ? extraFirst : 0);
      const y = TOP_PAD + row * ROW_HEIGHT;

      const stave = new Stave(x, y, w);
      if (isFirstInRow) stave.addClef(clef).addKeySignature(keySignature);
      if (isFirst) stave.addTimeSignature(timeSig);
      stave.setStyle(inkStyle);
      stave.setContext(ctx).draw();

      if (measure.items.length === 0) return;

      const notes = measure.items.map((item) => {
        const note = new StaveNote({
          clef,
          keys: [item.kind === "rest" ? restKey : vexKey(item.midi, keySignature)],
          duration: item.duration + (item.kind === "rest" ? "r" : ""),
          dots: item.dots,
          align_center: item.measureRest,
        });
        if (item.dots) Dot.buildAndAttach([note], { all: true });
        note.setStyle(item.live ? { fillStyle: LIVE_COLOR, strokeStyle: LIVE_COLOR } : inkStyle);
        drawn.push({ note, tieToNext: item.tieToNext, isNote: item.kind === "note", row });
        return note;
      });

      const voice = new Voice({ num_beats: beatsPerMeasure, beat_value: 4 }).setMode(Voice.Mode.SOFT);
      voice.addTickables(notes);
      Accidental.applyAccidentals([voice], keySignature);
      notes.forEach((n) => n.getModifiers().forEach((m) => m.setStyle(n.getStyle() ?? inkStyle)));

      const beams = Beam.generateBeams(notes, {
        groups: Beam.getDefaultBeamGroups(timeSig),
        beam_rests: false,
        maintain_stem_directions: false,
      });
      new Formatter().joinVoices([voice]).formatToStave([voice], stave);
      voice.draw(ctx, stave);
      beams.forEach((b) => b.setStyle(inkStyle).setContext(ctx).draw());
    });

    for (let i = 0; i < drawn.length; i++) {
      const cur = drawn[i];
      if (!cur.isNote || !cur.tieToNext) continue;
      const next = drawn.slice(i + 1).find((d) => d.isNote);
      if (!next) {
        // The note continues into time not rendered yet: a dangling tie.
        new StaveTie({ first_note: cur.note, first_indices: [0] }).setContext(ctx).draw();
        continue;
      }
      if (next.row === cur.row) {
        new StaveTie({ first_note: cur.note, last_note: next.note, first_indices: [0], last_indices: [0] })
          .setContext(ctx)
          .draw();
      } else {
        // Across a system break: two half ties.
        new StaveTie({ first_note: cur.note, first_indices: [0] }).setContext(ctx).draw();
        new StaveTie({ last_note: next.note, last_indices: [0] }).setContext(ctx).draw();
      }
    }

    // Follow the newest row.
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    // `signature` stands in for `measures` (a new array every frame).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, clef, keySignature, beatsPerMeasure, width, themeTick]);

  return (
    <div className="sheet-scroll" ref={scrollRef}>
      <div className="sheet-host" ref={hostRef} role="img" aria-label="Live transcription" />
    </div>
  );
}
