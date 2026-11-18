import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ScoreItem, ScoreMeasure } from "../lib/quantize";
import { renderScore } from "../lib/render";
import type { Clef } from "../lib/types";

interface Props {
  measures: ScoreMeasure[];
  clef: Clef;
  /** VexFlow key-signature spec for the *written* key, e.g. "D" or "Bb". */
  keySignature: string;
  /** e.g. "4/4" or "6/8". */
  timeSig: string;
  /** Changes whenever the drawing should change; skips redundant redraws. */
  signature: string;
  /** Editor: which items are selected, and what a click selects. */
  isSelected?: (item: ScoreItem) => boolean;
  onSelect?: (item: ScoreItem) => void;
  /** Keep the newest system in view (live recording). */
  followEnd?: boolean;
  label: string;
}

const LIVE_COLOR = "#e0902a";

function cssVar(el: HTMLElement, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

export function SheetMusic({ measures, clef, keySignature, timeSig, signature, isSelected, onSelect, followEnd, label }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
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
    const interactive = !!selectRef.current.onSelect;
    renderScore(host, measures, {
      width,
      clef,
      keySignature,
      timeSig,
      ink: cssVar(host, "--staff-ink", "#1d2130"),
      liveColor: LIVE_COLOR,
      selectColor: cssVar(host, "--select", "#2f6fdf"),
      isSelected: selectRef.current.isSelected,
      onItemElement: interactive
        ? (item, el) => {
            el.classList.add("score-item");
            el.addEventListener("click", (e) => {
              e.stopPropagation();
              selectRef.current.onSelect?.(item);
            });
          }
        : undefined,
    });
    if (followEnd) {
      const scroller = scrollRef.current;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    }
    // `signature` stands in for `measures` and the selection (new objects every frame).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, clef, keySignature, timeSig, width, themeTick, followEnd]);

  return (
    <div className="sheet-scroll" ref={scrollRef}>
      <div className="sheet-host" ref={hostRef} role="img" aria-label={label} />
    </div>
  );
}
