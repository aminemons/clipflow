import { useEffect, useState } from "react";
import { ChevronDown, Volume2, VolumeX } from "lucide-react";

export type ClipEnhancementsValue = {
  playback_speed?: number;
  audio_volume?: number;
  audio_denoise?: boolean;
  audio_fade?: number;
};

type Props = ClipEnhancementsValue & {
  start: number;
  end: number;
  disabled?: boolean;
  onChange: (patch: ClipEnhancementsValue) => void;
};

const speedPresets = [0.5, 0.75, 1, 1.25, 1.5, 2];

export default function ClipEnhancements({
  start,
  end,
  playback_speed = 1,
  audio_volume = 1,
  audio_denoise = false,
  audio_fade = 0,
  disabled,
  onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [fadeDraft, setFadeDraft] = useState(String(audio_fade));
  useEffect(() => setFadeDraft(String(audio_fade)), [audio_fade]);
  const outputDuration =
    Math.max(0, end - start) / Math.max(0.5, playback_speed);
  const muted = audio_volume <= 0;
  function commitFade() {
    const value = Math.min(2, Math.max(0, Number(fadeDraft) || 0));
    setFadeDraft(String(value));
    onChange({ audio_fade: value });
  }
  return (
    <section
      className={`settings-section clip-enhancements ${open ? "open" : ""}`}
    >
      <button
        className="enhancement-heading"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>
          <strong>Sound &amp; pace</strong>
          <small>Speed, level, and rendered audio finishing</small>
        </span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="enhancement-body">
          <div className="enhancement-label">
            <span>Playback speed</span>
            <b>{playback_speed}×</b>
          </div>
          <div className="speed-presets">
            {speedPresets.map((value) => (
              <button
                key={value}
                disabled={disabled}
                className={
                  Math.abs(playback_speed - value) < 0.01 ? "active" : ""
                }
                onClick={() => onChange({ playback_speed: value })}
              >
                {value}×
              </button>
            ))}
          </div>
          <div className="enhancement-label volume-label">
            <span>
              {muted ? <VolumeX size={14} /> : <Volume2 size={14} />} Audio
              level
            </span>
            <b>{Math.round(audio_volume * 100)}%</b>
          </div>
          <input
            disabled={disabled}
            aria-label="Audio volume"
            type="range"
            min="0"
            max="2"
            step=".01"
            value={audio_volume}
            onChange={(event) =>
              onChange({ audio_volume: Number(event.target.value) })
            }
          />
          <button
            disabled={disabled}
            className={`mute-toggle ${muted ? "active" : ""}`}
            onClick={() => onChange({ audio_volume: muted ? 1 : 0 })}
          >
            {muted ? "Unmute audio" : "Mute audio"}
          </button>
          <label className="enhancement-check">
            <input
              disabled={disabled}
              type="checkbox"
              checked={audio_denoise}
              onChange={(event) =>
                onChange({ audio_denoise: event.target.checked })
              }
            />{" "}
            Denoise in rendered proof
          </label>
          <label className="enhancement-field">
            Fade in / out
            <input
              disabled={disabled}
              type="number"
              min="0"
              max="2"
              step=".1"
              value={fadeDraft}
              onChange={(event) => setFadeDraft(event.target.value)}
              onBlur={commitFade}
              onKeyDown={(event) => event.key === "Enter" && commitFade()}
            />
            <span>seconds</span>
          </label>
          <div className="enhancement-estimate">
            Estimated output <b>{outputDuration.toFixed(1)}s</b>
          </div>
          <p className="enhancement-note">
            Denoise, gain above 100%, and fades are heard in the rendered proof.
            The source preview only follows speed and volume.
          </p>
        </div>
      )}
    </section>
  );
}
