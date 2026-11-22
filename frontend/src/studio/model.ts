import type { SubtitleSegment } from "../subtitleImport";

export const destinations = [
  { id: "reels", label: "Instagram Reels", ratio: "9:16", safeBottom: 0.20, safeRight: 0.14 },
  { id: "tiktok", label: "TikTok", ratio: "9:16", safeBottom: 0.23, safeRight: 0.16 },
  { id: "shorts", label: "YouTube Shorts", ratio: "9:16", safeBottom: 0.19, safeRight: 0.13 },
  { id: "square", label: "Square feed", ratio: "1:1", safeBottom: 0.11, safeRight: 0.07 },
  { id: "wide", label: "Landscape", ratio: "16:9", safeBottom: 0.10, safeRight: 0.07 },
] as const;
export const goals = ["Tell a story", "Teach one thing", "Share an opinion", "Show the process", "Make a teaser"] as const;
export const motions = [
  { id: "opening", label: "Title reveal", sample: "FIRST LIGHT", detail: "Wipe-in opening title" },
  { id: "speaker", label: "Lower third", sample: "FIELD NOTES", detail: "Sliding nameplate" },
  { id: "callout", label: "Key takeaway", sample: "THE TAKEAWAY", detail: "Spring callout card" },
  { id: "type", label: "Typewriter", sample: "KEEP WATCHING", detail: "Sequential letter reveal" },
  { id: "chapter", label: "Chapter card", sample: "CHAPTER ONE", detail: "Full-frame chapter interlude" },
  { id: "quote", label: "Pull quote", sample: "WORTH THE WAIT", detail: "Animated editorial quote" },
  { id: "metric", label: "Big number", sample: "03", detail: "Oversized number pop" },
  { id: "cta", label: "End card", sample: "SAVE THIS", detail: "Centered closing pill" },
  { id: "progress", label: "Progress bar", sample: "WATCH THE RIDGE", detail: "Fills as the clip plays" },
  { id: "flash", label: "Flash transition", sample: "", detail: "Brief flash at a cut" },
  { id: "zoom", label: "Punch in", sample: "", detail: "Animated crop emphasis" },
] as const;
export const captionStyles = ["Clean", "Bold", "Highlight", "Boxed", "Editorial"] as const;
export type Graphic = { id: string; style: (typeof motions)[number]["id"]; text: string; start: number; duration: number };
export type Span = { id: string; start: number; end: number };
export type Candidate = { id: string; title: string; reason: string; start: number; end: number; hook: string };
export type Cut = {
  spans: Span[]; graphics: Graphic[]; captions: boolean; captionStyle: (typeof captionStyles)[number];
  captionSize: number; accent: string; frame: "fill" | "fit" | "blur"; focus: number; zoom: number;
  volume: number; fade: boolean;
  ratio?: "9:16" | "4:5" | "1:1" | "16:9";
  captionX?: number; captionY?: number; captionFont?: "outfit" | "anton" | "noto-arabic";
  speed?: number; fadeSeconds?: number; denoise?: boolean;
  keyframes?: { time: number; x: number; y: number; zoom: number }[];
};
export type Project = {
  id: string; title: string; sourceName: string; sourceType: string; duration: number; width: number; height: number;
  updated: number; demo: boolean; destination: (typeof destinations)[number]["id"]; goal: (typeof goals)[number];
  subject: string; target: number; transcript: SubtitleSegment[]; candidates: Candidate[]; cut: Cut;
  approved: boolean; notes: string;
};
export type Stage = "Import" | "Find moments" | "Build cut" | "Style" | "Review" | "Export";
export const stages: Stage[] = ["Import", "Find moments", "Build cut", "Style", "Review", "Export"];
export const makeId = () => globalThis.crypto.randomUUID();
export const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
export const round = (n: number) => Math.round(n * 1000) / 1000;
export const lengthOf = (spans: Span[]) => spans.reduce((total, span) => total + span.end - span.start, 0);
export const destinationFor = (id: Project["destination"]) => destinations.find(item => item.id === id) ?? destinations[0];
export const elapsed = (n: number) => {
  const seconds = Math.max(0, Math.floor(n));
  return [Math.floor(seconds / 60), seconds % 60].map(value => String(value).padStart(2, "0")).join(":");
};
export const precise = (n: number) => `${elapsed(n)}.${String(Math.floor((n % 1) * 100 + 1e-7)).padStart(2, "0")}`;
export const filename = (name: string) => name.replace(/[^\p{L}\p{N} _-]+/gu, "").trim().replace(/\s+/g, "-").slice(0, 75) || "clipflow";

export function newProject(file: File, info: { duration: number; width: number; height: number }): Project {
  return {
    id: makeId(), title: file.name.replace(/\.[^.]+$/, ""), sourceName: file.name, sourceType: file.type, ...info,
    updated: Date.now(), demo: false, destination: "reels", goal: goals[0], target: 30, subject: "", transcript: [], candidates: [],
    cut: {
      spans: [{ id: makeId(), start: 0, end: Math.min(info.duration, 30) }], graphics: [], captions: true,
      captionStyle: "Clean", captionSize: 100, accent: "#dcff82", frame: "fill", focus: 50, zoom: 100, volume: 100, fade: true,
    }, approved: false, notes: "",
  };
}

export const sampleTranscript: SubtitleSegment[] = [
  { start: 0.10, end: 2.2, text: "The mountain didn't disappear." },
  { start: 2.2, end: 5.7, text: "The clouds changed how much of it we could see." },
  { start: 8.12, end: 10.4, text: "Watch the ridge on the right." },
  { start: 10.4, end: 15.1, text: "That's where the mist rises, spills over, and slowly breaks apart." },
  { start: 17.15, end: 20.5, text: "The trick to filming fog is patience." },
  { start: 20.5, end: 24.6, text: "Lock the camera and let the landscape do the moving." },
  { start: 26.15, end: 32.8, text: "In a vertical cut, keep one point of reference in frame so the viewer can see what changed." },
  { start: 35.15, end: 41.3, text: "Start with the clearest view, then hold long enough for the change to feel real." },
];

export function demoProject(): Project {
  const project = newProject(new File([], "Above the cloudline.mp4", { type: "video/mp4" }), { duration: 43, width: 854, height: 480 });
  return {
    ...project, demo: true, title: "Above the cloudline", transcript: sampleTranscript,
    subject: "How to film a mountain time-lapse", target: 30,
    candidates: [
      { id: makeId(), title: "The mountain didn’t disappear", reason: "An immediate visual hook followed by an explanation.", start: 0, end: 24.8, hook: "The mountain didn't disappear." },
      { id: makeId(), title: "The trick is patience", reason: "A practical filming tip with context and a clear payoff.", start: 17, end: 41.6, hook: "The trick to filming fog is patience." },
      { id: makeId(), title: "Watch the ridge", reason: "A direct instruction gives the viewer something to look for.", start: 8, end: 24.8, hook: "Watch the ridge on the right." },
    ],
    cut: {
      ...project.cut, spans: [{ id: makeId(), start: 0, end: 24.8 }],
      graphics: [{ id: makeId(), style: "opening", text: "ABOVE THE CLOUDLINE", start: 0, duration: 2.2 }],
      focus: 60,
    },
  };
}

export function clipCues(project: Project): SubtitleSegment[] {
  let offset = 0;
  return project.cut.spans.flatMap(span => {
    const cues = project.transcript.filter(cue => cue.end > span.start && cue.start < span.end).map(cue => ({
      start: round(offset + Math.max(0, cue.start - span.start)),
      end: round(offset + Math.min(span.end, cue.end) - span.start), text: cue.text,
    })).filter(cue => cue.end > cue.start);
    offset += span.end - span.start;
    return cues;
  });
}

export function clipPosition(spans: Span[], time: number) {
  let offset = 0;
  for (const [index, span] of spans.entries()) {
    const duration = span.end - span.start;
    if (time < offset + duration || index === spans.length - 1) {
      return { span, index, offset, sourceTime: clamp(span.start + time - offset, span.start, span.end) };
    }
    offset += duration;
  }
  return null;
}

export function trimSpan(span: Span, key: "start" | "end", input: number, sourceDuration: number): Span {
  if (!Number.isFinite(input)) return span;
  const minimum = Math.min(0.15, sourceDuration);
  return key === "start"
    ? { ...span, start: round(clamp(input, 0, Math.max(0, span.end - minimum))) }
    : { ...span, end: round(clamp(input, Math.min(span.start + minimum, sourceDuration), sourceDuration)) };
}

export function tightenPauses(project: Project): Span[] {
  const spans = project.cut.spans.flatMap(span => {
    const cues = project.transcript.filter(cue => cue.end > span.start && cue.start < span.end);
    if (cues.length < 2) return [span];
    const pieces: Span[] = [];
    let start = span.start;
    let lastSpeech = Math.max(span.start, cues[0].end);
    for (const cue of cues.slice(1)) {
      if (cue.start - lastSpeech > 0.95) {
        pieces.push({ id: makeId(), start, end: round(lastSpeech + 0.24) });
        start = round(cue.start - 0.19);
      }
      lastSpeech = Math.max(lastSpeech, cue.end);
    }
    return pieces.length ? [...pieces, { id: makeId(), start, end: span.end }] : [span];
  });
  return spans.length > 100 ? project.cut.spans : spans;
}

const themes: Record<Project["goal"], RegExp> = {
  "Tell a story": /\b(then|when|first|changed|happened|realized|until|before)\b/gi,
  "Teach one thing": /\b(how|because|trick|step|start|need|means|way)\b/gi,
  "Share an opinion": /\b(think|believe|opinion|wrong|important|should|disagree|why)\b/gi,
  "Show the process": /\b(watch|then|next|start|first|move|place|keep|repeat)\b/gi,
  "Make a teaser": /\b(secret|wait|watch|surprise|discover|imagine|suddenly)\b/gi,
};

export function localCandidates(project: Project): Candidate[] {
  const { transcript, duration, target, subject, goal } = project;
  if (!transcript.length) {
    const window = Math.min(duration, target);
    return [...new Set([0, round((duration - window) / 2), round(duration - window)])]
      .filter((value, index, all) => index === 0 || value - all[index - 1] >= 1)
      .map((start, i) => ({ id: makeId(), title: ["Opening", "Middle", "Ending"][i], reason: "Time-based starting point. Play the source to check what happens here.", start, end: round(start + window), hook: "" }));
  }
  const terms = subject.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [];
  const ranked = transcript.map((first, i) => {
    const start = Math.max(0, first.start - 0.12);
    const limit = Math.min(duration, start + target * 1.20);
    let last = i;
    while (last + 1 < transcript.length && transcript[last + 1].end <= limit && transcript[last].end < start + target * 0.94) last++;
    const end = Math.min(duration, transcript[last].end + 0.20);
    const body = transcript.slice(i, last + 1).map(cue => cue.text).join(" ");
    const lower = body.toLowerCase();
    const matches = terms.filter(term => lower.includes(term)).length;
    const goalMatches = (first.text.match(themes[goal]) ?? []).length;
    const opensCleanly = !/^(and|but|so|it|they|he|she|this|that)\b/i.test(first.text);
    const score = matches * 3 + goalMatches * 1.8 + Number(opensCleanly) * 1.4
      + Number(/[.!؟?]$/.test(transcript[last].text)) - Math.abs(end - start - target) / Math.max(4, target / 3);
    return {
      id: makeId(), title: first.text.replace(/[.!?؟]+$/, "").split(/\s+/).slice(0, 9).join(" ").slice(0, 150),
      reason: matches ? "Includes words from your topic and ends at a transcript boundary." : "Starts and ends at transcript boundaries. Check that it makes sense on its own.",
      start: round(start), end: round(end), hook: first.text.slice(0, 500), score,
    };
  }).filter(item => item.end - item.start >= Math.min(6, target * 0.30, duration * 0.65));
  const selected: Candidate[] = [];
  for (const item of ranked.sort((a, b) => b.score - a.score)) {
    if (selected.length === 5) break;
    const overlaps = selected.some(other => Math.max(0, Math.min(item.end, other.end) - Math.max(item.start, other.start)) > Math.min(other.end - other.start, item.end - item.start) * 0.58);
    if (!overlaps) selected.push(item);
  }
  return selected.length ? selected : localCandidates({ ...project, transcript: [] });
}

export function srt(cues: SubtitleSegment[]) {
  const stamp = (n: number) => {
    const ms = Math.round(n * 1000);
    const units = [Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60];
    return units.map(v => String(v).padStart(2, "0")).join(":") + "," + String(ms % 1000).padStart(3, "0");
  };
  return cues.map((cue, index) => `${index + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}\n`).join("\n");
}
