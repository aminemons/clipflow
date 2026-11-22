import { useState } from "react";
import { AudioLines, Captions, Film, Minus, Plus, Redo2, Scissors, Sparkles, Undo2 } from "lucide-react";
import { clamp, clipCues, elapsed, lengthOf, type Project } from "./model";
import type { Playback, Playhead } from "./Monitor";

export function Timeline({ project, playhead, mode, wave, seek, selected, select, onSplit, onUndo, onRedo, canUndo, canRedo }: {
  project: Project; playhead: Playhead; mode: Playback["mode"]; wave: number[]; seek: (time: number) => void;
  selected: string; select: (id: string) => void; onSplit: () => void; onUndo: () => void; onRedo: () => void;
  canUndo: boolean; canRedo: boolean;
}) {
  const [zoom, setZoom] = useState(1);
  const total = lengthOf(project.cut.spans);
  const cues = clipCues(project);
  const cursor = mode === "cut" ? playhead.cut : 0;
  let offset = 0;
  const spans = project.cut.spans.map(span => {
    const start = offset;
    offset += span.end - span.start;
    return { ...span, offset: start, duration: span.end - span.start };
  });
  const styleAt = (start: number, duration: number) => ({ left: `${start / total * 100}%`, width: `${Math.max(0, Math.min(duration, total - start)) / total * 100}%` });
  const shape = wave.length ? Array.from({ length: 110 * zoom }, (_, i) => {
    const time = i / (110 * zoom) * total;
    const span = spans.find(item => item.offset <= time && time < item.offset + item.duration);
    if (!span) return 0;
    return wave[clamp(Math.floor((span.start + time - span.offset) / project.duration * wave.length), 0, wave.length - 1)] ?? 0;
  }) : [];
  return <section className="cf-timeline" aria-label="Timeline">
    <header className="cf-panel-head">
      <span className="cf-panel-title"><Scissors size={16} /> Timeline <span className="cf-timeline-time">{elapsed(total)}</span></span>
      <div className="cf-timeline-tools">
        <button className="cf-icon" disabled={!canUndo} onClick={onUndo} aria-label="Undo" title="Undo (Ctrl+Z)"><Undo2 size={17} /></button>
        <button className="cf-icon" disabled={!canRedo} onClick={onRedo} aria-label="Redo" title="Redo (Ctrl+Shift+Z)"><Redo2 size={17} /></button>
        <button className="cf-small" onClick={onSplit} title="Split at the clip playhead"><Scissors size={15} /> <span>Split</span></button>
        <div className="cf-timeline-zoom">
          <button className="cf-icon" onClick={() => setZoom(zoom - 1)} disabled={zoom === 1} aria-label="Zoom timeline out"><Minus size={14} /></button>
          <span>{zoom}×</span>
          <button className="cf-icon" onClick={() => setZoom(zoom + 1)} disabled={zoom === 4} aria-label="Zoom timeline in"><Plus size={14} /></button>
        </div>
      </div>
    </header>
    <div className="cf-tracks">
      <div className="cf-track-labels"><span>Timecode</span><span><Film size={14} /> Video</span><span><AudioLines size={14} /> Audio</span><span><Captions size={14} /> Captions</span><span><Sparkles size={14} /> Motion</span></div>
      <div className="cf-track-scroll">
        <div className="cf-track-content" style={{ width: `${zoom * 100}%` }}>
          <div className="cf-ticks" aria-hidden="true">{Array.from({ length: 5 * zoom + 1 }, (_, i) => <span key={i} style={{ left: `${i / (5 * zoom) * 100}%` }}>{elapsed(total * i / (5 * zoom))}</span>)}</div>
          <input className="cf-track-scrubber" aria-label="Seek in timeline" type="range" min={0} max={total} step={0.01} value={Math.min(cursor, total)} onChange={event => seek(+event.target.value)} />
          <div className="cf-track-row cf-video-track">{spans.map(span => <button key={span.id} className={span.id === selected ? "is-selected" : ""} style={styleAt(span.offset, span.duration)} title={`${project.sourceName} · ${elapsed(span.start)}–${elapsed(span.end)}`} onClick={() => { select(span.id); seek(span.offset); }}><Film size={13} /> <span>{project.title}</span></button>)}</div>
          <div className="cf-track-row cf-wave" aria-label={shape.length ? "Audio waveform" : "Audio track"}>{shape.map((level, i) => <i key={i} style={{ height: `${Math.max(3, level * 93)}%` }} />)}{!shape.length && <span>{wave.length ? "Quiet audio" : "No waveform"}</span>}</div>
          <div className="cf-track-row cf-caption-track">{project.cut.captions && cues.map((cue, index) => <button key={index} style={styleAt(cue.start, cue.end - cue.start)} onClick={() => seek(cue.start)} title={cue.text}>{cue.text}</button>)}</div>
          <div className="cf-track-row cf-motion-track">{project.cut.graphics.filter(graphic => graphic.start < total).map(graphic => <button key={graphic.id} style={styleAt(graphic.start, graphic.duration)} onClick={() => seek(graphic.start)} title={graphic.text || graphic.style}>{graphic.text || graphic.style}</button>)}</div>
          <div className="cf-playhead" style={{ left: `${clamp(cursor / total, 0, 1) * 100}%` }}><i /></div>
        </div>
      </div>
    </div>
  </section>;
}
