import { useEffect, useRef, useState } from "react";
import { Film, Focus, Pause, Play, Scan, Volume2, VolumeX } from "lucide-react";
import { canvasSize, loadStudioFonts, paint, videoFrame } from "./compositor";
import { clamp, clipCues, clipPosition, elapsed, lengthOf, precise, type Project } from "./model";

export type Playback = { mode: "source" | "cut"; time: number; sequence: number; playUntil?: number };
export type Playhead = { source: number; cut: number };

export function Monitor({ project, url, playback, onSeek, onTime, guides, setGuides }: {
  project: Project; url: string; playback: Playback; onSeek: (mode: Playback["mode"], time: number) => void;
  onTime: (time: Playhead) => void; guides: boolean; setGuides: (set: boolean) => void;
}) {
  const source = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const frame = useRef(0);
  const spanIndex = useRef(0);
  const current = useRef(0);
  const published = useRef(-1);
  const auditionEnd = useRef<number>();
  const previewAudio = useRef<{ context: AudioContext; gain: GainNode; media: MediaElementAudioSourceNode }>();
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [problem, setProblem] = useState("");
  const sourceMode = playback.mode === "source";
  const cutLength = lengthOf(project.cut.spans);
  const total = sourceMode ? project.duration : cutLength;
  const size = sourceMode ? { width: 640, height: Math.max(1, Math.round(640 * project.height / project.width)) } : canvasSize(project, 360);

  useEffect(() => () => { void previewAudio.current?.context.close().catch(() => undefined); }, []);

  useEffect(() => {
    const video = source.current;
    const surface = canvas.current;
    if (!video || !surface) return;
    const ctx = surface.getContext("2d", { alpha: false });
    if (!ctx) return;
    let active = true;
    const cues = clipCues(project);
    const draw = () => {
      if (!active || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      const span = project.cut.spans[spanIndex.current];
      const offset = project.cut.spans.slice(0, spanIndex.current).reduce((value, item) => value + item.end - item.start, 0);
      const t = sourceMode ? video.currentTime : span ? clamp(offset + video.currentTime - span.start, 0, cutLength) : 0;
      current.current = clamp(t, 0, total);
      if (!video.paused && auditionEnd.current !== undefined && t >= auditionEnd.current - 0.017) {
        auditionEnd.current = undefined;
        video.pause();
      }
      if (!sourceMode && span && !video.paused && !video.seeking && video.currentTime >= span.end - 0.017) {
        const following = project.cut.spans[spanIndex.current + 1];
        if (following) {
          spanIndex.current++;
          video.currentTime = following.start;
          return;
        }
        video.pause();
        current.current = cutLength;
      }
      if (!sourceMode && video.ended && span && video.currentTime >= span.end - 0.08 && project.cut.spans[spanIndex.current + 1]) {
        spanIndex.current++;
        video.currentTime = project.cut.spans[spanIndex.current].start;
        void video.play().catch(() => setPlaying(false));
        return;
      }
      const fade = !sourceMode && project.cut.fade ? clamp(Math.min(t / 0.10, (cutLength - t) / 0.16), 0, 1) : 1;
      const gain = sourceMode ? 1 : project.cut.volume / 100 * fade;
      if (previewAudio.current) previewAudio.current.gain.gain.value = gain;
      else video.volume = Math.min(1, gain);
      paint(ctx, videoFrame(video), project, current.current, cues, guides, sourceMode, cutLength);
      if (video.paused || Math.abs(published.current - current.current) >= 0.10) {
        published.current = current.current;
        setPosition(current.current);
        onTime({ source: video.currentTime, cut: sourceMode ? 0 : current.current });
      }
    };
    const tick = () => {
      draw();
      if (!video.paused && !video.ended) frame.current = requestAnimationFrame(tick);
    };
    const play = () => {
      setPlaying(true);
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(tick);
    };
    const pause = () => { setPlaying(false); draw(); };
    const events = [["loadeddata", draw], ["seeked", draw], ["play", play], ["pause", pause], ["ended", pause]] as const;
    events.forEach(([event, handler]) => video.addEventListener(event, handler));
    if (video.paused) draw(); else frame.current = requestAnimationFrame(tick);
    void loadStudioFonts().then(draw);
    return () => {
      active = false;
      cancelAnimationFrame(frame.current);
      events.forEach(([event, handler]) => video.removeEventListener(event, handler));
    };
  }, [project, onTime, url, guides, sourceMode, total, cutLength, size.height, size.width]);

  useEffect(() => {
    const video = source.current;
    if (!video) return;
    setProblem("");
    video.pause();
    auditionEnd.current = playback.playUntil;
    const seek = () => {
      const output = clipPosition(project.cut.spans, playback.time);
      spanIndex.current = output?.index ?? 0;
      const target = sourceMode ? playback.time : output?.sourceTime ?? 0;
      video.currentTime = clamp(target, 0, video.duration);
      if (playback.playUntil !== undefined) void video.play().catch(() => setProblem("Press Play to preview this moment."));
    };
    if (video.readyState >= 1) seek();
    else video.addEventListener("loadedmetadata", seek, { once: true });
    return () => video.removeEventListener("loadedmetadata", seek);
    // Project edits may restyle without being an explicit seek.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback, url, sourceMode]);

  function toggle() {
    const video = source.current;
    if (!video || !url) return;
    if (!video.paused) return video.pause();
    if (current.current >= total - 0.03 || video.ended) {
      spanIndex.current = 0;
      video.currentTime = sourceMode ? 0 : project.cut.spans[0].start;
    }
    try {
      if (!previewAudio.current && window.AudioContext) {
        const context = new AudioContext();
        const gain = context.createGain();
        const media = context.createMediaElementSource(video);
        media.connect(gain).connect(context.destination);
        previewAudio.current = { context, gain, media };
        video.volume = 1;
      }
      void previewAudio.current?.context.resume().catch(() => undefined);
    } catch {
      // Native media volume remains available if the audio graph is unsupported.
    }
    void video.play().catch(() => setProblem("Playback could not start for this video."));
  }

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat || event.defaultPrevented || document.querySelector("dialog[open]") || (event.target instanceof Element && event.target.closest("input, textarea, select, button, [contenteditable]"))) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  });

  return <section className="cf-monitor" aria-label="Video monitor">
    <header className="cf-panel-head cf-monitor-head">
      <span className="cf-panel-title"><Scan size={16} /> Monitor</span>
      <div className="cf-segmented" aria-label="Monitor mode">
        <button className={!sourceMode ? "is-active" : ""} aria-pressed={!sourceMode} onClick={() => onSeek("cut", 0)}>Clip</button>
        <button className={sourceMode ? "is-active" : ""} aria-pressed={sourceMode} onClick={() => onSeek("source", 0)}>Source</button>
      </div>
      <button className={guides ? "cf-icon is-active" : "cf-icon"} type="button" onClick={() => setGuides(!guides)} disabled={sourceMode} title="Toggle platform safe guides" aria-label="Toggle platform safe guides" aria-pressed={guides}><Focus size={17} /></button>
    </header>
    <div className="cf-screen">
      <div className="cf-screen-top"><span><i /> {sourceMode ? "SOURCE" : "PROGRAM"}</span><span>{sourceMode ? `${project.width} × ${project.height}` : `${size.width} × ${size.height}`}</span></div>
      <div className="cf-monitor-frame" style={{ aspectRatio: `${size.width}/${size.height}`, "--preview-ratio": size.width / size.height } as React.CSSProperties}>
        {url && <canvas ref={canvas} width={size.width} height={size.height} onClick={toggle} aria-label={sourceMode ? "Source video preview" : "Composited clip preview"} />}
        {!url && <div className="cf-no-preview"><Film size={22} /><span>Opening local footage…</span></div>}
      </div>
      <video ref={source} className="cf-video-source" src={url || undefined} preload="auto" muted={muted} playsInline onError={() => setProblem("The source video could not be played.")} />
      {problem && <p role="alert" className="cf-monitor-error">{problem}</p>}
    </div>
    <div className="cf-transport">
      <button className="cf-play" onClick={toggle} disabled={!url} aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (Space)" : "Play (Space)"}>{playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button>
      <span className="cf-time">{precise(position)}</span>
      <input type="range" aria-label={sourceMode ? "Source playhead" : "Clip playhead"} min={0} max={total} step={0.01} value={Math.min(total, position)} onChange={event => onSeek(playback.mode, +event.target.value)} />
      <span className="cf-time cf-time-end">{elapsed(total)}</span>
      <button className="cf-icon" onClick={() => setMuted(!muted)} aria-label={muted ? "Unmute preview" : "Mute preview"}>{muted ? <VolumeX size={17} /> : <Volume2 size={17} />}</button>
    </div>
  </section>;
}
