import { useEffect, useState } from "react";

type Props = {
  x: number;
  y: number;
  disabled?: boolean;
  onChange: (patch: { caption_x: number; caption_y: number }) => void;
};

const clamp = (value: number) => Math.min(0.95, Math.max(0.05, value));

function CoordinateInput({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  disabled?: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(Math.round(value * 100)));
  useEffect(() => setDraft(String(Math.round(value * 100))), [value]);
  function commit() {
    const parsed = Number(draft);
    const next = Number.isFinite(parsed) ? clamp(parsed / 100) : value;
    setDraft(String(Math.round(next * 100)));
    onCommit(next);
  }
  return (
    <label className="caption-coordinate">
      <span>{label}</span>
      <input
        type="number"
        min="5"
        max="95"
        step="1"
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        aria-label={`Caption ${label} position percent`}
      />
      <small>%</small>
    </label>
  );
}

export default function CaptionPlacement({
  x,
  y,
  disabled,
  onChange,
}: Props) {
  return (
    <div className="caption-placement" aria-label="Precise caption placement">
      <div className="caption-placement-heading">
        <span>Precise placement</span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange({ caption_x: 0.5, caption_y: 0.86 })}
        >
          Reset
        </button>
      </div>
      <div className="caption-coordinate-grid">
        <CoordinateInput
          label="X"
          value={x}
          disabled={disabled}
          onCommit={(next) => onChange({ caption_x: next, caption_y: y })}
        />
        <CoordinateInput
          label="Y"
          value={y}
          disabled={disabled}
          onCommit={(next) => onChange({ caption_x: x, caption_y: next })}
        />
      </div>
      <small className="caption-placement-help">
        Drag the caption in the preview or enter a position from 5–95%.
      </small>
    </div>
  );
}
