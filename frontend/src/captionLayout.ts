// Match backend/caption_layout.py: proportional segment cues, not word alignment.
export const captionFont = (key = "outfit", text = "") =>
  /[\u0600-\u06ff]/.test(text) || key === "noto-arabic" ? '"Noto Sans Arabic", sans-serif' :
    key === "anton" ? '"Anton", sans-serif' : '"Outfit", sans-serif';

export function captionAt(segment: {start: number; end: number; text: string} | undefined, time: number) {
  if (!segment) return "";
  const words = segment.text.trim().split(/\s+/);
  const progress = Math.max(0, Math.min(.999999, (time - segment.start) / Math.max(.001, segment.end - segment.start)));
  const first = Math.floor(progress * words.length / 6) * 6;
  return words.slice(first, first + 6).join(" ");
}
