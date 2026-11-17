interface Props {
  beatsPerMeasure: number;
  /** Current beat within the bar (0-based), or null when stopped. */
  beat: number | null;
  countIn: boolean;
}

/** Visual metronome: one light per beat, the downbeat accented. */
export function BeatIndicator({ beatsPerMeasure, beat, countIn }: Props) {
  return (
    <div className="beats" aria-label={beat === null ? "Metronome stopped" : `Beat ${beat + 1}`}>
      {Array.from({ length: beatsPerMeasure }, (_, i) => (
        <span key={i} className={`beat ${i === 0 ? "is-down" : ""} ${beat === i ? "is-on" : ""}`} />
      ))}
      <span className="beat-label">{beat === null ? "" : countIn ? `count-in ${beat + 1}` : `beat ${beat + 1}`}</span>
    </div>
  );
}
