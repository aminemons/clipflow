import type { EditBrief } from "../AutoEdit";
import type { ClipSetupSettings } from "../ClipSetup";
import type { Clip, Project } from "../editorTypes";
import { aiMoments, requester } from "../studio/assistant";
import { clipCues, localCandidates, makeId, newProject, round, tightenPauses, type Project as RenderProject, type Span } from "../studio/model";
import type { SubtitleSegment } from "../subtitleImport";

export function clipDraft(source: Project, patch: Partial<Clip> = {}): Clip {
  const start = Math.max(0, Math.min(patch.start ?? 0, source.duration - 0.015));
  const end = Math.max(start + 0.015, Math.min(patch.end ?? 30, source.duration));
  return {
    title: "Untitled clip", framing: "manual", focus_x: 0.5, smoothing: 0.15,
    caption_text: "", caption_style: "clean", caption_color: "#b8a7ff", caption_position: "bottom",
    caption_enabled: true, caption_x: 0.5, caption_y: 0.86, resolution: 720, ...patch,
    start, end, id: makeId(), revision: 1, status: "draft", download_url: undefined, auto_proof: undefined,
  };
}

function keptSpans(clip: Clip): Span[] {
  let position = clip.start;
  const spans: Span[] = [];
  for (const gap of [...(clip.pause_cuts ?? [])].sort((a, b) => a.start - b.start)) {
    if (gap.start <= position || gap.end >= clip.end || gap.end <= gap.start) continue;
    spans.push({ id: makeId(), start: position, end: gap.start });
    position = gap.end;
  }
  spans.push({ id: makeId(), start: position, end: clip.end });
  return spans;
}

function renderSource(project: Project): RenderProject {
  const render = newProject(new File([], project.title), project);
  return { ...render, title: project.title, transcript: project.transcript ?? [] };
}

export function renderProject(project: Project, clip: Clip): RenderProject {
  const base = renderSource(project);
  const spans = keptSpans(clip);
  const graphics = clip.motion_graphic && (clip.motion_graphic.text || clip.motion_graphic.preset === "flash" || clip.motion_graphic.preset === "zoom") ? [{ id: makeId(), style: clip.motion_graphic.preset, text: clip.motion_graphic.text, start: 0, duration: 3 }] : [];
  const focus = clip.subject === "left" ? 0.22 : clip.subject === "right" ? 0.78 : clip.focus_x;
  return {
    ...base, transcript: clip.caption_text?.trim() ? [{ start: clip.start, end: clip.end, text: clip.caption_text }] : clip.transcript ?? base.transcript,
    cut: {
      ...base.cut, spans, graphics, captions: clip.caption_enabled !== false,
      captionStyle: clip.caption_style === "bold" ? "Bold" : clip.caption_style === "minimal" ? "Editorial" : "Clean",
      captionSize: 100 * (clip.caption_size ?? 52) / 52,
      captionX: clip.caption_x, captionY: clip.caption_y, captionFont: clip.caption_font,
      accent: clip.caption_color, ratio: clip.aspect_ratio,
      frame: clip.framing === "fit" ? "fit" : clip.framing === "blur" ? "blur" : "fill",
      focus: focus * 100, zoom: (clip.camera_zoom ?? 1) * 100,
      speed: clip.playback_speed || 1, volume: (clip.audio_volume ?? 1) * 100,
      fade: !!clip.audio_fade, fadeSeconds: clip.audio_fade, denoise: clip.audio_denoise,
      keyframes: clip.camera_keyframes?.slice().sort((a, b) => a.time - b.time),
    },
  };
}

export function renderedCaptions(project: Project, clip: Clip) {
  const render = renderProject(project, clip);
  const speed = render.cut.speed ?? 1;
  return clipCues(render).map(cue => ({ ...cue, start: round(cue.start / speed), end: round(cue.end / speed) }));
}

export async function moments(project: Project, options: Pick<ClipSetupSettings, "mode" | "use_transcript" | "max_clips" | "topic" | "target_duration" | "ranges" | "provider">, auth: { key: string; plan: boolean }, signal: AbortSignal, update: (label: string) => void) {
  const target = Math.max(1, options.target_duration || 30);
  const limit = Math.max(1, Math.min(100, options.max_clips || 5));
  if (options.mode === "manual") return options.ranges.map(range => ({ ...range, title: "", reason: "Manual range" }));
  if (options.mode === "full") {
    return Array.from({ length: Math.min(3000, Math.ceil(project.duration / target)) }, (_, index) => ({
      start: index * target, end: Math.min(project.duration, (index + 1) * target), title: "", reason: "Full source split",
    }));
  }
  const base = { ...renderSource(project), transcript: options.use_transcript ? project.transcript ?? [] : [], target, subject: options.topic || "" };
  if (options.provider === "openai" && base.transcript.length && (auth.key || auth.plan)) {
    return (await aiMoments(base, requester(auth.key, auth.plan), signal, update)).slice(0, limit);
  }
  return localCandidates(base).slice(0, limit);
}

export function configuredClip(project: Project, range: { start: number; end: number; title: string; reason: string }, settings: ClipSetupSettings, id: string, index: number) {
  const { captions, audio, camera } = settings;
  return clipDraft(project, {
    ...camera, ...range, title: range.title || `Clip ${index + 1}`, generation_id: id,
    caption_enabled: captions.mode !== "none", caption_text: captions.mode === "manual" ? captions.text : "",
    caption_style: captions.style, caption_color: captions.color, caption_x: captions.x,
    caption_y: captions.y, caption_font: captions.font, caption_size: captions.size,
    audio_volume: audio.volume, audio_denoise: audio.denoise, audio_fade: audio.fade,
    suggestion_status: settings.mode === "smart" ? "pending" : "kept",
    selected: settings.mode !== "smart",
  });
}

export function automaticClip(project: Project, range: { start: number; end: number; title: string; reason: string }, brief: EditBrief, id: string, index: number) {
  const clip = clipDraft(project, {
    ...range, title: range.title || `${brief.style === "visual" ? "Visual" : "Story"} cut ${index + 1}`, generation_id: id,
    aspect_ratio: brief.format, framing: brief.style === "visual" ? "fit" : "follow", camera_strategy: "adaptive", camera_motion: brief.style === "social" ? "dynamic" : "steady", selected: index === 0,
    caption_enabled: !brief.visible_captions && Boolean(project.transcript?.length), caption_style: brief.style === "social" ? "bold" : "clean",
    motion_graphic: brief.opening_text?.trim() ? { preset: "opening", text: brief.opening_text.trim() } : undefined,
    audio_fade: 0.12,
  });
  if (brief.style !== "visual" && project.transcript?.length) {
    const base = renderProject(project, clip);
    const spans = tightenPauses(base);
    clip.pause_cuts = spans.slice(1).map((span, i) => ({ start: spans[i].end, end: span.start }));
  }
  return clip;
}

export function intersectTranscript(cues: SubtitleSegment[], clip: Clip) {
  return cues.filter(cue => cue.end > clip.start && cue.start < clip.end).map(cue => ({
    ...cue, start: Math.max(cue.start, clip.start), end: Math.min(cue.end, clip.end),
  }));
}
