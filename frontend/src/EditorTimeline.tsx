import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Focus,
  Minus,
  Pause,
  Play,
  Plus,
  Scissors,
} from "lucide-react";
import "./EditorTimeline.css";

export type TimelineClip = {
  id: string;
  title: string;
  start: number;
  end: number;
  selected?: boolean;
  status?: string;
};
type Props = {
  duration: number;
  clips: TimelineClip[];
  selectedId: string | null;
  activeTime: number;
  playing: boolean;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  onSeek: (time: number) => void;
  onSelect: (clip: TimelineClip) => void;
  onPlayToggle: () => void;
  onStep: (amount: number) => void;
  onTrim: (id: string, start: number, end: number) => void;
  onFitSource: () => void;
  onFocusClip: () => void;
};
const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, n));
const formatTime = (seconds: number) => {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
};
const zoomStep = (zoom: number, direction: 1 | -1) =>
  clamp(direction > 0 ? zoom * 2 : zoom / 2, 1, 256);
function tickStep(duration: number, width: number) {
  const target = (duration / Math.max(width, 1)) * 80;
  return (
    [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800].find(
      (step) => step >= target,
    ) || 3600
  );
}

export default function EditorTimeline({
  duration,
  clips,
  selectedId,
  activeTime,
  playing,
  zoom,
  onZoomChange,
  onSeek,
  onSelect,
  onPlayToggle,
  onStep,
  onTrim,
  onFitSource,
  onFocusClip,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(760);
  const trimDrag = useRef<{ id: string; edge: "start" | "end" } | null>(null);
  const safeDuration = Math.max(duration, 1);
  const contentWidth = Math.max(
    viewportWidth,
    viewportWidth * clamp(zoom, 1, 256),
  );
  const step = tickStep(safeDuration, contentWidth);
  const ticks = useMemo(() => {
    const result: number[] = [];
    for (let value = 0; value <= duration; value += step) result.push(value);
    if (!result.length || result[result.length - 1] !== duration)
      result.push(duration);
    return result;
  }, [duration, step]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setViewportWidth(Math.max(1, entry.contentRect.width)),
    );
    observer.observe(element);
    setViewportWidth(Math.max(1, element.clientWidth));
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const active = timelineRef.current?.querySelector<HTMLElement>(
      "[data-active-clip='true']",
    );
    if (!active || !scrollRef.current) return;
    const parent = scrollRef.current;
    const left = active.offsetLeft;
    const right = left + active.offsetWidth;
    if (
      left < parent.scrollLeft ||
      right > parent.scrollLeft + parent.clientWidth
    )
      parent.scrollTo({
        left: Math.max(0, left - parent.clientWidth / 2),
        behavior: "smooth",
      });
  }, [selectedId, zoom]);
  function seekFromPointer(clientX: number) {
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = clientX - rect.left;
    onSeek(clamp((x / Math.max(rect.width, 1)) * safeDuration, 0, duration));
  }
  function trimFromPointer(clientX: number) {
    const active = trimDrag.current;
    const clip = clips.find((item) => item.id === active?.id);
    const rect = timelineRef.current?.getBoundingClientRect();
    if (!active || !clip || !rect) return;
    const time = clamp(
      ((clientX - rect.left) / Math.max(rect.width, 1)) * safeDuration,
      0,
      duration,
    );
    const next =
      active.edge === "start"
        ? [clamp(time, 0, clip.end - 0.1), clip.end]
        : [clip.start, clamp(time, clip.start + 0.1, duration)];
    onTrim(clip.id, next[0], next[1]);
  }
  function startTrim(
    event: React.PointerEvent<HTMLSpanElement>,
    clip: TimelineClip,
    edge: "start" | "end",
  ) {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    trimDrag.current = { id: clip.id, edge };
    trimFromPointer(event.clientX);
  }
  function moveTrim(event: React.PointerEvent<HTMLSpanElement>) {
    if (!trimDrag.current) return;
    trimFromPointer(event.clientX);
  }
  function endTrim(event: React.PointerEvent<HTMLSpanElement>) {
    trimDrag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }
  function trimByKeyboard(
    event: React.KeyboardEvent<HTMLSpanElement>,
    clip: TimelineClip,
    edge: "start" | "end",
  ) {
    const step = event.shiftKey ? 1 : 0.1;
    let value = edge === "start" ? clip.start : clip.end;
    if (event.key === "ArrowLeft") value -= step;
    else if (event.key === "ArrowRight") value += step;
    else if (event.key === "Home")
      value = edge === "start" ? 0 : clip.start + 0.1;
    else if (event.key === "End")
      value = edge === "end" ? duration : clip.end - 0.1;
    else return;
    event.preventDefault();
    onTrim(
      clip.id,
      edge === "start" ? clamp(value, 0, clip.end - 0.1) : clip.start,
      edge === "end" ? clamp(value, clip.start + 0.1, duration) : clip.end,
    );
  }
  function startScrub(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    seekFromPointer(event.clientX);
  }
  function handleSeekKey(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onStep(-Math.max(0.1, duration / zoom / 100));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onStep(Math.max(0.1, duration / zoom / 100));
    } else if (event.key === "Home") {
      event.preventDefault();
      onSeek(0);
    } else if (event.key === "End") {
      event.preventDefault();
      onSeek(duration);
    }
  }
  return (
    <section
      className="timeline-panel editor-timeline"
      aria-label="Editor timeline"
    >
      <div className="timeline-head">
        <div className="timeline-title">
          <span>Timeline</span>
          <span className="muted">{formatTime(duration)} source</span>
        </div>
        <div className="timeline-actions">
          <button
            className="icon-button"
            aria-label="Step back"
            onClick={() => onStep(-0.1)}
          >
            <ArrowLeft size={15} />
          </button>
          <span className="time-readout">{formatTime(activeTime)}</span>
          <button
            className="icon-button"
            aria-label="Step forward"
            onClick={() => onStep(0.1)}
          >
            <ArrowRight size={15} />
          </button>
          <button
            className="play-small"
            aria-label={playing ? "Pause timeline" : "Play timeline"}
            onClick={onPlayToggle}
          >
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </button>
        </div>
      </div>
      <div className="timeline-tools">
        <span className="timeline-tool-label">View</span>
        <button className="timeline-fit" onClick={onFitSource}>
          Fit source
        </button>
        <button
          className="timeline-fit"
          disabled={!selectedId}
          onClick={onFocusClip}
        >
          <Focus size={13} /> Focus clip
        </button>
        <div className="timeline-zoom" aria-label="Timeline zoom">
          <button
            aria-label="Zoom out"
            onClick={() => onZoomChange(zoomStep(zoom, -1))}
          >
            <Minus size={13} />
          </button>
          <input
            type="range"
            min="0"
            max="8"
            step="1"
            value={Math.log2(clamp(zoom, 1, 256))}
            onChange={(event) => onZoomChange(2 ** Number(event.target.value))}
            aria-label="Timeline zoom level"
          />
          <button
            aria-label="Zoom in"
            onClick={() => onZoomChange(zoomStep(zoom, 1))}
          >
            <Plus size={13} />
          </button>
          <b>{zoom >= 10 ? `${Math.round(zoom)}×` : `${zoom.toFixed(1)}×`}</b>
        </div>
      </div>
      <div className="timeline-scroll" ref={scrollRef}>
        <div
          className="timeline-canvas"
          ref={timelineRef}
          style={{ width: contentWidth }}
          onPointerDown={startScrub}
          onPointerMove={(event) =>
            event.currentTarget.hasPointerCapture(event.pointerId) &&
            seekFromPointer(event.clientX)
          }
        >
          <div
            className="timeline-ruler"
            role="slider"
            tabIndex={0}
            aria-label="Seek source timeline"
            aria-valuemin={0}
            aria-valuemax={duration}
            aria-valuenow={activeTime}
            onKeyDown={handleSeekKey}
          >
            {ticks.map((time) => (
              <span
                key={time}
                style={{ left: `${(time / safeDuration) * 100}%` }}
              >
                {formatTime(time)}
              </span>
            ))}
          </div>
          <div className="timeline-track">
            {clips.map((clip) => (
              <button
                key={clip.id}
                data-active-clip={clip.id === selectedId}
                className={`timeline-clip ${clip.id === selectedId ? "selected" : ""} ${clip.status === "exported" ? "exported" : "draft"}`}
                style={{
                  left: `${(clip.start / safeDuration) * contentWidth}px`,
                  width: `${Math.max(((clip.end - clip.start) / safeDuration) * contentWidth, 4)}px`,
                }}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect(clip);
                }}
                title={`${clip.title} · ${formatTime(clip.start)}–${formatTime(clip.end)}`}
              >
                <span
                  className="timeline-trim-handle start"
                  role="slider"
                  tabIndex={0}
                  aria-label={`Trim start of ${clip.title}`}
                  aria-valuemin={0}
                  aria-valuemax={Math.max(0, clip.end - 0.1)}
                  aria-valuenow={clip.start}
                  onPointerDown={(event) => startTrim(event, clip, "start")}
                  onPointerMove={moveTrim}
                  onPointerUp={endTrim}
                  onKeyDown={(event) => trimByKeyboard(event, clip, "start")}
                />
                <span>{clip.title}</span>
                <span
                  className="timeline-trim-handle end"
                  role="slider"
                  tabIndex={0}
                  aria-label={`Trim end of ${clip.title}`}
                  aria-valuemin={Math.min(duration, clip.start + 0.1)}
                  aria-valuemax={duration}
                  aria-valuenow={clip.end}
                  onPointerDown={(event) => startTrim(event, clip, "end")}
                  onPointerMove={moveTrim}
                  onPointerUp={endTrim}
                  onKeyDown={(event) => trimByKeyboard(event, clip, "end")}
                />
              </button>
            ))}
            <button
              type="button"
              className="timeline-playhead"
              style={{
                left: `${(activeTime / safeDuration) * contentWidth}px`,
              }}
              role="slider"
              tabIndex={0}
              aria-label="Seek timeline"
              aria-valuemin={0}
              aria-valuemax={duration}
              aria-valuenow={activeTime}
              onPointerDown={(event) => {
                event.stopPropagation();
                event.currentTarget.setPointerCapture(event.pointerId);
                seekFromPointer(event.clientX);
              }}
              onPointerMove={(event) =>
                event.currentTarget.hasPointerCapture(event.pointerId) &&
                seekFromPointer(event.clientX)
              }
              onKeyDown={handleSeekKey}
            >
              <i />
            </button>
          </div>
        </div>
      </div>
      <div className="timeline-bottom">
        <span>
          <Scissors size={13} /> {clips.length} clips
        </span>
        <span>Drag the ruler to seek · drag clip edges to trim</span>
      </div>
    </section>
  );
}
