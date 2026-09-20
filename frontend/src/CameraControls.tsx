import { Crosshair, MapPin, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Clip } from "./editorTypes";
import "./CameraControls.css";

type CameraKeyframe = NonNullable<Clip["camera_keyframes"]>[number];

export type CameraControlsProps = {
  clip: Clip;
  onPatch: (patch: Partial<Clip>) => void;
  activeTime: number;
  disabled?: boolean;
  onSeek?: (time: number) => void;
};

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

const readPercent = (value: string, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(parsed / 100, 0, 1) : fallback;
};

const formatTime = (value: number) => {
  const seconds = Math.max(0, value);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds - minutes * 60).toFixed(2).padStart(5, "0")}`;
};

function sortedKeyframes(clip: Clip): CameraKeyframe[] {
  return [...(clip.camera_keyframes ?? [])]
    .filter((frame) => Number.isFinite(frame.time))
    .sort((a, b) => a.time - b.time);
}

export default function CameraControls({
  clip,
  onPatch,
  activeTime,
  disabled = false,
  onSeek,
}: CameraControlsProps) {
  const keyframes = useMemo(
    () => sortedKeyframes(clip),
    [clip.camera_keyframes],
  );
  const playhead = clamp(activeTime, clip.start, clip.end);
  const nearby = keyframes.find(
    (frame) => Math.abs(frame.time - playhead) < 0.05,
  );
  const [xDraft, setXDraft] = useState(
    String(Math.round((nearby?.x ?? clip.focus_x ?? 0.5) * 100)),
  );
  const [yDraft, setYDraft] = useState(
    String(Math.round((nearby?.y ?? 0.5) * 100)),
  );

  useEffect(() => {
    setXDraft(String(Math.round((nearby?.x ?? clip.focus_x ?? 0.5) * 100)));
    setYDraft(String(Math.round((nearby?.y ?? 0.5) * 100)));
  }, [nearby?.time, clip.focus_x, clip.camera_keyframes, playhead]);

  function patchKeyframe(time: number, values: Partial<CameraKeyframe>) {
    const existing = keyframes.find(
      (frame) => Math.abs(frame.time - time) < 0.05,
    );
    const next: CameraKeyframe = {
      time: existing?.time ?? Number(time.toFixed(3)),
      x: clamp(values.x ?? existing?.x ?? 0.5, 0, 1),
      y: clamp(values.y ?? existing?.y ?? 0.5, 0, 1),
      zoom: clamp(
        values.zoom ?? existing?.zoom ?? clip.camera_zoom ?? 1,
        1,
        1.5,
      ),
    };
    const without = keyframes.filter(
      (frame) => Math.abs(frame.time - next.time) >= 0.05,
    );
    onPatch({
      camera_keyframes: [...without, next].sort((a, b) => a.time - b.time),
    });
  }

  function addAtPlayhead() {
    const exists = keyframes.some(
      (frame) => Math.abs(frame.time - playhead) < 0.05,
    );
    if (!exists && keyframes.length >= 50) return;
    const x = readPercent(xDraft, nearby?.x ?? clip.focus_x ?? 0.5);
    const y = readPercent(yDraft, nearby?.y ?? 0.5);
    patchKeyframe(playhead, { x, y, zoom: clip.camera_zoom ?? 1 });
    setXDraft(String(Math.round(x * 100)));
    setYDraft(String(Math.round(y * 100)));
  }

  function removeKeyframe(time: number) {
    onPatch({
      camera_keyframes: keyframes.filter(
        (frame) => Math.abs(frame.time - time) >= 0.05,
      ),
    });
  }

  return (
    <section
      className="settings-section camera-controls"
      aria-labelledby="camera-controls-title"
    >
      <div className="section-title" id="camera-controls-title">
        <span>
          {clip.framing === "follow"
            ? "Automatic camera movement"
            : "Manual camera path"}
        </span>
        <Crosshair size={16} aria-hidden="true" />
      </div>
      <p className="camera-controls-intro">
        {keyframes.length
          ? "Your keyframes control the camera and override automatic tracking. Remove them to return to automatic movement."
          : clip.framing === "follow"
            ? "Track the subject automatically, or add keyframes to control specific positions yourself."
            : "Set the zoom for a fixed crop, or add camera positions at different times to create movement."}
      </p>
      {clip.framing === "follow" && <div className="camera-strategy-controls">
        <label>Framing approach<select disabled={disabled} value={clip.camera_strategy || "adaptive"} onChange={(e) => onPatch({camera_strategy: e.target.value as Clip["camera_strategy"]})}>
          <option value="adaptive">Preserve diagrams and subjects</option><option value="follow">Follow subjects</option>
        </select></label>
        <label>When content is wider than the frame<select disabled={disabled} value={clip.safe_framing || "fit"} onChange={(e) => onPatch({safe_framing: e.target.value as Clip["safe_framing"]})}>
          <option value="fit">Show the whole frame</option><option value="blur">Show with blurred background</option>
        </select></label>
        <label>Visual analysis<select disabled={disabled} value={clip.vision_provider || "local"} onChange={(e) => onPatch({vision_provider: e.target.value as Clip["vision_provider"]})}>
          <option value="local">OpenCV · free</option><option value="gemini">Gemini · sends sampled frames, requires key</option>
        </select></label>
      </div>}
      <div
        hidden={clip.framing !== "follow" || keyframes.length > 0}
        className="camera-presets"
        role="group"
        aria-label="Camera movement preset"
      >
        {(["steady", "smooth", "dynamic"] as const).map((preset) => (
          <button
            type="button"
            key={preset}
            disabled={disabled}
            className={
              clip.camera_motion === preset ||
              (!clip.camera_motion && preset === "smooth")
                ? "selected"
                : ""
            }
            onClick={() => onPatch({ camera_motion: preset })}
          >
            {preset[0].toUpperCase() + preset.slice(1)}
          </button>
        ))}
      </div>
      {clip.framing === "follow" && !keyframes.length && <label className="camera-auto-zoom">
        <input type="checkbox" checked={!!clip.camera_auto_zoom} disabled={disabled}
          onChange={(event) => onPatch({camera_auto_zoom: event.target.checked,
            ...(event.target.checked ? {camera_zoom: Math.max(1.25, clip.camera_zoom ?? 1)} : {})})} />
        Adjust zoom to face size
      </label>}
      <label className="range-control">
        <span>
          <span>
            {keyframes.length ? "Zoom for next keyframe" : clip.camera_auto_zoom && clip.framing === "follow" ? "Maximum zoom" : "Camera zoom"}
          </span>
          <b>{(clip.camera_zoom ?? 1).toFixed(2)}×</b>
        </span>
        <input
          type="range"
          min="1"
          max="1.5"
          step="0.01"
          value={clip.camera_zoom ?? 1}
          disabled={disabled}
          aria-label="Camera zoom"
          onChange={(event) =>
            onPatch({ camera_zoom: Number(event.target.value) })
          }
        />
      </label>
      <label
        className="range-control"
        hidden={clip.framing !== "follow" || keyframes.length > 0}
      >
        <span>
          <span>Dead zone</span>
          <b>{Math.round((clip.camera_dead_zone ?? 0.08) * 100)}%</b>
        </span>
        <input
          type="range"
          min="0"
          max="0.3"
          step="0.01"
          value={clip.camera_dead_zone ?? 0.08}
          disabled={disabled}
          aria-label="Camera dead zone"
          onChange={(event) =>
            onPatch({ camera_dead_zone: Number(event.target.value) })
          }
        />
      </label>
      <div className="camera-keyframe-heading">
        <span>Camera keyframes</span>
        <small>{keyframes.length}/50</small>
      </div>
      <div className="camera-keyframe-editor">
        <span className="camera-playhead">At {formatTime(playhead)}</span>
        <div className="camera-coordinate-grid">
          <label>
            <span>X center</span>
            <input
              type="number"
              min="0"
              max="100"
              step="1"
              value={xDraft}
              disabled={disabled}
              onChange={(event) => setXDraft(event.target.value)}
            />
          </label>
          <label>
            <span>Y center</span>
            <input
              type="number"
              min="0"
              max="100"
              step="1"
              value={yDraft}
              disabled={disabled}
              onChange={(event) => setYDraft(event.target.value)}
            />
          </label>
        </div>
        <button
          type="button"
          className="camera-keyframe-add"
          disabled={disabled || (!nearby && keyframes.length >= 50)}
          onClick={addAtPlayhead}
        >
          <MapPin size={14} aria-hidden="true" />
          {nearby ? "Update keyframe" : "Add at playhead"}
        </button>
      </div>
      {keyframes.length > 0 && (
        <ol className="camera-keyframe-list" aria-label="Camera keyframes">
          {keyframes.map((frame) => (
            <li
              key={frame.time}
              className={nearby?.time === frame.time ? "active" : ""}
            >
              <button
                type="button"
                className="camera-keyframe-time"
                onClick={() => onSeek?.(frame.time)}
                disabled={disabled || !onSeek}
              >
                {formatTime(frame.time)}
              </button>
              <label>
                <span>X</span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={Math.round(frame.x * 100)}
                  disabled={disabled}
                  onChange={(event) =>
                    patchKeyframe(frame.time, {
                      x: readPercent(event.target.value, frame.x),
                    })
                  }
                />
              </label>
              <label>
                <span>Y</span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={Math.round(frame.y * 100)}
                  disabled={disabled}
                  onChange={(event) =>
                    patchKeyframe(frame.time, {
                      y: readPercent(event.target.value, frame.y),
                    })
                  }
                />
              </label>
              <label className="camera-keyframe-zoom">
                Zoom
                <input
                  aria-label={`Zoom at ${formatTime(frame.time)}`}
                  type="number"
                  min="1"
                  max="1.5"
                  step="0.05"
                  value={frame.zoom}
                  disabled={disabled}
                  onChange={(event) => {
                    const zoom = Number(event.target.value);
                    if (Number.isFinite(zoom) && zoom >= 1 && zoom <= 1.5)
                      patchKeyframe(frame.time, { zoom });
                  }}
                />
              </label>
              <button
                type="button"
                className="camera-keyframe-remove"
                aria-label={`Remove keyframe at ${formatTime(frame.time)}`}
                disabled={disabled}
                onClick={() => removeKeyframe(frame.time)}
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ol>
      )}
      <small className="camera-controls-note">
        Coordinates use the source frame center. Keyframe times are source
        seconds.
      </small>
    </section>
  );
}
