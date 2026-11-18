import { useEffect, useState } from "react";
import { TIME_SIGNATURES, meterName, parseMeter, type TimeSignature } from "../lib/meter";

interface Props {
  value: TimeSignature;
  disabled: boolean;
  onChange: (ts: TimeSignature) => void;
}

const CUSTOM = "custom";

/** Time signature: the common ones, or any custom meter with an optional grouping. */
export function MeterField({ value, disabled, onChange }: Props) {
  const name = meterName(value);
  const isListed = (TIME_SIGNATURES as readonly string[]).includes(name);
  const [custom, setCustom] = useState(!isListed);
  const [text, setText] = useState(name);
  const parsed = parseMeter(text);

  useEffect(() => setText(meterName(value)), [value]);

  const apply = () => {
    if (parsed) onChange(parsed);
  };

  return (
    <div className="field field-meter">
      <span>Time</span>
      <div className="meter-row">
        <select
          id="time-signature"
          value={custom ? CUSTOM : name}
          disabled={disabled}
          onChange={(e) => {
            if (e.target.value === CUSTOM) {
              setCustom(true);
              return;
            }
            setCustom(false);
            onChange(parseMeter(e.target.value)!);
          }}
        >
          {TIME_SIGNATURES.map((t) => (
            <option key={t} value={t}>
              {t === "2/2" ? "2/2 (cut)" : t}
            </option>
          ))}
          <option value={CUSTOM}>Custom…</option>
        </select>
        {custom && (
          <input
            id="custom-meter"
            className={parsed ? "" : "is-invalid"}
            type="text"
            value={text}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onBlur={apply}
            onKeyDown={(e) => e.key === "Enter" && apply()}
            placeholder="7/8 3+2+2"
            title="Beats/note value, optionally with a grouping: 11/8, 7/8 3+2+2, 5/4 3+2, 3+3+2/8. Note values: 2, 4, 8, 16."
            aria-invalid={!parsed}
          />
        )}
      </div>
    </div>
  );
}
