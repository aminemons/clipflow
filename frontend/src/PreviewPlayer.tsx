import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
  type RefObject,
} from "react";
import { Aperture, Image, Maximize2, Pause, Play, X } from "lucide-react";
import type { Clip, Project } from "./editorTypes";
import { useDialogFocus } from "./useDialogFocus";
import { captionAt, captionFont } from "./captionLayout";

const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));
const fmt = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export default function PreviewPlayer({
  project,
  clip,
  proofUrl,
  duration,
  activeTime,
  videoRef,
  pendingSourceSeek,
  playing,
  expanded = false,
  onPlayState,
  onTimeChange,
  onPatch,
  onRenderProof,
  renderDisabled = false,
  onUseSource,
  onExpand,
}: {
  project: Project | null;
  clip: Clip | undefined;
  proofUrl: string;
  duration: number;
  activeTime: number;
  videoRef: RefObject<HTMLVideoElement>;
  pendingSourceSeek: MutableRefObject<number | null>;
  playing: boolean;
  expanded?: boolean;
  onPlayState: (playing: boolean) => void;
  onTimeChange: (time: number) => void;
  onPatch: (id: string, patch: Partial<Clip>) => void;
  onRenderProof: () => void;
  renderDisabled?: boolean;
  onUseSource: () => void;
  onExpand: () => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const dialogRef = useDialogFocus<HTMLDivElement>(expanded);
  const [frameWidth, setFrameWidth] = useState(220);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    // Scale the editable overlay with the portrait canvas, including expanded view.
    const observer = new ResizeObserver(([entry]) =>
      setFrameWidth(entry.contentRect.width),
    );
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [captionPoint, setCaptionPoint] = useState({
    x: clip?.caption_x ?? 0.5,
    y: clip?.caption_y ?? (clip?.caption_position === "center" ? 0.5 : 0.86),
  });
  useEffect(() => {
    setCaptionPoint({
      x: clip?.caption_x ?? 0.5,
      y: clip?.caption_y ?? (clip?.caption_position === "center" ? 0.5 : 0.86),
    });
  }, [clip?.id, clip?.caption_x, clip?.caption_y, clip?.caption_position]);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) =>
      event.key === "Escape" && onExpand();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, onExpand]);
  const source = proofUrl || project?.source_url || "";
  const speed = clip?.playback_speed ?? 1;
  const sourceVolume = Math.min(1, Math.max(0, clip?.audio_volume ?? 1));
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const applyPlayback = () => {
      // Browser preview mirrors speed and mute/level only; rendered audio finishing stays proof-only.
      video.playbackRate = proofUrl ? 1 : speed;
      video.volume = proofUrl ? 1 : sourceVolume;
    };
    applyPlayback();
    video.addEventListener("loadedmetadata", applyPlayback);
    return () => video.removeEventListener("loadedmetadata", applyPlayback);
  }, [clip?.id, speed, sourceVolume, proofUrl, videoRef]);
  const transcriptCaption = captionAt(
    (clip?.transcript ?? project?.transcript)?.find(
        (segment) => activeTime >= segment.start && activeTime <= segment.end,
      ), activeTime);
  const captionText = clip?.caption_text?.trim() || transcriptCaption;
  function point(event: React.PointerEvent) {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0.5, y: 0.86 };
    return {
      x: clamp((event.clientX - rect.left) / rect.width, 0.05, 0.95),
      y: clamp((event.clientY - rect.top) / rect.height, 0.05, 0.95),
    };
  }
  function startCaptionDrag(event: React.PointerEvent<HTMLButtonElement>) {
    if (proofUrl || !clip) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = point(event);
    setCaptionPoint(drag.current);
  }
  function moveCaptionDrag(event: React.PointerEvent<HTMLButtonElement>) {
    if (!drag.current) return;
    drag.current = point(event);
    setCaptionPoint(drag.current);
  }
  function endCaptionDrag(event: React.PointerEvent<HTMLButtonElement>) {
    if (!drag.current || !clip) return;
    const finalPoint = drag.current;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    onPatch(clip.id, { caption_x: finalPoint.x, caption_y: finalPoint.y });
  }
  function toggle() {
    if (!videoRef.current) return;
    if (!proofUrl && clip && videoRef.current.currentTime >= clip.end) {
      videoRef.current.currentTime = clip.start;
    }
    if (videoRef.current.paused) videoRef.current.play().catch(() => undefined);
    else videoRef.current.pause();
  }
  const previewAspect = clip
    ? clip.aspect_ratio || "9:16"
    : `${project?.width || 16}:${project?.height || 9}`;
  const frame = (
    <div
      className={`preview-inner ${expanded ? "preview-inner-expanded" : ""}`}
      ref={frameRef}
      style={
        {
          aspectRatio: previewAspect.replace(":", "/"),
          "--preview-ratio": previewAspect
            .split(":")
            .map(Number)
            .reduce((width, height) => width / height),
        } as CSSProperties
      }
    >
      {source ? (
        <video
          className={proofUrl ? "proof-video" : "source-video"}
          style={
            proofUrl
              ? undefined
              : {
                  objectFit:
                    !clip || clip.framing !== "manual"
                      ? "contain"
                      : "cover",
                  objectPosition:
                    clip?.framing === "manual"
                      ? `${(clip.focus_x ?? 0.5) * 100}% 50%`
                      : "50% 50%",
                }
          }
          ref={videoRef}
          src={source}
          poster={proofUrl ? undefined : project?.thumbnail_url}
          onLoadedMetadata={() => {
            if (pendingSourceSeek.current === null || !videoRef.current) return;
            videoRef.current.currentTime = pendingSourceSeek.current;
            pendingSourceSeek.current = null;
          }}
          onTimeUpdate={(event) => {
            const sourceTime = event.currentTarget.currentTime;
            if (
              !proofUrl &&
              clip &&
              !event.currentTarget.paused &&
              sourceTime >= clip.end
            ) {
              event.currentTarget.pause();
              event.currentTarget.currentTime = clip.end;
              onPlayState(false);
            }
            onTimeChange(
              proofUrl
                ? clamp((clip?.start || 0) + sourceTime * speed, 0, duration)
                : sourceTime,
            );
          }}
          onPlay={() => onPlayState(true)}
          onPause={() => onPlayState(false)}
        />
      ) : (
        <>
          <div className="preview-grid" />
          <div className="empty-preview">
            <div className="preview-orbit">
              <Aperture size={28} />
            </div>
            <span>Import a source to start shaping your story</span>
            <small>Your original video stays in the local workspace</small>
          </div>
        </>
      )}
      {project && !project.source_url && !proofUrl && (
        <div className="source-missing">
          <Image size={14} />
          <span>Render a proof to inspect the final framing</span>
          <button disabled={renderDisabled} onClick={onRenderProof}>Render preview</button>
        </div>
      )}
      {clip && captionText && !proofUrl && clip.caption_enabled !== false && (
        <button
          className={`caption-overlay ${captionText ? "" : "caption-placeholder"} caption-${clip.caption_style || "clean"}`}
          aria-label="Drag caption position"
          style={{
            left: `${captionPoint.x * 100}%`,
            top: `${captionPoint.y * 100}%`,
            color: clip.caption_color || "#fff",
            fontSize: `${(frameWidth / 720) * (clip.caption_size ?? (clip.caption_style === "bold" ? 64 : clip.caption_style === "minimal" ? 46 : 52))}px`,
            fontFamily: captionFont(clip.caption_font, captionText),
            fontWeight: clip.caption_style === "bold" ? 700 : 400,
          }}
          onPointerDown={startCaptionDrag}
          onPointerMove={moveCaptionDrag}
          onPointerUp={endCaptionDrag}
        >
          {captionText}
        </button>
      )}
    </div>
  );
  const content = (
    <div className={expanded ? "preview-modal-card" : "preview-frame"}>
      {frame}
      <div className="preview-controls">
        <button
          className="preview-control-play"
          aria-label={playing ? "Pause preview" : "Play preview"}
          onClick={toggle}
        >
          {playing ? (
            <Pause size={14} fill="currentColor" />
          ) : (
            <Play size={14} fill="currentColor" />
          )}
        </button>
        <span>{proofUrl ? "Rendered proof" : "Source preview"}</span>
        <button
          className="preview-control"
          onClick={onRenderProof}
          disabled={!clip || !!proofUrl || renderDisabled}
        >
          Render preview
        </button>
        {proofUrl && (
          <button className="preview-control" onClick={onUseSource}>
            Use source
          </button>
        )}
        <button
          className="preview-control-expand"
          aria-label={expanded ? "Close expanded preview" : "Expand preview"}
          onClick={onExpand}
        >
          {expanded ? <X size={15} /> : <Maximize2 size={15} />}
        </button>
      </div>
      <div className="preview-label">
        <span>
          {proofUrl
            ? "Exact framing proof"
            : clip
              ? "Full source · render to see camera and effects"
              : "Full source · no cuts applied"}
        </span>
        <span>
          {clip ? `${fmt(clip.start)} – ${fmt(clip.end)}` : fmt(duration)}
        </span>
      </div>
    </div>
  );
  // Keep the video mounted so expanding never resets playback or the playhead.
  return (
    <div
      className={expanded ? "preview-modal" : "preview-shell"}
      ref={dialogRef}
      role={expanded ? "dialog" : undefined}
      aria-modal={expanded ? true : undefined}
      aria-label={expanded ? "Expanded preview" : undefined}
      onMouseDown={(event) =>
        expanded && event.target === event.currentTarget && onExpand()
      }
    >
      {content}
    </div>
  );
}
