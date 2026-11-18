import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { groupSteps, measureSteps, meterGlyph, type TimeSignature } from "../lib/meter";
import type { ScoreItem } from "../lib/quantize";
import { playheadAt, renderScore, type ScoreLayout, type StaffInput } from "../lib/render";

export interface PlayheadSource {
  subscribe(fn: (step: number | null) => void): () => void;
}

interface Props {
  staves: StaffInput[];
  timeSig: TimeSignature;
  /** Changes whenever the drawing should change; skips redundant redraws. */
  signature: string;
  /** Editor: which items are selected, and what a click selects. */
  isSelected?: (staff: number, item: ScoreItem) => boolean;
  onSelect?: (staff: number, item: ScoreItem) => void;
  /** Keep the newest system in view (live recording). */
  followEnd?: boolean;
  playhead?: PlayheadSource;
  label: string;
}

const LIVE_COLOR = "#e0902a";

function cssVar(el: HTMLElement, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

export function SheetMusic({ staves, timeSig, signature, isSelected, onSelect, followEnd, playhead, label }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<ScoreLayout | null>(null);
  const elementsRef = useRef<Array<Array<{ item: ScoreItem; el: SVGElement }>>>([]);
  const [width, setWidth] = useState(900);
  const [themeTick, setThemeTick] = useState(0);
  // Keep the latest callbacks without redrawing when only their identity changes.
  const selectRef = useRef({ isSelected, onSelect });
  selectRef.current = { isSelected, onSelect };

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
    const { isSelected: sel, onSelect: pick } = selectRef.current;
    const elements: Array<Array<{ item: ScoreItem; el: SVGElement }>> = staves.map(() => []);
    layoutRef.current = renderScore(
      host,
      staves.map((s, i) => ({ ...s, isSelected: sel ? (item: ScoreItem) => sel(i, item) : undefined })),
      {
        width,
        timeSig: meterGlyph(timeSig),
        beamGroups: groupSteps(timeSig),
        ink: cssVar(host, "--staff-ink", "#1d2130"),
        liveColor: LIVE_COLOR,
        selectColor: cssVar(host, "--select", "#2f6fdf"),
        onItemElement: (si, item, el) => {
          elements[si].push({ item, el });
          if (!pick) return;
          el.classList.add("score-item");
          // A generous invisible hit area, so small glyphs (rests, dots) are easy to click.
          const box = (el as SVGGraphicsElement).getBBox?.();
          if (box) {
            const hit = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            hit.setAttribute("class", "hit");
            hit.setAttribute("x", String(box.x - 4));
            hit.setAttribute("y", String(Math.min(box.y, box.y + box.height / 2 - 14) - 2));
            hit.setAttribute("width", String(box.width + 8));
            hit.setAttribute("height", String(Math.max(box.height, 28) + 4));
            el.insertBefore(hit, el.firstChild);
          }
          el.addEventListener("click", (e) => {
            e.stopPropagation();
            selectRef.current.onSelect?.(si, item);
          });
        },
      },
    );
    elementsRef.current = elements;
    if (followEnd) {
      const scroller = scrollRef.current;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    }
    // `signature` stands in for the staves and the selection (new objects every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, timeSig, width, themeTick, followEnd]);

  // The playback line and the notes it is sounding.
  useEffect(() => {
    if (!playhead) return;
    const spm = measureSteps(timeSig);
    let lit: SVGElement[] = [];
    let lastSystem = -1;
    const unlight = () => {
      lit.forEach((el) => el.classList.remove("is-playing"));
      lit = [];
    };
    const off = playhead.subscribe((step) => {
      const line = lineRef.current;
      const layout = layoutRef.current;
      if (!line || !layout) return;
      if (step === null) {
        line.hidden = true;
        unlight();
        lastSystem = -1;
        return;
      }
      const pos = playheadAt(layout, step, spm);
      if (!pos) return;
      const sys = layout.systems[pos.system];
      line.hidden = false;
      line.style.transform = `translateX(${pos.x}px)`;
      line.style.top = `${sys.top - 8}px`;
      line.style.height = `${sys.bottom - sys.top + 16}px`;
      const now: SVGElement[] = [];
      for (const list of elementsRef.current) {
        for (const { item, el } of list) {
          if (item.kind === "note" && item.start <= step && step < item.start + item.steps) now.push(el);
        }
      }
      if (now.length !== lit.length || now.some((el, i) => el !== lit[i])) {
        unlight();
        now.forEach((el) => el.classList.add("is-playing"));
        lit = now;
      }
      // Keep the playing system in view.
      if (pos.system !== lastSystem) {
        lastSystem = pos.system;
        const scroller = scrollRef.current;
        if (scroller && (sys.top < scroller.scrollTop || sys.bottom > scroller.scrollTop + scroller.clientHeight)) {
          scroller.scrollTo({ top: Math.max(0, sys.top - 24), behavior: "smooth" });
        }
      }
    });
    return () => {
      off();
      unlight();
      // The drawing is about to change; the line's old position no longer applies.
      if (lineRef.current) lineRef.current.hidden = true;
    };
  }, [playhead, timeSig, signature]);

  return (
    <div className="sheet-scroll" ref={scrollRef}>
      <div className="sheet-host-wrap">
        <div className="sheet-host" ref={hostRef} role="img" aria-label={label} />
        <div className="playhead" ref={lineRef} hidden aria-hidden />
      </div>
    </div>
  );
}
